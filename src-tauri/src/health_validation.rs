//! Scoring periods ("just score it").
//!
//! A model is fitted ONLY on the training scope (healthy periods). A scoring
//! period (wire name `test_periods`) is nothing but a time range,
//! `start` -> `end`: the train-only model gives a health score for that time and
//! the user reads the chart. Nothing is judged here - there is no Normal /
//! Known-problem label, no event time, no lead time and no detection verdict
//! (see `docs/design/handoff/workbench-redesign/README.md` section 2).
//!
//! This module is the one implementation of that maths. The three previews
//! (`health_preview`) feed it the rows they already scored with the TRAIN-only
//! model and it returns the `test_validation` block of `compute_health_preview`;
//! a legacy `train_relationship_model` run with scoring periods runs the very
//! same preview code (`model_export::relationship_block`) and writes
//! the same block as `validation` into the `*_INFO_*.json` file. Nothing here
//! ever fits or refits anything.
//!
//! Semantics (all three kinds - [`build_hourly`]; since 2026-10-11 the health
//! score is computed on 1-HOUR AVERAGES, see `health_hourly`):
//!   * Scoring rows = rows inside the scoring period that also pass the running
//!     condition's VALUE conditions (and AND/OR mode) of the training scope.
//!     The training TIME periods do not apply to them. A scoring period MAY
//!     overlap the training periods; results use the whole period and
//!     `train_rows` / `train_days` / `train_hours` report the overlap.
//!   * `rows`, `days`, `train_rows`, `train_days` stay RAW facts (dataset rows;
//!     "running time days" = rows x the dataset's median sample interval).
//!   * `hours` = the period's hourly points (clock hours with at least one of
//!     its scoring rows); `train_hours` = those that also hold a training row.
//!     A boundary hour's point averages every in-scope row of that hour (rows
//!     of the training periods and of other scoring periods included).
//!   * `scored` = hours that got a score; `pct_below_80` = share of the SCORED
//!     hours whose score is below 80.
//!   * `lowest` = the lowest hourly score of the period (rounded to a whole
//!     score); `lowest_at` = the START of that hour. The hourly mean already is
//!     "the level held for an hour", so there is no extra sustain window.
//!   * The kind metrics of a period are computed over its hourly points; the
//!     `train` block's metrics stay the model's own RAW training numbers.
//!
//! The Relation model needs one thing more: the engine's prediction for every
//! hourly point (the hour's MEAN predictors go through the fitted model - the
//! raw rows of a scoring period are never predicted one by one). [`RelHours`]
//! is the one implementation of "which hours, which mean inputs, which points
//! to ask the engine for"; the preview, the Train pre-warm, the later
//! `predict_relationship` run and the export all use it. An hour without a
//! prediction has no score (missing, never 0).
//!
//! Naming: the Rust types and the wire keys keep their `test_*` names
//! (`TestPeriodArg`, `test_periods`, `test_validation`, `tests`) so nothing on
//! the wire is renamed; only the user-facing wording says "scoring period" and
//! numbers them `S1`, `S2`, ... by list position.

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::csv_processor::ColumnarData;
use crate::health_hourly::{HourGroups, SCORING_AGGREGATION, SCORING_INTERVAL_SECS};
use crate::health_score::{Issue, RelExtra, RelFit, RelHourPoints, Severity, SCORE_AT_3SD};
use crate::{parse_time_bound, PreviewFilter, ResolvedFilter, TimeRangeArg};

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
fn rows_outside_training(per_test: &[Vec<u32>], train_rows: &[u32]) -> Vec<u32> {
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

// ---------------------------------------------------------------------------
// Relation model: the hourly table
// ---------------------------------------------------------------------------

/// The predictor values of a fit's training rows, in either layout.
#[derive(Clone, Copy)]
pub enum RelX<'a> {
    /// Column-major, `cols[k][i]`: a cached [`RelFit`]'s `x_cols`.
    Cols(&'a [Vec<f64>]),
    /// Row-major, `rows[i][k]`: the matrix a Train / an export sends the engine.
    Rows(&'a [Vec<f64>]),
}

impl RelX<'_> {
    fn at(&self, k: usize, i: usize) -> f64 {
        match self {
            RelX::Cols(c) => c[k][i],
            RelX::Rows(r) => r[i][k],
        }
    }
}

/// The training rows of a Relation model and their values, exactly as the
/// model was fitted on them (a cached fit keeps its own copy, so the hourly
/// means of the training rows never depend on the live dataset columns).
#[derive(Clone, Copy)]
pub struct RelTrain<'a> {
    /// Dataset rows the model was fitted on, ascending.
    pub rows: &'a [u32],
    /// Target value of each training row.
    pub actual: &'a [f64],
    /// Predictor values of each training row.
    pub x: RelX<'a>,
    /// Number of predictors.
    pub n_pred: usize,
}

impl<'a> RelTrain<'a> {
    /// The training rows of a cached fit.
    pub fn of(fit: &'a RelFit) -> Self {
        RelTrain {
            rows: &fit.rows,
            actual: &fit.actual,
            x: RelX::Cols(&fit.x_cols),
            n_pred: fit.predictors.len(),
        }
    }
}

/// Dataset columns of the model's inputs - only read for the rows of a
/// scoring period that are not training rows.
#[derive(Clone, Copy)]
pub struct RelCols<'a> {
    pub target: usize,
    pub predictors: &'a [usize],
}

/// Most scoring periods that may share ONE clock hour for every combination of
/// them to be prepared (see [`RelHours`], "removing a period"). Beyond it only
/// the full hour and its training-only version are prepared.
const MAX_SHARED_PERIODS: usize = 3;

/// The hourly table of a Relation model: what its health score is computed on.
///
/// * **Universe** (unchanged): the training rows, plus the rows of every
///   scoring period that have all inputs and pass the running condition's
///   value conditions. Ascending dataset rows.
/// * **Hourly point**: the universe rows of one clock hour (`health_hourly`):
///   mean target and mean of each predictor. A boundary hour between the
///   training periods and a scoring period averages rows of both.
/// * **Prediction**: the engine's answer for the hour's mean predictors
///   ([`RelHours::points`] is what to ask for, [`RelHours::predicted`] looks the
///   answers up). It is never an average of per-row predictions.
///
/// **Removing a period never needs the engine.** An hour that holds rows of
/// more than one source (training rows and a scoring period, or two scoring
/// periods - typical for periods that share a boundary instant) changes its
/// mean when one of them goes away. [`RelHours::points`] therefore also carries
/// the mean of every such hour for each combination of scoring periods that
/// could remain (training rows always stay). Shortening a period to an edge
/// INSIDE an hour does make a new point (that hour is predicted once).
pub struct RelHours {
    /// The universe: ascending dataset rows.
    pub rows: Vec<u32>,
    /// Is the row a training row?
    pub is_train: Vec<bool>,
    /// Rows of each scoring period with all inputs ([`rel_test_rows`]); empty
    /// without scoring periods.
    pub test_rows: Vec<Vec<u32>>,
    /// The universe grouped by clock hour.
    pub groups: HourGroups,
    /// Hourly mean of the target.
    pub actual: Vec<f64>,
    n_pred: usize,
    /// Hourly mean of each predictor, row-major (`n_pred` per hour).
    x: Vec<f64>,
    /// Extra points for hours shared by several sources: (hour numbers,
    /// row-major mean predictors).
    variants: (Vec<i64>, Vec<f64>),
}

impl RelHours {
    /// Build the table. `scoring` = the scoring periods and the dataset columns
    /// of the inputs (`None` = no scoring periods: the universe is the training
    /// rows and the dataset columns are never read).
    pub fn build(
        data: &ColumnarData,
        train: &RelTrain,
        scoring: Option<(&TestPlan, &RelCols)>,
    ) -> RelHours {
        const NOT_TRAIN: u32 = u32::MAX;
        let n_fit = train.rows.len();
        let p = train.n_pred;
        let test_rows: Vec<Vec<u32>> = scoring
            .map(|(plan, c)| rel_test_rows(plan, data, c.target, c.predictors))
            .unwrap_or_default();
        let outside = rows_outside_training(&test_rows, train.rows);
        // The universe and, per position, the training row it is (`tix`; `None`
        // = the universe IS the training rows).
        let (rows, tix): (Vec<u32>, Option<Vec<u32>>) = if outside.is_empty() {
            (train.rows.to_vec(), None)
        } else {
            let total = n_fit + outside.len();
            let mut rr: Vec<u32> = Vec::with_capacity(total);
            let mut tx: Vec<u32> = Vec::with_capacity(total);
            let (mut i, mut j) = (0usize, 0usize);
            while i < n_fit || j < outside.len() {
                if j >= outside.len() || (i < n_fit && train.rows[i] < outside[j]) {
                    rr.push(train.rows[i]);
                    tx.push(i as u32);
                    i += 1;
                } else {
                    rr.push(outside[j]);
                    tx.push(NOT_TRAIN);
                    j += 1;
                }
            }
            (rr, Some(tx))
        };
        let is_train: Vec<bool> = match &tix {
            None => vec![true; rows.len()],
            Some(t) => t.iter().map(|&x| x != NOT_TRAIN).collect(),
        };
        let cols = scoring.map(|(_, c)| *c);
        // Input `k` (`None` = the target) of universe position `i`: a training
        // row's value comes from the fit, any other row's from the dataset.
        let value = |k: Option<usize>, i: usize| -> f64 {
            let ti = match &tix {
                None => Some(i),
                Some(t) => (t[i] != NOT_TRAIN).then(|| t[i] as usize),
            };
            match (ti, k) {
                (Some(ti), None) => train.actual[ti],
                (Some(ti), Some(k)) => train.x.at(k, ti),
                (None, k) => cols.map_or(f64::NAN, |c| {
                    let col = k.map_or(c.target, |k| c.predictors[k]);
                    data.columns[col][rows[i] as usize]
                }),
            }
        };
        let groups = HourGroups::build(&data.ts_parsed, &rows, |_| true);
        let actual = groups.mean(|i| value(None, i));
        let mut x = vec![0.0f64; groups.len() * p];
        for k in 0..p {
            for (h, m) in groups.mean(|i| value(Some(k), i)).into_iter().enumerate() {
                x[h * p + k] = m;
            }
        }
        let variants = if test_rows.iter().all(Vec::is_empty) {
            (Vec::new(), Vec::new())
        } else {
            shared_hour_variants(&rows, &is_train, &test_rows, &groups, p, &|k, i| value(Some(k), i))
        };
        RelHours {
            rows,
            is_train,
            test_rows,
            groups,
            actual,
            n_pred: p,
            x,
            variants,
        }
    }

    /// The mean predictor values of hour `h`.
    pub fn x_of(&self, h: usize) -> &[f64] {
        &self.x[h * self.n_pred..(h + 1) * self.n_pred]
    }

    /// Every hourly point the engine has to predict for this table: one per
    /// hour (its mean predictors) plus the shared-hour versions described on
    /// the type. THE one implementation - the Train pre-warm, the later
    /// `predict_relationship` run and the export all send exactly this (minus
    /// what is already stored), so they can never disagree with the preview.
    /// An hour whose mean is not finite is left out (it stays unscored).
    pub fn points(&self) -> RelHourPoints {
        let keys = self.groups.hour_keys();
        let mut hours: Vec<i64> = Vec::with_capacity(keys.len() + self.variants.0.len());
        let mut x: Vec<f64> = Vec::with_capacity(self.x.len() + self.variants.1.len());
        for (h, &key) in keys.iter().enumerate() {
            let xs = self.x_of(h);
            if xs.iter().all(|v| v.is_finite()) {
                hours.push(key);
                x.extend_from_slice(xs);
            }
        }
        hours.extend_from_slice(&self.variants.0);
        x.extend_from_slice(&self.variants.1);
        RelHourPoints::from_unsorted(self.n_pred, hours, x)
    }

    /// The engine's prediction of every hour (`NaN` = none stored for that hour
    /// AND exactly its mean predictors - the hour is then unscored).
    pub fn predicted(&self, extra: Option<&RelExtra>) -> Vec<f64> {
        self.groups
            .hour_keys()
            .iter()
            .enumerate()
            .map(|(h, &key)| extra.and_then(|e| e.get(key, self.x_of(h))).unwrap_or(f64::NAN))
            .collect()
    }
}

/// The mean predictors of every hour that holds rows of more than one source
/// (training rows / each scoring period), for each combination of scoring
/// periods that could remain after some are removed - the training rows always
/// stay, the full hour itself is not repeated. Returns (hour numbers, row-major
/// means). The sums run in ascending row order and divide like
/// [`HourGroups::mean`], so a value is bit-identical to what a later table
/// without those periods computes for the hour.
///
/// Only an hour whose rows do NOT all belong to the same sources can change:
/// when every row of the hour is a training row AND a row of period 1 (a
/// scoring period laid over the training range), whatever remains keeps either
/// all of its rows or none, so its mean is the one already in the table. Such
/// hours are skipped up front - the pass is linear in the universe however much
/// the periods overlap the training range, and only the few boundary hours are
/// looked at row by row. `rows` and every list of `test_rows` are ascending.
fn shared_hour_variants(
    rows: &[u32],
    is_train: &[bool],
    test_rows: &[Vec<u32>],
    groups: &HourGroups,
    n_pred: usize,
    x_at: &dyn Fn(usize, usize) -> f64,
) -> (Vec<i64>, Vec<f64>) {
    const TRAIN: u64 = 1;
    // Period `j` -> its source bit (periods beyond the 63rd share the last bit:
    // still correct, only fewer combinations are prepared).
    let bit = |j: usize| 1u64 << (1 + j.min(62));
    // Which sources each universe row belongs to.
    let mut mask: Vec<u64> = is_train.iter().map(|&t| if t { TRAIN } else { 0 }).collect();
    for (j, rs) in test_rows.iter().enumerate() {
        let mut from = 0usize;
        for &r in rs {
            from = first_at_or_after(rows, from, r);
            if rows.get(from) == Some(&r) {
                mask[from] |= bit(j);
            }
        }
    }
    // Per hour: every source it holds, and whether its rows differ in theirs.
    let mut src = vec![0u64; groups.len()];
    let mut seen = vec![false; groups.len()];
    let mut differ = vec![false; groups.len()];
    for (i, &m) in mask.iter().enumerate() {
        if let Some(h) = groups.hour_of(i) {
            if seen[h] && src[h] != m {
                // `src[h]` is still the one mask of every earlier row, or
                // `differ[h]` is already set.
                differ[h] = true;
            }
            seen[h] = true;
            src[h] |= m;
        }
    }
    // (hour, position) of every row of an hour that can change, hour by hour.
    let mut at: Vec<(usize, usize)> = (0..rows.len())
        .filter_map(|i| groups.hour_of(i).filter(|&h| differ[h]).map(|h| (h, i)))
        .collect();
    at.sort_unstable();
    let keys = groups.hour_keys();
    let (mut out_h, mut out_x): (Vec<i64>, Vec<f64>) = (Vec::new(), Vec::new());
    let mut s = 0usize;
    while s < at.len() {
        let h = at[s].0;
        let e = s + at[s..].partition_point(|&(hh, _)| hh == h);
        let pos: Vec<usize> = at[s..e].iter().map(|&(_, i)| i).collect();
        s = e;
        // Which sources each row of the hour belongs to.
        let masks: Vec<u64> = pos.iter().map(|&i| mask[i]).collect();
        let train = src[h] & TRAIN;
        let pbits: Vec<u64> = (1..64).map(|b| 1u64 << b).filter(|b| src[h] & b != 0).collect();
        let combos: Vec<u64> = if pbits.len() <= MAX_SHARED_PERIODS {
            (0..(1u32 << pbits.len()))
                .map(|c| {
                    pbits
                        .iter()
                        .enumerate()
                        .filter(|(k, _)| c & (1 << k) != 0)
                        .fold(train, |m, (_, b)| m | b)
                })
                .collect()
        } else {
            vec![train]
        };
        for keep in combos {
            if keep == 0 || keep == src[h] {
                continue;
            }
            let sel: Vec<usize> = pos
                .iter()
                .zip(&masks)
                .filter(|&(_, &m)| m & keep != 0)
                .map(|(&i, _)| i)
                .collect();
            // No row left, or every row of the hour: nothing new to predict.
            if sel.is_empty() || sel.len() == pos.len() {
                continue;
            }
            let xs: Vec<f64> = (0..n_pred)
                .map(|k| {
                    let mut sum = 0.0f64;
                    for &i in &sel {
                        sum += x_at(k, i);
                    }
                    sum / f64::from(sel.len() as u32)
                })
                .collect();
            if xs.iter().all(|v| v.is_finite()) {
                out_h.push(keys[h]);
                out_x.extend_from_slice(&xs);
            }
        }
    }
    (out_h, out_x)
}

/// First position `>= from` of the ascending `rows` whose row is `>= r`
/// (`rows.len()` when there is none). Looks right next to `from` first and
/// widens the search exponentially, so walking a dense ascending list of rows
/// through `rows` is linear, and a sparse one costs a logarithm of each gap.
fn first_at_or_after(rows: &[u32], from: usize, r: u32) -> usize {
    let mut step = 1usize;
    while from + step < rows.len() && rows[from + step] < r {
        step *= 2;
    }
    let end = (from + step).min(rows.len());
    from + rows[from.min(end)..end].partition_point(|&u| u < r)
}

/// Stable code of the warning added when the Relation model's health score
/// could not be calculated and trying again may help (engine error / timeout).
/// The codes keep their `test_scoring_*` names (nothing on the wire is renamed)
/// although the warning can now also appear WITHOUT scoring periods: the
/// training hours need the engine's prediction too.
pub const TEST_SCORING_FAILED: &str = "test_scoring_failed";
/// Stable code of the warning added when the bundled Relation model engine is
/// too old to predict hourly points: a retry can never help (only an updated
/// install), so the frontend shows no "Try again" for it.
pub const TEST_SCORING_OUTDATED: &str = "test_scoring_outdated";

/// Warning code when the hourly predictions do not fit the model cache's memory
/// budget: retrying the same periods fails the same way, so it gets its own code
/// and the frontend offers no "Try again" -- the user has to shorten the train
/// or the scoring periods (it can fire with NO scoring period: the training
/// hours alone can be over the budget).
pub const TEST_SCORING_TOO_LARGE: &str = "test_scoring_too_large";

/// Why the health score of a Relationship preview could not be calculated
/// (the engine's predictions for its hourly points are missing). Picks the
/// warning's code and user-facing wording; also kept with the cache's
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
/// hourly points failed (never an error: the model fit is still valid). Hours
/// without a prediction have no score. The wording never carries the engine's
/// own text.
pub fn test_scoring_issue(kind: TestScoringFailure) -> Issue {
    let (code, message) = match kind {
        TestScoringFailure::Outdated => (
            TEST_SCORING_OUTDATED,
            "The health score could not be calculated: the Relation model engine in this build is out of \
             date - reinstall or update the app. The model fit is not affected.",
        ),
        TestScoringFailure::OverBudget => (
            TEST_SCORING_TOO_LARGE,
            "The health score could not be calculated: there are too many hours to score in memory - \
             shorten the train or scoring periods. The model fit is not affected.",
        ),
        TestScoringFailure::EngineError => (
            TEST_SCORING_FAILED,
            "The health score could not be calculated because the Relation model engine did not answer. \
             The model fit is not affected - try again, or train the model again.",
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
/// period keeps its identity and its raw facts (index, period, days, rows,
/// hours, the training overlap) but has no score, no metrics and none of the
/// nullable score fields - never a half-filled result that looks like a real
/// one. (The counts need no fixing: the hourly table does not depend on which
/// predictions arrived.)
pub fn mark_unscored(v: &mut TestValidation) {
    for t in v.tests.iter_mut() {
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
    /// RAW training rows the model was fitted on, and their running time.
    pub rows: usize,
    pub days: f64,
    /// Training HOURS: hourly points that hold at least one training row.
    pub hours: usize,
    /// The model's own numbers, from the raw training rows.
    #[serde(flatten)]
    pub metrics: KindMetrics,
}

/// The result of one scoring period. Facts only - no label, no event time, no
/// lead time and no verdict.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TestResult {
    /// 1-based position in the request's `test_periods` (`S1` = 1).
    pub index: usize,
    pub start: Option<String>,
    pub end: Option<String>,
    /// RAW running time: `rows` x the dataset's median sample interval.
    pub days: f64,
    /// RAW dataset rows of the period that have all the model's inputs.
    pub rows: usize,
    /// HOURLY points of the period: clock hours with at least one of its rows.
    pub hours: usize,
    /// The kind's metrics over the period's hourly points.
    #[serde(flatten)]
    pub metrics: KindMetrics,
    /// RAW rows (and running days) of this scoring period that are also train rows.
    pub train_rows: usize,
    pub train_days: f64,
    /// Hourly points of the period that are also training hours.
    pub train_hours: usize,
    /// HOURS that got a score.
    pub scored: usize,
    /// Share (%) of the scored HOURS whose score is below 80. `None` = nothing
    /// was scored.
    pub pct_below_80: Option<f64>,
    /// The lowest hourly score of the period (rounded to a whole score), and
    /// the START of that hour (`2024-01-05T13:00:00`).
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

/// "Running time days" of `rows` dataset rows: rows x the dataset's median
/// sample interval, one decimal (`0.0` when the interval is unknown). THE one
/// definition - the scoring results' `days` and the Running-condition modal's
/// per-period "d running" (`period_counts`) both come from here.
pub(crate) fn days_of(rows: usize, interval_secs: Option<f64>) -> f64 {
    interval_secs.map_or(0.0, |iv| r1(rows as f64 * iv / 86_400.0))
}

// ---------------------------------------------------------------------------
// The scoring results (the health score on 1-hour averages)
// ---------------------------------------------------------------------------

/// One scoring period as the hourly builder needs it.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct PeriodHours {
    /// RAW rows of the period that have all the model's inputs.
    pub rows: usize,
    /// Of which training rows.
    pub train_rows: usize,
    /// The period's hourly points (ascending hour indexes of the kind's
    /// [`HourGroups`]): hours with at least one of its rows.
    pub hours: Vec<usize>,
}

/// The raw counts and the hourly points of every scoring period.
///
/// * `test_rows` - [`TestPlan::collect_rows`] output (ascending dataset rows per
///   period); a row missing from the universe is dropped.
/// * `urows` / `is_train` - the kind's row universe (ascending dataset rows) and
///   each row's training flag.
/// * `groups` - the hourly grouping of that same universe.
pub fn period_hours(
    test_rows: &[Vec<u32>],
    urows: &[u32],
    is_train: &[bool],
    groups: &HourGroups,
) -> Vec<PeriodHours> {
    test_rows
        .iter()
        .map(|rs| {
            let pos: Vec<usize> = rs.iter().filter_map(|r| urows.binary_search(r).ok()).collect();
            PeriodHours {
                rows: pos.len(),
                train_rows: pos.iter().filter(|&&p| is_train[p]).count(),
                hours: groups.members(pos.iter().copied()),
            }
        })
        .collect()
}

/// The hourly points a kind scored (aligned with its [`HourGroups`]).
pub struct HourlyPoints<'a> {
    pub groups: &'a HourGroups,
    /// Does the hour hold at least one training row?
    pub is_train: &'a [bool],
    /// Hourly scores (`NaN` = no score); `None` while the set points are
    /// invalid.
    pub scores: Option<&'a [f64]>,
}

/// The score facts of one scoring period's hourly points.
#[derive(Debug, Clone, PartialEq)]
pub struct HourFacts {
    /// Hours that got a score.
    pub scored: usize,
    /// Scored hours below 80.
    pub below_80: usize,
    /// `(score, hour index)` of the lowest hourly score (the FIRST hour at the
    /// minimum).
    pub lowest: Option<(f64, usize)>,
}

/// One pass over the period's `hours` (indexes into `scores`, `NaN` = no
/// score). No window: each point already is a 1-hour average.
pub fn hour_facts(hours: &[usize], scores: &[f64]) -> HourFacts {
    let mut f = HourFacts {
        scored: 0,
        below_80: 0,
        lowest: None,
    };
    for &h in hours {
        let v = scores[h];
        if v.is_nan() {
            continue;
        }
        f.scored += 1;
        if v < SCORE_AT_3SD {
            f.below_80 += 1;
        }
        if f.lowest.is_none_or(|(l, _)| v < l) {
            f.lowest = Some((v, h));
        }
    }
    f
}

/// Build the whole `test_validation` block from HOURLY points (all three
/// kinds).
///
/// * `periods` - [`period_hours`] output, aligned with `plan.tests`.
/// * `train_rows` / `train_metrics` - the kind's RAW train summary (unchanged
///   by the hourly scoring).
/// * `metrics_for(hours)` - the kind's metrics over a period's hourly points
///   (called only for a period that has one).
pub fn build_hourly(
    plan: &TestPlan,
    periods: &[PeriodHours],
    h: &HourlyPoints,
    interval_secs: Option<f64>,
    train_rows: usize,
    train_metrics: KindMetrics,
    metrics_for: &dyn Fn(&[usize]) -> KindMetrics,
) -> TestValidation {
    let none = PeriodHours::default();
    let tests = plan
        .tests
        .iter()
        .enumerate()
        .map(|(j, t)| {
            let p = periods.get(j).unwrap_or(&none);
            let metrics = if p.hours.is_empty() { KindMetrics::default() } else { metrics_for(&p.hours) };
            let mut res = TestResult {
                index: t.index,
                start: t.start.clone(),
                end: t.end.clone(),
                days: days_of(p.rows, interval_secs),
                rows: p.rows,
                hours: p.hours.len(),
                metrics,
                train_rows: p.train_rows,
                train_days: days_of(p.train_rows, interval_secs),
                train_hours: p.hours.iter().filter(|&&x| h.is_train[x]).count(),
                scored: 0,
                pct_below_80: None,
                lowest: None,
                lowest_at: None,
            };
            if let (Some(sc), false) = (h.scores, p.hours.is_empty()) {
                let f = hour_facts(&p.hours, sc);
                res.scored = f.scored;
                res.pct_below_80 = (f.scored > 0).then(|| r1(f.below_80 as f64 * 100.0 / f.scored as f64));
                if let Some((lvl, at)) = f.lowest {
                    res.lowest = Some(nz(lvl.round()));
                    res.lowest_at = Some(h.groups.label(at));
                }
            }
            res
        })
        .collect();
    TestValidation {
        train: TrainBlock {
            rows: train_rows,
            days: days_of(train_rows, interval_secs),
            hours: h.is_train.iter().filter(|&&t| t).count(),
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
///
/// `scoring_interval_seconds` / `scoring_aggregation` declare how the scores
/// behind `tests[].scored` / `pct_below_80` / `lowest` were sampled: one point
/// per clock hour, the mean of the hour's running rows (`health_hourly`). A
/// file written before 2026-10-11 has neither key and was scored row by row.
/// No older key is removed or renamed.
pub fn export_block(v: &TestValidation, validated_at: &str) -> serde_json::Value {
    serde_json::json!({
        "tested": true,
        "validated_at": validated_at,
        "scoring_interval_seconds": SCORING_INTERVAL_SECS,
        "scoring_aggregation": SCORING_AGGREGATION,
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

    // ---------- test-scoring warnings ----------

    #[test]
    fn test_scoring_issue_codes_and_wording_per_kind() {
        let out = test_scoring_issue(TestScoringFailure::Outdated);
        assert_eq!(out.code, TEST_SCORING_OUTDATED, "own code: a retry cannot help");
        assert!(out.message.contains("out of date") && out.message.contains("reinstall"));
        let big = test_scoring_issue(TestScoringFailure::OverBudget);
        assert_eq!(big.code, TEST_SCORING_TOO_LARGE, "own code: retrying the same periods cannot help");
        assert!(big.message.contains("too many hours to score in memory"), "{}", big.message);
        // True with or without a scoring period: the training hours alone can
        // be over the budget, so it never tells the user to "remove one".
        assert!(big.message.contains("shorten the train or scoring periods"), "{}", big.message);
        assert!(!big.message.contains("remove"), "{}", big.message);
        assert!(!big.message.contains("did not answer"));
        let eng = test_scoring_issue(TestScoringFailure::EngineError);
        assert_eq!(eng.code, TEST_SCORING_FAILED);
        assert!(eng.message.contains("did not answer") && eng.message.contains("try again"));
        for i in [&out, &big, &eng] {
            assert_eq!(i.severity, Severity::Warning);
            assert_eq!(i.field, "test_periods");
            // The whole health score of a Relation model depends on the engine's
            // hourly predictions now - the wording says so, and that the fit is fine.
            assert!(i.message.starts_with("The health score could not be calculated"), "{}", i.message);
            assert!(i.message.contains("The model fit is not affected"), "{}", i.message);
            assert!(!i.message.contains("could not be scored"), "{}", i.message);
            assert!(!i.message.contains("training results above"), "{}", i.message);
            // Never the algorithm, the engine's own text or a developer word.
            for banned in ["LinearGAM", "GAM", "sidecar", "Python", "pygam", "X_extra"] {
                assert!(!i.message.contains(banned), "{banned} in: {}", i.message);
            }
            // "Test periods" are called scoring periods in everything the user reads.
            assert!(!i.message.to_lowercase().contains("test period"), "{}", i.message);
        }
        // The exact sentences (they are shown to the user as they are).
        assert_eq!(
            eng.message,
            "The health score could not be calculated because the Relation model engine did not answer. \
             The model fit is not affected - try again, or train the model again."
        );
        assert_eq!(
            out.message,
            "The health score could not be calculated: the Relation model engine in this build is out of \
             date - reinstall or update the app. The model fit is not affected."
        );
        assert_eq!(
            big.message,
            "The health score could not be calculated: there are too many hours to score in memory - \
             shorten the train or scoring periods. The model fit is not affected."
        );
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
        let t = |index: usize, rows: usize, hours: usize| TestResult {
            index,
            start: None,
            end: None,
            days: rows as f64 / 144.0,
            rows,
            hours,
            metrics: KindMetrics { r2: Some(0.9), ..Default::default() },
            train_rows: 6,
            train_days: 0.1,
            train_hours: 1,
            scored: hours,
            pct_below_80: Some(1.0),
            lowest: Some(50.0),
            lowest_at: Some("y".into()),
        };
        TestValidation {
            train: TrainBlock { rows: 10, days: 1.0, hours: 2, metrics: KindMetrics { rmse: Some(1.0), ..Default::default() } },
            train_ranges: vec![],
            tests: vec![t(1, 0, 0), t(2, 144, 24)],
        }
    }

    #[test]
    fn mark_unscored_clears_the_scores_and_keeps_every_raw_fact() {
        let before = unscored_fixture();
        let mut v = unscored_fixture();
        mark_unscored(&mut v);
        for (t, b) in v.tests.iter().zip(&before.tests) {
            assert_eq!(t.scored, 0);
            assert_eq!(t.metrics, KindMetrics::default());
            assert!(t.pct_below_80.is_none() && t.lowest.is_none() && t.lowest_at.is_none());
            // Identity and the raw facts are what the hourly table found - they
            // never depended on which predictions arrived.
            assert_eq!((t.index, t.rows, t.days, t.hours), (b.index, b.rows, b.days, b.hours));
            assert_eq!((t.train_rows, t.train_days, t.train_hours), (b.train_rows, b.train_days, b.train_hours));
        }
        assert_eq!((v.tests[1].rows, v.tests[1].days, v.tests[1].hours), (144, 1.0, 24));
        assert_eq!(v.train, before.train, "the train block is the model's own numbers: untouched");
    }

    // ---------- the Relation model's hourly table ----------

    /// 20-minute rows from 2024-01-01T00:00 (3 per hour): X = i, Z = 100 - i,
    /// Y = 2X. Headers: timestamp, X, Z, Y.
    fn rel_data(n: usize) -> ColumnarData {
        let x: Vec<f64> = (0..n).map(|i| i as f64).collect();
        let z: Vec<f64> = (0..n).map(|i| 100.0 - i as f64).collect();
        let y: Vec<f64> = x.iter().map(|v| 2.0 * v).collect();
        ColumnarData::from_parts(
            vec!["timestamp".into(), "X".into(), "Z".into(), "Y".into()],
            (0..n).map(|i| Some(ts_text(i))).collect(),
            vec![vec![f64::NAN; n], x, z, y],
        )
    }

    /// The timestamp of row `i` of [`rel_data`].
    fn ts_text(i: usize) -> String {
        format!("2024-01-01T{:02}:{:02}:00", i / 3, (i % 3) * 20)
    }

    /// A fit on the given rows of [`rel_data`] (predictors X, Z; target Y).
    fn rel_fit(d: &ColumnarData, rows: Vec<u32>) -> RelFit {
        let take = |c: usize| -> Vec<f64> { rows.iter().map(|&r| d.columns[c][r as usize]).collect() };
        RelFit {
            target: "Y".into(),
            predictors: vec!["X".into(), "Z".into()],
            lambda: 1.0,
            actual: take(3),
            predicted: take(3),
            x_cols: vec![take(1), take(2)],
            rows,
            r2_per_step: vec![],
            rmse2_per_step: vec![],
        }
    }

    const REL_COLS: RelCols<'static> = RelCols { target: 3, predictors: &[1, 2] };

    /// Scoring periods as inclusive row ranges of [`rel_data`].
    fn rel_plan(d: &ColumnarData, periods: &[(usize, usize)]) -> TestPlan {
        let args: Vec<TestPeriodArg> = periods.iter().map(|&(a, b)| arg(&ts_text(a), &ts_text(b))).collect();
        TestPlan::resolve(&args, None, &d.headers)
    }

    fn rel_hours(d: &ColumnarData, fit: &RelFit, periods: &[(usize, usize)]) -> RelHours {
        if periods.is_empty() {
            return RelHours::build(d, &RelTrain::of(fit), None);
        }
        let plan = rel_plan(d, periods);
        RelHours::build(d, &RelTrain::of(fit), Some((&plan, &REL_COLS)))
    }

    #[test]
    fn rel_hours_without_scoring_periods_are_the_training_rows_per_clock_hour() {
        // Training = rows 0..=13: hours 0..=3 complete, hour 4 holds rows 12, 13.
        let d = rel_data(36);
        let fit = rel_fit(&d, (0..14).collect());
        let h = rel_hours(&d, &fit, &[]);
        assert_eq!(h.rows, (0..14).collect::<Vec<u32>>());
        assert!(h.is_train.iter().all(|&t| t) && h.test_rows.is_empty());
        assert_eq!(h.groups.len(), 5);
        assert_eq!(h.groups.counts(), &[3, 3, 3, 3, 2]);
        // Mean target and mean of EACH predictor of the hour's rows.
        assert_eq!(h.actual, vec![2.0, 8.0, 14.0, 20.0, 25.0]);
        assert_eq!(h.x_of(0), &[1.0, 99.0]);
        assert_eq!(h.x_of(4), &[12.5, 87.5], "a partly covered hour averages the rows it has");
        // One point per hour, nothing else to ask the engine for.
        let p = h.points();
        assert_eq!(p.len(), 5);
        assert_eq!(p.hours(), h.groups.hour_keys());
        assert_eq!(p.x_rows()[4], vec![12.5, 87.5]);
        assert_eq!(p.n_pred(), 2);
    }

    #[test]
    fn rel_hours_take_the_training_values_from_the_fit_in_either_layout() {
        let d = rel_data(36);
        let fit = rel_fit(&d, (0..14).collect());
        let want = rel_hours(&d, &fit, &[]).points();
        // The dataset columns are never read for training rows: a dataset whose
        // columns hold something else gives the very same points.
        let mut other = rel_data(36);
        for c in 1..=3 {
            other.columns[c].iter_mut().for_each(|v| *v = -7.0);
        }
        assert_eq!(rel_hours(&other, &fit, &[]).points(), want);
        // Row-major training values (what a Train / an export holds before the
        // fit exists) give bit-identical points.
        let x_rows: Vec<Vec<f64>> = (0..14).map(|i| vec![fit.x_cols[0][i], fit.x_cols[1][i]]).collect();
        let train = RelTrain { rows: &fit.rows, actual: &fit.actual, x: RelX::Rows(&x_rows), n_pred: 2 };
        let built = RelHours::build(&d, &train, None);
        assert_eq!(built.points(), want);
        assert_eq!(built.actual, rel_hours(&d, &fit, &[]).actual);
    }

    #[test]
    fn rel_hours_add_the_scoring_rows_and_a_boundary_hour_averages_both() {
        // Training = rows 0..=13. S1 = rows 14..=20: the rest of hour 4 (row
        // 14), hour 5 and hour 6.
        let mut d = rel_data(36);
        d.columns[2][17] = f64::NAN; // a period row with a missing input
        let fit = rel_fit(&d, (0..14).collect());
        let h = rel_hours(&d, &fit, &[(14, 20)]);
        let want_rows: Vec<u32> = (0..=20).filter(|&r| r != 17).collect();
        assert_eq!(h.rows, want_rows, "training rows + the period's rows that have all inputs");
        assert_eq!(h.test_rows, vec![vec![14, 15, 16, 18, 19, 20]]);
        assert_eq!(h.is_train.iter().filter(|&&t| t).count(), 14);
        assert_eq!(h.groups.len(), 7);
        assert_eq!(h.groups.any(|i| h.is_train[i]), vec![true, true, true, true, true, false, false]);
        // Hour 4 = two training rows (12, 13) + one period row (14).
        assert_eq!(h.x_of(4), &[13.0, 87.0]);
        assert_eq!(h.actual[4], 26.0);
        // Hour 5 lost row 17: the mean of rows 15, 16.
        assert_eq!(h.x_of(5), &[15.5, 84.5]);
        // The points: one per hour, plus hour 4 as it is WITHOUT the period (so
        // removing the period needs no new prediction).
        let p = h.points();
        assert_eq!(p.len(), 8);
        let k4 = h.groups.hour_keys()[4];
        let hour4: Vec<&[f64]> = (0..p.len()).filter(|&i| p.hours()[i] == k4).map(|i| p.x(i)).collect();
        assert_eq!(hour4, vec![&[12.5, 87.5][..], &[13.0, 87.0][..]]);
    }

    /// Is every point of `needed` among `asked`?
    fn missing_from(needed: &RelHourPoints, asked: &RelHourPoints) -> usize {
        let known = RelExtra::new(asked, &vec![0.0; asked.len()]).unwrap();
        (0..needed.len()).filter(|&i| !known.has(needed.hours()[i], needed.x(i))).count()
    }

    #[test]
    fn removing_scoring_periods_never_needs_a_point_that_was_not_asked_for() {
        // Training = rows 0..=13. S1 = 14..=20, S2 = 20..=27 (they share row 20
        // and hour 6), S3 = 30..=31. Hour 4 is shared by training and S1.
        let d = rel_data(36);
        let fit = rel_fit(&d, (0..14).collect());
        let (s1, s2, s3) = ((14, 20), (20, 27), (30, 31));
        let asked = rel_hours(&d, &fit, &[s1, s2, s3]).points();
        // Whatever subset of the periods remains - including none at all - every
        // hourly point it needs was part of that one request.
        let subsets: [&[(usize, usize)]; 7] = [&[], &[s1], &[s2], &[s3], &[s1, s2], &[s1, s3], &[s2, s3]];
        for keep in subsets {
            let needed = rel_hours(&d, &fit, keep).points();
            assert!(!needed.is_empty());
            assert_eq!(missing_from(&needed, &asked), 0, "periods {keep:?}");
        }
        // The other way round is not free: ADDING a period brings new points...
        let two = rel_hours(&d, &fit, &[s1, s2]).points();
        assert!(missing_from(&asked, &two) > 0);
        // ...and so does an edge moved INSIDE an hour: S1 cut to rows 14..=16
        // leaves hour 5 with rows 15, 16 only - exactly one point nobody asked for.
        let cut = rel_hours(&d, &fit, &[(14, 16), s2, s3]).points();
        assert_eq!(missing_from(&cut, &asked), 1);
        // Shortening to an hour boundary is free again (S1 = 14..=17: hour 5 complete).
        let on_the_hour = rel_hours(&d, &fit, &[(14, 17), s2, s3]).points();
        assert_eq!(missing_from(&on_the_hour, &asked), 0);
    }

    #[test]
    fn first_at_or_after_finds_the_next_row_from_any_start() {
        let rows: Vec<u32> = vec![2, 3, 5, 8, 13, 21, 34, 55];
        for from in 0..=rows.len() {
            for r in 0..60u32 {
                let want = from + rows[from..].partition_point(|&u| u < r);
                assert_eq!(first_at_or_after(&rows, from, r), want, "from {from}, row {r}");
            }
        }
        assert_eq!(first_at_or_after(&[], 0, 7), 0);
    }

    #[test]
    fn a_scoring_period_over_the_training_range_adds_no_point_and_only_its_edge_hours_can_change() {
        // Training = rows 0..=20 (hours 0..=6). S1 = rows 0..=20: every row of
        // every hour is a training row AND a row of S1 - removing S1 changes no
        // mean, so nothing but the 7 hours is asked for.
        let d = rel_data(36);
        let fit = rel_fit(&d, (0..=20).collect());
        let base = rel_hours(&d, &fit, &[]).points();
        let over = rel_hours(&d, &fit, &[(0, 20)]);
        assert_eq!(over.variants.0, Vec::<i64>::new());
        assert_eq!(over.points(), base);
        // Two periods over everything: still nothing.
        assert_eq!(rel_hours(&d, &fit, &[(0, 20), (0, 20)]).points(), base);
        // S1 = rows 4..=22. Its edge hour 1 holds row 3 (training) and rows 4, 5
        // (training + S1): the rows differ in their sources, but dropping S1
        // keeps all three - no new point. Hours 2..=6 are uniform, and hour 7
        // (rows 21, 22: S1 only) exists only with S1.
        let part = rel_hours(&d, &fit, &[(4, 22)]);
        assert_eq!(part.variants.0, Vec::<i64>::new());
        assert_eq!(part.points().len(), 8);
        // S2 = rows 19..=25 beside it. Hour 6 holds row 18 (training + S1) and
        // rows 19, 20 (training + S1 + S2): all training rows, nothing new.
        // Hour 7 holds rows 21, 22 (S1 + S2) and row 23 (S2): dropping S1 keeps
        // all three, dropping S2 leaves rows 21, 22 - exactly ONE new point.
        let two = rel_hours(&d, &fit, &[(4, 22), (19, 25)]);
        let keys = two.groups.hour_keys();
        assert_eq!(two.variants.0, vec![keys[7]]);
        assert_eq!(two.variants.1, vec![21.5, 78.5], "hour 7 with S1 only: rows 21, 22");
        // And that is exactly the hour-7 point of the table without S2.
        assert_eq!(missing_from(&rel_hours(&d, &fit, &[(4, 22)]).points(), &two.points()), 0);
    }

    /// The previous implementation of [`shared_hour_variants`] (every hour with
    /// more than one source is walked row by row, each row's sources found by a
    /// binary search per period) - kept as the oracle of the faster one.
    fn shared_hour_variants_reference(
        rows: &[u32],
        is_train: &[bool],
        test_rows: &[Vec<u32>],
        groups: &HourGroups,
        n_pred: usize,
        x_at: &dyn Fn(usize, usize) -> f64,
    ) -> (Vec<i64>, Vec<f64>) {
        const TRAIN: u64 = 1;
        let bit = |j: usize| 1u64 << (1 + j.min(62));
        let mut src = vec![0u64; groups.len()];
        for (i, &t) in is_train.iter().enumerate() {
            if t {
                if let Some(h) = groups.hour_of(i) {
                    src[h] |= TRAIN;
                }
            }
        }
        for (j, rs) in test_rows.iter().enumerate() {
            for r in rs {
                if let Ok(at) = rows.binary_search(r) {
                    if let Some(h) = groups.hour_of(at) {
                        src[h] |= bit(j);
                    }
                }
            }
        }
        let keys = groups.hour_keys();
        let (mut out_h, mut out_x): (Vec<i64>, Vec<f64>) = (Vec::new(), Vec::new());
        for h in 0..groups.len() {
            if src[h].count_ones() <= 1 {
                continue;
            }
            let pos: Vec<usize> = (0..rows.len()).filter(|&i| groups.hour_of(i) == Some(h)).collect();
            let masks: Vec<u64> = pos
                .iter()
                .map(|&i| {
                    let mut m = if is_train[i] { TRAIN } else { 0 };
                    for (j, rs) in test_rows.iter().enumerate() {
                        if rs.binary_search(&rows[i]).is_ok() {
                            m |= bit(j);
                        }
                    }
                    m
                })
                .collect();
            let train = src[h] & TRAIN;
            let pbits: Vec<u64> = (1..64).map(|b| 1u64 << b).filter(|b| src[h] & b != 0).collect();
            let combos: Vec<u64> = if pbits.len() <= MAX_SHARED_PERIODS {
                (0..(1u32 << pbits.len()))
                    .map(|c| pbits.iter().enumerate().filter(|(k, _)| c & (1 << k) != 0).fold(train, |m, (_, b)| m | b))
                    .collect()
            } else {
                vec![train]
            };
            for keep in combos {
                if keep == 0 || keep == src[h] {
                    continue;
                }
                let sel: Vec<usize> = pos.iter().zip(&masks).filter(|&(_, &m)| m & keep != 0).map(|(&i, _)| i).collect();
                if sel.is_empty() || sel.len() == pos.len() {
                    continue;
                }
                let xs: Vec<f64> = (0..n_pred)
                    .map(|k| sel.iter().fold(0.0f64, |s, &i| s + x_at(k, i)) / f64::from(sel.len() as u32))
                    .collect();
                if xs.iter().all(|v| v.is_finite()) {
                    out_h.push(keys[h]);
                    out_x.extend_from_slice(&xs);
                }
            }
        }
        (out_h, out_x)
    }

    #[test]
    fn shared_hour_variants_match_the_row_by_row_reference_on_many_layouts() {
        // A small deterministic generator (no dependency).
        let mut seed = 0x9E37_79B9_7F4A_7C15u64;
        let mut next = move |m: u64| -> u64 {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed % m
        };
        let mut with_variants = 0;
        for case in 0..400 {
            // 20-minute rows over up to 20 hours; the file is in time order for
            // most cases and shuffled (rows of an hour far apart) for the rest.
            let n = 12 + next(48) as usize;
            let mut ts = ts20(n);
            if case % 4 == 3 {
                for i in (1..n).rev() {
                    ts.swap(i, next(i as u64 + 1) as usize);
                }
            }
            if case % 7 == 0 {
                ts[next(n as u64) as usize] = crate::csv_processor::TS_MISSING;
            }
            // Training rows: one or two runs. Periods: 0..=5 runs anywhere (over
            // the training rows, beside them, over each other, repeated).
            let mut train = vec![false; n];
            for _ in 0..1 + next(2) {
                let a = next(n as u64) as usize;
                let b = (a + next(n as u64) as usize).min(n);
                train[a..b].iter_mut().for_each(|t| *t = true);
            }
            let n_periods = next(6) as usize;
            let mut periods: Vec<Vec<u32>> = Vec::new();
            for _ in 0..n_periods {
                let a = next(n as u64) as usize;
                let b = (a + next(n as u64 / 2 + 1) as usize).min(n);
                // A period row with a missing input is not in the list.
                periods.push((a..b).filter(|r| r % 11 != 5).map(|r| r as u32).collect());
            }
            if case % 5 == 0 && !periods.is_empty() {
                periods.push(periods[0].clone());
            }
            // The universe: training rows + every period row, ascending.
            let in_period = |r: usize| periods.iter().any(|p| p.binary_search(&(r as u32)).is_ok());
            let urows: Vec<u32> = (0..n).filter(|&r| train[r] || in_period(r)).map(|r| r as u32).collect();
            let is_train: Vec<bool> = urows.iter().map(|&r| train[r as usize]).collect();
            let g = HourGroups::build(&ts, &urows, |_| true);
            let x_at = |k: usize, i: usize| (urows[i] as f64) * 1.25 + (k as f64) * 100.0 + ((urows[i] * 7 % 5) as f64) * 0.1;
            let got = shared_hour_variants(&urows, &is_train, &periods, &g, 2, &x_at);
            let want = shared_hour_variants_reference(&urows, &is_train, &periods, &g, 2, &x_at);
            assert_eq!(got, want, "case {case}: {n} rows, train {train:?}, periods {periods:?}");
            with_variants += usize::from(!got.0.is_empty());
        }
        assert!(with_variants > 100, "the layouts exercise real shared hours: {with_variants}");
    }

    #[test]
    fn rel_predictions_are_looked_up_per_hour_at_exactly_its_means() {
        let d = rel_data(36);
        let fit = rel_fit(&d, (0..14).collect());
        // The engine answered for the training-only table: prediction = 2 * mean X.
        let base = rel_hours(&d, &fit, &[]);
        let pts = base.points();
        let preds: Vec<f64> = (0..pts.len()).map(|i| 2.0 * pts.x(i)[0]).collect();
        let extra = RelExtra::new(&pts, &preds).unwrap();
        assert_eq!(base.predicted(Some(&extra)), vec![2.0, 8.0, 14.0, 20.0, 25.0]);
        assert!(base.predicted(None).iter().all(|v| v.is_nan()), "no predictions: every hour unscored");
        // With a scoring period hour 4 has other means and hours 5, 6 are new:
        // none of the three has a prediction yet - the old hour-4 answer is NOT reused.
        let with = rel_hours(&d, &fit, &[(14, 20)]);
        let got = with.predicted(Some(&extra));
        assert_eq!(&got[..4], &[2.0, 8.0, 14.0, 20.0]);
        assert!(got[4].is_nan() && got[5].is_nan() && got[6].is_nan());
    }

    #[test]
    fn rel_hours_ignore_rows_without_a_timestamp_and_do_not_need_time_order() {
        // Rows 3..=5 (hour 1) are moved to the END of the file and row 1 loses
        // its timestamp.
        let n = 12;
        let order: Vec<usize> = vec![0, 1, 2, 6, 7, 8, 9, 10, 11, 3, 4, 5];
        let src = rel_data(n);
        let col = |c: usize| -> Vec<f64> { order.iter().map(|&i| src.columns[c][i]).collect() };
        let ts: Vec<Option<String>> = order.iter().map(|&i| (i != 1).then(|| ts_text(i))).collect();
        let d = ColumnarData::from_parts(
            vec!["timestamp".into(), "X".into(), "Z".into(), "Y".into()],
            ts,
            vec![vec![f64::NAN; n], col(1), col(2), col(3)],
        );
        let fit = rel_fit(&d, (0..n as u32).collect());
        let h = rel_hours(&d, &fit, &[]);
        assert_eq!(h.groups.len(), 4, "hours 0..=3, in time order");
        // Hour 0 = original rows 0 and 2 (row 1 has no hour); hour 1 = rows 3, 4, 5.
        assert_eq!(h.x_of(0), &[1.0, 99.0]);
        assert_eq!(h.groups.counts(), &[2, 3, 3, 3]);
        assert_eq!(h.x_of(1), &[4.0, 96.0]);
        assert_eq!(h.groups.first_rows(), &[0, 9, 3, 6]);
        assert_eq!(h.points().len(), 4);
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
            hours: 0,
            metrics: KindMetrics { within_3sd_pct: Some(99.5), ..Default::default() },
            train_rows: 0,
            train_days: 0.0,
            train_hours: 0,
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
            hours: 4,
            metrics: KindMetrics::default(),
            train_rows: 3,
            train_days: 0.5,
            train_hours: 1,
            scored: 4,
            pct_below_80: Some(25.0),
            lowest: Some(42.0),
            lowest_at: Some("c".into()),
        };
        let j = serde_json::to_value(&t).unwrap();
        let mut keys: Vec<&str> = j.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        // Every key from before the hourly scoring is still there; `hours` and
        // `train_hours` are the only additions.
        assert_eq!(
            keys,
            vec![
                "days", "end", "hours", "index", "lowest", "lowest_at", "pct_below_80", "rows", "scored", "start",
                "train_days", "train_hours", "train_rows",
            ]
        );
        // The export block carries the periods unchanged.
        let v = TestValidation {
            train: TrainBlock { rows: 10, days: 1.0, hours: 2, metrics: KindMetrics::default() },
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
    fn the_export_block_keeps_every_old_key_and_declares_the_hourly_scoring() {
        let v = TestValidation {
            train: TrainBlock {
                rows: 288,
                days: 1.0,
                hours: 24,
                metrics: KindMetrics { mean: Some(1.0), sd: Some(0.5), ..Default::default() },
            },
            train_ranges: vec![TrainRange { start: Some("s".into()), end: None }],
            tests: vec![],
        };
        let block = export_block(&v, "2026-10-11T00:00:00Z");
        let mut keys: Vec<&str> = block.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "scoring_aggregation", "scoring_interval_seconds", "tested", "tests", "train", "train_ranges",
                "validated_at",
            ]
        );
        // The five keys a file written before 2026-10-11 has - none removed or renamed.
        for old in ["tested", "validated_at", "train", "train_ranges", "tests"] {
            assert!(block.get(old).is_some(), "{old}");
        }
        assert_eq!(block["scoring_interval_seconds"], 3600);
        assert_eq!(block["scoring_aggregation"], "mean");
        // The train block: the raw facts keep their keys, `hours` is added.
        let mut train: Vec<&str> = block["train"].as_object().unwrap().keys().map(String::as_str).collect();
        train.sort_unstable();
        assert_eq!(train, vec!["days", "hours", "mean", "rows", "sd"]);
        assert_eq!((block["train"]["rows"].clone(), block["train"]["hours"].clone()), (288.into(), 24.into()));
    }

    // ---------- hourly mode ----------

    #[test]
    fn hour_facts_count_scored_hours_and_take_the_lowest_one() {
        let nan = f64::NAN;
        // Hours 0..6: 100, 79.9, unscored, 55, 80, 55, 90.
        let scores = [100.0, 79.9, nan, 55.0, 80.0, 55.0, 90.0];
        let f = hour_facts(&[0, 1, 2, 3, 4, 5, 6], &scores);
        assert_eq!((f.scored, f.below_80), (6, 3), "exactly 80 is not below 80; an unscored hour is not counted");
        assert_eq!(f.lowest, Some((55.0, 3)), "the FIRST hour at the minimum");
        // A single low hour IS the lowest: the mean of an hour needs no further window.
        assert_eq!(hour_facts(&[4, 3], &scores).lowest, Some((55.0, 3)));
        // Only the period's hours are looked at.
        let part = hour_facts(&[0, 4, 6], &scores);
        assert_eq!((part.scored, part.below_80, part.lowest), (3, 0, Some((80.0, 4))));
        let none = hour_facts(&[2], &scores);
        assert_eq!((none.scored, none.below_80, none.lowest), (0, 0, None));
        assert_eq!(hour_facts(&[], &scores).lowest, None);
    }

    /// 20-minute rows, 2024-01-01 from 00:00: row `i` is at `i * 20` minutes.
    fn ts20(n: usize) -> Vec<i64> {
        let t0 = chrono::NaiveDate::from_ymd_opt(2024, 1, 1).unwrap().and_hms_opt(0, 0, 0).unwrap();
        (0..n as i64).map(|i| t0.and_utc().timestamp_micros() + i * 20 * 60_000_000).collect()
    }

    #[test]
    fn period_hours_keep_the_raw_counts_and_find_the_hours_of_each_period() {
        // Universe = dataset rows 0..12 except row 7 (4 hours of 3 rows; hour 2
        // has rows 6 and 8). Training = rows 0..=4.
        let urows: Vec<u32> = (0..12).filter(|&r| r != 7).collect();
        let is_train: Vec<bool> = urows.iter().map(|&r| r <= 4).collect();
        let g = HourGroups::build(&ts20(12), &urows, |_| true);
        assert_eq!(g.len(), 4);
        // S1 = rows 4..=8 (row 7 is not in the universe), S2 = nothing, S3 = row 11.
        let per = period_hours(&[vec![4, 5, 6, 7, 8], vec![], vec![11]], &urows, &is_train, &g);
        assert_eq!(per[0], PeriodHours { rows: 4, train_rows: 1, hours: vec![1, 2] });
        assert_eq!(per[1], PeriodHours::default());
        assert_eq!(per[2], PeriodHours { rows: 1, train_rows: 0, hours: vec![3] });
    }

    #[test]
    fn build_hourly_reports_raw_rows_beside_hours_and_judges_the_hourly_scores() {
        // 20-minute rows (3 per hour), 6 hours. Training = hours 0..=1 plus row 6
        // (the first row of hour 2). S1 = rows 7..=17 (the rest of hour 2 .. hour 5).
        let n = 18;
        let urows: Vec<u32> = (0..n as u32).collect();
        let is_train: Vec<bool> = (0..n).map(|i| i <= 6).collect();
        let g = HourGroups::build(&ts20(n), &urows, |_| true);
        let h_train = g.any(|i| is_train[i]);
        assert_eq!(h_train, vec![true, true, true, false, false, false]);
        // Hourly scores: 100, 100, 90 (the boundary hour), 70, unscored, 30.
        let scores = [100.0, 100.0, 90.0, 70.0, f64::NAN, 30.4];
        let plan = TestPlan::resolve(
            &[arg("2024-01-01T02:20", "2024-01-01T05:40"), arg("2030-01-01T00:00", "2030-01-02T00:00")],
            None,
            &headers(),
        );
        let periods = period_hours(&[(7..18).collect(), vec![]], &urows, &is_train, &g);
        let seen = std::cell::RefCell::new(Vec::new());
        let v = build_hourly(
            &plan,
            &periods,
            &HourlyPoints { groups: &g, is_train: &h_train, scores: Some(&scores) },
            Some(1200.0),
            7,
            KindMetrics { mean: Some(1.0), ..Default::default() },
            &|hours| {
                seen.borrow_mut().push(hours.to_vec());
                KindMetrics { within_3sd_pct: Some(hours.len() as f64), ..Default::default() }
            },
        );
        // Train block: raw rows and raw running time; hours added.
        assert_eq!((v.train.rows, v.train.days, v.train.hours), (7, 0.1, 3));
        assert_eq!(v.train.metrics.mean, Some(1.0));
        let t = &v.tests[0];
        // Raw facts: 11 rows of 20 min, none of them a training row.
        assert_eq!((t.rows, t.days, t.train_rows, t.train_days), (11, 0.2, 0, 0.0));
        // Hourly facts: hours 2..=5; hour 2 is also a training hour.
        assert_eq!((t.hours, t.train_hours), (4, 1));
        assert_eq!(t.scored, 3, "the unscored hour is not counted");
        assert_eq!(t.pct_below_80, Some(66.7), "2 of the 3 scored hours");
        assert_eq!(t.lowest, Some(30.0), "the lowest hourly score, rounded");
        assert_eq!(t.lowest_at.as_deref(), Some("2024-01-01T05:00:00"), "the start of that hour");
        assert_eq!(t.metrics.within_3sd_pct, Some(4.0), "metrics are computed over the period's hours");
        assert_eq!(*seen.borrow(), vec![vec![2, 3, 4, 5]], "and never for a period without one");
        // A period with no row: every count is 0, no metric, no score fact.
        let e = &v.tests[1];
        assert_eq!((e.index, e.rows, e.hours, e.train_hours, e.scored), (2, 0, 0, 0, 0));
        assert_eq!(e.metrics, KindMetrics::default());
        assert!(e.pct_below_80.is_none() && e.lowest.is_none() && e.lowest_at.is_none());

        // Set points not valid yet: counts and metrics, but no score fact.
        let v0 = build_hourly(
            &plan,
            &periods,
            &HourlyPoints { groups: &g, is_train: &h_train, scores: None },
            Some(1200.0),
            7,
            KindMetrics::default(),
            &|_| KindMetrics::default(),
        );
        let t0 = &v0.tests[0];
        assert_eq!((t0.rows, t0.hours, t0.scored), (11, 4, 0));
        assert!(t0.pct_below_80.is_none() && t0.lowest.is_none() && t0.lowest_at.is_none());
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
