mod csv_processor;
use csv_processor::{load_metadata, CsvMetadata, ProcessedData, SensorMetadata};
use serde::Deserialize;
use std::sync::Mutex;
use tauri::{Emitter, State};

struct SessionData {
    data: ProcessedData,
    paths: Vec<String>,
}

struct AppState(Mutex<Option<SessionData>>);

#[tauri::command]
fn load_csv(paths: Vec<String>, state: State<AppState>) -> Result<CsvMetadata, String> {
    let data = csv_processor::read_merge_csvs(paths.clone())?;
    let metadata = CsvMetadata {
        headers: data.headers.clone(),
        total_rows: data.rows.len(),
    };

    let mut state_lock = state.0.lock().map_err(|e| e.to_string())?;
    *state_lock = Some(SessionData { data, paths });

    Ok(metadata)
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

    // Using chunks to stream data
    // Chunk size 5000 seems reasonable for UI responsiveness vs IPC overhead
    const CHUNK_SIZE: usize = 5000;

    // Notify start (optional, but good for UI loading state if needed)
    // window.emit("data-stream-start", data.rows.len()).map_err(|e| e.to_string())?;

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

        // Emit chunk
        window
            .emit(
                "data-stream-chunk",
                ProcessedData {
                    headers: sensors.clone(),
                    rows: chunk_data,
                },
            )
            .map_err(|e| e.to_string())?;

        // Optional: Yield to event loop if needed, but in a command it might not help much unless async.
        // But since this is regular command, it runs on a thread pool (tauri default).
    }

    // Emit end
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
    // Use mock data for testing
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

    // Serialize data to JSON string
    let json_data = serde_json::to_string(&data).map_err(|e| e.to_string())?;

    // Write to stdin
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

    // Read stdout
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
    op_type: String, // 'add', 'subtract', 'multiply', 'divide', 'power'
    value: f64,
}

#[derive(Debug, Deserialize)]
struct MultiOperation {
    #[serde(rename = "type")]
    op_type: String, // 'sum', 'mean', 'median', 'product', 'subtract', 'divide'
    #[serde(rename = "baseSensor")]
    base_sensor: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SensorOperationConfig {
    mode: String, // 'single', 'multi'
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

    // Validation
    if sensors.is_empty() {
        return Err("No sensors selected".to_string());
    }

    // Identify indices
    let mut indices = Vec::new();
    for sensor in &sensors {
        match data.headers.iter().position(|h| h == sensor) {
            Some(idx) => indices.push(idx),
            None => return Err(format!("Sensor not found: {}", sensor)),
        }
    }

    // Determine new sensor name and logic
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

        // Calculation Loop
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
                    } // Handle div by zero?
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

        // Calculation Loop
        for row in &mut data.rows {
            let mut valid_values = Vec::new();
            let mut base_val = None;

            // For subtract/divide, separate base from others
            if op.op_type == "subtract" || op.op_type == "divide" {
                let base_sensor = op.base_sensor.as_ref().ok_or("Missing base sensor")?;
                // Find base index logic (re-find or use pre-calc indices?)
                // We relied on `sensors` list. The frontend should pass `baseSensor` IN `sensors` list?
                // Usually yes.
                // Let's iterate `sensors` and map usage.

                // Re-map values based on whether they are base or others
                let mut others_sum = 0.0;
                let mut count = 0;

                for (i, sensor_name) in sensors.iter().enumerate() {
                    let val_opt = row.values[indices[i]];
                    if let Some(v) = val_opt {
                        if sensor_name == base_sensor {
                            base_val = Some(v);
                        } else {
                            others_sum += v;
                            count += 1;
                        }
                    }
                }

                let new_val = match base_val {
                    Some(b) => {
                        if op.op_type == "subtract" {
                            Some(b - others_sum)
                        } else {
                            if others_sum != 0.0 {
                                Some(b / others_sum)
                            } else {
                                None
                            }
                        }
                    }
                    None => None,
                };
                row.values.push(new_val);
            } else {
                // Aggregation
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

    // Override with custom name if provided
    if let Some(name) = config.custom_name {
        if !name.trim().is_empty() {
            new_sensor_name = name;
        }
    }

    // Update Headers
    data.headers.push(new_sensor_name.clone());

    Ok(new_sensor_name)
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
            calculate_new_sensor
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
