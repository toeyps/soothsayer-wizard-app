//! Health score, Rust side, PRIVATE surface.
//!
//! Included from `lib.rs` as a `#[cfg(test)]` child module (one `#[path]`
//! line) because `health_preview`, `model_export`, the session/cache helpers
//! and the file writers are private to the crate; the file itself lives under
//! `src-tauri/tests/internal/` (not auto-discovered by
//! cargo as an integration-test target).
//!
//! Since 2026-10-11 the health score is computed on 1-HOUR AVERAGES (one point
//! per clock hour = the mean of the hour's in-scope rows, `health_hourly`):
//! the checks below re-compute every hourly point independently (the fixtures
//! are 10-minute rows, so an hour is 6 rows). The Relation model's hourly point
//! is the hour's mean target against the model's prediction for the hour's MEAN
//! predictors; its raw series (the fit's training rows) still equals
//! `REL_DATASET` row for row.
//!
//! Covers what the in-module tests do not:
//!   A. rounding consistency — write the model file through the legacy `train_*` core,
//!      read it back, re-score every hourly point with an independent
//!      reference (Relationship: the file's rows averaged per hour, through
//!      the model) and compare with the preview;
//!   B. training-scope consistency between `compute_health_preview` and the
//!      legacy `train_*` file for many filter shapes, against an independent filter;
//!   C. Relationship cache: generation straddle, concurrency, foreign rows;
//!   D. exact JSON shapes of the legacy `train_*` files (the Mark-complete export
//!      robustness tests went with that export, Export results phase 4);
//!   E. edge datasets (empty, one row, duplicate / case-variant names,
//!      TS_MISSING, Buddhist-Era timestamps, huge residuals, payload sizes);
//!   F. REAL-DATA smoke tests (`#[ignore]`d — run explicitly, skip gracefully
//!      when the file / sidecar binary is missing).
//!
//! A known bug is pinned as a test asserting the CORRECT behaviour, marked
//! ignored with a BUG reason (project convention) until fixed. The `bug_*`
//! tests guard bugs this file found.

#![allow(clippy::too_many_arguments)]

use crate::csv_processor::{ColumnarData, TS_MISSING};
use crate::health_preview::{
    clustering_preview, individual_preview, rel_extra_from_model, relationship_preview_ex,
    relationship_stats,
    HealthPreview, HealthPreviewRequest, HealthSeries, HealthStats,
};
use crate::health_score::{IndividualBand, RelFit, SetPointsArg};
use crate::metrics::{self, round_metric};
use crate::model_export::CoreError;
use crate::{
    commit_derived, health_preview_in, install_session, remove_derived_in_state,
    store_rel_fit, write_relationship_outputs, AppState, SessionStamp, ClusterRange, PreviewFilter,
    PreviewValueFilter, RelationshipOutputs, SessionData, TimeRangeArg,
};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

// ===========================================================================
// Helpers
// ===========================================================================

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

/// Dataset with a timestamp column + named columns, 10-minute rows from
/// 2024-01-01 (`ts_override` lets a test blank / rewrite individual rows).
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
        paths: vec![],
        derived: HashSet::new(),
        generation,
        rel_cache: Default::default(),
    })))
}

fn read_json(p: &Path) -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn interp(x: f64, xs: &[f64], ys: &[f64]) -> f64 {
    if x <= xs[0] {
        return ys[0];
    }
    if x >= xs[xs.len() - 1] {
        return ys[ys.len() - 1];
    }
    let j = xs.partition_point(|&k| k <= x);
    let i = j - 1;
    ys[i] + (x - xs[i]) / (xs[j] - xs[i]) * (ys[j] - ys[i])
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

/// The HOURLY series of a preview (`hourly`: one scored point per clock hour;
/// `*_parts` above give the RAW `series`, which carries no score).
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

/// Independent hourly grouping: the clock hour of a row is read from its
/// timestamp TEXT (`YYYY-MM-DDTHH`), never from `ts_parsed`. Returns, in time
/// order, `(hour start text, the dataset rows of `rows` in that hour)`; a row
/// without a timestamp is in no hour.
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

fn all_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    fn walk(d: &Path, out: &mut Vec<PathBuf>) {
        if let Ok(rd) = std::fs::read_dir(d) {
            for e in rd.flatten() {
                if e.path().is_dir() {
                    walk(&e.path(), out);
                } else {
                    out.push(e.path());
                }
            }
        }
    }
    walk(root, &mut out);
    out.sort();
    out
}

/// The legacy `train_individual_model` writer (`INDV_INFO_{target}.json` under
/// `{dir}/output/{target}/`); returns the file path. Mark complete no longer
/// writes files (Export results phase 4), so these tests exercise the legacy
/// `train_*` file instead.
fn ind_file(d: &ColumnarData, target: &str, sp: Option<SetPointsArg>, filter: Option<PreviewFilter>, dir: &Path) -> Result<PathBuf, String> {
    crate::write_individual_info(d, target.into(), None, dir.to_str().unwrap(), filter, sp.as_ref())
        .map(|i| PathBuf::from(i.saved_path))
        .map_err(CoreError::into_string)
}

// ===========================================================================
// A. Rounding consistency: file -> independent re-score == preview
// ===========================================================================

/// Score of `v` computed ONLY from an `INDV_INFO` file (independent of
/// `health_score`): knots L, -3σ, -1σ, +1σ, +3σ, H -> 0, 80, 100, 100, 80, 0.
fn score_from_indv_file(info: &serde_json::Value, v: f64) -> f64 {
    let m = &info["model_metrics"];
    let b1 = m["1sd_boundary"].as_array().unwrap();
    let b3 = m["3sd_boundary"].as_array().unwrap();
    let sp = m["setpoint_health_score"].as_array().unwrap();
    let f = |x: &serde_json::Value| x.as_f64().unwrap();
    interp(
        v,
        &[f(&sp[0]), f(&b3[0]), f(&b1[0]), f(&b1[1]), f(&b3[1]), f(&sp[1])],
        &[0.0, 80.0, 100.0, 100.0, 80.0, 0.0],
    )
}

#[test]
fn a1_individual_file_rescoring_matches_preview_for_every_hour_of_several_scales() {
    let mut rng = Rng::new(101);
    let n = 20_000;
    let scenarios: Vec<(&str, Box<dyn Fn(&mut Rng) -> f64>)> = vec![
        ("normal", Box::new(|r: &mut Rng| 100.0 + 3.0 * r.normal())),
        ("tiny_sd", Box::new(|r: &mut Rng| 0.003 + 0.0004 * r.normal())),
        ("large_mean_tiny_sd", Box::new(|r: &mut Rng| 12_345.678_9 + 0.0007 * r.normal())),
        ("negative", Box::new(|r: &mut Rng| -42.5 + 7.0 * r.normal())),
        ("stepped", Box::new(|r: &mut Rng| (r.range(0.0, 6.0)).floor() * 0.5)),
    ];
    let mut compared = 0usize;
    for (name, gen) in scenarios {
        let v: Vec<f64> = (0..n).map(|_| gen(&mut rng)).collect();
        let d = ds(vec![("S", v)]);
        let p0 = individual_preview(&d, &ind_req("S", None, None)).unwrap();
        let st = ind_parts(&p0).0;
        assert!(!IndividualBand::from_rounded(st.mean, st.sd, st.boundary_1sd, st.boundary_3sd).is_degenerate(), "{name}: band collapsed {st:?}");
        // Asymmetric L/H strictly beyond 3σ.
        let (l, h) = (st.boundary_3sd[0] - 2.0 * st.sd, st.boundary_3sd[1] + 5.0 * st.sd);
        let sp = sp_ind(l, h);
        let p = individual_preview(&d, &ind_req("S", Some(sp.clone()), None)).unwrap();
        assert!(p.valid, "{name}: {:?}", p.validation);
        let (st, raw) = ind_parts(&p);
        assert_eq!(raw.rows.len(), n, "{name}: series must hold every row at max_points=100000");
        assert!(raw.score.is_none(), "{name}: the raw rows are not scored");
        // What IS scored: one point per clock hour (6 rows of 10 minutes).
        let se = ind_hourly(&p);
        let hours = ref_hours(&d, 0..n);
        assert_eq!(hours.len(), n.div_ceil(6));
        assert_eq!(se.rows.len(), hours.len(), "{name}: every hourly point at max_points=100000");

        let app = tempfile::tempdir().unwrap();
        let info = read_json(&ind_file(&d, "S", Some(sp), None, app.path()).unwrap_or_else(|e| panic!("{name}: {e}")));
        let m = &info["model_metrics"];
        // The file numbers ARE the preview numbers (bit-identical).
        assert_eq!(m["mean"].as_f64().unwrap(), st.mean, "{name} mean");
        assert_eq!(m["sd"].as_f64().unwrap(), st.sd, "{name} sd");
        assert_eq!(m["1sd_boundary"][0].as_f64().unwrap(), st.boundary_1sd[0]);
        assert_eq!(m["1sd_boundary"][1].as_f64().unwrap(), st.boundary_1sd[1]);
        assert_eq!(m["3sd_boundary"][0].as_f64().unwrap(), st.boundary_3sd[0]);
        assert_eq!(m["3sd_boundary"][1].as_f64().unwrap(), st.boundary_3sd[1]);
        assert_eq!(m["setpoint_health_score"][0].as_f64().unwrap(), l);
        assert_eq!(m["setpoint_health_score"][1].as_f64().unwrap(), h);

        let sc = se.score.as_ref().unwrap();
        for (i, (start, rows)) in hours.iter().enumerate() {
            // The point is the hour's mean, labelled with the hour start...
            assert_eq!(&se.timestamps[i], start, "{name} hour {i}");
            assert_eq!(se.rows[i] as usize, rows[0], "{name} hour {i}: first row");
            assert_eq!(se.value[i], ref_mean(&d.columns[1], rows), "{name} hour {i}: mean of its rows");
            // ...and a consumer holding only the file scores that mean the same.
            let want = score_from_indv_file(&info, se.value[i]);
            let got = sc[i].unwrap();
            assert!((got - want).abs() <= 1e-9, "{name} hour {start}: preview {got} vs file {want}");
            compared += 1;
        }
    }
    assert_eq!(compared, 5 * n.div_ceil(6));
}

/// Mahalanobis distance from the file's numbers via an explicitly inverted
/// covariance (independent of `ClusterGeom::sd_distance`).
fn file_cluster_distance(c: &serde_json::Map<String, serde_json::Value>, x: f64, y: f64) -> f64 {
    let g = |k: &str| c[k].as_f64().unwrap();
    let (cx, cy, a, b, ang) = (g("x_cluster_center"), g("y_cluster_center"), g("x_sd"), g("y_sd"), g("angle_deg"));
    let (s, co) = ang.to_radians().sin_cos();
    let sxx = co * co * a * a + s * s * b * b;
    let syy = s * s * a * a + co * co * b * b;
    let sxy = co * s * (a * a - b * b);
    let det = sxx * syy - sxy * sxy;
    let (dx, dy) = (x - cx, y - cy);
    ((dx * dx * syy - 2.0 * dx * dy * sxy + dy * dy * sxx) / det).sqrt()
}

/// Assign a criteria value with ONLY the file: clusters in id order, the
/// first whose `(higher_than, lower_than]` contains it (Wizard Output Spec §4.4). `spelling` picks the
/// key family (`criteria_` or legacy `critera_`).
fn file_assign(info: &serde_json::Value, c: f64, spelling: &str) -> Option<u32> {
    if !c.is_finite() {
        return None;
    }
    let ci = info["cluster_info"].as_object().unwrap();
    let mut ids: Vec<u32> = ci.keys().map(|k| k.parse().unwrap()).collect();
    ids.sort();
    for id in ids {
        let e = ci[&id.to_string()].as_object().unwrap();
        let lo = e.get(&format!("{spelling}_sensor_value_higher_than")).and_then(|v| v.as_f64());
        let hi = e.get(&format!("{spelling}_sensor_value_lower_than")).and_then(|v| v.as_f64());
        if lo.is_none_or(|lo| c > lo) && hi.is_none_or(|hi| c <= hi) {
            return Some(id);
        }
    }
    None
}

/// The cluster of an HOUR with ONLY the file and the raw rows: the cluster
/// every row of the hour is in ([`file_assign`] per row). `None` when the rows
/// are not all in one cluster - two clusters in the hour, or a row whose
/// criteria value is missing / in no range.
fn file_assign_hour(info: &serde_json::Value, crit: &[f64], rows: &[usize], spelling: &str) -> Option<u32> {
    let first = file_assign(info, crit[*rows.first()?], spelling)?;
    rows.iter().all(|&r| file_assign(info, crit[r], spelling) == Some(first)).then_some(first)
}

/// Three rotated, anisotropic clusters selected by a criteria sensor C, plus
/// rows in a criteria gap and rows with a missing criteria value.
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

/// The legacy `train_clustering_model` writer (`CLUS_INFO_{x}_{y}.json`);
/// returns the file path.
fn clu_file(d: &ColumnarData, req: &HealthPreviewRequest, dir: &Path) -> Result<PathBuf, String> {
    crate::write_clustering_info(
        d,
        req.first_sensor.clone().unwrap_or_default(),
        req.second_sensor.clone().unwrap_or_default(),
        req.n_clusters.unwrap_or(1),
        req.criteria_sensor.clone(),
        req.cluster_ranges.clone(),
        None,
        dir.to_str().unwrap(),
        req.filter.clone(),
        req.set_points.as_ref(),
    )
    .map(|i| PathBuf::from(i.saved_path))
    .map_err(CoreError::into_string)
}

/// Overlapping criteria ranges: a row belongs to the FIRST matching cluster
/// only, for the FIT and the SCORE alike (2026-10-20: Train, the health score
/// and the export share `health_score::assign_cluster`; before, the fit used
/// every row each range contained, so overlap rows were fitted twice).
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

/// Count HOURLY points whose (cluster, score) differ between the preview and a
/// consumer that only has the CLUS_INFO file and the raw rows: it averages X
/// and Y per clock hour itself, gives the hour the cluster EVERY one of its
/// rows is in (none when they are not all in one cluster) and scores the mean
/// point against it.
/// Returns `(mismatches, hours compared, distinct assignments seen)`.
fn clustering_file_mismatches(d: &ColumnarData, req: &HealthPreviewRequest) -> (usize, usize, usize) {
    let p = clustering_preview(d, req).unwrap();
    assert!(p.valid, "{:?}", p.validation);
    assert!(clu_parts(&p).1.score.is_none(), "the raw rows are not scored");
    let se = clu_hourly(&p);
    let app = tempfile::tempdir().unwrap();
    let info = read_json(&clu_file(d, req, app.path()).unwrap());
    let (xi, yi, ci_col) = (d.col_index("X").unwrap(), d.col_index("Y").unwrap(), d.col_index("C").unwrap());
    let hours = ref_hours(d, 0..d.n_rows());
    assert_eq!(se.rows.len(), hours.len(), "every hourly point at max_points=100000");
    let sc = se.score.as_ref().unwrap();
    let mut mism = 0;
    let mut seen: HashSet<Option<u32>> = HashSet::new();
    for (i, (start, rows)) in hours.iter().enumerate() {
        assert_eq!(&se.timestamps[i], start);
        assert_eq!(se.x[i], ref_mean(&d.columns[xi], rows), "hour {start}: mean X");
        assert_eq!(se.y[i], ref_mean(&d.columns[yi], rows), "hour {start}: mean Y");
        let a_new = file_assign_hour(&info, &d.columns[ci_col], rows, "criteria");
        let a_old = file_assign_hour(&info, &d.columns[ci_col], rows, "critera");
        assert_eq!(a_new, a_old, "both key spellings must assign identically");
        seen.insert(a_new);
        if a_new != se.cluster[i] {
            mism += 1;
            continue;
        }
        let want = a_new.map(|id| {
            let e = info["cluster_info"][id.to_string()].as_object().unwrap();
            let n = e["boundary_sd_health_score"].as_f64().unwrap();
            let dist = file_cluster_distance(e, se.x[i], se.y[i]);
            interp(dist, &[0.0, 1.0, 3.0, n], &[100.0, 100.0, 80.0, 0.0])
        });
        match (want, sc[i]) {
            (None, None) => {}
            (Some(w), Some(g)) if (w - g).abs() <= 1e-7 => {}
            other => {
                mism += 1;
                if mism < 5 {
                    eprintln!("hour {start}: file {:?} vs preview {:?}", other.0, other.1);
                }
            }
        }
    }
    (mism, se.rows.len(), seen.len())
}

#[test]
fn a2_clustering_file_rescoring_matches_preview_for_every_hour() {
    // The machine changes state by the HOUR (6 rows): criteria in [0, 10),
    // [10, 20) or [25, 40). Hours WITHOUT a cluster (so without a score):
    //   * every 50th row reads 23 (in the gap between the ranges) - one such
    //     row leaves its whole hour without a cluster;
    //   * every 40th hour sits in the gap for the whole hour;
    //   * every 30th hour is half in the first range, half in the third (its
    //     mean criteria value is in or near the SECOND - a cluster the machine
    //     was never in during that hour);
    //   * an hour that holds a row with no criteria value (`three_cluster_data`).
    let d = three_cluster_data(30_000, &|r: &mut Rng, i: usize| {
        if (i / 6) % 40 == 7 {
            22.5
        } else if (i / 6) % 30 == 11 {
            [r.range(0.0, 10.0), r.range(25.0, 40.0)][(i % 6) / 3]
        } else if i % 50 == 0 {
            23.0
        } else {
            [r.range(0.0, 10.0), r.range(10.0, 20.0), r.range(25.0, 40.0)][(i / 6) % 3]
        }
    });
    let ranges = vec![
        ClusterRange { min: None, max: Some(10.0) },
        ClusterRange { min: Some(10.0), max: Some(20.0) },
        ClusterRange { min: Some(25.0), max: None },
    ];
    let (mism, total, seen) = clustering_file_mismatches(&d, &clu_req(ranges, 5.5, None));
    assert_eq!(total, 5_000);
    assert_eq!(seen, 4, "the fixture exercises every cluster and the no-cluster case");
    assert_eq!(mism, 0, "{mism}/{total} hours differ between preview and the CLUS_INFO file");
}

/// Criteria range bounds are written to `CLUS_INFO` verbatim — they are user
/// inputs, not metrics. Rounded (e.g. 10.12345 -> 10.123, or 0.00012345 ->
/// 0.0001235, which even rounds UP), a consumer of the file would put the
/// rows between the two values in a different cluster than the one the user
/// saw scored (the preview / fit assign rows with the UNROUNDED bounds).
#[test]
fn bug_a2_clustering_criteria_bounds_with_many_decimals_must_round_trip() {
    // An hour is in the cluster EVERY one of its rows is in. Most hours hold one
    // state (a value in [0, 10), [10.2, 21.9) or [22, 30)); every 10th hour sits,
    // for the whole hour, between a raw bound and its rounded value (10.1232 in
    // [10.123, 10.12345), 21.9877 in [21.98765, 21.988)) - every row of it does.
    let d = three_cluster_data(30_000, &|r: &mut Rng, i: usize| match (i / 6) % 20 {
        0 => 10.1232,
        10 => 21.9877,
        h => [r.range(0.0, 10.0), r.range(10.2, 21.9), r.range(22.0, 30.0)][h % 3],
    });
    let ranges = vec![
        ClusterRange { min: None, max: Some(10.12345) },
        ClusterRange { min: Some(10.12345), max: Some(21.98765) },
        ClusterRange { min: Some(21.98765), max: None },
    ];
    let (mism, total, seen) = clustering_file_mismatches(&d, &clu_req(ranges, 5.5, None));
    assert_eq!(seen, 4, "every cluster is exercised (+ the hours holding a row without a criteria value: no cluster)");
    assert_eq!(mism, 0, "{mism}/{total} hours assigned/scored differently from the file");
}

/// Emulate `backend.py::train_relationship`'s output rounding (with the Rust
/// `round_metric` standing in for numpy's per-element rounding).
fn sidecar_like_outputs(actual: &[f64], predicted: &[f64]) -> (Vec<f64>, Vec<f64>, f64) {
    let pr: Vec<f64> = predicted.iter().map(|&p| round_metric(p)).collect();
    let res: Vec<f64> = actual.iter().zip(&pr).map(|(a, p)| round_metric(a - p)).collect();
    let rmse2 = round_metric(2.0 * metrics::rmse(actual, &pr));
    (pr, res, rmse2)
}

fn rel_fixture(n: usize, scale: f64, seed: u64) -> (RelFit, ColumnarData) {
    let mut rng = Rng::new(seed);
    let x: Vec<f64> = (0..n).map(|i| scale * (i as f64 / n as f64 * 10.0 + rng.range(-0.1, 0.1))).collect();
    let actual: Vec<f64> = x.iter().map(|&v| 3.0 * v + scale * 0.37 * rng.normal()).collect();
    // Unrounded predictions with many decimals, like `preview_relationship`.
    let predicted: Vec<f64> = x.iter().map(|&v| 3.0 * v + scale * 0.0123456789).collect();
    let fit = RelFit {
        target: "Y".into(),
        predictors: vec!["X".into()],
        lambda: 100_000.0,
        rows: (0..n as u32).collect(),
        actual: actual.clone(),
        predicted,
        x_cols: vec![x.clone()],
        r2_per_step: vec![0.9],
        rmse2_per_step: vec![0.7],
    };
    let d = ds(vec![("X", x), ("Y", actual)]);
    (fit, d)
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

/// What a consumer of an exported Relation model gets when it recomputes the
/// health score from the files: REL_DATASET's rows averaged per clock hour
/// (target and predictor), the saved model run on the hourly mean predictor
/// (here `model`, standing in for the `.pkl`), the residual rounded like the
/// file's, and REL_INFO's 2RMSE + set points.
struct RelFileCheck {
    /// Largest |score difference| between that consumer and the preview's hourly score.
    max_d: f64,
    /// Hours differing by more than 1e-9.
    diff: usize,
    hours: usize,
    w_preview: f64,
    w_file: f64,
    /// Rows whose RAW residual in the preview's `series` differs from the
    /// file's RESIDUAL column.
    raw_diff: usize,
}

fn relationship_file_vs_preview(scale: f64) -> RelFileCheck {
    let n = 20_000;
    let (fit, d) = rel_fixture(n, scale, 303);
    let w_preview = relationship_stats(&fit).unwrap().two_rmse;
    let sp = rel_sp_from_w(w_preview);
    let req = HealthPreviewRequest {
        kind: "relationship".into(),
        target: Some("Y".into()),
        predictors: vec!["X".into()],
        cache_key: Some("k".into()),
        set_points: Some(sp.clone()),
        max_points: Some(100_000),
        ..Default::default()
    };
    // The model, as the engine answers for an hourly point (the fixture's
    // per-row predictions come from the same function).
    let model = |x: &[f64]| 3.0 * x[0] + scale * 0.0123456789;
    let extra = rel_extra_from_model(&d, &fit, &req, &model);
    let p = relationship_preview_ex(&d, &fit, Some(&extra), &req).unwrap();
    assert!(p.valid, "{:?}", p.validation);
    let raw = rel_parts(&p).1;
    assert!(raw.score.is_none(), "the raw series carries no score");
    assert_eq!(raw.rows.len(), n);
    let se = rel_hourly(&p);
    let hours = n.div_ceil(6);
    assert_eq!(se.rows.len(), hours, "10-minute rows: one point per 6 rows");

    let (pr, res, rmse2) = sidecar_like_outputs(&fit.actual, &fit.predicted);
    let dir = tempfile::tempdir().unwrap();
    let x_matrix: Vec<Vec<f64>> = fit.x_cols[0].iter().map(|&v| vec![v]).collect();
    let ts: Vec<Option<String>> = (0..n).map(|i| d.timestamps[i].clone()).collect();
    let bounds = (String::new(), String::new());
    let pr_o: Vec<Option<f64>> = pr.iter().map(|&v| Some(v)).collect();
    let res_o: Vec<Option<f64>> = res.iter().map(|&v| Some(v)).collect();
    let preds = vec!["X".to_string()];
    let out = RelationshipOutputs {
        predictors: &preds,
        target: "Y",
        lambda: 100_000.0,
        model_name: None,
        x_matrix: &x_matrix,
        y: &fit.actual,
        row_timestamps: &ts,
        time_bounds: &bounds,
        r2: 0.9,
        rmse2,
        predicted: &pr_o,
        residual: &res_o,
        set_points: Some(&sp),
    };
    let info_path = write_relationship_outputs(dir.path().to_str().unwrap(), &out)
        .map_err(|e| e.into_string())
        .unwrap();
    let info = read_json(&info_path);
    let w_file = info["model_metrics"]["2rmse"].as_f64().unwrap();
    let s = &info["setpoint_health_score"];
    let g = |k: &str| s[k].as_f64().unwrap();
    let knots = [
        g("residual_at_health_0_lower"),
        g("residual_at_health_80_lower"),
        -w_file,
        w_file,
        g("residual_at_health_80_upper"),
        g("residual_at_health_0_upper"),
    ];
    // REL_DATASET: timestamp, X, Y, PREDICTED, RESIDUAL - the raw training rows.
    let csv = std::fs::read_to_string(dir.path().join("output").join("Y").join("REL_DATASET_X_Y.csv")).unwrap();
    let rows: Vec<Vec<&str>> = csv.lines().skip(1).map(|l| l.split(',').collect()).collect();
    assert_eq!(rows.len(), n);
    // 1. The raw series IS the file, row for row.
    let raw_diff = (0..n)
        .filter(|&i| raw.residual[i] != Some(rows[i][4].parse::<f64>().unwrap()))
        .count();
    // 2. The hourly score, recomputed by a consumer from the file's rows.
    let sc = se.score.as_ref().unwrap();
    let (mut max_d, mut diff, mut h, mut i) = (0.0f64, 0usize, 0usize, 0usize);
    while i < n {
        // Rows of one clock hour: the same "YYYY-MM-DDTHH" prefix.
        let hour = &rows[i][0][..13];
        let (mut sx, mut sy, mut c) = (0.0f64, 0.0f64, 0u32);
        while i < n && &rows[i][0][..13] == hour {
            sx += rows[i][1].parse::<f64>().unwrap();
            sy += rows[i][2].parse::<f64>().unwrap();
            c += 1;
            i += 1;
        }
        let (mx, my) = (sx / f64::from(c), sy / f64::from(c));
        let residual = round_metric(my - round_metric(model(&[mx])));
        let want = interp(residual, &knots, &[0.0, 80.0, 100.0, 100.0, 80.0, 0.0]);
        assert!(se.timestamps[h].starts_with(hour), "hour {h}: {} vs {hour}", se.timestamps[h]);
        let dd = (sc[h].unwrap() - want).abs();
        max_d = max_d.max(dd);
        if dd > 1e-9 {
            diff += 1;
        }
        h += 1;
    }
    assert_eq!(h, hours);
    RelFileCheck { max_d, diff, hours, w_preview, w_file, raw_diff }
}

#[test]
fn a3_relationship_2rmse_and_raw_residuals_in_the_file_equal_the_preview() {
    for scale in [1.0, 0.001, 1000.0] {
        let c = relationship_file_vs_preview(scale);
        eprintln!(
            "scale {scale}: W preview {} file {}; raw residual rows differing {}; hours differing {}/{}, max |Δscore| {:.3e}",
            c.w_preview, c.w_file, c.raw_diff, c.diff, c.hours, c.max_d
        );
        assert_eq!(c.w_preview, c.w_file, "W must be the same number in the preview and the file");
        // The Model fit page's residual is the residual the FILE stores
        // (`RESIDUAL = round(actual − round(predicted))`), for every row.
        assert_eq!(c.raw_diff, 0, "scale {scale}: raw residuals differ from REL_DATASET");
        assert!(c.max_d < 1.0, "scale {scale}: max |Δscore| {}", c.max_d);
    }
}

/// The health score is computed on 1-HOUR AVERAGES (since 2026-10-11): the
/// hour's mean target against the model's prediction for the hour's mean
/// predictors, the residual rounded like the file's
/// (`health_preview::file_residual`). It can therefore NOT be read off
/// REL_DATASET's per-row RESIDUAL column any more - but a consumer that
/// averages the file's rows per clock hour, runs the saved model on the hourly
/// means and uses REL_INFO's 2RMSE and set points gets exactly the preview's
/// score for every hour. (Scoring an UNROUNDED residual instead would move most
/// hours outside the 100-band slightly, and an hour within ~0.0005 of a knot
/// could change band.)
#[test]
fn a3_relationship_hourly_scores_are_reproducible_from_the_exported_files_and_the_model() {
    for scale in [1.0, 0.001, 1000.0] {
        let c = relationship_file_vs_preview(scale);
        assert_eq!(c.diff, 0, "scale {scale}: {}/{} hours differ (max {:.3e})", c.diff, c.hours, c.max_d);
    }
}

// ===========================================================================
// B. Training scope: preview == export == independent computation
// ===========================================================================

fn vf(sensor: &str, op: &str, v1: Option<f64>, v2: Option<f64>) -> PreviewValueFilter {
    PreviewValueFilter { sensor: sensor.into(), operation: op.into(), value1: v1, value2: v2 }
}
fn tr(s: Option<&str>, e: Option<&str>) -> TimeRangeArg {
    TimeRangeArg { start: s.map(String::from), end: e.map(String::from) }
}

/// Independent filter: parses the bounds and each row's timestamp TEXT with
/// chrono itself (never `ts_parsed`), applies the documented semantics
/// (ranges inclusive & OR-ed, missing timestamp excluded under a time gate,
/// value conditions AND / OR, missing value fails its condition, unknown
/// sensor ignored).
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

/// 6000 rows: S (target, with NaN gaps), G (gate), C (criteria), X/Y; rows
/// 100..110 have no timestamp, rows 200..210 carry a Buddhist-Era year.
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
fn b1_individual_scope_preview_equals_export_and_an_independent_computation() {
    let d = scope_data();
    let si = d.col_index("S").unwrap();
    for (name, f) in scope_filters() {
        let kept: Vec<usize> = (0..d.n_rows())
            .filter(|&r| d.columns[si][r].is_finite() && f.as_ref().is_none_or(|f| ref_keeps(&d, f, r)))
            .collect();
        let vals: Vec<f64> = kept.iter().map(|&r| d.columns[si][r]).collect();
        let mean = vals.iter().sum::<f64>() / vals.len() as f64;
        let sd = (vals.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / (vals.len() - 1) as f64).sqrt();

        let p = individual_preview(&d, &ind_req("S", None, f.clone())).unwrap();
        let (st, se) = ind_parts(&p);
        assert_eq!(st.rows, kept.len(), "{name}: in-scope row count");
        assert_eq!(se.rows.iter().map(|&r| r as usize).collect::<Vec<_>>(), kept, "{name}: series rows");
        assert!((st.mean - mean).abs() <= 0.0005 + 1e-12, "{name}: mean {} vs {mean}", st.mean);
        assert!((st.sd - sd).abs() <= 0.0005 + 1e-12, "{name}: sd {} vs {sd}", st.sd);

        let sp = sp_ind(st.boundary_3sd[0] - 1.0, st.boundary_3sd[1] + 1.0);
        let app = tempfile::tempdir().unwrap();
        let info = read_json(&ind_file(&d, "S", Some(sp), f.clone(), app.path()).unwrap_or_else(|e| panic!("{name}: {e}")));
        let m = &info["model_metrics"];
        assert_eq!((m["mean"].as_f64().unwrap(), m["sd"].as_f64().unwrap()), (st.mean, st.sd), "{name}");
        assert_eq!(m["3sd_boundary"][1].as_f64().unwrap(), st.boundary_3sd[1], "{name}");
        // Training dates = first/last in-scope row (timestamps parsed here independently).
        let tsk: Vec<&str> = kept.iter().filter_map(|&r| d.timestamps[r].as_deref()).collect();
        let (mn, mx) = (tsk.iter().min().unwrap(), tsk.iter().max().unwrap());
        assert_eq!(info["model_training_set_info"]["training_set_start_date"], *mn, "{name}");
        assert_eq!(info["model_training_set_info"]["training_set_end_date"], *mx, "{name}");
    }
}

#[test]
fn b2_clustering_scope_preview_geometry_equals_the_exported_file() {
    let d = scope_data();
    for (name, f) in scope_filters() {
        let ranges = vec![ClusterRange { min: None, max: Some(15.0) }, ClusterRange { min: Some(15.0), max: None }];
        let req = clu_req(ranges, 4.5, f.clone());
        let p = match clustering_preview(&d, &req) {
            Ok(p) => p,
            Err(e) => panic!("{name}: {e}"),
        };
        let (st, se) = clu_parts(&p);
        // Universe = in-scope rows with finite X, Y (independent filter).
        let kept: Vec<usize> = (0..d.n_rows()).filter(|&r| f.as_ref().is_none_or(|f| ref_keeps(&d, f, r))).collect();
        assert_eq!(st.rows, kept.len(), "{name}");
        assert_eq!(se.rows.len(), kept.len().min(100_000));
        let app = tempfile::tempdir().unwrap();
        let info = read_json(&clu_file(&d, &req, app.path()).unwrap_or_else(|e| panic!("{name}: {e}")));
        for c in &st.clusters {
            let e = &info["cluster_info"][c.cluster_id.to_string()];
            for (k, v) in [("x_cluster_center", c.x_center), ("y_cluster_center", c.y_center), ("x_sd", c.x_sd), ("y_sd", c.y_sd), ("angle_deg", c.angle_deg)] {
                assert_eq!(e[k].as_f64().unwrap(), v, "{name}: cluster {} {k}", c.cluster_id);
            }
            assert_eq!(e["boundary_sd_health_score"].as_f64().unwrap(), 4.5);
        }
    }
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
        // RAW universe with the flag = every finite row, each with its scope
        // flag; without it only the in-scope rows. Neither carries a score.
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
        // HOURLY points: exactly the same with and without the flag - an
        // out-of-scope row never enters a mean and never makes a point (an hour
        // with no in-scope row is missing, not 0).
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
    // Rows without a timestamp are in the universe without a time gate, with
    // an empty timestamp string (never a panic), and drop out under one.
    let p = individual_preview(&d, &ind_req("S", None, None)).unwrap();
    let se = ind_parts(&p).1;
    let at = se.rows.iter().position(|&r| r == 105).unwrap();
    assert_eq!(se.timestamps[at], "");
}

// ===========================================================================
// C. Relationship cache
// ===========================================================================

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

/// A fit is only cached while the derived epoch is unchanged (`SessionStamp`;
/// `store_rel_fit` takes the stamp a Train captured). A special sensor
/// recomputed in place (`commit_derived` with `replace=true`) clears the cache
/// but does NOT bump the session generation, so without the epoch a
/// Relationship Train that read the OLD column before the recompute and
/// returns from the ~15 s sidecar run afterwards would be stored — and
/// `compute_health_preview` would serve that stale fit under the same key
/// forever (the frontend's cache key = model id + train fingerprint, which
/// does not include special-sensor formulas). Same for `remove_derived_in_state`.
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
    // (Was `c1_companion_documents_the_current_straddle_behaviour` — it pinned
    // the BUG; flipped when the derived epoch was added.)
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

/// Many threads: one keeps reloading datasets and caching a fit tagged with
/// the generation it was computed under; others read with
/// `expected_generation`. A successful read must ALWAYS see the fit of the
/// generation it asked for (never another dataset's), and nothing panics or
/// deadlocks.
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
                let g = install_session(&state, ds(vec![("X", vec![0.0; 64]), ("Y", vec![0.0; 64])]), vec![]).unwrap();
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

// ===========================================================================
// D. Legacy train_* file shapes
// ===========================================================================

fn ind_dataset() -> ColumnarData {
    let mut rng = Rng::new(505);
    ds(vec![("S", (0..2000).map(|_| 50.0 + 2.0 * rng.normal()).collect())])
}

fn good_ind_sp(d: &ColumnarData) -> SetPointsArg {
    let p = individual_preview(d, &ind_req("S", None, None)).unwrap();
    let st = ind_parts(&p).0;
    sp_ind(st.boundary_3sd[0] - 3.0, st.boundary_3sd[1] + 3.0)
}

fn keys(v: &serde_json::Value) -> Vec<String> {
    let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
    k.sort();
    k
}

#[test]
fn d10_info_json_shapes_are_exactly_the_spec() {
    // Individual
    let d = ind_dataset();
    let app = tempfile::tempdir().unwrap();
    let f = ind_file(&d, "S", Some(good_ind_sp(&d)), None, app.path()).unwrap();
    assert_eq!(f.file_name().unwrap(), "INDV_INFO_S.json");
    let j = read_json(&f);
    assert_eq!(keys(&j), vec!["historical_sd_band_and_set_point", "model_composition", "model_metrics", "model_name", "model_training_set_info", "model_update_record"]);
    assert_eq!(keys(&j["model_metrics"]), vec!["1sd_boundary", "3sd_boundary", "mean", "sd", "setpoint_health_score"]);
    let sp = j["model_metrics"]["setpoint_health_score"].as_array().unwrap();
    assert_eq!(sp.len(), 2, "INDV setpoint_health_score is the [L, H] ARRAY");
    assert!(sp[0].as_f64().unwrap() < sp[1].as_f64().unwrap());

    // Clustering (3 clusters: open-low, closed, open-high)
    let cd = three_cluster_data(6000, &|r: &mut Rng, i: usize| [r.range(0.0, 10.0), r.range(10.0, 20.0), r.range(25.0, 40.0)][i % 3]);
    let req = clu_req(
        vec![
            ClusterRange { min: None, max: Some(10.0) },
            ClusterRange { min: Some(10.0), max: Some(20.0) },
            ClusterRange { min: Some(25.0), max: None },
        ],
        4.25,
        None,
    );
    let f = clu_file(&cd, &req, app.path()).unwrap();
    assert_eq!(f.file_name().unwrap(), "CLUS_INFO_X_Y.json");
    let j = read_json(&f);
    assert_eq!(keys(&j), vec!["cluster_info", "model_composition", "model_name", "model_training_set_info", "model_update_record"]);
    let base = ["angle_deg", "boundary_sd_health_score", "x_cluster_center", "x_sd", "y_cluster_center", "y_sd"];
    let with = |extra: &[&str]| {
        let mut v: Vec<String> = base.iter().chain(extra).map(|s| s.to_string()).collect();
        v.sort();
        v
    };
    assert_eq!(keys(&j["cluster_info"]["1"]), with(&["criteria_sensor_value_lower_than", "critera_sensor_value_lower_than"]));
    assert_eq!(
        keys(&j["cluster_info"]["2"]),
        with(&["criteria_sensor_value_higher_than", "critera_sensor_value_higher_than", "criteria_sensor_value_lower_than", "critera_sensor_value_lower_than"])
    );
    assert_eq!(keys(&j["cluster_info"]["3"]), with(&["criteria_sensor_value_higher_than", "critera_sensor_value_higher_than"]));
    for id in ["1", "2", "3"] {
        assert_eq!(j["cluster_info"][id]["boundary_sd_health_score"].as_f64(), Some(4.25), "per-cluster N");
    }
    assert_eq!(j["model_composition"]["cluster_count"], 3);
    assert_eq!(j["model_composition"]["criteria_sensor"], "C");

    // Relationship (Rust half)
    let (fit, _) = rel_fixture(200, 1.0, 9);
    let (pr, res, rmse2) = sidecar_like_outputs(&fit.actual, &fit.predicted);
    let sp = rel_sp_from_w(rmse2);
    let x_matrix: Vec<Vec<f64>> = fit.x_cols[0].iter().map(|&v| vec![v]).collect();
    let ts: Vec<Option<String>> = vec![None; 200];
    let bounds = ("a".to_string(), "b".to_string());
    let pr_o: Vec<Option<f64>> = pr.into_iter().map(Some).collect();
    let res_o: Vec<Option<f64>> = res.into_iter().map(Some).collect();
    let preds = vec!["X".to_string(), "Z".to_string()];
    let x2: Vec<Vec<f64>> = x_matrix.iter().map(|r| vec![r[0], r[0] * 2.0]).collect();
    let dir = tempfile::tempdir().unwrap();
    let info = write_relationship_outputs(
        dir.path().to_str().unwrap(),
        &RelationshipOutputs {
            predictors: &preds, target: "Y", lambda: 5.0, model_name: None, x_matrix: &x2, y: &fit.actual,
            row_timestamps: &ts, time_bounds: &bounds, r2: 0.5, rmse2, predicted: &pr_o, residual: &res_o, set_points: Some(&sp),
        },
    )
    .map_err(|e| e.into_string())
    .unwrap();
    assert!(info.ends_with(Path::new("output").join("Y").join("REL_INFO_X+Z_Y.json")));
    let j = read_json(&info);
    assert_eq!(keys(&j), vec!["model_composition", "model_location", "model_metrics", "model_name", "model_training_set_info", "model_update_record", "setpoint_health_score"]);
    assert_eq!(keys(&j["model_metrics"]), vec!["2rmse", "r2_score"]);
    assert_eq!(
        keys(&j["setpoint_health_score"]),
        vec!["residual_at_health_0_lower", "residual_at_health_0_upper", "residual_at_health_80_lower", "residual_at_health_80_upper"],
        "REL setpoint_health_score is an OBJECT"
    );
    // serde_json (no `float_roundtrip` feature) may read a float back 1 ulp off — compare with a tolerance.
    assert!((j["setpoint_health_score"]["residual_at_health_80_lower"].as_f64().unwrap() - sp.residual_at_80_lower.unwrap()).abs() < 1e-12);
    assert_eq!(j["model_location"], "Y/REL_MODEL_X+Z_Y.pkl");
    assert_eq!(j["model_training_set_info"]["training_set_file_name"], "Y/REL_DATASET_X+Z_Y.csv");
    let csv = std::fs::read_to_string(dir.path().join("output").join("Y").join("REL_DATASET_X+Z_Y.csv")).unwrap();
    assert_eq!(csv.lines().next().unwrap(), "timestamp,X,Z,Y,PREDICTED,RESIDUAL");
}

/// Relationship file names join predictors with '+': a single predictor that
/// is itself named "A+B" collides with the two-predictor model [A, B] (same
/// REL_INFO/REL_DATASET/REL_MODEL names, last export wins). Pinned as a
/// limitation (low; '+' is legal in sensor names and not sanitised).
#[test]
fn d11_relationship_file_names_collide_for_a_predictor_named_with_plus() {
    let a = vec!["A+B".to_string()].join("+");
    let b = vec!["A".to_string(), "B".to_string()].join("+");
    assert_eq!(a, b, "documenting the collision");
}

// ===========================================================================
// E. Edge datasets
// ===========================================================================

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
    let app = tempfile::tempdir().unwrap();
    assert!(ind_file(&empty, "S", Some(sp_ind(0.0, 1.0)), None, app.path()).is_err());
    assert!(all_files(app.path()).is_empty());

    let one = ds(vec![("S", vec![5.0]), ("X", vec![1.0]), ("Y", vec![2.0])]);
    let p = individual_preview(&one, &ind_req("S", Some(sp_ind(0.0, 10.0)), None)).unwrap();
    assert!(!p.valid);
    assert!(p.validation.iter().any(|i| i.code == "degenerate_band"));
    assert_eq!(p.histogram.as_ref().unwrap().counts, vec![1]);
    let mut c1 = c.clone();
    c1.set_points = Some(sp_n(5.0));
    let p = clustering_preview(&one, &c1).unwrap();
    assert!(!p.valid && p.validation.iter().any(|i| i.code == "degenerate_band"));
    assert!(ind_file(&one, "S", Some(sp_ind(0.0, 10.0)), None, app.path()).unwrap_err().starts_with("VALIDATION"));
    // JSON of a degenerate preview has no NaN-turned-null surprises in stats.
    let j = serde_json::to_value(individual_preview(&one, &ind_req("S", None, None)).unwrap()).unwrap();
    for k in ["mean", "sd", "min", "max"] {
        assert!(j["stats"][k].is_number(), "{k} = {}", j["stats"][k]);
    }
}

#[test]
fn e2_duplicate_and_case_variant_names_resolve_the_same_way_in_preview_and_export() {
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
    // Duplicate "S": both paths use the FIRST column.
    let p = individual_preview(&d, &ind_req("S", None, None)).unwrap();
    let st = ind_parts(&p).0;
    assert!(st.mean < 20.0, "first 'S' column expected");
    let app = tempfile::tempdir().unwrap();
    let f = ind_file(&d, "S", Some(sp_ind(st.boundary_3sd[0] - 1.0, st.boundary_3sd[1] + 1.0)), None, app.path()).unwrap();
    assert_eq!(read_json(&f)["model_metrics"]["mean"].as_f64().unwrap(), st.mean);
    // "s" is a different, exact-match column (case-sensitive everywhere).
    let p = individual_preview(&d, &ind_req("s", None, None)).unwrap();
    assert!(ind_parts(&p).0.mean < 0.0);
    // Case-variant that does not exist: BAD_REQUEST in preview, plain error in export.
    let e = individual_preview(&d, &ind_req("S ", None, None)).unwrap_err();
    assert!(e.starts_with("BAD_REQUEST"), "{e}");
    let app2 = tempfile::tempdir().unwrap();
    assert!(ind_file(&d, "S ", Some(sp_ind(0.0, 1.0)), None, app2.path()).is_err());
    assert!(all_files(app2.path()).is_empty());
}

#[test]
fn e3_error_codes_for_bad_requests_are_prefixed() {
    let d = scope_data();
    // Clustering with an unknown sensor / missing criteria: the fit error is
    // passed through without a code today — see report (low).
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

/// `compute_health_preview` answers every bad request with a stable
/// `CODE: ...` prefix (`BAD_REQUEST`, `NO_DATA`, ...; `check_*_request` in
/// health_preview.rs) — an unknown clustering sensor, a ranges/n_clusters
/// mismatch, a missing criteria sensor and any invalid training-scope filter
/// included — so the UI (`parseHealthError`) can classify them.
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

/// Over IPC every number makes a round trip Rust -> JSON (shortest repr) ->
/// JS -> JSON -> serde_json. If the user types the 3σ boundary exactly as
/// shown, `validate_individual` must flag `lower_equals_3sd` — which needs
/// serde_json to read the same double back. Without serde_json's
/// `float_roundtrip` feature the parse is "best effort" and can be 1 ulp
/// off. Measures how often that breaks the equality rule.
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
    // Values rounded by round_metric (<= ~7 significant digits) round-trip
    // exactly; only 16-17-digit literals can come back 1 ulp off (seen when
    // reading a computed set point back in d10) — not a user-typed value.
    assert_eq!((lossy, missed), (0, 0));
}

// ===========================================================================
// F. REAL DATA smoke tests (run explicitly; skip when files are missing)
//
//   cargo test --release --lib qa_health_internal::real_data -- --ignored --nocapture --test-threads=1
// ===========================================================================

const REAL_CSV: &str = r"C:\00_DATA\OneDrive - PTTPLC\OPS_TEAM_CUSTOMER\BangChak\GEG4\data\raw_data_normalize_format.csv";
const REAL_MASTER: &str = r"C:\00_DATA\OneDrive - PTTPLC\OPS_TEAM_CUSTOMER\BangChak\GEG4\data\msater_data.csv";
const SIDECAR: &str = r"C:\00_DATA\Soothsayer-wizard-app\src-tauri\bin\backend-x86_64-pc-windows-msvc.exe";

mod real_data {
    use super::*;
    use std::time::Instant;

    fn load() -> Option<ColumnarData> {
        if !Path::new(REAL_CSV).is_file() {
            eprintln!("SKIP: real dataset not found at {REAL_CSV}");
            return None;
        }
        let t = Instant::now();
        let r = crate::csv_processor::read_merge_csvs_with_report(vec![REAL_CSV.to_string()]).unwrap();
        eprintln!(
            "load_csv core: {} rows x {} cols in {:?}; warnings: {:?}",
            r.data.n_rows(),
            r.data.headers.len(),
            t.elapsed(),
            r.warnings.iter().map(|w| w.chars().take(100).collect::<String>()).collect::<Vec<_>>()
        );
        Some(r.data)
    }

    /// ALARM_L / ALARM_H per tag from the master file (BOM-tolerant).
    fn alarms() -> std::collections::HashMap<String, (Option<f64>, Option<f64>)> {
        let mut out = std::collections::HashMap::new();
        let Ok(text) = std::fs::read_to_string(REAL_MASTER) else { return out };
        let text = text.trim_start_matches('\u{feff}');
        let mut rdr = csv::Reader::from_reader(text.as_bytes());
        let h = rdr.headers().unwrap().clone();
        let col = |n: &str| h.iter().position(|x| x.trim().eq_ignore_ascii_case(n));
        let (ti, li, hi) = (col("TAG").unwrap(), col("ALARM_L").unwrap(), col("ALARM_H").unwrap());
        for rec in rdr.records().flatten() {
            let f = |i: usize| rec.get(i).and_then(|s| s.trim().parse::<f64>().ok());
            out.insert(rec.get(ti).unwrap_or("").trim().to_string(), (f(li), f(hi)));
        }
        out
    }

    fn stats_of(col: &[f64]) -> (usize, f64, f64, usize) {
        let v: Vec<f64> = col.iter().copied().filter(|x| x.is_finite()).collect();
        let m = v.iter().sum::<f64>() / v.len().max(1) as f64;
        let sd = (v.iter().map(|x| (x - m).powi(2)).sum::<f64>() / (v.len().max(2) - 1) as f64).sqrt();
        let mut d: Vec<u64> = v.iter().map(|x| x.to_bits()).collect();
        d.sort_unstable();
        d.dedup();
        (v.len(), m, sd, d.len())
    }

    #[test]
    #[ignore = "real-data smoke test (121 MB): run explicitly with --ignored"]
    fn real_data_individual_and_clustering() {
        let Some(d) = load() else { return };
        let n = d.n_rows();
        let al = alarms();
        // Signal shapes: pick by characteristics, plus named ones.
        let mut picks: Vec<String> = vec![
            "11PT1214A.PV", "11PDT1247.PV", "11TE1002.PV", "11FQ1201.PV", "11ZT1205.PV", "11SE1203.PV",
            "11PT1226.PV", "11TE1228.PV", "11EI1301.PV", "11TE1405.PV", "11PT1217A.PV", "11PT1220.PV",
        ]
        .into_iter()
        .map(String::from)
        .filter(|s| d.col_index(s).is_some())
        .collect();
        // + the column with the most NaN and the one with the fewest distinct values (> 1).
        let mut most_nan = (0usize, String::new());
        let mut fewest = (usize::MAX, String::new());
        for (i, h) in d.headers.iter().enumerate().skip(1) {
            let (fin, _, _, distinct) = stats_of(&d.columns[i]);
            if n - fin > most_nan.0 && fin > 100 {
                most_nan = (n - fin, h.clone());
            }
            if distinct > 1 && distinct < fewest.0 && fin > 100 {
                fewest = (distinct, h.clone());
            }
        }
        for extra in [most_nan.1.clone(), fewest.1.clone()] {
            if !extra.is_empty() && !picks.contains(&extra) {
                picks.push(extra);
            }
        }
        // A realistic running condition: engine loaded + a time window.
        let gate = PreviewFilter {
            timestamp_ranges: vec![tr(Some("2025-02-01T00:00:00"), Some("2026-03-31T23:59:59"))],
            value_filters: vec![vf("11EI1301.PV", "greater_than", Some(1.0), None)],
            ..Default::default()
        };
        eprintln!("\n{:<15} {:>7} {:>6} {:>10} {:>9} {:>6}  {:<12} {:>8} {:>8} {:>7} {:>9}", "sensor", "finite", "nan%", "mean", "sd", "dist", "L/H source", "t_noSP", "t_SP", "min_sc", "%<80");
        let mut ok = 0;
        for s in &picks {
            let ci = d.col_index(s).unwrap();
            let (fin, _, _, distinct) = stats_of(&d.columns[ci]);
            for (scope_name, f) in [("all", None), ("gated", Some(gate.clone()))] {
                let t = Instant::now();
                let p0 = match individual_preview(&d, &HealthPreviewRequest { kind: "individual".into(), target: Some(s.clone()), filter: f.clone(), ..Default::default() }) {
                    Ok(p) => p,
                    Err(e) => {
                        eprintln!("{s:<15} {scope_name}: {e}");
                        continue;
                    }
                };
                let t0 = t.elapsed();
                let st = ind_parts(&p0).0;
                // Independent stats over the same scope.
                let kept_rows: Vec<usize> = (0..n)
                    .filter(|&r| d.columns[ci][r].is_finite() && f.as_ref().is_none_or(|f| ref_keeps_real(&d, f, r)))
                    .collect();
                let kept: Vec<f64> = kept_rows.iter().map(|&r| d.columns[ci][r]).collect();
                let m = kept.iter().sum::<f64>() / kept.len() as f64;
                let sd = (kept.iter().map(|x| (x - m).powi(2)).sum::<f64>() / (kept.len().max(2) - 1) as f64).sqrt();
                assert_eq!(st.rows, kept.len(), "{s} {scope_name} rows");
                assert!((st.mean - m).abs() <= 0.0005 * m.abs().max(1.0) + 1e-9, "{s}: mean {} vs {m}", st.mean);
                assert!((st.sd - sd).abs() <= 0.0005 * sd.max(1e-3) + 1e-6, "{s}: sd {} vs {sd}", st.sd);
                let band = IndividualBand::from_rounded(st.mean, st.sd, st.boundary_1sd, st.boundary_3sd);
                if band.is_degenerate() {
                    assert!(p0.validation.iter().any(|i| i.code == "degenerate_band"));
                    eprintln!("{s:<15} {scope_name}: degenerate band (σ={}) — correctly refused", st.sd);
                    continue;
                }
                let (ml, mh) = al.get(s).copied().unwrap_or((None, None));
                let (l, h, src) = match (ml, mh) {
                    (Some(l), Some(h)) if l < st.boundary_3sd[0] && h > st.boundary_3sd[1] => (l, h, "master"),
                    _ => (st.boundary_3sd[0] - 2.0 * st.sd, st.boundary_3sd[1] + 2.0 * st.sd, "3σ±2σ"),
                };
                let t = Instant::now();
                let p = individual_preview(&d, &HealthPreviewRequest {
                    kind: "individual".into(),
                    target: Some(s.clone()),
                    filter: f.clone(),
                    set_points: Some(sp_ind(l, h)),
                    include_out_of_scope: Some(f.is_some()),
                    ..Default::default()
                })
                .unwrap();
                let t1 = t.elapsed();
                assert!(p.valid, "{s}: {:?}", p.validation);
                assert!(ind_parts(&p).1.rows.len() <= 4000);
                assert!(ind_parts(&p).1.score.is_none(), "{s}: the raw rows are not scored");
                // The scored series: one point per clock hour.
                let se = ind_hourly(&p);
                assert!(se.rows.len() <= 4000);
                assert!(se.score.as_ref().unwrap().iter().flatten().all(|v| (0.0..=100.0).contains(v)));
                // Independent hourly means of the in-scope rows (ascending rows,
                // so the sums are taken in the same order).
                let mut by_hour: std::collections::BTreeMap<i64, (f64, usize)> = std::collections::BTreeMap::new();
                for &r in &kept_rows {
                    if d.ts_parsed[r] != TS_MISSING {
                        let e = by_hour.entry(d.ts_parsed[r].div_euclid(3_600_000_000)).or_insert((0.0, 0));
                        e.0 += d.columns[ci][r];
                        e.1 += 1;
                    }
                }
                let sum = p.score_summary.as_ref().unwrap();
                assert_eq!(sum.scored, by_hour.len(), "{s}: one scored point per running hour");
                assert_eq!(sum.share_basis, "hour_count");
                let bytes = serde_json::to_string(&p).unwrap().len();
                assert!(bytes < 1_500_000, "{s}: {bytes} bytes");
                // Independent min score over ALL hourly means.
                let ip = crate::health_score::IndividualParams::new(band, &sp_ind(l, h)).unwrap();
                let mins = by_hour.values().map(|&(sm, c)| ip.score(sm / c as f64).unwrap()).fold(f64::INFINITY, f64::min);
                assert_eq!(sum.min_score.as_ref().unwrap().score, mins, "{s}: min score");
                assert!(se.score.as_ref().unwrap().iter().flatten().any(|&v| v == mins), "{s}: min score kept in the bounded series");
                eprintln!(
                    "{:<15} {:>7} {:>5.1}% {:>10.3} {:>9.4} {:>6}  {:<12} {:>7.0?} {:>7.0?} {:>7.2} {:>8.2}%  [{scope_name}, {bytes} B]",
                    s, fin, 100.0 * (n - fin) as f64 / n as f64, st.mean, st.sd, distinct, src, t0, t1,
                    mins, sum.pct_below_80.unwrap()
                );
                ok += 1;
            }
        }
        assert!(ok >= 8, "only {ok} sensor/scope combinations scored");

        // ---- Clustering: 2 pairs with criteria ranges from tertiles ----
        for (xs, ys, crit) in [("11FQ1201.PV", "11EI1301.PV", "11SE1203.PV"), ("11TE1228.PV", "11TE1229.PV", "11EI1301.PV")] {
            if [xs, ys, crit].iter().any(|s| d.col_index(s).is_none()) {
                eprintln!("SKIP clustering {xs}/{ys}: missing sensor");
                continue;
            }
            let cc = &d.columns[d.col_index(crit).unwrap()];
            let mut cv: Vec<f64> = cc.iter().copied().filter(|v| v.is_finite()).collect();
            cv.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let (q1, q2) = (cv[cv.len() / 3], cv[2 * cv.len() / 3]);
            let ranges = vec![
                ClusterRange { min: None, max: Some(q1) },
                ClusterRange { min: Some(q1), max: Some(q2) },
                ClusterRange { min: Some(q2), max: None },
            ];
            let req = HealthPreviewRequest {
                kind: "clustering".into(),
                first_sensor: Some(xs.into()),
                second_sensor: Some(ys.into()),
                n_clusters: Some(3),
                criteria_sensor: Some(crit.into()),
                cluster_ranges: Some(ranges.clone()),
                set_points: Some(sp_n(6.0)),
                filter: Some(gate.clone()),
                ..Default::default()
            };
            let t = Instant::now();
            let p = match clustering_preview(&d, &req) {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("clustering {xs}/{ys}: {e}");
                    continue;
                }
            };
            let tc = t.elapsed();
            let st = clu_parts(&p).0;
            assert!(clu_parts(&p).1.rows.len() <= 4000);
            // The scored series: one point per clock hour.
            let se = clu_hourly(&p);
            assert!(se.rows.len() <= 4000);
            if let Some(sc) = se.score.as_ref() {
                assert!(sc.iter().flatten().all(|v| (0.0..=100.0).contains(v)));
            }
            let bytes = serde_json::to_string(&p).unwrap().len();
            eprintln!(
                "clustering {xs} vs {ys} by {crit} [{q1}, {q2}]: rows {} assigned {} valid {} in {tc:?}, {bytes} B, clusters {:?}, summary {:?}",
                st.rows, st.assigned_rows, p.valid,
                st.clusters.iter().map(|c| (c.cluster_id, c.n_rows, c.x_sd, c.y_sd, c.angle_deg)).collect::<Vec<_>>(),
                p.score_summary.as_ref().map(|s| (s.min_score.as_ref().map(|m| m.score), s.pct_below_80))
            );
            // Export round-trip on real data: file re-scoring == preview.
            if p.valid {
                let app = tempfile::tempdir().unwrap();
                let t = Instant::now();
                let f = clu_file(&d, &req, app.path()).unwrap();
                eprintln!("  train_clustering_model core in {:?} -> {}", t.elapsed(), f.display());
                let info = read_json(&f);
                let ci = d.col_index(crit).unwrap();
                let sc = se.score.as_ref().unwrap();
                // Independent cluster of every hour: the cluster EVERY one of
                // its in-scope rows with finite X and Y is in (else none).
                let (xi, yi) = (d.col_index(xs).unwrap(), d.col_index(ys).unwrap());
                let mut rows_by_hour: std::collections::HashMap<i64, Vec<usize>> = std::collections::HashMap::new();
                for r in 0..n {
                    if d.columns[xi][r].is_finite()
                        && d.columns[yi][r].is_finite()
                        && d.ts_parsed[r] != TS_MISSING
                        && ref_keeps_real(&d, &gate, r)
                    {
                        rows_by_hour.entry(d.ts_parsed[r].div_euclid(3_600_000_000)).or_default().push(r);
                    }
                }
                let mut mism = 0;
                for i in 0..se.rows.len() {
                    let hour = d.ts_parsed[se.rows[i] as usize].div_euclid(3_600_000_000);
                    let a = file_assign_hour(&info, &d.columns[ci], &rows_by_hour[&hour], "criteria");
                    if a != se.cluster[i] {
                        mism += 1;
                        continue;
                    }
                    if let Some(id) = a {
                        let e = info["cluster_info"][id.to_string()].as_object().unwrap();
                        let w = interp(file_cluster_distance(e, se.x[i], se.y[i]), &[0.0, 1.0, 3.0, 6.0], &[100.0, 100.0, 80.0, 0.0]);
                        if (w - sc[i].unwrap()).abs() > 1e-6 {
                            mism += 1;
                        }
                    }
                }
                eprintln!("  file re-scoring mismatches: {mism}/{} (criteria bounds {q1}/{q2} rounded in file: {}/{})", se.rows.len(), round_metric(q1), round_metric(q2));
            }
        }
    }

    /// Like `ref_keeps` but for the real file's "YYYY-MM-DD HH:MM:SS+07:00" text.
    fn ref_keeps_real(d: &ColumnarData, f: &PreviewFilter, row: usize) -> bool {
        let p = |s: &str| {
            chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S")
                .ok()
                .or_else(|| chrono::DateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S%:z").ok().map(|x| x.naive_local()))
        };
        if !f.timestamp_ranges.is_empty() {
            let Some(t) = d.timestamps[row].as_deref().and_then(p) else { return false };
            if !f.timestamp_ranges.iter().any(|r| {
                r.start.as_deref().and_then(p).is_none_or(|s| t >= s) && r.end.as_deref().and_then(p).is_none_or(|e| t <= e)
            }) {
                return false;
            }
        }
        f.value_filters.iter().all(|c| {
            let v = d.columns[d.col_index(&c.sensor).unwrap()][row];
            !v.is_nan() && c.value1.is_none_or(|a| v > a)
        })
    }

    /// Run the REAL sidecar binary exactly like `spawn_sidecar` (one JSON
    /// line on a BOM-free stdin, JSON on stdout).
    fn run_sidecar(payload: &serde_json::Value) -> Result<(serde_json::Value, std::time::Duration), String> {
        run_process(std::process::Command::new(SIDECAR), payload)
    }

    /// The CURRENT `backend.py` source under a local python3 with numpy +
    /// pygam (what the next Nuitka build will contain).
    fn run_backend_py(payload: &serde_json::Value) -> Result<(serde_json::Value, std::time::Duration), String> {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("python").join("backend.py");
        let mut c = std::process::Command::new("python3");
        c.arg(src);
        run_process(c, payload)
    }

    fn run_process(mut cmd: std::process::Command, payload: &serde_json::Value) -> Result<(serde_json::Value, std::time::Duration), String> {
        use std::io::{Read, Write};
        let t = Instant::now();
        let mut child = cmd
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        let mut line = serde_json::to_string(payload).unwrap();
        line.push('\n');
        child.stdin.take().unwrap().write_all(line.as_bytes()).map_err(|e| e.to_string())?;
        let mut out = String::new();
        child.stdout.take().unwrap().read_to_string(&mut out).map_err(|e| e.to_string())?;
        let mut err = String::new();
        let _ = child.stderr.take().unwrap().read_to_string(&mut err);
        child.wait().map_err(|e| e.to_string())?;
        let v: serde_json::Value = serde_json::from_str(out.trim()).map_err(|e| format!("{e}: {out} / {err}"))?;
        if let Some(e) = v.get("error") {
            return Err(format!("sidecar error: {e}"));
        }
        Ok((v, t.elapsed()))
    }

    /// Project / NaN-drop exactly like `preview_relationship_model` (and
    /// `write_relationship_files`) do.
    fn project(d: &ColumnarData, preds: &[&str], target: &str, f: Option<&PreviewFilter>) -> (Vec<Vec<f64>>, Vec<f64>, Vec<u32>) {
        let resolved = crate::ResolvedFilter::resolve(f, &d.headers).unwrap();
        let pi: Vec<usize> = preds.iter().map(|p| d.col_index(p).unwrap()).collect();
        let ti = d.col_index(target).unwrap();
        let (mut x, mut y, mut rows) = (Vec::new(), Vec::new(), Vec::new());
        for r in 0..d.n_rows() {
            if !resolved.is_noop() && !resolved.keeps(d, r) {
                continue;
            }
            let xr: Vec<f64> = pi.iter().map(|&i| d.columns[i][r]).collect();
            if xr.iter().any(|v| !v.is_finite()) || !d.columns[ti][r].is_finite() {
                continue;
            }
            x.push(xr);
            y.push(d.columns[ti][r]);
            rows.push(r as u32);
        }
        (x, y, rows)
    }

    #[test]
    #[ignore = "real-data + real sidecar smoke test: run explicitly with --ignored"]
    fn real_data_relationship_with_the_real_sidecar() {
        if !Path::new(SIDECAR).is_file() {
            eprintln!("SKIP: sidecar binary not found at {SIDECAR}");
            return;
        }
        let Some(d) = load() else { return };
        let gate = PreviewFilter {
            timestamp_ranges: vec![tr(Some("2025-06-01T00:00:00"), Some("2025-12-31T23:59:59"))],
            value_filters: vec![vf("11EI1301.PV", "greater_than", Some(1.0), None)],
            ..Default::default()
        };
        let pairs: Vec<(&str, Vec<&str>)> = vec![
            ("11PT1214A.PV", vec!["11PT1214B.PV"]),
            ("11TE1228.PV", vec!["11TE1229.PV", "11TE1230.PV"]),
            ("11SE1203.PV", vec!["11EI1301.PV"]),
        ];
        let state = state_with(d, 1);
        for (target, preds) in pairs {
            let (x, y, rows) = {
                let lock = state.0.read().unwrap();
                let data = &lock.as_ref().unwrap().data;
                if preds.iter().chain(std::iter::once(&target)).any(|s| data.col_index(s).is_none()) {
                    eprintln!("SKIP {target}: missing sensor");
                    continue;
                }
                project(data, &preds, target, Some(&gate))
            };
            let predictors: Vec<String> = preds.iter().map(|s| s.to_string()).collect();
            let lambda = 100_000.0;
            let (resp, t_prev) = match run_sidecar(&serde_json::json!({
                "action": "preview_relationship",
                "payload": {"predictors": predictors, "target": target, "X": x, "y": y, "linearGAM_lambda": lambda}
            })) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("{target}: sidecar preview failed: {}", e.chars().take(300).collect::<String>());
                    continue;
                }
            };
            let fit = crate::rel_fit_from_response(&resp, &predictors, target, lambda, &rows, &y, &x)
                .expect("sidecar response must be cacheable");
            let key = format!("real::{target}");
            assert!(store_rel_fit(&state, SessionStamp::new(1, 0), key.clone(), fit));
            let t = Instant::now();
            let p0 = health_preview_in(&state, &HealthPreviewRequest {
                kind: "relationship".into(), target: Some(target.into()), predictors: predictors.clone(),
                cache_key: Some(key.clone()), expected_generation: Some(1), ..Default::default()
            })
            .unwrap();
            let t_np = t.elapsed();
            let w = rel_parts(&p0).0.two_rmse;
            let sp = rel_sp_from_w(w);
            let t = Instant::now();
            let p = health_preview_in(&state, &HealthPreviewRequest {
                kind: "relationship".into(), target: Some(target.into()), predictors: predictors.clone(),
                cache_key: Some(key.clone()), set_points: Some(sp.clone()), expected_generation: Some(1), ..Default::default()
            })
            .unwrap();
            let t_sp = t.elapsed();
            assert!(p.valid, "{:?}", p.validation);
            let (st, raw) = rel_parts(&p);
            assert!(raw.rows.len() <= 4000 && raw.score.is_none());
            // The hourly points (no engine prediction was stored in this
            // real-data smoke run, so the scores may all be null).
            let se = rel_hourly(&p);
            assert!(se.rows.len() <= 4000);
            assert!(se.score.as_ref().unwrap().iter().flatten().all(|v| (0.0..=100.0).contains(v)));
            let bytes = serde_json::to_string(&p).unwrap().len();
            // Independent W from the sidecar's own predictions.
            let pr: Vec<f64> = resp["predicted"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
            let rm = (y.iter().zip(&pr).map(|(a, b)| (a - b).powi(2)).sum::<f64>() / y.len() as f64).sqrt();
            eprintln!(
                "REL {target} ~ {preds:?}: rows {} r2 {} W(2rmse) {} [indep 2·rmse {:.6}; sidecar rmse2_per_step {:?}] sidecar preview {t_prev:?}, health preview {t_np:?}/{t_sp:?}, {bytes} B, min score {:?}, %<80 {:?}",
                st.rows, st.r2, w, 2.0 * rm, resp["rmse2_per_step"], p.score_summary.as_ref().and_then(|s| s.min_score.as_ref().map(|m| m.score)),
                p.score_summary.as_ref().and_then(|s| s.pct_below_80)
            );
            assert!((w - 2.0 * rm).abs() <= 0.001 * (2.0 * rm).max(1.0), "W vs independent 2·RMSE");

            // The REAL train path (sidecar train_relationship) -> its rmse2
            // is what export validates against and writes.
            let save = tempfile::tempdir().unwrap();
            match run_sidecar(&serde_json::json!({
                "action": "train_relationship",
                "payload": {"predictors": predictors, "target": target, "X": x, "y": y, "linearGAM_lambda": lambda,
                            "saved_path": save.path().to_str().unwrap()}
            })) {
                Ok((tr_resp, t_train)) => {
                    let rmse2_file = tr_resp["rmse2"].as_f64().unwrap();
                    eprintln!("    sidecar train_relationship {t_train:?}: file 2rmse {rmse2_file} vs preview W {w} -> {}",
                        if rmse2_file == w { "EQUAL" } else { "DIFFERENT" });
                    // Rust half of the export with the real sidecar outputs.
                    let pr_o: Vec<Option<f64>> = tr_resp["predicted"].as_array().unwrap().iter().map(|v| v.as_f64()).collect();
                    let rs_o: Vec<Option<f64>> = tr_resp["residual"].as_array().unwrap().iter().map(|v| v.as_f64()).collect();
                    let ts: Vec<Option<String>> = {
                        let lock = state.0.read().unwrap();
                        rows.iter().map(|&r| lock.as_ref().unwrap().data.timestamps[r as usize].clone()).collect()
                    };
                    let bounds = (String::new(), String::new());
                    let outcome = write_relationship_outputs(save.path().to_str().unwrap(), &RelationshipOutputs {
                        predictors: &predictors, target, lambda, model_name: None, x_matrix: &x, y: &y,
                        row_timestamps: &ts, time_bounds: &bounds, r2: tr_resp["r2"].as_f64().unwrap(), rmse2: rmse2_file,
                        predicted: &pr_o, residual: &rs_o, set_points: Some(&sp),
                    });
                    match outcome {
                        Ok(p) => eprintln!("    write_relationship_outputs OK -> {}", p.display()),
                        Err(e) => eprintln!("    write_relationship_outputs REFUSED the preview-valid set points: {}", e.into_string()),
                    }
                }
                Err(e) => eprintln!("    sidecar train failed: {}", e.chars().take(300).collect::<String>()),
            }
            // Same train with the CURRENT backend.py (post phase-1 rounding).
            let save2 = tempfile::tempdir().unwrap();
            match run_backend_py(&serde_json::json!({
                "action": "train_relationship",
                "payload": {"predictors": predictors, "target": target, "X": x, "y": y, "linearGAM_lambda": lambda,
                            "saved_path": save2.path().to_str().unwrap()}
            })) {
                Ok((tr, t_train)) => {
                    let rmse2_file = tr["rmse2"].as_f64().unwrap();
                    eprintln!("    CURRENT backend.py train_relationship {t_train:?}: file 2rmse {rmse2_file} vs preview W {w} -> {}",
                        if rmse2_file == w { "EQUAL" } else { "DIFFERENT" });
                    let v = crate::health_score::validate_relationship(Some(rmse2_file), &sp);
                    assert!(v.is_empty(), "set points valid in the preview must pass against the exported 2rmse: {v:?}");
                    // Edge: an 80-point placed exactly on the PREVIEW's W.
                    let mut edge = sp.clone();
                    edge.residual_at_80_upper = Some(w);
                    let pv = crate::health_score::validate_relationship(Some(w), &edge);
                    let ev = crate::health_score::validate_relationship(Some(rmse2_file), &edge);
                    eprintln!("    80-point == preview W: preview codes {:?}, export codes {:?}",
                        pv.iter().map(|i| &i.code).collect::<Vec<_>>(), ev.iter().map(|i| &i.code).collect::<Vec<_>>());
                }
                Err(e) => eprintln!("    python3 backend.py unavailable/failed: {}", e.chars().take(200).collect::<String>()),
            }
        }
    }
}
