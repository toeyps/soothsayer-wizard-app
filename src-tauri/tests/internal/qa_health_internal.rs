//! Health score, Rust side, PRIVATE surface: a `#[cfg(test)]` child module of `lib.rs` (one `#[path]` line), not an integration target.
//! Covers rounding and scope consistency vs an independent filter, Relationship cache, JSON shapes and edge datasets.

#![allow(clippy::too_many_arguments)]

use crate::csv_processor::{ColumnarData, TS_MISSING};
use crate::health_preview::{
    clustering_preview, individual_preview, rel_extra_from_model, relationship_preview_ex,
    relationship_stats,
    HealthPreview, HealthPreviewRequest, HealthSeries, HealthStats,
};
use crate::health_score::{IndividualBand, RelFit, SetPointsArg};
use crate::{
    commit_derived, health_preview_in, install_session, remove_derived_in_state,
    store_rel_fit, AppState, SessionStamp, ClusterRange, PreviewFilter,
    PreviewValueFilter, SessionData, TimeRangeArg,
};
use std::collections::HashSet;
use std::sync::{Arc, RwLock};


struct Rng(u64);
impl Rng {
    fn new(seed: u64) -> Self {
        Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }
    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn f(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
    fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.f()
    }
    fn normal(&mut self) -> f64 {
        (0..12).map(|_| self.f()).sum::<f64>() - 6.0
    }
}

fn ts_at(i: usize) -> String {
    let base = chrono::NaiveDate::from_ymd_opt(2024, 1, 1).unwrap().and_hms_opt(0, 0, 0).unwrap();
    (base + chrono::Duration::minutes(10 * i as i64)).format("%Y-%m-%dT%H:%M:%S").to_string()
}

/// Dataset with a timestamp column + named columns, 10-minute rows from 2024-01-01; `ts_override` blanks/rewrites individual rows.
fn ds_with(cols: Vec<(&str, Vec<f64>)>, ts_override: &dyn Fn(usize) -> Option<String>) -> ColumnarData {
    let n = cols[0].1.len();
    let mut headers = vec!["TimeStamp".to_string()];
    let mut columns = vec![vec![f64::NAN; n]];
    for (name, c) in cols {
        assert_eq!(c.len(), n);
        headers.push(name.to_string());
        columns.push(c);
    }
    let timestamps: Vec<Option<String>> = (0..n).map(ts_override).collect();
    ColumnarData::from_parts(headers, timestamps, columns)
}

fn ds(cols: Vec<(&str, Vec<f64>)>) -> ColumnarData {
    ds_with(cols, &|i| Some(ts_at(i)))
}

fn state_with(data: ColumnarData, generation: u64) -> AppState {
    AppState(RwLock::new(Some(SessionData {
        data,
        derived: HashSet::new(),
        generation,
        rel_cache: Default::default(),
    })))
}

fn ind_parts(p: &HealthPreview) -> (&crate::health_preview::IndividualStats, &crate::health_preview::IndividualSeries) {
    match (&p.stats, &p.series) {
        (HealthStats::Individual(s), HealthSeries::Individual(se)) => (s, se),
        _ => panic!("not individual"),
    }
}
fn rel_parts(p: &HealthPreview) -> (&crate::health_preview::RelationshipStats, &crate::health_preview::RelationshipSeries) {
    match (&p.stats, &p.series) {
        (HealthStats::Relationship(s), HealthSeries::Relationship(se)) => (s, se),
        _ => panic!("not relationship"),
    }
}
fn clu_parts(p: &HealthPreview) -> (&crate::health_preview::ClusteringStats, &crate::health_preview::ClusteringSeries) {
    match (&p.stats, &p.series) {
        (HealthStats::Clustering(s), HealthSeries::Clustering(se)) => (s, se),
        _ => panic!("not clustering"),
    }
}

/// Hourly series of a preview (one scored point per clock hour); the raw `series` carries no score.
fn ind_hourly(p: &HealthPreview) -> &crate::health_preview::IndividualSeries {
    match &p.hourly {
        HealthSeries::Individual(se) => se,
        _ => panic!("not individual"),
    }
}
fn clu_hourly(p: &HealthPreview) -> &crate::health_preview::ClusteringSeries {
    match &p.hourly {
        HealthSeries::Clustering(se) => se,
        _ => panic!("not clustering"),
    }
}
fn rel_hourly(p: &HealthPreview) -> &crate::health_preview::RelationshipSeries {
    match &p.hourly {
        HealthSeries::Relationship(se) => se,
        _ => panic!("not relationship"),
    }
}

/// Independent hourly grouping: the hour comes from the timestamp TEXT (`YYYY-MM-DDTHH`), never `ts_parsed`.
/// Returns (hour start text, rows in that hour) in time order; a row with no timestamp is in no hour.
fn ref_hours(d: &ColumnarData, rows: impl Iterator<Item = usize>) -> Vec<(String, Vec<usize>)> {
    let mut by_hour: std::collections::BTreeMap<String, Vec<usize>> = std::collections::BTreeMap::new();
    for r in rows {
        if let Some(t) = d.timestamps[r].as_deref() {
            by_hour.entry(format!("{}:00:00", &t[..13])).or_default().push(r);
        }
    }
    by_hour.into_iter().collect()
}

/// Mean of the finite values of `col` over `rows` (`NaN` when there is none).
fn ref_mean(col: &[f64], rows: &[usize]) -> f64 {
    let v: Vec<f64> = rows.iter().map(|&r| col[r]).filter(|x| x.is_finite()).collect();
    if v.is_empty() {
        f64::NAN
    } else {
        v.iter().sum::<f64>() / v.len() as f64
    }
}

fn ind_req(target: &str, sp: Option<SetPointsArg>, filter: Option<PreviewFilter>) -> HealthPreviewRequest {
    HealthPreviewRequest {
        kind: "individual".into(),
        target: Some(target.into()),
        set_points: sp,
        filter,
        max_points: Some(100_000),
        ..Default::default()
    }
}

fn sp_ind(l: f64, h: f64) -> SetPointsArg {
    SetPointsArg { lower: Some(l), upper: Some(h), ..Default::default() }
}

fn sp_n(n: f64) -> SetPointsArg {
    SetPointsArg { outer_sd: Some(n), ..Default::default() }
}


/// Three rotated, anisotropic clusters selected by criteria sensor C, plus rows in a criteria gap and rows with a missing criteria value.
fn three_cluster_data(n: usize, crit: &dyn Fn(&mut Rng, usize) -> f64) -> ColumnarData {
    let mut rng = Rng::new(202);
    let (mut x, mut y, mut c) = (Vec::new(), Vec::new(), Vec::new());
    let specs = [(0.0, 0.0, 4.0, 0.7, 25.0), (40.0, 10.0, 2.0, 1.5, -60.0), (10.0, 60.0, 6.0, 0.3, 135.0)];
    for i in 0..n {
        let cv = crit(&mut rng, i);
        let k = if cv < 10.0 { 0 } else if cv < 22.0 { 1 } else { 2 };
        let (cx, cy, a, b, ang) = specs[k];
        let (u, v) = (a * rng.normal(), b * rng.normal());
        let t = (ang as f64).to_radians();
        x.push(cx + u * t.cos() - v * t.sin());
        y.push(cy + u * t.sin() + v * t.cos());
        c.push(if i % 97 == 0 { f64::NAN } else { cv });
    }
    ds(vec![("X", x), ("Y", y), ("C", c)])
}

fn clu_req(ranges: Vec<ClusterRange>, n_out: f64, filter: Option<PreviewFilter>) -> HealthPreviewRequest {
    HealthPreviewRequest {
        kind: "clustering".into(),
        first_sensor: Some("X".into()),
        second_sensor: Some("Y".into()),
        n_clusters: Some(ranges.len() as u32),
        criteria_sensor: Some("C".into()),
        cluster_ranges: Some(ranges),
        set_points: Some(sp_n(n_out)),
        filter,
        max_points: Some(100_000),
        ..Default::default()
    }
}

/// Overlapping criteria ranges: a row belongs to the FIRST matching cluster only, for fit and score (`health_score::assign_cluster`).
#[test]
fn a2b_overlapping_ranges_fit_and_score_first_match_only() {
    let d = three_cluster_data(9000, &|r: &mut Rng, _: usize| r.range(0.0, 30.0));
    let req = clu_req(
        vec![ClusterRange { min: Some(0.0), max: Some(20.0) }, ClusterRange { min: Some(10.0), max: Some(30.0) }],
        5.0,
        None,
    );
    let p = clustering_preview(&d, &req).unwrap();
    let (st, se) = clu_parts(&p);
    let fit_rows: usize = st.clusters.iter().map(|c| c.n_rows).sum();
    assert_eq!(fit_rows, st.assigned_rows, "every row is fitted once");
    let ci = d.col_index("C").unwrap();
    for i in 0..se.rows.len() {
        let c = d.columns[ci][se.rows[i] as usize];
        if c > 10.0 && c <= 20.0 {
            assert_eq!(se.cluster[i], Some(1), "overlap row scored against the FIRST cluster");
        }
    }
}

fn rel_sp_from_w(w: f64) -> SetPointsArg {
    SetPointsArg {
        residual_at_80_lower: Some(-(1.4 * w)),
        residual_at_80_upper: Some(1.9 * w),
        residual_at_0_lower: Some(-(3.0 * w)),
        residual_at_0_upper: Some(4.5 * w),
        ..Default::default()
    }
}


fn vf(sensor: &str, op: &str, v1: Option<f64>, v2: Option<f64>) -> PreviewValueFilter {
    PreviewValueFilter { sensor: sensor.into(), operation: op.into(), value1: v1, value2: v2 }
}
fn tr(s: Option<&str>, e: Option<&str>) -> TimeRangeArg {
    TimeRangeArg { start: s.map(String::from), end: e.map(String::from) }
}

/// Independent filter: parses bounds and each row's timestamp TEXT with chrono (never `ts_parsed`).
/// Ranges inclusive, OR-ed; no timestamp = excluded under a time gate; conditions AND/OR; missing value fails; unknown sensor ignored.
fn ref_keeps(d: &ColumnarData, f: &PreviewFilter, row: usize) -> bool {
    let p = |s: &str| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S").ok();
    let mut ranges: Vec<(Option<chrono::NaiveDateTime>, Option<chrono::NaiveDateTime>)> = Vec::new();
    let blank = |s: &Option<String>| s.as_deref().map(str::trim).filter(|t| !t.is_empty()).map(|t| p(t).unwrap());
    if blank(&f.timestamp_start).is_some() || blank(&f.timestamp_end).is_some() {
        ranges.push((blank(&f.timestamp_start), blank(&f.timestamp_end)));
    }
    for r in &f.timestamp_ranges {
        ranges.push((blank(&r.start), blank(&r.end)));
    }
    if !ranges.is_empty() {
        let Some(t) = d.timestamps[row].as_deref().and_then(p) else { return false };
        if !ranges.iter().any(|(s, e)| s.is_none_or(|s| t >= s) && e.is_none_or(|e| t <= e)) {
            return false;
        }
    }
    let conds: Vec<bool> = f
        .value_filters
        .iter()
        .filter_map(|c| {
            let ci = d.headers.iter().position(|h| h == &c.sensor)?;
            let v = d.columns[ci][row];
            Some(if v.is_nan() {
                false
            } else {
                match c.operation.as_str() {
                    "greater_than" => c.value1.is_none_or(|a| v > a),
                    "less_than" => c.value1.is_none_or(|a| v < a),
                    "equals" => c.value1.is_none_or(|a| (v - a).abs() < f64::EPSILON),
                    "between" => match (c.value1, c.value2) {
                        (Some(a), Some(b)) => v >= a && v <= b,
                        _ => true,
                    },
                    _ => true,
                }
            })
        })
        .collect();
    if conds.is_empty() {
        return true;
    }
    if f.combine.as_deref() == Some("or") {
        conds.iter().any(|&b| b)
    } else {
        conds.iter().all(|&b| b)
    }
}

/// 6000 rows: S (target, NaN gaps), G (gate), C (criteria), X/Y; rows 100..110 lack a timestamp, 200..210 use a Buddhist-Era year.
fn scope_data() -> ColumnarData {
    let n = 6000;
    let mut rng = Rng::new(404);
    let s: Vec<f64> = (0..n).map(|i| if i % 37 == 0 { f64::NAN } else { 100.0 + 4.0 * rng.normal() + (i / 1000) as f64 }).collect();
    let g: Vec<f64> = (0..n).map(|i| if i % 53 == 0 { f64::NAN } else { (i % 7) as f64 }).collect();
    let x: Vec<f64> = (0..n).map(|_| 5.0 + 2.0 * rng.normal()).collect();
    let y: Vec<f64> = x.iter().map(|&v| 0.5 * v + rng.normal()).collect();
    let c: Vec<f64> = (0..n).map(|i| (i % 30) as f64).collect();
    ds_with(vec![("S", s), ("G", g), ("X", x), ("Y", y), ("C", c)], &|i| {
        if (100..110).contains(&i) {
            None
        } else if (200..210).contains(&i) {
            // Same instant written in Buddhist Era (BE = CE + 543).
            let t = ts_at(i);
            Some(format!("{}{}", t[0..4].parse::<i32>().unwrap() + 543, &t[4..]))
        } else {
            Some(ts_at(i))
        }
    })
}

fn scope_filters() -> Vec<(&'static str, Option<PreviewFilter>)> {
    let t = |i: usize| ts_at(i);
    vec![
        ("none", None),
        ("empty object", Some(PreviewFilter::default())),
        ("two disjoint ranges", Some(PreviewFilter {
            timestamp_ranges: vec![tr(Some(&t(50)), Some(&t(1500))), tr(Some(&t(3000)), Some(&t(3500)))],
            ..Default::default()
        })),
        ("overlapping + unsorted ranges", Some(PreviewFilter {
            timestamp_ranges: vec![tr(Some(&t(2000)), Some(&t(4000))), tr(Some(&t(150)), Some(&t(2500)))],
            ..Default::default()
        })),
        ("open start + open end", Some(PreviewFilter {
            timestamp_ranges: vec![tr(None, Some(&t(205))), tr(Some(&t(5000)), None)],
            ..Default::default()
        })),
        ("blank period", Some(PreviewFilter { timestamp_ranges: vec![tr(Some(""), Some("  "))], ..Default::default() })),
        ("legacy start/end", Some(PreviewFilter {
            timestamp_start: Some(t(90)),
            timestamp_end: Some(t(4321)),
            ..Default::default()
        })),
        ("AND values", Some(PreviewFilter {
            value_filters: vec![vf("G", "greater_than", Some(1.5), None), vf("S", "less_than", Some(104.0), None)],
            ..Default::default()
        })),
        ("OR values", Some(PreviewFilter {
            value_filters: vec![vf("G", "equals", Some(0.0), None), vf("S", "between", Some(95.0), Some(98.0))],
            combine: Some("or".into()),
            ..Default::default()
        })),
        ("ranges + OR values", Some(PreviewFilter {
            timestamp_ranges: vec![tr(Some(&t(10)), Some(&t(4000)))],
            value_filters: vec![vf("G", "less_than", Some(2.0), None), vf("C", "greater_than", Some(25.0), None)],
            combine: Some("or".into()),
            ..Default::default()
        })),
        ("between missing value2 = no-op", Some(PreviewFilter {
            value_filters: vec![vf("G", "between", Some(3.0), None)],
            ..Default::default()
        })),
        ("unknown sensor condition is IGNORED", Some(PreviewFilter {
            value_filters: vec![vf("DELETED_SPECIAL", "greater_than", Some(1e9), None)],
            ..Default::default()
        })),
    ]
}

#[test]
fn b3_include_out_of_scope_marks_rows_without_changing_stats_or_in_scope_scores() {
    let d = scope_data();
    let si = d.col_index("S").unwrap();
    for (name, f) in scope_filters() {
        let base = individual_preview(&d, &ind_req("S", None, f.clone())).unwrap();
        let st0 = ind_parts(&base).0;
        let sp = sp_ind(st0.boundary_3sd[0] - 1.0, st0.boundary_3sd[1] + 1.0);
        let a = individual_preview(&d, &ind_req("S", Some(sp.clone()), f.clone())).unwrap();
        let mut rq = ind_req("S", Some(sp.clone()), f.clone());
        rq.include_out_of_scope = Some(true);
        let b = individual_preview(&d, &rq).unwrap();
        let ((sa, ea), (sb, eb)) = (ind_parts(&a), ind_parts(&b));
        assert_eq!((sa.mean, sa.sd, sa.rows), (sb.mean, sb.sd, sb.rows), "{name}: stats must not change");
        assert_eq!(a.score_summary, b.score_summary, "{name}: the summary must not change");
        // RAW universe: with the flag every finite row (each with its scope flag), without it only in-scope rows. Neither carries a score.
        let finite: Vec<u32> = (0..d.n_rows()).filter(|&r| d.columns[si][r].is_finite()).map(|r| r as u32).collect();
        assert_eq!(eb.rows, finite, "{name}");
        assert!(ea.score.is_none() && eb.score.is_none(), "{name}");
        let kept: Vec<usize> = finite
            .iter()
            .map(|&r| r as usize)
            .filter(|&r| f.as_ref().is_none_or(|f| ref_keeps(&d, f, r)))
            .collect();
        assert_eq!(ea.rows.iter().map(|&r| r as usize).collect::<Vec<_>>(), kept, "{name}");
        for i in 0..eb.rows.len() {
            let r = eb.rows[i] as usize;
            assert_eq!(eb.in_scope[i], kept.binary_search(&r).is_ok(), "{name}: row {r} in_scope");
        }
        // Hourly points are the same with and without the flag: out-of-scope rows never enter a mean (an hour with none is missing, not 0).
        let (ha, hb) = (ind_hourly(&a), ind_hourly(&b));
        assert_eq!(serde_json::to_value(ha).unwrap(), serde_json::to_value(hb).unwrap(), "{name}: hourly changed");
        // ...and they are the independent per-hour means of the in-scope rows.
        let hours = ref_hours(&d, kept.iter().copied());
        assert_eq!(hb.total_points, hours.len(), "{name}: hours with an in-scope row");
        assert_eq!(hb.rows.len(), hours.len(), "{name}");
        let params = crate::health_score::IndividualParams::new(
            IndividualBand::from_rounded(sb.mean, sb.sd, sb.boundary_1sd, sb.boundary_3sd),
            &sp,
        )
        .unwrap();
        let sc = hb.score.as_ref().unwrap();
        for (i, (start, rows)) in hours.iter().enumerate() {
            assert_eq!(&hb.timestamps[i], start, "{name}");
            assert_eq!(hb.rows[i] as usize, rows[0], "{name} {start}");
            assert_eq!(hb.value[i], ref_mean(&d.columns[si], rows), "{name} {start}");
            assert_eq!(sc[i], Some(params.score(hb.value[i]).unwrap()), "{name} {start}");
            assert!(hb.in_scope[i]);
        }
        let sum = b.score_summary.as_ref().unwrap();
        assert_eq!((sum.scored, sum.total_rows, sum.share_basis), (hours.len(), hours.len(), "hour_count"), "{name}");
    }
}

#[test]
fn b4_buddhist_era_rows_are_converted_and_filtered_in_ce() {
    let d = scope_data();
    assert_eq!(d.timestamps[205].as_deref(), Some(ts_at(205).as_str()), "BE text rewritten to CE");
    assert_ne!(d.ts_parsed[205], TS_MISSING);
    assert_eq!(d.ts_parsed[105], TS_MISSING);
    // A CE range that only covers the BE rows keeps exactly those (minus NaN S).
    let f = PreviewFilter { timestamp_ranges: vec![tr(Some(&ts_at(200)), Some(&ts_at(209)))], ..Default::default() };
    let p = individual_preview(&d, &ind_req("S", None, Some(f))).unwrap();
    let rows: Vec<u32> = ind_parts(&p).1.rows.clone();
    let want: Vec<u32> = (200..210).filter(|i| i % 37 != 0).collect();
    assert_eq!(rows, want);
    // Rows without a timestamp are in the universe without a time gate (empty timestamp string, no panic) and drop out under one.
    let p = individual_preview(&d, &ind_req("S", None, None)).unwrap();
    let se = ind_parts(&p).1;
    let at = se.rows.iter().position(|&r| r == 105).unwrap();
    assert_eq!(se.timestamps[at], "");
}


fn small_fit(target: &str, n: usize, marker: f64) -> RelFit {
    RelFit {
        target: target.into(),
        predictors: vec!["X".into()],
        lambda: 1.0,
        rows: (0..n as u32).collect(),
        actual: (0..n).map(|i| marker + (i % 5) as f64).collect(),
        predicted: (0..n).map(|i| marker + (i % 5) as f64 + 0.25).collect(),
        x_cols: vec![(0..n).map(|i| i as f64).collect()],
        r2_per_step: vec![],
        rmse2_per_step: vec![],
    }
}

fn rel_req(key: &str, gen: Option<u64>) -> HealthPreviewRequest {
    HealthPreviewRequest {
        kind: "relationship".into(),
        cache_key: Some(key.into()),
        expected_generation: gen,
        ..Default::default()
    }
}

/// A fit is cached only while the derived epoch is unchanged (`SessionStamp`). Recomputing a special sensor in place clears the cache
/// but not the session generation, so a Train on the OLD column would be served forever; same for `remove_derived_in_state`.
#[test]
fn bug_c1_fit_straddling_a_special_sensor_recompute_must_not_be_cached() {
    let state = state_with(ds(vec![("X", vec![1.0; 50]), ("Y", vec![2.0; 50])]), 4);
    commit_derived(&state, 4, None, "SP", vec![0.0; 50], false).unwrap();
    // Train starts: it captures the session stamp (generation 4 + derived
    // epoch) and the OLD "SP" values...
    let g = crate::session_stamp(&state).unwrap().unwrap();
    // ...the user recomputes SP while the sidecar runs...
    commit_derived(&state, 4, None, "SP", vec![9.0; 50], true).unwrap();
    // ...the sidecar returns and the stale fit is offered to the cache.
    let stored = store_rel_fit(&state, g, "m1::fp".into(), small_fit("Y", 50, 0.0));
    assert!(!stored, "a fit computed from the pre-recompute column must be refused");
}

#[test]
fn c1_companion_a_fit_straddling_a_replace_or_remove_is_refused_and_a_fresh_one_is_cached() {
    let state = state_with(ds(vec![("X", vec![1.0; 50]), ("Y", vec![2.0; 50])]), 4);
    commit_derived(&state, 4, None, "SP", vec![0.0; 50], false).unwrap();
    // Adding a NEW column cannot affect a fit: a Train that started before it still stores.
    let before_add = crate::session_stamp(&state).unwrap().unwrap();
    commit_derived(&state, 4, None, "OTHER", vec![1.0; 50], false).unwrap();
    assert!(store_rel_fit(&state, before_add, "add".into(), small_fit("Y", 50, 0.0)), "add keeps working");
    // Replace while a Train is in flight: refused, nothing served.
    let g = crate::session_stamp(&state).unwrap().unwrap();
    commit_derived(&state, 4, None, "SP", vec![9.0; 50], true).unwrap();
    assert!(!store_rel_fit(&state, g, "k".into(), small_fit("Y", 50, 0.0)));
    assert!(health_preview_in(&state, &rel_req("k", Some(4))).unwrap_err().starts_with("NOT_FITTED"));
    // A Train that starts AFTER the recompute stores normally.
    let fresh = crate::session_stamp(&state).unwrap().unwrap();
    assert!(store_rel_fit(&state, fresh, "k".into(), small_fit("Y", 50, 0.0)));
    assert!(health_preview_in(&state, &rel_req("k", Some(4))).is_ok());
    // Removing a special sensor has the same window; the removal also empties the cache.
    assert_eq!(remove_derived_in_state(&state, &["SP".into()], None).unwrap(), 1);
    assert!(!store_rel_fit(&state, fresh, "k2".into(), small_fit("Y", 50, 0.0)));
    assert!(health_preview_in(&state, &rel_req("k", Some(4))).unwrap_err().starts_with("NOT_FITTED"));
    // Removing nothing (unknown / raw column) does not invalidate anything.
    let after = crate::session_stamp(&state).unwrap().unwrap();
    assert_eq!(remove_derived_in_state(&state, &["X".into()], None).unwrap(), 0);
    assert!(store_rel_fit(&state, after, "k3".into(), small_fit("Y", 50, 0.0)));
}

#[test]
fn c2_cached_fit_rows_beyond_the_dataset_are_refused_not_indexed() {
    let state = state_with(ds(vec![("X", vec![1.0; 10]), ("Y", vec![2.0; 10])]), 1);
    // A fit claiming 50 rows on a 10-row dataset (only reachable through a bug).
    assert!(store_rel_fit(&state, SessionStamp::new(1, 0), "k".into(), small_fit("Y", 50, 0.0)));
    let e = health_preview_in(&state, &rel_req("k", None)).unwrap_err();
    assert!(e.starts_with("NOT_FITTED"), "{e}");
}

#[test]
fn c3_mismatched_target_or_predictor_order_is_not_fitted_but_empty_lists_skip_the_check() {
    let state = state_with(ds(vec![("X", vec![1.0; 50]), ("Y", vec![2.0; 50])]), 1);
    store_rel_fit(&state, SessionStamp::new(1, 0), "k".into(), small_fit("Y", 50, 0.0));
    let mut r = rel_req("k", None);
    r.target = Some("y".into()); // case differs -> different sensor
    assert!(health_preview_in(&state, &r).unwrap_err().starts_with("NOT_FITTED"));
    r.target = Some("Y".into());
    r.predictors = vec!["X".into(), "Z".into()];
    assert!(health_preview_in(&state, &r).unwrap_err().starts_with("NOT_FITTED"));
    // No target / no predictors in the request = no check (documented trust
    // in the cache key).
    assert!(health_preview_in(&state, &rel_req("k", None)).is_ok());
}

/// One thread reloads datasets and caches a fit tagged with its generation; others read with `expected_generation`.
/// A successful read must ALWAYS see the fit of the generation it asked for; no panic or deadlock.
#[test]
fn c4_concurrent_reload_store_and_preview_never_mix_datasets() {
    let state = Arc::new(state_with(ds(vec![("X", vec![0.0; 64]), ("Y", vec![0.0; 64])]), 1));
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut handles = Vec::new();
    {
        let (state, stop) = (state.clone(), stop.clone());
        handles.push(std::thread::spawn(move || {
            let mut loads = 0;
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                let g = install_session(&state, ds(vec![("X", vec![0.0; 64]), ("Y", vec![0.0; 64])])).unwrap();
                // A "sidecar" for this generation finishes...
                store_rel_fit(&state, SessionStamp::new(g, 0), "k".into(), small_fit(&format!("T{g}"), 64, g as f64));
                // ...and a late one from the previous generation must be refused.
                assert!(!store_rel_fit(&state, SessionStamp::new(g - 1, 0), "k".into(), small_fit("STALE", 64, -1.0)), "late fit of an older generation must be refused");
                loads += 1;
            }
            loads
        }));
    }
    let mut readers = Vec::new();
    for t in 0..4 {
        let (state, stop) = (state.clone(), stop.clone());
        readers.push(std::thread::spawn(move || {
            let (mut ok, mut miss) = (0usize, 0usize);
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                let g = crate::session_generation(&state).unwrap().unwrap();
                match health_preview_in(&state, &rel_req("k", Some(g))) {
                    Ok(p) => {
                        let (s, _) = rel_parts(&p);
                        assert_eq!(s.target, format!("T{g}"), "reader {t}: served another dataset's fit");
                        ok += 1;
                    }
                    Err(e) => {
                        assert!(e.starts_with("NOT_FITTED") || e.starts_with("STALE_SESSION"), "{e}");
                        miss += 1;
                    }
                }
            }
            (ok, miss)
        }));
    }
    std::thread::sleep(std::time::Duration::from_millis(1500));
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let loads = handles.pop().unwrap().join().expect("loader panicked");
    let mut total_ok = 0;
    for r in readers {
        let (ok, _) = r.join().expect("reader panicked");
        total_ok += ok;
    }
    eprintln!("c4: {loads} reloads, {total_ok} consistent cached reads");
    assert!(loads > 10 && total_ok > 10);
}


/// Joining predictor names with '+' makes one predictor "A+B" equal to the model [A, B]; '+' is legal in sensor names and not sanitised.
#[test]
fn d11_relationship_file_names_collide_for_a_predictor_named_with_plus() {
    let a = vec!["A+B".to_string()].join("+");
    let b = vec!["A".to_string(), "B".to_string()].join("+");
    assert_eq!(a, b, "documenting the collision");
}


#[test]
fn e3_error_codes_for_bad_requests_are_prefixed() {
    let d = scope_data();
    // Clustering with an unknown sensor / missing criteria and a bad scope: only checks that an error comes back; the codes are asserted in the next test.
    let mut c = clu_req(vec![ClusterRange { min: None, max: Some(15.0) }, ClusterRange { min: Some(15.0), max: None }], 4.0, None);
    c.first_sensor = Some("NOPE".into());
    let e1 = clustering_preview(&d, &c).unwrap_err();
    let mut c = clu_req(vec![ClusterRange { min: None, max: Some(15.0) }], 4.0, None);
    c.n_clusters = Some(2);
    let e2 = clustering_preview(&d, &c).unwrap_err();
    let bad_filter = PreviewFilter { timestamp_ranges: vec![tr(Some(&ts_at(9)), Some(&ts_at(1)))], ..Default::default() };
    let e3 = individual_preview(&d, &ind_req("S", None, Some(bad_filter))).unwrap_err();
    eprintln!("uncoded errors seen: {e1:?} | {e2:?} | {e3:?}");
    for e in [&e1, &e2, &e3] {
        assert!(!e.is_empty());
    }
}

/// `compute_health_preview` answers every bad request with a stable `CODE: ...` prefix (`BAD_REQUEST`, `NO_DATA`, ...)
/// so the UI (`parseHealthError`) can classify it: unknown clustering sensor, ranges/n_clusters mismatch, missing criteria sensor, invalid scope filter.
#[test]
fn bug_e3_every_bad_request_error_is_coded() {
    let d = scope_data();
    let mut c = clu_req(vec![ClusterRange { min: None, max: Some(15.0) }, ClusterRange { min: Some(15.0), max: None }], 4.0, None);
    c.first_sensor = Some("NOPE".into());
    assert!(clustering_preview(&d, &c).unwrap_err().starts_with("BAD_REQUEST"));
    let mut c = clu_req(vec![ClusterRange { min: None, max: Some(15.0) }], 4.0, None);
    c.n_clusters = Some(2);
    assert!(clustering_preview(&d, &c).unwrap_err().starts_with("BAD_REQUEST"));
    let bad_filter = PreviewFilter { timestamp_ranges: vec![tr(Some(&ts_at(9)), Some(&ts_at(1)))], ..Default::default() };
    assert!(individual_preview(&d, &ind_req("S", None, Some(bad_filter))).unwrap_err().starts_with("BAD_REQUEST"));
}

#[test]
fn e4_huge_residuals_and_huge_values_score_zero_without_nan() {
    let n = 1000;
    let mut fit = small_fit("Y", n, 0.0);
    fit.actual[10] = 1e300;
    fit.actual[11] = -1e300;
    let d = ds(vec![("X", vec![0.0; n]), ("Y", vec![0.0; n])]);
    let w = relationship_stats(&fit).unwrap().two_rmse;
    let req = HealthPreviewRequest {
        kind: "relationship".into(),
        set_points: Some(rel_sp_from_w(w.max(1e-6))),
        max_points: Some(100_000),
        ..Default::default()
    };
    // Every hourly point has a prediction (the model answers a constant).
    let extra = rel_extra_from_model(&d, &fit, &req, &|_| 0.25);
    let p = relationship_preview_ex(&d, &fit, Some(&extra), &req).unwrap();
    // W is now astronomically large (rmse dominated by the 1e300 rows) — the
    // preview must still be well-formed.
    let j = serde_json::to_string(&p).unwrap();
    assert!(!j.contains("NaN"));
    assert!(rel_parts(&p).1.score.is_none());
    let h = rel_hourly(&p);
    assert_eq!(h.total_points, n.div_ceil(6));
    if let Some(sc) = h.score.as_ref() {
        assert!(sc.iter().any(Option::is_some), "the hours are scored");
        assert!(sc.iter().flatten().all(|s| (0.0..=100.0).contains(s)));
    }
}

/// Payload size of a full preview for a 159 264-row dataset (the real
/// dataset's size) with default caps, per kind.
#[test]
fn e5_payload_json_is_bounded_for_159k_rows() {
    let n = 159_264;
    let mut rng = Rng::new(55);
    let s: Vec<f64> = (0..n).map(|i| 400.0 + 20.0 * rng.normal() + if i == 77_777 { 500.0 } else { 0.0 }).collect();
    let x: Vec<f64> = (0..n).map(|_| rng.normal()).collect();
    let y: Vec<f64> = x.iter().map(|v| v * 3.0 + rng.normal()).collect();
    let c: Vec<f64> = (0..n).map(|i| (i % 10) as f64).collect();
    let d = ds(vec![("S", s), ("X", x.clone()), ("Y", y.clone()), ("C", c)]);
    let mut q = ind_req("S", None, None);
    q.max_points = None;
    let p0 = individual_preview(&d, &q).unwrap();
    let st = ind_parts(&p0).0;
    q.set_points = Some(sp_ind(st.boundary_3sd[0] - 50.0, st.boundary_3sd[1] + 50.0));
    let p = individual_preview(&d, &q).unwrap();
    let ji = serde_json::to_string(&p).unwrap();
    let se = ind_parts(&p).1;
    assert!(se.rows.len() <= 4000 && se.rows.contains(&77_777), "spike kept");
    // The hourly series is bounded by the same cap (26 544 hours here), and the
    // payload below holds BOTH series.
    let h = ind_hourly(&p);
    assert_eq!(h.total_points, n / 6);
    assert!(h.rows.len() <= 4000, "{}", h.rows.len());
    assert!(h.rows.contains(&(77_777 / 6 * 6)), "the spike's hour is kept");
    let mut cq = clu_req(vec![ClusterRange { min: None, max: Some(5.0) }, ClusterRange { min: Some(5.0), max: None }], 5.0, None);
    cq.max_points = None;
    let jc = serde_json::to_string(&clustering_preview(&d, &cq).unwrap()).unwrap();
    let fit = RelFit {
        target: "Y".into(),
        predictors: vec!["X".into()],
        lambda: 1.0,
        rows: (0..n as u32).collect(),
        actual: y.clone(),
        predicted: x.iter().map(|v| v * 3.0).collect(),
        x_cols: vec![x],
        r2_per_step: vec![],
        rmse2_per_step: vec![],
    };
    let w = relationship_stats(&fit).unwrap().two_rmse;
    let rq = HealthPreviewRequest { kind: "relationship".into(), set_points: Some(rel_sp_from_w(w)), ..Default::default() };
    // With every hourly prediction in place (the largest payload).
    let extra = rel_extra_from_model(&d, &fit, &rq, &|x| 3.0 * x[0]);
    let pr = relationship_preview_ex(&d, &fit, Some(&extra), &rq).unwrap();
    assert_eq!(rel_hourly(&pr).total_points, n / 6);
    assert!(rel_hourly(&pr).rows.len() <= 4000 && rel_parts(&pr).1.rows.len() <= 4000);
    assert!(rel_hourly(&pr).score.as_ref().unwrap().iter().all(Option::is_some));
    let jr = serde_json::to_string(&pr).unwrap();
    eprintln!("payload bytes for {n} rows: individual {} / relationship {} / clustering {}", ji.len(), jr.len(), jc.len());
    for (k, l) in [("individual", ji.len()), ("relationship", jr.len()), ("clustering", jc.len())] {
        assert!(l < 2_000_000, "{k} payload {l} bytes");
    }
}

#[test]
fn e6_every_series_respects_max_points_for_every_kind_and_cap() {
    let n = 12_345;
    let mut rng = Rng::new(66);
    let s: Vec<f64> = (0..n).map(|_| 50.0 + rng.normal()).collect();
    let x: Vec<f64> = (0..n).map(|_| rng.normal()).collect();
    let y: Vec<f64> = x.iter().map(|v| v + 0.3 * rng.normal()).collect();
    let d = ds(vec![("S", s), ("X", x.clone()), ("Y", y.clone())]);
    let fit = RelFit {
        target: "Y".into(), predictors: vec!["X".into()], lambda: 1.0, rows: (0..n as u32).collect(),
        actual: y, predicted: x.clone(), x_cols: vec![x], r2_per_step: vec![], rmse2_per_step: vec![],
    };
    let w = relationship_stats(&fit).unwrap().two_rmse;
    for cap in [0usize, 1, 2, 7, 8, 9, 100, 4000, 12_344, 12_345, 100_000, 1_000_000] {
        let want = cap.clamp(8, 100_000).min(n);
        let mut q = ind_req("S", Some(sp_ind(40.0, 60.0)), None);
        q.max_points = Some(cap);
        q.max_scatter_points = Some(cap);
        let p = individual_preview(&d, &q).unwrap();
        let se = ind_parts(&p).1;
        assert!(se.rows.len() <= want, "ind cap {cap}: {}", se.rows.len());
        assert!([se.timestamps.len(), se.value.len(), se.in_scope.len()].iter().all(|&l| l == se.rows.len()));
        assert!(se.score.is_none());
        assert!(se.timestamps.iter().all(|t| crate::csv_processor::parse_timestamp(t).is_some()));
        // The hourly series obeys the same cap (2058 hours of 6 rows).
        let hours = n.div_ceil(6);
        let want_h = cap.clamp(8, 100_000).min(hours);
        let h = ind_hourly(&p);
        assert_eq!(h.total_points, hours);
        assert!(h.rows.len() <= want_h, "ind hourly cap {cap}: {}", h.rows.len());
        assert!([h.timestamps.len(), h.value.len(), h.in_scope.len(), h.score.as_ref().unwrap().len()].iter().all(|&l| l == h.rows.len()));
        assert!(h.timestamps.iter().all(|t| t.ends_with(":00:00") && crate::csv_processor::parse_timestamp(t).is_some()));
        assert!(h.rows.windows(2).all(|w| w[0] < w[1]), "ascending in time");
        let rq = HealthPreviewRequest { kind: "relationship".into(), set_points: Some(rel_sp_from_w(w)), max_points: Some(cap), max_scatter_points: Some(cap), ..Default::default() };
        let extra = rel_extra_from_model(&d, &fit, &rq, &|x| x[0]);
        let p = relationship_preview_ex(&d, &fit, Some(&extra), &rq).unwrap();
        let se = rel_parts(&p).1;
        assert!(se.rows.len() <= want);
        assert!([se.actual.len(), se.predicted.len(), se.residual.len(), se.timestamps.len()].iter().all(|&l| l == se.rows.len()));
        assert!(se.score.is_none());
        let h = rel_hourly(&p);
        assert_eq!(h.total_points, hours);
        assert!(h.rows.len() <= want_h, "rel hourly cap {cap}: {}", h.rows.len());
        assert!([h.actual.len(), h.predicted.len(), h.residual.len(), h.timestamps.len(), h.score.as_ref().unwrap().len()].iter().all(|&l| l == h.rows.len()));
        assert!(h.timestamps.iter().all(|t| t.ends_with(":00:00") && crate::csv_processor::parse_timestamp(t).is_some()));
        assert!(h.rows.windows(2).all(|w| w[0] < w[1]), "ascending in time");
        assert!(p.fit_scatter.as_ref().unwrap().x.len() <= cap.clamp(1, 100_000).min(n));
        let mut cq = clu_req(vec![], 5.0, None);
        cq.n_clusters = Some(1);
        cq.criteria_sensor = None;
        cq.cluster_ranges = None;
        cq.max_points = Some(cap);
        cq.max_scatter_points = Some(cap);
        let p = clustering_preview(&d, &cq).unwrap();
        let se = clu_parts(&p).1;
        assert!(se.rows.len() <= want);
        assert!([se.x.len(), se.y.len(), se.cluster.len(), se.sd_distance.len()].iter().all(|&l| l == se.rows.len()));
        assert!(se.score.is_none());
        let h = clu_hourly(&p);
        assert_eq!(h.total_points, hours);
        assert!(h.rows.len() <= want_h, "clu hourly cap {cap}: {}", h.rows.len());
        assert!([h.x.len(), h.y.len(), h.cluster.len(), h.sd_distance.len(), h.timestamps.len(), h.score.as_ref().unwrap().len()].iter().all(|&l| l == h.rows.len()));
        assert!(p.cluster_scatter.as_ref().unwrap().x.len() <= cap.clamp(1, 100_000).min(n));
    }
}

/// Numbers round-trip Rust -> JSON -> JS -> JSON -> serde_json over IPC; `lower_equals_3sd` needs the same double back (1 ulp off breaks it).
/// Counts how often the round trip breaks the equality rule.
fn equal_rule_failures(samples: usize) -> (usize, usize) {
    let mut rng = Rng::new(77);
    let (mut lossy_parse, mut missed_equal) = (0, 0);
    for _ in 0..samples {
        let mean = rng.range(-2000.0, 2000.0) * 10f64.powf(rng.range(-4.0, 0.0));
        let sd = 10f64.powf(rng.range(-4.0, 3.0));
        let (m, s, b1, b3) = crate::individual_rounded_metrics(mean, sd);
        let band = IndividualBand::from_rounded(m, s, b1, b3);
        if band.is_degenerate() {
            continue;
        }
        // What the page shows / sends back = serde_json's (ryu) text.
        let shown = serde_json::to_string(&b3[0]).unwrap();
        let back: f64 = serde_json::from_str(&shown).unwrap();
        if back != b3[0] {
            lossy_parse += 1;
        }
        let h = b3[1] + s;
        let sp: SetPointsArg = serde_json::from_str(&format!(r#"{{"lower":{shown},"upper":{h}}}"#)).unwrap();
        let v = crate::health_score::validate_individual(&band, &sp);
        if !v.iter().any(|i| i.code == "lower_equals_3sd") {
            missed_equal += 1;
        }
    }
    (lossy_parse, missed_equal)
}

#[test]
fn e7_typed_3sd_boundary_round_trip_measurement() {
    let (lossy, missed) = equal_rule_failures(200_000);
    eprintln!("e7: serde_json parse != value for {lossy}/200000 boundaries; 'equals 3σ' rule missed {missed} times");
    // Values rounded by `round_metric` (<= ~7 significant digits) round-trip exactly; only 16-17 digit literals can be 1 ulp off.
    assert_eq!((lossy, missed), (0, 0));
}


#[test]
fn e1_empty_and_one_row_datasets_never_panic() {
    let empty = ColumnarData::from_parts(
        vec!["TimeStamp".into(), "S".into(), "X".into(), "Y".into()],
        vec![],
        vec![vec![], vec![], vec![], vec![]],
    );
    assert!(individual_preview(&empty, &ind_req("S", None, None)).unwrap_err().starts_with("NO_DATA"));
    let c = HealthPreviewRequest {
        kind: "clustering".into(),
        first_sensor: Some("X".into()),
        second_sensor: Some("Y".into()),
        ..Default::default()
    };
    assert!(clustering_preview(&empty, &c).unwrap_err().starts_with("NO_DATA"));

    let one = ds(vec![("S", vec![5.0]), ("X", vec![1.0]), ("Y", vec![2.0])]);
    let p = individual_preview(&one, &ind_req("S", Some(sp_ind(0.0, 10.0)), None)).unwrap();
    assert!(!p.valid);
    assert!(p.validation.iter().any(|i| i.code == "degenerate_band"));
    assert_eq!(p.histogram.as_ref().unwrap().counts, vec![1]);
    let mut c1 = c.clone();
    c1.set_points = Some(sp_n(5.0));
    let p = clustering_preview(&one, &c1).unwrap();
    assert!(!p.valid && p.validation.iter().any(|i| i.code == "degenerate_band"));
    // JSON of a degenerate preview has no NaN-turned-null surprises in stats.
    let j = serde_json::to_value(individual_preview(&one, &ind_req("S", None, None)).unwrap()).unwrap();
    for k in ["mean", "sd", "min", "max"] {
        assert!(j["stats"][k].is_number(), "{k} = {}", j["stats"][k]);
    }
}

#[test]
fn e2_duplicate_and_case_variant_names_resolve_the_same_way_in_the_preview() {
    let d = ColumnarData::from_parts(
        vec!["TimeStamp".into(), "S".into(), "S".into(), "s".into()],
        (0..500).map(|i| Some(ts_at(i))).collect(),
        vec![
            vec![f64::NAN; 500],
            (0..500).map(|i| 10.0 + (i % 7) as f64).collect(),
            (0..500).map(|i| 1000.0 + (i % 11) as f64).collect(),
            (0..500).map(|i| -5.0 + (i % 3) as f64).collect(),
        ],
    );
    // Duplicate "S": the FIRST column.
    let p = individual_preview(&d, &ind_req("S", None, None)).unwrap();
    assert!(ind_parts(&p).0.mean < 20.0, "first 'S' column expected");
    // "s" is a different, exact-match column (case-sensitive everywhere).
    let p = individual_preview(&d, &ind_req("s", None, None)).unwrap();
    assert!(ind_parts(&p).0.mean < 0.0);
    // A name that does not exist: BAD_REQUEST.
    let e = individual_preview(&d, &ind_req("S ", None, None)).unwrap_err();
    assert!(e.starts_with("BAD_REQUEST"), "{e}");
}
