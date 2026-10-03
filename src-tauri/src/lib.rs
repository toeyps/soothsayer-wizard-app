mod chart_query;
pub mod clustering;
pub mod csv_processor;
pub mod metrics;
pub mod operation_registry;
use csv_processor::{
    load_metadata, micros_to_naive, parse_timestamp, ts_to_micros, ColumnarData, CsvLoadReport,
    CsvRecord, MappingData, MappingResult, SensorMetadata, TS_MISSING,
};
use fasteval::Evaler;
use serde::{Deserialize, Serialize};
use std::sync::RwLock;
use tauri::State;

// ---------------------------------------------------------------------------
// Security / path-validation helpers
// ---------------------------------------------------------------------------

/// Validate a single path component intended to be used as a filename
/// (or directory name) on disk. Rejects empty strings, `.` / `..`, any
/// path separators (`/` `\`), `:`, NUL, Windows-reserved chars (`* ? < > | "`),
/// and ASCII control characters.
///
/// Used to defend the `train_*` commands against path-traversal via
/// frontend-supplied sensor/target names that are interpolated into
/// `Path::join` / `format!` filename templates.
fn sanitize_filename_component(s: &str) -> Result<String, String> {
    if s.is_empty() {
        return Err("empty filename component".into());
    }
    if s == "." || s == ".." {
        return Err("reserved filename component".into());
    }
    let bad = ['/', '\\', ':', '\0', '*', '?', '<', '>', '|', '"'];
    if s.chars().any(|c| bad.contains(&c) || c.is_control()) {
        return Err(format!("invalid character in name: {}", s));
    }
    Ok(s.to_string())
}

/// Validate a path passed from the frontend that we're about to open
/// for read (`load_csv`, `load_metadata_command`, `load_mapping_csv`).
///
/// We deliberately do NOT canonicalize or check existence here —
/// `File::open` already surfaces "file not found" with a useful error.
/// We only reject shapes that indicate the frontend is constructing
/// the path from attacker-controlled input (NUL bytes, `..` traversal).
fn validate_read_path(p: &str) -> Result<(), String> {
    if p.is_empty() {
        return Err("path is empty".into());
    }
    if p.contains('\0') {
        return Err("path contains NUL byte".into());
    }
    // Split on both Unix and Windows separators so cross-platform paths
    // are caught regardless of which slash style the frontend serialized.
    for component in p.split(['/', '\\']) {
        if component == ".." {
            return Err("path contains '..' component".into());
        }
    }
    Ok(())
}

/// Prefix a string cell with a leading apostrophe if it would otherwise
/// be interpreted as a formula by Excel / Numbers / LibreOffice
/// (CSV injection / "formula injection" defense, CWE-1236).
///
/// The leading apostrophe forces spreadsheet apps to treat the cell as
/// a literal string, and is stripped on display. Apply ONLY to string
/// cells — numeric values written with `{:e}`/`{}` start with a digit,
/// `+`, or `-`, but their value semantics rely on Excel parsing them as
/// numbers, so escaping would break that.
fn excel_safe(s: &str) -> String {
    if let Some(c) = s.chars().next() {
        if matches!(c, '=' | '+' | '-' | '@' | '\t' | '\r') {
            return format!("'{}", s);
        }
    }
    s.to_string()
}

/// Validate a frontend-supplied directory the backend will write into
/// (the `save_path` argument to the `train_*` commands). The user picks
/// this via a native dialog, so we don't constrain it to a specific
/// root — but we do reject obviously-malicious shapes.
///
///   - must be non-empty
///   - must be absolute (rejects `./foo`, `../foo`, plain `foo`)
///   - must not contain `..` components anywhere
///   - must already exist on disk and be a directory
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

/// Shared validation for frontend-supplied write destinations picked via
/// the OS-native save dialog (`write_user_file`).
///
/// The user picks the destination via the OS-native save dialog, so the
/// path itself is trusted to the extent the OS dialog vetted it. These
/// commands exist because the `tauri-plugin-fs` scope (which Phase 2 will
/// lock down to `$APPDATA/**`) would otherwise reject writes outside the
/// scoped directories. Validation here defends against frontend bugs that
/// might pass through a malicious string without dialog confirmation.
///
/// Validation:
///   - reject empty path or paths containing NUL byte
///   - reject any `..` component (traversal)
///   - canonicalize the *parent* directory (which must already exist —
///     the dialog selected a path under it) and assert it starts with
///     the lexical parent. This guards against a TOCTOU symlink-swap
///     where the parent dir is replaced with a symlink between dialog
///     and write. We don't canonicalize the file path itself because the
///     file may not exist yet.
///   - if parent doesn't exist, error out — we don't auto-mkdir because
///     the user selected a path via dialog, so its parent should exist.
fn validate_user_write_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("path is empty".into());
    }
    if path.contains('\0') {
        return Err("path contains NUL byte".into());
    }
    let p = std::path::Path::new(path);
    for component in p.components() {
        if matches!(component, std::path::Component::ParentDir) {
            return Err("path contains '..' component".into());
        }
    }
    let parent = p
        .parent()
        .ok_or_else(|| format!("path has no parent directory: {}", path))?;
    if parent.as_os_str().is_empty() {
        return Err(format!("path has no parent directory: {}", path));
    }
    // Canonicalize the parent (resolves symlinks, normalizes `.` / `..`).
    // If the parent doesn't exist, this errors — we don't auto-mkdir because
    // the user picked the path via a native save dialog, so its parent
    // directory must already exist.
    let parent_canonical = parent
        .canonicalize()
        .map_err(|e| format!("parent dir not accessible ({}): {}", parent.display(), e))?;
    // Defense against TOCTOU dir tricks: ensure the canonical parent path
    // still ends with (i.e. starts at the suffix matching) the literal
    // parent the caller passed in. If a symlink resolved to a totally
    // different prefix (e.g. parent was `/tmp/safe` and it's actually a
    // symlink to `/etc`), the canonical parent will not contain `safe`,
    // so the starts_with check catches the divergence.
    //
    // We can't directly compare equality because Windows / macOS may
    // legitimately rewrite drive letters / case / `/private` prefixes
    // during canonicalize, so we use suffix containment of the literal
    // parent's components against the canonical components.
    let lex_components: Vec<_> = parent
        .components()
        .filter(|c| matches!(c, std::path::Component::Normal(_)))
        .collect();
    let canon_components: Vec<_> = parent_canonical
        .components()
        .filter(|c| matches!(c, std::path::Component::Normal(_)))
        .collect();
    if !lex_components.is_empty() {
        let lex_len = lex_components.len();
        if canon_components.len() < lex_len
            || canon_components[canon_components.len() - lex_len..] != lex_components[..]
        {
            return Err(format!(
                "parent dir canonicalization diverged (possible symlink): {}",
                parent.display()
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod path_validation_tests {
    use super::*;

    // ── sanitize_filename_component ─────────────────────────────────

    #[test]
    fn sanitize_filename_component_accepts_a_plain_name() {
        assert_eq!(
            sanitize_filename_component("Sensor A").unwrap(),
            "Sensor A"
        );
    }

    #[test]
    fn sanitize_filename_component_rejects_empty() {
        assert!(sanitize_filename_component("").is_err());
    }

    #[test]
    fn sanitize_filename_component_rejects_dot_and_dotdot() {
        assert!(sanitize_filename_component(".").is_err());
        assert!(sanitize_filename_component("..").is_err());
    }

    #[test]
    fn sanitize_filename_component_rejects_path_separators() {
        assert!(sanitize_filename_component("a/b").is_err());
        assert!(sanitize_filename_component("a\\b").is_err());
    }

    #[test]
    fn sanitize_filename_component_rejects_windows_reserved_chars() {
        for c in ['*', '?', '<', '>', '|', '"', ':'] {
            let s = format!("bad{c}name");
            assert!(sanitize_filename_component(&s).is_err(), "should reject {c:?}");
        }
    }

    #[test]
    fn sanitize_filename_component_rejects_nul_and_control_chars() {
        assert!(sanitize_filename_component("a\0b").is_err());
        assert!(sanitize_filename_component("a\nb").is_err());
    }

    // ── validate_read_path ──────────────────────────────────────────

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

    // ── excel_safe ───────────────────────────────────────────────────

    #[test]
    fn excel_safe_escapes_formula_trigger_chars() {
        for c in ['=', '+', '-', '@'] {
            let s = format!("{c}cmd|calc");
            let escaped = excel_safe(&s);
            assert!(escaped.starts_with('\''), "should escape leading {c:?}");
            assert_eq!(&escaped[1..], s);
        }
    }

    #[test]
    fn excel_safe_escapes_leading_tab_and_cr() {
        assert!(excel_safe("\tdanger").starts_with('\''));
        assert!(excel_safe("\rdanger").starts_with('\''));
    }

    #[test]
    fn excel_safe_leaves_ordinary_strings_untouched() {
        assert_eq!(excel_safe("Sensor A"), "Sensor A");
        assert_eq!(excel_safe(""), "");
    }

    #[test]
    fn excel_safe_leaves_numeric_looking_strings_untouched() {
        // Numbers can start with -/+ but must round-trip as numeric values,
        // not be defensively escaped (escaping would corrupt them).
        // Only string CELLS go through excel_safe in practice, but the
        // function itself has no way to know that -- document the actual
        // (intentional) behavior: a leading '-' or '+' IS escaped.
        assert!(excel_safe("-5.2").starts_with('\''));
        assert_eq!(excel_safe("5.2"), "5.2");
    }

    // ── validate_save_dir ────────────────────────────────────────────

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

    // ── validate_user_write_path ─────────────────────────────────────

    #[test]
    fn validate_user_write_path_rejects_empty_and_nul() {
        assert!(validate_user_write_path("").is_err());
        assert!(validate_user_write_path("a\0b").is_err());
    }

    #[test]
    fn validate_user_write_path_rejects_traversal_components() {
        let dir = std::env::temp_dir().join(format!("wizard-writepath-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let traversal = dir.join("..").join("evil.csv");
        assert!(validate_user_write_path(traversal.to_str().unwrap()).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn validate_user_write_path_rejects_a_parent_dir_with_no_existing_directory() {
        let path = std::env::temp_dir()
            .join(format!("wizard-missing-parent-{}", std::process::id()))
            .join("out.csv");
        assert!(validate_user_write_path(path.to_str().unwrap()).is_err());
    }

    #[test]
    fn validate_user_write_path_accepts_a_file_under_an_existing_directory() {
        let dir = std::env::temp_dir().join(format!("wizard-writepath-ok-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("out.csv");
        assert!(validate_user_write_path(file.to_str().unwrap()).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── write_user_file (thin wrapper over validate_user_write_path) ──

    #[test]
    fn write_user_file_rejects_an_invalid_path_without_touching_disk() {
        let result = write_user_file("".into(), vec![1, 2, 3]);
        assert!(result.is_err());
    }

    #[test]
    fn write_user_file_writes_the_given_bytes() {
        let dir = std::env::temp_dir().join(format!("wizard-writefile-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("out.bin");
        write_user_file(file.to_str().unwrap().to_string(), vec![1, 2, 3]).unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), vec![1, 2, 3]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Bridge command for frontend `save()` dialog → arbitrary-path file write.
/// See [`validate_user_write_path`] for the trust model.
#[tauri::command]
fn write_user_file(path: String, contents: Vec<u8>) -> Result<(), String> {
    validate_user_write_path(&path)?;
    std::fs::write(&path, &contents)
        .map_err(|e| format!("Failed to write {}: {}", path, e))
}

struct SessionData {
    data: ColumnarData,
    paths: Vec<String>,
    /// Lower-cased, trimmed names (see [`name_key`]) of the columns that were
    /// COMPUTED in this session by `calculate_new_sensor` / `evaluate_formula`
    /// ("special sensors"), as opposed to imported from the CSV. Only these may
    /// be overwritten (`replace`) or dropped (`remove_sensor_columns`) — a raw
    /// CSV column is never touched. Rebuilt empty by every `load_csv`, so it can
    /// never outlive the dataset it describes.
    derived: std::collections::HashSet<String>,
    /// Bumped by every `load_csv`. A special-sensor computation runs under a
    /// READ lock and stores its result under a short write lock afterwards; if
    /// a new dataset was loaded in between, the generation no longer matches
    /// and the result is discarded instead of being attached to the wrong data.
    generation: u64,
}

static SESSION_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

struct AppState(RwLock<Option<SessionData>>);

#[tauri::command]
fn load_csv(paths: Vec<String>, state: State<AppState>) -> Result<CsvLoadReport, String> {
    // Reject any path with a `..` component, NUL byte, or empty string.
    // File-existence is delegated to `File::open` so the error surface
    // stays familiar.
    for p in &paths {
        validate_read_path(p).map_err(|e| format!("invalid path '{}': {}", p, e))?;
    }
    let merge_result = csv_processor::read_merge_csvs_with_report(paths.clone())?;
    let report = csv_processor::build_load_report(&merge_result);

    let mut state_lock = state.0.write().map_err(|e| e.to_string())?;
    *state_lock = Some(SessionData {
        data: merge_result.data,
        paths,
        derived: std::collections::HashSet::new(),
        generation: SESSION_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1,
    });

    Ok(report)
}

#[tauri::command]
fn get_loaded_paths(state: State<AppState>) -> Result<Vec<String>, String> {
    let state_lock = state.0.read().map_err(|e| e.to_string())?;
    match &*state_lock {
        Some(session) => Ok(session.paths.clone()),
        None => Ok(Vec::new()),
    }
}

#[tauri::command]
fn get_all_sensors(state: State<AppState>) -> Result<Vec<String>, String> {
    let state_lock = state.0.read().map_err(|e| e.to_string())?;
    let session = state_lock.as_ref().ok_or("No data loaded")?;
    Ok(session.data.headers.clone())
}

#[tauri::command]
fn load_metadata_command(path: String) -> Result<Vec<SensorMetadata>, String> {
    validate_read_path(&path).map_err(|e| format!("invalid path '{}': {}", path, e))?;
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

/// Compute mean / sample standard deviation (ddof=1, pandas-style) plus 1σ
/// & 3σ bounds across all non-null values of a given sensor in the currently
/// loaded dataset.
///
/// Phase 3 change: switched from population SD (ddof=0) to sample SD (ddof=1)
/// for parity with `wizard.py` which uses pandas `.std()`. The numerical
/// difference is `sqrt(N/(N-1))` per σ — invisible at large N, slightly wider
/// boundaries at small N.
#[tauri::command]
fn compute_sensor_stats(
    sensor: String,
    // Same dashboard filter the predictive-model preview commands take.
    // When present, mean/SD/±σ are computed over the filtered slice — so
    // the boundary markers on the PM target chart match the slice the user
    // explored in the dashboard.
    filter: Option<PreviewFilter>,
    state: State<AppState>,
) -> Result<SensorStats, String> {
    use rayon::prelude::*;

    let state_lock = state.0.read().map_err(|e| e.to_string())?;
    let session = state_lock.as_ref().ok_or("No data loaded")?;
    let data = &session.data;

    let idx = data
        .headers
        .iter()
        .position(|h| h == &sensor)
        .ok_or_else(|| format!("Sensor not found: {}", sensor))?;

    let resolved = ResolvedFilter::resolve(filter.as_ref(), &data.headers)?;

    // Parallel collect of all finite values for the target column (NaN =
    // missing, so `is_finite` drops missing and ±inf alike) — restricted to
    // rows passing the dashboard filter when one is set.
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

    // Min/max in parallel (mean now comes from `metrics::mean`).
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
    // Sample SD (ddof=1) — matches pandas `.std()`. For N=1 sample_sd is NaN;
    // fall back to 0.0 so the ±σ band is degenerate but well-defined.
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

/// Spawn the Python ML sidecar (`bin/backend-<target-triple>`), translating
/// the classic fresh-checkout failures into an actionable error.
///
/// The sidecar binary is gitignored and built separately; `cargo check`
/// only needs a 0-byte stub to satisfy tauri-build's existence check, but
/// actually LAUNCHING that stub fails with `%1 is not a valid Win32
/// application. (os error 193)` on Windows (`Exec format error` on unix).
/// Without this mapping the raw OS error reaches the UI and reads like a
/// crash instead of a missing build step.
fn spawn_sidecar(
    app: &tauri::AppHandle,
) -> Result<
    (
        tauri::async_runtime::Receiver<CommandEvent>,
        tauri_plugin_shell::process::CommandChild,
    ),
    String,
> {
    const BUILD_HINT: &str = "The Python ML sidecar (src-tauri/bin/backend-<target>) is missing or is \
         an empty stub. Build it with src-tauri/python/build_sidecar.sh (or \
         scripts/build-installer-windows.ps1 step 3), then retry.";
    let sidecar = app
        .shell()
        .sidecar("backend")
        .map_err(|e| format!("Sidecar setup failed: {}. {}", e, BUILD_HINT))?;
    sidecar.spawn().map_err(|e| {
        let msg = e.to_string();
        let lower = msg.to_lowercase();
        let looks_like_missing_build = lower.contains("os error 193")
            || lower.contains("not a valid win32 application")
            || lower.contains("exec format error")
            || lower.contains("os error 2") // file not found
            || lower.contains("not found");
        if looks_like_missing_build {
            format!("Failed to launch the Python ML sidecar ({}). {}", msg, BUILD_HINT)
        } else {
            format!("Failed to launch the Python ML sidecar: {}", msg)
        }
    })
}

/// Optional value-filter passed alongside `preview_relationship_model`.
/// Mirrors the JSON shape produced by the dashboard's FilterPanel, so the
/// preview scatter can be built off the same filtered slice the user is
/// looking at on the previous page.
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
    /// "and" | "or" — how `value_filters` combine. Missing/anything else
    /// defaults to "and" (the only mode this ever had before the Running
    /// Condition Filter's AND/OR toggle). `DataFilter::to_preview` (below)
    /// never sets this, so Dashboard's own chart/scatter queries always stay
    /// AND-only — only the Build Model page's Running Condition Filter can
    /// opt into "or".
    #[serde(default)]
    combine: Option<String>,
    /// Multiple training time periods (Feature 4). Kept if the row falls in ANY
    /// period. Mutually exclusive with the legacy `timestamp_start/_end` pair —
    /// sending both is a wiring bug and `ResolvedFilter::resolve` rejects it.
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

/// Parse one optional bound to epoch micros. Blank/whitespace/None = open
/// (`Ok(None)`); anything else that fails to parse is an error rather than a
/// silently unbounded side.
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

/// Parsed/resolved form of a `PreviewFilter`. Built once per command call
/// from a `&[String]` of headers; thereafter `.keeps(data, row)` is a cheap
/// predicate suitable for use inside the row-iteration loop of every
/// data-reading command. Timestamp bounds are held as epoch microseconds and
/// compared against `ColumnarData::ts_parsed` — rows are never re-parsed.
/// A noop filter (`is_noop() == true`) is what every command saw before this
/// refactor — included for symmetry but most call sites short-circuit when
/// noop to preserve the parallel-rayon fast paths.
struct ResolvedFilter {
    /// Sorted, merged time periods (epoch micros, inclusive). Empty = no time
    /// gate. `None` on a side = open bound.
    ts_ranges: Vec<(Option<i64>, Option<i64>)>,
    value_filters: Vec<ResolvedValueFilter>,
    /// true = OR (any value filter passing keeps the row), false = AND (all
    /// must pass) — the pre-existing, still-default behavior.
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
                headers
                    .iter()
                    .position(|h| h == &vf.sensor)
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

    /// True if row `row` falls inside the dashboard filter window (timestamp
    /// AND all value-filter predicates). Rows whose timestamp was missing or
    /// unparseable at load (`TS_MISSING`) are excluded under a timestamp gate
    /// — matches the legacy per-query parse behavior.
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
        // AND: every condition must pass (the original, still-default
        // behavior). OR: at least one must pass — an empty list is handled
        // above and never reaches here, so this is never a vacuous "OR of
        // nothing" false.
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

    // ---- Feature 4: multiple time periods ----

    fn ts_dataset() -> ColumnarData {
        // Rows at minute 0..=9 on 2020-01-01, plus a TS_MISSING row. A = row index.
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

/// Preview the Relationship (LinearGAM) model on the currently loaded
/// dataset by delegating to the Python sidecar.
///
/// The Rust side projects only the predictor + target columns, drops rows
/// with any null/non-finite value, and ships the resulting matrix to the
/// sidecar (much smaller than the full dataset).  The sidecar runs the
/// `Wizard.PreviewModel.relationship` routine and streams back JSON, which
/// we forward to the frontend untouched as `serde_json::Value`.
///
/// When `filter` is provided, rows are first restricted to those matching
/// the dashboard's timestamp range + value filters before NaN-dropping.
/// `None` keeps the legacy "use all rows" behavior.
#[tauri::command]
async fn preview_relationship_model(
    predictors: Vec<String>,
    target: String,
    lambda: f64,
    filter: Option<PreviewFilter>,
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
        let state_lock = state.0.read().map_err(|e| e.to_string())?;
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

        // Dashboard filter (timestamp + value gates) — same resolution used
        // by every other data-reading command; row timestamps were parsed
        // once at load, so the gate below is pure integer compares.
        let resolved = ResolvedFilter::resolve(filter.as_ref(), &data.headers)?;

        // Drop rows with any null/non-finite across the (predictors + target) set,
        // and rows that fall outside the dashboard filter (when present).
        let pred_cols: Vec<&[f64]> = predictor_indices
            .iter()
            .map(|&i| data.columns[i].as_slice())
            .collect();
        let target_col: &[f64] = &data.columns[target_idx];

        let mut x_matrix: Vec<Vec<f64>> = Vec::with_capacity(data.n_rows());
        let mut y_vector: Vec<f64> = Vec::with_capacity(data.n_rows());
        for r in 0..data.n_rows() {
            if !resolved.is_noop() && !resolved.keeps(data, r) {
                continue;
            }
            let mut x_row: Vec<f64> = Vec::with_capacity(pred_cols.len());
            let mut ok = true;
            for col in &pred_cols {
                let v = col[r];
                if v.is_finite() {
                    x_row.push(v);
                } else {
                    ok = false;
                    break;
                }
            }
            if !ok {
                continue;
            }
            let y_val = target_col[r];
            if !y_val.is_finite() {
                continue;
            }
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
    let (mut rx, mut child) = spawn_sidecar(&app)?;
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

    let mut parsed = serde_json::from_str::<serde_json::Value>(stdout_buf.trim())
        .map_err(|e| format!("Failed to parse sidecar output: {} (raw: {})", e, stdout_buf))?;

    // Re-extract X / y from the request payload we shipped to the sidecar — these
    // were already cleaned (NaN-dropped, projected) by Rust above.  Attaching them
    // to the response lets the frontend draw scatter (predictor_raw vs target_raw)
    // without re-querying the dataset.
    if let Some(obj) = parsed.as_object_mut() {
        if let Some(req_payload) = payload.get("payload") {
            if let Some(x_val) = req_payload.get("X") {
                obj.insert("predictor_raw".to_string(), x_val.clone());
            }
            if let Some(y_val) = req_payload.get("y") {
                obj.insert("target_raw".to_string(), y_val.clone());
            }
        }
    }

    Ok(parsed)
}

// ── Phase 3 / 4: Predictive-model save commands (Individual + Clustering) ──

/// Scan a column; return (min_iso, max_iso) over the load-time-parsed
/// timestamps of every row whose value at `value_idx` is finite. Falls back
/// to empty strings if no timestamps parsed. When `filter.is_noop()` is
/// false, rows are first gated by the dashboard filter (timestamp + value
/// bounds).
fn dataset_time_bounds(
    data: &ColumnarData,
    value_idx: usize,
    filter: &ResolvedFilter,
) -> (String, String) {
    let col = &data.columns[value_idx];
    let mut min_us: Option<i64> = None;
    let mut max_us: Option<i64> = None;
    for (r, &v) in col.iter().enumerate() {
        if !filter.is_noop() && !filter.keeps(data, r) {
            continue;
        }
        if !v.is_finite() {
            continue;
        }
        let us = data.ts_parsed[r];
        if us == TS_MISSING {
            continue;
        }
        min_us = Some(min_us.map_or(us, |m| m.min(us)));
        max_us = Some(max_us.map_or(us, |m| m.max(us)));
    }
    match (
        min_us.and_then(micros_to_naive),
        max_us.and_then(micros_to_naive),
    ) {
        (Some(mn), Some(mx)) => (
            mn.format("%Y-%m-%dT%H:%M:%S").to_string(),
            mx.format("%Y-%m-%dT%H:%M:%S").to_string(),
        ),
        _ => (String::new(), String::new()),
    }
}

#[derive(Debug, Serialize)]
pub struct IndividualModelInfo {
    pub model_name: String,
    pub publish_id: i64,
    pub training_set_start_date: String,
    pub training_set_end_date: String,
    pub mean: f64,
    pub sd: f64,
    pub boundary_1sd: [f64; 2],
    pub boundary_3sd: [f64; 2],
    pub saved_path: String,
}

/// Build the `INDIVIDUAL_INFO` JSON payload (matching wizard.py exactly) and
/// write it to `{save_path}/output/{target}/INDV_INFO_{target}.json`.
///
/// Numeric values are rounded to 3 decimals to match wizard.py's
/// `round(..., 3)` calls in `_execute_individual`.
#[tauri::command(rename_all = "snake_case")]
fn train_individual_model(
    target: String,
    model_name: Option<String>,
    save_path: String,
    // Dashboard filter (timestamp + value gates). When set, the trained mean/
    // SD and the saved start/end_date all reflect the filtered slice rather
    // than the entire dataset.
    filter: Option<PreviewFilter>,
    state: State<AppState>,
) -> Result<IndividualModelInfo, String> {
    use rayon::prelude::*;

    if target.is_empty() {
        return Err("Target sensor is required.".into());
    }
    if save_path.is_empty() {
        return Err("save_path is required.".into());
    }
    // Path-traversal defense: `target` is interpolated into the on-disk
    // filename / directory under `save_path/output/{target}/INDV_INFO_*`.
    // A sensor name containing `/`, `..`, etc. would either escape the
    // intended directory or produce an opaque filesystem error.
    let target = sanitize_filename_component(&target)
        .map_err(|e| format!("target: {}", e))?;
    validate_save_dir(&save_path)?;

    let state_lock = state.0.read().map_err(|e| e.to_string())?;
    let session = state_lock.as_ref().ok_or("No data loaded")?;
    let data = &session.data;

    let idx = data
        .headers
        .iter()
        .position(|h| h == &target)
        .ok_or_else(|| format!("Sensor not found: {}", target))?;

    let resolved = ResolvedFilter::resolve(filter.as_ref(), &data.headers)?;

    // Finite values for the target column (NaN = missing), gated by the
    // dashboard filter when one is set.
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

    if values.is_empty() {
        return Err(format!("No valid numeric values for sensor '{}'", target));
    }

    let mean = metrics::mean(&values);
    let sd_raw = metrics::sample_sd(&values, mean);
    let sd = if sd_raw.is_nan() { 0.0 } else { sd_raw };

    // Round to 3 decimals to match wizard.py.
    let r3 = |x: f64| (x * 1000.0).round() / 1000.0;
    let mean_r = r3(mean);
    let sd_r = r3(sd);
    let b1 = [r3(mean_r - sd_r), r3(mean_r + sd_r)];
    let b3 = [r3(mean_r - 3.0 * sd_r), r3(mean_r + 3.0 * sd_r)];

    // start/end_date follow the same filter — otherwise saved metadata
    // would advertise the full dataset's span.
    let (start_date, end_date) = dataset_time_bounds(data, idx, &resolved);

    // Default model_name follows wizard.py: f"{descr} ({tag})". We don't have
    // the sensor mapper Rust-side, so just use the tag.
    let resolved_name = model_name
        .as_deref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("({})", target));

    let now = chrono::Utc::now().to_rfc3339();

    // Build the JSON payload matching wizard.PredictiveImplementationTemplate.INDIVIDUAL_INFO
    let json_payload = serde_json::json!({
        "model_name": resolved_name,
        "model_composition": {},
        "model_training_set_info": {
            "publish_id": 0,
            "training_set_start_date": start_date,
            "training_set_end_date": end_date,
            "training_set_comments": ""
        },
        "model_metrics": {
            "mean": mean_r,
            "sd": sd_r,
            "1sd_boundary": [b1[0], b1[1]],
            "3sd_boundary": [b3[0], b3[1]],
            "setpoint_health_score": [serde_json::Value::Null, serde_json::Value::Null]
        },
        "historical_sd_band_and_set_point": {},
        "model_update_record": [
            {
                "publish_id": 0,
                "updated_timestamp": now,
                "updated_by": "Wizard",
                "activity": "Wizard",
                "comments": ""
            }
        ]
    });

    // Write to disk: {save_path}/output/{target}/INDV_INFO_{target}.json
    let out_dir = std::path::Path::new(&save_path)
        .join("output")
        .join(&target);
    std::fs::create_dir_all(&out_dir)
        .map_err(|e| format!("Failed to create output dir: {}", e))?;
    let out_file = out_dir.join(format!("INDV_INFO_{}.json", target));
    let json_text = serde_json::to_string_pretty(&json_payload)
        .map_err(|e| format!("JSON serialize failed: {}", e))?;
    std::fs::write(&out_file, json_text)
        .map_err(|e| format!("Failed to write {}: {}", out_file.display(), e))?;

    Ok(IndividualModelInfo {
        model_name: resolved_name,
        publish_id: 0,
        training_set_start_date: start_date,
        training_set_end_date: end_date,
        mean: mean_r,
        sd: sd_r,
        boundary_1sd: b1,
        boundary_3sd: b3,
        saved_path: out_file.to_string_lossy().into_owned(),
    })
}

/// Half-open interval `[min, max)` over the criteria sensor's value.
/// `None` on either bound means "unbounded in that direction" — i.e.
/// the cluster catches everything at/above min (if max is None) or
/// strictly below max (if min is None). Mirrors `wizard.py`'s use of
/// `-inf` / `+inf` sentinels via `Option` so JSON stays well-formed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClusterRange {
    pub min: Option<f64>,
    pub max: Option<f64>,
}

impl ClusterRange {
    fn contains(&self, v: f64) -> bool {
        if let Some(lo) = self.min {
            if v < lo { return false; }
        }
        if let Some(hi) = self.max {
            if v >= hi { return false; }
        }
        true
    }
}

#[derive(Debug, Serialize)]
pub struct ClusterDetail {
    /// 1-based cluster id, matching wizard.py's keys ("1", "2", …).
    pub cluster_id: u32,
    /// `None` for the single-cluster path (no criteria split).
    pub range: Option<ClusterRange>,
    pub n_rows: usize,
    pub ellipse: clustering::EllipseFit,
    /// Per-row X values for this cluster (first_sensor, NaN-dropped).
    pub xs: Vec<f64>,
    /// Per-row Y values for this cluster (second_sensor, NaN-dropped).
    pub ys: Vec<f64>,
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

/// Compute one ellipse fit per cluster.
///
///   • `n_clusters == 1`: single-cluster path — ignore `criteria_sensor` /
///     `cluster_ranges`. Fits one ellipse over all (first, second) rows
///     after NaN-drop.
///   • `n_clusters > 1`: multi-cluster path — requires `criteria_sensor`
///     and a `cluster_ranges` vec of length `n_clusters`. For each
///     range, filters rows whose criteria_sensor value falls in
///     `[range.min, range.max)`, drops NaNs on (first, second), and fits
///     a single Gaussian to produce an ellipse. Mirrors
///     `wizard.py::PreviewModel.clustering` semantics.
#[tauri::command(rename_all = "snake_case")]
fn compute_clustering_preview(
    first_sensor: String,
    second_sensor: String,
    n_clusters: u32,
    criteria_sensor: Option<String>,
    cluster_ranges: Option<Vec<ClusterRange>>,
    // Same dashboard filter the predictive-model preview commands take.
    // When present the ellipse fit and per-cluster scatter are restricted
    // to the filtered slice, matching what the user saw in the dashboard.
    filter: Option<PreviewFilter>,
    state: State<AppState>,
) -> Result<ClusteringPreview, String> {
    if n_clusters == 0 {
        return Err("n_clusters must be at least 1".into());
    }
    if first_sensor.is_empty() || second_sensor.is_empty() {
        return Err("Both sensors are required.".into());
    }

    let state_lock = state.0.read().map_err(|e| e.to_string())?;
    let session = state_lock.as_ref().ok_or("No data loaded")?;
    let data = &session.data;

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

    // ── Single-cluster path ──────────────────────────────────────
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
                xs,
                ys,
            }],
        });
    }

    // ── Multi-cluster path ──────────────────────────────────────
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

    let mut clusters: Vec<ClusterDetail> = Vec::with_capacity(n_clusters as usize);
    let mut total_rows: usize = 0;

    let c1 = &data.columns[i1];
    let c2 = &data.columns[i2];
    let cc = &data.columns[ic];

    for (idx, range) in ranges.iter().enumerate() {
        let cluster_id = (idx + 1) as u32;
        let mut xs: Vec<f64> = Vec::new();
        let mut ys: Vec<f64> = Vec::new();
        for r in 0..data.n_rows() {
            if !resolved.is_noop() && !resolved.keeps(data, r) {
                continue;
            }
            let c = cc[r];
            if !c.is_finite() || !range.contains(c) {
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
            return Err(format!(
                "Cluster {} has no rows after applying its criteria range.",
                cluster_id
            ));
        }
        let ellipse = clustering::fit_single_cluster_ellipse(&xs, &ys)?;
        let n_rows = xs.len();
        total_rows += n_rows;
        clusters.push(ClusterDetail {
            cluster_id,
            range: Some(range.clone()),
            n_rows,
            ellipse,
            xs,
            ys,
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

#[derive(Debug, Serialize)]
pub struct ClusteringModelInfo {
    pub model_name: String,
    pub first_sensor: String,
    pub second_sensor: String,
    pub criteria_sensor: Option<String>,
    pub cluster_count: u32,
    /// Per-cluster ellipse fits, in cluster_id order.
    pub clusters: Vec<ClusterDetail>,
    pub saved_path: String,
}

/// Persist a (single- or multi-) cluster GMM ellipse fit to
/// `{save_path}/output/{second_sensor}/CLUS_INFO_{first_sensor}_{second_sensor}.json`
/// matching `wizard.py`'s `CLUSTERING_INFO` template, including the
/// per-cluster `critera_sensor_value_higher_than` /
/// `critera_sensor_value_lower_than` keys (note the `critera` typo —
/// preserved for parity with the upstream wizard payload).
#[tauri::command(rename_all = "snake_case")]
fn train_clustering_model(
    first_sensor: String,
    second_sensor: String,
    n_clusters: u32,
    criteria_sensor: Option<String>,
    cluster_ranges: Option<Vec<ClusterRange>>,
    model_name: Option<String>,
    save_path: String,
    // Forwarded straight to `compute_clustering_preview` so the trained
    // ellipse mirrors the dashboard's filtered slice.
    filter: Option<PreviewFilter>,
    state: State<AppState>,
) -> Result<ClusteringModelInfo, String> {
    if save_path.is_empty() {
        return Err("save_path is required.".into());
    }
    // Path-traversal defense — both sensors land in the filename
    // (`CLUS_INFO_{first}_{second}.json`) and `second_sensor` is also
    // a directory component. Reject any traversal/separator chars before
    // we let them anywhere near `Path::join` / `format!`.
    let first_sensor = sanitize_filename_component(&first_sensor)
        .map_err(|e| format!("first_sensor: {}", e))?;
    let second_sensor = sanitize_filename_component(&second_sensor)
        .map_err(|e| format!("second_sensor: {}", e))?;
    validate_save_dir(&save_path)?;

    // Reuse the preview path — it already does all the validation /
    // splitting / ellipse-fitting for both 1-cluster and N-cluster cases.
    // We clone `filter` because the date-range computation below needs
    // the same predicate to clip start/end to the filtered window.
    let preview = compute_clustering_preview(
        first_sensor.clone(),
        second_sensor.clone(),
        n_clusters,
        criteria_sensor.clone(),
        cluster_ranges,
        filter.clone(),
        state.clone(),
    )?;

    // Need start/end dates over the joined-non-null subset (matches
    // single-cluster behaviour even when n_clusters > 1; the criteria
    // filter doesn't shift the training date range). The dashboard
    // filter — distinct from the per-cluster criteria range — does narrow
    // it, so we gate rows by `resolved.keeps(row)` here too.
    let (start_date, end_date) = {
        let state_lock = state.0.read().map_err(|e| e.to_string())?;
        let session = state_lock.as_ref().ok_or("No data loaded")?;
        let data = &session.data;
        let i1 = data.headers.iter().position(|h| h == &first_sensor).unwrap();
        let i2 = data.headers.iter().position(|h| h == &second_sensor).unwrap();

        let resolved = ResolvedFilter::resolve(filter.as_ref(), &data.headers)?;
        let c1 = &data.columns[i1];
        let c2 = &data.columns[i2];
        let mut min_us: Option<i64> = None;
        let mut max_us: Option<i64> = None;
        for r in 0..data.n_rows() {
            if !resolved.is_noop() && !resolved.keeps(data, r) { continue; }
            if !(c1[r].is_finite() && c2[r].is_finite()) { continue; }
            let us = data.ts_parsed[r];
            if us == TS_MISSING { continue; }
            min_us = Some(min_us.map_or(us, |m| m.min(us)));
            max_us = Some(max_us.map_or(us, |m| m.max(us)));
        }
        match (
            min_us.and_then(micros_to_naive),
            max_us.and_then(micros_to_naive),
        ) {
            (Some(a), Some(b)) => (
                a.format("%Y-%m-%dT%H:%M:%S").to_string(),
                b.format("%Y-%m-%dT%H:%M:%S").to_string(),
            ),
            _ => (String::new(), String::new()),
        }
    };

    let r3 = |x: f64| (x * 1000.0).round() / 1000.0;

    let resolved_name = model_name
        .as_deref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("({}) VS ({})", first_sensor, second_sensor));

    let now = chrono::Utc::now().to_rfc3339();

    // Build the wizard.py-shaped cluster_info map. Each cluster entry
    // gets the ellipse params plus optional criteria-range fields,
    // emitted only when the corresponding bound is finite (mirrors
    // wizard.py's three-branch handling of -inf / +inf).
    let mut cluster_info_map = serde_json::Map::new();
    for cluster in &preview.clusters {
        let mut entry = serde_json::Map::new();
        if let Some(range) = &cluster.range {
            if let Some(lo) = range.min {
                entry.insert(
                    "critera_sensor_value_higher_than".into(),
                    serde_json::json!(r3(lo)),
                );
            }
            if let Some(hi) = range.max {
                entry.insert(
                    "critera_sensor_value_lower_than".into(),
                    serde_json::json!(r3(hi)),
                );
            }
        }
        entry.insert("x_cluster_center".into(), serde_json::json!(r3(cluster.ellipse.x_center)));
        entry.insert("y_cluster_center".into(), serde_json::json!(r3(cluster.ellipse.y_center)));
        entry.insert("x_sd".into(), serde_json::json!(r3(cluster.ellipse.x_sd)));
        entry.insert("y_sd".into(), serde_json::json!(r3(cluster.ellipse.y_sd)));
        entry.insert("angle_deg".into(), serde_json::json!(r3(cluster.ellipse.angle_deg)));
        entry.insert("boundary_sd_health_score".into(), serde_json::Value::Null);

        cluster_info_map.insert(cluster.cluster_id.to_string(), serde_json::Value::Object(entry));
    }
    let cluster_info = serde_json::Value::Object(cluster_info_map);

    let composition_criteria = preview
        .criteria_sensor
        .clone()
        .unwrap_or_default();

    let json_payload = serde_json::json!({
        "model_name": resolved_name,
        "model_composition": {
            "first_sensor": first_sensor,
            "second_sensor": second_sensor,
            "criteria_sensor": composition_criteria,
            "cluster_count": preview.cluster_count,
        },
        "model_training_set_info": {
            "publish_id": 0,
            "training_set_start_date": start_date,
            "training_set_end_date": end_date,
            "training_set_comments": ""
        },
        "cluster_info": cluster_info,
        "model_update_record": [
            {
                "publish_id": 0,
                "updated_timestamp": now,
                "updated_by": "Wizard",
                "activity": "Wizard",
                "comments": ""
            }
        ]
    });

    let out_dir = std::path::Path::new(&save_path)
        .join("output")
        .join(&second_sensor);
    std::fs::create_dir_all(&out_dir)
        .map_err(|e| format!("Failed to create output dir: {}", e))?;
    let out_file = out_dir.join(format!(
        "CLUS_INFO_{}_{}.json",
        first_sensor, second_sensor
    ));
    let json_text = serde_json::to_string_pretty(&json_payload)
        .map_err(|e| format!("JSON serialize failed: {}", e))?;
    std::fs::write(&out_file, json_text)
        .map_err(|e| format!("Failed to write {}: {}", out_file.display(), e))?;

    Ok(ClusteringModelInfo {
        model_name: resolved_name,
        first_sensor,
        second_sensor,
        criteria_sensor: preview.criteria_sensor,
        cluster_count: preview.cluster_count,
        clusters: preview.clusters,
        saved_path: out_file.to_string_lossy().into_owned(),
    })
}

#[derive(Debug, Serialize)]
pub struct RelationshipTrainResult {
    pub model_path: String,
    pub r2: f64,
    pub rmse2: f64,
    pub n_rows: usize,
    pub info_path: String,
}

/// Train a Relationship (LinearGAM) model via the sidecar and persist:
///   - The pickled model under `{save_path}/output/{target}/REL_MODEL_*.pkl`
///   - A `REL_INFO_*.json` written by Rust (Python only saves the .pkl).
#[tauri::command(rename_all = "snake_case")]
async fn train_relationship_model(
    predictors: Vec<String>,
    target: String,
    lambda: f64,
    save_path: String,
    model_name: Option<String>,
    // Dashboard filter (timestamp + value gates). When set, the LinearGAM
    // is trained on the filtered slice and the REL_DATASET CSV / time
    // bounds reflect the same restricted row set.
    filter: Option<PreviewFilter>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<RelationshipTrainResult, String> {
    if predictors.is_empty() {
        return Err("At least one predictor is required.".into());
    }
    if target.is_empty() {
        return Err("Target sensor is required.".into());
    }
    if save_path.is_empty() {
        return Err("save_path is required.".into());
    }
    // Path-traversal defense: `target` ends up as a directory name
    // (`save_path/output/{target}/`) and each predictor is joined with `+`
    // to form the `{feat_token}` interpolated into REL_DATASET/REL_INFO
    // filenames. Any of these containing path separators or `..` would
    // either escape the output dir or corrupt the filename.
    let target = sanitize_filename_component(&target)
        .map_err(|e| format!("target: {}", e))?;
    let predictors: Vec<String> = predictors
        .iter()
        .map(|p| sanitize_filename_component(p).map_err(|e| format!("predictor '{}': {}", p, e)))
        .collect::<Result<Vec<_>, String>>()?;
    validate_save_dir(&save_path)?;

    // Build (X, y) the same way preview does. Also capture the raw timestamp
    // string per surviving row — we use it later as the first CSV column so
    // the REL_DATASET file aligns with `wizard.py::SaveThisSensor`'s
    // `training_set.to_csv(...)` (which writes the DataFrame's DatetimeIndex
    // as the unnamed first column).
    let (x_matrix, y_vector, row_timestamps, time_bounds) = {
        let state_lock = state.0.read().map_err(|e| e.to_string())?;
        let session = state_lock.as_ref().ok_or("No data loaded")?;
        let data = &session.data;

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

        let mut x_matrix: Vec<Vec<f64>> = Vec::with_capacity(data.n_rows());
        let mut y_vector: Vec<f64> = Vec::with_capacity(data.n_rows());
        let mut row_timestamps: Vec<Option<String>> = Vec::with_capacity(data.n_rows());
        let mut min_us: Option<i64> = None;
        let mut max_us: Option<i64> = None;
        for r in 0..data.n_rows() {
            if !resolved.is_noop() && !resolved.keeps(data, r) {
                continue;
            }
            let mut x_row: Vec<f64> = Vec::with_capacity(pred_cols.len());
            let mut ok = true;
            for col in &pred_cols {
                let v = col[r];
                if v.is_finite() {
                    x_row.push(v);
                } else {
                    ok = false;
                    break;
                }
            }
            if !ok { continue; }
            let y_val = target_col[r];
            if !y_val.is_finite() {
                continue;
            }
            x_matrix.push(x_row);
            y_vector.push(y_val);
            row_timestamps.push(data.timestamps[r].clone());
            let us = data.ts_parsed[r];
            if us != TS_MISSING {
                min_us = Some(min_us.map_or(us, |m| m.min(us)));
                max_us = Some(max_us.map_or(us, |m| m.max(us)));
            }
        }
        if x_matrix.is_empty() {
            return Err("No rows remain after dropping nulls.".into());
        }
        let bounds = match (
            min_us.and_then(micros_to_naive),
            max_us.and_then(micros_to_naive),
        ) {
            (Some(a), Some(b)) => (
                a.format("%Y-%m-%dT%H:%M:%S").to_string(),
                b.format("%Y-%m-%dT%H:%M:%S").to_string(),
            ),
            _ => (String::new(), String::new()),
        };
        (x_matrix, y_vector, row_timestamps, bounds)
    };

    let n_rows = x_matrix.len();

    let payload = serde_json::json!({
        "action": "train_relationship",
        "payload": {
            "predictors": predictors,
            "target": target,
            "X": x_matrix,
            "y": y_vector,
            "linearGAM_lambda": lambda,
            "saved_path": save_path,
        }
    });

    let mut payload_line = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    payload_line.push('\n');

    let (mut rx, mut child) = spawn_sidecar(&app)?;
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

    #[derive(Deserialize)]
    struct SidecarTrainResponse {
        r2: Option<f64>,
        rmse2: Option<f64>,
        model_path: Option<String>,
        /// Per-row LinearGAM predictions, NaN-cleaned (None) and rounded to
        /// 3 decimals by `backend.py::train_relationship`. Length matches
        /// the surviving-row count we sent over.
        predicted: Option<Vec<Option<f64>>>,
        /// Per-row residuals (`y - predicted`), same shape as `predicted`.
        residual: Option<Vec<Option<f64>>>,
        error: Option<String>,
        #[allow(dead_code)]
        trace: Option<String>,
    }

    let resp: SidecarTrainResponse = serde_json::from_str(stdout_buf.trim())
        .map_err(|e| format!("Failed to parse sidecar output: {} (raw: {})", e, stdout_buf))?;
    if let Some(err) = resp.error {
        return Err(format!("Sidecar error: {}", err));
    }
    let r2 = resp.r2.ok_or("Sidecar response missing r2")?;
    let rmse2 = resp.rmse2.ok_or("Sidecar response missing rmse2")?;
    let model_path = resp.model_path.ok_or("Sidecar response missing model_path")?;
    let predicted = resp
        .predicted
        .ok_or("Sidecar response missing predicted")?;
    let residual = resp
        .residual
        .ok_or("Sidecar response missing residual")?;
    if predicted.len() != n_rows || residual.len() != n_rows {
        return Err(format!(
            "Sidecar predicted/residual length mismatch (got {}/{} expected {})",
            predicted.len(),
            residual.len(),
            n_rows,
        ));
    }

    let feat_token = predictors.join("+");
    let out_dir = std::path::Path::new(&save_path).join("output").join(&target);
    std::fs::create_dir_all(&out_dir)
        .map_err(|e| format!("Failed to create output dir: {}", e))?;

    // ── REL_DATASET_*.csv ─────────────────────────────────────────────
    // Mirror wizard.py::_execute_relationship line 239:
    //   training_set.to_csv(f"{saved_path}/output/{target}/REL_DATASET_{features}_{target}.csv")
    // The file is the input matrix plus the model's predictions and
    // residuals on the same rows. PREDICTED and RESIDUAL arrive from the
    // sidecar already rounded to 3 decimals (`backend.py::train_relationship`).
    // Raw predictor + target values are written verbatim — pandas's
    // default `to_csv` also doesn't reformat numeric columns.
    {
        let fmt_f = |v: f64| format!("{}", v);
        let fmt_opt = |v: Option<f64>| -> String {
            match v {
                Some(n) if n.is_finite() => fmt_f(n),
                _ => String::new(),
            }
        };

        let mut csv = String::new();
        // `timestamp` is a hard-coded literal and safe, but the user-supplied
        // predictor + target names are not — escape them so a sensor named
        // `=cmd|...` doesn't run as a formula when the CSV is opened in
        // Excel. Numeric value cells use `format!("{}", f64)` which always
        // starts with a digit, `-`, or `inf`/`NaN` text — we leave those
        // unescaped so Excel still parses them as numbers.
        csv.push_str("timestamp");
        for p in &predictors {
            csv.push(',');
            csv.push_str(&excel_safe(p));
        }
        csv.push(',');
        csv.push_str(&excel_safe(&target));
        csv.push_str(",PREDICTED,RESIDUAL\n");

        for i in 0..n_rows {
            let ts = row_timestamps
                .get(i)
                .and_then(|t| t.as_deref())
                .unwrap_or("");
            // Timestamp is the only per-row string cell — escape to prevent
            // formula injection from a malformed-but-valid CSV input.
            csv.push_str(&excel_safe(ts));
            for v in &x_matrix[i] {
                csv.push(',');
                csv.push_str(&fmt_f(*v));
            }
            csv.push(',');
            csv.push_str(&fmt_f(y_vector[i]));
            csv.push(',');
            csv.push_str(&fmt_opt(predicted[i]));
            csv.push(',');
            csv.push_str(&fmt_opt(residual[i]));
            csv.push('\n');
        }

        let csv_path = out_dir.join(format!("REL_DATASET_{}_{}.csv", feat_token, target));
        std::fs::write(&csv_path, csv)
            .map_err(|e| format!("Failed to write {}: {}", csv_path.display(), e))?;
    }

    // Write the REL_INFO_*.json on the Rust side (parity with wizard.py).
    let resolved_name = model_name
        .as_deref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            let pred_str = predictors
                .iter()
                .map(|p| format!("({})", p))
                .collect::<Vec<_>>()
                .join(" + ");
            format!("{} -> ({})", pred_str, target)
        });

    let predictors_obj: serde_json::Map<String, serde_json::Value> = predictors
        .iter()
        .map(|p| (p.clone(), serde_json::Value::String(p.clone())))
        .collect();

    let now = chrono::Utc::now().to_rfc3339();
    let info_payload = serde_json::json!({
        "model_name": resolved_name,
        "model_composition": {
            "predictors": predictors_obj,
            "target": { target.clone(): target.clone() },
            "linearGAM_lambda": lambda
        },
        "model_training_set_info": {
            "publish_id": 0,
            "training_set_file_name": format!("{}/REL_DATASET_{}_{}.csv", target, feat_token, target),
            "training_set_start_date": time_bounds.0,
            "training_set_end_date": time_bounds.1,
            "training_set_comments": ""
        },
        "model_metrics": {
            "r2_score": r2,
            "2rmse": rmse2
        },
        "model_location": format!("{}/REL_MODEL_{}_{}.pkl", target, feat_token, target),
        "setpoint_health_score": {
            "residual_at_health_80_lower": serde_json::Value::Null,
            "residual_at_health_80_upper": serde_json::Value::Null,
            "residual_at_health_0_lower": serde_json::Value::Null,
            "residual_at_health_0_upper": serde_json::Value::Null
        },
        "model_update_record": [
            {
                "publish_id": 0,
                "updated_timestamp": now,
                "updated_by": "Wizard",
                "activity": "Wizard",
                "comments": ""
            }
        ]
    });

    let info_path = out_dir.join(format!("REL_INFO_{}_{}.json", feat_token, target));
    let info_text = serde_json::to_string_pretty(&info_payload)
        .map_err(|e| format!("JSON serialize failed: {}", e))?;
    std::fs::write(&info_path, info_text)
        .map_err(|e| format!("Failed to write {}: {}", info_path.display(), e))?;

    Ok(RelationshipTrainResult {
        model_path,
        r2,
        rmse2,
        n_rows,
        info_path: info_path.to_string_lossy().into_owned(),
    })
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

/// Canonical form of a sensor name for COLLISION / LOOKUP purposes: trimmed and
/// lower-cased. The frontend's `sameTag` is case-insensitive and merges
/// sensors by lowercase key, so Rust has to agree on what "the same name"
/// means or "Sum All" and "sum all" would be two columns here but one sensor
/// there.
fn name_key(name: &str) -> String {
    name.trim().to_lowercase()
}

/// First header equal to `name` ignoring case and surrounding whitespace.
fn find_column_ci(headers: &[String], name: &str) -> Option<usize> {
    let key = name_key(name);
    headers.iter().position(|h| name_key(h) == key)
}

/// Resolve a SOURCE sensor name (a `sensors[]` entry or a formula reference)
/// to a column: exact match first, then the trimmed/case-insensitive match.
/// Every reader (`validate_formula`, `evaluate_formula`,
/// `calculate_new_sensor`) goes through this so they can never disagree about
/// whether a sensor exists.
fn resolve_sensor(headers: &[String], name: &str) -> Option<usize> {
    headers
        .iter()
        .position(|h| h == name)
        .or_else(|| find_column_ci(headers, name))
}

/// Put a freshly computed column into the session under `name`; returns the
/// TRIMMED name that was actually stored (the caller must hand THAT to the
/// frontend, never the raw input).
///
/// Collision rules (all comparisons trimmed + case-insensitive):
/// * `replace == false` (create): the name must not exist at all — an
///   existing column of that name, raw OR derived, is an `Err`. (Appending a
///   second column used to be allowed, but every lookup in this file takes the
///   FIRST header match, so the new values were stored and never read — the
///   chart kept showing the old sensor's numbers.)
/// * `replace == true` (recompute after an edit/rename, and workspace-reopen
///   replay): a DERIVED column of that name is overwritten IN PLACE (position
///   kept, header takes the new casing); a RAW (imported) column of that name,
///   or the timestamp column, is an `Err` so a recompute can never overwrite
///   imported data; no match at all appends (a replay onto a freshly loaded
///   CSV where the special sensors don't exist yet).
///
/// Nothing is mutated unless this returns `Ok`.
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

/// Drop derived (special-sensor) columns by name — trimmed + case-insensitive.
/// Raw CSV columns and the timestamp column (`headers[0]`) are never removed:
/// a name that isn't a derived column is skipped silently. Returns how many
/// columns were actually removed.
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

/// Store a computed column under a SHORT write lock. The computation itself
/// ran under a read lock (it can take seconds on a big file — holding the
/// write lock for that long froze every chart query), so first confirm the
/// dataset is still the one the result was computed from.
fn commit_derived(
    state: &AppState,
    generation: u64,
    name: &str,
    col: Vec<f64>,
    replace: bool,
) -> Result<String, String> {
    let mut lock = state.0.write().map_err(|e| e.to_string())?;
    let session = lock.as_mut().ok_or("No data loaded")?;
    if session.generation != generation {
        return Err("The dataset changed while the sensor was being computed; please try again".to_string());
    }
    store_derived_column(&mut session.data, &mut session.derived, name, col, replace)
}

fn remove_derived_in_state(state: &AppState, names: &[String]) -> Result<usize, String> {
    let mut lock = state.0.write().map_err(|e| e.to_string())?;
    match lock.as_mut() {
        // Nothing loaded -> nothing to remove (a delete firing after the
        // session was reset must not surface as an error).
        None => Ok(0),
        Some(session) => Ok(remove_derived_columns(
            &mut session.data,
            &mut session.derived,
            names,
        )),
    }
}

/// Remove special-sensor columns from the in-memory session. Call it when the
/// user DELETES a special sensor and for the OLD name after a RENAME —
/// otherwise the stale column stays behind and shadows (or collides with) the
/// next sensor created under that name.
///
/// Only columns created by `calculate_new_sensor` / `evaluate_formula` in this
/// session are removed; matching is trimmed + case-insensitive. A name that is
/// unknown, a raw CSV column, or the timestamp column is skipped (not an
/// error). Returns the number of columns actually removed (0 if no dataset is
/// loaded).
#[tauri::command]
fn remove_sensor_columns(names: Vec<String>, state: State<AppState>) -> Result<usize, String> {
    remove_derived_in_state(&state, &names)
}

/// Pure core of `calculate_new_sensor`: validates and computes the column
/// without touching the session. Returns `(final trimmed name, column)`.
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
            let op_name = operation_registry::multi_op_name(&op.op_type)?;
            (Op::Multi(op), format!("{}({:?})", op_name, sensors))
        }
        _ => return Err("Invalid mode".to_string()),
    };

    let name = match config.custom_name.as_deref().map(str::trim) {
        Some(n) if !n.is_empty() => n.to_string(),
        _ => default_name.trim().to_string(),
    };

    // A recomputation must not read the column it is about to overwrite: it
    // would compute from the OLD values and then replace them, so the sensor
    // would drift a little further every time it was saved.
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
    let n = data.n_rows();
    let mut new_col: Vec<f64> = Vec::with_capacity(n);
    // Non-finite results (power/exp overflow, 0^-1, ...) become "missing":
    // `inf` stored in a column poisons every downstream stat and chart axis.
    let finite = |v: f64| if v.is_finite() { v } else { f64::NAN };

    match op {
        Op::Single(op) => {
            let f = operation_registry::single_op_fn(&op.op_type)?;
            for &v in data.columns[indices[0]].iter() {
                new_col.push(if v.is_nan() {
                    f64::NAN
                } else {
                    f(v, op.value).map(finite).unwrap_or(f64::NAN)
                });
            }
        }
        Op::Multi(op) => {
            let f = operation_registry::multi_op_fn(&op.op_type)?;
            let needs_all = operation_registry::multi_op_needs_all_inputs(&op.op_type);
            let src_cols: Vec<&[f64]> =
                indices.iter().map(|&i| data.columns[i].as_slice()).collect();
            let mut valid: Vec<f64> = Vec::with_capacity(src_cols.len());
            for r in 0..n {
                valid.clear();
                for col in &src_cols {
                    let v = col[r];
                    if !v.is_nan() {
                        valid.push(v);
                    }
                }
                // `sum` (needs_all): any missing source -> missing row, like
                // `evaluate_formula`. Other ops skip missing sources and use
                // what is left; an all-missing row stays missing.
                let skip = valid.is_empty() || (needs_all && valid.len() != src_cols.len());
                new_col.push(if skip {
                    f64::NAN
                } else {
                    f(&valid).map(finite).unwrap_or(f64::NAN)
                });
            }
        }
    }

    Ok((name, new_col))
}

#[tauri::command]
fn calculate_new_sensor(
    sensors: Vec<String>,
    config: SensorOperationConfig,
    replace: Option<bool>,
    state: State<AppState>,
) -> Result<String, String> {
    let replace = replace.unwrap_or(false);
    // Compute under a READ lock (other queries keep running), store under a
    // short write lock.
    let (generation, name, col) = {
        let lock = state.0.read().map_err(|e| e.to_string())?;
        let session = lock.as_ref().ok_or("No data loaded")?;
        let (name, col) = compute_operation_sensor(&session.data, &sensors, &config, replace)?;
        (session.generation, name, col)
    };
    commit_derived(&state, generation, &name, col, replace)
}

// ---------------------------------------------------------------------------
// Formula engine helpers
// ---------------------------------------------------------------------------

/// One `$Name` / `${Name}` occurrence in a formula, located by CHAR index
/// (`start..end`, end exclusive) so callers can rebuild the text around it
/// instead of doing a blind string replace (which corrupts a token that is a
/// prefix of a longer one: `$A` inside `$A.PV`).
struct SensorRefSpan {
    start: usize,
    end: usize,
    token: String,
    name: String,
}

/// The ONE tokenizer for sensor references — `extract_sensor_refs`,
/// `rewrite_sensor_ref` and `prepare_formula_for_eval` all build on it so they
/// can never disagree about where a name ends.
/// Supports two patterns:
///   - `$SensorName` — the name runs while chars are alphanumeric, `_` or `.`
///     (so `$Total-Power` is the sensor `Total` followed by `- Power`)
///   - `${Sensor Name With Spaces}` (anything up to the first `}`)
///
/// An unclosed `${` and an empty `${}` yield no reference.
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

/// Extract sensor references from a formula string.
/// Returns a Vec of (full_match_token, sensor_name) pairs, in order of
/// appearance. See [`scan_sensor_refs`] for the grammar.
fn extract_sensor_refs(formula: &str) -> Vec<(String, String)> {
    scan_sensor_refs(formula)
        .into_iter()
        .map(|s| (s.token, s.name))
        .collect()
}

/// Which sensors does each formula reference?
///
/// Exposed to the frontend so the "Special Sensors" management view can work
/// out what depends on what before allowing a delete. It deliberately reuses
/// `extract_sensor_refs` rather than reimplementing the scan in TypeScript:
/// the reference syntax has two forms (`$Name` and `${Name With Spaces}`) and
/// a second parser would drift from this one the moment either changes.
///
/// Substring matching is NOT a valid substitute on the frontend side — with
/// sensors named `test` and `test extend`, asking whether a formula "contains"
/// `test` answers yes for both.
///
/// Returns one de-duplicated list per input formula, in the same order.
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

/// Build the reference token for `name`: bare `$Name` ONLY when the name is
/// non-empty and made purely of alphanumerics and `_` — otherwise braced
/// `${name}`. The bare grammar stops at the first char that is not
/// alphanumeric / `_` / `.`, so a bare `Total-Power` re-parses as `$Total`
/// minus `Power` (wrong, or silently the wrong sensor if `Total` exists).
/// A `.` is braced too (it IS legal in the bare grammar, but braces are always
/// safe). The TypeScript twin `sensorRef()` in `useCalculationEngine.ts` must
/// follow the same rule by hand. A name containing `}` cannot be expressed
/// either way (the braced form ends at the first `}`).
fn sensor_ref_token(name: &str) -> String {
    if !name.is_empty() && name.chars().all(|c| c.is_alphanumeric() || c == '_') {
        format!("${}", name)
    } else {
        format!("${{{}}}", name)
    }
}

/// Rewrite every reference to `old_name` inside `formula` to point at
/// `new_name` instead, leaving everything else byte-for-byte unchanged.
///
/// This is what makes renaming a special sensor safe for every OTHER
/// formula that names it: walks the formula with the exact same tokenizer as
/// `extract_sensor_refs` rather than doing a blind string replace, because a
/// name can be a PREFIX of a longer one (`test` inside `test extend` via
/// `${test extend}`, or `test` inside `testA` via `$testA`) -- naively
/// replacing every literal occurrence of `$test` would also corrupt
/// `$testA`. Matching is trimmed + case-insensitive, same as every other tag
/// comparison in the app. A formula that doesn't reference `old_name` at all
/// comes back unchanged.
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

/// Rewrite every reference to `old_name` in a formula to `new_name` --
/// exposed to the frontend so the "Manage Special Sensors" rename flow can
/// carry a rename into every OTHER formula-kind recipe that names the
/// sensor. Reuses the same parser `extract_formula_refs` does rather than a
/// second, string-replace-based rewrite on the TypeScript side, for the same
/// reason that command exists: a name that's a prefix of a longer one would
/// silently corrupt the longer one.
#[tauri::command]
fn rename_formula_refs(formula: String, old_name: String, new_name: String) -> String {
    rewrite_sensor_ref(&formula, &old_name, &new_name)
}

/// Convert sensor references to fasteval-safe variable names.
/// Returns (transformed_expression, [(safe_name, original_sensor_name)]) with
/// ONE entry per distinct sensor name (the same name used twice shares a
/// variable).
///
/// The expression is rebuilt from the tokenizer's spans, NOT by
/// `expr.replace(token, ...)`: a string replace of `$11PT1214A` would also
/// chew the front of `$11PT1214A.PV` (a real pair of sensor names), turning
/// it into `__sensor_0.PV`.
///
/// `^` needs no rewriting -- fasteval parses it natively as its exponent
/// operator (`BinaryOp::EExp`).
fn prepare_formula_for_eval(formula: &str) -> (String, Vec<(String, String)>) {
    let chars: Vec<char> = formula.chars().collect();
    let mut expr = String::with_capacity(formula.len());
    let mut safe_names: Vec<(String, String)> = Vec::new();
    let mut pos = 0;

    for span in scan_sensor_refs(formula) {
        expr.extend(chars[pos..span.start].iter());
        let idx = match safe_names.iter().position(|(_, n)| *n == span.name) {
            Some(i) => i,
            None => {
                safe_names.push((format!("__sensor_{}", safe_names.len()), span.name.clone()));
                safe_names.len() - 1
            }
        };
        expr.push_str(&safe_names[idx].0);
        pos = span.end;
    }
    expr.extend(chars[pos..].iter());

    (expr, safe_names)
}

/// fasteval's own function set (`abs`/`log`/`round`/`min`/`max`/`ceil`/
/// `floor`/trig) doesn't include `sqrt`, `exp`, `log10`, or `pow` -- calling
/// any of those in a formula used to silently fail per-row (the eval
/// namespace only resolved sensor variables, so an unknown function name
/// made every row NAN with no error surfaced to the user, even though the
/// "Formula Syntax Help" panel advertised all four as supported). Handled
/// here via fasteval's custom-function namespace callback instead of
/// pre-rewriting the formula text, since `pow`'s two arguments can be
/// arbitrary sub-expressions that a naive string rewrite can't safely
/// re-bracket.
fn eval_extra_math_fn(name: &str, args: &[f64]) -> Option<f64> {
    match (name, args) {
        ("sqrt", [x]) => Some(x.sqrt()),
        ("exp", [x]) => Some(x.exp()),
        ("log10", [x]) => Some(x.log10()),
        ("pow", [x, y]) => Some(x.powf(*y)),
        _ => None,
    }
}

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
            multi_op: Some(MultiOperation { op_type: op.into() }),
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

    // ── store_derived_column: create ─────────────────────────────────

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

    // ── store_derived_column: replace ────────────────────────────────

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

    // ── the user's bug: delete then recreate ─────────────────────────

    /// Reproduces "special sensor values don't match": create X, delete X in
    /// the UI, create a NEW X with a different formula. Before the fix a
    /// second column named X was appended and every lookup (FIRST match) read
    /// the old deleted sensor's numbers.
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

    // ── remove_derived_columns ───────────────────────────────────────

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

    // ── session-level wrappers ───────────────────────────────────────

    fn app_state(generation: u64) -> AppState {
        AppState(RwLock::new(Some(SessionData {
            data: dataset(),
            paths: vec![],
            derived: HashSet::new(),
            generation,
        })))
    }

    #[test]
    fn commit_derived_refuses_a_result_computed_from_a_replaced_dataset() {
        let state = app_state(5);
        let err = commit_derived(&state, 4, "X", vec![1.0; 3], false).unwrap_err();
        assert!(err.contains("changed"), "{err}");
        assert_eq!(state.0.read().unwrap().as_ref().unwrap().data.headers.len(), 3);
        assert_eq!(commit_derived(&state, 5, "X", vec![1.0; 3], false).unwrap(), "X");
    }

    #[test]
    fn commit_and_remove_through_the_session() {
        let state = app_state(1);
        commit_derived(&state, 1, "X", vec![1.0; 3], false).unwrap();
        assert!(commit_derived(&state, 1, "x", vec![2.0; 3], false).is_err());
        assert_eq!(remove_derived_in_state(&state, &strs(&["X", "A"])).unwrap(), 1);
        assert_eq!(state.0.read().unwrap().as_ref().unwrap().data.headers, vec!["timestamp", "A", "B"]);
    }

    #[test]
    fn with_no_dataset_remove_is_a_noop_and_commit_errors() {
        let state = AppState(RwLock::new(None));
        assert_eq!(remove_derived_in_state(&state, &strs(&["X"])).unwrap(), 0);
        assert!(commit_derived(&state, 1, "X", vec![], false).is_err());
    }

    // ── resolve_sensor ───────────────────────────────────────────────

    #[test]
    fn resolve_prefers_an_exact_match_then_falls_back_to_trimmed_case_insensitive() {
        let headers = strs(&["timestamp", "a", "A", "Tag B"]);
        assert_eq!(resolve_sensor(&headers, "A"), Some(2), "exact wins over an earlier case-variant");
        assert_eq!(resolve_sensor(&headers, "a"), Some(1));
        assert_eq!(resolve_sensor(&headers, " tag b "), Some(3));
        assert_eq!(resolve_sensor(&headers, "zzz"), None);
    }

    // ── compute_operation_sensor ─────────────────────────────────────

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

    // ── multi-op NaN semantics (decided 2026-10-03) ──────────────────

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

    // ── compute_formula_sensor ───────────────────────────────────────

    #[test]
    fn formula_computes_and_a_missing_input_gives_a_missing_row() {
        let data = dataset_with(&["A", "B"], vec![vec![1.0, NAN, 3.0], vec![10.0, 20.0, 30.0]]);
        let (name, col) = compute_formula_sensor(&data, "$A + $B", Some(" Total "), false).unwrap();
        assert_eq!(name, "Total");
        assert!(same(&col, &[11.0, NAN, 33.0]), "{col:?}");
    }

    /// `$11PT1214A` is a textual prefix of `$11PT1214A.PV`; a string replace
    /// of the shorter token used to mangle the longer one.
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

    // ── sensor_ref_token / tokenizer round trips ─────────────────────

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

    // ── prepare_formula_for_eval ─────────────────────────────────────

    #[test]
    fn prepare_rebuilds_the_expression_from_spans_not_string_replace() {
        let (expr, names) = prepare_formula_for_eval("$A + $A.PV * ${x y} - $A");
        assert_eq!(expr, "__sensor_0 + __sensor_1 * __sensor_2 - __sensor_0");
        assert_eq!(
            names,
            vec![
                ("__sensor_0".to_string(), "A".to_string()),
                ("__sensor_1".to_string(), "A.PV".to_string()),
                ("__sensor_2".to_string(), "x y".to_string()),
            ]
        );
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

    /// The whole reason this command exists rather than a substring check on
    /// the frontend: one sensor name can be a prefix of another. Asking
    /// whether the formula "contains" `test` would answer yes for both of
    /// these, which would wrongly mark `test` as depended-upon and block its
    /// deletion forever.
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

    /// The whole reason this walks the formula with the same tokenizer as
    /// `extract_sensor_refs` instead of a naive string replace -- "$test" is
    /// a literal substring of "$testA", so `.replace("$test", ...)` would
    /// corrupt it too.
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
        // Formerly the eval namespace only resolved sensor variables, so
        // these names fell through to `None` and silently produced NaN for
        // every row -- same must-not-panic contract applies to bad arities.
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
}

/// Bound on formula source length + brace/paren nesting depth — a cheap
/// DoS guard so a pathological string can't make `fasteval::Parser`
/// allocate unbounded stack/Slab. Real formulas top out around a few
/// hundred chars; 4 KB / 64 levels is an enormous headroom.
const MAX_FORMULA_LEN: usize = 4096;
const MAX_FORMULA_DEPTH: i32 = 64;

fn check_formula_limits(formula: &str) -> Result<(), String> {
    if formula.len() > MAX_FORMULA_LEN {
        return Err(format!(
            "Formula too long ({} chars, max {})",
            formula.len(),
            MAX_FORMULA_LEN
        ));
    }
    let mut depth: i32 = 0;
    let mut max_depth: i32 = 0;
    for c in formula.chars() {
        match c {
            '(' | '{' => {
                depth += 1;
                if depth > max_depth {
                    max_depth = depth;
                }
            }
            ')' | '}' => {
                depth -= 1;
            }
            _ => {}
        }
    }
    if max_depth > MAX_FORMULA_DEPTH {
        return Err(format!(
            "Formula too deeply nested ({} levels, max {})",
            max_depth, MAX_FORMULA_DEPTH
        ));
    }
    Ok(())
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
    fn tracks_depth_as_a_running_max_not_a_final_balance() {
        // Deeply nested then fully closed: max_depth was breached even
        // though the formula ends balanced at depth 0.
        let mut formula = "(".repeat(MAX_FORMULA_DEPTH as usize + 1);
        formula.push_str(&")".repeat(MAX_FORMULA_DEPTH as usize + 1));
        assert!(check_formula_limits(&formula).is_err());
    }
}

#[tauri::command]
fn validate_formula(
    formula: String,
    state: State<AppState>,
) -> Result<FormulaValidationResult, String> {
    check_formula_limits(&formula)?;

    let state_lock = state.0.read().map_err(|e| e.to_string())?;
    let session = state_lock.as_ref().ok_or("No data loaded")?;
    let data = &session.data;

    // 1. Extract sensor references (distinct, in order of appearance)
    let sensor_refs = extract_sensor_refs(&formula);
    let mut referenced_sensors: Vec<String> = Vec::new();
    for (_, name) in &sensor_refs {
        if !referenced_sensors.contains(name) {
            referenced_sensors.push(name.clone());
        }
    }

    // 2. Check all referenced sensors exist in loaded data — through the same
    //    resolver `evaluate_formula` uses, so "valid" here means "will run".
    for sensor_name in &referenced_sensors {
        if resolve_sensor(&data.headers, sensor_name).is_none() {
            return Ok(FormulaValidationResult {
                valid: false,
                error: Some(format!("Sensor not found: {}", sensor_name)),
                referenced_sensors,
            });
        }
    }

    // 3. Try to parse the expression (with dummy values)
    let (expr, safe_names) = prepare_formula_for_eval(&formula);

    let parser = fasteval::Parser::new();
    let mut slab = fasteval::Slab::new();

    match parser.parse(&expr, &mut slab.ps) {
        Ok(expr_i) => {
            // Try to evaluate with dummy values to catch runtime issues
            let mut ns = |name: &str, args: Vec<f64>| -> Option<f64> {
                for (safe_name, _) in &safe_names {
                    if name == safe_name {
                        return Some(1.0); // dummy value
                    }
                }
                eval_extra_math_fn(name, &args)
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

/// Pure core of `evaluate_formula`: validates and evaluates without touching
/// the session. Returns `(final trimmed name, column)`; a row with ANY missing
/// (NaN) input, or a non-finite / failed evaluation, is NaN.
fn compute_formula_sensor(
    data: &ColumnarData,
    formula: &str,
    custom_name: Option<&str>,
    replace: bool,
) -> Result<(String, Vec<f64>), String> {
    check_formula_limits(formula)?;

    // 1. Extract sensor references from formula
    if extract_sensor_refs(formula).is_empty() {
        return Err("Formula contains no sensor references. Use $SensorName or ${Sensor Name} syntax.".to_string());
    }

    // 2. Rewrite to fasteval-safe variables and resolve every distinct sensor
    //    to a column (all of them must exist).
    let (expr, safe_names) = prepare_formula_for_eval(formula);
    let mut safe_name_to_idx: Vec<(&str, usize)> = Vec::with_capacity(safe_names.len());
    for (safe_name, original_name) in &safe_names {
        let idx = resolve_sensor(&data.headers, original_name)
            .ok_or_else(|| format!("Sensor not found: {}", original_name))?;
        safe_name_to_idx.push((safe_name.as_str(), idx));
    }

    // 3. Final name + collision rules.
    let name = match custom_name.map(str::trim) {
        Some(n) if !n.is_empty() => n.to_string(),
        _ => format!("f({})", formula.trim()),
    };
    // A recomputation must not read the column it is about to overwrite —
    // `$self + 1` would otherwise creep upward by one every time the formula
    // was saved.
    if replace {
        if let Some(target) = find_column_ci(&data.headers, &name) {
            if safe_name_to_idx.iter().any(|(_, idx)| *idx == target) {
                return Err(format!("'{}' cannot be built from itself", name));
            }
        }
    } else if find_column_ci(&data.headers, &name).is_some() {
        // Fail fast, before the (possibly long) evaluation.
        return Err(format!("A sensor named '{}' already exists", name));
    }

    // 4. Pre-compile the expression once
    let parser = fasteval::Parser::new();
    let mut slab = fasteval::Slab::new();
    let expr_i = parser
        .parse(&expr, &mut slab.ps)
        .map_err(|e| format!("Formula parse error: {}", e))?;

    // 5. Evaluate for each row (NaN in `new_col` = missing result)
    let n = data.n_rows();
    let mut new_col: Vec<f64> = Vec::with_capacity(n);
    let var_names: Vec<&str> = safe_name_to_idx.iter().map(|(s, _)| *s).collect();
    let src_cols: Vec<&[f64]> = safe_name_to_idx
        .iter()
        .map(|(_, idx)| data.columns[*idx].as_slice())
        .collect();
    let mut row_values: Vec<f64> = vec![0.0; src_cols.len()];

    for r in 0..n {
        // A missing (NaN) input on any referenced sensor → missing result.
        if src_cols.iter().any(|col| col[r].is_nan()) {
            new_col.push(f64::NAN);
            continue;
        }
        for (j, col) in src_cols.iter().enumerate() {
            row_values[j] = col[r];
        }

        let mut ns = |var: &str, args: Vec<f64>| -> Option<f64> {
            match var_names.iter().position(|s| *s == var) {
                Some(j) => Some(row_values[j]),
                None => eval_extra_math_fn(var, &args),
            }
        };

        let expr_ref = slab.ps.get_expr(expr_i);
        match expr_ref.eval(&slab, &mut ns) {
            Ok(result) if result.is_finite() => new_col.push(result),
            // NaN / Infinity / eval error → missing
            _ => new_col.push(f64::NAN),
        }
    }

    Ok((name, new_col))
}

#[tauri::command]
fn evaluate_formula(
    formula: String,
    custom_name: Option<String>,
    replace: Option<bool>,
    state: State<AppState>,
) -> Result<String, String> {
    check_formula_limits(&formula)?;
    let replace = replace.unwrap_or(false);

    // Evaluate under a READ lock, store under a short write lock (see
    // `commit_derived`).
    let (generation, name, col) = {
        let lock = state.0.read().map_err(|e| e.to_string())?;
        let session = lock.as_ref().ok_or("No data loaded")?;
        let (name, col) =
            compute_formula_sensor(&session.data, &formula, custom_name.as_deref(), replace)?;
        (session.generation, name, col)
    };
    commit_derived(&state, generation, &name, col, replace)
}

#[tauri::command]
fn load_mapping_csv(path: String) -> Result<MappingData, String> {
    validate_read_path(&path).map_err(|e| format!("invalid path '{}': {}", path, e))?;
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
    /// Passed straight through to `PreviewFilter.combine` below. `get_chart_data`
    /// is shared by Dashboard's own multi-sensor chart (whose JS-side filter
    /// object never sets this, so it stays "and") AND the Build Model page's
    /// own target-sensor preview chart (whose `dashboardFilterPayload` does
    /// set it, matching whatever the Running Condition Filter in effect for
    /// that model uses) — Rust can't tell those two callers apart, so this
    /// type has to accept the field faithfully rather than hardcoding it.
    #[serde(default)]
    combine: Option<String>,
    /// Multiple training periods — passed straight through to
    /// `PreviewFilter.timestamp_ranges` (the PM target chart uses this type).
    #[serde(default)]
    timestamp_ranges: Vec<TimeRangeArg>,
}

impl DataFilter {
    /// Bridge to the `PreviewFilter` shape so `get_filtered_data` and
    /// `get_scatter_sample` share `ResolvedFilter` with every other
    /// data-reading command (identical gate semantics, one implementation).
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

/// Bounded chart payload for the dashboard line chart.
///
/// The full pipeline (dashboard filter → operation transform → optional
/// hourly aggregation → min/max decimation to `max_points`) runs Rust-side
/// over the columnar store; the WebView receives O(max_points) columnar
/// arrays instead of the entire dataset. Replaces the dashboard's use of
/// the old full-stream `get_filtered_data` command, which duplicated the
/// whole dataset into the JS heap and froze the UI on large CSVs.
// `rename_all = "snake_case"`: the frontend sends `max_points` verbatim
// (same convention as `get_scatter_sample`).
#[tauri::command(rename_all = "snake_case")]
fn get_chart_data(
    filter: DataFilter,
    sampling: String,
    operation: Option<chart_query::OperationConfig>,
    max_points: usize,
    state: State<AppState>,
) -> Result<chart_query::ChartView, String> {
    let state_lock = state.0.read().map_err(|e| e.to_string())?;
    let session = state_lock.as_ref().ok_or("No data loaded")?;
    chart_query::build_chart_view(
        &session.data,
        &filter,
        operation.as_ref(),
        &sampling,
        max_points,
    )
}

/// True first/last timestamp across the WHOLE loaded dataset, ignoring any
/// dashboard time filter — see `chart_query::full_dataset_time_bounds`'s
/// docstring for why `ChartView::ts_min`/`ts_max` can't serve this. Powers
/// the Dashboard's "data available" label and the anchor point for the
/// relative-range (Y/M/W/D/H) buttons.
#[derive(Debug, Serialize)]
struct DatasetTimeBounds {
    min: Option<String>,
    max: Option<String>,
}

#[tauri::command]
fn get_dataset_time_bounds(state: State<AppState>) -> Result<DatasetTimeBounds, String> {
    let state_lock = state.0.read().map_err(|e| e.to_string())?;
    let session = state_lock.as_ref().ok_or("No data loaded")?;
    let (min, max) = chart_query::full_dataset_time_bounds(&session.data);
    Ok(DatasetTimeBounds { min, max })
}

/// Tiny dependency-free PRNG (xorshift64*) used to drive reservoir sampling.
/// Seeded with a fixed constant so the same dataset + filter yields the SAME
/// sample on every call — important so the scatter doesn't visibly reshuffle
/// when the chart refetches (e.g. after a workspace reopen).
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

/// Bounded sample of the (filtered) dataset for scatter / pair-plot rendering.
/// `rows.len()` never exceeds the requested `max_points`, so the IPC payload,
/// the JS heap, and the WebGL vertex buffers all stay bounded no matter how
/// large the underlying dataset is (the whole point: a 2 GB CSV must not blow
/// up the renderer or the GPU).
#[derive(serde::Serialize)]
struct ScatterSample {
    /// Resolved sensor names, in the SAME column order as each row's `values`.
    /// Only sensors that actually exist in the dataset are included, so
    /// `headers.len() == rows[i].values.len()` always holds.
    headers: Vec<String>,
    rows: Vec<CsvRecord>,
    /// Total rows that passed the filter (the population we sampled from).
    total: usize,
    /// Number of rows actually returned (`== rows.len()`, `<= max_points`).
    sampled: usize,
}

/// Return a uniform random sample of at most `max_points` rows from the
/// in-memory dataset, projected to the requested sensors and respecting the
/// dashboard's timestamp / value filters.
///
/// Uses single-pass reservoir sampling (Algorithm R): O(n) time over the
/// rows, O(max_points) memory, one timestamp parse per row at most (skipped
/// entirely when no filter is active — the common "just loaded, hit Scatter"
/// path). A row is only cloned/projected when it's actually kept, so huge
/// datasets don't pay an allocation per row.
// `rename_all = "snake_case"` is REQUIRED here: the frontend sends
// `max_points` verbatim, but without the attribute the macro expects the
// camelCased key `maxPoints` and every invoke fails with "missing required
// key" before the command body ever runs.
#[tauri::command(rename_all = "snake_case")]
fn get_scatter_sample(
    filter: DataFilter,
    max_points: usize,
    state: State<AppState>,
) -> Result<ScatterSample, String> {
    let state_lock = state.0.read().map_err(|e| e.to_string())?;
    let session = state_lock.as_ref().ok_or("No data loaded")?;
    sample_dataset(&session.data, &filter, max_points)
}

/// Pure core of [`get_scatter_sample`] (no Tauri state) so it's unit-testable.
/// Reservoir-samples up to `max_points` rows from `data`, projected to
/// `filter.sensors` and respecting the timestamp / value filters.
fn sample_dataset(
    data: &ColumnarData,
    filter: &DataFilter,
    max_points: usize,
) -> Result<ScatterSample, String> {
    // Clamp to a sane band: at least 1, and a hard ceiling so a bad caller
    // can't ask for a 100M-row "sample" and reintroduce the OOM we're fixing.
    let cap = max_points.clamp(1, 2_000_000);

    // Resolve requested sensors → column indices. Drop any that don't exist
    // and keep `resolved_headers` aligned with `sensor_indices` so the
    // returned headers always match the projected value columns 1:1.
    let mut sensor_indices: Vec<usize> = Vec::new();
    let mut resolved_headers: Vec<String> = Vec::new();
    for s in &filter.sensors {
        if let Some(idx) = data.headers.iter().position(|h| h == s) {
            sensor_indices.push(idx);
            resolved_headers.push(s.clone());
        }
    }

    // Same gate semantics as get_filtered_data — one shared implementation,
    // comparing load-time-parsed timestamps (no per-row parsing).
    let preview = filter.to_preview();
    let resolved = ResolvedFilter::resolve(Some(&preview), &data.headers)?;

    // The reservoir holds ROW INDICES; rows are materialized to the wire
    // shape only once at the end, so evicted candidates never pay a
    // projection/clone.
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
}

/// Resolve (and create) the persistent error-log location:
/// `<app-log-dir>/frontend-errors.log` — `%LOCALAPPDATA%/<identifier>/logs`
/// on Windows. Lives outside the install dir so it never needs elevated
/// writes and survives reinstalls.
fn error_log_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("cannot resolve app log dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create log dir {dir:?}: {e}"))?;
    Ok(dir.join("frontend-errors.log"))
}

/// Best-effort append — the error logger must never become an error source
/// itself, so every failure here is deliberately swallowed.
fn append_error_line(path: &std::path::Path, source: &str, message: &str, detail: Option<&str>) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let _ = writeln!(f, "[{ts}] [{source}] {message}");
        if let Some(d) = detail {
            if !d.trim().is_empty() {
                let _ = writeln!(f, "{d}");
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
            // Persist Rust panics to the same error log the frontend reporter
            // writes to — an installed build has no console, so without this a
            // panicked command/thread vanishes without a trace.
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
            // Native decorations are OFF everywhere except macOS, because the
            // frontend draws its own titlebar (see TitleBar.tsx — it renders
            // custom window buttons whenever the platform isn't macOS).
            //
            // Windows gets this from `tauri.windows.conf.json`, which Tauri
            // merges over `tauri.conf.json` at build/dev time. Setting it there
            // rather than stripping decorations here means the window is BORN
            // undecorated — a runtime strip can't help but create the window
            // with a native frame first, risking a visible flash before the
            // call lands.
            //
            // macOS deliberately keeps `decorations: true` (base config) so the
            // native traffic lights still exist — without them, and with the
            // custom buttons suppressed on macOS, the window would have no
            // close/minimise affordance at all.
            //
            // Linux has no platform config file of its own, so it still needs
            // the runtime strip to match the custom titlebar.
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
            get_loaded_paths,
            calculate_new_sensor,
            remove_sensor_columns,
            load_mapping_csv,
            apply_sensor_mapping,
            get_chart_data,
            get_dataset_time_bounds,
            evaluate_formula,
            validate_formula,
            extract_formula_refs,
            rename_formula_refs,
            train_individual_model,
            compute_clustering_preview,
            train_clustering_model,
            train_relationship_model,
            write_user_file,
            get_scatter_sample,
            log_frontend_error,
            get_error_log_path
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // Exit the app when the last *visible* webview window is destroyed.
        // Overrides Tauri's default "stay alive on macOS after all windows
        // close" — otherwise closing every window leaves the process running
        // with no UI but a phantom macOS menu bar, which the user has no way
        // to recover from short of Cmd+Q.
        //
        // The visibility filter handles the recent-workspace-navigation case:
        // when the user clicks a Recent Workspace whose `lastRoute` is
        // `failure-group` / `predictive-model`, the main window calls
        // `Window.destroy()` immediately after spawning the sub-window. If
        // that destroy races a re-mount and the manager-map entry lingers as
        // a hidden window, the visibility filter ignores it so the app still
        // exits when the sub-window closes.
        //
        // Belt-and-suspenders: if `app_handle.exit(0)` doesn't terminate the
        // process within 500 ms (it sometimes hangs on the cocoa runloop
        // after the last window is gone), force-kill with `std::process::exit(0)`.
        .run(|app_handle, event| {
            use tauri::Manager;
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
                        std::process::exit(0);
                    });
                }
            }
        });
}
