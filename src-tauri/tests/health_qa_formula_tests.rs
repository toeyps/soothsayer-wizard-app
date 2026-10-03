//! QA sweep (2026-10-04) — Health score formulas, validation, bounded-data
//! helpers and the Relationship cache, attacked through the PUBLIC
//! `health_score` surface with INDEPENDENT reference implementations written
//! from the SPEC FINAL / concept entries in `docs/PROJECT_HANDOVER.md`, not
//! from the worker's code:
//!
//!   * every kind is a piecewise-linear curve through fixed knots, evaluated
//!     here with a generic sorted-knot interpolator (`interp`) instead of the
//!     production per-branch `lerp`s;
//!   * the Clustering distance is checked against a Mahalanobis distance
//!     built from an explicitly inverted 2×2 covariance matrix;
//!   * thousands of generated cases (deterministic xorshift PRNG — no `rand`
//!     dependency) plus hand-picked knots / ulp neighbours / NaN / inf.
//!
//! Known bugs are pinned as tests that assert the CORRECT behaviour and are
//! marked ignored with a BUG reason (project convention) until fixed; the
//! two non-finite-set-point bugs below were fixed 2026-10-04 and run normally.

use tauri_app_lib::clustering::fit_single_cluster_ellipse;
use tauri_app_lib::health_score::*;

// ---------------------------------------------------------------------------
// Deterministic PRNG + helpers
// ---------------------------------------------------------------------------

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
    /// Uniform in [0, 1).
    fn f(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
    fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.f()
    }
    fn usize(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }
    /// Approximately normal (Irwin–Hall, 12 uniforms).
    fn normal(&mut self) -> f64 {
        (0..12).map(|_| self.f()).sum::<f64>() - 6.0
    }
}

/// Reference piecewise-linear interpolation through ascending knots `xs`
/// (strictly increasing) with values `ys`; flat outside. Written as a
/// binary search, structurally different from the production `lerp` chain.
fn interp(x: f64, xs: &[f64], ys: &[f64]) -> f64 {
    assert_eq!(xs.len(), ys.len());
    if x <= xs[0] {
        return ys[0];
    }
    if x >= xs[xs.len() - 1] {
        return ys[ys.len() - 1];
    }
    // first knot strictly greater than x
    let j = xs.partition_point(|&k| k <= x);
    let i = j - 1;
    let t = (x - xs[i]) / (xs[j] - xs[i]);
    ys[i] + t * (ys[j] - ys[i])
}

fn close(a: f64, b: f64, tol: f64, ctx: &str) {
    assert!(
        (a - b).abs() <= tol,
        "{ctx}: expected {b}, got {a} (|Δ| = {})",
        (a - b).abs()
    );
}

fn sp_ind(l: f64, h: f64) -> SetPointsArg {
    SetPointsArg { lower: Some(l), upper: Some(h), ..Default::default() }
}

fn sp_rel(l80: f64, u80: f64, l0: f64, u0: f64) -> SetPointsArg {
    SetPointsArg {
        residual_at_80_lower: Some(l80),
        residual_at_80_upper: Some(u80),
        residual_at_0_lower: Some(l0),
        residual_at_0_upper: Some(u0),
        ..Default::default()
    }
}

fn sp_n(n: f64) -> SetPointsArg {
    SetPointsArg { outer_sd: Some(n), ..Default::default() }
}

fn codes(v: &[Issue]) -> Vec<String> {
    v.iter().map(|i| i.code.clone()).collect()
}

/// A random but valid Individual configuration (band built like the INFO
/// file: boundaries from mean ± k·sd), with independently drawn L/H gaps.
fn random_individual(rng: &mut Rng) -> (IndividualBand, f64, f64) {
    let scale = 10f64.powf(rng.range(-4.0, 5.0));
    let mean = rng.range(-1000.0, 1000.0) * scale.min(1.0) + rng.range(-5.0, 5.0) * scale;
    let sd = scale * rng.range(0.05, 3.0);
    let band = IndividualBand::from_rounded(
        mean,
        sd,
        [mean - sd, mean + sd],
        [mean - 3.0 * sd, mean + 3.0 * sd],
    );
    // L / H strictly beyond 3σ, asymmetric gaps (sometimes tiny).
    let gl = sd * if rng.f() < 0.1 { 1e-3 } else { rng.range(0.01, 20.0) };
    let gh = sd * if rng.f() < 0.1 { 1e-3 } else { rng.range(0.01, 20.0) };
    (band, band.lower_3sd - gl, band.upper_3sd + gh)
}

fn ind_ref(b: &IndividualBand, l: f64, h: f64, v: f64) -> f64 {
    interp(
        v,
        &[l, b.lower_3sd, b.lower_1sd, b.upper_1sd, b.upper_3sd, h],
        &[0.0, 80.0, 100.0, 100.0, 80.0, 0.0],
    )
}

// ===========================================================================
// 1. Individual vs the spec
// ===========================================================================

#[test]
fn individual_matches_independent_reference_on_20k_generated_cases() {
    let mut rng = Rng::new(1);
    let mut checked = 0usize;
    for _ in 0..400 {
        let (b, l, h) = random_individual(&mut rng);
        let p = IndividualParams::new(b, &sp_ind(l, h)).expect("valid config");
        let lo = l - (h - l) * 0.2;
        let hi = h + (h - l) * 0.2;
        for _ in 0..50 {
            let v = rng.range(lo, hi);
            let got = p.score(v).unwrap();
            let want = ind_ref(&b, l, h, v);
            close(got, want, 1e-9 * 100.0, &format!("v={v} band={b:?} L={l} H={h}"));
            checked += 1;
        }
    }
    assert_eq!(checked, 20_000);
}

#[test]
fn individual_every_knot_is_exact_on_both_sides_for_generated_bands() {
    let mut rng = Rng::new(2);
    for _ in 0..2000 {
        let (b, l, h) = random_individual(&mut rng);
        let p = IndividualParams::new(b, &sp_ind(l, h)).unwrap();
        assert_eq!(p.score(b.mean).unwrap(), 100.0, "μ");
        assert_eq!(p.score(b.upper_1sd).unwrap(), 100.0, "+1σ");
        assert_eq!(p.score(b.lower_1sd).unwrap(), 100.0, "-1σ");
        assert_eq!(p.score(b.upper_3sd).unwrap(), 80.0, "+3σ must be EXACTLY 80 (never 85)");
        assert_eq!(p.score(b.lower_3sd).unwrap(), 80.0, "-3σ must be EXACTLY 80 (never 85)");
        assert_eq!(p.score(h).unwrap(), 0.0, "H");
        assert_eq!(p.score(l).unwrap(), 0.0, "L");
        // Just beyond the 0 point on each side.
        assert_eq!(p.score(h + (h.abs() + 1.0) * 1e-12).unwrap(), 0.0);
        assert_eq!(p.score(l - (l.abs() + 1.0) * 1e-12).unwrap(), 0.0);
        // Just inside the 0 point: tiny but positive and never above 80.
        let inside = h - (h - b.upper_3sd) * 1e-6;
        let s = p.score(inside).unwrap();
        assert!(s > 0.0 && s < 1e-3, "just inside H scored {s}");
    }
}

#[test]
fn individual_is_monotonic_bounded_and_continuous_per_side() {
    let mut rng = Rng::new(3);
    for _ in 0..300 {
        let (b, l, h) = random_individual(&mut rng);
        let p = IndividualParams::new(b, &sp_ind(l, h)).unwrap();
        // Upper side: from μ outwards past H.
        let steps = 2000;
        let mut prev = f64::INFINITY;
        for i in 0..=steps {
            let v = b.mean + (h - b.mean) * 1.2 * i as f64 / steps as f64;
            let s = p.score(v).unwrap();
            assert!((0.0..=100.0).contains(&s), "out of bounds {s}");
            assert!(s <= prev + 1e-9, "upper side not monotonic at {v}: {prev} -> {s}");
            prev = s;
        }
        let mut prev = f64::INFINITY;
        for i in 0..=steps {
            let v = b.mean - (b.mean - l) * 1.2 * i as f64 / steps as f64;
            let s = p.score(v).unwrap();
            assert!((0.0..=100.0).contains(&s));
            assert!(s <= prev + 1e-9, "lower side not monotonic at {v}: {prev} -> {s}");
            prev = s;
        }
        // Continuity at every knot: left and right limits agree.
        let knots = [l, b.lower_3sd, b.lower_1sd, b.upper_1sd, b.upper_3sd, h];
        for (i, &k) in knots.iter().enumerate() {
            let left = if i > 0 { k - knots[i - 1] } else { knots[1] - k };
            let right = if i + 1 < knots.len() { knots[i + 1] - k } else { k - knots[i - 1] };
            let eps = 1e-9 * left.abs().min(right.abs());
            let a = p.score(k - eps).unwrap();
            let c = p.score(k + eps).unwrap();
            assert!((a - c).abs() < 1e-5, "jump at knot {k}: {a} vs {c}");
        }
    }
}

#[test]
fn individual_is_symmetric_when_set_points_are_symmetric() {
    let mut rng = Rng::new(4);
    for _ in 0..500 {
        let mean = rng.range(-50.0, 50.0);
        let sd = rng.range(0.1, 5.0);
        let b = IndividualBand::from_rounded(mean, sd, [mean - sd, mean + sd], [mean - 3.0 * sd, mean + 3.0 * sd]);
        let gap = sd * rng.range(0.5, 10.0);
        let p = IndividualParams::new(b, &sp_ind(b.lower_3sd - gap, b.upper_3sd + gap)).unwrap();
        for _ in 0..40 {
            let d = rng.range(0.0, 3.0 * sd + gap * 1.5);
            close(p.score(mean + d).unwrap(), p.score(mean - d).unwrap(), 1e-9, "symmetry");
        }
    }
}

#[test]
fn individual_asymmetric_sigma_band_knots_hold_per_side() {
    // A band whose two sides are NOT mirror images (as can happen after
    // rounding): every knot must still be honoured on its own side.
    let b = IndividualBand { mean: 10.0, sd: 1.0, lower_1sd: 9.2, upper_1sd: 11.0, lower_3sd: 6.5, upper_3sd: 13.1 };
    let p = IndividualParams::new(b, &sp_ind(2.0, 20.0)).unwrap();
    for (v, want) in [(9.2, 100.0), (6.5, 80.0), (2.0, 0.0), (11.0, 100.0), (13.1, 80.0), (20.0, 0.0)] {
        assert_eq!(p.score(v).unwrap(), want, "knot {v}");
    }
    close(p.score((9.2 + 6.5) / 2.0).unwrap(), 90.0, 1e-9, "mid lower 1σ..3σ");
    close(p.score((13.1 + 20.0) / 2.0).unwrap(), 40.0, 1e-9, "mid upper 3σ..H");
    close(p.score((6.5 + 2.0) / 2.0).unwrap(), 40.0, 1e-9, "mid lower 3σ..L");
}

#[test]
fn individual_non_finite_values_are_unscored_never_zero() {
    let b = IndividualBand::from_rounded(0.0, 1.0, [-1.0, 1.0], [-3.0, 3.0]);
    let p = IndividualParams::new(b, &sp_ind(-5.0, 5.0)).unwrap();
    for v in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert_eq!(p.score(v), None);
    }
    // Huge but finite values score 0, not None, and do not overflow.
    assert_eq!(p.score(f64::MAX).unwrap(), 0.0);
    assert_eq!(p.score(-f64::MAX).unwrap(), 0.0);
}

#[test]
fn individual_huge_magnitude_configuration_does_not_overflow() {
    let m = 1e300;
    let sd = 1e298;
    let b = IndividualBand::from_rounded(m, sd, [m - sd, m + sd], [m - 3.0 * sd, m + 3.0 * sd]);
    let p = IndividualParams::new(b, &sp_ind(m - 10.0 * sd, m + 10.0 * sd)).unwrap();
    assert_eq!(p.score(m).unwrap(), 100.0);
    assert_eq!(p.score(m + 3.0 * sd).unwrap(), 80.0);
    let s = p.score(m + 6.5 * sd).unwrap();
    close(s, 40.0, 1e-6, "midpoint at 1e300 scale");
}

// ===========================================================================
// 1b. Relationship vs the spec
// ===========================================================================

fn rel_ref(w: f64, l80: f64, u80: f64, l0: f64, u0: f64, r: f64) -> f64 {
    interp(r, &[l0, l80, -w, w, u80, u0], &[0.0, 80.0, 100.0, 100.0, 80.0, 0.0])
}

#[test]
fn relationship_matches_independent_reference_on_20k_generated_cases() {
    let mut rng = Rng::new(10);
    let mut checked = 0;
    for _ in 0..400 {
        let scale = 10f64.powf(rng.range(-4.0, 4.0));
        let w = scale * rng.range(0.01, 5.0);
        // Asymmetric per side.
        let l80 = -(w + scale * rng.range(1e-3, 5.0));
        let u80 = w + scale * rng.range(1e-3, 5.0);
        let l0 = l80 - scale * rng.range(1e-3, 30.0);
        let u0 = u80 + scale * rng.range(1e-3, 30.0);
        let p = RelationshipParams::new(w, &sp_rel(l80, u80, l0, u0)).expect("valid");
        for _ in 0..50 {
            let r = rng.range(l0 * 1.3, u0 * 1.3);
            close(p.score(r).unwrap(), rel_ref(w, l80, u80, l0, u0, r), 1e-7, &format!("r={r}"));
            checked += 1;
        }
        // Knots exact.
        assert_eq!(p.score(w).unwrap(), 100.0);
        assert_eq!(p.score(-w).unwrap(), 100.0);
        assert_eq!(p.score(0.0).unwrap(), 100.0);
        assert_eq!(p.score(u80).unwrap(), 80.0);
        assert_eq!(p.score(l80).unwrap(), 80.0);
        assert_eq!(p.score(u0).unwrap(), 0.0);
        assert_eq!(p.score(l0).unwrap(), 0.0);
        assert_eq!(p.score(u0 * 2.0).unwrap(), 0.0);
        assert_eq!(p.score(l0 * 2.0).unwrap(), 0.0);
    }
    assert_eq!(checked, 20_000);
}

#[test]
fn relationship_asymmetric_80_0_per_side_hand_values() {
    // W = 2; lower: 80 at -3, 0 at -5; upper: 80 at 10, 0 at 40.
    let p = RelationshipParams::new(2.0, &sp_rel(-3.0, 10.0, -5.0, 40.0)).unwrap();
    close(p.score(-2.5).unwrap(), 90.0, 1e-12, "lower mid 100..80");
    close(p.score(-4.0).unwrap(), 40.0, 1e-12, "lower mid 80..0");
    close(p.score(6.0).unwrap(), 90.0, 1e-12, "upper mid 100..80");
    close(p.score(25.0).unwrap(), 40.0, 1e-12, "upper mid 80..0");
    assert_eq!(p.score(-5.000001).unwrap(), 0.0);
    assert_eq!(p.score(40.000001).unwrap(), 0.0);
    // Residual exactly ±W and tiny steps beyond it.
    assert_eq!(p.score(2.0).unwrap(), 100.0);
    assert!(p.score(2.0 + 1e-9).unwrap() < 100.0);
    assert!(p.score(-2.0 - 1e-9).unwrap() < 100.0);
}

#[test]
fn relationship_monotonic_and_bounded() {
    let mut rng = Rng::new(11);
    for _ in 0..200 {
        let w = rng.range(0.1, 3.0);
        let p = RelationshipParams::new(
            w,
            &sp_rel(-(w + rng.range(0.1, 2.0)), w + rng.range(0.1, 2.0), -(w + 2.5), w + 2.5 + rng.range(0.0, 5.0)),
        );
        let Ok(p) = p else { continue };
        let mut prev = f64::INFINITY;
        for i in 0..1000 {
            let r = 15.0 * i as f64 / 1000.0;
            let s = p.score(r).unwrap();
            assert!((0.0..=100.0).contains(&s));
            assert!(s <= prev + 1e-9);
            prev = s;
        }
        let mut prev = f64::INFINITY;
        for i in 0..1000 {
            let r = -15.0 * i as f64 / 1000.0;
            let s = p.score(r).unwrap();
            assert!(s <= prev + 1e-9);
            prev = s;
        }
    }
}

// ===========================================================================
// 1c. Clustering vs the spec
// ===========================================================================

/// Mahalanobis distance from an explicitly inverted covariance
/// Σ = R·diag(a², b²)·Rᵀ (R = rotation by `angle_deg`), independent of the
/// production rotate-then-scale formula.
fn mahalanobis_ref(g: &ClusterGeom, x: f64, y: f64) -> f64 {
    let t = g.angle_deg.to_radians();
    let (s, c) = t.sin_cos();
    let (a2, b2) = (g.x_sd * g.x_sd, g.y_sd * g.y_sd);
    let sxx = c * c * a2 + s * s * b2;
    let syy = s * s * a2 + c * c * b2;
    let sxy = c * s * (a2 - b2);
    let det = sxx * syy - sxy * sxy;
    let (ixx, iyy, ixy) = (syy / det, sxx / det, -sxy / det);
    let (dx, dy) = (x - g.x_center, y - g.y_center);
    (dx * dx * ixx + 2.0 * dx * dy * ixy + dy * dy * iyy).sqrt()
}

fn clus_ref(d: f64, n: f64) -> f64 {
    interp(d, &[0.0, 1.0, 3.0, n], &[100.0, 100.0, 80.0, 0.0])
}

#[test]
fn clustering_distance_matches_an_explicit_inverse_covariance_at_many_angles() {
    let mut rng = Rng::new(20);
    for i in 0..2000 {
        let g = ClusterGeom {
            cluster_id: 1,
            x_center: rng.range(-100.0, 100.0),
            y_center: rng.range(-100.0, 100.0),
            x_sd: rng.range(0.5, 20.0),
            y_sd: rng.range(0.01, 5.0),
            angle_deg: if i < 16 { -180.0 + 22.5 * i as f64 } else { rng.range(-180.0, 180.0) },
        };
        for _ in 0..10 {
            let (x, y) = (g.x_center + rng.range(-60.0, 60.0), g.y_center + rng.range(-60.0, 60.0));
            let a = g.sd_distance(x, y);
            let b = mahalanobis_ref(&g, x, y);
            assert!((a - b).abs() <= 1e-7 * b.max(1.0), "angle {} : {a} vs {b}", g.angle_deg);
        }
    }
}

#[test]
fn clustering_points_on_the_1x_3x_nx_rings_score_100_80_0_at_any_rotation() {
    let mut rng = Rng::new(21);
    for _ in 0..500 {
        let g = ClusterGeom {
            cluster_id: 1,
            x_center: rng.range(-10.0, 10.0),
            y_center: rng.range(-10.0, 10.0),
            x_sd: rng.range(0.5, 4.0),
            y_sd: rng.range(0.05, 0.5),
            angle_deg: rng.range(-180.0, 180.0),
        };
        let n = 3.0 + rng.range(0.01, 6.0);
        let p = ClusteringParams::new(vec![g], &sp_n(n)).unwrap();
        for k in [1.0, 2.0, 3.0, n, 0.5 * (3.0 + n)] {
            let t = rng.range(0.0, std::f64::consts::TAU);
            // A point on the k×SD ellipse, built in the ellipse frame.
            let (u, v) = (k * g.x_sd * t.cos(), k * g.y_sd * t.sin());
            let a = g.angle_deg.to_radians();
            let (x, y) = (g.x_center + u * a.cos() - v * a.sin(), g.y_center + u * a.sin() + v * a.cos());
            let (s, d) = p.score(0, x, y).unwrap();
            close(d, k, 1e-9 * k.max(1.0), "ring distance");
            close(s, clus_ref(k, n), 1e-6, &format!("score on ring {k}"));
        }
    }
}

#[test]
fn clustering_score_function_matches_reference_and_is_monotonic() {
    let mut rng = Rng::new(22);
    for _ in 0..500 {
        let n = 3.0 + rng.range(1e-9, 10.0);
        let mut prev = f64::INFINITY;
        for i in 0..400 {
            let d = (n + 2.0) * i as f64 / 400.0;
            let s = score_clustering_distance(d, n).unwrap();
            close(s, clus_ref(d, n), 1e-9, "clustering curve");
            assert!(s <= prev + 1e-12 && (0.0..=100.0).contains(&s));
            prev = s;
        }
        assert_eq!(score_clustering_distance(1.0, n).unwrap(), 100.0);
        assert_eq!(score_clustering_distance(3.0, n).unwrap(), 80.0);
        assert_eq!(score_clustering_distance(n, n).unwrap(), 0.0);
    }
    assert_eq!(score_clustering_distance(f64::NAN, 5.0), None);
    assert_eq!(score_clustering_distance(f64::INFINITY, 5.0), None);
}

#[test]
fn clustering_n_barely_above_3_is_valid_and_steep_but_bounded() {
    let g = ClusterGeom { cluster_id: 1, x_center: 0.0, y_center: 0.0, x_sd: 1.0, y_sd: 1.0, angle_deg: 0.0 };
    let n = 3.0 + f64::EPSILON * 4.0;
    let p = ClusteringParams::new(vec![g], &sp_n(n)).expect("N just above 3 is valid");
    assert_eq!(p.score(0, 3.0, 0.0).unwrap().0, 80.0);
    for x in [3.0 + 1e-16, 3.0 + 1e-15, 3.0 + 1e-12, 3.1] {
        let s = p.score(0, x, 0.0).unwrap().0;
        assert!((0.0..=80.0).contains(&s), "x={x} s={s}");
    }
}

/// End to end against the real GMM fit: over the training points of a
/// 1-cluster fit, the mean of d² must be exactly 2 (the dimension) when d is
/// the Mahalanobis distance of the fitted (biased) Gaussian. This only holds
/// if `x_sd` / `y_sd` / `angle_deg` are interpreted with the convention the
/// fit produced them in — a swapped axis or a wrong rotation sense breaks it.
#[test]
fn fitted_ellipse_convention_gives_mean_d_squared_of_two_at_any_rotation() {
    let mut rng = Rng::new(23);
    for case in 0..60 {
        let n = 400 + rng.usize(2000);
        let (a, b) = (rng.range(0.5, 10.0), rng.range(0.05, 3.0));
        let th = rng.range(-180.0f64, 180.0).to_radians();
        let (cx, cy) = (rng.range(-500.0, 500.0), rng.range(-500.0, 500.0));
        let mut xs = Vec::with_capacity(n);
        let mut ys = Vec::with_capacity(n);
        for _ in 0..n {
            let (u, v) = (a * rng.normal(), b * rng.normal());
            xs.push(cx + u * th.cos() - v * th.sin());
            ys.push(cy + u * th.sin() + v * th.cos());
        }
        let e = fit_single_cluster_ellipse(&xs, &ys).unwrap();
        let g = ClusterGeom {
            cluster_id: 1,
            x_center: e.x_center,
            y_center: e.y_center,
            x_sd: e.x_sd,
            y_sd: e.y_sd,
            angle_deg: e.angle_deg,
        };
        let m: f64 = xs.iter().zip(&ys).map(|(&x, &y)| g.sd_distance(x, y).powi(2)).sum::<f64>() / n as f64;
        assert!((m - 2.0).abs() < 1e-6, "case {case}: mean d² = {m} (θ={}°)", th.to_degrees());
        // And the score of the cloud is mostly ≥ 80 (≈ 98.9 % inside 3σ for
        // a 2-D Gaussian).
        let p = ClusteringParams::new(vec![g], &sp_n(5.0)).unwrap();
        let hi = xs.iter().zip(&ys).filter(|(&x, &y)| p.score(0, x, y).unwrap().0 >= 80.0).count();
        assert!(hi as f64 / n as f64 > 0.95, "case {case}: only {hi}/{n} ≥ 80");
    }
}

#[test]
fn singular_or_tiny_clusters_are_rejected_by_validation() {
    // 1 row -> both SDs 0.
    let e = fit_single_cluster_ellipse(&[1.0], &[2.0]).unwrap();
    let g1 = ClusterGeom { cluster_id: 1, x_center: e.x_center, y_center: e.y_center, x_sd: e.x_sd, y_sd: e.y_sd, angle_deg: e.angle_deg };
    // 2 rows -> rank 1, minor SD 0.
    let e = fit_single_cluster_ellipse(&[1.0, 3.0], &[2.0, 5.0]).unwrap();
    let g2 = ClusterGeom { cluster_id: 2, x_center: e.x_center, y_center: e.y_center, x_sd: e.x_sd, y_sd: e.y_sd, angle_deg: e.angle_deg };
    // Collinear many rows -> singular covariance.
    let xs: Vec<f64> = (0..100).map(|i| i as f64).collect();
    let ys: Vec<f64> = xs.iter().map(|x| 2.0 * x + 1.0).collect();
    let e = fit_single_cluster_ellipse(&xs, &ys).unwrap();
    let g3 = ClusterGeom { cluster_id: 3, x_center: e.x_center, y_center: e.y_center, x_sd: e.x_sd, y_sd: e.y_sd, angle_deg: e.angle_deg };
    for g in [g1, g2, g3] {
        let v = validate_clustering(&[g], &sp_n(5.0));
        assert!(
            v.iter().any(|i| i.code == "degenerate_band" && i.field == format!("cluster_{}", g.cluster_id)),
            "cluster {g:?} must be degenerate, got {:?}",
            codes(&v)
        );
        assert!(ClusteringParams::new(vec![g], &sp_n(5.0)).is_err());
    }
}

#[test]
fn assign_cluster_edges_overlaps_unsorted_and_missing() {
    let r = vec![(None, Some(10.0)), (Some(10.0), Some(20.0)), (Some(20.0), None)];
    assert_eq!(assign_cluster(9.999_999, &r), Some(0));
    assert_eq!(assign_cluster(10.0, &r), Some(1), "[min,max): 10 belongs to the second range");
    assert_eq!(assign_cluster(20.0, &r), Some(2));
    assert_eq!(assign_cluster(-1e300, &r), Some(0));
    assert_eq!(assign_cluster(1e300, &r), Some(2));
    for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert_eq!(assign_cluster(bad, &r), None);
    }
    // Gap.
    let gap = vec![(None, Some(10.0)), (Some(15.0), None)];
    assert_eq!(assign_cluster(12.0, &gap), None);
    assert_eq!(assign_cluster(15.0, &gap), Some(1));
    // Overlapping -> first wins.
    let ov = vec![(Some(0.0), Some(20.0)), (Some(10.0), Some(30.0))];
    assert_eq!(assign_cluster(15.0, &ov), Some(0));
    assert_eq!(assign_cluster(25.0, &ov), Some(1));
    // Unsorted -> still by containment, first match.
    let un = vec![(Some(20.0), None), (None, Some(20.0))];
    assert_eq!(assign_cluster(5.0, &un), Some(1));
    assert_eq!(assign_cluster(20.0, &un), Some(0));
    // Empty range [a, a) contains nothing.
    let empty = vec![(Some(5.0), Some(5.0))];
    assert_eq!(assign_cluster(5.0, &empty), None);
    // No ranges at all.
    assert_eq!(assign_cluster(1.0, &[]), None);
}

// ===========================================================================
// 2. Validation — every rule / edge, never panics
// ===========================================================================

fn band100() -> IndividualBand {
    IndividualBand::from_rounded(100.0, 10.0, [90.0, 110.0], [70.0, 130.0])
}

#[test]
fn individual_validation_matrix_codes_fields_and_messages() {
    let b = band100();
    let cases: Vec<(Option<f64>, Option<f64>, Vec<&str>)> = vec![
        (Some(40.0), Some(160.0), vec![]),
        (None, Some(160.0), vec!["required"]),
        (Some(40.0), None, vec!["required"]),
        (None, None, vec!["required", "required"]),
        (Some(70.0), Some(160.0), vec!["lower_equals_3sd"]),
        (Some(40.0), Some(130.0), vec!["upper_equals_3sd"]),
        (Some(70.0), Some(130.0), vec!["lower_equals_3sd", "upper_equals_3sd"]),
        (Some(75.0), Some(160.0), vec!["lower_inside_3sd"]),
        (Some(100.0), Some(160.0), vec!["lower_inside_3sd"]),
        (Some(40.0), Some(125.0), vec!["upper_inside_3sd"]),
        (Some(40.0), Some(40.0), vec!["ordering", "upper_inside_3sd"]),
        (Some(160.0), Some(40.0), vec!["ordering", "lower_inside_3sd", "upper_inside_3sd"]),
        (Some(-1e308), Some(1e308), vec![]),
        (Some(70.0 - 1e-12), Some(130.0 + 1e-12), vec![]),
    ];
    for (l, h, want) in cases {
        let sp = SetPointsArg { lower: l, upper: h, ..Default::default() };
        let v = validate_individual(&b, &sp);
        assert_eq!(codes(&v), want, "L={l:?} H={h:?}");
        for i in &v {
            assert_eq!(i.severity, Severity::Error);
            assert!(!i.message.is_empty() && !i.message.contains("NaN"), "{}", i.message);
            assert!(["lower", "upper", "sd"].contains(&i.field.as_str()), "field {}", i.field);
        }
        // Validation and construction agree.
        assert_eq!(IndividualParams::new(b, &sp).is_ok(), want.is_empty());
    }
}

#[test]
fn individual_validation_degenerate_bands_never_panic() {
    let bands = [
        IndividualBand::from_rounded(5.0, 0.0, [5.0, 5.0], [5.0, 5.0]),
        IndividualBand::from_rounded(5.0, 0.1, [4.9, 5.1], [4.9, 5.1]),
        IndividualBand::from_rounded(5.0, -1.0, [6.0, 4.0], [8.0, 2.0]),
        IndividualBand::from_rounded(f64::NAN, f64::NAN, [f64::NAN; 2], [f64::NAN; 2]),
        IndividualBand::from_rounded(f64::INFINITY, f64::INFINITY, [f64::NEG_INFINITY, f64::INFINITY], [f64::NEG_INFINITY, f64::INFINITY]),
    ];
    for b in bands {
        assert!(b.is_degenerate(), "{b:?}");
        for sp in [sp_ind(1.0, 9.0), SetPointsArg::default(), sp_ind(f64::NAN, f64::NAN)] {
            let v = validate_individual(&b, &sp);
            assert!(v.iter().any(|i| i.code == "degenerate_band" && i.field == "sd"));
            assert!(IndividualParams::new(b, &sp).is_err());
        }
    }
}

/// FIXED 2026-10-04 (was: `validate_individual` accepted a NaN L or H — every
/// comparison with NaN is false, so no rule fired and scores beyond 3σ came
/// back as `Some(NaN)`, breaking the "None = unscored, otherwise 0..=100"
/// contract). Individual now refuses non-finite L / H with code `not_finite`,
/// like Clustering (`outer_sd_not_a_number`). Not reachable from the frontend
/// (JSON cannot carry NaN) but `train_individual_model` / export rely on it.
#[test]
fn bug_individual_validation_must_reject_nan_set_points() {
    let b = band100();
    let v = validate_individual(&b, &sp_ind(f64::NAN, 160.0));
    assert!(!v.is_empty(), "NaN L must be an issue");
    let v = validate_individual(&b, &sp_ind(40.0, f64::NAN));
    assert!(!v.is_empty(), "NaN H must be an issue");
}

/// Companion (was `individual_nan_set_point_currently_leaks_nan_scores`, which
/// pinned the bug): a NaN L / H can no longer reach `score()` at all.
#[test]
fn individual_nan_set_point_is_refused_so_no_nan_score_can_exist() {
    let b = band100();
    for sp in [sp_ind(f64::NAN, 160.0), sp_ind(40.0, f64::NAN)] {
        assert!(IndividualParams::new(b, &sp).is_err(), "{sp:?}");
    }
}

/// The stable code and field of every non-finite set point, per kind (each
/// non-finite value gives exactly one `not_finite` issue and no cascade).
#[test]
fn non_finite_set_points_get_the_not_finite_code_on_the_right_field() {
    let b = band100();
    for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let v = validate_individual(&b, &sp_ind(bad, 160.0));
        assert_eq!(codes(&v), vec!["not_finite"], "L={bad}");
        assert_eq!(v[0].field, "lower");
        let v = validate_individual(&b, &sp_ind(40.0, bad));
        assert_eq!(codes(&v), vec!["not_finite"], "H={bad}");
        assert_eq!(v[0].field, "upper");

        for (sp, field) in [
            (sp_rel(bad, 3.0, -5.0, 5.0), "residual_at_80_lower"),
            (sp_rel(-3.0, bad, -5.0, 5.0), "residual_at_80_upper"),
            (sp_rel(-3.0, 3.0, bad, 5.0), "residual_at_0_lower"),
            (sp_rel(-3.0, 3.0, -5.0, bad), "residual_at_0_upper"),
        ] {
            let v = validate_relationship(Some(2.0), &sp);
            assert_eq!(codes(&v), vec!["not_finite"], "{sp:?}");
            assert_eq!(v[0].field, field);
            assert!(RelationshipParams::new(2.0, &sp).is_err());
            // W unknown: same answer (the check needs no W).
            assert_eq!(codes(&validate_relationship(None, &sp)), vec!["not_finite"]);
        }
    }
}

/// FIXED 2026-10-04 (was: infinite 0-points passed Individual and Relationship
/// validation; the curve then never reached 0). Every kind refuses them now.
#[test]
fn bug_infinite_zero_points_must_be_rejected_like_clustering_does() {
    let v = validate_individual(&band100(), &sp_ind(f64::NEG_INFINITY, 160.0));
    assert!(!v.is_empty());
    let v = validate_relationship(Some(1.0), &sp_rel(-2.0, 2.0, f64::NEG_INFINITY, 5.0));
    assert!(!v.is_empty());
    assert!(!validate_clustering(
        &[ClusterGeom { cluster_id: 1, x_center: 0.0, y_center: 0.0, x_sd: 1.0, y_sd: 1.0, angle_deg: 0.0 }],
        &sp_n(f64::INFINITY)
    )
    .is_empty());
}

#[test]
fn relationship_validation_matrix() {
    let w = 2.0;
    let cases: Vec<(SetPointsArg, Vec<&str>)> = vec![
        (sp_rel(-3.0, 3.0, -5.0, 5.0), vec![]),
        (SetPointsArg::default(), vec!["required"; 4]),
        (sp_rel(-2.0, 3.0, -5.0, 5.0), vec!["point80_equals_band"]),
        (sp_rel(-3.0, 2.0, -5.0, 5.0), vec!["point80_equals_band"]),
        (sp_rel(-1.0, 3.0, -5.0, 5.0), vec!["point80_inside_band"]),
        (sp_rel(-3.0, 3.0, -3.0, 5.0), vec!["point0_equals_point80"]),
        (sp_rel(-3.0, 3.0, -5.0, 3.0), vec!["point0_equals_point80"]),
        (sp_rel(-3.0, 3.0, -2.5, 5.0), vec!["point0_inside_point80"]),
        (sp_rel(3.0, 3.0, -5.0, 5.0), vec!["must_be_negative"]),
        (sp_rel(-3.0, -3.0, -5.0, 5.0), vec!["must_be_positive"]),
        (sp_rel(-3.0, 3.0, 5.0, 5.0), vec!["must_be_negative"]),
        (sp_rel(0.0, 3.0, -5.0, 5.0), vec!["must_be_negative"]),
        (sp_rel(-3.0, 0.0, -5.0, 5.0), vec!["must_be_positive"]),
        // NaN now has its own stable code (was `must_be_negative`, 2026-10-04) —
        // the same one every kind uses for a non-finite set point.
        (sp_rel(f64::NAN, 3.0, -5.0, 5.0), vec!["not_finite"]),
    ];
    for (sp, want) in cases {
        let v = validate_relationship(Some(w), &sp);
        assert_eq!(codes(&v), want, "{sp:?}");
        assert_eq!(RelationshipParams::new(w, &sp).is_ok(), want.is_empty(), "{sp:?}");
        for i in &v {
            assert!(i.field.starts_with("residual_at_") || i.field == "two_rmse", "{}", i.field);
        }
    }
    // Degenerate / unknown W.
    for bad_w in [0.0, -1.0, f64::NAN, f64::INFINITY] {
        let v = validate_relationship(Some(bad_w), &sp_rel(-3.0, 3.0, -5.0, 5.0));
        assert_eq!(codes(&v), vec!["degenerate_band"], "W={bad_w}");
        assert_eq!(v[0].field, "two_rmse");
        assert!(RelationshipParams::new(bad_w, &sp_rel(-3.0, 3.0, -5.0, 5.0)).is_err());
    }
    // W unknown (cache miss before export): only W-free rules run.
    assert!(validate_relationship(None, &sp_rel(-3.0, 3.0, -5.0, 5.0)).is_empty());
    assert_eq!(codes(&validate_relationship(None, &sp_rel(-3.0, 3.0, -3.0, 5.0))), vec!["point0_equals_point80"]);
}

#[test]
fn clustering_validation_matrix_including_n_between_3_and_3_plus_eps() {
    let g = ClusterGeom { cluster_id: 7, x_center: 0.0, y_center: 0.0, x_sd: 1.0, y_sd: 0.5, angle_deg: 30.0 };
    let cases: Vec<(Option<f64>, Vec<&str>)> = vec![
        (None, vec!["required"]),
        (Some(3.0), vec!["outer_sd_equals_3"]),
        (Some(2.999_999_999), vec!["outer_sd_not_above_3"]),
        (Some(-4.0), vec!["outer_sd_not_above_3"]),
        (Some(0.0), vec!["outer_sd_not_above_3"]),
        (Some(f64::NAN), vec!["outer_sd_not_a_number"]),
        (Some(f64::INFINITY), vec!["outer_sd_not_a_number"]),
        (Some(3.0 + f64::EPSILON * 2.0), vec![]),
        (Some(3.000_000_001), vec![]),
        (Some(4.0), vec![]),
        (Some(1e300), vec![]),
    ];
    for (n, want) in cases {
        let sp = SetPointsArg { outer_sd: n, ..Default::default() };
        assert_eq!(codes(&validate_clustering(&[g], &sp)), want, "N={n:?}");
    }
    // Empty cluster list is an error even with a fine N.
    assert_eq!(codes(&validate_clustering(&[], &sp_n(5.0))), vec!["degenerate_band"]);
    // Non-finite geometry is degenerate, never a panic.
    for bad in [
        ClusterGeom { x_sd: f64::NAN, ..g },
        ClusterGeom { y_sd: 0.0, ..g },
        ClusterGeom { x_sd: -1.0, ..g },
        ClusterGeom { angle_deg: f64::INFINITY, ..g },
        ClusterGeom { x_center: f64::NAN, ..g },
    ] {
        let v = validate_clustering(&[bad], &sp_n(5.0));
        assert_eq!(codes(&v), vec!["degenerate_band"]);
        assert_eq!(v[0].field, "cluster_7");
    }
}

#[test]
fn validation_is_pure_and_repeatable() {
    // "re-run per call": the same input always yields the same issues and the
    // functions keep no state between calls.
    let b = band100();
    let sp = sp_ind(75.0, 125.0);
    let a = validate_individual(&b, &sp);
    for _ in 0..100 {
        assert_eq!(validate_individual(&b, &sp), a);
    }
    // A wider band (scope changed) changes the verdict immediately.
    let wide = IndividualBand::from_rounded(100.0, 20.0, [80.0, 120.0], [40.0, 160.0]);
    assert!(!validate_individual(&wide, &sp_ind(30.0, 170.0)).iter().any(|i| i.severity == Severity::Error));
    assert!(has_errors(&validate_individual(&wide, &sp_ind(40.0, 170.0))));
}

#[test]
fn validation_never_panics_on_fuzzed_inputs() {
    let specials = [
        f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 0.0, -0.0, 1e-308, -1e-308, f64::MAX, f64::MIN, 3.0, -3.0, 1.0,
    ];
    let mut rng = Rng::new(30);
    let pick = |rng: &mut Rng| -> Option<f64> {
        match rng.usize(4) {
            0 => None,
            1 => Some(specials[rng.usize(specials.len())]),
            _ => Some(rng.range(-1e3, 1e3)),
        }
    };
    for _ in 0..20_000 {
        let sp = SetPointsArg {
            lower: pick(&mut rng),
            upper: pick(&mut rng),
            residual_at_80_lower: pick(&mut rng),
            residual_at_80_upper: pick(&mut rng),
            residual_at_0_lower: pick(&mut rng),
            residual_at_0_upper: pick(&mut rng),
            outer_sd: pick(&mut rng),
        };
        let x = |rng: &mut Rng| pick(rng).unwrap_or(1.0);
        let b = IndividualBand::from_rounded(x(&mut rng), x(&mut rng), [x(&mut rng), x(&mut rng)], [x(&mut rng), x(&mut rng)]);
        let _ = validate_individual(&b, &sp);
        if let Ok(p) = IndividualParams::new(b, &sp) {
            let s = p.score(x(&mut rng));
            if let Some(s) = s {
                // Only a NaN set point (see bug test above) may break bounds.
                if sp.lower.is_some_and(|v| v.is_finite()) && sp.upper.is_some_and(|v| v.is_finite()) {
                    assert!((0.0..=100.0).contains(&s), "{s} from {b:?} {sp:?}");
                }
            }
        }
        let w = pick(&mut rng);
        let _ = validate_relationship(w, &sp);
        if let Some(w) = w {
            if let Ok(p) = RelationshipParams::new(w, &sp) {
                if let Some(s) = p.score(x(&mut rng)) {
                    if s.is_finite() {
                        assert!((0.0..=100.0).contains(&s));
                    }
                }
            }
        }
        let g = ClusterGeom {
            cluster_id: 1,
            x_center: x(&mut rng),
            y_center: x(&mut rng),
            x_sd: x(&mut rng),
            y_sd: x(&mut rng),
            angle_deg: x(&mut rng),
        };
        let _ = validate_clustering(&[g], &sp);
        if let Ok(p) = ClusteringParams::new(vec![g], &sp) {
            if let Some((s, _)) = p.score(0, x(&mut rng), x(&mut rng)) {
                assert!((0.0..=100.0).contains(&s));
            }
            assert!(p.score(5, 0.0, 0.0).is_none(), "unknown cluster index is unscored");
        }
    }
}

#[test]
fn issue_json_is_stable_for_the_ui() {
    let v = validate_relationship(Some(2.0), &sp_rel(-1.0, 3.0, -5.0, 5.0));
    let j = serde_json::to_value(&v).unwrap();
    let o = j[0].as_object().unwrap();
    let mut keys: Vec<&String> = o.keys().collect();
    keys.sort();
    assert_eq!(keys, vec!["code", "field", "message", "severity"]);
    assert_eq!(j[0]["severity"], "error");
    assert_eq!(j[0]["code"], "point80_inside_band");
    assert_eq!(j[0]["field"], "residual_at_80_lower");
}

#[test]
fn set_points_wire_formats_are_all_accepted_and_unknown_keys_ignored() {
    // What `healthSetPointsToWire` sends, what the TS model holds, and legacy names.
    for json in [
        r#"{"residual_at_80_lower":-3,"residual_at_80_upper":3,"residual_at_0_lower":-5,"residual_at_0_upper":5}"#,
        r#"{"kind":"relationship","residualAt80Lower":-3,"residualAt80Upper":3,"residualAt0Lower":-5,"residualAt0Upper":5}"#,
        r#"{"residual_at_health_80_lower":-3,"residual_at_health_80_upper":3,"residual_at_health_0_lower":-5,"residual_at_health_0_upper":5}"#,
    ] {
        let sp: SetPointsArg = serde_json::from_str(json).unwrap();
        assert_eq!(sp, sp_rel(-3.0, 3.0, -5.0, 5.0), "{json}");
    }
    let sp: SetPointsArg =
        serde_json::from_str(r#"{"kind":"individual","lower":1.5,"upper":null,"masterLower":1.5,"masterUpper":null}"#).unwrap();
    assert_eq!((sp.lower, sp.upper), (Some(1.5), None));
    let sp: SetPointsArg = serde_json::from_str(r#"{"kind":"clustering","outerSd":4.5}"#).unwrap();
    assert_eq!(sp.outer_sd, Some(4.5));
    // JSON cannot carry NaN; an out-of-range literal is rejected, not turned
    // into inf (so the inf/NaN bugs above are not reachable over IPC).
    assert!(serde_json::from_str::<SetPointsArg>(r#"{"lower":NaN}"#).is_err());
    assert!(serde_json::from_str::<SetPointsArg>(r#"{"lower":1e400}"#).is_err());
}

// ===========================================================================
// 4. Bounded data helpers
// ===========================================================================

fn check_selection(n: usize, max: usize, primary: Option<&[f64]>, score: Option<&[f64]>) -> Vec<usize> {
    let sel = select_indices(n, max, primary, score);
    let cap = max.clamp(8, MAX_SERIES_POINTS);
    assert!(sel.len() <= cap.max(n.min(cap)), "n={n} max={max} -> {}", sel.len());
    assert!(sel.len() <= n);
    assert!(sel.windows(2).all(|w| w[0] < w[1]), "ascending + unique");
    if n > 0 {
        assert_eq!(sel[0], 0);
        assert_eq!(*sel.last().unwrap(), n - 1);
    }
    // Global extremes survive.
    if let Some(p) = primary {
        let fin: Vec<(usize, f64)> = p.iter().copied().enumerate().filter(|(_, v)| v.is_finite()).collect();
        if let Some(mn) = fin.iter().map(|x| x.1).reduce(f64::min) {
            assert!(sel.iter().any(|&i| p[i] == mn), "global primary min lost (n={n} max={max})");
            let mx = fin.iter().map(|x| x.1).reduce(f64::max).unwrap();
            assert!(sel.iter().any(|&i| p[i] == mx), "global primary max lost (n={n} max={max})");
        }
    }
    if let Some(s) = score {
        if let Some(mn) = s.iter().copied().filter(|v| !v.is_nan()).reduce(f64::min) {
            assert!(sel.iter().any(|&i| s[i] == mn), "global min score lost (n={n} max={max})");
        }
    }
    sel
}

#[test]
fn select_indices_bounds_for_many_sizes_and_caps() {
    let caps = [0usize, 1, 2, 7, 8, 9, 10, 100, 4000, 100_000, 1_000_000, usize::MAX];
    let sizes = [0usize, 1, 2, 3, 8, 9, 100, 4001, 50_000, 250_000];
    let mut rng = Rng::new(40);
    for &n in &sizes {
        let p: Vec<f64> = (0..n).map(|_| rng.range(-1.0, 1.0)).collect();
        let s: Vec<f64> = (0..n).map(|_| rng.range(0.0, 100.0)).collect();
        for &m in &caps {
            check_selection(n, m, Some(&p), Some(&s));
            check_selection(n, m, Some(&p), None);
            check_selection(n, m, None, Some(&s));
            check_selection(n, m, None, None);
        }
    }
}

#[test]
fn select_indices_tiny_caps_are_raised_to_eight() {
    // Contract note (not a bug, but worth knowing): max_points 0/1/2 do NOT
    // give 0/1/2 points — the floor is 8 (HealthPreviewRequest also clamps).
    let p: Vec<f64> = (0..1000).map(|i| (i as f64).sin()).collect();
    for m in [0, 1, 2] {
        let sel = select_indices(1000, m, Some(&p), None);
        assert!(sel.len() > m && sel.len() <= 8, "m={m} -> {}", sel.len());
    }
}

#[test]
fn select_indices_adversarial_shapes_keep_dip_spike_and_lowest_score() {
    let n = 200_000;
    // single dip
    let mut p = vec![10.0; n];
    p[123_457] = -999.0;
    check_selection(n, 500, Some(&p), None);
    // single spike next to a NaN stretch
    let mut p = vec![10.0; n];
    for v in p.iter_mut().take(150_000).skip(100_000) {
        *v = f64::NAN;
    }
    p[150_000] = 1e9;
    let sel = check_selection(n, 500, Some(&p), None);
    assert!(sel.contains(&150_000));
    // plateau of identical scores with one dip of score
    let mut s = vec![100.0; n];
    s[77_777] = 3.0;
    let sel = check_selection(n, 64, Some(&vec![1.0; n]), Some(&s));
    assert!(sel.contains(&77_777));
    // alternating NaN score / value
    let p: Vec<f64> = (0..n).map(|i| if i % 2 == 0 { f64::NAN } else { (i % 1000) as f64 }).collect();
    let s: Vec<f64> = (0..n).map(|i| if i % 2 == 1 { f64::NAN } else { (i % 997) as f64 / 10.0 }).collect();
    check_selection(n, 1000, Some(&p), Some(&s));
    // all NaN
    let nan = vec![f64::NAN; n];
    let sel = check_selection(n, 300, Some(&nan), Some(&nan));
    assert!(sel.len() <= 300);
    // dip at the very first / last row
    let mut s = vec![50.0; n];
    s[n - 2] = 0.0;
    let sel = check_selection(n, 30, None, Some(&s));
    assert!(sel.contains(&(n - 2)));
}

#[test]
fn stride_indices_bounds() {
    for n in [0usize, 1, 5, 100, 100_001] {
        for m in [0usize, 1, 2, 50, 100_000, usize::MAX] {
            let s = stride_indices(n, m);
            assert!(s.len() <= n && s.len() <= m.clamp(1, MAX_SERIES_POINTS));
            assert!(s.windows(2).all(|w| w[0] < w[1]));
            assert!(s.iter().all(|&i| i < n.max(1)));
        }
    }
}

#[test]
fn histogram_counts_sum_to_finite_rows_and_bins_are_bounded() {
    let mut rng = Rng::new(50);
    for n in [1usize, 2, 9, 10, 99, 100, 101, 6399, 6400, 6401, 159_264] {
        let mut v: Vec<f64> = (0..n).map(|_| rng.normal() * 3.0 + 7.0).collect();
        // sprinkle NaN / inf, which must be ignored
        let mut finite = n;
        if n > 10 {
            v[3] = f64::NAN;
            v[5] = f64::INFINITY;
            v[7] = f64::NEG_INFINITY;
            finite -= 3;
        }
        let h = histogram(&v, 7.0, 3.0, 80).unwrap();
        assert_eq!(h.counts.iter().sum::<usize>(), finite, "n={n}");
        assert_eq!(h.n, finite);
        assert!(h.counts.len() <= MAX_HISTOGRAM_BINS);
        assert_eq!(h.bin_edges.len(), h.counts.len() + 1);
        assert_eq!(h.curve.len(), h.counts.len());
        assert!(h.bin_edges.windows(2).all(|w| w[0] < w[1]));
        assert!(h.curve.iter().all(|c| c.is_finite() && *c >= 0.0));
        // Every finite value falls inside the edges.
        let (lo, hi) = (h.bin_edges[0], *h.bin_edges.last().unwrap());
        assert!(v.iter().filter(|x| x.is_finite()).all(|&x| x >= lo && x <= hi + 1e-9 * hi.abs().max(1.0)));
    }
    // Constant data, one row, all NaN, max_bins edge values.
    let c = histogram(&[5.0; 1000], 5.0, 0.0, 80).unwrap();
    assert_eq!((c.counts.clone(), c.curve.clone()), (vec![1000], vec![0.0]));
    let one = histogram(&[42.0], 42.0, 0.0, 80).unwrap();
    assert_eq!(one.counts, vec![1]);
    assert!(histogram(&[f64::NAN; 10], 0.0, 1.0, 80).is_none());
    assert!(histogram(&[], 0.0, 1.0, 80).is_none());
    for mb in [0usize, 1, 3, 500] {
        let h = histogram(&(0..1000).map(|i| i as f64).collect::<Vec<_>>(), 500.0, 288.0, mb).unwrap();
        assert!(h.counts.len() <= mb.clamp(1, 80), "max_bins {mb}");
        assert_eq!(h.counts.iter().sum::<usize>(), 1000);
    }
}

#[test]
fn histogram_with_extreme_range_does_not_panic() {
    // (mx - mn) overflows to inf: must not panic; counts still sum.
    let v = vec![-1.7e308, 0.0, 1.7e308];
    let h = histogram(&v, 0.0, 1e308, 80).unwrap();
    assert_eq!(h.counts.iter().sum::<usize>(), 3);
}

#[test]
fn summarize_shares_partition_scored_rows() {
    let mut rng = Rng::new(60);
    for _ in 0..200 {
        let n = 1 + rng.usize(5000);
        let s: Vec<f64> = (0..n)
            .map(|_| if rng.f() < 0.1 { f64::NAN } else { (rng.range(0.0, 100.0) * 4.0).round() / 4.0 })
            .collect();
        let total = n + rng.usize(100);
        let sum = summarize(&s, total, |i| (i * 2, Some(format!("t{i}"))));
        let scored = s.iter().filter(|v| !v.is_nan()).count();
        assert_eq!(sum.scored, scored);
        assert_eq!(sum.unscored, total - scored);
        assert_eq!(sum.share_basis, "row_count");
        if scored == 0 {
            assert!(sum.min_score.is_none() && sum.pct_below_80.is_none());
            continue;
        }
        let tot = sum.share_80_100.unwrap() + sum.share_40_80.unwrap() + sum.share_0_40.unwrap();
        close(tot, 100.0, 1e-9, "shares sum");
        close(sum.pct_below_80.unwrap(), sum.share_40_80.unwrap() + sum.share_0_40.unwrap(), 1e-9, "below 80");
        let below = s.iter().filter(|v| !v.is_nan() && **v < 80.0).count() as f64 * 100.0 / scored as f64;
        close(sum.pct_below_80.unwrap(), below, 1e-9, "pct below 80 exact");
        let mn = s.iter().copied().filter(|v| !v.is_nan()).reduce(f64::min).unwrap();
        let first = s.iter().position(|&v| v == mn).unwrap();
        let m = sum.min_score.unwrap();
        assert_eq!((m.score, m.row, m.timestamp), (mn, first * 2, Some(format!("t{first}"))));
    }
    // Boundaries: exactly 80 is in 80–100, exactly 40 in 40–80.
    let sum = summarize(&[80.0, 40.0, 39.999], 3, |i| (i, None));
    assert_eq!((sum.share_80_100.unwrap(), sum.share_40_80.unwrap()), (100.0 / 3.0, 100.0 / 3.0));
}

// ===========================================================================
// 6. Relationship cache (public RelCache)
// ===========================================================================

fn fit(rows: usize, tag: &str, preds: usize) -> RelFit {
    RelFit {
        target: tag.into(),
        predictors: (0..preds).map(|k| format!("P{k}")).collect(),
        lambda: 1.0,
        rows: (0..rows as u32).collect(),
        actual: vec![1.0; rows],
        predicted: vec![1.0; rows],
        x_cols: vec![vec![0.0; rows]; preds],
        r2_per_step: vec![],
        rmse2_per_step: vec![],
    }
}

#[test]
fn cache_eviction_by_count_is_insertion_order_when_only_peek_is_used() {
    // The health preview path only ever PEEKs (read lock) — so recency is
    // never refreshed by reads and eviction is effectively FIFO by insert.
    let mut c = RelCache::new(3, usize::MAX);
    for k in ["a", "b", "c"] {
        c.insert(k.into(), fit(10, k, 1));
    }
    assert!(c.peek("a").is_some());
    c.insert("d".into(), fit(10, "d", 1));
    assert!(c.peek("a").is_none(), "peek does not protect 'a' from eviction");
    assert_eq!(c.len(), 3);
    // `get` DOES refresh recency.
    assert!(c.get("b").is_some());
    c.insert("e".into(), fit(10, "e", 1));
    assert!(c.peek("b").is_some());
    assert!(c.peek("c").is_none());
}

#[test]
fn cache_eviction_by_bytes_and_newest_always_kept() {
    // One entry of 1000 rows × 2 predictors ≈ 1000*20 + 2*8000 = 36 000 B.
    let mut c = RelCache::new(100, 80_000);
    c.insert("a".into(), fit(1000, "a", 2));
    c.insert("b".into(), fit(1000, "b", 2));
    assert_eq!(c.len(), 2);
    c.insert("c".into(), fit(1000, "c", 2));
    assert_eq!(c.len(), 2, "byte budget evicts the oldest");
    assert!(c.peek("a").is_none());
    // A single oversized entry is still kept (and evicts everyone else).
    c.insert("huge".into(), fit(100_000, "huge", 4));
    assert_eq!(c.len(), 1);
    assert!(c.peek("huge").is_some());
    // max_entries 0 is coerced to 1.
    let mut z = RelCache::new(0, usize::MAX);
    z.insert("x".into(), fit(1, "x", 1));
    z.insert("y".into(), fit(1, "y", 1));
    assert_eq!(z.len(), 1);
}

#[test]
fn cache_same_key_is_replaced_not_duplicated_and_clear_empties() {
    let mut c = RelCache::default();
    c.insert("k".into(), fit(5, "T1", 1));
    c.insert("k".into(), fit(5, "T2", 1));
    assert_eq!(c.len(), 1);
    assert_eq!(c.peek("k").unwrap().target, "T2", "a key collision: the last writer wins");
    // An Arc handed out before a replace keeps the OLD fit alive and intact.
    let held = c.peek("k").unwrap();
    c.insert("k".into(), fit(5, "T3", 1));
    assert_eq!(held.target, "T2");
    c.clear();
    assert!(c.is_empty());
    assert!(c.peek("k").is_none());
    // Keys are compared exactly (no trimming / case folding).
    c.insert("Model::fp".into(), fit(1, "a", 1));
    assert!(c.peek("model::fp").is_none());
    assert!(c.peek("Model::fp ").is_none());
}
