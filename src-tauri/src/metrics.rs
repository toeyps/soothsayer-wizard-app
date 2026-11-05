//! Pure `std` metric helpers on `&[f64]`; degenerate input returns `f64::NAN` instead of panicking.
//! Parity with numpy/pandas to within 1e-9 on hand-computed fixtures (see `tests`).

/// R² = 1 - SS_res / SS_tot against the mean of `y_true`; NaN for empty, mismatched length, or constant `y_true`.
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

/// NaN for empty or mismatched input.
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

/// Population SD (ddof=0, divides by N); the caller passes the precomputed mean; NaN on empty.
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

/// Sample SD (Bessel, ddof=1, divides by N - 1), matching `pandas.Series.std()`; NaN for fewer than 2 values.
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

/// Minimum number of decimals kept by [`round_metric`].
const METRIC_MIN_DECIMALS: i32 = 3;

/// Decimals `round_metric` keeps: 3 for |x| >= 1, else enough for 4 significant digits; 0 / NaN / ±inf use 3.
fn metric_decimals(x: f64) -> i32 {
    if x == 0.0 || !x.is_finite() {
        return METRIC_MIN_DECIMALS;
    }
    let exp = x.abs().log10().floor() as i32;
    (METRIC_MIN_DECIMALS - exp).max(METRIC_MIN_DECIMALS)
}

/// Returns `x` unchanged when scaling would overflow (huge magnitudes are already integral).
fn round_to_decimals(x: f64, decimals: i32) -> f64 {
    if !x.is_finite() || x.abs() >= 1e15 {
        return x;
    }
    let scale = 10f64.powi(decimals);
    if !scale.is_finite() {
        return x;
    }
    let scaled = x * scale;
    if !scaled.is_finite() {
        return x;
    }
    scaled.round() / scale
}

/// Rounding for every reported metric: 3 decimals when |x| >= 1, else 4 significant digits.
/// With a tiny SD, 3 decimals would merge the 1 SD and 3 SD boundaries (zero health-score denominator). 0 stays 0; NaN / ±inf pass through.
pub fn round_metric(x: f64) -> f64 {
    round_to_decimals(x, metric_decimals(x))
}

/// `round_metric` for a value next to a smaller spread: uses the finer of the two precisions so `mean ± k·sd` stays resolvable.
pub fn round_metric_scaled(x: f64, scale: f64) -> f64 {
    let own = metric_decimals(x);
    let by_scale = if scale == 0.0 || !scale.is_finite() {
        METRIC_MIN_DECIMALS
    } else {
        metric_decimals(scale)
    };
    round_to_decimals(x, own.max(by_scale))
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


    #[test]
    fn population_sd_known_three_values() {
        // Hand-computed: values [2,4,4], population variance 8/9.
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


    #[test]
    fn sample_sd_known_four_values() {
        // Hand-computed: values [1,2,3,4], sample variance 5/3.
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
        // sklearn doc fixture: ss_res = 1.5, ss_tot = 29.1875.
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


    /// Fixed 3-decimal rounding; `round_metric` must match it wherever 3 decimals already give >= 4 significant digits.
    fn legacy_r3(x: f64) -> f64 {
        (x * 1000.0).round() / 1000.0
    }

    #[test]
    fn round_metric_typical_values_match_three_decimals() {
        assert_eq!(round_metric(1234.5678), 1234.568);
        assert_eq!(round_metric(1.23456), 1.235);
        assert_eq!(round_metric(5.0), 5.0);
        assert_eq!(round_metric(99.9996), 100.0);
        // Anything with |x| >= 1 is bit-identical to `legacy_r3`.
        for x in [1.0, 1.0005, 3.14159, 12.3456, 250.5555, 9999.9999, -1.2346, -75.4321] {
            assert_eq!(round_metric(x), legacy_r3(x), "x = {x}");
        }
    }

    #[test]
    fn round_metric_small_values_keep_four_significant_digits() {
        assert_eq!(round_metric(0.000412345), 0.0004123);
        assert_eq!(round_metric(0.00412345), 0.004123);
        assert_eq!(round_metric(0.0412345), 0.04123);
        assert_eq!(round_metric(0.123456), 0.1235);
        // A tiny value that fixed 3-decimal rounding collapses to 0.0.
        assert_eq!(legacy_r3(0.0004), 0.0);
        assert_eq!(round_metric(0.0004), 0.0004);
    }

    #[test]
    fn round_metric_negative_values_are_symmetric() {
        assert_eq!(round_metric(-1234.5678), -1234.568);
        assert_eq!(round_metric(-0.000412345), -0.0004123);
        assert_eq!(round_metric(-0.123456), -0.1235);
    }

    #[test]
    fn round_metric_zero_nan_inf_pass_through() {
        assert_eq!(round_metric(0.0), 0.0);
        assert!(round_metric(f64::NAN).is_nan());
        assert_eq!(round_metric(f64::INFINITY), f64::INFINITY);
        assert_eq!(round_metric(f64::NEG_INFINITY), f64::NEG_INFINITY);
    }

    #[test]
    fn round_metric_very_large_and_very_small_magnitudes_do_not_overflow() {
        assert_eq!(round_metric(1.0e15), 1.0e15);
        assert_eq!(round_metric(1.7e308), 1.7e308);
        assert_eq!(round_metric(-1.7e308), -1.7e308);
        assert_eq!(round_metric(123456789012.3456), 123456789012.346);
        // 10^decimals would overflow for subnormals — value comes back as is.
        let tiny = 1.0e-320;
        assert_eq!(round_metric(tiny), tiny);
        // Still a sane number just above the overflow edge.
        let small = 1.234567e-300;
        assert!((round_metric(small) - 1.235e-300).abs() < 1e-310);
    }

    #[test]
    fn round_metric_keeps_small_sd_bands_distinct() {
        // SD ~0.0004: with fixed 3-decimal rounding (`legacy_r3`) the 1SD and 3SD half-widths would both be 0.0.
        let sd = round_metric(0.000412);
        assert_eq!(sd, 0.000412);
        assert!(round_metric(sd) > 0.0);
        assert_ne!(round_metric(1.0 * sd), round_metric(3.0 * sd));
    }


    #[test]
    fn round_metric_scaled_equals_round_metric_when_scale_is_not_small() {
        for (x, s) in [(1234.5678, 5.0), (1234.5678, 1.0), (0.000412345, 10.0), (-7.77777, 100.0)] {
            assert_eq!(round_metric_scaled(x, s), round_metric(x), "x = {x}, s = {s}");
        }
        // Zero / NaN / inf scale → ignored.
        assert_eq!(round_metric_scaled(1234.5678, 0.0), 1234.568);
        assert_eq!(round_metric_scaled(1234.5678, f64::NAN), 1234.568);
        assert_eq!(round_metric_scaled(1234.5678, f64::INFINITY), 1234.568);
    }

    #[test]
    fn round_metric_scaled_keeps_boundaries_of_a_large_mean_with_tiny_sd_distinct() {
        let sd = 0.0004;
        let mean = 1000.0001234;
        let m = round_metric_scaled(mean, sd);
        let lo1 = round_metric_scaled(m - sd, sd);
        let hi1 = round_metric_scaled(m + sd, sd);
        let lo3 = round_metric_scaled(m - 3.0 * sd, sd);
        let hi3 = round_metric_scaled(m + 3.0 * sd, sd);
        assert!(lo3 < lo1 && lo1 < m && m < hi1 && hi1 < hi3, "{lo3} {lo1} {m} {hi1} {hi3}");
        // The plain 3-decimal rule would have collapsed all five onto 1000.0.
        assert_eq!(round_metric(m), 1000.0);
        assert_eq!(round_metric(m - sd), 1000.0);
    }

    #[test]
    fn round_metric_scaled_passes_through_non_finite_x() {
        assert!(round_metric_scaled(f64::NAN, 0.001).is_nan());
        assert_eq!(round_metric_scaled(f64::INFINITY, 0.001), f64::INFINITY);
    }
}
