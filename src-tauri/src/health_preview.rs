//! `compute_health_preview` — the bounded, per-kind data the Build Model
//! "Model fit" and "Health score" pages draw, computed Rust-side over the
//! columnar store. Child module of the crate root so it can reuse the private
//! `ResolvedFilter` / `PreviewFilter` / cluster fitting without widening them.
//!
//! Nothing here ships every row to the WebView: every series is downsampled
//! to `max_points` with [`select_indices`] (min/max + lowest score kept) and
//! every scatter is a deterministic stride sample.
//!
//! **Two series per answer (since 2026-10-11, "Health score on 1-hour
//! averages"):**
//!   * `series` - the RAW rows of the universe below, for the Model fit page.
//!     It carries NO score any more (`score: null`).
//!   * `hourly` - what the health score is computed on: ONE POINT PER CLOCK
//!     HOUR, each input being the MEAN of the hour's in-scope rows
//!     (`health_hourly`). Only rows that pass the running condition enter a
//!     mean; an hour with no such row has no point (and so no score - missing,
//!     never 0). `score_summary` and `test_validation` count these hours.
//!
//! The model itself is untouched by that: mean / SD, the band, the ellipses,
//! the statistics, the histogram and both scatters still come from the raw
//! training rows.
//!
//! Row universe per kind:
//!   * individual   — rows with a finite target value that pass the training
//!     scope (`filter`); with `include_out_of_scope` every finite row, the
//!     out-of-scope ones marked `in_scope: false` and left unscored.
//!   * relationship — `series`: the rows of the cached fit (all in scope by
//!     construction; `filter` is NOT re-applied — the fit already used it) with
//!     the fit's own per-row predictions. `hourly`: those rows plus the rows of
//!     the scoring periods, per clock hour; the hour's prediction is the
//!     engine's answer for the hour's MEAN predictors (`health_validation::
//!     RelHours`), so a scoring period has no per-row prediction at all.
//!   * clustering   — in-scope rows with finite X and Y (a row whose criteria
//!     value is in no range is kept in the series with `cluster: null`,
//!     `score: null`). `hourly`: an hour is in a cluster only when EVERY one of
//!     its rows is in that cluster; any other hour (the state changed inside
//!     it, or a row has no cluster) keeps its point but has `cluster: null`,
//!     `sd_distance: null`, `score: null`.

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::csv_processor::ColumnarData;
use crate::health_hourly::{HourGroups, SCORING_INTERVAL_SECS};
use crate::health_score::{
    has_errors, histogram, select_indices, stride_indices, summarize_hours,
    validate_clustering, validate_individual, validate_relationship, ClusterGeom, ClusteringParams,
    Histogram, Issue, IndividualBand, IndividualParams, RelExtra, RelFit, RelationshipParams,
    ScoreSummary, SetPointsArg, MAX_SERIES_POINTS,
};
use crate::health_validation::{
    self, HourlyPoints, KindMetrics, RelCols, RelHours, RelTrain, TestPeriodArg, TestPlan,
    TestValidation,
};
use crate::metrics::{self, round_metric, round_metric_scaled};
use crate::{
    clustering_preview_in, individual_rounded_metrics, ClusterRange, PreviewFilter, ResolvedFilter,
};

pub const DEFAULT_MAX_POINTS: usize = 4000;
pub const DEFAULT_MAX_SCATTER_POINTS: usize = 8000;

/// Stable error-code prefixes (`"CODE: message"`) the UI can match on.
pub const ERR_NO_DATA: &str = "NO_DATA";
pub const ERR_NOT_FITTED: &str = "NOT_FITTED";
pub const ERR_BAD_REQUEST: &str = "BAD_REQUEST";

pub fn not_fitted(msg: &str) -> String {
    format!("{ERR_NOT_FITTED}: {msg}")
}

fn bad_request(msg: impl std::fmt::Display) -> String {
    format!("{ERR_BAD_REQUEST}: {msg}")
}

fn no_data(msg: impl std::fmt::Display) -> String {
    format!("{ERR_NO_DATA}: {msg}")
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Deserialize)]
pub struct HealthPreviewRequest {
    /// `"individual"` | `"relationship"` | `"clustering"`.
    pub kind: String,
    /// Individual / Relationship: the target sensor.
    #[serde(default)]
    pub target: Option<String>,
    /// Relationship: the predictors, in the order the model was fitted with.
    #[serde(default)]
    pub predictors: Vec<String>,
    /// Relationship: the key the fit was cached under
    /// (`preview_relationship_model`'s `cache_key`).
    #[serde(default)]
    pub cache_key: Option<String>,
    /// Relationship: which predictor goes on the Fit scatter's X axis
    /// (default: the first).
    #[serde(default)]
    pub x_predictor: Option<String>,
    /// Clustering: the X sensor.
    #[serde(default)]
    pub first_sensor: Option<String>,
    /// Clustering: the Y sensor.
    #[serde(default)]
    pub second_sensor: Option<String>,
    #[serde(default)]
    pub n_clusters: Option<u32>,
    #[serde(default)]
    pub criteria_sensor: Option<String>,
    #[serde(default)]
    pub cluster_ranges: Option<Vec<ClusterRange>>,
    /// The training scope (Running condition + periods), same shape as every
    /// other preview command.
    #[serde(default)]
    pub filter: Option<PreviewFilter>,
    /// The model's `healthSetPoints` (any of the three shapes; all optional).
    #[serde(default)]
    pub set_points: Option<SetPointsArg>,
    /// Cap on `series` points AND on `hourly` points, each (default 4000, max
    /// 100 000).
    #[serde(default)]
    pub max_points: Option<usize>,
    /// Cap on scatter points (default 8000, max 100 000).
    #[serde(default)]
    pub max_scatter_points: Option<usize>,
    /// Individual only: also return the rows outside the training scope
    /// (`in_scope: false`, never scored).
    #[serde(default)]
    pub include_out_of_scope: Option<bool>,
    /// Refuse (`STALE_SESSION`) when the loaded dataset's generation differs.
    #[serde(default, alias = "expectedGeneration")]
    pub expected_generation: Option<u64>,
    /// Scoring periods: time ranges (`[{start,end}]`; a legacy `label` /
    /// `event_time` is accepted and ignored) to score with the TRAIN-only model
    /// and compare with the training rows (see `health_validation`). Absent /
    /// empty = no change at all and `test_validation: null`.
    #[serde(default)]
    pub test_periods: Option<Vec<TestPeriodArg>>,
    /// Relationship: `true` = the user asked to try calculating the health
    /// score again ("Try again" on the `test_scoring_failed` notice). Forgets
    /// this fit's failed prediction attempt so the sidecar runs once more;
    /// without it a failed attempt is NOT repeated by later previews (only a
    /// re-train or this flag clears it). Default `false` - send it only from
    /// that button, never on every preview.
    #[serde(default, alias = "retryTestScoring")]
    pub retry_test_scoring: bool,
}

impl HealthPreviewRequest {
    /// The parsed test periods, `None` when the request has none.
    pub fn test_plan(&self, data: &ColumnarData) -> Option<TestPlan> {
        let periods = self.test_periods.as_deref().filter(|t| !t.is_empty())?;
        Some(TestPlan::resolve(periods, self.filter.as_ref(), &data.headers))
    }

    fn max_points(&self) -> usize {
        self.max_points
            .unwrap_or(DEFAULT_MAX_POINTS)
            .clamp(8, MAX_SERIES_POINTS)
    }

    fn max_scatter(&self) -> usize {
        self.max_scatter_points
            .unwrap_or(DEFAULT_MAX_SCATTER_POINTS)
            .clamp(1, MAX_SERIES_POINTS)
    }

    fn set_points(&self) -> SetPointsArg {
        self.set_points.clone().unwrap_or_default()
    }
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct IndividualStats {
    /// In-scope rows the statistics were computed over.
    pub rows: usize,
    /// Mean / SD / boundaries ROUNDED exactly as `INDV_INFO_*.json` stores
    /// them (the score is computed from these same numbers).
    pub mean: f64,
    pub sd: f64,
    pub boundary_1sd: [f64; 2],
    pub boundary_3sd: [f64; 2],
    pub min: f64,
    pub max: f64,
}

#[derive(Debug, Serialize)]
pub struct RelationshipStats {
    /// Fitted rows with a prediction.
    pub rows: usize,
    pub target: String,
    pub predictors: Vec<String>,
    pub r2: f64,
    pub rmse: f64,
    /// `2 × RMSE` — the half-width W of the 100 band, rounded like
    /// `REL_INFO_*.json`'s `2rmse`.
    pub two_rmse: f64,
    pub residual_mean: f64,
    pub residual_sd: f64,
    pub residual_min: f64,
    pub residual_max: f64,
    /// The sidecar's cumulative per-predictor scores (last = full model), for
    /// "Compare predictors".
    pub r2_per_step: Vec<f64>,
    pub rmse2_per_step: Vec<f64>,
}

#[derive(Debug, Serialize)]
pub struct ClusterStat {
    pub cluster_id: u32,
    pub range: Option<ClusterRange>,
    pub n_rows: usize,
    pub x_center: f64,
    pub y_center: f64,
    /// Major-axis SD.
    pub x_sd: f64,
    /// Minor-axis SD.
    pub y_sd: f64,
    pub angle_deg: f64,
}

#[derive(Debug, Serialize)]
pub struct ClusteringStats {
    /// In-scope rows with finite X and Y.
    pub rows: usize,
    /// Rows assigned to a cluster (the scored ones).
    pub assigned_rows: usize,
    /// Rows in no criteria range / missing criteria (never scored).
    pub unassigned_rows: usize,
    pub cluster_count: u32,
    pub criteria_sensor: Option<String>,
    /// Centre / SDs / angle ROUNDED like `CLUS_INFO_*.json` (the score uses
    /// these same numbers).
    pub clusters: Vec<ClusterStat>,
    /// Share (%) of the training rows with a cluster that sit inside its
    /// 3x SD ring (score >= 80). Sent with or without scoring periods (the
    /// Model fit page's "Inside 3x SD" tile); `None` when no training row has
    /// a usable cluster.
    pub inside_3sd_ring_pct: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum HealthStats {
    Individual(IndividualStats),
    Relationship(RelationshipStats),
    Clustering(ClusteringStats),
}

/// One struct, two uses (`HealthPreview::series` and `HealthPreview::hourly`):
///
/// * as `series` (RAW rows): one point per dataset row; `score` is always
///   `null` - the health score is not computed per row any more.
/// * as `hourly`: one point per clock hour. `rows` = the FIRST dataset row of
///   the hour, `timestamps` = the hour's START (`2024-01-05T13:00:00`),
///   `value` = the mean of the hour's in-scope rows, `in_scope` all `true`,
///   `total_points` = hours before downsampling. `score`: `null` when the set
///   points are incomplete/invalid ("Set the points above"); otherwise one
///   entry per point, `null` where the hour has no score — never 0.
#[derive(Debug, Serialize)]
pub struct IndividualSeries {
    /// Dataset row number of each point (0-based).
    pub rows: Vec<u32>,
    /// CSV timestamp text ("" when the row has none).
    pub timestamps: Vec<String>,
    pub value: Vec<f64>,
    pub in_scope: Vec<bool>,
    pub score: Option<Vec<Option<f64>>>,
    /// Size of the series BEFORE downsampling.
    pub total_points: usize,
}

/// As `series`: the raw TRAINING rows of the fit with the fit's own per-row
/// prediction (`score: null`; the rows of a scoring period are not in it - they
/// have no per-row prediction). As `hourly`: one point per clock hour - `rows`
/// = the hour's first dataset row, `timestamps` = the hour's start, `actual` =
/// the hour's mean target, `predicted` = the engine's answer for the hour's
/// mean predictors (`null` = none yet / the engine gave none), `residual` =
/// `actual − predicted` rounded like the file's, `score` of that residual
/// (`null` where the hour has no prediction).
#[derive(Debug, Clone, Serialize)]
pub struct RelationshipSeries {
    pub rows: Vec<u32>,
    pub timestamps: Vec<String>,
    pub actual: Vec<f64>,
    pub predicted: Vec<Option<f64>>,
    /// `actual − predicted`.
    pub residual: Vec<Option<f64>>,
    pub score: Option<Vec<Option<f64>>>,
    pub total_points: usize,
}

/// As `series`: the raw rows (`score: null`; `cluster` / `sd_distance` of each
/// ROW). As `hourly`: one point per clock hour - `rows` = the hour's first
/// dataset row, `timestamps` = the hour's start, `x` / `y` = the hour's means,
/// `cluster` = the cluster EVERY row of the hour is in (`null` = its rows are
/// not all in one cluster: two clusters in the hour, or a row whose criteria
/// value is missing / in no range), `sd_distance` / `score` of the point
/// (x mean, y mean) against that cluster - both `null` when `cluster` is
/// (the hour is still a point and still counts in `hours`; never a 0 score).
#[derive(Debug, Serialize)]
pub struct ClusteringSeries {
    pub rows: Vec<u32>,
    pub timestamps: Vec<String>,
    pub x: Vec<f64>,
    pub y: Vec<f64>,
    /// 1-based cluster id; `null` = in no criteria range (as `hourly`: the
    /// hour's rows are not all in one cluster).
    pub cluster: Vec<Option<u32>>,
    /// Distance to the cluster centre in SD units (`null` until the set
    /// points are valid — it is computed with the validated clusters).
    pub sd_distance: Vec<Option<f64>>,
    pub score: Option<Vec<Option<f64>>>,
    pub total_points: usize,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum HealthSeries {
    Individual(IndividualSeries),
    Relationship(RelationshipSeries),
    Clustering(ClusteringSeries),
}

/// Relationship "Fit" scatter: the fitted rows' target vs one predictor, with
/// the model's prediction at the same rows (stride sample, time-ordered).
#[derive(Debug, Serialize)]
pub struct FitScatter {
    pub x_sensor: String,
    pub predictors: Vec<String>,
    pub x: Vec<f64>,
    pub actual: Vec<f64>,
    pub predicted: Vec<Option<f64>>,
    /// Fitted rows the sample was drawn from.
    pub total: usize,
}

/// Clustering scatter (stride sample of the in-scope X/Y rows).
#[derive(Debug, Serialize)]
pub struct ClusterScatter {
    pub x: Vec<f64>,
    pub y: Vec<f64>,
    /// 1-based cluster id; `null` = in no criteria range.
    pub cluster: Vec<Option<u32>>,
    pub total: usize,
}

#[derive(Debug, Serialize)]
pub struct HealthPreview {
    /// `"individual"` | `"relationship"` | `"clustering"`.
    pub kind: String,
    pub stats: HealthStats,
    /// Re-run on every call. Empty = fine.
    pub validation: Vec<Issue>,
    /// `false` when any validation issue OF THE SET POINTS is an error (no score
    /// is produced). Test-period issues are NOT part of it: an invalid test
    /// period (`test_*` / `event_*` codes, error severity - that period is only
    /// skipped) and the `test_scoring_*` warnings (Relation model: the engine's
    /// hourly predictions are missing, so hours are unscored - also possible
    /// with no scoring period at all) can appear with `valid: true`.
    pub valid: bool,
    /// The RAW rows (Model fit). `series.score` is always `null`.
    pub series: HealthSeries,
    /// The HOURLY points the health score is computed on (same per-kind shape
    /// as `series`): one point per clock hour, every value the mean of the
    /// hour's in-scope rows; `score` is `null` until the set points are valid.
    pub hourly: HealthSeries,
    /// The health score's sampling interval in seconds: `3600`.
    pub scoring_interval_secs: u64,
    /// `null` when `valid` is false. Counts HOURS (the training hours);
    /// `share_basis: "hour_count"`.
    pub score_summary: Option<ScoreSummary>,
    /// Individual only.
    pub histogram: Option<Histogram>,
    /// Relationship only.
    pub fit_scatter: Option<FitScatter>,
    /// Clustering only.
    pub cluster_scatter: Option<ClusterScatter>,
    /// `null` unless the request carried `test_periods`: the train-vs-test
    /// comparison (named so because `validation` is already the issue list).
    pub test_validation: Option<TestValidation>,
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// One flag per dataset row: is it in ANY of the test row lists? Empty `Vec`
/// (not `n` falses) when no test has a row, so callers can skip the lookup.
fn mark_rows(n: usize, lists: &[Vec<u32>]) -> Vec<bool> {
    if lists.iter().all(|l| l.is_empty()) {
        return Vec::new();
    }
    let mut flags = vec![false; n];
    for l in lists {
        for &r in l {
            flags[r as usize] = true;
        }
    }
    flags
}

/// `summarize` over the TRAINING points only (a masked copy): a point that is
/// not a training point is left out of the summary. Scoring periods can still
/// move it at the edges - an hour that holds training rows AND rows of a
/// scoring period is a training point whose mean includes both, so adding or
/// removing that period changes that one hour's score.
fn masked_scores(scores: &[f64], is_train: &[bool]) -> Vec<f64> {
    scores
        .iter()
        .zip(is_train)
        .map(|(&s, &t)| if t { s } else { f64::NAN })
        .collect()
}

fn share_pct(hits: usize, total: usize) -> Option<f64> {
    (total > 0).then(|| health_validation::r1(hits as f64 * 100.0 / total as f64))
}

fn ts_text(data: &ColumnarData, row: u32) -> String {
    data.timestamps[row as usize].clone().unwrap_or_default()
}

/// The score summary of an hourly series: over the TRAINING hours only (the
/// scoring periods have their own results in `test_validation`). Counts hours;
/// the minimum is located by its hour start and the hour's first dataset row.
fn hourly_summary(scores: &[f64], h_train: &[bool], groups: &HourGroups) -> ScoreSummary {
    let train_hours = h_train.iter().filter(|&&t| t).count();
    let locate = |h: usize| (groups.first_row(h) as usize, Some(groups.label(h)));
    if train_hours == h_train.len() {
        summarize_hours(scores, train_hours, locate)
    } else {
        summarize_hours(&masked_scores(scores, h_train), train_hours, locate)
    }
}

fn pick<T: Copy>(v: &[T], idx: &[usize]) -> Vec<T> {
    idx.iter().map(|&i| v[i]).collect()
}

fn opt(v: f64) -> Option<f64> {
    if v.is_nan() {
        None
    } else {
        Some(v)
    }
}

fn opts(v: &[f64], idx: &[usize]) -> Vec<Option<f64>> {
    idx.iter().map(|&i| opt(v[i])).collect()
}

fn col_index(data: &ColumnarData, name: &str, what: &str) -> Result<usize, String> {
    data.col_index(name)
        .ok_or_else(|| bad_request(format!("{what} not found: {name}")))
}

fn required<'a>(v: &'a Option<String>, what: &str) -> Result<&'a str, String> {
    v.as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| bad_request(format!("{what} is required")))
}

/// Mean / sample SD of the finite values (NaN-safe; a single value → SD 0).
fn mean_sd(values: &[f64]) -> (f64, f64) {
    let mean = metrics::mean(values);
    let sd = metrics::sample_sd(values, mean);
    (mean, if sd.is_nan() { 0.0 } else { sd })
}

// ---------------------------------------------------------------------------
// Request checks of the preview (coded `BAD_REQUEST`)
// ---------------------------------------------------------------------------

/// The training scope must resolve (parseable bounds, no both-legacy-and-ranges,
/// no period that ends before it starts).
pub fn check_scope(data: &ColumnarData, filter: Option<&PreviewFilter>) -> Result<(), String> {
    ResolvedFilter::resolve(filter, &data.headers)
        .map(|_| ())
        .map_err(|e| bad_request(format!("invalid training scope: {e}")))
}

/// Clustering: both sensors exist, the scope resolves and — for more than one
/// cluster — the criteria sensor exists and there is exactly one range per
/// cluster.
pub fn check_clustering_request(
    data: &ColumnarData,
    first: &str,
    second: &str,
    n_clusters: u32,
    criteria_sensor: Option<&str>,
    cluster_ranges: Option<&[ClusterRange]>,
    filter: Option<&PreviewFilter>,
) -> Result<(), String> {
    if n_clusters == 0 {
        return Err(bad_request("n_clusters must be at least 1"));
    }
    col_index(data, first, "Sensor")?;
    col_index(data, second, "Sensor")?;
    check_scope(data, filter)?;
    if n_clusters > 1 {
        let criteria = criteria_sensor
            .filter(|s| !s.is_empty())
            .ok_or_else(|| bad_request("criteria_sensor is required when n_clusters > 1"))?;
        col_index(data, criteria, "Criteria sensor")?;
        let ranges = cluster_ranges
            .ok_or_else(|| bad_request("cluster_ranges is required when n_clusters > 1"))?;
        if ranges.len() as u32 != n_clusters {
            return Err(bad_request(format!(
                "cluster_ranges length ({}) must equal n_clusters ({})",
                ranges.len(),
                n_clusters
            )));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Individual
// ---------------------------------------------------------------------------

pub fn individual_preview(
    data: &ColumnarData,
    req: &HealthPreviewRequest,
) -> Result<HealthPreview, String> {
    let target = required(&req.target, "target")?;
    let idx = col_index(data, target, "Sensor")?;
    let col = &data.columns[idx];
    let resolved = ResolvedFilter::resolve(req.filter.as_ref(), &data.headers)
        .map_err(|e| bad_request(format!("invalid training scope: {e}")))?;
    let noop = resolved.is_noop();
    let include_out = req.include_out_of_scope.unwrap_or(false);

    // Train/Test validation: the rows of every test period (finite target +
    // the running condition's value conditions). `with_tests` = the request
    // carried test periods at all (even if none has a row).
    let plan = req.test_plan(data);
    let with_tests = plan.is_some();
    let test_rows: Vec<Vec<u32>> = plan
        .as_ref()
        .map(|p| p.collect_rows(data, &|r| col[r].is_finite()))
        .unwrap_or_default();
    let in_test = mark_rows(data.n_rows(), &test_rows);
    let is_test = |r: usize| !in_test.is_empty() && in_test[r];

    // Row universe (ascending dataset rows), then the in-scope flag of each.
    // Test rows are part of it (scored with the train-only model).
    let rows: Vec<u32> = (0..data.n_rows())
        .into_par_iter()
        .filter(|&r| {
            col[r].is_finite()
                && (include_out || noop || is_test(r) || resolved.keeps(data, r))
        })
        .map(|r| r as u32)
        .collect();
    // Does the row pass the TRAINING scope? Only needed (and only computed)
    // when some rows of the universe may be outside it.
    let need_flags = !noop && (include_out || with_tests);
    let is_train: Vec<bool> = if need_flags {
        rows.par_iter()
            .map(|&r| resolved.keeps(data, r as usize))
            .collect()
    } else {
        vec![true; rows.len()]
    };
    // Scored rows: training rows, and (with tests) the test rows.
    let in_scope: Vec<bool> = if !in_test.is_empty() {
        rows.iter()
            .zip(&is_train)
            .map(|(&r, &t)| t || in_test[r as usize])
            .collect()
    } else {
        is_train.clone()
    };
    let values: Vec<f64> = rows.iter().map(|&r| col[r as usize]).collect();
    let scope_vals: Vec<f64> = if need_flags {
        values
            .iter()
            .zip(&is_train)
            .filter(|&(_, &s)| s)
            .map(|(&v, _)| v)
            .collect()
    } else {
        // Borrow-free copy only when needed; otherwise reuse below.
        Vec::new()
    };
    let scope: &[f64] = if need_flags { &scope_vals } else { &values };
    if scope.is_empty() {
        return Err(no_data(format!(
            "No valid numeric values for sensor '{target}' in the training scope"
        )));
    }

    let (mean, sd) = mean_sd(scope);
    let (mean_r, sd_r, b1, b3) = individual_rounded_metrics(mean, sd);
    let band = IndividualBand::from_rounded(mean_r, sd_r, b1, b3);
    let (min, max) = scope
        .iter()
        .fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), &v| (a.min(v), b.max(v)));
    let stats = IndividualStats {
        rows: scope.len(),
        mean: mean_r,
        sd: sd_r,
        boundary_1sd: b1,
        boundary_3sd: b3,
        min,
        max,
    };

    let sp = req.set_points();
    let mut validation = validate_individual(&band, &sp);
    let valid = !has_errors(&validation);
    if let Some(p) = &plan {
        validation.extend(p.issues.iter().cloned());
    }
    let params = if valid {
        IndividualParams::new(band, &sp).ok()
    } else {
        None
    };

    // ---- hourly points: what the health score is computed on ----
    // The in-scope rows (training rows + the rows of the scoring periods)
    // grouped by clock hour; the value of a point is the MEAN of its rows. A row
    // outside the scope (only present with `include_out_of_scope`) never enters
    // a mean, and an hour with no in-scope row has no point.
    let groups = HourGroups::build(&data.ts_parsed, &rows, |i| in_scope[i]);
    let h_value = groups.mean(|i| values[i]);
    // A training hour holds at least one training row.
    let h_train = groups.any(|i| is_train[i]);
    // Hourly scores (NaN = no score).
    let h_scores: Option<Vec<f64>> = params.map(|p| {
        h_value
            .par_iter()
            .map(|&v| p.score(v).unwrap_or(f64::NAN))
            .collect()
    });

    // The summary describes the TRAINING hours; scoring periods have their own
    // results.
    let summary = h_scores
        .as_ref()
        .map(|sc| hourly_summary(sc, &h_train, &groups));

    // RAW rows for the Model fit page: no score (see the module docs).
    let sel = select_indices(rows.len(), req.max_points(), Some(&values), None);
    let series = IndividualSeries {
        rows: pick(&rows, &sel),
        timestamps: sel.iter().map(|&i| ts_text(data, rows[i])).collect(),
        value: pick(&values, &sel),
        in_scope: pick(&in_scope, &sel),
        score: None,
        total_points: rows.len(),
    };
    // The hourly series: value extremes and the lowest score of every bucket
    // survive the downsample, exactly like a raw series.
    let hsel = select_indices(
        groups.len(),
        req.max_points(),
        Some(&h_value),
        h_scores.as_deref(),
    );
    let hourly = IndividualSeries {
        rows: pick(groups.first_rows(), &hsel),
        timestamps: hsel.iter().map(|&h| groups.label(h)).collect(),
        value: pick(&h_value, &hsel),
        in_scope: vec![true; hsel.len()],
        score: h_scores.as_ref().map(|sc| opts(sc, &hsel)),
        total_points: groups.len(),
    };

    let test_validation = plan.as_ref().map(|plan| {
        let inside3 = |v: f64| v >= b3[0] && v <= b3[1];
        // The train block: the model's own numbers, from the RAW training rows.
        let train_in = scope.iter().filter(|&&v| inside3(v)).count();
        let train_metrics = KindMetrics {
            mean: Some(mean_r),
            sd: Some(sd_r),
            within_3sd_pct: share_pct(train_in, scope.len()),
            ..Default::default()
        };
        // A period's metrics: over its HOURLY points.
        let metrics_for = |hours: &[usize]| {
            let vs: Vec<f64> = hours.iter().map(|&h| h_value[h]).collect();
            let inside = vs.iter().filter(|&&v| inside3(v)).count();
            let m = metrics::mean(&vs);
            KindMetrics {
                within_3sd_pct: share_pct(inside, vs.len()),
                mean_shift_sd: (sd_r > 0.0 && m.is_finite())
                    .then(|| health_validation::r2dp((m - mean_r) / sd_r)),
                ..Default::default()
            }
        };
        health_validation::build_hourly(
            plan,
            &health_validation::period_hours(&test_rows, &rows, &is_train, &groups),
            &HourlyPoints {
                groups: &groups,
                is_train: &h_train,
                scores: h_scores.as_deref(),
            },
            health_validation::sample_interval_secs(data),
            scope.len(),
            train_metrics,
            &metrics_for,
        )
    });

    Ok(HealthPreview {
        kind: "individual".into(),
        stats: HealthStats::Individual(stats),
        validation,
        valid,
        series: HealthSeries::Individual(series),
        hourly: HealthSeries::Individual(hourly),
        scoring_interval_secs: SCORING_INTERVAL_SECS,
        score_summary: summary,
        histogram: histogram(scope, mean_r, sd_r, 80),
        fit_scatter: None,
        cluster_scatter: None,
        test_validation,
    })
}

// ---------------------------------------------------------------------------
// Relationship
// ---------------------------------------------------------------------------

/// A residual with the rounding `REL_DATASET_*.csv` uses
/// (`backend.py::train_relationship`):
/// `RESIDUAL = round_metric(actual − round_metric(predicted))` — taken from the
/// ROUNDED prediction and then rounded itself.
///
/// Two uses:
///   * the RAW training rows (`series`, the residual statistics, 2RMSE): these
///     are the very numbers the file stores, so the Model fit page and
///     `REL_DATASET` agree row for row;
///   * the HOURLY points (`hourly`, what is scored): `actual` is the hour's mean
///     target and `predicted` the engine's answer for the hour's mean
///     predictors - same rounding, so a residual means the same thing against
///     the same 2RMSE band.
///
/// What is NOT true any more (since the health score moved to 1-hour averages,
/// 2026-10-11): the health score cannot be reproduced from `REL_DATASET` alone.
/// That file holds the raw training rows; a consumer that wants the score has
/// to average the target and every predictor per clock hour, run the saved
/// model (`.pkl`) on the hourly mean predictors and score THAT residual - which
/// is what the `validation` block of `REL_INFO` declares with
/// `scoring_interval_seconds: 3600` / `scoring_aggregation: "mean"`.
///
/// **This function and `backend.py::train_relationship` must stay in sync**
/// (same rounding, same order of operations). Non-finite input gives NaN (an
/// unscored point).
pub fn file_residual(actual: f64, predicted: f64) -> f64 {
    if actual.is_finite() && predicted.is_finite() {
        round_metric(actual - round_metric(predicted))
    } else {
        f64::NAN
    }
}

/// Statistics of a cached fit, computed the way `train_relationship` writes
/// them to `REL_INFO_*.json`: predictions rounded with `round_metric`, `r2`
/// to 2 decimals, `2rmse = round_metric(2 · RMSE)`. The residual statistics
/// use [`file_residual`] (the residual the file stores).
pub fn relationship_stats(fit: &RelFit) -> Result<RelationshipStats, String> {
    let mut y = Vec::new();
    let mut p = Vec::new();
    let mut resid = Vec::new();
    for (a, b) in fit.actual.iter().zip(&fit.predicted) {
        if a.is_finite() && b.is_finite() {
            y.push(*a);
            p.push(round_metric(*b));
            resid.push(file_residual(*a, *b));
        }
    }
    if y.is_empty() {
        return Err(no_data("The fitted model has no predictions"));
    }
    let r2 = metrics::r2_score(&y, &p);
    let r2 = if r2.is_nan() { 0.0 } else { (r2 * 100.0).round() / 100.0 };
    let rmse = metrics::rmse(&y, &p);
    let (rm, rs) = mean_sd(&resid);
    let (rmin, rmax) = resid
        .iter()
        .fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), &v| (a.min(v), b.max(v)));
    Ok(RelationshipStats {
        rows: y.len(),
        target: fit.target.clone(),
        predictors: fit.predictors.clone(),
        r2,
        rmse: round_metric(rmse),
        two_rmse: round_metric(2.0 * rmse),
        residual_mean: rm,
        residual_sd: rs,
        residual_min: rmin,
        residual_max: rmax,
        r2_per_step: fit.r2_per_step.clone(),
        rmse2_per_step: fit.rmse2_per_step.clone(),
    })
}

/// Tests only: the Relationship preview with NO hourly predictions (every hour
/// unscored) - for what does not depend on them (statistics, raw series, Fit
/// scatter, validation, errors). Production always goes through
/// [`relationship_preview_ex`] with the fit's stored predictions.
#[cfg(test)]
pub fn relationship_preview(
    data: &ColumnarData,
    fit: &RelFit,
    req: &HealthPreviewRequest,
) -> Result<HealthPreview, String> {
    relationship_preview_ex(data, fit, None, req)
}

/// Metrics of `(actual, predicted)` pairs the way `REL_INFO_*.json` /
/// `REL_DATASET_*.csv` define them: predictions rounded with `round_metric`,
/// residual = [`file_residual`]. Pairs with a non-finite side are skipped; no
/// pair at all gives no metrics. The pairs are RAW training rows for the train
/// block and HOURLY points (mean actual, prediction at the mean predictors) for
/// a scoring period.
fn rel_metrics(pairs: impl Iterator<Item = (f64, f64)>) -> KindMetrics {
    let mut y = Vec::new();
    let mut p = Vec::new();
    let mut resid = Vec::new();
    for (a, b) in pairs {
        if a.is_finite() && b.is_finite() {
            y.push(a);
            p.push(round_metric(b));
            resid.push(file_residual(a, b));
        }
    }
    if y.is_empty() {
        return KindMetrics::default();
    }
    let r2 = metrics::r2_score(&y, &p);
    let (rm, rs) = mean_sd(&resid);
    KindMetrics {
        r2: Some(if r2.is_nan() { 0.0 } else { health_validation::r3dp(r2) }),
        rmse: Some(round_metric(metrics::rmse(&y, &p))),
        residual_mean: Some(health_validation::nz(round_metric(rm))),
        residual_sd: Some(round_metric(rs)),
        ..Default::default()
    }
}

/// The Relationship preview. `extra` holds the engine's predictions for the
/// HOURLY points of this fit (see [`RelExtra`]); an hour with no prediction
/// there is unscored (`null`, never 0) - with `extra: None` no hour has a score.
///
/// What is computed on what (user decision 2026-10-11, "resample the raw data
/// to 1 hour, pass that through the model"):
///   * the fit, its statistics, 2RMSE, the Fit scatter and the raw `series`
///     are the RAW training rows, unchanged;
///   * `hourly`, `score_summary` (training hours, `share_basis: "hour_count"`)
///     and `test_validation` are the hourly table of
///     [`health_validation::RelHours`]: mean target, the engine's prediction at
///     the hour's mean predictors, `file_residual` of the two, the score of it.
///
/// The training hours need a prediction as well, so this runs the same way
/// with and without scoring periods.
pub fn relationship_preview_ex(
    data: &ColumnarData,
    fit: &RelFit,
    extra: Option<&RelExtra>,
    req: &HealthPreviewRequest,
) -> Result<HealthPreview, String> {
    if let Some(t) = req.target.as_deref() {
        if t != fit.target {
            return Err(not_fitted(&format!(
                "the cached fit is for target '{}', not '{t}' — train it first",
                fit.target
            )));
        }
    }
    if !req.predictors.is_empty() && req.predictors != fit.predictors {
        return Err(not_fitted(
            "the cached fit used different predictors — train it first",
        ));
    }
    let x_idx = match req.x_predictor.as_deref().filter(|s| !s.is_empty()) {
        Some(name) => fit
            .predictors
            .iter()
            .position(|p| p == name)
            .ok_or_else(|| bad_request(format!("x_predictor '{name}' is not a predictor of this model")))?,
        None => 0,
    };
    let stats = relationship_stats(fit)?;
    let n_fit = fit.rows.len();
    if fit.rows.iter().any(|&r| r as usize >= data.n_rows()) {
        // A fit can only outlive its dataset through a bug (the cache lives in
        // the session) — refuse rather than index out of range.
        return Err(not_fitted("the cached fit does not belong to the loaded dataset"));
    }

    // ---- hourly points: what the health score is computed on ----
    // Universe = the fitted (training) rows plus the rows of the scoring
    // periods; one point per clock hour with the MEAN target and the MEAN of
    // each predictor (the same selection as the prediction step / the Train
    // pre-warm / the export: `RelHours`).
    let plan = req.test_plan(data);
    let pcols: Vec<usize> = match &plan {
        // The dataset columns are only read for the rows of a scoring period.
        Some(_) => fit
            .predictors
            .iter()
            .map(|p| col_index(data, p, "Predictor"))
            .collect::<Result<_, _>>()?,
        None => Vec::new(),
    };
    let cols = match &plan {
        Some(_) => Some(RelCols {
            target: col_index(data, &fit.target, "Target")?,
            predictors: &pcols,
        }),
        None => None,
    };
    let hours = RelHours::build(data, &RelTrain::of(fit), plan.as_ref().zip(cols.as_ref()));
    let groups = &hours.groups;
    // The engine's answer for each hour's mean predictors (NaN = none), and the
    // residual with the file's rounding.
    let h_pred = hours.predicted(extra);
    let h_resid: Vec<f64> = hours
        .actual
        .iter()
        .zip(&h_pred)
        .map(|(&a, &p)| file_residual(a, p))
        .collect();

    let sp = req.set_points();
    let mut validation = validate_relationship(Some(stats.two_rmse), &sp);
    let valid = !has_errors(&validation);
    if let Some(p) = &plan {
        validation.extend(p.issues.iter().cloned());
    }
    // Hourly scores (NaN = no score: the hour has no prediction).
    let h_scores: Option<Vec<f64>> = if valid {
        RelationshipParams::new(stats.two_rmse, &sp).ok().map(|p| {
            h_resid
                .par_iter()
                .map(|&r| p.score(r).unwrap_or(f64::NAN))
                .collect()
        })
    } else {
        None
    };
    // A training hour holds at least one training row. The summary describes
    // the TRAINING hours; scoring periods have their own results.
    let h_train = groups.any(|i| hours.is_train[i]);
    let summary = h_scores
        .as_ref()
        .map(|sc| hourly_summary(sc, &h_train, groups));

    // RAW rows for the Model fit page: the fit's training rows with the fit's
    // own per-row prediction and the residual the FILE stores. No score, and no
    // row of a scoring period (those are only ever predicted per hour).
    let residual: Vec<f64> = fit
        .actual
        .iter()
        .zip(&fit.predicted)
        .map(|(&a, &p)| file_residual(a, p))
        .collect();
    let sel = select_indices(n_fit, req.max_points(), Some(&residual), None);
    let series = RelationshipSeries {
        rows: pick(&fit.rows, &sel),
        timestamps: sel.iter().map(|&i| ts_text(data, fit.rows[i])).collect(),
        actual: pick(&fit.actual, &sel),
        predicted: opts(&fit.predicted, &sel),
        residual: opts(&residual, &sel),
        score: None,
        total_points: n_fit,
    };
    // The hourly series: residual extremes and the lowest score of every bucket
    // survive the downsample.
    let hsel = select_indices(
        groups.len(),
        req.max_points(),
        Some(&h_resid),
        h_scores.as_deref(),
    );
    let hourly = RelationshipSeries {
        rows: pick(groups.first_rows(), &hsel),
        timestamps: hsel.iter().map(|&h| groups.label(h)).collect(),
        actual: pick(&hours.actual, &hsel),
        predicted: opts(&h_pred, &hsel),
        residual: opts(&h_resid, &hsel),
        score: h_scores.as_ref().map(|sc| opts(sc, &hsel)),
        total_points: groups.len(),
    };

    let sc_idx = stride_indices(n_fit, req.max_scatter());
    let xs = &fit.x_cols[x_idx];
    let fit_scatter = FitScatter {
        x_sensor: fit.predictors[x_idx].clone(),
        predictors: fit.predictors.clone(),
        x: pick(xs, &sc_idx),
        actual: pick(&fit.actual, &sc_idx),
        predicted: opts(&fit.predicted, &sc_idx),
        total: n_fit,
    };

    let test_validation = plan.as_ref().map(|plan| {
        // The train block: the model's own numbers, from the RAW training rows.
        let train_metrics = rel_metrics(fit.actual.iter().copied().zip(fit.predicted.iter().copied()));
        // A period's metrics: over its HOURLY points.
        let metrics_for =
            |hs: &[usize]| rel_metrics(hs.iter().map(|&h| (hours.actual[h], h_pred[h])));
        health_validation::build_hourly(
            plan,
            &health_validation::period_hours(&hours.test_rows, &hours.rows, &hours.is_train, groups),
            &HourlyPoints {
                groups,
                is_train: &h_train,
                scores: h_scores.as_deref(),
            },
            health_validation::sample_interval_secs(data),
            stats.rows,
            train_metrics,
            &metrics_for,
        )
    });

    Ok(HealthPreview {
        kind: "relationship".into(),
        stats: HealthStats::Relationship(stats),
        validation,
        valid,
        series: HealthSeries::Relationship(series),
        hourly: HealthSeries::Relationship(hourly),
        scoring_interval_secs: SCORING_INTERVAL_SECS,
        score_summary: summary,
        histogram: None,
        fit_scatter: Some(fit_scatter),
        cluster_scatter: None,
        test_validation,
    })
}

/// Test helper (every test module that needs a scored Relation preview): the
/// predictions `model(mean predictors)` for every hourly point `req` needs of
/// `fit` - what a successful engine run would have stored.
#[cfg(test)]
pub(crate) fn rel_extra_from_model(
    data: &ColumnarData,
    fit: &RelFit,
    req: &HealthPreviewRequest,
    model: &dyn Fn(&[f64]) -> f64,
) -> RelExtra {
    let plan = req.test_plan(data);
    let pcols: Vec<usize> = match &plan {
        Some(_) => fit.predictors.iter().map(|p| data.col_index(p).expect("predictor column")).collect(),
        None => Vec::new(),
    };
    let cols = plan.as_ref().map(|_| RelCols {
        target: data.col_index(&fit.target).expect("target column"),
        predictors: &pcols,
    });
    let points = RelHours::build(data, &RelTrain::of(fit), plan.as_ref().zip(cols.as_ref())).points();
    let predicted: Vec<f64> = (0..points.len()).map(|i| model(points.x(i))).collect();
    RelExtra::new(&points, &predicted).expect("aligned")
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

/// A cluster's fit rounded exactly as `build_cluster_info` writes it to
/// `CLUS_INFO_*.json` (centre at least as fine as its own axis SD).
pub fn rounded_geom(cluster_id: u32, e: &crate::clustering::EllipseFit) -> ClusterGeom {
    ClusterGeom {
        cluster_id,
        x_center: round_metric_scaled(e.x_center, e.x_sd),
        y_center: round_metric_scaled(e.y_center, e.y_sd),
        x_sd: round_metric(e.x_sd),
        y_sd: round_metric(e.y_sd),
        angle_deg: round_metric(e.angle_deg),
    }
}

pub fn clustering_preview(
    data: &ColumnarData,
    req: &HealthPreviewRequest,
) -> Result<HealthPreview, String> {
    let first = required(&req.first_sensor, "first_sensor")?;
    let second = required(&req.second_sensor, "second_sensor")?;
    let n_clusters = req.n_clusters.unwrap_or(1);
    if n_clusters == 0 {
        return Err(bad_request("n_clusters must be at least 1"));
    }
    // Request-shaped problems are all caught HERE, coded `BAD_REQUEST`, before
    // the shared fit (`clustering_preview_in`, whose plain messages are also
    // used by the PM-page commands and must stay as they are).
    check_clustering_request(
        data,
        first,
        second,
        n_clusters,
        req.criteria_sensor.as_deref(),
        req.cluster_ranges.as_deref(),
        req.filter.as_ref(),
    )?;
    // Fit exactly the way the PM preview and the exported file do (training
    // rows only — test periods never take part in the fit).
    let preview = clustering_preview_in(
        data,
        first.to_string(),
        second.to_string(),
        n_clusters,
        req.criteria_sensor.clone(),
        req.cluster_ranges.clone(),
        req.filter.clone(),
    )
    .map_err(|e| {
        if e.contains("no rows") || e.contains("No rows") {
            no_data(e)
        } else {
            e
        }
    })?;

    let geoms: Vec<ClusterGeom> = preview
        .clusters
        .iter()
        .map(|c| rounded_geom(c.cluster_id, &c.ellipse))
        .collect();
    let stats_clusters: Vec<ClusterStat> = preview
        .clusters
        .iter()
        .zip(&geoms)
        .map(|(c, g)| ClusterStat {
            cluster_id: c.cluster_id,
            range: c.range.clone(),
            n_rows: c.n_rows,
            x_center: g.x_center,
            y_center: g.y_center,
            x_sd: g.x_sd,
            y_sd: g.y_sd,
            angle_deg: g.angle_deg,
        })
        .collect();
    let ranges: Vec<(Option<f64>, Option<f64>)> = if n_clusters > 1 {
        req.cluster_ranges
            .as_ref()
            .map(|r| r.iter().map(|c| (c.min, c.max)).collect())
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let criteria_idx = if n_clusters > 1 {
        preview
            .criteria_sensor
            .as_deref()
            .and_then(|c| data.col_index(c))
    } else {
        None
    };

    let i1 = col_index(data, first, "Sensor")?;
    let i2 = col_index(data, second, "Sensor")?;
    let resolved = ResolvedFilter::resolve(req.filter.as_ref(), &data.headers)
        .map_err(|e| bad_request(format!("invalid training scope: {e}")))?;
    let noop = resolved.is_noop();
    let (c1, c2) = (&data.columns[i1], &data.columns[i2]);

    // Train/Test validation: the rows of every test period (finite X and Y +
    // the running condition's value conditions).
    let plan = req.test_plan(data);
    let with_tests = plan.is_some();
    let test_rows: Vec<Vec<u32>> = plan
        .as_ref()
        .map(|p| p.collect_rows(data, &|r| c1[r].is_finite() && c2[r].is_finite()))
        .unwrap_or_default();
    let in_test = mark_rows(data.n_rows(), &test_rows);
    let is_test = |r: usize| !in_test.is_empty() && in_test[r];

    // Universe: training rows (and, with tests, the test rows) with finite X
    // and Y, plus each row's cluster (0-based; NONE = none).
    const NONE: u32 = u32::MAX;
    let rows: Vec<u32> = (0..data.n_rows())
        .into_par_iter()
        .filter(|&r| {
            c1[r].is_finite()
                && c2[r].is_finite()
                && (noop || is_test(r) || resolved.keeps(data, r))
        })
        .map(|r| r as u32)
        .collect();
    // Training-scope membership of each universe row (only built with tests).
    let is_train: Vec<bool> = if with_tests {
        if noop {
            vec![true; rows.len()]
        } else {
            rows.par_iter()
                .map(|&r| resolved.keeps(data, r as usize))
                .collect()
        }
    } else {
        Vec::new()
    };
    let assign: Vec<u32> = rows
        .par_iter()
        .map(|&r| match criteria_idx {
            Some(ci) => {
                crate::health_score::assign_cluster(data.columns[ci][r as usize], &ranges)
                    .map_or(NONE, |k| k as u32)
            }
            None => 0, // single cluster: every row
        })
        .collect();
    if rows.is_empty() {
        return Err(no_data("No rows remain after dropping nulls."));
    }
    let train_n = if with_tests {
        is_train.iter().filter(|&&t| t).count()
    } else {
        rows.len()
    };
    let assigned = if with_tests {
        assign
            .iter()
            .zip(&is_train)
            .filter(|&(&a, &t)| t && a != NONE)
            .count()
    } else {
        assign.iter().filter(|&&a| a != NONE).count()
    };

    let sp = req.set_points();
    let mut validation = validate_clustering(&geoms, &sp);
    let valid = !has_errors(&validation);
    if let Some(p) = &plan {
        validation.extend(p.issues.iter().cloned());
    }
    let params = if valid {
        ClusteringParams::new(geoms.clone(), &sp).ok()
    } else {
        None
    };

    // ---- hourly points: what the health score is computed on ----
    // Every universe row is in scope (training rows + the rows of the scoring
    // periods), so every row with a timestamp enters its hour's means.
    let groups = HourGroups::build(&data.ts_parsed, &rows, |_| true);
    let h_x = groups.mean(|i| c1[rows[i] as usize]);
    let h_y = groups.mean(|i| c2[rows[i] as usize]);
    // The hour's cluster is the cluster shared by EVERY row of the hour (each
    // row's own `assign`, the same per-row rule the fit uses). An hour whose
    // rows are not all in one cluster - the machine changed state inside the
    // hour, or a row's criteria value is missing / in no range - has NO
    // cluster and so no score (user decision, 2026-10-11): the mean of two
    // states is a point the machine never was at, and the mean criteria value
    // could even name a cluster it never was in. Such an hour is still a point
    // of `hourly` and still counts in `hours`; it is unscored, never 0.
    // A single-cluster model has no criteria: every row, so every hour, is 0.
    let h_assign: Vec<u32> = groups.unanimous(|i| assign[i], NONE);
    // A training hour holds at least one training row (no tests = all of them).
    let h_train: Vec<bool> = if with_tests {
        groups.any(|i| is_train[i])
    } else {
        vec![true; groups.len()]
    };
    // (score, sd_distance) per hour; NaN = none.
    let h_scored: Option<Vec<(f64, f64)>> = params.as_ref().map(|p| {
        (0..groups.len())
            .into_par_iter()
            .map(|h| {
                let a = h_assign[h];
                if a == NONE {
                    return (f64::NAN, f64::NAN);
                }
                p.score(a as usize, h_x[h], h_y[h])
                    .map_or((f64::NAN, f64::NAN), |(s, d)| (s, d))
            })
            .collect()
    });
    let h_scores: Option<Vec<f64>> = h_scored
        .as_ref()
        .map(|v| v.iter().map(|&(s, _)| s).collect());
    // The summary describes the TRAINING hours; scoring periods have their own
    // results.
    let summary = h_scores
        .as_ref()
        .map(|sc| hourly_summary(sc, &h_train, &groups));

    let cl_of = |i: usize| (assign[i] != NONE).then(|| assign[i] + 1);

    // RAW rows for the Model fit page: each row's own cluster and SD distance
    // (the distance needs the validated clusters, as before), no score.
    let row_dist: Option<Vec<f64>> = params.as_ref().map(|p| {
        rows.par_iter()
            .zip(assign.par_iter())
            .map(|(&r, &a)| {
                if a == NONE {
                    return f64::NAN;
                }
                p.score(a as usize, c1[r as usize], c2[r as usize])
                    .map_or(f64::NAN, |(_, d)| d)
            })
            .collect()
    });
    let sel = select_indices(rows.len(), req.max_points(), None, None);
    let series = ClusteringSeries {
        rows: pick(&rows, &sel),
        timestamps: sel.iter().map(|&i| ts_text(data, rows[i])).collect(),
        x: sel.iter().map(|&i| c1[rows[i] as usize]).collect(),
        y: sel.iter().map(|&i| c2[rows[i] as usize]).collect(),
        cluster: sel.iter().map(|&i| cl_of(i)).collect(),
        sd_distance: match &row_dist {
            Some(v) => opts(v, &sel),
            None => sel.iter().map(|_| None).collect(),
        },
        score: None,
        total_points: rows.len(),
    };
    // The hourly series (the lowest and highest score of every bucket survive
    // the downsample, exactly like the scored row series did).
    let hsel = select_indices(groups.len(), req.max_points(), None, h_scores.as_deref());
    let hourly = ClusteringSeries {
        rows: pick(groups.first_rows(), &hsel),
        timestamps: hsel.iter().map(|&h| groups.label(h)).collect(),
        x: pick(&h_x, &hsel),
        y: pick(&h_y, &hsel),
        cluster: hsel
            .iter()
            .map(|&h| (h_assign[h] != NONE).then(|| h_assign[h] + 1))
            .collect(),
        sd_distance: match &h_scored {
            Some(v) => hsel.iter().map(|&h| opt(v[h].1)).collect(),
            None => hsel.iter().map(|_| None).collect(),
        },
        score: h_scores.as_ref().map(|sc| opts(sc, &hsel)),
        total_points: groups.len(),
    };

    // The scatter shows the training rows only.
    let sc_idx: Vec<usize> = if with_tests {
        let tp: Vec<usize> = (0..rows.len()).filter(|&i| is_train[i]).collect();
        stride_indices(tp.len(), req.max_scatter())
            .into_iter()
            .map(|k| tp[k])
            .collect()
    } else {
        stride_indices(rows.len(), req.max_scatter())
    };
    let cluster_scatter = ClusterScatter {
        x: sc_idx.iter().map(|&i| c1[rows[i] as usize]).collect(),
        y: sc_idx.iter().map(|&i| c2[rows[i] as usize]).collect(),
        cluster: sc_idx.iter().map(|&i| cl_of(i)).collect(),
        total: train_n,
    };

    // Distance to the assigned cluster's centre in SD units, from the
    // TRAIN-fitted clusters (independent of the set points; a collapsed
    // cluster has no meaningful distance).
    let dist_of = |a: u32, x: f64, y: f64| -> Option<f64> {
        if a == NONE {
            return None;
        }
        let g = geoms.get(a as usize)?;
        if g.is_degenerate() {
            return None;
        }
        Some(g.sd_distance(x, y)).filter(|d| d.is_finite())
    };
    let ring = |ds: Vec<f64>| -> Option<f64> {
        share_pct(ds.iter().filter(|&&d| d <= crate::health_score::ANCHOR_SD).count(), ds.len())
    };
    // The RAW training rows against their own clusters: the share inside the
    // 3x SD ring. Known with or without scoring periods (without them every
    // row of the universe is a training row).
    let train_ring_pct = ring(
        (0..rows.len())
            .filter(|&i| !with_tests || is_train[i])
            .filter_map(|i| dist_of(assign[i], c1[rows[i] as usize], c2[rows[i] as usize]))
            .collect(),
    );

    let test_validation = plan.as_ref().map(|plan| {
        // The train block: the same share.
        let train_metrics = KindMetrics {
            inside_3sd_ring_pct: train_ring_pct,
            ..Default::default()
        };
        // A period's metric: over its HOURLY points.
        let metrics_for = |hours: &[usize]| KindMetrics {
            inside_3sd_ring_pct: ring(
                hours
                    .iter()
                    .filter_map(|&h| dist_of(h_assign[h], h_x[h], h_y[h]))
                    .collect(),
            ),
            ..Default::default()
        };
        health_validation::build_hourly(
            plan,
            &health_validation::period_hours(&test_rows, &rows, &is_train, &groups),
            &HourlyPoints {
                groups: &groups,
                is_train: &h_train,
                scores: h_scores.as_deref(),
            },
            health_validation::sample_interval_secs(data),
            train_n,
            train_metrics,
            &metrics_for,
        )
    });

    Ok(HealthPreview {
        kind: "clustering".into(),
        stats: HealthStats::Clustering(ClusteringStats {
            rows: train_n,
            assigned_rows: assigned,
            unassigned_rows: train_n - assigned,
            cluster_count: preview.cluster_count,
            criteria_sensor: preview.criteria_sensor.clone(),
            clusters: stats_clusters,
            inside_3sd_ring_pct: train_ring_pct,
        }),
        validation,
        valid,
        series: HealthSeries::Clustering(series),
        hourly: HealthSeries::Clustering(hourly),
        scoring_interval_secs: SCORING_INTERVAL_SECS,
        score_summary: summary,
        histogram: None,
        fit_scatter: None,
        cluster_scatter: Some(cluster_scatter),
        test_validation,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal dataset: timestamp + the given named columns, 1-minute rows.
    fn dataset(cols: Vec<(&str, Vec<f64>)>) -> ColumnarData {
        let n = cols[0].1.len();
        let mut headers = vec!["timestamp".to_string()];
        let mut columns = vec![vec![f64::NAN; n]];
        for (name, c) in cols {
            headers.push(name.to_string());
            columns.push(c);
        }
        let timestamps: Vec<Option<String>> = (0..n)
            .map(|i| {
                Some(format!(
                    "2024-01-{:02}T{:02}:{:02}:00",
                    1 + (i / 1440) % 28,
                    (i / 60) % 24,
                    i % 60
                ))
            })
            .collect();
        ColumnarData::from_parts(headers, timestamps, columns)
    }

    fn req(kind: &str) -> HealthPreviewRequest {
        HealthPreviewRequest {
            kind: kind.into(),
            ..Default::default()
        }
    }

    /// 2000 rows alternating around mean ~100 with SD ~ small.
    fn ind_data() -> (ColumnarData, f64, f64) {
        let v: Vec<f64> = (0..2000)
            .map(|i| 100.0 + ((i * 37 % 101) as f64 - 50.0) / 10.0)
            .collect();
        let (m, s) = mean_sd(&v);
        (dataset(vec![("S", v)]), m, s)
    }

    fn ind_req(l: Option<f64>, h: Option<f64>) -> HealthPreviewRequest {
        HealthPreviewRequest {
            target: Some("S".into()),
            set_points: Some(SetPointsArg {
                lower: l,
                upper: h,
                ..Default::default()
            }),
            ..req("individual")
        }
    }

    /// Stats + the RAW series (`series`: dataset rows, never scored).
    fn individual(p: &HealthPreview) -> (&IndividualStats, &IndividualSeries) {
        match (&p.stats, &p.series) {
            (HealthStats::Individual(s), HealthSeries::Individual(se)) => (s, se),
            _ => panic!("not individual"),
        }
    }

    /// The HOURLY series (`hourly`: one scored point per clock hour).
    fn individual_hourly(p: &HealthPreview) -> &IndividualSeries {
        match &p.hourly {
            HealthSeries::Individual(se) => se,
            _ => panic!("not individual"),
        }
    }

    /// Dataset whose row `i` is `minute_of(i)` minutes after 2024-01-01T00:00
    /// (`None` = the row has no timestamp).
    fn dataset_at(minute_of: &dyn Fn(usize) -> Option<i64>, cols: Vec<(&str, Vec<f64>)>) -> ColumnarData {
        let n = cols[0].1.len();
        let mut headers = vec!["timestamp".to_string()];
        let mut columns = vec![vec![f64::NAN; n]];
        for (name, c) in cols {
            headers.push(name.to_string());
            columns.push(c);
        }
        let t0 = chrono::NaiveDate::from_ymd_opt(2024, 1, 1).unwrap().and_hms_opt(0, 0, 0).unwrap();
        let timestamps: Vec<Option<String>> = (0..n)
            .map(|i| minute_of(i).map(|m| (t0 + chrono::Duration::minutes(m)).format("%Y-%m-%dT%H:%M:%S").to_string()))
            .collect();
        ColumnarData::from_parts(headers, timestamps, columns)
    }

    /// The start of hour `h` counted from 2024-01-01T00:00, as an hourly point
    /// is labelled.
    fn hour_text(h: usize) -> String {
        format!("2024-01-{:02}T{:02}:00:00", 1 + h / 24, h % 24)
    }

    /// The mean the way an independent reader would compute it.
    fn mean_of(v: &[f64]) -> f64 {
        v.iter().sum::<f64>() / v.len() as f64
    }

    fn running(sensor: &str) -> PreviewFilter {
        PreviewFilter {
            value_filters: vec![crate::PreviewValueFilter {
                sensor: sensor.into(),
                operation: "greater_than".into(),
                value1: Some(0.5),
                value2: None,
            }],
            ..Default::default()
        }
    }

    // ---------- individual ----------

    #[test]
    fn individual_stats_use_the_rounded_info_numbers() {
        let (d, m, s) = ind_data();
        let p = individual_preview(&d, &ind_req(None, None)).unwrap();
        let (st, _) = individual(&p);
        let (mr, sr, b1, b3) = individual_rounded_metrics(m, s);
        assert_eq!(st.mean, mr);
        assert_eq!(st.sd, sr);
        assert_eq!(st.boundary_1sd, b1);
        assert_eq!(st.boundary_3sd, b3);
        assert_eq!(st.rows, 2000);
        assert!(st.min <= st.mean && st.mean <= st.max);
    }

    #[test]
    fn individual_without_set_points_returns_stats_raw_series_and_required_issues() {
        let (d, _, _) = ind_data();
        let p = individual_preview(&d, &ind_req(None, None)).unwrap();
        assert!(!p.valid);
        assert_eq!(p.validation.len(), 2);
        assert!(p.validation.iter().all(|i| i.code == "required"));
        assert!(p.score_summary.is_none());
        let (_, se) = individual(&p);
        assert!(se.score.is_none());
        assert!(!se.value.is_empty());
        assert!(p.histogram.is_some());
        // The hourly points are there too (the set-point chart draws them), unscored.
        let h = individual_hourly(&p);
        assert!(h.score.is_none());
        assert_eq!(h.total_points, 34, "2000 one-minute rows = 33 full hours + 20 rows");
        assert_eq!(p.scoring_interval_secs, 3600);
    }

    #[test]
    fn individual_scores_are_between_0_and_100_and_match_the_pure_function() {
        let (d, m, s) = ind_data();
        let (mr, sr, b1, b3) = individual_rounded_metrics(m, s);
        let l = b3[0] - 2.0;
        let h = b3[1] + 2.0;
        let p = individual_preview(&d, &ind_req(Some(l), Some(h))).unwrap();
        assert!(p.valid, "{:?}", p.validation);
        let params = IndividualParams::new(
            IndividualBand::from_rounded(mr, sr, b1, b3),
            &SetPointsArg {
                lower: Some(l),
                upper: Some(h),
                ..Default::default()
            },
        )
        .unwrap();
        // The raw rows are never scored any more...
        let (_, raw) = individual(&p);
        assert!(raw.score.is_none());
        assert_eq!(raw.total_points, 2000);
        // ...the hourly points are: each one is the score of the hour's mean.
        let se = individual_hourly(&p);
        let sc = se.score.as_ref().unwrap();
        assert_eq!(se.total_points, 34);
        assert_eq!(sc.len(), se.value.len());
        let col = &d.columns[1];
        for (k, (v, s)) in se.value.iter().zip(sc).enumerate() {
            let s = s.unwrap();
            assert!((0.0..=100.0).contains(&s));
            assert_eq!(s, params.score(*v).unwrap());
            assert_eq!(*v, mean_of(&col[k * 60..(k * 60 + 60).min(2000)]), "hour {k}");
            assert_eq!(se.rows[k] as usize, k * 60, "the first dataset row of the hour");
            assert_eq!(se.timestamps[k], hour_text(k), "the hour start");
            assert!(se.in_scope[k]);
        }
        let sum = p.score_summary.clone().unwrap();
        assert_eq!((sum.scored, sum.unscored, sum.total_rows), (34, 0, 34), "the summary counts hours");
        assert_eq!(sum.share_basis, "hour_count");
    }

    #[test]
    fn five_minute_rows_give_one_point_per_hour_the_mean_of_its_twelve_rows() {
        // 48 hours of 5-minute rows. Hour 20 runs +5 high and hour 30 +9 high for
        // the WHOLE hour, so they are the only hours that leave the 100 band.
        let n = 12 * 48;
        let v: Vec<f64> = (0..n)
            .map(|i| {
                let base = 100.0 + ((i * 37 % 101) as f64 - 50.0) / 10.0;
                base + match i / 12 {
                    20 => 5.0,
                    30 => 9.0,
                    _ => 0.0,
                }
            })
            .collect();
        let d = dataset_at(&|i| Some(5 * i as i64), vec![("S", v.clone())]);
        assert_eq!(d.sample_interval_secs(), Some(300.0));
        let p0 = individual_preview(&d, &ind_req(None, None)).unwrap();
        let st = individual(&p0).0;
        let (l, h) = (st.boundary_3sd[0] - 4.0, st.boundary_3sd[1] + 4.0);
        let params = IndividualParams::new(
            IndividualBand::from_rounded(st.mean, st.sd, st.boundary_1sd, st.boundary_3sd),
            &SetPointsArg { lower: Some(l), upper: Some(h), ..Default::default() },
        )
        .unwrap();
        let p = individual_preview(&d, &ind_req(Some(l), Some(h))).unwrap();
        assert!(p.valid, "{:?}", p.validation);

        // Training is untouched: the statistics are the raw rows' (576 of them).
        let (st, raw) = individual(&p);
        assert_eq!(st.rows, n);
        let (m, s) = mean_sd(&v);
        assert_eq!((st.mean, st.sd), (individual_rounded_metrics(m, s).0, individual_rounded_metrics(m, s).1));
        assert_eq!(p.histogram.as_ref().unwrap().n, n);
        // The raw series is every row, unscored.
        assert_eq!((raw.total_points, raw.value.clone(), raw.score.is_none()), (n, v.clone(), true));

        // One point per clock hour: mean of exactly its 12 rows.
        let se = individual_hourly(&p);
        assert_eq!((se.total_points, se.rows.len()), (48, 48));
        let sc = se.score.as_ref().unwrap();
        for k in 0..48 {
            assert_eq!(se.value[k], mean_of(&v[12 * k..12 * k + 12]), "hour {k}");
            assert_eq!(se.rows[k] as usize, 12 * k);
            assert_eq!(se.timestamps[k], hour_text(k));
            assert_eq!(sc[k], Some(params.score(se.value[k]).unwrap()), "hour {k}");
        }
        // The two shifted hours are the only ones below 100, hour 30 the lowest.
        let below: Vec<usize> = (0..48).filter(|&k| sc[k].unwrap() < 100.0).collect();
        assert_eq!(below, vec![20, 30]);
        assert!(sc[30].unwrap() < sc[20].unwrap());
        // The summary counts those hours and points at the lowest one by its
        // hour start and first row.
        let sum = p.score_summary.clone().unwrap();
        assert_eq!((sum.scored, sum.unscored, sum.total_rows, sum.share_basis), (48, 0, 48, "hour_count"));
        let min = sum.min_score.unwrap();
        assert_eq!((min.score, min.row), (sc[30].unwrap(), 360));
        assert_eq!(min.timestamp.as_deref(), Some("2024-01-02T06:00:00"));
        let below_80 = (0..48).filter(|&k| sc[k].unwrap() < 80.0).count();
        assert_eq!(sum.pct_below_80, Some(below_80 as f64 * 100.0 / 48.0));
        assert_eq!(p.scoring_interval_secs, 3600);
    }

    #[test]
    fn a_dip_shorter_than_the_hour_is_averaged_not_reported_as_zero() {
        // A 15-minute dip (3 readings) far below L: per row each would score 0;
        // the hour's mean is what is scored now (user decision: 1-hour averages).
        let n = 12 * 24;
        let mut v: Vec<f64> = (0..n).map(|i| 100.0 + ((i * 37 % 101) as f64 - 50.0) / 10.0).collect();
        let d0 = dataset_at(&|i| Some(5 * i as i64), vec![("S", v.clone())]);
        let st0 = individual(&individual_preview(&d0, &ind_req(None, None)).unwrap()).0.boundary_3sd;
        let (l, h) = (st0[0] - 20.0, st0[1] + 20.0);
        for x in &mut v[100..103] {
            *x = l - 5.0; // hour 8, beyond the 0 point
        }
        let d = dataset_at(&|i| Some(5 * i as i64), vec![("S", v.clone())]);
        let p = individual_preview(&d, &ind_req(Some(l), Some(h))).unwrap();
        assert!(p.valid, "{:?}", p.validation);
        let st = individual(&p).0;
        let params = IndividualParams::new(
            IndividualBand::from_rounded(st.mean, st.sd, st.boundary_1sd, st.boundary_3sd),
            &SetPointsArg { lower: Some(l), upper: Some(h), ..Default::default() },
        )
        .unwrap();
        assert_eq!(params.score(v[100]), Some(0.0), "each of those readings alone is a 0");
        let se = individual_hourly(&p);
        let sc = se.score.as_ref().unwrap();
        let hour8 = mean_of(&v[96..108]);
        assert_eq!(se.value[8], hour8);
        assert_eq!(sc[8], Some(params.score(hour8).unwrap()));
        assert!(sc[8].unwrap() > 0.0 && sc[8].unwrap() < 100.0, "the hour is lower, but not a 0: {:?}", sc[8]);
        let min = p.score_summary.clone().unwrap().min_score.unwrap();
        assert_eq!((min.row, min.timestamp.as_deref()), (96, Some("2024-01-01T08:00:00")));
        assert!(min.score > 0.0);
    }

    #[test]
    fn a_partly_running_hour_averages_only_its_running_rows_and_a_stopped_hour_has_no_point() {
        // 4 hours of 5-minute rows. Hour 0 and 3: running. Hour 1: only rows
        // 12..16 run. Hour 2: stopped. A stopped row reads 0 (far from ~100).
        let run = |i: usize| match i / 12 {
            1 => i < 16,
            2 => false,
            _ => true,
        };
        let v: Vec<f64> = (0..48).map(|i| if run(i) { 100.0 + (i % 7) as f64 } else { 0.0 }).collect();
        let g: Vec<f64> = (0..48).map(|i| if run(i) { 1.0 } else { 0.0 }).collect();
        let d = dataset_at(&|i| Some(5 * i as i64), vec![("S", v.clone()), ("G", g)]);
        let mut r = ind_req(None, None);
        r.filter = Some(running("G"));
        let st = individual(&individual_preview(&d, &r).unwrap()).0.boundary_3sd;
        r.set_points = Some(SetPointsArg { lower: Some(st[0] - 5.0), upper: Some(st[1] + 5.0), ..Default::default() });
        let p = individual_preview(&d, &r).unwrap();
        assert!(p.valid, "{:?}", p.validation);
        let se = individual_hourly(&p);
        assert_eq!(se.total_points, 3, "the stopped hour has no point");
        assert_eq!(se.timestamps, vec![hour_text(0), hour_text(1), hour_text(3)]);
        assert_eq!(se.rows, vec![0, 12, 36]);
        assert_eq!(se.value[1], mean_of(&v[12..16]), "only the 4 running rows of the hour are averaged");
        assert!(se.value[1] > 99.0, "the stopped rows' 0 never enters the mean");
        let sc = se.score.as_ref().unwrap();
        assert!(sc.iter().all(|s| s.is_some()), "every point is a running hour and has a score");
        let sum = p.score_summary.clone().unwrap();
        assert_eq!((sum.scored, sum.unscored, sum.total_rows), (3, 0, 3));

        // Asking for the out-of-scope rows adds them to the RAW series only: the
        // hourly points, their scores and the summary are exactly the same.
        r.include_out_of_scope = Some(true);
        let q = individual_preview(&d, &r).unwrap();
        let j = |p: &HealthPreview, k: &str| serde_json::to_value(p).unwrap()[k].clone();
        assert_eq!(j(&q, "hourly"), j(&p, "hourly"));
        assert_eq!(j(&q, "score_summary"), j(&p, "score_summary"));
        let (_, raw) = individual(&q);
        assert_eq!(raw.total_points, 48);
        assert_eq!(raw.in_scope, (0..48).map(run).collect::<Vec<_>>());
        assert!(raw.score.is_none());
    }

    #[test]
    fn hourly_points_do_not_depend_on_the_row_order_of_the_file() {
        // The same 48 readings, once in time order and once shuffled in the file.
        let n = 48usize;
        let sorted: Vec<f64> = (0..n).map(|k| 100.0 + ((k * 37 % 101) as f64 - 50.0) / 10.0).collect();
        let perm = |i: usize| (i * 7 + 5) % n; // file row i holds the reading of slot perm(i)
        let shuffled: Vec<f64> = (0..n).map(|i| sorted[perm(i)]).collect();
        let a = dataset_at(&|k| Some(5 * k as i64), vec![("S", sorted)]);
        let b = dataset_at(&|i| Some(5 * perm(i) as i64), vec![("S", shuffled)]);
        let st = individual(&individual_preview(&a, &ind_req(None, None)).unwrap()).0.boundary_3sd;
        let rq = ind_req(Some(st[0] - 3.0), Some(st[1] + 3.0));
        let (pa, pb) = (individual_preview(&a, &rq).unwrap(), individual_preview(&b, &rq).unwrap());
        let (ha, hb) = (individual_hourly(&pa), individual_hourly(&pb));
        assert_eq!(hb.total_points, 4);
        assert_eq!(hb.timestamps, ha.timestamps, "the points come out in time order");
        assert_eq!(hb.timestamps, (0..4).map(hour_text).collect::<Vec<_>>());
        for k in 0..4 {
            assert!((ha.value[k] - hb.value[k]).abs() < 1e-9, "hour {k}: {} vs {}", ha.value[k], hb.value[k]);
            let (sa, sb) = (ha.score.as_ref().unwrap()[k].unwrap(), hb.score.as_ref().unwrap()[k].unwrap());
            assert!((sa - sb).abs() < 1e-6, "hour {k}: {sa} vs {sb}");
            // `rows` = the lowest file row of the hour.
            let first = (0..n).find(|&i| perm(i) / 12 == k).unwrap();
            assert_eq!(hb.rows[k] as usize, first);
        }
        assert_eq!(pa.score_summary.as_ref().unwrap().scored, pb.score_summary.as_ref().unwrap().scored);
    }

    #[test]
    fn a_row_without_a_timestamp_stays_in_the_raw_series_but_has_no_hourly_point() {
        let v: Vec<f64> = (0..24).map(|i| 50.0 + (i % 5) as f64).collect();
        let d = dataset_at(&|i| if i == 5 || i == 13 { None } else { Some(5 * i as i64) }, vec![("S", v.clone())]);
        let st = individual(&individual_preview(&d, &ind_req(None, None)).unwrap()).0.boundary_3sd;
        let p = individual_preview(&d, &ind_req(Some(st[0] - 3.0), Some(st[1] + 3.0))).unwrap();
        assert!(p.valid, "{:?}", p.validation);
        // No time gate: the rows train the model and are in the raw series...
        let (st, raw) = individual(&p);
        assert_eq!((st.rows, raw.total_points), (24, 24));
        assert_eq!((raw.timestamps[5].as_str(), raw.timestamps[13].as_str()), ("", ""));
        // ...but they belong to no hour, so they are in no mean.
        let se = individual_hourly(&p);
        assert_eq!(se.total_points, 2);
        let h0: Vec<f64> = (0..12).filter(|&i| i != 5).map(|i| v[i]).collect();
        let h1: Vec<f64> = (12..24).filter(|&i| i != 13).map(|i| v[i]).collect();
        assert_eq!(se.value, vec![mean_of(&h0), mean_of(&h1)]);
        assert_eq!(p.score_summary.clone().unwrap().scored, 2);
        // A dataset with no timestamp at all: the model still fits, nothing is scored.
        let none = dataset_at(&|_| None, vec![("S", v)]);
        let p = individual_preview(&none, &ind_req(Some(st.boundary_3sd[0] - 3.0), Some(st.boundary_3sd[1] + 3.0))).unwrap();
        assert!(p.valid);
        assert_eq!(individual_hourly(&p).total_points, 0);
        assert_eq!(individual_hourly(&p).score.as_deref(), Some(&[][..]));
        let sum = p.score_summary.clone().unwrap();
        assert_eq!((sum.scored, sum.total_rows, sum.min_score, sum.pct_below_80), (0, 0, None, None));
        assert!(!serde_json::to_string(&p).unwrap().contains("NaN"));
    }

    #[test]
    fn data_already_at_one_hour_or_two_hours_is_scored_point_for_point() {
        let v: Vec<f64> = (0..200).map(|i| 100.0 + ((i * 37 % 101) as f64 - 50.0) / 10.0).collect();
        for (step, offset) in [(60i64, 0i64), (120, 30)] {
            let d = dataset_at(&|i| Some(offset + step * i as i64), vec![("S", v.clone())]);
            let p0 = individual_preview(&d, &ind_req(None, None)).unwrap();
            let st = individual(&p0).0;
            let sp = SetPointsArg {
                lower: Some(st.boundary_3sd[0] - 3.0),
                upper: Some(st.boundary_3sd[1] + 3.0),
                ..Default::default()
            };
            let params = IndividualParams::new(
                IndividualBand::from_rounded(st.mean, st.sd, st.boundary_1sd, st.boundary_3sd),
                &sp,
            )
            .unwrap();
            let p = individual_preview(&d, &ind_req(sp.lower, sp.upper)).unwrap();
            let (_, raw) = individual(&p);
            let se = individual_hourly(&p);
            // One point per row: the "mean" of a single reading is the reading.
            assert_eq!(se.total_points, 200, "step {step}: no hour is merged and none is invented");
            assert_eq!(se.value, v, "step {step}");
            assert_eq!(se.rows, raw.rows, "step {step}");
            let sc = se.score.as_ref().unwrap();
            for i in 0..200 {
                assert_eq!(sc[i], Some(params.score(v[i]).unwrap()), "step {step} row {i}");
            }
            if offset == 0 {
                assert_eq!(se.timestamps, raw.timestamps, "1 h rows already sit on the hour start");
            } else {
                // Rows at xx:30 are labelled with their hour's start.
                assert_eq!(raw.timestamps[1], "2024-01-01T02:30:00");
                assert_eq!(se.timestamps[1], "2024-01-01T02:00:00");
                assert_eq!(se.timestamps[2], "2024-01-01T04:00:00", "the odd hours in between have no point");
            }
            assert_eq!(p.score_summary.clone().unwrap().scored, 200);
        }
    }

    #[test]
    fn individual_validation_is_rerun_when_the_scope_changes_sigma() {
        // The same set points are valid under a narrow Running condition (small
        // σ) and invalid once the scope widens (large σ pushes 3σ past H).
        let mut v: Vec<f64> = (0..1000).map(|i| 100.0 + (i % 5) as f64 * 0.1).collect();
        v.extend((0..1000).map(|i| 100.0 + (i % 7) as f64 * 30.0));
        let g: Vec<f64> = (0..2000).map(|i| if i < 1000 { 1.0 } else { 2.0 }).collect();
        let d = dataset(vec![("S", v), ("G", g)]);
        let mut r = ind_req(Some(60.0), Some(200.0));
        // Narrow scope (G == 1): σ ~0.14 → fine.
        r.filter = Some(PreviewFilter {
            value_filters: vec![crate::PreviewValueFilter {
                sensor: "G".into(),
                operation: "less_than".into(),
                value1: Some(1.5),
                value2: None,
            }],
            ..Default::default()
        });
        let narrow = individual_preview(&d, &r).unwrap();
        assert!(narrow.valid, "{:?}", narrow.validation);
        // Wide scope (everything): σ is large, 3σ passes the set points.
        r.filter = None;
        let wide = individual_preview(&d, &r).unwrap();
        assert!(!wide.valid);
        assert!(wide
            .validation
            .iter()
            .any(|i| i.code == "upper_inside_3sd" || i.code == "lower_inside_3sd"));
        let (ns, _) = individual(&narrow);
        let (ws, _) = individual(&wide);
        assert!(ws.sd > ns.sd * 10.0);
    }

    #[test]
    fn individual_constant_sensor_reports_degenerate_band() {
        let d = dataset(vec![("S", vec![5.0; 100])]);
        let p = individual_preview(&d, &ind_req(Some(1.0), Some(9.0))).unwrap();
        assert!(!p.valid);
        assert!(p.validation.iter().any(|i| i.code == "degenerate_band"));
        assert!(p.score_summary.is_none());
        let h = p.histogram.unwrap();
        assert_eq!(h.counts, vec![100]);
    }

    #[test]
    fn individual_out_of_scope_rows_have_no_score_not_zero() {
        let v: Vec<f64> = (0..400).map(|i| 100.0 + (i % 9) as f64).collect();
        let g: Vec<f64> = (0..400).map(|i| if i < 200 { 1.0 } else { 0.0 }).collect();
        let d = dataset(vec![("S", v.clone()), ("G", g)]);
        let mut r = ind_req(None, None);
        r.filter = Some(running("G"));
        // Stats are from the 200 in-scope rows.
        let p = individual_preview(&d, &r).unwrap();
        assert_eq!(individual(&p).0.rows, 200);
        assert_eq!(individual(&p).1.total_points, 200);

        // Fill in set points and ask for the out-of-scope rows too.
        let st = individual(&p).0;
        r.set_points = Some(SetPointsArg {
            lower: Some(st.boundary_3sd[0] - 1.0),
            upper: Some(st.boundary_3sd[1] + 1.0),
            ..Default::default()
        });
        r.include_out_of_scope = Some(true);
        let p = individual_preview(&d, &r).unwrap();
        assert!(p.valid, "{:?}", p.validation);
        let (st2, se) = individual(&p);
        assert_eq!(st2.rows, 200, "stats still only use the in-scope rows");
        // The raw series shows all 400 rows with their scope flag - and no score.
        assert_eq!(se.total_points, 400);
        assert_eq!(se.in_scope.iter().filter(|&&s| s).count(), 200);
        assert!(se.score.is_none());
        // The hourly points exist only where a row is in scope: hours 0..=2 are
        // whole, hour 3 has 20 in-scope rows (180..200), hours 4.. have none.
        let h = individual_hourly(&p);
        assert_eq!(h.total_points, 4, "an hour with no in-scope row has no point, not a 0");
        assert_eq!(h.value[3], mean_of(&v[180..200]), "out-of-scope rows never enter a mean");
        assert!(h.in_scope.iter().all(|&s| s));
        let sc = h.score.as_ref().unwrap();
        assert!(sc.iter().all(|s| s.is_some()));
        let sum = p.score_summary.clone().unwrap();
        assert_eq!((sum.scored, sum.unscored, sum.total_rows), (4, 0, 4));
    }

    #[test]
    fn individual_missing_values_are_not_in_the_series() {
        let mut v: Vec<f64> = (0..100).map(|i| 50.0 + (i % 5) as f64).collect();
        v[10] = f64::NAN;
        v[20] = f64::NAN;
        let d = dataset(vec![("S", v)]);
        let p = individual_preview(&d, &ind_req(None, None)).unwrap();
        let (st, se) = individual(&p);
        assert_eq!(st.rows, 98);
        assert_eq!(se.total_points, 98);
        assert!(!se.rows.contains(&10) && !se.rows.contains(&20));
    }

    #[test]
    fn individual_series_is_bounded_and_keeps_the_spike_and_the_lowest_score() {
        // 600 hours of one-minute rows; row 31 337 spikes for one minute and
        // hour 400 (rows 24 000..24 060) runs high for the whole hour.
        let n = 36_000;
        let mut v: Vec<f64> = (0..n).map(|i| 100.0 + ((i * 7919) % 11) as f64 * 0.1).collect();
        v[31_337] = 100.0 + 25.0; // spike (σ is ~0.3 so far beyond 3σ)
        for x in &mut v[24_000..24_060] {
            *x += 20.0;
        }
        let d = dataset(vec![("S", v)]);
        let p0 = individual_preview(&d, &ind_req(None, None)).unwrap();
        let st = individual(&p0).0;
        let mut r = ind_req(Some(st.boundary_3sd[0] - 5.0), Some(st.boundary_3sd[1] + 30.0));
        r.max_points = Some(500);
        let p = individual_preview(&d, &r).unwrap();
        assert!(p.valid, "{:?}", p.validation);
        // RAW series: bounded, the one-minute spike survives the downsample.
        let (_, se) = individual(&p);
        assert!(se.rows.len() <= 500, "{}", se.rows.len());
        assert_eq!(se.total_points, n);
        assert!(se.rows.contains(&31_337), "spike must survive downsampling");
        assert!(se.score.is_none());
        // HOURLY series: bounded by the same cap; the lowest hour survives it.
        let h = individual_hourly(&p);
        assert!(h.rows.len() <= 500, "{}", h.rows.len());
        assert_eq!(h.total_points, 600);
        let sum = p.score_summary.clone().unwrap();
        assert_eq!(sum.scored, 600);
        let min = sum.min_score.unwrap();
        assert_eq!(min.row, 24_000, "the first row of the lowest hour");
        assert_eq!(min.timestamp.as_deref(), Some(hour_text(400).as_str()));
        let at = h.rows.iter().position(|&r| r == 24_000).expect("the lowest hour is shipped");
        assert_eq!(h.timestamps[at], hour_text(400));
        let sc = h.score.as_ref().unwrap();
        let shipped_min = sc.iter().flatten().cloned().fold(f64::INFINITY, f64::min);
        assert_eq!(shipped_min, min.score);
        assert_eq!(sc[at], Some(min.score));
        // The hour of the one-minute spike is only a little off (its mean), and
        // its highest VALUE is kept by the downsample too.
        let spike_hour = h.rows.iter().position(|&r| r == 31_320).expect("the spike's hour is shipped");
        assert!(sc[spike_hour].unwrap() > min.score);
    }

    #[test]
    fn individual_histogram_covers_exactly_the_in_scope_rows() {
        let (d, _, _) = ind_data();
        let p = individual_preview(&d, &ind_req(None, None)).unwrap();
        let h = p.histogram.unwrap();
        assert_eq!(h.counts.iter().sum::<usize>(), 2000);
        assert!(h.counts.len() <= 80);
    }

    #[test]
    fn individual_errors_are_coded() {
        let (d, _, _) = ind_data();
        let mut r = ind_req(None, None);
        r.target = Some("NOPE".into());
        assert!(individual_preview(&d, &r).unwrap_err().starts_with("BAD_REQUEST"));
        r.target = None;
        assert!(individual_preview(&d, &r).unwrap_err().starts_with("BAD_REQUEST"));
        let empty = dataset(vec![("S", vec![f64::NAN; 10])]);
        let r = ind_req(None, None);
        assert!(individual_preview(&empty, &r).unwrap_err().starts_with("NO_DATA"));
    }

    // ---------- relationship ----------

    fn rel_fit(n: usize) -> RelFit {
        // actual = 2x + noise; predicted = 2x  =>  residual = noise.
        let x: Vec<f64> = (0..n).map(|i| i as f64 * 0.01).collect();
        let noise = |i: usize| (((i * 7919) % 21) as f64 - 10.0) * 0.1; // ±1
        let actual: Vec<f64> = (0..n).map(|i| 2.0 * x[i] + noise(i)).collect();
        let predicted: Vec<f64> = x.iter().map(|v| 2.0 * v).collect();
        RelFit {
            target: "Y".into(),
            predictors: vec!["X".into(), "Z".into()],
            lambda: 1.0,
            rows: (0..n as u32).collect(),
            actual,
            predicted,
            x_cols: vec![x.clone(), x.iter().map(|v| v * 3.0).collect()],
            r2_per_step: vec![0.5, 0.97],
            rmse2_per_step: vec![1.4, 1.2],
        }
    }

    fn rel_req(sp: Option<SetPointsArg>) -> HealthPreviewRequest {
        HealthPreviewRequest {
            target: Some("Y".into()),
            predictors: vec!["X".into(), "Z".into()],
            cache_key: Some("k".into()),
            set_points: sp,
            ..req("relationship")
        }
    }

    fn rel(p: &HealthPreview) -> (&RelationshipStats, &RelationshipSeries) {
        match (&p.stats, &p.series) {
            (HealthStats::Relationship(s), HealthSeries::Relationship(se)) => (s, se),
            _ => panic!("not relationship"),
        }
    }

    /// `hourly` of a Relationship preview: one scored point per clock hour.
    fn rel_hourly(p: &HealthPreview) -> &RelationshipSeries {
        match &p.hourly {
            HealthSeries::Relationship(se) => se,
            _ => panic!("not relationship"),
        }
    }

    #[test]
    fn relationship_stats_match_the_info_file_computation() {
        let fit = rel_fit(3000);
        let s = relationship_stats(&fit).unwrap();
        let y: Vec<f64> = fit.actual.clone();
        let p: Vec<f64> = fit.predicted.iter().map(|&v| round_metric(v)).collect();
        assert_eq!(s.two_rmse, round_metric(2.0 * metrics::rmse(&y, &p)));
        assert_eq!(s.rows, 3000);
        assert!(s.r2 > 0.9 && s.r2 <= 1.0);
        assert!((s.rmse * 2.0 - s.two_rmse).abs() < 0.01);
        assert!(s.residual_mean.abs() < 0.1);
        assert!(s.residual_min < 0.0 && s.residual_max > 0.0);
        assert_eq!(s.r2_per_step, vec![0.5, 0.97]);
    }

    /// The model of [`rel_fit`] as the engine would answer for an hourly point:
    /// `2 * mean X` (X is the first predictor).
    fn two_x(x: &[f64]) -> f64 {
        2.0 * x[0]
    }

    /// Set points that are valid for a band of half-width `w`.
    fn rel_sp(w: f64) -> SetPointsArg {
        SetPointsArg {
            residual_at_80_lower: Some(-(w + 1.0)),
            residual_at_80_upper: Some(w + 1.0),
            residual_at_0_lower: Some(-(w + 4.0)),
            residual_at_0_upper: Some(w + 4.0),
            ..Default::default()
        }
    }

    #[test]
    fn relationship_without_set_points_still_returns_series_and_stats() {
        let fit = rel_fit(500);
        let d = dataset(vec![("A", vec![0.0; 500])]);
        let p = relationship_preview(&d, &fit, &rel_req(None)).unwrap();
        assert!(!p.valid);
        assert_eq!(p.validation.iter().filter(|i| i.code == "required").count(), 4);
        let (_, se) = rel(&p);
        assert!(se.score.is_none());
        assert_eq!(se.rows.len(), 500);
        // 500 one-minute rows = 9 clock hours (8 full ones and 20 minutes).
        let h = rel_hourly(&p);
        assert!(h.score.is_none());
        assert_eq!((h.total_points, h.rows.len()), (9, 9));
        assert_eq!(h.rows, (0..9).map(|k| k * 60).collect::<Vec<u32>>(), "the first row of each hour");
        assert_eq!(h.timestamps[1], hour_text(1));
        assert!(p.fit_scatter.is_some());
    }

    #[test]
    fn relationship_scores_the_hourly_mean_through_the_model_with_the_validated_set_points() {
        let fit = rel_fit(2000);
        let d = dataset(vec![("A", vec![0.0; 2000])]);
        let stats = relationship_stats(&fit).unwrap();
        let w = stats.two_rmse;
        let sp = rel_sp(w);
        let req = rel_req(Some(sp.clone()));
        let extra = rel_extra_from_model(&d, &fit, &req, &two_x);
        let p = relationship_preview_ex(&d, &fit, Some(&extra), &req).unwrap();
        assert!(p.valid, "{:?}", p.validation);
        // The raw series: the fit's rows with the fit's per-row prediction and
        // the residual the file stores - never a score.
        let (_, raw) = rel(&p);
        assert!(raw.score.is_none());
        assert_eq!(raw.total_points, 2000);
        for (k, &row) in raw.rows.iter().enumerate() {
            let i = row as usize;
            assert_eq!(raw.residual[k], Some(file_residual(fit.actual[i], fit.predicted[i])));
        }
        // The hourly series: 2000 one-minute rows = 34 hours (33 full + 20 min).
        let se = rel_hourly(&p);
        assert_eq!(se.total_points, 34);
        let params = RelationshipParams::new(w, &sp).unwrap();
        let sc = se.score.as_ref().unwrap();
        for h in 0..34 {
            let rows: Vec<usize> = (h * 60..((h + 1) * 60).min(2000)).collect();
            // Mean target of the hour; the model's answer for the hour's MEAN X.
            let actual = mean_of(&rows.iter().map(|&i| fit.actual[i]).collect::<Vec<_>>());
            let x_mean = mean_of(&rows.iter().map(|&i| fit.x_cols[0][i]).collect::<Vec<_>>());
            assert!((se.actual[h] - actual).abs() < 1e-9, "hour {h}");
            assert!((se.predicted[h].unwrap() - 2.0 * x_mean).abs() < 1e-9, "hour {h}");
            // residual = file_residual(mean actual, prediction), then the score of it.
            let r = se.residual[h].unwrap();
            assert_eq!(r, file_residual(se.actual[h], se.predicted[h].unwrap()), "hour {h}");
            assert_eq!(sc[h].unwrap(), params.score(r).unwrap(), "hour {h}");
            assert_eq!(se.timestamps[h], hour_text(h));
            assert_eq!(se.rows[h] as usize, h * 60);
        }
        // The +-1 row noise averages out over an hour: every hour sits in the band.
        assert!(sc.iter().all(|s| s.unwrap() == 100.0));
        let sum = p.score_summary.clone().unwrap();
        assert_eq!((sum.scored, sum.unscored, sum.total_rows), (34, 0, 34), "the summary counts HOURS");
        assert_eq!(sum.share_basis, "hour_count");
        let m = sum.min_score.unwrap();
        assert_eq!((m.row, m.timestamp.as_deref()), (0, Some(hour_text(0).as_str())));
        assert_eq!(p.scoring_interval_secs, 3600);
    }

    #[test]
    fn relationship_hourly_prediction_is_the_model_at_the_mean_inputs_not_a_mean_of_row_predictions() {
        // A model that curves: y = x^2. Per row the fit predicts x^2 exactly; the
        // hourly point is the hour's MEAN x pushed through the model, which is
        // NOT the mean of the row predictions.
        let n = 240;
        let x: Vec<f64> = (0..n).map(|i| i as f64 * 0.1).collect();
        let fit = RelFit {
            target: "Y".into(),
            predictors: vec!["X".into()],
            lambda: 1.0,
            rows: (0..n as u32).collect(),
            actual: x.iter().map(|v| v * v + if (*v as usize) % 2 == 0 { 0.4 } else { -0.4 }).collect(),
            predicted: x.iter().map(|v| v * v).collect(),
            x_cols: vec![x.clone()],
            r2_per_step: vec![],
            rmse2_per_step: vec![],
        };
        let d = dataset(vec![("A", vec![0.0; n])]);
        let mut req = rel_req(None);
        req.predictors = vec!["X".into()];
        let extra = rel_extra_from_model(&d, &fit, &req, &|x| x[0] * x[0]);
        let p = relationship_preview_ex(&d, &fit, Some(&extra), &req).unwrap();
        let se = rel_hourly(&p);
        assert_eq!(se.total_points, 4);
        for h in 0..4 {
            let xs = &x[h * 60..(h + 1) * 60];
            let at_mean = mean_of(xs).powi(2);
            let mean_of_row_predictions = mean_of(&xs.iter().map(|v| v * v).collect::<Vec<_>>());
            assert!((se.predicted[h].unwrap() - at_mean).abs() < 1e-9, "hour {h}");
            assert!((at_mean - mean_of_row_predictions).abs() > 1.0, "the two really differ here");
            assert_eq!(se.residual[h], Some(file_residual(se.actual[h], se.predicted[h].unwrap())));
        }
    }

    #[test]
    fn relationship_invalid_set_points_are_reported_and_block_the_score() {
        let fit = rel_fit(300);
        let d = dataset(vec![("A", vec![0.0; 300])]);
        let w = relationship_stats(&fit).unwrap().two_rmse;
        let sp = SetPointsArg {
            residual_at_80_lower: Some(-w), // equals the band edge
            residual_at_80_upper: Some(w + 1.0),
            residual_at_0_lower: Some(-(w + 4.0)),
            residual_at_0_upper: Some(w + 4.0),
            ..Default::default()
        };
        let req = rel_req(Some(sp));
        let extra = rel_extra_from_model(&d, &fit, &req, &two_x);
        let p = relationship_preview_ex(&d, &fit, Some(&extra), &req).unwrap();
        assert!(!p.valid);
        assert!(p.validation.iter().any(|i| i.code == "point80_equals_band"));
        assert!(rel(&p).1.score.is_none() && rel_hourly(&p).score.is_none());
        // The hourly values are still there (the set-point chart draws them).
        assert!(rel_hourly(&p).residual.iter().all(Option::is_some));
        assert!(p.score_summary.is_none());
    }

    #[test]
    fn relationship_hour_without_a_prediction_is_unscored_not_zero() {
        let mut fit = rel_fit(300);
        fit.predicted[40] = f64::NAN; // a training ROW the engine gave no prediction for
        let d = dataset(vec![("A", vec![0.0; 300])]);
        let w = relationship_stats(&fit).unwrap().two_rmse;
        let req = rel_req(Some(rel_sp(w)));
        // The engine answered for every hour but hour 2 (NaN = it returned none).
        let x_hour2 = mean_of(&fit.x_cols[0][120..180]);
        let extra = rel_extra_from_model(&d, &fit, &req, &|x| if (x[0] - x_hour2).abs() < 1e-9 { f64::NAN } else { two_x(x) });
        let p = relationship_preview_ex(&d, &fit, Some(&extra), &req).unwrap();
        assert!(p.valid);
        let se = rel_hourly(&p);
        assert_eq!(se.total_points, 5);
        assert!(se.predicted[2].is_none() && se.residual[2].is_none());
        let sc = se.score.as_ref().unwrap();
        assert!(sc[2].is_none(), "null, never 0");
        assert!(sc.iter().enumerate().all(|(h, s)| h == 2 || s.is_some()));
        // A row without a per-row prediction does not touch the hourly point: the
        // hour's prediction comes from the hour's mean predictors.
        assert!(sc[0].is_some());
        let sum = p.score_summary.clone().unwrap();
        assert_eq!((sum.scored, sum.unscored, sum.total_rows), (4, 1, 5));
        // The raw series shows that row as it is: no prediction, no residual.
        let (_, raw) = rel(&p);
        let at = raw.rows.iter().position(|&r| r == 40).unwrap();
        assert!(raw.predicted[at].is_none() && raw.residual[at].is_none());

        // No stored prediction at all (the engine never answered): every hour is
        // unscored - valid set points, a summary with nothing scored, no panic.
        let none = relationship_preview(&d, &fit, &req).unwrap();
        assert!(none.valid);
        let h = rel_hourly(&none);
        assert_eq!(h.total_points, 5);
        assert!(h.predicted.iter().all(Option::is_none) && h.residual.iter().all(Option::is_none));
        assert!(h.score.as_ref().unwrap().iter().all(Option::is_none));
        assert!(h.actual.iter().all(|v| v.is_finite()), "the hourly mean target is still there");
        let sum = none.score_summary.clone().unwrap();
        assert_eq!((sum.scored, sum.unscored, sum.total_rows), (0, 5, 5));
        assert!(sum.min_score.is_none() && sum.pct_below_80.is_none());
        // The model-fit side is exactly the same either way.
        let (a, b) = (serde_json::to_value(&p).unwrap(), serde_json::to_value(&none).unwrap());
        for key in ["stats", "series", "fit_scatter", "valid"] {
            assert_eq!(a[key], b[key], "{key}");
        }
    }

    #[test]
    fn relationship_predictions_of_other_means_are_never_used_for_an_hour() {
        // Predictions stored for a fit whose hour 1 had OTHER mean predictors
        // (here: a shorter fit, so hour 1 is only half covered) must not score
        // hour 1 of this fit.
        let d = dataset(vec![("A", vec![0.0; 180])]);
        let short = rel_fit(90);
        let full = rel_fit(180);
        let req = rel_req(Some(rel_sp(relationship_stats(&full).unwrap().two_rmse)));
        let stale = rel_extra_from_model(&d, &short, &req, &two_x);
        let p = relationship_preview_ex(&d, &full, Some(&stale), &req).unwrap();
        let sc = rel_hourly(&p).score.clone().unwrap();
        assert!(sc[0].is_some(), "hour 0 has the same rows and so the same means in both");
        assert!(sc[1].is_none(), "hour 1 has other means: its stored prediction does not apply");
        assert!(sc[2].is_none(), "hour 2 was never predicted");
    }

    #[test]
    fn relationship_mismatched_target_or_predictors_is_not_fitted() {
        let fit = rel_fit(50);
        let d = dataset(vec![("A", vec![0.0; 50])]);
        let mut r = rel_req(None);
        r.target = Some("Other".into());
        assert!(relationship_preview(&d, &fit, &r).unwrap_err().starts_with("NOT_FITTED"));
        let mut r = rel_req(None);
        r.predictors = vec!["Z".into(), "X".into()];
        assert!(relationship_preview(&d, &fit, &r).unwrap_err().starts_with("NOT_FITTED"));
        let mut r = rel_req(None);
        r.x_predictor = Some("nope".into());
        assert!(relationship_preview(&d, &fit, &r).unwrap_err().starts_with("BAD_REQUEST"));
    }

    #[test]
    fn relationship_fit_scatter_uses_the_chosen_predictor_and_is_bounded() {
        let fit = rel_fit(5000);
        let d = dataset(vec![("A", vec![0.0; 5000])]);
        let mut r = rel_req(None);
        r.max_scatter_points = Some(100);
        r.x_predictor = Some("Z".into());
        let p = relationship_preview(&d, &fit, &r).unwrap();
        let sc = p.fit_scatter.unwrap();
        assert_eq!(sc.x_sensor, "Z");
        assert_eq!(sc.x.len(), 100);
        assert_eq!(sc.actual.len(), 100);
        assert_eq!(sc.total, 5000);
        // Z = 3x, so x values are the Z column.
        assert!((sc.x[1] - fit.x_cols[1][50]).abs() < 1e-12);
    }

    #[test]
    fn relationship_series_is_bounded_and_keeps_the_residual_spike() {
        let mut fit = rel_fit(40_000);
        fit.actual[22_222] += 50.0; // residual spike
        let d = dataset(vec![("A", vec![0.0; 40_000])]);
        let mut r = rel_req(None);
        r.max_points = Some(400);
        let extra = rel_extra_from_model(&d, &fit, &r, &two_x);
        let p = relationship_preview_ex(&d, &fit, Some(&extra), &r).unwrap();
        let (_, se) = rel(&p);
        assert!(se.rows.len() <= 400);
        assert_eq!(se.total_points, 40_000);
        assert!(se.rows.contains(&22_222));
        // The hourly series is bounded by the same cap (667 hours here) and keeps
        // the hour that holds the spike (hour 370 = rows 22 200..22 260).
        let h = rel_hourly(&p);
        assert_eq!(h.total_points, 667);
        assert!(h.rows.len() <= 400);
        assert!(h.rows.contains(&22_200), "the hour with the residual spike survives the downsample");
        assert!(h.rows.windows(2).all(|w| w[0] < w[1]));
    }

    // ---------- clustering ----------

    /// Two clean clusters on a criteria sensor C: C<10 → around (0,0),
    /// C>=10 → around (50,50).
    fn cl_data() -> ColumnarData {
        let n = 2000;
        let mut x = Vec::new();
        let mut y = Vec::new();
        let mut c = Vec::new();
        for i in 0..n {
            let a = (i as f64) * 0.618;
            let (cx, cy, crit) = if i % 2 == 0 { (0.0, 0.0, 5.0) } else { (50.0, 50.0, 15.0) };
            x.push(cx + (a.sin()) * 2.0 + ((i * 31 % 17) as f64 - 8.0) * 0.1);
            y.push(cy + (a.cos()) * 1.0 + ((i * 17 % 13) as f64 - 6.0) * 0.1);
            c.push(crit);
        }
        dataset(vec![("X", x), ("Y", y), ("C", c)])
    }

    fn cl_req(n: u32, outer: Option<f64>) -> HealthPreviewRequest {
        HealthPreviewRequest {
            first_sensor: Some("X".into()),
            second_sensor: Some("Y".into()),
            n_clusters: Some(n),
            criteria_sensor: if n > 1 { Some("C".into()) } else { None },
            cluster_ranges: if n > 1 {
                Some(vec![
                    ClusterRange { min: None, max: Some(10.0) },
                    ClusterRange { min: Some(10.0), max: None },
                ])
            } else {
                None
            },
            set_points: Some(SetPointsArg {
                outer_sd: outer,
                ..Default::default()
            }),
            ..req("clustering")
        }
    }

    /// Stats + the RAW series (dataset rows, never scored).
    fn clus(p: &HealthPreview) -> (&ClusteringStats, &ClusteringSeries) {
        match (&p.stats, &p.series) {
            (HealthStats::Clustering(s), HealthSeries::Clustering(se)) => (s, se),
            _ => panic!("not clustering"),
        }
    }

    /// The HOURLY series (one scored point per clock hour).
    fn clus_hourly(p: &HealthPreview) -> &ClusteringSeries {
        match &p.hourly {
            HealthSeries::Clustering(se) => se,
            _ => panic!("not clustering"),
        }
    }

    /// Like [`cl_data`], but the machine changes state by the HOUR (one-minute
    /// rows): `state_of(row)` = 0 -> C = 5 around (0, 0), 1 -> C = 15 around
    /// (50, 50).
    fn cl_data_by(n: usize, state_of: &dyn Fn(usize) -> usize) -> ColumnarData {
        let (mut x, mut y, mut c) = (Vec::new(), Vec::new(), Vec::new());
        for i in 0..n {
            let a = (i as f64) * 0.618;
            let (cx, cy, crit) = [(0.0, 0.0, 5.0), (50.0, 50.0, 15.0)][state_of(i)];
            x.push(cx + (a.sin()) * 2.0 + ((i * 31 % 17) as f64 - 8.0) * 0.1);
            y.push(cy + (a.cos()) * 1.0 + ((i * 17 % 13) as f64 - 6.0) * 0.1);
            c.push(crit);
        }
        dataset(vec![("X", x), ("Y", y), ("C", c)])
    }

    fn geoms_of(st: &ClusteringStats) -> Vec<ClusterGeom> {
        st.clusters
            .iter()
            .map(|c| ClusterGeom {
                cluster_id: c.cluster_id,
                x_center: c.x_center,
                y_center: c.y_center,
                x_sd: c.x_sd,
                y_sd: c.y_sd,
                angle_deg: c.angle_deg,
            })
            .collect()
    }

    #[test]
    fn clustering_stats_match_the_info_file_rounding() {
        let d = cl_data();
        let p = clustering_preview(&d, &cl_req(2, Some(5.0))).unwrap();
        let (st, _) = clus(&p);
        assert_eq!(st.cluster_count, 2);
        assert_eq!(st.clusters.len(), 2);
        // Same numbers build_cluster_info writes for the same clusters.
        let prev = clustering_preview_in(
            &d,
            "X".into(),
            "Y".into(),
            2,
            Some("C".into()),
            cl_req(2, None).cluster_ranges,
            None,
        )
        .unwrap();
        let info = crate::build_cluster_info(&prev.clusters, None);
        for c in &st.clusters {
            let e = &info[c.cluster_id.to_string()];
            assert_eq!(e["x_cluster_center"].as_f64().unwrap(), c.x_center);
            assert_eq!(e["y_cluster_center"].as_f64().unwrap(), c.y_center);
            assert_eq!(e["x_sd"].as_f64().unwrap(), c.x_sd);
            assert_eq!(e["y_sd"].as_f64().unwrap(), c.y_sd);
            assert_eq!(e["angle_deg"].as_f64().unwrap(), c.angle_deg);
        }
        assert_eq!(st.rows, 2000);
        assert_eq!(st.assigned_rows, 2000);
        assert_eq!(st.unassigned_rows, 0);
    }

    // The Model fit page's "Inside 3x SD" tile: the share is in the stats with
    // or without scoring periods (it used to exist only in the train block of
    // `test_validation`, so the tile read "-" for a model with no period).
    #[test]
    fn clustering_stats_carry_the_inside_3sd_share_without_scoring_periods() {
        let p = clustering_preview(&cl_data(), &cl_req(2, Some(5.0))).unwrap();
        assert!(p.test_validation.is_none());
        let pct = clus(&p).0.inside_3sd_ring_pct.expect("known without scoring periods");
        assert!(pct > 90.0 && pct <= 100.0, "{pct}");
        // No set point is needed for it (the ring is the TRAIN-fitted cluster's).
        let p0 = clustering_preview(&cl_data(), &cl_req(2, None)).unwrap();
        assert_eq!(clus(&p0).0.inside_3sd_ring_pct, Some(pct));
    }

    #[test]
    fn clustering_requires_n_above_3_and_returns_issues_without_scores() {
        let d = cl_data();
        let p = clustering_preview(&d, &cl_req(2, None)).unwrap();
        assert!(!p.valid);
        assert_eq!(p.validation[0].code, "required");
        assert!(clus(&p).1.score.is_none());
        let h = clus_hourly(&p);
        assert!(h.score.is_none() && h.sd_distance.iter().all(|d| d.is_none()));
        assert_eq!(h.total_points, 34, "the hourly points are there before the set point is valid");
        let p = clustering_preview(&d, &cl_req(2, Some(3.0))).unwrap();
        assert_eq!(p.validation[0].code, "outer_sd_equals_3");
        let p = clustering_preview(&d, &cl_req(2, Some(2.5))).unwrap();
        assert_eq!(p.validation[0].code, "outer_sd_not_above_3");
        // Scatter + stats still present.
        assert!(p.cluster_scatter.is_some());
    }

    #[test]
    fn clustering_scores_use_the_assigned_clusters_own_gaussian() {
        // The machine alternates state every hour: even hours cluster 1, odd
        // hours cluster 2 (2000 one-minute rows = 34 hours).
        let d = cl_data_by(2000, &|i| (i / 60) % 2);
        let p = clustering_preview(&d, &cl_req(2, Some(6.0))).unwrap();
        assert!(p.valid, "{:?}", p.validation);
        let (st, raw) = clus(&p);
        let geoms = geoms_of(st);
        // RAW series: each row's own cluster and SD distance, no score.
        assert!(raw.score.is_none());
        assert_eq!(raw.total_points, 2000);
        for i in 0..raw.rows.len() {
            let k = raw.cluster[i].unwrap() as usize - 1;
            assert_eq!(k, (raw.rows[i] as usize / 60) % 2);
            let dist = geoms[k].sd_distance(raw.x[i], raw.y[i]);
            assert!((raw.sd_distance[i].unwrap() - dist).abs() < 1e-12);
        }
        // HOURLY series: the point (mean X, mean Y) against the cluster every
        // row of the hour is in (here each hour is in ONE cluster throughout).
        let se = clus_hourly(&p);
        let sc = se.score.as_ref().unwrap();
        assert_eq!((se.total_points, se.rows.len()), (34, 34));
        let (cx, cy) = (&d.columns[1], &d.columns[2]);
        for h in 0..34 {
            let rows = h * 60..(h * 60 + 60).min(2000);
            assert_eq!(se.rows[h] as usize, h * 60);
            assert_eq!(se.timestamps[h], hour_text(h));
            assert_eq!(se.x[h], mean_of(&cx[rows.clone()]), "hour {h}");
            assert_eq!(se.y[h], mean_of(&cy[rows]), "hour {h}");
            let k = se.cluster[h].unwrap() as usize - 1;
            assert_eq!(k, h % 2, "hour {h}");
            let dist = geoms[k].sd_distance(se.x[h], se.y[h]);
            assert!((se.sd_distance[h].unwrap() - dist).abs() < 1e-12);
            assert_eq!(
                sc[h].unwrap(),
                crate::health_score::score_clustering_distance(dist, 6.0).unwrap()
            );
        }
        // An hour's mean sits near its cluster centre: every hour scores high.
        let sum = p.score_summary.clone().unwrap();
        assert_eq!((sum.scored, sum.unscored, sum.total_rows, sum.share_basis), (34, 0, 34, "hour_count"));
        assert_eq!(sum.share_80_100, Some(100.0));
        assert_eq!(p.scoring_interval_secs, 3600);
    }

    #[test]
    fn a_clustering_hour_whose_rows_are_in_two_clusters_has_no_cluster_and_no_score() {
        // Hours 0, 2: state 0 (C = 5). Hours 1, 3: state 1 (C = 15). Hour 4
        // changes state after 40 minutes (mean C = 8.33), hour 5 after 20 minutes
        // (mean C = 11.67): the machine was in BOTH clusters during those hours.
        let state = |i: usize| match i / 60 {
            4 => usize::from(i % 60 >= 40),
            5 => usize::from(i % 60 >= 20),
            h => h % 2,
        };
        let d = cl_data_by(360, &state);
        let p = clustering_preview(&d, &cl_req(2, Some(6.0))).unwrap();
        assert!(p.valid, "{:?}", p.validation);
        let (st, raw) = clus(&p);
        // The FIT and the raw rows are per row: every row is in its own cluster
        // and keeps its own SD distance, also inside a transition hour.
        assert_eq!((st.assigned_rows, st.unassigned_rows), (360, 0));
        for i in 0..360 {
            assert_eq!(raw.cluster[i], Some(state(i) as u32 + 1), "row {i}");
            assert!(raw.sd_distance[i].is_some(), "row {i}");
        }
        let se = clus_hourly(&p);
        let sc = se.score.as_ref().unwrap();
        let geoms = geoms_of(st);
        // Clean hours: their own cluster, a high score - exactly as before.
        for h in 0..4 {
            let k = h % 2;
            assert_eq!(se.cluster[h], Some(k as u32 + 1));
            let dist = geoms[k].sd_distance(se.x[h], se.y[h]);
            assert!((se.sd_distance[h].unwrap() - dist).abs() < 1e-12);
            assert_eq!(sc[h].unwrap(), crate::health_score::score_clustering_distance(dist, 6.0).unwrap());
            assert!(sc[h].unwrap() >= 80.0, "hour {h}: {:?}", sc[h]);
        }
        // Transition hours: still a POINT of the series (first row, hour start,
        // mean X / Y), but no cluster, no distance and no score - never a 0.
        assert_eq!((se.total_points, se.rows.len()), (6, 6));
        for h in [4usize, 5] {
            assert_eq!((se.cluster[h], se.sd_distance[h], sc[h]), (None, None, None), "hour {h}");
            assert_eq!(se.rows[h] as usize, h * 60);
            assert_eq!(se.timestamps[h], hour_text(h));
            assert!((se.x[h] - mean_of(&d.columns[1][h * 60..h * 60 + 60])).abs() < 1e-12);
            assert!((se.y[h] - mean_of(&d.columns[2][h * 60..h * 60 + 60])).abs() < 1e-12);
            // What scoring the mean point would have said: far outside BOTH
            // clusters, i.e. a 0 on a healthy training hour.
            for g in &geoms {
                assert!(g.sd_distance(se.x[h], se.y[h]) > 6.0, "hour {h}");
            }
        }
        // The summary counts them as unscored hours; its minimum is a real,
        // scored hour (it used to be the 0 of hour 4, row 240).
        let sum = p.score_summary.clone().unwrap();
        assert_eq!((sum.scored, sum.unscored, sum.total_rows), (4, 2, 6));
        let min = sum.min_score.clone().unwrap();
        assert!(min.score >= 80.0, "{}", min.score);
        assert!([0, 60, 120, 180].contains(&min.row), "{}", min.row);
        assert_eq!(min.score, sc[..4].iter().flatten().cloned().fold(f64::INFINITY, f64::min));
        assert_eq!((sum.share_80_100, sum.pct_below_80), (Some(100.0), Some(0.0)));

        // The ranges do not matter for that: with a gap between them ([.., 8) and
        // [12, ..)) every row is still in a range, the two hours are still mixed.
        let mut r = cl_req(2, Some(6.0));
        r.cluster_ranges = Some(vec![
            ClusterRange { min: None, max: Some(8.0) },
            ClusterRange { min: Some(12.0), max: None },
        ]);
        let p = clustering_preview(&d, &r).unwrap();
        assert!(p.valid, "{:?}", p.validation);
        let se = clus_hourly(&p);
        let sc = se.score.as_ref().unwrap();
        for h in [4usize, 5] {
            assert_eq!((se.cluster[h], se.sd_distance[h], sc[h]), (None, None, None), "hour {h}");
        }
        assert!((0..4).all(|h| sc[h].is_some()));
        let sum = p.score_summary.clone().unwrap();
        assert_eq!((sum.scored, sum.unscored, sum.total_rows), (4, 2, 6));
        // Every row of those hours is still a normal, assigned training row.
        assert_eq!(clus(&p).0.unassigned_rows, 0);

        // Before the set point is valid the hour has no cluster either.
        let p = clustering_preview(&d, &cl_req(2, None)).unwrap();
        let se = clus_hourly(&p);
        assert!(!p.valid && se.score.is_none());
        assert_eq!(se.cluster, vec![Some(1), Some(2), Some(1), Some(2), None, None]);
    }

    /// Three machine states A / B / C on a criteria sensor (C = 5 / 15 / 25,
    /// ranges [.., 10) [10, 20) [20, ..)) around (0, 0) / (50, 50) / (100, 100);
    /// one-minute rows, `state_of(row)` picks the state.
    fn cl3_data(n: usize, state_of: &dyn Fn(usize) -> usize) -> ColumnarData {
        let (mut x, mut y, mut c) = (Vec::new(), Vec::new(), Vec::new());
        for i in 0..n {
            let a = (i as f64) * 0.618;
            let (cx, cy, crit) = [(0.0, 0.0, 5.0), (50.0, 50.0, 15.0), (100.0, 100.0, 25.0)][state_of(i)];
            x.push(cx + (a.sin()) * 2.0 + ((i * 31 % 17) as f64 - 8.0) * 0.1);
            y.push(cy + (a.cos()) * 1.0 + ((i * 17 % 13) as f64 - 6.0) * 0.1);
            c.push(crit);
        }
        dataset(vec![("X", x), ("Y", y), ("C", c)])
    }

    fn cl3_req() -> HealthPreviewRequest {
        let mut r = cl_req(2, Some(6.0));
        r.n_clusters = Some(3);
        r.cluster_ranges = Some(vec![
            ClusterRange { min: None, max: Some(10.0) },
            ClusterRange { min: Some(10.0), max: Some(20.0) },
            ClusterRange { min: Some(20.0), max: None },
        ]);
        r
    }

    #[test]
    fn a_three_range_hour_split_between_a_and_c_is_not_scored_against_b() {
        // Hours 0..6 cycle A, B, C. Hour 6 is half A, half C: its mean criteria
        // value is 15 (range B) and its mean point is B's centre - but the
        // machine was never in B during that hour.
        let state = |i: usize| match i / 60 {
            6 => 2 * usize::from(i % 60 >= 30),
            h => h % 3,
        };
        let d = cl3_data(420, &state);
        let p = clustering_preview(&d, &cl3_req()).unwrap();
        assert!(p.valid, "{:?}", p.validation);
        let (st, raw) = clus(&p);
        assert_eq!((st.clusters.len(), st.unassigned_rows), (3, 0));
        // Per row nothing is in B during hour 6.
        assert!((360..420).all(|i| raw.cluster[i] == Some(state(i) as u32 + 1) && raw.cluster[i] != Some(2)));
        let se = clus_hourly(&p);
        let sc = se.score.as_ref().unwrap();
        assert_eq!(se.total_points, 7);
        for h in 0..6 {
            assert_eq!(se.cluster[h], Some((h % 3) as u32 + 1), "hour {h}");
            assert!(sc[h].unwrap() >= 80.0, "hour {h}: {:?}", sc[h]);
        }
        // The old rule's answer, to show what is avoided: the mean criteria
        // value names B and the mean point scores well against it.
        assert_eq!(mean_of(&d.columns[3][360..420]), 15.0);
        let b = &geoms_of(st)[1];
        let would = crate::health_score::score_clustering_distance(b.sd_distance(se.x[6], se.y[6]), 6.0).unwrap();
        assert!(would >= 80.0, "the A/C mean point looks healthy against B: {would}");
        // The new rule: no cluster, no distance, no score.
        assert_eq!((se.cluster[6], se.sd_distance[6], sc[6]), (None, None, None));
        let sum = p.score_summary.clone().unwrap();
        assert_eq!((sum.scored, sum.unscored, sum.total_rows), (6, 1, 7));
    }

    #[test]
    fn a_scoring_period_counts_a_transition_hour_as_an_hour_but_not_as_scored() {
        let req_for = |train_end: &str, score_start: &str| {
            let mut r = cl_req(2, Some(6.0));
            r.filter = Some(PreviewFilter {
                timestamp_ranges: vec![crate::TimeRangeArg {
                    start: Some("2024-01-01T00:00:00".into()),
                    end: Some(train_end.into()),
                }],
                ..Default::default()
            });
            r.test_periods = Some(vec![TestPeriodArg {
                start: Some(score_start.into()),
                end: Some("2024-01-01T07:59:00".into()),
            }]);
            r
        };
        // Training = hours 0..4 (clean, alternating). Scoring period = hours
        // 4..8: hour 4 clean (state 0), hour 5 changes state half way, hour 6
        // clean (state 0), hour 7 clean (state 1) but shifted far away.
        let state = |i: usize| match i / 60 {
            5 => usize::from(i % 60 >= 30),
            h => h % 2,
        };
        let mut d = cl_data_by(480, &state);
        for i in 420..480 {
            d.columns[1][i] += 500.0;
        }
        let p = clustering_preview(&d, &req_for("2024-01-01T03:59:00", "2024-01-01T04:00:00")).unwrap();
        assert!(p.valid, "{:?}", p.validation);
        let se = clus_hourly(&p);
        let sc = se.score.as_ref().unwrap();
        assert_eq!(se.cluster, vec![Some(1), Some(2), Some(1), Some(2), Some(1), None, Some(1), Some(2)]);
        assert_eq!(sc[5], None);
        assert_eq!(sc[7], Some(0.0), "a real excursion inside ONE cluster still scores 0");
        let t = &p.test_validation.as_ref().unwrap().tests[0];
        assert_eq!((t.rows, t.hours, t.train_hours), (240, 4, 0), "the transition hour is still an hour of the period");
        assert_eq!(t.scored, 3, "but it is not a scored one");
        // Of the 3 hours with a cluster: 2 inside the ring, 1 (the excursion) out.
        assert_eq!(t.metrics.inside_3sd_ring_pct, Some(66.7));
        // With scoring periods the stats' share is the train block's: the training rows only.
        let train_pct = p.test_validation.as_ref().unwrap().train.metrics.inside_3sd_ring_pct;
        assert!(train_pct.is_some());
        assert_eq!(clus(&p).0.inside_3sd_ring_pct, train_pct);
        assert_eq!(t.pct_below_80, Some(33.3));
        assert_eq!(t.lowest, Some(0.0));
        assert_eq!(t.lowest_at.as_deref(), Some(hour_text(7).as_str()), "never the transition hour");
        // The training summary is the 4 clean training hours.
        let sum = p.score_summary.clone().unwrap();
        assert_eq!((sum.scored, sum.unscored, sum.total_rows), (4, 0, 4));

        // A boundary hour that holds training rows of one cluster and scoring
        // rows of another is mixed too - every row of the hour votes: the
        // training periods end at 03:29, and at 03:30 the state changes.
        let state2 = |i: usize| match i / 60 {
            0 | 2 => 0,
            1 => 1,
            3 => usize::from(i % 60 >= 30),
            _ => 1,
        };
        let d2 = cl_data_by(480, &state2);
        let p2 = clustering_preview(&d2, &req_for("2024-01-01T03:29:00", "2024-01-01T03:30:00")).unwrap();
        assert!(p2.valid, "{:?}", p2.validation);
        let h2 = clus_hourly(&p2);
        assert_eq!(h2.cluster, vec![Some(1), Some(2), Some(1), None, Some(2), Some(2), Some(2), Some(2)]);
        assert_eq!(h2.score.as_ref().unwrap()[3], None, "training rows in cluster 1 + scoring rows in cluster 2");
        let t2 = &p2.test_validation.as_ref().unwrap().tests[0];
        assert_eq!((t2.rows, t2.hours, t2.train_hours, t2.scored), (270, 5, 1, 4));
        let sum2 = p2.score_summary.clone().unwrap();
        assert_eq!((sum2.scored, sum2.unscored, sum2.total_rows), (3, 1, 4), "hour 3 is a training hour, unscored");
    }

    #[test]
    fn clustering_rows_in_no_range_or_missing_criteria_get_no_score() {
        let d = cl_data();
        // Leave a gap: [None,10) and [20,None) — the C=15 rows are unassigned.
        let mut r = cl_req(2, Some(6.0));
        r.cluster_ranges = Some(vec![
            ClusterRange { min: None, max: Some(10.0) },
            ClusterRange { min: Some(20.0), max: None },
        ]);
        // Second cluster is then empty → the fit errors with NO_DATA.
        assert!(clustering_preview(&d, &r).unwrap_err().starts_with("NO_DATA"));

        // Three states, one per HOUR (10 hours): C = 5 / 15 / 100; the ranges
        // cover 5 and 100 only. Hour 3 has no criteria value at all; ONE row of
        // hour 0 (row 3) has none and ONE row of hour 6 (row 370) is in no range.
        let mut cols = Vec::new();
        let n = 600;
        let (mut x, mut y, mut c) = (vec![], vec![], vec![]);
        for i in 0..n {
            let g = (i / 60) % 3;
            let (cx, crit) = [(0.0, 5.0), (30.0, 15.0), (60.0, 100.0)][g];
            x.push(cx + ((i * 31 % 17) as f64 - 8.0) * 0.1);
            y.push(cx + ((i * 17 % 13) as f64 - 6.0) * 0.1);
            c.push(match i {
                370 => 15.0,
                _ if i == 3 || i / 60 == 3 => f64::NAN,
                _ => crit,
            });
        }
        cols.push(("X", x));
        cols.push(("Y", y));
        cols.push(("C", c));
        let d = dataset(cols);
        let mut r = cl_req(2, Some(6.0));
        r.cluster_ranges = Some(vec![
            ClusterRange { min: None, max: Some(10.0) },
            ClusterRange { min: Some(50.0), max: None },
        ]);
        let p = clustering_preview(&d, &r).unwrap();
        assert!(p.valid, "{:?}", p.validation);
        let (st, raw) = clus(&p);
        // RAW rows: 180 rows of C = 15 (hours 1, 4, 7) + hour 3 (60) + rows 3, 370.
        assert_eq!(st.unassigned_rows, 242);
        assert_eq!(st.assigned_rows, 358);
        assert!(raw.score.is_none());
        assert_eq!(raw.cluster.iter().filter(|c| c.is_none()).count(), 242);
        // The other 59 rows of hours 0 and 6 are ordinary rows of cluster 1.
        assert_eq!((raw.cluster[2], raw.cluster[3], raw.cluster[4]), (Some(1), None, Some(1)));
        assert_eq!((raw.cluster[369], raw.cluster[370], raw.cluster[371]), (Some(1), None, Some(1)));
        // HOURLY points: an hour has a cluster only when EVERY one of its rows is
        // in that cluster. No cluster = no distance and no score.
        let se = clus_hourly(&p);
        assert_eq!(se.total_points, 10);
        let sc = se.score.as_ref().unwrap();
        let want: Vec<Option<u32>> = vec![None, None, Some(2), None, None, Some(2), None, None, Some(2), Some(1)];
        assert_eq!(se.cluster, want);
        for h in 0..10 {
            assert_eq!(sc[h].is_some(), want[h].is_some(), "hour {h}: an hour without a cluster is unscored");
            assert_eq!(se.sd_distance[h].is_some(), want[h].is_some());
        }
        // Hour 0: one row has no criteria value. Hour 6: one row is in no range.
        // A single such row among 59 assigned ones leaves the hour without a
        // cluster (the 59 others do not out-vote it) - missing, never 0.
        assert_eq!((se.cluster[0], sc[0]), (None, None));
        assert_eq!((se.cluster[6], sc[6]), (None, None));
        // Hours 1, 4, 7 (every row in no range) and hour 3 (no criteria at all).
        assert!([1usize, 3, 4, 7].iter().all(|&h| se.cluster[h].is_none() && sc[h].is_none()));
        // Hour 9 (all 60 rows in cluster 1) is scored as before.
        let g1 = &geoms_of(st)[0];
        let dist = g1.sd_distance(se.x[9], se.y[9]);
        assert!((se.sd_distance[9].unwrap() - dist).abs() < 1e-12);
        assert_eq!(sc[9].unwrap(), crate::health_score::score_clustering_distance(dist, 6.0).unwrap());
        let sum = p.score_summary.clone().unwrap();
        assert_eq!((sum.scored, sum.unscored, sum.total_rows), (4, 6, 10));
    }

    #[test]
    fn clustering_single_cluster_scores_every_row() {
        let d = cl_data();
        let mut r = cl_req(1, Some(5.0));
        r.criteria_sensor = Some("ignored".into());
        let p = clustering_preview(&d, &r).unwrap();
        assert!(p.valid, "{:?}", p.validation);
        let (st, se) = clus(&p);
        assert_eq!(st.clusters.len(), 1);
        assert!(se.cluster.iter().all(|c| *c == Some(1)));
        // One cluster: every hour is in it and is scored (34 hours of 2000 rows).
        let h = clus_hourly(&p);
        assert_eq!(h.total_points, 34);
        assert!(h.cluster.iter().all(|c| *c == Some(1)));
        assert!(h.score.as_ref().unwrap().iter().all(|s| s.is_some()));
        assert_eq!(p.score_summary.clone().unwrap().scored, 34);
    }

    #[test]
    fn clustering_series_and_scatter_are_bounded() {
        // The state changes by the HOUR, so every hour is in one cluster and
        // has a score (an hour holding rows of both clusters would have none).
        let d = cl_data_by(2000, &|i| (i / 60) % 2);
        let mut r = cl_req(2, Some(6.0));
        r.max_points = Some(100);
        r.max_scatter_points = Some(50);
        let p = clustering_preview(&d, &r).unwrap();
        let (_, se) = clus(&p);
        assert!(se.rows.len() <= 100);
        assert_eq!(se.total_points, 2000);
        // 34 hours fit under the cap of 100...
        assert_eq!(clus_hourly(&p).rows.len(), 34);
        let sc = p.cluster_scatter.unwrap();
        assert_eq!(sc.x.len(), 50);
        assert_eq!(sc.total, 2000);
        // ...and are downsampled like any series under a smaller one, keeping
        // the lowest score.
        r.max_points = Some(8);
        let p = clustering_preview(&d, &r).unwrap();
        let h = clus_hourly(&p);
        assert!(h.rows.len() <= 8, "{}", h.rows.len());
        assert_eq!(h.total_points, 34);
        let lens = [h.timestamps.len(), h.x.len(), h.y.len(), h.cluster.len(), h.sd_distance.len(), h.score.as_ref().unwrap().len()];
        assert!(lens.iter().all(|&l| l == h.rows.len()));
        let shipped_min = h.score.as_ref().unwrap().iter().flatten().cloned().fold(f64::INFINITY, f64::min);
        assert_eq!(shipped_min, p.score_summary.clone().unwrap().min_score.unwrap().score);
    }

    #[test]
    fn clustering_degenerate_cluster_blocks_the_score() {
        // A cluster whose X is constant has a zero minor/major SD.
        let n = 200;
        let x: Vec<f64> = vec![3.0; n];
        let y: Vec<f64> = (0..n).map(|i| (i % 10) as f64).collect();
        let d = dataset(vec![("X", x), ("Y", y)]);
        let r = HealthPreviewRequest {
            first_sensor: Some("X".into()),
            second_sensor: Some("Y".into()),
            n_clusters: Some(1),
            set_points: Some(SetPointsArg {
                outer_sd: Some(5.0),
                ..Default::default()
            }),
            ..req("clustering")
        };
        let p = clustering_preview(&d, &r).unwrap();
        assert!(!p.valid);
        assert!(p.validation.iter().any(|i| i.code == "degenerate_band" && i.field == "cluster_1"));
        assert!(p.score_summary.is_none());
    }

    #[test]
    fn clustering_errors_are_coded() {
        let d = cl_data();
        let mut r = cl_req(2, Some(5.0));
        r.first_sensor = None;
        assert!(clustering_preview(&d, &r).unwrap_err().starts_with("BAD_REQUEST"));
        let mut r = cl_req(2, Some(5.0));
        r.n_clusters = Some(0);
        assert!(clustering_preview(&d, &r).unwrap_err().starts_with("BAD_REQUEST"));
    }

    /// Run manually: `cargo test --lib perf_smoke_health -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn perf_smoke_health_preview_two_million_rows() {
        let n = 2_000_000usize;
        let v: Vec<f64> = (0..n).map(|i| 100.0 + ((i * 7919) % 1000) as f64 * 0.01).collect();
        let g: Vec<f64> = (0..n).map(|i| if i % 5 == 0 { 0.0 } else { 1.0 }).collect();
        let d = dataset(vec![("S", v), ("G", g)]);
        let mut r = ind_req(None, None);
        r.filter = Some(PreviewFilter {
            value_filters: vec![crate::PreviewValueFilter {
                sensor: "G".into(),
                operation: "greater_than".into(),
                value1: Some(0.5),
                value2: None,
            }],
            ..Default::default()
        });
        let t = std::time::Instant::now();
        let p0 = individual_preview(&d, &r).unwrap();
        let st = individual(&p0).0;
        r.set_points = Some(SetPointsArg {
            lower: Some(st.boundary_3sd[0] - 3.0),
            upper: Some(st.boundary_3sd[1] + 3.0),
            ..Default::default()
        });
        let t1 = t.elapsed();
        let t = std::time::Instant::now();
        let p = individual_preview(&d, &r).unwrap();
        let t2 = t.elapsed();
        let (_, se) = individual(&p);
        assert!(se.rows.len() <= DEFAULT_MAX_POINTS);
        println!("individual 2M rows: no-set-points {t1:?}, scored {t2:?}, points {}", se.rows.len());
    }

    /// The Relation model's hourly path on a large fit: 1.5 M training rows, two
    /// predictors, a 500 000-row scoring period (1-minute rows = 33 334 hours).
    /// Run manually: `cargo test --lib perf_smoke_relationship -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn perf_smoke_relationship_preview_two_million_rows() {
        let n = 2_000_000usize;
        let n_fit = 1_500_000usize;
        let x: Vec<f64> = (0..n).map(|i| ((i * 7919) % 1000) as f64 * 0.01).collect();
        let z: Vec<f64> = (0..n).map(|i| ((i * 104_729) % 977) as f64 * 0.1).collect();
        let y: Vec<f64> = (0..n).map(|i| 2.0 * x[i] + 0.5 * z[i] + ((i % 7) as f64 - 3.0) * 0.1).collect();
        let fit = RelFit {
            target: "Y".into(),
            predictors: vec!["X".into(), "Z".into()],
            lambda: 1.0,
            rows: (0..n_fit as u32).collect(),
            actual: y[..n_fit].to_vec(),
            predicted: (0..n_fit).map(|i| 2.0 * x[i] + 0.5 * z[i]).collect(),
            x_cols: vec![x[..n_fit].to_vec(), z[..n_fit].to_vec()],
            r2_per_step: vec![],
            rmse2_per_step: vec![],
        };
        let d = dataset_at(&|i| Some(i as i64), vec![("X", x), ("Z", z), ("Y", y)]);
        let w = relationship_stats(&fit).unwrap().two_rmse;
        let mut r = rel_req(Some(rel_sp(w)));
        r.test_periods = Some(vec![TestPeriodArg {
            start: d.timestamps[n_fit].clone(),
            end: None,
        }]);
        let t = std::time::Instant::now();
        let extra = rel_extra_from_model(&d, &fit, &r, &|x| 2.0 * x[0] + 0.5 * x[1]);
        let t_points = t.elapsed();
        let t = std::time::Instant::now();
        let p = relationship_preview_ex(&d, &fit, Some(&extra), &r).unwrap();
        let t_preview = t.elapsed();
        let h = rel_hourly(&p);
        assert_eq!(h.total_points, n.div_ceil(60));
        assert!(h.rows.len() <= DEFAULT_MAX_POINTS && rel(&p).1.rows.len() <= DEFAULT_MAX_POINTS);
        assert!(h.score.as_ref().unwrap().iter().all(Option::is_some));
        println!(
            "relationship 2M rows: hourly points {} in {t_points:?}, scored preview {t_preview:?}",
            extra.len()
        );
    }

    /// The Relation model's hourly table when scoring periods lie OVER the
    /// training range: every hour then holds rows of several sources (training
    /// rows + each period), the worst case of the shared-hour pass
    /// (`health_validation::shared_hour_variants`, run once per `RelHours`,
    /// i.e. twice per preview). 2 M training rows, two predictors, 1-minute
    /// rows; one period over everything, then three.
    /// Run manually:
    /// `cargo test --lib perf_smoke_relationship_scoring_periods_over -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn perf_smoke_relationship_scoring_periods_over_the_whole_training_range() {
        let n = 2_000_000usize;
        let x: Vec<f64> = (0..n).map(|i| ((i * 7919) % 1000) as f64 * 0.01).collect();
        let z: Vec<f64> = (0..n).map(|i| ((i * 104_729) % 977) as f64 * 0.1).collect();
        let y: Vec<f64> = (0..n).map(|i| 2.0 * x[i] + 0.5 * z[i] + ((i % 7) as f64 - 3.0) * 0.1).collect();
        let fit = RelFit {
            target: "Y".into(),
            predictors: vec!["X".into(), "Z".into()],
            lambda: 1.0,
            rows: (0..n as u32).collect(),
            actual: y.clone(),
            predicted: (0..n).map(|i| 2.0 * x[i] + 0.5 * z[i]).collect(),
            x_cols: vec![x.clone(), z.clone()],
            r2_per_step: vec![],
            rmse2_per_step: vec![],
        };
        let d = dataset_at(&|i| Some(i as i64), vec![("X", x), ("Z", z), ("Y", y)]);
        let w = relationship_stats(&fit).unwrap().two_rmse;
        let hours = n.div_ceil(60);
        let train = RelTrain::of(&fit);
        let t = std::time::Instant::now();
        let base = RelHours::build(&d, &train, None);
        println!("relationship 2M training rows, no scoring period: hourly table {:?}", t.elapsed());
        assert_eq!(base.points().len(), hours);
        for periods in [1usize, 3] {
            let mut r = rel_req(Some(rel_sp(w)));
            r.test_periods = Some(vec![TestPeriodArg { start: d.timestamps[0].clone(), end: None }; periods]);
            let plan = r.test_plan(&d).expect("a plan");
            let pcols: Vec<usize> = fit.predictors.iter().map(|p| d.col_index(p).unwrap()).collect();
            let cols = RelCols { target: d.col_index("Y").unwrap(), predictors: &pcols };
            let t = std::time::Instant::now();
            let table = RelHours::build(&d, &train, Some((&plan, &cols)));
            let t_table = t.elapsed();
            // Removing a period that covers every training row changes no mean:
            // no extra point is asked for.
            assert_eq!(table.points().len(), hours);
            let t = std::time::Instant::now();
            let extra = rel_extra_from_model(&d, &fit, &r, &|x| 2.0 * x[0] + 0.5 * x[1]);
            let p = relationship_preview_ex(&d, &fit, Some(&extra), &r).unwrap();
            let t_preview = t.elapsed();
            assert_eq!(rel_hourly(&p).total_points, hours);
            assert!(rel_hourly(&p).score.as_ref().unwrap().iter().all(Option::is_some));
            println!(
                "relationship 2M training rows under {periods} scoring period(s): hourly table {t_table:?}, \
                 points + scored preview {t_preview:?}"
            );
        }
    }

    #[test]
    fn request_deserializes_from_the_frontend_json() {
        let r: HealthPreviewRequest = serde_json::from_str(
            r#"{"kind":"relationship","target":"Y","predictors":["A","B"],"cache_key":"m1:abc",
                "x_predictor":"B","filter":{"timestamp_ranges":[{"start":"2024-01-01T00:00","end":null}],
                "value_filters":[],"combine":"or"},
                "set_points":{"kind":"relationship","residualAt80Lower":-4,"residualAt80Upper":6,
                "residualAt0Lower":-10,"residualAt0Upper":20},"max_points":1200,"expectedGeneration":7}"#,
        )
        .unwrap();
        assert_eq!(r.kind, "relationship");
        assert_eq!(r.predictors, vec!["A", "B"]);
        assert_eq!(r.max_points(), 1200);
        assert_eq!(r.expected_generation, Some(7));
        assert_eq!(r.set_points().residual_at_0_upper, Some(20.0));
        let min: HealthPreviewRequest = serde_json::from_str(r#"{"kind":"individual"}"#).unwrap();
        assert_eq!(min.max_points(), DEFAULT_MAX_POINTS);
        assert_eq!(min.max_scatter(), DEFAULT_MAX_SCATTER_POINTS);
    }

    #[test]
    fn response_serializes_with_snake_case_and_a_kind_tag() {
        let (d, _, _) = ind_data();
        let p = individual_preview(&d, &ind_req(None, None)).unwrap();
        let j = serde_json::to_value(&p).unwrap();
        assert_eq!(j["kind"], "individual");
        assert_eq!(j["stats"]["kind"], "individual");
        assert_eq!(j["series"]["kind"], "individual");
        assert!(j["stats"]["boundary_3sd"].is_array());
        assert!(j["series"]["score"].is_null());
        // The hourly series and the scoring interval are part of every answer.
        assert_eq!(j["hourly"]["kind"], "individual");
        assert!(j["hourly"]["score"].is_null());
        assert_eq!(j["hourly"]["total_points"], 34);
        assert!(j["hourly"]["value"].as_array().unwrap().iter().all(|v| v.is_number()));
        let mut keys: Vec<&str> = j["hourly"].as_object().unwrap().keys().map(String::as_str).collect();
        let mut raw_keys: Vec<&str> = j["series"].as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        raw_keys.sort_unstable();
        assert_eq!(keys, raw_keys, "`hourly` has the same shape as `series`");
        assert_eq!(j["scoring_interval_secs"], 3600);
        assert!(j["score_summary"].is_null());
        assert_eq!(j["valid"], false);
        assert_eq!(j["validation"][0]["code"], "required");
        assert!(j["histogram"]["bin_edges"].is_array());
        // No NaN leaked: every number in the value array is finite.
        assert!(j["series"]["value"].as_array().unwrap().iter().all(|v| v.is_number()));
    }

    // ---------- canonical residual (the FILE's), coded errors, warnings ----------

    #[test]
    fn file_residual_is_what_the_sidecar_writes_and_nan_for_missing() {
        // round_metric(actual - round_metric(predicted)), in this order.
        for (a, p) in [(10.0, 9.123_456_7), (0.000_412_345, 0.000_411_111), (-3.3, 1.234_567_8), (1234.5678, 1234.1111)] {
            assert_eq!(file_residual(a, p), round_metric(a - round_metric(p)), "{a} {p}");
        }
        // It really differs from the raw residual for a many-decimal prediction.
        assert_ne!(file_residual(10.0, 9.123_456_7), 10.0 - 9.123_456_7);
        for (a, p) in [(f64::NAN, 1.0), (1.0, f64::NAN), (f64::INFINITY, 1.0), (1.0, f64::NEG_INFINITY)] {
            assert!(file_residual(a, p).is_nan());
        }
    }

    #[test]
    fn relationship_preview_series_and_stats_use_the_file_residual() {
        let mut fit = rel_fit(500);
        // Many-decimal predictions, like the sidecar's raw output before rounding.
        for (i, p) in fit.predicted.iter_mut().enumerate() {
            *p += 0.000_123_456_7 * (1 + i % 7) as f64;
        }
        let d = dataset(vec![("X", vec![0.0; 500])]);
        let p = relationship_preview(&d, &fit, &rel_req(None)).unwrap();
        let (st, se) = rel(&p);
        for (k, &row) in se.rows.iter().enumerate() {
            let i = row as usize;
            assert_eq!(se.residual[k], Some(round_metric(fit.actual[i] - round_metric(fit.predicted[i]))));
        }
        // The reported residual statistics are over the same numbers.
        let res: Vec<f64> = (0..500).map(|i| file_residual(fit.actual[i], fit.predicted[i])).collect();
        let (mean, _) = mean_sd(&res);
        assert_eq!(st.residual_mean, mean);
        assert_eq!(st.residual_min, res.iter().cloned().fold(f64::INFINITY, f64::min));
        assert_eq!(st.residual_max, res.iter().cloned().fold(f64::NEG_INFINITY, f64::max));
        // W is unchanged (it was already computed from the rounded predictions).
        assert_eq!(st.two_rmse, relationship_stats(&fit).unwrap().two_rmse);
    }

    #[test]
    fn request_shaped_errors_are_all_coded_bad_request() {
        let d = cl_data();
        let coded = |e: String| assert!(e.starts_with("BAD_REQUEST: "), "{e}");
        // unknown clustering sensor / criteria sensor
        let mut r = cl_req(2, Some(5.0));
        r.first_sensor = Some("NOPE".into());
        coded(clustering_preview(&d, &r).unwrap_err());
        let mut r = cl_req(2, Some(5.0));
        r.criteria_sensor = Some("NOPE".into());
        coded(clustering_preview(&d, &r).unwrap_err());
        // missing criteria sensor / ranges, ranges length mismatch
        let mut r = cl_req(2, Some(5.0));
        r.criteria_sensor = None;
        coded(clustering_preview(&d, &r).unwrap_err());
        let mut r = cl_req(2, Some(5.0));
        r.cluster_ranges = None;
        coded(clustering_preview(&d, &r).unwrap_err());
        let mut r = cl_req(2, Some(5.0));
        r.n_clusters = Some(3);
        coded(clustering_preview(&d, &r).unwrap_err());
        // invalid training scope, all three kinds
        let bad = PreviewFilter {
            timestamp_ranges: vec![crate::TimeRangeArg {
                start: Some("2024-01-01T05:00:00".into()),
                end: Some("2024-01-01T01:00:00".into()),
            }],
            ..Default::default()
        };
        let mut r = cl_req(1, Some(5.0));
        r.filter = Some(bad.clone());
        coded(clustering_preview(&d, &r).unwrap_err());
        let (ind, ..) = ind_data();
        let mut r = ind_req(None, None);
        r.filter = Some(bad);
        coded(individual_preview(&ind, &r).unwrap_err());
        // The data-shaped ones keep their own codes.
        let mut r = cl_req(1, Some(5.0));
        r.filter = Some(PreviewFilter {
            value_filters: vec![crate::PreviewValueFilter {
                sensor: "X".into(),
                operation: "greater_than".into(),
                value1: Some(1e9),
                value2: None,
            }],
            ..Default::default()
        });
        assert!(clustering_preview(&d, &r).unwrap_err().starts_with("NO_DATA"));
    }

    #[test]
    fn check_clustering_request_accepts_good_requests_and_refuses_bad_ones() {
        let d = cl_data();
        let ranges = [ClusterRange { min: None, max: Some(1.0) }, ClusterRange { min: Some(1.0), max: None }];
        assert!(check_clustering_request(&d, "X", "Y", 2, Some("C"), Some(&ranges), None).is_ok());
        assert!(check_clustering_request(&d, "X", "Y", 1, None, None, None).is_ok());
        assert!(check_clustering_request(&d, "X", "Y", 0, None, None, None).is_err());
        assert!(check_clustering_request(&d, "X", "Y", 3, Some("C"), Some(&ranges), None).is_err());
    }

    #[test]
    fn unusual_sensor_names_never_add_a_file_name_warning() {
        // Export results sanitizes every key tag, so the preview no longer
        // warns about a sensor name that is not a valid file name.
        let v: Vec<f64> = (0..300).map(|i| 10.0 + (i % 9) as f64).collect();
        let d = dataset(vec![("A/B", v)]);
        let mut r = ind_req(None, None);
        r.target = Some("A/B".into());
        let p = individual_preview(&d, &r).unwrap();
        assert!(p.validation.iter().all(|i| i.code != "unsafe_file_name"));
        // Scores still come out once the set points are valid.
        let st = individual(&p).0;
        r.set_points = Some(SetPointsArg {
            lower: Some(st.boundary_3sd[0] - 1.0),
            upper: Some(st.boundary_3sd[1] + 1.0),
            ..Default::default()
        });
        let p = individual_preview(&d, &r).unwrap();
        assert!(p.valid && individual_hourly(&p).score.is_some());
        assert!(p.validation.iter().all(|i| i.code != "unsafe_file_name"));
        // Relationship with a predictor name holding ':'.
        let mut fit = rel_fit(100);
        fit.predictors = vec!["X".into(), "Z:1".into()];
        let dd = dataset(vec![("X", vec![0.0; 100])]);
        let mut rq = rel_req(None);
        rq.predictors = vec![];
        let p = relationship_preview(&dd, &fit, &rq).unwrap();
        assert!(p.validation.iter().all(|i| i.code != "unsafe_file_name"));
    }
}
