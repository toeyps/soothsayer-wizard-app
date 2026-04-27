pub mod csv_processor;
pub mod operation_registry;
use csv_processor::{
    load_metadata, CsvLoadReport, MappingData, MappingResult, ProcessedData,
    SensorMetadata,
};
use fasteval::Evaler;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Mutex;
use tauri::{Emitter, State};

struct SessionData {
    data: ProcessedData,
    paths: Vec<String>,
}

struct AppState(Mutex<Option<SessionData>>);

#[tauri::command]
fn load_csv(paths: Vec<String>, state: State<AppState>) -> Result<CsvLoadReport, String> {
    let merge_result = csv_processor::read_merge_csvs_with_report(paths.clone())?;
    let report = csv_processor::build_load_report(&merge_result);

    let mut state_lock = state.0.lock().map_err(|e| e.to_string())?;
    *state_lock = Some(SessionData {
        data: merge_result.data,
        paths,
    });

    Ok(report)
}

#[tauri::command]
fn get_loaded_paths(state: State<AppState>) -> Result<Vec<String>, String> {
    let state_lock = state.0.lock().map_err(|e| e.to_string())?;
    match &*state_lock {
        Some(session) => Ok(session.paths.clone()),
        None => Ok(Vec::new()),
    }
}

#[tauri::command]
fn get_data(
    sensors: Vec<String>,
    window: tauri::Window,
    state: State<AppState>,
) -> Result<(), String> {
    let state_lock = state.0.lock().map_err(|e| e.to_string())?;
    let session = state_lock.as_ref().ok_or("No data loaded")?;
    let data = &session.data;

    // Find indices of requested sensors
    let mut indices = Vec::new();
    for sensor in &sensors {
        if let Some(idx) = data.headers.iter().position(|h| h == sensor) {
            indices.push(idx);
        }
    }

    const CHUNK_SIZE: usize = 5000;

    for (_chunk_idx, chunk) in data.rows.chunks(CHUNK_SIZE).enumerate() {
        let chunk_data: Vec<csv_processor::CsvRecord> = chunk
            .iter()
            .map(|row| {
                let mut new_values = Vec::new();
                for &idx in &indices {
                    if idx < row.values.len() {
                        new_values.push(row.values[idx]);
                    } else {
                        new_values.push(None);
                    }
                }

                csv_processor::CsvRecord {
                    timestamp: row.timestamp.clone(),
                    values: new_values,
                }
            })
            .collect();

        window
            .emit(
                "data-stream-chunk",
                ProcessedData {
                    headers: sensors.clone(),
                    rows: chunk_data,
                },
            )
            .map_err(|e| e.to_string())?;
    }

    window
        .emit("data-stream-end", {})
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn get_all_sensors(state: State<AppState>) -> Result<Vec<String>, String> {
    let state_lock = state.0.lock().map_err(|e| e.to_string())?;
    let session = state_lock.as_ref().ok_or("No data loaded")?;
    Ok(session.data.headers.clone())
}

#[tauri::command]
fn load_metadata_command(path: String) -> Result<Vec<SensorMetadata>, String> {
    load_metadata(&path)
}

#[derive(Debug, Serialize)]
struct SensorStats {
    mean: f64,
    sd: f64,
    min: f64,
    max: f64,
    count: usize,
    // 1σ bounds
    lower1: f64,
    upper1: f64,
    // 3σ bounds
    lower3: f64,
    upper3: f64,
}

/// Compute mean / standard deviation (population) plus 1σ & 3σ bounds
/// across all non-null values of a given sensor in the currently loaded dataset.
#[tauri::command]
fn compute_sensor_stats(
    sensor: String,
    state: State<AppState>,
) -> Result<SensorStats, String> {
    use rayon::prelude::*;

    let state_lock = state.0.lock().map_err(|e| e.to_string())?;
    let session = state_lock.as_ref().ok_or("No data loaded")?;
    let data = &session.data;

    let idx = data
        .headers
        .iter()
        .position(|h| h == &sensor)
        .ok_or_else(|| format!("Sensor not found: {}", sensor))?;

    // Parallel collect of all non-null, finite values for the target column.
    let values: Vec<f64> = data
        .rows
        .par_iter()
        .filter_map(|row| {
            row.values
                .get(idx)
                .and_then(|v| *v)
                .filter(|v| v.is_finite())
        })
        .collect();

    let count = values.len();
    if count == 0 {
        return Err(format!("No valid numeric values for sensor '{}'", sensor));
    }

    // Sum + min/max in parallel.
    let (sum, min, max) = values
        .par_iter()
        .copied()
        .fold(
            || (0.0_f64, f64::INFINITY, f64::NEG_INFINITY),
            |(s, mn, mx), v| (s + v, mn.min(v), mx.max(v)),
        )
        .reduce(
            || (0.0_f64, f64::INFINITY, f64::NEG_INFINITY),
            |(s1, mn1, mx1), (s2, mn2, mx2)| (s1 + s2, mn1.min(mn2), mx1.max(mx2)),
        );

    let mean = sum / count as f64;

    // Population variance (divide by N) — consistent with ±3σ outlier detection.
    let variance = values
        .par_iter()
        .map(|v| {
            let d = *v - mean;
            d * d
        })
        .sum::<f64>()
        / count as f64;
    let sd = variance.sqrt();

    Ok(SensorStats {
        mean,
        sd,
        min,
        max,
        count,
        lower1: mean - sd,
        upper1: mean + sd,
        lower3: mean - 3.0 * sd,
        upper3: mean + 3.0 * sd,
    })
}

use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

#[tauri::command]
async fn run_python_analysis(app: tauri::AppHandle) -> Result<String, String> {
    let data = ProcessedData {
        headers: vec![
            "Timestamp".to_string(),
            "SensorA".to_string(),
            "SensorB".to_string(),
        ],
        rows: vec![
            csv_processor::CsvRecord {
                timestamp: Some("2021-01-01T00:00:00Z".to_string()),
                values: vec![None, Some(10.0), Some(20.0)],
            },
            csv_processor::CsvRecord {
                timestamp: Some("2021-01-01T01:00:00Z".to_string()),
                values: vec![None, Some(15.0), Some(25.0)],
            },
            csv_processor::CsvRecord {
                timestamp: Some("2021-01-01T02:00:00Z".to_string()),
                values: vec![None, Some(12.0), Some(22.0)],
            },
        ],
    };

    let json_data = serde_json::to_string(&data).map_err(|e| e.to_string())?;

    println!("Rust: Spawning sidecar...");
    let sidecar_command = app.shell().sidecar("backend").map_err(|e| e.to_string())?;
    let (mut rx, mut child) = sidecar_command.spawn().map_err(|e| e.to_string())?;

    println!("Rust: Writing data to stdin...");
    let mut data_with_newline = json_data.clone();
    data_with_newline.push('\n');
    child
        .write(data_with_newline.as_bytes())
        .map_err(|e| e.to_string())?;
    println!("Rust: Data written.");

    let mut output = String::new();
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                let line_str = String::from_utf8(line).map_err(|e| e.to_string())?;
                output.push_str(&line_str);
            }
            CommandEvent::Stderr(line) => {
                let line_str = String::from_utf8(line).map_err(|e| e.to_string())?;
                println!("Python Error: {}", line_str);
            }
            CommandEvent::Terminated(_) => {
                break;
            }
            _ => {}
        }
    }

    Ok(output)
}

/// Preview the Relationship (LinearGAM) model on the currently loaded
/// dataset by delegating to the Python sidecar.
///
/// The Rust side projects only the predictor + target columns, drops rows
/// with any null/non-finite value, and ships the resulting matrix to the
/// sidecar (much smaller than the full dataset).  The sidecar runs the
/// `Wizard.PreviewModel.relationship` routine and streams back JSON, which
/// we forward to the frontend untouched as `serde_json::Value`.
#[tauri::command]
async fn preview_relationship_model(
    predictors: Vec<String>,
    target: String,
    lambda: f64,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    if predictors.is_empty() {
        return Err("At least one predictor is required.".into());
    }
    if target.is_empty() {
        return Err("Target sensor is required.".into());
    }

    // ── Build the projected, NaN-dropped (X, y) off the locked AppState. ──
    // Phase 1 contract: the sidecar receives pre-cleaned arrays. Rust owns
    // column projection and NaN/non-finite filtering.  `X` is n_rows × n_predictors,
    // `y` is n_rows.  We collect into owned data and drop the lock before any await.
    let (x_matrix, y_vector) = {
        let state_lock = state.0.lock().map_err(|e| e.to_string())?;
        let session = state_lock.as_ref().ok_or("No data loaded")?;
        let data = &session.data;

        // Resolve predictor indices first, then the target.
        let mut predictor_indices: Vec<usize> = Vec::with_capacity(predictors.len());
        for p in &predictors {
            let idx = data
                .headers
                .iter()
                .position(|h| h == p)
                .ok_or_else(|| format!("Predictor not found: {}", p))?;
            predictor_indices.push(idx);
        }
        let target_idx = data
            .headers
            .iter()
            .position(|h| h == &target)
            .ok_or_else(|| format!("Target not found: {}", target))?;

        // Drop rows with any null/non-finite across the (predictors + target) set.
        let mut x_matrix: Vec<Vec<f64>> = Vec::with_capacity(data.rows.len());
        let mut y_vector: Vec<f64> = Vec::with_capacity(data.rows.len());
        for row in &data.rows {
            let mut x_row: Vec<f64> = Vec::with_capacity(predictor_indices.len());
            let mut ok = true;
            for &i in &predictor_indices {
                match row.values.get(i).and_then(|v| *v) {
                    Some(v) if v.is_finite() => x_row.push(v),
                    _ => {
                        ok = false;
                        break;
                    }
                }
            }
            if !ok {
                continue;
            }
            let y_val = match row.values.get(target_idx).and_then(|v| *v) {
                Some(v) if v.is_finite() => v,
                _ => continue,
            };
            x_matrix.push(x_row);
            y_vector.push(y_val);
        }

        if x_matrix.is_empty() {
            return Err("No rows remain after dropping nulls.".into());
        }

        (x_matrix, y_vector)
    };

    let payload = serde_json::json!({
        "action": "preview_relationship",
        "payload": {
            "predictors": predictors,
            "target": target,
            "X": x_matrix,
            "y": y_vector,
            "linearGAM_lambda": lambda,
        }
    });

    let mut payload_line = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    payload_line.push('\n');

    // ── Spawn sidecar and pipe payload over stdin. ──
    let sidecar = app.shell().sidecar("backend").map_err(|e| e.to_string())?;
    let (mut rx, mut child) = sidecar.spawn().map_err(|e| e.to_string())?;
    child
        .write(payload_line.as_bytes())
        .map_err(|e| e.to_string())?;

    let mut stdout_buf = String::new();
    let mut stderr_buf = String::new();
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                stdout_buf.push_str(&String::from_utf8_lossy(&line));
            }
            CommandEvent::Stderr(line) => {
                stderr_buf.push_str(&String::from_utf8_lossy(&line));
            }
            CommandEvent::Terminated(_) => break,
            _ => {}
        }
    }

    if stdout_buf.trim().is_empty() {
        return Err(format!(
            "Sidecar returned no output. Stderr: {}",
            stderr_buf.trim()
        ));
    }

    serde_json::from_str::<serde_json::Value>(stdout_buf.trim())
        .map_err(|e| format!("Failed to parse sidecar output: {} (raw: {})", e, stdout_buf))
}

#[derive(Debug, Deserialize)]
struct SingleOperation {
    #[serde(rename = "type")]
    op_type: String,
    value: f64,
}

#[derive(Debug, Deserialize)]
struct MultiOperation {
    #[serde(rename = "type")]
    op_type: String,
    #[serde(rename = "baseSensor")]
    base_sensor: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SensorOperationConfig {
    mode: String,
    #[serde(rename = "singleOp")]
    single_op: Option<SingleOperation>,
    #[serde(rename = "multiOp")]
    multi_op: Option<MultiOperation>,
    #[serde(rename = "customName")]
    custom_name: Option<String>,
}

#[tauri::command]
fn calculate_new_sensor(
    sensors: Vec<String>,
    config: SensorOperationConfig,
    state: State<AppState>,
) -> Result<String, String> {
    let mut state_lock = state.0.lock().map_err(|e| e.to_string())?;
    let session = state_lock.as_mut().ok_or("No data loaded")?;
    let data = &mut session.data;

    if sensors.is_empty() {
        return Err("No sensors selected".to_string());
    }

    let mut indices = Vec::new();
    for sensor in &sensors {
        match data.headers.iter().position(|h| h == sensor) {
            Some(idx) => indices.push(idx),
            None => return Err(format!("Sensor not found: {}", sensor)),
        }
    }

    let mut new_sensor_name;

    if config.mode == "single" {
        if sensors.len() != 1 {
            return Err("Single mode requires exactly one sensor".to_string());
        }
        let op = config.single_op.ok_or("Missing singleOp config")?;
        let op_symbol = operation_registry::single_op_symbol(&op.op_type)?;
        new_sensor_name = format!("{} {} {}", sensors[0], op_symbol, op.value);

        for row in &mut data.rows {
            let val = row.values[indices[0]];
            let new_val = match val {
                Some(v) => operation_registry::execute_single_op(&op.op_type, v, op.value)
                    .map_err(|e| e.to_string())?,
                None => None,
            };
            row.values.push(new_val);
        }
    } else if config.mode == "multi" {
        let op = config.multi_op.ok_or("Missing multiOp config")?;
        let op_name = operation_registry::multi_op_name(&op.op_type)?;

        if operation_registry::is_base_op(&op.op_type) {
            let base = op
                .base_sensor
                .as_ref()
                .ok_or("Missing base sensor for subtract/divide")?;
            new_sensor_name = format!("{}({}, others)", op_name, base);
        } else {
            new_sensor_name = format!("{}({:?})", op_name, sensors);
        }

        for row in &mut data.rows {
            if operation_registry::is_base_op(&op.op_type) {
                let base_sensor = op.base_sensor.as_ref().ok_or("Missing base sensor")?;
                let mut base_val = None;
                let mut others_sum = 0.0;

                for (i, sensor_name) in sensors.iter().enumerate() {
                    let val_opt = row.values[indices[i]];
                    if let Some(v) = val_opt {
                        if sensor_name == base_sensor {
                            base_val = Some(v);
                        } else {
                            others_sum += v;
                        }
                    }
                }

                let new_val = match base_val {
                    Some(b) => operation_registry::execute_base_op(&op.op_type, b, others_sum)?,
                    None => None,
                };
                row.values.push(new_val);
            } else {
                let mut valid_values = Vec::new();
                for &idx in &indices {
                    if let Some(v) = row.values[idx] {
                        valid_values.push(v);
                    }
                }

                let new_val = if valid_values.is_empty() {
                    None
                } else {
                    operation_registry::execute_multi_op(&op.op_type, &valid_values)?
                };
                row.values.push(new_val);
            }
        }
    } else {
        return Err("Invalid mode".to_string());
    }

    if let Some(name) = config.custom_name {
        if !name.trim().is_empty() {
            new_sensor_name = name;
        }
    }

    data.headers.push(new_sensor_name.clone());

    Ok(new_sensor_name)
}

// ---------------------------------------------------------------------------
// Formula engine helpers
// ---------------------------------------------------------------------------

/// Extract sensor references from a formula string.
/// Supports two patterns:
///   - `$SensorName` (alphanumeric, underscores, dots)
///   - `${Sensor Name With Spaces}` (anything inside braces)
/// Returns a Vec of (full_match_token, sensor_name) pairs.
fn extract_sensor_refs(formula: &str) -> Vec<(String, String)> {
    let mut refs = Vec::new();
    let chars: Vec<char> = formula.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        if chars[i] == '$' {
            if i + 1 < len && chars[i + 1] == '{' {
                // ${Sensor Name} pattern
                let start = i;
                let name_start = i + 2;
                let mut j = name_start;
                while j < len && chars[j] != '}' {
                    j += 1;
                }
                if j < len {
                    let name: String = chars[name_start..j].iter().collect();
                    let token: String = chars[start..=j].iter().collect();
                    if !name.is_empty() {
                        refs.push((token, name));
                    }
                    i = j + 1;
                } else {
                    i += 1;
                }
            } else if i + 1 < len
                && (chars[i + 1].is_alphanumeric() || chars[i + 1] == '_')
            {
                // $SensorName pattern (alphanumeric, underscores, dots)
                let start = i;
                let name_start = i + 1;
                let mut j = name_start;
                while j < len
                    && (chars[j].is_alphanumeric() || chars[j] == '_' || chars[j] == '.')
                {
                    j += 1;
                }
                let name: String = chars[name_start..j].iter().collect();
                let token: String = chars[start..j].iter().collect();
                if !name.is_empty() {
                    refs.push((token, name));
                }
                i = j;
            } else {
                i += 1;
            }
        } else {
            i += 1;
        }
    }

    refs
}

/// Replace `^` with `.pow(...)` for fasteval compatibility and convert
/// sensor references to fasteval-safe variable names.
/// Returns (transformed_expression, map_of_safe_name -> original_sensor_name).
fn prepare_formula_for_eval(
    formula: &str,
    sensor_refs: &[(String, String)],
) -> (String, Vec<(String, String)>) {
    let mut expr = formula.to_string();
    let mut safe_names: Vec<(String, String)> = Vec::new();

    // Replace sensor references with safe variable names (fasteval needs
    // simple alphanumeric identifiers).
    for (i, (token, sensor_name)) in sensor_refs.iter().enumerate() {
        let safe_name = format!("__sensor_{}", i);
        expr = expr.replace(token, &safe_name);
        safe_names.push((safe_name, sensor_name.clone()));
    }

    (expr, safe_names)
}

#[derive(Debug, Serialize)]
struct FormulaValidationResult {
    valid: bool,
    error: Option<String>,
    referenced_sensors: Vec<String>,
}

#[tauri::command]
fn validate_formula(
    formula: String,
    state: State<AppState>,
) -> Result<FormulaValidationResult, String> {
    let state_lock = state.0.lock().map_err(|e| e.to_string())?;
    let session = state_lock.as_ref().ok_or("No data loaded")?;
    let data = &session.data;

    // 1. Extract sensor references
    let sensor_refs = extract_sensor_refs(&formula);
    let referenced_sensors: Vec<String> = sensor_refs
        .iter()
        .map(|(_, name)| name.clone())
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();

    // 2. Check all referenced sensors exist in loaded data
    for sensor_name in &referenced_sensors {
        if !data.headers.contains(sensor_name) {
            return Ok(FormulaValidationResult {
                valid: false,
                error: Some(format!("Sensor not found: {}", sensor_name)),
                referenced_sensors,
            });
        }
    }

    // 3. Try to parse the expression (with dummy values)
    let (expr, safe_names) = prepare_formula_for_eval(&formula, &sensor_refs);

    let parser = fasteval::Parser::new();
    let mut slab = fasteval::Slab::new();

    match parser.parse(&expr, &mut slab.ps) {
        Ok(expr_i) => {
            // Try to evaluate with dummy values to catch runtime issues
            let mut ns = |name: &str, _args: Vec<f64>| -> Option<f64> {
                for (safe_name, _) in &safe_names {
                    if name == safe_name {
                        return Some(1.0); // dummy value
                    }
                }
                None
            };

            let expr_ref = slab.ps.get_expr(expr_i);
            match expr_ref.eval(&slab, &mut ns) {
                Ok(_) => Ok(FormulaValidationResult {
                    valid: true,
                    error: None,
                    referenced_sensors,
                }),
                Err(e) => Ok(FormulaValidationResult {
                    valid: false,
                    error: Some(format!("Evaluation error: {}", e)),
                    referenced_sensors,
                }),
            }
        }
        Err(e) => Ok(FormulaValidationResult {
            valid: false,
            error: Some(format!("Parse error: {}", e)),
            referenced_sensors,
        }),
    }
}

#[tauri::command]
fn evaluate_formula(
    formula: String,
    custom_name: Option<String>,
    state: State<AppState>,
) -> Result<String, String> {
    let mut state_lock = state.0.lock().map_err(|e| e.to_string())?;
    let session = state_lock.as_mut().ok_or("No data loaded")?;
    let data = &mut session.data;

    // 1. Extract sensor references from formula
    let sensor_refs = extract_sensor_refs(&formula);
    if sensor_refs.is_empty() {
        return Err("Formula contains no sensor references. Use $SensorName or ${Sensor Name} syntax.".to_string());
    }

    // 2. Resolve sensor names to column indices
    let mut sensor_indices: Vec<(String, String, usize)> = Vec::new(); // (token, sensor_name, col_index)
    let unique_sensors: std::collections::HashSet<String> =
        sensor_refs.iter().map(|(_, name)| name.clone()).collect();

    for sensor_name in &unique_sensors {
        match data.headers.iter().position(|h| h == sensor_name) {
            Some(idx) => {
                // Find all tokens for this sensor
                for (token, name) in &sensor_refs {
                    if name == sensor_name {
                        sensor_indices.push((token.clone(), name.clone(), idx));
                    }
                }
            }
            None => return Err(format!("Sensor not found: {}", sensor_name)),
        }
    }

    // 3. Prepare the expression for fasteval
    let (expr, safe_names) = prepare_formula_for_eval(&formula, &sensor_refs);

    // Build a map from safe_name -> column index
    let mut safe_name_to_idx: Vec<(String, usize)> = Vec::new();
    for (safe_name, original_name) in &safe_names {
        let idx = data
            .headers
            .iter()
            .position(|h| h == original_name)
            .ok_or(format!("Sensor not found: {}", original_name))?;
        safe_name_to_idx.push((safe_name.clone(), idx));
    }

    // 4. Pre-compile the expression once
    let parser = fasteval::Parser::new();
    let mut slab = fasteval::Slab::new();
    let expr_i = parser
        .parse(&expr, &mut slab.ps)
        .map_err(|e| format!("Formula parse error: {}", e))?;

    // 5. Evaluate for each row
    let mut new_values: Vec<Option<f64>> = Vec::with_capacity(data.rows.len());

    for row in &data.rows {
        // Check if any referenced sensor is None for this row
        let mut has_none = false;
        for (_, idx) in &safe_name_to_idx {
            if *idx >= row.values.len() || row.values[*idx].is_none() {
                has_none = true;
                break;
            }
        }

        if has_none {
            new_values.push(None);
            continue;
        }

        // Build the namespace with actual sensor values for this row
        let row_values: BTreeMap<String, f64> = safe_name_to_idx
            .iter()
            .filter_map(|(safe_name, idx)| {
                row.values.get(*idx).and_then(|v| v.map(|val| (safe_name.clone(), val)))
            })
            .collect();

        let mut ns = |name: &str, _args: Vec<f64>| -> Option<f64> {
            row_values.get(name).copied()
        };

        let expr_ref = slab.ps.get_expr(expr_i);
        match expr_ref.eval(&slab, &mut ns) {
            Ok(result) => {
                if result.is_finite() {
                    new_values.push(Some(result));
                } else {
                    new_values.push(None); // NaN or Infinity -> None
                }
            }
            Err(_) => {
                new_values.push(None);
            }
        }
    }

    // 6. Determine the new sensor name
    let new_sensor_name = match custom_name {
        Some(ref name) if !name.trim().is_empty() => name.clone(),
        _ => format!("f({})", formula),
    };

    // 7. Append new column to each row
    for (i, row) in data.rows.iter_mut().enumerate() {
        row.values.push(new_values[i]);
    }

    data.headers.push(new_sensor_name.clone());

    Ok(new_sensor_name)
}

#[tauri::command]
fn load_mapping_csv(path: String) -> Result<MappingData, String> {
    csv_processor::load_mapping_csv_data(&path)
}

#[tauri::command]
fn apply_sensor_mapping(
    key_column: String,
    mapping_data: MappingData,
    dataset_headers: Vec<String>,
) -> Result<MappingResult, String> {
    csv_processor::apply_mapping(&key_column, &mapping_data, &dataset_headers)
}

#[derive(Debug, Deserialize)]
struct ValueFilter {
    sensor: String,
    operation: String, // "greater_than" | "less_than" | "between" | "equals"
    value1: Option<f64>,
    value2: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct DataFilter {
    sensors: Vec<String>,
    timestamp_start: Option<String>,
    timestamp_end: Option<String>,
    value_filters: Vec<ValueFilter>,
}

#[tauri::command]
fn get_filtered_data(
    filter: DataFilter,
    window: tauri::Window,
    state: State<AppState>,
) -> Result<(), String> {
    let state_lock = state.0.lock().map_err(|e| e.to_string())?;
    let session = state_lock.as_ref().ok_or("No data loaded")?;
    let data = &session.data;

    // Resolve sensor indices
    let sensor_indices: Vec<usize> = filter
        .sensors
        .iter()
        .filter_map(|s| data.headers.iter().position(|h| h == s))
        .collect();

    // Parse timestamp bounds once
    let ts_start = filter
        .timestamp_start
        .as_deref()
        .and_then(|s| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M").ok());
    let ts_end = filter
        .timestamp_end
        .as_deref()
        .and_then(|s| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M").ok());

    // Pre-resolve value filter indices
    struct ResolvedFilter {
        sensor_idx: usize,
        operation: String,
        value1: Option<f64>,
        value2: Option<f64>,
    }
    let resolved_filters: Vec<ResolvedFilter> = filter
        .value_filters
        .iter()
        .filter_map(|vf| {
            data.headers
                .iter()
                .position(|h| h == &vf.sensor)
                .map(|idx| ResolvedFilter {
                    sensor_idx: idx,
                    operation: vf.operation.clone(),
                    value1: vf.value1,
                    value2: vf.value2,
                })
        })
        .collect();

    const CHUNK_SIZE: usize = 5000;
    let mut chunk_buf: Vec<csv_processor::CsvRecord> = Vec::with_capacity(CHUNK_SIZE);

    for row in &data.rows {
        // Timestamp filter
        if ts_start.is_some() || ts_end.is_some() {
            if let Some(ref ts_str) = row.timestamp {
                // Try multiple common formats (NaiveDateTime first, then timezone-aware)
                let parsed = chrono::NaiveDateTime::parse_from_str(ts_str, "%Y-%m-%dT%H:%M:%S%.f")
                    .or_else(|_| chrono::NaiveDateTime::parse_from_str(ts_str, "%Y-%m-%dT%H:%M:%S"))
                    .or_else(|_| chrono::NaiveDateTime::parse_from_str(ts_str, "%Y-%m-%dT%H:%M"))
                    .or_else(|_| chrono::NaiveDateTime::parse_from_str(ts_str, "%Y-%m-%d %H:%M:%S%.f"))
                    .or_else(|_| chrono::NaiveDateTime::parse_from_str(ts_str, "%Y-%m-%d %H:%M:%S"))
                    .or_else(|_| chrono::NaiveDateTime::parse_from_str(ts_str, "%Y-%m-%d %H:%M"))
                    // Timezone-aware formats (e.g. "2019-10-22 09:00:00+07:00")
                    .or_else(|_| chrono::DateTime::parse_from_str(ts_str, "%Y-%m-%d %H:%M:%S%:z").map(|dt| dt.naive_local()))
                    .or_else(|_| chrono::DateTime::parse_from_str(ts_str, "%Y-%m-%dT%H:%M:%S%:z").map(|dt| dt.naive_local()))
                    .or_else(|_| chrono::DateTime::parse_from_str(ts_str, "%Y-%m-%d %H:%M:%S%.f%:z").map(|dt| dt.naive_local()))
                    .or_else(|_| chrono::DateTime::parse_from_str(ts_str, "%Y-%m-%dT%H:%M:%S%.f%:z").map(|dt| dt.naive_local()));

                if let Ok(ts) = parsed {
                    if let Some(ref start) = ts_start {
                        if ts < *start {
                            continue;
                        }
                    }
                    if let Some(ref end) = ts_end {
                        if ts > *end {
                            continue;
                        }
                    }
                } else {
                    continue; // skip rows with unparseable timestamps
                }
            } else {
                continue; // skip rows without timestamp
            }
        }

        // Value filters — all must pass (AND logic)
        let mut pass = true;
        for rf in &resolved_filters {
            let val = if rf.sensor_idx < row.values.len() {
                row.values[rf.sensor_idx]
            } else {
                None
            };

            let ok = match val {
                None => false,
                Some(v) => match rf.operation.as_str() {
                    "greater_than" => rf.value1.map_or(true, |v1| v > v1),
                    "less_than" => rf.value1.map_or(true, |v1| v < v1),
                    "equals" => rf.value1.map_or(true, |v1| (v - v1).abs() < f64::EPSILON),
                    "between" => match (rf.value1, rf.value2) {
                        (Some(v1), Some(v2)) => v >= v1 && v <= v2,
                        _ => true,
                    },
                    _ => true,
                },
            };
            if !ok {
                pass = false;
                break;
            }
        }
        if !pass {
            continue;
        }

        // Build projected row (only requested sensor columns)
        let new_values: Vec<Option<f64>> = sensor_indices
            .iter()
            .map(|&idx| {
                if idx < row.values.len() {
                    row.values[idx]
                } else {
                    None
                }
            })
            .collect();

        chunk_buf.push(csv_processor::CsvRecord {
            timestamp: row.timestamp.clone(),
            values: new_values,
        });

        if chunk_buf.len() >= CHUNK_SIZE {
            window
                .emit(
                    "data-stream-chunk",
                    ProcessedData {
                        headers: filter.sensors.clone(),
                        rows: std::mem::replace(
                            &mut chunk_buf,
                            Vec::with_capacity(CHUNK_SIZE),
                        ),
                    },
                )
                .map_err(|e| e.to_string())?;
        }
    }

    // Flush remaining
    if !chunk_buf.is_empty() {
        window
            .emit(
                "data-stream-chunk",
                ProcessedData {
                    headers: filter.sensors.clone(),
                    rows: chunk_buf,
                },
            )
            .map_err(|e| e.to_string())?;
    }

    window
        .emit("data-stream-end", {})
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|_app| {
            // On non-macOS platforms, disable native decorations so we use the custom titlebar.
            // macOS uses native decorations with Overlay titlebar style (traffic lights).
            #[cfg(not(target_os = "macos"))]
            {
                use tauri::Manager;
                if let Some(window) = _app.get_webview_window("main") {
                    window.set_decorations(false).ok();
                }
            }
            Ok(())
        })
        .manage(AppState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            load_csv,
            get_data,
            get_all_sensors,
            load_metadata_command,
            compute_sensor_stats,
            run_python_analysis,
            preview_relationship_model,
            get_loaded_paths,
            calculate_new_sensor,
            load_mapping_csv,
            apply_sensor_mapping,
            get_filtered_data,
            evaluate_formula,
            validate_formula
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
