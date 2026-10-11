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

#![allow(clippy::too_many_arguments)]

use crate::csv_processor::ColumnarData;
use crate::health_preview::{
    clustering_preview, individual_preview, relationship_preview_ex, HealthPreview,
    HealthPreviewRequest, HealthSeries, HealthStats,
};
use crate::health_score::{RelExtra, RelFit, SetPointsArg};
use crate::health_validation::{TestPeriodArg, TestScoringFailure, TestValidation};
use crate::model_export::{export_sync, ModelFilesRequest};
use crate::{
    apply_rel_extra, health_preview_in, parse_predicted_extra, plan_export, plan_rel_extra,
    store_rel_fit, session_stamp, AppState, ClusterRange, ExportPlan, PreviewFilter,
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
    assert_eq!((t.index, t.rows, t.days), (1, 288, 2.0));
    assert_eq!((t.start.clone(), t.end.clone()), (Some(ts_at(288)), Some(ts_at(575))), "the period is echoed");
    assert_eq!((t.train_rows, t.train_days), (0, 0.0));
    assert_eq!(t.scored, 288);
    assert_eq!(t.pct_below_80, Some(0.0));
    assert_eq!(t.lowest, Some(100.0), "every 6-row window holds a 100");
    assert_eq!(t.lowest_at.as_deref(), Some(ts_at(288).as_str()), "the first window of the period");
    assert_eq!(t.metrics.within_3sd_pct, Some(100.0));
    assert!(t.metrics.mean_shift_sd.unwrap().abs() < 0.1);
    assert!(t.metrics.r2.is_none() && t.metrics.inside_3sd_ring_pct.is_none());
    assert!(!serde_json::to_string(t).unwrap().contains("-0.0"), "a rounded zero is never -0.0");
    // The train block is the model's own numbers.
    assert_eq!(v.train.rows, 288);
    assert_eq!(v.train.days, 2.0);
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
    // The period is rows 576..=1151 (4 days).
    let p = individual_preview(&d, &ind_req(vec![tp(576, 1151)], Some(sp))).unwrap();
    let t = &tv(&p).tests[0];
    assert_eq!((t.rows, t.days, t.scored), (576, 4.0, 576));
    // 576 - 776 + 576 = rows 776..=1151 are below 80 -> 376 of 576.
    assert_eq!(t.pct_below_80, Some(65.3));
    // Plateau score at 120: 80 + (120 - b3u) / (130 - b3u) * (0 - 80).
    let u = b3_upper(&p);
    let plateau = 80.0 + (120.0 - u) / (130.0 - u) * -80.0;
    assert_eq!(t.lowest, Some(plateau.round()));
    assert_eq!(t.lowest_at.as_deref(), Some(ts_at(STEP_ROW).as_str()));
    // Share of rows inside the model's 3 sigma: the 200 rows before the step.
    approx(t.metrics.within_3sd_pct.unwrap(), 200.0 * 100.0 / 576.0, 0.06, "within_3sd_pct");
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
            "days", "end", "index", "lowest", "lowest_at", "mean_shift_sd", "pct_below_80", "rows", "scored",
            "start", "train_days", "train_rows", "within_3sd_pct",
        ]
    );
    let mut top: Vec<&str> = j.as_object().unwrap().keys().map(String::as_str).collect();
    top.sort_unstable();
    assert_eq!(top, vec!["tests", "train", "train_ranges"]);
}

#[test]
fn individual_lowest_needs_one_hour_a_50_minute_dip_does_not_move_it_a_60_minute_one_does() {
    for (dip_rows, held) in [(5usize, false), (6, true), (7, true)] {
        let d = ind_data(dip_rows, 0..0);
        let p = individual_preview(&d, &ind_req(vec![tp(576, 1151)], Some(ind_sp(&d)))).unwrap();
        let t = &tv(&p).tests[0];
        let u = b3_upper(&p);
        let plateau = (80.0 + (120.0 - u) / (130.0 - u) * -80.0).round();
        assert!(plateau < 80.0);
        if held {
            assert_eq!(t.lowest, Some(plateau), "{dip_rows} rows of 10 min");
            assert_eq!(t.lowest_at.as_deref(), Some(ts_at(STEP_ROW).as_str()));
        } else {
            // Every 1 h window still holds a normal row (inside 3 sigma).
            assert!(t.lowest.unwrap() >= 80.0, "{dip_rows} rows of 10 min: {:?}", t.lowest);
        }
        // The share counts every low row, held for an hour or not.
        assert_eq!(t.pct_below_80, Some(((dip_rows as f64 * 1000.0 / 576.0).round()) / 10.0), "{dip_rows}");
    }
}

#[test]
fn individual_overlap_with_train_reports_train_rows_and_days_and_uses_the_whole_period() {
    let d = ind_data(400, 0..0);
    // Rows 144..=431: the last train day (144 rows) + 144 later rows.
    let p = individual_preview(&d, &ind_req(vec![tp(144, 431)], Some(ind_sp(&d)))).unwrap();
    let t = &tv(&p).tests[0];
    assert_eq!((t.rows, t.days), (288, 2.0));
    assert_eq!((t.train_rows, t.train_days), (144, 1.0));
    assert_eq!(t.scored, 288);
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
    assert_eq!(tv(&p).tests[0].rows, 0);
}

#[test]
fn individual_test_rows_must_pass_the_running_condition_and_a_stop_breaks_the_lowest_window() {
    // The machine is stopped (G = 0) for rows 800..=809 inside the period; the
    // 120 plateau is 776..=1175, so the stop splits it into 776..=799 (24 rows)
    // and 810..=1175: both are longer than 1 h, the first one gives `lowest_at`.
    let d = ind_data(400, 800..810);
    let mut r = ind_req(vec![tp(576, 1151)], Some(ind_sp(&d)));
    r.filter = Some(train_to(
        2 * DAY - 1,
        vec![PreviewValueFilter { sensor: "G".into(), operation: "greater_than".into(), value1: Some(0.5), value2: None }],
    ));
    let p = individual_preview(&d, &r).unwrap();
    let t = &tv(&p).tests[0];
    assert_eq!(t.rows, 576 - 10, "stopped rows are not scoring rows");
    let plateau = |p: &HealthPreview| {
        let u = b3_upper(p);
        (80.0 + (120.0 - u) / (130.0 - u) * -80.0).round()
    };
    assert_eq!(t.lowest, Some(plateau(&p)));
    assert_eq!(t.lowest_at.as_deref(), Some(ts_at(STEP_ROW).as_str()));
    // A stop inside a SHORT plateau: 776..=785 with row 779 stopped leaves 3 rows
    // and then 780..=785 = exactly 6 rows = 60 min, so the level is held from 780.
    let d2 = ind_data(10, 779..780);
    let mut r2 = r.clone();
    r2.set_points = Some(ind_sp(&d2));
    let p2 = individual_preview(&d2, &r2).unwrap();
    let t2 = &tv(&p2).tests[0];
    assert_eq!(t2.lowest, Some(plateau(&p2)));
    assert_eq!(t2.lowest_at.as_deref(), Some(ts_at(780).as_str()));
    // One more stopped row (782) and no part of the plateau lasts an hour.
    let mut d3 = ind_data(10, 779..780);
    d3.columns[2][782] = 0.0;
    let mut r3 = r.clone();
    r3.set_points = Some(ind_sp(&d3));
    let p3 = individual_preview(&d3, &r3).unwrap();
    assert!(tv(&p3).tests[0].lowest.unwrap() >= 80.0);
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
    assert_eq!(t.rows, 576);
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
    let (rows, scores, in_scope) = match &p.series {
        HealthSeries::Individual(s) => (&s.rows, s.score.as_ref().unwrap(), &s.in_scope),
        _ => unreachable!(),
    };
    for (i, &r) in rows.iter().enumerate() {
        let r = r as usize;
        assert!(r < 288 || (288..432).contains(&r) || (576..1152).contains(&r), "row {r} is in neither");
        assert!(scores[i].is_some() && in_scope[i]);
    }
    assert!(rows.contains(&700) && rows.contains(&300) && rows.contains(&10));
    // With out-of-scope rows requested the gap rows come back unscored.
    let mut r = ind_req(tests, Some(sp));
    r.include_out_of_scope = Some(true);
    let p = individual_preview(&d, &r).unwrap();
    if let HealthSeries::Individual(s) = &p.series {
        let at = s.rows.iter().position(|&x| x == 500).expect("row 500 present");
        assert!(!s.in_scope[at] && s.score.as_ref().unwrap()[at].is_none(), "a gap row has no score, not 0");
        let at = s.rows.iter().position(|&x| x == 300).unwrap();
        assert!(s.in_scope[at] && s.score.as_ref().unwrap()[at].is_some());
    }
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
    // And the series is exactly the training rows.
    if let HealthSeries::Individual(s) = &a.series {
        assert_eq!(s.total_points, 288);
    }
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
    assert_eq!((tv(&plain).tests[0].rows, tv(&plain).tests[0].pct_below_80), (576, Some(65.3)));
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
fn rel_data() -> ColumnarData {
    let x: Vec<f64> = (0..N_REL).map(|i| i as f64 * 0.01).collect();
    let y: Vec<f64> = (0..N_REL)
        .map(|i| 2.0 * x[i] + rel_noise(i) + if i >= STEP_ROW { 10.0 } else { 0.0 })
        .collect();
    ds(vec![("X", x), ("Y", y)])
}

/// The train-only model (Y = 2X) fitted on rows 0..288, with predictions for
/// `extra_rows` as the sidecar would return them.
fn rel_fit(d: &ColumnarData) -> RelFit {
    let rows: Vec<u32> = (0..2 * DAY as u32).collect();
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

fn rel_extra(d: &ColumnarData, rows: impl Iterator<Item = u32>) -> RelExtra {
    let rows: Vec<u32> = rows.collect();
    let predicted = rows.iter().map(|&r| 2.0 * d.columns[1][r as usize]).collect();
    RelExtra { rows, predicted }
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

/// Independent reference: R2 / RMSE / residual mean / sd of (y, 2x) over rows.
fn rel_ref(d: &ColumnarData, rows: impl Iterator<Item = usize>) -> (f64, f64, f64, f64) {
    let (mut ys, mut rs) = (vec![], vec![]);
    for r in rows {
        let y = d.columns[2][r];
        ys.push(y);
        rs.push(y - 2.0 * d.columns[1][r]);
    }
    let n = ys.len() as f64;
    let my = ys.iter().sum::<f64>() / n;
    let sst: f64 = ys.iter().map(|y| (y - my).powi(2)).sum();
    let ssr: f64 = rs.iter().map(|r| r * r).sum();
    let mr = rs.iter().sum::<f64>() / n;
    let sd = (rs.iter().map(|r| (r - mr).powi(2)).sum::<f64>() / (n - 1.0)).sqrt();
    (1.0 - ssr / sst, (ssr / n).sqrt(), mr, sd)
}

#[test]
fn relationship_quiet_period_metrics_and_a_score_of_100_throughout() {
    let d = rel_data();
    let fit = rel_fit(&d);
    let extra = rel_extra(&d, 288..576);
    let p = relationship_preview_ex(&d, &fit, Some(&extra), &rel_req(vec![tp(288, 575)])).unwrap();
    assert!(p.valid, "{:?}", p.validation);
    let t = &tv(&p).tests[0];
    assert_eq!((t.rows, t.days, t.scored, t.train_rows), (288, 2.0, 288, 0));
    assert_eq!(t.pct_below_80, Some(0.0));
    assert_eq!(t.lowest, Some(100.0));
    assert_eq!(t.lowest_at.as_deref(), Some(ts_at(288).as_str()));
    let (r2, rmse, mean, sd) = rel_ref(&d, 288..576);
    approx(t.metrics.r2.unwrap(), r2, 0.0006, "r2");
    assert_eq!(t.metrics.rmse, Some(1.0));
    assert_eq!(t.metrics.residual_mean, Some(0.0));
    approx(t.metrics.residual_sd.unwrap(), sd, 0.0006, "residual_sd");
    approx(rmse, 1.0, 1e-12, "reference rmse");
    approx(mean, 0.0, 1e-12, "reference mean");
    // The train block equals the model's own (INFO) numbers.
    let v = tv(&p);
    let st = match &p.stats {
        HealthStats::Relationship(s) => s,
        _ => unreachable!(),
    };
    assert_eq!(v.train.rows, st.rows);
    assert_eq!((v.train.metrics.rmse, v.train.days), (Some(st.rmse), 2.0));
    let (tr2, ..) = rel_ref(&d, 0..288);
    approx(v.train.metrics.r2.unwrap(), tr2, 0.0006, "train r2");
}

#[test]
fn relationship_drift_period_has_exact_share_below_80_lowest_and_residual_shift() {
    let d = rel_data();
    let fit = rel_fit(&d);
    let extra = rel_extra(&d, 288..1152);
    let tests = vec![tp(576, 1151)];
    let p = relationship_preview_ex(&d, &fit, Some(&extra), &rel_req(tests)).unwrap();
    let t = &tv(&p).tests[0];
    assert_eq!((t.rows, t.scored), (576, 576));
    // Residual 9 or 11 beyond the 80-point (5) -> scores 48 / 32, all below 80.
    assert_eq!(t.pct_below_80, Some(65.3));
    assert_eq!(t.lowest, Some(48.0), "the level held for 1 h: max of a 32/48 window");
    assert_eq!(t.lowest_at.as_deref(), Some(ts_at(STEP_ROW).as_str()));
    let (_, rmse, mean, sd) = rel_ref(&d, 576..1152);
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
            "days", "end", "index", "lowest", "lowest_at", "pct_below_80", "r2", "residual_mean", "residual_sd",
            "rmse", "rows", "scored", "start", "train_days", "train_rows",
        ]
    );
}

#[test]
fn relationship_lowest_needs_one_hour_on_the_residual_score() {
    for (dip, held) in [(5usize, false), (6, true)] {
        // A residual burst of +10 for `dip` rows only.
        let mut d = rel_data();
        for i in STEP_ROW..N_REL {
            let burst = i < STEP_ROW + dip;
            d.columns[2][i] = 2.0 * d.columns[1][i] + rel_noise(i) + if burst { 10.0 } else { 0.0 };
        }
        let fit = rel_fit(&d);
        let extra = rel_extra(&d, 288..1152);
        let p = relationship_preview_ex(&d, &fit, Some(&extra), &rel_req(vec![tp(576, 1151)])).unwrap();
        let t = &tv(&p).tests[0];
        // Burst rows score 48 / 32; every other row scores 100.
        assert_eq!(t.lowest, Some(if held { 48.0 } else { 100.0 }), "{dip} rows");
        if held {
            assert_eq!(t.lowest_at.as_deref(), Some(ts_at(STEP_ROW).as_str()));
        }
        // The share counts every low row either way.
        assert_eq!(t.pct_below_80, Some((dip as f64 * 1000.0 / 576.0).round() / 10.0), "{dip} rows");
    }
}

#[test]
fn relationship_overlap_and_rows_without_a_prediction() {
    let d = rel_data();
    let fit = rel_fit(&d);
    // Test 144..=431 overlaps the last train day (144 rows); rows 288..=431 need a prediction.
    let extra = rel_extra(&d, 288..432);
    let p = relationship_preview_ex(&d, &fit, Some(&extra), &rel_req(vec![tp(144, 431)])).unwrap();
    let t = &tv(&p).tests[0];
    assert_eq!((t.rows, t.days, t.train_rows, t.train_days), (288, 2.0, 144, 1.0));
    // Without any extra prediction only the train overlap can be scored.
    let p = relationship_preview_ex(&d, &fit, None, &rel_req(vec![tp(144, 431)])).unwrap();
    let t = &tv(&p).tests[0];
    assert_eq!((t.rows, t.train_rows, t.scored), (144, 144, 144));
    // A period with no row at all.
    let p = relationship_preview_ex(&d, &fit, Some(&extra), &rel_req(vec![tp(5000, 6000)])).unwrap();
    let t = &tv(&p).tests[0];
    assert_eq!((t.rows, t.scored, t.pct_below_80), (0, 0, None));
    assert!(serde_json::to_value(t).unwrap().get("r2").is_none());
}

#[test]
fn relationship_fit_summary_scatter_and_stats_stay_training_only() {
    let d = rel_data();
    let fit = rel_fit(&d);
    let extra = rel_extra(&d, 288..1152);
    let base = relationship_preview_ex(&d, &fit, None, &rel_req(vec![])).unwrap();
    let with = relationship_preview_ex(&d, &fit, Some(&extra), &rel_req(vec![tp(288, 575), tp(576, 1151)])).unwrap();
    let (a, b) = (serde_json::to_value(&base).unwrap(), serde_json::to_value(&with).unwrap());
    assert_eq!(a["stats"], b["stats"]);
    assert_eq!(a["score_summary"], b["score_summary"]);
    assert_eq!(a["fit_scatter"], b["fit_scatter"], "the Fit scatter shows the training rows");
    if let (HealthSeries::Relationship(s0), HealthSeries::Relationship(s1)) = (&base.series, &with.series) {
        assert_eq!(s0.total_points, 288);
        assert_eq!(s1.total_points, 288 + 288 + 576);
        // Rows are ascending and the test rows are scored.
        assert!(s1.rows.windows(2).all(|w| w[0] < w[1]));
        let at = s1.rows.iter().position(|&r| r == 800).unwrap();
        assert!(s1.score.as_ref().unwrap()[at].is_some());
    } else {
        unreachable!()
    }
    assert!(a["test_validation"].is_null());
}

// ---------- the lazy test-row predictions of compute_health_preview ----------

fn rel_state() -> (AppState, ColumnarData) {
    let d = rel_data();
    let state = state_with(rel_data());
    let stamp = session_stamp(&state).unwrap().unwrap();
    assert!(store_rel_fit(&state, stamp, "m1::fp".into(), rel_fit(&d)));
    (state, d)
}

#[test]
fn only_test_rows_without_a_cached_prediction_are_planned_and_edits_never_run_again() {
    let (state, d) = rel_state();
    let req = rel_req(vec![tp(288, 431)]);
    let job = plan_rel_extra(&state, &req).unwrap().expect("new test rows need a prediction run");
    assert_eq!(job.rows, (288..432).collect::<Vec<u32>>());
    assert_eq!(job.x.len(), 288, "the model is refitted on the TRAIN rows only");
    assert_eq!(job.y.len(), 288);
    assert_eq!(job.x_extra.len(), 144);
    assert_eq!(job.x_extra[0], vec![d.columns[1][288]]);
    // Before the predictions arrive the preview still answers (test rows left out).
    let p = health_preview_in(&state, &req).unwrap();
    assert_eq!(tv(&p).tests[0].rows, 0);
    // The sidecar's answer is stored under the fit's key...
    let preds: Vec<f64> = job.rows.iter().map(|&r| 2.0 * d.columns[1][r as usize]).collect();
    apply_rel_extra(&state, &job, &preds).unwrap();
    // ...and nothing more is planned for the same periods, whatever the set points.
    assert!(plan_rel_extra(&state, &req).unwrap().is_none());
    let mut edited = req.clone();
    edited.set_points = Some(SetPointsArg { residual_at_80_lower: Some(-6.0), ..rel_sp() });
    assert!(plan_rel_extra(&state, &edited).unwrap().is_none());
    let p = health_preview_in(&state, &edited).unwrap();
    assert_eq!(tv(&p).tests[0].rows, 144);
    assert_eq!(tv(&p).tests[0].scored, 144);
    // A longer period needs only the NEW rows.
    let longer = rel_req(vec![tp(288, 575)]);
    let job2 = plan_rel_extra(&state, &longer).unwrap().unwrap();
    assert_eq!(job2.rows, (432..576).collect::<Vec<u32>>());
    let preds2: Vec<f64> = job2.rows.iter().map(|&r| 2.0 * d.columns[1][r as usize]).collect();
    apply_rel_extra(&state, &job2, &preds2).unwrap();
    let p = health_preview_in(&state, &longer).unwrap();
    assert_eq!(tv(&p).tests[0].rows, 288, "old and new predictions are both used");
    // A period inside what is cached, and train-overlap rows, plan nothing.
    assert!(plan_rel_extra(&state, &rel_req(vec![tp(100, 400)])).unwrap().is_none());
}

#[test]
fn nothing_is_planned_without_test_periods_or_without_a_fit_and_stale_results_are_refused() {
    let (state, d) = rel_state();
    assert!(plan_rel_extra(&state, &rel_req(vec![])).unwrap().is_none());
    let mut other = rel_req(vec![tp(288, 431)]);
    other.cache_key = Some("unknown".into());
    assert!(plan_rel_extra(&state, &other).unwrap().is_none());
    assert!(health_preview_in(&state, &other).unwrap_err().starts_with("NOT_FITTED"));
    other.cache_key = None;
    assert!(plan_rel_extra(&state, &other).unwrap().is_none());
    let mut wrong_target = rel_req(vec![tp(288, 431)]);
    wrong_target.target = Some("X".into());
    assert!(plan_rel_extra(&state, &wrong_target).unwrap().is_none());
    // The generation guard applies.
    let mut stale = rel_req(vec![tp(288, 431)]);
    stale.expected_generation = Some(99);
    assert!(plan_rel_extra(&state, &stale).unwrap_err().starts_with("STALE_SESSION"));
    // A result that straddles a special-sensor change (cache cleared) is dropped.
    let job = plan_rel_extra(&state, &rel_req(vec![tp(288, 431)])).unwrap().unwrap();
    state.0.write().unwrap().as_mut().unwrap().rel_cache.clear();
    let preds: Vec<f64> = job.rows.iter().map(|&r| 2.0 * d.columns[1][r as usize]).collect();
    assert!(apply_rel_extra(&state, &job, &preds).unwrap_err().starts_with("NOT_FITTED"));
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

// ---------- Train pre-warm (preview_relationship_model + test_periods) ----------

/// What the sidecar's `preview_relationship` returns for the 288 training rows
/// (+ `predicted_extra` for `extra` when given).
fn train_response(d: &ColumnarData, extra: Option<&[u32]>) -> serde_json::Value {
    let preds: Vec<f64> = (0..2 * DAY).map(|r| 2.0 * d.columns[1][r]).collect();
    let resid: Vec<f64> = (0..2 * DAY).map(|r| d.columns[2][r] - preds[r]).collect();
    let mut v = serde_json::json!({
        "request": "PreviewModel/relationship",
        "r2_per_step": [0.9],
        "rmse2_per_step": [2.0],
        "predicted": preds,
        "residual": resid,
    });
    if let Some(rows) = extra {
        let pe: Vec<f64> = rows.iter().map(|&r| 2.0 * d.columns[1][r as usize]).collect();
        v["predicted_extra"] = serde_json::json!(pe);
    }
    v
}

/// The Train call's tail (`finish_relationship_response_ex`) over a fresh session.
fn finish_train(state: &AppState, d: &ColumnarData, parsed: serde_json::Value, extra_rows: &[u32]) -> serde_json::Value {
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
        extra_rows,
        &|_| {},
    )
    .unwrap()
}

#[test]
fn train_and_the_lazy_prediction_choose_the_same_test_rows() {
    // One function picks them: what the Train would send as X_extra equals what
    // the preview's own job would ask the sidecar for (both: finite inputs,
    // inside a test period, not a training row).
    let (state, d) = rel_state();
    let tests = vec![tp(144, 431), tp(576, 600)];
    let plan = crate::health_validation::TestPlan::resolve(&tests, Some(&train_to(2 * DAY - 1, vec![])), &d.headers);
    let train_rows: Vec<u32> = (0..2 * DAY as u32).collect();
    let rows = crate::health_validation::extra_test_rows(&plan, &d, 2, &[1], &train_rows);
    let job = plan_rel_extra(&state, &rel_req(tests)).unwrap().unwrap();
    assert_eq!(rows, job.rows);
    assert_eq!(rows.first(), Some(&288), "training rows 144..287 are not predicted again");
    assert_eq!(rows.len(), (288..432).count() + (576..=600).count());
    assert_eq!(crate::health_validation::x_rows(&d, &[1], &rows), job.x_extra);
}

#[test]
fn train_prewarm_seeds_the_predictions_so_the_next_preview_needs_no_sidecar() {
    let d = rel_data();
    let state = state_with(rel_data());
    let extra_rows: Vec<u32> = (288..576).collect();
    let resp = finish_train(&state, &d, train_response(&d, Some(&extra_rows)), &extra_rows);
    assert_eq!(resp["cached"], true);
    assert!(resp.get("predicted_extra").is_none(), "the unbounded predictions are never shipped");
    assert!(resp.get("health_preview").is_some(), "the train answer is unchanged");
    // Seeded under the fit's key...
    let seeded = state.0.read().unwrap().as_ref().unwrap().rel_cache.peek_extra("m1::fp").unwrap();
    assert_eq!(seeded.rows, extra_rows);
    // ...so the preview's planner has nothing left to predict = no sidecar call.
    let req = rel_req(vec![tp(288, 575)]);
    assert!(plan_rel_extra(&state, &req).unwrap().is_none());
    let p = health_preview_in(&state, &req).unwrap();
    assert_eq!((tv(&p).tests[0].rows, tv(&p).tests[0].scored), (288, 288));
    // Same numbers as when the predictions arrive the lazy way.
    let (lazy_state, _) = rel_state();
    let job = plan_rel_extra(&lazy_state, &req).unwrap().unwrap();
    apply_rel_extra(&lazy_state, &job, &extra_rows.iter().map(|&r| 2.0 * d.columns[1][r as usize]).collect::<Vec<_>>()).unwrap();
    let lazy = health_preview_in(&lazy_state, &req).unwrap();
    assert_eq!(serde_json::to_value(&p).unwrap(), serde_json::to_value(&lazy).unwrap());
    // A longer period needs only the rows the pre-warm did not cover.
    let longer = rel_req(vec![tp(288, 719)]);
    assert_eq!(plan_rel_extra(&state, &longer).unwrap().unwrap().rows, (576..720).collect::<Vec<u32>>());
}

#[test]
fn train_without_prewarm_is_exactly_as_before() {
    let d = rel_data();
    let state = state_with(rel_data());
    // No extra rows asked for: nothing is stored even if the answer carries some.
    let stray: Vec<u32> = (288..300).collect();
    let resp = finish_train(&state, &d, train_response(&d, Some(&stray)), &[]);
    assert_eq!(resp["cached"], true);
    assert!(resp.get("predicted_extra").is_none());
    assert!(state.0.read().unwrap().as_ref().unwrap().rel_cache.peek_extra("m1::fp").is_none());
    // An old sidecar that ignores X_extra (no predicted_extra) / a wrong length: no seed, no failure.
    let state = state_with(rel_data());
    let rows: Vec<u32> = (288..576).collect();
    let resp = finish_train(&state, &d, train_response(&d, None), &rows);
    assert_eq!(resp["cached"], true);
    assert!(state.0.read().unwrap().as_ref().unwrap().rel_cache.peek_extra("m1::fp").is_none());
    let state = state_with(rel_data());
    let resp = finish_train(&state, &d, train_response(&d, Some(&rows[..10])), &rows);
    assert_eq!(resp["cached"], true);
    assert!(state.0.read().unwrap().as_ref().unwrap().rel_cache.peek_extra("m1::fp").is_none());
    // The lazy path then still works for those rows.
    assert!(plan_rel_extra(&state, &rel_req(vec![tp(288, 575)])).unwrap().is_some());
}

#[test]
fn train_prewarm_is_not_stored_for_a_fit_that_was_not_cached() {
    let d = rel_data();
    let state = state_with(rel_data());
    // The dataset's derived state changes while the sidecar ran: nothing is cached or seeded.
    let stamp = session_stamp(&state).unwrap().unwrap();
    state.0.write().unwrap().as_mut().unwrap().rel_cache.clear();
    let rows: Vec<u32> = (0..2 * DAY as u32).collect();
    let extra_rows: Vec<u32> = (288..300).collect();
    let y: Vec<f64> = rows.iter().map(|&r| d.columns[2][r as usize]).collect();
    let x: Vec<Vec<f64>> = rows.iter().map(|&r| vec![d.columns[1][r as usize]]).collect();
    let resp = crate::finish_relationship_response_ex(
        &state, stamp, train_response(&d, Some(&extra_rows)), &["X".to_string()], "Y", 1.0,
        &rows, &y, &x, Some("m1::fp".into()), Some(100), &extra_rows, &|_| {},
    )
    .unwrap();
    assert_eq!(resp["cached"], false);
    assert!(state.0.read().unwrap().as_ref().unwrap().rel_cache.peek_extra("m1::fp").is_none());
}

// ---------- a failed test-row prediction degrades, never fails ----------

#[test]
fn failed_prediction_gives_the_train_preview_with_unscored_tests_and_one_warning() {
    let (state, _d) = rel_state();
    let tests = vec![tp(288, 575), tp(144, 431)];
    let req = rel_req(tests);
    // What a sidecar crash looks like to the caller.
    let crash = parse_predicted_extra(&serde_json::json!({ "error": "boom: C:\\build\\x.py line 3" }), 1).unwrap_err();
    assert!(crash.contains("boom"), "the raw reason only goes to the log");
    let p = crate::health_preview_with_outcome(&state, &req, Some(TestScoringFailure::EngineError)).unwrap();
    // Train part intact: the very same answer as without test periods.
    let plain = health_preview_in(&state, &rel_req(vec![])).unwrap();
    let (a, b) = (serde_json::to_value(&plain).unwrap(), serde_json::to_value(&p).unwrap());
    for key in ["stats", "series", "score_summary", "fit_scatter", "valid"] {
        assert_eq!(a[key], b[key], "{key}");
    }
    assert!(p.valid, "a warning never invalidates the set points");
    // Test block present, every test unscored, metrics omitted, nullable fields null.
    let v = &b["test_validation"];
    assert_eq!(v["train"]["rows"], 288);
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
    assert!(!w[0].message.contains("boom") && !w[0].message.contains("C:\\"));
    assert!(!w[0].message.contains(".sh") && !w[0].message.contains("src-tauri"));
    // No failure: the same request with no error has no such warning.
    let ok = crate::health_preview_with_outcome(&state, &req, None).unwrap();
    assert!(ok.validation.iter().all(|i| i.code != "test_scoring_failed"));
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
    assert_eq!((w.severity, w.field.as_str()), (crate::health_score::Severity::Warning, "test_periods"));
    assert!(p.validation.iter().all(|i| i.code != "test_scoring_failed"), "never both codes");
    assert!(tv(&p).tests.iter().all(|t| t.scored == 0));
    // An Individual preview has no prediction step and is never touched.
    let d = ind_data(0, 0..0);
    let st = state_with(d);
    let ip = crate::health_preview_with_outcome(&st, &ind_req(vec![tp(288, 575)], None), None).unwrap();
    assert!(ip.validation.iter().all(|i| i.code != "test_scoring_failed"));
}

#[test]
fn predictions_over_the_cache_budget_are_reported_not_stored_and_not_an_error() {
    let d = rel_data();
    let state = state_with(rel_data());
    // Fits the 288-row fit (8064 bytes) but not its 144 predictions on top (+1728).
    state.0.write().unwrap().as_mut().unwrap().rel_cache = crate::health_score::RelCache::new(8, 8100);
    let stamp = session_stamp(&state).unwrap().unwrap();
    assert!(store_rel_fit(&state, stamp, "m1::fp".into(), rel_fit(&d)));
    let req = rel_req(vec![tp(288, 431)]);
    let job = plan_rel_extra(&state, &req).unwrap().unwrap();
    let preds: Vec<f64> = job.rows.iter().map(|&r| 2.0 * d.columns[1][r as usize]).collect();
    assert_eq!(apply_rel_extra(&state, &job, &preds), Ok(crate::ExtraStored::OverBudget), "still fitted, but no room");
    assert!(state.0.read().unwrap().as_ref().unwrap().rel_cache.peek("m1::fp").is_some());
    // The caller turns that into the degraded answer, with its own wording.
    let p = crate::health_preview_with_outcome(&state, &req, Some(TestScoringFailure::OverBudget)).unwrap();
    let w = p.validation.iter().find(|i| i.code == "test_scoring_too_large").unwrap();
    assert!(p.validation.iter().all(|i| i.code != "test_scoring_failed"), "never both codes");
    assert!(w.message.contains("too many rows to score in memory"), "{}", w.message);
    assert!(!w.message.contains("did not answer"));
    // A fit that is really gone is still NOT_FITTED.
    state.0.write().unwrap().as_mut().unwrap().rel_cache.clear();
    assert!(apply_rel_extra(&state, &job, &preds).unwrap_err().starts_with("NOT_FITTED"));
}

#[test]
fn unscored_tests_still_report_their_rows_and_days() {
    // A period fully outside the training scope has no
    // prediction after a failure; it must not report 0 rows / 0 days.
    let (state, _d) = rel_state();
    let req = rel_req(vec![tp(288, 575), tp(144, 431)]);
    let p = crate::health_preview_with_outcome(&state, &req, Some(TestScoringFailure::EngineError)).unwrap();
    let t = &tv(&p).tests;
    assert_eq!((t[0].rows, t[0].days, t[0].scored), (288, 2.0, 0));
    assert_eq!((t[1].rows, t[1].days, t[1].train_rows, t[1].scored), (288, 2.0, 144, 0));
}

// ---------- score_test_rows: lock scope, remembered failures, retry ----------

use crate::{score_test_rows, ExtraPlan, RelExtraJob, TestScoringError};
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::task::{Context, Poll, Waker};

type RunResult = (RelExtraJob, Result<Vec<f64>, String>);

/// A runner that answers with Y = 2X for every job row (counts its calls).
fn good_runner<'a>(d: &ColumnarData, calls: &'a AtomicUsize) -> impl FnOnce(RelExtraJob) -> std::future::Ready<RunResult> + 'a {
    let x = d.columns[1].clone();
    move |job: RelExtraJob| {
        calls.fetch_add(1, Ordering::SeqCst);
        let preds = job.rows.iter().map(|&r| 2.0 * x[r as usize]).collect();
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
fn a_fully_cached_preview_is_planned_without_waiting_for_the_prediction_lock() {
    let (state, d) = rel_state();
    let serial = tauri::async_runtime::Mutex::new(());
    let outdated = AtomicBool::new(false);
    let calls = AtomicUsize::new(0);
    let req = rel_req(vec![tp(288, 431)]);
    // Fill the predictions once.
    assert_eq!(block_on(score_test_rows(&state, &req, &serial, &outdated, good_runner(&d, &calls), &|_| {})), Ok(None));
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    // Another model's prediction run holds the lock...
    let held = serial.try_lock().unwrap();
    // ...a preview whose rows are all cached answers on the FIRST poll.
    let mut cx = Context::from_waker(Waker::noop());
    let fut = std::pin::pin!(score_test_rows(&state, &req, &serial, &outdated, good_runner(&d, &calls), &|_| {}));
    assert_eq!(fut.poll(&mut cx), Poll::Ready(Ok(None)), "must not wait for the lock");
    assert_eq!(calls.load(Ordering::SeqCst), 1, "no sidecar run");

    // A preview that needs NEW rows does wait for it...
    let longer = rel_req(vec![tp(288, 575)]);
    let mut fut = std::pin::pin!(score_test_rows(&state, &longer, &serial, &outdated, good_runner(&d, &calls), &|_| {}));
    assert!(fut.as_mut().poll(&mut cx).is_pending(), "a run needs the lock");
    // ...and runs once it is free.
    drop(held);
    assert_eq!(block_on(fut), Ok(None));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert!(crate::plan_rel_extra(&state, &longer).unwrap().is_none());
}

#[test]
fn the_planning_split_builds_the_job_only_when_asked() {
    let (state, _d) = rel_state();
    let req = rel_req(vec![tp(288, 431)]);
    assert!(matches!(crate::plan_rel_extra_ex(&state, &req, false, false).unwrap(), ExtraPlan::Needed(None)));
    match crate::plan_rel_extra_ex(&state, &req, false, true).unwrap() {
        ExtraPlan::Needed(Some(job)) => assert_eq!(job.rows, (288..432).collect::<Vec<u32>>()),
        other => panic!("expected a job, got {other:?}"),
    }
    // Outdated sidecar: rows are missing, but nothing is to be run.
    match crate::plan_rel_extra_ex(&state, &req, true, true).unwrap() {
        ExtraPlan::Failed(e) => assert!(e.reason.starts_with("SIDECAR_OUTDATED") && e.kind == TestScoringFailure::Outdated),
        other => panic!("{other:?}"),
    }
    // Nothing missing -> Nothing, whatever the flags.
    assert!(matches!(crate::plan_rel_extra_ex(&state, &rel_req(vec![tp(0, 100)]), true, true).unwrap(), ExtraPlan::Nothing));
    // The generation guard still applies to the lock-free look.
    let mut stale = req.clone();
    stale.expected_generation = Some(99);
    assert!(crate::plan_rel_extra_ex(&state, &stale, false, false).unwrap_err().starts_with("STALE_SESSION"));
}

#[test]
fn a_failed_attempt_is_logged_remembered_and_retried_only_on_request() {
    let (state, d) = rel_state();
    let serial = tauri::async_runtime::Mutex::new(());
    let outdated = AtomicBool::new(false);
    let calls = AtomicUsize::new(0);
    let logged = std::sync::Mutex::new(Vec::<String>::new());
    let log = |s: &str| logged.lock().unwrap().push(s.to_string());
    let req = rel_req(vec![tp(288, 431)]);

    // 1. The sidecar fails: the raw reason is returned and logged, the fit is marked.
    let r = block_on(score_test_rows(&state, &req, &serial, &outdated, failing_runner("boom at C:\\x.py", &calls), &log));
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
    let r = block_on(score_test_rows(&state, &req, &serial, &outdated, failing_runner("again", &calls), &log)).unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1, "no second sidecar run");
    assert_eq!(logged.lock().unwrap().len(), 1, "nothing new to log");
    let e = r.expect("still reported as not scored");
    assert_eq!(e.kind, TestScoringFailure::EngineError, "the remembered kind");
    let p = crate::health_preview_with_outcome(&state, &req, Some(e.kind)).unwrap();
    let w = p.validation.iter().find(|i| i.code == "test_scoring_failed").unwrap();
    assert!(!w.message.contains("out of date"), "generic wording: {}", w.message);
    assert!(tv(&p).tests.iter().all(|t| t.scored == 0));

    // 3. An explicit retry (the "Try again" button) runs it once more.
    let mut retry = req.clone();
    retry.retry_test_scoring = true;
    assert_eq!(block_on(score_test_rows(&state, &retry, &serial, &outdated, good_runner(&d, &calls), &log)), Ok(None));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert!(!has_marker(&state, "m1::fp"));
    let p = crate::health_preview_with_outcome(&state, &req, None).unwrap();
    assert_eq!(tv(&p).tests[0].scored, 144);
}

#[test]
fn a_retrain_clears_the_failed_marker() {
    let (state, d) = rel_state();
    let serial = tauri::async_runtime::Mutex::new(());
    let outdated = AtomicBool::new(false);
    let calls = AtomicUsize::new(0);
    let req = rel_req(vec![tp(288, 431)]);
    block_on(score_test_rows(&state, &req, &serial, &outdated, failing_runner("boom", &calls), &|_| {})).unwrap();
    assert!(matches!(crate::plan_rel_extra_ex(&state, &req, false, false).unwrap(), ExtraPlan::Failed(_)));
    // Train again (same key): a fresh fit, a fresh attempt.
    let stamp = session_stamp(&state).unwrap().unwrap();
    assert!(store_rel_fit(&state, stamp, "m1::fp".into(), rel_fit(&d)));
    assert!(matches!(crate::plan_rel_extra_ex(&state, &req, false, false).unwrap(), ExtraPlan::Needed(None)));
    assert_eq!(block_on(score_test_rows(&state, &req, &serial, &outdated, good_runner(&d, &calls), &|_| {})), Ok(None));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[test]
fn an_outdated_sidecar_is_remembered_for_the_process_not_per_fit() {
    let (state, d) = rel_state();
    let serial = tauri::async_runtime::Mutex::new(());
    let outdated = AtomicBool::new(false);
    let calls = AtomicUsize::new(0);
    let req = rel_req(vec![tp(288, 431)]);
    let old = parse_predicted_extra(&serde_json::json!({ "error": "Unknown action: 'predict_relationship'" }), 1).unwrap_err();
    let r = block_on(score_test_rows(&state, &req, &serial, &outdated, failing_runner(&old, &calls), &|_| {})).unwrap();
    let e = r.unwrap();
    assert!(e.reason.starts_with("SIDECAR_OUTDATED") && e.kind == TestScoringFailure::Outdated);
    assert!(outdated.load(Ordering::SeqCst));
    assert!(!has_marker(&state, "m1::fp"), "the flag, not the marker");
    // Any later run is skipped - also another fit, also on retry.
    let stamp = session_stamp(&state).unwrap().unwrap();
    assert!(store_rel_fit(&state, stamp, "m2::fp".into(), rel_fit(&d)));
    let mut other = rel_req(vec![tp(288, 431)]);
    other.cache_key = Some("m2::fp".into());
    other.retry_test_scoring = true;
    for r in [&req, &other] {
        let e = block_on(score_test_rows(&state, r, &serial, &outdated, good_runner(&d, &calls), &|_| {})).unwrap().unwrap();
        assert!(e.reason.starts_with("SIDECAR_OUTDATED") && e.kind == TestScoringFailure::Outdated);
    }
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    // Fully cached periods (here: inside the training rows) need no sidecar: no warning.
    let inside = rel_req(vec![tp(0, 200)]);
    assert_eq!(block_on(score_test_rows(&state, &inside, &serial, &outdated, good_runner(&d, &calls), &|_| {})), Ok(None));
}

#[test]
fn over_budget_predictions_are_remembered_like_a_failure() {
    let d = rel_data();
    let state = state_with(rel_data());
    state.0.write().unwrap().as_mut().unwrap().rel_cache = crate::health_score::RelCache::new(8, 8100);
    let stamp = session_stamp(&state).unwrap().unwrap();
    assert!(store_rel_fit(&state, stamp, "m1::fp".into(), rel_fit(&d)));
    let serial = tauri::async_runtime::Mutex::new(());
    let outdated = AtomicBool::new(false);
    let calls = AtomicUsize::new(0);
    let logged = std::sync::Mutex::new(Vec::<String>::new());
    let req = rel_req(vec![tp(288, 431)]);
    let r = block_on(score_test_rows(&state, &req, &serial, &outdated, good_runner(&d, &calls), &|s| logged.lock().unwrap().push(s.into()))).unwrap();
    let e = r.unwrap();
    assert!(e.reason.contains("do not fit the model cache") && e.kind == TestScoringFailure::OverBudget);
    assert!(logged.lock().unwrap()[0].contains("144 test rows"));
    let again = block_on(score_test_rows(&state, &req, &serial, &outdated, good_runner(&d, &calls), &|_| {})).unwrap();
    assert_eq!(again.map(|e| e.kind), Some(TestScoringFailure::OverBudget), "remembered with its own wording");
    assert_eq!(calls.load(Ordering::SeqCst), 1, "not predicted again");
    // The natural fix - a shorter test period - is tried again (and here fits).
    let shorter = rel_req(vec![tp(288, 289)]);
    assert_eq!(block_on(score_test_rows(&state, &shorter, &serial, &outdated, good_runner(&d, &calls), &|_| {})), Ok(None));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

fn has_marker(state: &AppState, key: &str) -> bool {
    state.0.read().unwrap().as_ref().unwrap().rel_cache.has_failed_marker(key)
}

#[test]
fn a_remembered_failure_applies_only_to_the_same_missing_rows() {
    // The failed marker is per set of missing rows, not per fit: after a
    // failure a change of the test periods must not answer "failed" at once.
    let (state, d) = rel_state();
    let serial = tauri::async_runtime::Mutex::new(());
    let outdated = AtomicBool::new(false);
    let calls = AtomicUsize::new(0);
    let t1 = rel_req(vec![tp(288, 431)]);
    assert!(block_on(score_test_rows(&state, &t1, &serial, &outdated, failing_runner("boom", &calls), &|_| {})).unwrap().is_some());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    // Same rows (a set-point edit): remembered, no run.
    assert!(block_on(score_test_rows(&state, &t1, &serial, &outdated, failing_runner("x", &calls), &|_| {})).unwrap().is_some());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    // T2 added: other rows -> one fresh attempt (fails again here).
    let t1_t2 = rel_req(vec![tp(288, 431), tp(576, 700)]);
    assert!(block_on(score_test_rows(&state, &t1_t2, &serial, &outdated, failing_runner("boom 2", &calls), &|_| {})).unwrap().is_some());
    assert_eq!(calls.load(Ordering::SeqCst), 2, "a superset runs again");
    // ...and THAT set is now the remembered one.
    assert!(block_on(score_test_rows(&state, &t1_t2, &serial, &outdated, failing_runner("x", &calls), &|_| {})).unwrap().is_some());
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    // A period shortened: runs again (and succeeds).
    let shrunk = rel_req(vec![tp(288, 300)]);
    assert_eq!(block_on(score_test_rows(&state, &shrunk, &serial, &outdated, good_runner(&d, &calls), &|_| {})), Ok(None));
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
    let e = block_on(score_test_rows(&state, &req, &serial, &outdated, failing_runner(&huge, &calls), &|s| logged.lock().unwrap().push(s.into())))
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
    assert!(block_on(score_test_rows(&state, &req, &serial, &outdated, failing_runner("boom", &calls), &log)).unwrap().is_some());
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
    let x = d.columns[1].clone();
    let r = block_on(score_test_rows(&state, &req, &serial, &outdated, |job: RelExtraJob| {
        retrain();
        let preds = job.rows.iter().map(|&r| 2.0 * x[r as usize]).collect();
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
    let r = block_on(score_test_rows(&state, &req, &serial, &outdated, |job: RelExtraJob| {
        retrain();
        std::future::ready((job, Err("boom".to_string())))
    }, &|_| {}))
    .unwrap();
    assert!(r.is_some());
    assert!(!has_marker(&state, "m1::fp"), "the failure belongs to the OLD fit");
    // c) The re-train pre-warmed the new fit's test rows: answer for it, all scored.
    let r = block_on(score_test_rows(&state, &req, &serial, &outdated, |job: RelExtraJob| {
        retrain();
        let new_fit = {
            let lock = state.0.read().unwrap();
            std::sync::Arc::downgrade(&lock.as_ref().unwrap().rel_cache.peek("m1::fp").unwrap())
        };
        let stamp = session_stamp(&state).unwrap().unwrap();
        let preds: Vec<f64> = job.rows.iter().map(|&r| 2.0 * x[r as usize]).collect();
        assert_eq!(crate::merge_rel_extra(&state, stamp, "m1::fp", &new_fit, &job.rows, &preds), crate::ExtraStored::Stored);
        std::future::ready((job, Ok(vec![-1.0; preds.len()])))
    }, &|_| {}))
    .unwrap();
    assert_eq!(r, None);
    let p = crate::health_preview_with_outcome(&state, &req, None).unwrap();
    assert_eq!(tv(&p).tests[0].scored, 144);
    let lock = state.0.read().unwrap();
    let extra = lock.as_ref().unwrap().rel_cache.peek_extra("m1::fp").unwrap();
    assert!(extra.get(300).unwrap() > 0.0, "the new fit's predictions, not the old run's -1");
}

#[test]
fn other_kinds_and_requests_without_tests_never_touch_the_sidecar() {
    let (state, d) = rel_state();
    let serial = tauri::async_runtime::Mutex::new(());
    let outdated = AtomicBool::new(false);
    let calls = AtomicUsize::new(0);
    assert_eq!(block_on(score_test_rows(&state, &rel_req(vec![]), &serial, &outdated, good_runner(&d, &calls), &|_| {})), Ok(None));
    let mut ind = rel_req(vec![tp(288, 431)]);
    ind.kind = "individual".into();
    assert_eq!(block_on(score_test_rows(&state, &ind, &serial, &outdated, good_runner(&d, &calls), &|_| {})), Ok(None));
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
fn the_preview_and_the_prediction_step_select_the_same_test_rows() {
    // relationship_preview_ex uses the shared selection.
    let d = rel_data();
    let fit = rel_fit(&d);
    let tests = vec![tp(144, 431), tp(576, 600)];
    let plan = crate::health_validation::TestPlan::resolve(&tests, Some(&train_to(2 * DAY - 1, vec![])), &d.headers);
    let rows = crate::health_validation::extra_test_rows(&plan, &d, 2, &[1], &fit.rows);
    let extra = rel_extra(&d, rows.iter().copied());
    let p = relationship_preview_ex(&d, &fit, Some(&extra), &rel_req(tests)).unwrap();
    match &p.series {
        HealthSeries::Relationship(s) => assert_eq!(s.total_points, fit.rows.len() + rows.len()),
        _ => unreachable!(),
    }
    let t = &tv(&p).tests;
    assert_eq!((t[0].rows, t[0].train_rows, t[0].scored), (288, 144, 288));
    assert_eq!((t[1].rows, t[1].scored), (25, 25));
}

// ---------- the export still refuses what it cannot validate ----------

#[test]
fn export_never_claims_a_validation_it_could_not_compute() {
    use crate::export_extra_predictions as ex;
    // No test rows: nothing to predict, nothing required.
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
/// shifted by +100 (far outside any ring). C is the criteria sensor.
fn clu_data() -> ColumnarData {
    let n = 10 * DAY;
    let x: Vec<f64> = (0..n)
        .map(|i| 10.0 + (((i * 37) % 11) as f64 - 5.0) * 0.2 + if i >= STEP_ROW { 100.0 } else { 0.0 })
        .collect();
    let y: Vec<f64> = (0..n).map(|i| 20.0 + (((i * 17) % 13) as f64 - 6.0) * 0.1).collect();
    let c: Vec<f64> = (0..n).map(|i| if i % 2 == 0 { 5.0 } else { 15.0 }).collect();
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
    assert_eq!((v.train.rows, v.train.days), (288, 2.0));
    assert_eq!(v.train.metrics.inside_3sd_ring_pct, Some(100.0));
    let n = &v.tests[0];
    assert_eq!((n.rows, n.days, n.scored, n.train_rows), (288, 2.0, 288, 0));
    assert_eq!(n.metrics.inside_3sd_ring_pct, Some(100.0));
    assert_eq!(n.pct_below_80, Some(0.0));
    assert!(n.lowest.unwrap() >= 80.0, "inside the 3 SD ring throughout: {:?}", n.lowest);
    let k = &v.tests[1];
    assert_eq!((k.rows, k.scored), (576, 576));
    // 200 rows before the shift are inside the ring, the 376 shifted ones are far outside.
    assert_eq!(k.metrics.inside_3sd_ring_pct, Some(34.7));
    assert_eq!(k.pct_below_80, Some(65.3));
    assert_eq!(k.lowest, Some(0.0), "the plateau beyond the outer ring scores 0 and is held for 1 h");
    assert_eq!(k.lowest_at.as_deref(), Some(ts_at(STEP_ROW).as_str()));
    assert!(k.metrics.r2.is_none() && k.metrics.within_3sd_pct.is_none());
    assert_eq!((n.index, k.index), (1, 2));
    // Only the scoring facts and the Clustering metric are on the wire.
    let j = serde_json::to_value(k).unwrap();
    let mut keys: Vec<&str> = j.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec![
            "days", "end", "index", "inside_3sd_ring_pct", "lowest", "lowest_at", "pct_below_80", "rows", "scored",
            "start", "train_days", "train_rows",
        ]
    );
}

#[test]
fn clustering_rows_in_no_criteria_range_are_not_scored_and_not_counted_inside() {
    // Criteria ranges [None,10) and [20,None): the C = 15 rows are unassigned.
    let d = clu_data();
    let mut r = clu_req(vec![tp(288, 575)], 2);
    r.cluster_ranges = Some(vec![
        ClusterRange { min: None, max: Some(10.0) },
        ClusterRange { min: Some(20.0), max: None },
    ]);
    // The second cluster has no training row -> the fit is refused (NO_DATA) as before.
    assert!(clustering_preview(&d, &r).unwrap_err().starts_with("NO_DATA"));
    // Three-way criteria: ranges cover C = 5 and C = 100 only.
    let n = 10 * DAY;
    let c: Vec<f64> = (0..n).map(|i| [5.0, 15.0, 100.0][i % 3]).collect();
    let x: Vec<f64> = (0..n)
        .map(|i| [10.0, 40.0, 70.0][i % 3] + (((i * 37) % 11) as f64 - 5.0) * 0.2)
        .collect();
    let y: Vec<f64> = (0..n)
        .map(|i| [20.0, 50.0, 80.0][i % 3] + (((i * 17) % 13) as f64 - 6.0) * 0.1)
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
    assert_eq!(t.scored, 192, "only the assigned (C = 5 or 100) rows are scored");
    assert_eq!(t.metrics.inside_3sd_ring_pct, Some(100.0));
    let st = match &p.stats {
        HealthStats::Clustering(s) => s,
        _ => unreachable!(),
    };
    assert_eq!(st.rows, 288);
    assert_eq!(st.assigned_rows + st.unassigned_rows, 288);
}

#[test]
fn clustering_overlap_and_training_summary_stay_training_only() {
    let d = clu_data();
    let base = clustering_preview(&d, &clu_req(vec![], 1)).unwrap();
    let with = clustering_preview(&d, &clu_req(vec![tp(144, 431)], 1)).unwrap();
    let t = &tv(&with).tests[0];
    assert_eq!((t.rows, t.train_rows, t.train_days), (288, 144, 1.0));
    let (a, b) = (serde_json::to_value(&base).unwrap(), serde_json::to_value(&with).unwrap());
    assert_eq!(a["stats"], b["stats"]);
    assert_eq!(a["score_summary"], b["score_summary"]);
    assert_eq!(a["cluster_scatter"], b["cluster_scatter"], "the scatter shows the training rows");
    assert!(a["test_validation"].is_null());
    // Test rows outside the training period are part of the scored series.
    if let HealthSeries::Clustering(s) = &with.series {
        assert_eq!(s.total_points, 432);
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

fn ind_export(tests: Vec<TestPeriodArg>, sp: SetPointsArg) -> ModelFilesRequest {
    ModelFilesRequest {
        kind: "individual".into(),
        workspace_id: "ws".into(),
        target: Some("S".into()),
        filter: Some(train_to(2 * DAY - 1, vec![])),
        set_points: Some(sp),
        test_periods: if tests.is_empty() { None } else { Some(tests) },
        ..Default::default()
    }
}

#[test]
fn individual_export_adds_a_validation_block_and_keeps_every_existing_key() {
    let d = ind_data(400, 0..0);
    let sp = ind_sp(&d);
    let tests = vec![tp(288, 575), tp(576, 1151)];

    let plain_dir = tempfile::tempdir().unwrap();
    let r0 = export_sync(&d, &ind_export(vec![], sp.clone()), plain_dir.path()).unwrap();
    assert!(r0.ok);
    let plain = read_json(Path::new(&r0.files[0].path));
    assert!(plain.get("validation").is_none(), "no test periods = no validation block");

    let dir = tempfile::tempdir().unwrap();
    let r = export_sync(&d, &ind_export(tests.clone(), sp.clone()), dir.path()).unwrap();
    assert!(r.ok, "{:?}", r.validation);
    assert_eq!(r.files.len(), 1);
    let doc = read_json(Path::new(&r.files[0].path));
    assert_eq!(comparable(doc.clone()), comparable(plain), "every existing key is untouched");

    let v = &doc["validation"];
    assert_eq!(v["tested"], true);
    chrono::DateTime::parse_from_rfc3339(v["validated_at"].as_str().unwrap()).expect("RFC 3339");
    assert_eq!(v["train_ranges"][0]["start"], ts_at(0));
    assert_eq!(v["train_ranges"][0]["end"], ts_at(2 * DAY - 1));
    assert_eq!(v["train"]["rows"], 288);
    let tests_json = v["tests"].as_array().unwrap();
    assert_eq!(tests_json.len(), 2);
    for key in ["index", "start", "end", "rows", "days", "scored", "pct_below_80", "lowest", "lowest_at", "train_rows", "train_days", "within_3sd_pct", "mean_shift_sd"] {
        assert!(tests_json[1].get(key).is_some(), "{key}");
    }
    // Scoring periods are written as start -> end only: no label, no event time,
    // no lead time, no detection.
    for t in tests_json {
        for gone in ["label", "event_time", "lead_days", "first_below_80"] {
            assert!(t.get(gone).is_none(), "{gone} must not be written");
        }
    }
    assert_eq!((tests_json[0]["index"].clone(), tests_json[1]["index"].clone()), (1.into(), 2.into()));
    assert_eq!(tests_json[1]["start"], ts_at(576));
    assert_eq!(tests_json[1]["end"], ts_at(1151));
    assert_eq!(tests_json[1]["pct_below_80"], 65.3);
    assert_eq!(tests_json[1]["lowest_at"], ts_at(STEP_ROW));

    // The export is the SAME computation as the preview.
    let mut pr = ind_req(tests, Some(sp));
    pr.max_points = Some(8);
    let preview = individual_preview(&d, &pr).unwrap();
    assert_eq!(v["tests"], serde_json::to_value(&tv(&preview).tests).unwrap());
    assert_eq!(v["train"], serde_json::to_value(&tv(&preview).train).unwrap());
}

#[test]
fn export_refuses_malformed_test_periods_before_writing_anything() {
    let d = ind_data(400, 0..0);
    let sp = ind_sp(&d);
    let dir = tempfile::tempdir().unwrap();
    let bad = vec![tp(1151, 576)]; // ends before it starts
    let r = export_sync(&d, &ind_export(bad, sp.clone()), dir.path()).unwrap();
    assert!(!r.ok);
    assert!(r.files.is_empty());
    assert_eq!(r.validation[0].code, "test_ends_before_start");
    assert_eq!(r.validation[0].field, "test_period_1_end");
    assert!(std::fs::read_dir(dir.path()).unwrap().next().is_none(), "nothing was created");
    let bad_date = vec![TestPeriodArg { start: Some("not a date".into()), end: Some(ts_at(700)) }];
    let r = export_sync(&d, &ind_export(bad_date, sp), dir.path()).unwrap();
    assert!(!r.ok && r.files.is_empty());
    assert_eq!(r.validation[0].code, "test_start_unparseable");
    assert!(std::fs::read_dir(dir.path()).unwrap().next().is_none(), "nothing was created");
}

#[test]
fn clustering_export_keeps_both_criteria_spellings_and_adds_validation() {
    let d = clu_data();
    let tests = vec![tp(288, 575), tp(576, 1151)];
    let make = |tests: Vec<TestPeriodArg>| {
        let r = clu_req(tests.clone(), 2);
        ModelFilesRequest {
            kind: "clustering".into(),
            workspace_id: "ws".into(),
            first_sensor: r.first_sensor.clone(),
            second_sensor: r.second_sensor.clone(),
            n_clusters: r.n_clusters,
            criteria_sensor: r.criteria_sensor.clone(),
            cluster_ranges: r.cluster_ranges.clone(),
            filter: r.filter.clone(),
            set_points: r.set_points.clone(),
            test_periods: if tests.is_empty() { None } else { Some(tests) },
            ..Default::default()
        }
    };
    let d0 = tempfile::tempdir().unwrap();
    let r0 = export_sync(&d, &make(vec![]), d0.path()).unwrap();
    assert!(r0.ok, "{:?}", r0.validation);
    let plain = read_json(Path::new(&r0.files[0].path));
    let d1 = tempfile::tempdir().unwrap();
    let r1 = export_sync(&d, &make(tests), d1.path()).unwrap();
    assert!(r1.ok, "{:?}", r1.validation);
    let doc = read_json(Path::new(&r1.files[0].path));
    assert_eq!(comparable(doc.clone()), comparable(plain.clone()));
    // Both spellings of the criteria keys are still there, exactly as without tests.
    let text = serde_json::to_string(&doc).unwrap();
    assert!(text.contains("criteria_") && text.contains("critera_"), "{text}");
    assert_eq!(text.matches("critera_").count(), serde_json::to_string(&plain).unwrap().matches("critera_").count());
    let v = &doc["validation"];
    assert_eq!(v["tested"], true);
    assert_eq!(v["tests"].as_array().unwrap().len(), 2);
    assert!(v["tests"][0].get("inside_3sd_ring_pct").is_some());
    assert_eq!(v["tests"][1]["pct_below_80"], 65.3);
    assert!(!v.to_string().contains("lead_days") && !v.to_string().contains("label"));
}

#[test]
fn relationship_export_block_matches_the_preview_and_writes_into_the_info_file() {
    use crate::{write_relationship_outputs, RelationshipOutputs};
    let d = rel_data();
    let fit = rel_fit(&d);
    let extra = rel_extra(&d, 288..1152);
    let tests = vec![tp(288, 575), tp(576, 1151)];

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

    let req = ModelFilesRequest {
        kind: "relationship".into(),
        filter: Some(train_to(2 * DAY - 1, vec![])),
        set_points: Some(sp),
        test_periods: Some(tests.clone()),
        ..Default::default()
    };
    let block = crate::model_export::relationship_block(&d, &fit, &extra, &req).unwrap();
    crate::health_validation::inject_validation(&info_path, block).unwrap();
    let after = read_json(&info_path);
    assert_eq!(comparable(after.clone()), comparable(before.clone()), "every existing key is untouched");
    assert!(before.get("validation").is_none());

    let v = &after["validation"];
    assert_eq!(v["tested"], true);
    let preview = relationship_preview_ex(&d, &fit, Some(&extra), &rel_req(tests)).unwrap();
    assert_eq!(v["tests"], serde_json::to_value(&tv(&preview).tests).unwrap());
    assert_eq!(v["tests"][1]["lowest"], 48.0);
    assert_eq!(v["tests"][1]["lowest_at"], ts_at(STEP_ROW));
    for gone in ["label", "event_time", "lead_days", "first_below_80"] {
        assert!(!v.to_string().contains(gone), "{gone} must not be written");
    }
    assert!(v["tests"][0].get("r2").is_some() && v["tests"][0].get("residual_sd").is_some());
}

#[test]
fn relationship_export_plan_refuses_malformed_test_periods_before_the_sidecar() {
    let (state, _d) = rel_state();
    let dir = tempfile::tempdir().unwrap();
    let mut req = ModelFilesRequest {
        kind: "relationship".into(),
        workspace_id: "ws".into(),
        target: Some("Y".into()),
        predictors: vec!["X".into()],
        lambda: Some(1.0),
        filter: Some(train_to(2 * DAY - 1, vec![])),
        set_points: Some(rel_sp()),
        cache_key: Some("m1::fp".into()),
        test_periods: Some(vec![tp(1151, 576)]), // ends before it starts
        ..Default::default()
    };
    match plan_export(&req, dir.path(), &state).unwrap() {
        ExportPlan::Finished(r) => {
            assert!(!r.ok);
            assert_eq!(r.validation[0].code, "test_ends_before_start");
        }
        ExportPlan::RunSidecar => panic!("a malformed test period must be refused before the sidecar"),
    }
    // A good period proceeds to the sidecar.
    req.test_periods = Some(vec![tp(576, 1151)]);
    assert!(matches!(plan_export(&req, dir.path(), &state).unwrap(), ExportPlan::RunSidecar));
    // And so does a request without test periods.
    req.test_periods = None;
    assert!(matches!(plan_export(&req, dir.path(), &state).unwrap(), ExportPlan::RunSidecar));
}

#[test]
fn export_request_deserializes_test_periods_from_the_frontend_json() {
    let r: ModelFilesRequest = serde_json::from_str(
        r#"{"kind":"individual","workspace_id":"w","target":"S",
            "test_periods":[{"start":"2024-01-01T00:00","end":null,"label":"problem","event_time":"2024-01-02T00:00"}]}"#,
    )
    .unwrap();
    // The legacy `label` / `event_time` keys are accepted and dropped.
    let t = &r.test_periods.as_ref().unwrap()[0];
    assert_eq!(*t, TestPeriodArg { start: Some("2024-01-01T00:00".into()), end: None });
    assert!(r.tests_requested());
    // What the frontend sends from now on: only start / end.
    let new: ModelFilesRequest = serde_json::from_str(
        r#"{"kind":"individual","workspace_id":"w","target":"S",
            "test_periods":[{"start":"2024-01-01T00:00","end":"2024-01-02T00:00"}]}"#,
    )
    .unwrap();
    assert_eq!(new.test_periods.as_ref().unwrap()[0].end.as_deref(), Some("2024-01-02T00:00"));
    let none: ModelFilesRequest = serde_json::from_str(r#"{"kind":"individual","workspace_id":"w"}"#).unwrap();
    assert!(!none.tests_requested());
    let h: HealthPreviewRequest = serde_json::from_str(
        r#"{"kind":"individual","test_periods":[{"start":null,"end":null,"label":"normal"}]}"#,
    )
    .unwrap();
    assert!(h.has_test_periods());
}

