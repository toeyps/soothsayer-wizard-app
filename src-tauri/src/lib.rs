mod chart_query;
pub mod clustering;
pub mod csv_processor;
mod formula_diagnostics;
pub mod health_score;
mod health_hourly;
mod health_preview;
mod health_validation;
pub mod metrics;
pub mod operation_registry;
mod period_counts;
mod workspace_export;
// QA-owned in-crate tests (private surface); the file lives in tests/internal/.
#[cfg(test)]
#[path = "../tests/internal/qa_health_internal.rs"]
mod qa_health_internal;
// Train/Test validation scenarios (private surface, same arrangement).
#[cfg(test)]
#[path = "../tests/internal/train_test_validation_internal.rs"]
mod train_test_validation_internal;
// Special-sensor formula/operation scenarios (same arrangement).
#[cfg(test)]
#[path = "../tests/internal/qa_special_sensor_internal.rs"]
mod qa_special_sensor_internal;
// Formula editor preview / coded gate / decimals / legacy round conversion
// (same arrangement).
#[cfg(test)]
#[path = "../tests/internal/formula_preview_internal.rs"]
mod formula_preview_internal;
// Timestamp import edge cases through the whole load path (same arrangement).
#[cfg(test)]
#[path = "../tests/internal/qa_timestamp_import_internal.rs"]
mod qa_timestamp_import_internal;
// Export results end to end (same arrangement).
#[cfg(test)]
#[path = "../tests/internal/qa_workspace_export_internal.rs"]
mod qa_workspace_export_internal;
use formula_diagnostics::FormulaIssue;
use csv_processor::{
    load_metadata, parse_timestamp, ts_to_micros, ColumnarData, CsvLoadReport,
    CsvRecord, MappingData, MappingResult, SensorMetadata, TS_MISSING,
};
use fasteval::Evaler;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::RwLock;
use tauri::{Emitter, State};


/// Rejects empty paths, NUL bytes and `..` traversal; existence is left to `File::open`.
fn validate_read_path(p: &str) -> Result<(), String> {
    if p.is_empty() {
        return Err("path is empty".into());
    }
    if p.contains('\0') {
        return Err("path contains NUL byte".into());
    }
    // Split on both `/` and `\` so either slash style is caught.
    for component in p.split(['/', '\\']) {
        if component == ".." {
            return Err("path contains '..' component".into());
        }
    }
    Ok(())
}

/// Directory must be non-empty, absolute, free of `..`, and already exist.
fn validate_save_dir(p: &str) -> Result<(), String> {
    if p.is_empty() {
        return Err("save_path is empty".into());
    }
    if p.contains('\0') {
        return Err("save_path contains NUL byte".into());
    }
    let path = std::path::Path::new(p);
    if !path.is_absolute() {
        return Err(format!("save_path must be absolute: {}", p));
    }
    for component in p.split(['/', '\\']) {
        if component == ".." {
            return Err("save_path contains '..' component".into());
        }
    }
    if !path.exists() {
        return Err(format!("save_path does not exist: {}", p));
    }
    if !path.is_dir() {
        return Err(format!("save_path is not a directory: {}", p));
    }
    Ok(())
}

#[cfg(test)]
mod path_validation_tests {
    use super::*;



    #[test]
    fn validate_read_path_accepts_a_normal_path() {
        assert!(validate_read_path("C:/data/sensors.csv").is_ok());
        assert!(validate_read_path("relative/path.csv").is_ok());
    }

    #[test]
    fn validate_read_path_rejects_empty() {
        assert!(validate_read_path("").is_err());
    }

    #[test]
    fn validate_read_path_rejects_nul_byte() {
        assert!(validate_read_path("a\0b.csv").is_err());
    }

    #[test]
    fn validate_read_path_rejects_traversal_on_either_slash_style() {
        assert!(validate_read_path("../secret.csv").is_err());
        assert!(validate_read_path("a/../b.csv").is_err());
        assert!(validate_read_path("a\\..\\b.csv").is_err());
    }

    #[test]
    fn validate_read_path_allows_single_dot_component() {
        // Only ".." is rejected -- "." (current dir) is a legitimate,
        // non-traversing component.
        assert!(validate_read_path("./data.csv").is_ok());
    }



    #[test]
    fn validate_save_dir_rejects_empty_and_nul() {
        assert!(validate_save_dir("").is_err());
        assert!(validate_save_dir("C:/a\0b").is_err());
    }

    #[test]
    fn validate_save_dir_rejects_relative_paths() {
        assert!(validate_save_dir("relative/dir").is_err());
    }

    #[test]
    fn validate_save_dir_rejects_traversal_components() {
        let dir = std::env::temp_dir();
        let with_traversal = format!("{}/../{}", dir.display(), "x");
        assert!(validate_save_dir(&with_traversal).is_err());
    }

    #[test]
    fn validate_save_dir_rejects_nonexistent_path() {
        let dir = std::env::temp_dir().join(format!(
            "wizard-does-not-exist-{}",
            std::process::id()
        ));
        assert!(validate_save_dir(dir.to_str().unwrap()).is_err());
    }

    #[test]
    fn validate_save_dir_rejects_a_file_path() {
        let dir = std::env::temp_dir().join(format!("wizard-savedir-file-{}", std::process::id()));
        std::fs::write(&dir, b"x").unwrap();
        assert!(validate_save_dir(dir.to_str().unwrap()).is_err());
        let _ = std::fs::remove_file(&dir);
    }

    #[test]
    fn validate_save_dir_accepts_an_existing_absolute_directory() {
        let dir = std::env::temp_dir().join(format!("wizard-savedir-ok-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(validate_save_dir(dir.to_str().unwrap()).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

struct SessionData {
    data: ColumnarData,
    /// Names (via `name_key`) of columns computed this session; only these may be replaced or removed. Reset by `load_csv`.
    derived: std::collections::HashSet<String>,
    /// Bumped by `load_csv`; a result computed under a read lock is discarded if the generation changed before the write.
    generation: u64,
    /// Full Relationship fits by `cache_key`, so set-point edits skip the sidecar; dropped with the session; stale fits refused via `SessionStamp`.
    rel_cache: health_score::RelCache,
}

static SESSION_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

struct AppState(RwLock<Option<SessionData>>);

/// Runs on the blocking pool: a sync command would freeze every window on the main thread.
async fn on_blocking_pool<T, F>(app: tauri::AppHandle, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&AppState) -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<AppState>();
        f(state.inner())
    })
    .await
    .map_err(|e| format!("Background task failed: {e}"))?
}

/// One special-sensor change at a time: each command locks the session twice (compute, then store).
static SENSOR_CHANGE_LOCK: tauri::async_runtime::Mutex<()> = tauri::async_runtime::Mutex::const_new(());

/// Name of the global event `load_csv` emits while it runs (payload:
/// [`csv_processor::CsvLoadProgress`]).
const CSV_LOAD_PROGRESS_EVENT: &str = "csv-load-progress";

/// Serialises `load_csv` so an older async load cannot finish after a newer one and replace its dataset.
static LOAD_CSV_LOCK: tauri::async_runtime::Mutex<()> = tauri::async_runtime::Mutex::const_new(());

/// Uses `spawn_blocking` so `csv-load-progress` events are not held back; emits are best-effort and never fail the load.
#[tauri::command(rename_all = "snake_case")]
async fn load_csv(
    paths: Vec<String>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<CsvLoadReport, String> {
    for p in &paths {
        validate_read_path(p).map_err(|e| format!("invalid path '{}': {}", p, e))?;
    }
    let _serial = LOAD_CSV_LOCK.lock().await;
    let file_count = paths.len();
    let read_paths = paths.clone();
    let progress_app = app.clone();
    let (data, mut report) = tauri::async_runtime::spawn_blocking(move || {
        let merge_result = csv_processor::read_merge_csvs_with_progress(read_paths, &|p| {
            let _ = progress_app.emit(CSV_LOAD_PROGRESS_EVENT, p);
        })?;
        let report = csv_processor::build_load_report(&merge_result);
        Ok::<_, String>((merge_result.data, report))
    })
    .await
    .map_err(|e| format!("CSV load task failed: {e}"))??;
    report.generation = install_session(&state, data)?;
    let _ = app.emit(
        CSV_LOAD_PROGRESS_EVENT,
        csv_processor::CsvLoadProgress::after_reading(file_count, true),
    );
    Ok(report)
}

/// Allocates the generation under the write lock, so it is exactly the one stored.
fn install_session(state: &AppState, data: ColumnarData) -> Result<u64, String> {
    let mut state_lock = state.0.write().map_err(|e| e.to_string())?;
    let generation = SESSION_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    *state_lock = Some(SessionData {
        data,
        derived: std::collections::HashSet::new(),
        generation,
        rel_cache: health_score::RelCache::default(),
    });
    Ok(generation)
}

/// Captured when columns are read; a fit is cached only if both are current (an in-place recompute keeps `generation`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SessionStamp {
    generation: u64,
    derived_epoch: u64,
}

impl SessionStamp {
    fn new(generation: u64, derived_epoch: u64) -> Self {
        SessionStamp { generation, derived_epoch }
    }
}

impl SessionData {
    fn stamp(&self) -> SessionStamp {
        SessionStamp::new(self.generation, self.rel_cache.epoch())
    }
}

/// Test helper: caches a fit only if `stamp` is still current, else returns false.
#[cfg(test)]
fn store_rel_fit(state: &AppState, stamp: SessionStamp, key: String, fit: health_score::RelFit) -> bool {
    store_rel_fit_ex(state, stamp, key, fit).is_some()
}

/// Like `store_rel_fit` but returns the stored fit's identity, which the hourly pre-warm must present.
fn store_rel_fit_ex(
    state: &AppState,
    stamp: SessionStamp,
    key: String,
    fit: health_score::RelFit,
) -> Option<std::sync::Weak<health_score::RelFit>> {
    let mut lock = state.0.write().ok()?;
    match lock.as_mut() {
        Some(s) if s.stamp() == stamp => Some(std::sync::Arc::downgrade(&s.rel_cache.insert(key, fit))),
        _ => None,
    }
}

/// Test helper: stamp of the loaded session, `None` if nothing is loaded.
#[cfg(test)]
fn session_stamp(state: &AppState) -> Result<Option<SessionStamp>, String> {
    let lock = state.0.read().map_err(|e| e.to_string())?;
    Ok(lock.as_ref().map(|s| s.stamp()))
}

/// Generation of the currently loaded dataset, `None` when nothing is loaded.
fn session_generation(state: &AppState) -> Result<Option<u64>, String> {
    let lock = state.0.read().map_err(|e| e.to_string())?;
    Ok(lock.as_ref().map(|s| s.generation))
}

/// Diagnostic: generation of the loaded dataset, or null if none.
#[tauri::command]
async fn get_session_generation(app: tauri::AppHandle) -> Result<Option<u64>, String> {
    on_blocking_pool(app, session_generation).await
}

/// Error prefix when a caller bound to an older dataset mutates the session; the frontend matches `STALE_SESSION`.
pub const STALE_SESSION_ERROR: &str =
    "STALE_SESSION: the dataset changed since this window was opened";

/// `Ok` when the caller did not pin a generation, or pinned the current one.
fn check_expected_generation(expected: Option<u64>, actual: u64) -> Result<(), String> {
    match expected {
        Some(g) if g != actual => Err(STALE_SESSION_ERROR.to_string()),
        _ => Ok(()),
    }
}

#[tauri::command]
async fn get_all_sensors(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    on_blocking_pool(app, |state| {
        let state_lock = state.0.read().map_err(|e| e.to_string())?;
        let session = state_lock.as_ref().ok_or("No data loaded")?;
        Ok(session.data.headers.clone())
    })
    .await
}

#[tauri::command]
async fn load_metadata_command(path: String, app: tauri::AppHandle) -> Result<Vec<SensorMetadata>, String> {
    on_blocking_pool(app, move |_| {
        validate_read_path(&path).map_err(|e| format!("invalid path '{}': {}", path, e))?;
        load_metadata(&path)
    })
    .await
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

/// Mean, sample SD (ddof=1, matches pandas `.std()`) and 1σ/3σ bounds over non-null values.
#[tauri::command]
async fn compute_sensor_stats(
    sensor: String,
    // With a filter, stats cover only the filtered slice.
    filter: Option<PreviewFilter>,
    app: tauri::AppHandle,
) -> Result<SensorStats, String> {
    on_blocking_pool(app, move |state| sensor_stats_in(state, &sensor, filter.as_ref())).await
}

fn sensor_stats_in(
    state: &AppState,
    sensor: &str,
    filter: Option<&PreviewFilter>,
) -> Result<SensorStats, String> {
    use rayon::prelude::*;

    let state_lock = state.0.read().map_err(|e| e.to_string())?;
    let session = state_lock.as_ref().ok_or("No data loaded")?;
    let data = &session.data;

    let idx = data
        .headers
        .iter()
        .position(|h| h == sensor)
        .ok_or_else(|| format!("Sensor not found: {}", sensor))?;

    let resolved = ResolvedFilter::resolve(filter, &data.headers)?;

    // `is_finite` drops NaN (missing) and ±inf; restricted to filtered rows when a filter is set.
    let col = &data.columns[idx];
    let values: Vec<f64> = if resolved.is_noop() {
        col.par_iter().copied().filter(|v| v.is_finite()).collect()
    } else {
        (0..data.n_rows())
            .into_par_iter()
            .filter(|&r| resolved.keeps(data, r))
            .map(|r| col[r])
            .filter(|v| v.is_finite())
            .collect()
    };

    let count = values.len();
    if count == 0 {
        return Err(format!("No valid numeric values for sensor '{}'", sensor));
    }

    // Min/max in parallel.
    let (min, max) = values
        .par_iter()
        .copied()
        .fold(
            || (f64::INFINITY, f64::NEG_INFINITY),
            |(mn, mx), v| (mn.min(v), mx.max(v)),
        )
        .reduce(
            || (f64::INFINITY, f64::NEG_INFINITY),
            |(mn1, mx1), (mn2, mx2)| (mn1.min(mn2), mx1.max(mx2)),
        );

    let mean = metrics::mean(&values);
    // N=1 gives a NaN SD; use 0.0 so the ±σ band stays defined.
    let sd_raw = metrics::sample_sd(&values, mean);
    let sd = if sd_raw.is_nan() { 0.0 } else { sd_raw };

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

/// Spawns the sidecar; maps a missing/stub binary (os error 193 / Exec format error) to an actionable error.
fn spawn_sidecar(
    app: &tauri::AppHandle,
) -> Result<
    (
        tauri::async_runtime::Receiver<CommandEvent>,
        tauri_plugin_shell::process::CommandChild,
    ),
    String,
> {
    // The UI gets the user wording (`engine_start_error`); the developer
    // wording + build hint go to the error log / dev console only.
    let sidecar = app.shell().sidecar("backend").map_err(|e| {
        let detail = e.to_string();
        log_sidecar_start_failure(app, &sidecar_start_log_line("Sidecar setup failed", &detail, true));
        engine_start_error(&detail, true)
    })?;
    sidecar.spawn().map_err(|e| {
        let msg = e.to_string();
        let unbuilt = sidecar_looks_unbuilt(&msg);
        log_sidecar_start_failure(
            app,
            &sidecar_start_log_line("Failed to launch the Python ML sidecar", &msg, unbuilt),
        );
        engine_start_error(&msg, unbuilt)
    })
}

// Requests are HMAC-SHA256 signed over `<secs>\n<json>`; key must match `_KEY` in backend.py. Change both and rebuild.
const SIDECAR_KEY: [u8; 32] = [
    0x28, 0x4e, 0x88, 0xbf, 0x1b, 0x87, 0xea, 0x16, 0x28, 0xf1, 0xcd, 0x3c, 0x0d, 0x6d, 0xa3, 0xfa,
    0x10, 0xd9, 0xb0, 0x4e, 0x88, 0x3e, 0xa3, 0x89, 0x91, 0x1a, 0xb8, 0x77, 0x04, 0xba, 0xb7, 0xb7,
];

/// HMAC-SHA256 (RFC 2104) on `sha2`, which the dependency tree already has.
fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut block = [0u8; 64];
    if key.len() > 64 {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let ipad: Vec<u8> = block.iter().map(|b| b ^ 0x36).collect();
    let opad: Vec<u8> = block.iter().map(|b| b ^ 0x5c).collect();
    let inner = Sha256::new().chain_update(&ipad).chain_update(msg).finalize();
    Sha256::new().chain_update(&opad).chain_update(inner).finalize().into()
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The signed stdin line for `request` stamped `unix_secs` (newline included).
fn signed_sidecar_line_at(request: &serde_json::Value, unix_secs: u64) -> Result<String, String> {
    let body = serde_json::to_string(request).map_err(|e| e.to_string())?;
    let ts = unix_secs.to_string();
    let sig = hmac_sha256(&SIDECAR_KEY, format!("{ts}\n{body}").as_bytes());
    Ok(format!("{ts} {} {body}\n", to_hex(&sig)))
}

/// The signed stdin line for `request`, stamped now.
fn signed_sidecar_line(request: &serde_json::Value) -> Result<String, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    signed_sidecar_line_at(request, now)
}

/// Developer-only hint for logs; never shown in the UI, which says "Relation model engine".
const SIDECAR_BUILD_HINT: &str = "The Python ML sidecar (src-tauri/bin/backend-<target>) is missing or is \
     an empty stub. Build it with src-tauri/python/build_sidecar.sh (or \
     scripts/build-installer-windows.ps1 step 3), then retry.";

/// A spawn error that means "the binary is missing or is the 0-byte stub".
fn sidecar_looks_unbuilt(os_error: &str) -> bool {
    let lower = os_error.to_lowercase();
    lower.contains("os error 193")
        || lower.contains("not a valid win32 application")
        || lower.contains("exec format error")
        || lower.contains("os error 2") // file not found
        || lower.contains("not found")
}

/// The LOG line (developer wording) of a sidecar that could not be started.
fn sidecar_start_log_line(what: &str, os_error: &str, unbuilt: bool) -> String {
    if unbuilt {
        format!("{what} ({os_error}). {SIDECAR_BUILD_HINT}")
    } else {
        format!("{what}: {os_error}")
    }
}

/// Best effort: the permanent error log + stderr (the `tauri dev` console).
fn log_sidecar_start_failure(app: &tauri::AppHandle, line: &str) {
    eprintln!("{line}");
    if let Ok(path) = error_log_path(app) {
        append_error_line(&path, "sidecar", line, None);
    }
}

// Users see only fixed sentences; the engine's own text goes to the error log (it may name the confidential algorithm).

/// The engine could not be started. `unbuilt` = it is missing / not runnable.
fn engine_start_error(os_error: &str, unbuilt: bool) -> String {
    if unbuilt {
        format!(
            "The Relation model engine could not start: it is missing from this installation or is \
             damaged. Please reinstall or update the app. Detail: {os_error}"
        )
    } else {
        format!("The Relation model engine could not start: {os_error}")
    }
}

/// The engine answered with its own error. Fixed text: the engine's message is
/// never shown (see the note above).
const ENGINE_FIT_FAILED: &str =
    "The Relation model engine could not fit this model. The details are in the error log.";
/// The engine ended without printing an answer and said nothing on stderr.
const ENGINE_NO_OUTPUT: &str = "The Relation model engine stopped without returning a result.";
/// Same, when it left something on stderr (now in the log).
const ENGINE_NO_OUTPUT_LOGGED: &str =
    "The Relation model engine stopped without returning a result. The details are in the error log.";
/// The engine's answer is not JSON of the expected shape.
const ENGINE_UNREADABLE: &str =
    "The Relation model engine returned an answer that could not be read. The details are in the error log.";

/// A run stopped at [`ENGINE_RUN_TIMEOUT`]. One line: the Train queue row shows
/// only the first line of an error.
const ENGINE_TIMED_OUT: &str = "The Relation model ran for 10 minutes without an answer \
     and was stopped. Try again, or use fewer rows or predictors.";

// Per-entry log byte budgets; their worst-case sum stays under `ERROR_LOG_DETAIL_MAX`.
/// The engine's `error` text (start kept).
const ENGINE_LOG_ERROR_MAX: usize = 1024;
/// The engine's `trace` (END kept: a traceback names the exception last).
const ENGINE_LOG_TRACE_MAX: usize = 2560;
/// stderr of a run without an answer (END kept, same reason).
const ENGINE_LOG_STDERR_MAX: usize = 3584;
/// The parse error of an unreadable answer.
const ENGINE_LOG_PARSE_ERROR_MAX: usize = 256;
/// The raw stdout of an unreadable answer (start kept) - it can be megabytes.
const ENGINE_LOG_RAW_MAX: usize = 3072;

/// One engine failure, split into what the USER reads and what the LOG keeps.
#[derive(Debug, Clone, PartialEq, Eq)]
struct EngineFailure {
    /// A fixed, Rust-authored sentence. Never contains engine text.
    user: &'static str,
    /// The log line (developer wording, Rust-authored).
    log_message: String,
    /// The engine's own text, bounded (see the `ENGINE_LOG_*_MAX` budgets).
    log_detail: Option<String>,
}

/// The last `max` bytes of `s` (cut on a char boundary) after
/// "(N bytes truncated) …"; unchanged when it already fits.
fn truncate_log_tail(s: &str, max: usize) -> std::borrow::Cow<'_, str> {
    if s.len() <= max {
        return std::borrow::Cow::Borrowed(s);
    }
    let mut start = s.len() - max;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    std::borrow::Cow::Owned(format!("({start} bytes truncated) …{}", &s[start..]))
}

/// The engine ended without printing an answer; `stderr` = what it said instead.
fn engine_no_output_failure(step: &str, stderr: &str) -> EngineFailure {
    let stderr = stderr.trim();
    EngineFailure {
        user: if stderr.is_empty() { ENGINE_NO_OUTPUT } else { ENGINE_NO_OUTPUT_LOGGED },
        log_message: format!("Relation model engine (sidecar) returned no output [{step}]"),
        log_detail: (!stderr.is_empty())
            .then(|| format!("stderr: {}", truncate_log_tail(stderr, ENGINE_LOG_STDERR_MAX))),
    }
}

/// The engine hit [`ENGINE_RUN_TIMEOUT`] and was killed.
fn engine_timed_out_failure(step: &str, stderr: &str) -> EngineFailure {
    let stderr = stderr.trim();
    EngineFailure {
        user: ENGINE_TIMED_OUT,
        log_message: format!(
            "Relation model engine (sidecar) did not finish within {} s and was killed [{step}]",
            ENGINE_RUN_TIMEOUT.as_secs()
        ),
        log_detail: (!stderr.is_empty())
            .then(|| format!("stderr: {}", truncate_log_tail(stderr, ENGINE_LOG_STDERR_MAX))),
    }
}

/// The engine's answer is not valid JSON of the expected shape.
fn engine_unreadable_answer_failure(step: &str, parse_error: &dyn std::fmt::Display, raw: &str) -> EngineFailure {
    let parse_error = parse_error.to_string();
    EngineFailure {
        user: ENGINE_UNREADABLE,
        log_message: format!("Relation model engine (sidecar) output could not be parsed [{step}]"),
        log_detail: Some(format!(
            "parse error: {}\nraw: {}",
            truncate_log_detail(&parse_error, ENGINE_LOG_PARSE_ERROR_MAX),
            truncate_log_detail(raw.trim(), ENGINE_LOG_RAW_MAX),
        )),
    }
}

/// The engine answered with its own `error` (+ optional `trace`).
fn engine_reported_failure(step: &str, err: &str, trace: Option<&str>) -> EngineFailure {
    let mut detail = format!("error: {}", truncate_log_detail(err.trim(), ENGINE_LOG_ERROR_MAX));
    if let Some(trace) = trace.map(str::trim).filter(|t| !t.is_empty()) {
        detail.push_str("\ntrace: ");
        detail.push_str(&truncate_log_tail(trace, ENGINE_LOG_TRACE_MAX));
    }
    EngineFailure {
        user: ENGINE_FIT_FAILED,
        log_message: format!("Relation model engine (sidecar) reported an error [{step}]"),
        log_detail: Some(detail),
    }
}

/// Replaces the engine's error with the fixed sentence, drops `trace`, returns what to log; a non-object answer becomes `{error}`.
fn take_engine_error(parsed: &mut serde_json::Value, step: &str) -> Option<EngineFailure> {
    let Some(obj) = parsed.as_object_mut() else {
        let failure = engine_unreadable_answer_failure(step, &"the answer is not a JSON object", &parsed.to_string());
        *parsed = serde_json::json!({ "error": failure.user });
        return Some(failure);
    };
    let trace = obj.remove("trace");
    let err = obj.get("error").filter(|e| !e.is_null())?;
    // Not a string (never sent by the engine): log its JSON text.
    let text = |v: &serde_json::Value| v.as_str().map(str::to_owned).unwrap_or_else(|| v.to_string());
    let failure = engine_reported_failure(step, &text(err), trace.as_ref().map(text).as_deref());
    obj.insert("error".into(), serde_json::Value::String(failure.user.into()));
    Some(failure)
}

/// Best effort: appends one bounded engine failure to the error log (source `sidecar`).
fn write_engine_failure(path: &std::path::Path, failure: &EngineFailure) {
    append_error_line(path, "sidecar", &failure.log_message, failure.log_detail.as_deref());
}

/// Best effort: the permanent error log + stderr (the `tauri dev` console).
fn log_engine_failure(app: &tauri::AppHandle, failure: &EngineFailure) {
    eprintln!("{}", failure.log_message);
    if let Some(detail) = &failure.log_detail {
        eprintln!("{detail}");
    }
    if let Ok(path) = error_log_path(app) {
        write_engine_failure(&path, failure);
    }
}

/// Log `failure` and return the sentence the user reads.
fn report_engine_failure(app: &tauri::AppHandle, failure: EngineFailure) -> String {
    log_engine_failure(app, &failure);
    failure.user.to_string()
}

/// What the engine printed for `step`, as JSON of type `T`. No output or an
/// unreadable answer is a failure (user sentence + log entry).
fn read_engine_answer<T: serde::de::DeserializeOwned>(
    step: &str,
    stdout: &str,
    stderr: &str,
) -> Result<T, EngineFailure> {
    if stdout.trim().is_empty() {
        return Err(engine_no_output_failure(step, stderr));
    }
    serde_json::from_str(stdout.trim()).map_err(|e| engine_unreadable_answer_failure(step, &e, stdout))
}

#[cfg(test)]
mod engine_wording_tests {
    use super::*;

    /// Words a user must never read (the confidential algorithm name included).
    const DEV_WORDS: [&str; 9] =
        ["idecar", "Python", "python", "backend", "build_", ".sh", "src-tauri", "LinearGAM", "Nuitka"];

    fn assert_user_wording(msg: &str) {
        assert!(msg.starts_with("The Relation model engine"), "{msg}");
        for w in DEV_WORDS {
            assert!(!msg.contains(w), "developer wording ({w}) in: {msg}");
        }
    }

    #[test]
    fn a_missing_engine_tells_the_user_to_reinstall_and_keeps_the_os_error() {
        let os = "%1 is not a valid Win32 application. (os error 193)";
        assert!(sidecar_looks_unbuilt(os));
        let msg = engine_start_error(os, sidecar_looks_unbuilt(os));
        assert_user_wording(&msg);
        assert!(msg.contains("could not start") && msg.contains("reinstall or update the app"));
        assert!(msg.ends_with(&format!("Detail: {os}")), "the OS error stays, after the sentence: {msg}");
        // One line: the Train queue row shows only the first line of an error.
        assert!(!msg.contains('\n'));
    }

    #[test]
    fn every_missing_binary_shape_is_recognised_and_other_failures_are_not() {
        for os in [
            "%1 is not a valid Win32 application. (os error 193)",
            "Exec format error (os error 8)",
            "The system cannot find the file specified. (os error 2)",
            "No such file or directory (os error 2)",
            "program not found",
        ] {
            assert!(sidecar_looks_unbuilt(os), "{os}");
        }
        let other = "Access is denied. (os error 5)";
        assert!(!sidecar_looks_unbuilt(other));
        let msg = engine_start_error(other, false);
        assert_user_wording(&msg);
        assert_eq!(msg, format!("The Relation model engine could not start: {other}"));
        assert!(!msg.contains("reinstall"), "not a known missing-install case: no such advice");
    }

    #[test]
    fn the_build_hint_only_ever_goes_to_the_log_line() {
        let os = "program not found";
        let log = sidecar_start_log_line("Failed to launch the Python ML sidecar", os, true);
        assert!(log.contains("sidecar") && log.contains("build_sidecar.sh") && log.contains(os));
        assert!(!engine_start_error(os, true).contains("build_sidecar"));
        // Not a missing build: no hint in the log either, just the reason.
        assert_eq!(
            sidecar_start_log_line("Failed to launch the Python ML sidecar", "Access is denied.", false),
            "Failed to launch the Python ML sidecar: Access is denied."
        );
    }


    /// Library-exception text; every word is forbidden in the UI.
    const NASTY: &str = "pygam LinearGAM did not converge (numpy.linalg.LinAlgError) - Python sidecar backend.py";
    const NASTY_TRACE: &str = "Traceback (most recent call last):\n  File \"backend.py\", line 180, in \
         preview_relationship\n    model = pygam.LinearGAM(lam=lamb).fit(Xi, y)\nnumpy.linalg.LinAlgError: SVD did not converge";
    /// Engine / library words on top of [`DEV_WORDS`].
    const ENGINE_WORDS: [&str; 7] = ["pygam", "GAM", "numpy", "LinAlgError", "Traceback", "converge", "SVD"];

    fn assert_no_engine_text(shown: &str) {
        for w in DEV_WORDS.iter().chain(&ENGINE_WORDS) {
            assert!(!shown.contains(w), "engine wording ({w}) shown to the user: {shown}");
        }
    }

    /// The whole log entry of `f` as it is written (message + detail).
    fn entry(f: &EngineFailure) -> String {
        format!("{}\n{}", f.log_message, f.log_detail.as_deref().unwrap_or(""))
    }

    fn assert_logged(f: &EngineFailure, words: &[&str]) {
        let e = entry(f);
        for w in words {
            assert!(e.contains(w), "the log lost the detail ({w}): {e}");
        }
        assert!(e.len() <= ERROR_LOG_DETAIL_MAX, "log entry of {} bytes", e.len());
        assert!(f.log_message.contains("sidecar"), "developer wording in the log line: {}", f.log_message);
    }

    #[test]
    fn a_run_without_an_answer_shows_no_stderr_but_logs_it() {
        let quiet = engine_no_output_failure("preview_relationship", "  \n");
        assert_eq!(quiet.user, "The Relation model engine stopped without returning a result.");
        assert_eq!(quiet.log_detail, None, "nothing to log but the line itself");
        assert!(quiet.log_message.ends_with("[preview_relationship]"));
        // stderr can be a full traceback.
        let loud = engine_no_output_failure("preview_relationship", &format!("  {NASTY_TRACE}\n"));
        assert_eq!(
            loud.user,
            "The Relation model engine stopped without returning a result. The details are in the error log."
        );
        assert_logged(&loud, &["Traceback", "pygam.LinearGAM", "LinAlgError: SVD did not converge"]);
        for f in [&quiet, &loud] {
            assert_user_wording(f.user);
            assert_no_engine_text(f.user);
        }
    }

    #[test]
    fn an_unreadable_answer_shows_neither_the_parse_error_nor_the_raw_output() {
        let raw = format!("{NASTY}\n{{\"r2\":");
        let f = engine_unreadable_answer_failure("preview_relationship", &"EOF while parsing a value", &raw);
        assert_eq!(
            f.user,
            "The Relation model engine returned an answer that could not be read. The details are in the error log."
        );
        assert_user_wording(f.user);
        assert_no_engine_text(f.user);
        assert!(!f.user.contains("EOF") && !f.user.contains("raw"));
        assert_logged(&f, &["parse error: EOF while parsing a value", "raw: pygam LinearGAM", "{\"r2\":"]);
    }

    #[test]
    fn an_engine_error_shows_the_fixed_sentence_and_logs_error_and_trace() {
        let f = engine_reported_failure("preview_relationship", NASTY, Some(NASTY_TRACE));
        assert_eq!(f.user, "The Relation model engine could not fit this model. The details are in the error log.");
        assert_user_wording(f.user);
        assert_no_engine_text(f.user);
        assert_logged(&f, &[NASTY, "trace: Traceback", "SVD did not converge"]);
        // No trace (the "Unknown action" answer has none): just the error.
        let bare = engine_reported_failure("preview_relationship", "Unknown action: 'x'", None);
        assert_eq!(bare.log_detail.as_deref(), Some("error: Unknown action: 'x'"));
        // The engine's own KNOWN validation messages get no special treatment:
        // they are internal mismatches the user cannot act on.
        for known in [
            "X has 3 rows but y has 4",
            "X has 2 columns but 3 predictors named",
            "X_extra has 2 columns but the model has 3 predictors",
            "Unknown action: 'preview_relationship'",
        ] {
            let f = engine_reported_failure("preview_relationship", known, None);
            assert_eq!(f.user, ENGINE_FIT_FAILED, "{known}");
            assert_logged(&f, &[known]);
        }
    }

    #[test]
    fn every_engine_log_entry_is_bounded() {
        // "ก" is 3 bytes: the cuts must land on char boundaries (no panic).
        let huge = "ก1.5, ".repeat(400_000);
        for f in [
            engine_no_output_failure("s", &huge),
            engine_unreadable_answer_failure("s", &huge, &huge),
            engine_reported_failure("s", &huge, Some(&huge)),
        ] {
            let e = entry(&f);
            assert!(e.len() <= ERROR_LOG_DETAIL_MAX, "{}: {} bytes", f.log_message, e.len());
            assert!(e.contains("bytes truncated)"), "{}", f.log_message);
        }
    }

    #[test]
    fn a_timed_out_train_says_so_in_plain_words_and_logs_the_rest() {
        let f = engine_timed_out_failure("preview_relationship", &format!("  {NASTY_TRACE}\n"));
        assert!(f.user.starts_with("The Relation model ran for 10 minutes"), "{}", f.user);
        assert!(f.user.contains("Relation model"));
        assert!(f.user.contains("10 minutes"));
        assert_eq!(ENGINE_RUN_TIMEOUT.as_secs(), 600, "the sentence names this cap");
        assert!(!f.user.contains('\n'));
        for w in DEV_WORDS {
            assert!(!f.user.contains(w), "developer wording ({w}) in: {}", f.user);
        }
        assert_no_engine_text(f.user);
        assert_logged(&f, &["killed", "SVD did not converge"]);
        assert_eq!(engine_timed_out_failure("s", " ").log_detail, None);
    }

    #[test]
    fn truncate_log_tail_keeps_the_end_on_a_char_boundary() {
        assert_eq!(truncate_log_tail("short", 10), "short");
        assert_eq!(truncate_log_tail("exactly10!", 10), "exactly10!");
        assert_eq!(truncate_log_tail("abcdefghijk", 4), "(7 bytes truncated) …hijk");
        // A cut inside "ข" moves forward to the next boundary.
        assert_eq!(truncate_log_tail("กขค", 4), "(6 bytes truncated) …ค");
        assert_eq!(truncate_log_tail("กขค", 2), "(9 bytes truncated) …");
        assert_eq!(truncate_log_tail("", 0), "");
    }

    #[test]
    fn a_preview_answer_with_an_engine_error_keeps_its_shape_but_not_the_text() {
        let mut parsed = serde_json::json!({ "error": NASTY, "trace": NASTY_TRACE, "request": "r" });
        let f = take_engine_error(&mut parsed, "preview_relationship").expect("an error answer");
        assert_eq!(parsed, serde_json::json!({ "error": ENGINE_FIT_FAILED, "request": "r" }), "`error` stays a string, `trace` is gone");
        assert_no_engine_text(&parsed.to_string());
        assert_logged(&f, &[NASTY, "SVD did not converge"]);
        assert!(f.log_message.ends_with("[preview_relationship]"));
        // A good answer is untouched and logs nothing - but a stray `trace` never ships.
        let mut good = serde_json::json!({ "r2_per_step": [0.5], "trace": NASTY_TRACE });
        assert_eq!(take_engine_error(&mut good, "s"), None);
        assert_eq!(good, serde_json::json!({ "r2_per_step": [0.5] }));
        let mut null_error = serde_json::json!({ "error": null, "predicted": [] });
        assert_eq!(take_engine_error(&mut null_error, "s"), None);
        assert_eq!(null_error, serde_json::json!({ "error": null, "predicted": [] }));
        // A non-string `error` and an answer that is not an object: fixed text too.
        let mut odd = serde_json::json!({ "error": { "why": NASTY } });
        let f = take_engine_error(&mut odd, "s").unwrap();
        assert_eq!(odd, serde_json::json!({ "error": ENGINE_FIT_FAILED }));
        assert_logged(&f, &["pygam LinearGAM"]);
        let mut bare = serde_json::json!(NASTY);
        let f = take_engine_error(&mut bare, "s").unwrap();
        assert_eq!(bare, serde_json::json!({ "error": ENGINE_UNREADABLE }));
        assert_logged(&f, &["not a JSON object", "pygam LinearGAM"]);
    }

    #[test]
    fn the_log_file_gets_the_engine_text_under_the_sidecar_tag() {
        let dir = std::env::temp_dir().join(format!("wizard-engine-log-{}-{:?}", std::process::id(), std::thread::current().id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("frontend-errors.log");
        let f = engine_reported_failure("preview_relationship", NASTY, Some(NASTY_TRACE));
        write_engine_failure(&path, &f);
        let quiet = engine_no_output_failure("preview_relationship", "");
        write_engine_failure(&path, &quiet);
        let log = std::fs::read_to_string(&path).unwrap();
        assert!(log.contains("[sidecar] Relation model engine (sidecar) reported an error [preview_relationship]"), "{log}");
        assert!(log.contains(&format!("error: {NASTY}")) && log.contains("numpy.linalg.LinAlgError: SVD did not converge"), "{log}");
        assert!(log.contains("[sidecar] Relation model engine (sidecar) returned no output [preview_relationship]"), "{log}");
        // Best effort: a path that cannot be written is silently skipped.
        write_engine_failure(&dir.join("no-such-dir").join("x.log"), &f);
        let _ = std::fs::remove_dir_all(&dir);
    }

}

/// Value filter for `preview_relationship_model`, same JSON shape as the dashboard FilterPanel.
#[derive(Debug, Deserialize, Clone)]
struct PreviewValueFilter {
    sensor: String,
    operation: String, // "greater_than" | "less_than" | "between" | "equals"
    value1: Option<f64>,
    value2: Option<f64>,
}

#[derive(Debug, Deserialize, Default, Clone)]
struct PreviewFilter {
    #[serde(default)]
    timestamp_start: Option<String>,
    #[serde(default)]
    timestamp_end: Option<String>,
    #[serde(default)]
    value_filters: Vec<PreviewValueFilter>,
    /// "and" | "or"; missing means "and". `DataFilter::to_preview` forwards `DataFilter::combine` into it.
    #[serde(default)]
    combine: Option<String>,
    /// Kept if the row is in ANY period; sending it with the legacy `timestamp_start/_end` pair is rejected by `ResolvedFilter::resolve`.
    #[serde(default)]
    timestamp_ranges: Vec<TimeRangeArg>,
}

/// One time period as sent by the frontend. `None` / blank = open bound.
#[derive(Debug, Deserialize, Default, Clone)]
struct TimeRangeArg {
    #[serde(default)]
    start: Option<String>,
    #[serde(default)]
    end: Option<String>,
}

/// Blank/None is an open bound; an unparseable value is an error, not a silent open bound.
fn parse_time_bound(raw: Option<&str>, label: &str) -> Result<Option<i64>, String> {
    match raw.map(str::trim) {
        None | Some("") => Ok(None),
        Some(t) => parse_timestamp(t)
            .map(|dt| Some(ts_to_micros(dt)))
            .ok_or_else(|| format!("{label}: cannot parse timestamp '{t}'")),
    }
}

/// One pre-resolved value filter: sensor name → header index (resolved once
/// up front so the per-row hot loop never re-scans `headers`).
struct ResolvedValueFilter {
    sensor_idx: usize,
    operation: String,
    value1: Option<f64>,
    value2: Option<f64>,
}

/// Resolved `PreviewFilter`, built once per call; `keeps()` is a cheap per-row predicate on epoch micros vs `ts_parsed`.
struct ResolvedFilter {
    /// Sorted, merged time periods (epoch micros, inclusive). Empty = no time
    /// gate. `None` on a side = open bound.
    ts_ranges: Vec<(Option<i64>, Option<i64>)>,
    value_filters: Vec<ResolvedValueFilter>,
    /// true = OR (any value filter passing keeps the row), false = AND (all must pass, the default).
    or_combine: bool,
}

/// Sort ranges by start (open start first) and merge overlapping/touching ones.
fn merge_ranges(mut r: Vec<(Option<i64>, Option<i64>)>) -> Vec<(Option<i64>, Option<i64>)> {
    r.sort_by_key(|(s, _)| s.unwrap_or(i64::MIN));
    let mut out: Vec<(Option<i64>, Option<i64>)> = Vec::with_capacity(r.len());
    for (s, e) in r {
        if let Some(last) = out.last_mut() {
            // last.1 == None means open end: swallows everything after it.
            let overlaps = match (last.1, s) {
                (None, _) => true,
                (_, None) => true,
                (Some(le), Some(s)) => s <= le,
            };
            if overlaps {
                last.1 = match (last.1, e) {
                    (None, _) | (_, None) => None,
                    (Some(a), Some(b)) => Some(a.max(b)),
                };
                continue;
            }
        }
        out.push((s, e));
    }
    out
}

impl ResolvedFilter {
    fn resolve(filter: Option<&PreviewFilter>, headers: &[String]) -> Result<Self, String> {
        let Some(f) = filter else {
            return Ok(Self {
                ts_ranges: Vec::new(),
                value_filters: Vec::new(),
                or_combine: false,
            });
        };
        let legacy_start = parse_time_bound(f.timestamp_start.as_deref(), "timestamp_start")?;
        let legacy_end = parse_time_bound(f.timestamp_end.as_deref(), "timestamp_end")?;
        let legacy_given = legacy_start.is_some() || legacy_end.is_some();
        if legacy_given && !f.timestamp_ranges.is_empty() {
            return Err(
                "filter sets both timestamp_start/timestamp_end and timestamp_ranges; send only one"
                    .to_string(),
            );
        }
        let mut ranges: Vec<(Option<i64>, Option<i64>)> = Vec::new();
        if legacy_given {
            if let (Some(s), Some(e)) = (legacy_start, legacy_end) {
                if s > e {
                    return Err("time period 1 ends before it starts".to_string());
                }
            }
            ranges.push((legacy_start, legacy_end));
        }
        for (i, r) in f.timestamp_ranges.iter().enumerate() {
            let n = i + 1;
            let s = parse_time_bound(r.start.as_deref(), &format!("time period {n} start"))?;
            let e = parse_time_bound(r.end.as_deref(), &format!("time period {n} end"))?;
            if let (Some(s), Some(e)) = (s, e) {
                if s > e {
                    return Err(format!("time period {n} ends before it starts"));
                }
            }
            // A fully blank period is (None, None): a gate that keeps every row
            // with a parseable timestamp.
            ranges.push((s, e));
        }
        let ts_ranges = merge_ranges(ranges);
        let value_filters = f
            .value_filters
            .iter()
            .filter_map(|vf| {
                resolve_sensor(headers, &vf.sensor)
                    .map(|idx| ResolvedValueFilter {
                        sensor_idx: idx,
                        operation: vf.operation.clone(),
                        value1: vf.value1,
                        value2: vf.value2,
                    })
            })
            .collect();
        Ok(Self {
            ts_ranges,
            value_filters,
            or_combine: f.combine.as_deref() == Some("or"),
        })
    }

    #[inline]
    fn is_noop(&self) -> bool {
        self.ts_ranges.is_empty() && self.value_filters.is_empty()
    }

    /// Rows with `TS_MISSING` timestamps are excluded under a timestamp gate.
    #[inline]
    fn keeps(&self, data: &ColumnarData, row: usize) -> bool {
        if !self.ts_ranges.is_empty() {
            let ts = data.ts_parsed[row];
            if ts == TS_MISSING {
                return false;
            }
            let inside = self
                .ts_ranges
                .iter()
                .any(|&(s, e)| s.is_none_or(|s| ts >= s) && e.is_none_or(|e| ts <= e));
            if !inside {
                return false;
            }
        }
        if self.value_filters.is_empty() {
            return true;
        }
        // AND: all must pass; OR: at least one. An empty list is handled above, so no vacuous OR.
        let mut matched_any = false;
        for rf in &self.value_filters {
            let val = data.value(rf.sensor_idx, row);
            let ok = match val {
                None => false,
                Some(v) => match rf.operation.as_str() {
                    "greater_than" => rf.value1.is_none_or(|v1| v > v1),
                    "less_than" => rf.value1.is_none_or(|v1| v < v1),
                    "equals" => rf.value1.is_none_or(|v1| (v - v1).abs() < f64::EPSILON),
                    "between" => match (rf.value1, rf.value2) {
                        (Some(v1), Some(v2)) => v >= v1 && v <= v2,
                        _ => true,
                    },
                    _ => true,
                },
            };
            if self.or_combine {
                if ok {
                    matched_any = true;
                    break;
                }
            } else if !ok {
                return false;
            }
        }
        if self.or_combine {
            matched_any
        } else {
            true
        }
    }
}

#[cfg(test)]
mod resolved_filter_tests {
    use super::*;

    fn dataset() -> ColumnarData {
        ColumnarData::from_parts(
            vec!["timestamp".into(), "A".into()],
            vec![
                Some("2020-01-01T00:00".into()),
                Some("2020-01-01T00:05".into()),
                Some("2020-01-01T00:10".into()),
                None, // unparseable / missing timestamp
            ],
            vec![
                vec![f64::NAN; 4],
                vec![1.0, 2.0, 3.0, 4.0],
            ],
        )
    }

    #[test]
    fn none_filter_resolves_to_a_noop() {
        let resolved = ResolvedFilter::resolve(None, &dataset().headers).unwrap();
        assert!(resolved.is_noop());
    }

    #[test]
    fn empty_filter_resolves_to_a_noop() {
        let resolved = ResolvedFilter::resolve(Some(&PreviewFilter::default()), &dataset().headers).unwrap();
        assert!(resolved.is_noop());
    }

    #[test]
    fn a_timestamp_filter_is_not_a_noop_and_gates_rows() {
        let data = dataset();
        let filter = PreviewFilter {
            timestamp_start: Some("2020-01-01T00:05".into()),
            timestamp_end: None,
            value_filters: vec![],
            ..Default::default()
        };
        let resolved = ResolvedFilter::resolve(Some(&filter), &data.headers).unwrap();
        assert!(!resolved.is_noop());
        assert!(!resolved.keeps(&data, 0)); // before start
        assert!(resolved.keeps(&data, 1)); // exactly at start
        assert!(resolved.keeps(&data, 2)); // after start
    }

    #[test]
    fn rows_with_missing_timestamp_are_excluded_once_a_timestamp_gate_is_active() {
        let data = dataset();
        let filter = PreviewFilter {
            timestamp_start: Some("2020-01-01T00:00".into()),
            timestamp_end: None,
            value_filters: vec![],
            ..Default::default()
        };
        let resolved = ResolvedFilter::resolve(Some(&filter), &data.headers).unwrap();
        assert!(!resolved.keeps(&data, 3)); // row 3 has no timestamp
    }

    #[test]
    fn missing_timestamp_rows_pass_through_when_no_timestamp_gate_is_set() {
        let data = dataset();
        let filter = PreviewFilter {
            timestamp_start: None,
            timestamp_end: None,
            value_filters: vec![PreviewValueFilter {
                sensor: "A".into(),
                operation: "greater_than".into(),
                value1: Some(0.0),
                value2: None,
            }],
            ..Default::default()
        };
        let resolved = ResolvedFilter::resolve(Some(&filter), &data.headers).unwrap();
        assert!(resolved.keeps(&data, 3)); // A=4.0 > 0, no timestamp gate active
    }

    #[test]
    fn value_filter_sensor_matches_ignoring_case_and_spaces_like_the_gate() {
        let data = dataset();
        let filter = PreviewFilter {
            timestamp_start: None,
            timestamp_end: None,
            value_filters: vec![PreviewValueFilter {
                sensor: " a ".into(),
                operation: "greater_than".into(),
                value1: Some(1000.0),
                value2: None,
            }],
            ..Default::default()
        };
        let resolved = ResolvedFilter::resolve(Some(&filter), &data.headers).unwrap();
        assert!(!resolved.is_noop());
        assert!(!resolved.keeps(&data, 3)); // the condition applies: A=4.0 is not above 1000
    }

    #[test]
    fn value_filter_unknown_sensor_is_dropped_from_the_resolved_set() {
        let data = dataset();
        let filter = PreviewFilter {
            timestamp_start: None,
            timestamp_end: None,
            value_filters: vec![PreviewValueFilter {
                sensor: "DOES_NOT_EXIST".into(),
                operation: "greater_than".into(),
                value1: Some(0.0),
                value2: None,
            }],
            ..Default::default()
        };
        let resolved = ResolvedFilter::resolve(Some(&filter), &data.headers).unwrap();
        // Unknown sensor -> filtered out during resolve -> effectively a noop.
        assert!(resolved.is_noop());
    }

    #[test]
    fn value_filter_operations_match_expected_semantics() {
        let data = dataset(); // A values: 1, 2, 3, 4
        let make = |op: &str, v1: Option<f64>, v2: Option<f64>| {
            ResolvedFilter::resolve(
                Some(&PreviewFilter {
                    timestamp_start: None,
                    timestamp_end: None,
                    value_filters: vec![PreviewValueFilter {
                        sensor: "A".into(),
                        operation: op.into(),
                        value1: v1,
                        value2: v2,
                    }],
                    ..Default::default()
                }),
                &data.headers,
            )
            .unwrap()
        };

        let gt = make("greater_than", Some(2.0), None);
        assert_eq!((0..4).filter(|&r| gt.keeps(&data, r)).count(), 2); // 3, 4

        let lt = make("less_than", Some(3.0), None);
        assert_eq!((0..4).filter(|&r| lt.keeps(&data, r)).count(), 2); // 1, 2

        let eq = make("equals", Some(3.0), None);
        assert_eq!((0..4).filter(|&r| eq.keeps(&data, r)).count(), 1); // 3

        let between = make("between", Some(2.0), Some(3.0));
        assert_eq!((0..4).filter(|&r| between.keeps(&data, r)).count(), 2); // 2, 3
    }

    #[test]
    fn unknown_operation_string_passes_every_row() {
        let data = dataset();
        let resolved = ResolvedFilter::resolve(
            Some(&PreviewFilter {
                timestamp_start: None,
                timestamp_end: None,
                value_filters: vec![PreviewValueFilter {
                    sensor: "A".into(),
                    operation: "not_a_real_op".into(),
                    value1: Some(999.0),
                    value2: None,
                }],
                ..Default::default()
            }),
            &data.headers,
        )
        .unwrap();
        assert_eq!((0..4).filter(|&r| resolved.keeps(&data, r)).count(), 4);
    }

    #[test]
    fn or_combine_keeps_a_row_that_matches_any_one_condition() {
        let data = dataset(); // A values: 1, 2, 3, 4
        let filter = PreviewFilter {
            timestamp_start: None,
            timestamp_end: None,
            value_filters: vec![
                PreviewValueFilter {
                    sensor: "A".into(),
                    operation: "less_than".into(),
                    value1: Some(1.5), // only row 0 (A=1)
                    value2: None,
                },
                PreviewValueFilter {
                    sensor: "A".into(),
                    operation: "greater_than".into(),
                    value1: Some(3.5), // only row 3 (A=4)
                    value2: None,
                },
            ],
            combine: Some("or".into()),
            ..Default::default()
        };
        let resolved = ResolvedFilter::resolve(Some(&filter), &data.headers).unwrap();
        assert!(resolved.keeps(&data, 0)); // A=1 < 1.5
        assert!(!resolved.keeps(&data, 1)); // A=2 matches neither
        assert!(!resolved.keeps(&data, 2)); // A=3 matches neither
        assert!(resolved.keeps(&data, 3)); // A=4 > 3.5
    }

    #[test]
    fn and_combine_still_requires_every_condition_when_combine_is_set_explicitly() {
        let data = dataset(); // A values: 1, 2, 3, 4
        let filter = PreviewFilter {
            timestamp_start: None,
            timestamp_end: None,
            value_filters: vec![
                PreviewValueFilter {
                    sensor: "A".into(),
                    operation: "greater_than".into(),
                    value1: Some(1.0),
                    value2: None,
                },
                PreviewValueFilter {
                    sensor: "A".into(),
                    operation: "less_than".into(),
                    value1: Some(4.0),
                    value2: None,
                },
            ],
            combine: Some("and".into()),
            ..Default::default()
        };
        let resolved = ResolvedFilter::resolve(Some(&filter), &data.headers).unwrap();
        assert!(!resolved.keeps(&data, 0)); // A=1 fails > 1
        assert!(resolved.keeps(&data, 1)); // A=2 passes both
        assert!(resolved.keeps(&data, 2)); // A=3 passes both
        assert!(!resolved.keeps(&data, 3)); // A=4 fails < 4
    }

    #[test]
    fn missing_or_unrecognized_combine_defaults_to_and() {
        let data = dataset(); // A values: 1, 2, 3, 4
        let filter = PreviewFilter {
            timestamp_start: None,
            timestamp_end: None,
            value_filters: vec![PreviewValueFilter {
                sensor: "A".into(),
                operation: "greater_than".into(),
                value1: Some(1.0),
                value2: None,
            }],
            combine: Some("banana".into()),
            ..Default::default()
        };
        let resolved = ResolvedFilter::resolve(Some(&filter), &data.headers).unwrap();
        assert!(!resolved.or_combine);
    }


    fn ts_dataset() -> ColumnarData {
        // Minutes 0..=9 plus a TS_MISSING row; A = row index.
        let mut ts: Vec<Option<String>> = (0..10)
            .map(|i| Some(format!("2020-01-01T00:{:02}", i)))
            .collect();
        ts.push(None);
        ColumnarData::from_parts(
            vec!["timestamp".into(), "A".into()],
            ts,
            vec![vec![f64::NAN; 11], (0..11).map(|i| i as f64).collect()],
        )
    }

    fn range(s: Option<&str>, e: Option<&str>) -> TimeRangeArg {
        TimeRangeArg {
            start: s.map(String::from),
            end: e.map(String::from),
        }
    }

    fn kept(f: &PreviewFilter, d: &ColumnarData) -> Vec<usize> {
        let r = ResolvedFilter::resolve(Some(f), &d.headers).unwrap();
        (0..d.n_rows()).filter(|&i| r.keeps(d, i)).collect()
    }

    #[test]
    fn or_across_two_disjoint_ranges() {
        let d = ts_dataset();
        let f = PreviewFilter {
            timestamp_ranges: vec![
                range(Some("2020-01-01T00:01"), Some("2020-01-01T00:02")),
                range(Some("2020-01-01T00:06"), Some("2020-01-01T00:07")),
            ],
            ..Default::default()
        };
        assert_eq!(kept(&f, &d), vec![1, 2, 6, 7]);
        let r = ResolvedFilter::resolve(Some(&f), &d.headers).unwrap();
        assert_eq!(r.ts_ranges.len(), 2);
    }

    #[test]
    fn overlapping_ranges_are_merged() {
        let d = ts_dataset();
        let f = PreviewFilter {
            timestamp_ranges: vec![
                range(Some("2020-01-01T00:04"), Some("2020-01-01T00:07")),
                range(Some("2020-01-01T00:01"), Some("2020-01-01T00:05")),
            ],
            ..Default::default()
        };
        let r = ResolvedFilter::resolve(Some(&f), &d.headers).unwrap();
        assert_eq!(r.ts_ranges.len(), 1);
        assert_eq!(kept(&f, &d), vec![1, 2, 3, 4, 5, 6, 7]);
    }

    #[test]
    fn open_first_start_and_open_last_end() {
        let d = ts_dataset();
        let f = PreviewFilter {
            timestamp_ranges: vec![
                range(None, Some("2020-01-01T00:01")),
                range(Some("2020-01-01T00:08"), Some("")),
            ],
            ..Default::default()
        };
        assert_eq!(kept(&f, &d), vec![0, 1, 8, 9]);
    }

    #[test]
    fn ranges_combine_with_value_filters_under_and_and_or() {
        let d = ts_dataset();
        let vf = |op: &str, v: f64| PreviewValueFilter {
            sensor: "A".into(),
            operation: op.into(),
            value1: Some(v),
            value2: None,
        };
        let mut f = PreviewFilter {
            timestamp_ranges: vec![range(Some("2020-01-01T00:02"), Some("2020-01-01T00:06"))],
            value_filters: vec![vf("greater_than", 3.0), vf("less_than", 5.0)],
            ..Default::default()
        };
        // AND: in range AND 3<A<5 -> only A=4
        assert_eq!(kept(&f, &d), vec![4]);
        // OR: in range AND (A>3 OR A<5) -> every in-range row
        f.combine = Some("or".into());
        assert_eq!(kept(&f, &d), vec![2, 3, 4, 5, 6]);
    }

    #[test]
    fn legacy_pair_alone_still_works_as_one_range() {
        let d = ts_dataset();
        let f = PreviewFilter {
            timestamp_start: Some("2020-01-01T00:03".into()),
            timestamp_end: Some("2020-01-01T00:05".into()),
            ..Default::default()
        };
        assert_eq!(kept(&f, &d), vec![3, 4, 5]);
    }

    #[test]
    fn legacy_and_ranges_together_is_an_error() {
        let d = ts_dataset();
        let f = PreviewFilter {
            timestamp_start: Some("2020-01-01T00:03".into()),
            timestamp_ranges: vec![range(Some("2020-01-01T00:05"), None)],
            ..Default::default()
        };
        assert!(ResolvedFilter::resolve(Some(&f), &d.headers).is_err());
    }

    #[test]
    fn unparseable_bound_is_an_error_in_both_shapes() {
        let d = ts_dataset();
        let legacy = PreviewFilter {
            timestamp_start: Some("not a date".into()),
            ..Default::default()
        };
        assert!(ResolvedFilter::resolve(Some(&legacy), &d.headers).is_err());
        let ranged = PreviewFilter {
            timestamp_ranges: vec![range(None, Some("2020-13-45"))],
            ..Default::default()
        };
        assert!(ResolvedFilter::resolve(Some(&ranged), &d.headers).is_err());
    }

    #[test]
    fn blank_bounds_mean_no_bound() {
        let d = ts_dataset();
        let f = PreviewFilter {
            timestamp_start: Some("".into()),
            timestamp_end: Some("   ".into()),
            ..Default::default()
        };
        assert!(ResolvedFilter::resolve(Some(&f), &d.headers).unwrap().is_noop());
    }

    #[test]
    fn start_after_end_is_an_error_with_one_based_period_number() {
        let d = ts_dataset();
        let f = PreviewFilter {
            timestamp_ranges: vec![
                range(Some("2020-01-01T00:01"), Some("2020-01-01T00:02")),
                range(Some("2020-01-01T00:08"), Some("2020-01-01T00:03")),
            ],
            ..Default::default()
        };
        let err = ResolvedFilter::resolve(Some(&f), &d.headers).err().unwrap();
        assert_eq!(err, "time period 2 ends before it starts");
    }

    #[test]
    fn is_noop_is_false_with_ranges_and_true_with_empty_list() {
        let d = ts_dataset();
        let with = PreviewFilter {
            timestamp_ranges: vec![range(Some("2020-01-01T00:01"), None)],
            ..Default::default()
        };
        assert!(!ResolvedFilter::resolve(Some(&with), &d.headers).unwrap().is_noop());
        let empty = PreviewFilter {
            timestamp_ranges: vec![],
            ..Default::default()
        };
        assert!(ResolvedFilter::resolve(Some(&empty), &d.headers).unwrap().is_noop());
    }

    #[test]
    fn ts_missing_row_is_excluded_when_a_range_exists() {
        let d = ts_dataset();
        let f = PreviewFilter {
            timestamp_ranges: vec![range(Some("2020-01-01T00:00"), None)],
            ..Default::default()
        };
        let k = kept(&f, &d);
        assert!(!k.contains(&10)); // TS_MISSING row
        assert_eq!(k.len(), 10);
    }

    #[test]
    fn data_filter_passes_ranges_through_to_preview() {
        let df = DataFilter {
            timestamp_ranges: vec![range(Some("2020-01-01T00:01"), None)],
            ..Default::default()
        };
        assert_eq!(df.to_preview().timestamp_ranges.len(), 1);
    }

    #[test]
    fn timestamp_ranges_deserializes_from_frontend_json() {
        let f: PreviewFilter = serde_json::from_str(
            r#"{"timestamp_ranges":[{"start":"2020-01-01T00:01","end":null},{"start":null,"end":"2020-01-01T00:09"}]}"#,
        )
        .unwrap();
        assert_eq!(f.timestamp_ranges.len(), 2);
        assert!(f.timestamp_ranges[0].end.is_none());
        let g: PreviewFilter = serde_json::from_str("{}").unwrap();
        assert!(g.timestamp_ranges.is_empty());
    }
}

/// Fits the Relationship model via the sidecar on filtered, NaN-dropped rows; with `cache_key` caches the full fit (`NOT_FITTED` if unknown).
/// With `max_points` the response arrays are one aligned strided sample; the cache keeps full arrays. The same run pre-warms hourly predictions.
#[tauri::command(rename_all = "snake_case")]
async fn preview_relationship_model(
    predictors: Vec<String>,
    target: String,
    lambda: f64,
    filter: Option<PreviewFilter>,
    cache_key: Option<String>,
    max_points: Option<usize>,
    test_periods: Option<Vec<health_validation::TestPeriodArg>>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    if predictors.is_empty() {
        return Err("At least one predictor is required.".into());
    }
    if target.is_empty() {
        return Err("Target sensor is required.".into());
    }

    // The sidecar gets pre-cleaned arrays (Rust projects columns and drops NaN/non-finite rows); drop the lock before any await.
    let (x_matrix, y_vector, row_idx, stamp, extra_points) = {
        let state_lock = state.0.read().map_err(|e| e.to_string())?;
        let session = state_lock.as_ref().ok_or("No data loaded")?;
        let data = &session.data;
        // Captured under the same read lock that copies the columns below.
        let stamp = session.stamp();

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

        let resolved = ResolvedFilter::resolve(filter.as_ref(), &data.headers)?;

        let pred_cols: Vec<&[f64]> = predictor_indices
            .iter()
            .map(|&i| data.columns[i].as_slice())
            .collect();
        let target_col: &[f64] = &data.columns[target_idx];

        // Shared training-row rule (also the export's training CSV); keeps each row's dataset index for timestamps.
        let mut model_cols = predictor_indices.clone();
        model_cols.push(target_idx);
        let row_idx: Vec<u32> = workspace_export::training_rows(data, &resolved, &model_cols, None);
        let x_matrix: Vec<Vec<f64>> = row_idx
            .iter()
            .map(|&r| pred_cols.iter().map(|c| c[r as usize]).collect())
            .collect();
        let y_vector: Vec<f64> = row_idx.iter().map(|&r| target_col[r as usize]).collect();

        if x_matrix.is_empty() {
            return Err("No rows remain after dropping nulls.".into());
        }

        // Hourly pre-warm: predict the training and scoring-period hours in this same run, only with a cache key.
        let extra_points = if cache_key.as_deref().is_some_and(|k| !k.is_empty()) {
            let plan = test_periods
                .as_deref()
                .filter(|t| !t.is_empty())
                .map(|periods| health_validation::TestPlan::resolve(periods, filter.as_ref(), &data.headers));
            let cols = health_validation::RelCols {
                target: target_idx,
                predictors: &predictor_indices,
            };
            let train = health_validation::RelTrain {
                rows: &row_idx,
                actual: &y_vector,
                x: health_validation::RelX::Rows(&x_matrix),
                n_pred: predictors.len(),
            };
            health_validation::RelHours::build(data, &train, plan.as_ref().map(|p| (p, &cols))).points()
        } else {
            health_score::RelHourPoints::default()
        };

        (x_matrix, y_vector, row_idx, stamp, extra_points)
    };

    let mut payload = serde_json::json!({
        "action": "preview_relationship",
        "payload": {
            "predictors": predictors,
            "target": target,
            "X": x_matrix,
            "y": y_vector,
            "smoothing": lambda,
        }
    });
    if !extra_points.is_empty() {
        payload["payload"]["X_extra"] = serde_json::json!(extra_points.x_rows());
    }

    let payload_line = signed_sidecar_line(&payload)?;
    drop(payload);

    let run = run_engine(&app, payload_line, stamp.generation).await?;
    if run.timed_out {
        return Err(report_engine_failure(&app, engine_timed_out_failure(PREVIEW_ENGINE_STEP, &run.stderr)));
    }

    // Engine text goes to the error log; the user reads a fixed sentence.
    let parsed: serde_json::Value = read_engine_answer(PREVIEW_ENGINE_STEP, &run.stdout, &run.stderr)
        .map_err(|failure| report_engine_failure(&app, failure))?;

    finish_relationship_response_ex(
        &state, stamp, parsed, &predictors, &target, lambda, &row_idx, &y_vector, &x_matrix, cache_key,
        max_points, &extra_points, &|failure| log_engine_failure(&app, failure),
    )
}

/// Log label of the `preview_relationship` engine run.
const PREVIEW_ENGINE_STEP: &str = "preview_relationship";

/// Post-sidecar work: caches the full fit, attaches `health_preview`, then bounds the arrays. Split out to test without a sidecar.
/// With `max_points`: aligned strided sample (min/max kept), `residual` dropped, `n_rows` real. Engine `error` keeps its key with the fixed sentence; `trace` removed.
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
fn finish_relationship_response(
    state: &AppState,
    stamp: SessionStamp,
    parsed: serde_json::Value,
    predictors: &[String],
    target: &str,
    lambda: f64,
    row_idx: &[u32],
    y_vector: &[f64],
    x_matrix: &[Vec<f64>],
    cache_key: Option<String>,
    max_points: Option<usize>,
) -> Result<serde_json::Value, String> {
    finish_relationship_response_ex(
        state, stamp, parsed, predictors, target, lambda, row_idx, y_vector, x_matrix, cache_key,
        max_points, &health_score::RelHourPoints::default(), &|_| {},
    )
}

/// Adds the hourly pre-warm: stores `predicted_extra` with the cached fit and strips it from the response; a bad answer stores nothing (lazy fallback).
#[allow(clippy::too_many_arguments)]
fn finish_relationship_response_ex(
    state: &AppState,
    stamp: SessionStamp,
    mut parsed: serde_json::Value,
    predictors: &[String],
    target: &str,
    lambda: f64,
    row_idx: &[u32],
    y_vector: &[f64],
    x_matrix: &[Vec<f64>],
    cache_key: Option<String>,
    max_points: Option<usize>,
    extra_points: &health_score::RelHourPoints,
    log_engine: &dyn Fn(&EngineFailure),
) -> Result<serde_json::Value, String> {
    // First of all: the engine's own error text never leaves this function.
    if let Some(failure) = take_engine_error(&mut parsed, PREVIEW_ENGINE_STEP) {
        log_engine(&failure);
    }
    let predicted_extra: Option<Vec<f64>> = parsed
        .as_object_mut()
        .and_then(|o| o.remove("predicted_extra"))
        .and_then(|v| {
            let a = v.as_array()?;
            (!extra_points.is_empty() && a.len() == extra_points.len()).then(|| {
                a.iter()
                    .map(|x| x.as_f64().filter(|x| x.is_finite()).unwrap_or(f64::NAN))
                    .collect()
            })
        });
    let cache_key = cache_key.filter(|k| !k.is_empty());
    if let Some(key) = cache_key {
        if parsed.get("error").is_none() {
            if let Some(fit) =
                rel_fit_from_response(&parsed, predictors, target, lambda, row_idx, y_vector, x_matrix)
            {
                // The hourly predictions of this very fit, as it just answered.
                let seeded = predicted_extra
                    .as_deref()
                    .and_then(|preds| health_score::RelExtra::new(extra_points, preds));
                let bounded = {
                    let lock = state.0.read().map_err(|e| e.to_string())?;
                    lock.as_ref()
                        .filter(|s| s.stamp() == stamp)
                        .and_then(|s| {
                            let req = health_preview::HealthPreviewRequest {
                                kind: "relationship".into(),
                                target: Some(target.to_string()),
                                predictors: predictors.to_vec(),
                                max_points,
                                ..Default::default()
                            };
                            health_preview::relationship_preview_ex(&s.data, &fit, seeded.as_ref(), &req)
                                .ok()
                        })
                };
                let stored = store_rel_fit_ex(state, stamp, key.clone(), fit);
                let cached = stored.is_some();
                // Pre-warm this fit only; not stored if over budget or the session/fit changed (lazy fallback).
                if let (Some(handle), Some(preds)) = (stored.as_ref(), predicted_extra.as_deref()) {
                    merge_rel_extra(state, stamp, &key, handle, extra_points, preds);
                }
                if let Some(obj) = parsed.as_object_mut() {
                    obj.insert("cache_key".into(), serde_json::Value::String(key));
                    obj.insert("cached".into(), serde_json::Value::Bool(cached));
                    if let Some(b) = bounded.and_then(|b| serde_json::to_value(b).ok()) {
                        obj.insert("health_preview".into(), b);
                    }
                }
            }
        }
    }

    shape_relationship_arrays(&mut parsed, x_matrix, y_vector, max_points);
    Ok(parsed)
}

/// Rows kept on top of the stride sample: argmin / argmax of the target and of
/// the prediction.
const REL_SAMPLE_EXTREMES: usize = 4;

/// Even stride over 0..n plus the min/max rows of `y` and `predicted`, so extremes are drawn; all rows when n <= max_points.
fn relationship_sample_indices(
    n: usize,
    max_points: usize,
    y: &[f64],
    predicted: Option<&[Option<f64>]>,
) -> Vec<usize> {
    let max_points = max_points.max(1);
    if n <= max_points {
        return (0..n).collect();
    }
    // Too small a cap to spare room for the extremes: plain stride.
    let reserve = if max_points >= 8 { REL_SAMPLE_EXTREMES } else { 0 };
    let k = max_points - reserve;
    let mut idx: Vec<usize> = (0..k).map(|i| i * n / k).collect();
    if reserve > 0 {
        let mut extremes = |values: &mut dyn Iterator<Item = (usize, f64)>| {
            let mut mn: Option<(usize, f64)> = None;
            let mut mx: Option<(usize, f64)> = None;
            for (i, v) in values {
                if !v.is_finite() {
                    continue;
                }
                if mn.is_none_or(|(_, m)| v < m) {
                    mn = Some((i, v));
                }
                if mx.is_none_or(|(_, m)| v > m) {
                    mx = Some((i, v));
                }
            }
            idx.extend(mn.map(|(i, _)| i));
            idx.extend(mx.map(|(i, _)| i));
        };
        extremes(&mut y.iter().copied().enumerate().take(n));
        if let Some(p) = predicted {
            extremes(&mut p.iter().enumerate().take(n).filter_map(|(i, v)| v.map(|v| (i, v))));
        }
    }
    idx.sort_unstable();
    idx.dedup();
    idx
}

/// Attaches `predictor_raw`/`target_raw`/`n_rows`; with `max_points`, bounds arrays to one aligned sample and drops `residual`.
fn shape_relationship_arrays(
    parsed: &mut serde_json::Value,
    x_matrix: &[Vec<f64>],
    y: &[f64],
    max_points: Option<usize>,
) {
    let n = y.len();
    let Some(obj) = parsed.as_object_mut() else {
        return;
    };
    obj.insert("n_rows".to_string(), serde_json::json!(n));
    let Some(cap) = max_points else {
        // No `max_points`: every row.
        obj.insert("predictor_raw".to_string(), serde_json::json!(x_matrix));
        obj.insert("target_raw".to_string(), serde_json::json!(y));
        return;
    };
    // The prediction array only takes part when it lines up with the rows.
    let pred_full: Option<Vec<Option<f64>>> = obj
        .get("predicted")
        .and_then(|v| v.as_array())
        .filter(|a| a.len() == n)
        .map(|a| a.iter().map(|v| v.as_f64()).collect());
    let idx = relationship_sample_indices(n, cap, y, pred_full.as_deref());
    obj.insert(
        "predictor_raw".to_string(),
        serde_json::Value::Array(idx.iter().map(|&i| serde_json::json!(x_matrix[i])).collect()),
    );
    obj.insert(
        "target_raw".to_string(),
        serde_json::Value::Array(idx.iter().map(|&i| serde_json::json!(y[i])).collect()),
    );
    if let Some(p) = pred_full {
        obj.insert(
            "predicted".to_string(),
            serde_json::Value::Array(idx.iter().map(|&i| serde_json::json!(p[i])).collect()),
        );
    }
    obj.remove("residual");
}

/// Cacheable full fit from the response; `None` if `predicted` is missing or the wrong length. Input row-major, stored column-major.
fn rel_fit_from_response(
    parsed: &serde_json::Value,
    predictors: &[String],
    target: &str,
    lambda: f64,
    row_idx: &[u32],
    y: &[f64],
    x_matrix: &[Vec<f64>],
) -> Option<health_score::RelFit> {
    let n = y.len();
    let pred_arr = parsed.get("predicted")?.as_array()?;
    if pred_arr.len() != n || row_idx.len() != n || x_matrix.len() != n {
        return None;
    }
    let predicted: Vec<f64> = pred_arr
        .iter()
        .map(|v| v.as_f64().filter(|x| x.is_finite()).unwrap_or(f64::NAN))
        .collect();
    let nums = |key: &str| -> Vec<f64> {
        parsed
            .get(key)
            .and_then(|v| v.as_array())
            .map(|a| a.iter().map(|v| v.as_f64().unwrap_or(f64::NAN)).collect())
            .unwrap_or_default()
    };
    let x_cols: Vec<Vec<f64>> = (0..predictors.len())
        .map(|k| x_matrix.iter().map(|row| row[k]).collect())
        .collect();
    Some(health_score::RelFit {
        target: target.to_string(),
        predictors: predictors.to_vec(),
        lambda,
        rows: row_idx.to_vec(),
        actual: y.to_vec(),
        predicted,
        x_cols,
        r2_per_step: nums("r2_per_step"),
        rmse2_per_step: nums("rmse2_per_step"),
    })
}


/// Rounds mean/SD and derives 1SD/3SD bounds from the rounded values; `round_metric` keeps 4 significant digits for tiny SD.
/// Constant sensor (SD = 0): every bound equals the mean; the health score guards it.
fn individual_rounded_metrics(mean: f64, sd: f64) -> (f64, f64, [f64; 2], [f64; 2]) {
    use metrics::{round_metric, round_metric_scaled};
    let sd_r = round_metric(sd);
    let mean_r = round_metric_scaled(mean, sd_r);
    let b1 = [
        round_metric_scaled(mean_r - sd_r, sd_r),
        round_metric_scaled(mean_r + sd_r, sd_r),
    ];
    let b3 = [
        round_metric_scaled(mean_r - 3.0 * sd_r, sd_r),
        round_metric_scaled(mean_r + 3.0 * sd_r, sd_r),
    ];
    (mean_r, sd_r, b1, b3)
}

/// Half-open `min < v <= max`; `None` = unbounded that side. Assign rows via `health_score::assign_cluster`, which also opens outer edges with 2+ ranges.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClusterRange {
    pub min: Option<f64>,
    pub max: Option<f64>,
}

impl ClusterRange {
    /// `(min, max)` tuples for `assign_cluster`; selecting over several ranges must use it, not `contains`.
    pub(crate) fn bounds(ranges: &[ClusterRange]) -> Vec<(Option<f64>, Option<f64>)> {
        ranges.iter().map(|r| (r.min, r.max)).collect()
    }

    #[cfg_attr(not(test), allow(dead_code))]
    fn contains(&self, v: f64) -> bool {
        if let Some(lo) = self.min {
            if v <= lo { return false; }
        }
        if let Some(hi) = self.max {
            if v > hi { return false; }
        }
        true
    }
}

#[derive(Debug, Serialize)]
pub struct ClusterDetail {
    /// 1-based cluster id.
    pub cluster_id: u32,
    /// `None` for the single-cluster path (no criteria split).
    pub range: Option<ClusterRange>,
    pub n_rows: usize,
    pub ellipse: clustering::EllipseFit,
}

#[derive(Debug, Serialize)]
pub struct ClusteringPreview {
    pub first_sensor: String,
    pub second_sensor: String,
    /// Set when `n_clusters > 1`, else `None`.
    pub criteria_sensor: Option<String>,
    pub cluster_count: u32,
    /// Total rows assigned across all clusters (sum of `clusters[*].n_rows`).
    pub n_rows: usize,
    /// One entry per cluster, in cluster_id order (1..=N).
    pub clusters: Vec<ClusterDetail>,
}

/// One ellipse per cluster. n_clusters == 1: all rows, ignores criteria/ranges. > 1: needs `criteria_sensor` and `cluster_ranges`; rows with criteria in `(min, max]`.
#[tauri::command(rename_all = "snake_case")]
async fn compute_clustering_preview(
    first_sensor: String,
    second_sensor: String,
    n_clusters: u32,
    criteria_sensor: Option<String>,
    cluster_ranges: Option<Vec<ClusterRange>>,
    // With a filter, the fit uses the filtered slice.
    filter: Option<PreviewFilter>,
    app: tauri::AppHandle,
) -> Result<ClusteringPreview, String> {
    on_blocking_pool(app, move |state| {
        let state_lock = state.0.read().map_err(|e| e.to_string())?;
        let session = state_lock.as_ref().ok_or("No data loaded")?;
        clustering_preview_in(
            &session.data,
            first_sensor,
            second_sensor,
            n_clusters,
            criteria_sensor,
            cluster_ranges,
            filter,
        )
    })
    .await
}

/// Pure core of `compute_clustering_preview`, shared with health score and export so numbers agree.
fn clustering_preview_in(
    data: &ColumnarData,
    first_sensor: String,
    second_sensor: String,
    n_clusters: u32,
    criteria_sensor: Option<String>,
    cluster_ranges: Option<Vec<ClusterRange>>,
    filter: Option<PreviewFilter>,
) -> Result<ClusteringPreview, String> {
    if n_clusters == 0 {
        return Err("n_clusters must be at least 1".into());
    }
    if first_sensor.is_empty() || second_sensor.is_empty() {
        return Err("Both sensors are required.".into());
    }

    let i1 = data
        .headers
        .iter()
        .position(|h| h == &first_sensor)
        .ok_or_else(|| format!("Sensor not found: {}", first_sensor))?;
    let i2 = data
        .headers
        .iter()
        .position(|h| h == &second_sensor)
        .ok_or_else(|| format!("Sensor not found: {}", second_sensor))?;

    let resolved = ResolvedFilter::resolve(filter.as_ref(), &data.headers)?;

    if n_clusters == 1 {
        let c1 = &data.columns[i1];
        let c2 = &data.columns[i2];
        let mut xs: Vec<f64> = Vec::with_capacity(data.n_rows());
        let mut ys: Vec<f64> = Vec::with_capacity(data.n_rows());
        for r in 0..data.n_rows() {
            if !resolved.is_noop() && !resolved.keeps(data, r) {
                continue;
            }
            let x = c1[r];
            if !x.is_finite() {
                continue;
            }
            let y = c2[r];
            if !y.is_finite() {
                continue;
            }
            xs.push(x);
            ys.push(y);
        }
        if xs.is_empty() {
            return Err("No rows remain after dropping nulls.".into());
        }
        let ellipse = clustering::fit_single_cluster_ellipse(&xs, &ys)?;
        let n_rows = xs.len();
        return Ok(ClusteringPreview {
            first_sensor,
            second_sensor,
            criteria_sensor: None,
            cluster_count: 1,
            n_rows,
            clusters: vec![ClusterDetail {
                cluster_id: 1,
                range: None,
                n_rows,
                ellipse,
            }],
        });
    }

    let criteria = criteria_sensor
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "criteria_sensor is required when n_clusters > 1".to_string())?;
    let ranges = cluster_ranges
        .ok_or_else(|| "cluster_ranges is required when n_clusters > 1".to_string())?;
    if ranges.len() as u32 != n_clusters {
        return Err(format!(
            "cluster_ranges length ({}) must equal n_clusters ({})",
            ranges.len(),
            n_clusters
        ));
    }
    let ic = data
        .headers
        .iter()
        .position(|h| h == &criteria)
        .ok_or_else(|| format!("Criteria sensor not found: {}", criteria))?;

    let c1 = &data.columns[i1];
    let c2 = &data.columns[i2];
    let cc = &data.columns[ic];

    // One rule with the health score and the export (outer edges open with
    // >= 2 ranges; first match wins on an overlap).
    let bounds = ClusterRange::bounds(&ranges);
    let assigner = health_score::ClusterAssigner::new(&bounds);
    let mut points: Vec<(Vec<f64>, Vec<f64>)> = vec![(Vec::new(), Vec::new()); ranges.len()];
    for r in 0..data.n_rows() {
        if !resolved.is_noop() && !resolved.keeps(data, r) {
            continue;
        }
        let Some(k) = assigner.assign(cc[r]) else {
            continue;
        };
        let (x, y) = (c1[r], c2[r]);
        if x.is_finite() && y.is_finite() {
            points[k].0.push(x);
            points[k].1.push(y);
        }
    }

    let mut clusters: Vec<ClusterDetail> = Vec::with_capacity(ranges.len());
    let mut total_rows: usize = 0;
    for (idx, (range, (xs, ys))) in ranges.iter().zip(&points).enumerate() {
        let cluster_id = (idx + 1) as u32;
        if xs.is_empty() {
            return Err(format!(
                "Cluster {} has no rows after applying its criteria range.",
                cluster_id
            ));
        }
        let ellipse = clustering::fit_single_cluster_ellipse(xs, ys)?;
        let n_rows = xs.len();
        total_rows += n_rows;
        clusters.push(ClusterDetail {
            cluster_id,
            range: Some(range.clone()),
            n_rows,
            ellipse,
        });
    }

    Ok(ClusteringPreview {
        first_sensor,
        second_sensor,
        criteria_sensor: Some(criteria),
        cluster_count: n_clusters,
        n_rows: total_rows,
        clusters,
    })
}

#[derive(Debug, Deserialize)]
struct SingleOperation {
    #[serde(rename = "type")]
    op_type: String,
    value: f64,
}

#[derive(Debug, Deserialize, Clone)]
struct MultiOperation {
    #[serde(rename = "type")]
    op_type: String,
    /// Decimal places to round each result to, half away from zero; absent/null = unrounded. Read as a number so `2.0` is accepted.
    #[serde(default)]
    decimals: Option<f64>,
}

/// Upper bound for `MultiOperation::decimals` (beyond ~10 places an f64 sensor
/// value has no digits left to round).
const MAX_OPERATION_DECIMALS: f64 = 10.0;

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

/// Trimmed lower-case key for lookup/collision, matching the frontend's case-insensitive `sameTag`.
fn name_key(name: &str) -> String {
    name.trim().to_lowercase()
}

/// First header equal to `name` ignoring case and surrounding whitespace.
fn find_column_ci(headers: &[String], name: &str) -> Option<usize> {
    let key = name_key(name);
    headers.iter().position(|h| name_key(h) == key)
}

/// Exact match first, then trimmed case-insensitive; all readers use it so they agree.
fn resolve_sensor(headers: &[String], name: &str) -> Option<usize> {
    headers
        .iter()
        .position(|h| h == name)
        .or_else(|| find_column_ci(headers, name))
}

/// Stores a computed column; returns the trimmed name actually stored (give THAT to the frontend). Compares trimmed, case-insensitive.
/// Create: name must not exist (raw or derived). Replace: overwrites a derived column in place, appends if absent, Err on raw/timestamp. Nothing mutates on Err.
fn store_derived_column(
    data: &mut ColumnarData,
    derived: &mut std::collections::HashSet<String>,
    name: &str,
    col: Vec<f64>,
    replace: bool,
) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Sensor name cannot be empty".to_string());
    }
    if col.len() != data.n_rows() {
        return Err(format!(
            "Computed column has {} rows but the dataset has {}",
            col.len(),
            data.n_rows()
        ));
    }
    let key = name_key(name);
    match find_column_ci(&data.headers, name) {
        Some(idx) => {
            if !replace {
                return Err(format!("A sensor named '{}' already exists", name));
            }
            if idx == 0 || !derived.contains(&key) {
                return Err(format!(
                    "'{}' is an imported data column and cannot be overwritten",
                    name
                ));
            }
            data.columns[idx] = col;
            data.headers[idx] = name.to_string();
        }
        None => {
            data.columns.push(col);
            data.headers.push(name.to_string());
            derived.insert(key);
        }
    }
    Ok(name.to_string())
}

/// Drops derived columns by name (trimmed, case-insensitive); raw and timestamp columns are skipped. Returns the count removed.
fn remove_derived_columns(
    data: &mut ColumnarData,
    derived: &mut std::collections::HashSet<String>,
    names: &[String],
) -> usize {
    let mut removed = 0;
    for name in names {
        let key = name_key(name);
        if !derived.remove(&key) {
            continue;
        }
        if let Some(idx) = find_column_ci(&data.headers, name) {
            if idx != 0 {
                data.headers.remove(idx);
                data.columns.remove(idx);
                removed += 1;
            }
        }
    }
    removed
}

/// Stores under a short write lock (compute ran under a read lock); re-checks `generation` and the caller's `expected` under that same lock.
fn commit_derived(
    state: &AppState,
    generation: u64,
    expected: Option<u64>,
    name: &str,
    col: Vec<f64>,
    replace: bool,
) -> Result<String, String> {
    let mut lock = state.0.write().map_err(|e| e.to_string())?;
    let session = lock.as_mut().ok_or_else(|| missing_session_error(expected))?;
    check_expected_generation(expected, session.generation)?;
    if session.generation != generation {
        return Err("The dataset changed while the sensor was being computed; please try again".to_string());
    }
    let stored = store_derived_column(&mut session.data, &mut session.derived, name, col, replace)?;
    if replace {
        // An in-place recompute may change a cached fit's inputs, so clear the cache.
        session.rel_cache.clear();
    }
    Ok(stored)
}

/// Error for "no dataset loaded": a caller that pinned a generation is by
/// definition stale (the dataset it was bound to is gone).
fn missing_session_error(expected: Option<u64>) -> String {
    if expected.is_some() {
        STALE_SESSION_ERROR.to_string()
    } else {
        "No data loaded".to_string()
    }
}

fn remove_derived_in_state(
    state: &AppState,
    names: &[String],
    expected: Option<u64>,
) -> Result<usize, String> {
    let mut lock = state.0.write().map_err(|e| e.to_string())?;
    match lock.as_mut() {
        // Nothing loaded: Ok(0), unless the caller pinned a generation, then stale.
        None if expected.is_some() => Err(STALE_SESSION_ERROR.to_string()),
        None => Ok(0),
        Some(session) => {
            check_expected_generation(expected, session.generation)?;
            let removed = remove_derived_columns(&mut session.data, &mut session.derived, names);
            if removed > 0 {
                // Same reason as in `commit_derived`: a cached fit may have
                // been built on a column that just disappeared.
                session.rel_cache.clear();
            }
            Ok(removed)
        }
    }
}

/// Call on delete and for the old name after rename, or the stale column shadows the next sensor of that name. Only derived columns are removed.
/// Keeps default camelCase keys (`expectedGeneration`); a mismatch returns `STALE_SESSION_ERROR` and removes nothing.
#[tauri::command]
async fn remove_sensor_columns(
    names: Vec<String>,
    expected_generation: Option<u64>,
    app: tauri::AppHandle,
) -> Result<usize, String> {
    let _serial = SENSOR_CHANGE_LOCK.lock().await;
    on_blocking_pool(app, move |state| remove_derived_in_state(state, &names, expected_generation)).await
}

/// User-facing name of a multi operation in messages.
fn multi_op_label(op_type: &str) -> &'static str {
    match op_type {
        "mean" => "Average",
        "median" => "Median",
        "sum" => "Sum",
        _ => "This operation",
    }
}

/// Shared check for Sum/Average/Median blocks (create, edit, replay, `preview_formula`). `require_two` is off for replay so one-source recipes saved earlier restore.
fn check_multi_operation(
    headers: &[String],
    sensors: &[String],
    op: &MultiOperation,
    require_two: bool,
) -> Result<Vec<usize>, FormulaIssue> {
    use formula_diagnostics::{issue_at, AGG_TOO_FEW, BAD_DECIMALS, UNKNOWN_OPERATION, UNKNOWN_SENSOR};
    if sensors.is_empty() {
        return Err(issue_at("", AGG_TOO_FEW, "No sensors selected", None));
    }
    let mut indices = Vec::with_capacity(sensors.len());
    for sensor in sensors {
        match resolve_sensor(headers, sensor) {
            Some(idx) => indices.push(idx),
            None => return Err(issue_at("", UNKNOWN_SENSOR, format!("Sensor not found: {}", sensor), None)),
        }
    }
    if let Err(e) = operation_registry::multi_op_name(&op.op_type) {
        return Err(issue_at("", UNKNOWN_OPERATION, e, None));
    }
    if require_two && sensors.len() < 2 {
        return Err(issue_at(
            "",
            AGG_TOO_FEW,
            format!("{} needs at least 2 sensors.", multi_op_label(&op.op_type)),
            None,
        ));
    }
    if let Some(d) = op.decimals {
        if !(d.is_finite() && d.fract() == 0.0 && (0.0..=MAX_OPERATION_DECIMALS).contains(&d)) {
            return Err(issue_at(
                "",
                BAD_DECIMALS,
                format!("Decimals must be a whole number from 0 to {} (got {}).", MAX_OPERATION_DECIMALS, d),
                None,
            ));
        }
    }
    Ok(indices)
}

/// Rounds to `d` decimals, half away from zero. Returned unchanged if `|x*10^d| >= 2^52` or non-finite; `-0.0` becomes `0.0`.
fn round_to_decimals(v: f64, decimals: f64) -> f64 {
    const EXACT_INT: f64 = 4_503_599_627_370_496.0; // 2^52
    let factor = 10f64.powi(decimals as i32);
    let scaled = v * factor;
    if scaled.is_nan() || scaled.abs() >= EXACT_INT {
        return v;
    }
    let r = scaled.round() / factor;
    if r == 0.0 {
        0.0
    } else {
        r
    }
}

/// Rows per parallel chunk of a computed column (formula and multi-op
/// builders), and the granularity of a preview's cancellation check.
const COLUMN_CHUNK: usize = 16_384;

/// Checked once per chunk; only `preview_formula` ever cancels.
type CancelCheck<'a> = &'a (dyn Fn() -> bool + Sync);

fn never_cancelled() -> bool {
    false
}

/// `Err` of a preview superseded by a newer `preview_formula` request.
const FORMULA_PREVIEW_CANCELLED: &str = "CANCELLED: a newer formula preview replaced this one";

/// `sum` needs every source; `mean`/`median` skip missing; non-finite is missing; `decimals` rounds last. Chunks write straight into the preallocated output.
fn compute_multi_column(
    data: &ColumnarData,
    indices: &[usize],
    op: &MultiOperation,
    cancelled: CancelCheck,
) -> Result<Vec<f64>, String> {
    use rayon::prelude::*;
    let f = operation_registry::multi_op_fn(&op.op_type)?;
    let needs_all = operation_registry::multi_op_needs_all_inputs(&op.op_type);
    let src_cols: Vec<&[f64]> = indices.iter().map(|&i| data.columns[i].as_slice()).collect();
    let n = data.n_rows();
    let mut new_col: Vec<f64> = vec![0.0; n];
    new_col.par_chunks_mut(COLUMN_CHUNK).enumerate().try_for_each(|(c, out)| {
        if cancelled() {
            return Err(FORMULA_PREVIEW_CANCELLED.to_string());
        }
        let start = c * COLUMN_CHUNK;
        let mut valid: Vec<f64> = Vec::with_capacity(src_cols.len());
        for (k, slot) in out.iter_mut().enumerate() {
            let r = start + k;
            valid.clear();
            for col in &src_cols {
                let v = col[r];
                if !v.is_nan() {
                    valid.push(v);
                }
            }
            // `sum` (needs_all): any missing source makes the row missing; others use what is left; all-missing stays missing.
            let skip = valid.is_empty() || (needs_all && valid.len() != src_cols.len());
            let mut v = if skip { f64::NAN } else { f(&valid).unwrap_or(f64::NAN) };
            if let Some(d) = op.decimals {
                v = round_to_decimals(v, d);
            }
            *slot = if v.is_finite() { v } else { f64::NAN };
        }
        Ok(())
    })?;
    Ok(new_col)
}

/// Pure core of `calculate_new_sensor`: validates and computes without touching the session.
fn compute_operation_sensor(
    data: &ColumnarData,
    sensors: &[String],
    config: &SensorOperationConfig,
    replace: bool,
) -> Result<(String, Vec<f64>), String> {
    if sensors.is_empty() {
        return Err("No sensors selected".to_string());
    }

    let mut indices = Vec::with_capacity(sensors.len());
    for sensor in sensors {
        match resolve_sensor(&data.headers, sensor) {
            Some(idx) => indices.push(idx),
            None => return Err(format!("Sensor not found: {}", sensor)),
        }
    }

    enum Op<'a> {
        Single(&'a SingleOperation),
        Multi(&'a MultiOperation),
    }
    let (op, default_name) = match config.mode.as_str() {
        "single" => {
            if sensors.len() != 1 {
                return Err("Single mode requires exactly one sensor".to_string());
            }
            let op = config.single_op.as_ref().ok_or("Missing singleOp config")?;
            let symbol = operation_registry::single_op_symbol(&op.op_type)?;
            (Op::Single(op), format!("{} {} {}", sensors[0], symbol, op.value))
        }
        "multi" => {
            let op = config.multi_op.as_ref().ok_or("Missing multiOp config")?;
            // Replay (`replace`) accepts a one-source block.
            check_multi_operation(&data.headers, sensors, op, !replace)?;
            let op_name = operation_registry::multi_op_name(&op.op_type)?;
            // Decimals are in the default name so rounding variants don't clash; no decimals keeps the plain name so saved recipes replay.
            let default_name = match op.decimals {
                Some(d) => format!("{}({:?}, {}dp)", op_name, sensors, d),
                None => format!("{}({:?})", op_name, sensors),
            };
            (Op::Multi(op), default_name)
        }
        _ => return Err("Invalid mode".to_string()),
    };

    let name = match config.custom_name.as_deref().map(str::trim) {
        Some(n) if !n.is_empty() => n.to_string(),
        _ => default_name.trim().to_string(),
    };

    // Must not read the column it overwrites, or the sensor would drift on every save.
    if replace {
        if let Some(target) = find_column_ci(&data.headers, &name) {
            if indices.contains(&target) {
                return Err(format!("'{}' cannot be built from itself", name));
            }
        }
    } else if find_column_ci(&data.headers, &name).is_some() {
        // Fail fast, before the (possibly long) computation.
        return Err(format!("A sensor named '{}' already exists", name));
    }

    // The whole column is built before anything touches the session, so an
    // error part-way can't leave the dataset half-mutated.
    let new_col = match op {
        Op::Single(op) => {
            // Non-finite results become missing: `inf` poisons downstream stats and axes.
            let finite = |v: f64| if v.is_finite() { v } else { f64::NAN };
            let f = operation_registry::single_op_fn(&op.op_type)?;
            data.columns[indices[0]]
                .iter()
                .map(|&v| if v.is_nan() { f64::NAN } else { f(v, op.value).map(finite).unwrap_or(f64::NAN) })
                .collect()
        }
        Op::Multi(op) => compute_multi_column(data, &indices, op, &never_cancelled)?,
    };

    Ok((name, new_col))
}

/// Session-level version; `between` runs between compute and commit, a test seam to simulate a dataset swap.
fn calculate_sensor_in_state(
    state: &AppState,
    sensors: &[String],
    config: &SensorOperationConfig,
    replace: bool,
    expected: Option<u64>,
    between: &dyn Fn(),
) -> Result<String, String> {
    // Compute under a READ lock (other queries keep running), store under a
    // short write lock.
    let (generation, name, col) = {
        let lock = state.0.read().map_err(|e| e.to_string())?;
        let session = lock.as_ref().ok_or_else(|| missing_session_error(expected))?;
        check_expected_generation(expected, session.generation)?;
        let (name, col) = compute_operation_sensor(&session.data, sensors, config, replace)?;
        (session.generation, name, col)
    };
    between();
    commit_derived(state, generation, expected, &name, col, replace)
}

/// `expected_generation` (JS `expectedGeneration`) must match the dataset's generation, else `STALE_SESSION_ERROR` and nothing changes.
#[tauri::command]
async fn calculate_new_sensor(
    sensors: Vec<String>,
    config: SensorOperationConfig,
    replace: Option<bool>,
    expected_generation: Option<u64>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let _serial = SENSOR_CHANGE_LOCK.lock().await;
    on_blocking_pool(app, move |state| {
        calculate_sensor_in_state(
            state,
            &sensors,
            &config,
            replace.unwrap_or(false),
            expected_generation,
            &|| {},
        )
    })
    .await
}


/// Char-index span (end exclusive) of a ref, so edits avoid blind replace corrupting prefixes (`$A` inside `$A.PV`).
struct SensorRefSpan {
    start: usize,
    end: usize,
    token: String,
    name: String,
}

/// The one sensor-ref tokenizer. `$Name` runs over alphanumerics, `_`, `.`; `${...}` takes anything up to the first `}`. Unclosed `${` or `${}` yields none.
fn scan_sensor_refs(formula: &str) -> Vec<SensorRefSpan> {
    let mut refs = Vec::new();
    let chars: Vec<char> = formula.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        if chars[i] == '$' {
            if i + 1 < len && chars[i + 1] == '{' {
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
                        refs.push(SensorRefSpan { start, end: j + 1, token, name });
                    }
                    i = j + 1;
                } else {
                    i += 1;
                }
            } else if i + 1 < len && (chars[i + 1].is_alphanumeric() || chars[i + 1] == '_') {
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
                    refs.push(SensorRefSpan { start, end: j, token, name });
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

/// Returns (token, name) pairs in order of appearance.
fn extract_sensor_refs(formula: &str) -> Vec<(String, String)> {
    scan_sensor_refs(formula)
        .into_iter()
        .map(|s| (s.token, s.name))
        .collect()
}

/// Lets the Special Sensors view find dependencies with this parser; substring matching is wrong (`test` vs `test extend`). One de-duplicated list per formula, same order.
#[tauri::command]
fn extract_formula_refs(formulas: Vec<String>) -> Vec<Vec<String>> {
    formulas
        .iter()
        .map(|formula| {
            let mut seen = std::collections::HashSet::new();
            extract_sensor_refs(formula)
                .into_iter()
                .map(|(_, name)| name)
                .filter(|name| seen.insert(name.clone()))
                .collect()
        })
        .collect()
}

/// Bare `$Name` only for non-empty alphanumeric/`_` names, else braced `${name}`: a bare `Total-Power` would re-parse as `$Total` minus `Power`.
/// TS twin `sensorRef()` in `useCalculationEngine.ts` must follow the same rule; a name containing `}` cannot be expressed.
fn sensor_ref_token(name: &str) -> String {
    if !name.is_empty() && name.chars().all(|c| c.is_alphanumeric() || c == '_') {
        format!("${}", name)
    } else {
        format!("${{{}}}", name)
    }
}

/// Rewrites refs to `old_name` with the shared tokenizer, not string replace, so a prefix name (`$test` in `$testA`) isn't corrupted. Trimmed, case-insensitive; other text unchanged.
fn rewrite_sensor_ref(formula: &str, old_name: &str, new_name: &str) -> String {
    let old_key = name_key(old_name);
    let chars: Vec<char> = formula.chars().collect();
    let new_token = sensor_ref_token(new_name.trim());
    let mut out = String::with_capacity(formula.len());
    let mut pos = 0;

    for span in scan_sensor_refs(formula) {
        if name_key(&span.name) == old_key {
            out.extend(chars[pos..span.start].iter());
            out.push_str(&new_token);
            pos = span.end;
        }
    }
    out.extend(chars[pos..].iter());
    out
}

/// Exposed so renaming a special sensor carries into other formulas using the same parser; a TS string replace would corrupt prefix names.
#[tauri::command]
fn rename_formula_refs(formula: String, old_name: String, new_name: String) -> String {
    rewrite_sensor_ref(&formula, &old_name, &new_name)
}

/// Rewrites refs to short variables (`_0`, `_1`), one per distinct sensor. Built from tokenizer spans, not `replace` (`$11PT1214A` would eat the front of `$11PT1214A.PV`).
/// Prefix is one `_` longer than any `_` run outside refs, so a typed `_0` never matches; a space is inserted when a ref touches a letter/digit/`_`/`.`, so `${A}0` can't fuse into `_10`.
fn prepare_formula_for_eval(formula: &str) -> (String, Vec<(String, String)>) {
    let (expr, safe_names, _) = prepare_formula_for_eval_mapped(formula);
    (expr, safe_names)
}

/// Also maps each byte of the rewritten text to its source char index, so fasteval error positions can be shown in the user's own text.
fn prepare_formula_for_eval_mapped(formula: &str) -> (String, Vec<(String, String)>, Vec<usize>) {
    let chars: Vec<char> = formula.chars().collect();
    let spans = scan_sensor_refs(formula);

    let mut longest_run = 0usize;
    {
        let mut run = 0usize;
        let mut pos = 0usize;
        let mut scan = |seg: &[char], run: &mut usize| {
            for c in seg {
                if *c == '_' {
                    *run += 1;
                    longest_run = longest_run.max(*run);
                } else {
                    *run = 0;
                }
            }
        };
        for span in &spans {
            scan(&chars[pos..span.start], &mut run);
            run = 0; // a reference breaks the run
            pos = span.end;
        }
        scan(&chars[pos..], &mut run);
    }
    let prefix = "_".repeat(longest_run + 1);

    let mut expr = String::with_capacity(formula.len() + 8);
    let mut map: Vec<usize> = Vec::with_capacity(formula.len() + 9);
    let mut safe_names: Vec<(String, String)> = Vec::new();
    let mut pos = 0;

    let push_chars = |expr: &mut String, map: &mut Vec<usize>, from: usize, to: usize| {
        for (k, c) in chars[from..to].iter().enumerate() {
            expr.push(*c);
            map.extend(std::iter::repeat_n(from + k, c.len_utf8()));
        }
    };

    for span in &spans {
        push_chars(&mut expr, &mut map, pos, span.start);
        let idx = match safe_names.iter().position(|(_, n)| *n == span.name) {
            Some(i) => i,
            None => {
                safe_names.push((format!("{}{}", prefix, safe_names.len()), span.name.clone()));
                safe_names.len() - 1
            }
        };
        if expr.chars().last().is_some_and(is_formula_word_char) {
            expr.push(' ');
            map.push(span.start);
        }
        expr.push_str(&safe_names[idx].0);
        map.extend(std::iter::repeat_n(span.start, safe_names[idx].0.len()));
        if chars.get(span.end).is_some_and(|c| is_formula_word_char(*c)) {
            expr.push(' ');
            map.push(span.end);
        }
        pos = span.end;
    }
    push_chars(&mut expr, &mut map, pos, chars.len());
    map.push(chars.len());

    (expr, safe_names, map)
}

/// A character fasteval would glue onto an adjacent name or number.
fn is_formula_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '.'
}

/// Extra math fns (`sqrt`, `exp`, `log10`, `ln`, `pow`) via fasteval's custom-function callback, since `pow` args can be sub-expressions. `log` stays base 10; `ln` is natural.
/// Unknown name/arity returns `None` (`Error::Undefined`), which `compile_formula` turns into a refusal.
fn eval_extra_math_fn(name: &str, args: &[f64]) -> Option<f64> {
    match (name, args) {
        ("sqrt", [x]) => Some(x.sqrt()),
        ("exp", [x]) => Some(x.exp()),
        ("log10", [x]) => Some(x.log10()),
        ("ln", [x]) => Some(x.ln()),
        ("pow", [x, y]) => Some(x.powf(*y)),
        _ => None,
    }
}

/// `(name, argument count, example)` of every `eval_extra_math_fn` function,
/// for the wrong-arity error message.
const EXTRA_MATH_FNS: &[(&str, usize, &str)] = &[
    ("sqrt", 1, "sqrt($A)"),
    ("exp", 1, "exp($A)"),
    ("log10", 1, "log10($A)"),
    ("ln", 1, "ln($A)"),
    ("pow", 2, "pow($A, 2)"),
];

/// fasteval built-ins that take arguments (`pi`/`e` are handled separately).
const BUILTIN_FORMULA_FNS: &[&str] = &[
    "int", "ceil", "floor", "abs", "sign", "log", "round", "min", "max", "sin", "cos", "tan",
    "asin", "acos", "atan", "sinh", "cosh", "tanh", "asinh", "acosh", "atanh",
];

/// Shown with "unknown function" -- keep in sync with the Formula Syntax Help.
const FORMULA_FUNCTION_LIST: &str =
    "abs, sqrt, pow, exp, ln, log (base 10), log10, round, min, max, ceil, floor, sin, cos, tan, pi(), e()";

/// All accepted function names; sent to the editor by `preview_formula` (a test checks it matches both lists).
const FORMULA_FUNCTIONS: &[&str] = &[
    "abs", "sqrt", "pow", "exp", "ln", "log", "log10", "round", "min", "max", "ceil", "floor",
    "sin", "cos", "tan", "asin", "acos", "atan", "sinh", "cosh", "tanh", "asinh", "acosh", "atanh",
    "sign", "int", "pi", "e",
];

#[cfg(test)]
mod special_sensor_tests {
    use super::*;
    use std::collections::HashSet;

    const NAN: f64 = f64::NAN;

    fn dataset() -> ColumnarData {
        ColumnarData::from_parts(
            vec!["timestamp".into(), "A".into(), "B".into()],
            vec![
                Some("2020-01-01T00:00".into()),
                Some("2020-01-01T00:01".into()),
                Some("2020-01-01T00:02".into()),
            ],
            vec![
                vec![NAN; 3],
                vec![1.0, 2.0, 3.0],
                vec![10.0, 20.0, 30.0],
            ],
        )
    }

    fn dataset_with(headers: &[&str], cols: Vec<Vec<f64>>) -> ColumnarData {
        let n = cols[0].len();
        let mut h: Vec<String> = vec!["timestamp".into()];
        h.extend(headers.iter().map(|s| s.to_string()));
        let mut c = vec![vec![NAN; n]];
        c.extend(cols);
        ColumnarData::from_parts(h, (0..n).map(|i| Some(format!("2020-01-01T00:0{}", i))).collect(), c)
    }

    fn single(op: &str, v: f64, name: Option<&str>) -> SensorOperationConfig {
        SensorOperationConfig {
            mode: "single".into(),
            single_op: Some(SingleOperation { op_type: op.into(), value: v }),
            multi_op: None,
            custom_name: name.map(String::from),
        }
    }

    fn multi(op: &str, name: Option<&str>) -> SensorOperationConfig {
        SensorOperationConfig {
            mode: "multi".into(),
            single_op: None,
            multi_op: Some(MultiOperation { op_type: op.into(), decimals: None }),
            custom_name: name.map(String::from),
        }
    }

    fn strs(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn same(a: &[f64], b: &[f64]) -> bool {
        a.len() == b.len()
            && a.iter().zip(b).all(|(x, y)| (x.is_nan() && y.is_nan()) || x == y)
    }


    #[test]
    fn create_appends_and_tracks_the_column_as_derived() {
        let mut data = dataset();
        let mut derived = HashSet::new();
        let name = store_derived_column(&mut data, &mut derived, "C", vec![5.0, 6.0, 7.0], false).unwrap();
        assert_eq!(name, "C");
        assert_eq!(data.headers, vec!["timestamp", "A", "B", "C"]);
        assert_eq!(data.columns[3], vec![5.0, 6.0, 7.0]);
        assert!(derived.contains("c"));
    }

    #[test]
    fn create_over_an_existing_name_is_rejected_exact_and_different_case() {
        let mut data = dataset();
        let mut derived = HashSet::new();
        store_derived_column(&mut data, &mut derived, "Sum All", vec![1.0; 3], false).unwrap();
        for dup in ["Sum All", "sum all", "  SUM ALL  ", "A", "a", "timestamp"] {
            let err = store_derived_column(&mut data, &mut derived, dup, vec![9.0; 3], false).unwrap_err();
            assert!(err.contains("already exists"), "{dup}: {err}");
        }
        assert_eq!(data.headers, vec!["timestamp", "A", "B", "Sum All"], "nothing was appended");
        assert_eq!(data.columns[3], vec![1.0; 3], "nothing was overwritten");
    }

    #[test]
    fn stores_and_returns_the_trimmed_name() {
        let mut data = dataset();
        let mut derived = HashSet::new();
        let name = store_derived_column(&mut data, &mut derived, "  Total  ", vec![1.0; 3], false).unwrap();
        assert_eq!(name, "Total");
        assert_eq!(data.headers[3], "Total");
    }

    #[test]
    fn rejects_an_empty_name_and_a_wrong_length_column() {
        let mut data = dataset();
        let mut derived = HashSet::new();
        assert!(store_derived_column(&mut data, &mut derived, "   ", vec![1.0; 3], false).is_err());
        let err = store_derived_column(&mut data, &mut derived, "C", vec![1.0; 2], false).unwrap_err();
        assert!(err.contains("rows"), "{err}");
        assert_eq!(data.headers.len(), 3);
        assert_eq!(data.columns.len(), 3);
        assert!(derived.is_empty());
    }


    #[test]
    fn replace_overwrites_a_derived_column_in_place_keeping_its_position() {
        let mut data = dataset();
        let mut derived = HashSet::new();
        store_derived_column(&mut data, &mut derived, "X", vec![1.0; 3], false).unwrap();
        store_derived_column(&mut data, &mut derived, "Y", vec![2.0; 3], false).unwrap();
        // Different case on purpose: the sensor is the same one.
        let name = store_derived_column(&mut data, &mut derived, " x ", vec![7.0, 8.0, 9.0], true).unwrap();
        assert_eq!(name, "x");
        assert_eq!(data.headers, vec!["timestamp", "A", "B", "x", "Y"], "same slot, no second X");
        assert_eq!(data.columns[3], vec![7.0, 8.0, 9.0]);
        assert_eq!(data.columns[4], vec![2.0; 3], "Y untouched");
    }

    #[test]
    fn replace_on_a_raw_column_or_the_timestamp_column_errors_and_changes_nothing() {
        let mut data = dataset();
        let mut derived = HashSet::new();
        for raw in ["A", "a", "timestamp"] {
            let err = store_derived_column(&mut data, &mut derived, raw, vec![9.0; 3], true).unwrap_err();
            assert!(err.contains("imported"), "{raw}: {err}");
        }
        assert_eq!(data.columns[1], vec![1.0, 2.0, 3.0]);
        assert_eq!(data.headers, vec!["timestamp", "A", "B"]);
    }

    #[test]
    fn replace_of_a_name_that_is_not_there_appends() {
        // What a workspace reopen does: the recipes replay against freshly
        // loaded CSV data where none of the special sensors exist yet.
        let mut data = dataset();
        let mut derived = HashSet::new();
        store_derived_column(&mut data, &mut derived, "C", vec![5.0, 6.0, 7.0], true).unwrap();
        assert_eq!(data.headers, vec!["timestamp", "A", "B", "C"]);
        assert!(derived.contains("c"), "and it is derived, so a later replace works");
        store_derived_column(&mut data, &mut derived, "C", vec![0.0; 3], true).unwrap();
        assert_eq!(data.columns[3], vec![0.0; 3]);
    }


    /// Create X, delete X, create a new X: it must hold the new values, since lookups take the FIRST header match.
    #[test]
    fn recreate_after_remove_serves_the_new_values_on_first_lookup() {
        let mut data = dataset();
        let mut derived = HashSet::new();
        store_derived_column(&mut data, &mut derived, "X", vec![1.0, 1.0, 1.0], false).unwrap();

        // While X still exists, creating another X is refused.
        assert!(store_derived_column(&mut data, &mut derived, "X", vec![2.0; 3], false).is_err());

        let removed = remove_derived_columns(&mut data, &mut derived, &strs(&["X"]));
        assert_eq!(removed, 1);
        assert_eq!(data.headers, vec!["timestamp", "A", "B"]);

        store_derived_column(&mut data, &mut derived, "X", vec![2.0, 2.0, 2.0], false).unwrap();
        assert_eq!(data.headers.iter().filter(|h| *h == "X").count(), 1, "exactly one X");
        let first = resolve_sensor(&data.headers, "X").unwrap();
        assert_eq!(data.columns[first], vec![2.0, 2.0, 2.0], "the FIRST lookup returns the NEW values");
        assert_eq!(data.col_index("X"), Some(first));
    }

    #[test]
    fn rename_leaves_no_old_name_behind_once_the_old_column_is_removed() {
        let mut data = dataset();
        let mut derived = HashSet::new();
        store_derived_column(&mut data, &mut derived, "Old", vec![1.0; 3], false).unwrap();
        // The frontend's rename: remove the old name, create/replace the new.
        remove_derived_columns(&mut data, &mut derived, &strs(&["Old"]));
        store_derived_column(&mut data, &mut derived, "New", vec![1.0; 3], true).unwrap();
        // The old name is free to be reused with different data.
        store_derived_column(&mut data, &mut derived, "Old", vec![4.0; 3], false).unwrap();
        let i = resolve_sensor(&data.headers, "Old").unwrap();
        assert_eq!(data.columns[i], vec![4.0; 3]);
    }


    #[test]
    fn remove_never_touches_raw_or_timestamp_columns() {
        let mut data = dataset();
        let mut derived = HashSet::new();
        store_derived_column(&mut data, &mut derived, "X", vec![1.0; 3], false).unwrap();
        let removed = remove_derived_columns(&mut data, &mut derived, &strs(&["A", "B", "timestamp", "TIMESTAMP", "nope"]));
        assert_eq!(removed, 0);
        assert_eq!(data.headers, vec!["timestamp", "A", "B", "X"]);
        assert_eq!(data.columns.len(), 4);
        assert!(derived.contains("x"));
    }

    #[test]
    fn remove_matches_trimmed_case_insensitively_and_counts_correctly() {
        let mut data = dataset();
        let mut derived = HashSet::new();
        store_derived_column(&mut data, &mut derived, "X", vec![1.0; 3], false).unwrap();
        store_derived_column(&mut data, &mut derived, "Y z", vec![2.0; 3], false).unwrap();
        store_derived_column(&mut data, &mut derived, "W", vec![3.0; 3], false).unwrap();
        // "x" and " y Z " hit; "X" again (duplicate in the request), "A" (raw) and
        // "ghost" don't count.
        let removed = remove_derived_columns(&mut data, &mut derived, &strs(&["x", " y Z ", "X", "A", "ghost"]));
        assert_eq!(removed, 2);
        assert_eq!(data.headers, vec!["timestamp", "A", "B", "W"]);
        assert_eq!(data.columns.len(), data.headers.len());
        assert_eq!(data.columns[3], vec![3.0; 3], "W kept its own values after the shift");
        assert_eq!(derived, HashSet::from(["w".to_string()]));
    }


    fn app_state(generation: u64) -> AppState {
        AppState(RwLock::new(Some(SessionData {
            data: dataset(),
            derived: HashSet::new(),
            generation,
            rel_cache: Default::default(),
        })))
    }

    #[test]
    fn commit_derived_refuses_a_result_computed_from_a_replaced_dataset() {
        let state = app_state(5);
        let err = commit_derived(&state, 4, None, "X", vec![1.0; 3], false).unwrap_err();
        assert!(err.contains("changed"), "{err}");
        assert_eq!(state.0.read().unwrap().as_ref().unwrap().data.headers.len(), 3);
        assert_eq!(commit_derived(&state, 5, None, "X", vec![1.0; 3], false).unwrap(), "X");
    }

    #[test]
    fn commit_and_remove_through_the_session() {
        let state = app_state(1);
        commit_derived(&state, 1, None, "X", vec![1.0; 3], false).unwrap();
        assert!(commit_derived(&state, 1, None, "x", vec![2.0; 3], false).is_err());
        assert_eq!(remove_derived_in_state(&state, &strs(&["X", "A"]), None).unwrap(), 1);
        assert_eq!(state.0.read().unwrap().as_ref().unwrap().data.headers, vec!["timestamp", "A", "B"]);
    }

    #[test]
    fn with_no_dataset_remove_is_a_noop_and_commit_errors() {
        let state = AppState(RwLock::new(None));
        assert_eq!(remove_derived_in_state(&state, &strs(&["X"]), None).unwrap(), 0);
        assert!(commit_derived(&state, 1, None, "X", vec![], false).is_err());
    }


    fn headers_of(state: &AppState) -> Vec<String> {
        state.0.read().unwrap().as_ref().unwrap().data.headers.clone()
    }

    fn derived_of(state: &AppState) -> HashSet<String> {
        state.0.read().unwrap().as_ref().unwrap().derived.clone()
    }

    fn bump_generation(state: &AppState) {
        state.0.write().unwrap().as_mut().unwrap().generation += 1;
    }

    fn calc(state: &AppState, name: &str, replace: bool, expected: Option<u64>) -> Result<String, String> {
        calculate_sensor_in_state(
            state,
            &strs(&["A"]),
            &single("multiply", 2.0, Some(name)),
            replace,
            expected,
            &|| {},
        )
    }

    fn formula(state: &AppState, name: &str, replace: bool, expected: Option<u64>) -> Result<String, String> {
        evaluate_formula_in_state(state, "$A + 1", Some(name), replace, expected, &|| {})
    }

    #[test]
    fn stale_error_prefix_is_stable() {
        assert!(STALE_SESSION_ERROR.starts_with("STALE_SESSION"));
        assert_eq!(
            STALE_SESSION_ERROR,
            "STALE_SESSION: the dataset changed since this window was opened"
        );
    }

    #[test]
    fn matching_generation_succeeds_for_all_three_commands() {
        let state = app_state(7);
        assert_eq!(calc(&state, "C1", false, Some(7)).unwrap(), "C1");
        assert_eq!(formula(&state, "F1", false, Some(7)).unwrap(), "F1");
        assert_eq!(
            remove_derived_in_state(&state, &strs(&["C1"]), Some(7)).unwrap(),
            1
        );
        assert_eq!(headers_of(&state), vec!["timestamp", "A", "B", "F1"]);
    }

    #[test]
    fn mismatching_generation_rejects_and_mutates_nothing() {
        let state = app_state(7);
        calc(&state, "Keep", false, Some(7)).unwrap();
        let headers_before = headers_of(&state);
        let derived_before = derived_of(&state);

        for bad in [6u64, 8, 0] {
            assert_eq!(calc(&state, "N1", false, Some(bad)).unwrap_err(), STALE_SESSION_ERROR);
            // `replace` must not overwrite the derived column either.
            assert_eq!(calc(&state, "Keep", true, Some(bad)).unwrap_err(), STALE_SESSION_ERROR);
            assert_eq!(formula(&state, "N2", false, Some(bad)).unwrap_err(), STALE_SESSION_ERROR);
            assert_eq!(formula(&state, "Keep", true, Some(bad)).unwrap_err(), STALE_SESSION_ERROR);
            assert_eq!(
                remove_derived_in_state(&state, &strs(&["Keep"]), Some(bad)).unwrap_err(),
                STALE_SESSION_ERROR
            );
        }
        assert_eq!(headers_of(&state), headers_before);
        assert_eq!(derived_of(&state), derived_before);
        // The kept column still has its original values (2 * A).
        let lock = state.0.read().unwrap();
        let s = lock.as_ref().unwrap();
        assert_eq!(s.data.columns[3], vec![2.0, 4.0, 6.0]);
    }

    #[test]
    fn validate_formula_honours_an_optional_expected_generation() {
        let state = app_state(5);
        // Old callers (no generation) and a matching one get the verdict.
        let v = validate_formula_in_state(&state, "$A + 1", None).unwrap();
        assert!(v.valid && v.error.is_none());
        let v = validate_formula_in_state(&state, "$nope", Some(5)).unwrap();
        assert_eq!(v.error.as_deref(), Some("Sensor not found: nope"));
        // A window bound to another dataset gets STALE_SESSION, not a verdict.
        for bad in [4u64, 6] {
            assert_eq!(validate_formula_in_state(&state, "$A + 1", Some(bad)).unwrap_err(), STALE_SESSION_ERROR);
        }
        // No dataset: the old text without a generation, stale with one.
        let empty = AppState(RwLock::new(None));
        assert_eq!(validate_formula_in_state(&empty, "$A", None).unwrap_err(), "No data loaded");
        assert_eq!(validate_formula_in_state(&empty, "$A", Some(1)).unwrap_err(), STALE_SESSION_ERROR);
        // Size limits are still checked first.
        let deep = format!("{}$A{}", "[".repeat(65), "]".repeat(65));
        assert!(validate_formula_in_state(&state, &deep, Some(5)).unwrap_err().contains("too deeply nested"));
    }

    #[test]
    fn validate_refuses_a_formula_with_no_sensor_reference_like_create_does() {
        let v = validate_formula_against(&dataset(), "1 + 2");
        assert!(!v.valid);
        assert_eq!(v.error.as_deref(), Some(FORMULA_NO_REFS_ERROR));
        assert!(v.referenced_sensors.is_empty());
    }

    #[test]
    fn a_stale_caller_is_rejected_even_when_the_formula_or_config_is_invalid() {
        // The guard runs before the compute, so a stale window never even
        // reaches name/collision validation of the new dataset.
        let state = app_state(3);
        let err = evaluate_formula_in_state(&state, "$Nope +", None, false, Some(2), &|| {}).unwrap_err();
        assert_eq!(err, STALE_SESSION_ERROR);
    }

    #[test]
    fn generation_change_between_compute_and_commit_is_rejected() {
        // Caller pinned the (then current) generation: the swap in between is
        // detected at commit and reported as stale.
        let state = app_state(10);
        let err = calculate_sensor_in_state(
            &state,
            &strs(&["A"]),
            &single("multiply", 2.0, Some("X")),
            false,
            Some(10),
            &|| bump_generation(&state),
        )
        .unwrap_err();
        assert_eq!(err, STALE_SESSION_ERROR);
        assert_eq!(headers_of(&state), vec!["timestamp", "A", "B"]);
        assert!(derived_of(&state).is_empty());

        let state = app_state(10);
        let err = evaluate_formula_in_state(&state, "$A + 1", Some("X"), false, Some(10), &|| {
            bump_generation(&state)
        })
        .unwrap_err();
        assert_eq!(err, STALE_SESSION_ERROR);
        assert_eq!(headers_of(&state), vec!["timestamp", "A", "B"]);
        assert!(derived_of(&state).is_empty());
    }

    #[test]
    fn generation_change_between_compute_and_commit_is_rejected_without_a_pin_too() {
        // No pin: still refused, with the "changed while ..." message.
        let state = app_state(10);
        let err = calculate_sensor_in_state(
            &state,
            &strs(&["A"]),
            &single("multiply", 2.0, Some("X")),
            false,
            None,
            &|| bump_generation(&state),
        )
        .unwrap_err();
        assert!(err.contains("changed while"), "{err}");
        assert_eq!(headers_of(&state), vec!["timestamp", "A", "B"]);
    }

    #[test]
    fn dataset_removed_between_compute_and_commit_is_rejected_for_a_pinned_caller() {
        let state = app_state(10);
        let err = calculate_sensor_in_state(
            &state,
            &strs(&["A"]),
            &single("multiply", 2.0, Some("X")),
            false,
            Some(10),
            &|| {
                *state.0.write().unwrap() = None;
            },
        )
        .unwrap_err();
        assert_eq!(err, STALE_SESSION_ERROR);
    }

    #[test]
    fn none_behaves_exactly_as_before() {
        let state = app_state(7);
        assert_eq!(calc(&state, "C1", false, None).unwrap(), "C1");
        assert_eq!(formula(&state, "F1", false, None).unwrap(), "F1");
        assert!(calc(&state, "c1", false, None).is_err(), "collision rule unchanged");
        assert_eq!(calc(&state, "C1", true, None).unwrap(), "C1", "replace rule unchanged");
        assert_eq!(remove_derived_in_state(&state, &strs(&["C1", "F1", "A"]), None).unwrap(), 2);
        assert_eq!(headers_of(&state), vec!["timestamp", "A", "B"]);
    }

    #[test]
    fn with_no_dataset_a_pinned_caller_is_stale_but_an_unpinned_one_keeps_the_old_behaviour() {
        let state = AppState(RwLock::new(None));
        assert_eq!(remove_derived_in_state(&state, &strs(&["X"]), None).unwrap(), 0);
        assert_eq!(
            remove_derived_in_state(&state, &strs(&["X"]), Some(1)).unwrap_err(),
            STALE_SESSION_ERROR
        );
        assert_eq!(calc(&state, "X", false, None).unwrap_err(), "No data loaded");
        assert_eq!(calc(&state, "X", false, Some(1)).unwrap_err(), STALE_SESSION_ERROR);
        assert_eq!(formula(&state, "X", false, None).unwrap_err(), "No data loaded");
        assert_eq!(formula(&state, "X", false, Some(1)).unwrap_err(), STALE_SESSION_ERROR);
        assert_eq!(
            commit_derived(&state, 1, Some(1), "X", vec![], false).unwrap_err(),
            STALE_SESSION_ERROR
        );
    }

    #[test]
    fn install_session_returns_a_strictly_greater_generation_each_time_and_matches_the_session() {
        let state = AppState(RwLock::new(None));
        assert_eq!(session_generation(&state).unwrap(), None);

        let g1 = install_session(&state, dataset()).unwrap();
        assert_eq!(session_generation(&state).unwrap(), Some(g1));
        let g2 = install_session(&state, dataset()).unwrap();
        assert!(g2 > g1, "{g2} should be > {g1}");
        assert_eq!(session_generation(&state).unwrap(), Some(g2));
        let g3 = install_session(&state, dataset()).unwrap();
        assert!(g3 > g2);
        assert_eq!(session_generation(&state).unwrap(), Some(g3));
    }

    #[test]
    fn a_window_bound_to_the_previous_dataset_cannot_touch_the_new_one() {
        let state = AppState(RwLock::new(None));
        let g_a = install_session(&state, dataset()).unwrap();
        calc(&state, "Mine", false, Some(g_a)).unwrap();
        // Workspace B is loaded; the leftover window still holds g_a.
        let g_b = install_session(&state, dataset()).unwrap();
        calc(&state, "Mine", false, Some(g_b)).unwrap();

        assert_eq!(calc(&state, "Mine", true, Some(g_a)).unwrap_err(), STALE_SESSION_ERROR);
        assert_eq!(formula(&state, "Other", false, Some(g_a)).unwrap_err(), STALE_SESSION_ERROR);
        assert_eq!(
            remove_derived_in_state(&state, &strs(&["Mine"]), Some(g_a)).unwrap_err(),
            STALE_SESSION_ERROR
        );
        assert_eq!(headers_of(&state), vec!["timestamp", "A", "B", "Mine"]);
    }

    #[test]
    fn load_report_json_carries_the_generation_field() {
        let report = CsvLoadReport {
            headers: vec![],
            total_rows: 0,
            columns: vec![],
            warnings: vec![],
            generation: 42,
            ..Default::default()
        };
        let v = serde_json::to_value(&report).unwrap();
        assert_eq!(v["generation"], 42);
        // Older payloads without the field still deserialize (default 0).
        let back: CsvLoadReport = serde_json::from_str(
            r#"{"headers":[],"total_rows":0,"columns":[],"warnings":[]}"#,
        )
        .unwrap();
        assert_eq!(back.generation, 0);
    }


    #[test]
    fn resolve_prefers_an_exact_match_then_falls_back_to_trimmed_case_insensitive() {
        let headers = strs(&["timestamp", "a", "A", "Tag B"]);
        assert_eq!(resolve_sensor(&headers, "A"), Some(2), "exact wins over an earlier case-variant");
        assert_eq!(resolve_sensor(&headers, "a"), Some(1));
        assert_eq!(resolve_sensor(&headers, " tag b "), Some(3));
        assert_eq!(resolve_sensor(&headers, "zzz"), None);
    }


    #[test]
    fn single_op_computes_and_names_the_column() {
        let data = dataset();
        let (name, col) = compute_operation_sensor(&data, &strs(&["A"]), &single("multiply", 2.0, None), false).unwrap();
        assert_eq!(name, "A * 2");
        assert_eq!(col, vec![2.0, 4.0, 6.0]);
    }

    #[test]
    fn custom_name_is_trimmed() {
        let data = dataset();
        let (name, _) = compute_operation_sensor(&data, &strs(&["A"]), &single("add", 1.0, Some("  My Sensor ")), false).unwrap();
        assert_eq!(name, "My Sensor");
    }

    #[test]
    fn create_rejects_an_existing_name_before_computing() {
        let data = dataset();
        let err = compute_operation_sensor(&data, &strs(&["A"]), &single("add", 1.0, Some("b")), false).unwrap_err();
        assert!(err.contains("already exists"), "{err}");
    }

    #[test]
    fn replace_cannot_read_the_column_it_overwrites_even_with_different_case() {
        let data = dataset();
        let err = compute_operation_sensor(&data, &strs(&["A"]), &single("add", 1.0, Some(" a ")), true).unwrap_err();
        assert!(err.contains("cannot be built from itself"), "{err}");
    }

    #[test]
    fn unknown_sensor_and_bad_config_are_errors() {
        let data = dataset();
        assert!(compute_operation_sensor(&data, &strs(&["nope"]), &single("add", 1.0, None), false).unwrap_err().contains("Sensor not found"));
        assert!(compute_operation_sensor(&data, &[], &single("add", 1.0, None), false).is_err());
        assert!(compute_operation_sensor(&data, &strs(&["A", "B"]), &single("add", 1.0, None), false).is_err());
        assert!(compute_operation_sensor(&data, &strs(&["A"]), &single("bogus", 1.0, None), false).is_err());
        let bad_mode = SensorOperationConfig { mode: "x".into(), single_op: None, multi_op: None, custom_name: None };
        assert!(compute_operation_sensor(&data, &strs(&["A"]), &bad_mode, false).is_err());
    }

    #[test]
    fn single_op_missing_input_stays_missing_and_non_finite_results_become_missing() {
        let data = dataset_with(&["P"], vec![vec![NAN, 0.0, 1e300]]);
        // divide by zero -> None -> NaN
        let (_, col) = compute_operation_sensor(&data, &strs(&["P"]), &single("divide", 0.0, Some("d")), false).unwrap();
        assert!(col.iter().all(|v| v.is_nan()));
        // 0^-1 = inf and 1e300^2 = inf must NOT be stored as inf
        let (_, col) = compute_operation_sensor(&data, &strs(&["P"]), &single("power", -1.0, Some("neg")), false).unwrap();
        assert!(col[0].is_nan() && col[1].is_nan(), "{col:?}");
        assert!(col[2] > 0.0 && col[2].is_finite(), "{col:?}");
        let (_, col) = compute_operation_sensor(&data, &strs(&["P"]), &single("power", 2.0, Some("sq")), false).unwrap();
        assert!(same(&col, &[NAN, 0.0, NAN]), "{col:?}");
        assert!(col.iter().all(|v| !v.is_infinite()));
    }


    fn nan_dataset() -> ColumnarData {
        // row0: all valid, row1: B missing, row2: all missing
        dataset_with(&["A", "B"], vec![vec![1.0, 4.0, NAN], vec![3.0, NAN, NAN]])
    }

    #[test]
    fn multi_sum_is_missing_when_any_source_is_missing() {
        let (_, col) = compute_operation_sensor(&nan_dataset(), &strs(&["A", "B"]), &multi("sum", Some("S")), false).unwrap();
        assert!(same(&col, &[4.0, NAN, NAN]), "{col:?}");
    }

    #[test]
    fn multi_mean_and_median_skip_missing_sources_and_all_missing_stays_missing() {
        let (_, mean) = compute_operation_sensor(&nan_dataset(), &strs(&["A", "B"]), &multi("mean", Some("M")), false).unwrap();
        assert!(same(&mean, &[2.0, 4.0, NAN]), "{mean:?}");
        let (_, med) = compute_operation_sensor(&nan_dataset(), &strs(&["A", "B"]), &multi("median", Some("D")), false).unwrap();
        assert!(same(&med, &[2.0, 4.0, NAN]), "{med:?}");
    }

    #[test]
    fn multi_op_with_all_valid_sources_is_unaffected() {
        let data = dataset();
        let (name, col) = compute_operation_sensor(&data, &strs(&["A", "B"]), &multi("sum", None), false).unwrap();
        assert_eq!(name, "Sum([\"A\", \"B\"])");
        assert_eq!(col, vec![11.0, 22.0, 33.0]);
    }

    #[test]
    fn multi_op_can_be_built_from_a_derived_column() {
        let mut data = dataset();
        let mut derived = HashSet::new();
        let (n, c) = compute_operation_sensor(&data, &strs(&["A"]), &single("multiply", 10.0, Some("A10")), false).unwrap();
        store_derived_column(&mut data, &mut derived, &n, c, false).unwrap();
        let (_, col) = compute_operation_sensor(&data, &strs(&["a10", "B"]), &multi("sum", Some("T")), false).unwrap();
        assert_eq!(col, vec![20.0, 40.0, 60.0]);
    }


    #[test]
    fn formula_computes_and_a_missing_input_gives_a_missing_row() {
        let data = dataset_with(&["A", "B"], vec![vec![1.0, NAN, 3.0], vec![10.0, 20.0, 30.0]]);
        let (name, col) = compute_formula_sensor(&data, "$A + $B", Some(" Total "), false).unwrap();
        assert_eq!(name, "Total");
        assert!(same(&col, &[11.0, NAN, 33.0]), "{col:?}");
    }

    /// `$11PT1214A` is a textual prefix of `$11PT1214A.PV`; a string replace
    /// of the shorter token would mangle the longer one.
    #[test]
    fn formula_with_one_name_a_prefix_of_another_uses_the_right_columns() {
        let data = dataset_with(&["11PT1214A", "11PT1214A.PV"], vec![vec![1.0, 2.0], vec![100.0, 200.0]]);
        let (_, col) = compute_formula_sensor(&data, "$11PT1214A + $11PT1214A.PV", Some("S"), false).unwrap();
        assert_eq!(col, vec![101.0, 202.0]);
        let (_, col) = compute_formula_sensor(&data, "$11PT1214A.PV - $11PT1214A", Some("D"), false).unwrap();
        assert_eq!(col, vec![99.0, 198.0]);
    }

    #[test]
    fn formula_reusing_one_sensor_twice_and_special_character_names() {
        let data = dataset_with(&["Total-Power", "A/B"], vec![vec![2.0, 3.0], vec![4.0, 5.0]]);
        let f = format!("{} * {} + {}", sensor_ref_token("Total-Power"), sensor_ref_token("Total-Power"), sensor_ref_token("A/B"));
        let (_, col) = compute_formula_sensor(&data, &f, Some("R"), false).unwrap();
        assert_eq!(col, vec![8.0, 14.0]);
    }

    #[test]
    fn formula_resolves_sources_case_insensitively_and_trimmed() {
        let data = dataset();
        let (_, col) = compute_formula_sensor(&data, "$a * 2", Some("Z"), false).unwrap();
        assert_eq!(col, vec![2.0, 4.0, 6.0]);
    }

    #[test]
    fn formula_errors() {
        let data = dataset();
        assert!(compute_formula_sensor(&data, "1 + 2", Some("Z"), false).unwrap_err().contains("no sensor references"));
        assert!(compute_formula_sensor(&data, "$nope + 1", Some("Z"), false).unwrap_err().contains("Sensor not found"));
        assert!(compute_formula_sensor(&data, "$A + 1", Some("b"), false).unwrap_err().contains("already exists"));
        assert!(compute_formula_sensor(&data, "$A + 1", Some("a"), true).unwrap_err().contains("cannot be built from itself"));
        assert!(compute_formula_sensor(&data, "$A +", Some("Z"), false).unwrap_err().contains("parse error"));
    }

    #[test]
    fn formula_non_finite_results_are_missing() {
        let data = dataset_with(&["A"], vec![vec![0.0, 2.0]]);
        let (_, col) = compute_formula_sensor(&data, "1 / $A", Some("Z"), false).unwrap();
        assert!(same(&col, &[NAN, 0.5]), "{col:?}");
    }

    #[test]
    fn formula_default_name_is_trimmed() {
        let data = dataset();
        let (name, _) = compute_formula_sensor(&data, "$A + 1 ", None, false).unwrap();
        assert_eq!(name, "f($A + 1)");
    }


    #[test]
    fn token_is_bare_only_for_alphanumeric_underscore_names() {
        assert_eq!(sensor_ref_token("plain_1"), "$plain_1");
        assert_eq!(sensor_ref_token("Temp"), "$Temp");
        for braced in ["Total-Power", "A/B", "Eff%", "(x)", "Sum All", "a.b", "11PT1214A.PV", "", "a+b"] {
            assert_eq!(sensor_ref_token(braced), format!("${{{}}}", braced), "{braced}");
        }
    }

    #[test]
    fn token_round_trips_through_extract_sensor_refs() {
        for name in [
            "plain_1", "Total-Power", "A/B", "Eff%", "(x)", "Sum All", "a.b", "11PT1214A.PV",
            "ไทย", "อุณหภูมิ", "a+b", "x*y", "50%", "ºC",
        ] {
            let token = sensor_ref_token(name);
            let formula = format!("1 + {} * 2", token);
            let refs = extract_sensor_refs(&formula);
            assert_eq!(refs, vec![(token.clone(), name.to_string())], "{name}");
        }
    }

    #[test]
    fn a_bare_name_with_a_dash_would_have_been_misparsed() {
        // Documents WHY the brace rule exists.
        let refs = extract_sensor_refs("$Total-Power");
        assert_eq!(refs[0].1, "Total");
    }

    #[test]
    fn rewrite_round_trips_special_character_names() {
        assert_eq!(rewrite_sensor_ref("${Total-Power} + 1", "total-power", "Eff%"), "${Eff%} + 1");
        assert_eq!(rewrite_sensor_ref("$A + $B", "A", "Total-Power"), "${Total-Power} + $B");
        assert_eq!(rewrite_sensor_ref("$A + 1", "A", "  Spacey Name "), "${Spacey Name} + 1");
        // the rewritten formula parses back to the new name
        let out = rewrite_sensor_ref("$A * 2", "A", "A/B");
        assert_eq!(extract_sensor_refs(&out)[0].1, "A/B");
    }


    #[test]
    fn prepare_rebuilds_the_expression_from_spans_not_string_replace() {
        let (expr, names) = prepare_formula_for_eval("$A + $A.PV * ${x y} - $A");
        assert_eq!(expr, "_0 + _1 * _2 - _0");
        assert_eq!(
            names,
            vec![
                ("_0".to_string(), "A".to_string()),
                ("_1".to_string(), "A.PV".to_string()),
                ("_2".to_string(), "x y".to_string()),
            ]
        );
    }

    #[test]
    fn prepare_prefix_is_longer_than_any_underscore_run_the_user_typed() {
        // `_0` typed by the user must stay an unknown name, never sensor 0.
        let (expr, names) = prepare_formula_for_eval("$A + _0");
        assert_eq!(expr, "__0 + _0");
        assert_eq!(names[0].0, "__0");
        let (expr, _) = prepare_formula_for_eval("$A + a__b");
        assert_eq!(expr, "___0 + a__b");
        // Underscores INSIDE a reference do not count.
        let (expr, _) = prepare_formula_for_eval("${a__b} + $c_d");
        assert_eq!(expr, "_0 + _1");
    }

    #[test]
    fn prepare_never_fuses_a_reference_with_adjacent_text() {
        // `${A}0` must not become `_10`-style text naming another sensor.
        let (expr, _) = prepare_formula_for_eval("${A}0 + ${B}");
        assert_eq!(expr, "_0 0 + _1");
        let (expr, _) = prepare_formula_for_eval("2${A}");
        assert_eq!(expr, "2 _0");
        let (expr, _) = prepare_formula_for_eval("${A}${B}");
        assert_eq!(expr, "_0 _1");
        let data = dataset();
        assert!(compute_formula_sensor(&data, "${A}0", Some("Z"), false).unwrap_err().contains("parse error"));
    }


    fn err_of(formula: &str) -> String {
        compute_formula_sensor(&dataset(), formula, Some("Z"), false).unwrap_err()
    }

    #[test]
    fn ln_is_the_natural_log_and_log_stays_base_10() {
        let data = dataset_with(&["A"], vec![vec![std::f64::consts::E, 100.0, 0.0]]);
        let (_, col) = compute_formula_sensor(&data, "ln($A)", Some("L"), false).unwrap();
        assert!((col[0] - 1.0).abs() < 1e-12 && (col[1] - 100f64.ln()).abs() < 1e-12, "{col:?}");
        assert!(col[2].is_nan(), "ln(0) = -inf -> missing");
        let (_, col) = compute_formula_sensor(&data, "log($A)", Some("L"), false).unwrap();
        assert!((col[1] - 2.0).abs() < 1e-12, "{col:?}");
    }

    #[test]
    fn unknown_names_and_functions_are_refused_with_exact_messages() {
        assert_eq!(err_of("$A * pi"), "Formula error: unknown name 'pi'. Write pi() for π.");
        assert_eq!(
            err_of("$A * e"),
            "Formula error: unknown name 'e'. Write e() for Euler's number (2.718…)."
        );
        assert_eq!(
            err_of("$A + x"),
            "Formula error: unknown name 'x'. Write sensors as $Name, or ${Name} when the name has spaces or symbols."
        );
        assert_eq!(
            err_of("sqr($A)"),
            format!("Formula error: unknown function 'sqr'. Available functions: {}.", FORMULA_FUNCTION_LIST)
        );
        assert_eq!(err_of("sqrt($A, 2)"), "Formula error: sqrt takes 1 value but was given 2. Example: sqrt($A).");
        assert_eq!(err_of("$A * sqrt"), "Formula error: sqrt takes 1 value but was given none. Example: sqrt($A).");
        assert_eq!(err_of("pow($A)"), "Formula error: pow takes 2 values but was given 1. Example: pow($A, 2).");
        assert_eq!(err_of("$A * abs"), "Formula error: abs needs a value in brackets, e.g. abs($A).");
        assert!(err_of("myround($A, 2)").contains("unknown function 'myround'"));
    }

    #[test]
    fn a_sensor_called_like_a_function_is_refused_not_silently_its_value() {
        let data = dataset_with(&["A", "x y"], vec![vec![1.0], vec![2.0]]);
        let err = compute_formula_sensor(&data, "$A (1 - ${x y})", Some("Z"), false).unwrap_err();
        assert_eq!(
            err,
            "Formula error: $A is a sensor, not a function. Put an operator before the bracket, e.g. $A * (…)."
        );
        let err = compute_formula_sensor(&data, "${x y}(2)", Some("Z"), false).unwrap_err();
        assert!(err.starts_with("Formula error: ${x y} is a sensor"), "{err}");
    }

    #[test]
    fn an_error_hidden_behind_a_condition_still_refuses_the_formula() {
        // fasteval doesn't short-circuit `&&`/`||`, so `nope($A)` is always evaluated and the trial in `compile_formula` refuses it.
        let data = dataset_with(&["A"], vec![vec![0.0, 5.0]]);
        let err = compute_formula_sensor(&data, "($A > 2) && nope($A)", Some("Z"), false).unwrap_err();
        assert!(err.contains("unknown function 'nope'"), "{err}");
    }

    #[test]
    fn non_finite_results_stay_missing_rows_not_errors() {
        let data = dataset_with(&["A"], vec![vec![-1.0, 4.0, 0.0]]);
        let (_, col) = compute_formula_sensor(&data, "sqrt($A) + ln($A)", Some("Z"), false).unwrap();
        assert!(same(&col, &[NAN, 2.0 + 4f64.ln(), NAN]), "{col:?}");
    }

    #[test]
    fn parse_errors_show_the_users_own_sensor_names() {
        assert_eq!(
            err_of("$A $B"),
            "Formula parse error: unexpected text at \"$B\" (an operator such as + - * / may be missing)"
        );
        assert_eq!(
            err_of("($A + 1"),
            "Formula parse error: the formula ends too early (a value or a closing bracket is missing)"
        );
        assert_eq!(err_of("abs($A, 1)"), "Formula parse error: abs: expected one arg");
    }

    #[test]
    fn round_with_a_sensor_first_and_a_constant_second_is_refused() {
        assert_eq!(
            err_of("round($A, 2)"),
            "Formula error: round($A, 2) does not round to 2 decimal places. Write round($A * 100) / 100 instead."
        );
        assert_eq!(
            err_of("round($A + $B, 1) * 3"),
            "Formula error: round($A + $B, 1) does not round to 1 decimal place. Write round(($A + $B) * 10) / 10 instead."
        );
        assert_eq!(
            err_of("round($A, 0)"),
            "Formula error: round($A, 0) is not supported. Write round($A) to round to a whole number."
        );
        assert_eq!(
            err_of("round($A, 0.5)"),
            "Formula error: round($A, 0.5) is not supported. To round to the nearest step, put the step first: round(0.5, $A)."
        );
        // fasteval's other bracket / separator spellings, and nesting.
        assert!(err_of("ROUND($A, 2)").contains("unknown function 'ROUND'"));
        assert!(err_of("round [ $A ; 3 ]").contains("round($A, 3) does not round to 3 decimal places"));
        assert!(err_of("1 + round(round(0.1, $A), 2)").contains("round(round(0.1, $A), 2)"));
        assert!(err_of("round(min($A, $B), 2)").contains("Write round(min($A, $B) * 100) / 100"));
        assert!(err_of("round(($A + 1), 2)").contains("Write round(($A + 1) * 100) / 100"));
        assert!(err_of("round(-$A, 2)").contains("Write round((-$A) * 100) / 100"));
        assert!(err_of("round(${Flow (m3/h)}, 2)").contains("Sensor not found"), "refs resolved first");
    }

    #[test]
    fn documented_round_forms_and_lookalikes_still_evaluate() {
        let data = dataset_with(
            &["A", "B", "round", "x round(1, 2)"],
            vec![vec![1.234], vec![0.5], vec![7.0], vec![9.0]],
        );
        let ok = |f: &str| compute_formula_sensor(&data, f, Some("Z"), false).unwrap_or_else(|e| panic!("{f}: {e}")).1[0];
        assert_eq!(ok("round($A)"), 1.0);
        assert!((ok("round(0.01, $A)") - 1.23).abs() < 1e-12);
        assert_eq!(ok("round($B, $A)"), 1.0, "step from a sensor: fasteval semantics kept");
        assert!((ok("$A + round(1.5, 2)") - (1.234 + 1.5)).abs() < 1e-12, "no sensor on either side: a constant");
        assert_eq!(ok("$round + 1"), 8.0, "a SENSOR called round is not the function");
        assert_eq!(ok("${x round(1, 2)} * 2"), 18.0, "text inside braces is a name");
    }

    #[test]
    fn spread_over_many_sensors_no_longer_overflows_the_parse_slab() {
        let n = 80;
        let headers: Vec<String> = (0..n).map(|i| format!("S{i}")).collect();
        let hrefs: Vec<&str> = headers.iter().map(String::as_str).collect();
        let data = dataset_with(&hrefs, (0..n).map(|i| vec![i as f64]).collect());
        let refs = headers.iter().map(|h| format!("${h}")).collect::<Vec<_>>().join(", ");
        let (_, col) = compute_formula_sensor(&data, &format!("max({refs}) - min({refs})"), Some("Z"), false).unwrap();
        assert_eq!(col, vec![(n - 1) as f64]);
    }

    #[test]
    fn nesting_up_to_the_apps_own_limit_parses() {
        let deep = format!("{}$A{}", "(".repeat(MAX_FORMULA_DEPTH as usize), ")".repeat(MAX_FORMULA_DEPTH as usize));
        let (_, col) = compute_formula_sensor(&dataset(), &deep, Some("Z"), false).unwrap();
        assert_eq!(col, vec![1.0, 2.0, 3.0]);
        let signs = format!("{}$A", "-".repeat(MAX_FORMULA_DEPTH as usize));
        assert!(compute_formula_sensor(&dataset(), &signs, Some("Z"), false).is_ok());

        // `(` and `[` interleaved, 64 levels in all: still within budget.
        let d = MAX_FORMULA_DEPTH as usize;
        let open: String = (0..d).map(|i| if i % 2 == 0 { '(' } else { '[' }).collect();
        let close: String = (0..d).rev().map(|i| if i % 2 == 0 { ')' } else { ']' }).collect();
        let (_, col) = compute_formula_sensor(&dataset(), &format!("{open}$A{close}"), Some("Z"), false).unwrap();
        assert_eq!(col, vec![1.0, 2.0, 3.0]);
    }

    #[test]
    fn square_brackets_past_the_apps_limit_are_refused_before_fasteval() {
        // 65..=127 `[` would reach fasteval's recursive parse/eval (its limit is 2 * MAX_FORMULA_DEPTH) unless brackets are counted.
        let d = MAX_FORMULA_DEPTH as usize + 1;
        let deep = format!("{}$A{}", "[".repeat(d), "]".repeat(d));
        let err = compute_formula_sensor(&dataset(), &deep, Some("Z"), false).unwrap_err();
        assert!(err.contains("too deeply nested"), "{err}");
        let deepest = format!("{}$A{}", "[".repeat(127), "]".repeat(127));
        let err = compute_formula_sensor(&dataset(), &deepest, Some("Z"), false).unwrap_err();
        assert!(err.contains("too deeply nested"), "{err}");
    }

    #[test]
    fn validate_gives_the_same_verdict_and_message_as_compute() {
        let data = dataset();
        for f in ["$A + $B", "$A * pi", "round($A, 2)", "$A +", "$nope + 1", "ln($A)", "$A(2)", "1 + 2"] {
            let v = validate_formula_against(&data, f);
            match compute_formula_sensor(&data, f, Some("Z"), false) {
                Ok(_) => assert!(v.valid && v.error.is_none(), "{f}: {:?}", v.error),
                Err(e) => {
                    assert!(!v.valid, "{f}");
                    assert_eq!(v.error.as_deref(), Some(e.as_str()), "{f}");
                }
            }
        }
        assert_eq!(validate_formula_against(&data, "$B + $A + $b").referenced_sensors, vec!["B", "A", "b"]);
    }

    #[test]
    fn prepare_leaves_non_reference_text_alone() {
        let (expr, names) = prepare_formula_for_eval("sqrt(4) + 2 ^ 3 $ {oops");
        assert_eq!(expr, "sqrt(4) + 2 ^ 3 $ {oops");
        assert!(names.is_empty());
    }
}

#[cfg(test)]
mod extract_formula_refs_tests {
    use super::*;

    #[test]
    fn reads_both_reference_forms() {
        let out = extract_formula_refs(vec![
            "$11PT1214A.PV * 2".to_string(),
            "${test extend} + 10".to_string(),
        ]);
        assert_eq!(out[0], vec!["11PT1214A.PV"]);
        assert_eq!(out[1], vec!["test extend"]);
    }

    #[test]
    fn keeps_one_entry_per_input_formula_in_order() {
        let out = extract_formula_refs(vec![
            "$a + $b".to_string(),
            "42".to_string(),
            "$c".to_string(),
        ]);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0], vec!["a", "b"]);
        assert!(out[1].is_empty(), "a formula with no references yields an empty list, not a missing entry");
        assert_eq!(out[2], vec!["c"]);
    }

    #[test]
    fn de_duplicates_repeated_references() {
        let out = extract_formula_refs(vec!["$a + $a * $a".to_string()]);
        assert_eq!(out[0], vec!["a"]);
    }

    /// A name that prefixes another (`test`/`test extend`) must not count as depended-on, or deletion is blocked forever.
    #[test]
    fn does_not_confuse_a_name_with_a_longer_name_starting_the_same_way() {
        let out = extract_formula_refs(vec!["${test extend} + 1".to_string()]);
        assert_eq!(out[0], vec!["test extend"]);
        assert!(!out[0].contains(&"test".to_string()));

        let out2 = extract_formula_refs(vec!["${test} + 1".to_string()]);
        assert_eq!(out2[0], vec!["test"]);
        assert!(!out2[0].contains(&"test extend".to_string()));
    }

    #[test]
    fn ignores_an_unclosed_brace_rather_than_capturing_the_rest() {
        let out = extract_formula_refs(vec!["${never closed + 1".to_string()]);
        assert!(out[0].is_empty());
    }

    #[test]
    fn handles_an_empty_input_list() {
        assert!(extract_formula_refs(vec![]).is_empty());
    }
}

#[cfg(test)]
mod rewrite_sensor_ref_tests {
    use super::*;

    #[test]
    fn rewrites_the_no_brace_form() {
        assert_eq!(rewrite_sensor_ref("$A + 1", "A", "B"), "$B + 1");
    }

    #[test]
    fn rewrites_the_braced_form() {
        assert_eq!(
            rewrite_sensor_ref("${Old Name} * 2", "Old Name", "New Name"),
            "${New Name} * 2"
        );
    }

    #[test]
    fn braces_the_new_name_when_it_needs_it() {
        assert_eq!(rewrite_sensor_ref("$A + 1", "A", "New Name"), "${New Name} + 1");
    }

    #[test]
    fn unbraces_the_new_name_when_it_no_longer_needs_it() {
        assert_eq!(rewrite_sensor_ref("${Old Name} + 1", "Old Name", "NewName"), "$NewName + 1");
    }

    #[test]
    fn is_case_insensitive_on_the_old_name() {
        assert_eq!(rewrite_sensor_ref("$test + 1", "TEST", "renamed"), "$renamed + 1");
    }

    /// `$test` is a substring of `$testA`, so a plain `.replace` would corrupt it.
    #[test]
    fn does_not_touch_a_longer_name_that_starts_the_same_way() {
        assert_eq!(rewrite_sensor_ref("$testA + $test", "test", "renamed"), "$testA + $renamed");
    }

    #[test]
    fn leaves_a_formula_with_no_match_unchanged() {
        assert_eq!(rewrite_sensor_ref("$A + $B", "C", "D"), "$A + $B");
    }

    #[test]
    fn rewrites_every_occurrence() {
        assert_eq!(rewrite_sensor_ref("$A + $A * 2", "A", "B"), "$B + $B * 2");
    }

    #[test]
    fn ignores_an_unclosed_brace_rather_than_capturing_the_rest() {
        assert_eq!(
            rewrite_sensor_ref("${never closed + 1", "never closed", "x"),
            "${never closed + 1"
        );
    }
}

#[cfg(test)]
mod eval_extra_math_fn_tests {
    use super::*;

    #[test]
    fn computes_each_supported_function() {
        assert_eq!(eval_extra_math_fn("sqrt", &[9.0]), Some(3.0));
        assert_eq!(eval_extra_math_fn("exp", &[0.0]), Some(1.0));
        assert_eq!(eval_extra_math_fn("log10", &[100.0]), Some(2.0));
        assert_eq!(eval_extra_math_fn("pow", &[2.0, 10.0]), Some(1024.0));
    }

    #[test]
    fn rejects_wrong_arg_count_instead_of_panicking() {
        // A bad arity must return `None`, not panic.
        assert_eq!(eval_extra_math_fn("sqrt", &[1.0, 2.0]), None);
        assert_eq!(eval_extra_math_fn("pow", &[1.0]), None);
    }

    #[test]
    fn unknown_name_falls_through_to_none() {
        assert_eq!(eval_extra_math_fn("not_a_function", &[1.0]), None);
    }
}

#[derive(Debug, Serialize)]
struct FormulaValidationResult {
    valid: bool,
    error: Option<String>,
    referenced_sensors: Vec<String>,
    /// Stable issue code when invalid (same codes as `preview_formula`;
    /// absent when valid).
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<&'static str>,
    /// `[start, end)` of the problem in UTF-16 units of the formula, when it
    /// can be located.
    #[serde(skip_serializing_if = "Option::is_none")]
    range: Option<[usize; 2]>,
}

/// Caps formula length and nesting depth so pathological input can't overflow fasteval's parser or stack.
/// `(`, `[`, `{` share one depth budget: fasteval nests `[ ]` like `( )`, and deep `[[[…]]]` could overflow the Windows main-thread stack.
const MAX_FORMULA_LEN: usize = 4096;
const MAX_FORMULA_DEPTH: i32 = 64;

fn check_formula_limits(formula: &str) -> Result<(), String> {
    match formula_limit_issue(formula) {
        Some(issue) => Err(issue.message),
        None => Ok(()),
    }
}

/// Size gate as a coded issue (`too_long`/`too_deep`). Length counts UTF-16 units like the editor's `text.length`, not UTF-8 bytes (Thai is 3 bytes per char).
fn formula_limit_issue(formula: &str) -> Option<FormulaIssue> {
    use formula_diagnostics::{issue_at, TOO_DEEP, TOO_LONG};
    let len = formula.encode_utf16().count();
    if len > MAX_FORMULA_LEN {
        return Some(issue_at(
            formula,
            TOO_LONG,
            format!("Formula too long ({} chars, max {})", len, MAX_FORMULA_LEN),
            None,
        ));
    }
    let mut depth: i32 = 0;
    let mut max_depth: i32 = 0;
    let mut first_over: Option<usize> = None;
    for (i, c) in formula.chars().enumerate() {
        match c {
            '(' | '[' | '{' => {
                depth += 1;
                if depth > max_depth {
                    max_depth = depth;
                }
                if depth > MAX_FORMULA_DEPTH && first_over.is_none() {
                    first_over = Some(i);
                }
            }
            ')' | ']' | '}' => {
                depth -= 1;
            }
            _ => {}
        }
    }
    if max_depth > MAX_FORMULA_DEPTH {
        return Some(issue_at(
            formula,
            TOO_DEEP,
            format!("Formula too deeply nested ({} levels, max {})", max_depth, MAX_FORMULA_DEPTH),
            first_over.map(|i| (i, i + 1)),
        ));
    }
    None
}

#[cfg(test)]
mod check_formula_limits_tests {
    use super::*;

    #[test]
    fn accepts_a_short_shallow_formula() {
        assert!(check_formula_limits("$A + $B * 2").is_ok());
    }

    #[test]
    fn rejects_a_formula_over_the_length_cap() {
        let formula = "1".repeat(MAX_FORMULA_LEN + 1);
        let err = check_formula_limits(&formula).unwrap_err();
        assert!(err.contains("too long"));
    }

    #[test]
    fn accepts_a_formula_exactly_at_the_length_cap() {
        let formula = "1".repeat(MAX_FORMULA_LEN);
        assert!(check_formula_limits(&formula).is_ok());
    }

    #[test]
    fn rejects_a_formula_nested_deeper_than_the_cap() {
        let formula = "(".repeat(MAX_FORMULA_DEPTH as usize + 1);
        let err = check_formula_limits(&formula).unwrap_err();
        assert!(err.contains("too deeply nested"));
    }

    #[test]
    fn accepts_a_formula_nested_exactly_at_the_cap() {
        let formula = "(".repeat(MAX_FORMULA_DEPTH as usize);
        assert!(check_formula_limits(&formula).is_ok());
    }

    #[test]
    fn counts_curly_braces_toward_the_same_depth_budget_as_parens() {
        let formula = "{".repeat(MAX_FORMULA_DEPTH as usize + 1);
        assert!(check_formula_limits(&formula).is_err());
    }

    #[test]
    fn counts_square_brackets_toward_the_same_depth_budget_as_parens() {
        // fasteval parses `[ ]` as a group exactly like `( )`.
        let over = format!("{}$A{}", "[".repeat(MAX_FORMULA_DEPTH as usize + 1), "]".repeat(MAX_FORMULA_DEPTH as usize + 1));
        let err = check_formula_limits(&over).unwrap_err();
        assert!(err.contains("too deeply nested"), "{err}");
        let at = format!("{}$A{}", "[".repeat(MAX_FORMULA_DEPTH as usize), "]".repeat(MAX_FORMULA_DEPTH as usize));
        assert!(check_formula_limits(&at).is_ok());
    }

    #[test]
    fn mixed_bracket_kinds_add_up_in_one_budget() {
        // 33 `(` + 32 `[` interleaved = 65 levels: over the cap even though
        // neither kind alone is.
        let open: String = (0..MAX_FORMULA_DEPTH + 1).map(|i| if i % 2 == 0 { '(' } else { '[' }).collect();
        assert!(check_formula_limits(&format!("{open}$A")).is_err());
    }

    #[test]
    fn tracks_depth_as_a_running_max_not_a_final_balance() {
        // Deeply nested then fully closed: max_depth was breached even
        // though the formula ends balanced at depth 0.
        let mut formula = "(".repeat(MAX_FORMULA_DEPTH as usize + 1);
        formula.push_str(&")".repeat(MAX_FORMULA_DEPTH as usize + 1));
        assert!(check_formula_limits(&formula).is_err());
    }
}

#[cfg(test)]
mod formula_gate_tests {
    use super::*;

    const NAN: f64 = f64::NAN;

    fn data() -> ColumnarData {
        ColumnarData::from_parts(
            vec!["timestamp".into(), "A".into(), "ค่า แรง".into()],
            vec![Some("2020-01-01T00:00".into()), Some("2020-01-01T00:01".into())],
            vec![vec![NAN; 2], vec![1.5, 4.0], vec![2.0, NAN]],
        )
    }

    #[test]
    fn the_function_list_is_exactly_the_engines_and_every_entry_compiles() {
        let mut expected: Vec<&str> = BUILTIN_FORMULA_FNS.to_vec();
        expected.extend(EXTRA_MATH_FNS.iter().map(|(n, _, _)| *n));
        expected.extend(["pi", "e"]);
        let mut got = FORMULA_FUNCTIONS.to_vec();
        expected.sort_unstable();
        got.sort_unstable();
        assert_eq!(got, expected);
        for f in FORMULA_FUNCTIONS {
            let formula = match *f {
                "pi" | "e" => format!("$A * {f}()"),
                "pow" => "pow($A, 2)".to_string(),
                _ => format!("{f}($A)"),
            };
            assert!(compute_formula_sensor(&data(), &formula, Some("Z"), false).is_ok(), "{formula}");
        }
    }

    #[test]
    fn the_rewrite_map_points_every_byte_back_at_the_users_text() {
        let f = "${ค่า แรง} + $A0";
        let (expr, names, map) = prepare_formula_for_eval_mapped(f);
        assert_eq!(map.len(), expr.len() + 1);
        assert_eq!(names.len(), 2);
        let chars: Vec<char> = f.chars().collect();
        // The `+` in the rewritten text maps to the user's `+`.
        let plus = expr.find('+').unwrap();
        assert_eq!(chars[map[plus]], '+');
        // The second generated name maps to the start of `$A0`.
        let second = expr.rfind(&names[1].0).unwrap();
        assert_eq!(chars[map[second]], '$');
        assert_eq!(map[second], 13);
        assert_eq!(*map.last().unwrap(), chars.len());
        // Unchanged text keeps the old (unmapped) function's output.
        assert_eq!(prepare_formula_for_eval(f), (expr, names));
    }

    #[test]
    fn validate_reports_the_code_and_range_of_its_refusal() {
        let v = validate_formula_against(&data(), "${ค่า แรง} + $nope");
        assert!(!v.valid);
        assert_eq!(v.error.as_deref(), Some("Sensor not found: nope"));
        assert_eq!(v.code, Some("unknown_sensor"));
        assert_eq!(v.range, Some([13, 18]));
        let v = validate_formula_against(&data(), "round($A, 2)");
        assert_eq!(v.code, Some("round_excel"));
        assert_eq!(v.range, Some([0, 12]));
        let v = validate_formula_against(&data(), "$A + 1");
        assert!(v.valid && v.code.is_none() && v.range.is_none());
        // A valid verdict has no code / range keys.
        let json = serde_json::to_value(&v).unwrap();
        assert_eq!(json, serde_json::json!({ "valid": true, "error": null, "referenced_sensors": ["A"] }));
    }

    #[test]
    fn a_literal_division_by_zero_is_refused_on_create() {
        let err = compute_formula_sensor(&data(), "$A / 0", Some("Z"), false).unwrap_err();
        assert_eq!(err, formula_diagnostics::DIV_ZERO_MESSAGE);
        // Dividing by a sensor that is 0 on some rows is still fine (those rows are empty).
        assert!(compute_formula_sensor(&data(), "1 / ($A - 1.5)", Some("Z"), false).is_ok());
        // Create-only: a recompute / replay of a saved recipe still computes.
        assert!(compute_formula_sensor(&data(), "$A / 0", Some("Z"), true).is_ok());
    }

    #[test]
    fn the_limit_counts_utf16_units_like_the_editor() {
        let thai = "ค".repeat(MAX_FORMULA_LEN);
        assert!(thai.len() > MAX_FORMULA_LEN, "3 bytes per char");
        assert!(check_formula_limits(&thai).is_ok());
        let over = "ค".repeat(MAX_FORMULA_LEN + 1);
        assert_eq!(
            check_formula_limits(&over).unwrap_err(),
            format!("Formula too long ({} chars, max {})", MAX_FORMULA_LEN + 1, MAX_FORMULA_LEN)
        );
        // An astral char is two units, as in JS.
        let astral = "😀".repeat(MAX_FORMULA_LEN / 2 + 1);
        assert!(check_formula_limits(&astral).is_err());
    }

    #[test]
    fn multi_op_decimals_rounds_and_is_optional_in_json() {
        let cfg: SensorOperationConfig = serde_json::from_value(serde_json::json!({
            "mode": "multi", "multiOp": { "type": "mean", "decimals": 0 }, "customName": "M"
        }))
        .unwrap();
        assert_eq!(cfg.multi_op.as_ref().unwrap().decimals, Some(0.0));
        let (_, col) = compute_operation_sensor(&data(), &["A".into(), "ค่า แรง".into()], &cfg, false).unwrap();
        assert_eq!(col, vec![2.0, 4.0], "1.75 -> 2, a lone 4 stays 4");
        let old: SensorOperationConfig = serde_json::from_value(serde_json::json!({
            "mode": "multi", "multiOp": { "type": "mean" }, "customName": "M"
        }))
        .unwrap();
        assert_eq!(old.multi_op.unwrap().decimals, None);
        assert_eq!(round_to_decimals(1.005, 2.0), (1.005f64 * 100.0).round() / 100.0);
        assert_eq!(round_to_decimals(-0.25, 1.0), -0.3);
    }
}

/// A formula parsed once and proven to evaluate (see [`compile_formula`]).
struct CompiledFormula {
    slab: fasteval::Slab,
    expr_i: fasteval::ExpressionI,
    /// `(safe variable name, original sensor name)`, one per distinct sensor,
    /// in the order `prepare_formula_for_eval` assigned them.
    safe_names: Vec<(String, String)>,
}

/// Value every sensor gets for the trial evaluation in [`compile_formula`].
const FORMULA_TRIAL_VALUE: f64 = 1.0;

/// Parse + trial-evaluate (every sensor = 1.0) so a bad formula is refused; shared by `validate_formula` and `compute_formula_sensor`.
/// Slab sized for this formula (fasteval defaults are tighter than `check_formula_limits`); refuses spreadsheet-order `round`; `div_zero` is create-only, not checked here.
fn compile_formula(formula: &str) -> Result<CompiledFormula, FormulaIssue> {
    let (expr, safe_names, byte_map) = prepare_formula_for_eval_mapped(formula);

    let parser = fasteval::Parser {
        expr_len_limit: expr.len().max(fasteval::parser::DEFAULT_EXPR_LEN_LIMIT),
        // fasteval counts unary signs as well as brackets; twice the app's
        // bracket budget is still a small, safe recursion depth.
        expr_depth_limit: 2 * MAX_FORMULA_DEPTH as usize,
    };
    // Every sub-expression / value consumes at least one byte of the text.
    let mut slab = fasteval::Slab::with_capacity(expr.len().max(64) + 1);
    let expr_i = match parser.parse(&expr, &mut slab.ps) {
        Ok(i) => i,
        Err(e) => {
            let message = formula_parse_error_message(&e, &safe_names);
            return Err(formula_diagnostics::parse_issue(formula, &e, message, &expr, &byte_map));
        }
    };

    let compiled = CompiledFormula { slab, expr_i, safe_names };
    let trial = vec![FORMULA_TRIAL_VALUE; compiled.safe_names.len()];
    let mut failed = None;
    if let Err(e) = eval_compiled(&compiled, &trial, &mut failed) {
        let message = formula_eval_error_message(&e, failed.as_ref(), &compiled.safe_names);
        return Err(formula_diagnostics::eval_issue(formula, &e, failed.as_ref(), &compiled.safe_names, message));
    }

    check_round_argument_order(formula)?;
    Ok(compiled)
}

/// Evaluates with `values[j]` for the j-th sensor; the first unresolved name goes to `failed` as `(name, arg count)`.
fn eval_compiled(
    c: &CompiledFormula,
    values: &[f64],
    failed: &mut Option<(String, usize)>,
) -> Result<f64, fasteval::Error> {
    let mut ns = |var: &str, args: Vec<f64>| -> Option<f64> {
        let found = match c.safe_names.iter().position(|(s, _)| s == var) {
            // A sensor is a value: `$A(2)` is not a call.
            Some(j) if args.is_empty() => Some(values[j]),
            Some(_) => None,
            None => eval_extra_math_fn(var, &args),
        };
        if found.is_none() && failed.is_none() {
            *failed = Some((var.to_string(), args.len()));
        }
        found
    };
    c.slab.ps.get_expr(c.expr_i).eval(&c.slab, &mut ns)
}

/// Puts the user's `$A`/`${Name}` back in place of generated variable names, for error messages.
fn restore_sensor_refs(text: &str, safe_names: &[(String, String)]) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_ascii_alphanumeric() || chars[i] == '_' {
            let start = i;
            while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            match safe_names.iter().find(|(s, _)| *s == word) {
                Some((_, name)) => out.push_str(&sensor_ref_token(name)),
                None => out.push_str(&word),
            }
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

fn formula_parse_error_message(err: &fasteval::Error, safe_names: &[(String, String)]) -> String {
    use fasteval::Error as E;
    let detail = match err {
        E::TooDeep => "the formula is nested too deeply".to_string(),
        E::TooLong | E::SlabOverflow => "the formula is too long".to_string(),
        E::UnparsedTokensRemaining(rest) => {
            let rest = restore_sensor_refs(rest.trim(), safe_names);
            let shown: String = rest.chars().take(40).collect();
            let more = if rest.chars().count() > 40 { "…" } else { "" };
            format!(
                "unexpected text at \"{}{}\" (an operator such as + - * / may be missing)",
                shown, more
            )
        }
        E::EOF | E::EofWhileParsing(_) => {
            "the formula ends too early (a value or a closing bracket is missing)".to_string()
        }
        E::InvalidValue => "a number, sensor or function was expected".to_string(),
        E::ParseF64(s) => format!("invalid number \"{}\"", s),
        E::Expected(s) => format!("expected {}", s),
        E::WrongArgs(s) => s.clone(),
        other => format!("{}", other),
    };
    format!("Formula parse error: {}", detail)
}

fn formula_eval_error_message(
    err: &fasteval::Error,
    failed: Option<&(String, usize)>,
    safe_names: &[(String, String)],
) -> String {
    let name = match err {
        fasteval::Error::Undefined(name) => name,
        other => return format!("Formula error: {}", other),
    };
    let nargs = failed.filter(|(n, _)| n == name).map(|(_, k)| *k).unwrap_or(0);

    if let Some((_, sensor)) = safe_names.iter().find(|(s, _)| s == name) {
        let token = sensor_ref_token(sensor);
        return format!(
            "Formula error: {} is a sensor, not a function. Put an operator before the bracket, e.g. {} * (…).",
            token, token
        );
    }
    if let Some((f, want, example)) = EXTRA_MATH_FNS.iter().find(|(f, _, _)| f == name) {
        let given = if nargs == 0 { "none".to_string() } else { nargs.to_string() };
        return format!(
            "Formula error: {} takes {} value{} but was given {}. Example: {}.",
            f,
            want,
            if *want == 1 { "" } else { "s" },
            given,
            example
        );
    }
    match name.as_str() {
        "pi" => "Formula error: unknown name 'pi'. Write pi() for π.".to_string(),
        "e" => "Formula error: unknown name 'e'. Write e() for Euler's number (2.718…).".to_string(),
        n if BUILTIN_FORMULA_FNS.contains(&n) => {
            format!("Formula error: {} needs a value in brackets, e.g. {}($A).", n, n)
        }
        n if nargs > 0 => format!(
            "Formula error: unknown function '{}'. Available functions: {}.",
            n, FORMULA_FUNCTION_LIST
        ),
        n => format!(
            "Formula error: unknown name '{}'. Write sensors as $Name, or ${{Name}} when the name has spaces or symbols.",
            n
        ),
    }
}

/// Refuses `round(<sensor expr>, <constant>)`: fasteval's `round(step, x)` rounds x to a multiple of step, so `round($A, 2)` would silently store 0, A or 2A.
/// Refused (code `round_excel`) with the formula to type. `round(x)`, `round(step, $A)`, `round($A, $B)` and sensor-free rounds pass; `convert_legacy_formula` converts old text.
fn check_round_argument_order(formula: &str) -> Result<(), FormulaIssue> {
    let chars: Vec<char> = formula.chars().collect();
    let spans = scan_sensor_refs(formula);
    let in_ref = ref_mask(chars.len(), &spans);
    let Some(call) = excel_round_calls(&chars, &in_ref, &spans).into_iter().next() else {
        return Ok(());
    };
    let text = |a: usize, b: usize| chars[a..b].iter().collect::<String>().trim().to_string();
    let message = round_order_message(
        &text(call.x.0, call.x.1),
        &text(call.n.0, call.n.1),
        is_formula_atom(&chars, &in_ref, &spans, call.x.0, call.x.1),
    );
    Err(formula_diagnostics::issue_at(
        formula,
        formula_diagnostics::ROUND_EXCEL,
        message,
        Some((call.start, call.end)),
    ))
}

/// `true` for every char that belongs to a `$Name` / `${Name}` reference.
fn ref_mask(len: usize, spans: &[SensorRefSpan]) -> Vec<bool> {
    let mut in_ref = vec![false; len];
    for s in spans {
        for flag in &mut in_ref[s.start..s.end] {
            *flag = true;
        }
    }
    in_ref
}

/// A spreadsheet-order `round(x, n)` call (char indices): the whole call span plus argument `x` (has a sensor) and `n` (has none).
struct ExcelRoundCall {
    start: usize,
    end: usize,
    x: (usize, usize),
    n: (usize, usize),
}

/// Every `round(<sensor expr>, <no sensor>)` call, outer before inner; serves both the refusal and the conversion. Text inside a ref is a name, never a call.
fn excel_round_calls(chars: &[char], in_ref: &[bool], spans: &[SensorRefSpan]) -> Vec<ExcelRoundCall> {
    let len = chars.len();
    let is_word = |i: usize| !in_ref[i] && (chars[i].is_ascii_alphanumeric() || chars[i] == '_');
    let has_ref = |a: usize, b: usize| spans.iter().any(|s| s.start >= a && s.end <= b);
    const ROUND: [char; 5] = ['r', 'o', 'u', 'n', 'd'];

    let mut out = Vec::new();
    let mut i = 0;
    while i + ROUND.len() <= len {
        let end = i + ROUND.len();
        let is_round = !in_ref[i]
            && chars[i..end] == ROUND
            && (i == 0 || !is_word(i - 1))
            && (end == len || !is_word(end));
        if !is_round {
            i += 1;
            continue;
        }
        let mut j = end;
        while j < len && !in_ref[j] && chars[j].is_whitespace() {
            j += 1;
        }
        if j < len && !in_ref[j] && (chars[j] == '(' || chars[j] == '[') {
            let mut depth = 0i32;
            let mut args: Vec<(usize, usize)> = Vec::new();
            let mut arg_start = j + 1;
            let mut close = None;
            for k in j..len {
                if in_ref[k] {
                    continue;
                }
                match chars[k] {
                    '(' | '[' => depth += 1,
                    ')' | ']' => {
                        depth -= 1;
                        if depth == 0 {
                            args.push((arg_start, k));
                            close = Some(k);
                            break;
                        }
                    }
                    ',' | ';' if depth == 1 => {
                        args.push((arg_start, k));
                        arg_start = k + 1;
                    }
                    _ => {}
                }
            }
            if let (Some(k), 2) = (close, args.len()) {
                let (x, n) = (args[0], args[1]);
                if has_ref(x.0, x.1) && !has_ref(n.0, n.1) {
                    out.push(ExcelRoundCall { start: i, end: k + 1, x, n });
                }
            }
        }
        i = end;
    }
    out
}

/// True if `chars[a..b]` (trimmed) is one operand safe to multiply bare: a sensor ref, number/name, or a bracket group closing at `b`.
fn is_formula_atom(
    chars: &[char],
    in_ref: &[bool],
    spans: &[SensorRefSpan],
    mut a: usize,
    mut b: usize,
) -> bool {
    while a < b && chars[a].is_whitespace() {
        a += 1;
    }
    while b > a && chars[b - 1].is_whitespace() {
        b -= 1;
    }
    if a >= b {
        return false;
    }
    if spans.iter().any(|s| s.start == a && s.end == b) {
        return true;
    }
    let plain = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '.';
    if (a..b).all(|i| !in_ref[i] && plain(chars[i])) {
        return true;
    }
    // Optional function name, then a bracket group that must close at `b`.
    let mut i = a;
    while i < b && !in_ref[i] && (chars[i].is_ascii_alphanumeric() || chars[i] == '_') {
        i += 1;
    }
    if i >= b || in_ref[i] || !(chars[i] == '(' || chars[i] == '[') {
        return false;
    }
    let mut depth = 0i32;
    for k in i..b {
        if in_ref[k] {
            continue;
        }
        match chars[k] {
            '(' | '[' => depth += 1,
            ')' | ']' => {
                depth -= 1;
                if depth == 0 {
                    return k == b - 1;
                }
            }
            _ => {}
        }
    }
    false
}

/// Decimal places `n` meant by a refused `round(x, n)`: a whole number 0..=15, else `None`.
fn round_places(n: &str) -> Option<u32> {
    fasteval::ez_eval(n, &mut fasteval::EmptyNamespace)
        .ok()
        .filter(|v| v.is_finite() && v.fract() == 0.0 && *v >= 0.0 && *v <= 15.0)
        .map(|v| v as u32)
}

/// Message for a refused `round(x, n)`, with `x` and `n` as typed; `x_is_simple` = can multiply without brackets.
fn round_order_message(x: &str, n: &str, x_is_simple: bool) -> String {
    let places = round_places(n);
    match places {
        Some(0) => format!(
            "Formula error: round({}, {}) is not supported. Write round({}) to round to a whole number.",
            x, n, x
        ),
        Some(p) => {
            let scale = 10u64.pow(p);
            let xw = if x_is_simple { x.to_string() } else { format!("({})", x) };
            format!(
                "Formula error: round({}, {}) does not round to {} decimal place{}. Write round({} * {}) / {} instead.",
                x,
                n,
                p,
                if p == 1 { "" } else { "s" },
                xw,
                scale,
                scale
            )
        }
        None => format!(
            "Formula error: round({}, {}) is not supported. To round to the nearest step, put the step first: round({}, {}).",
            x, n, n, x
        ),
    }
}

/// Refusal for a formula with no sensor reference; shared by `validate_formula` and `compute_formula_sensor`.
const FORMULA_NO_REFS_ERROR: &str =
    "Formula contains no sensor references. Use $SensorName or ${Sensor Name} syntax.";

/// `expected_generation` (JS `expectedGeneration`, default camelCase): a mismatch returns `STALE_SESSION_ERROR`, not a verdict on another dataset. Read-only.
#[tauri::command]
async fn validate_formula(
    formula: String,
    expected_generation: Option<u64>,
    app: tauri::AppHandle,
) -> Result<FormulaValidationResult, String> {
    on_blocking_pool(app, move |state| validate_formula_in_state(state, &formula, expected_generation)).await
}

/// Session-level `validate_formula` (testable without a Tauri `State`).
fn validate_formula_in_state(
    state: &AppState,
    formula: &str,
    expected: Option<u64>,
) -> Result<FormulaValidationResult, String> {
    check_formula_limits(formula)?;

    let state_lock = state.0.read().map_err(|e| e.to_string())?;
    let session = state_lock.as_ref().ok_or_else(|| missing_session_error(expected))?;
    check_expected_generation(expected, session.generation)?;
    Ok(validate_formula_against(&session.data, formula))
}

/// Pure core of `validate_formula`: same checks as `compute_formula_sensor`, so verdicts match Create/Save.
fn validate_formula_against(data: &ColumnarData, formula: &str) -> FormulaValidationResult {
    // Sensor references (distinct, in order of appearance) — reported even
    // when the formula is refused.
    let mut referenced_sensors: Vec<String> = Vec::new();
    for (_, name) in extract_sensor_refs(formula) {
        if !referenced_sensors.contains(&name) {
            referenced_sensors.push(name);
        }
    }
    match formula_gate(&data.headers, formula, false) {
        Ok(_) => FormulaValidationResult { valid: true, error: None, referenced_sensors, code: None, range: None },
        Err(issue) => FormulaValidationResult {
            valid: false,
            error: Some(issue.message),
            referenced_sensors,
            code: Some(issue.code),
            range: issue.range,
        },
    }
}

/// Distinct referenced sensors resolved to columns, in variable order. Errors `constant_only` (no refs) or `unknown_sensor` (ranged on first occurrence), via the shared resolver.
fn resolve_formula_sources(headers: &[String], formula: &str) -> Result<Vec<usize>, FormulaIssue> {
    use formula_diagnostics::{issue_at, CONSTANT_ONLY, UNKNOWN_SENSOR};
    let spans = scan_sensor_refs(formula);
    if spans.is_empty() {
        return Err(issue_at(formula, CONSTANT_ONLY, FORMULA_NO_REFS_ERROR, None));
    }
    let (_, safe_names) = prepare_formula_for_eval(formula);
    let mut src_idx: Vec<usize> = Vec::with_capacity(safe_names.len());
    for (_, name) in &safe_names {
        match resolve_sensor(headers, name) {
            Some(idx) => src_idx.push(idx),
            None => {
                let at = spans.iter().find(|s| s.name == *name).map(|s| (s.start, s.end));
                return Err(issue_at(formula, UNKNOWN_SENSOR, format!("Sensor not found: {}", name), at));
            }
        }
    }
    Ok(src_idx)
}

/// THE formula gate: size limits, references, then parse + trial evaluation + app refusals. Validate, preview and compute all use it, so verdicts match Create/Save.
/// `replace` false (create, `validate_formula`) also applies the create-only refusals; true (recompute/replay/Save) skips them.
fn formula_gate(
    headers: &[String],
    formula: &str,
    replace: bool,
) -> Result<(CompiledFormula, Vec<usize>), FormulaIssue> {
    if let Some(issue) = formula_limit_issue(formula) {
        return Err(issue);
    }
    let src_idx = resolve_formula_sources(headers, formula)?;
    let compiled = compile_formula(formula)?;
    if !replace {
        if let Some(issue) = create_only_formula_issue(formula) {
            return Err(issue);
        }
    }
    Ok((compiled, src_idx))
}

/// Refusals only for CREATE, never recompute/replay: a literal division by 0 (`div_zero`). Such a formula still evaluates, so old recipes keep restoring.
fn create_only_formula_issue(formula: &str) -> Option<FormulaIssue> {
    formula_diagnostics::division_by_zero(formula)
}

/// Evaluates every row in parallel; any NaN input or NaN/infinite result gives NaN. Shared with the preview so its numbers match the sensor.
fn eval_formula_column(
    data: &ColumnarData,
    compiled: &CompiledFormula,
    src_idx: &[usize],
    cancelled: CancelCheck,
) -> Result<Vec<f64>, String> {
    use rayon::prelude::*;
    let n = data.n_rows();
    let src_cols: Vec<&[f64]> = src_idx.iter().map(|idx| data.columns[*idx].as_slice()).collect();
    // Chunks write into the preallocated column (peak memory is one column); row r lands at r.
    let mut col: Vec<f64> = vec![0.0; n];
    col.par_chunks_mut(COLUMN_CHUNK).enumerate().try_for_each(|(c, out)| {
        if cancelled() {
            return Err(FORMULA_PREVIEW_CANCELLED.to_string());
        }
        let start = c * COLUMN_CHUNK;
        let mut row_values: Vec<f64> = vec![0.0; src_cols.len()];
        let mut failed = None;
        for (k, slot) in out.iter_mut().enumerate() {
            let r = start + k;
            // A missing (NaN) input on any referenced sensor → missing result.
            if src_cols.iter().any(|col| col[r].is_nan()) {
                *slot = f64::NAN;
                continue;
            }
            for (j, col) in src_cols.iter().enumerate() {
                row_values[j] = col[r];
            }
            *slot = match eval_compiled(compiled, &row_values, &mut failed) {
                Ok(result) if result.is_finite() => result,
                // NaN / Infinity (0/0, 1/0, sqrt of a negative, ...) → missing
                Ok(_) => f64::NAN,
                // Defence only: errors depend on names/arity, never row values (fasteval evaluates every operand), so `compile_formula`'s trial caught them; refuse the whole formula rather than empty some rows.
                Err(e) => return Err(formula_eval_error_message(&e, failed.as_ref(), &compiled.safe_names)),
            };
        }
        Ok(())
    })?;
    Ok(col)
}

/// Pure core of `evaluate_formula`: any NaN input or NaN/infinite result gives NaN; an unevaluable formula is an `Err`, never an all-empty column.
fn compute_formula_sensor(
    data: &ColumnarData,
    formula: &str,
    custom_name: Option<&str>,
    replace: bool,
) -> Result<(String, Vec<f64>), String> {
    check_formula_limits(formula)?;

    // 1-2. Every distinct sensor resolved to a column (all must exist).
    let src_idx = resolve_formula_sources(&data.headers, formula)?;

    // 3. Final name + collision rules.
    let name = match custom_name.map(str::trim) {
        Some(n) if !n.is_empty() => n.to_string(),
        _ => format!("f({})", formula.trim()),
    };
    // Must not read the column it overwrites, or `$self + 1` creeps up on every save.
    if replace {
        if let Some(target) = find_column_ci(&data.headers, &name) {
            if src_idx.contains(&target) {
                return Err(format!("'{}' cannot be built from itself", name));
            }
        }
    } else if find_column_ci(&data.headers, &name).is_some() {
        // Fail fast, before the (possibly long) evaluation.
        return Err(format!("A sensor named '{}' already exists", name));
    }

    // 4. Parse once and prove it evaluates (refuses a bad formula up front).
    let compiled = compile_formula(formula)?;
    // Only a create gets the create-only refusals; replay must keep restoring old recipes.
    if !replace {
        if let Some(issue) = create_only_formula_issue(formula) {
            return Err(issue.into());
        }
    }

    // 5. Evaluate every row (NaN = missing result).
    let new_col = eval_formula_column(data, &compiled, &src_idx, &never_cancelled)?;
    Ok((name, new_col))
}

/// Session-level `evaluate_formula` (see [`calculate_sensor_in_state`] for
/// the `between` seam).
fn evaluate_formula_in_state(
    state: &AppState,
    formula: &str,
    custom_name: Option<&str>,
    replace: bool,
    expected: Option<u64>,
    between: &dyn Fn(),
) -> Result<String, String> {
    check_formula_limits(formula)?;

    // Evaluate under a READ lock, store under a short write lock (see
    // `commit_derived`).
    let (generation, name, col) = {
        let lock = state.0.read().map_err(|e| e.to_string())?;
        let session = lock.as_ref().ok_or_else(|| missing_session_error(expected))?;
        check_expected_generation(expected, session.generation)?;
        let (name, col) = compute_formula_sensor(&session.data, formula, custom_name, replace)?;
        (session.generation, name, col)
    };
    between();
    commit_derived(state, generation, expected, &name, col, replace)
}

/// `expected_generation` (JS `expectedGeneration`) must match the dataset's generation, else `STALE_SESSION_ERROR` and nothing changes.
#[tauri::command]
async fn evaluate_formula(
    formula: String,
    custom_name: Option<String>,
    replace: Option<bool>,
    expected_generation: Option<u64>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let _serial = SENSOR_CHANGE_LOCK.lock().await;
    on_blocking_pool(app, move |state| {
        evaluate_formula_in_state(
            state,
            &formula,
            custom_name.as_deref(),
            replace.unwrap_or(false),
            expected_generation,
            &|| {},
        )
    })
    .await
}


/// Default / ceiling of `preview_formula`'s downsampled series.
const FORMULA_PREVIEW_DEFAULT_POINTS: usize = 600;
const FORMULA_PREVIEW_MAX_POINTS: usize = 2000;

/// An Average / Median / Sum block, previewed exactly as
/// `calculate_new_sensor` (mode `multi`) would build it.
#[derive(Debug, Deserialize, Clone)]
struct FormulaPreviewAggregate {
    /// `"mean"` (Average) | `"median"` | `"sum"`
    #[serde(rename = "type")]
    op_type: String,
    sources: Vec<String>,
    /// Same meaning as `SensorOperationConfig.multiOp.decimals`.
    #[serde(default)]
    decimals: Option<f64>,
}

#[derive(Debug, Serialize, PartialEq)]
struct FormulaPreviewStats {
    /// Over the rows that have a value; `null` when none has.
    min: Option<f64>,
    max: Option<f64>,
    mean: Option<f64>,
    /// Every row of the dataset.
    rows: usize,
    /// Rows without a value (a missing input or a non-finite result).
    missing: usize,
}

#[derive(Debug, Serialize)]
struct FormulaPreviewLimits {
    max_len: usize,
    max_depth: i32,
}

#[derive(Debug, Serialize)]
struct FormulaPreview {
    ok: bool,
    /// Empty when `ok`; otherwise the gate's refusal (one entry today).
    issues: Vec<FormulaIssue>,
    /// `null` when not `ok`.
    stats: Option<FormulaPreviewStats>,
    /// Min/max-preserving downsample, at most `max_points`; arrays equal length, empty when not ok.
    timestamps: Vec<String>,
    values: Vec<Option<f64>>,
    /// `[first, last]` timestamp text of the dataset, same format as `timestamps`; null if not ok or no parseable time.
    period: Option<[String; 2]>,
    /// Every engine function name (the editor's suggestion / error list).
    functions: &'static [&'static str],
    limits: FormulaPreviewLimits,
    /// Set only for a `round_excel` refusal when converting every spreadsheet-order round passes the gate; offered as the fix.
    converted_formula: Option<String>,
}

impl FormulaPreview {
    fn refused(issue: FormulaIssue, converted_formula: Option<String>) -> Self {
        FormulaPreview {
            ok: false,
            issues: vec![issue],
            stats: None,
            timestamps: Vec::new(),
            values: Vec::new(),
            period: None,
            functions: FORMULA_FUNCTIONS,
            limits: FormulaPreviewLimits { max_len: MAX_FORMULA_LEN, max_depth: MAX_FORMULA_DEPTH },
            converted_formula,
        }
    }
}

/// Pure core of `preview_formula`: validation and values come from the same gate and column builders as Create/Save; only the output is bounded. Create mode, never cancelled.
#[cfg(test)]
fn build_formula_preview(
    data: &ColumnarData,
    formula: Option<&str>,
    aggregate: Option<&FormulaPreviewAggregate>,
    max_points: Option<usize>,
) -> Result<FormulaPreview, String> {
    build_formula_preview_with(data, formula, aggregate, max_points, false, &never_cancelled)
}

/// `build_formula_preview` with options: `replace` answers as Save/replay would (skips create-only refusals); `cancelled` is checked per chunk and before output, giving `Err(FORMULA_PREVIEW_CANCELLED)`.
fn build_formula_preview_with(
    data: &ColumnarData,
    formula: Option<&str>,
    aggregate: Option<&FormulaPreviewAggregate>,
    max_points: Option<usize>,
    replace: bool,
    cancelled: CancelCheck,
) -> Result<FormulaPreview, String> {
    let col = match (formula, aggregate) {
        (Some(_), Some(_)) => return Err("BAD_REQUEST: send either formula or aggregate, not both".to_string()),
        (None, None) => return Err("BAD_REQUEST: send formula or aggregate".to_string()),
        (Some(f), None) => match formula_gate(&data.headers, f, replace) {
            Ok((compiled, src_idx)) => eval_formula_column(data, &compiled, &src_idx, cancelled)?,
            Err(issue) => {
                let converted = (issue.code == formula_diagnostics::ROUND_EXCEL)
                    .then(|| formula_diagnostics::convert_legacy_round(f))
                    .filter(|c| c != f && formula_gate(&data.headers, c, replace).is_ok());
                return Ok(FormulaPreview::refused(issue, converted));
            }
        },
        (None, Some(a)) => {
            let op = MultiOperation { op_type: a.op_type.clone(), decimals: a.decimals };
            match check_multi_operation(&data.headers, &a.sources, &op, !replace) {
                Ok(idx) => compute_multi_column(data, &idx, &op, cancelled)?,
                Err(issue) => return Ok(FormulaPreview::refused(issue, None)),
            }
        }
    };
    if cancelled() {
        return Err(FORMULA_PREVIEW_CANCELLED.to_string());
    }

    let (mut min, mut max, mut sum, mut present) = (f64::INFINITY, f64::NEG_INFINITY, 0.0f64, 0usize);
    for &v in &col {
        if v.is_nan() {
            continue;
        }
        present += 1;
        sum += v;
        min = min.min(v);
        max = max.max(v);
    }
    let some = |v: f64| (present > 0).then_some(v);
    let stats = FormulaPreviewStats {
        min: some(min),
        max: some(max),
        mean: some(sum / present.max(1) as f64),
        rows: col.len(),
        missing: col.len() - present,
    };

    let points = max_points
        .unwrap_or(FORMULA_PREVIEW_DEFAULT_POINTS)
        .clamp(2, FORMULA_PREVIEW_MAX_POINTS);
    let ts_at = |k: usize| data.timestamps[k].clone().unwrap_or_default();
    let val_at = |k: usize, _c: usize| col[k];
    let (timestamps, mut series) = chart_query::decimate(col.len(), 1, &ts_at, &val_at, points);
    let values = series.pop().unwrap_or_default();

    Ok(FormulaPreview {
        ok: true,
        issues: Vec::new(),
        stats: Some(stats),
        timestamps,
        values,
        period: dataset_period_text(data),
        functions: FORMULA_FUNCTIONS,
        limits: FormulaPreviewLimits { max_len: MAX_FORMULA_LEN, max_depth: MAX_FORMULA_DEPTH },
        converted_formula: None,
    })
}

/// Earliest/latest row by `ts_parsed` (not string order), as that row's timestamp text; `None` if no parseable time or text.
fn dataset_period_text(data: &ColumnarData) -> Option<[String; 2]> {
    let mut first: Option<(i64, usize)> = None;
    let mut last: Option<(i64, usize)> = None;
    for (r, &us) in data.ts_parsed.iter().enumerate() {
        if us == TS_MISSING {
            continue;
        }
        if first.is_none_or(|(m, _)| us < m) {
            first = Some((us, r));
        }
        if last.is_none_or(|(m, _)| us > m) {
            last = Some((us, r));
        }
    }
    let text = |r: usize| data.timestamps.get(r).cloned().flatten();
    Some([text(first?.1)?, text(last?.1)?])
}

/// Latest `preview_formula` `requestId` (0 = none); an older running preview stops at its next chunk.
static FORMULA_PREVIEW_LATEST: AtomicU64 = AtomicU64::new(0);

/// Record `id` as the latest preview request (called as the request arrives,
/// before it is queued for evaluation).
fn register_preview_request(token: &AtomicU64, id: Option<u64>) {
    if let Some(id) = id {
        token.store(id, AtomicOrdering::SeqCst);
    }
}

/// Testable `preview_formula`; the read lock keeps chart queries running. `Err(FORMULA_PREVIEW_CANCELLED)` once the token holds a different id (checked on entry and per chunk).
fn preview_formula_in_state(
    state: &AppState,
    formula: Option<&str>,
    aggregate: Option<&FormulaPreviewAggregate>,
    max_points: Option<usize>,
    expected: Option<u64>,
    replace: bool,
    request: Option<(&AtomicU64, u64)>,
) -> Result<FormulaPreview, String> {
    let cancelled = move || request.is_some_and(|(token, id)| token.load(AtomicOrdering::Relaxed) != id);
    if cancelled() {
        return Err(FORMULA_PREVIEW_CANCELLED.to_string());
    }
    let lock = state.0.read().map_err(|e| e.to_string())?;
    let session = lock.as_ref().ok_or_else(|| missing_session_error(expected))?;
    check_expected_generation(expected, session.generation)?;
    build_formula_preview_with(&session.data, formula, aggregate, max_points, replace, &cancelled)
}

/// Live check + preview for the Formula editor: send `formula` OR `aggregate`; verdict matches Create/Save; response bounded (`maxPoints` default 600, max 2000). A refusal is `ok: false` with `issues`; `Err` only for `BAD_REQUEST:`, no data, `STALE_SESSION`, `CANCELLED:`.
/// `replace`: send what Save will send. `requestId`: a newer id cancels an older running preview (it answers `CANCELLED:`; ignore it). Keys stay camelCase: snake_case would drop `expectedGeneration`.
#[tauri::command]
async fn preview_formula(
    formula: Option<String>,
    aggregate: Option<FormulaPreviewAggregate>,
    max_points: Option<usize>,
    expected_generation: Option<u64>,
    replace: Option<bool>,
    request_id: Option<u64>,
    app: tauri::AppHandle,
) -> Result<FormulaPreview, String> {
    register_preview_request(&FORMULA_PREVIEW_LATEST, request_id);
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<AppState>();
        preview_formula_in_state(
            &state,
            formula.as_deref(),
            aggregate.as_ref(),
            max_points,
            expected_generation,
            replace.unwrap_or(false),
            request_id.map(|id| (&FORMULA_PREVIEW_LATEST, id)),
        )
    })
    .await
    .map_err(|e| format!("Formula preview failed: {e}"))?
}

#[derive(Debug, Serialize, PartialEq)]
struct LegacyFormulaConversion {
    formula: String,
    changed: bool,
}

/// Rewrites spreadsheet-order `round(x, n)` to `round(x * 10^n) / 10^n` (`round(x)` for n = 0). Pure text; unchanged if no such call, `n` is not a whole number 0..=15, or the formula is over the size/depth limits.
/// The result is not re-checked, so callers re-gate it.
#[tauri::command]
fn convert_legacy_formula(formula: String) -> LegacyFormulaConversion {
    if formula_limit_issue(&formula).is_some() {
        return LegacyFormulaConversion { formula, changed: false };
    }
    let converted = formula_diagnostics::convert_legacy_round(&formula);
    let changed = converted != formula;
    LegacyFormulaConversion { formula: converted, changed }
}

#[tauri::command]
async fn load_mapping_csv(path: String, app: tauri::AppHandle) -> Result<MappingData, String> {
    on_blocking_pool(app, move |_| {
        validate_read_path(&path).map_err(|e| format!("invalid path '{}': {}", path, e))?;
        csv_processor::load_mapping_csv_data(&path)
    })
    .await
}

#[tauri::command]
fn apply_sensor_mapping(
    key_column: String,
    mapping_data: MappingData,
    dataset_headers: Vec<String>,
) -> Result<MappingResult, String> {
    csv_processor::apply_mapping(&key_column, &mapping_data, &dataset_headers)
}

#[derive(Debug, Deserialize, Clone)]
struct ValueFilter {
    sensor: String,
    operation: String, // "greater_than" | "less_than" | "between" | "equals"
    value1: Option<f64>,
    value2: Option<f64>,
}

#[derive(Debug, Deserialize, Default, Clone)]
struct DataFilter {
    sensors: Vec<String>,
    timestamp_start: Option<String>,
    timestamp_end: Option<String>,
    value_filters: Vec<ValueFilter>,
    /// Passed to `PreviewFilter.combine`. Dashboard's chart never sets it (stays "and"); the Build Model target chart does. Rust can't tell the callers apart, so accept it.
    #[serde(default)]
    combine: Option<String>,
    /// Multiple training periods — passed straight through to
    /// `PreviewFilter.timestamp_ranges` (the PM target chart uses this type).
    #[serde(default)]
    timestamp_ranges: Vec<TimeRangeArg>,
}

impl DataFilter {
    /// Bridge to `PreviewFilter` so all data-reading commands share `ResolvedFilter` semantics.
    fn to_preview(&self) -> PreviewFilter {
        PreviewFilter {
            timestamp_start: self.timestamp_start.clone(),
            timestamp_end: self.timestamp_end.clone(),
            value_filters: self
                .value_filters
                .iter()
                .map(|vf| PreviewValueFilter {
                    sensor: vf.sensor.clone(),
                    operation: vf.operation.clone(),
                    value1: vf.value1,
                    value2: vf.value2,
                })
                .collect(),
            combine: self.combine.clone(),
            timestamp_ranges: self.timestamp_ranges.clone(),
        }
    }
}

/// Bounded chart payload: filter, operation transform, optional hourly aggregation, min/max decimation to `max_points`, all Rust-side; the WebView gets O(max_points) arrays.
// `rename_all = "snake_case"`: the frontend sends `max_points` verbatim
// (same convention as `get_scatter_sample`).
#[tauri::command(rename_all = "snake_case")]
async fn get_chart_data(
    filter: DataFilter,
    sampling: String,
    operation: Option<chart_query::OperationConfig>,
    max_points: usize,
    app: tauri::AppHandle,
) -> Result<chart_query::ChartView, String> {
    on_blocking_pool(app, move |state| {
        let state_lock = state.0.read().map_err(|e| e.to_string())?;
        let session = state_lock.as_ref().ok_or("No data loaded")?;
        chart_query::build_chart_view(
            &session.data,
            &filter,
            operation.as_ref(),
            &sampling,
            max_points,
        )
    })
    .await
}

/// True first/last timestamp of the WHOLE dataset, ignoring the dashboard time filter; anchors the "data available" label and the relative-range buttons.
#[derive(Debug, Serialize)]
struct DatasetTimeBounds {
    min: Option<String>,
    max: Option<String>,
}

#[tauri::command]
async fn get_dataset_time_bounds(app: tauri::AppHandle) -> Result<DatasetTimeBounds, String> {
    on_blocking_pool(app, |state| {
        let state_lock = state.0.read().map_err(|e| e.to_string())?;
        let session = state_lock.as_ref().ok_or("No data loaded")?;
        let (min, max) = chart_query::full_dataset_time_bounds(&session.data);
        Ok(DatasetTimeBounds { min, max })
    })
    .await
}

/// Tiny xorshift64* PRNG for reservoir sampling; fixed seed so the same dataset + filter gives the same sample (the scatter doesn't reshuffle on refetch).
struct Xorshift64 {
    state: u64,
}
impl Xorshift64 {
    fn new(seed: u64) -> Self {
        // Avoid the all-zero state (xorshift's fixed point).
        Xorshift64 { state: seed | 1 }
    }
    fn next_u64(&mut self) -> u64 {
        let mut x = self.state;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.state = x;
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }
    /// Uniform integer in `[0, bound)`. Modulo bias is negligible at our scale.
    fn next_bounded(&mut self, bound: u64) -> u64 {
        if bound == 0 {
            0
        } else {
            self.next_u64() % bound
        }
    }
}

/// Bounded sample for scatter/pair-plot; `rows.len()` never exceeds `max_points`, keeping IPC, JS heap and GPU buffers bounded.
#[derive(serde::Serialize)]
struct ScatterSample {
    /// Sensor names in each row's `values` order; only existing sensors, so `headers.len() == rows[i].values.len()`.
    headers: Vec<String>,
    rows: Vec<CsvRecord>,
    /// Total rows that passed the filter (the population we sampled from).
    total: usize,
    /// Number of rows actually returned (`== rows.len()`, `<= max_points`).
    sampled: usize,
}

/// Uniform sample of at most `max_points` filtered rows by reservoir sampling (Algorithm R): O(n) time, O(max_points) memory; rows are projected only when kept.
// Needs `rename_all = "snake_case"`, or the macro expects `maxPoints` and invoke fails with "missing required key".
#[tauri::command(rename_all = "snake_case")]
async fn get_scatter_sample(
    filter: DataFilter,
    max_points: usize,
    app: tauri::AppHandle,
) -> Result<ScatterSample, String> {
    on_blocking_pool(app, move |state| {
        let state_lock = state.0.read().map_err(|e| e.to_string())?;
        let session = state_lock.as_ref().ok_or("No data loaded")?;
        sample_dataset(&session.data, &filter, max_points)
    })
    .await
}

/// Pure core of `get_scatter_sample`: reservoir-samples filtered rows projected to `filter.sensors`.
fn sample_dataset(
    data: &ColumnarData,
    filter: &DataFilter,
    max_points: usize,
) -> Result<ScatterSample, String> {
    // Clamp to 1..=2,000,000 so a bad caller can't request an OOM-sized sample.
    let cap = max_points.clamp(1, 2_000_000);

    // Drop unknown sensors; `resolved_headers` stays aligned 1:1 with `sensor_indices`.
    let mut sensor_indices: Vec<usize> = Vec::new();
    let mut resolved_headers: Vec<String> = Vec::new();
    for s in &filter.sensors {
        if let Some(idx) = data.headers.iter().position(|h| h == s) {
            sensor_indices.push(idx);
            resolved_headers.push(s.clone());
        }
    }

    // Same gate as every data-reading command: one shared `ResolvedFilter`,
    // comparing load-time-parsed timestamps (no per-row parsing).
    let preview = filter.to_preview();
    let resolved = ResolvedFilter::resolve(Some(&preview), &data.headers)?;

    // The reservoir holds row indices; rows are materialised once at the end.
    let mut reservoir: Vec<usize> = Vec::with_capacity(cap.min(data.n_rows()));
    let mut seen: usize = 0;
    let mut rng = Xorshift64::new(0x9E3779B97F4A7C15);

    for r in 0..data.n_rows() {
        if !resolved.is_noop() && !resolved.keeps(data, r) {
            continue;
        }

        if reservoir.len() < cap {
            reservoir.push(r); // still filling → append
        } else {
            let j = rng.next_bounded((seen + 1) as u64) as usize;
            if j < cap {
                reservoir[j] = r; // replace an existing reservoir slot
            }
        }
        seen += 1;
    }

    let rows: Vec<CsvRecord> = reservoir
        .iter()
        .map(|&r| data.wire_record(r, &sensor_indices))
        .collect();
    let sampled = rows.len();
    Ok(ScatterSample {
        headers: resolved_headers,
        rows,
        total: seen,
        sampled,
    })
}


/// Bounded per-kind data for Model fit and Health score: stats, set-point validation, downsampled series, histogram/scatter. `series` = raw rows (never scored); `hourly` = per-clock-hour means, which the score is computed on.
/// Relationship reads the fit cached under `cache_key` (unknown = `NOT_FITTED:`) and runs the sidecar only for hourly points nobody predicted. If that fails, those hours go unscored with a `test_scoring_*` warning, remembered until re-train, a point change or `retry_test_scoring`.
#[tauri::command]
async fn compute_health_preview(
    request: health_preview::HealthPreviewRequest,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<health_preview::HealthPreview, String> {
    // `reason` arrives already bounded (`truncate_log_detail` in predict_rel_hours).
    let log = |reason: &str| {
        if let Ok(path) = error_log_path(&app) {
            append_error_line(
                &path,
                "test-scoring",
                "The health score could not be calculated (Relation model prediction step)",
                Some(reason),
            );
        }
    };
    let runner_app = app.clone();
    let scoring_error = predict_rel_hours(
        &state,
        &request,
        &REL_EXTRA_LOCK,
        &SIDECAR_KNOWN_OUTDATED,
        move |job| async move {
            let result = run_predict_relationship(&runner_app, &job).await;
            (job, result)
        },
        &log,
    )
    .await?;
    health_preview_with_outcome(&state, &request, scoring_error.map(|e| e.kind))
}

/// Set once a sidecar run answers `SIDECAR_OUTDATED` (the binary can't change while running); later previews skip the ~15 s run. Not cleared by `retry_test_scoring`.
static SIDECAR_KNOWN_OUTDATED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Never shown; stands in for a remembered failure whose retry wasn't requested (the user sees the failure kind's warning).
const TEST_SCORING_PREVIOUSLY_FAILED: &str =
    "the last prediction attempt for this fit and these hourly points failed (not retried until \
     the points change, a re-train or an explicit retry)";

/// Why the Relationship health score can't be calculated: `kind` picks the user warning; `reason` is raw detail, logged only.
#[derive(Debug, Clone, PartialEq, Eq)]
struct TestScoringError {
    kind: health_validation::TestScoringFailure,
    reason: String,
}

impl TestScoringError {
    fn new(kind: health_validation::TestScoringFailure, reason: impl Into<String>) -> Self {
        TestScoringError { kind, reason: reason.into() }
    }
}

/// Cap on error-log detail: a sidecar parse error can carry the engine's whole stdout (megabytes).
const ERROR_LOG_DETAIL_MAX: usize = 4 * 1024;

/// `s` cut to at most `max` bytes (on a char boundary) plus
/// "… (N bytes truncated)"; unchanged when it already fits.
fn truncate_log_detail(s: &str, max: usize) -> std::borrow::Cow<'_, str> {
    if s.len() <= max {
        return std::borrow::Cow::Borrowed(s);
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    std::borrow::Cow::Owned(format!("{}… ({} bytes truncated)", &s[..end], s.len() - end))
}

/// Hourly-prediction step of `compute_health_preview`, generic over the sidecar run and log for testing. `Ok(None)` = nothing to do or stored; `Ok(Some(e))` = points left unpredicted (caller degrades with `e.kind`); `Err` = request refused (`STALE_SESSION`/`NOT_FITTED`).
/// Plans without `serial`, so stored or known-failed points never wait for another ~15 s run, then re-plans under it. Failures are logged and remembered per attempted points; results land only on the fit they were computed for.
async fn predict_rel_hours<R, Fut>(
    state: &AppState,
    request: &health_preview::HealthPreviewRequest,
    serial: &tauri::async_runtime::Mutex<()>,
    outdated: &std::sync::atomic::AtomicBool,
    run: R,
    log: &(dyn Fn(&str) + Sync),
) -> Result<Option<TestScoringError>, String>
where
    R: FnOnce(RelExtraJob) -> Fut,
    Fut: std::future::Future<Output = (RelExtraJob, Result<Vec<f64>, String>)>,
{
    use health_validation::TestScoringFailure as Kind;
    use std::sync::atomic::Ordering;
    if request.kind != "relationship" {
        return Ok(None);
    }
    if request.retry_test_scoring {
        clear_rel_extra_failed(state, request);
    }
    // 1. Without the lock, and without building the job.
    match plan_rel_extra_ex(state, request, outdated.load(Ordering::SeqCst), false)? {
        ExtraPlan::Nothing => return Ok(None),
        ExtraPlan::Failed(e) => return Ok(Some(e)),
        ExtraPlan::Needed(_) => {}
    }
    // 2. One prediction run at a time; re-plan under the lock.
    let serial_guard = serial.lock().await;
    let (outcome, to_log) = 'locked: {
        let job = match plan_rel_extra_ex(state, request, outdated.load(Ordering::SeqCst), true)? {
            ExtraPlan::Nothing => return Ok(None),
            ExtraPlan::Failed(e) => return Ok(Some(e)),
            ExtraPlan::Needed(Some(job)) => job,
            ExtraPlan::Needed(None) => {
                // `build_job = true` always builds the job: a bug if reached.
                if cfg!(debug_assertions) {
                    unreachable!("plan_rel_extra_ex(build_job = true) returned no job");
                }
                let e = TestScoringError::new(
                    Kind::EngineError,
                    "internal error: the prediction step was planned without a job",
                );
                let line = e.reason.clone();
                break 'locked (Some(e), Some(line));
            }
        };
        let (job, result) = run(job).await;
        let failure = match result {
            Ok(predicted) => match apply_rel_extra(state, &job, &predicted)? {
                ExtraStored::Stored => None,
                ExtraStored::OverBudget => Some(TestScoringError::new(
                    Kind::OverBudget,
                    format!("the predictions of {} hourly points do not fit the model cache", job.points.len()),
                )),
                ExtraStored::Superseded => {
                    // Re-trained under the same key meanwhile: predictions dropped. Not a failure; answer for the new fit and never mark it.
                    let again = plan_rel_extra_ex(state, request, outdated.load(Ordering::SeqCst), false)?;
                    break 'locked (
                        match again {
                            ExtraPlan::Nothing => None,
                            ExtraPlan::Failed(e) => Some(e),
                            ExtraPlan::Needed(_) => Some(TestScoringError::new(
                                Kind::EngineError,
                                "the model was trained again while its hourly points were being predicted",
                            )),
                        },
                        None,
                    );
                }
                // `apply_rel_extra` already answers this with `Err(NOT_FITTED)`.
                ExtraStored::FitGone => return Err(health_preview::not_fitted(REL_EXTRA_FIT_GONE)),
            },
            // The dataset was replaced, or the user stopped the run: not a failure of this fit.
            Err(e) if e == STALE_SESSION_ERROR || e == ENGINE_STOPPED_ERROR => return Err(e),
            Err(e) if e.starts_with("SIDECAR_OUTDATED") => Some(TestScoringError::new(Kind::Outdated, e)),
            Err(e) => Some(TestScoringError::new(Kind::EngineError, e)),
        };
        let mut line = None;
        if let Some(f) = &failure {
            line = Some(format!("model {}: {}", job.key, f.reason));
            // Remember while `serial` is held, so the next caller re-plans against it.
            if f.kind == Kind::Outdated {
                outdated.store(true, Ordering::SeqCst);
            } else {
                mark_rel_extra_failed(state, &job, f.kind);
            }
        }
        (failure, line)
    };
    drop(serial_guard);
    if let Some(line) = to_log {
        log(&truncate_log_detail(&line, ERROR_LOG_DETAIL_MAX));
    }
    Ok(outcome)
}

/// Marks a failed attempt only on the same data (`stamp`) and the very same fit.
fn mark_rel_extra_failed(state: &AppState, job: &RelExtraJob, kind: health_validation::TestScoringFailure) {
    if let Ok(mut lock) = state.0.write() {
        if let Some(s) = lock.as_mut().filter(|s| s.stamp() == job.stamp) {
            s.rel_cache.mark_extra_failed(&job.key, &job.fit, &job.points, kind);
        }
    }
}

/// `retry_test_scoring`: forget the failed attempt of the request's fit.
fn clear_rel_extra_failed(state: &AppState, request: &health_preview::HealthPreviewRequest) {
    let Some(key) = request.cache_key.as_deref().filter(|k| !k.is_empty()) else {
        return;
    };
    if let Ok(mut lock) = state.0.write() {
        if let Some(s) = lock.as_mut() {
            s.rel_cache.clear_extra_failed(key);
        }
    }
}

/// `health_preview_in` plus the degraded answer when hourly prediction failed: `scoring_error` kind picks the warning (`test_scoring_outdated`/`_too_large`/`_failed`).
/// Fit, stats and raw series are untouched; unpredicted hours and all scoring periods are unscored.
fn health_preview_with_outcome(
    state: &AppState,
    request: &health_preview::HealthPreviewRequest,
    scoring_error: Option<health_validation::TestScoringFailure>,
) -> Result<health_preview::HealthPreview, String> {
    let mut preview = health_preview_in(state, request)?;
    if let Some(kind) = scoring_error {
        if let Some(tv) = preview.test_validation.as_mut() {
            health_validation::mark_unscored(tv);
        }
        preview.validation.push(health_validation::test_scoring_issue(kind));
    }
    Ok(preview)
}

/// Serialises the sidecar runs that fill the Relationship hourly predictions.
static REL_EXTRA_LOCK: tauri::async_runtime::Mutex<()> = tauri::async_runtime::Mutex::const_new(());

/// What one `predict_relationship` run needs (copied out of the session so no
/// lock is held across the sidecar).
#[derive(Debug)]
struct RelExtraJob {
    key: String,
    /// The dataset / special-sensor state the rows were read from; the result is
    /// only stored if it is still current.
    stamp: SessionStamp,
    /// The fit this job predicts for; a same-key re-train replaces it, and nothing from this job may then land. `Weak` gives identity without keeping old columns alive.
    fit: std::sync::Weak<health_score::RelFit>,
    predictors: Vec<String>,
    target: String,
    lambda: f64,
    /// The hourly points to predict (hour + the hour's mean predictors), in the
    /// order of `x_extra`.
    points: health_score::RelHourPoints,
    /// The TRAIN rows the model is fitted on (row-major) and their target.
    x: Vec<Vec<f64>>,
    y: Vec<f64>,
    /// `points` as the sidecar's `X_extra` rows.
    x_extra: Vec<Vec<f64>>,
}

/// What [`plan_rel_extra_ex`] found.
#[derive(Debug)]
enum ExtraPlan {
    /// Nothing to predict: all cached, or a request `health_preview_in` itself refuses.
    Nothing,
    /// Points missing but not to be predicted now: sidecar known outdated, or the last attempt failed for exactly these points.
    Failed(TestScoringError),
    /// Points are missing; the job when it was asked for (`build_job`).
    Needed(Option<RelExtraJob>),
}

/// Hourly points with no stored prediction; with `build_job`, also what is needed to predict them (otherwise skips copying the training matrix). No scoring periods: training hours only; with them: the whole universe plus shared-hour versions, so removing a period is free.
fn plan_rel_extra_ex(
    state: &AppState,
    request: &health_preview::HealthPreviewRequest,
    sidecar_outdated: bool,
    build_job: bool,
) -> Result<ExtraPlan, String> {
    let lock = state.0.read().map_err(|e| e.to_string())?;
    let session = lock
        .as_ref()
        .ok_or_else(|| missing_session_error(request.expected_generation))?;
    check_expected_generation(request.expected_generation, session.generation)?;
    let Some(key) = request.cache_key.as_deref().filter(|k| !k.is_empty()) else {
        return Ok(ExtraPlan::Nothing);
    };
    let Some(fit) = session.rel_cache.peek(key) else {
        return Ok(ExtraPlan::Nothing);
    };
    if request.target.as_deref().is_some_and(|t| t != fit.target)
        || (!request.predictors.is_empty() && request.predictors != fit.predictors)
    {
        return Ok(ExtraPlan::Nothing);
    }
    let data = &session.data;
    let plan = request.test_plan(data);
    // The dataset columns are only needed for the rows of a scoring period.
    let pcols: Vec<usize> = match &plan {
        Some(_) => {
            let Some(pcols) = fit
                .predictors
                .iter()
                .map(|p| data.col_index(p))
                .collect::<Option<Vec<usize>>>()
            else {
                return Ok(ExtraPlan::Nothing);
            };
            pcols
        }
        None => Vec::new(),
    };
    let cols = match &plan {
        Some(_) => {
            let Some(tcol) = data.col_index(&fit.target) else {
                return Ok(ExtraPlan::Nothing);
            };
            Some(health_validation::RelCols {
                target: tcol,
                predictors: &pcols,
            })
        }
        None => None,
    };
    // The same points the Train pre-warm and the export predict (one function).
    let mut points = health_validation::RelHours::build(
        data,
        &health_validation::RelTrain::of(&fit),
        plan.as_ref().zip(cols.as_ref()),
    )
    .points();
    if let Some(known) = session.rel_cache.peek_extra(key) {
        points.retain(|hour, x| !known.has(hour, x));
    }
    if points.is_empty() {
        return Ok(ExtraPlan::Nothing);
    }
    if sidecar_outdated {
        return Ok(ExtraPlan::Failed(TestScoringError::new(
            health_validation::TestScoringFailure::Outdated,
            SIDECAR_OUTDATED,
        )));
    }
    if let Some(kind) = session.rel_cache.extra_failed(key, &points) {
        return Ok(ExtraPlan::Failed(TestScoringError::new(kind, TEST_SCORING_PREVIOUSLY_FAILED)));
    }
    if !build_job {
        return Ok(ExtraPlan::Needed(None));
    }
    let x: Vec<Vec<f64>> = (0..fit.rows.len())
        .map(|i| fit.x_cols.iter().map(|c| c[i]).collect())
        .collect();
    let x_extra = points.x_rows();
    Ok(ExtraPlan::Needed(Some(RelExtraJob {
        key: key.to_string(),
        stamp: session.stamp(),
        fit: std::sync::Arc::downgrade(&fit),
        predictors: fit.predictors.clone(),
        target: fit.target.clone(),
        lambda: fit.lambda,
        points,
        x,
        y: fit.actual.clone(),
        x_extra,
    })))
}

/// Test helper: the job when hourly points must be
/// predicted (ignores the outdated flag; a failed marker reads as `None`).
#[cfg(test)]
fn plan_rel_extra(
    state: &AppState,
    request: &health_preview::HealthPreviewRequest,
) -> Result<Option<RelExtraJob>, String> {
    Ok(match plan_rel_extra_ex(state, request, false, true)? {
        ExtraPlan::Needed(job) => job,
        ExtraPlan::Nothing | ExtraPlan::Failed(_) => None,
    })
}

/// Outcome of [`merge_rel_extra`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExtraStored {
    Stored,
    /// The dataset / special sensors changed, or the fit left the cache.
    FitGone,
    /// The key now holds another fit (re-trained meanwhile); predictions dropped.
    Superseded,
    /// The fit is still cached but fit + predictions exceed the cache budget.
    OverBudget,
}

/// Store hourly predictions under `key` - only into the very fit (`fit`) they
/// were computed for, on the same data (`stamp`).
fn merge_rel_extra(
    state: &AppState,
    stamp: SessionStamp,
    key: &str,
    fit: &std::sync::Weak<health_score::RelFit>,
    points: &health_score::RelHourPoints,
    predicted: &[f64],
) -> ExtraStored {
    let Ok(mut lock) = state.0.write() else {
        return ExtraStored::FitGone;
    };
    match lock.as_mut() {
        Some(s) if s.stamp() == stamp => {
            if s.rel_cache.merge_extra(key, fit, points, predicted) {
                ExtraStored::Stored
            } else if s.rel_cache.is_current(key, fit) {
                ExtraStored::OverBudget
            } else if s.rel_cache.peek(key).is_some() {
                ExtraStored::Superseded
            } else {
                ExtraStored::FitGone
            }
        }
        _ => ExtraStored::FitGone,
    }
}

/// `NOT_FITTED` detail when the data or the fit left while predicting.
const REL_EXTRA_FIT_GONE: &str =
    "the data or the model changed while the health score was being calculated - train the model again";

/// Stores a job's predictions only into its own fit on the same data. `OverBudget` = fit stays but predictions exceed the cache budget; `Superseded` = re-trained under the key; `Err(NOT_FITTED)` = data changed or fit evicted.
fn apply_rel_extra(state: &AppState, job: &RelExtraJob, predicted: &[f64]) -> Result<ExtraStored, String> {
    match merge_rel_extra(state, job.stamp, &job.key, &job.fit, &job.points, predicted) {
        ExtraStored::FitGone => Err(health_preview::not_fitted(REL_EXTRA_FIT_GONE)),
        other => Ok(other),
    }
}

/// Longest wait for one sidecar run (normally ~15 s); only a hung engine reaches it.
const ENGINE_RUN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// After a kill, how long to wait for the end event before giving up on it.
const ENGINE_KILL_GRACE: std::time::Duration = std::time::Duration::from_secs(5);

/// How often a running engine checks that its caller still wants the answer.
const ENGINE_WANTED_POLL: std::time::Duration = std::time::Duration::from_millis(250);

/// Why [`arm_engine_stop`] stopped a run.
#[derive(Default)]
struct EngineStopFlags {
    timed_out: std::sync::atomic::AtomicBool,
    superseded: std::sync::atomic::AtomicBool,
}

/// Runs `on_stop` on a helper thread after `limit` or once `still_wanted` is false; dropping the returned `Sender` ends the thread at once.
fn arm_engine_stop<W, F>(
    limit: std::time::Duration,
    still_wanted: W,
    on_stop: F,
) -> (std::sync::mpsc::Sender<()>, std::sync::Arc<EngineStopFlags>)
where
    W: Fn() -> bool + Send + 'static,
    F: FnOnce() + Send + 'static,
{
    use std::sync::atomic::Ordering::SeqCst;
    use std::sync::mpsc::RecvTimeoutError::Timeout;
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    let flags = std::sync::Arc::new(EngineStopFlags::default());
    let thread_flags = flags.clone();
    std::thread::spawn(move || {
        let started = std::time::Instant::now();
        loop {
            let left = limit.saturating_sub(started.elapsed());
            if !matches!(done_rx.recv_timeout(left.min(ENGINE_WANTED_POLL)), Err(Timeout)) {
                return;
            }
            if started.elapsed() >= limit {
                thread_flags.timed_out.store(true, SeqCst);
                break;
            }
            if !still_wanted() {
                thread_flags.superseded.store(true, SeqCst);
                break;
            }
        }
        on_stop();
    });
    (done_tx, flags)
}

/// One engine run's output. `timed_out` = killed at the cap; `superseded` = killed because its dataset was replaced. Neither is an answer.
#[derive(Debug, Default)]
struct EngineOutput {
    stdout: String,
    stderr: String,
    timed_out: bool,
    superseded: bool,
}

/// Kills the engine and its children: the one-file launcher runs the real engine as a child, and killing only the launcher leaves it holding the pipes with no end event. Best effort.
fn kill_engine_tree(pid: u32) {
    use std::process::{Command, Stdio};
    let mut commands: Vec<Command> = Vec::new();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
        let mut c = Command::new(std::path::Path::new(&root).join("System32").join("taskkill.exe"));
        c.args(["/F", "/T", "/PID", &pid.to_string()]).creation_flags(CREATE_NO_WINDOW);
        commands.push(c);
    }
    #[cfg(not(windows))]
    {
        let mut children = Command::new("/usr/bin/pkill");
        children.args(["-KILL", "-P", &pid.to_string()]);
        commands.push(children);
        let mut parent = Command::new("/bin/kill");
        parent.args(["-KILL", &pid.to_string()]);
        commands.push(parent);
    }
    for mut c in commands {
        let _ = c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
}

/// Sends the request and collects output until the run ends. After `limit` or when `still_wanted` is false `kill` runs; after `grace` more the wait stops regardless. The cap covers the write (an engine stuck before reading stdin blocks it); a failed write also kills.
async fn collect_engine_output<W, K, S>(
    mut rx: tauri::async_runtime::Receiver<CommandEvent>,
    write: W,
    kill: K,
    still_wanted: S,
    limit: std::time::Duration,
    grace: std::time::Duration,
) -> EngineOutput
where
    W: FnOnce() -> Result<(), String> + Send + 'static,
    K: Fn() + Send + Sync + 'static,
    S: Fn() -> bool + Send + 'static,
{
    let kill = std::sync::Arc::new(kill);
    let (give_up_tx, mut give_up_rx) = tauri::async_runtime::channel::<()>(1);
    let timer_kill = kill.clone();
    let (done, stop) = arm_engine_stop(limit, still_wanted, move || {
        (*timer_kill)();
        std::thread::sleep(grace);
        let _ = give_up_tx.try_send(());
    });
    let write_error = std::sync::Arc::new(std::sync::Mutex::new(None::<String>));
    let writer_error = write_error.clone();
    // Write off the runtime (a big request blocks until read) while output is drained, or both sides can wait on a full pipe.
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(e) = write() {
            if let Ok(mut slot) = writer_error.lock() {
                *slot = Some(e);
            }
            (*kill)();
        }
    });
    let mut out = EngineOutput::default();
    loop {
        let event = std::future::poll_fn(|cx| {
            if let std::task::Poll::Ready(Some(())) = give_up_rx.poll_recv(cx) {
                return std::task::Poll::Ready(None);
            }
            rx.poll_recv(cx)
        })
        .await;
        match event {
            Some(CommandEvent::Stdout(l)) => out.stdout.push_str(&String::from_utf8_lossy(&l)),
            Some(CommandEvent::Stderr(l)) => out.stderr.push_str(&String::from_utf8_lossy(&l)),
            Some(CommandEvent::Terminated(_)) | None => break,
            Some(_) => {}
        }
    }
    drop(done); // ends the timer thread
    out.timed_out = stop.timed_out.load(std::sync::atomic::Ordering::SeqCst);
    out.superseded = stop.superseded.load(std::sync::atomic::Ordering::SeqCst);
    if let Some(e) = write_error.lock().ok().and_then(|mut slot| slot.take()) {
        out.stderr.push_str(&format!("\nThe request could not be sent: {e}"));
    }
    out
}

/// One engine run at a time, in arrival order (Train, Compare predictors, hourly predictions); a dropped waiter just leaves the line.
static ENGINE_LOCK: tauri::async_runtime::Mutex<()> = tauri::async_runtime::Mutex::const_new(());

/// Waits for the turn, then runs holding it; a caller whose dataset was replaced during the (possibly minutes-long) wait is refused.
async fn run_in_engine_turn<T, Fut>(
    lock: &tauri::async_runtime::Mutex<()>,
    still_wanted: &(dyn Fn() -> bool + Sync),
    run: impl FnOnce() -> Fut,
) -> Result<T, String>
where
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let _turn = lock.lock().await;
    if !still_wanted() {
        return Err(STALE_SESSION_ERROR.to_string());
    }
    run().await
}

/// The engines running now, so the app can stop them when it exits.
struct EngineRegistry {
    closed: bool,
    pids: Vec<u32>,
    /// Bumped by each [`stop_running_engine`]. A run compares it with its value
    /// when it joined the line, so a stop also refuses the callers waiting then.
    stops: u64,
}

impl EngineRegistry {
    const fn new() -> Self {
        EngineRegistry { closed: false, pids: Vec::new(), stops: 0 }
    }
}

/// The caller of a run the user stopped reads this. One line, plain words: it is
/// neither a failure of the run nor of the user's data.
pub const ENGINE_STOPPED_ERROR: &str =
    "This run was stopped before it finished. Your data and settings did not cause this.";

fn request_engine_stop(registry: &std::sync::Mutex<EngineRegistry>) {
    let mut live = lock_engine_registry(registry);
    live.stops = live.stops.wrapping_add(1);
}

fn engine_stop_requested(registry: &std::sync::Mutex<EngineRegistry>, stops_at_start: u64) -> bool {
    lock_engine_registry(registry).stops != stops_at_start
}

fn engine_stops_now(registry: &std::sync::Mutex<EngineRegistry>) -> u64 {
    lock_engine_registry(registry).stops
}

/// Stops the engine run holding the turn (its timer kills the tree within `ENGINE_WANTED_POLL`) and every caller already in line; all get `ENGINE_STOPPED_ERROR`. A caller that arrives later runs normally.
#[tauri::command]
fn stop_running_engine() -> Result<(), String> {
    request_engine_stop(&LIVE_ENGINES);
    Ok(())
}

static LIVE_ENGINES: std::sync::Mutex<EngineRegistry> = std::sync::Mutex::new(EngineRegistry::new());

/// Exit wait for kills; each kill is its own process, so this only has to get them started.
const ENGINE_EXIT_WAIT: std::time::Duration = std::time::Duration::from_millis(300);

fn lock_engine_registry(
    registry: &std::sync::Mutex<EngineRegistry>,
) -> std::sync::MutexGuard<'_, EngineRegistry> {
    registry.lock().unwrap_or_else(|e| e.into_inner())
}

/// A registered engine. Dropped before `finished` (its caller's future was dropped), it kills the engine: nobody reads its answer and the next run must not overlap.
struct TrackedEngine<'a> {
    registry: &'a std::sync::Mutex<EngineRegistry>,
    pid: u32,
    kill: fn(u32),
    finished: bool,
    stops_at_start: u64,
}

impl TrackedEngine<'_> {
    fn finished(mut self) {
        self.finished = true;
    }

    /// What the run's caller gets, once the output is in.
    fn outcome(self, out: EngineOutput) -> Result<EngineOutput, String> {
        let stopped = engine_stop_requested(self.registry, self.stops_at_start);
        self.finished();
        if stopped {
            return Err(ENGINE_STOPPED_ERROR.to_string());
        }
        if out.superseded {
            return Err(STALE_SESSION_ERROR.to_string());
        }
        Ok(out)
    }
}

impl Drop for TrackedEngine<'_> {
    fn drop(&mut self) {
        let pid = self.pid;
        lock_engine_registry(self.registry).pids.retain(|&p| p != pid);
        if !self.finished {
            let kill = self.kill;
            std::thread::spawn(move || kill(pid));
        }
    }
}

/// Starts and records an engine as one step so exit can't miss it; refused once exiting.
fn start_tracked_engine<'a, T>(
    registry: &'a std::sync::Mutex<EngineRegistry>,
    kill: fn(u32),
    start: impl FnOnce() -> Result<(T, u32), String>,
) -> Result<(T, TrackedEngine<'a>), String> {
    let mut live = lock_engine_registry(registry);
    if live.closed {
        return Err("The app is closing.".to_string());
    }
    let (started, pid) = start()?;
    live.pids.push(pid);
    let stops_at_start = live.stops;
    Ok((started, TrackedEngine { registry, pid, kill, finished: false, stops_at_start }))
}

/// Kill every running engine and refuse new ones, waiting at most `wait`.
fn stop_all_engines(
    registry: &std::sync::Mutex<EngineRegistry>,
    kill: fn(u32),
    wait: std::time::Duration,
) {
    let pids = {
        let mut live = lock_engine_registry(registry);
        live.closed = true;
        std::mem::take(&mut live.pids)
    };
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    for &pid in &pids {
        let done = done_tx.clone();
        std::thread::spawn(move || {
            kill(pid);
            let _ = done.send(());
        });
    }
    let deadline = std::time::Instant::now() + wait;
    for _ in &pids {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if done_rx.recv_timeout(left).is_err() {
            return;
        }
    }
}

/// One engine run with `line` on stdin for dataset `generation`. Queued behind other runs; `ENGINE_RUN_TIMEOUT` counts the run only.
/// `STALE_SESSION` if the dataset is replaced during wait or run (a running engine is killed). The child is dropped after the write, closing stdin.
async fn run_engine(app: &tauri::AppHandle, line: String, generation: u64) -> Result<EngineOutput, String> {
    let still_wanted = {
        let app = app.clone();
        move || {
            use tauri::Manager;
            let state = app.state::<AppState>();
            // Can't tell (poisoned lock): let the run finish, its result is stamp-checked.
            session_generation(state.inner()).map_or(true, |current| current == Some(generation))
        }
    };
    let arrival = engine_stops_now(&LIVE_ENGINES);
    run_in_engine_turn(&ENGINE_LOCK, &still_wanted, || async {
        if engine_stop_requested(&LIVE_ENGINES, arrival) {
            return Err(ENGINE_STOPPED_ERROR.to_string());
        }
        let ((rx, mut child), mut engine) = start_tracked_engine(&LIVE_ENGINES, kill_engine_tree, || {
            let (rx, child) = spawn_sidecar(app)?;
            let pid = child.pid();
            Ok(((rx, child), pid))
        })?;
        engine.stops_at_start = arrival; // a stop between the check and the start still counts
        let pid = engine.pid;
        let stops_at_start = engine.stops_at_start;
        let dataset_current = still_wanted.clone();
        let out = collect_engine_output(
            rx,
            move || child.write(line.as_bytes()).map_err(|e| e.to_string()),
            move || kill_engine_tree(pid),
            move || dataset_current() && !engine_stop_requested(&LIVE_ENGINES, stops_at_start),
            ENGINE_RUN_TIMEOUT,
            ENGINE_KILL_GRACE,
        )
        .await;
        engine.outcome(out)
    })
    .await
}

/// Runs one request through the sidecar. Errors are LOG-ONLY (`predict_rel_hours` logs them and shows a fixed warning); a caller that shows errors to the user must use `EngineFailure`'s fixed sentences.
async fn run_sidecar_json(
    app: &tauri::AppHandle,
    payload: &serde_json::Value,
    generation: u64,
) -> Result<serde_json::Value, String> {
    let line = signed_sidecar_line(payload)?;
    let run = run_engine(app, line, generation).await?;
    if run.timed_out {
        return Err(format!(
            "The Relation model engine did not answer within {} s and was stopped.",
            ENGINE_RUN_TIMEOUT.as_secs()
        ));
    }
    if run.stdout.trim().is_empty() {
        return Err(format!("Sidecar returned no output. Stderr: {}", run.stderr.trim()));
    }
    serde_json::from_str(run.stdout.trim())
        .map_err(|e| format!("Failed to parse sidecar output: {e} (raw: {})", run.stdout))
}

/// Bundled sidecar predates `predict_relationship`/`X_extra`. Shown to the user as-is (the frontend maps the `SIDECAR_OUTDATED:` prefix): no developer paths or build steps.
const SIDECAR_OUTDATED: &str = "SIDECAR_OUTDATED: The Relation model engine in this build is out \
    of date - please reinstall or update the app.";

/// `predicted_extra` of a sidecar answer: `want` entries, `NaN` for a missing
/// one; the outdated-sidecar / error cases as errors.
fn parse_predicted_extra(resp: &serde_json::Value, want: usize) -> Result<Vec<f64>, String> {
    if let Some(err) = resp.get("error").and_then(|e| e.as_str()) {
        return Err(if err.contains("Unknown action") {
            SIDECAR_OUTDATED.to_string()
        } else {
            format!("Sidecar error: {err}")
        });
    }
    let arr = resp
        .get("predicted_extra")
        .and_then(|v| v.as_array())
        .ok_or_else(|| SIDECAR_OUTDATED.to_string())?;
    if arr.len() != want {
        return Err(format!(
            "Sidecar predicted_extra length mismatch (got {} expected {want})",
            arr.len()
        ));
    }
    Ok(arr
        .iter()
        .map(|v| v.as_f64().filter(|x| x.is_finite()).unwrap_or(f64::NAN))
        .collect())
}

async fn run_predict_relationship(
    app: &tauri::AppHandle,
    job: &RelExtraJob,
) -> Result<Vec<f64>, String> {
    let payload = serde_json::json!({
        "action": "predict_relationship",
        "payload": {
            "predictors": job.predictors,
            "target": job.target,
            "X": job.x,
            "y": job.y,
            "X_extra": job.x_extra,
            "smoothing": job.lambda,
        }
    });
    let resp = run_sidecar_json(app, &payload, job.stamp.generation).await?;
    parse_predicted_extra(&resp, job.points.len())
}

/// Session-level core of [`compute_health_preview`] (no Tauri state type).
fn health_preview_in(
    state: &AppState,
    request: &health_preview::HealthPreviewRequest,
) -> Result<health_preview::HealthPreview, String> {
    let lock = state.0.read().map_err(|e| e.to_string())?;
    let session = lock
        .as_ref()
        .ok_or_else(|| missing_session_error(request.expected_generation))?;
    check_expected_generation(request.expected_generation, session.generation)?;
    match request.kind.as_str() {
        "individual" => health_preview::individual_preview(&session.data, request),
        "clustering" => health_preview::clustering_preview(&session.data, request),
        "relationship" => {
            let key = request
                .cache_key
                .as_deref()
                .filter(|k| !k.is_empty())
                .ok_or_else(|| health_preview::not_fitted("no cache_key was given"))?;
            let fit = session.rel_cache.get(key).ok_or_else(|| {
                health_preview::not_fitted(
                    "this Relation model has no fit in memory (not trained yet, or the data changed) - train it first",
                )
            })?;
            // The engine's hourly predictions of this fit, when stored (an hour
            // without one is unscored).
            let extra = session.rel_cache.peek_extra(key);
            health_preview::relationship_preview_ex(&session.data, &fit, extra.as_deref(), request)
        }
        other => Err(format!("BAD_REQUEST: unknown kind '{other}'")),
    }
}

/// Session-level core of `count_period_rows`; same generation guard as `health_preview_in`: a pinned generation gets `STALE_SESSION` on mismatch or when nothing is loaded.
fn count_period_rows_in(
    state: &AppState,
    periods: &[TimeRangeArg],
    filter: Option<&PreviewFilter>,
    expected_generation: Option<u64>,
) -> Result<period_counts::PeriodCounts, String> {
    let lock = state.0.read().map_err(|e| e.to_string())?;
    let session = lock.as_ref().ok_or_else(|| match expected_generation {
        Some(_) => STALE_SESSION_ERROR.to_string(),
        None => "NO_DATA: no dataset is loaded".to_string(),
    })?;
    check_expected_generation(expected_generation, session.generation)?;
    period_counts::count(&session.data, periods, filter)
}

/// Running-condition modal: per period (`[{start, end}]`, null/blank = open) counts dataset rows inside it and those passing the running condition (`filter.value_filters` + `combine`; filter time fields ignored), plus running-time days; see `period_counts`.
/// Bounded: at most `period_counts::MAX_PERIODS`, one pass. An uncountable period returns `valid: false` with zeroes. Errors: `BAD_REQUEST:`, `NO_DATA:`, `STALE_SESSION:`.
#[tauri::command(rename_all = "snake_case")]
async fn count_period_rows(
    periods: Vec<TimeRangeArg>,
    filter: Option<PreviewFilter>,
    expected_generation: Option<u64>,
    state: State<'_, AppState>,
) -> Result<period_counts::PeriodCounts, String> {
    count_period_rows_in(&state, &periods, filter.as_ref(), expected_generation)
}

#[cfg(test)]
mod count_period_rows_tests {
    use super::*;

    /// One day of 10-minute rows; `RUN` is 1 for the first half of the day.
    fn state_with(generation: u64) -> AppState {
        let n = 144;
        let data = ColumnarData::from_parts(
            vec!["timestamp".into(), "RUN".into()],
            (0..n).map(|i| Some(format!("2024-01-01T{:02}:{:02}:00", i / 6, (i % 6) * 10))).collect(),
            vec![vec![f64::NAN; n], (0..n).map(|i| if i < 72 { 1.0 } else { 0.0 }).collect()],
        );
        AppState(RwLock::new(Some(SessionData {
            data,
            derived: std::collections::HashSet::new(),
            generation,
            rel_cache: Default::default(),
        })))
    }

    fn day() -> Vec<TimeRangeArg> {
        vec![TimeRangeArg { start: Some("2024-01-01T00:00".into()), end: None }]
    }

    fn running() -> PreviewFilter {
        serde_json::from_str(r#"{"value_filters":[{"sensor":"RUN","operation":"greater_than","value1":0.5}]}"#).unwrap()
    }

    #[test]
    fn counts_against_the_loaded_dataset() {
        let state = state_with(4);
        for pinned in [None, Some(4)] {
            let c = count_period_rows_in(&state, &day(), Some(&running()), pinned).unwrap();
            assert_eq!(c.total_rows, 144);
            assert_eq!((c.periods[0].rows_in_period, c.periods[0].running_rows, c.periods[0].running_days), (144, 72, 0.5));
        }
    }

    #[test]
    fn a_stale_caller_generation_is_refused() {
        let state = state_with(4);
        let e = count_period_rows_in(&state, &day(), None, Some(3)).unwrap_err();
        assert_eq!(e, STALE_SESSION_ERROR);
        assert!(e.starts_with("STALE_SESSION:"), "{e}");
        // A newer generation than the loaded one is just as foreign.
        assert_eq!(count_period_rows_in(&state, &day(), None, Some(5)).unwrap_err(), STALE_SESSION_ERROR);
        // The generation is checked before the request: a stale window is told
        // it is stale, not that its request is too long.
        let many = vec![TimeRangeArg::default(); period_counts::MAX_PERIODS + 1];
        assert_eq!(count_period_rows_in(&state, &many, None, Some(3)).unwrap_err(), STALE_SESSION_ERROR);
    }

    #[test]
    fn nothing_loaded_is_no_data_or_stale_for_a_pinned_caller() {
        let none = AppState(RwLock::new(None));
        let e = count_period_rows_in(&none, &day(), None, None).unwrap_err();
        assert!(e.starts_with("NO_DATA:"), "{e}");
        assert_eq!(count_period_rows_in(&none, &day(), None, Some(4)).unwrap_err(), STALE_SESSION_ERROR);
    }

    #[test]
    fn too_many_periods_is_a_bad_request() {
        let state = state_with(1);
        let many = vec![TimeRangeArg::default(); period_counts::MAX_PERIODS + 1];
        let e = count_period_rows_in(&state, &many, None, Some(1)).unwrap_err();
        assert!(e.starts_with("BAD_REQUEST:"), "{e}");
        assert!(count_period_rows_in(&state, &many[..period_counts::MAX_PERIODS], None, Some(1)).is_ok());
    }


    use crate::csv_processor::{median_interval_runs, median_interval_seconds};

    /// `n` rows one minute apart with a `RUN` column of ones.
    fn minute_rows(n: usize) -> ColumnarData {
        ColumnarData::from_parts(
            vec!["timestamp".into(), "RUN".into()],
            (0..n).map(|i| Some(format!("2024-02-01T{:02}:{:02}:00", i / 60, i % 60))).collect(),
            vec![vec![f64::NAN; n], vec![1.0; n]],
        )
    }

    /// The loaded dataset's cached interval, its timestamps, and what a fresh
    /// computation over those timestamps gives.
    fn interval_facts(state: &AppState) -> (Option<f64>, Vec<i64>, Option<f64>) {
        let lock = state.0.read().unwrap();
        let data = &lock.as_ref().unwrap().data;
        (data.sample_interval_secs(), data.ts_parsed.clone(), median_interval_seconds(&data.ts_parsed))
    }

    #[test]
    fn two_calls_on_the_loaded_dataset_compute_the_sample_interval_at_most_once() {
        let state = state_with(4);
        let before = median_interval_runs();
        // One settled draft of the modal = two calls (train periods, scoring
        // periods); every later edit = two more.
        let a = count_period_rows_in(&state, &day(), Some(&running()), Some(4)).unwrap();
        let b = count_period_rows_in(&state, &day(), None, Some(4)).unwrap();
        assert!(median_interval_runs() - before <= 1, "the interval belongs to the dataset, not to the call");
        for _ in 0..4 {
            count_period_rows_in(&state, &day(), Some(&running()), None).unwrap();
        }
        assert_eq!(median_interval_runs() - before, 1);
        assert_eq!((a.interval_secs, b.interval_secs), (Some(600.0), Some(600.0)));
        assert_eq!((a.periods[0].running_days, b.periods[0].running_days), (0.5, 1.0));
        // Bit-identical to the value a computation per call returned.
        let (cached, _, fresh) = interval_facts(&state);
        assert_eq!(cached.map(f64::to_bits), fresh.map(f64::to_bits));
        assert_eq!(a.interval_secs.map(f64::to_bits), fresh.map(f64::to_bits));
    }

    #[test]
    fn a_newly_loaded_dataset_gets_its_own_interval_not_the_previous_ones() {
        let state = state_with(4); // 10-minute rows
        let old = count_period_rows_in(&state, &[TimeRangeArg::default()], None, None).unwrap();
        assert_eq!((old.interval_secs, old.periods[0].running_days), (Some(600.0), 1.0));

        // Mirrors `load_csv`: build the load report (asks for the interval on the load's own thread, before any lock), then install.
        let merged = csv_processor::MergeResult {
            data: minute_rows(720),
            warnings: vec![],
            parse_fail_counts: vec![],
            files: vec![],
        };
        let before = median_interval_runs();
        let report = csv_processor::build_load_report(&merged);
        assert_eq!(median_interval_runs() - before, 1, "computed afresh for the new dataset");
        assert_eq!(report.interval_seconds, Some(60.0));
        let generation = install_session(&state, merged.data).unwrap();

        let before = median_interval_runs();
        let new = count_period_rows_in(&state, &[TimeRangeArg::default()], None, Some(generation)).unwrap();
        let again = count_period_rows_in(&state, &[TimeRangeArg::default()], Some(&running()), Some(generation)).unwrap();
        assert_eq!(median_interval_runs(), before, "after a real load nothing is computed under the session lock");
        // 720 one-minute rows = half a day - with the OLD interval (600 s) it
        // would have read 5.0 days.
        assert_eq!((new.interval_secs, new.total_rows, new.periods[0].running_days), (Some(60.0), 720, 0.5));
        assert_eq!(again, new);
        assert_eq!(new.interval_secs, report.interval_seconds, "the load report and the modal agree");

        // A dataset installed WITHOUT a load report (tests only) is still
        // right: its first reader computes it, once.
        install_session(&state, minute_rows(1)).unwrap();
        let before = median_interval_runs();
        let one = count_period_rows_in(&state, &[TimeRangeArg::default()], None, None).unwrap();
        count_period_rows_in(&state, &[TimeRangeArg::default()], None, None).unwrap();
        assert_eq!(median_interval_runs() - before, 1);
        assert_eq!((one.interval_secs, one.periods[0].running_days), (None, 0.0));
    }

    #[test]
    fn special_sensor_changes_keep_the_timestamps_and_the_cached_interval() {
        // Special-sensor add/recompute/remove only touch value columns, so the cached interval stays fresh.
        let state = state_with(4);
        let first = count_period_rows_in(&state, &day(), Some(&running()), Some(4)).unwrap();
        let (_, ts_before, _) = interval_facts(&state);
        let before = median_interval_runs();
        let steps: [&dyn Fn(); 3] = [
            &|| {
                commit_derived(&state, 4, Some(4), "Extra", vec![1.0; 144], false).unwrap();
            },
            &|| {
                commit_derived(&state, 4, Some(4), "extra", vec![2.0; 144], true).unwrap();
            },
            &|| {
                assert_eq!(remove_derived_in_state(&state, &["EXTRA".to_string()], Some(4)).unwrap(), 1);
            },
        ];
        for (k, step) in steps.iter().enumerate() {
            step();
            let (cached, ts, fresh) = interval_facts(&state); // one fresh computation per step
            assert_eq!(ts, ts_before, "step {k}: timestamps untouched");
            assert_eq!(cached.map(f64::to_bits), fresh.map(f64::to_bits), "step {k}");
            assert_eq!(count_period_rows_in(&state, &day(), Some(&running()), Some(4)).unwrap(), first, "step {k}");
        }
        assert_eq!(median_interval_runs() - before, steps.len(), "only the explicit fresh computations ran");
    }

    #[test]
    fn health_previews_with_scoring_periods_reuse_the_interval_too() {
        let state = state_with(4);
        let request = health_preview::HealthPreviewRequest {
            kind: "individual".into(),
            target: Some("RUN".into()),
            test_periods: Some(vec![health_validation::TestPeriodArg {
                start: Some("2024-01-01T12:00".into()),
                end: None,
            }]),
            ..Default::default()
        };
        let before = median_interval_runs();
        let p1 = health_preview_in(&state, &request).unwrap();
        let p2 = health_preview_in(&state, &request).unwrap();
        // ... and the modal's count on the same dataset shares that one value.
        let counted = count_period_rows_in(&state, &day(), None, None).unwrap();
        assert_eq!(median_interval_runs() - before, 1, "two previews + a count, one computation");
        let (_, _, fresh) = interval_facts(&state);
        assert_eq!(counted.interval_secs.map(f64::to_bits), fresh.map(f64::to_bits));
        for p in [&p1, &p2] {
            let v = p.test_validation.as_ref().expect("scoring periods were sent");
            assert_eq!(v.tests[0].rows, 72, "12:00 .. 23:50");
            assert_eq!(v.tests[0].days, health_validation::days_of(72, fresh));
            assert_eq!(v.tests[0].days, 0.5);
            assert_eq!(v.train.days, health_validation::days_of(v.train.rows, fresh));
        }
    }
}

#[cfg(test)]
mod engine_run_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    use tauri_plugin_shell::process::TerminatedPayload;

    const LONG: Duration = Duration::from_secs(60);

    fn ended() -> CommandEvent {
        CommandEvent::Terminated(TerminatedPayload { code: Some(0), signal: None })
    }

    fn counter() -> (Arc<AtomicUsize>, impl Fn() + Send + Sync + 'static) {
        let n = Arc::new(AtomicUsize::new(0));
        let m = n.clone();
        (n, move || {
            m.fetch_add(1, Ordering::SeqCst);
        })
    }

    /// [`collect_engine_output`] for a caller that stays wanted.
    async fn collect<W, K>(
        rx: tauri::async_runtime::Receiver<CommandEvent>,
        write: W,
        kill: K,
        limit: Duration,
        grace: Duration,
    ) -> EngineOutput
    where
        W: FnOnce() -> Result<(), String> + Send + 'static,
        K: Fn() + Send + Sync + 'static,
    {
        collect_engine_output(rx, write, kill, || true, limit, grace).await
    }

    async fn wait_a_moment(ms: u64) {
        let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(Duration::from_millis(ms))).await;
    }

    #[test]
    fn engine_runs_never_overlap_and_keep_their_order() {
        static LOCK: tauri::async_runtime::Mutex<()> = tauri::async_runtime::Mutex::const_new(());
        let running = Arc::new(AtomicUsize::new(0));
        let order = Arc::new(std::sync::Mutex::new(Vec::new()));
        let runs: Vec<_> = (0..3)
            .map(|i| {
                let running = running.clone();
                let order = order.clone();
                tauri::async_runtime::spawn(async move {
                    wait_a_moment(30 * i).await; // arrive in order
                    run_in_engine_turn(&LOCK, &|| true, || async move {
                        assert_eq!(running.fetch_add(1, Ordering::SeqCst), 0, "two runs at once");
                        wait_a_moment(100).await;
                        order.lock().unwrap().push(i);
                        running.fetch_sub(1, Ordering::SeqCst);
                        Ok::<_, String>(())
                    })
                    .await
                })
            })
            .collect();
        tauri::async_runtime::block_on(async {
            for run in runs {
                run.await.unwrap().unwrap();
            }
        });
        assert_eq!(*order.lock().unwrap(), vec![0, 1, 2]);
    }

    #[test]
    fn a_caller_whose_dataset_was_replaced_during_the_wait_does_not_run() {
        static LOCK: tauri::async_runtime::Mutex<()> = tauri::async_runtime::Mutex::const_new(());
        let ran = Arc::new(AtomicUsize::new(0));
        let r = ran.clone();
        let out = tauri::async_runtime::block_on(run_in_engine_turn(&LOCK, &|| false, || async move {
            r.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }));
        assert_eq!(out, Err(STALE_SESSION_ERROR.to_string()));
        assert_eq!(ran.load(Ordering::SeqCst), 0);
        // And it did not keep the turn.
        assert!(LOCK.try_lock().is_ok());
    }

    #[test]
    fn a_cancelled_caller_does_not_keep_the_turn() {
        static LOCK: tauri::async_runtime::Mutex<()> = tauri::async_runtime::Mutex::const_new(());
        tauri::async_runtime::block_on(async {
            // Cancelled during its run.
            let holder = tauri::async_runtime::spawn(run_in_engine_turn(&LOCK, &|| true, || async {
                std::future::pending::<Result<(), String>>().await
            }));
            wait_a_moment(50).await;
            assert!(LOCK.try_lock().is_err(), "it holds the turn while it runs");
            // Cancelled while waiting in line behind that run.
            let waiter = tauri::async_runtime::spawn(run_in_engine_turn(&LOCK, &|| true, || async { Ok(()) }));
            wait_a_moment(50).await;
            waiter.abort();
            holder.abort();
            let _ = holder.await;
            run_in_engine_turn(&LOCK, &|| true, || async { Ok(()) }).await.unwrap();
        });
    }

    #[test]
    fn the_cap_does_not_count_the_wait_in_line() {
        static LOCK: tauri::async_runtime::Mutex<()> = tauri::async_runtime::Mutex::const_new(());
        let limit = Duration::from_millis(100);
        let (kills, kill) = counter();
        let out = tauri::async_runtime::block_on(async move {
            let busy = tauri::async_runtime::spawn(run_in_engine_turn(&LOCK, &|| true, move || async move {
                wait_a_moment(400).await;
                Ok::<_, String>(())
            }));
            wait_a_moment(50).await;
            let (tx, rx) = tauri::async_runtime::channel(8);
            tx.send(ended()).await.unwrap();
            let out = run_in_engine_turn(&LOCK, &|| true, || async move {
                Ok::<_, String>(collect(rx, || Ok(()), kill, limit, limit).await)
            })
            .await
            .unwrap();
            busy.await.unwrap().unwrap();
            out
        });
        assert!(!out.timed_out, "the wait was longer than the cap");
        assert_eq!(kills.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_run_whose_dataset_is_replaced_is_killed_and_gives_up_its_turn() {
        // `_tx` stays open: even with no end event the wait ends after the grace.
        let (_tx, rx) = tauri::async_runtime::channel(8);
        let (kills, kill) = counter();
        let wanted = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let w = wanted.clone();
        let flip = wanted.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            flip.store(false, Ordering::SeqCst);
        });
        let out = tauri::async_runtime::block_on(collect_engine_output(
            rx,
            || Ok(()),
            kill,
            move || w.load(Ordering::SeqCst),
            LONG,
            Duration::from_millis(50),
        ));
        assert!(out.superseded);
        assert!(!out.timed_out);
        assert_eq!(kills.load(Ordering::SeqCst), 1);
    }

    fn registry() -> std::sync::Mutex<EngineRegistry> {
        std::sync::Mutex::new(EngineRegistry::new())
    }

    fn no_kill(_: u32) {}

    fn pids(r: &std::sync::Mutex<EngineRegistry>) -> Vec<u32> {
        r.lock().unwrap().pids.clone()
    }

    #[test]
    fn exit_kills_every_running_engine_and_refuses_new_ones() {
        static KILLED: std::sync::Mutex<Vec<u32>> = std::sync::Mutex::new(Vec::new());
        fn record(pid: u32) {
            KILLED.lock().unwrap().push(pid);
        }
        let r = registry();
        let (_, a) = start_tracked_engine(&r, no_kill, || Ok(((), 11))).unwrap();
        let (_, b) = start_tracked_engine(&r, no_kill, || Ok(((), 22))).unwrap();
        let (_, done) = start_tracked_engine(&r, no_kill, || Ok(((), 33))).unwrap();
        done.finished();
        assert_eq!(pids(&r), vec![11, 22], "an engine that ended is not tracked");
        stop_all_engines(&r, record, LONG);
        let mut killed = KILLED.lock().unwrap().clone();
        killed.sort_unstable();
        assert_eq!(killed, vec![11, 22]);
        let refused = start_tracked_engine(&r, no_kill, || -> Result<((), u32), String> {
            panic!("no engine may start once the app is exiting")
        });
        assert!(refused.is_err());
        a.finished();
        b.finished();
    }

    #[test]
    fn exit_does_not_wait_long_for_a_slow_kill() {
        fn slow(_: u32) {
            std::thread::sleep(Duration::from_secs(30));
        }
        let r = registry();
        let (_, engine) = start_tracked_engine(&r, no_kill, || Ok(((), 1))).unwrap();
        let start = Instant::now();
        stop_all_engines(&r, slow, Duration::from_millis(50));
        assert!(start.elapsed() < Duration::from_secs(10));
        engine.finished();
    }

    #[test]
    fn a_failed_start_tracks_nothing() {
        let r = registry();
        assert!(start_tracked_engine::<()>(&r, no_kill, || Err("nope".to_string())).is_err());
        assert!(pids(&r).is_empty());
    }

    #[test]
    fn a_dropped_caller_kills_its_engine() {
        static KILLED: AtomicUsize = AtomicUsize::new(0);
        fn record(pid: u32) {
            KILLED.store(pid as usize, Ordering::SeqCst);
        }
        let r = registry();
        let (_, engine) = start_tracked_engine(&r, record, || Ok(((), 77))).unwrap();
        drop(engine);
        assert!(pids(&r).is_empty());
        let start = Instant::now();
        while KILLED.load(Ordering::SeqCst) != 77 {
            assert!(start.elapsed() < Duration::from_secs(10), "the engine was not killed");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// Every engine goes through the line and the registry, and exit is wired.
    #[test]
    fn the_engine_is_started_in_one_place_and_stopped_at_exit() {
        let src = include_str!("lib.rs");
        // Any spelling of a call or a reference: the definition plus one use.
        assert_eq!(src.matches(concat!("spawn_", "sidecar")).count(), 2);
        assert_eq!(src.matches(concat!("fn spawn_", "sidecar(")).count(), 1);
        assert_eq!(src.matches(concat!("run_in_engine_turn", "(&ENGINE_LOCK")).count(), 1);
        assert!(src.contains(concat!("matches!(event, tauri::RunEvent::", "Exit)")));
    }

    /// One run as `run_engine` does it, on the test's own registry and lock; `_tx` stays open so a hung engine reports no end.
    async fn tracked_run(
        lock: &'static tauri::async_runtime::Mutex<()>,
        registry: &'static std::sync::Mutex<EngineRegistry>,
        rx: tauri::async_runtime::Receiver<CommandEvent>,
        kill: impl Fn() + Send + Sync + 'static,
    ) -> Result<EngineOutput, String> {
        let arrival = engine_stops_now(registry);
        run_in_engine_turn(lock, &|| true, || async move {
            if engine_stop_requested(registry, arrival) {
                return Err(ENGINE_STOPPED_ERROR.to_string());
            }
            let ((), mut engine) = start_tracked_engine(registry, no_kill, || Ok(((), 5)))?;
            engine.stops_at_start = arrival;
            let stops_at_start = engine.stops_at_start;
            let out = collect_engine_output(
                rx,
                || Ok(()),
                kill,
                move || !engine_stop_requested(registry, stops_at_start),
                LONG,
                Duration::from_millis(50),
            )
            .await;
            engine.outcome(out)
        })
        .await
    }

    #[test]
    fn a_stop_kills_the_run_and_refuses_the_callers_already_in_line() {
        static LOCK: tauri::async_runtime::Mutex<()> = tauri::async_runtime::Mutex::const_new(());
        static REGISTRY: std::sync::Mutex<EngineRegistry> = std::sync::Mutex::new(EngineRegistry::new());
        let (hung_tx, hung_rx) = tauri::async_runtime::channel(8);
        let (kills, kill) = counter();
        let (next_kills, next_kill) = counter();
        let (next_tx, next_rx) = tauri::async_runtime::channel(8);
        let start = Instant::now();
        tauri::async_runtime::block_on(async move {
            let hung = tauri::async_runtime::spawn(tracked_run(&LOCK, &REGISTRY, hung_rx, kill));
            wait_a_moment(50).await;
            assert_eq!(pids(&REGISTRY), vec![5], "the hung run holds the turn");
            let next = tauri::async_runtime::spawn(tracked_run(&LOCK, &REGISTRY, next_rx, next_kill));
            wait_a_moment(50).await;
            next_tx.send(ended()).await.unwrap();
            request_engine_stop(&REGISTRY);
            assert_eq!(hung.await.unwrap().unwrap_err(), ENGINE_STOPPED_ERROR);
            drop(hung_tx);
            // The one in line was stopped too: it never started an engine.
            assert_eq!(next.await.unwrap().unwrap_err(), ENGINE_STOPPED_ERROR);
        });
        assert_eq!(kills.load(Ordering::SeqCst), 1);
        assert_eq!(next_kills.load(Ordering::SeqCst), 0);
        assert!(start.elapsed() < Duration::from_secs(30), "well before the cap");
        assert!(pids(&REGISTRY).is_empty());
    }

    #[test]
    fn stopping_with_nothing_running_does_nothing_and_does_not_stop_a_later_run() {
        static LOCK: tauri::async_runtime::Mutex<()> = tauri::async_runtime::Mutex::const_new(());
        static REGISTRY: std::sync::Mutex<EngineRegistry> = std::sync::Mutex::new(EngineRegistry::new());
        request_engine_stop(&REGISTRY);
        let (tx, rx) = tauri::async_runtime::channel(8);
        let (kills, kill) = counter();
        let out = tauri::async_runtime::block_on(async move {
            tx.send(ended()).await.unwrap();
            tracked_run(&LOCK, &REGISTRY, rx, kill).await
        });
        assert!(out.is_ok());
        assert_eq!(kills.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn the_stopped_sentence_does_not_read_like_a_failed_train() {
        for word in ["fail", "error", "engine", "Relation", "sidecar", ":"] {
            assert!(!ENGINE_STOPPED_ERROR.contains(word), "{word}");
        }
        assert!(!ENGINE_STOPPED_ERROR.contains('\n'));
    }

    #[test]
    fn a_normal_run_returns_its_output_and_kills_nothing() {
        let (tx, rx) = tauri::async_runtime::channel(8);
        let (kills, kill) = counter();
        let out = tauri::async_runtime::block_on(async move {
            tx.send(CommandEvent::Stdout(b"{\"r\":".to_vec())).await.unwrap();
            tx.send(CommandEvent::Stderr(b"note".to_vec())).await.unwrap();
            tx.send(CommandEvent::Stdout(b"1}".to_vec())).await.unwrap();
            tx.send(ended()).await.unwrap();
            collect(rx, || Ok(()), kill, LONG, LONG).await
        });
        assert_eq!((out.stdout.as_str(), out.stderr.as_str(), out.timed_out), ("{\"r\":1}", "note", false));
        assert_eq!(kills.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_hung_engine_is_killed_at_the_cap_and_the_call_returns_even_with_no_end_event() {
        // `_tx` stays open: the process never reports its end.
        let (_tx, rx) = tauri::async_runtime::channel(8);
        let (kills, kill) = counter();
        let start = Instant::now();
        let out = tauri::async_runtime::block_on(collect(
            rx,
            || Ok(()),
            kill,
            Duration::from_millis(50),
            Duration::from_millis(50),
        ));
        assert!(out.timed_out);
        assert_eq!(kills.load(Ordering::SeqCst), 1);
        assert!(start.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn the_end_event_after_the_kill_ends_the_wait_without_the_grace_period() {
        let (tx, rx) = tauri::async_runtime::channel(8);
        let kill = move || {
            let _ = tx.try_send(ended());
        };
        let start = Instant::now();
        let out = tauri::async_runtime::block_on(collect(rx, || Ok(()), kill, Duration::from_millis(50), LONG));
        assert!(out.timed_out);
        assert!(start.elapsed() < Duration::from_secs(10), "it did not sit out the grace period");
    }

    #[test]
    fn the_cap_also_covers_a_write_that_never_returns() {
        let (_tx, rx) = tauri::async_runtime::channel(8);
        let (release, stuck) = std::sync::mpsc::channel::<()>();
        let (kills, kill) = counter();
        let out = tauri::async_runtime::block_on(collect(
            rx,
            move || {
                let _ = stuck.recv();
                Ok(())
            },
            kill,
            Duration::from_millis(50),
            Duration::from_millis(50),
        ));
        assert!(out.timed_out);
        assert_eq!(kills.load(Ordering::SeqCst), 1);
        drop(release);
    }

    #[test]
    fn a_failed_write_kills_the_engine_and_lands_in_the_log_text_only() {
        let (tx, rx) = tauri::async_runtime::channel(8);
        let n = Arc::new(AtomicUsize::new(0));
        let m = n.clone();
        let kill = move || {
            m.fetch_add(1, Ordering::SeqCst);
            let _ = tx.try_send(ended());
        };
        let out = tauri::async_runtime::block_on(collect(
            rx,
            || Err("The pipe has been ended. (os error 109)".to_string()),
            kill,
            LONG,
            LONG,
        ));
        assert!(!out.timed_out);
        assert_eq!(n.load(Ordering::SeqCst), 1);
        assert!(out.stderr.contains("os error 109"));
        // The user reads the fixed sentence, not the OS text.
        let failure = read_engine_answer::<serde_json::Value>("s", &out.stdout, &out.stderr).unwrap_err();
        assert_eq!(failure.user, ENGINE_NO_OUTPUT_LOGGED);
    }

    #[test]
    fn a_run_after_a_timed_out_one_works() {
        let (_tx, rx) = tauri::async_runtime::channel(8);
        let first = tauri::async_runtime::block_on(collect(
            rx,
            || Ok(()),
            || {},
            Duration::from_millis(20),
            Duration::from_millis(20),
        ));
        assert!(first.timed_out);
        let (tx, rx) = tauri::async_runtime::channel(8);
        let second = tauri::async_runtime::block_on(async move {
            tx.send(CommandEvent::Stdout(b"{}".to_vec())).await.unwrap();
            tx.send(ended()).await.unwrap();
            collect(rx, || Ok(()), || {}, LONG, LONG).await
        });
        assert!(!second.timed_out);
        assert_eq!(second.stdout, "{}");
    }

    /// Real one-file engine shape: a parent whose child inherits the pipes; killing the parent alone leaves the pipe open for the whole ping.
    #[cfg(windows)]
    #[test]
    fn the_tree_kill_also_ends_the_child_that_holds_the_pipes() {
        use std::io::Read;
        use std::process::{Command, Stdio};
        let mut parent = Command::new("cmd")
            .args(["/C", "ping -n 60 127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut pipe = parent.stdout.take().unwrap();
        // ping prints as soon as it runs: the child exists when this returns.
        let mut first = [0u8; 1];
        pipe.read_exact(&mut first).unwrap();
        let start = Instant::now();
        kill_engine_tree(parent.id());
        let mut rest = Vec::new();
        let _ = pipe.read_to_end(&mut rest);
        assert!(start.elapsed() < Duration::from_secs(20), "the child kept the pipe open");
        let _ = parent.wait();
    }
}

#[cfg(test)]
mod off_main_thread_tests {
    use super::*;

    /// A sync command runs on the main thread (and a slow one freezes every window).
    #[test]
    fn session_commands_stay_async_and_keep_their_argument_casing() {
        let src = include_str!("lib.rs");
        for (name, attr) in [
            ("get_session_generation", "#[tauri::command]"),
            ("load_metadata_command", "#[tauri::command]"),
            ("load_mapping_csv", "#[tauri::command]"),
            ("get_all_sensors", "#[tauri::command]"),
            ("compute_sensor_stats", "#[tauri::command]"),
            ("compute_clustering_preview", "#[tauri::command(rename_all = \"snake_case\")]"),
            ("remove_sensor_columns", "#[tauri::command]"),
            ("calculate_new_sensor", "#[tauri::command]"),
            ("evaluate_formula", "#[tauri::command]"),
            ("validate_formula", "#[tauri::command]"),
            ("get_chart_data", "#[tauri::command(rename_all = \"snake_case\")]"),
            ("get_dataset_time_bounds", "#[tauri::command]"),
            ("get_scatter_sample", "#[tauri::command(rename_all = \"snake_case\")]"),
        ] {
            let signature = format!("async fn {name}(");
            let pos = src.find(&signature).unwrap_or_else(|| panic!("{name} is not async"));
            let before = src[..pos].trim_end();
            assert!(before.ends_with(attr), "{name} lost {attr}");
        }
    }

    #[test]
    fn the_blocking_pool_is_not_the_calling_thread() {
        let caller = std::thread::current().id();
        let worker = tauri::async_runtime::block_on(tauri::async_runtime::spawn_blocking(|| std::thread::current().id()))
            .unwrap();
        assert_ne!(worker, caller);
    }

    #[test]
    fn clustering_payload_carries_no_rows() {
        let n = 400;
        let data = ColumnarData::from_parts(
            vec!["timestamp".into(), "X".into(), "Y".into(), "C".into()],
            (0..n).map(|i| Some(format!("2024-01-01T{:02}:{:02}:00", i / 60, i % 60))).collect(),
            vec![
                vec![f64::NAN; n],
                (0..n).map(|i| i as f64).collect(),
                (0..n).map(|i| (i as f64 * 0.7).sin()).collect(),
                (0..n).map(|i| (i % 2) as f64).collect(),
            ],
        );
        for (clusters, criteria, ranges) in [
            (1, None, None),
            (
                2,
                Some("C".to_string()),
                Some(vec![
                    ClusterRange { min: None, max: Some(0.0) },
                    ClusterRange { min: Some(0.0), max: None },
                ]),
            ),
        ] {
            let p = clustering_preview_in(&data, "X".into(), "Y".into(), clusters, criteria, ranges, None).unwrap();
            assert_eq!(p.n_rows, n);
            assert_eq!(p.clusters.iter().map(|c| c.n_rows).sum::<usize>(), n);
            let json = serde_json::to_value(&p).unwrap();
            for c in json["clusters"].as_array().unwrap() {
                let keys: Vec<&str> = c.as_object().unwrap().keys().map(String::as_str).collect();
                assert!(!keys.contains(&"xs") && !keys.contains(&"ys"), "{keys:?}");
                assert!(c["ellipse"]["x_sd"].is_number());
            }
            assert!(json.to_string().len() < 2_000, "bounded by the cluster count, not the rows");
        }
    }

    #[test]
    fn the_one_pass_cluster_split_fits_the_same_rows_as_a_loop_per_cluster() {
        // Overlap and a gap: first match wins, gap rows go nowhere, a NaN Y is dropped.
        let n = 300;
        let cc: Vec<f64> = (0..n).map(|i| (i % 30) as f64).collect();
        let xs: Vec<f64> = (0..n).map(|i| i as f64).collect();
        let ys: Vec<f64> = (0..n).map(|i| if i % 37 == 0 { f64::NAN } else { (i as f64).sqrt() }).collect();
        let data = ColumnarData::from_parts(
            vec!["timestamp".into(), "X".into(), "Y".into(), "C".into()],
            (0..n).map(|i| Some(format!("2024-01-01T{:02}:{:02}:00", i / 60, i % 60))).collect(),
            vec![vec![f64::NAN; n], xs.clone(), ys.clone(), cc.clone()],
        );
        let ranges = vec![
            ClusterRange { min: None, max: Some(10.0) },
            ClusterRange { min: Some(5.0), max: Some(15.0) },
            ClusterRange { min: Some(20.0), max: None },
        ];
        let p = clustering_preview_in(&data, "X".into(), "Y".into(), 3, Some("C".into()), Some(ranges.clone()), None).unwrap();
        let bounds = ClusterRange::bounds(&ranges);
        for (k, c) in p.clusters.iter().enumerate() {
            let rows: Vec<usize> = (0..n)
                .filter(|&r| health_score::assign_cluster(cc[r], &bounds) == Some(k) && ys[r].is_finite())
                .collect();
            let x: Vec<f64> = rows.iter().map(|&r| xs[r]).collect();
            let y: Vec<f64> = rows.iter().map(|&r| ys[r]).collect();
            assert_eq!(c.n_rows, rows.len());
            let fit = clustering::fit_single_cluster_ellipse(&x, &y).unwrap();
            assert_eq!(c.ellipse.x_center.to_bits(), fit.x_center.to_bits());
            assert_eq!(c.ellipse.x_sd.to_bits(), fit.x_sd.to_bits());
            assert_eq!(c.ellipse.angle_deg.to_bits(), fit.angle_deg.to_bits());
        }
        assert_eq!(p.n_rows, p.clusters.iter().map(|c| c.n_rows).sum::<usize>());
        // The first empty cluster is still the one named.
        let empty = vec![
            ClusterRange { min: None, max: Some(10.0) },
            ClusterRange { min: Some(1000.0), max: Some(1001.0) },
            ClusterRange { min: Some(2000.0), max: None },
        ];
        // Outer edges are open, so only the middle range can stay empty.
        let e = clustering_preview_in(&data, "X".into(), "Y".into(), 3, Some("C".into()), Some(empty), None).unwrap_err();
        assert!(e.starts_with("Cluster 2 has no rows"), "{e}");
    }

    #[test]
    fn the_sidecar_source_rounds_compare_like_model_fit_and_lost_the_old_actions() {
        let py = include_str!("../python/backend.py");
        assert!(py.contains("rmse2 = _round_metric(2.0 * _rmse(y, pred))"), "Compare predictors uses round_metric");
        assert!(!py.contains("round(2.0 * _rmse"), "a fixed rounding turns a small 2RMSE into 0");
        for gone in ["train_relationship", "train_clustering", "pickle", "CLUS_INFO"] {
            assert!(!py.contains(gone), "{gone} is still in backend.py");
        }
    }
}


/// Folders written by `export_workspace_results` in THIS process — the only
/// paths `reveal_export_folder` will open.
static EXPORTED_FOLDERS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

fn remember_exported_folder(folder: &str) {
    if let Ok(mut v) = EXPORTED_FOLDERS.lock() {
        if !v.iter().any(|f| f == folder) {
            v.push(folder.to_string());
        }
    }
}

fn was_exported_here(path: &str) -> bool {
    EXPORTED_FOLDERS.lock().map(|v| v.iter().any(|f| f == path)).unwrap_or(false)
}

/// Dry run of Export results: issues, exact JSON, CSV columns, rows, bytes and a 6-row Peek per model, from the same function as the write. Writes nothing. Errors: `BAD_REQUEST:`, `NO_DATA:`, `STALE_SESSION:`.
#[tauri::command(rename_all = "snake_case")]
async fn plan_workspace_export(
    request: workspace_export::WorkspaceExportRequest,
    app: tauri::AppHandle,
) -> Result<workspace_export::WorkspaceExportPlan, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<AppState>();
        workspace_export::plan_in(&state, &request)
    })
    .await
    .map_err(|e| format!("export plan task failed: {e}"))?
}

/// Writes `<dest_dir>/<folder_name>` (or `_2`…`_99`) with `machine_info.json` + `derived/<tag>.csv` + `models/<key>.json|.csv`, all or nothing; one export at a time; emits `workspace-export-progress` per model. Errors: `BAD_REQUEST:`/`NO_DATA:`/`STALE_SESSION:`/`NOT_READY: <n> problem(s)`/`CANCELLED:`/`WRITE_FAILED:`; none leave anything behind.
#[tauri::command(rename_all = "snake_case")]
async fn export_workspace_results(
    request: workspace_export::WorkspaceExportRequest,
    dest_dir: String,
    folder_name: String,
    export_id: String,
    app: tauri::AppHandle,
) -> Result<workspace_export::WorkspaceExportResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let guard = workspace_export::EXPORTS.begin(&export_id)?;
        let cancel = guard.cancel_flag();
        let state = app.state::<AppState>();
        let workspace_id = request.workspace_id.clone();
        let result = workspace_export::write_export(
            &state,
            &request,
            &dest_dir,
            &folder_name,
            &cancel,
            |written, total, key| {
                let _ = app.emit(
                    workspace_export::PROGRESS_EVENT,
                    workspace_export::ExportProgressEvent {
                        export_id: export_id.clone(),
                        workspace_id: workspace_id.clone(),
                        written,
                        total,
                        model_key: key.to_string(),
                    },
                );
            },
        );
        if let Ok(r) = &result {
            remember_exported_folder(&r.folder);
        }
        drop(guard);
        result
    })
    .await
    .map_err(|e| format!("export task failed: {e}"))?
}

/// Ask the running export `export_id` to stop (checked between files and every
/// 64k rows). `false` = no export with that id is running.
#[tauri::command(rename_all = "snake_case")]
fn cancel_workspace_export(export_id: String) -> bool {
    workspace_export::EXPORTS.cancel(&export_id)
}

/// Opens an exported folder; only paths written by `export_workspace_results` in this process (exact `folder` value), else `BAD_REQUEST`.
#[tauri::command(rename_all = "snake_case")]
fn reveal_export_folder(path: String, app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if !was_exported_here(&path) {
        return Err("BAD_REQUEST: this folder was not exported in this session".into());
    }
    if !std::path::Path::new(&path).is_dir() {
        return Err("BAD_REQUEST: the exported folder no longer exists".into());
    }
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| format!("cannot open the folder: {e}"))
}

#[cfg(test)]
mod exported_folder_tests {
    use super::*;

    #[test]
    fn only_remembered_folders_may_be_revealed() {
        let p = "Z:/never/exported/by/this/test";
        assert!(!was_exported_here(p));
        remember_exported_folder(p);
        remember_exported_folder(p);
        assert!(was_exported_here(p));
        assert_eq!(EXPORTED_FOLDERS.lock().unwrap().iter().filter(|f| *f == p).count(), 1);
        assert!(!was_exported_here("Z:/never/exported"));
    }
}

/// Session cache and `rel_fit_from_response` tests.
#[cfg(test)]
mod health_export_tests {
    use super::*;
    use crate::health_score::RelFit;
    use std::collections::HashSet;

    fn ds(cols: Vec<(&str, Vec<f64>)>) -> ColumnarData {
        let n = cols[0].1.len();
        let mut headers = vec!["timestamp".to_string()];
        let mut columns = vec![vec![f64::NAN; n]];
        for (name, c) in cols {
            headers.push(name.to_string());
            columns.push(c);
        }
        let timestamps: Vec<Option<String>> = (0..n)
            .map(|i| Some(format!("2024-03-{:02}T{:02}:{:02}:00", 1 + (i / 1440) % 28, (i / 60) % 24, i % 60)))
            .collect();
        ColumnarData::from_parts(headers, timestamps, columns)
    }

    /// 1000 rows of S around 100 (σ ≈ 2.9).
    fn s_values() -> Vec<f64> {
        (0..1000).map(|i| 100.0 + ((i * 37 % 101) as f64 - 50.0) / 8.0).collect()
    }

    fn state_with(data: ColumnarData, generation: u64) -> AppState {
        AppState(RwLock::new(Some(SessionData {
            data,
            derived: HashSet::new(),
            generation,
            rel_cache: Default::default(),
        })))
    }

    fn fit() -> RelFit {
        RelFit {
            target: "Y".into(),
            predictors: vec!["X".into()],
            lambda: 1.0,
            rows: (0..50).collect(),
            actual: (0..50).map(|i| i as f64).collect(),
            predicted: (0..50).map(|i| i as f64 + 0.5).collect(),
            x_cols: vec![(0..50).map(|i| i as f64).collect()],
            r2_per_step: vec![0.9],
            rmse2_per_step: vec![1.0],
        }
    }

    fn rel_request(key: Option<&str>) -> health_preview::HealthPreviewRequest {
        health_preview::HealthPreviewRequest {
            kind: "relationship".into(),
            target: Some("Y".into()),
            predictors: vec!["X".into()],
            cache_key: key.map(String::from),
            ..Default::default()
        }
    }


    #[test]
    fn relationship_preview_without_a_cached_fit_is_not_fitted() {
        let state = state_with(ds(vec![("S", s_values())]), 1);
        let e = health_preview_in(&state, &rel_request(Some("m1:abc"))).unwrap_err();
        assert!(e.starts_with("NOT_FITTED"), "{e}");
        // Wording: the kind is named "Relation model"
        // wherever a user can read it - never "Relationship", never the algorithm.
        assert_eq!(
            e,
            "NOT_FITTED: this Relation model has no fit in memory (not trained yet, or the data changed) - train it first"
        );
        let e = health_preview_in(&state, &rel_request(None)).unwrap_err();
        assert!(e.starts_with("NOT_FITTED"), "{e}");
        for msg in [&e, &health_preview_in(&state, &rel_request(Some("m1:abc"))).unwrap_err()] {
            assert!(!msg.contains("Relationship") && !msg.contains("relationship"), "{msg}");
            assert!(!msg.contains("GAM"), "{msg}");
        }
    }

    #[test]
    fn cache_hit_serves_relationship_preview_and_a_wrong_key_misses() {
        let state = state_with(ds(vec![("S", vec![0.0; 50])]), 7);
        assert!(store_rel_fit(&state, SessionStamp::new(7, 0), "m1:abc".into(), fit()));
        let ok = health_preview_in(&state, &rel_request(Some("m1:abc"))).unwrap();
        assert_eq!(ok.kind, "relationship");
        // Editing set points = just another call; the sidecar is never involved.
        let again = health_preview_in(&state, &rel_request(Some("m1:abc"))).unwrap();
        assert_eq!(again.kind, "relationship");
        // A key with another fingerprint (settings changed) is a miss.
        let e = health_preview_in(&state, &rel_request(Some("m1:def"))).unwrap_err();
        assert!(e.starts_with("NOT_FITTED"), "{e}");
    }

    #[test]
    fn a_new_load_clears_the_cache() {
        let state = state_with(ds(vec![("S", vec![0.0; 50])]), 1);
        assert!(store_rel_fit(&state, SessionStamp::new(1, 0), "k".into(), fit()));
        assert!(health_preview_in(&state, &rel_request(Some("k"))).is_ok());
        // What `load_csv` does with a freshly loaded dataset:
        install_session(&state, ds(vec![("S", vec![0.0; 50])])).unwrap();
        assert!(state.0.read().unwrap().as_ref().unwrap().rel_cache.is_empty());
        let e = health_preview_in(&state, &rel_request(Some("k"))).unwrap_err();
        assert!(e.starts_with("NOT_FITTED"), "{e}");
    }

    #[test]
    fn a_fit_from_a_replaced_dataset_generation_is_not_cached() {
        let state = state_with(ds(vec![("S", vec![0.0; 50])]), 5);
        // The sidecar run started under generation 4, a reload landed meanwhile.
        assert!(!store_rel_fit(&state, SessionStamp::new(4, 0), "k".into(), fit()));
        assert!(state.0.read().unwrap().as_ref().unwrap().rel_cache.is_empty());
        // No dataset at all: also refused, no panic.
        let none = AppState(RwLock::new(None));
        assert!(!store_rel_fit(&none, SessionStamp::new(1, 0), "k".into(), fit()));
    }

    #[test]
    fn a_stale_caller_generation_is_refused() {
        let state = state_with(ds(vec![("S", s_values())]), 3);
        let mut req = health_preview::HealthPreviewRequest {
            kind: "individual".into(),
            target: Some("S".into()),
            expected_generation: Some(2),
            ..Default::default()
        };
        let e = health_preview_in(&state, &req).unwrap_err();
        assert!(e.starts_with("STALE_SESSION"), "{e}");
        req.expected_generation = Some(3);
        assert!(health_preview_in(&state, &req).is_ok());
        let none = AppState(RwLock::new(None));
        req.expected_generation = Some(3);
        assert!(health_preview_in(&none, &req).unwrap_err().starts_with("STALE_SESSION"));
        req.expected_generation = None;
        assert_eq!(health_preview_in(&none, &req).unwrap_err(), "No data loaded");
    }

    #[test]
    fn unknown_kind_is_a_bad_request() {
        let state = state_with(ds(vec![("S", s_values())]), 1);
        let req = health_preview::HealthPreviewRequest { kind: "weird".into(), ..Default::default() };
        assert!(health_preview_in(&state, &req).unwrap_err().starts_with("BAD_REQUEST"));
    }

    #[test]
    fn recomputing_or_removing_a_special_sensor_invalidates_cached_fits() {
        let state = state_with(ds(vec![("S", vec![1.0; 50])]), 9);
        // A brand-new special sensor does not touch an existing fit...
        assert!(store_rel_fit(&state, SessionStamp::new(9, 0), "k".into(), fit()));
        commit_derived(&state, 9, None, "SP", vec![2.0; 50], false).unwrap();
        assert!(health_preview_in(&state, &rel_request(Some("k"))).is_ok());
        // ...recomputing it in place does (it may have been the predictor)...
        let in_flight = session_stamp(&state).unwrap().unwrap();
        commit_derived(&state, 9, None, "SP", vec![3.0; 50], true).unwrap();
        assert!(health_preview_in(&state, &rel_request(Some("k"))).unwrap_err().starts_with("NOT_FITTED"));
        // (a fit that was in flight across the recompute is refused, not cached)
        assert!(!store_rel_fit(&state, in_flight, "k".into(), fit()));
        // ...and so does removing one.
        let stamp = session_stamp(&state).unwrap().unwrap();
        assert!(store_rel_fit(&state, stamp, "k".into(), fit()));
        assert_eq!(remove_derived_in_state(&state, &["SP".to_string()], None).unwrap(), 1);
        assert!(health_preview_in(&state, &rel_request(Some("k"))).unwrap_err().starts_with("NOT_FITTED"));
        // Removing a name that is not a special sensor changes nothing.
        let stamp = session_stamp(&state).unwrap().unwrap();
        assert!(store_rel_fit(&state, stamp, "k".into(), fit()));
        assert_eq!(remove_derived_in_state(&state, &["S".to_string()], None).unwrap(), 0);
        assert!(health_preview_in(&state, &rel_request(Some("k"))).is_ok());
    }


    #[test]
    fn rel_fit_is_built_column_major_from_the_sidecar_response() {
        let parsed = serde_json::json!({
            "predicted": [1.0, null, 3.0],
            "r2_per_step": [0.5, 0.9],
            "rmse2_per_step": [2.0, 1.0],
        });
        let x = vec![vec![1.0, 10.0], vec![2.0, 20.0], vec![3.0, 30.0]];
        let f = rel_fit_from_response(
            &parsed,
            &["A".to_string(), "B".to_string()],
            "T",
            5.0,
            &[4, 7, 9],
            &[1.5, 2.5, 3.5],
            &x,
        )
        .unwrap();
        assert_eq!(f.rows, vec![4, 7, 9]);
        assert_eq!(f.x_cols, vec![vec![1.0, 2.0, 3.0], vec![10.0, 20.0, 30.0]]);
        assert!(f.predicted[1].is_nan());
        assert_eq!(f.predicted[0], 1.0);
        assert_eq!(f.r2_per_step, vec![0.5, 0.9]);
        assert_eq!(f.target, "T");
        assert_eq!(f.lambda, 5.0);
        // Wrong-length prediction array / missing key => nothing to cache.
        let bad = serde_json::json!({"predicted": [1.0]});
        assert!(rel_fit_from_response(&bad, &["A".to_string(), "B".to_string()], "T", 1.0, &[4, 7, 9], &[1.0, 2.0, 3.0], &x).is_none());
        let none = serde_json::json!({"error": "x"});
        assert!(rel_fit_from_response(&none, &["A".to_string(), "B".to_string()], "T", 1.0, &[4, 7, 9], &[1.0, 2.0, 3.0], &x).is_none());
    }







}

/// Session stamp tests: it changes on replace and remove, not on add.
#[cfg(test)]
mod health_fix_tests {
    use super::*;
    use crate::health_score::RelFit;
    use std::collections::HashSet;

    fn state_with(n: usize, generation: u64) -> AppState {
        let headers = vec!["timestamp".to_string(), "X".to_string(), "Y".to_string()];
        let timestamps: Vec<Option<String>> = (0..n)
            .map(|i| Some(format!("2024-03-01T{:02}:{:02}:00", (i / 60) % 24, i % 60)))
            .collect();
        let cols = vec![vec![f64::NAN; n], vec![1.0; n], vec![2.0; n]];
        AppState(RwLock::new(Some(SessionData {
            data: ColumnarData::from_parts(headers, timestamps, cols),
            derived: HashSet::new(),
            generation,
            rel_cache: Default::default(),
        })))
    }

    fn fit(target: &str, preds: &[&str]) -> RelFit {
        RelFit {
            target: target.into(),
            predictors: preds.iter().map(|s| s.to_string()).collect(),
            lambda: 1.0,
            rows: (0..50).collect(),
            actual: (0..50).map(|i| i as f64).collect(),
            predicted: (0..50).map(|i| i as f64 + 0.5).collect(),
            x_cols: preds.iter().map(|_| (0..50).map(|i| i as f64).collect()).collect(),
            r2_per_step: vec![],
            rmse2_per_step: vec![],
        }
    }



    #[test]
    fn stamp_changes_on_replace_and_remove_but_not_on_add_or_a_noop_remove() {
        let state = state_with(50, 3);
        let s0 = session_stamp(&state).unwrap().unwrap();
        assert_eq!(s0, SessionStamp::new(3, 0));
        commit_derived(&state, 3, None, "SP", vec![0.0; 50], false).unwrap();
        assert_eq!(session_stamp(&state).unwrap().unwrap(), s0, "adding a column cannot affect a fit");
        commit_derived(&state, 3, None, "SP", vec![1.0; 50], true).unwrap();
        let s1 = session_stamp(&state).unwrap().unwrap();
        assert_eq!(s1, SessionStamp::new(3, 1), "replace bumps the epoch, never the generation");
        assert_eq!(remove_derived_in_state(&state, &["Y".to_string()], None).unwrap(), 0);
        assert_eq!(session_stamp(&state).unwrap().unwrap(), s1, "removing nothing changes nothing");
        assert_eq!(remove_derived_in_state(&state, &["SP".to_string()], None).unwrap(), 1);
        assert_eq!(session_stamp(&state).unwrap().unwrap(), SessionStamp::new(3, 2));
        // A reload resets everything (fresh session, new generation).
        let fresh = ColumnarData::from_parts(
            vec!["timestamp".into(), "X".into()],
            vec![Some("2024-03-01T00:00:00".into())],
            vec![vec![f64::NAN], vec![1.0]],
        );
        let g = install_session(&state, fresh).unwrap();
        assert_eq!(session_stamp(&state).unwrap().unwrap(), SessionStamp::new(g, 0));
    }

    #[test]
    fn a_stale_stamp_is_refused_by_the_epoch_alone_not_only_the_generation() {
        let state = state_with(50, 3);
        let before = session_stamp(&state).unwrap().unwrap();
        commit_derived(&state, 3, None, "SP", vec![0.0; 50], false).unwrap();
        commit_derived(&state, 3, None, "SP", vec![1.0; 50], true).unwrap();
        // Same generation, older epoch.
        assert_eq!(before.generation, session_stamp(&state).unwrap().unwrap().generation);
        assert!(!store_rel_fit(&state, before, "k".into(), fit("Y", &["X"])));
        assert!(state.0.read().unwrap().as_ref().unwrap().rel_cache.is_empty());
    }



}

/// Rounding of the Individual mean/SD and 1SD/3SD bounds (`individual_rounded_metrics`).
#[cfg(test)]
mod model_info_output_tests {
    use super::*;

    fn legacy_r3(x: f64) -> f64 {
        (x * 1000.0).round() / 1000.0
    }

    fn close(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-12, "expected {b}, got {a}");
    }


    #[test]
    fn individual_typical_values_match_legacy_three_decimals() {
        // SD >= 1: rounded to 3 decimals.
        let (mean, sd) = (1234.56789, 12.34567);
        let (m, s, b1, b3) = individual_rounded_metrics(mean, sd);
        let (lm, ls) = (legacy_r3(mean), legacy_r3(sd));
        assert_eq!(m, lm);
        assert_eq!(s, ls);
        assert_eq!(b1, [legacy_r3(lm - ls), legacy_r3(lm + ls)]);
        assert_eq!(b3, [legacy_r3(lm - 3.0 * ls), legacy_r3(lm + 3.0 * ls)]);
    }

    #[test]
    fn individual_small_sd_keeps_distinct_bands_and_nonzero_denominators() {
        // The motivating case: SD ~0.0004. Legacy r3 gave sd = 0.0 and every
        // boundary == mean.
        let (mean, sd) = (0.5, 0.000412);
        let ls = legacy_r3(sd);
        assert_eq!(ls, 0.0);

        let (m, s, b1, b3) = individual_rounded_metrics(mean, sd);
        close(m, 0.5);
        close(s, 0.000412);
        close(b1[0], 0.499588);
        close(b1[1], 0.500412);
        close(b3[0], 0.498764);
        close(b3[1], 0.501236);
        // Strictly ordered, so (3SD - 1SD) style denominators are never 0.
        assert!(b3[0] < b1[0] && b1[0] < m && m < b1[1] && b1[1] < b3[1]);
        assert!(b3[0] != b1[0] && b3[1] != b1[1]);
    }

    #[test]
    fn individual_large_mean_tiny_sd_does_not_collapse() {
        let (m, s, b1, b3) = individual_rounded_metrics(1000.0001234, 0.0004);
        assert!(s > 0.0);
        assert!(b3[0] < b1[0] && b1[0] < m && m < b1[1] && b1[1] < b3[1], "{b3:?} {b1:?} {m}");
    }

    #[test]
    fn individual_constant_sensor_boundaries_equal_the_mean() {
        // SD = 0: every boundary equals the mean (band-width denominator is 0); the health score guards it.
        let (m, s, b1, b3) = individual_rounded_metrics(7.25, 0.0);
        assert_eq!(m, 7.25);
        assert_eq!(s, 0.0);
        assert_eq!(b1, [7.25, 7.25]);
        assert_eq!(b3, [7.25, 7.25]);
    }


}

#[cfg(test)]
mod scatter_sample_tests {
    use super::*;

    fn dataset() -> ColumnarData {
        let timestamps: Vec<Option<String>> = (0..10)
            .map(|i| Some(format!("2020-01-01T00:{:02}", i)))
            .collect();
        ColumnarData::from_parts(
            vec!["timestamp".into(), "A".into(), "B".into()],
            timestamps,
            vec![
                vec![f64::NAN; 10],
                (0..10).map(|i| i as f64).collect(),
                (0..10).map(|i| (i * 2) as f64).collect(),
            ],
        )
    }

    fn filter(sensors: &[&str]) -> DataFilter {
        DataFilter {
            sensors: sensors.iter().map(|s| s.to_string()).collect(),
            timestamp_start: None,
            timestamp_end: None,
            value_filters: vec![],
            ..Default::default()
        }
    }

    #[test]
    fn returns_all_rows_projected_when_under_cap() {
        let s = sample_dataset(&dataset(), &filter(&["A", "B"]), 1000).unwrap();
        assert_eq!(s.headers, vec!["A", "B"]);
        assert_eq!(s.total, 10);
        assert_eq!(s.sampled, 10);
        assert_eq!(s.rows.len(), 10);
        // Values are projected to [A, B] (2 columns), not the raw 3.
        assert!(s.rows.iter().all(|r| r.values.len() == 2));
    }

    #[test]
    fn caps_row_count_at_max_points() {
        let s = sample_dataset(&dataset(), &filter(&["A"]), 3).unwrap();
        assert_eq!(s.total, 10); // population unchanged
        assert_eq!(s.sampled, 3); // sample bounded
        assert_eq!(s.rows.len(), 3);
        assert_eq!(s.headers, vec!["A"]);
        assert!(s.rows.iter().all(|r| r.values.len() == 1));
    }

    #[test]
    fn drops_unknown_sensors_from_headers_and_values() {
        let s = sample_dataset(&dataset(), &filter(&["A", "DOES_NOT_EXIST"]), 100).unwrap();
        assert_eq!(s.headers, vec!["A"]); // unknown sensor dropped
        assert!(s.rows.iter().all(|r| r.values.len() == 1));
    }

    #[test]
    fn value_filter_shrinks_population() {
        let mut f = filter(&["A"]);
        f.value_filters = vec![ValueFilter {
            sensor: "A".into(),
            operation: "greater_than".into(),
            value1: Some(5.0),
            value2: None,
        }];
        let s = sample_dataset(&dataset(), &f, 100).unwrap();
        // A > 5 → i ∈ {6,7,8,9} → 4 rows.
        assert_eq!(s.total, 4);
        assert_eq!(s.sampled, 4);
    }

    #[test]
    fn empty_dataset_yields_empty_sample() {
        let empty = ColumnarData::from_parts(
            vec!["timestamp".into(), "A".into()],
            vec![],
            vec![vec![], vec![]],
        );
        let s = sample_dataset(&empty, &filter(&["A"]), 100).unwrap();
        assert_eq!(s.total, 0);
        assert_eq!(s.sampled, 0);
        assert!(s.rows.is_empty());
    }

    #[test]
    fn timestamp_filter_gates_population_via_ts_parsed() {
        let mut f = filter(&["A"]);
        f.timestamp_start = Some("2020-01-01T00:05".into());
        let s = sample_dataset(&dataset(), &f, 100).unwrap();
        // Minutes 05..09 pass the parsed-timestamp gate → 5 rows.
        assert_eq!(s.total, 5);
        assert_eq!(s.rows[0].values, vec![Some(5.0)]);
    }

    #[test]
    fn append_error_line_writes_entry_detail_and_appends() {
        let dir = std::env::temp_dir().join(format!("wizard-errlog-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("frontend-errors.log");

        append_error_line(&path, "frontend", "boom happened", Some("stack line 1\nstack line 2"));
        append_error_line(&path, "rust-panic", "second entry", None);
        // Whitespace-only detail must not add noise lines.
        append_error_line(&path, "frontend", "third", Some("   "));

        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("[frontend] boom happened"));
        assert!(content.contains("stack line 2"));
        assert!(content.contains("[rust-panic] second entry"));
        // Appending (not truncating): all three entries coexist, in order.
        let first = content.find("boom happened").unwrap();
        let third = content.find("third").unwrap();
        assert!(first < third);
        assert_eq!(content.matches("[frontend] third").count(), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn a_full_error_log_moves_aside_and_long_entries_are_cut() {
        let dir = std::env::temp_dir().join(format!("wizard-errlog-rotate-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("frontend-errors.log");
        let old = dir.join("frontend-errors.old.log");
        std::fs::write(&old, "older than old").unwrap();
        let f = std::fs::File::create(&path).unwrap();
        f.set_len(ERROR_LOG_MAX_BYTES).unwrap();
        drop(f);

        let huge = "é".repeat(ERROR_LOG_MAX_DETAIL); // 2 bytes per char: cut mid-way
        append_error_line(&path, "frontend", &"m".repeat(ERROR_LOG_MAX_MESSAGE + 10), Some(&huge));

        // The full file became .old (replacing the previous one); the new log is small.
        assert_eq!(std::fs::metadata(&old).unwrap().len(), ERROR_LOG_MAX_BYTES);
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.len() < ERROR_LOG_MAX_MESSAGE + ERROR_LOG_MAX_DETAIL + 200);
        assert_eq!(content.matches("[cut,").count(), 2);
        assert!(content.contains(&format!("[cut, {} bytes total]", huge.len())));

        // Under the limit: plain append, no rotation.
        append_error_line(&path, "frontend", "next", None);
        assert!(std::fs::read_to_string(&path).unwrap().contains("[frontend] next"));
        assert_eq!(std::fs::metadata(&old).unwrap().len(), ERROR_LOG_MAX_BYTES);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// `<app-log-dir>/frontend-errors.log`; outside the install dir so it needs no elevated writes and survives reinstalls.
fn error_log_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("cannot resolve app log dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create log dir {dir:?}: {e}"))?;
    Ok(dir.join("frontend-errors.log"))
}

/// At this size the log moves to `<name>.old.log` (replacing the old one), so it holds at most ~2× this.
const ERROR_LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;
/// Longest message / detail kept per entry; anything past it is cut.
const ERROR_LOG_MAX_MESSAGE: usize = 4 * 1024;
const ERROR_LOG_MAX_DETAIL: usize = 32 * 1024;

/// `text` cut to at most `max` bytes on a char boundary, marked when cut.
fn clip_log_text(text: &str, max: usize) -> std::borrow::Cow<'_, str> {
    if text.len() <= max {
        return std::borrow::Cow::Borrowed(text);
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    std::borrow::Cow::Owned(format!("{}… [cut, {} bytes total]", &text[..end], text.len()))
}

/// Move a full log aside (`frontend-errors.log` → `frontend-errors.old.log`).
fn rotate_error_log(path: &std::path::Path) {
    let full = std::fs::metadata(path).map(|m| m.len() >= ERROR_LOG_MAX_BYTES).unwrap_or(false);
    if full {
        let old = path.with_extension("old.log");
        let _ = std::fs::remove_file(&old);
        let _ = std::fs::rename(path, &old);
    }
}

/// Best-effort append — the error logger must never become an error source
/// itself, so every failure here is deliberately swallowed.
fn append_error_line(path: &std::path::Path, source: &str, message: &str, detail: Option<&str>) {
    use std::io::Write;
    rotate_error_log(path);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let message = clip_log_text(message, ERROR_LOG_MAX_MESSAGE);
        let _ = writeln!(f, "[{ts}] [{source}] {message}");
        if let Some(d) = detail {
            if !d.trim().is_empty() {
                let _ = writeln!(f, "{}", clip_log_text(d, ERROR_LOG_MAX_DETAIL));
            }
        }
    }
}

#[tauri::command]
fn log_frontend_error(
    app: tauri::AppHandle,
    message: String,
    detail: Option<String>,
) -> Result<String, String> {
    let path = error_log_path(&app)?;
    append_error_line(&path, "frontend", &message, detail.as_deref());
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn get_error_log_path(app: tauri::AppHandle) -> Result<String, String> {
    Ok(error_log_path(&app)?.to_string_lossy().into_owned())
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
            // Persist Rust panics to the error log: an installed build has no console.
            {
                let handle = _app.handle().clone();
                let default_hook = std::panic::take_hook();
                std::panic::set_hook(Box::new(move |info| {
                    if let Ok(path) = error_log_path(&handle) {
                        append_error_line(&path, "rust-panic", &info.to_string(), None);
                    }
                    default_hook(info);
                }));
            }
            // Native decorations are off (the frontend draws its own titlebar) except on macOS; Windows sets it in its platform config, Linux strips them at runtime.
            #[cfg(target_os = "linux")]
            {
                use tauri::Manager;
                if let Some(window) = _app.get_webview_window("main") {
                    window.set_decorations(false).ok();
                }
            }
            Ok(())
        })
        .manage(AppState(RwLock::new(None)))
        .invoke_handler(tauri::generate_handler![
            load_csv,
            get_all_sensors,
            load_metadata_command,
            compute_sensor_stats,
            preview_relationship_model,
            get_session_generation,
            calculate_new_sensor,
            remove_sensor_columns,
            load_mapping_csv,
            apply_sensor_mapping,
            get_chart_data,
            get_dataset_time_bounds,
            evaluate_formula,
            validate_formula,
            preview_formula,
            convert_legacy_formula,
            extract_formula_refs,
            rename_formula_refs,
            compute_clustering_preview,
            compute_health_preview,
            count_period_rows,
            plan_workspace_export,
            export_workspace_results,
            cancel_workspace_export,
            reveal_export_folder,
            get_scatter_sample,
            log_frontend_error,
            get_error_log_path,
            stop_running_engine
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // Exit when the last visible window is destroyed (overrides macOS stay-alive); hidden leftovers are ignored.
        // If exit(0) has not ended the process in 500 ms, force std::process::exit(0).
        .run(|app_handle, event| {
            use tauri::Manager;
            // An engine left running would keep working with no app to answer.
            if matches!(event, tauri::RunEvent::Exit) {
                stop_all_engines(&LIVE_ENGINES, kill_engine_tree, ENGINE_EXIT_WAIT);
            }
            if let tauri::RunEvent::WindowEvent {
                event: tauri::WindowEvent::Destroyed,
                label,
                ..
            } = &event
            {
                let remaining: Vec<String> = app_handle
                    .webview_windows()
                    .iter()
                    .filter(|(_label, w)| {
                        // Conservative: if `is_visible` errors, treat as visible
                        // so we don't kill the app prematurely.
                        w.is_visible().unwrap_or(true)
                    })
                    .map(|(label, _)| label.clone())
                    .collect();
                eprintln!(
                    "[exit-guard] Window destroyed: {} | remaining visible windows: {:?}",
                    label, remaining
                );
                if remaining.is_empty() {
                    eprintln!("[exit-guard] No visible windows left — exiting.");
                    // Force-destroy any hidden/leftover windows so they don't
                    // keep the cocoa runloop alive.
                    for (_, w) in app_handle.webview_windows() {
                        let _ = w.destroy();
                    }
                    app_handle.exit(0);
                    std::thread::spawn(|| {
                        std::thread::sleep(std::time::Duration::from_millis(500));
                        eprintln!("[exit-guard] app.exit(0) didn't terminate — forcing process exit.");
                        stop_all_engines(&LIVE_ENGINES, kill_engine_tree, ENGINE_EXIT_WAIT);
                        std::process::exit(0);
                    });
                }
            }
        });
}

/// Contract of `preview_relationship_model`: `max_points` gives bounded aligned arrays + `n_rows`; the cache keeps the FULL fit.
#[cfg(test)]
mod relationship_response_tests {
    use super::*;
    use std::collections::HashSet;

    /// y = 100 + 10*sin(i/50) plus a spike and a dip; predicted = 2*y + 1, x0 = i, so alignment is checkable.
    struct Fixture {
        n: usize,
        x: Vec<Vec<f64>>,
        y: Vec<f64>,
        predicted: Vec<f64>,
        spike: usize,
        dip: usize,
    }

    fn fixture(n: usize) -> Fixture {
        let mut y: Vec<f64> = (0..n).map(|i| 100.0 + 10.0 * (i as f64 / 50.0).sin()).collect();
        let (spike, dip) = (n / 3 + 1, 2 * n / 3 + 2);
        if n > 3 {
            y[spike] = 1000.0;
            y[dip] = -1000.0;
        }
        let x = (0..n).map(|i| vec![i as f64, (i % 17) as f64]).collect();
        let predicted = y.iter().map(|v| 2.0 * v + 1.0).collect();
        Fixture { n, x, y, predicted, spike, dip }
    }

    fn sidecar_response(f: &Fixture) -> serde_json::Value {
        serde_json::json!({
            "request": "r",
            "r2_per_step": [0.5, 0.9],
            "rmse2_per_step": [2.0, 1.0],
            "predicted": f.predicted,
            "residual": f.y.iter().zip(&f.predicted).map(|(a, p)| a - p).collect::<Vec<_>>(),
        })
    }

    fn state_for(n: usize) -> AppState {
        let headers = vec!["timestamp".to_string(), "X1".to_string(), "X2".to_string(), "Y".to_string()];
        let timestamps: Vec<Option<String>> = (0..n)
            .map(|i| Some(format!("2024-03-{:02}T{:02}:{:02}:00", 1 + (i / 1440) % 28, (i / 60) % 24, i % 60)))
            .collect();
        let columns = vec![vec![f64::NAN; n], vec![0.0; n], vec![0.0; n], vec![0.0; n]];
        AppState(RwLock::new(Some(SessionData {
            data: ColumnarData::from_parts(headers, timestamps, columns),
            derived: HashSet::new(),
            generation: 3,
            rel_cache: Default::default(),
        })))
    }

    fn run(
        f: &Fixture,
        state: &AppState,
        parsed: serde_json::Value,
        cache_key: Option<&str>,
        max_points: Option<usize>,
    ) -> serde_json::Value {
        let rows: Vec<u32> = (0..f.n as u32).collect();
        finish_relationship_response(
            state,
            session_stamp(state).unwrap().unwrap(),
            parsed,
            &["X1".to_string(), "X2".to_string()],
            "Y",
            1000.0,
            &rows,
            &f.y,
            &f.x,
            cache_key.map(String::from),
            max_points,
        )
        .unwrap()
    }

    fn arr<'a>(v: &'a serde_json::Value, k: &str) -> &'a Vec<serde_json::Value> {
        v.get(k).and_then(|x| x.as_array()).unwrap_or_else(|| panic!("{k} missing"))
    }


    #[test]
    fn sample_is_every_row_when_n_is_at_or_below_the_cap() {
        let f = fixture(50);
        assert_eq!(relationship_sample_indices(50, 50, &f.y, None), (0..50).collect::<Vec<_>>());
        assert_eq!(relationship_sample_indices(50, 4000, &f.y, None), (0..50).collect::<Vec<_>>());
        assert!(relationship_sample_indices(0, 10, &[], None).is_empty());
    }

    #[test]
    fn sample_just_above_the_cap_is_bounded_sorted_unique() {
        let f = fixture(51);
        let idx = relationship_sample_indices(51, 50, &f.y, None);
        assert!(idx.len() <= 50 && idx.len() >= 40, "{}", idx.len());
        assert!(idx.windows(2).all(|w| w[0] < w[1]));
        assert!(idx.iter().all(|&i| i < 51));
    }

    #[test]
    fn sample_keeps_the_target_and_prediction_extremes() {
        let f = fixture(10_000);
        // The prediction's extremes sit on different rows than the target's.
        let mut pred: Vec<Option<f64>> = f.predicted.iter().map(|&v| Some(v)).collect();
        pred[1234] = Some(9e6);
        pred[8765] = Some(-9e6);
        let idx = relationship_sample_indices(10_000, 200, &f.y, Some(&pred));
        assert!(idx.len() <= 200);
        for want in [f.spike, f.dip, 1234, 8765] {
            assert!(idx.contains(&want), "missing extreme row {want}");
        }
        assert!(idx.windows(2).all(|w| w[0] < w[1]));
    }

    #[test]
    fn sample_ignores_non_finite_values_when_picking_extremes() {
        let mut f = fixture(5000);
        f.y[10] = f64::NAN;
        let mut pred: Vec<Option<f64>> = f.predicted.iter().map(|&v| Some(v)).collect();
        pred[20] = None;
        let idx = relationship_sample_indices(5000, 100, &f.y, Some(&pred));
        assert!(idx.len() <= 100);
        assert!(idx.contains(&f.spike) && idx.contains(&f.dip));
    }

    #[test]
    fn sample_with_a_tiny_cap_is_a_plain_stride_within_the_cap() {
        let f = fixture(1000);
        for cap in [1usize, 2, 5, 7] {
            let idx = relationship_sample_indices(1000, cap, &f.y, None);
            assert_eq!(idx.len(), cap);
        }
        // 0 behaves like 1 (never an empty / unbounded sample).
        assert_eq!(relationship_sample_indices(1000, 0, &f.y, None).len(), 1);
    }


    #[test]
    fn bounded_arrays_are_aligned_capped_and_keep_the_extremes() {
        let f = fixture(20_000);
        let state = state_for(f.n);
        let resp = run(&f, &state, sidecar_response(&f), None, Some(500));
        let (p, t, x) = (arr(&resp, "predicted"), arr(&resp, "target_raw"), arr(&resp, "predictor_raw"));
        assert!(p.len() <= 500 && !p.is_empty());
        assert_eq!(p.len(), t.len());
        assert_eq!(p.len(), x.len());
        let mut rows = Vec::new();
        for j in 0..p.len() {
            let row = x[j][0].as_f64().unwrap() as usize; // x0[i] = i
            rows.push(row);
            assert_eq!(t[j].as_f64().unwrap(), f.y[row], "target misaligned at {j}");
            assert_eq!(p[j].as_f64().unwrap(), f.predicted[row], "prediction misaligned at {j}");
            assert_eq!(x[j][1].as_f64().unwrap(), (row % 17) as f64);
        }
        assert!(rows.windows(2).all(|w| w[0] < w[1]), "rows must be ascending (time order)");
        // min and max of the target (and so of the prediction) are in the sample.
        assert!(rows.contains(&f.spike) && rows.contains(&f.dip));
        assert!(t.iter().any(|v| v.as_f64() == Some(1000.0)));
        assert!(t.iter().any(|v| v.as_f64() == Some(-1000.0)));
        assert!(p.iter().any(|v| v.as_f64() == Some(2001.0)));
        assert!(p.iter().any(|v| v.as_f64() == Some(-1999.0)));
    }

    #[test]
    fn n_rows_is_the_real_row_count_below_at_and_above_the_cap() {
        for (n, cap) in [(30usize, 100usize), (100, 100), (101, 100), (5000, 100)] {
            let f = fixture(n);
            let state = state_for(n);
            let resp = run(&f, &state, sidecar_response(&f), None, Some(cap));
            assert_eq!(resp["n_rows"], serde_json::json!(n), "n_rows for n={n}");
            let len = arr(&resp, "predicted").len();
            assert!(len <= cap, "n={n}: {len} > cap {cap}");
            if n <= cap {
                assert_eq!(len, n, "no sampling when the data fits");
            }
        }
    }

    #[test]
    fn bounded_response_drops_residual_but_keeps_the_scores_and_error() {
        let f = fixture(2000);
        let state = state_for(f.n);
        let resp = run(&f, &state, sidecar_response(&f), None, Some(100));
        assert!(resp.get("residual").is_none());
        assert_eq!(resp["r2_per_step"], serde_json::json!([0.5, 0.9]));
        assert_eq!(resp["rmse2_per_step"], serde_json::json!([2.0, 1.0]));
        assert_eq!(resp["request"], serde_json::json!("r"));
        // No cache_key => none of the cache fields appear.
        assert!(resp.get("cache_key").is_none());
        assert!(resp.get("cached").is_none());
        assert!(resp.get("health_preview").is_none());
        // An error response keeps its shape (bounded sample + `n_rows`) but the engine's text becomes the fixed sentence.
        let err = run(&f, &state, serde_json::json!({"error": "boom", "trace": "t"}), Some("k"), Some(100));
        assert_eq!(err["error"], serde_json::json!(ENGINE_FIT_FAILED));
        assert!(err.get("trace").is_none(), "the traceback is never shipped");
        assert_eq!(err["n_rows"], serde_json::json!(2000));
        assert!(err.get("predicted").is_none());
        assert!(err.get("cache_key").is_none(), "an error is never cached");
        assert!(state.0.read().unwrap().as_ref().unwrap().rel_cache.is_empty());
    }

    #[test]
    fn an_engine_error_never_reaches_the_frontend_and_is_logged_once() {
        // A library exception can name Python, a
        // library or the (confidential) algorithm.
        let nasty = "pygam LinearGAM: PIRLS did not converge (numpy.linalg.LinAlgError) in the Python sidecar";
        let trace = "Traceback (most recent call last):\n  File \"backend.py\", line 180\nnumpy.linalg.LinAlgError: SVD";
        let f = fixture(300);
        let state = state_for(f.n);
        let rows: Vec<u32> = (0..f.n as u32).collect();
        let logged = std::sync::Mutex::new(Vec::<EngineFailure>::new());
        let resp = finish_relationship_response_ex(
            &state,
            session_stamp(&state).unwrap().unwrap(),
            serde_json::json!({ "error": nasty, "trace": trace }),
            &["X1".to_string(), "X2".to_string()],
            "Y",
            1000.0,
            &rows,
            &f.y,
            &f.x,
            Some("k".into()),
            Some(100),
            &health_score::RelHourPoints::default(),
            &|failure| logged.lock().unwrap().push(failure.clone()),
        )
        .unwrap();
        // What the frontend shows as the message: the fixed sentence, a string.
        assert_eq!(
            resp["error"],
            serde_json::json!("The Relation model engine could not fit this model. The details are in the error log.")
        );
        let shipped = resp.to_string();
        for word in ["idecar", "ython", "pygam", "GAM", "numpy", "LinAlgError", "Traceback", "backend", "PIRLS", "trace"] {
            assert!(!shipped.contains(word), "{word} reached the frontend: {shipped}");
        }
        assert_eq!(resp["n_rows"], serde_json::json!(300), "the answer keeps its shape");
        assert!(resp.get("cache_key").is_none() && state.0.read().unwrap().as_ref().unwrap().rel_cache.is_empty());
        // The log got the real text, once, bounded, under the preview step.
        let logged = logged.lock().unwrap();
        assert_eq!(logged.len(), 1);
        let detail = logged[0].log_detail.as_deref().unwrap();
        assert!(detail.contains(nasty) && detail.contains("numpy.linalg.LinAlgError: SVD"), "{detail}");
        assert!(logged[0].log_message.ends_with("[preview_relationship]"));
        assert!(logged[0].log_message.len() + detail.len() <= ERROR_LOG_DETAIL_MAX);
        // A good answer logs nothing.
        drop(logged);
        let logged = std::sync::Mutex::new(0usize);
        let ok = finish_relationship_response_ex(
            &state,
            session_stamp(&state).unwrap().unwrap(),
            sidecar_response(&f),
            &["X1".to_string(), "X2".to_string()],
            "Y",
            1000.0,
            &rows,
            &f.y,
            &f.x,
            None,
            Some(100),
            &health_score::RelHourPoints::default(),
            &|_| *logged.lock().unwrap() += 1,
        )
        .unwrap();
        assert!(ok.get("error").is_none());
        assert_eq!(*logged.lock().unwrap(), 0);
    }

    #[test]
    fn null_predictions_survive_the_sample_as_null() {
        let f = fixture(1000);
        let state = state_for(f.n);
        let mut parsed = sidecar_response(&f);
        parsed["predicted"][0] = serde_json::Value::Null; // row 0 is always in the stride
        let resp = run(&f, &state, parsed, None, Some(100));
        let p = arr(&resp, "predicted");
        let x = arr(&resp, "predictor_raw");
        let j = x.iter().position(|r| r[0].as_f64() == Some(0.0)).unwrap();
        assert!(p[j].is_null());
    }

    #[test]
    fn a_prediction_array_of_the_wrong_length_is_left_alone() {
        let f = fixture(1000);
        let state = state_for(f.n);
        let mut parsed = sidecar_response(&f);
        parsed["predicted"] = serde_json::json!([1.0, 2.0]);
        let resp = run(&f, &state, parsed, None, Some(100));
        assert_eq!(arr(&resp, "predicted").len(), 2);
        assert_eq!(arr(&resp, "target_raw").len(), arr(&resp, "predictor_raw").len());
    }

    #[test]
    fn payload_is_small_for_159k_rows() {
        let f = fixture(159_000);
        let state = state_for(f.n);
        let full = serde_json::to_string(&run(&f, &state, sidecar_response(&f), None, None)).unwrap();
        let bounded = serde_json::to_string(&run(&f, &state, sidecar_response(&f), None, Some(4000))).unwrap();
        assert!(full.len() > 10_000_000, "sanity: the legacy payload is MBs ({})", full.len());
        assert!(bounded.len() < 450_000, "bounded payload is {} bytes", bounded.len());
        let r: serde_json::Value = serde_json::from_str(&bounded).unwrap();
        assert_eq!(r["n_rows"], serde_json::json!(159_000));
        assert!(arr(&r, "predicted").len() <= 4000);
    }


    #[test]
    fn without_max_points_every_row_and_residual_are_returned_as_before() {
        let f = fixture(3000);
        let state = state_for(f.n);
        let resp = run(&f, &state, sidecar_response(&f), None, None);
        assert_eq!(arr(&resp, "predicted").len(), 3000);
        assert_eq!(arr(&resp, "target_raw").len(), 3000);
        assert_eq!(arr(&resp, "predictor_raw").len(), 3000);
        assert_eq!(arr(&resp, "residual").len(), 3000);
        assert_eq!(resp["target_raw"][7].as_f64(), Some(f.y[7]));
        assert_eq!(resp["predictor_raw"][7], serde_json::json!(f.x[7]));
        assert_eq!(resp["n_rows"], serde_json::json!(3000));
    }


    #[test]
    fn the_cache_holds_every_row_even_when_the_response_is_bounded() {
        let f = fixture(2500);
        let state = state_for(f.n);
        let resp = run(&f, &state, sidecar_response(&f), Some("m1::abc"), Some(100));
        // Response: bounded + the cache fields + a bounded health preview.
        assert!(arr(&resp, "predicted").len() <= 100);
        assert_eq!(resp["cache_key"], serde_json::json!("m1::abc"));
        assert_eq!(resp["cached"], serde_json::json!(true));
        assert_eq!(resp["n_rows"], serde_json::json!(2500));
        let hp = resp.get("health_preview").expect("health_preview");
        assert_eq!(hp["kind"], serde_json::json!("relationship"));
        assert_eq!(hp["series"]["total_points"], serde_json::json!(2500), "the preview saw every row");
        assert!(hp["series"]["rows"].as_array().unwrap().len() <= 100);
        // Cache: the FULL arrays, untouched by the response bounding.
        let lock = state.0.read().unwrap();
        let fit = lock.as_ref().unwrap().rel_cache.peek("m1::abc").expect("cached fit");
        assert_eq!(fit.rows.len(), 2500);
        assert_eq!(fit.actual, f.y);
        assert_eq!(fit.predicted, f.predicted);
        assert_eq!(fit.x_cols[0].len(), 2500);
        assert_eq!(fit.x_cols[0][2499], 2499.0);
        assert_eq!(fit.r2_per_step, vec![0.5, 0.9]);
    }

    #[test]
    fn cached_and_health_preview_are_the_same_with_and_without_max_points() {
        let f = fixture(1200);
        let state = state_for(f.n);
        let a = run(&f, &state, sidecar_response(&f), Some("k1"), None);
        let b = run(&f, &state, sidecar_response(&f), Some("k1"), Some(4000));
        assert_eq!(a["cached"], b["cached"]);
        assert_eq!(a["cache_key"], b["cache_key"]);
        assert_eq!(a["health_preview"], b["health_preview"]);
        // max_points 4000 > 1200 rows => the arrays are whole in both.
        assert_eq!(arr(&b, "predicted").len(), 1200);
        assert!(a.get("residual").is_some() && b.get("residual").is_none());
    }

    #[test]
    fn a_stale_stamp_is_reported_as_not_cached_and_the_response_is_still_bounded() {
        let f = fixture(800);
        let state = state_for(f.n);
        let rows: Vec<u32> = (0..f.n as u32).collect();
        let stale = SessionStamp::new(99, 0); // a reload happened while the sidecar ran
        let resp = finish_relationship_response(
            &state,
            stale,
            sidecar_response(&f),
            &["X1".to_string(), "X2".to_string()],
            "Y",
            1000.0,
            &rows,
            &f.y,
            &f.x,
            Some("k".into()),
            Some(50),
        )
        .unwrap();
        assert_eq!(resp["cached"], serde_json::json!(false));
        assert!(resp.get("health_preview").is_none());
        assert!(arr(&resp, "predicted").len() <= 50);
        assert!(state.0.read().unwrap().as_ref().unwrap().rel_cache.is_empty());
    }
}

#[cfg(test)]
mod signed_sidecar_tests {
    use super::*;

    #[test]
    fn hmac_matches_rfc_4231() {
        // Test case 2 (short key) and test case 6 (key longer than a block).
        assert_eq!(
            to_hex(&hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        assert_eq!(
            to_hex(&hmac_sha256(&[0xaa; 131], b"Test Using Larger Than Block-Size Key - Hash Key First")),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn a_signed_line_is_timestamp_signature_and_the_request() {
        let request = serde_json::json!({"action": "predict_relationship", "payload": {"name": "ถังน้ำ \"A\"\nB"}});
        let line = signed_sidecar_line_at(&request, 1_700_000_000).unwrap();
        // One line: the sidecar reads exactly one line from stdin.
        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1);
        let mut parts = line.trim_end_matches('\n').splitn(3, ' ');
        let (ts, sig, body) = (parts.next().unwrap(), parts.next().unwrap(), parts.next().unwrap());
        assert_eq!(ts, "1700000000");
        assert_eq!(sig.len(), 64);
        assert_eq!(sig, to_hex(&hmac_sha256(&SIDECAR_KEY, format!("{ts}\n{body}").as_bytes())));
        assert_eq!(serde_json::from_str::<serde_json::Value>(body).unwrap(), request);
        // Another moment signs differently (a captured line cannot be re-stamped).
        assert_ne!(line, signed_sidecar_line_at(&request, 1_700_000_001).unwrap());
    }

    #[test]
    fn the_sidecar_source_carries_the_same_key_and_checks_it() {
        let py = include_str!("../python/backend.py");
        let key_line = format!("_KEY = bytes.fromhex(\"{}\")", to_hex(&SIDECAR_KEY));
        assert!(py.contains(&key_line), "backend.py must hold {key_line}");
        assert!(py.contains("msg = json.loads(_verified_body(line))"), "backend.py must verify before parsing");
    }

    /// Runs against the BUILT engine; ignored by default (`cargo test --lib built_engine -- --ignored`).
    #[test]
    #[ignore]
    fn built_engine_answers_a_signed_line_and_refuses_an_unsigned_one() {
        use std::io::Write;
        let exe = std::fs::read_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/bin"))
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| p.file_name().unwrap().to_string_lossy().starts_with("backend-"))
            .expect("build the engine first");
        let run = |line: String| -> serde_json::Value {
            let mut child = std::process::Command::new(&exe)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            child.stdin.take().unwrap().write_all(line.as_bytes()).unwrap();
            let out = child.wait_with_output().unwrap();
            serde_json::from_slice(&out.stdout).unwrap()
        };
        let request = serde_json::json!({"action": "preview_relationship", "payload": {
            "predictors": ["P1"], "target": "T",
            "X": [[1.0], [2.0], [3.0], [4.0], [5.0], [6.0]], "y": [2.0, 4.0, 6.0, 8.0, 10.0, 12.0],
            "smoothing": 1.0}});
        let answered = run(signed_sidecar_line(&request).unwrap());
        assert!(answered.get("error").is_none(), "{answered}");
        assert!(answered["r2_per_step"].is_array());
        let refused = run(format!("{request}\n"));
        assert_eq!(refused["error"], "Request refused.");
    }

    #[test]
    fn the_smoothing_key_has_a_neutral_name_on_both_sides() {
        let py = include_str!("../python/backend.py");
        assert!(py.contains("payload.get(\"smoothing\", 10000)"));
        assert!(!py.contains("linearGAM_lambda"), "the algorithm name must not travel over stdin");
    }
}
