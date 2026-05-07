//! Statistical metric helpers used across the predictive-model code paths.
//!
//! All helpers are pure `std`, side-effect free, and operate on `&[f64]`.
//! Edge cases (empty input, single-element where the metric is undefined)
//! return `f64::NAN` instead of panicking. This matches the behaviour of
//! numpy / pandas on degenerate inputs and keeps callers from needing to
//! sprinkle `is_empty()` guards everywhere.
//!
//! Numerical contract: parity with the corresponding numpy/pandas reference
//! to within 1e-9 on hand-computed fixtures (see `tests` below).
//!
//! `mean` and `sample_sd` are wired into `compute_sensor_stats` and the
//! `train_individual_model` command (Phase 3). `population_sd`, `r2_score`,
//! and `rmse` are kept available for future callers.

/// Coefficient of determination (R²).
///
/// `1 - SS_res / SS_tot` where `SS_tot` is computed against the mean of
/// `y_true`. Returns `NaN` if the inputs are empty, mismatched in length,
/// or `SS_tot` is zero (constant `y_true`, undefined R²).
pub fn r2_score(y_true: &[f64], y_pred: &[f64]) -> f64 {
    if y_true.is_empty() || y_true.len() != y_pred.len() {
        return f64::NAN;
    }
    let mean_true = mean(y_true);
    let mut ss_res = 0.0_f64;
    let mut ss_tot = 0.0_f64;
    for (yt, yp) in y_true.iter().zip(y_pred.iter()) {
        let r = yt - yp;
        ss_res += r * r;
        let d = yt - mean_true;
        ss_tot += d * d;
    }
    if ss_tot == 0.0 {
        return f64::NAN;
    }
    1.0 - ss_res / ss_tot
}

/// Root mean squared error.
///
/// `sqrt(mean((y_true - y_pred)^2))`. Returns `NaN` for empty/mismatched input.
pub fn rmse(y_true: &[f64], y_pred: &[f64]) -> f64 {
    if y_true.is_empty() || y_true.len() != y_pred.len() {
        return f64::NAN;
    }
    let mut acc = 0.0_f64;
    for (yt, yp) in y_true.iter().zip(y_pred.iter()) {
        let d = yt - yp;
        acc += d * d;
    }
    (acc / (y_true.len() as f64)).sqrt()
}

/// Arithmetic mean. Returns `NaN` on empty input.
pub fn mean(values: &[f64]) -> f64 {
    if values.is_empty() {
        return f64::NAN;
    }
    let mut acc = 0.0_f64;
    for v in values {
        acc += *v;
    }
    acc / (values.len() as f64)
}

/// Population standard deviation (ddof=0). Divides by `N`.
///
/// Returns `NaN` on empty input. The caller must pass a precomputed mean to
/// avoid recomputing it (callers typically already have it).
pub fn population_sd(values: &[f64], mean: f64) -> f64 {
    if values.is_empty() {
        return f64::NAN;
    }
    let mut acc = 0.0_f64;
    for v in values {
        let d = v - mean;
        acc += d * d;
    }
    (acc / (values.len() as f64)).sqrt()
}

/// Sample standard deviation with Bessel's correction (ddof=1). Divides by `N - 1`.
///
/// Matches `pandas.Series.std()` (the wizard.py default). Returns `NaN` on
/// empty input or single-element input (where ddof=1 is undefined).
pub fn sample_sd(values: &[f64], mean: f64) -> f64 {
    let n = values.len();
    if n < 2 {
        return f64::NAN;
    }
    let mut acc = 0.0_f64;
    for v in values {
        let d = v - mean;
        acc += d * d;
    }
    (acc / ((n - 1) as f64)).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tolerance for parity with the reference numpy/pandas computation.
    const EPS: f64 = 1e-9;

    fn approx(a: f64, b: f64) {
        assert!(
            (a - b).abs() < EPS,
            "expected ≈{b}, got {a} (|Δ| = {})",
            (a - b).abs()
        );
    }

    // ---------- mean ----------

    #[test]
    fn mean_simple() {
        approx(mean(&[1.0, 2.0, 3.0, 4.0]), 2.5);
    }

    #[test]
    fn mean_negatives_and_floats() {
        approx(mean(&[-1.5, 0.5, 2.5]), 0.5);
    }

    #[test]
    fn mean_single_element() {
        approx(mean(&[42.0]), 42.0);
    }

    #[test]
    fn mean_empty_is_nan() {
        assert!(mean(&[]).is_nan());
    }

    // ---------- population_sd ----------

    #[test]
    fn population_sd_known_three_values() {
        // values = [2,4,4]  mean = 10/3
        // pop variance = ((2-10/3)^2 + (4-10/3)^2 + (4-10/3)^2) / 3
        //              = (16/9 + 4/9 + 4/9) / 3 = 24/27 = 8/9
        let v = [2.0, 4.0, 4.0];
        let m = mean(&v);
        approx(population_sd(&v, m), (8.0_f64 / 9.0).sqrt());
    }

    #[test]
    fn population_sd_constant_is_zero() {
        let v = [5.0, 5.0, 5.0, 5.0];
        approx(population_sd(&v, mean(&v)), 0.0);
    }

    #[test]
    fn population_sd_single_element_is_zero() {
        // ddof=0: variance of a single point about itself is 0
        approx(population_sd(&[7.0], 7.0), 0.0);
    }

    #[test]
    fn population_sd_empty_is_nan() {
        assert!(population_sd(&[], 0.0).is_nan());
    }

    // ---------- sample_sd ----------

    #[test]
    fn sample_sd_known_four_values() {
        // values = [1,2,3,4]  mean = 2.5
        // sum sq dev = 2.25 + 0.25 + 0.25 + 2.25 = 5.0
        // sample variance = 5/3 -> sd = sqrt(5/3)
        let v = [1.0, 2.0, 3.0, 4.0];
        approx(sample_sd(&v, mean(&v)), (5.0_f64 / 3.0).sqrt());
    }

    #[test]
    fn sample_sd_known_three_values() {
        // values = [2,4,4]  sum sq dev about 10/3 = 24/9
        // sample variance = (24/9) / 2 = 4/3 -> sd = sqrt(4/3)
        let v = [2.0, 4.0, 4.0];
        approx(sample_sd(&v, mean(&v)), (4.0_f64 / 3.0).sqrt());
    }

    #[test]
    fn sample_sd_constant_is_zero() {
        let v = [5.0, 5.0, 5.0];
        approx(sample_sd(&v, mean(&v)), 0.0);
    }

    #[test]
    fn sample_sd_single_element_is_nan() {
        // ddof=1 with n=1 → division by zero / undefined → NaN, matching pandas
        assert!(sample_sd(&[42.0], 42.0).is_nan());
    }

    #[test]
    fn sample_sd_empty_is_nan() {
        assert!(sample_sd(&[], 0.0).is_nan());
    }

    /// Direct ddof comparison: on the same input, `sample_sd^2 = pop_sd^2 * N/(N-1)`.
    #[test]
    fn sample_vs_population_ddof_difference() {
        let v = [2.0, 4.0, 4.0, 4.0, 5.0, 5.0, 7.0, 9.0];
        let m = mean(&v);
        let pop = population_sd(&v, m);
        let samp = sample_sd(&v, m);
        let n = v.len() as f64;
        approx(samp * samp, pop * pop * n / (n - 1.0));
        // And concretely: pop_var = 32/8 = 4, sd = 2; samp_var = 32/7
        approx(pop, 2.0);
        approx(samp, (32.0_f64 / 7.0).sqrt());
    }

    // ---------- r2_score ----------

    #[test]
    fn r2_perfect_fit_is_one() {
        let y = [1.0, 2.0, 3.0, 4.0, 5.0];
        approx(r2_score(&y, &y), 1.0);
    }

    #[test]
    fn r2_predicting_mean_is_zero() {
        let y = [1.0, 2.0, 3.0, 4.0, 5.0];
        let m = mean(&y);
        let yp = [m, m, m, m, m];
        approx(r2_score(&y, &yp), 0.0);
    }

    #[test]
    fn r2_known_value() {
        // y = [3, -0.5, 2, 7], yhat = [2.5, 0.0, 2, 8]  (sklearn doc fixture)
        // ss_res = 0.25 + 0.25 + 0 + 1 = 1.5
        // mean_y = 2.875
        // ss_tot = (3-2.875)^2 + (-0.5-2.875)^2 + (2-2.875)^2 + (7-2.875)^2
        //        = 0.015625 + 11.390625 + 0.765625 + 17.015625 = 29.1875
        // r2 = 1 - 1.5/29.1875 = 0.9486081370449679
        let y = [3.0, -0.5, 2.0, 7.0];
        let yp = [2.5, 0.0, 2.0, 8.0];
        approx(r2_score(&y, &yp), 1.0 - 1.5 / 29.1875);
    }

    #[test]
    fn r2_constant_truth_is_nan() {
        // ss_tot = 0 → undefined
        let y = [4.0, 4.0, 4.0];
        let yp = [4.0, 4.5, 3.5];
        assert!(r2_score(&y, &yp).is_nan());
    }

    #[test]
    fn r2_length_mismatch_is_nan() {
        assert!(r2_score(&[1.0, 2.0], &[1.0]).is_nan());
    }

    #[test]
    fn r2_empty_is_nan() {
        assert!(r2_score(&[], &[]).is_nan());
    }

    // ---------- rmse ----------

    #[test]
    fn rmse_zero_when_perfect() {
        let y = [1.0, 2.0, 3.0];
        approx(rmse(&y, &y), 0.0);
    }

    #[test]
    fn rmse_known_value() {
        // y = [3, -0.5, 2, 7], yhat = [2.5, 0.0, 2, 8]
        // mse = (0.25 + 0.25 + 0 + 1) / 4 = 0.375; rmse = sqrt(0.375)
        let y = [3.0, -0.5, 2.0, 7.0];
        let yp = [2.5, 0.0, 2.0, 8.0];
        approx(rmse(&y, &yp), 0.375_f64.sqrt());
    }

    #[test]
    fn rmse_constant_offset() {
        // y = [1,2,3], yhat = [2,3,4] → residuals all 1 → rmse = 1
        approx(rmse(&[1.0, 2.0, 3.0], &[2.0, 3.0, 4.0]), 1.0);
    }

    #[test]
    fn rmse_length_mismatch_is_nan() {
        assert!(rmse(&[1.0, 2.0], &[1.0]).is_nan());
    }

    #[test]
    fn rmse_empty_is_nan() {
        assert!(rmse(&[], &[]).is_nan());
    }
}
