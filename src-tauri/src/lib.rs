pub mod csv_processor;
use csv_processor::{
    load_metadata, CsvLoadReport, MappingData, MappingResult, ProcessedData,
    SensorMetadata,
};
use serde::Deserialize;
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
        let op_symbol = match op.op_type.as_str() {
            "add" => "+",
            "subtract" => "-",
            "multiply" => "*",
            "divide" => "/",
            "power" => "^",
            _ => return Err("Invalid single operation type".to_string()),
        };
        new_sensor_name = format!("{} {} {}", sensors[0], op_symbol, op.value);

        for row in &mut data.rows {
            let val = row.values[indices[0]];
            let new_val = match val {
                Some(v) => match op.op_type.as_str() {
                    "add" => Some(v + op.value),
                    "subtract" => Some(v - op.value),
                    "multiply" => Some(v * op.value),
                    "divide" => {
                        if op.value != 0.0 {
                            Some(v / op.value)
                        } else {
                            None
                        }
                    }
                    "power" => Some(v.powf(op.value)),
                    _ => None,
                },
                None => None,
            };
            row.values.push(new_val);
        }
    } else if config.mode == "multi" {
        let op = config.multi_op.ok_or("Missing multiOp config")?;

        let op_name = match op.op_type.as_str() {
            "sum" => "Sum",
            "mean" => "Avg",
            "median" => "Median",
            "product" => "Product",
            "subtract" => "Diff",
            "divide" => "Ratio",
            _ => return Err("Invalid multi operation type".to_string()),
        };

        if op.op_type == "subtract" || op.op_type == "divide" {
            let base = op
                .base_sensor
                .as_ref()
                .ok_or("Missing base sensor for subtract/divide")?;
            new_sensor_name = format!("{}({}, others)", op_name, base);
        } else {
            new_sensor_name = format!("{}({:?})", op_name, sensors);
        }

        for row in &mut data.rows {
            let mut valid_values = Vec::new();
            let mut base_val = None;

            if op.op_type == "subtract" || op.op_type == "divide" {
                let base_sensor = op.base_sensor.as_ref().ok_or("Missing base sensor")?;
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
                    Some(b) => {
                        if op.op_type == "subtract" {
                            Some(b - others_sum)
                        } else if others_sum != 0.0 {
                            Some(b / others_sum)
                        } else {
                            None
                        }
                    }
                    None => None,
                };
                row.values.push(new_val);
            } else {
                for &idx in &indices {
                    if let Some(v) = row.values[idx] {
                        valid_values.push(v);
                    }
                }

                let new_val = if valid_values.is_empty() {
                    None
                } else {
                    match op.op_type.as_str() {
                        "sum" => Some(valid_values.iter().sum()),
                        "mean" => {
                            Some(valid_values.iter().sum::<f64>() / valid_values.len() as f64)
                        }
                        "product" => Some(valid_values.iter().product()),
                        "median" => {
                            valid_values.sort_by(|a, b| a.partial_cmp(b).unwrap());
                            let mid = valid_values.len() / 2;
                            if valid_values.len() % 2 == 0 {
                                Some((valid_values[mid - 1] + valid_values[mid]) / 2.0)
                            } else {
                                Some(valid_values[mid])
                            }
                        }
                        _ => None,
                    }
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
        .manage(AppState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            load_csv,
            get_data,
            get_all_sensors,
            load_metadata_command,
            run_python_analysis,
            get_loaded_paths,
            calculate_new_sensor,
            load_mapping_csv,
            apply_sensor_mapping,
            get_filtered_data
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
