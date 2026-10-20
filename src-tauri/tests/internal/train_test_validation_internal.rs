//! Scoring periods ("just score it") — Rust side, PRIVATE surface.
//!
//! Included from `lib.rs` as a `#[cfg(test)]` child module (one `#[path]` line,
//! like `qa_health_internal`) because the previews, the export and the session
//! cache helpers are private to the crate.
//!
//! A scoring period is only start -> end: there is no Normal / Known-problem
//! label, no event time, no lead time and no detection.
//!
//! Every scenario is a regular synthetic series whose expected numbers follow
//! from how it is built (10-minute rows, 144 rows = 1 day):
//!   * train  = rows 0..=287 (2 days),
//!   * a quiet period with the same pattern,
//!   * a period with a STEP at row 776 (so `pct_below_80`, `lowest` and
//!     `lowest_at` are exact).
//!
//! **All three kinds are scored on 1-HOUR AVERAGES** (since 2026-10-11): 6
//! rows = 1 hour, hour `h` = rows `6h..6h+6`, 144 rows = 24 hours. The step row
//! 776 falls INSIDE hour 129 (rows 774..=779: two normal rows, four stepped
//! ones), so that hour's point is a mix and the plateau proper starts with hour
//! 130 (row 780). The raw facts (`rows`, `days`, `train_rows`, `train_days`)
//! are unchanged; `hours`, `train_hours`, `scored`, `pct_below_80` and `lowest`
//! count / judge hourly points.
//!
//! The Relation model's hourly point is the hour's mean target against the
//! engine's prediction for the hour's MEAN predictors; those predictions are
//! stored with the fit per (hour, mean predictors) - the second half of the
//! Relationship section covers what is asked of the engine and when.

#![allow(clippy::too_many_arguments)]

use crate::csv_processor::ColumnarData;
use crate::health_preview::{
    clustering_preview, individual_preview, rel_extra_from_model, relationship_preview_ex,
    HealthPreview, HealthPreviewRequest, HealthSeries, HealthStats,
};
use crate::health_score::{RelExtra, RelFit, RelHourPoints, SetPointsArg};
use crate::health_validation::{
    RelCols, RelHours, RelTrain, RelX, TestPeriodArg, TestPlan, TestScoringFailure, TestValidation,
};
use crate::{
    apply_rel_extra, health_preview_in, parse_predicted_extra, plan_rel_extra,
    store_rel_fit, session_stamp, AppState, ClusterRange, PreviewFilter,
    PreviewValueFilter, SessionData, TimeRangeArg,
};
use std::collections::HashSet;
use std::path::Path;
use std::sync::RwLock;

const DAY: usize = 144;

fn ts_at(i: usize) -> String {
    let base = chrono::NaiveDate::from_ymd_opt(2024, 1, 1).unwrap().and_hms_opt(0, 0, 0).unwrap();
    (base + chrono::Duration::minutes(10 * i as i64)).format("%Y-%m-%dT%H:%M:%S").to_string()
}

fn ds(cols: Vec<(&str, Vec<f64>)>) -> ColumnarData {
    let n = cols[0].1.len();
    let mut headers = vec!["TimeStamp".to_string()];
    let mut columns = vec![vec![f64::NAN; n]];
    for (name, c) in cols {
        headers.push(name.to_string());
        columns.push(c);
    }
    let timestamps: Vec<Option<String>> = (0..n).map(|i| Some(ts_at(i))).collect();
    ColumnarData::from_parts(headers, timestamps, columns)
}

fn state_with(data: ColumnarData) -> AppState {
    AppState(RwLock::new(Some(SessionData {
        data,
        paths: vec![],
        derived: HashSet::new(),
        generation: 1,
        rel_cache: Default::default(),
    })))
}

/// Inclusive rows `a..=b` as a scoring period (only start -> end).
fn tp(a: usize, b: usize) -> TestPeriodArg {
    TestPeriodArg {
        start: Some(ts_at(a)),
        end: Some(ts_at(b)),
    }
}

/// The training periods: rows `0..=b`.
fn train_to(b: usize, value_filters: Vec<PreviewValueFilter>) -> PreviewFilter {
    PreviewFilter {
        timestamp_ranges: vec![TimeRangeArg { start: Some(ts_at(0)), end: Some(ts_at(b)) }],
        value_filters,
        ..Default::default()
    }
}

fn tv(p: &HealthPreview) -> &TestValidation {
    p.test_validation.as_ref().expect("test_validation")
}

fn approx(a: f64, b: f64, tol: f64, what: &str) {
    assert!((a - b).abs() <= tol, "{what}: expected {b}, got {a}");
}

const STEP_ROW: usize = 776;
/// Rows per hour (10-minute rows) and the hour the step falls into.
const HOUR: usize = 6;
const STEP_HOUR: usize = STEP_ROW / HOUR; // 129: rows 774..=779
/// The first row of the first hour that lies entirely on the plateau.
const PLATEAU_ROW: usize = (STEP_HOUR + 1) * HOUR; // 780

/// The HOURLY series of an Individual preview (the scored points).
fn ind_hourly(p: &HealthPreview) -> &crate::health_preview::IndividualSeries {
    match &p.hourly {
        HealthSeries::Individual(s) => s,
        _ => unreachable!(),
    }
}

/// Mean of `col` over the rows of hour `h` that satisfy `keep`.
fn hour_mean(col: &[f64], h: usize, keep: &dyn Fn(usize) -> bool) -> f64 {
    let v: Vec<f64> = (h * HOUR..(h + 1) * HOUR).filter(|&r| keep(r)).map(|r| col[r]).collect();
    v.iter().sum::<f64>() / v.len() as f64
}

// ===========================================================================
// Individual
// ===========================================================================

/// 10 days of S. Pattern 99..101 everywhere; from `STEP_ROW` for `dip` rows the
/// value is 120 (far above the 3σ edge). G is 1 (running) except `stop`.
fn ind_data(dip: usize, stop: std::ops::Range<usize>) -> ColumnarData {
    let n = 10 * DAY;
    let s: Vec<f64> = (0..n)
        .map(|i| {
            if i >= STEP_ROW && i < STEP_ROW + dip {
                120.0
            } else {
                100.0 + (((i * 7) % 5) as f64 - 2.0) * 0.5
            }
        })
        .collect();
    let g: Vec<f64> = (0..n).map(|i| if stop.contains(&i) { 0.0 } else { 1.0 }).collect();
    ds(vec![("S", s), ("G", g)])
}

fn ind_req(tests: Vec<TestPeriodArg>, sp: Option<SetPointsArg>) -> HealthPreviewRequest {
    HealthPreviewRequest {
        kind: "individual".into(),
        target: Some("S".into()),
        filter: Some(train_to(2 * DAY - 1, vec![])),
        set_points: sp,
        test_periods: if tests.is_empty() { None } else { Some(tests) },
        max_points: Some(100_000),
        ..Default::default()
    }
}

fn ind_sp(d: &ColumnarData) -> SetPointsArg {
    let p0 = individual_preview(d, &ind_req(vec![], None)).unwrap();
    let b3 = match &p0.stats {
        HealthStats::Individual(s) => s.boundary_3sd,
        _ => unreachable!(),
    };
    SetPointsArg { lower: Some(b3[0] - 10.0), upper: Some(130.0), ..Default::default() }
}

fn b3_upper(p: &HealthPreview) -> f64 {
    match &p.stats {
        HealthStats::Individual(s) => s.boundary_3sd[1],
        _ => unreachable!(),
    }
}

#[test]
fn individual_quiet_period_scores_100_throughout() {
    let d = ind_data(400, 0..0);
    let sp = ind_sp(&d);
    let p = individual_preview(&d, &ind_req(vec![tp(288, 575)], Some(sp))).unwrap();
    assert!(p.valid, "{:?}", p.validation);
    let v = tv(&p);
    assert_eq!(v.tests.len(), 1);
    let t = &v.tests[0];
    // Raw facts: 288 rows = 2 days of running time.
    assert_eq!((t.index, t.rows, t.days), (1, 288, 2.0));
    assert_eq!((t.start.clone(), t.end.clone()), (Some(ts_at(288)), Some(ts_at(575))), "the period is echoed");
    assert_eq!((t.train_rows, t.train_days), (0, 0.0));
    // Hourly facts: 48 hourly points, all scored.
    assert_eq!((t.hours, t.train_hours), (48, 0));
    assert_eq!(t.scored, 48, "scored counts HOURS");
    assert_eq!(t.pct_below_80, Some(0.0));
    assert_eq!(t.lowest, Some(100.0), "every hourly average scores 100");
    assert_eq!(t.lowest_at.as_deref(), Some(ts_at(288).as_str()), "the start of the period's first hour");
    assert_eq!(t.metrics.within_3sd_pct, Some(100.0));
    assert!(t.metrics.mean_shift_sd.unwrap().abs() < 0.1);
    assert!(t.metrics.r2.is_none() && t.metrics.inside_3sd_ring_pct.is_none());
    assert!(!serde_json::to_string(t).unwrap().contains("-0.0"), "a rounded zero is never -0.0");
    // The train block is the model's own numbers (raw rows), plus its hours.
    assert_eq!(v.train.rows, 288);
    assert_eq!(v.train.days, 2.0);
    assert_eq!(v.train.hours, 48);
    let st = match &p.stats {
        HealthStats::Individual(s) => s,
        _ => unreachable!(),
    };
    assert_eq!((v.train.metrics.mean, v.train.metrics.sd), (Some(st.mean), Some(st.sd)));
    assert_eq!(v.train.metrics.within_3sd_pct, Some(100.0));
    assert_eq!(v.train_ranges.len(), 1);
    assert_eq!(v.train_ranges[0].start.as_deref(), Some(ts_at(0).as_str()));
}

#[test]
fn individual_period_with_a_step_has_an_exact_share_below_80_and_lowest() {
    let d = ind_data(400, 0..0); // value 120 from row 776 to 1175
    let sp = ind_sp(&d);
    // The period is rows 576..=1151 (4 days) = hours 96..=191.
    let p = individual_preview(&d, &ind_req(vec![tp(576, 1151)], Some(sp))).unwrap();
    let t = &tv(&p).tests[0];
    assert_eq!((t.rows, t.days), (576, 4.0), "raw rows and running time");
    assert_eq!((t.hours, t.scored), (96, 96), "one scored point per hour");
    // Score of a value above the 3 sigma edge: 80 + (v - b3u) / (130 - b3u) * (0 - 80).
    let u = b3_upper(&p);
    let score = |v: f64| 80.0 + (v - u) / (130.0 - u) * -80.0;
    // Hour 129 holds the step (2 normal rows + 4 at 120): its AVERAGE is scored.
    let mixed = hour_mean(&d.columns[1], STEP_HOUR, &|_| true);
    assert_eq!(mixed, 113.25);
    let h = ind_hourly(&p);
    let at = h.rows.iter().position(|&r| r as usize == STEP_HOUR * HOUR).unwrap();
    assert_eq!(h.value[at], mixed);
    approx(h.score.as_ref().unwrap()[at].unwrap(), score(mixed), 1e-9, "the score of the hour's mean");
    assert!(score(120.0) < score(mixed) && score(mixed) < 80.0);
    // Hours 129..=191 are below 80 -> 63 of 96.
    assert_eq!(t.pct_below_80, Some(65.6));
    // The lowest hourly score is the plateau's; its first whole hour starts at row 780.
    assert_eq!(t.lowest, Some(score(120.0).round()));
    assert_eq!(t.lowest_at.as_deref(), Some(ts_at(PLATEAU_ROW).as_str()));
    // Share of HOURS inside the model's 3 sigma: the 33 hours before the step.
    assert_eq!(t.metrics.within_3sd_pct, Some(34.4));
    assert!(t.metrics.mean_shift_sd.unwrap() > 5.0);
}

#[test]
fn a_result_carries_no_label_event_time_lead_or_detection_keys() {
    // The same step period, serialized: only the scoring facts are on the wire.
    let d = ind_data(400, 0..0);
    let p = individual_preview(&d, &ind_req(vec![tp(576, 1151)], Some(ind_sp(&d)))).unwrap();
    let j = serde_json::to_value(tv(&p)).unwrap();
    let mut keys: Vec<&str> = j["tests"][0].as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec![
            "days", "end", "hours", "index", "lowest", "lowest_at", "mean_shift_sd", "pct_below_80", "rows", "scored",
            "start", "train_days", "train_hours", "train_rows", "within_3sd_pct",
        ]
    );
    let mut top: Vec<&str> = j.as_object().unwrap().keys().map(String::as_str).collect();
    top.sort_unstable();
    assert_eq!(top, vec!["tests", "train", "train_ranges"]);
    let mut train: Vec<&str> = j["train"].as_object().unwrap().keys().map(String::as_str).collect();
    train.sort_unstable();
    assert_eq!(train, vec!["days", "hours", "mean", "rows", "sd", "within_3sd_pct"]);
}

#[test]
fn individual_lowest_is_the_lowest_hourly_average_a_dip_weighs_by_how_much_of_the_hour_it_fills() {
    // The old rule ("the level held for 1 h of consecutive rows") is gone: each
    // point already is a 1-hour average, so `lowest` is simply the lowest one.
    // A dip of `dip_rows` rows from row 776 puts 4 rows in hour 129 and the
    // rest in hour 130.
    for dip_rows in [1usize, 4, 5, 6, 7, 10] {
        let d = ind_data(dip_rows, 0..0);
        let p = individual_preview(&d, &ind_req(vec![tp(576, 1151)], Some(ind_sp(&d)))).unwrap();
        let t = &tv(&p).tests[0];
        let u = b3_upper(&p);
        let score = |v: f64| if v <= u { 100.0 } else { 80.0 + (v - u) / (130.0 - u) * -80.0 };
        let s = &d.columns[1];
        let (m129, m130) = (hour_mean(s, STEP_HOUR, &|_| true), hour_mean(s, STEP_HOUR + 1, &|_| true));
        // Both hours are judged by their MEAN; whichever is lower is `lowest`.
        let (lowest, at) = if score(m129) <= score(m130) {
            (score(m129), STEP_HOUR * HOUR)
        } else {
            (score(m130), PLATEAU_ROW)
        };
        assert!(lowest < 100.0, "{dip_rows} rows: {lowest}");
        assert_eq!(t.lowest, Some(lowest.round()), "{dip_rows} rows of 10 min");
        assert_eq!(t.lowest_at.as_deref(), Some(ts_at(at).as_str()), "{dip_rows} rows: the start of that hour");
        // A single 10-minute reading at 120 would score far lower on its own.
        assert!(lowest > score(120.0) || dip_rows == 10, "{dip_rows} rows: the dip is averaged");
        // The share counts HOURS below 80, not rows.
        let below = [m129, m130].iter().filter(|&&m| score(m) < 80.0).count();
        assert_eq!(t.pct_below_80, Some((below as f64 * 1000.0 / 96.0).round() / 10.0), "{dip_rows}");
    }
    // One whole hour at 120 (rows 780..=785) is exactly the plateau score.
    let mut d = ind_data(0, 0..0);
    for r in PLATEAU_ROW..PLATEAU_ROW + HOUR {
        d.columns[1][r] = 120.0;
    }
    let p = individual_preview(&d, &ind_req(vec![tp(576, 1151)], Some(ind_sp(&d)))).unwrap();
    let t = &tv(&p).tests[0];
    let u = b3_upper(&p);
    assert_eq!(t.lowest, Some((80.0 + (120.0 - u) / (130.0 - u) * -80.0).round()));
    assert_eq!(t.lowest_at.as_deref(), Some(ts_at(PLATEAU_ROW).as_str()));
    assert_eq!(t.pct_below_80, Some(1.0), "1 of 96 hours");
}

#[test]
fn individual_overlap_with_train_reports_train_rows_and_days_and_uses_the_whole_period() {
    let d = ind_data(400, 0..0);
    // Rows 144..=431: the last train day (144 rows) + 144 later rows.
    let p = individual_preview(&d, &ind_req(vec![tp(144, 431)], Some(ind_sp(&d)))).unwrap();
    let t = &tv(&p).tests[0];
    assert_eq!((t.rows, t.days), (288, 2.0));
    assert_eq!((t.train_rows, t.train_days), (144, 1.0));
    // 48 hourly points, 24 of them training hours; every one is scored.
    assert_eq!((t.hours, t.train_hours, t.scored), (48, 24, 48));
    // The training statistics are unchanged by the overlap.
    let p0 = individual_preview(&d, &ind_req(vec![], Some(ind_sp(&d)))).unwrap();
    assert_eq!(serde_json::to_value(&p.stats).unwrap(), serde_json::to_value(&p0.stats).unwrap());
}

#[test]
fn individual_empty_test_period_has_no_rows_and_no_metrics() {
    let d = ind_data(400, 0..0);
    // Beyond the end of the data.
    let p = individual_preview(&d, &ind_req(vec![tp(5000, 6000)], Some(ind_sp(&d)))).unwrap();
    let t = &tv(&p).tests[0];
    assert_eq!((t.rows, t.days, t.scored, t.train_rows), (0, 0.0, 0, 0));
    assert_eq!((t.hours, t.train_hours), (0, 0));
    assert!(t.pct_below_80.is_none() && t.lowest.is_none() && t.lowest_at.is_none());
    let j = serde_json::to_value(t).unwrap();
    assert!(j.get("within_3sd_pct").is_none() && j.get("mean_shift_sd").is_none(), "no metric = omitted");
    // Rows removed by the running condition give the same.
    let g_zero = ind_data(400, 288..576);
    let mut r = ind_req(vec![tp(288, 575)], Some(ind_sp(&g_zero)));
    r.filter = Some(train_to(
        2 * DAY - 1,
        vec![PreviewValueFilter { sensor: "G".into(), operation: "greater_than".into(), value1: Some(0.5), value2: None }],
    ));
    let p = individual_preview(&g_zero, &r).unwrap();
    assert_eq!((tv(&p).tests[0].rows, tv(&p).tests[0].hours), (0, 0), "a stopped period has no row and no hourly point");
    // ...and none of those stopped hours is in the scored series.
    assert_eq!(ind_hourly(&p).total_points, 48, "only the 48 training hours");
}

#[test]
fn individual_test_rows_must_pass_the_running_condition_and_stopped_rows_are_never_averaged() {
    // The machine is stopped (G = 0) for rows 800..=809 inside the period, and
    // while stopped the sensor reads 500 (far beyond H = 130, a 0 on its own).
    // Hour 133 = rows 798..=803 keeps its 2 running rows; hour 134 = rows
    // 804..=809 has none.
    let mut d = ind_data(400, 800..810);
    for r in 800..810 {
        d.columns[1][r] = 500.0;
    }
    let mut r = ind_req(vec![tp(576, 1151)], Some(ind_sp(&d)));
    r.filter = Some(train_to(
        2 * DAY - 1,
        vec![PreviewValueFilter { sensor: "G".into(), operation: "greater_than".into(), value1: Some(0.5), value2: None }],
    ));
    let p = individual_preview(&d, &r).unwrap();
    let t = &tv(&p).tests[0];
    assert_eq!(t.rows, 576 - 10, "stopped rows are not scoring rows");
    assert_eq!((t.hours, t.scored), (95, 95), "the fully stopped hour has no point and no score");
    let plateau = |p: &HealthPreview| {
        let u = b3_upper(p);
        (80.0 + (120.0 - u) / (130.0 - u) * -80.0).round()
    };
    // No 500 ever enters a mean: the lowest hourly score is still the plateau's.
    assert_eq!(t.lowest, Some(plateau(&p)));
    assert_eq!(t.lowest_at.as_deref(), Some(ts_at(PLATEAU_ROW).as_str()));
    let h = ind_hourly(&p);
    let at = h.rows.iter().position(|&x| x == 798).expect("the partly-running hour has a point");
    assert_eq!(h.value[at], 120.0, "the mean of its 2 running rows only");
    assert_eq!(h.timestamps[at], ts_at(798));
    assert!(!h.rows.contains(&804), "an hour with no running row has no point");
    assert!(h.score.as_ref().unwrap().iter().all(|s| s.is_some()), "a missing hour is absent, never a 0");

    // A stop inside a SHORT plateau: 776..=785 with row 779 stopped. Hour 129
    // averages its 5 running rows (2 normal + 3 at 120); hour 130 is all 120.
    let d2 = ind_data(10, 779..780);
    let mut r2 = r.clone();
    r2.set_points = Some(ind_sp(&d2));
    let p2 = individual_preview(&d2, &r2).unwrap();
    let t2 = &tv(&p2).tests[0];
    assert_eq!(t2.lowest, Some(plateau(&p2)));
    assert_eq!(t2.lowest_at.as_deref(), Some(ts_at(PLATEAU_ROW).as_str()));
    let h2 = ind_hourly(&p2);
    let at = h2.rows.iter().position(|&x| x as usize == STEP_HOUR * HOUR).unwrap();
    assert_eq!(h2.value[at], hour_mean(&d2.columns[1], STEP_HOUR, &|r| r != 779));
    // One more stopped row (782): hour 130 still has 5 running rows at 120, and
    // they ARE its average - there is no minimum coverage and no 1 h window.
    let mut d3 = ind_data(10, 779..780);
    d3.columns[2][782] = 0.0;
    let mut r3 = r.clone();
    r3.set_points = Some(ind_sp(&d3));
    let p3 = individual_preview(&d3, &r3).unwrap();
    assert_eq!(tv(&p3).tests[0].lowest, Some(plateau(&p3)));
    assert_eq!(tv(&p3).tests[0].lowest_at.as_deref(), Some(ts_at(PLATEAU_ROW).as_str()));
}

#[test]
fn the_and_or_mode_of_the_running_condition_applies_to_test_rows_too() {
    // G = 0 (stopped) on rows 300..310. Conditions: G > 0.5 and S < 99.2 (true for
    // the S = 99.0 rows only, one row in five).
    let d = ind_data(400, 300..310);
    let conds = vec![
        PreviewValueFilter { sensor: "G".into(), operation: "greater_than".into(), value1: Some(0.5), value2: None },
        PreviewValueFilter { sensor: "S".into(), operation: "less_than".into(), value1: Some(99.2), value2: None },
    ];
    let (g, s) = (&d.columns[2], &d.columns[1]);
    let expect = |or: bool| {
        (288..576)
            .filter(|&i| {
                let (a, b) = (g[i] > 0.5, s[i] < 99.2);
                if or { a || b } else { a && b }
            })
            .count()
    };
    for (mode, or) in [("and", false), ("or", true)] {
        let mut r = ind_req(vec![tp(288, 575)], Some(ind_sp(&d)));
        let mut f = train_to(2 * DAY - 1, conds.clone());
        f.combine = Some(mode.into());
        r.filter = Some(f);
        let p = individual_preview(&d, &r).unwrap();
        assert_eq!(tv(&p).tests[0].rows, expect(or), "{mode}");
    }
    assert_ne!(expect(false), expect(true));
}

#[test]
fn individual_without_set_points_still_returns_metrics_but_no_score_facts() {
    let d = ind_data(400, 0..0);
    let p = individual_preview(&d, &ind_req(vec![tp(576, 1151)], None)).unwrap();
    assert!(!p.valid);
    let t = &tv(&p).tests[0];
    assert_eq!((t.rows, t.hours), (576, 96));
    assert!(t.metrics.within_3sd_pct.is_some());
    assert_eq!(t.scored, 0);
    assert!(t.pct_below_80.is_none() && t.lowest.is_none() && t.lowest_at.is_none());
}

#[test]
fn individual_series_scores_test_rows_and_leaves_other_rows_out() {
    let d = ind_data(400, 0..0);
    let sp = ind_sp(&d);
    // Train 0..=287, S1 288..=431, S2 576..=1151; rows 432..=575 are in neither.
    let tests = vec![tp(288, 431), tp(576, 1151)];
    let p = individual_preview(&d, &ind_req(tests.clone(), Some(sp.clone()))).unwrap();
    // RAW series: the rows of the training and scoring periods, never scored.
    let (rows, in_scope) = match &p.series {
        HealthSeries::Individual(s) => {
            assert!(s.score.is_none());
            (&s.rows, &s.in_scope)
        }
        _ => unreachable!(),
    };
    for (i, &r) in rows.iter().enumerate() {
        let r = r as usize;
        assert!(r < 288 || (288..432).contains(&r) || (576..1152).contains(&r), "row {r} is in neither");
        assert!(in_scope[i]);
    }
    assert!(rows.contains(&700) && rows.contains(&300) && rows.contains(&10));
    // HOURLY series: one scored point per hour of those periods (48 + 24 + 96),
    // none for the 24 hours in between.
    let h = ind_hourly(&p);
    assert_eq!(h.total_points, 168);
    let scores = h.score.as_ref().unwrap();
    for (i, &r) in h.rows.iter().enumerate() {
        let r = r as usize;
        assert_eq!(r % HOUR, 0, "a point is labelled by the first row of its hour");
        assert!(r < 288 || (288..432).contains(&r) || (576..1152).contains(&r), "hour of row {r} is in neither");
        assert!(scores[i].is_some() && h.in_scope[i]);
        assert_eq!(h.timestamps[i], ts_at(r));
    }
    assert!(h.rows.contains(&696) && h.rows.contains(&300) && h.rows.contains(&6));
    // With out-of-scope rows requested the gap rows come back in the RAW series
    // (flagged); they still make no hourly point and so have no score.
    let mut r = ind_req(tests, Some(sp));
    r.include_out_of_scope = Some(true);
    let q = individual_preview(&d, &r).unwrap();
    if let HealthSeries::Individual(s) = &q.series {
        let at = s.rows.iter().position(|&x| x == 500).expect("row 500 present");
        assert!(!s.in_scope[at] && s.score.is_none(), "a gap row is flagged, and no raw row has a score");
        let at = s.rows.iter().position(|&x| x == 300).unwrap();
        assert!(s.in_scope[at]);
    }
    assert!(!ind_hourly(&q).rows.contains(&498), "a gap hour has no point, not a 0");
    assert_eq!(serde_json::to_value(ind_hourly(&q)).unwrap(), serde_json::to_value(h).unwrap());
}

#[test]
fn a_scoring_period_edge_inside_an_hour_makes_a_boundary_hour_that_is_both() {
    // Train = rows 0..=290 (ends 30 minutes into hour 48); S1 = rows 294..=431
    // (starts on the 4th row of hour 49). Rows 291..=293 are in neither.
    //   hour 48 = rows 288..=293: 288..=290 train, 291..=293 nothing
    //   hour 49 = rows 294..=299: all S1
    let d = ind_data(0, 0..0);
    let filter = PreviewFilter {
        timestamp_ranges: vec![TimeRangeArg { start: Some(ts_at(0)), end: Some(ts_at(290)) }],
        ..Default::default()
    };
    let sp = {
        let mut r = ind_req(vec![], None);
        r.filter = Some(filter.clone());
        let p0 = individual_preview(&d, &r).unwrap();
        SetPointsArg { lower: Some(b3_upper(&p0) - 20.0), upper: Some(130.0), ..Default::default() }
    };
    let mut r = ind_req(vec![tp(294, 431)], Some(sp.clone()));
    r.filter = Some(filter.clone());
    let p = individual_preview(&d, &r).unwrap();
    assert!(p.valid, "{:?}", p.validation);
    let s = &d.columns[1];
    let h = ind_hourly(&p);
    // Hour 48 averages ONLY its 3 training rows (the 3 rows in neither period are out of scope).
    let at48 = h.rows.iter().position(|&x| x == 288).unwrap();
    assert_eq!(h.value[at48], hour_mean(s, 48, &|r| r <= 290));
    assert_ne!(h.value[at48], hour_mean(s, 48, &|_| true));
    let v = tv(&p);
    let t = &v.tests[0];
    assert_eq!((t.rows, t.train_rows), (138, 0), "raw rows of S1");
    assert_eq!((t.hours, t.train_hours), (23, 0), "hours 49..=71; hour 48 holds no S1 row");
    assert_eq!((v.train.rows, v.train.hours), (291, 49), "hours 0..=48");

    // Now S1 = rows 290..=431: it starts INSIDE hour 48 and overlaps one train row.
    //   hour 48: rows 288, 289 train - row 290 train AND S1 - rows 291..=293 S1.
    let mut r = ind_req(vec![tp(290, 431)], Some(sp));
    r.filter = Some(filter);
    let p = individual_preview(&d, &r).unwrap();
    let h = ind_hourly(&p);
    let at48 = h.rows.iter().position(|&x| x == 288).unwrap();
    // The boundary hour is ONE point: the mean of all its in-scope rows, train
    // and scoring-period rows together.
    assert_eq!(h.value[at48], hour_mean(s, 48, &|_| true));
    assert_eq!(h.rows.iter().filter(|&&x| x == 288).count(), 1);
    let v = tv(&p);
    let t = &v.tests[0];
    assert_eq!((t.rows, t.train_rows), (142, 1), "raw: rows 290..=431, row 290 is also a train row");
    assert_eq!((t.hours, t.train_hours), (24, 1), "hours 48..=71; hour 48 is also a training hour");
    assert_eq!(t.scored, 24);
    assert_eq!(t.lowest_at.as_deref(), Some(ts_at(288).as_str()), "the period's first hourly point is the boundary hour");
    assert_eq!((v.train.rows, v.train.hours), (291, 49));
    // The training summary counts the boundary hour once, as a training hour.
    let sum = p.score_summary.as_ref().unwrap();
    assert_eq!((sum.scored, sum.total_rows, sum.share_basis), (49, 49, "hour_count"));
}

#[test]
fn the_lowest_is_the_minimum_hourly_score_with_its_hour_start() {
    // Three excursions inside S1 (hours 96..=191), each a WHOLE hour:
    // hour 100 at 112, hour 150 at 125 (the lowest), hour 170 at 118.
    let mut d = ind_data(0, 0..0);
    for (hour, v) in [(100usize, 112.0), (150, 125.0), (170, 118.0)] {
        for r in hour * HOUR..(hour + 1) * HOUR {
            d.columns[1][r] = v;
        }
    }
    let p = individual_preview(&d, &ind_req(vec![tp(576, 1151)], Some(ind_sp(&d)))).unwrap();
    let t = &tv(&p).tests[0];
    let u = b3_upper(&p);
    let score = |v: f64| 80.0 + (v - u) / (130.0 - u) * -80.0;
    assert_eq!(t.lowest, Some(score(125.0).round()));
    assert_eq!(t.lowest_at.as_deref(), Some(ts_at(150 * HOUR).as_str()), "the start of the lowest hour");
    assert_eq!(t.lowest_at.as_deref(), Some("2024-01-07T06:00:00"));
    assert_eq!(t.pct_below_80, Some(3.1), "3 of 96 hours");
    // It is the minimum of the hourly scores of the period, nothing else.
    let h = ind_hourly(&p);
    let min = h
        .rows
        .iter()
        .zip(h.score.as_ref().unwrap())
        .filter(|&(&r, _)| (576..1152).contains(&(r as usize)))
        .map(|(_, s)| s.unwrap())
        .fold(f64::INFINITY, f64::min);
    assert_eq!(t.lowest, Some(min.round()));
    // The training summary is untouched by a scoring period's lows.
    let sum = p.score_summary.as_ref().unwrap();
    assert_eq!((sum.scored, sum.pct_below_80), (48, Some(0.0)));
    assert_eq!(sum.min_score.as_ref().unwrap().score, 100.0);
}

#[test]
fn individual_training_stats_summary_and_histogram_are_unchanged_by_test_periods() {
    let d = ind_data(400, 0..0);
    let sp = ind_sp(&d);
    let base = individual_preview(&d, &ind_req(vec![], Some(sp.clone()))).unwrap();
    let with = individual_preview(
        &d,
        &ind_req(vec![tp(288, 575), tp(576, 1151)], Some(sp)),
    )
    .unwrap();
    let j = |p: &HealthPreview| serde_json::to_value(p).unwrap();
    let (a, b) = (j(&base), j(&with));
    assert_eq!(a["stats"], b["stats"]);
    assert_eq!(a["score_summary"], b["score_summary"], "the summary describes the training rows");
    assert_eq!(a["histogram"], b["histogram"]);
    assert_eq!(a["validation"], b["validation"]);
    assert_eq!(a["valid"], b["valid"]);
}

#[test]
fn absent_or_empty_test_periods_change_nothing_and_give_null() {
    let d = ind_data(400, 0..0);
    let sp = ind_sp(&d);
    let a = individual_preview(&d, &ind_req(vec![], Some(sp.clone()))).unwrap();
    let mut r = ind_req(vec![], Some(sp));
    r.test_periods = Some(vec![]);
    let b = individual_preview(&d, &r).unwrap();
    let (ja, jb) = (serde_json::to_value(&a).unwrap(), serde_json::to_value(&b).unwrap());
    assert_eq!(ja, jb);
    assert!(ja["test_validation"].is_null() && ja.as_object().unwrap().contains_key("test_validation"));
    // And the series is exactly the training rows; the hourly one their 48 hours.
    if let HealthSeries::Individual(s) = &a.series {
        assert_eq!(s.total_points, 288);
    }
    assert_eq!(ind_hourly(&a).total_points, 48);
    assert_eq!(ja["scoring_interval_secs"], 3600);
}

#[test]
fn bad_test_periods_become_structured_issues_and_the_period_is_skipped() {
    let d = ind_data(400, 0..0);
    let sp = ind_sp(&d);
    let backwards = tp(1151, 576); // ends before it starts
    let bad_date = TestPeriodArg { start: Some("not a date".into()), end: Some(ts_at(700)) };
    let p = individual_preview(&d, &ind_req(vec![backwards, bad_date, tp(288, 575)], Some(sp))).unwrap();
    let codes: Vec<(&str, &str)> = p.validation.iter().map(|i| (i.code.as_str(), i.field.as_str())).collect();
    assert!(codes.contains(&("test_ends_before_start", "test_period_1_end")), "{codes:?}");
    assert!(codes.contains(&("test_start_unparseable", "test_period_2_start")), "{codes:?}");
    for i in p.validation.iter().filter(|i| i.field.starts_with("test_period_")) {
        assert!(i.message.starts_with("Scoring period S"), "{}", i.message);
    }
    assert!(p.valid, "set-point validity is about the set points");
    let v = tv(&p);
    assert_eq!(v.tests.len(), 3, "every period gets a result, in order");
    assert_eq!((v.tests[0].rows, v.tests[0].scored), (0, 0));
    assert_eq!((v.tests[1].rows, v.tests[1].scored), (0, 0));
    assert_eq!((v.tests[2].index, v.tests[2].rows), (3, 288));
}

#[test]
fn a_legacy_label_or_event_time_on_the_wire_changes_nothing() {
    // A legacy request shape: an event time outside the period and a label —
    // both accepted on the wire and never read.
    let d = ind_data(400, 0..0);
    let make = |periods: serde_json::Value| -> HealthPreviewRequest {
        serde_json::from_value(serde_json::json!({
            "kind": "individual",
            "target": "S",
            "filter": { "timestamp_ranges": [{ "start": ts_at(0), "end": ts_at(2 * DAY - 1) }] },
            "set_points": { "lower": 80.0, "upper": 130.0 },
            "test_periods": periods,
            "max_points": 100000,
        }))
        .expect("old callers must not break")
    };
    let (a, b) = (ts_at(576), ts_at(1151));
    let plain = individual_preview(&d, &make(serde_json::json!([{ "start": a, "end": b }]))).unwrap();
    assert!(plain.valid, "{:?}", plain.validation);
    assert_eq!((tv(&plain).tests[0].rows, tv(&plain).tests[0].pct_below_80), (576, Some(65.6)));
    for legacy in [
        serde_json::json!([{ "start": a, "end": b, "label": "normal" }]),
        serde_json::json!([{ "start": a, "end": b, "label": "problem", "event_time": ts_at(1500) }]),
        serde_json::json!([{ "start": a, "end": b, "label": "problem", "eventTime": "nonsense" }]),
        serde_json::json!([{ "start": a, "end": b, "label": "sideways", "event_time": null }]),
    ] {
        let p = individual_preview(&d, &make(legacy.clone())).unwrap();
        assert_eq!(serde_json::to_value(&p).unwrap(), serde_json::to_value(&plain).unwrap(), "{legacy}");
    }
}

// ===========================================================================
// Relationship
// ===========================================================================

const N_REL: usize = 10 * DAY;

fn rel_noise(i: usize) -> f64 {
    if i % 2 == 0 {
        1.0
    } else {
        -1.0
    }
}

/// Y = 2X + noise (+10 from the step row on, inside the second scoring period).
/// The row noise is +1 / -1 in turn, so over a clock hour (6 rows) it cancels:
/// an hourly point lies ON the model unless the hour holds stepped rows.
fn rel_data() -> ColumnarData {
    let x: Vec<f64> = (0..N_REL).map(|i| i as f64 * 0.01).collect();
    let y: Vec<f64> = (0..N_REL)
        .map(|i| 2.0 * x[i] + rel_noise(i) + if i >= STEP_ROW { 10.0 } else { 0.0 })
        .collect();
    ds(vec![("X", x), ("Y", y)])
}

/// The model (Y = 2X) fitted on rows `0..n`, with its per-row predictions.
fn rel_fit_n(d: &ColumnarData, n: usize) -> RelFit {
    let rows: Vec<u32> = (0..n as u32).collect();
    let xc = &d.columns[1];
    let yc = &d.columns[2];
    RelFit {
        target: "Y".into(),
        predictors: vec!["X".into()],
        lambda: 1.0,
        actual: rows.iter().map(|&r| yc[r as usize]).collect(),
        predicted: rows.iter().map(|&r| 2.0 * xc[r as usize]).collect(),
        x_cols: vec![rows.iter().map(|&r| xc[r as usize]).collect()],
        rows,
        r2_per_step: vec![0.9],
        rmse2_per_step: vec![2.0],
    }
}

/// The model fitted on the two training days (rows 0..288 = hours 0..48).
fn rel_fit(d: &ColumnarData) -> RelFit {
    rel_fit_n(d, 2 * DAY)
}

/// What the engine answers for an hourly point: the model at the hour's MEAN X.
fn two_x(x: &[f64]) -> f64 {
    2.0 * x[0]
}

/// The engine's answers for `points`, in their order.
fn answers(points: &RelHourPoints) -> Vec<f64> {
    (0..points.len()).map(|i| two_x(points.x(i))).collect()
}

/// The stored predictions a successful engine run leaves for `req`.
fn rel_extra(d: &ColumnarData, fit: &RelFit, req: &HealthPreviewRequest) -> RelExtra {
    rel_extra_from_model(d, fit, req, &two_x)
}

fn rel_sp() -> SetPointsArg {
    SetPointsArg {
        residual_at_80_lower: Some(-5.0),
        residual_at_80_upper: Some(5.0),
        residual_at_0_lower: Some(-15.0),
        residual_at_0_upper: Some(15.0),
        ..Default::default()
    }
}

fn rel_req(tests: Vec<TestPeriodArg>) -> HealthPreviewRequest {
    HealthPreviewRequest {
        kind: "relationship".into(),
        target: Some("Y".into()),
        predictors: vec!["X".into()],
        cache_key: Some("m1::fp".into()),
        filter: Some(train_to(2 * DAY - 1, vec![])),
        set_points: Some(rel_sp()),
        test_periods: if tests.is_empty() { None } else { Some(tests) },
        max_points: Some(100_000),
        ..Default::default()
    }
}

/// The preview of `tests` with every hourly prediction in place.
fn rel_preview(d: &ColumnarData, fit: &RelFit, tests: Vec<TestPeriodArg>) -> HealthPreview {
    let req = rel_req(tests);
    relationship_preview_ex(d, fit, Some(&rel_extra(d, fit, &req)), &req).unwrap()
}

/// The HOURLY series of a Relationship preview (the scored points).
fn rel_hourly(p: &HealthPreview) -> &crate::health_preview::RelationshipSeries {
    match &p.hourly {
        HealthSeries::Relationship(s) => s,
        _ => unreachable!(),
    }
}

fn ref_stats(ys: &[f64], rs: &[f64]) -> (f64, f64, f64, f64) {
    let n = ys.len() as f64;
    let my = ys.iter().sum::<f64>() / n;
    let sst: f64 = ys.iter().map(|y| (y - my).powi(2)).sum();
    let ssr: f64 = rs.iter().map(|r| r * r).sum();
    let mr = rs.iter().sum::<f64>() / n;
    let sd = (rs.iter().map(|r| (r - mr).powi(2)).sum::<f64>() / (n - 1.0)).sqrt();
    (1.0 - ssr / sst, (ssr / n).sqrt(), mr, sd)
}

/// Independent reference over RAW rows: R2 / RMSE / residual mean / sd of (y, 2x).
fn rel_ref(d: &ColumnarData, rows: impl Iterator<Item = usize>) -> (f64, f64, f64, f64) {
    let (mut ys, mut rs) = (vec![], vec![]);
    for r in rows {
        let y = d.columns[2][r];
        ys.push(y);
        rs.push(y - 2.0 * d.columns[1][r]);
    }
    ref_stats(&ys, &rs)
}

/// Independent reference over HOURLY points: the same four numbers of
/// (hourly mean y, 2 x hourly mean x) over the given hours.
fn rel_ref_hours(d: &ColumnarData, hours: impl Iterator<Item = usize>) -> (f64, f64, f64, f64) {
    let (mut ys, mut rs) = (vec![], vec![]);
    for h in hours {
        let y = hour_mean(&d.columns[2], h, &|_| true);
        ys.push(y);
        rs.push(y - 2.0 * hour_mean(&d.columns[1], h, &|_| true));
    }
    ref_stats(&ys, &rs)
}

#[test]
fn relationship_quiet_period_metrics_and_a_score_of_100_throughout() {
    let d = rel_data();
    let fit = rel_fit(&d);
    let p = rel_preview(&d, &fit, vec![tp(288, 575)]);
    assert!(p.valid, "{:?}", p.validation);
    let t = &tv(&p).tests[0];
    // Raw facts: 288 rows = 2 days. Hourly facts: 48 hours, every one scored.
    assert_eq!((t.rows, t.days, t.train_rows), (288, 2.0, 0));
    assert_eq!((t.hours, t.train_hours, t.scored), (48, 0, 48));
    assert_eq!(t.pct_below_80, Some(0.0));
    assert_eq!(t.lowest, Some(100.0));
    assert_eq!(t.lowest_at.as_deref(), Some(ts_at(288).as_str()), "the start of the period's first hour");
    // The period's metrics are over its HOURLY points, which lie on the model
    // (the +-1 row noise cancels within an hour).
    let (r2, rmse, mean, sd) = rel_ref_hours(&d, 48..96);
    approx(t.metrics.r2.unwrap(), r2, 0.0006, "r2");
    approx(t.metrics.r2.unwrap(), 1.0, 0.0006, "points on the model");
    approx(t.metrics.rmse.unwrap(), rmse, 1e-9, "rmse");
    approx(t.metrics.residual_mean.unwrap(), mean, 1e-9, "residual mean");
    approx(t.metrics.residual_sd.unwrap(), sd, 1e-9, "residual_sd");
    approx(rmse, 0.0, 1e-9, "reference rmse");
    approx(mean, 0.0, 1e-9, "reference mean");
    // The train block equals the model's own (INFO) numbers: RAW rows, where the
    // row noise is fully visible (RMSE 1).
    let v = tv(&p);
    let st = match &p.stats {
        HealthStats::Relationship(s) => s,
        _ => unreachable!(),
    };
    assert_eq!(v.train.rows, st.rows);
    assert_eq!((v.train.metrics.rmse, v.train.days, v.train.hours), (Some(st.rmse), 2.0, 48));
    assert_eq!(v.train.metrics.rmse, Some(1.0), "the raw rows' figure, not an hourly one");
    let (tr2, ..) = rel_ref(&d, 0..288);
    approx(v.train.metrics.r2.unwrap(), tr2, 0.0006, "train r2");
}

#[test]
fn relationship_drift_period_has_exact_share_below_80_lowest_and_residual_shift() {
    let d = rel_data();
    let fit = rel_fit(&d);
    let p = rel_preview(&d, &fit, vec![tp(576, 1151)]);
    let t = &tv(&p).tests[0];
    assert_eq!((t.rows, t.hours, t.scored), (576, 96, 96));
    // Hours 96..=128 lie on the model (100). Hour 129 holds 4 stepped rows of 6:
    // residual 10 * 4/6 = 6.667 -> 66.7. Hours 130..=191: residual 10 -> 40.
    assert_eq!(t.pct_below_80, Some(65.6), "63 of the 96 hours");
    assert_eq!(t.lowest, Some(40.0), "the lowest hourly score");
    assert_eq!(t.lowest_at.as_deref(), Some(ts_at(PLATEAU_ROW).as_str()), "the start of that hour");
    let h = rel_hourly(&p);
    assert_eq!(h.total_points, 48 + 96, "the training hours and the period's hours");
    let at = |row: usize| h.rows.iter().position(|&r| r as usize == row).unwrap();
    let sc = h.score.as_ref().unwrap();
    let mixed = at(STEP_HOUR * HOUR);
    approx(h.residual[mixed].unwrap(), 10.0 * 4.0 / 6.0, 0.001, "the mixed hour's residual");
    approx(sc[mixed].unwrap(), 80.0 - (10.0 * 4.0 / 6.0 - 5.0) * 8.0, 0.01, "the mixed hour's score");
    assert_eq!((h.residual[at(PLATEAU_ROW)], sc[at(PLATEAU_ROW)]), (Some(10.0), Some(40.0)));
    assert_eq!(sc[at((STEP_HOUR - 1) * HOUR)], Some(100.0));
    // actual = the hour's mean target, predicted = the model at the hour's mean X.
    approx(h.actual[mixed], hour_mean(&d.columns[2], STEP_HOUR, &|_| true), 1e-9, "mean actual");
    approx(h.predicted[mixed].unwrap(), 2.0 * hour_mean(&d.columns[1], STEP_HOUR, &|_| true), 1e-9, "prediction");
    assert_eq!(h.timestamps[mixed], ts_at(STEP_HOUR * HOUR));
    let (_, rmse, mean, sd) = rel_ref_hours(&d, 96..192);
    approx(t.metrics.residual_mean.unwrap(), mean, 0.0006, "residual shift");
    approx(t.metrics.rmse.unwrap(), rmse, 0.0006, "rmse");
    approx(t.metrics.residual_sd.unwrap(), sd, 0.0006, "sd");
    assert!(t.metrics.rmse.unwrap() > 5.0, "many times the train RMSE of 1");
    // Only the scoring facts and the Relation-model metrics are on the wire.
    let j = serde_json::to_value(t).unwrap();
    let mut keys: Vec<&str> = j.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec![
            "days", "end", "hours", "index", "lowest", "lowest_at", "pct_below_80", "r2", "residual_mean",
            "residual_sd", "rmse", "rows", "scored", "start", "train_days", "train_hours", "train_rows",
        ]
    );
}

#[test]
fn relationship_lowest_is_the_lowest_hourly_average_a_burst_weighs_by_how_much_of_the_hour_it_fills() {
    // A residual burst of +10 for `dip` rows from the step row (the 3rd row of
    // hour 129). There is no "held for 1 h" window any more: the hourly mean IS
    // the level of that hour.
    //   2 rows  -> hour 129: 10 * 2/6 = 3.33 -> 91.1 (not below 80)
    //   4 rows  -> hour 129: 10 * 4/6 = 6.67 -> 66.7
    //   10 rows -> hour 129: 6.67 -> 66.7, hour 130 (all 6 rows): 10 -> 40
    for (dip, lowest, low_hours, at_row) in [(2usize, 91.0, 0usize, STEP_HOUR * HOUR), (4, 67.0, 1, STEP_HOUR * HOUR), (10, 40.0, 2, PLATEAU_ROW)] {
        let mut d = rel_data();
        for i in STEP_ROW..N_REL {
            let burst = i < STEP_ROW + dip;
            d.columns[2][i] = 2.0 * d.columns[1][i] + rel_noise(i) + if burst { 10.0 } else { 0.0 };
        }
        let fit = rel_fit(&d);
        let p = rel_preview(&d, &fit, vec![tp(576, 1151)]);
        let t = &tv(&p).tests[0];
        assert_eq!(t.lowest, Some(lowest), "{dip} rows");
        assert_eq!(t.lowest_at.as_deref(), Some(ts_at(at_row).as_str()), "{dip} rows");
        assert_eq!(t.pct_below_80, Some((low_hours as f64 * 1000.0 / 96.0).round() / 10.0), "{dip} rows");
        assert_eq!(t.scored, 96);
    }
}

#[test]
fn relationship_overlap_and_hours_without_a_prediction() {
    let d = rel_data();
    let fit = rel_fit(&d);
    // 144..=431 overlaps the last train day (144 rows = 24 hours).
    let req = rel_req(vec![tp(144, 431)]);
    let p = relationship_preview_ex(&d, &fit, Some(&rel_extra(&d, &fit, &req)), &req).unwrap();
    let t = &tv(&p).tests[0];
    assert_eq!((t.rows, t.days, t.train_rows, t.train_days), (288, 2.0, 144, 1.0));
    assert_eq!((t.hours, t.train_hours, t.scored), (48, 24, 48));
    // Only the TRAINING hours have a prediction (the engine answered for the
    // model without scoring periods): the period's other 24 hours are unscored -
    // while every count stays what the data says.
    let train_only = rel_extra(&d, &fit, &rel_req(vec![]));
    let p = relationship_preview_ex(&d, &fit, Some(&train_only), &req).unwrap();
    let t = &tv(&p).tests[0];
    assert_eq!((t.rows, t.train_rows, t.hours, t.train_hours), (288, 144, 48, 24));
    assert_eq!(t.scored, 24, "an hour without a prediction has no score");
    let h = rel_hourly(&p);
    assert_eq!(h.total_points, 72);
    let sc = h.score.as_ref().unwrap();
    for (k, &row) in h.rows.iter().enumerate() {
        let predicted = (row as usize) < 2 * DAY;
        assert_eq!(sc[k].is_some(), predicted, "hour of row {row}");
        assert_eq!(h.predicted[k].is_some(), predicted);
        assert_eq!(h.residual[k].is_some(), predicted);
        assert!(h.actual[k].is_finite(), "the hour's mean target is there either way");
    }
    // Without any prediction at all: nothing scored, no metrics, the counts intact.
    let p = relationship_preview_ex(&d, &fit, None, &req).unwrap();
    assert!(p.valid);
    let t = &tv(&p).tests[0];
    assert_eq!((t.rows, t.days, t.train_rows, t.hours, t.train_hours), (288, 2.0, 144, 48, 24));
    assert_eq!((t.scored, t.pct_below_80, t.lowest, t.lowest_at.clone()), (0, None, None, None));
    assert!(serde_json::to_value(t).unwrap().get("r2").is_none());
    assert_eq!(p.score_summary.as_ref().unwrap().scored, 0);
    // A period with no row at all.
    let empty = rel_req(vec![tp(5000, 6000)]);
    let p = relationship_preview_ex(&d, &fit, Some(&rel_extra(&d, &fit, &empty)), &empty).unwrap();
    let t = &tv(&p).tests[0];
    assert_eq!((t.rows, t.hours, t.scored, t.pct_below_80), (0, 0, 0, None));
    assert!(serde_json::to_value(t).unwrap().get("r2").is_none());
}

#[test]
fn relationship_fit_summary_scatter_stats_and_raw_series_stay_training_only() {
    let d = rel_data();
    let fit = rel_fit(&d);
    let base = rel_preview(&d, &fit, vec![]);
    let with = rel_preview(&d, &fit, vec![tp(288, 575), tp(576, 1151)]);
    let (a, b) = (serde_json::to_value(&base).unwrap(), serde_json::to_value(&with).unwrap());
    assert_eq!(a["stats"], b["stats"]);
    assert_eq!(a["score_summary"], b["score_summary"]);
    assert_eq!(a["fit_scatter"], b["fit_scatter"], "the Fit scatter shows the training rows");
    // The raw series is the fit's training rows - with or without scoring
    // periods (a scoring period has no per-row prediction) - and never scored.
    assert_eq!(a["series"], b["series"]);
    if let (HealthSeries::Relationship(s0), HealthSeries::Relationship(s1)) = (&base.series, &with.series) {
        assert_eq!((s0.total_points, s1.total_points), (288, 288));
        assert!(s1.rows.windows(2).all(|w| w[0] < w[1]));
        assert!(s1.rows.iter().all(|&r| (r as usize) < 2 * DAY));
        assert!(s0.score.is_none() && s1.score.is_none());
        assert!(s1.predicted.iter().all(Option::is_some), "the fit's own per-row predictions");
    } else {
        unreachable!()
    }
    // The summary describes the 48 training hours.
    assert_eq!(a["score_summary"]["scored"], 48);
    assert_eq!(a["score_summary"]["total_rows"], 48);
    assert_eq!(a["score_summary"]["share_basis"], "hour_count");
    // The scoring periods are in the HOURLY series only: 48 + 48 + 96 hours.
    let (h0, h1) = (rel_hourly(&base), rel_hourly(&with));
    assert_eq!((h0.total_points, h1.total_points), (48, 48 + 48 + 96));
    let at = h1.rows.iter().position(|&r| r == 798).unwrap();
    assert_eq!(h1.score.as_ref().unwrap()[at], Some(40.0), "an hour of the second period (rows 798..=803) is scored");
    assert!(h1.rows.windows(2).all(|w| w[0] < w[1]));
    assert!(a["test_validation"].is_null());
    assert_eq!((a["scoring_interval_secs"].clone(), b["scoring_interval_secs"].clone()), (3600.into(), 3600.into()));
}

// ---------- the hourly predictions of compute_health_preview ----------

fn rel_state() -> (AppState, ColumnarData) {
    let d = rel_data();
    let state = state_with(rel_data());
    let stamp = session_stamp(&state).unwrap().unwrap();
    assert!(store_rel_fit(&state, stamp, "m1::fp".into(), rel_fit(&d)));
    (state, d)
}

/// Clock-hour number of dataset row `row` (what a stored prediction is keyed by).
fn hour_no(d: &ColumnarData, row: usize) -> i64 {
    d.ts_parsed[row].div_euclid(crate::chart_query::HOUR_US)
}

/// The hours of `points`, counted from the dataset's first hour (hour `h` =
/// rows `6h..6h+6`).
fn rel_hours_of(d: &ColumnarData, points: &RelHourPoints) -> Vec<i64> {
    points.hours().iter().map(|h| h - hour_no(d, 0)).collect()
}

/// Plan the prediction run of `req` and store the engine's answers for it.
fn fill(state: &AppState, req: &HealthPreviewRequest) {
    let job = plan_rel_extra(state, req).unwrap().expect("something to predict");
    assert_eq!(apply_rel_extra(state, &job, &answers(&job.points)), Ok(crate::ExtraStored::Stored));
}

fn planned(state: &AppState, tests: Vec<TestPeriodArg>) -> Option<crate::RelExtraJob> {
    plan_rel_extra(state, &rel_req(tests)).unwrap()
}

#[test]
fn only_hours_without_a_stored_prediction_are_planned_and_edits_never_run_again() {
    let (state, d) = rel_state();
    let req = rel_req(vec![tp(288, 431)]);
    let job = plan_rel_extra(&state, &req).unwrap().expect("the hourly points need a prediction run");
    // The 48 training hours and the 24 hours of the period, each at its mean X.
    assert_eq!(rel_hours_of(&d, &job.points), (0..72).collect::<Vec<i64>>());
    assert_eq!(job.x.len(), 288, "the model is refitted on the RAW TRAIN rows only");
    assert_eq!(job.y.len(), 288);
    assert_eq!(job.x_extra.len(), 72, "one X_extra row per hourly point - never one per raw row");
    approx(job.x_extra[0][0], hour_mean(&d.columns[1], 0, &|_| true), 1e-12, "mean X of hour 0");
    approx(job.x_extra[48][0], hour_mean(&d.columns[1], 48, &|_| true), 1e-12, "mean X of hour 48");
    // Before the predictions arrive the preview still answers: counts, no score.
    let p = health_preview_in(&state, &req).unwrap();
    let t = &tv(&p).tests[0];
    assert_eq!((t.rows, t.hours, t.scored), (144, 24, 0));
    assert!(rel_hourly(&p).score.as_ref().unwrap().iter().all(Option::is_none), "null, never 0");
    // The engine's answer is stored under the fit's key...
    apply_rel_extra(&state, &job, &answers(&job.points)).unwrap();
    // ...and nothing more is planned for the same periods, whatever the set points.
    assert!(plan_rel_extra(&state, &req).unwrap().is_none());
    let mut edited = req.clone();
    edited.set_points = Some(SetPointsArg { residual_at_80_lower: Some(-6.0), ..rel_sp() });
    assert!(plan_rel_extra(&state, &edited).unwrap().is_none());
    let p = health_preview_in(&state, &edited).unwrap();
    assert_eq!((tv(&p).tests[0].rows, tv(&p).tests[0].hours, tv(&p).tests[0].scored), (144, 24, 24));
    // ADDING (here: a longer period) plans exactly the NEW hours.
    let longer = rel_req(vec![tp(288, 575)]);
    let job2 = plan_rel_extra(&state, &longer).unwrap().unwrap();
    assert_eq!(rel_hours_of(&d, &job2.points), (72..96).collect::<Vec<i64>>());
    apply_rel_extra(&state, &job2, &answers(&job2.points)).unwrap();
    let p = health_preview_in(&state, &longer).unwrap();
    assert_eq!((tv(&p).tests[0].hours, tv(&p).tests[0].scored), (48, 48), "old and new predictions are both used");
    // REMOVING the period, going back to the shorter one, shortening it to an
    // hour boundary, or a period over training rows: nothing to predict.
    for tests in [vec![], vec![tp(288, 431)], vec![tp(288, 293)], vec![tp(100, 401)], vec![tp(288, 431), tp(432, 575)]] {
        assert!(planned(&state, tests.clone()).is_none(), "{tests:?}");
    }
}

#[test]
fn a_period_edge_moved_inside_an_hour_re_predicts_exactly_that_hour() {
    let (state, d) = rel_state();
    fill(&state, &rel_req(vec![tp(288, 431)])); // hours 0..=71 are stored
    // Lengthened by two rows into hour 72 (rows 432, 433 of 432..=437): one new
    // point, at the mean of just those two rows.
    let job = planned(&state, vec![tp(288, 433)]).unwrap();
    assert_eq!(rel_hours_of(&d, &job.points), vec![72]);
    approx(job.x_extra[0][0], (d.columns[1][432] + d.columns[1][433]) / 2.0, 1e-12, "mean of the two rows");
    // Shortened to end INSIDE hour 71 (rows 426..=428 of 426..=431): that hour has
    // other means now - its stored prediction is not reused, the hour is asked again.
    let job = planned(&state, vec![tp(288, 428)]).unwrap();
    assert_eq!(rel_hours_of(&d, &job.points), vec![71]);
    approx(job.x_extra[0][0], (426..=428).map(|r| d.columns[1][r]).sum::<f64>() / 3.0, 1e-12, "mean of the three rows");
    // Until it is predicted that one hour is unscored, the other 23 are scored.
    let p = health_preview_in(&state, &rel_req(vec![tp(288, 428)])).unwrap();
    let t = &tv(&p).tests[0];
    assert_eq!((t.rows, t.hours, t.scored), (141, 24, 23));
    apply_rel_extra(&state, &job, &answers(&job.points)).unwrap();
    let p = health_preview_in(&state, &rel_req(vec![tp(288, 428)])).unwrap();
    assert_eq!(tv(&p).tests[0].scored, 24);
    // Both versions of hour 71 are kept: moving the edge back costs nothing.
    assert!(planned(&state, vec![tp(288, 428)]).is_none());
    assert!(planned(&state, vec![tp(288, 431)]).is_none());
}

#[test]
fn removing_a_scoring_period_plans_nothing_even_when_it_shared_an_hour() {
    // The model is trained on rows 0..=285, so hour 47 (rows 282..=287) holds
    // four training rows. S1 = 286..=434: the rest of hour 47, hours 48..=71 and
    // rows 432..=434 of hour 72. S2 = 434..=575: shares row 434 (and hour 72)
    // with S1 - the usual case of two periods that meet at one instant.
    let d = rel_data();
    let state = state_with(rel_data());
    let stamp = session_stamp(&state).unwrap().unwrap();
    assert!(store_rel_fit(&state, stamp, "m1::fp".into(), rel_fit_n(&d, 286)));
    let (s1, s2) = (tp(286, 434), tp(434, 575));
    let job = planned(&state, vec![s1.clone(), s2.clone()]).unwrap();
    // One point per hour 0..=95, plus the shared hours as they are WITHOUT one of
    // their sources: hour 47 with the training rows only, hour 72 with S1 only
    // and with S2 only.
    let hours = rel_hours_of(&d, &job.points);
    assert_eq!(hours.len(), 96 + 3);
    assert_eq!(hours.iter().filter(|&&h| h == 47).count(), 2);
    assert_eq!(hours.iter().filter(|&&h| h == 72).count(), 3);
    assert_eq!(job.x_extra.len(), 99);
    apply_rel_extra(&state, &job, &answers(&job.points)).unwrap();
    // Whatever is removed afterwards, the engine is not needed again...
    for tests in [vec![s1.clone()], vec![s2.clone()], vec![], vec![s2.clone(), s1.clone()]] {
        assert!(planned(&state, tests.clone()).is_none(), "{tests:?}");
        // ...and every hour of that answer has its score.
        let p = health_preview_in(&state, &rel_req(tests.clone())).unwrap();
        assert!(rel_hourly(&p).score.as_ref().unwrap().iter().all(Option::is_some), "{tests:?}");
        let sum = p.score_summary.as_ref().unwrap();
        assert_eq!((sum.scored, sum.unscored, sum.total_rows), (48, 0, 48), "{tests:?}");
    }
    // Hour 72 really is another point in each case (so the stored versions matter).
    let only_s1 = health_preview_in(&state, &rel_req(vec![s1])).unwrap();
    let both = health_preview_in(&state, &rel_req(vec![tp(286, 434), s2])).unwrap();
    let hour72 = |p: &HealthPreview| {
        let h = rel_hourly(p);
        let k = h.rows.iter().position(|&r| r == 432).unwrap();
        h.predicted[k].unwrap()
    };
    assert!((hour72(&only_s1) - hour72(&both)).abs() > 0.01);
}

#[test]
fn nothing_is_planned_without_a_fit_and_stale_results_are_refused() {
    let (state, _d) = rel_state();
    let mut other = rel_req(vec![tp(288, 431)]);
    other.cache_key = Some("unknown".into());
    assert!(plan_rel_extra(&state, &other).unwrap().is_none());
    assert!(health_preview_in(&state, &other).unwrap_err().starts_with("NOT_FITTED"));
    other.cache_key = None;
    assert!(plan_rel_extra(&state, &other).unwrap().is_none());
    let mut wrong_target = rel_req(vec![tp(288, 431)]);
    wrong_target.target = Some("X".into());
    assert!(plan_rel_extra(&state, &wrong_target).unwrap().is_none());
    // The generation guard applies - with and without scoring periods.
    for tests in [vec![tp(288, 431)], vec![]] {
        let mut stale = rel_req(tests);
        stale.expected_generation = Some(99);
        assert!(plan_rel_extra(&state, &stale).unwrap_err().starts_with("STALE_SESSION"));
    }
    // A result that straddles a special-sensor change (cache cleared) is dropped.
    let job = planned(&state, vec![tp(288, 431)]).unwrap();
    state.0.write().unwrap().as_mut().unwrap().rel_cache.clear();
    assert!(apply_rel_extra(&state, &job, &answers(&job.points)).unwrap_err().starts_with("NOT_FITTED"));
}

#[test]
fn predictions_die_with_an_evicted_fit_and_are_asked_for_again_after_a_new_train() {
    let d = rel_data();
    let state = state_with(rel_data());
    state.0.write().unwrap().as_mut().unwrap().rel_cache = crate::health_score::RelCache::new(1, usize::MAX);
    let stamp = session_stamp(&state).unwrap().unwrap();
    assert!(store_rel_fit(&state, stamp, "m1::fp".into(), rel_fit(&d)));
    let req = rel_req(vec![tp(288, 431)]);
    fill(&state, &req);
    assert!(plan_rel_extra(&state, &req).unwrap().is_none());
    // Another model's fit pushes it out of the (one-entry) cache.
    assert!(store_rel_fit(&state, stamp, "m2::fp".into(), rel_fit(&d)));
    {
        let lock = state.0.read().unwrap();
        let c = &lock.as_ref().unwrap().rel_cache;
        assert!(c.peek("m1::fp").is_none() && c.peek_extra("m1::fp").is_none(), "no orphaned predictions");
    }
    assert!(plan_rel_extra(&state, &req).unwrap().is_none(), "no fit: nothing to plan ...");
    assert!(health_preview_in(&state, &req).unwrap_err().starts_with("NOT_FITTED"), "... the preview asks for a new Train");
    // Trained again: the old fit's predictions are gone with it - all 72 are asked again.
    assert!(store_rel_fit(&state, stamp, "m1::fp".into(), rel_fit(&d)));
    assert_eq!(plan_rel_extra(&state, &req).unwrap().unwrap().points.len(), 72);
}

#[test]
fn sidecar_answers_are_checked_and_an_outdated_sidecar_is_named() {
    let ok = serde_json::json!({ "predicted_extra": [1.0, null, 3.0] });
    let v = parse_predicted_extra(&ok, 3).unwrap();
    assert_eq!((v[0], v[2]), (1.0, 3.0));
    assert!(v[1].is_nan());
    assert!(parse_predicted_extra(&ok, 4).unwrap_err().contains("length mismatch"));
    // An old binary: unknown action, or a train answer without predicted_extra.
    let old_action = serde_json::json!({ "error": "Unknown action: 'predict_relationship'" });
    assert!(parse_predicted_extra(&old_action, 1).unwrap_err().starts_with("SIDECAR_OUTDATED"));
    let no_field = serde_json::json!({ "request": "PreviewModel/relationship", "predicted": [] });
    assert!(parse_predicted_extra(&no_field, 1).unwrap_err().starts_with("SIDECAR_OUTDATED"));
    let other = serde_json::json!({ "error": "boom" });
    assert!(parse_predicted_extra(&other, 1).unwrap_err().contains("boom"));
}

// ---------- Train pre-warm (preview_relationship_model) ----------

/// The hourly points `preview_relationship_model` asks the engine for when it
/// trains on rows 0..288 with these scoring periods - built the way the command
/// does it (row-major training values, no fit yet).
fn train_points(d: &ColumnarData, tests: &[TestPeriodArg]) -> RelHourPoints {
    let rows: Vec<u32> = (0..2 * DAY as u32).collect();
    let y: Vec<f64> = rows.iter().map(|&r| d.columns[2][r as usize]).collect();
    let x: Vec<Vec<f64>> = rows.iter().map(|&r| vec![d.columns[1][r as usize]]).collect();
    let filter = train_to(2 * DAY - 1, vec![]);
    let plan = (!tests.is_empty()).then(|| TestPlan::resolve(tests, Some(&filter), &d.headers));
    let cols = RelCols { target: 2, predictors: &[1] };
    let train = RelTrain { rows: &rows, actual: &y, x: RelX::Rows(&x), n_pred: 1 };
    RelHours::build(d, &train, plan.as_ref().map(|p| (p, &cols))).points()
}

/// What the sidecar's `preview_relationship` returns for the 288 training rows
/// (+ `predicted_extra` for the hourly points `extra` when given).
fn train_response(d: &ColumnarData, extra: Option<&RelHourPoints>) -> serde_json::Value {
    let preds: Vec<f64> = (0..2 * DAY).map(|r| 2.0 * d.columns[1][r]).collect();
    let resid: Vec<f64> = (0..2 * DAY).map(|r| d.columns[2][r] - preds[r]).collect();
    let mut v = serde_json::json!({
        "request": "PreviewModel/relationship",
        "r2_per_step": [0.9],
        "rmse2_per_step": [2.0],
        "predicted": preds,
        "residual": resid,
    });
    if let Some(points) = extra {
        v["predicted_extra"] = serde_json::json!(answers(points));
    }
    v
}

/// The Train call's tail (`finish_relationship_response_ex`) over a fresh session.
fn finish_train(state: &AppState, d: &ColumnarData, parsed: serde_json::Value, asked: &RelHourPoints) -> serde_json::Value {
    let rows: Vec<u32> = (0..2 * DAY as u32).collect();
    let y: Vec<f64> = rows.iter().map(|&r| d.columns[2][r as usize]).collect();
    let x: Vec<Vec<f64>> = rows.iter().map(|&r| vec![d.columns[1][r as usize]]).collect();
    crate::finish_relationship_response_ex(
        state,
        session_stamp(state).unwrap().unwrap(),
        parsed,
        &["X".to_string()],
        "Y",
        1.0,
        &rows,
        &y,
        &x,
        Some("m1::fp".into()),
        Some(100),
        asked,
        &|_| {},
    )
    .unwrap()
}

#[test]
fn train_and_the_lazy_prediction_choose_the_same_hourly_points() {
    // One function picks them: what the Train sends as X_extra equals what the
    // preview's own job would ask the sidecar for.
    let (state, d) = rel_state();
    let tests = vec![tp(144, 431), tp(576, 600)];
    let points = train_points(&d, &tests);
    let job = plan_rel_extra(&state, &rel_req(tests)).unwrap().unwrap();
    assert_eq!(points, job.points);
    assert_eq!(points.x_rows(), job.x_extra);
    // Training hours 0..=47 (the first period's training rows change nothing in
    // them), the first period's other hours 48..=71, and the second period:
    // hours 96..=99 complete plus hour 100 with its single row 600.
    let want: Vec<i64> = (0..72).chain(96..=100).collect();
    assert_eq!(rel_hours_of(&d, &points), want);
    assert_eq!(*points.x_rows().last().unwrap(), vec![d.columns[1][600]], "a one-row hour is that row");
}

#[test]
fn train_prewarm_leaves_nothing_to_predict_for_the_preview_that_follows() {
    let d = rel_data();
    let state = state_with(rel_data());
    let tests = vec![tp(288, 575)];
    let asked = train_points(&d, &tests);
    assert_eq!(asked.len(), 96, "48 training hours + the period's 48 - all in the Train's one run");
    let resp = finish_train(&state, &d, train_response(&d, Some(&asked)), &asked);
    assert_eq!(resp["cached"], true);
    assert!(resp.get("predicted_extra").is_none(), "the unbounded predictions are never shipped");
    // The bounded preview of the Train answer already carries hourly predictions.
    let hp = &resp["health_preview"];
    assert_eq!(hp["hourly"]["total_points"], 48);
    assert!(hp["hourly"]["predicted"].as_array().unwrap().iter().all(|v| v.is_number()));
    assert!(hp["hourly"]["score"].is_null(), "no set points in the Train answer");
    assert_eq!(hp["series"]["total_points"], 288);
    // Stored under the fit's key...
    let seeded = state.0.read().unwrap().as_ref().unwrap().rel_cache.peek_extra("m1::fp").unwrap();
    assert_eq!(seeded.points(), &asked);
    // ...so the preview's planner has nothing left to predict = no sidecar call.
    let req = rel_req(tests);
    assert!(plan_rel_extra(&state, &req).unwrap().is_none());
    let p = health_preview_in(&state, &req).unwrap();
    assert_eq!((tv(&p).tests[0].rows, tv(&p).tests[0].hours, tv(&p).tests[0].scored), (288, 48, 48));
    assert_eq!(p.score_summary.as_ref().unwrap().scored, 48);
    // Same numbers as when the predictions arrive the lazy way.
    let (lazy_state, _) = rel_state();
    fill(&lazy_state, &req);
    let lazy = health_preview_in(&lazy_state, &req).unwrap();
    assert_eq!(serde_json::to_value(&p).unwrap(), serde_json::to_value(&lazy).unwrap());
    // A longer period needs only the hours the pre-warm did not cover; removing
    // the period needs nothing.
    let longer = planned(&state, vec![tp(288, 719)]).unwrap();
    assert_eq!(rel_hours_of(&d, &longer.points), (96..120).collect::<Vec<i64>>());
    assert!(planned(&state, vec![]).is_none());
}

#[test]
fn train_without_scoring_periods_prewarms_the_training_hours() {
    let d = rel_data();
    let state = state_with(rel_data());
    let asked = train_points(&d, &[]);
    assert_eq!(rel_hours_of(&d, &asked), (0..48).collect::<Vec<i64>>());
    let resp = finish_train(&state, &d, train_response(&d, Some(&asked)), &asked);
    assert_eq!(resp["cached"], true);
    // The health score is there at once - no second engine run.
    let req = rel_req(vec![]);
    assert!(plan_rel_extra(&state, &req).unwrap().is_none());
    let p = health_preview_in(&state, &req).unwrap();
    let sum = p.score_summary.as_ref().unwrap();
    assert_eq!((sum.scored, sum.unscored, sum.total_rows), (48, 0, 48));
    assert!(p.test_validation.is_none());
    // A scoring period added afterwards costs exactly its own hours.
    let job = planned(&state, vec![tp(288, 431)]).unwrap();
    assert_eq!(rel_hours_of(&d, &job.points), (48..72).collect::<Vec<i64>>());
}

#[test]
fn train_without_a_usable_prewarm_answer_stores_nothing_and_the_lazy_path_still_works() {
    let d = rel_data();
    let none = RelHourPoints::default();
    // No point asked for (no cache key in the real command): nothing is stored
    // even if the answer carries some predictions.
    let state = state_with(rel_data());
    let stray = train_points(&d, &[]);
    let resp = finish_train(&state, &d, train_response(&d, Some(&stray)), &none);
    assert_eq!(resp["cached"], true);
    assert!(resp.get("predicted_extra").is_none());
    assert!(state.0.read().unwrap().as_ref().unwrap().rel_cache.peek_extra("m1::fp").is_none());
    // An old sidecar that ignores X_extra (no predicted_extra): no seed, no failure.
    let state = state_with(rel_data());
    let asked = train_points(&d, &[tp(288, 575)]);
    let resp = finish_train(&state, &d, train_response(&d, None), &asked);
    assert_eq!(resp["cached"], true);
    assert!(state.0.read().unwrap().as_ref().unwrap().rel_cache.peek_extra("m1::fp").is_none());
    // The Train answer is still complete; its hourly points just have no prediction yet.
    assert!(resp["health_preview"]["hourly"]["predicted"].as_array().unwrap().iter().all(|v| v.is_null()));
    // A wrong length: no seed either.
    let state = state_with(rel_data());
    let short = train_points(&d, &[]);
    let resp = finish_train(&state, &d, train_response(&d, Some(&short)), &asked);
    assert_eq!(resp["cached"], true);
    assert!(state.0.read().unwrap().as_ref().unwrap().rel_cache.peek_extra("m1::fp").is_none());
    // The lazy path then still works for those points.
    assert_eq!(planned(&state, vec![tp(288, 575)]).unwrap().points, asked);
}

#[test]
fn train_prewarm_is_not_stored_for_a_fit_that_was_not_cached() {
    let d = rel_data();
    let state = state_with(rel_data());
    // The dataset's derived state changes while the sidecar ran: nothing is cached or seeded.
    let stamp = session_stamp(&state).unwrap().unwrap();
    state.0.write().unwrap().as_mut().unwrap().rel_cache.clear();
    let rows: Vec<u32> = (0..2 * DAY as u32).collect();
    let asked = train_points(&d, &[tp(288, 299)]);
    let y: Vec<f64> = rows.iter().map(|&r| d.columns[2][r as usize]).collect();
    let x: Vec<Vec<f64>> = rows.iter().map(|&r| vec![d.columns[1][r as usize]]).collect();
    let resp = crate::finish_relationship_response_ex(
        &state, stamp, train_response(&d, Some(&asked)), &["X".to_string()], "Y", 1.0,
        &rows, &y, &x, Some("m1::fp".into()), Some(100), &asked, &|_| {},
    )
    .unwrap();
    assert_eq!(resp["cached"], false);
    assert!(state.0.read().unwrap().as_ref().unwrap().rel_cache.peek_extra("m1::fp").is_none());
}

// ---------- a failed hourly prediction degrades, never fails ----------

#[test]
fn failed_prediction_gives_the_fit_preview_with_unscored_hours_and_one_warning() {
    let (state, _d) = rel_state();
    let tests = vec![tp(288, 575), tp(144, 431)];
    let req = rel_req(tests);
    // What a sidecar crash looks like to the caller.
    let crash = parse_predicted_extra(&serde_json::json!({ "error": "boom: C:\\build\\x.py line 3" }), 1).unwrap_err();
    assert!(crash.contains("boom"), "the raw reason only goes to the log");
    let p = crate::health_preview_with_outcome(&state, &req, Some(TestScoringFailure::EngineError)).unwrap();
    // The model-fit side is intact: the very same answer as without scoring periods.
    let plain = health_preview_in(&state, &rel_req(vec![])).unwrap();
    let (a, b) = (serde_json::to_value(&plain).unwrap(), serde_json::to_value(&p).unwrap());
    for key in ["stats", "series", "score_summary", "fit_scatter", "valid"] {
        assert_eq!(a[key], b[key], "{key}");
    }
    assert!(p.valid, "a warning never invalidates the set points");
    // No hour has a prediction: every hourly score is null (never 0) and the
    // summary says nothing was scored.
    assert!(rel_hourly(&p).score.as_ref().unwrap().iter().all(Option::is_none));
    assert_eq!((b["score_summary"]["scored"].clone(), b["score_summary"]["unscored"].clone()), (0.into(), 48.into()));
    assert!(b["score_summary"]["min_score"].is_null());
    // Scoring block present, every period unscored, metrics omitted, nullable fields null.
    let v = &b["test_validation"];
    assert_eq!((v["train"]["rows"].clone(), v["train"]["hours"].clone()), (288.into(), 48.into()));
    for t in v["tests"].as_array().unwrap() {
        assert_eq!(t["scored"], 0);
        for k in ["pct_below_80", "lowest", "lowest_at"] {
            assert!(t[k].is_null(), "{k}");
        }
        for k in ["label", "event_time", "first_below_80", "lead_days"] {
            assert!(t.get(k).is_none(), "{k} is no longer part of a result");
        }
        for k in ["r2", "rmse", "residual_mean", "residual_sd", "mean_shift_sd", "within_3sd_pct"] {
            assert!(t.get(k).is_none(), "{k} must be omitted");
        }
    }
    // Exactly one warning, user readable, no raw error text / paths.
    let w: Vec<_> = p.validation.iter().filter(|i| i.code == "test_scoring_failed").collect();
    assert_eq!(w.len(), 1);
    assert_eq!(w[0].severity, crate::health_score::Severity::Warning);
    assert_eq!(w[0].field, "test_periods");
    assert!(w[0].message.starts_with("The health score could not be calculated"), "{}", w[0].message);
    assert!(w[0].message.contains("The model fit is not affected"), "{}", w[0].message);
    assert!(!w[0].message.contains("boom") && !w[0].message.contains("C:\\"));
    assert!(!w[0].message.contains(".sh") && !w[0].message.contains("src-tauri"));
    // No failure: the same request with no error has no such warning.
    let ok = crate::health_preview_with_outcome(&state, &req, None).unwrap();
    assert!(ok.validation.iter().all(|i| i.code != "test_scoring_failed"));
}

#[test]
fn a_failure_after_a_good_train_keeps_the_training_hours_scored() {
    // The Train pre-warmed the training hours; a scoring period added later
    // could not be predicted. The training hours keep their score, the new
    // hours are null, every period reads "not scored".
    let (state, _d) = rel_state();
    fill(&state, &rel_req(vec![]));
    let req = rel_req(vec![tp(288, 431)]);
    let p = crate::health_preview_with_outcome(&state, &req, Some(TestScoringFailure::EngineError)).unwrap();
    let sum = p.score_summary.as_ref().unwrap();
    assert_eq!((sum.scored, sum.unscored, sum.total_rows), (48, 0, 48));
    let h = rel_hourly(&p);
    let sc = h.score.as_ref().unwrap();
    for (k, &row) in h.rows.iter().enumerate() {
        assert_eq!(sc[k].is_some(), (row as usize) < 2 * DAY, "hour of row {row}");
    }
    let t = &tv(&p).tests[0];
    assert_eq!((t.rows, t.hours, t.scored, t.pct_below_80), (144, 24, 0, None));
    assert_eq!(p.validation.iter().filter(|i| i.code == "test_scoring_failed").count(), 1);
}

#[test]
fn outdated_sidecar_gets_its_own_user_facing_wording() {
    let (state, _d) = rel_state();
    let old = parse_predicted_extra(&serde_json::json!({ "error": "Unknown action: 'predict_relationship'" }), 1).unwrap_err();
    assert!(old.starts_with("SIDECAR_OUTDATED:"), "the frontend keys on the prefix");
    assert!(old.contains("out of date") && old.contains("reinstall"));
    for dev in ["build_sidecar", ".sh", "src-tauri", "Python", "sidecar"] {
        assert!(!old.contains(dev), "no developer wording ({dev}) in: {old}");
    }
    let p = crate::health_preview_with_outcome(&state, &rel_req(vec![tp(288, 575)]), Some(TestScoringFailure::Outdated)).unwrap();
    // Its own code: a retry cannot help, so the
    // frontend shows no "Try again" for it.
    let w = p.validation.iter().find(|i| i.code == "test_scoring_outdated").unwrap();
    assert!(w.message.contains("out of date"));
    assert!(w.message.starts_with("The health score could not be calculated"), "{}", w.message);
    assert_eq!((w.severity, w.field.as_str()), (crate::health_score::Severity::Warning, "test_periods"));
    assert!(p.validation.iter().all(|i| i.code != "test_scoring_failed"), "never both codes");
    assert!(tv(&p).tests.iter().all(|t| t.scored == 0));
    // An Individual preview has no prediction step and is never touched.
    let d = ind_data(0, 0..0);
    let st = state_with(d);
    let ip = crate::health_preview_with_outcome(&st, &ind_req(vec![tp(288, 575)], None), None).unwrap();
    assert!(ip.validation.iter().all(|i| i.code != "test_scoring_failed"));
}

/// A cache budget that holds the 288-row fit (8064 bytes) and its 48 training
/// hours (48 x 24 = 1152 bytes -> 9216) but not 24 more hours (-> 9792).
const TIGHT_BUDGET: usize = 9300;

#[test]
fn predictions_over_the_cache_budget_are_reported_not_stored_and_not_an_error() {
    let d = rel_data();
    let state = state_with(rel_data());
    state.0.write().unwrap().as_mut().unwrap().rel_cache = crate::health_score::RelCache::new(8, TIGHT_BUDGET);
    let stamp = session_stamp(&state).unwrap().unwrap();
    assert!(store_rel_fit(&state, stamp, "m1::fp".into(), rel_fit(&d)));
    let req = rel_req(vec![tp(288, 431)]);
    let job = plan_rel_extra(&state, &req).unwrap().unwrap();
    assert_eq!(job.points.len(), 72);
    assert_eq!(apply_rel_extra(&state, &job, &answers(&job.points)), Ok(crate::ExtraStored::OverBudget), "still fitted, but no room");
    assert!(state.0.read().unwrap().as_ref().unwrap().rel_cache.peek("m1::fp").is_some());
    // The caller turns that into the degraded answer, with its own wording.
    let p = crate::health_preview_with_outcome(&state, &req, Some(TestScoringFailure::OverBudget)).unwrap();
    let w = p.validation.iter().find(|i| i.code == "test_scoring_too_large").unwrap();
    assert!(p.validation.iter().all(|i| i.code != "test_scoring_failed"), "never both codes");
    assert!(w.message.contains("too many hours to score in memory"), "{}", w.message);
    assert!(w.message.contains("shorten the train or scoring periods"), "{}", w.message);
    assert!(!w.message.contains("did not answer"));
    // A fit that is really gone is still NOT_FITTED.
    state.0.write().unwrap().as_mut().unwrap().rel_cache.clear();
    assert!(apply_rel_extra(&state, &job, &answers(&job.points)).unwrap_err().starts_with("NOT_FITTED"));
}

#[test]
fn unscored_periods_still_report_their_rows_days_and_hours() {
    // A period fully outside the training scope has no prediction after a
    // failure; it must not report 0 rows / 0 days / 0 hours.
    let (state, _d) = rel_state();
    let req = rel_req(vec![tp(288, 575), tp(144, 431)]);
    let p = crate::health_preview_with_outcome(&state, &req, Some(TestScoringFailure::EngineError)).unwrap();
    let t = &tv(&p).tests;
    assert_eq!((t[0].rows, t[0].days, t[0].hours, t[0].scored), (288, 2.0, 48, 0));
    assert_eq!((t[1].rows, t[1].days, t[1].train_rows, t[1].scored), (288, 2.0, 144, 0));
    assert_eq!((t[1].hours, t[1].train_hours, t[1].train_days), (48, 24, 1.0));
}

// ---------- predict_rel_hours: lock scope, remembered failures, retry ----------

use crate::{predict_rel_hours, ExtraPlan, RelExtraJob, TestScoringError};
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::task::{Context, Poll, Waker};

type RunResult = (RelExtraJob, Result<Vec<f64>, String>);

/// A runner that answers with Y = 2X for every hourly point of the job (counts
/// its calls).
fn good_runner(calls: &AtomicUsize) -> impl FnOnce(RelExtraJob) -> std::future::Ready<RunResult> + '_ {
    move |job: RelExtraJob| {
        calls.fetch_add(1, Ordering::SeqCst);
        let preds = answers(&job.points);
        std::future::ready((job, Ok(preds)))
    }
}

fn failing_runner<'a>(err: &str, calls: &'a AtomicUsize) -> impl FnOnce(RelExtraJob) -> std::future::Ready<RunResult> + 'a {
    let err = err.to_string();
    move |job: RelExtraJob| {
        calls.fetch_add(1, Ordering::SeqCst);
        std::future::ready((job, Err(err)))
    }
}

fn block_on<F: Future>(f: F) -> F::Output {
    tauri::async_runtime::block_on(f)
}

#[test]
fn the_training_hours_are_predicted_and_scored_without_any_scoring_period() {
    let (state, _d) = rel_state();
    let serial = tauri::async_runtime::Mutex::new(());
    let outdated = AtomicBool::new(false);
    let calls = AtomicUsize::new(0);
    let req = rel_req(vec![]);
    // Nothing stored yet (the Train's own answer did not carry the hourly
    // predictions): valid set points, but no hour has a score.
    let before = health_preview_in(&state, &req).unwrap();
    assert!(before.valid && before.test_validation.is_none());
    assert_eq!(before.score_summary.as_ref().unwrap().scored, 0);
    // The prediction step runs although there is no scoring period...
    assert_eq!(block_on(predict_rel_hours(&state, &req, &serial, &outdated, good_runner(&calls), &|_| {})), Ok(None));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let p = crate::health_preview_with_outcome(&state, &req, None).unwrap();
    let sum = p.score_summary.clone().unwrap();
    assert_eq!((sum.scored, sum.unscored, sum.total_rows, sum.share_basis), (48, 0, 48, "hour_count"));
    assert_eq!(sum.pct_below_80, Some(0.0));
    assert!(p.test_validation.is_none(), "no scoring period, no scoring block");
    assert!(p.validation.iter().all(|i| !i.code.starts_with("test_scoring")));
    // ...once: the next preview (a set-point edit) finds every hour stored.
    assert_eq!(block_on(predict_rel_hours(&state, &req, &serial, &outdated, good_runner(&calls), &|_| {})), Ok(None));
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    // If it FAILS, the warning appears although there is no scoring period:
    // every hour unscored, the model-fit side intact, no engine text anywhere.
    let (failed_state, _) = rel_state();
    let nasty = "pygam LinearGAM exploded in backend.py (numpy.linalg.LinAlgError)";
    let e = block_on(predict_rel_hours(&failed_state, &req, &serial, &outdated, failing_runner(nasty, &calls), &|_| {}))
        .unwrap()
        .expect("reported, not silently unscored");
    assert_eq!(e.kind, TestScoringFailure::EngineError);
    let bad = crate::health_preview_with_outcome(&failed_state, &req, Some(e.kind)).unwrap();
    assert!(bad.valid && bad.test_validation.is_none());
    let w: Vec<_> = bad.validation.iter().filter(|i| i.code == "test_scoring_failed").collect();
    assert_eq!(w.len(), 1);
    assert_eq!(
        w[0].message,
        "The health score could not be calculated because the Relation model engine did not answer. \
         The model fit is not affected - try again, or train the model again."
    );
    assert_eq!(bad.score_summary.as_ref().unwrap().scored, 0);
    assert!(rel_hourly(&bad).score.as_ref().unwrap().iter().all(Option::is_none));
    let shipped = serde_json::to_string(&bad).unwrap();
    for word in ["pygam", "LinearGAM", "GAM", "backend.py", "exploded", "numpy", "idecar", "ython"] {
        assert!(!shipped.contains(word), "{word} reached the frontend");
    }
    let (a, b) = (serde_json::to_value(&p).unwrap(), serde_json::to_value(&bad).unwrap());
    for key in ["stats", "series", "fit_scatter", "valid"] {
        assert_eq!(a[key], b[key], "{key}");
    }
}

#[test]
fn a_fully_cached_preview_is_planned_without_waiting_for_the_prediction_lock() {
    let (state, _d) = rel_state();
    let serial = tauri::async_runtime::Mutex::new(());
    let outdated = AtomicBool::new(false);
    let calls = AtomicUsize::new(0);
    let req = rel_req(vec![tp(288, 431)]);
    // Fill the predictions once.
    assert_eq!(block_on(predict_rel_hours(&state, &req, &serial, &outdated, good_runner(&calls), &|_| {})), Ok(None));
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    // Another model's prediction run holds the lock...
    let held = serial.try_lock().unwrap();
    // ...a preview whose hours are all stored answers on the FIRST poll - also
    // the one with the scoring period removed.
    let mut cx = Context::from_waker(Waker::noop());
    for r in [&req, &rel_req(vec![])] {
        let fut = std::pin::pin!(predict_rel_hours(&state, r, &serial, &outdated, good_runner(&calls), &|_| {}));
        assert_eq!(fut.poll(&mut cx), Poll::Ready(Ok(None)), "must not wait for the lock");
    }
    assert_eq!(calls.load(Ordering::SeqCst), 1, "no sidecar run");

    // A preview that needs NEW hours does wait for it...
    let longer = rel_req(vec![tp(288, 575)]);
    let mut fut = std::pin::pin!(predict_rel_hours(&state, &longer, &serial, &outdated, good_runner(&calls), &|_| {}));
    assert!(fut.as_mut().poll(&mut cx).is_pending(), "a run needs the lock");
    // ...and runs once it is free.
    drop(held);
    assert_eq!(block_on(fut), Ok(None));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert!(crate::plan_rel_extra(&state, &longer).unwrap().is_none());
}

#[test]
fn the_planning_split_builds_the_job_only_when_asked() {
    let (state, d) = rel_state();
    let req = rel_req(vec![tp(288, 431)]);
    assert!(matches!(crate::plan_rel_extra_ex(&state, &req, false, false).unwrap(), ExtraPlan::Needed(None)));
    let job = match crate::plan_rel_extra_ex(&state, &req, false, true).unwrap() {
        ExtraPlan::Needed(Some(job)) => job,
        other => panic!("expected a job, got {other:?}"),
    };
    assert_eq!(rel_hours_of(&d, &job.points), (0..72).collect::<Vec<i64>>());
    // Outdated sidecar: hours are missing, but nothing is to be run.
    match crate::plan_rel_extra_ex(&state, &req, true, true).unwrap() {
        ExtraPlan::Failed(e) => assert!(e.reason.starts_with("SIDECAR_OUTDATED") && e.kind == TestScoringFailure::Outdated),
        other => panic!("{other:?}"),
    }
    // Nothing missing -> Nothing, whatever the flags.
    apply_rel_extra(&state, &job, &answers(&job.points)).unwrap();
    for r in [&req, &rel_req(vec![]), &rel_req(vec![tp(0, 100)])] {
        assert!(matches!(crate::plan_rel_extra_ex(&state, r, true, true).unwrap(), ExtraPlan::Nothing));
    }
    // The generation guard still applies to the lock-free look.
    let mut stale = req.clone();
    stale.expected_generation = Some(99);
    assert!(crate::plan_rel_extra_ex(&state, &stale, false, false).unwrap_err().starts_with("STALE_SESSION"));
}

#[test]
fn a_failed_attempt_is_logged_remembered_and_retried_only_on_request() {
    let (state, _d) = rel_state();
    let serial = tauri::async_runtime::Mutex::new(());
    let outdated = AtomicBool::new(false);
    let calls = AtomicUsize::new(0);
    let logged = std::sync::Mutex::new(Vec::<String>::new());
    let log = |s: &str| logged.lock().unwrap().push(s.to_string());
    let req = rel_req(vec![tp(288, 431)]);

    // 1. The sidecar fails: the raw reason is returned and logged, the fit is marked.
    let r = block_on(predict_rel_hours(&state, &req, &serial, &outdated, failing_runner("boom at C:\\x.py", &calls), &log));
    assert_eq!(r, Ok(Some(TestScoringError::new(TestScoringFailure::EngineError, "boom at C:\\x.py"))));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    {
        let l = logged.lock().unwrap();
        assert_eq!(l.len(), 1);
        assert!(l[0].contains("boom at C:\\x.py") && l[0].contains("m1::fp"), "{l:?}");
    }
    assert!(has_marker(&state, "m1::fp"));
    assert!(!outdated.load(Ordering::SeqCst));

    // 2. The next (debounced) preview does NOT run the sidecar again.
    let r = block_on(predict_rel_hours(&state, &req, &serial, &outdated, failing_runner("again", &calls), &log)).unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1, "no second sidecar run");
    assert_eq!(logged.lock().unwrap().len(), 1, "nothing new to log");
    let e = r.expect("still reported as not scored");
    assert_eq!(e.kind, TestScoringFailure::EngineError, "the remembered kind");
    let p = crate::health_preview_with_outcome(&state, &req, Some(e.kind)).unwrap();
    let w = p.validation.iter().find(|i| i.code == "test_scoring_failed").unwrap();
    assert!(!w.message.contains("out of date"), "generic wording: {}", w.message);
    assert!(!w.message.contains("boom") && !w.message.contains("x.py"), "never the engine's text: {}", w.message);
    assert!(tv(&p).tests.iter().all(|t| t.scored == 0));

    // 3. An explicit retry (the "Try again" button) runs it once more.
    let mut retry = req.clone();
    retry.retry_test_scoring = true;
    assert_eq!(block_on(predict_rel_hours(&state, &retry, &serial, &outdated, good_runner(&calls), &log)), Ok(None));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert!(!has_marker(&state, "m1::fp"));
    let p = crate::health_preview_with_outcome(&state, &req, None).unwrap();
    assert_eq!(tv(&p).tests[0].scored, 24);
    assert_eq!(p.score_summary.as_ref().unwrap().scored, 48);
}

#[test]
fn a_retrain_clears_the_failed_marker() {
    let (state, d) = rel_state();
    let serial = tauri::async_runtime::Mutex::new(());
    let outdated = AtomicBool::new(false);
    let calls = AtomicUsize::new(0);
    let req = rel_req(vec![tp(288, 431)]);
    block_on(predict_rel_hours(&state, &req, &serial, &outdated, failing_runner("boom", &calls), &|_| {})).unwrap();
    assert!(matches!(crate::plan_rel_extra_ex(&state, &req, false, false).unwrap(), ExtraPlan::Failed(_)));
    // Train again (same key): a fresh fit, a fresh attempt.
    let stamp = session_stamp(&state).unwrap().unwrap();
    assert!(store_rel_fit(&state, stamp, "m1::fp".into(), rel_fit(&d)));
    assert!(matches!(crate::plan_rel_extra_ex(&state, &req, false, false).unwrap(), ExtraPlan::Needed(None)));
    assert_eq!(block_on(predict_rel_hours(&state, &req, &serial, &outdated, good_runner(&calls), &|_| {})), Ok(None));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[test]
fn an_outdated_sidecar_is_remembered_for_the_process_not_per_fit() {
    let (state, d) = rel_state();
    let serial = tauri::async_runtime::Mutex::new(());
    let outdated = AtomicBool::new(false);
    let calls = AtomicUsize::new(0);
    // A third model whose hours were all predicted BEFORE the engine turned out
    // to be outdated (e.g. its Train answered with them).
    let stamp = session_stamp(&state).unwrap().unwrap();
    assert!(store_rel_fit(&state, stamp, "m3::fp".into(), rel_fit(&d)));
    let mut stored = rel_req(vec![tp(288, 431)]);
    stored.cache_key = Some("m3::fp".into());
    fill(&state, &stored);

    let req = rel_req(vec![tp(288, 431)]);
    let old = parse_predicted_extra(&serde_json::json!({ "error": "Unknown action: 'predict_relationship'" }), 1).unwrap_err();
    let r = block_on(predict_rel_hours(&state, &req, &serial, &outdated, failing_runner(&old, &calls), &|_| {})).unwrap();
    let e = r.unwrap();
    assert!(e.reason.starts_with("SIDECAR_OUTDATED") && e.kind == TestScoringFailure::Outdated);
    assert!(outdated.load(Ordering::SeqCst));
    assert!(!has_marker(&state, "m1::fp"), "the flag, not the marker");
    // Any later run is skipped - also another fit, also on retry, also without
    // scoring periods (the training hours need the engine too).
    assert!(store_rel_fit(&state, stamp, "m2::fp".into(), rel_fit(&d)));
    let mut other = rel_req(vec![tp(288, 431)]);
    other.cache_key = Some("m2::fp".into());
    other.retry_test_scoring = true;
    for r in [&req, &other, &rel_req(vec![])] {
        let e = block_on(predict_rel_hours(&state, r, &serial, &outdated, good_runner(&calls), &|_| {})).unwrap().unwrap();
        assert!(e.reason.starts_with("SIDECAR_OUTDATED") && e.kind == TestScoringFailure::Outdated);
    }
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    // A model whose hours are all stored needs no sidecar: no warning.
    assert_eq!(block_on(predict_rel_hours(&state, &stored, &serial, &outdated, good_runner(&calls), &|_| {})), Ok(None));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn over_budget_predictions_are_remembered_like_a_failure() {
    let d = rel_data();
    let state = state_with(rel_data());
    state.0.write().unwrap().as_mut().unwrap().rel_cache = crate::health_score::RelCache::new(8, TIGHT_BUDGET);
    let stamp = session_stamp(&state).unwrap().unwrap();
    assert!(store_rel_fit(&state, stamp, "m1::fp".into(), rel_fit(&d)));
    let serial = tauri::async_runtime::Mutex::new(());
    let outdated = AtomicBool::new(false);
    let calls = AtomicUsize::new(0);
    let logged = std::sync::Mutex::new(Vec::<String>::new());
    let req = rel_req(vec![tp(288, 431)]);
    let r = block_on(predict_rel_hours(&state, &req, &serial, &outdated, good_runner(&calls), &|s| logged.lock().unwrap().push(s.into()))).unwrap();
    let e = r.unwrap();
    assert!(e.reason.contains("do not fit the model cache") && e.kind == TestScoringFailure::OverBudget);
    assert!(logged.lock().unwrap()[0].contains("72 hourly points"));
    let again = block_on(predict_rel_hours(&state, &req, &serial, &outdated, good_runner(&calls), &|_| {})).unwrap();
    assert_eq!(again.map(|e| e.kind), Some(TestScoringFailure::OverBudget), "remembered with its own wording");
    assert_eq!(calls.load(Ordering::SeqCst), 1, "not predicted again");
    // The natural fix - a shorter scoring period - is tried again (and here fits:
    // 48 training hours + one more).
    let shorter = rel_req(vec![tp(288, 289)]);
    assert_eq!(block_on(predict_rel_hours(&state, &shorter, &serial, &outdated, good_runner(&calls), &|_| {})), Ok(None));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

fn has_marker(state: &AppState, key: &str) -> bool {
    state.0.read().unwrap().as_ref().unwrap().rel_cache.has_failed_marker(key)
}

#[test]
fn a_remembered_failure_applies_only_to_the_same_missing_hours() {
    // The failed marker is per set of missing hourly points, not per fit: after a
    // failure a change of the scoring periods must not answer "failed" at once.
    let (state, _d) = rel_state();
    let serial = tauri::async_runtime::Mutex::new(());
    let outdated = AtomicBool::new(false);
    let calls = AtomicUsize::new(0);
    let t1 = rel_req(vec![tp(288, 431)]);
    assert!(block_on(predict_rel_hours(&state, &t1, &serial, &outdated, failing_runner("boom", &calls), &|_| {})).unwrap().is_some());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    // Same hours (a set-point edit): remembered, no run.
    assert!(block_on(predict_rel_hours(&state, &t1, &serial, &outdated, failing_runner("x", &calls), &|_| {})).unwrap().is_some());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    // S2 added: other hours -> one fresh attempt (fails again here).
    let t1_t2 = rel_req(vec![tp(288, 431), tp(576, 700)]);
    assert!(block_on(predict_rel_hours(&state, &t1_t2, &serial, &outdated, failing_runner("boom 2", &calls), &|_| {})).unwrap().is_some());
    assert_eq!(calls.load(Ordering::SeqCst), 2, "a superset runs again");
    // ...and THAT set is now the remembered one.
    assert!(block_on(predict_rel_hours(&state, &t1_t2, &serial, &outdated, failing_runner("x", &calls), &|_| {})).unwrap().is_some());
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    // A period shortened: runs again (and succeeds).
    let shrunk = rel_req(vec![tp(288, 300)]);
    assert_eq!(block_on(predict_rel_hours(&state, &shrunk, &serial, &outdated, good_runner(&calls), &|_| {})), Ok(None));
    assert_eq!(calls.load(Ordering::SeqCst), 3, "a subset runs again");
    assert!(!has_marker(&state, "m1::fp"), "a success clears the marker");
}

#[test]
fn the_logged_reason_is_bounded() {
    // A parse error carries the engine's whole stdout.
    let (state, _d) = rel_state();
    let serial = tauri::async_runtime::Mutex::new(());
    let outdated = AtomicBool::new(false);
    let calls = AtomicUsize::new(0);
    let logged = std::sync::Mutex::new(Vec::<String>::new());
    let huge = format!("Failed to parse sidecar output: EOF (raw: {})", "ก1.5, ".repeat(400_000));
    let req = rel_req(vec![tp(288, 431)]);
    let e = block_on(predict_rel_hours(&state, &req, &serial, &outdated, failing_runner(&huge, &calls), &|s| logged.lock().unwrap().push(s.into())))
        .unwrap()
        .unwrap();
    assert_eq!(e.reason, huge, "the caller still gets the full reason (never shown)");
    let l = logged.lock().unwrap();
    assert_eq!(l.len(), 1);
    assert!(l[0].len() < crate::ERROR_LOG_DETAIL_MAX + 64, "logged {} bytes", l[0].len());
    assert!(l[0].starts_with("model m1::fp: Failed to parse sidecar output"));
    let full = format!("model m1::fp: {huge}");
    let kept = l[0].find('…').unwrap();
    assert!(l[0].ends_with(&format!("… ({} bytes truncated)", full.len() - kept)), "{}", &l[0][kept..]);
}

#[test]
fn truncate_log_detail_is_char_boundary_safe() {
    use crate::truncate_log_detail as t;
    assert_eq!(t("short", 10), "short");
    assert_eq!(t("exactly10!", 10), "exactly10!");
    assert_eq!(t("abcdefghijk", 4), "abcd… (7 bytes truncated)");
    // "ก" is 3 bytes: a cut inside it backs off to the previous boundary.
    assert_eq!(t("กขค", 4), "ก… (6 bytes truncated)");
    assert_eq!(t("กขค", 2), "… (9 bytes truncated)");
    assert_eq!(t("", 0), "");
}

#[test]
fn the_log_is_written_after_the_prediction_lock_is_released() {
    let (state, _d) = rel_state();
    let serial = tauri::async_runtime::Mutex::new(());
    let outdated = AtomicBool::new(false);
    let calls = AtomicUsize::new(0);
    let free_while_logging = AtomicBool::new(false);
    let log = |_: &str| free_while_logging.store(serial.try_lock().is_ok(), Ordering::SeqCst);
    let req = rel_req(vec![tp(288, 431)]);
    assert!(block_on(predict_rel_hours(&state, &req, &serial, &outdated, failing_runner("boom", &calls), &log)).unwrap().is_some());
    assert!(free_while_logging.load(Ordering::SeqCst));
    // ...while the failure itself was remembered before (the next caller sees it).
    assert!(has_marker(&state, "m1::fp"));
}

#[test]
fn a_same_key_retrain_during_the_run_never_receives_the_old_fits_predictions() {
    // The job carries its fit's identity.
    let (state, d) = rel_state();
    let serial = tauri::async_runtime::Mutex::new(());
    let outdated = AtomicBool::new(false);
    let req = rel_req(vec![tp(288, 431)]);
    let retrain = || {
        let stamp = session_stamp(&state).unwrap().unwrap();
        assert!(store_rel_fit(&state, stamp, "m1::fp".into(), rel_fit(&d)));
    };
    // a) The run succeeds, but the model was trained again meanwhile.
    let r = block_on(predict_rel_hours(&state, &req, &serial, &outdated, |job: RelExtraJob| {
        retrain();
        let preds = answers(&job.points);
        std::future::ready((job, Ok(preds)))
    }, &|_| {}))
    .unwrap();
    let e = r.expect("the new fit has no predictions yet: reported, not silently unscored");
    assert_eq!(e.kind, TestScoringFailure::EngineError);
    {
        let lock = state.0.read().unwrap();
        let c = &lock.as_ref().unwrap().rel_cache;
        assert!(c.peek_extra("m1::fp").is_none(), "old predictions never merged into the new fit");
        assert!(!c.has_failed_marker("m1::fp"), "the new fit did not fail");
    }
    // b) The run fails, and the model was trained again meanwhile: nothing marked.
    let r = block_on(predict_rel_hours(&state, &req, &serial, &outdated, |job: RelExtraJob| {
        retrain();
        std::future::ready((job, Err("boom".to_string())))
    }, &|_| {}))
    .unwrap();
    assert!(r.is_some());
    assert!(!has_marker(&state, "m1::fp"), "the failure belongs to the OLD fit");
    // c) The re-train pre-warmed the new fit's hours: answer for it, all scored.
    let r = block_on(predict_rel_hours(&state, &req, &serial, &outdated, |job: RelExtraJob| {
        retrain();
        let new_fit = {
            let lock = state.0.read().unwrap();
            std::sync::Arc::downgrade(&lock.as_ref().unwrap().rel_cache.peek("m1::fp").unwrap())
        };
        let stamp = session_stamp(&state).unwrap().unwrap();
        let preds = answers(&job.points);
        assert_eq!(crate::merge_rel_extra(&state, stamp, "m1::fp", &new_fit, &job.points, &preds), crate::ExtraStored::Stored);
        std::future::ready((job, Ok(vec![-1.0; preds.len()])))
    }, &|_| {}))
    .unwrap();
    assert_eq!(r, None);
    let p = crate::health_preview_with_outcome(&state, &req, None).unwrap();
    assert_eq!(tv(&p).tests[0].scored, 24);
    let lock = state.0.read().unwrap();
    let extra = lock.as_ref().unwrap().rel_cache.peek_extra("m1::fp").unwrap();
    let last = extra.len() - 1;
    let stored = extra.get(extra.points().hours()[last], extra.points().x(last)).unwrap();
    assert!(stored > 0.0, "the new fit's predictions, not the old run's -1");
}

#[test]
fn other_kinds_never_touch_the_sidecar_and_a_relation_model_only_for_missing_hours() {
    let (state, _d) = rel_state();
    let serial = tauri::async_runtime::Mutex::new(());
    let outdated = AtomicBool::new(false);
    let calls = AtomicUsize::new(0);
    let mut ind = rel_req(vec![tp(288, 431)]);
    ind.kind = "individual".into();
    assert_eq!(block_on(predict_rel_hours(&state, &ind, &serial, &outdated, good_runner(&calls), &|_| {})), Ok(None));
    let mut clu = rel_req(vec![]);
    clu.kind = "clustering".into();
    assert_eq!(block_on(predict_rel_hours(&state, &clu, &serial, &outdated, good_runner(&calls), &|_| {})), Ok(None));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    // A Relation model with an unknown fit / no key is left to the preview's own
    // NOT_FITTED answer.
    let mut unknown = rel_req(vec![]);
    unknown.cache_key = Some("nope".into());
    assert_eq!(block_on(predict_rel_hours(&state, &unknown, &serial, &outdated, good_runner(&calls), &|_| {})), Ok(None));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn the_request_accepts_retry_test_scoring_in_snake_and_camel_case() {
    let a: HealthPreviewRequest = serde_json::from_str(r#"{"kind":"relationship","retry_test_scoring":true}"#).unwrap();
    assert!(a.retry_test_scoring);
    let b: HealthPreviewRequest = serde_json::from_str(r#"{"kind":"relationship","retryTestScoring":true}"#).unwrap();
    assert!(b.retry_test_scoring);
    let c: HealthPreviewRequest = serde_json::from_str(r#"{"kind":"relationship"}"#).unwrap();
    assert!(!c.retry_test_scoring, "default false");
}

#[test]
fn a_sidecar_timeout_fires_once_and_a_finished_run_cancels_it() {
    use std::time::Duration;
    // Fires: the callback (the kill) runs and the flag is set.
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let (_done, fired) = crate::arm_timeout(Duration::from_millis(20), move || tx.send(()).unwrap());
    assert!(rx.recv_timeout(Duration::from_secs(5)).is_ok(), "the timeout callback ran");
    assert!(fired.load(Ordering::SeqCst));
    // Cancelled: dropping the sender before the limit means no callback, no flag.
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let (done, fired) = crate::arm_timeout(Duration::from_millis(300), move || tx.send(()).unwrap());
    drop(done);
    assert!(rx.recv_timeout(Duration::from_millis(600)).is_err(), "never called after the run finished");
    assert!(!fired.load(Ordering::SeqCst));
    assert!(crate::PREDICT_SIDECAR_TIMEOUT >= Duration::from_secs(300), "generous: only a hung engine hits it");
}

#[test]
fn the_preview_and_the_prediction_step_use_the_same_hourly_points() {
    // What the prediction step asks the engine for is exactly what the preview
    // looks up: with the job's answers stored, no hour is left without a score.
    let (state, d) = rel_state();
    let fit = rel_fit(&d);
    let tests = vec![tp(144, 431), tp(576, 600)];
    let job = plan_rel_extra(&state, &rel_req(tests.clone())).unwrap().unwrap();
    let extra = RelExtra::new(&job.points, &answers(&job.points)).unwrap();
    let p = relationship_preview_ex(&d, &fit, Some(&extra), &rel_req(tests)).unwrap();
    let h = rel_hourly(&p);
    assert_eq!(h.total_points, job.points.len());
    assert_eq!(h.total_points, 77);
    assert!(h.predicted.iter().all(Option::is_some) && h.score.as_ref().unwrap().iter().all(Option::is_some));
    // The raw series stays the fit's rows.
    match &p.series {
        HealthSeries::Relationship(s) => assert_eq!(s.total_points, fit.rows.len()),
        _ => unreachable!(),
    }
    let t = &tv(&p).tests;
    assert_eq!((t[0].rows, t[0].train_rows, t[0].hours, t[0].train_hours, t[0].scored), (288, 144, 48, 24, 48));
    assert_eq!((t[1].rows, t[1].hours, t[1].scored), (25, 5, 5));
}

// ---------- the export still refuses what it cannot validate ----------

#[test]
fn export_never_claims_a_validation_it_could_not_compute() {
    use crate::export_extra_predictions as ex;
    // No hourly point: nothing to predict, nothing required.
    assert_eq!(ex(None, 0), Ok(vec![]));
    // An outdated sidecar ignores X_extra: refuse (nothing is written by the caller).
    assert!(ex(None, 3).unwrap_err().starts_with("SIDECAR_OUTDATED:"));
    // Wrong length: refuse. This error is SHOWN (Mark complete): user wording
    // first ("Relation model engine", never "sidecar"), the numbers after it.
    let wrong = ex(Some(&[Some(1.0)]), 3).unwrap_err();
    assert!(wrong.starts_with("The Relation model engine's answer does not match the request"), "{wrong}");
    assert!(wrong.contains("length mismatch (got 1 expected 3)"), "{wrong}");
    assert!(!wrong.to_lowercase().contains("sidecar") && !wrong.contains("Python"), "{wrong}");
    // Good answer: NaN for a missing / non-finite value.
    let v = ex(Some(&[Some(1.0), None, Some(f64::INFINITY)]), 3).unwrap();
    assert_eq!(v[0], 1.0);
    assert!(v[1].is_nan() && v[2].is_nan());
}

// ===========================================================================
// Clustering
// ===========================================================================

/// X/Y around (10, 20) with a small bounded pattern; from the step row the X is
/// shifted by +100 (far outside any ring). C is the criteria sensor: it changes
/// by the HOUR (even hours 5, odd hours 15), so every hour is in one cluster.
fn clu_data() -> ColumnarData {
    let n = 10 * DAY;
    let x: Vec<f64> = (0..n)
        .map(|i| 10.0 + (((i * 37) % 11) as f64 - 5.0) * 0.2 + if i >= STEP_ROW { 100.0 } else { 0.0 })
        .collect();
    let y: Vec<f64> = (0..n).map(|i| 20.0 + (((i * 17) % 13) as f64 - 6.0) * 0.1).collect();
    let c: Vec<f64> = (0..n).map(|i| if (i / HOUR) % 2 == 0 { 5.0 } else { 15.0 }).collect();
    ds(vec![("X", x), ("Y", y), ("C", c)])
}

fn clu_req(tests: Vec<TestPeriodArg>, n_clusters: u32) -> HealthPreviewRequest {
    HealthPreviewRequest {
        kind: "clustering".into(),
        first_sensor: Some("X".into()),
        second_sensor: Some("Y".into()),
        n_clusters: Some(n_clusters),
        criteria_sensor: (n_clusters > 1).then(|| "C".to_string()),
        cluster_ranges: (n_clusters > 1).then(|| {
            vec![
                ClusterRange { min: None, max: Some(10.0) },
                ClusterRange { min: Some(10.0), max: None },
            ]
        }),
        filter: Some(train_to(2 * DAY - 1, vec![])),
        set_points: Some(SetPointsArg { outer_sd: Some(6.0), ..Default::default() }),
        test_periods: if tests.is_empty() { None } else { Some(tests) },
        max_points: Some(100_000),
        ..Default::default()
    }
}

#[test]
fn clustering_quiet_period_and_a_period_with_a_shift() {
    let d = clu_data();
    let tests = vec![
        tp(288, 575),
        tp(576, 1151),
    ];
    let p = clustering_preview(&d, &clu_req(tests, 1)).unwrap();
    assert!(p.valid, "{:?}", p.validation);
    let v = tv(&p);
    assert_eq!((v.train.rows, v.train.days, v.train.hours), (288, 2.0, 48));
    assert_eq!(v.train.metrics.inside_3sd_ring_pct, Some(100.0), "the raw training rows");
    let n = &v.tests[0];
    assert_eq!((n.rows, n.days, n.train_rows), (288, 2.0, 0), "raw facts");
    assert_eq!((n.hours, n.train_hours, n.scored), (48, 0, 48), "hourly points");
    assert_eq!(n.metrics.inside_3sd_ring_pct, Some(100.0));
    assert_eq!(n.pct_below_80, Some(0.0));
    assert!(n.lowest.unwrap() >= 80.0, "inside the 3 SD ring throughout: {:?}", n.lowest);
    let k = &v.tests[1];
    assert_eq!((k.rows, k.hours, k.scored), (576, 96, 96));
    // The 33 hours before the shift are inside the ring. Hour 129 holds the step
    // (2 rows at ~10, 4 at ~110): its MEAN point is far outside, like the 62
    // fully shifted hours after it.
    assert_eq!(k.metrics.inside_3sd_ring_pct, Some(34.4));
    assert_eq!(k.pct_below_80, Some(65.6));
    assert_eq!(k.lowest, Some(0.0), "an hourly mean beyond the outer ring scores 0");
    assert_eq!(k.lowest_at.as_deref(), Some(ts_at(STEP_HOUR * HOUR).as_str()), "the first hour at 0: the step's own hour");
    assert!(k.metrics.r2.is_none() && k.metrics.within_3sd_pct.is_none());
    assert_eq!((n.index, k.index), (1, 2));
    // The hourly point of the step hour is the mean of its 6 rows.
    if let HealthSeries::Clustering(h) = &p.hourly {
        let at = h.rows.iter().position(|&r| r as usize == STEP_HOUR * HOUR).unwrap();
        assert_eq!(h.x[at], hour_mean(&d.columns[1], STEP_HOUR, &|_| true));
        assert_eq!(h.y[at], hour_mean(&d.columns[2], STEP_HOUR, &|_| true));
        assert_eq!(h.score.as_ref().unwrap()[at], Some(0.0));
        assert_eq!(h.total_points, 48 + 48 + 96);
    } else {
        unreachable!()
    }
    // Only the scoring facts and the Clustering metric are on the wire.
    let j = serde_json::to_value(k).unwrap();
    let mut keys: Vec<&str> = j.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec![
            "days", "end", "hours", "index", "inside_3sd_ring_pct", "lowest", "lowest_at", "pct_below_80", "rows",
            "scored", "start", "train_days", "train_hours", "train_rows",
        ]
    );
}

#[test]
fn clustering_hours_in_no_criteria_range_are_not_scored_and_not_counted_inside() {
    // Criteria ranges [None,10) and [20,None): the C = 15 rows are unassigned.
    let d = clu_data();
    let mut r = clu_req(vec![tp(288, 575)], 2);
    r.cluster_ranges = Some(vec![
        ClusterRange { min: None, max: Some(10.0) },
        ClusterRange { min: Some(20.0), max: None },
    ]);
    // The second cluster has no training row -> the fit is refused (NO_DATA) as before.
    assert!(clustering_preview(&d, &r).unwrap_err().starts_with("NO_DATA"));
    // Three machine states, one per HOUR: C = 5, 15, 100; the ranges cover
    // C = 5 and C = 100 only.
    let n = 10 * DAY;
    let state = |i: usize| (i / HOUR) % 3;
    let c: Vec<f64> = (0..n).map(|i| [5.0, 15.0, 100.0][state(i)]).collect();
    let x: Vec<f64> = (0..n)
        .map(|i| [10.0, 40.0, 70.0][state(i)] + (((i * 37) % 11) as f64 - 5.0) * 0.2)
        .collect();
    let y: Vec<f64> = (0..n)
        .map(|i| [20.0, 50.0, 80.0][state(i)] + (((i * 17) % 13) as f64 - 6.0) * 0.1)
        .collect();
    let d3 = ds(vec![("X", x), ("Y", y), ("C", c)]);
    let mut r = clu_req(vec![tp(288, 575)], 2);
    r.cluster_ranges = Some(vec![
        ClusterRange { min: None, max: Some(10.0) },
        ClusterRange { min: Some(50.0), max: None },
    ]);
    let p = clustering_preview(&d3, &r).unwrap();
    assert!(p.valid, "{:?}", p.validation);
    let t = &tv(&p).tests[0];
    assert_eq!(t.rows, 288, "rows with finite X and Y");
    assert_eq!(t.hours, 48, "every hour of the period has a point");
    assert_eq!(t.scored, 32, "only the assigned (C = 5 or 100) hours are scored");
    assert_eq!(t.metrics.inside_3sd_ring_pct, Some(100.0), "of the 32 hours that have a cluster");
    let st = match &p.stats {
        HealthStats::Clustering(s) => s,
        _ => unreachable!(),
    };
    assert_eq!(st.rows, 288);
    assert_eq!((st.assigned_rows, st.unassigned_rows), (192, 96), "the raw training rows, as before");

    // Hours of the period whose rows are NOT all in one cluster have no cluster:
    // they stay hours of the period but are not scored and not counted "inside".
    //   * hour 50 (state 2): its first half is in state 0 - two clusters in one
    //     hour. (Its mean criteria value, 52.5, is in the second range and its
    //     mean point is far from that cluster: judged by the mean it was a 0.)
    //   * hour 51 (state 0): one row has no criteria value.
    //   * hour 54 (state 0): one row's criteria value is in no range.
    let state5 = |i: usize| if (300..303).contains(&i) { 0 } else { state(i) };
    let mut c: Vec<f64> = (0..n).map(|i| [5.0, 15.0, 100.0][state5(i)]).collect();
    c[308] = f64::NAN;
    c[329] = 15.0;
    let x: Vec<f64> = (0..n)
        .map(|i| [10.0, 40.0, 70.0][state5(i)] + (((i * 37) % 11) as f64 - 5.0) * 0.2)
        .collect();
    let y: Vec<f64> = (0..n)
        .map(|i| [20.0, 50.0, 80.0][state5(i)] + (((i * 17) % 13) as f64 - 6.0) * 0.1)
        .collect();
    let d5 = ds(vec![("X", x), ("Y", y), ("C", c)]);
    let p = clustering_preview(&d5, &r).unwrap();
    assert!(p.valid, "{:?}", p.validation);
    let t = &tv(&p).tests[0];
    assert_eq!((t.rows, t.hours), (288, 48), "the three hours are still hours of the period");
    assert_eq!(t.scored, 29, "32 hours with a cluster, minus the three mixed ones");
    assert_eq!(t.metrics.inside_3sd_ring_pct, Some(100.0), "of the 29 hours that have a cluster");
    assert_eq!(t.pct_below_80, Some(0.0));
    assert!(t.lowest.unwrap() >= 80.0, "never the 0 of a transition hour: {:?}", t.lowest);
    if let HealthSeries::Clustering(h) = &p.hourly {
        assert_eq!(h.total_points, 96);
        let sc = h.score.as_ref().unwrap();
        for hour in [50usize, 51, 54] {
            assert_eq!(h.rows[hour] as usize, hour * HOUR);
            assert_eq!((h.cluster[hour], h.sd_distance[hour], sc[hour]), (None, None, None), "hour {hour}");
            assert_eq!(h.x[hour], hour_mean(&d5.columns[1], hour, &|_| true), "the hour is still a point");
        }
        // Their clean neighbours are scored as before.
        assert_eq!((h.cluster[53], h.cluster[57]), (Some(2), Some(1)));
        assert!(sc[53].unwrap() >= 80.0 && sc[57].unwrap() >= 80.0);
    } else {
        unreachable!()
    }
    let st = match &p.stats {
        HealthStats::Clustering(s) => s,
        _ => unreachable!(),
    };
    assert_eq!((st.assigned_rows, st.unassigned_rows), (192, 96), "the training rows are untouched");

    // The same three states changing every ROW: every hour holds rows of both
    // clusters (and rows in no range), so no hour has a cluster - nothing is scored.
    let c: Vec<f64> = (0..n).map(|i| [5.0, 15.0, 100.0][i % 3]).collect();
    let x: Vec<f64> = (0..n)
        .map(|i| [10.0, 40.0, 70.0][i % 3] + (((i * 37) % 11) as f64 - 5.0) * 0.2)
        .collect();
    let y: Vec<f64> = (0..n)
        .map(|i| [20.0, 50.0, 80.0][i % 3] + (((i * 17) % 13) as f64 - 6.0) * 0.1)
        .collect();
    let d4 = ds(vec![("X", x), ("Y", y), ("C", c)]);
    let p = clustering_preview(&d4, &r).unwrap();
    assert!(p.valid, "{:?}", p.validation);
    let t = &tv(&p).tests[0];
    assert_eq!((t.rows, t.hours, t.scored), (288, 48, 0));
    assert!(t.pct_below_80.is_none() && t.lowest.is_none() && t.lowest_at.is_none(), "no score is missing, never 0");
    assert_eq!(t.metrics.inside_3sd_ring_pct, None);
    let sum = p.score_summary.as_ref().unwrap();
    assert_eq!((sum.scored, sum.unscored, sum.total_rows), (0, 48, 48));
    // The per-row training facts are untouched by that.
    let st = match &p.stats {
        HealthStats::Clustering(s) => s,
        _ => unreachable!(),
    };
    assert_eq!((st.assigned_rows, st.unassigned_rows), (192, 96));
}

#[test]
fn clustering_overlap_and_training_summary_stay_training_only() {
    let d = clu_data();
    let base = clustering_preview(&d, &clu_req(vec![], 1)).unwrap();
    let with = clustering_preview(&d, &clu_req(vec![tp(144, 431)], 1)).unwrap();
    let t = &tv(&with).tests[0];
    assert_eq!((t.rows, t.train_rows, t.train_days), (288, 144, 1.0));
    assert_eq!((t.hours, t.train_hours, t.scored), (48, 24, 48));
    let (a, b) = (serde_json::to_value(&base).unwrap(), serde_json::to_value(&with).unwrap());
    assert_eq!(a["stats"], b["stats"]);
    assert_eq!(a["score_summary"], b["score_summary"]);
    assert_eq!(a["cluster_scatter"], b["cluster_scatter"], "the scatter shows the training rows");
    assert!(a["test_validation"].is_null());
    // Test rows outside the training period are part of the raw series, and
    // their hours of the scored (hourly) one.
    if let HealthSeries::Clustering(s) = &with.series {
        assert_eq!(s.total_points, 432);
    }
    if let (HealthSeries::Clustering(h0), HealthSeries::Clustering(h1)) = (&base.hourly, &with.hourly) {
        assert_eq!((h0.total_points, h1.total_points), (48, 72));
    }
}

// ===========================================================================
// Export
// ===========================================================================

fn read_json(p: &Path) -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

/// The export document without the keys that legitimately differ between two runs.
fn comparable(mut v: serde_json::Value) -> serde_json::Value {
    let o = v.as_object_mut().unwrap();
    o.remove("validation");
    o.remove("model_update_record");
    v
}

#[test]
fn relationship_export_block_matches_the_preview_and_writes_into_the_info_file() {
    use crate::{write_relationship_outputs, RelationshipOutputs};
    let d = rel_data();
    let fit = rel_fit(&d);
    let tests = vec![tp(288, 575), tp(576, 1151)];
    // What the export's one sidecar run answers for the hourly points it sent
    // (the training hours and the hours of both periods).
    let extra = rel_extra(&d, &fit, &rel_req(tests.clone()));
    assert_eq!(extra.len(), 48 + 48 + 96);

    // What the sidecar returned for the training rows (rounded like the files).
    let predicted: Vec<Option<f64>> = fit.predicted.iter().map(|&p| Some(p)).collect();
    let residual: Vec<Option<f64>> = (0..fit.rows.len()).map(|i| Some(fit.actual[i] - fit.predicted[i])).collect();
    let x_matrix: Vec<Vec<f64>> = fit.x_cols[0].iter().map(|&v| vec![v]).collect();
    let ts: Vec<Option<String>> = fit.rows.iter().map(|&r| d.timestamps[r as usize].clone()).collect();
    let dir = tempfile::tempdir().unwrap();
    let sp = rel_sp();
    let info_path = write_relationship_outputs(
        dir.path().to_str().unwrap(),
        &RelationshipOutputs {
            predictors: &["X".to_string()],
            target: "Y",
            lambda: 1.0,
            model_name: None,
            x_matrix: &x_matrix,
            y: &fit.actual,
            row_timestamps: &ts,
            time_bounds: &(ts_at(0), ts_at(287)),
            r2: 0.9,
            rmse2: 2.0,
            predicted: &predicted,
            residual: &residual,
            set_points: Some(&sp),
        },
    )
    .unwrap();
    let before = read_json(&info_path);

    let filter = train_to(2 * DAY - 1, vec![]);
    let block = crate::model_export::relationship_block(&d, &fit, &extra, Some(&filter), Some(&sp), &tests).unwrap();
    crate::health_validation::inject_validation(&info_path, block).unwrap();
    let after = read_json(&info_path);
    assert_eq!(comparable(after.clone()), comparable(before.clone()), "every existing key is untouched");
    assert!(before.get("validation").is_none());

    // The block IS the preview's `test_validation` plus `tested`, `validated_at`
    // and the two keys that declare the hourly scoring - nothing else.
    let v = &after["validation"];
    let preview = relationship_preview_ex(&d, &fit, Some(&extra), &rel_req(tests.clone())).unwrap();
    let pv = serde_json::to_value(tv(&preview)).unwrap();
    for key in ["train", "train_ranges", "tests"] {
        assert_eq!(v[key], pv[key], "{key}");
    }
    let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec!["scoring_aggregation", "scoring_interval_seconds", "tested", "tests", "train", "train_ranges", "validated_at"]
    );
    assert_eq!(v["tested"], true);
    chrono::DateTime::parse_from_rfc3339(v["validated_at"].as_str().unwrap()).expect("RFC 3339");
    assert_eq!((v["scoring_interval_seconds"].clone(), v["scoring_aggregation"].clone()), (3600.into(), "mean".into()));
    // It really is hourly now: raw rows beside hours, the scores judged per hour.
    assert_eq!((v["train"]["rows"].clone(), v["train"]["hours"].clone()), (288.into(), 48.into()));
    assert_eq!(v["train"]["rmse"], 1.0, "the train block stays the raw rows' numbers");
    let t = &v["tests"][1];
    assert_eq!((t["rows"].clone(), t["hours"].clone(), t["scored"].clone()), (576.into(), 96.into(), 96.into()));
    assert_eq!(t["pct_below_80"], 65.6);
    assert_eq!(t["lowest"], 40.0);
    assert_eq!(t["lowest_at"], ts_at(PLATEAU_ROW));
    for gone in ["label", "event_time", "lead_days", "first_below_80"] {
        assert!(!v.to_string().contains(gone), "{gone} must not be written");
    }
    assert!(v["tests"][0].get("r2").is_some() && v["tests"][0].get("residual_sd").is_some());
    // An export whose engine answered for no hourly point of a period would write
    // "not scored" - the caller refuses before that (`export_extra_predictions`).
    let none = crate::model_export::relationship_block(&d, &fit, &RelExtra::default(), Some(&filter), Some(&sp), &tests).unwrap();
    assert_eq!(none["tests"][1]["scored"], 0);
    assert!(none["tests"][1]["lowest"].is_null());
}

// ===========================================================================
// Parity with the frontend's fake Rust backend (one shared fixture)
// ===========================================================================
//
// `tests/fixtures/hourly_score_parity.json` holds ONE dataset (5-minute rows),
// one `compute_health_preview` request per kind exactly as the frontend sends
// it, and the answer expected for it. The frontend's integration tests run on
// a TypeScript port of this module (`src/__tests__/helpers/fakeHealthRust.ts`);
// `src/__tests__/HealthHourlyRustParity.test.ts` asserts the SAME fixture on
// that port. A number only one side reproduces is a finding - Rust is the
// source of truth, so fix the port (or, for a deliberate contract change, the
// fixture and both sides together).

const PARITY_FIXTURE: &str = include_str!("../fixtures/hourly_score_parity.json");

fn parity() -> serde_json::Value {
    serde_json::from_str(PARITY_FIXTURE).expect("hourly_score_parity.json")
}

/// The fixture's dataset as a session dataset (a JSON `null` is a missing value).
fn parity_data(fx: &serde_json::Value) -> ColumnarData {
    let ds = &fx["dataset"];
    let headers: Vec<String> = ds["headers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h.as_str().unwrap().to_string())
        .collect();
    let timestamps: Vec<Option<String>> = ds["timestamps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t.as_str().map(str::to_string))
        .collect();
    let n = timestamps.len();
    let mut columns = vec![vec![f64::NAN; n]];
    for h in &headers[1..] {
        let col: Vec<f64> = ds["columns"][h.as_str()]
            .as_array()
            .unwrap_or_else(|| panic!("column {h}"))
            .iter()
            .map(|v| v.as_f64().unwrap_or(f64::NAN))
            .collect();
        assert_eq!(col.len(), n, "column {h}");
        columns.push(col);
    }
    ColumnarData::from_parts(headers, timestamps, columns)
}

/// Numbers compared by VALUE: the fixture's `100` is Rust's `100.0`.
fn by_value(v: &serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    match v {
        Value::Number(n) => serde_json::json!(n.as_f64().unwrap()),
        Value::Array(a) => Value::Array(a.iter().map(by_value).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), by_value(x))).collect()),
        other => other.clone(),
    }
}

/// The whole value is the fixture's: same keys (a key Rust omits must be absent
/// from the fixture too), same values.
fn assert_same(actual: &serde_json::Value, expected: &serde_json::Value, what: &str) {
    assert_eq!(by_value(actual), by_value(expected), "{what}");
}

/// Every key the fixture lists is answered with exactly that value (other keys
/// of the answer are free).
fn assert_listed(actual: &serde_json::Value, listed: &serde_json::Value, what: &str) {
    for (k, v) in listed.as_object().unwrap() {
        assert_eq!(by_value(&actual[k.as_str()]), by_value(v), "{what}.{k}");
    }
}

fn parity_col<'a>(d: &'a ColumnarData, tag: &str) -> &'a [f64] {
    &d.columns[d.headers.iter().position(|h| h == tag).unwrap_or_else(|| panic!("column {tag}"))]
}

#[test]
fn hourly_parity_fixture_is_five_minute_rows_and_stopped_rows_read_9999() {
    let fx = parity();
    let d = parity_data(&fx);
    assert_eq!(d.timestamps.len(), 120);
    assert_eq!(crate::health_validation::sample_interval_secs(&d), Some(300.0));
    let run = parity_col(&d, "RUN");
    let stopped: Vec<usize> = (0..120).filter(|&i| run[i] == 0.0).collect();
    assert_eq!(stopped.len(), 9 + 12 + 6, "hour 5 (9 rows), hour 6 (all), hour 7 (6 rows)");
    for tag in ["V", "X", "Y", "T", "P"] {
        let c = parity_col(&d, tag);
        assert!(stopped.iter().all(|&i| c[i] == 9999.0), "{tag}");
    }
    // The one row with no criteria value is a RUNNING row.
    let mode = parity_col(&d, "MODE");
    assert_eq!((0..120).filter(|&i| mode[i].is_nan()).collect::<Vec<_>>(), vec![61]);
    assert_eq!(run[61], 1.0);
}

#[test]
fn hourly_parity_individual_answers_the_fixture_the_frontend_fake_is_tested_with() {
    let fx = parity();
    let d = parity_data(&fx);
    let case = &fx["cases"]["individual"];
    let want = &case["expect"];
    let req: HealthPreviewRequest = serde_json::from_value(case["request"].clone()).expect("the frontend's request");
    let p = individual_preview(&d, &req).unwrap();
    assert!(p.valid, "{:?}", p.validation);
    let j = serde_json::to_value(&p).unwrap();
    assert_same(&j["scoring_interval_secs"], &want["scoring_interval_secs"], "scoring_interval_secs");
    // Raw rows: never scored; only running rows of the train / scoring periods.
    assert!(j["series"]["score"].is_null());
    assert_same(&j["series"]["total_points"], &want["series_total_points"], "series.total_points");
    assert_listed(&j["hourly"], &want["hourly"], "hourly");
    assert_same(&j["score_summary"], &want["score_summary"], "score_summary");
    assert_same(&j["test_validation"], &want["test_validation"], "test_validation");
    // No stopped row (9999) reached a mean.
    assert!(ind_hourly(&p).value.iter().all(|&v| v < 100.0));
}

#[test]
fn hourly_parity_clustering_answers_the_fixture_the_frontend_fake_is_tested_with() {
    let fx = parity();
    let d = parity_data(&fx);
    let case = &fx["cases"]["clustering"];
    let want = &case["expect"];
    let req: HealthPreviewRequest = serde_json::from_value(case["request"].clone()).expect("the frontend's request");
    let p = clustering_preview(&d, &req).unwrap();
    assert!(p.valid, "{:?}", p.validation);
    let j = serde_json::to_value(&p).unwrap();
    assert_same(&j["scoring_interval_secs"], &want["scoring_interval_secs"], "scoring_interval_secs");
    assert!(j["series"]["score"].is_null());
    assert_same(&j["series"]["total_points"], &want["series_total_points"], "series.total_points");
    // An hour with rows in two clusters, with a row that has no criteria value,
    // or in no range: no cluster, no SD distance, no score (null, never 0).
    assert_listed(&j["hourly"], &want["hourly"], "hourly");
    let no_distance: Vec<serde_json::Value> = j["hourly"]["sd_distance"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.is_null().into())
        .collect();
    assert_eq!(serde_json::Value::Array(no_distance), want["sd_distance_is_null"]);
    assert_listed(&j["stats"], &want["stats"], "stats");
    assert_same(&j["score_summary"], &want["score_summary"], "score_summary");

    // (b) The row with NO criteria value still enters its hour's mean x / y:
    // hour 05:00 = two rows at 30 / 60 and that row at 42 / 72.
    let h = match &p.hourly {
        HealthSeries::Clustering(h) => h,
        _ => unreachable!(),
    };
    let at = h.timestamps.iter().position(|t| t == "2024-03-01T05:00:00").unwrap();
    assert_eq!((h.x[at], h.y[at]), (34.0, 64.0), "without the row it would be 30 / 60");
    assert_eq!((h.cluster[at], h.sd_distance[at], h.score.as_ref().unwrap()[at]), (None, None, None));

    // (a) A scoring period in which NO hour has a cluster: the metric is
    // OMITTED on the wire - not null, not 0. The next period has it.
    assert_same(&j["test_validation"], &want["test_validation"], "test_validation");
    let (s1, s2) = (&j["test_validation"]["tests"][0], &j["test_validation"]["tests"][1]);
    assert!(s1.get("inside_3sd_ring_pct").is_none(), "{s1}");
    assert_eq!((by_value(&s1["hours"]), by_value(&s1["scored"])), (serde_json::json!(2.0), serde_json::json!(0.0)));
    assert!(s1["pct_below_80"].is_null() && s1["lowest"].is_null() && s1["lowest_at"].is_null());
    assert_eq!(s2["inside_3sd_ring_pct"], 50.0);
    // A kind never carries another kind's metric keys.
    for t in [s1, s2] {
        for k in ["r2", "rmse", "residual_mean", "residual_sd", "mean", "sd", "within_3sd_pct", "mean_shift_sd"] {
            assert!(t.get(k).is_none(), "{k}");
        }
    }
}

