use std::collections::HashMap;

/// Single-sensor operations: take (value, param) -> result
pub type SingleOpFn = fn(f64, f64) -> Option<f64>;
/// Multi-sensor operations: take slice of values -> result
pub type MultiOpFn = fn(&[f64]) -> Option<f64>;

pub fn build_single_ops() -> HashMap<&'static str, SingleOpFn> {
    let mut ops: HashMap<&'static str, SingleOpFn> = HashMap::new();
    ops.insert("add", |a, b| Some(a + b));
    ops.insert("subtract", |a, b| Some(a - b));
    ops.insert("multiply", |a, b| Some(a * b));
    ops.insert("divide", |a, b| if b != 0.0 { Some(a / b) } else { None });
    ops.insert("power", |a, b| Some(a.powf(b)));
    ops.insert("abs", |a, _| Some(a.abs()));
    ops.insert("log10", |a, _| if a > 0.0 { Some(a.log10()) } else { None });
    ops.insert("sqrt", |a, _| if a >= 0.0 { Some(a.sqrt()) } else { None });
    ops.insert("round", |a, decimals| {
        let factor = 10f64.powi(decimals as i32);
        Some((a * factor).round() / factor)
    });
    ops.insert("exp", |a, _| Some(a.exp()));
    ops.insert("ceil", |a, _| Some(a.ceil()));
    ops.insert("floor", |a, _| Some(a.floor()));
    ops
}

pub fn build_multi_ops() -> HashMap<&'static str, MultiOpFn> {
    let mut ops: HashMap<&'static str, MultiOpFn> = HashMap::new();
    ops.insert("sum", |vals| Some(vals.iter().sum()));
    ops.insert("mean", |vals| {
        if vals.is_empty() {
            None
        } else {
            Some(vals.iter().sum::<f64>() / vals.len() as f64)
        }
    });
    ops.insert("median", |vals| {
        if vals.is_empty() {
            return None;
        }
        let mut sorted = vals.to_vec();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let mid = sorted.len() / 2;
        if sorted.len() % 2 == 0 {
            Some((sorted[mid - 1] + sorted[mid]) / 2.0)
        } else {
            Some(sorted[mid])
        }
    });
    ops
}

/// Execute a single-sensor operation using the registry
pub fn execute_single_op(op_id: &str, value: f64, param: f64) -> Result<Option<f64>, String> {
    let ops = build_single_ops();
    match ops.get(op_id) {
        Some(op_fn) => Ok(op_fn(value, param)),
        None => Err(format!("Unknown single operation: {}", op_id)),
    }
}

/// Execute a multi-sensor aggregation using the registry
pub fn execute_multi_op(op_id: &str, values: &[f64]) -> Result<Option<f64>, String> {
    let ops = build_multi_ops();
    match ops.get(op_id) {
        Some(op_fn) => Ok(op_fn(values)),
        None => Err(format!("Unknown multi operation: {}", op_id)),
    }
}

/// Get the display symbol for a single-sensor operation
pub fn single_op_symbol(op_id: &str) -> Result<&'static str, String> {
    match op_id {
        "add" => Ok("+"),
        "subtract" => Ok("-"),
        "multiply" => Ok("*"),
        "divide" => Ok("/"),
        "power" => Ok("^"),
        "abs" => Ok("abs"),
        "log10" => Ok("log10"),
        "sqrt" => Ok("sqrt"),
        "round" => Ok("round"),
        "exp" => Ok("exp"),
        "ceil" => Ok("ceil"),
        "floor" => Ok("floor"),
        _ => Err(format!("Unknown single operation: {}", op_id)),
    }
}

/// Get the display name for a multi-sensor operation
pub fn multi_op_name(op_id: &str) -> Result<&'static str, String> {
    match op_id {
        "sum" => Ok("Sum"),
        "mean" => Ok("Avg"),
        "median" => Ok("Median"),
        _ => Err(format!("Unknown multi operation: {}", op_id)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── execute_single_op ────────────────────────────────────────────

    #[test]
    fn single_add() {
        assert_eq!(execute_single_op("add", 2.0, 3.0).unwrap(), Some(5.0));
    }

    #[test]
    fn single_subtract() {
        assert_eq!(execute_single_op("subtract", 5.0, 3.0).unwrap(), Some(2.0));
    }

    #[test]
    fn single_multiply() {
        assert_eq!(execute_single_op("multiply", 4.0, 2.5).unwrap(), Some(10.0));
    }

    #[test]
    fn single_divide() {
        assert_eq!(execute_single_op("divide", 10.0, 4.0).unwrap(), Some(2.5));
    }

    #[test]
    fn single_divide_by_zero_is_none() {
        assert_eq!(execute_single_op("divide", 10.0, 0.0).unwrap(), None);
    }

    #[test]
    fn single_power() {
        assert_eq!(execute_single_op("power", 2.0, 3.0).unwrap(), Some(8.0));
    }

    #[test]
    fn single_power_negative_exponent() {
        assert_eq!(execute_single_op("power", 2.0, -1.0).unwrap(), Some(0.5));
    }

    #[test]
    fn single_abs_negative_becomes_positive() {
        assert_eq!(execute_single_op("abs", -7.5, 0.0).unwrap(), Some(7.5));
    }

    #[test]
    fn single_abs_positive_unchanged() {
        assert_eq!(execute_single_op("abs", 7.5, 0.0).unwrap(), Some(7.5));
    }

    #[test]
    fn single_log10_valid() {
        assert_eq!(execute_single_op("log10", 100.0, 0.0).unwrap(), Some(2.0));
    }

    #[test]
    fn single_log10_zero_is_none() {
        assert_eq!(execute_single_op("log10", 0.0, 0.0).unwrap(), None);
    }

    #[test]
    fn single_log10_negative_is_none() {
        assert_eq!(execute_single_op("log10", -5.0, 0.0).unwrap(), None);
    }

    #[test]
    fn single_sqrt_valid() {
        assert_eq!(execute_single_op("sqrt", 9.0, 0.0).unwrap(), Some(3.0));
    }

    #[test]
    fn single_sqrt_zero_is_valid() {
        assert_eq!(execute_single_op("sqrt", 0.0, 0.0).unwrap(), Some(0.0));
    }

    #[test]
    fn single_sqrt_negative_is_none() {
        assert_eq!(execute_single_op("sqrt", -4.0, 0.0).unwrap(), None);
    }

    #[test]
    fn single_round_two_decimals() {
        assert_eq!(execute_single_op("round", 3.14159, 2.0).unwrap(), Some(3.14));
    }

    #[test]
    fn single_round_zero_decimals() {
        assert_eq!(execute_single_op("round", 3.6, 0.0).unwrap(), Some(4.0));
    }

    #[test]
    fn single_exp() {
        let result = execute_single_op("exp", 0.0, 0.0).unwrap().unwrap();
        assert!((result - 1.0).abs() < 1e-9);
    }

    #[test]
    fn single_ceil() {
        assert_eq!(execute_single_op("ceil", 3.1, 0.0).unwrap(), Some(4.0));
    }

    #[test]
    fn single_ceil_already_whole_unchanged() {
        assert_eq!(execute_single_op("ceil", 3.0, 0.0).unwrap(), Some(3.0));
    }

    #[test]
    fn single_floor() {
        assert_eq!(execute_single_op("floor", 3.9, 0.0).unwrap(), Some(3.0));
    }

    #[test]
    fn single_unknown_op_errs() {
        assert!(execute_single_op("bogus", 1.0, 1.0).is_err());
    }

    // Regression guard: "product"/"subtract"/"divide" multi-op-with-base
    // were removed from the multi registry (2026-08-06) but their names
    // overlap with real single-op ids — confirm single-op "subtract"/
    // "divide" still work (they're a different feature: a sensor combined
    // with a fixed value, not "one sensor vs the rest").
    #[test]
    fn single_subtract_and_divide_ids_still_valid_after_multi_removal() {
        assert!(execute_single_op("subtract", 1.0, 1.0).is_ok());
        assert!(execute_single_op("divide", 1.0, 1.0).is_ok());
    }

    // ── execute_multi_op ─────────────────────────────────────────────

    #[test]
    fn multi_sum() {
        assert_eq!(execute_multi_op("sum", &[1.0, 2.0, 3.0]).unwrap(), Some(6.0));
    }

    #[test]
    fn multi_sum_empty_is_zero() {
        // Rust's iter().sum() on an empty slice is 0.0, not None — sum has
        // a sensible identity element, unlike mean/median.
        assert_eq!(execute_multi_op("sum", &[]).unwrap(), Some(0.0));
    }

    #[test]
    fn multi_mean() {
        assert_eq!(execute_multi_op("mean", &[2.0, 4.0, 6.0]).unwrap(), Some(4.0));
    }

    #[test]
    fn multi_mean_empty_is_none() {
        assert_eq!(execute_multi_op("mean", &[]).unwrap(), None);
    }

    #[test]
    fn multi_median_odd_count() {
        assert_eq!(execute_multi_op("median", &[1.0, 5.0, 3.0]).unwrap(), Some(3.0));
    }

    #[test]
    fn multi_median_even_count_averages_middle_two() {
        assert_eq!(execute_multi_op("median", &[1.0, 2.0, 3.0, 4.0]).unwrap(), Some(2.5));
    }

    #[test]
    fn multi_median_single_element() {
        assert_eq!(execute_multi_op("median", &[42.0]).unwrap(), Some(42.0));
    }

    #[test]
    fn multi_median_empty_is_none() {
        assert_eq!(execute_multi_op("median", &[]).unwrap(), None);
    }

    #[test]
    fn multi_unknown_op_errs() {
        assert!(execute_multi_op("bogus", &[1.0]).is_err());
    }

    // Regression guard: "product" (and "subtract"/"divide" as multi-ops
    // with a base sensor) were removed from the multi registry entirely
    // (2026-08-06, alongside their UI in SensorTooling.tsx). If either
    // ever silently comes back as valid here without the UI/type-layer
    // support being restored too, calculate_new_sensor would accept a
    // config the frontend can no longer construct — catch that drift.
    #[test]
    fn multi_product_was_removed() {
        assert!(execute_multi_op("product", &[2.0, 3.0]).is_err());
    }

    #[test]
    fn multi_subtract_and_divide_were_removed() {
        assert!(execute_multi_op("subtract", &[2.0, 3.0]).is_err());
        assert!(execute_multi_op("divide", &[2.0, 3.0]).is_err());
    }

    // ── single_op_symbol ─────────────────────────────────────────────

    #[test]
    fn single_op_symbol_covers_every_known_id() {
        let expected = [
            ("add", "+"), ("subtract", "-"), ("multiply", "*"), ("divide", "/"),
            ("power", "^"), ("abs", "abs"), ("log10", "log10"), ("sqrt", "sqrt"),
            ("round", "round"), ("exp", "exp"), ("ceil", "ceil"), ("floor", "floor"),
        ];
        for (id, symbol) in expected {
            assert_eq!(single_op_symbol(id).unwrap(), symbol, "mismatch for id={id}");
        }
    }

    #[test]
    fn single_op_symbol_unknown_errs() {
        assert!(single_op_symbol("bogus").is_err());
    }

    // ── multi_op_name ────────────────────────────────────────────────

    #[test]
    fn multi_op_name_covers_every_known_id() {
        let expected = [("sum", "Sum"), ("mean", "Avg"), ("median", "Median")];
        for (id, name) in expected {
            assert_eq!(multi_op_name(id).unwrap(), name, "mismatch for id={id}");
        }
    }

    #[test]
    fn multi_op_name_unknown_errs() {
        assert!(multi_op_name("bogus").is_err());
    }

    #[test]
    fn multi_op_name_product_was_removed() {
        assert!(multi_op_name("product").is_err());
    }
}
