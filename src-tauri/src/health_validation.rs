//! Scoring periods ("just score it", user decision 2026-10-09/10).
//!
//! A model is fitted ONLY on the training scope (healthy periods). A scoring
//! period (wire name still `test_periods`) is nothing but a time range,
//! `start` -> `end`: the train-only model gives a health score for that time and
//! the user reads the chart. Nothing is judged here - there is no Normal /
//! Known-problem label, no event time, no lead time and no detection verdict any
//! more (they were removed with the Workbench redesign; see
//! `docs/design/handoff/workbench-redesign/README.md` section 2).
//!
//! This module is the one implementation of that maths. The three previews
//! (`health_preview`) feed it the rows they already scored with the TRAIN-only
//! model and it returns the `test_validation` block of `compute_health_preview`;
//! the export (`export_model_files`) runs the very same preview code and writes
//! the same block as `validation` into the `*_INFO_*.json` file. Nothing here
//! ever fits or refits anything.
//!
//! Semantics:
//!   * Scoring rows = rows inside the scoring period that also pass the running
//!     condition's VALUE conditions (and AND/OR mode) of the training scope.
//!     The training TIME periods do not apply to them. A scoring period MAY
//!     overlap the training periods; results use the whole period and
//!     `train_rows` / `train_days` report the overlap.
//!   * `pct_below_80` = share of the SCORED rows whose score is below 80.
//!   * `lowest` = the lowest level the score STAYED at (or below) for
//!     [`DROP_SUSTAIN_HOURS`] of running time, i.e. for `ceil(1 h / sample
//!     interval)` CONSECUTIVE scored dataset rows (a row removed by the running
//!     condition, or an unscored row, breaks the window): min over every window
//!     of the window's max, so a single restart dip is never reported as
//!     "lowest 0". `lowest_at` = the first row of that window.
//!   * "Running time days" = rows x the dataset's median sample interval.
//!
//! Naming: the Rust types and the wire keys keep their original `test_*` names
//! (`TestPeriodArg`, `test_periods`, `test_validation`, `tests`) so nothing on
//! the wire is renamed; only the user-facing wording says "scoring period" and
//! numbers them `S1`, `S2`, ... by list position.

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::Path;

use crate::csv_processor::ColumnarData;
use crate::health_score::{Issue, Severity, SCORE_AT_3SD};
use crate::{parse_time_bound, PreviewFilter, ResolvedFilter, TimeRangeArg};

/// The window of the "lowest" rule: the score has to stay at (or below) a level
/// for this long (hours of RUNNING time) for that level to be reported.
pub const DROP_SUSTAIN_HOURS: f64 = 1.0;

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/// One scoring period as sent by the frontend (`test_periods[]`): only
/// `start` -> `end`. Same datetime strings as the training periods; `None` /
/// blank = open bound.
///
/// Older callers also send `label` (`"normal"` | `"problem"`) and `event_time`
/// (or `eventTime`). Those keys are still ACCEPTED - serde skips keys it does
/// not know, and this struct must never get `deny_unknown_fields` - but they
/// are not read: whatever they hold, the period is scored the same way.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
pub struct TestPeriodArg {
    #[serde(default)]
    pub start: Option<String>,
    #[serde(default)]
    pub end: Option<String>,
}

pub(crate) fn blank_to_none(s: &Option<String>) -> Option<String> {
    s.as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
}

fn err_issue(code: &str, field: String, message: String) -> Issue {
    Issue {
        code: code.to_string(),
        severity: Severity::Error,
        message,
        field,
    }
}

/// One resolved scoring period. `filter` is `None` when the period is invalid
/// (the matching issue is in [`TestPlan::issues`]): it is skipped, its result
/// has no rows and no metrics.
pub struct PlannedTest {
    /// 1-based position in the request (`S1`, `S2`, ...).
    pub index: usize,
    start: Option<String>,
    end: Option<String>,
    filter: Option<ResolvedFilter>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TrainRange {
    pub start: Option<String>,
    pub end: Option<String>,
}

/// The scoring periods of a request, parsed once. Built by [`TestPlan::resolve`].
pub struct TestPlan {
    pub tests: Vec<PlannedTest>,
    /// Structured problems with the periods (error severity, codes below).
    pub issues: Vec<Issue>,
    pub train_ranges: Vec<TrainRange>,
}

impl TestPlan {
    /// Parse and check every scoring period against the training scope `base`.
    ///
    /// Issue codes (field `test_period_<n>_start` / `test_period_<n>_end`):
    /// `test_start_unparseable`, `test_end_unparseable`,
    /// `test_ends_before_start`.
    pub fn resolve(args: &[TestPeriodArg], base: Option<&PreviewFilter>, headers: &[String]) -> TestPlan {
        let mut tests = Vec::with_capacity(args.len());
        let mut issues = Vec::new();
        for (i, a) in args.iter().enumerate() {
            let n = i + 1;
            let mut bad = false;
            let start = blank_to_none(&a.start);
            let end = blank_to_none(&a.end);
            let s = match parse_time_bound(start.as_deref(), "start") {
                Ok(v) => v,
                Err(_) => {
                    issues.push(err_issue(
                        "test_start_unparseable",
                        format!("test_period_{n}_start"),
                        format!("Scoring period S{n}: the start time '{}' is not a valid date and time.", start.as_deref().unwrap_or("")),
                    ));
                    bad = true;
                    None
                }
            };
            let e = match parse_time_bound(end.as_deref(), "end") {
                Ok(v) => v,
                Err(_) => {
                    issues.push(err_issue(
                        "test_end_unparseable",
                        format!("test_period_{n}_end"),
                        format!("Scoring period S{n}: the end time '{}' is not a valid date and time.", end.as_deref().unwrap_or("")),
                    ));
                    bad = true;
                    None
                }
            };
            if let (Some(sv), Some(ev)) = (s, e) {
                if sv > ev {
                    issues.push(err_issue(
                        "test_ends_before_start",
                        format!("test_period_{n}_end"),
                        format!("Scoring period S{n} ends before it starts."),
                    ));
                    bad = true;
                }
            }
            let filter = if bad {
                None
            } else {
                // The running condition's VALUE conditions (+ AND/OR) with the
                // scoring period as the only time gate.
                let pf = PreviewFilter {
                    timestamp_start: None,
                    timestamp_end: None,
                    value_filters: base.map(|b| b.value_filters.clone()).unwrap_or_default(),
                    combine: base.and_then(|b| b.combine.clone()),
                    timestamp_ranges: vec![TimeRangeArg {
                        start: start.clone(),
                        end: end.clone(),
                    }],
                };
                ResolvedFilter::resolve(Some(&pf), headers).ok()
            };
            tests.push(PlannedTest {
                index: n,
                start,
                end,
                filter,
            });
        }
        TestPlan {
            tests,
            issues,
            train_ranges: train_ranges_of(base),
        }
    }

    /// Dataset rows of each test (ascending), one `Vec` per planned test (empty
    /// for an invalid one): rows that pass `finite` (the kind's "has all its
    /// inputs" test) and the test's filter.
    pub fn collect_rows(
        &self,
        data: &ColumnarData,
        finite: &(dyn Fn(usize) -> bool + Sync),
    ) -> Vec<Vec<u32>> {
        self.tests
            .iter()
            .map(|t| match &t.filter {
                Some(f) => (0..data.n_rows())
                    .into_par_iter()
                    .filter(|&r| finite(r) && f.keeps(data, r))
                    .map(|r| r as u32)
                    .collect(),
                None => Vec::new(),
            })
            .collect()
    }
}

/// Test rows the TRAIN-only Relationship model has to PREDICT: the rows of every
/// test period that have all inputs (`target_col` + `pred_cols` finite) and are
/// not training rows. Ascending and unique. THE one implementation - the
/// health preview, the lazy `predict_relationship` run, the Train pre-warm and
/// the export all call it, so they can never disagree on which rows are tested.
/// `train_rows` must be ascending (a fit's `rows` are).
///
/// Composed of [`rel_test_rows`] + [`rows_outside_training`]; a caller that also
/// needs the per-test lists (the Relationship preview) calls those two itself so
/// the dataset is scanned once.
pub fn extra_test_rows(
    plan: &TestPlan,
    data: &ColumnarData,
    target_col: usize,
    pred_cols: &[usize],
    train_rows: &[u32],
) -> Vec<u32> {
    rows_outside_training(&rel_test_rows(plan, data, target_col, pred_cols), train_rows)
}

/// Relationship: the rows of each test period that have all inputs
/// (`target_col` + `pred_cols` finite), one ascending `Vec` per planned test.
pub fn rel_test_rows(
    plan: &TestPlan,
    data: &ColumnarData,
    target_col: usize,
    pred_cols: &[usize],
) -> Vec<Vec<u32>> {
    plan.collect_rows(data, &|r| {
        data.columns[target_col][r].is_finite() && pred_cols.iter().all(|&c| data.columns[c][r].is_finite())
    })
}

/// The rows of `per_test` that are not in `train_rows` (ascending), ascending
/// and unique across all tests.
pub fn rows_outside_training(per_test: &[Vec<u32>], train_rows: &[u32]) -> Vec<u32> {
    let mut rows: Vec<u32> = per_test
        .iter()
        .flatten()
        .copied()
        .filter(|r| train_rows.binary_search(r).is_err())
        .collect();
    rows.sort_unstable();
    rows.dedup();
    rows
}

/// Row-major predictor values of `rows` (what the sidecar's `X_extra` carries).
pub fn x_rows(data: &ColumnarData, pred_cols: &[usize], rows: &[u32]) -> Vec<Vec<f64>> {
    rows.iter()
        .map(|&r| pred_cols.iter().map(|&c| data.columns[c][r as usize]).collect())
        .collect()
}

/// Stable code of the warning added when the test periods could not be scored
/// and trying again may help (engine error / timeout, too many rows).
pub const TEST_SCORING_FAILED: &str = "test_scoring_failed";
/// Stable code of the warning added when the bundled Relation model engine is
/// too old to score test periods: a retry can never help (only an updated
/// install), so the frontend shows no "Try again" for it.
pub const TEST_SCORING_OUTDATED: &str = "test_scoring_outdated";

/// Warning code when the test periods have too many rows for the model cache's
/// memory budget (2026-10-07, code review): retrying the same periods fails the
/// same way, so it gets its own code and the frontend offers no "Try again" --
/// the user has to shorten or remove a test period.
pub const TEST_SCORING_TOO_LARGE: &str = "test_scoring_too_large";

/// Why the test periods of a Relationship preview could not be scored. Picks
/// the warning's code and user-facing wording; also kept with the cache's
/// "last attempt failed" marker, so a remembered failure is reported with the
/// same wording as the original one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TestScoringFailure {
    /// The engine failed, timed out or answered something unusable.
    EngineError,
    /// The predictions do not fit the model cache's memory budget.
    OverBudget,
    /// The bundled engine predates `predict_relationship` (`SIDECAR_OUTDATED`).
    Outdated,
}

/// The warning `compute_health_preview` adds when the prediction step for the
/// test rows failed (never an error: the training results are still valid).
pub fn test_scoring_issue(kind: TestScoringFailure) -> Issue {
    let (code, message) = match kind {
        TestScoringFailure::Outdated => (
            TEST_SCORING_OUTDATED,
            "The scoring periods could not be scored: the Relation model engine in this build is out of \
             date - reinstall or update the app. The training results above are not affected.",
        ),
        TestScoringFailure::OverBudget => (
            TEST_SCORING_TOO_LARGE,
            "These scoring periods have too many rows to score in memory - shorten them or remove one. \
             The training results above are not affected.",
        ),
        TestScoringFailure::EngineError => (
            TEST_SCORING_FAILED,
            "The scoring periods could not be scored because the Relation model engine did not answer. \
             The training results above are not affected - try again, or train the model again.",
        ),
    };
    Issue {
        code: code.to_string(),
        severity: Severity::Warning,
        message: message.to_string(),
        field: "test_periods".to_string(),
    }
}

/// Turn a finished `test_validation` into "nothing could be scored": every
/// period keeps its identity (index, period, days, rows) but has no score, no
/// metrics and none of the nullable score fields - never a half-filled result
/// that looks like a real one.
///
/// `input_rows` (aligned with `v.tests`; ignored when the length differs): the
/// rows of each test period that have all the model's inputs, i.e. what a
/// successful prediction step would have scored. When given, `rows` / `days`
/// are set from it - otherwise a period fully outside the training scope would
/// report 0 rows only because its predictions are missing. `interval_secs` =
/// [`sample_interval_secs`] of the dataset.
pub fn mark_unscored(v: &mut TestValidation, input_rows: Option<&[usize]>, interval_secs: Option<f64>) {
    let counts = input_rows.filter(|c| c.len() == v.tests.len());
    for (j, t) in v.tests.iter_mut().enumerate() {
        if let Some(c) = counts {
            t.rows = c[j];
            t.days = days_of(c[j], interval_secs);
        }
        t.scored = 0;
        t.metrics = KindMetrics::default();
        t.pct_below_80 = None;
        t.lowest = None;
        t.lowest_at = None;
    }
}

/// The training periods as echoed in `train_ranges` (the new `timestamp_ranges`,
/// or the legacy start/end pair as one range).
fn train_ranges_of(base: Option<&PreviewFilter>) -> Vec<TrainRange> {
    let Some(b) = base else {
        return Vec::new();
    };
    if !b.timestamp_ranges.is_empty() {
        return b
            .timestamp_ranges
            .iter()
            .map(|r| TrainRange {
                start: blank_to_none(&r.start),
                end: blank_to_none(&r.end),
            })
            .collect();
    }
    let (s, e) = (blank_to_none(&b.timestamp_start), blank_to_none(&b.timestamp_end));
    if s.is_some() || e.is_some() {
        vec![TrainRange { start: s, end: e }]
    } else {
        Vec::new()
    }
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/// The metrics that make sense for the model kind; every other field stays
/// `None` and is OMITTED from the JSON (undefined on the TS side).
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct KindMetrics {
    // Relationship (residual = actual - predicted)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r2: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rmse: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub residual_mean: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub residual_sd: Option<f64>,
    // Individual (train block only: the model's own mean / sd)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mean: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub within_3sd_pct: Option<f64>,
    /// Test block only: (test mean - train mean) / train sd.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mean_shift_sd: Option<f64>,
    // Clustering
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inside_3sd_ring_pct: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TrainBlock {
    pub rows: usize,
    pub days: f64,
    #[serde(flatten)]
    pub metrics: KindMetrics,
}

/// The result of one scoring period. Facts only - no label, no event time, no
/// lead time and no verdict (removed 2026-10-10, "just score it").
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TestResult {
    /// 1-based position in the request's `test_periods` (`S1` = 1).
    pub index: usize,
    pub start: Option<String>,
    pub end: Option<String>,
    pub days: f64,
    pub rows: usize,
    #[serde(flatten)]
    pub metrics: KindMetrics,
    /// Rows (and running days) of this scoring period that are also train rows.
    pub train_rows: usize,
    pub train_days: f64,
    /// Rows that got a score.
    pub scored: usize,
    /// Share (%) of the scored rows whose score is below 80. `None` = nothing
    /// was scored.
    pub pct_below_80: Option<f64>,
    /// The lowest level the score held for [`DROP_SUSTAIN_HOURS`] (rounded to
    /// a whole score), and the timestamp text of the first row of that window.
    pub lowest: Option<f64>,
    pub lowest_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TestValidation {
    pub train: TrainBlock,
    pub train_ranges: Vec<TrainRange>,
    pub tests: Vec<TestResult>,
}

// ---------------------------------------------------------------------------
// Maths
// ---------------------------------------------------------------------------

/// `-0.0` -> `0.0` (adding +0.0 does it) so a rounded tiny negative never
/// shows up as `-0.0` in the JSON.
pub fn nz(x: f64) -> f64 {
    x + 0.0
}

/// One decimal (percentages, days).
pub fn r1(x: f64) -> f64 {
    nz((x * 10.0).round() / 10.0)
}

pub fn r2dp(x: f64) -> f64 {
    nz((x * 100.0).round() / 100.0)
}

pub fn r3dp(x: f64) -> f64 {
    nz((x * 1000.0).round() / 1000.0)
}

/// Median sample interval of the dataset in seconds (`None` below 2 valid
/// timestamps). Constant for a loaded dataset and cached on it (computed at
/// most once, normally by `load_csv`) - see
/// [`ColumnarData::sample_interval_secs`]; this is never a scan per call.
pub fn sample_interval_secs(data: &ColumnarData) -> Option<f64> {
    data.sample_interval_secs()
}

/// Consecutive scored rows that make [`DROP_SUSTAIN_HOURS`] of running time
/// (the window of the "lowest" rule).
pub fn sustain_rows(interval_secs: Option<f64>) -> usize {
    match interval_secs {
        Some(iv) if iv.is_finite() && iv > 0.0 => {
            (((DROP_SUSTAIN_HOURS * 3600.0) / iv) - 1e-9).ceil().clamp(1.0, 1_000_000.0) as usize
        }
        _ => 1,
    }
}

/// "Running time days" of `rows` dataset rows: rows x the dataset's median
/// sample interval, one decimal (`0.0` when the interval is unknown). THE one
/// definition - the scoring results' `days` and the Running-condition modal's
/// per-period "d running" (`period_counts`) both come from here.
pub(crate) fn days_of(rows: usize, interval_secs: Option<f64>) -> f64 {
    interval_secs.map_or(0.0, |iv| r1(rows as f64 * iv / 86_400.0))
}

/// The score facts of one scoring period's rows. Positions index `rows` /
/// `scores`.
#[derive(Debug, Clone, PartialEq)]
pub struct Facts {
    pub scored: usize,
    /// Scored rows below 80 (every one counts, however short the dip).
    pub below_80: usize,
    /// `(level, position of the window's first row)`: the lowest level the
    /// score stayed at (or below) for `sustain` consecutive scored rows.
    pub lowest: Option<(f64, usize)>,
}

/// One O(n) pass (the window maximum uses a monotonic deque). `rows` are
/// ascending dataset rows, `scores` aligned with them (`NaN` = unscored). A gap
/// (an unscored row, or rows that are not adjacent in the dataset) restarts the
/// window.
pub fn score_facts(rows: &[u32], scores: &[f64], sustain: usize) -> Facts {
    let s = sustain.max(1);
    let mut scored = 0usize;
    let mut below = 0usize;
    let mut lowest: Option<(f64, usize)> = None;
    let mut seg = 0usize;
    let mut dq: VecDeque<usize> = VecDeque::new();
    for i in 0..rows.len() {
        let v = scores[i];
        let gap = v.is_nan() || (i > 0 && u64::from(rows[i]) != u64::from(rows[i - 1]) + 1);
        if gap {
            seg = 0;
            dq.clear();
        }
        if v.is_nan() {
            continue;
        }
        seg += 1;
        scored += 1;
        if v < SCORE_AT_3SD {
            below += 1;
        }
        while dq.back().is_some_and(|&b| scores[b] <= v) {
            dq.pop_back();
        }
        dq.push_back(i);
        while dq.front().is_some_and(|&f| f + s <= i) {
            dq.pop_front();
        }
        if seg >= s {
            let mx = scores[*dq.front().expect("window is never empty")];
            if lowest.is_none_or(|(l, _)| mx < l) {
                lowest = Some((mx, i + 1 - s));
            }
        }
    }
    Facts {
        scored,
        below_80: below,
        lowest,
    }
}

/// The rows a kind scored (the UNIVERSE of its series), aligned arrays.
pub struct Universe<'a> {
    pub data: &'a ColumnarData,
    /// Ascending dataset rows.
    pub rows: &'a [u32],
    /// Is this row a training row (passes the training scope)?
    pub is_train: &'a [bool],
    /// Aligned scores (`NaN` = unscored); `None` while the set points are
    /// invalid.
    pub scores: Option<&'a [f64]>,
}

/// Build the whole `test_validation` block.
///
/// * `test_rows` - [`TestPlan::collect_rows`] output (rows the kind could use);
///   rows missing from the universe (no prediction, ...) are dropped.
/// * `train_rows` / `train_metrics` - the kind's train summary.
/// * `metrics_for(positions)` - the kind's metrics over a test's universe
///   positions (called only for a period with rows).
pub fn build(
    plan: &TestPlan,
    test_rows: &[Vec<u32>],
    u: &Universe,
    interval_secs: Option<f64>,
    train_rows: usize,
    train_metrics: KindMetrics,
    metrics_for: &dyn Fn(&[usize]) -> KindMetrics,
) -> TestValidation {
    let sustain = sustain_rows(interval_secs);
    let tests = plan
        .tests
        .iter()
        .enumerate()
        .map(|(j, t)| {
            let pos: Vec<usize> = test_rows
                .get(j)
                .map(|rs| rs.iter().filter_map(|r| u.rows.binary_search(r).ok()).collect())
                .unwrap_or_default();
            let rows = pos.len();
            let train_in = pos.iter().filter(|&&p| u.is_train[p]).count();
            let metrics = if rows > 0 { metrics_for(&pos) } else { KindMetrics::default() };
            let mut res = TestResult {
                index: t.index,
                start: t.start.clone(),
                end: t.end.clone(),
                days: days_of(rows, interval_secs),
                rows,
                metrics,
                train_rows: train_in,
                train_days: days_of(train_in, interval_secs),
                scored: 0,
                pct_below_80: None,
                lowest: None,
                lowest_at: None,
            };
            if let (Some(sc), true) = (u.scores, rows > 0) {
                let drows: Vec<u32> = pos.iter().map(|&p| u.rows[p]).collect();
                let tscores: Vec<f64> = pos.iter().map(|&p| sc[p]).collect();
                let f = score_facts(&drows, &tscores, sustain);
                res.scored = f.scored;
                res.pct_below_80 = (f.scored > 0).then(|| r1(f.below_80 as f64 * 100.0 / f.scored as f64));
                if let Some((lvl, at)) = f.lowest {
                    res.lowest = Some(lvl.round());
                    res.lowest_at = u.data.timestamps[drows[at] as usize].clone();
                }
            }
            res
        })
        .collect();
    TestValidation {
        train: TrainBlock {
            rows: train_rows,
            days: days_of(train_rows, interval_secs),
            metrics: train_metrics,
        },
        train_ranges: plan.train_ranges.clone(),
        tests,
    }
}

// ---------------------------------------------------------------------------
// Export block
// ---------------------------------------------------------------------------

/// The `validation` object written into the `*_INFO_*.json` file. `tests` are
/// the scoring periods exactly as in `test_validation` (so: no `label`, no
/// `event_time`, no `first_below_80`, no `lead_days`).
pub fn export_block(v: &TestValidation, validated_at: &str) -> serde_json::Value {
    serde_json::json!({
        "tested": true,
        "validated_at": validated_at,
        "train": v.train,
        "train_ranges": v.train_ranges,
        "tests": v.tests,
    })
}

/// Add `validation` to an already written `*_INFO_*.json` (every other key is
/// left exactly as it was).
pub fn inject_validation(info_path: &Path, block: serde_json::Value) -> Result<(), String> {
    let text = std::fs::read_to_string(info_path)
        .map_err(|e| format!("Failed to read {}: {e}", info_path.display()))?;
    let mut doc: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("Failed to parse {}: {e}", info_path.display()))?;
    let obj = doc
        .as_object_mut()
        .ok_or_else(|| format!("{} is not a JSON object", info_path.display()))?;
    obj.insert("validation".to_string(), block);
    let out = serde_json::to_string_pretty(&doc).map_err(|e| format!("JSON serialize failed: {e}"))?;
    std::fs::write(info_path, out)
        .map_err(|e| format!("Failed to write {}: {}", info_path.display(), e))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn arg(start: &str, end: &str) -> TestPeriodArg {
        TestPeriodArg {
            start: Some(start.into()),
            end: Some(end.into()),
        }
    }

    fn headers() -> Vec<String> {
        vec!["timestamp".into(), "S".into()]
    }

    fn rows(n: u32) -> Vec<u32> {
        (0..n).collect()
    }

    // ---------- test-scoring warnings ----------

    #[test]
    fn test_scoring_issue_codes_and_wording_per_kind() {
        let out = test_scoring_issue(TestScoringFailure::Outdated);
        assert_eq!(out.code, TEST_SCORING_OUTDATED, "own code: a retry cannot help");
        assert!(out.message.contains("out of date") && out.message.contains("reinstall"));
        let big = test_scoring_issue(TestScoringFailure::OverBudget);
        assert_eq!(big.code, TEST_SCORING_TOO_LARGE, "own code: retrying the same rows cannot help");
        assert!(big.message.contains("too many rows") && big.message.contains("shorten them or remove one"));
        assert!(!big.message.contains("did not answer"));
        let eng = test_scoring_issue(TestScoringFailure::EngineError);
        assert_eq!(eng.code, TEST_SCORING_FAILED);
        assert!(eng.message.contains("did not answer") && eng.message.contains("try again"));
        for i in [&out, &big, &eng] {
            assert_eq!(i.severity, Severity::Warning);
            assert_eq!(i.field, "test_periods");
            assert!(i.message.contains("training results above are not affected"));
            assert!(!i.message.contains("LinearGAM") && !i.message.contains("sidecar"));
            // "Test periods" are called scoring periods in everything the user reads.
            assert!(i.message.contains("coring periods"), "{}", i.message);
            assert!(!i.message.to_lowercase().contains("test period"), "{}", i.message);
        }
    }

    // ---------- the 1 h "lowest" window + the below-80 count ----------

    #[test]
    fn sustain_rows_follows_the_sample_interval() {
        assert_eq!(sustain_rows(Some(600.0)), 6);
        assert_eq!(sustain_rows(Some(60.0)), 60);
        assert_eq!(sustain_rows(Some(3600.0)), 1);
        assert_eq!(sustain_rows(Some(7200.0)), 1);
        assert_eq!(sustain_rows(Some(420.0)), 9); // 63 min >= 1 h
        assert_eq!(sustain_rows(None), 1);
        assert_eq!(sustain_rows(Some(0.0)), 1);
    }

    fn scores_with_dip(n: usize, from: usize, len: usize, level: f64) -> Vec<f64> {
        (0..n).map(|i| if i >= from && i < from + len { level } else { 100.0 }).collect()
    }

    #[test]
    fn every_row_below_80_counts_but_only_a_full_hour_moves_the_lowest() {
        let r = rows(30);
        // 10-minute rows: 5 rows = 50 min, 6 rows = 60 min.
        let f5 = score_facts(&r, &scores_with_dip(30, 10, 5, 30.0), 6);
        assert_eq!((f5.scored, f5.below_80), (30, 5), "a short dip still counts in the share");
        assert_eq!(f5.lowest, Some((100.0, 0)), "50 min at 30 is not a level the score held for 1 h");
        let f6 = score_facts(&r, &scores_with_dip(30, 10, 6, 30.0), 6);
        assert_eq!(f6.below_80, 6);
        assert_eq!(f6.lowest, Some((30.0, 10)), "60 min at 30: held, from the dip's first row");
    }

    #[test]
    fn lowest_is_the_level_held_for_the_whole_window() {
        let r = rows(40);
        // One-row restart dip to 0 does not count; a 6-row plateau at 40-60 does.
        let mut s = vec![100.0; 40];
        s[3] = 0.0;
        for (k, v) in s.iter_mut().enumerate().skip(20).take(6) {
            *v = 40.0 + 4.0 * (k - 20) as f64; // 40,44,48,52,56,60
        }
        let f = score_facts(&r, &s, 6);
        let (lvl, at) = f.lowest.unwrap();
        assert_eq!(lvl, 60.0, "the window max, not the single lowest row");
        assert_eq!(at, 20);
    }

    #[test]
    fn fewer_than_a_window_of_rows_has_no_lowest() {
        let f = score_facts(&rows(4), &[90.0, 80.0, 70.0, 60.0], 6);
        assert_eq!(f.lowest, None);
        assert_eq!((f.scored, f.below_80), (4, 2));
    }

    #[test]
    fn unscored_rows_and_dataset_gaps_break_the_window() {
        // 3 low, NaN, 3 low  => never 6 in a row.
        let r = rows(7);
        let s = [30.0, 30.0, 30.0, f64::NAN, 30.0, 30.0, 30.0];
        let f = score_facts(&r, &s, 6);
        assert_eq!((f.scored, f.below_80, f.lowest), (6, 6, None));
        // 3 low, then rows 4 apart (removed by the running condition), 3 low.
        let r = [0u32, 1, 2, 7, 8, 9];
        let s = [30.0; 6];
        let f = score_facts(&r, &s, 6);
        assert_eq!((f.below_80, f.lowest), (6, None));
        // Contiguous rows do hold the level.
        let r = [4u32, 5, 6, 7, 8, 9];
        assert_eq!(score_facts(&r, &s, 6).lowest, Some((30.0, 0)));
    }

    #[test]
    fn exactly_80_is_not_below_80() {
        let f = score_facts(&rows(12), &[80.0; 12], 6);
        assert_eq!(f.below_80, 0);
        assert_eq!(f.lowest, Some((80.0, 0)));
        assert_eq!(score_facts(&rows(12), &[79.9; 12], 6).below_80, 12);
    }

    // ---------- plan / issues ----------

    #[test]
    fn plan_parses_ranges_and_numbers_them_from_one() {
        let p = TestPlan::resolve(
            &[
                arg("2024-01-01T00:00", "2024-01-03T00:00"),
                arg("2024-02-01 00:00:00", "2024-02-10 00:00:00"),
                // Open bounds (absent or blank) are fine.
                TestPeriodArg { start: Some("2024-03-01T00:00".into()), end: None },
                TestPeriodArg { start: Some("  ".into()), end: Some("".into()) },
            ],
            None,
            &headers(),
        );
        assert!(p.issues.is_empty(), "{:?}", p.issues);
        assert_eq!(p.tests.iter().map(|t| t.index).collect::<Vec<_>>(), vec![1, 2, 3, 4]);
        assert!(p.tests.iter().all(|t| t.filter.is_some()));
        assert_eq!((p.tests[3].start.clone(), p.tests[3].end.clone()), (None, None), "blank = open bound");
    }

    #[test]
    fn plan_flags_every_kind_of_bad_period_with_a_stable_code() {
        let issues = |a: TestPeriodArg| TestPlan::resolve(&[a], None, &headers()).issues;
        let codes = |a: TestPeriodArg| -> Vec<String> { issues(a).into_iter().map(|i| i.code).collect() };
        let (s, e) = ("2024-02-01T00:00", "2024-02-10T00:00");
        assert_eq!(codes(arg("not a date", e)), vec!["test_start_unparseable"]);
        assert_eq!(codes(arg(s, "31/12/2024")), vec!["test_end_unparseable"]);
        assert_eq!(codes(arg(e, s)), vec!["test_ends_before_start"]);
        assert!(codes(arg(s, s)).is_empty(), "start == end is a (one-instant) period, not an error");
        // The wording says "Scoring period S<n>", never "Test period T<n>".
        for a in [arg("not a date", e), arg(s, "31/12/2024"), arg(e, s)] {
            let i = &issues(a)[0];
            assert!(i.message.starts_with("Scoring period S1"), "{}", i.message);
            assert_eq!(i.severity, Severity::Error);
        }
        // An invalid period is skipped (no filter), the others still resolve;
        // the field names its 1-based position.
        let p = TestPlan::resolve(&[arg("bad", e), arg(s, e), arg(e, s)], None, &headers());
        assert!(p.tests[0].filter.is_none() && p.tests[1].filter.is_some() && p.tests[2].filter.is_none());
        let at: Vec<(&str, &str)> = p.issues.iter().map(|i| (i.code.as_str(), i.field.as_str())).collect();
        assert_eq!(at, vec![("test_start_unparseable", "test_period_1_start"), ("test_ends_before_start", "test_period_3_end")]);
        assert!(p.issues[1].message.starts_with("Scoring period S3"));
    }

    #[test]
    fn the_removed_label_and_event_time_are_accepted_on_the_wire_but_never_read() {
        // What the frontend sent before the redesign, with values that used to be
        // refused (`test_label_invalid`, `event_outside_test_period`,
        // `event_unparseable`) - none of it matters any more.
        let (s, e) = ("2024-02-01T00:00", "2024-02-10T00:00");
        let plain: TestPeriodArg = serde_json::from_value(serde_json::json!({ "start": s, "end": e })).unwrap();
        for legacy in [
            serde_json::json!({ "start": s, "end": e, "label": "normal" }),
            serde_json::json!({ "start": s, "end": e, "label": "problem", "event_time": "2024-02-08T12:00" }),
            serde_json::json!({ "start": s, "end": e, "label": "problem", "eventTime": "2030-01-01T00:00" }),
            serde_json::json!({ "start": s, "end": e, "label": "sideways", "event_time": "nonsense" }),
            serde_json::json!({ "start": s, "end": e, "label": null, "event_time": null, "fromHighlight": "h1" }),
        ] {
            let a: TestPeriodArg = serde_json::from_value(legacy.clone()).expect("old callers must not break");
            assert_eq!(a, plain, "{legacy}");
            let p = TestPlan::resolve(&[a], None, &headers());
            assert!(p.issues.is_empty(), "{legacy}: {:?}", p.issues);
            assert!(p.tests[0].filter.is_some());
        }
        // Absent start / end still default to an open bound.
        let open: TestPeriodArg = serde_json::from_str(r#"{"label":"normal","eventTime":"y"}"#).unwrap();
        assert_eq!(open, TestPeriodArg::default());
    }

    #[test]
    fn train_ranges_echo_the_periods_or_the_legacy_pair() {
        let f = PreviewFilter {
            timestamp_ranges: vec![TimeRangeArg { start: Some("2024-01-01T00:00".into()), end: Some("2024-01-05T00:00".into()) }],
            ..Default::default()
        };
        let p = TestPlan::resolve(&[], Some(&f), &headers());
        assert_eq!(p.train_ranges, vec![TrainRange { start: Some("2024-01-01T00:00".into()), end: Some("2024-01-05T00:00".into()) }]);
        let legacy = PreviewFilter { timestamp_start: Some("2024-01-01T00:00".into()), ..Default::default() };
        let p = TestPlan::resolve(&[], Some(&legacy), &headers());
        assert_eq!(p.train_ranges, vec![TrainRange { start: Some("2024-01-01T00:00".into()), end: None }]);
        assert!(TestPlan::resolve(&[], None, &headers()).train_ranges.is_empty());
    }

    // ---------- shared row selection / unscored ----------

    #[test]
    fn rows_outside_training_are_merged_sorted_unique_and_exclude_train_rows() {
        let per_test = vec![vec![5u32, 6, 7, 8], vec![1, 2, 7, 9], vec![]];
        assert_eq!(rows_outside_training(&per_test, &[2, 6, 8]), vec![1, 5, 7, 9]);
        assert!(rows_outside_training(&[], &[1]).is_empty());
    }

    fn unscored_fixture() -> TestValidation {
        let t = |index: usize, rows: usize| TestResult {
            index,
            start: None,
            end: None,
            days: 0.0,
            rows,
            metrics: KindMetrics { r2: Some(0.9), ..Default::default() },
            train_rows: 0,
            train_days: 0.0,
            scored: rows,
            pct_below_80: Some(1.0),
            lowest: Some(50.0),
            lowest_at: Some("y".into()),
        };
        TestValidation {
            train: TrainBlock { rows: 10, days: 1.0, metrics: KindMetrics::default() },
            train_ranges: vec![],
            tests: vec![t(1, 0), t(2, 5)],
        }
    }

    #[test]
    fn mark_unscored_clears_the_scores_and_takes_rows_from_the_inputs() {
        let mut v = unscored_fixture();
        // 10-minute rows: 144 rows = 1 day.
        mark_unscored(&mut v, Some(&[144, 288]), Some(600.0));
        assert_eq!((v.tests[0].rows, v.tests[0].days), (144, 1.0));
        assert_eq!((v.tests[1].rows, v.tests[1].days), (288, 2.0));
        for t in &v.tests {
            assert_eq!(t.scored, 0);
            assert_eq!(t.metrics, KindMetrics::default());
            assert!(t.pct_below_80.is_none() && t.lowest.is_none() && t.lowest_at.is_none());
        }
        // No counts / a length mismatch: rows and days are left as they were.
        let mut v = unscored_fixture();
        mark_unscored(&mut v, Some(&[1]), Some(600.0));
        assert_eq!(v.tests[1].rows, 5);
        mark_unscored(&mut v, None, None);
        assert_eq!((v.tests[1].rows, v.tests[1].scored), (5, 0));
    }

    // ---------- json ----------

    #[test]
    fn unknown_metrics_are_omitted_not_null() {
        let t = TestResult {
            index: 1,
            start: None,
            end: None,
            days: 0.0,
            rows: 0,
            metrics: KindMetrics { within_3sd_pct: Some(99.5), ..Default::default() },
            train_rows: 0,
            train_days: 0.0,
            scored: 0,
            pct_below_80: None,
            lowest: None,
            lowest_at: None,
        };
        let j = serde_json::to_value(&t).unwrap();
        assert_eq!(j["within_3sd_pct"], 99.5);
        assert!(j.get("r2").is_none() && j.get("inside_3sd_ring_pct").is_none());
        for k in ["pct_below_80", "lowest", "lowest_at", "start", "end"] {
            assert!(j[k].is_null(), "{k} must be present and null");
        }
    }

    #[test]
    fn a_result_is_exactly_the_scoring_facts_no_label_event_or_verdict_keys() {
        let t = TestResult {
            index: 2,
            start: Some("a".into()),
            end: Some("b".into()),
            days: 1.5,
            rows: 10,
            metrics: KindMetrics::default(),
            train_rows: 3,
            train_days: 0.5,
            scored: 9,
            pct_below_80: Some(11.1),
            lowest: Some(42.0),
            lowest_at: Some("c".into()),
        };
        let j = serde_json::to_value(&t).unwrap();
        let mut keys: Vec<&str> = j.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec!["days", "end", "index", "lowest", "lowest_at", "pct_below_80", "rows", "scored", "start", "train_days", "train_rows"]
        );
        // The export block carries the periods unchanged.
        let v = TestValidation {
            train: TrainBlock { rows: 10, days: 1.0, metrics: KindMetrics::default() },
            train_ranges: vec![],
            tests: vec![t],
        };
        let block = export_block(&v, "2026-10-10T00:00:00Z");
        assert_eq!(block["tests"][0], j);
        let text = block.to_string();
        for gone in ["label", "event_time", "lead_days", "first_below_80"] {
            assert!(!text.contains(gone), "{gone} must not be written");
        }
        assert_eq!((block["tested"].clone(), block["validated_at"].clone()), (true.into(), "2026-10-10T00:00:00Z".into()));
    }

    #[test]
    fn inject_validation_adds_one_key_and_keeps_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("INDV_INFO_S.json");
        std::fs::write(&p, r#"{"model_name":"m","model_metrics":{"mean":1.0},"model_update_record":[{"a":1}]}"#).unwrap();
        inject_validation(&p, serde_json::json!({"tested": true})).unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v["validation"]["tested"], true);
        assert_eq!(v["model_name"], "m");
        assert_eq!(v["model_metrics"]["mean"], 1.0);
        assert_eq!(v["model_update_record"][0]["a"], 1);
        assert!(inject_validation(&dir.path().join("missing.json"), serde_json::json!({})).is_err());
    }
}
