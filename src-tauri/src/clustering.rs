//! 2D ellipse fitting for the single-cluster GMM case.
//!
//! For `n_components = 1`, sklearn's `GaussianMixture` reduces to:
//!   - mean = sample mean
//!   - covariance = sample covariance matrix (ddof=0 in sklearn's empirical
//!     covariance — we follow the same convention here)
//!
//! The major-/minor-axis lengths and rotation angle are recovered via SVD
//! of the 2×2 covariance matrix:
//!   `U, s, Vt = svd(cov)`
//!   `angle_deg = atan2(U[1,0], U[0,0]).to_degrees()`
//!   `(major_sd, minor_sd) = (sqrt(s[0]), sqrt(s[1]))`
//!
//! See `wizard.py::PreviewModel.clustering` for the reference Python.

use nalgebra::{Matrix2, SVD};

#[derive(Debug, Clone, serde::Serialize)]
pub struct EllipseFit {
    pub x_center: f64,
    pub y_center: f64,
    /// Major-axis std (sqrt of larger singular value).
    pub x_sd: f64,
    /// Minor-axis std (sqrt of smaller singular value).
    pub y_sd: f64,
    /// Rotation angle of the major axis in degrees.
    pub angle_deg: f64,
}

/// Fit a 2D Gaussian (n_components=1, full covariance) to `(xs, ys)` and
/// return the ellipse parameters. Inputs must have equal, non-zero length.
pub fn fit_single_cluster_ellipse(xs: &[f64], ys: &[f64]) -> Result<EllipseFit, String> {
    if xs.is_empty() || ys.is_empty() {
        return Err("fit_single_cluster_ellipse: empty input".into());
    }
    if xs.len() != ys.len() {
        return Err(format!(
            "fit_single_cluster_ellipse: length mismatch xs={} ys={}",
            xs.len(),
            ys.len()
        ));
    }

    let n = xs.len() as f64;
    let mean_x: f64 = xs.iter().sum::<f64>() / n;
    let mean_y: f64 = ys.iter().sum::<f64>() / n;

    // sklearn empirical covariance uses biased estimator (divide by N), which
    // matches numpy.cov(..., bias=True). wizard.py relies on
    // sklearn.mixture.GaussianMixture which internally uses the biased
    // estimator for the covariance attribute. We follow the same convention
    // for parity.
    let mut sxx = 0.0_f64;
    let mut syy = 0.0_f64;
    let mut sxy = 0.0_f64;
    for (x, y) in xs.iter().zip(ys.iter()) {
        let dx = x - mean_x;
        let dy = y - mean_y;
        sxx += dx * dx;
        syy += dy * dy;
        sxy += dx * dy;
    }
    let cov = Matrix2::new(sxx / n, sxy / n, sxy / n, syy / n);

    let svd = SVD::new(cov, true, true);
    let u = svd
        .u
        .ok_or_else(|| "SVD failed to produce U".to_string())?;
    let s = svd.singular_values; // 2-vector, ordered descending

    let s0 = s[0].max(0.0);
    let s1 = s[1].max(0.0);
    let angle_deg = u[(1, 0)].atan2(u[(0, 0)]).to_degrees();

    Ok(EllipseFit {
        x_center: mean_x,
        y_center: mean_y,
        x_sd: s0.sqrt(),
        y_sd: s1.sqrt(),
        angle_deg,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPS: f64 = 1e-6;

    fn approx(a: f64, b: f64, eps: f64) {
        assert!(
            (a - b).abs() < eps,
            "expected ≈{b}, got {a} (|Δ| = {})",
            (a - b).abs()
        );
    }

    /// Build an axis-aligned cloud: x ~ var=4, y ~ var=1, mean (10, 20).
    /// Covariance is diagonal → SVD U should be ±I → angle ≈ 0.
    #[test]
    fn axis_aligned_gaussian_angle_zero() {
        // 5 symmetric points: spread of ±2 on x and ±1 on y, mean (10, 20).
        let xs = [12.0, 8.0, 12.0, 8.0, 10.0, 10.0];
        let ys = [21.0, 19.0, 19.0, 21.0, 20.0, 20.0];
        let fit = fit_single_cluster_ellipse(&xs, &ys).unwrap();
        approx(fit.x_center, 10.0, EPS);
        approx(fit.y_center, 20.0, EPS);
        // For symmetric +/- spread the off-diagonal sum cancels exactly.
        // var_x = (4+4+4+4+0+0)/6 = 16/6, var_y = (1+1+1+1+0+0)/6 = 4/6
        let expected_major = (16.0_f64 / 6.0).sqrt();
        let expected_minor = (4.0_f64 / 6.0).sqrt();
        approx(fit.x_sd, expected_major, EPS);
        approx(fit.y_sd, expected_minor, EPS);
        // Angle should be 0° (or 180° depending on sign of U) — both have
        // |sin| = 0 so |angle mod 180| ≈ 0.
        let a_mod = fit.angle_deg.rem_euclid(180.0);
        let near_zero = a_mod < 1e-6 || (a_mod - 180.0).abs() < 1e-6;
        assert!(near_zero, "angle_deg = {}", fit.angle_deg);
    }

    /// Diagonal cloud rotated by 45°: covariance off-diagonal dominates.
    /// Eigenvectors should be (1,1)/√2 and (-1,1)/√2 → angle = ±45°.
    #[test]
    fn rotated_45_gaussian_angle_45() {
        // 4-point cloud along the y=x axis with small perpendicular spread.
        let xs = [1.0, -1.0, 2.0, -2.0];
        let ys = [1.0, -1.0, 2.0, -2.0];
        let fit = fit_single_cluster_ellipse(&xs, &ys).unwrap();
        approx(fit.x_center, 0.0, EPS);
        approx(fit.y_center, 0.0, EPS);
        // var_x = var_y = 10/4 = 2.5; cov = 10/4 = 2.5 → eigenvalues 5 and 0.
        // major_sd = sqrt(5), minor_sd = 0.
        approx(fit.x_sd, 5.0_f64.sqrt(), EPS);
        approx(fit.y_sd, 0.0, EPS);
        // Angle: principal axis along (1,1)/√2 → atan2(1/√2, 1/√2) = 45°
        // (or -135° if U flips sign — accept |angle| close to 45 mod 180).
        let a_mod = (fit.angle_deg.rem_euclid(180.0) - 45.0).abs();
        assert!(a_mod < 1e-6, "angle_deg = {}", fit.angle_deg);
    }

    /// Hand-computed 2x2 covariance recovery — ensures means are right
    /// and singular values match `numpy.linalg.svd` output.
    #[test]
    fn known_cov_matrix_recovery() {
        // 4 points: (0,0), (2,0), (0,2), (2,2)
        // mean = (1,1), cov (biased, /N): var_x = var_y = 1, cov_xy = 0
        let xs = [0.0, 2.0, 0.0, 2.0];
        let ys = [0.0, 0.0, 2.0, 2.0];
        let fit = fit_single_cluster_ellipse(&xs, &ys).unwrap();
        approx(fit.x_center, 1.0, EPS);
        approx(fit.y_center, 1.0, EPS);
        // Both singular values = 1 → x_sd = y_sd = 1
        approx(fit.x_sd, 1.0, EPS);
        approx(fit.y_sd, 1.0, EPS);
    }

    #[test]
    fn empty_input_errors() {
        assert!(fit_single_cluster_ellipse(&[], &[]).is_err());
    }

    #[test]
    fn length_mismatch_errors() {
        assert!(fit_single_cluster_ellipse(&[1.0, 2.0], &[1.0]).is_err());
    }
}
