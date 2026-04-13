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
    ops.insert("product", |vals| Some(vals.iter().product()));
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

/// Execute a multi-sensor operation with a base sensor (subtract/divide)
pub fn execute_base_op(
    op_id: &str,
    base_value: f64,
    others_sum: f64,
) -> Result<Option<f64>, String> {
    match op_id {
        "subtract" => Ok(Some(base_value - others_sum)),
        "divide" => {
            if others_sum != 0.0 {
                Ok(Some(base_value / others_sum))
            } else {
                Ok(None)
            }
        }
        _ => Err(format!("Unknown base operation: {}", op_id)),
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
        "product" => Ok("Product"),
        "subtract" => Ok("Diff"),
        "divide" => Ok("Ratio"),
        _ => Err(format!("Unknown multi operation: {}", op_id)),
    }
}

/// Check if a multi-sensor operation requires a base sensor
pub fn is_base_op(op_id: &str) -> bool {
    matches!(op_id, "subtract" | "divide")
}
