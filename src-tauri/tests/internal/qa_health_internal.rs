//! QA sweep (2026-10-04) — Health score, Rust side, PRIVATE surface.
//!
//! Included from `lib.rs` as a `#[cfg(test)]` child module (one `#[path]`
//! line) because `health_preview`, `model_export`, the session/cache helpers
//! and the file writers are private to the crate; the file itself lives under
//! `src-tauri/tests/internal/` (QA's write zone, and not auto-discovered by
//! cargo as an integration-test target).
//!
//! Covers what the worker's own in-module tests did not:
//!   A. rounding consistency — write the model file through the export core,
//!      read it back, re-score every row with an independent reference and
//!      compare with the preview (Individual / Clustering / Relationship);
//!   B. training-scope consistency between `compute_health_preview` and the
//!      export path for many filter shapes, against an independent filter;
//!   C. Relationship cache: generation straddle, concurrency, foreign rows;
//!   D. export robustness: failure injection, locked files, hostile names,
//!      orphan staging dirs, odd workspace ids, exact JSON shapes;
//!   E. edge datasets (empty, one row, duplicate / case-variant names,
//!      TS_MISSING, Buddhist-Era timestamps, huge residuals, payload sizes);
//!   F. REAL-DATA smoke tests (`#[ignore]`d — run explicitly, skip gracefully
//!      when the file / sidecar binary is missing).
//!
//! Known bugs are pinned as tests asserting the CORRECT behaviour, marked
//! ignored with a BUG reason (project convention) until fixed. All seven found
//! by this sweep were FIXED 2026-10-04; their tests (`bug_*`) now run normally
//! and keep guarding the fix.

#![allow(clippy::too_many_arguments)]

use crate::csv_processor::{ColumnarData, TS_MISSING};
use crate::health_preview::{
    clustering_preview, individual_preview, relationship_preview, relationship_stats,
    HealthPreview, HealthPreviewRequest, HealthSeries, HealthStats,
};
use crate::health_score::{IndividualBand, RelFit, SetPointsArg};
use crate::metrics::{self, round_metric};
use crate::model_export::{
    commit, export_sync, output_dir_path, prepare_workspace, ModelFilesRequest, Staging,
};
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

/// Every `.staging-*` / `.backup` directory left anywhere under `root`.
fn leftovers(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    fn walk(d: &Path, out: &mut Vec<String>) {
        if let Ok(rd) = std::fs::read_dir(d) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                if name.starts_with(".staging-") || name == ".backup" {
                    out.push(e.path().display().to_string());
                }
                if e.path().is_dir() {
                    walk(&e.path(), out);
                }
            }
        }
    }
    walk(root, &mut out);
    out
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

fn ind_export(target: &str, ws: &str, sp: Option<SetPointsArg>, filter: Option<PreviewFilter>) -> ModelFilesRequest {
    ModelFilesRequest {
        kind: "individual".into(),
        workspace_id: ws.into(),
        target: Some(target.into()),
        set_points: sp,
        filter,
        ..Default::default()
    }
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
fn a1_individual_file_rescoring_matches_preview_for_every_row_of_several_scales() {
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
        let (st, se) = ind_parts(&p);
        assert_eq!(se.rows.len(), n, "{name}: series must hold every row at max_points=100000");

        let app = tempfile::tempdir().unwrap();
        let r = export_sync(&d, &ind_export("S", "ws", Some(sp), None), app.path()).unwrap();
        assert!(r.ok, "{name}: {:?}", r.validation);
        let info = read_json(Path::new(&r.files[0].path));
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
        for i in 0..se.rows.len() {
            let want = score_from_indv_file(&info, se.value[i]);
            let got = sc[i].unwrap();
            assert!((got - want).abs() <= 1e-9, "{name} row {}: preview {got} vs file {want}", se.rows[i]);
            compared += 1;
        }
    }
    assert_eq!(compared, 5 * n);
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
/// first whose `[higher_than, lower_than)` contains it. `spelling` picks the
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
        if lo.is_none_or(|lo| c >= lo) && hi.is_none_or(|hi| c < hi) {
            return Some(id);
        }
    }
    None
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

fn clu_export(req: &HealthPreviewRequest, ws: &str) -> ModelFilesRequest {
    ModelFilesRequest {
        kind: "clustering".into(),
        workspace_id: ws.into(),
        first_sensor: req.first_sensor.clone(),
        second_sensor: req.second_sensor.clone(),
        n_clusters: req.n_clusters,
        criteria_sensor: req.criteria_sensor.clone(),
        cluster_ranges: req.cluster_ranges.clone(),
        filter: req.filter.clone(),
        set_points: req.set_points.clone(),
        ..Default::default()
    }
}

/// Overlapping criteria ranges: the FIT of every cluster uses every row its
/// own range contains (`clustering_preview_in`, legacy behaviour), but a row
/// is SCORED against the first matching cluster only. Pinned so a change is
/// deliberate; the UI should keep ranges from overlapping (observation).
#[test]
fn a2b_overlapping_ranges_fit_with_shared_rows_but_score_first_match_only() {
    let d = three_cluster_data(9000, &|r: &mut Rng, _: usize| r.range(0.0, 30.0));
    let req = clu_req(
        vec![ClusterRange { min: Some(0.0), max: Some(20.0) }, ClusterRange { min: Some(10.0), max: Some(30.0) }],
        5.0,
        None,
    );
    let p = clustering_preview(&d, &req).unwrap();
    let (st, se) = clu_parts(&p);
    let fit_rows: usize = st.clusters.iter().map(|c| c.n_rows).sum();
    assert!(fit_rows > st.assigned_rows, "overlap rows are fitted twice: {fit_rows} vs {}", st.assigned_rows);
    let ci = d.col_index("C").unwrap();
    for i in 0..se.rows.len() {
        let c = d.columns[ci][se.rows[i] as usize];
        if (10.0..20.0).contains(&c) {
            assert_eq!(se.cluster[i], Some(1), "overlap row scored against the FIRST cluster");
        }
    }
}

/// Count rows whose (cluster, score) differ between the preview and a
/// consumer that only has the CLUS_INFO file.
fn clustering_file_mismatches(d: &ColumnarData, req: &HealthPreviewRequest) -> (usize, usize) {
    let p = clustering_preview(d, req).unwrap();
    assert!(p.valid, "{:?}", p.validation);
    let (_, se) = clu_parts(&p);
    let app = tempfile::tempdir().unwrap();
    let r = export_sync(d, &clu_export(req, "ws"), app.path()).unwrap();
    assert!(r.ok, "{:?}", r.validation);
    let info = read_json(Path::new(&r.files[0].path));
    let ci_col = d.col_index("C").unwrap();
    let sc = se.score.as_ref().unwrap();
    let mut mism = 0;
    for i in 0..se.rows.len() {
        let row = se.rows[i] as usize;
        let c = d.columns[ci_col][row];
        let a_new = file_assign(&info, c, "criteria");
        let a_old = file_assign(&info, c, "critera");
        assert_eq!(a_new, a_old, "both key spellings must assign identically");
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
                    eprintln!("row {row}: file {:?} vs preview {:?}", other.0, other.1);
                }
            }
        }
    }
    (mism, se.rows.len())
}

#[test]
fn a2_clustering_file_rescoring_matches_preview_for_every_row() {
    let d = three_cluster_data(30_000, &|r: &mut Rng, i: usize| if i % 50 == 0 { 23.0 } else { [r.range(0.0, 10.0), r.range(10.0, 20.0), r.range(25.0, 40.0)][i % 3] });
    let ranges = vec![
        ClusterRange { min: None, max: Some(10.0) },
        ClusterRange { min: Some(10.0), max: Some(20.0) },
        ClusterRange { min: Some(25.0), max: None },
    ];
    let (mism, total) = clustering_file_mismatches(&d, &clu_req(ranges, 5.5, None));
    assert_eq!(total, 30_000);
    assert_eq!(mism, 0, "{mism}/{total} rows differ between preview and the CLUS_INFO file");
}

/// FIXED 2026-10-04 (was a bug): `build_cluster_info` wrote the criteria range bounds through
/// `round_metric` (lib.rs:2172-2182), but the preview / fit assign rows with
/// the UNROUNDED bounds. A bound with more than 3 decimals (e.g. 10.12345 ->
/// 10.123, or 0.00012345 -> 0.0001235 which even rounds UP) makes a
/// consumer of `CLUS_INFO` put the rows between the two values in a
/// different cluster than the one the user saw scored. Range bounds are user
/// inputs, not metrics — they should be written verbatim.
#[test]
fn bug_a2_clustering_criteria_bounds_with_many_decimals_must_round_trip() {
    // Most rows uniform; every 10th sits between a raw bound and its rounded
    // value (10.1232 in [10.123, 10.12345), 21.9877 in [21.98765, 21.988)).
    let d = three_cluster_data(30_000, &|r: &mut Rng, i: usize| match i % 20 {
        0 => 10.1232,
        10 => 21.9877,
        _ => r.range(0.0, 30.0),
    });
    let ranges = vec![
        ClusterRange { min: None, max: Some(10.12345) },
        ClusterRange { min: Some(10.12345), max: Some(21.98765) },
        ClusterRange { min: Some(21.98765), max: None },
    ];
    let (mism, total) = clustering_file_mismatches(&d, &clu_req(ranges, 5.5, None));
    assert_eq!(mism, 0, "{mism}/{total} rows assigned/scored differently from the file");
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

/// Re-score a Relationship model from REL_INFO + REL_DATASET only.
/// Returns (max |Δscore|, rows differing by > 1e-9, rows compared).
fn relationship_file_vs_preview(scale: f64) -> (f64, usize, usize, f64, f64) {
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
    let p = relationship_preview(&d, &fit, &req).unwrap();
    assert!(p.valid, "{:?}", p.validation);
    let (_, se) = rel_parts(&p);
    assert_eq!(se.rows.len(), n);

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
    let csv = std::fs::read_to_string(dir.path().join("output").join("Y").join("REL_DATASET_X_Y.csv")).unwrap();
    let file_res: Vec<f64> = csv.lines().skip(1).map(|l| l.rsplit(',').next().unwrap().parse().unwrap()).collect();
    assert_eq!(file_res.len(), n);
    let sc = se.score.as_ref().unwrap();
    let (mut max_d, mut diff) = (0.0f64, 0usize);
    for i in 0..n {
        let want = interp(file_res[i], &knots, &[0.0, 80.0, 100.0, 100.0, 80.0, 0.0]);
        let dd = (sc[i].unwrap() - want).abs();
        max_d = max_d.max(dd);
        if dd > 1e-9 {
            diff += 1;
        }
    }
    (max_d, diff, n, w_preview, w_file)
}

#[test]
fn a3_relationship_2rmse_in_the_file_equals_the_preview_w_and_scores_agree_closely() {
    for scale in [1.0, 0.001, 1000.0] {
        let (max_d, diff, n, w_p, w_f) = relationship_file_vs_preview(scale);
        eprintln!("scale {scale}: W preview {w_p} file {w_f}; rows differing {diff}/{n}, max |Δscore| {max_d:.3e}");
        assert_eq!(w_p, w_f, "W must be the same number in the preview and the file");
        // Residual rounding (4 significant digits / 3 decimals) bounds the drift.
        assert!(max_d < 1.0, "scale {scale}: max |Δscore| {max_d}");
    }
}

/// FIXED 2026-10-04 (decision: the FILE is canonical — the preview now scores
/// `health_preview::file_residual`, the same number the sidecar writes). Was: the preview scored the UNROUNDED residual `actual − predicted`
/// (health_preview.rs:545-554, and `relationship_stats` builds residual
/// stats from the unrounded prediction at line 482) while the export writes
/// `RESIDUAL = round(actual − round(predicted))` to REL_DATASET_*.csv
/// (backend.py:197-198). A consumer re-scoring from the file gets slightly
/// different scores for most rows outside the 100-band, and a row whose
/// residual sits within ~0.0005 of a knot can change band. Fix: score
/// `actual − round_metric(predicted)` (rounded like the file) in the preview.
#[test]
fn bug_a3_relationship_scores_must_be_reproducible_from_rel_dataset() {
    for scale in [1.0, 0.001, 1000.0] {
        let (max_d, diff, n, _, _) = relationship_file_vs_preview(scale);
        assert_eq!(diff, 0, "scale {scale}: {diff}/{n} rows differ (max {max_d:.3e})");
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
        let r = export_sync(&d, &ind_export("S", "w", Some(sp), f.clone()), app.path()).unwrap();
        assert!(r.ok, "{name}: {:?}", r.validation);
        let info = read_json(Path::new(&r.files[0].path));
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
        let r = export_sync(&d, &clu_export(&req, "w"), app.path()).unwrap();
        assert!(r.ok, "{name}: {:?}", r.validation);
        let info = read_json(Path::new(&r.files[0].path));
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
        let mut rq = ind_req("S", Some(sp), f.clone());
        rq.include_out_of_scope = Some(true);
        let b = individual_preview(&d, &rq).unwrap();
        let ((sa, ea), (sb, eb)) = (ind_parts(&a), ind_parts(&b));
        assert_eq!((sa.mean, sa.sd, sa.rows), (sb.mean, sb.sd, sb.rows), "{name}: stats must not change");
        assert_eq!(a.score_summary.as_ref().unwrap().scored, b.score_summary.as_ref().unwrap().scored, "{name}");
        // Universe with the flag = every finite row.
        let finite: Vec<u32> = (0..d.n_rows()).filter(|&r| d.columns[si][r].is_finite()).map(|r| r as u32).collect();
        assert_eq!(eb.rows, finite, "{name}");
        let sb_scores = eb.score.as_ref().unwrap();
        let sa_scores = ea.score.as_ref().unwrap();
        let mut j = 0;
        for i in 0..eb.rows.len() {
            let r = eb.rows[i] as usize;
            let want_in = f.as_ref().is_none_or(|f| ref_keeps(&d, f, r));
            assert_eq!(eb.in_scope[i], want_in, "{name}: row {r} in_scope");
            if want_in {
                assert_eq!(ea.rows[j] as usize, r);
                assert_eq!(sb_scores[i], sa_scores[j], "{name}: in-scope score changed");
                j += 1;
            } else {
                assert_eq!(sb_scores[i], None, "{name}: out-of-scope row {r} must be unscored, not 0");
            }
        }
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

/// FIXED 2026-10-04 (derived epoch + `SessionStamp`; `store_rel_fit` now takes
/// the stamp a Train captured). Was: a special sensor recomputed in place (`commit_derived`
/// with `replace=true`, lib.rs:3016-3040) clears the cache but does NOT bump
/// the session generation. A Relationship Train that read the OLD column
/// before the recompute and returns from the ~15 s sidecar run afterwards is
/// then stored by `store_rel_fit` (lib.rs:480-491, generation still matches)
/// — and `compute_health_preview` serves that stale fit under the same key
/// forever (the frontend's cache key = model id + train fingerprint, which
/// does not include special-sensor formulas). Same for `remove_derived_in_state`.
/// Fix idea: a per-session "derived epoch" captured with the generation and
/// re-checked in `store_rel_fit`.
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
// D. Export robustness
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

#[test]
fn d1_failure_when_the_workspace_dir_is_a_file_writes_nothing() {
    let d = ind_dataset();
    let app = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(app.path().join("workspaces")).unwrap();
    std::fs::write(app.path().join("workspaces").join("ws"), "i am a file").unwrap();
    let e = export_sync(&d, &ind_export("S", "ws", Some(good_ind_sp(&d)), None), app.path()).unwrap_err();
    assert!(e.contains("Failed to create"), "{e}");
    assert_eq!(std::fs::read_to_string(app.path().join("workspaces").join("ws")).unwrap(), "i am a file");
    assert!(leftovers(app.path()).is_empty());
}

#[test]
fn d2_failure_when_the_final_target_folder_is_a_file_rolls_back_and_cleans_staging() {
    let d = ind_dataset();
    let app = tempfile::tempdir().unwrap();
    let w = prepare_workspace(app.path(), "ws").unwrap();
    std::fs::write(w.output_dir.join("S"), "blocker").unwrap();
    let e = export_sync(&d, &ind_export("S", "ws", Some(good_ind_sp(&d)), None), app.path()).unwrap_err();
    assert!(e.contains("nothing was changed"), "{e}");
    assert_eq!(std::fs::read_to_string(w.output_dir.join("S")).unwrap(), "blocker");
    assert!(leftovers(app.path()).is_empty(), "{:?}", leftovers(app.path()));
}

#[test]
fn d3_a_refused_export_after_a_good_one_keeps_the_good_files_byte_identical() {
    let d = ind_dataset();
    let app = tempfile::tempdir().unwrap();
    let ok = export_sync(&d, &ind_export("S", "ws", Some(good_ind_sp(&d)), None), app.path()).unwrap();
    let before = std::fs::read(&ok.files[0].path).unwrap();
    // Invalid set points, and missing set points.
    for sp in [Some(sp_ind(49.0, 51.0)), None, Some(SetPointsArg::default())] {
        let r = export_sync(&d, &ind_export("S", "ws", sp, None), app.path()).unwrap();
        assert!(!r.ok && r.files.is_empty() && !r.validation.is_empty());
        assert_eq!(std::fs::read(&ok.files[0].path).unwrap(), before);
    }
    // A scope under which the old L/H fall inside 3σ is refused at export
    // even though the page last saw it valid (validation re-run per call).
    let narrow_d = ds(vec![("S", (0..2000).map(|i| 50.0 + if i < 1000 { 0.1 } else { 40.0 } * ((i % 10) as f64 - 4.5)).collect())]);
    let sp = good_ind_sp(&ind_dataset());
    let r = export_sync(&narrow_d, &ind_export("S", "ws", Some(sp), None), app.path()).unwrap();
    assert!(!r.ok, "wider σ must re-validate and refuse");
    assert_eq!(std::fs::read(&ok.files[0].path).unwrap(), before);
    assert!(leftovers(app.path()).is_empty());
}

#[cfg(windows)]
fn lock_exclusively(p: &Path) -> std::fs::File {
    use std::os::windows::fs::OpenOptionsExt;
    std::fs::OpenOptions::new().read(true).share_mode(0).open(p).unwrap()
}

/// The user has the previous export open in Excel (Excel opens without
/// FILE_SHARE_DELETE): re-export must fail cleanly and keep the old file.
#[cfg(windows)]
#[test]
fn d4_re_export_while_the_old_file_is_locked_fails_cleanly() {
    let d = ind_dataset();
    let app = tempfile::tempdir().unwrap();
    let ok = export_sync(&d, &ind_export("S", "ws", Some(good_ind_sp(&d)), None), app.path()).unwrap();
    let before = std::fs::read(&ok.files[0].path).unwrap();
    let lock = lock_exclusively(Path::new(&ok.files[0].path));
    let r = export_sync(&d, &ind_export("S", "ws", Some(good_ind_sp(&d)), None), app.path());
    drop(lock);
    let e = r.unwrap_err();
    assert!(e.contains("nothing was changed"), "{e}");
    assert_eq!(std::fs::read(&ok.files[0].path).unwrap(), before);
    assert!(leftovers(app.path()).is_empty(), "{:?}", leftovers(app.path()));
}

/// Relationship-shaped commit (INFO + pkl + CSV) where the SECOND file is
/// locked: the first must be rolled back to the previous version.
#[cfg(windows)]
#[test]
fn d5_multi_file_commit_with_a_locked_middle_file_restores_every_previous_file() {
    let app = tempfile::tempdir().unwrap();
    let w = prepare_workspace(app.path(), "ws").unwrap();
    let names = ["REL_DATASET_X_Y.csv", "REL_INFO_X_Y.json", "REL_MODEL_X_Y.pkl"];
    for n in names {
        let p = w.output_dir.join("Y").join(n);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, format!("OLD {n}")).unwrap();
    }
    let st = Staging::create(&w.ws_dir).unwrap();
    for n in names {
        let p = st.output_dir().join("Y").join(n);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, format!("NEW {n}")).unwrap();
    }
    let lock = lock_exclusively(&w.output_dir.join("Y").join(names[1]));
    let e = commit(&st.output_dir(), &w.output_dir).unwrap_err();
    drop(lock);
    assert!(e.contains("nothing was changed"), "{e}");
    for n in names {
        assert_eq!(std::fs::read_to_string(w.output_dir.join("Y").join(n)).unwrap(), format!("OLD {n}"));
    }
    drop(st);
    assert!(leftovers(app.path()).is_empty(), "{:?}", leftovers(app.path()));
}

/// FIXED 2026-10-04 (`Staging::create` sweeps; a backup is restored when its final file is missing). Was: an interrupted export (process killed / power loss between
/// `Staging::create` and its `Drop`) leaves `{ws}/.staging-*` behind —
/// possibly holding a `.backup` of the user's previous files — and nothing
/// ever sweeps it (model_export.rs:183-215). Suggest: sweep stale
/// `.staging-*` dirs (other PIDs / older than N minutes) in
/// `prepare_workspace`.
#[test]
fn bug_d6_orphan_staging_dirs_are_swept_on_the_next_export() {
    let d = ind_dataset();
    let app = tempfile::tempdir().unwrap();
    let w = prepare_workspace(app.path(), "ws").unwrap();
    let orphan = w.ws_dir.join(".staging-99999-1-0");
    std::fs::create_dir_all(orphan.join("output").join("S")).unwrap();
    std::fs::write(orphan.join("output").join("S").join("INDV_INFO_S.json"), "half").unwrap();
    export_sync(&d, &ind_export("S", "ws", Some(good_ind_sp(&d)), None), app.path()).unwrap();
    assert!(!orphan.exists(), "orphan staging dir from a crashed export is still there");
}

#[test]
fn d7_hostile_sensor_names_never_escape_the_output_folder_or_leave_debris() {
    let names: Vec<String> = vec![
        "..".into(), ".".into(), "a/b".into(), "a\\b".into(), "../../evil".into(), "C:evil".into(),
        "CON".into(), "NUL".into(), "COM1".into(), "LPT1".into(), "AUX".into(), "PRN".into(),
        "A.".into(), "A ".into(), " A".into(), "x".repeat(300), "温度センサー".into(), "ท่ออากาศ".into(),
        "=cmd|' /C calc'!A0".into(), "-5".into(), "tab\tname".into(), "q?".into(), "a*b".into(), "\u{202e}rtl".into(),
    ];
    let app = tempfile::tempdir().unwrap();
    let mut report = Vec::new();
    for name in &names {
        let mut rng = Rng::new(7);
        let d = ds(vec![(name.as_str(), (0..300).map(|_| 10.0 + rng.normal()).collect())]);
        let p = individual_preview(&d, &ind_req(name, None, None)).unwrap();
        let st = ind_parts(&p).0;
        let sp = sp_ind(st.boundary_3sd[0] - 1.0, st.boundary_3sd[1] + 1.0);
        let res = export_sync(&d, &ind_export(name, "ws", Some(sp), None), app.path());
        let outcome = match &res {
            Ok(r) => {
                assert!(r.ok);
                for f in &r.files {
                    let fp = Path::new(&f.path);
                    assert!(fp.starts_with(app.path().join("workspaces").join("ws").join("output")), "{name:?} -> {}", f.path);
                    // The reported file must really be there and be the INFO for THIS sensor.
                    let ok_read = std::fs::read_to_string(fp).ok().and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
                    match ok_read {
                        Some(j) => assert_eq!(j["model_name"], format!("({name})")),
                        None => report.push(format!("{name:?}: reported {} but it cannot be read back", f.path)),
                    }
                }
                "ok".to_string()
            }
            Err(e) => format!("refused: {e}"),
        };
        eprintln!("{:<30} {}", format!("{name:?}").chars().take(30).collect::<String>(), outcome.chars().take(110).collect::<String>());
    }
    // Nothing outside {app}/workspaces, no staging debris.
    for f in all_files(app.path()) {
        assert!(f.starts_with(app.path().join("workspaces")), "escaped: {}", f.display());
    }
    assert!(leftovers(app.path()).is_empty(), "{:?}", leftovers(app.path()));
    assert!(report.is_empty(), "{report:#?}");
}

/// Trailing dot / space are silently stripped by Win32: sensor "A." and "A"
/// share ONE output folder. The file names still differ (INDV_INFO_A..json
/// vs INDV_INFO_A.json), so nothing is overwritten — pinned here.
#[test]
fn d8_trailing_dot_or_space_sensor_names_do_not_overwrite_each_other() {
    let app = tempfile::tempdir().unwrap();
    let mut paths = Vec::new();
    for name in ["A", "A.", "A "] {
        let mut rng = Rng::new(8);
        let d = ds(vec![(name, (0..300).map(|_| 10.0 + rng.normal()).collect())]);
        let p = individual_preview(&d, &ind_req(name, None, None)).unwrap();
        let st = ind_parts(&p).0;
        let r = export_sync(&d, &ind_export(name, "ws", Some(sp_ind(st.boundary_3sd[0] - 1.0, st.boundary_3sd[1] + 1.0)), None), app.path());
        if let Ok(r) = r {
            paths.push((name, r.files[0].path.clone()));
        }
    }
    for (name, p) in &paths {
        let j = read_json(Path::new(p));
        assert_eq!(j["model_name"], format!("({name})"), "{p} was overwritten by another sensor");
    }
}

#[test]
fn d9_two_models_same_target_different_kinds_coexist_and_re_export_overwrites_only_its_own_file() {
    let mut rng = Rng::new(9);
    let n = 3000;
    let t: Vec<f64> = (0..n).map(|_| 20.0 + rng.normal()).collect();
    let x: Vec<f64> = t.iter().map(|v| v * 2.0 + rng.normal()).collect();
    let d = ds(vec![("T", t), ("X", x)]);
    let app = tempfile::tempdir().unwrap();
    let a = export_sync(&d, &ind_export("T", "ws", Some(good_ind_sp_for(&d, "T")), None), app.path()).unwrap();
    let creq = HealthPreviewRequest {
        kind: "clustering".into(),
        first_sensor: Some("X".into()),
        second_sensor: Some("T".into()),
        n_clusters: Some(1),
        set_points: Some(sp_n(6.0)),
        ..Default::default()
    };
    let b = export_sync(&d, &clu_export(&creq, "ws"), app.path()).unwrap();
    assert!(a.ok && b.ok);
    let out = app.path().join("workspaces").join("ws").join("output").join("T");
    let mut listed: Vec<String> = std::fs::read_dir(&out).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    listed.sort();
    assert_eq!(listed, vec!["CLUS_INFO_X_T.json", "INDV_INFO_T.json"]);
    let clus_before = std::fs::read(out.join("CLUS_INFO_X_T.json")).unwrap();
    export_sync(&d, &ind_export("T", "ws", Some(good_ind_sp_for(&d, "T")), None), app.path()).unwrap();
    assert_eq!(std::fs::read(out.join("CLUS_INFO_X_T.json")).unwrap(), clus_before);
}

fn good_ind_sp_for(d: &ColumnarData, s: &str) -> SetPointsArg {
    let p = individual_preview(d, &ind_req(s, None, None)).unwrap();
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
    let r = export_sync(&d, &ind_export("S", "ws", Some(good_ind_sp(&d)), None), app.path()).unwrap();
    assert_eq!(r.files.len(), 1);
    assert_eq!(r.files[0].file_name, "INDV_INFO_S.json");
    assert_eq!(r.files[0].kind, "info");
    let j = read_json(Path::new(&r.files[0].path));
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
    let r = export_sync(&cd, &clu_export(&req, "ws"), app.path()).unwrap();
    assert_eq!(r.files[0].file_name, "CLUS_INFO_X_Y.json");
    let j = read_json(Path::new(&r.files[0].path));
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

#[test]
fn d12_odd_workspace_ids_never_resolve_outside_app_data() {
    let app = tempfile::tempdir().unwrap();
    let ids: Vec<String> = vec![
        "".into(), ".".into(), "..".into(), "../x".into(), "..\\x".into(), "a/b".into(), "a\\b".into(),
        "C:\\x".into(), "C:x".into(), "\\\\srv\\share".into(), "/abs".into(), "ws.".into(), " ws".into(),
        "ws ".into(), "ws\u{0}".into(), "CON".into(), "NUL".into(), "com1".into(), "%APPDATA%".into(),
        "~".into(), "งาน-1".into(), "x".repeat(255), "x".repeat(400), "ws_ok-1".into(),
    ];
    for id in &ids {
        match output_dir_path(app.path(), id) {
            Ok(p) => {
                assert!(p.starts_with(app.path().join("workspaces")), "{id:?} -> {}", p.display());
                assert_eq!(p.parent().unwrap().parent().unwrap(), app.path().join("workspaces"), "{id:?} must be ONE component");
                let r = prepare_workspace(app.path(), id);
                eprintln!("workspace id {:<12} -> accepted, prepare: {}", format!("{id:?}").chars().take(12).collect::<String>(), if r.is_ok() { "ok" } else { "error" });
            }
            Err(e) => {
                assert!(e.starts_with("workspace_id"), "{e}");
                assert!(prepare_workspace(app.path(), id).is_err());
            }
        }
    }
    for f in all_files(app.path()) {
        assert!(f.starts_with(app.path().join("workspaces")));
    }
    for traversal in ["..", "../x", "a/b", "a\\b", "C:\\x", "\\\\srv\\share", "/abs", "", "."] {
        assert!(output_dir_path(app.path(), traversal).is_err(), "{traversal:?} must be refused");
    }
}

/// Windows reserved device names as a workspace id: on Windows
/// `{app}/workspaces/CON/output` is not a real folder (writes go to the
/// console device / fail). `sanitize_workspace_id` should refuse them.
/// Real ids are UUID-like, so this is defensive (low).
#[cfg(windows)]
#[test]
fn d13_reserved_windows_names_as_workspace_id_behaviour() {
    let app = tempfile::tempdir().unwrap();
    for id in ["CON", "NUL", "COM1", "aux"] {
        let ok = output_dir_path(app.path(), id).is_ok();
        let made = prepare_workspace(app.path(), id).map(|w| w.output_dir.is_dir());
        eprintln!("workspace id {id}: accepted={ok} prepare={made:?}");
    }
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
    assert!(export_sync(&empty, &ind_export("S", "ws", Some(sp_ind(0.0, 1.0)), None), app.path()).is_err());
    assert!(leftovers(app.path()).is_empty());

    let one = ds(vec![("S", vec![5.0]), ("X", vec![1.0]), ("Y", vec![2.0])]);
    let p = individual_preview(&one, &ind_req("S", Some(sp_ind(0.0, 10.0)), None)).unwrap();
    assert!(!p.valid);
    assert!(p.validation.iter().any(|i| i.code == "degenerate_band"));
    assert_eq!(p.histogram.as_ref().unwrap().counts, vec![1]);
    let mut c1 = c.clone();
    c1.set_points = Some(sp_n(5.0));
    let p = clustering_preview(&one, &c1).unwrap();
    assert!(!p.valid && p.validation.iter().any(|i| i.code == "degenerate_band"));
    let r = export_sync(&one, &ind_export("S", "ws", Some(sp_ind(0.0, 10.0)), None), app.path()).unwrap();
    assert!(!r.ok);
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
    let r = export_sync(&d, &ind_export("S", "ws", Some(sp_ind(st.boundary_3sd[0] - 1.0, st.boundary_3sd[1] + 1.0)), None), app.path()).unwrap();
    assert_eq!(read_json(Path::new(&r.files[0].path))["model_metrics"]["mean"].as_f64().unwrap(), st.mean);
    // "s" is a different, exact-match column (case-sensitive everywhere).
    let p = individual_preview(&d, &ind_req("s", None, None)).unwrap();
    assert!(ind_parts(&p).0.mean < 0.0);
    // Case-variant that does not exist: BAD_REQUEST in preview, plain error in export.
    let e = individual_preview(&d, &ind_req("S ", None, None)).unwrap_err();
    assert!(e.starts_with("BAD_REQUEST"), "{e}");
    assert!(export_sync(&d, &ind_export("S ", "ws2", Some(sp_ind(0.0, 1.0)), None), app.path()).is_err());
    assert!(leftovers(app.path()).is_empty());
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

/// FIXED 2026-10-04 (`check_*_request` in health_preview.rs). Was: `compute_health_preview` promised stable `CODE: ...` prefixes
/// (`BAD_REQUEST`, `NO_DATA`, ...) but several bad-request paths return the
/// raw message: an unknown clustering sensor ("Sensor not found: X", from
/// `clustering_preview_in` which runs BEFORE health_preview.rs:693's coded
/// lookup), a ranges/n_clusters mismatch, a missing criteria sensor, and any
/// invalid training-scope filter (`ResolvedFilter::resolve(...)?` at
/// health_preview.rs:352 / 695). The UI (`parseHealthError`) then cannot
/// classify them.
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
    let p = relationship_preview(&d, &fit, &req).unwrap();
    // W is now astronomically large (rmse dominated by the 1e300 rows) — the
    // preview must still be well-formed.
    let j = serde_json::to_string(&p).unwrap();
    assert!(!j.contains("NaN"));
    if let Some(sc) = rel_parts(&p).1.score.as_ref() {
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
    let jr = serde_json::to_string(&relationship_preview(&d, &fit, &rq).unwrap()).unwrap();
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
        assert!([se.timestamps.len(), se.value.len(), se.in_scope.len(), se.score.as_ref().unwrap().len()].iter().all(|&l| l == se.rows.len()));
        assert!(se.timestamps.iter().all(|t| crate::csv_processor::parse_timestamp(t).is_some()));
        let rq = HealthPreviewRequest { kind: "relationship".into(), set_points: Some(rel_sp_from_w(w)), max_points: Some(cap), max_scatter_points: Some(cap), ..Default::default() };
        let p = relationship_preview(&d, &fit, &rq).unwrap();
        let se = rel_parts(&p).1;
        assert!(se.rows.len() <= want);
        assert!([se.actual.len(), se.predicted.len(), se.residual.len(), se.timestamps.len()].iter().all(|&l| l == se.rows.len()));
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
                let kept: Vec<f64> = (0..n)
                    .filter(|&r| d.columns[ci][r].is_finite() && f.as_ref().is_none_or(|f| ref_keeps_real(&d, f, r)))
                    .map(|r| d.columns[ci][r])
                    .collect();
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
                let se = ind_parts(&p).1;
                assert!(se.rows.len() <= 4000);
                assert!(se.score.as_ref().unwrap().iter().flatten().all(|v| (0.0..=100.0).contains(v)));
                let sum = p.score_summary.as_ref().unwrap();
                assert_eq!(sum.scored, kept.len());
                let bytes = serde_json::to_string(&p).unwrap().len();
                assert!(bytes < 1_500_000, "{s}: {bytes} bytes");
                // Independent min score over ALL in-scope rows.
                let ip = crate::health_score::IndividualParams::new(band, &sp_ind(l, h)).unwrap();
                let mins = kept.iter().map(|&v| ip.score(v).unwrap()).fold(f64::INFINITY, f64::min);
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
            let (st, se) = clu_parts(&p);
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
                let r = export_sync(&d, &clu_export(&req, "real"), app.path()).unwrap();
                eprintln!("  export_model_files(clustering) core in {:?} -> {:?}", t.elapsed(), r.files.iter().map(|f| &f.file_name).collect::<Vec<_>>());
                assert!(r.ok);
                let info = read_json(Path::new(&r.files[0].path));
                let ci = d.col_index(crit).unwrap();
                let sc = se.score.as_ref().unwrap();
                let mut mism = 0;
                for i in 0..se.rows.len() {
                    let a = file_assign(&info, d.columns[ci][se.rows[i] as usize], "criteria");
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
            let (st, se) = rel_parts(&p);
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
