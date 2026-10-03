//! Health score — pure math (no Tauri, no session state).
//!
//! Rust is the single source of truth for the score: the frontend only
//! displays what these functions produce. Every score is piecewise-linear and
//! clamped to `0..=100`, with the SAME anchor on every model kind — **80 at
//! exactly 3 standard deviations** (never 85: the 85 in the legacy pandas
//! reference code is a known bug).
//!
//! | kind         | 100                    | 80                     | 0                         |
//! |--------------|------------------------|------------------------|---------------------------|
//! | individual   | within ±1σ             | ±3σ                    | the sensor's L / H        |
//! | relationship | `|residual| <= 2RMSE`  | user's 80-point        | user's 0-point            |
//! | clustering   | inside the 1×SD ring   | 3×SD ring              | N×SD ring (N > 3, user)   |
//!
//! A row with NO score is `None` / `NaN` in the score vectors — never 0. That
//! is the case for rows outside the training scope and rows whose inputs are
//! missing. Validation ([`validate_individual`], [`validate_relationship`],
//! [`validate_clustering`]) is re-run on every call because the training scope
//! changes σ / 2RMSE / the ellipses, and a score is only ever produced from
//! parameters that passed it ([`IndividualParams::new`] etc.).
//!
//! Also here: the bounded-payload helpers the charts need ([`select_indices`]
//! — a min/max-preserving downsample, [`histogram`], [`summarize`]) and the
//! in-session cache of full-resolution Relationship fits ([`RelCache`]).

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::metrics::round_metric;

/// Score at the `±3σ` knot (every model kind). NOT 85.
pub const SCORE_AT_3SD: f64 = 80.0;
/// Score inside the inner band.
pub const SCORE_MAX: f64 = 100.0;
/// Inner band, in standard deviations (100 up to here).
pub const INNER_SD: f64 = 1.0;
/// The anchor ring, in standard deviations (80 here).
pub const ANCHOR_SD: f64 = 3.0;

// ---------------------------------------------------------------------------
// Validation issues
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    /// Blocks "Mark complete" / export.
    Error,
    /// Shown, never blocks.
    Warning,
}

/// One validation finding. `code` is stable (the UI keys on it); `message` is
/// plain English the UI may show as-is; `field` names the input it belongs to
/// (`lower`, `upper`, `residual_at_80_lower`, `outer_sd`, `sd`, `two_rmse`,
/// `cluster_<id>`, ...).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Issue {
    pub code: String,
    pub severity: Severity,
    pub message: String,
    pub field: String,
}

fn issue(code: &str, field: &str, message: String) -> Issue {
    Issue {
        code: code.to_string(),
        severity: Severity::Error,
        message,
        field: field.to_string(),
    }
}

/// True when any issue is an error.
pub fn has_errors(issues: &[Issue]) -> bool {
    issues.iter().any(|i| i.severity == Severity::Error)
}

/// Human-friendly number for messages (rounded like the INFO files).
fn fmt_num(x: f64) -> String {
    if !x.is_finite() {
        return format!("{x}");
    }
    format!("{}", round_metric(x))
}

// ---------------------------------------------------------------------------
// User-entered set points (as sent by the frontend)
// ---------------------------------------------------------------------------

/// The three TS `HealthSetPoints` shapes flattened into one all-optional
/// struct, so the frontend can send the model's `healthSetPoints` object
/// as-is. Accepts snake_case (canonical), the TS camelCase names and the
/// legacy `residual_at_health_*` names; unknown keys (`kind`, `masterLower`,
/// ...) are ignored. `null` / missing = "not entered".
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
pub struct SetPointsArg {
    /// Individual: L — health 0 below the mean at this value.
    #[serde(default)]
    pub lower: Option<f64>,
    /// Individual: H — health 0 above the mean at this value.
    #[serde(default)]
    pub upper: Option<f64>,
    /// Relationship (residual = actual − predicted; lower side is negative).
    #[serde(default, alias = "residualAt80Lower", alias = "residual_at_health_80_lower")]
    pub residual_at_80_lower: Option<f64>,
    #[serde(default, alias = "residualAt80Upper", alias = "residual_at_health_80_upper")]
    pub residual_at_80_upper: Option<f64>,
    #[serde(default, alias = "residualAt0Lower", alias = "residual_at_health_0_lower")]
    pub residual_at_0_lower: Option<f64>,
    #[serde(default, alias = "residualAt0Upper", alias = "residual_at_health_0_upper")]
    pub residual_at_0_upper: Option<f64>,
    /// Clustering: N — the outer ring (health 0) at N × each cluster's SD.
    #[serde(default, alias = "outerSd")]
    pub outer_sd: Option<f64>,
}

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

/// Linear interpolation of `y` between `(x0, y0)` and `(x1, y1)` at `x`.
/// `x1 <= x0` (a collapsed segment) returns `y1` instead of dividing by zero —
/// validation keeps that from ever being reached.
#[inline]
fn lerp(x: f64, x0: f64, y0: f64, x1: f64, y1: f64) -> f64 {
    if x1 <= x0 {
        return y1;
    }
    y0 + (y1 - y0) * (x - x0) / (x1 - x0)
}

#[inline]
fn clamp_score(s: f64) -> f64 {
    s.clamp(0.0, SCORE_MAX)
}

// ---------------------------------------------------------------------------
// Individual
// ---------------------------------------------------------------------------

/// The ±1σ / ±3σ band of an Individual model exactly as written to
/// `INDV_INFO_*.json` (the ROUNDED mean / SD / boundaries — see
/// `individual_rounded_metrics`), so a consumer reading the file reproduces
/// the same score.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct IndividualBand {
    pub mean: f64,
    pub sd: f64,
    pub lower_1sd: f64,
    pub upper_1sd: f64,
    pub lower_3sd: f64,
    pub upper_3sd: f64,
}

impl IndividualBand {
    /// From the output of `individual_rounded_metrics`:
    /// `(mean, sd, [lo1, hi1], [lo3, hi3])`.
    pub fn from_rounded(mean: f64, sd: f64, b1: [f64; 2], b3: [f64; 2]) -> Self {
        IndividualBand {
            mean,
            sd,
            lower_1sd: b1[0],
            upper_1sd: b1[1],
            lower_3sd: b3[0],
            upper_3sd: b3[1],
        }
    }

    /// Strictly increasing `lower3 < lower1 < upper1 < upper3` with finite
    /// values. A constant sensor (σ = 0) collapses every boundary onto the
    /// mean; a score would divide by zero.
    pub fn is_degenerate(&self) -> bool {
        let v = [
            self.lower_3sd,
            self.lower_1sd,
            self.upper_1sd,
            self.upper_3sd,
        ];
        !v.iter().all(|x| x.is_finite()) || !v.windows(2).all(|w| w[0] < w[1])
    }
}

/// Validate an Individual model's set points against its band.
///
/// Rules: both L and H entered; band not degenerate; `L < H`;
/// `L < lower 3σ` and `H > upper 3σ`, STRICTLY (equal is invalid — the 80
/// point and the 0 point would coincide).
pub fn validate_individual(band: &IndividualBand, sp: &SetPointsArg) -> Vec<Issue> {
    let mut out = Vec::new();
    if sp.lower.is_none() {
        out.push(issue(
            "required",
            "lower",
            "Enter the lower set point (L): the value where health reaches 0 on the low side."
                .into(),
        ));
    }
    if sp.upper.is_none() {
        out.push(issue(
            "required",
            "upper",
            "Enter the upper set point (H): the value where health reaches 0 on the high side."
                .into(),
        ));
    }
    let degenerate = band.is_degenerate();
    if degenerate {
        out.push(issue(
            "degenerate_band",
            "sd",
            format!(
                "The ±1σ / ±3σ band is collapsed for this training scope (σ = {}), so a health \
                 score can't be calculated. Widen the training period or running condition so the \
                 sensor varies.",
                fmt_num(band.sd)
            ),
        ));
    }
    if let (Some(l), Some(h)) = (sp.lower, sp.upper) {
        if l >= h {
            out.push(issue(
                "ordering",
                "lower",
                format!(
                    "The lower set point (L = {}) must be below the upper set point (H = {}).",
                    fmt_num(l),
                    fmt_num(h)
                ),
            ));
        }
    }
    if !degenerate {
        if let Some(l) = sp.lower {
            if l == band.lower_3sd {
                out.push(issue(
                    "lower_equals_3sd",
                    "lower",
                    format!(
                        "The lower set point (L = {}) equals the lower 3σ boundary, so the 80 and \
                         the 0 point would coincide. Set L below {}.",
                        fmt_num(l),
                        fmt_num(band.lower_3sd)
                    ),
                ));
            } else if l > band.lower_3sd {
                out.push(issue(
                    "lower_inside_3sd",
                    "lower",
                    format!(
                        "The lower set point (L = {}) must be below the lower 3σ boundary ({}).",
                        fmt_num(l),
                        fmt_num(band.lower_3sd)
                    ),
                ));
            }
        }
        if let Some(h) = sp.upper {
            if h == band.upper_3sd {
                out.push(issue(
                    "upper_equals_3sd",
                    "upper",
                    format!(
                        "The upper set point (H = {}) equals the upper 3σ boundary, so the 80 and \
                         the 0 point would coincide. Set H above {}.",
                        fmt_num(h),
                        fmt_num(band.upper_3sd)
                    ),
                ));
            } else if h < band.upper_3sd {
                out.push(issue(
                    "upper_inside_3sd",
                    "upper",
                    format!(
                        "The upper set point (H = {}) must be above the upper 3σ boundary ({}).",
                        fmt_num(h),
                        fmt_num(band.upper_3sd)
                    ),
                ));
            }
        }
    }
    out
}

/// Validated parameters of an Individual score. Only constructible from
/// set points that passed [`validate_individual`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct IndividualParams {
    pub band: IndividualBand,
    /// L
    pub lower: f64,
    /// H
    pub upper: f64,
}

impl IndividualParams {
    pub fn new(band: IndividualBand, sp: &SetPointsArg) -> Result<Self, Vec<Issue>> {
        let issues = validate_individual(&band, sp);
        if has_errors(&issues) {
            return Err(issues);
        }
        // No errors => both are present.
        Ok(IndividualParams {
            band,
            lower: sp.lower.unwrap_or(f64::NAN),
            upper: sp.upper.unwrap_or(f64::NAN),
        })
    }

    /// Score of one value; `None` for a non-finite value.
    ///
    /// Upper side: `upper1σ -> 100`, `upper3σ -> 80`, `H -> 0`; lower side
    /// mirrored (`lower1σ -> 100`, `lower3σ -> 80`, `L -> 0`); between the two
    /// 1σ boundaries = 100; at or beyond H / L = 0.
    pub fn score(&self, v: f64) -> Option<f64> {
        if !v.is_finite() {
            return None;
        }
        let b = &self.band;
        let s = if v > b.upper_1sd {
            if v >= self.upper {
                0.0
            } else if v <= b.upper_3sd {
                lerp(v, b.upper_1sd, SCORE_MAX, b.upper_3sd, SCORE_AT_3SD)
            } else {
                lerp(v, b.upper_3sd, SCORE_AT_3SD, self.upper, 0.0)
            }
        } else if v < b.lower_1sd {
            if v <= self.lower {
                0.0
            } else if v >= b.lower_3sd {
                lerp(-v, -b.lower_1sd, SCORE_MAX, -b.lower_3sd, SCORE_AT_3SD)
            } else {
                lerp(-v, -b.lower_3sd, SCORE_AT_3SD, -self.lower, 0.0)
            }
        } else {
            SCORE_MAX
        };
        Some(clamp_score(s))
    }
}

// ---------------------------------------------------------------------------
// Relationship
// ---------------------------------------------------------------------------

/// Validate a Relationship model's set points.
///
/// `w` = the model's `2rmse` half-width (`None` when it isn't known yet — only
/// the checks that don't need it run). Per side (residual = actual − predicted,
/// so the lower side is negative): `|80-point| > W` and `|0-point| > |80-point|`,
/// both STRICT, plus sign sanity and "all four entered".
pub fn validate_relationship(w: Option<f64>, sp: &SetPointsArg) -> Vec<Issue> {
    let mut out = Vec::new();
    let fields: [(&str, Option<f64>, &str); 4] = [
        (
            "residual_at_80_lower",
            sp.residual_at_80_lower,
            "the lower 80-point (residual where health is 80, negative)",
        ),
        (
            "residual_at_80_upper",
            sp.residual_at_80_upper,
            "the upper 80-point (residual where health is 80, positive)",
        ),
        (
            "residual_at_0_lower",
            sp.residual_at_0_lower,
            "the lower 0-point (residual where health is 0, negative)",
        ),
        (
            "residual_at_0_upper",
            sp.residual_at_0_upper,
            "the upper 0-point (residual where health is 0, positive)",
        ),
    ];
    for (name, v, label) in fields {
        if v.is_none() {
            out.push(issue("required", name, format!("Enter {label}.")));
        }
    }
    let band_ok = match w {
        Some(w) if w.is_finite() && w > 0.0 => true,
        Some(w) => {
            out.push(issue(
                "degenerate_band",
                "two_rmse",
                format!(
                    "The model's 2RMSE is {}, so there is no residual band to build a health score \
                     on. Check the model fit or widen the training scope.",
                    fmt_num(w)
                ),
            ));
            false
        }
        None => false,
    };

    for side in [Side::Lower, Side::Upper] {
        let (f80, v80, f0, v0) = match side {
            Side::Lower => (
                "residual_at_80_lower",
                sp.residual_at_80_lower,
                "residual_at_0_lower",
                sp.residual_at_0_lower,
            ),
            Side::Upper => (
                "residual_at_80_upper",
                sp.residual_at_80_upper,
                "residual_at_0_upper",
                sp.residual_at_0_upper,
            ),
        };
        let name = match side {
            Side::Lower => "lower",
            Side::Upper => "upper",
        };
        let sign_ok = |v: f64| match side {
            Side::Lower => v < 0.0,
            Side::Upper => v > 0.0,
        };
        let (sign_code, sign_word) = match side {
            Side::Lower => ("must_be_negative", "negative"),
            Side::Upper => ("must_be_positive", "positive"),
        };
        let mut v80_ok = false;
        let mut v0_ok = false;
        if let Some(v) = v80 {
            if sign_ok(v) {
                v80_ok = true;
            } else {
                out.push(issue(
                    sign_code,
                    f80,
                    format!(
                        "The {name} 80-point must be {sign_word} (residual = actual − predicted); got {}.",
                        fmt_num(v)
                    ),
                ));
            }
        }
        if let Some(v) = v0 {
            if sign_ok(v) {
                v0_ok = true;
            } else {
                out.push(issue(
                    sign_code,
                    f0,
                    format!(
                        "The {name} 0-point must be {sign_word} (residual = actual − predicted); got {}.",
                        fmt_num(v)
                    ),
                ));
            }
        }
        if let (true, Some(w), Some(v)) = (band_ok && v80_ok, w, v80) {
            let m = v.abs();
            if m == w {
                out.push(issue(
                    "point80_equals_band",
                    f80,
                    format!(
                        "The {name} 80-point ({}) sits exactly on the ±2RMSE band edge ({}), so the \
                         100 and the 80 point would coincide. Move it further from zero.",
                        fmt_num(v),
                        fmt_num(w)
                    ),
                ));
            } else if m < w {
                out.push(issue(
                    "point80_inside_band",
                    f80,
                    format!(
                        "The {name} 80-point ({}) must be further from zero than the ±2RMSE band \
                         edge ({}).",
                        fmt_num(v),
                        fmt_num(w)
                    ),
                ));
            }
        }
        if let (true, Some(a), Some(b)) = (v80_ok && v0_ok, v80, v0) {
            let (m80, m0) = (a.abs(), b.abs());
            if m0 == m80 {
                out.push(issue(
                    "point0_equals_point80",
                    f0,
                    format!(
                        "The {name} 0-point ({}) equals the {name} 80-point, so the score would \
                         drop from 80 to 0 instantly. Move the 0-point further from zero.",
                        fmt_num(b)
                    ),
                ));
            } else if m0 < m80 {
                out.push(issue(
                    "point0_inside_point80",
                    f0,
                    format!(
                        "The {name} 0-point ({}) must be further from zero than the {name} \
                         80-point ({}).",
                        fmt_num(b),
                        fmt_num(a)
                    ),
                ));
            }
        }
    }
    out
}

#[derive(Clone, Copy)]
enum Side {
    Lower,
    Upper,
}

/// Validated parameters of a Relationship score.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RelationshipParams {
    /// Half-width of the 100-band (the model's `2rmse`).
    pub w: f64,
    pub lower_80: f64,
    pub lower_0: f64,
    pub upper_80: f64,
    pub upper_0: f64,
}

impl RelationshipParams {
    pub fn new(w: f64, sp: &SetPointsArg) -> Result<Self, Vec<Issue>> {
        let issues = validate_relationship(Some(w), sp);
        if has_errors(&issues) {
            return Err(issues);
        }
        Ok(RelationshipParams {
            w,
            lower_80: sp.residual_at_80_lower.unwrap_or(f64::NAN),
            lower_0: sp.residual_at_0_lower.unwrap_or(f64::NAN),
            upper_80: sp.residual_at_80_upper.unwrap_or(f64::NAN),
            upper_0: sp.residual_at_0_upper.unwrap_or(f64::NAN),
        })
    }

    /// Score of one residual (`actual − predicted`, signed); `None` when
    /// non-finite.
    ///
    /// `|r| <= W` = 100. Upper side: `W -> 100`, `upper_80 -> 80`,
    /// `upper_0 -> 0`; lower side mirrored with the negative values. Beyond the
    /// 0-point = 0.
    pub fn score(&self, r: f64) -> Option<f64> {
        if !r.is_finite() {
            return None;
        }
        let s = if r > self.w {
            if r >= self.upper_0 {
                0.0
            } else if r <= self.upper_80 {
                lerp(r, self.w, SCORE_MAX, self.upper_80, SCORE_AT_3SD)
            } else {
                lerp(r, self.upper_80, SCORE_AT_3SD, self.upper_0, 0.0)
            }
        } else if r < -self.w {
            if r <= self.lower_0 {
                0.0
            } else if r >= self.lower_80 {
                lerp(-r, self.w, SCORE_MAX, -self.lower_80, SCORE_AT_3SD)
            } else {
                lerp(-r, -self.lower_80, SCORE_AT_3SD, -self.lower_0, 0.0)
            }
        } else {
            SCORE_MAX
        };
        Some(clamp_score(s))
    }
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

/// One cluster's Gaussian as written to `CLUS_INFO_*.json` (centre / SDs /
/// angle ROUNDED like the file, so the score reproduces from the file).
/// `x_sd` is the MAJOR-axis SD and `angle_deg` the major axis' rotation (the
/// convention of `clustering::EllipseFit` and the UI's ellipse drawing): the
/// `k×SD` ellipse has semi-axes `k·x_sd` (along the angle) and `k·y_sd`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct ClusterGeom {
    pub cluster_id: u32,
    pub x_center: f64,
    pub y_center: f64,
    pub x_sd: f64,
    pub y_sd: f64,
    pub angle_deg: f64,
}

impl ClusterGeom {
    pub fn is_degenerate(&self) -> bool {
        let v = [self.x_center, self.y_center, self.x_sd, self.y_sd, self.angle_deg];
        !v.iter().all(|x| x.is_finite()) || self.x_sd <= 0.0 || self.y_sd <= 0.0
    }

    /// Distance of `(x, y)` from the cluster centre in SD units: the
    /// Mahalanobis distance of the fitted Gaussian. `d == k` means the point
    /// lies exactly ON the `k×SD` ellipse (so `d == 3` is the 3σ ring and a
    /// point there scores 80).
    pub fn sd_distance(&self, x: f64, y: f64) -> f64 {
        let dx = x - self.x_center;
        let dy = y - self.y_center;
        let a = self.angle_deg.to_radians();
        let (sin, cos) = a.sin_cos();
        // Coordinates in the ellipse's own axes (inverse of the rotation the
        // UI applies when drawing it).
        let u = dx * cos + dy * sin;
        let v = -dx * sin + dy * cos;
        ((u / self.x_sd).powi(2) + (v / self.y_sd).powi(2)).sqrt()
    }
}

/// Validate a Clustering model's set point (the one number N) against its
/// fitted clusters: entered; `N > 3` STRICTLY (equal is invalid); no cluster
/// with a collapsed ellipse (a zero SD can't be scored).
pub fn validate_clustering(clusters: &[ClusterGeom], sp: &SetPointsArg) -> Vec<Issue> {
    let mut out = Vec::new();
    match sp.outer_sd {
        None => out.push(issue(
            "required",
            "outer_sd",
            "Enter the outer ring (N × SD): the distance where health reaches 0.".into(),
        )),
        Some(n) if !n.is_finite() => out.push(issue(
            "outer_sd_not_a_number",
            "outer_sd",
            "The outer ring must be a number.".into(),
        )),
        Some(n) if n == ANCHOR_SD => out.push(issue(
            "outer_sd_equals_3",
            "outer_sd",
            "The outer ring can't equal 3× SD (that ring is the 80 point). Use more than 3."
                .into(),
        )),
        Some(n) if n < ANCHOR_SD => out.push(issue(
            "outer_sd_not_above_3",
            "outer_sd",
            format!(
                "The outer ring ({}× SD) must be more than 3× SD (the 80 point).",
                fmt_num(n)
            ),
        )),
        Some(_) => {}
    }
    for c in clusters {
        if c.is_degenerate() {
            out.push(issue(
                "degenerate_band",
                &format!("cluster_{}", c.cluster_id),
                format!(
                    "Cluster {} has no spread in one direction (SDs {} × {}), so a health score \
                     can't be calculated for it. Adjust the criteria ranges or the training scope.",
                    c.cluster_id,
                    fmt_num(c.x_sd),
                    fmt_num(c.y_sd)
                ),
            ));
        }
    }
    if clusters.is_empty() {
        out.push(issue(
            "degenerate_band",
            "clusters",
            "No cluster could be fitted, so a health score can't be calculated.".into(),
        ));
    }
    out
}

/// Score from an SD distance: `d <= 1 -> 100`, `3 -> 80`, `N -> 0`, beyond N
/// = 0. Requires `outer_sd > 3` (validated).
pub fn score_clustering_distance(d: f64, outer_sd: f64) -> Option<f64> {
    if !d.is_finite() {
        return None;
    }
    let s = if d <= INNER_SD {
        SCORE_MAX
    } else if d <= ANCHOR_SD {
        lerp(d, INNER_SD, SCORE_MAX, ANCHOR_SD, SCORE_AT_3SD)
    } else if d < outer_sd {
        lerp(d, ANCHOR_SD, SCORE_AT_3SD, outer_sd, 0.0)
    } else {
        0.0
    };
    Some(clamp_score(s))
}

/// Cluster index (0-based) of a criteria value: the FIRST range that contains
/// it (half-open `[min, max)`, `None` bound = unbounded — the same test
/// `compute_clustering_preview` uses). `None` when the value is missing or in
/// no range.
pub fn assign_cluster(c: f64, ranges: &[(Option<f64>, Option<f64>)]) -> Option<usize> {
    if !c.is_finite() {
        return None;
    }
    ranges.iter().position(|&(lo, hi)| {
        lo.is_none_or(|lo| c >= lo) && hi.is_none_or(|hi| c < hi)
    })
}

/// Validated parameters of a Clustering score.
#[derive(Debug, Clone, PartialEq)]
pub struct ClusteringParams {
    pub clusters: Vec<ClusterGeom>,
    pub outer_sd: f64,
}

impl ClusteringParams {
    pub fn new(clusters: Vec<ClusterGeom>, sp: &SetPointsArg) -> Result<Self, Vec<Issue>> {
        let issues = validate_clustering(&clusters, sp);
        if has_errors(&issues) {
            return Err(issues);
        }
        Ok(ClusteringParams {
            clusters,
            outer_sd: sp.outer_sd.unwrap_or(f64::NAN),
        })
    }

    /// `(score, sd_distance)` of a point assigned to cluster index `k`.
    pub fn score(&self, k: usize, x: f64, y: f64) -> Option<(f64, f64)> {
        let g = self.clusters.get(k)?;
        if !x.is_finite() || !y.is_finite() {
            return None;
        }
        let d = g.sd_distance(x, y);
        score_clustering_distance(d, self.outer_sd).map(|s| (s, d))
    }
}

// ---------------------------------------------------------------------------
// Score-series summary
// ---------------------------------------------------------------------------

/// The lowest score of a series and where it happened.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MinScorePoint {
    pub score: f64,
    /// Dataset row number (0-based, the same row numbering as `series.rows`).
    pub row: usize,
    /// The CSV timestamp text of that row, when it has one.
    pub timestamp: Option<String>,
}

/// Summary of one score series. Time shares are BY ROW COUNT (each scored row
/// weighs the same): exact for evenly-sampled data and immune to gaps in the
/// log; `share_basis` says so, so the UI can label it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScoreSummary {
    /// Rows that got a score.
    pub scored: usize,
    /// `total_rows - scored` (out of the training scope, or an input missing).
    pub unscored: usize,
    /// Rows the shares/counts are measured against (dataset rows for
    /// Individual/Clustering; the fitted rows for Relationship).
    pub total_rows: usize,
    pub min_score: Option<MinScorePoint>,
    /// % of SCORED rows with a score strictly below 80. `None` when nothing
    /// was scored.
    pub pct_below_80: Option<f64>,
    /// % of scored rows with `score >= 80`.
    pub share_80_100: Option<f64>,
    /// % of scored rows with `40 <= score < 80`.
    pub share_40_80: Option<f64>,
    /// % of scored rows with `score < 40`.
    pub share_0_40: Option<f64>,
    /// `"row_count"` — see above.
    pub share_basis: &'static str,
}

/// Summarise `scores` (`NaN` = unscored, aligned to the series universe).
/// `locate(i)` maps a position in `scores` to `(dataset row, timestamp)` and
/// is only called for the minimum.
pub fn summarize(
    scores: &[f64],
    total_rows: usize,
    locate: impl Fn(usize) -> (usize, Option<String>),
) -> ScoreSummary {
    let mut scored = 0usize;
    let (mut hi, mut mid, mut lo) = (0usize, 0usize, 0usize);
    let mut min: Option<(usize, f64)> = None;
    for (i, &s) in scores.iter().enumerate() {
        if s.is_nan() {
            continue;
        }
        scored += 1;
        if s >= SCORE_AT_3SD {
            hi += 1;
        } else if s >= 40.0 {
            mid += 1;
        } else {
            lo += 1;
        }
        // Strict `<`: the FIRST row at the minimum wins (deterministic).
        if min.is_none_or(|(_, m)| s < m) {
            min = Some((i, s));
        }
    }
    let pct = |c: usize| {
        if scored == 0 {
            None
        } else {
            Some(c as f64 * 100.0 / scored as f64)
        }
    };
    ScoreSummary {
        scored,
        unscored: total_rows.saturating_sub(scored),
        total_rows,
        min_score: min.map(|(i, s)| {
            let (row, timestamp) = locate(i);
            MinScorePoint {
                score: s,
                row,
                timestamp,
            }
        }),
        pct_below_80: pct(mid + lo),
        share_80_100: pct(hi),
        share_40_80: pct(mid),
        share_0_40: pct(lo),
        share_basis: "row_count",
    }
}

// ---------------------------------------------------------------------------
// Bounded series — min/max-preserving downsample
// ---------------------------------------------------------------------------

/// Hard ceiling for any bounded series sent to the WebView.
pub const MAX_SERIES_POINTS: usize = 100_000;

/// Choose which of `n` ordered rows to ship, at most `max_points` of them
/// (never more than `n`), as ascending positions.
///
/// The universe is split into contiguous buckets; each bucket keeps its
/// `primary` minimum AND maximum (a dip and a spike both survive) plus its
/// `score` MINIMUM (a low score is never averaged away) — and, when there is
/// no `primary`, its score maximum too so the line still has a top edge.
/// `NaN` entries are skipped; a bucket with nothing finite keeps its first
/// row (the gap stays visible). Row 0 and the last row are always kept. The
/// SAME positions are used for every aligned series, so raw value and score
/// share one time axis.
pub fn select_indices(
    n: usize,
    max_points: usize,
    primary: Option<&[f64]>,
    score: Option<&[f64]>,
) -> Vec<usize> {
    let max_points = max_points.clamp(8, MAX_SERIES_POINTS);
    if n <= max_points {
        return (0..n).collect();
    }
    let per = match (primary.is_some(), score.is_some()) {
        (true, true) => 3,
        (true, false) => 2,
        (false, true) => 2,
        (false, false) => 1,
    };
    let buckets = ((max_points - 2) / per).max(1);
    let mut picks: Vec<usize> = (0..buckets)
        .into_par_iter()
        .flat_map_iter(|b| {
            let s = b * n / buckets;
            let e = ((b + 1) * n / buckets).min(n);
            let mut out: Vec<usize> = Vec::with_capacity(3);
            if e > s {
                let mut p_min: Option<(usize, f64)> = None;
                let mut p_max: Option<(usize, f64)> = None;
                let mut s_min: Option<(usize, f64)> = None;
                let mut s_max: Option<(usize, f64)> = None;
                for i in s..e {
                    if let Some(p) = primary {
                        let v = p[i];
                        if v.is_finite() {
                            if p_min.is_none_or(|(_, m)| v < m) {
                                p_min = Some((i, v));
                            }
                            if p_max.is_none_or(|(_, m)| v > m) {
                                p_max = Some((i, v));
                            }
                        }
                    }
                    if let Some(sc) = score {
                        let v = sc[i];
                        if !v.is_nan() {
                            if s_min.is_none_or(|(_, m)| v < m) {
                                s_min = Some((i, v));
                            }
                            if primary.is_none() && s_max.is_none_or(|(_, m)| v > m) {
                                s_max = Some((i, v));
                            }
                        }
                    }
                }
                for c in [p_min, p_max, s_min, s_max].into_iter().flatten() {
                    out.push(c.0);
                }
                if out.is_empty() {
                    out.push(s);
                }
                out.sort_unstable();
                out.dedup();
            }
            out
        })
        .collect();
    picks.push(0);
    picks.push(n - 1);
    picks.sort_unstable();
    picks.dedup();
    picks
}

/// Evenly spaced positions (deterministic, time-ordered), at most `max`.
pub fn stride_indices(n: usize, max: usize) -> Vec<usize> {
    let max = max.clamp(1, MAX_SERIES_POINTS);
    if n <= max {
        return (0..n).collect();
    }
    (0..max).map(|i| i * n / max).collect()
}

// ---------------------------------------------------------------------------
// Histogram (Individual distribution)
// ---------------------------------------------------------------------------

/// Bounded histogram plus a fitted normal curve for the Individual
/// "Distribution" chart.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Histogram {
    /// `counts.len() + 1` ascending edges.
    pub bin_edges: Vec<f64>,
    /// Rows per bin (sums to `n`).
    pub counts: Vec<usize>,
    /// Expected rows per bin under Normal(mean, sd), at each bin centre
    /// (`n · width · pdf`), so it overlays `counts` directly. All 0 when
    /// `sd <= 0`.
    pub curve: Vec<f64>,
    pub bin_width: f64,
    pub n: usize,
}

pub const MAX_HISTOGRAM_BINS: usize = 80;

/// Histogram of finite `values` in at most `max_bins` (<= 80) equal-width bins
/// (`ceil(sqrt(n))`, at least 10 unless the range is a single value). The last
/// bin includes the maximum. `None` for no finite values.
pub fn histogram(values: &[f64], mean: f64, sd: f64, max_bins: usize) -> Option<Histogram> {
    let (mut mn, mut mx) = (f64::INFINITY, f64::NEG_INFINITY);
    let mut n = 0usize;
    for &v in values {
        if v.is_finite() {
            n += 1;
            mn = mn.min(v);
            mx = mx.max(v);
        }
    }
    if n == 0 {
        return None;
    }
    let max_bins = max_bins.clamp(1, MAX_HISTOGRAM_BINS);
    let (edges, bins, width) = if mx > mn {
        let want = ((n as f64).sqrt().ceil() as usize).clamp(10, MAX_HISTOGRAM_BINS);
        let bins = want.min(max_bins);
        let width = (mx - mn) / bins as f64;
        let edges: Vec<f64> = (0..=bins).map(|i| mn + width * i as f64).collect();
        (edges, bins, width)
    } else {
        // A constant sensor: one unit-wide bin around the value.
        (vec![mn - 0.5, mn + 0.5], 1usize, 1.0)
    };
    let mut counts = vec![0usize; bins];
    for &v in values {
        if !v.is_finite() {
            continue;
        }
        let i = if bins == 1 {
            0
        } else {
            (((v - mn) / width) as usize).min(bins - 1)
        };
        counts[i] += 1;
    }
    let curve: Vec<f64> = (0..bins)
        .map(|i| {
            if !(sd > 0.0) || !sd.is_finite() {
                return 0.0;
            }
            let c = (edges[i] + edges[i + 1]) / 2.0;
            let z = (c - mean) / sd;
            n as f64 * width * (-0.5 * z * z).exp() / (sd * (2.0 * std::f64::consts::PI).sqrt())
        })
        .collect();
    Some(Histogram {
        bin_edges: edges,
        counts,
        curve,
        bin_width: width,
        n,
    })
}

// ---------------------------------------------------------------------------
// Relationship fit cache (full resolution, per dataset session)
// ---------------------------------------------------------------------------

/// Full-resolution output of one Relationship fit (the sidecar's predictions
/// plus the rows they belong to), kept Rust-side so editing set points
/// re-scores instantly without re-running the ~12-18 s sidecar.
#[derive(Debug)]
pub struct RelFit {
    pub target: String,
    pub predictors: Vec<String>,
    pub lambda: f64,
    /// Dataset row number of each fitted row (ascending).
    pub rows: Vec<u32>,
    pub actual: Vec<f64>,
    /// `NaN` = the sidecar returned no prediction for that row.
    pub predicted: Vec<f64>,
    /// Predictor values, one column per predictor (`x_cols[k][i]` is row
    /// `rows[i]`). Kept so the Fit scatter never depends on the live dataset
    /// columns (which a special-sensor edit may replace).
    pub x_cols: Vec<Vec<f64>>,
    /// The sidecar's cumulative per-step scores (last = full model), for the
    /// "Compare predictors" view.
    pub r2_per_step: Vec<f64>,
    pub rmse2_per_step: Vec<f64>,
}

impl RelFit {
    fn approx_bytes(&self) -> usize {
        let n = self.rows.len();
        n * (4 + 8 + 8) + self.x_cols.iter().map(|c| c.len() * 8).sum::<usize>()
    }
}

/// Most-recent-first bounded cache of [`RelFit`]s. Lives INSIDE the session
/// (`SessionData`), so a new `load_csv` drops it with the dataset it
/// described; the caller-supplied key is `modelId + fingerprint`.
#[derive(Debug)]
pub struct RelCache {
    /// Most recently used LAST.
    entries: Vec<(String, Arc<RelFit>)>,
    max_entries: usize,
    max_bytes: usize,
}

pub const REL_CACHE_MAX_ENTRIES: usize = 8;
/// ~512 MiB of fitted columns across all entries.
pub const REL_CACHE_MAX_BYTES: usize = 512 * 1024 * 1024;

impl Default for RelCache {
    fn default() -> Self {
        RelCache::new(REL_CACHE_MAX_ENTRIES, REL_CACHE_MAX_BYTES)
    }
}

impl RelCache {
    pub fn new(max_entries: usize, max_bytes: usize) -> Self {
        RelCache {
            entries: Vec::new(),
            max_entries: max_entries.max(1),
            max_bytes,
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }

    fn total_bytes(&self) -> usize {
        self.entries.iter().map(|(_, f)| f.approx_bytes()).sum()
    }

    /// Insert (replacing the same key), then evict the least recently used
    /// entries until both bounds hold. The newest entry is always kept, even
    /// if it alone exceeds the byte budget.
    pub fn insert(&mut self, key: String, fit: RelFit) {
        self.entries.retain(|(k, _)| k != &key);
        self.entries.push((key, Arc::new(fit)));
        while self.entries.len() > 1
            && (self.entries.len() > self.max_entries || self.total_bytes() > self.max_bytes)
        {
            self.entries.remove(0);
        }
    }

    /// Look up and mark as most recently used.
    pub fn get(&mut self, key: &str) -> Option<Arc<RelFit>> {
        let pos = self.entries.iter().position(|(k, _)| k == key)?;
        let e = self.entries.remove(pos);
        let fit = e.1.clone();
        self.entries.push(e);
        Some(fit)
    }

    /// Look up without touching recency (usable under a read lock).
    pub fn peek(&self, key: &str) -> Option<Arc<RelFit>> {
        self.entries
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, f)| f.clone())
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-9, "expected ≈{b}, got {a}");
    }

    // mean 100, sd 10: 1σ = 90/110, 3σ = 70/130.
    fn band() -> IndividualBand {
        IndividualBand::from_rounded(100.0, 10.0, [90.0, 110.0], [70.0, 130.0])
    }

    fn sp_ind(l: Option<f64>, h: Option<f64>) -> SetPointsArg {
        SetPointsArg {
            lower: l,
            upper: h,
            ..Default::default()
        }
    }

    fn ind(l: f64, h: f64) -> IndividualParams {
        IndividualParams::new(band(), &sp_ind(Some(l), Some(h))).unwrap()
    }

    fn codes(v: &[Issue]) -> Vec<&str> {
        v.iter().map(|i| i.code.as_str()).collect()
    }

    // ---------- individual score ----------

    #[test]
    fn individual_every_knot_upper_side() {
        let p = ind(40.0, 160.0);
        approx(p.score(100.0).unwrap(), 100.0); // mean
        approx(p.score(110.0).unwrap(), 100.0); // +1σ
        approx(p.score(130.0).unwrap(), 80.0); // +3σ — exactly 80, not 85
        approx(p.score(160.0).unwrap(), 0.0); // H
        approx(p.score(200.0).unwrap(), 0.0); // beyond H
    }

    #[test]
    fn individual_every_knot_lower_side() {
        let p = ind(40.0, 160.0);
        approx(p.score(90.0).unwrap(), 100.0);
        approx(p.score(70.0).unwrap(), 80.0);
        approx(p.score(40.0).unwrap(), 0.0);
        approx(p.score(-50.0).unwrap(), 0.0);
    }

    #[test]
    fn individual_between_knots_is_linear() {
        let p = ind(40.0, 160.0);
        // +2σ is halfway between the 100 and 80 knots.
        approx(p.score(120.0).unwrap(), 90.0);
        // Halfway between +3σ (80) and H (0): 130 -> 160 midpoint 145 => 40.
        approx(p.score(145.0).unwrap(), 40.0);
        // Lower mirrored.
        approx(p.score(80.0).unwrap(), 90.0);
        approx(p.score(55.0).unwrap(), 40.0);
    }

    #[test]
    fn individual_eighty_point_is_three_sigma_never_85() {
        // A buggy 85 would score 85 at +3σ; the real knot is 80.
        let p = ind(40.0, 160.0);
        let s = p.score(band().upper_3sd).unwrap();
        assert_eq!(s, 80.0);
        assert_ne!(s, 85.0);
        assert_eq!(p.score(band().lower_3sd).unwrap(), 80.0);
        assert_eq!(SCORE_AT_3SD, 80.0);
    }

    #[test]
    fn individual_asymmetric_set_points() {
        // L is close (80 → only 10 below the 3σ edge), H is far.
        let p = ind(60.0, 250.0);
        approx(p.score(65.0).unwrap(), 40.0); // halfway 70 -> 60
        approx(p.score(190.0).unwrap(), 40.0); // halfway 130 -> 250 = 190
        approx(p.score(60.0).unwrap(), 0.0);
        approx(p.score(250.0).unwrap(), 0.0);
    }

    #[test]
    fn individual_nan_and_inf_are_unscored_not_zero() {
        let p = ind(40.0, 160.0);
        assert_eq!(p.score(f64::NAN), None);
        assert_eq!(p.score(f64::INFINITY), None);
        assert_eq!(p.score(f64::NEG_INFINITY), None);
    }

    #[test]
    fn individual_monotonic_decreasing_away_from_the_mean() {
        let p = ind(40.0, 160.0);
        let mut prev = 100.0;
        let mut v = 110.0;
        while v < 170.0 {
            let s = p.score(v).unwrap();
            assert!(s <= prev + 1e-12, "not monotonic at {v}");
            prev = s;
            v += 0.5;
        }
    }

    // ---------- individual validation ----------

    #[test]
    fn individual_validation_passes_for_good_set_points() {
        assert!(validate_individual(&band(), &sp_ind(Some(40.0), Some(160.0))).is_empty());
    }

    #[test]
    fn individual_validation_empty_fields_are_required() {
        let v = validate_individual(&band(), &sp_ind(None, None));
        assert_eq!(codes(&v), vec!["required", "required"]);
        assert_eq!(v[0].field, "lower");
        assert_eq!(v[1].field, "upper");
        let v = validate_individual(&band(), &sp_ind(Some(40.0), None));
        assert_eq!(codes(&v), vec!["required"]);
        assert_eq!(v[0].field, "upper");
    }

    #[test]
    fn individual_validation_equal_to_3sd_is_invalid_with_its_own_message() {
        let v = validate_individual(&band(), &sp_ind(Some(70.0), Some(160.0)));
        assert_eq!(codes(&v), vec!["lower_equals_3sd"]);
        assert!(v[0].message.contains("equals"), "{}", v[0].message);
        let v = validate_individual(&band(), &sp_ind(Some(40.0), Some(130.0)));
        assert_eq!(codes(&v), vec!["upper_equals_3sd"]);
        assert!(v[0].message.contains("equals"));
    }

    #[test]
    fn individual_validation_inside_3sd_is_invalid() {
        let v = validate_individual(&band(), &sp_ind(Some(75.0), Some(160.0)));
        assert_eq!(codes(&v), vec!["lower_inside_3sd"]);
        let v = validate_individual(&band(), &sp_ind(Some(40.0), Some(125.0)));
        assert_eq!(codes(&v), vec!["upper_inside_3sd"]);
        // Just outside passes.
        assert!(validate_individual(&band(), &sp_ind(Some(69.999), Some(130.001))).is_empty());
    }

    #[test]
    fn individual_validation_lower_not_below_upper() {
        let v = validate_individual(&band(), &sp_ind(Some(200.0), Some(150.0)));
        assert!(codes(&v).contains(&"ordering"), "{:?}", codes(&v));
        let v = validate_individual(&band(), &sp_ind(Some(150.0), Some(150.0)));
        assert!(codes(&v).contains(&"ordering"));
    }

    #[test]
    fn individual_validation_degenerate_constant_sensor() {
        // sd = 0: every boundary collapses onto the mean (the phase-1 pin).
        let flat = IndividualBand::from_rounded(5.0, 0.0, [5.0, 5.0], [5.0, 5.0]);
        let v = validate_individual(&flat, &sp_ind(Some(1.0), Some(9.0)));
        assert_eq!(codes(&v), vec!["degenerate_band"]);
        assert_eq!(v[0].field, "sd");
        assert!(v[0].severity == Severity::Error);
        assert!(IndividualParams::new(flat, &sp_ind(Some(1.0), Some(9.0))).is_err());
        // Partly collapsed (3σ == 1σ after rounding) is degenerate too.
        let part = IndividualBand::from_rounded(5.0, 0.1, [4.9, 5.1], [4.9, 5.1]);
        assert!(part.is_degenerate());
        // And NaN.
        let nan = IndividualBand::from_rounded(f64::NAN, f64::NAN, [f64::NAN; 2], [f64::NAN; 2]);
        assert!(nan.is_degenerate());
        assert!(!band().is_degenerate());
    }

    #[test]
    fn individual_params_only_exist_for_valid_set_points() {
        assert!(IndividualParams::new(band(), &sp_ind(Some(70.0), Some(160.0))).is_err());
        let p = IndividualParams::new(band(), &sp_ind(Some(40.0), Some(160.0))).unwrap();
        assert_eq!((p.lower, p.upper), (40.0, 160.0));
    }

    // ---------- relationship ----------

    fn sp_rel(l80: f64, u80: f64, l0: f64, u0: f64) -> SetPointsArg {
        SetPointsArg {
            residual_at_80_lower: Some(l80),
            residual_at_80_upper: Some(u80),
            residual_at_0_lower: Some(l0),
            residual_at_0_upper: Some(u0),
            ..Default::default()
        }
    }

    // W = 2, lower 80 = -4, lower 0 = -10, upper 80 = +6, upper 0 = +20 (asymmetric).
    fn rel() -> RelationshipParams {
        RelationshipParams::new(2.0, &sp_rel(-4.0, 6.0, -10.0, 20.0)).unwrap()
    }

    #[test]
    fn relationship_every_knot_both_sides() {
        let p = rel();
        approx(p.score(0.0).unwrap(), 100.0);
        approx(p.score(2.0).unwrap(), 100.0); // +W
        approx(p.score(-2.0).unwrap(), 100.0); // -W
        approx(p.score(6.0).unwrap(), 80.0); // upper 80
        approx(p.score(-4.0).unwrap(), 80.0); // lower 80
        approx(p.score(20.0).unwrap(), 0.0); // upper 0
        approx(p.score(-10.0).unwrap(), 0.0); // lower 0
        approx(p.score(35.0).unwrap(), 0.0); // beyond
        approx(p.score(-99.0).unwrap(), 0.0);
    }

    #[test]
    fn relationship_between_knots_asymmetric() {
        let p = rel();
        // Upper: W=2 (100) -> 6 (80): midpoint 4 => 90.
        approx(p.score(4.0).unwrap(), 90.0);
        // Upper: 6 (80) -> 20 (0): midpoint 13 => 40.
        approx(p.score(13.0).unwrap(), 40.0);
        // Lower: -2 (100) -> -4 (80): midpoint -3 => 90.
        approx(p.score(-3.0).unwrap(), 90.0);
        // Lower: -4 (80) -> -10 (0): midpoint -7 => 40.
        approx(p.score(-7.0).unwrap(), 40.0);
    }

    #[test]
    fn relationship_unscored_for_non_finite() {
        let p = rel();
        assert_eq!(p.score(f64::NAN), None);
        assert_eq!(p.score(f64::INFINITY), None);
    }

    #[test]
    fn relationship_validation_ok() {
        assert!(validate_relationship(Some(2.0), &sp_rel(-4.0, 6.0, -10.0, 20.0)).is_empty());
    }

    #[test]
    fn relationship_validation_empty_is_required_per_field() {
        let v = validate_relationship(Some(2.0), &SetPointsArg::default());
        assert_eq!(codes(&v), vec!["required"; 4]);
        let fields: Vec<&str> = v.iter().map(|i| i.field.as_str()).collect();
        assert_eq!(
            fields,
            vec![
                "residual_at_80_lower",
                "residual_at_80_upper",
                "residual_at_0_lower",
                "residual_at_0_upper"
            ]
        );
        // Partial: the entered ones are still checked.
        let mut sp = sp_rel(-4.0, 6.0, -10.0, 20.0);
        sp.residual_at_0_upper = None;
        let v = validate_relationship(Some(2.0), &sp);
        assert_eq!(codes(&v), vec!["required"]);
        assert_eq!(v[0].field, "residual_at_0_upper");
    }

    #[test]
    fn relationship_validation_80_point_must_be_strictly_beyond_the_band() {
        // Equal to W.
        let v = validate_relationship(Some(2.0), &sp_rel(-2.0, 6.0, -10.0, 20.0));
        assert_eq!(codes(&v), vec!["point80_equals_band"]);
        assert_eq!(v[0].field, "residual_at_80_lower");
        assert!(v[0].message.contains("exactly"), "{}", v[0].message);
        let v = validate_relationship(Some(2.0), &sp_rel(-4.0, 2.0, -10.0, 20.0));
        assert_eq!(codes(&v), vec!["point80_equals_band"]);
        assert_eq!(v[0].field, "residual_at_80_upper");
        // Inside W.
        let v = validate_relationship(Some(2.0), &sp_rel(-1.0, 6.0, -10.0, 20.0));
        assert_eq!(codes(&v), vec!["point80_inside_band"]);
        let v = validate_relationship(Some(2.0), &sp_rel(-4.0, 1.5, -10.0, 20.0));
        assert_eq!(codes(&v), vec!["point80_inside_band"]);
        // Just beyond W passes.
        assert!(validate_relationship(Some(2.0), &sp_rel(-2.0001, 2.0001, -10.0, 20.0)).is_empty());
    }

    #[test]
    fn relationship_validation_0_point_must_be_strictly_beyond_the_80_point() {
        let v = validate_relationship(Some(2.0), &sp_rel(-4.0, 6.0, -4.0, 20.0));
        assert_eq!(codes(&v), vec!["point0_equals_point80"]);
        assert_eq!(v[0].field, "residual_at_0_lower");
        let v = validate_relationship(Some(2.0), &sp_rel(-4.0, 6.0, -10.0, 6.0));
        assert_eq!(codes(&v), vec!["point0_equals_point80"]);
        assert_eq!(v[0].field, "residual_at_0_upper");
        let v = validate_relationship(Some(2.0), &sp_rel(-4.0, 6.0, -3.0, 20.0));
        assert_eq!(codes(&v), vec!["point0_inside_point80"]);
        let v = validate_relationship(Some(2.0), &sp_rel(-4.0, 6.0, -10.0, 5.0));
        assert_eq!(codes(&v), vec!["point0_inside_point80"]);
    }

    #[test]
    fn relationship_validation_sign_sanity() {
        // Lower positive / upper negative.
        let v = validate_relationship(Some(2.0), &sp_rel(4.0, -6.0, -10.0, 20.0));
        assert_eq!(codes(&v), vec!["must_be_negative", "must_be_positive"]);
        let v = validate_relationship(Some(2.0), &sp_rel(-4.0, 6.0, 10.0, -20.0));
        assert_eq!(codes(&v), vec!["must_be_negative", "must_be_positive"]);
        // Zero is not a valid side value either.
        let v = validate_relationship(Some(2.0), &sp_rel(0.0, 6.0, -10.0, 20.0));
        assert!(codes(&v).contains(&"must_be_negative"));
    }

    #[test]
    fn relationship_validation_degenerate_band_and_unknown_w() {
        let v = validate_relationship(Some(0.0), &sp_rel(-4.0, 6.0, -10.0, 20.0));
        assert_eq!(codes(&v), vec!["degenerate_band"]);
        assert_eq!(v[0].field, "two_rmse");
        let v = validate_relationship(Some(f64::NAN), &sp_rel(-4.0, 6.0, -10.0, 20.0));
        assert_eq!(codes(&v), vec!["degenerate_band"]);
        // W unknown: only required/sign checks run (so a pre-fit check works).
        assert!(validate_relationship(None, &sp_rel(-4.0, 6.0, -10.0, 20.0)).is_empty());
        let v = validate_relationship(None, &sp_rel(4.0, 6.0, -10.0, 20.0));
        assert_eq!(codes(&v), vec!["must_be_negative"]);
        assert!(RelationshipParams::new(0.0, &sp_rel(-4.0, 6.0, -10.0, 20.0)).is_err());
    }

    // ---------- clustering ----------

    fn geom(angle: f64) -> ClusterGeom {
        ClusterGeom {
            cluster_id: 1,
            x_center: 10.0,
            y_center: 20.0,
            x_sd: 4.0,
            y_sd: 1.5,
            angle_deg: angle,
        }
    }

    fn sp_cl(n: Option<f64>) -> SetPointsArg {
        SetPointsArg {
            outer_sd: n,
            ..Default::default()
        }
    }

    /// Point on the `k×SD` ellipse at parameter `t`, built the way the UI
    /// draws it (centre + R(angle)·(k·x_sd·cos t, k·y_sd·sin t)).
    fn on_ring(g: &ClusterGeom, k: f64, t: f64) -> (f64, f64) {
        let a = g.angle_deg.to_radians();
        let (sin, cos) = a.sin_cos();
        let ex = k * g.x_sd * t.cos();
        let ey = k * g.y_sd * t.sin();
        (
            g.x_center + ex * cos - ey * sin,
            g.y_center + ex * sin + ey * cos,
        )
    }

    #[test]
    fn mahalanobis_matches_the_drawn_ellipse_at_any_rotation() {
        for angle in [0.0, 30.0, 45.0, 90.0, 133.0, -60.0] {
            let g = geom(angle);
            for k in [1.0, 3.0, 5.5] {
                for t in [0.0, 0.7, 1.9, 3.1, 4.4, 5.9] {
                    let (x, y) = on_ring(&g, k, t);
                    approx(g.sd_distance(x, y), k);
                }
            }
        }
        // The centre is distance 0.
        approx(geom(37.0).sd_distance(10.0, 20.0), 0.0);
    }

    #[test]
    fn point_exactly_on_the_3sd_ellipse_scores_80() {
        let p = ClusteringParams::new(vec![geom(37.0)], &sp_cl(Some(6.0))).unwrap();
        for t in [0.0, 1.0, 2.5, 4.0] {
            let (x, y) = on_ring(&geom(37.0), 3.0, t);
            let (s, d) = p.score(0, x, y).unwrap();
            approx(d, 3.0);
            approx(s, 80.0); // would be 85 with the legacy bug
        }
    }

    #[test]
    fn clustering_every_knot() {
        let g = geom(20.0);
        let p = ClusteringParams::new(vec![g], &sp_cl(Some(7.0))).unwrap();
        let at = |k: f64| {
            let (x, y) = on_ring(&g, k, 0.9);
            p.score(0, x, y).unwrap().0
        };
        approx(at(0.0), 100.0);
        approx(at(1.0), 100.0);
        approx(at(2.0), 90.0);
        approx(at(3.0), 80.0);
        approx(at(5.0), 40.0); // halfway 3 -> 7
        approx(at(7.0), 0.0);
        approx(at(9.0), 0.0);
        approx(score_clustering_distance(2.0, 5.0).unwrap(), 90.0);
        assert_eq!(score_clustering_distance(f64::NAN, 5.0), None);
    }

    #[test]
    fn clustering_unscored_for_missing_xy_or_unknown_cluster() {
        let p = ClusteringParams::new(vec![geom(0.0)], &sp_cl(Some(5.0))).unwrap();
        assert!(p.score(0, f64::NAN, 1.0).is_none());
        assert!(p.score(0, 1.0, f64::NAN).is_none());
        assert!(p.score(3, 1.0, 1.0).is_none());
    }

    #[test]
    fn assign_cluster_uses_half_open_ranges_and_first_match() {
        let ranges = [(None, Some(10.0)), (Some(10.0), Some(20.0)), (Some(20.0), None)];
        assert_eq!(assign_cluster(-5.0, &ranges), Some(0));
        assert_eq!(assign_cluster(9.999, &ranges), Some(0));
        assert_eq!(assign_cluster(10.0, &ranges), Some(1)); // [min, max)
        assert_eq!(assign_cluster(19.9, &ranges), Some(1));
        assert_eq!(assign_cluster(20.0, &ranges), Some(2));
        assert_eq!(assign_cluster(1e9, &ranges), Some(2));
        // Overlap: first range wins.
        let overlap = [(Some(0.0), Some(10.0)), (Some(5.0), Some(15.0))];
        assert_eq!(assign_cluster(7.0, &overlap), Some(0));
        assert_eq!(assign_cluster(12.0, &overlap), Some(1));
    }

    #[test]
    fn assign_cluster_gives_nothing_for_a_gap_or_missing_value() {
        let gap = [(Some(0.0), Some(10.0)), (Some(20.0), Some(30.0))];
        assert_eq!(assign_cluster(15.0, &gap), None);
        assert_eq!(assign_cluster(-1.0, &gap), None);
        assert_eq!(assign_cluster(30.0, &gap), None);
        assert_eq!(assign_cluster(f64::NAN, &gap), None);
        assert_eq!(assign_cluster(f64::INFINITY, &gap), None);
    }

    #[test]
    fn clustering_validation_outer_sd_rules() {
        let c = [geom(0.0)];
        assert!(validate_clustering(&c, &sp_cl(Some(4.0))).is_empty());
        assert!(validate_clustering(&c, &sp_cl(Some(3.0001))).is_empty());
        let v = validate_clustering(&c, &sp_cl(None));
        assert_eq!(codes(&v), vec!["required"]);
        assert_eq!(v[0].field, "outer_sd");
        let v = validate_clustering(&c, &sp_cl(Some(3.0)));
        assert_eq!(codes(&v), vec!["outer_sd_equals_3"]);
        let v = validate_clustering(&c, &sp_cl(Some(2.0)));
        assert_eq!(codes(&v), vec!["outer_sd_not_above_3"]);
        let v = validate_clustering(&c, &sp_cl(Some(f64::NAN)));
        assert_eq!(codes(&v), vec!["outer_sd_not_a_number"]);
    }

    #[test]
    fn clustering_validation_degenerate_cluster() {
        let mut flat = geom(0.0);
        flat.cluster_id = 2;
        flat.y_sd = 0.0;
        let v = validate_clustering(&[geom(0.0), flat], &sp_cl(Some(5.0)));
        assert_eq!(codes(&v), vec!["degenerate_band"]);
        assert_eq!(v[0].field, "cluster_2");
        assert!(ClusteringParams::new(vec![flat], &sp_cl(Some(5.0))).is_err());
        let v = validate_clustering(&[], &sp_cl(Some(5.0)));
        assert_eq!(codes(&v), vec!["degenerate_band"]);
    }

    // ---------- summary ----------

    #[test]
    fn summary_counts_shares_and_minimum() {
        let nan = f64::NAN;
        // 100, 90, 80 (>=80 -> 3), 60, 40 (mid -> 2), 39, 0 (low -> 2), 2 unscored.
        let scores = [100.0, 90.0, 80.0, 60.0, 40.0, 39.0, 0.0, nan, nan];
        let s = summarize(&scores, 20, |i| (i * 10, Some(format!("t{i}"))));
        assert_eq!(s.scored, 7);
        assert_eq!(s.unscored, 13);
        assert_eq!(s.total_rows, 20);
        let m = s.min_score.unwrap();
        assert_eq!(m.score, 0.0);
        assert_eq!(m.row, 60);
        assert_eq!(m.timestamp.as_deref(), Some("t6"));
        approx(s.share_80_100.unwrap(), 300.0 / 7.0);
        approx(s.share_40_80.unwrap(), 200.0 / 7.0);
        approx(s.share_0_40.unwrap(), 200.0 / 7.0);
        approx(s.pct_below_80.unwrap(), 400.0 / 7.0);
        approx(
            s.share_80_100.unwrap() + s.share_40_80.unwrap() + s.share_0_40.unwrap(),
            100.0,
        );
        assert_eq!(s.share_basis, "row_count");
    }

    #[test]
    fn summary_of_nothing_scored() {
        let s = summarize(&[f64::NAN, f64::NAN], 2, |i| (i, None));
        assert_eq!((s.scored, s.unscored), (0, 2));
        assert!(s.min_score.is_none());
        assert!(s.pct_below_80.is_none());
        assert!(s.share_80_100.is_none());
        let e = summarize(&[], 0, |i| (i, None));
        assert_eq!((e.scored, e.unscored), (0, 0));
    }

    #[test]
    fn summary_minimum_prefers_the_first_row_on_a_tie() {
        let s = summarize(&[50.0, 10.0, 10.0, 90.0], 4, |i| (i, None));
        assert_eq!(s.min_score.unwrap().row, 1);
    }

    // ---------- downsample ----------

    #[test]
    fn select_all_rows_when_under_the_cap() {
        assert_eq!(select_indices(5, 100, None, None), vec![0, 1, 2, 3, 4]);
        assert!(select_indices(0, 100, None, None).is_empty());
    }

    #[test]
    fn select_is_bounded_ascending_and_deduplicated() {
        let n = 100_000;
        let prim: Vec<f64> = (0..n).map(|i| ((i as f64) * 0.01).sin()).collect();
        let score: Vec<f64> = (0..n).map(|i| 50.0 + (i % 50) as f64).collect();
        for max in [8, 50, 1000, 4000] {
            let idx = select_indices(n, max, Some(&prim), Some(&score));
            assert!(idx.len() <= max, "{} > {max}", idx.len());
            assert!(idx.windows(2).all(|w| w[0] < w[1]));
            assert_eq!(*idx.first().unwrap(), 0);
            assert_eq!(*idx.last().unwrap(), n - 1);
        }
    }

    #[test]
    fn select_keeps_the_spike_the_dip_and_the_lowest_score() {
        let n = 50_000;
        let mut prim = vec![10.0; n];
        let mut score = vec![100.0; n];
        prim[12_345] = 999.0; // spike
        prim[40_001] = -999.0; // dip
        score[27_777] = 3.0; // single low score
        let idx = select_indices(n, 300, Some(&prim), Some(&score));
        assert!(idx.len() <= 300);
        assert!(idx.contains(&12_345), "spike lost");
        assert!(idx.contains(&40_001), "dip lost");
        assert!(idx.contains(&27_777), "lowest score lost");
    }

    #[test]
    fn select_score_only_keeps_min_and_skips_nan_buckets() {
        let n = 20_000;
        let mut score = vec![f64::NAN; n];
        for (i, s) in score.iter_mut().enumerate().take(n / 2) {
            *s = 90.0 + (i % 7) as f64;
        }
        score[1234] = 1.0;
        let idx = select_indices(n, 200, None, Some(&score));
        assert!(idx.len() <= 200);
        assert!(idx.contains(&1234));
        // The unscored half still appears (so the gap is visible).
        assert!(idx.iter().any(|&i| i >= n / 2));
    }

    #[test]
    fn select_clamps_a_tiny_or_huge_cap() {
        let n = 5_000;
        let idx = select_indices(n, 1, None, None);
        assert!(idx.len() <= 8 && idx.len() >= 2);
        let idx = select_indices(n, usize::MAX, None, None);
        assert_eq!(idx.len(), n);
    }

    #[test]
    fn stride_is_even_ordered_and_bounded() {
        let idx = stride_indices(1000, 10);
        assert_eq!(idx.len(), 10);
        assert!(idx.windows(2).all(|w| w[0] < w[1]));
        assert_eq!(stride_indices(5, 10), vec![0, 1, 2, 3, 4]);
    }

    // ---------- histogram ----------

    #[test]
    fn histogram_bins_sum_to_the_row_count() {
        let v: Vec<f64> = (0..10_000).map(|i| (i as f64 * 0.37).sin() * 5.0 + 50.0).collect();
        let h = histogram(&v, 50.0, 3.5, 80).unwrap();
        assert!(h.counts.len() <= MAX_HISTOGRAM_BINS);
        assert_eq!(h.counts.len() + 1, h.bin_edges.len());
        assert_eq!(h.counts.iter().sum::<usize>(), v.len());
        assert_eq!(h.n, v.len());
        assert_eq!(h.curve.len(), h.counts.len());
        assert!(h.bin_edges.windows(2).all(|w| w[0] < w[1]));
        // The maximum lands in the last bin, not out of range.
        assert!(*h.counts.last().unwrap() >= 1);
    }

    #[test]
    fn histogram_curve_integrates_to_about_n() {
        // Wide, normal-ish data: curve mass ≈ n (tails beyond the range lost).
        let n = 50_000usize;
        let mut v = Vec::with_capacity(n);
        let mut x = 12345u64;
        for _ in 0..n {
            // Sum of uniforms ~ normal.
            let mut s = 0.0;
            for _ in 0..12 {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                s += (x % 10_000) as f64 / 10_000.0;
            }
            v.push((s - 6.0) * 2.0 + 100.0);
        }
        let mean = v.iter().sum::<f64>() / n as f64;
        let sd = (v.iter().map(|a| (a - mean).powi(2)).sum::<f64>() / (n as f64 - 1.0)).sqrt();
        let h = histogram(&v, mean, sd, 80).unwrap();
        let mass: f64 = h.curve.iter().sum();
        assert!((mass - n as f64).abs() / (n as f64) < 0.02, "mass {mass}");
        // And it peaks near the centre.
        let peak = h
            .curve
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
            .unwrap()
            .0;
        let centre = (h.bin_edges[peak] + h.bin_edges[peak + 1]) / 2.0;
        assert!((centre - mean).abs() < 2.0 * h.bin_width);
    }

    #[test]
    fn histogram_constant_and_empty_inputs() {
        let h = histogram(&[7.0, 7.0, 7.0], 7.0, 0.0, 80).unwrap();
        assert_eq!(h.counts, vec![3]);
        assert_eq!(h.curve, vec![0.0]);
        assert_eq!(h.bin_edges, vec![6.5, 7.5]);
        assert!(histogram(&[], 0.0, 1.0, 80).is_none());
        assert!(histogram(&[f64::NAN], 0.0, 1.0, 80).is_none());
        // Non-finite values are skipped, not counted.
        let h = histogram(&[1.0, f64::NAN, 2.0, f64::INFINITY], 1.5, 0.5, 80).unwrap();
        assert_eq!(h.counts.iter().sum::<usize>(), 2);
    }

    #[test]
    fn histogram_small_samples_use_at_least_ten_bins_and_respect_max_bins() {
        let v: Vec<f64> = (0..30).map(|i| i as f64).collect();
        assert_eq!(histogram(&v, 14.5, 8.8, 80).unwrap().counts.len(), 10);
        assert_eq!(histogram(&v, 14.5, 8.8, 4).unwrap().counts.len(), 4);
        let big: Vec<f64> = (0..1_000_000).map(|i| (i % 1000) as f64).collect();
        assert_eq!(histogram(&big, 500.0, 288.0, 200).unwrap().counts.len(), 80);
    }

    // ---------- cache ----------

    fn fit(n: usize, tag: &str) -> RelFit {
        RelFit {
            target: tag.to_string(),
            predictors: vec!["x".into()],
            lambda: 1.0,
            rows: (0..n as u32).collect(),
            actual: vec![1.0; n],
            predicted: vec![1.0; n],
            x_cols: vec![vec![0.0; n]],
            r2_per_step: vec![0.9],
            rmse2_per_step: vec![0.1],
        }
    }

    #[test]
    fn cache_hit_miss_and_replace() {
        let mut c = RelCache::default();
        assert!(c.get("a").is_none());
        c.insert("a".into(), fit(10, "T1"));
        assert_eq!(c.get("a").unwrap().target, "T1");
        assert!(c.get("b").is_none());
        // Same key replaces, not duplicates.
        c.insert("a".into(), fit(10, "T2"));
        assert_eq!(c.len(), 1);
        assert_eq!(c.get("a").unwrap().target, "T2");
        assert!(c.peek("a").is_some());
        c.clear();
        assert!(c.is_empty());
        assert!(c.get("a").is_none());
    }

    #[test]
    fn cache_is_bounded_by_entries_and_evicts_least_recently_used() {
        let mut c = RelCache::new(3, usize::MAX);
        for k in ["a", "b", "c"] {
            c.insert(k.into(), fit(4, k));
        }
        // Touch "a" so "b" becomes the oldest.
        assert!(c.get("a").is_some());
        c.insert("d".into(), fit(4, "d"));
        assert_eq!(c.len(), 3);
        assert!(c.peek("b").is_none(), "LRU entry should be evicted");
        assert!(c.peek("a").is_some() && c.peek("c").is_some() && c.peek("d").is_some());
    }

    #[test]
    fn cache_is_bounded_by_bytes_but_always_keeps_the_newest() {
        // Each 1000-row fit ≈ 1000*(20+8) = 28 000 bytes.
        let mut c = RelCache::new(100, 60_000);
        c.insert("a".into(), fit(1000, "a"));
        c.insert("b".into(), fit(1000, "b"));
        assert_eq!(c.len(), 2);
        c.insert("c".into(), fit(1000, "c")); // 84 000 > 60 000 -> drop "a"
        assert_eq!(c.len(), 2);
        assert!(c.peek("a").is_none());
        // One entry bigger than the whole budget is still kept alone.
        c.insert("huge".into(), fit(10_000, "huge"));
        assert_eq!(c.len(), 1);
        assert!(c.peek("huge").is_some());
    }

    // ---------- set points parsing ----------

    #[test]
    fn set_points_accept_snake_camel_and_legacy_names() {
        let a: SetPointsArg = serde_json::from_str(
            r#"{"kind":"relationship","residualAt80Lower":-4,"residual_at_80_upper":6,
                "residual_at_health_0_lower":-10,"residualAt0Upper":20,"junk":1}"#,
        )
        .unwrap();
        assert_eq!(a, sp_rel(-4.0, 6.0, -10.0, 20.0));
        let i: SetPointsArg = serde_json::from_str(
            r#"{"kind":"individual","lower":1.5,"upper":null,"masterLower":3,"masterUpper":null}"#,
        )
        .unwrap();
        assert_eq!((i.lower, i.upper), (Some(1.5), None));
        let c: SetPointsArg = serde_json::from_str(r#"{"kind":"clustering","outerSd":5}"#).unwrap();
        assert_eq!(c.outer_sd, Some(5.0));
        let e: SetPointsArg = serde_json::from_str("{}").unwrap();
        assert_eq!(e, SetPointsArg::default());
    }

    #[test]
    fn issue_serializes_with_stable_lowercase_severity() {
        let v = validate_individual(&band(), &sp_ind(None, Some(160.0)));
        let j = serde_json::to_value(&v[0]).unwrap();
        assert_eq!(j["code"], "required");
        assert_eq!(j["severity"], "error");
        assert_eq!(j["field"], "lower");
        assert!(j["message"].as_str().unwrap().len() > 10);
    }
}
