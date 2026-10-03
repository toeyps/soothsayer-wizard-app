//! `compute_health_preview` — the bounded, per-kind data the Build Model
//! "Model fit" and "Health score" pages draw, computed Rust-side over the
//! columnar store. Child module of the crate root so it can reuse the private
//! `ResolvedFilter` / `PreviewFilter` / cluster fitting without widening them.
//!
//! Nothing here ships every row to the WebView: every series is downsampled
//! to `max_points` with [`select_indices`] (min/max + lowest score kept) and
//! every scatter is a deterministic stride sample.
//!
//! Row universe per kind:
//!   * individual   — rows with a finite target value that pass the training
//!     scope (`filter`); with `include_out_of_scope` every finite row, the
//!     out-of-scope ones marked `in_scope: false` and left unscored.
//!   * relationship — the rows of the cached fit (all in scope by
//!     construction; `filter` is NOT re-applied — the fit already used it).
//!   * clustering   — in-scope rows with finite X and Y (a row whose criteria
//!     value is in no range is kept in the series with `cluster: null`,
//!     `score: null`).

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::csv_processor::ColumnarData;
use crate::health_score::{
    has_errors, histogram, select_indices, stride_indices, summarize, validate_clustering,
    validate_individual, validate_relationship, ClusterGeom, ClusteringParams, Histogram, Issue,
    IndividualBand, IndividualParams, RelFit, RelationshipParams, ScoreSummary, SetPointsArg,
    MAX_SERIES_POINTS,
};
use crate::metrics::{self, round_metric, round_metric_scaled};
use crate::model_export::unsafe_name_warnings;
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
    /// Cap on `series` points (default 4000, max 100 000).
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
}

impl HealthPreviewRequest {
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
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum HealthStats {
    Individual(IndividualStats),
    Relationship(RelationshipStats),
    Clustering(ClusteringStats),
}

/// `score`: `null` when the set points are incomplete/invalid ("Set the points
/// above"); otherwise one entry per `rows` entry, `null` where the row has no
/// score (out of scope / missing input) — never 0.
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

#[derive(Debug, Serialize)]
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

#[derive(Debug, Serialize)]
pub struct ClusteringSeries {
    pub rows: Vec<u32>,
    pub timestamps: Vec<String>,
    pub x: Vec<f64>,
    pub y: Vec<f64>,
    /// 1-based cluster id; `null` = in no criteria range.
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
    /// `false` when any validation issue is an error (no score is produced).
    pub valid: bool,
    pub series: HealthSeries,
    /// `null` when `valid` is false.
    pub score_summary: Option<ScoreSummary>,
    /// Individual only.
    pub histogram: Option<Histogram>,
    /// Relationship only.
    pub fit_scatter: Option<FitScatter>,
    /// Clustering only.
    pub cluster_scatter: Option<ClusterScatter>,
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

fn ts_text(data: &ColumnarData, row: u32) -> String {
    data.timestamps[row as usize].clone().unwrap_or_default()
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
// Request checks shared by the preview and the export (coded `BAD_REQUEST`)
// ---------------------------------------------------------------------------

/// The training scope must resolve (parseable bounds, no both-legacy-and-ranges,
/// no period that ends before it starts).
pub fn check_scope(data: &ColumnarData, filter: Option<&PreviewFilter>) -> Result<(), String> {
    ResolvedFilter::resolve(filter, &data.headers)
        .map(|_| ())
        .map_err(|e| bad_request(format!("invalid training scope: {e}")))
}

/// Individual: the target sensor exists and the scope resolves.
pub fn check_individual_request(
    data: &ColumnarData,
    target: &str,
    filter: Option<&PreviewFilter>,
) -> Result<(), String> {
    col_index(data, target, "Sensor")?;
    check_scope(data, filter)
}

/// Relationship: target and every predictor exist and the scope resolves.
pub fn check_relationship_request(
    data: &ColumnarData,
    target: &str,
    predictors: &[String],
    filter: Option<&PreviewFilter>,
) -> Result<(), String> {
    col_index(data, target, "Target")?;
    for p in predictors {
        col_index(data, p, "Predictor")?;
    }
    check_scope(data, filter)
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

    // Row universe (ascending dataset rows), then the in-scope flag of each.
    let rows: Vec<u32> = (0..data.n_rows())
        .into_par_iter()
        .filter(|&r| col[r].is_finite() && (include_out || noop || resolved.keeps(data, r)))
        .map(|r| r as u32)
        .collect();
    let in_scope: Vec<bool> = if include_out && !noop {
        rows.par_iter()
            .map(|&r| resolved.keeps(data, r as usize))
            .collect()
    } else {
        vec![true; rows.len()]
    };
    let values: Vec<f64> = rows.iter().map(|&r| col[r as usize]).collect();
    let scope_vals: Vec<f64> = if include_out && !noop {
        values
            .iter()
            .zip(&in_scope)
            .filter(|&(_, &s)| s)
            .map(|(&v, _)| v)
            .collect()
    } else {
        // Borrow-free copy only when needed; otherwise reuse below.
        Vec::new()
    };
    let scope: &[f64] = if include_out && !noop {
        &scope_vals
    } else {
        &values
    };
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
    validation.extend(unsafe_name_warnings(&[("target", target)]));
    let params = if valid {
        IndividualParams::new(band, &sp).ok()
    } else {
        None
    };

    // Scores (NaN = unscored) over the universe.
    let scores: Option<Vec<f64>> = params.map(|p| {
        values
            .par_iter()
            .zip(in_scope.par_iter())
            .map(|(&v, &s)| {
                if s {
                    p.score(v).unwrap_or(f64::NAN)
                } else {
                    f64::NAN
                }
            })
            .collect()
    });

    let summary = scores.as_ref().map(|sc| {
        summarize(sc, data.n_rows(), |i| {
            let row = rows[i];
            (row as usize, data.timestamps[row as usize].clone())
        })
    });

    let sel = select_indices(
        rows.len(),
        req.max_points(),
        Some(&values),
        scores.as_deref(),
    );
    let series = IndividualSeries {
        rows: pick(&rows, &sel),
        timestamps: sel.iter().map(|&i| ts_text(data, rows[i])).collect(),
        value: pick(&values, &sel),
        in_scope: pick(&in_scope, &sel),
        score: scores.as_ref().map(|sc| opts(sc, &sel)),
        total_points: rows.len(),
    };

    Ok(HealthPreview {
        kind: "individual".into(),
        stats: HealthStats::Individual(stats),
        validation,
        valid,
        series: HealthSeries::Individual(series),
        score_summary: summary,
        histogram: histogram(scope, mean_r, sd_r, 80),
        fit_scatter: None,
        cluster_scatter: None,
    })
}

// ---------------------------------------------------------------------------
// Relationship
// ---------------------------------------------------------------------------

/// The residual of one row exactly as the sidecar writes it to
/// `REL_DATASET_*.csv` (`backend.py::train_relationship`):
/// `RESIDUAL = round_metric(actual − round_metric(predicted))` — the residual
/// is taken from the ROUNDED prediction and then rounded itself.
///
/// The FILE is canonical: a consumer re-scoring from `REL_DATASET` must
/// reproduce the preview exactly, so the preview scores, plots and summarises
/// THIS residual (never the raw `actual − predicted`). **This function and
/// `backend.py::train_relationship` must stay in sync** (same rounding, same
/// order of operations). Non-finite input gives NaN (an unscored row).
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

pub fn relationship_preview(
    data: &ColumnarData,
    fit: &RelFit,
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
    let n = fit.rows.len();
    if fit.rows.iter().any(|&r| r as usize >= data.n_rows()) {
        // A fit can only outlive its dataset through a bug (the cache lives in
        // the session) — refuse rather than index out of range.
        return Err(not_fitted("the cached fit does not belong to the loaded dataset"));
    }

    // The residual the FILE stores (see `file_residual`) — scored, plotted and
    // summarised as such so the preview and `REL_DATASET_*.csv` agree.
    let residual: Vec<f64> = (0..n)
        .map(|i| file_residual(fit.actual[i], fit.predicted[i]))
        .collect();

    let sp = req.set_points();
    let mut validation = validate_relationship(Some(stats.two_rmse), &sp);
    let valid = !has_errors(&validation);
    let names: Vec<(&str, &str)> = std::iter::once(("target", fit.target.as_str()))
        .chain(fit.predictors.iter().map(|p| ("predictor", p.as_str())))
        .collect();
    validation.extend(unsafe_name_warnings(&names));
    let scores: Option<Vec<f64>> = if valid {
        RelationshipParams::new(stats.two_rmse, &sp).ok().map(|p| {
            residual
                .par_iter()
                .map(|&r| p.score(r).unwrap_or(f64::NAN))
                .collect()
        })
    } else {
        None
    };
    let summary = scores.as_ref().map(|sc| {
        summarize(sc, n, |i| {
            let row = fit.rows[i];
            (row as usize, data.timestamps[row as usize].clone())
        })
    });

    let sel = select_indices(n, req.max_points(), Some(&residual), scores.as_deref());
    let series = RelationshipSeries {
        rows: pick(&fit.rows, &sel),
        timestamps: sel.iter().map(|&i| ts_text(data, fit.rows[i])).collect(),
        actual: pick(&fit.actual, &sel),
        predicted: opts(&fit.predicted, &sel),
        residual: opts(&residual, &sel),
        score: scores.as_ref().map(|sc| opts(sc, &sel)),
        total_points: n,
    };

    let sc_idx = stride_indices(n, req.max_scatter());
    let xs = &fit.x_cols[x_idx];
    let fit_scatter = FitScatter {
        x_sensor: fit.predictors[x_idx].clone(),
        predictors: fit.predictors.clone(),
        x: pick(xs, &sc_idx),
        actual: pick(&fit.actual, &sc_idx),
        predicted: opts(&fit.predicted, &sc_idx),
        total: n,
    };

    Ok(HealthPreview {
        kind: "relationship".into(),
        stats: HealthStats::Relationship(stats),
        validation,
        valid,
        series: HealthSeries::Relationship(series),
        score_summary: summary,
        histogram: None,
        fit_scatter: Some(fit_scatter),
        cluster_scatter: None,
    })
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
    // Fit exactly the way the PM preview and the exported file do.
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

    // Universe: in-scope rows with finite X and Y, plus each row's cluster
    // (0-based; usize::MAX = none).
    const NONE: u32 = u32::MAX;
    let rows: Vec<u32> = (0..data.n_rows())
        .into_par_iter()
        .filter(|&r| c1[r].is_finite() && c2[r].is_finite() && (noop || resolved.keeps(data, r)))
        .map(|r| r as u32)
        .collect();
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
    let assigned = assign.iter().filter(|&&a| a != NONE).count();

    let sp = req.set_points();
    let mut validation = validate_clustering(&geoms, &sp);
    let valid = !has_errors(&validation);
    validation.extend(unsafe_name_warnings(&[("first_sensor", first), ("second_sensor", second)]));
    let params = if valid {
        ClusteringParams::new(geoms.clone(), &sp).ok()
    } else {
        None
    };

    // (score, sd_distance) per row; NaN = none.
    let scored: Option<Vec<(f64, f64)>> = params.as_ref().map(|p| {
        rows.par_iter()
            .zip(assign.par_iter())
            .map(|(&r, &a)| {
                if a == NONE {
                    return (f64::NAN, f64::NAN);
                }
                p.score(a as usize, c1[r as usize], c2[r as usize])
                    .map_or((f64::NAN, f64::NAN), |(s, d)| (s, d))
            })
            .collect()
    });
    let scores: Option<Vec<f64>> = scored
        .as_ref()
        .map(|v| v.iter().map(|&(s, _)| s).collect());
    let summary = scores.as_ref().map(|sc| {
        summarize(sc, data.n_rows(), |i| {
            let row = rows[i];
            (row as usize, data.timestamps[row as usize].clone())
        })
    });

    let cl_of = |i: usize| (assign[i] != NONE).then(|| assign[i] + 1);

    let sel = select_indices(rows.len(), req.max_points(), None, scores.as_deref());
    let series = ClusteringSeries {
        rows: pick(&rows, &sel),
        timestamps: sel.iter().map(|&i| ts_text(data, rows[i])).collect(),
        x: sel.iter().map(|&i| c1[rows[i] as usize]).collect(),
        y: sel.iter().map(|&i| c2[rows[i] as usize]).collect(),
        cluster: sel.iter().map(|&i| cl_of(i)).collect(),
        sd_distance: match &scored {
            Some(v) => sel.iter().map(|&i| opt(v[i].1)).collect(),
            None => sel.iter().map(|_| None).collect(),
        },
        score: scores.as_ref().map(|sc| opts(sc, &sel)),
        total_points: rows.len(),
    };

    let sc_idx = stride_indices(rows.len(), req.max_scatter());
    let cluster_scatter = ClusterScatter {
        x: sc_idx.iter().map(|&i| c1[rows[i] as usize]).collect(),
        y: sc_idx.iter().map(|&i| c2[rows[i] as usize]).collect(),
        cluster: sc_idx.iter().map(|&i| cl_of(i)).collect(),
        total: rows.len(),
    };

    Ok(HealthPreview {
        kind: "clustering".into(),
        stats: HealthStats::Clustering(ClusteringStats {
            rows: rows.len(),
            assigned_rows: assigned,
            unassigned_rows: rows.len() - assigned,
            cluster_count: preview.cluster_count,
            criteria_sensor: preview.criteria_sensor.clone(),
            clusters: stats_clusters,
        }),
        validation,
        valid,
        series: HealthSeries::Clustering(series),
        score_summary: summary,
        histogram: None,
        fit_scatter: None,
        cluster_scatter: Some(cluster_scatter),
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

    fn individual(p: &HealthPreview) -> (&IndividualStats, &IndividualSeries) {
        match (&p.stats, &p.series) {
            (HealthStats::Individual(s), HealthSeries::Individual(se)) => (s, se),
            _ => panic!("not individual"),
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
    }

    #[test]
    fn individual_scores_are_between_0_and_100_and_match_the_pure_function() {
        let (d, m, s) = ind_data();
        let (mr, sr, b1, b3) = individual_rounded_metrics(m, s);
        let l = b3[0] - 2.0;
        let h = b3[1] + 2.0;
        let p = individual_preview(&d, &ind_req(Some(l), Some(h))).unwrap();
        assert!(p.valid, "{:?}", p.validation);
        let (_, se) = individual(&p);
        let params = IndividualParams::new(
            IndividualBand::from_rounded(mr, sr, b1, b3),
            &SetPointsArg {
                lower: Some(l),
                upper: Some(h),
                ..Default::default()
            },
        )
        .unwrap();
        let sc = se.score.as_ref().unwrap();
        assert_eq!(sc.len(), se.value.len());
        for (v, s) in se.value.iter().zip(sc) {
            let s = s.unwrap();
            assert!((0.0..=100.0).contains(&s));
            assert_eq!(s, params.score(*v).unwrap());
        }
        let sum = p.score_summary.clone().unwrap();
        assert_eq!(sum.scored, 2000);
        assert_eq!(sum.unscored, 0);
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
        assert_eq!(se.total_points, 400);
        let sc = se.score.as_ref().unwrap();
        for i in 0..se.rows.len() {
            if se.in_scope[i] {
                assert!(sc[i].is_some());
            } else {
                assert!(sc[i].is_none(), "out-of-scope row must be unscored, not 0");
            }
        }
        let sum = p.score_summary.clone().unwrap();
        assert_eq!(sum.scored, 200);
        assert_eq!(sum.unscored, 200);
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
        let n = 60_000;
        let mut v: Vec<f64> = (0..n).map(|i| 100.0 + ((i * 7919) % 11) as f64 * 0.1).collect();
        v[31_337] = 100.0 + 25.0; // spike (σ is ~0.3 so far beyond 3σ)
        let d = dataset(vec![("S", v)]);
        let p0 = individual_preview(&d, &ind_req(None, None)).unwrap();
        let st = individual(&p0).0;
        let mut r = ind_req(Some(st.boundary_3sd[0] - 5.0), Some(st.boundary_3sd[1] + 30.0));
        r.max_points = Some(500);
        let p = individual_preview(&d, &r).unwrap();
        assert!(p.valid, "{:?}", p.validation);
        let (_, se) = individual(&p);
        assert!(se.rows.len() <= 500, "{}", se.rows.len());
        assert_eq!(se.total_points, n);
        assert!(se.rows.contains(&31_337), "spike must survive downsampling");
        let sum = p.score_summary.clone().unwrap();
        let min = sum.min_score.unwrap();
        assert_eq!(min.row, 31_337);
        // The shipped series carries that minimum too.
        let sc = se.score.as_ref().unwrap();
        let shipped_min = sc.iter().flatten().cloned().fold(f64::INFINITY, f64::min);
        assert_eq!(shipped_min, min.score);
        assert!(min.timestamp.is_some());
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
        assert!(p.fit_scatter.is_some());
    }

    #[test]
    fn relationship_scores_residuals_with_the_validated_set_points() {
        let fit = rel_fit(2000);
        let d = dataset(vec![("A", vec![0.0; 2000])]);
        let stats = relationship_stats(&fit).unwrap();
        let w = stats.two_rmse;
        let sp = SetPointsArg {
            residual_at_80_lower: Some(-(w + 1.0)),
            residual_at_80_upper: Some(w + 1.0),
            residual_at_0_lower: Some(-(w + 4.0)),
            residual_at_0_upper: Some(w + 4.0),
            ..Default::default()
        };
        let p = relationship_preview(&d, &fit, &rel_req(Some(sp.clone()))).unwrap();
        assert!(p.valid, "{:?}", p.validation);
        let (_, se) = rel(&p);
        let params = RelationshipParams::new(w, &sp).unwrap();
        let sc = se.score.as_ref().unwrap();
        for i in 0..se.rows.len() {
            let r = se.residual[i].unwrap();
            assert_eq!(sc[i].unwrap(), params.score(r).unwrap());
            // residual = actual − predicted
            assert!((r - (se.actual[i] - se.predicted[i].unwrap())).abs() < 1e-12);
        }
        // Residuals inside ±W score 100.
        assert!(sc
            .iter()
            .zip(&se.residual)
            .filter(|(_, r)| r.unwrap().abs() <= w)
            .all(|(s, _)| s.unwrap() == 100.0));
        assert_eq!(p.score_summary.clone().unwrap().scored, 2000);
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
        let p = relationship_preview(&d, &fit, &rel_req(Some(sp))).unwrap();
        assert!(!p.valid);
        assert!(p.validation.iter().any(|i| i.code == "point80_equals_band"));
        assert!(rel(&p).1.score.is_none());
        assert!(p.score_summary.is_none());
    }

    #[test]
    fn relationship_missing_prediction_is_unscored_not_zero() {
        let mut fit = rel_fit(100);
        fit.predicted[40] = f64::NAN;
        let d = dataset(vec![("A", vec![0.0; 100])]);
        let w = relationship_stats(&fit).unwrap().two_rmse;
        let sp = SetPointsArg {
            residual_at_80_lower: Some(-(w + 1.0)),
            residual_at_80_upper: Some(w + 1.0),
            residual_at_0_lower: Some(-(w + 4.0)),
            residual_at_0_upper: Some(w + 4.0),
            ..Default::default()
        };
        let p = relationship_preview(&d, &fit, &rel_req(Some(sp))).unwrap();
        let (_, se) = rel(&p);
        let at = se.rows.iter().position(|&r| r == 40).unwrap();
        assert!(se.predicted[at].is_none() && se.residual[at].is_none());
        assert!(se.score.as_ref().unwrap()[at].is_none());
        let sum = p.score_summary.clone().unwrap();
        assert_eq!((sum.scored, sum.unscored, sum.total_rows), (99, 1, 100));
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
        let p = relationship_preview(&d, &fit, &r).unwrap();
        let (_, se) = rel(&p);
        assert!(se.rows.len() <= 400);
        assert_eq!(se.total_points, 40_000);
        assert!(se.rows.contains(&22_222));
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

    fn clus(p: &HealthPreview) -> (&ClusteringStats, &ClusteringSeries) {
        match (&p.stats, &p.series) {
            (HealthStats::Clustering(s), HealthSeries::Clustering(se)) => (s, se),
            _ => panic!("not clustering"),
        }
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

    #[test]
    fn clustering_requires_n_above_3_and_returns_issues_without_scores() {
        let d = cl_data();
        let p = clustering_preview(&d, &cl_req(2, None)).unwrap();
        assert!(!p.valid);
        assert_eq!(p.validation[0].code, "required");
        assert!(clus(&p).1.score.is_none());
        let p = clustering_preview(&d, &cl_req(2, Some(3.0))).unwrap();
        assert_eq!(p.validation[0].code, "outer_sd_equals_3");
        let p = clustering_preview(&d, &cl_req(2, Some(2.5))).unwrap();
        assert_eq!(p.validation[0].code, "outer_sd_not_above_3");
        // Scatter + stats still present.
        assert!(p.cluster_scatter.is_some());
    }

    #[test]
    fn clustering_scores_use_the_assigned_clusters_own_gaussian() {
        let d = cl_data();
        let p = clustering_preview(&d, &cl_req(2, Some(6.0))).unwrap();
        assert!(p.valid, "{:?}", p.validation);
        let (st, se) = clus(&p);
        let sc = se.score.as_ref().unwrap();
        let geoms: Vec<ClusterGeom> = st
            .clusters
            .iter()
            .map(|c| ClusterGeom {
                cluster_id: c.cluster_id,
                x_center: c.x_center,
                y_center: c.y_center,
                x_sd: c.x_sd,
                y_sd: c.y_sd,
                angle_deg: c.angle_deg,
            })
            .collect();
        for i in 0..se.rows.len() {
            let k = se.cluster[i].unwrap() as usize - 1;
            // Rows alternate clusters by index: even → cluster 1.
            assert_eq!(k, (se.rows[i] % 2) as usize);
            let dist = geoms[k].sd_distance(se.x[i], se.y[i]);
            assert!((se.sd_distance[i].unwrap() - dist).abs() < 1e-12);
            assert_eq!(
                sc[i].unwrap(),
                crate::health_score::score_clustering_distance(dist, 6.0).unwrap()
            );
        }
        // A point far from its cluster would score 0; the ones near score high.
        let sum = p.score_summary.clone().unwrap();
        assert_eq!(sum.scored, 2000);
        assert!(sum.share_80_100.unwrap() > 50.0);
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

        // Three-way data: C = 5 / 15 / 100; ranges cover 5 and 100 only.
        let mut cols = Vec::new();
        let n = 600;
        let (mut x, mut y, mut c) = (vec![], vec![], vec![]);
        for i in 0..n {
            let g = i % 3;
            let (cx, crit) = [(0.0, 5.0), (30.0, 15.0), (60.0, 100.0)][g];
            x.push(cx + ((i * 31 % 17) as f64 - 8.0) * 0.1);
            y.push(cx + ((i * 17 % 13) as f64 - 6.0) * 0.1);
            c.push(if i == 3 { f64::NAN } else { crit });
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
        let (st, se) = clus(&p);
        // 200 rows of g==1 (15) unassigned + the NaN criteria row (it was g==0).
        assert_eq!(st.unassigned_rows, 201);
        assert_eq!(st.assigned_rows, 399);
        let sc = se.score.as_ref().unwrap();
        for i in 0..se.rows.len() {
            if se.cluster[i].is_none() {
                assert!(sc[i].is_none(), "unassigned row must be unscored");
            } else {
                assert!(sc[i].is_some());
            }
        }
        let sum = p.score_summary.clone().unwrap();
        assert_eq!(sum.scored, 399);
        assert_eq!(sum.unscored, 600 - 399);
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
        assert_eq!(p.score_summary.clone().unwrap().scored, 2000);
    }

    #[test]
    fn clustering_series_and_scatter_are_bounded() {
        let d = cl_data();
        let mut r = cl_req(2, Some(6.0));
        r.max_points = Some(100);
        r.max_scatter_points = Some(50);
        let p = clustering_preview(&d, &r).unwrap();
        let (_, se) = clus(&p);
        assert!(se.rows.len() <= 100);
        assert_eq!(se.total_points, 2000);
        let sc = p.cluster_scatter.unwrap();
        assert_eq!(sc.x.len(), 50);
        assert_eq!(sc.total, 2000);
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
        assert!(j["score_summary"].is_null());
        assert_eq!(j["valid"], false);
        assert_eq!(j["validation"][0]["code"], "required");
        assert!(j["histogram"]["bin_edges"].is_array());
        // No NaN leaked: every number in the value array is finite.
        assert!(j["series"]["value"].as_array().unwrap().iter().all(|v| v.is_number()));
    }

    // ---------- 2026-10-04: canonical residual (the FILE's), coded errors, warnings ----------

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
    fn check_helpers_agree_with_the_previews_and_accept_good_requests() {
        let d = cl_data();
        assert!(check_individual_request(&d, "X", None).is_ok());
        assert!(check_individual_request(&d, "x", None).unwrap_err().starts_with("BAD_REQUEST"));
        assert!(check_relationship_request(&d, "Y", &["X".into(), "C".into()], None).is_ok());
        assert!(check_relationship_request(&d, "Y", &["nope".into()], None).unwrap_err().starts_with("BAD_REQUEST: Predictor"));
        assert!(check_relationship_request(&d, "nope", &["X".into()], None).unwrap_err().starts_with("BAD_REQUEST: Target"));
        let ranges = [ClusterRange { min: None, max: Some(1.0) }, ClusterRange { min: Some(1.0), max: None }];
        assert!(check_clustering_request(&d, "X", "Y", 2, Some("C"), Some(&ranges), None).is_ok());
        assert!(check_clustering_request(&d, "X", "Y", 1, None, None, None).is_ok());
        assert!(check_clustering_request(&d, "X", "Y", 0, None, None, None).is_err());
        assert!(check_clustering_request(&d, "X", "Y", 3, Some("C"), Some(&ranges), None).is_err());
    }

    #[test]
    fn unsafe_sensor_names_add_a_warning_but_never_block_the_preview() {
        let v: Vec<f64> = (0..300).map(|i| 10.0 + (i % 9) as f64).collect();
        let d = dataset(vec![("A/B", v)]);
        let mut r = ind_req(None, None);
        r.target = Some("A/B".into());
        let p = individual_preview(&d, &r).unwrap();
        assert!(p.validation.iter().any(|i| i.code == "unsafe_file_name"
            && i.severity == crate::health_score::Severity::Warning
            && i.field == "target"));
        // Scores still come out once the set points are valid.
        let st = individual(&p).0;
        r.set_points = Some(SetPointsArg {
            lower: Some(st.boundary_3sd[0] - 1.0),
            upper: Some(st.boundary_3sd[1] + 1.0),
            ..Default::default()
        });
        let p = individual_preview(&d, &r).unwrap();
        assert!(p.valid && individual(&p).1.score.is_some());
        // A normal name gets no warning.
        let (ind, ..) = ind_data();
        let p = individual_preview(&ind, &ind_req(None, None)).unwrap();
        assert!(p.validation.iter().all(|i| i.code != "unsafe_file_name"));
        // Relationship: one warning per bad name (target and predictors).
        let mut fit = rel_fit(100);
        fit.predictors = vec!["X".into(), "Z:1".into()];
        let dd = dataset(vec![("X", vec![0.0; 100])]);
        let mut rq = rel_req(None);
        rq.predictors = vec![];
        let p = relationship_preview(&dd, &fit, &rq).unwrap();
        let w: Vec<&str> = p.validation.iter().filter(|i| i.code == "unsafe_file_name").map(|i| i.field.as_str()).collect();
        assert_eq!(w, vec!["predictor"]);
    }
}
