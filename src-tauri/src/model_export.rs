//! "Mark complete" -> write the model files.
//!
//! `export_model_files` runs the existing `train_*` writers, but never straight
//! into the user-visible output folder: everything is written into a private
//! staging directory first and only moved into place once every step has
//! succeeded, so a failure (validation, sidecar crash, disk error) leaves NO
//! partial set of files behind and a previous export stays intact. Re-exporting
//! the same model overwrites its files (same names).
//!
//! Output location (user decision, no folder picker): an app-managed folder
//! `{app_data}/workspaces/{workspace_id}/output/`, files under
//! `output/{target}/...` exactly as the `train_*` commands lay them out (they
//! are handed `{app_data}/workspaces/{workspace_id}` — or the staging dir — as
//! their `save_path`).
//!
//! Known limitation (no manifest is kept): re-exporting a Relationship model
//! with a DIFFERENT predictor list writes new file names (the predictors are
//! part of them) and leaves the previous predictors' files in place.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::csv_processor::ColumnarData;
use crate::health_score::{Issue, SetPointsArg};
use crate::{ClusterRange, PreviewFilter};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Failure of a file-writing core: either the set points failed validation
/// (nothing was written; the issues say why) or something else went wrong.
#[derive(Debug)]
pub enum CoreError {
    Validation(Vec<Issue>),
    Other(String),
}

impl From<String> for CoreError {
    fn from(s: String) -> Self {
        CoreError::Other(s)
    }
}

impl From<&str> for CoreError {
    fn from(s: &str) -> Self {
        CoreError::Other(s.to_string())
    }
}

impl CoreError {
    /// Flatten for the plain-`String` error channel of the direct `train_*`
    /// commands: `VALIDATION: msg1; msg2`.
    pub fn into_string(self) -> String {
        match self {
            CoreError::Other(s) => s,
            CoreError::Validation(v) => format!(
                "VALIDATION: {}",
                v.iter().map(|i| i.message.as_str()).collect::<Vec<_>>().join("; ")
            ),
        }
    }
}

// ---------------------------------------------------------------------------
// Request / response
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ModelFilesRequest {
    /// `"individual"` | `"relationship"` | `"clustering"`.
    pub kind: String,
    /// Names the output folder (`{app_data}/workspaces/{workspace_id}/output`).
    pub workspace_id: String,
    #[serde(default)]
    pub model_name: Option<String>,
    /// Individual / Relationship target sensor.
    #[serde(default)]
    pub target: Option<String>,
    /// Relationship predictors.
    #[serde(default)]
    pub predictors: Vec<String>,
    /// Relationship stiffness as the LinearGAM lambda (required for it).
    #[serde(default)]
    pub lambda: Option<f64>,
    /// Clustering X / Y sensors.
    #[serde(default)]
    pub first_sensor: Option<String>,
    #[serde(default)]
    pub second_sensor: Option<String>,
    #[serde(default)]
    pub n_clusters: Option<u32>,
    #[serde(default)]
    pub criteria_sensor: Option<String>,
    #[serde(default)]
    pub cluster_ranges: Option<Vec<ClusterRange>>,
    /// The training scope (Running condition + periods).
    #[serde(default)]
    pub filter: Option<PreviewFilter>,
    /// The model's `healthSetPoints`. Missing/empty = refused (`required`).
    #[serde(default)]
    pub set_points: Option<SetPointsArg>,
    /// Relationship only: the fit's cache key. When the fit is cached its 2RMSE
    /// is used to validate the set points BEFORE the ~15 s sidecar run.
    #[serde(default)]
    pub cache_key: Option<String>,
    #[serde(default, alias = "expectedGeneration")]
    pub expected_generation: Option<u64>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct WrittenFile {
    /// `"info"` (`*_INFO_*.json`) | `"model"` (`.pkl`) | `"dataset"` (`.csv`).
    pub kind: &'static str,
    pub file_name: String,
    /// Absolute path of the file in the final output folder.
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct ModelFilesResult {
    /// `false` = the set points failed validation: NOTHING was written and
    /// `validation` says why. Hard failures (sidecar, disk) are `Err` instead.
    pub ok: bool,
    pub files: Vec<WrittenFile>,
    /// `{app_data}/workspaces/{workspace_id}/output` (what the UI can reveal).
    pub output_dir: String,
    pub validation: Vec<Issue>,
    pub warnings: Vec<String>,
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

pub struct WorkspaceDirs {
    /// `{app_data}/workspaces/{workspace_id}` — handed to the writers as
    /// `save_path` (via a staging child of it).
    pub ws_dir: PathBuf,
    /// `{ws_dir}/output` — what the user is told about.
    pub output_dir: PathBuf,
}

/// A workspace id becomes a directory name, so it gets the strict filename
/// check plus the Windows pitfalls (leading/trailing space, trailing dot).
pub fn sanitize_workspace_id(id: &str) -> Result<String, String> {
    let s = crate::sanitize_filename_component(id).map_err(|e| format!("workspace_id: {e}"))?;
    if s != s.trim() || s.ends_with('.') {
        return Err(format!("workspace_id: invalid name: {s}"));
    }
    Ok(s)
}

/// `{app_data}/workspaces/{id}/output` WITHOUT creating anything (id checked).
pub fn output_dir_path(app_data: &Path, workspace_id: &str) -> Result<PathBuf, String> {
    let id = sanitize_workspace_id(workspace_id)?;
    Ok(app_data.join("workspaces").join(id).join("output"))
}

/// Resolve (and create) `{app_data}/workspaces/{id}/output`.
pub fn prepare_workspace(app_data: &Path, workspace_id: &str) -> Result<WorkspaceDirs, String> {
    let id = sanitize_workspace_id(workspace_id)?;
    let ws_dir = app_data.join("workspaces").join(id);
    let output_dir = ws_dir.join("output");
    std::fs::create_dir_all(&output_dir)
        .map_err(|e| format!("Failed to create output dir {}: {e}", output_dir.display()))?;
    Ok(WorkspaceDirs { ws_dir, output_dir })
}

// ---------------------------------------------------------------------------
// Sensor names as file names
// ---------------------------------------------------------------------------

/// Longest file / folder name the export will create (bytes; NTFS allows 255
/// UTF-16 units, ext4 255 bytes — the stricter of the two).
pub const MAX_FILE_NAME_BYTES: usize = 255;

/// Short, safe-to-show form of a (possibly hostile) name for messages.
fn shown(name: &str) -> String {
    let escaped: String = name
        .chars()
        .take(40)
        .flat_map(|c| {
            if c.is_control() {
                c.escape_default().collect::<Vec<_>>()
            } else {
                vec![c]
            }
        })
        .collect();
    if name.chars().count() > 40 {
        format!("{escaped}...")
    } else {
        escaped
    }
}

/// Why `name` cannot be used as ONE path component (the sensor becomes a
/// folder name and part of the file names), `None` when it is fine. Stricter
/// than `sanitize_filename_component` (the path-traversal guard the writers
/// keep): it also covers what only fails later as a raw OS error — Windows
/// reserved device names, leading / trailing space, trailing dot, over-long
/// names.
pub fn file_name_problem(name: &str) -> Option<String> {
    if name.is_empty() {
        return Some("it is empty".into());
    }
    if name == "." || name == ".." {
        return Some("it is a reserved name".into());
    }
    if let Some(c) = name
        .chars()
        .find(|c| ['/', '\\', ':', '*', '?', '"', '<', '>', '|'].contains(c) || c.is_control())
    {
        let c = if c.is_control() { c.escape_default().to_string() } else { c.to_string() };
        return Some(format!("it contains the character {c}"));
    }
    if name != name.trim() {
        return Some("it starts or ends with a space".into());
    }
    if name.ends_with('.') {
        return Some("it ends with a dot".into());
    }
    let stem = name.split('.').next().unwrap_or(name).trim_end().to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0');
    if reserved {
        return Some("it is a reserved Windows device name".into());
    }
    if name.len() > MAX_FILE_NAME_BYTES {
        return Some(format!("it is too long ({} bytes, max {MAX_FILE_NAME_BYTES})", name.len()));
    }
    None
}

/// `(field, name)` pairs whose values end up in the files of this model:
/// Individual `target`; Clustering `first_sensor` / `second_sensor`;
/// Relationship `target` + every predictor.
fn exported_names(req: &ModelFilesRequest) -> Vec<(&'static str, &str)> {
    match req.kind.as_str() {
        "individual" => req.target.as_deref().map(|t| ("target", t)).into_iter().collect(),
        "clustering" => req
            .first_sensor
            .as_deref()
            .map(|t| ("first_sensor", t))
            .into_iter()
            .chain(req.second_sensor.as_deref().map(|t| ("second_sensor", t)))
            .collect(),
        "relationship" => req
            .target
            .as_deref()
            .map(|t| ("target", t))
            .into_iter()
            .chain(req.predictors.iter().map(|p| ("predictor", p.as_str())))
            .collect(),
        _ => Vec::new(),
    }
}

/// Every composed file name this request would create, for the length check.
fn composed_file_names(req: &ModelFilesRequest) -> Vec<String> {
    let s = |o: &Option<String>| o.clone().unwrap_or_default();
    match req.kind.as_str() {
        "individual" => vec![format!("INDV_INFO_{}.json", s(&req.target))],
        "clustering" => vec![format!(
            "CLUS_INFO_{}_{}.json",
            s(&req.first_sensor),
            s(&req.second_sensor)
        )],
        "relationship" => {
            let tok = req.predictors.join("+");
            [("REL_DATASET", "csv"), ("REL_INFO", "json"), ("REL_MODEL", "pkl")]
                .iter()
                .map(|(p, ext)| format!("{p}_{tok}_{}.{ext}", s(&req.target)))
                .collect()
        }
        _ => Vec::new(),
    }
}

/// Refuse, with a clean `BAD_REQUEST: ...` error and BEFORE anything touches
/// the disk, a request whose sensor names (or workspace id) cannot become safe
/// file names. Replaces the earlier mix of uncoded messages and raw OS errors.
pub fn check_export_names(req: &ModelFilesRequest) -> Result<(), String> {
    sanitize_workspace_id(&req.workspace_id).map_err(|e| format!("BAD_REQUEST: {e}"))?;
    for (field, name) in exported_names(req) {
        if let Some(why) = file_name_problem(name) {
            return Err(format!(
                "BAD_REQUEST: the {field} name '{}' cannot be used in a file name: {why}",
                shown(name)
            ));
        }
    }
    for f in composed_file_names(req) {
        if f.len() > MAX_FILE_NAME_BYTES {
            return Err(format!(
                "BAD_REQUEST: the file name '{}' would be {} bytes long (max {MAX_FILE_NAME_BYTES}); \
                 use fewer or shorter predictor names",
                shown(&f),
                f.len()
            ));
        }
    }
    Ok(())
}

/// Preview-side twin of [`check_export_names`]: one non-blocking
/// `unsafe_file_name` WARNING per name that "Mark complete" would refuse, so
/// the page can say so while the user is still looking at the model (the
/// preview itself works for any sensor name).
pub fn unsafe_name_warnings(names: &[(&str, &str)]) -> Vec<Issue> {
    names
        .iter()
        .filter_map(|(field, name)| {
            file_name_problem(name).map(|why| Issue {
                code: "unsafe_file_name".into(),
                severity: crate::health_score::Severity::Warning,
                message: format!(
                    "The {field} name '{}' cannot be used in a file name ({why}), so Mark complete \
                     will be refused for this model.",
                    shown(name)
                ),
                field: (*field).to_string(),
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Overwriting another model's file
// ---------------------------------------------------------------------------

/// File names are derived from sensor names only, so two DIFFERENT models can
/// map to the same file: a Relationship with the single predictor `A+B` and
/// the one with predictors `[A, B]`, or two Clustering models with the same X/Y
/// but different criteria. Changing the established names would break existing
/// workspaces (and the sidecar names the `.pkl` itself), so the export keeps
/// them and instead WARNS when the file it is about to replace was written for
/// a different configuration. (Re-exporting after editing the same model's
/// criteria sensor / cluster count also triggers it — the export cannot tell
/// the two apart.) Returns the warnings; never fails.
pub fn overwrite_warnings(req: &ModelFilesRequest, final_output: &Path) -> Vec<String> {
    let read = |p: PathBuf| -> Option<serde_json::Value> {
        serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()
    };
    match req.kind.as_str() {
        "relationship" => {
            let Some(target) = req.target.as_deref() else {
                return Vec::new();
            };
            let file = format!("REL_INFO_{}_{target}.json", req.predictors.join("+"));
            let Some(old) = read(final_output.join(target).join(&file)) else {
                return Vec::new();
            };
            let mut old_preds: Vec<String> = old["model_composition"]["predictors"]
                .as_object()
                .map(|o| o.keys().cloned().collect())
                .unwrap_or_default();
            let mut new_preds = req.predictors.clone();
            old_preds.sort();
            new_preds.sort();
            if old_preds == new_preds {
                return Vec::new();
            }
            vec![format!(
                "{file} already existed for a model with predictors [{}]; it was replaced by the model with predictors [{}].",
                old_preds.join(", "),
                req.predictors.join(", ")
            )]
        }
        "clustering" => {
            let (Some(first), Some(second)) =
                (req.first_sensor.as_deref(), req.second_sensor.as_deref())
            else {
                return Vec::new();
            };
            let file = format!("CLUS_INFO_{first}_{second}.json");
            let Some(old) = read(final_output.join(second).join(&file)) else {
                return Vec::new();
            };
            let n = req.n_clusters.unwrap_or(1);
            let old_count = old["model_composition"]["cluster_count"].as_u64().unwrap_or(1);
            let old_criteria = old["model_composition"]["criteria_sensor"].as_str().unwrap_or("");
            let new_criteria = if n > 1 { req.criteria_sensor.as_deref().unwrap_or("") } else { "" };
            if old_count == u64::from(n) && old_criteria == new_criteria {
                return Vec::new();
            }
            let desc = |c: &str, n: u64| {
                if n > 1 {
                    format!("criteria sensor '{c}', {n} clusters")
                } else {
                    "a single cluster".to_string()
                }
            };
            vec![format!(
                "{file} already existed for a model with {}; it was replaced by the model with {}.",
                desc(old_criteria, old_count),
                desc(new_criteria, u64::from(n))
            )]
        }
        _ => Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// Staging + all-or-nothing commit
// ---------------------------------------------------------------------------

static STAGING_SEQ: AtomicU64 = AtomicU64::new(0);

/// Staging dirs of exports running RIGHT NOW in this process. The sweep of
/// orphaned `.staging-*` dirs (see [`sweep_stale_staging`]) skips these, and
/// the lock is held across the whole sweep and across registering a new dir,
/// so a running export's directory can never be mistaken for an orphan.
static ACTIVE_STAGING: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());

fn lock_active() -> std::sync::MutexGuard<'static, Vec<PathBuf>> {
    ACTIVE_STAGING.lock().unwrap_or_else(|p| p.into_inner())
}

/// A private scratch directory inside the workspace folder. Removed (with
/// everything in it, incl. backups) when dropped — success or failure.
pub struct Staging {
    root: PathBuf,
}

impl Staging {
    /// Create a fresh staging dir inside `ws_dir`. First sweeps the workspace
    /// for `.staging-*` dirs orphaned by an interrupted export (see
    /// [`sweep_stale_staging`]).
    pub fn create(ws_dir: &Path) -> Result<Self, String> {
        let mut active = lock_active();
        sweep_stale_staging(ws_dir, &active);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let name = format!(
            ".staging-{}-{}-{}",
            std::process::id(),
            nanos,
            STAGING_SEQ.fetch_add(1, Ordering::SeqCst)
        );
        let root = ws_dir.join(name);
        std::fs::create_dir_all(&root)
            .map_err(|e| format!("Failed to create staging dir {}: {e}", root.display()))?;
        active.push(root.clone());
        Ok(Staging { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Where the writers put their files (`{root}/output/{target}/...`).
    pub fn output_dir(&self) -> PathBuf {
        self.root.join("output")
    }
}

impl Drop for Staging {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
        lock_active().retain(|p| p != &self.root);
    }
}

/// Clean up `{ws_dir}/.staging-*` dirs left behind by an export that never
/// reached its `Drop` (process killed, power loss), except those in `active`.
///
/// A leftover can hold the BACKUP of the user's previous files (`commit` moves
/// an existing destination to `{staging}/.backup/{relative path}` before
/// placing the new one): if the crash lost the final file, the backup is
/// moved back first; if the final file exists (the commit got that far, or the
/// user exported again since) the backup is stale and is dropped with the dir.
/// A dir whose backup could not be restored is kept for the next attempt.
/// Best effort — nothing here can fail an export. Only direct children of THIS
/// workspace folder are ever touched.
fn sweep_stale_staging(ws_dir: &Path, active: &[PathBuf]) {
    let Ok(rd) = std::fs::read_dir(ws_dir) else {
        return;
    };
    let final_output = ws_dir.join("output");
    for e in rd.flatten() {
        let path = e.path();
        let is_staging = e.file_name().to_string_lossy().starts_with(".staging-");
        if !is_staging || active.contains(&path) || !path.is_dir() {
            continue;
        }
        if restore_backups(&path.join(".backup"), &final_output) {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

/// Move every file under `backup_dir` back to `{final_output}/{relative path}`
/// when that destination is missing. Returns `false` when some restore failed
/// (the caller then keeps the directory).
fn restore_backups(backup_dir: &Path, final_output: &Path) -> bool {
    let Ok(rels) = list_files(backup_dir) else {
        return false;
    };
    let mut all_ok = true;
    for rel in rels {
        let dst = final_output.join(&rel);
        if dst.exists() {
            continue;
        }
        let restored = dst
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|_| std::fs::rename(backup_dir.join(&rel), &dst));
        if restored.is_err() {
            all_ok = false;
        }
    }
    all_ok
}

fn list_files(dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
        for e in std::fs::read_dir(dir)? {
            let e = e?;
            let p = e.path();
            if e.file_type()?.is_dir() {
                walk(base, &p, out)?;
            } else {
                out.push(p.strip_prefix(base).unwrap_or(&p).to_path_buf());
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    if dir.is_dir() {
        walk(dir, dir, &mut out)?;
    }
    out.sort();
    Ok(out)
}

fn file_kind(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".json") {
        "info"
    } else if lower.ends_with(".pkl") {
        "model"
    } else {
        "dataset"
    }
}

/// Move every file under `staged_output` into `final_output`, keeping the
/// relative layout, ALL-OR-NOTHING: an existing destination is first moved
/// aside to a backup (`{staging}/.backup/{relative path}`); if any step fails every
/// placed file is removed and every backup restored, so the previous export is
/// left exactly as it was. Returns the final files (sorted by path).
pub fn commit(staged_output: &Path, final_output: &Path) -> Result<Vec<WrittenFile>, String> {
    let rels = list_files(staged_output)
        .map_err(|e| format!("Failed to read staged files: {e}"))?;
    if rels.is_empty() {
        return Err("Nothing was written for this model.".to_string());
    }
    let backup_dir = staged_output
        .parent()
        .unwrap_or(staged_output)
        .join(".backup");

    // (destination, backup of what was there before)
    let mut placed: Vec<(PathBuf, Option<PathBuf>)> = Vec::new();
    let mut failure: Option<String> = None;
    for rel in rels.iter() {
        let src = staged_output.join(rel);
        let dst = final_output.join(rel);
        let step = (|| -> std::io::Result<Option<PathBuf>> {
            if let Some(parent) = dst.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut backup = None;
            if dst.exists() {
                // Named by RELATIVE PATH (not an index) so an interrupted
                // export's backup can be put back by `sweep_stale_staging`.
                let b = backup_dir.join(rel);
                if let Some(bp) = b.parent() {
                    std::fs::create_dir_all(bp)?;
                }
                std::fs::rename(&dst, &b)?;
                backup = Some(b);
            }
            Ok(backup)
        })();
        match step {
            Ok(backup) => {
                // Record BEFORE the final rename so a failure there still
                // restores the backup.
                placed.push((dst.clone(), backup));
                if let Err(e) = std::fs::rename(&src, &dst) {
                    failure = Some(format!("Failed to write {}: {e}", dst.display()));
                    break;
                }
            }
            Err(e) => {
                failure = Some(format!("Failed to write {}: {e}", dst.display()));
                break;
            }
        }
    }

    if let Some(msg) = failure {
        let mut rollback_problems = Vec::new();
        for (dst, backup) in placed.into_iter().rev() {
            if dst.is_file() {
                if let Err(e) = std::fs::remove_file(&dst) {
                    rollback_problems.push(format!("{}: {e}", dst.display()));
                }
            }
            if let Some(b) = backup {
                if let Err(e) = std::fs::rename(&b, &dst) {
                    rollback_problems.push(format!("restore {}: {e}", dst.display()));
                }
            }
        }
        return Err(if rollback_problems.is_empty() {
            format!("{msg} (nothing was changed)")
        } else {
            format!("{msg} (rollback incomplete: {})", rollback_problems.join("; "))
        });
    }

    Ok(rels
        .iter()
        .map(|rel| {
            let name = rel
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            WrittenFile {
                kind: file_kind(&name),
                file_name: name,
                path: final_output.join(rel).to_string_lossy().into_owned(),
            }
        })
        .collect())
}

/// Turn a writer's outcome into the command's result: validation failures
/// become `ok: false` (nothing committed), other errors stay errors, success
/// commits the staged files (no warnings; see [`finalize_with`]).
#[cfg_attr(not(test), allow(dead_code))]
pub fn finalize(
    staging: Staging,
    output_dir: &Path,
    outcome: Result<(), CoreError>,
) -> Result<ModelFilesResult, String> {
    finalize_with(staging, output_dir, outcome, Vec::new())
}

/// [`finalize`] carrying `warnings` (e.g. [`overwrite_warnings`]) into the
/// result of a SUCCESSFUL export.
pub fn finalize_with(
    staging: Staging,
    output_dir: &Path,
    outcome: Result<(), CoreError>,
    warnings: Vec<String>,
) -> Result<ModelFilesResult, String> {
    let output_dir_s = output_dir.to_string_lossy().into_owned();
    match outcome {
        Err(CoreError::Validation(issues)) => Ok(ModelFilesResult {
            ok: false,
            files: Vec::new(),
            output_dir: output_dir_s,
            validation: issues,
            warnings: Vec::new(),
        }),
        Err(CoreError::Other(e)) => Err(e),
        Ok(()) => {
            let files = commit(&staging.output_dir(), output_dir)?;
            Ok(ModelFilesResult {
                ok: true,
                files,
                output_dir: output_dir_s,
                validation: Vec::new(),
                warnings,
            })
        }
    }
}

// ---------------------------------------------------------------------------
// Individual / Clustering (synchronous over the columnar data)
// ---------------------------------------------------------------------------

fn need<'a>(v: &'a Option<String>, what: &str) -> Result<&'a str, String> {
    v.as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("BAD_REQUEST: {what} is required"))
}

/// Export an Individual or Clustering model. (Relationship needs the sidecar
/// and is orchestrated by the async command, reusing [`Staging`] /
/// [`finalize`].) Validation runs inside the writer against the freshly
/// computed statistics, so a scope change since the page was last viewed is
/// caught here too.
pub fn export_sync(
    data: &ColumnarData,
    req: &ModelFilesRequest,
    app_data: &Path,
) -> Result<ModelFilesResult, String> {
    // Parameter checks first — no directories are created for a bad request.
    match req.kind.as_str() {
        "individual" => {
            need(&req.target, "target")?;
        }
        "clustering" => {
            need(&req.first_sensor, "first_sensor")?;
            need(&req.second_sensor, "second_sensor")?;
        }
        other => return Err(format!("BAD_REQUEST: unknown kind '{other}'")),
    }
    // Every request-shaped problem is refused here, coded, before the disk.
    check_export_names(req)?;
    match req.kind.as_str() {
        "individual" => crate::health_preview::check_individual_request(
            data,
            need(&req.target, "target")?,
            req.filter.as_ref(),
        )?,
        _ => crate::health_preview::check_clustering_request(
            data,
            need(&req.first_sensor, "first_sensor")?,
            need(&req.second_sensor, "second_sensor")?,
            req.n_clusters.unwrap_or(1),
            req.criteria_sensor.as_deref(),
            req.cluster_ranges.as_deref(),
            req.filter.as_ref(),
        )?,
    }
    let dirs = prepare_workspace(app_data, &req.workspace_id)?;
    let staging = Staging::create(&dirs.ws_dir)?;
    let save_path = staging.root().to_string_lossy().into_owned();
    // An absent set-point object is "nothing entered": refused as `required`,
    // never written as nulls.
    let empty = SetPointsArg::default();
    let sp = Some(req.set_points.as_ref().unwrap_or(&empty));

    let outcome: Result<(), CoreError> = match req.kind.as_str() {
        "individual" => crate::write_individual_info(
            data,
            need(&req.target, "target")?.to_string(),
            req.model_name.clone(),
            &save_path,
            req.filter.clone(),
            sp,
        )
        .map(|_| ()),
        _ => crate::write_clustering_info(
            data,
            need(&req.first_sensor, "first_sensor")?.to_string(),
            need(&req.second_sensor, "second_sensor")?.to_string(),
            req.n_clusters.unwrap_or(1),
            req.criteria_sensor.clone(),
            req.cluster_ranges.clone(),
            req.model_name.clone(),
            &save_path,
            req.filter.clone(),
            sp,
        )
        .map(|_| ()),
    };
    let warnings = overwrite_warnings(req, &dirs.output_dir);
    finalize_with(staging, &dirs.output_dir, outcome, warnings)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn write(p: &Path, s: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, s).unwrap();
    }

    // ---------- workspace id / paths ----------

    #[test]
    fn workspace_id_is_sanitised() {
        assert_eq!(sanitize_workspace_id("ws_123-abc").unwrap(), "ws_123-abc");
        for bad in ["", ".", "..", "a/b", "a\\b", "..\\x", "a:b", "x*y", "a?b", " lead", "trail ", "dot.", "nul\0x"] {
            assert!(sanitize_workspace_id(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn prepare_workspace_creates_the_documented_layout() {
        let d = tmp();
        let w = prepare_workspace(d.path(), "ws1").unwrap();
        assert_eq!(w.ws_dir, d.path().join("workspaces").join("ws1"));
        assert_eq!(w.output_dir, d.path().join("workspaces").join("ws1").join("output"));
        assert!(w.output_dir.is_dir());
        // Idempotent.
        prepare_workspace(d.path(), "ws1").unwrap();
        // A traversal id never creates anything outside.
        assert!(prepare_workspace(d.path(), "../evil").is_err());
        assert!(!d.path().join("evil").exists());
    }

    // ---------- staging ----------

    #[test]
    fn staging_dirs_are_unique_and_removed_on_drop() {
        let d = tmp();
        let a = Staging::create(d.path()).unwrap();
        let b = Staging::create(d.path()).unwrap();
        assert_ne!(a.root(), b.root());
        let ra = a.root().to_path_buf();
        write(&a.output_dir().join("T").join("f.json"), "{}");
        assert!(ra.is_dir());
        drop(a);
        assert!(!ra.exists());
        assert!(b.root().is_dir());
    }

    // ---------- commit ----------

    #[test]
    fn commit_moves_files_keeping_the_layout_and_classifies_them() {
        let d = tmp();
        let st = Staging::create(d.path()).unwrap();
        let out = d.path().join("output");
        write(&st.output_dir().join("T").join("REL_INFO_x_T.json"), "{\"a\":1}");
        write(&st.output_dir().join("T").join("REL_MODEL_x_T.pkl"), "pkl");
        write(&st.output_dir().join("T").join("REL_DATASET_x_T.csv"), "a,b");
        let files = commit(&st.output_dir(), &out).unwrap();
        assert_eq!(files.len(), 3);
        let kinds: Vec<(&str, &str)> = files.iter().map(|f| (f.file_name.as_str(), f.kind)).collect();
        assert!(kinds.contains(&("REL_INFO_x_T.json", "info")));
        assert!(kinds.contains(&("REL_MODEL_x_T.pkl", "model")));
        assert!(kinds.contains(&("REL_DATASET_x_T.csv", "dataset")));
        for f in &files {
            assert!(Path::new(&f.path).is_file(), "{}", f.path);
            assert!(f.path.starts_with(out.to_str().unwrap()));
        }
        assert_eq!(fs::read_to_string(out.join("T").join("REL_INFO_x_T.json")).unwrap(), "{\"a\":1}");
        assert!(list_files(&st.output_dir()).unwrap().is_empty(), "staged files were moved");
    }

    #[test]
    fn commit_overwrites_the_previous_export() {
        let d = tmp();
        let out = d.path().join("output");
        write(&out.join("T").join("INDV_INFO_T.json"), "OLD");
        write(&out.join("T").join("other.txt"), "keep me");
        let st = Staging::create(d.path()).unwrap();
        write(&st.output_dir().join("T").join("INDV_INFO_T.json"), "NEW");
        commit(&st.output_dir(), &out).unwrap();
        assert_eq!(fs::read_to_string(out.join("T").join("INDV_INFO_T.json")).unwrap(), "NEW");
        assert_eq!(fs::read_to_string(out.join("T").join("other.txt")).unwrap(), "keep me");
    }

    #[test]
    fn commit_rolls_back_completely_when_a_later_file_fails() {
        let d = tmp();
        let out = d.path().join("output");
        // Previous export of A/x.json exists...
        write(&out.join("A").join("x.json"), "OLD-A");
        // ...and B exists as a plain FILE, so B/y.json can never be created.
        write(&out.join("B"), "i am a file");
        let st = Staging::create(d.path()).unwrap();
        write(&st.output_dir().join("A").join("x.json"), "NEW-A");
        write(&st.output_dir().join("A").join("z.json"), "NEW-Z");
        write(&st.output_dir().join("B").join("y.json"), "NEW-B");
        let err = commit(&st.output_dir(), &out).unwrap_err();
        assert!(err.contains("Failed to write"), "{err}");
        // Old content restored, nothing new left behind.
        assert_eq!(fs::read_to_string(out.join("A").join("x.json")).unwrap(), "OLD-A");
        assert!(!out.join("A").join("z.json").exists());
        assert_eq!(fs::read_to_string(out.join("B")).unwrap(), "i am a file");
    }

    #[test]
    fn commit_of_nothing_is_an_error() {
        let d = tmp();
        let st = Staging::create(d.path()).unwrap();
        fs::create_dir_all(st.output_dir()).unwrap();
        assert!(commit(&st.output_dir(), &d.path().join("output")).is_err());
    }

    // ---------- finalize ----------

    #[test]
    fn finalize_validation_failure_writes_nothing() {
        let d = tmp();
        let w = prepare_workspace(d.path(), "ws").unwrap();
        let st = Staging::create(&w.ws_dir).unwrap();
        let root = st.root().to_path_buf();
        write(&st.output_dir().join("T").join("f.json"), "partial");
        let issue = crate::health_score::validate_clustering(&[], &SetPointsArg::default());
        let r = finalize(st, &w.output_dir, Err(CoreError::Validation(issue))).unwrap();
        assert!(!r.ok);
        assert!(!r.validation.is_empty());
        assert!(r.files.is_empty());
        assert!(list_files(&w.output_dir).unwrap().is_empty());
        assert!(!root.exists(), "staging is cleaned up");
    }

    #[test]
    fn finalize_other_error_is_an_error_and_cleans_up() {
        let d = tmp();
        let w = prepare_workspace(d.path(), "ws").unwrap();
        let st = Staging::create(&w.ws_dir).unwrap();
        let root = st.root().to_path_buf();
        write(&st.output_dir().join("T").join("f.json"), "partial");
        let e = finalize(st, &w.output_dir, Err(CoreError::Other("boom".into()))).unwrap_err();
        assert_eq!(e, "boom");
        assert!(list_files(&w.output_dir).unwrap().is_empty());
        assert!(!root.exists());
    }

    #[test]
    fn core_error_flattens_validation_messages() {
        let v = crate::health_score::validate_clustering(&[], &SetPointsArg::default());
        let s = CoreError::Validation(v).into_string();
        assert!(s.starts_with("VALIDATION: "), "{s}");
        assert_eq!(CoreError::Other("x".into()).into_string(), "x");
    }

    #[test]
    fn request_and_result_json_shapes() {
        let r: ModelFilesRequest = serde_json::from_str(
            r#"{"kind":"relationship","workspace_id":"ws1","target":"Y","predictors":["A"],
                "lambda":10000,"cache_key":"k","set_points":{"kind":"relationship","residualAt80Lower":-1},
                "expectedGeneration":3}"#,
        )
        .unwrap();
        assert_eq!(r.workspace_id, "ws1");
        assert_eq!(r.lambda, Some(10000.0));
        assert_eq!(r.expected_generation, Some(3));
        assert_eq!(r.set_points.unwrap().residual_at_80_lower, Some(-1.0));
        let res = ModelFilesResult {
            ok: true,
            files: vec![WrittenFile { kind: "info", file_name: "a.json".into(), path: "/p/a.json".into() }],
            output_dir: "/p".into(),
            validation: vec![],
            warnings: vec![],
        };
        let j = serde_json::to_value(&res).unwrap();
        assert_eq!(j["ok"], true);
        assert_eq!(j["files"][0]["kind"], "info");
        assert_eq!(j["files"][0]["file_name"], "a.json");
        assert_eq!(j["output_dir"], "/p");
    }

    // ---------- 2026-10-04: orphaned staging sweep ----------

    fn orphan(ws: &Path, name: &str) -> PathBuf {
        let p = ws.join(name);
        fs::create_dir_all(p.join("output").join("T")).unwrap();
        write(&p.join("output").join("T").join("half.json"), "half");
        p
    }

    #[test]
    fn commit_names_backups_by_relative_path() {
        let d = tmp();
        let out = d.path().join("output");
        write(&out.join("T").join("a.json"), "OLD");
        let st = Staging::create(d.path()).unwrap();
        write(&st.output_dir().join("T").join("a.json"), "NEW");
        commit(&st.output_dir(), &out).unwrap();
        assert_eq!(fs::read_to_string(out.join("T").join("a.json")).unwrap(), "NEW");
        // The previous file is kept (until the staging dir is dropped) at the
        // SAME relative path, which is what lets a later sweep put it back.
        let b = st.root().join(".backup").join("T").join("a.json");
        assert_eq!(fs::read_to_string(&b).unwrap(), "OLD");
        let root = st.root().to_path_buf();
        drop(st);
        assert!(!root.exists(), "success drops the staging dir together with its backups");
    }

    #[test]
    fn a_leftover_staging_dir_without_a_backup_is_deleted_by_the_next_export() {
        let d = tmp();
        let w = prepare_workspace(d.path(), "ws").unwrap();
        let o = orphan(&w.ws_dir, ".staging-99999-1-0");
        let st = Staging::create(&w.ws_dir).unwrap();
        assert!(!o.exists(), "orphan swept");
        assert!(st.root().is_dir(), "the new staging dir is not swept");
    }

    #[test]
    fn a_leftover_backup_is_restored_when_the_final_file_was_lost_and_dropped_when_it_exists() {
        let d = tmp();
        let w = prepare_workspace(d.path(), "ws").unwrap();
        // Crash between "move the old file aside" and "place the new one":
        // the final file is missing, the backup holds the user's previous export.
        let o = orphan(&w.ws_dir, ".staging-99999-2-0");
        write(&o.join(".backup").join("T").join("lost.json"), "PREVIOUS");
        // Crash after placing: the final file exists (new), the backup is stale.
        write(&o.join(".backup").join("T").join("placed.json"), "STALE-OLD");
        write(&w.output_dir.join("T").join("placed.json"), "NEW");
        let _st = Staging::create(&w.ws_dir).unwrap();
        assert!(!o.exists(), "the orphan dir is gone either way");
        assert_eq!(fs::read_to_string(w.output_dir.join("T").join("lost.json")).unwrap(), "PREVIOUS");
        assert_eq!(fs::read_to_string(w.output_dir.join("T").join("placed.json")).unwrap(), "NEW");
        // The half-written staged file never leaks into the output.
        assert!(!w.output_dir.join("T").join("half.json").exists());
    }

    #[test]
    fn a_staging_dir_whose_backup_cannot_be_restored_is_kept() {
        let d = tmp();
        let w = prepare_workspace(d.path(), "ws").unwrap();
        let o = orphan(&w.ws_dir, ".staging-99999-3-0");
        write(&o.join(".backup").join("T").join("x.json"), "PREVIOUS");
        // `output/T` is a FILE, so the previous export can't be put back there.
        write(&w.output_dir.join("T"), "blocker");
        let _st = Staging::create(&w.ws_dir).unwrap();
        assert!(o.join(".backup").join("T").join("x.json").is_file(), "kept for the next attempt");
    }

    #[test]
    fn the_sweep_skips_a_running_export_and_other_workspaces() {
        let d = tmp();
        let w1 = prepare_workspace(d.path(), "ws1").unwrap();
        let w2 = prepare_workspace(d.path(), "ws2").unwrap();
        let running = Staging::create(&w1.ws_dir).unwrap();
        write(&running.output_dir().join("T").join("f.json"), "in progress");
        let other = orphan(&w2.ws_dir, ".staging-99999-4-0");
        // A second export in the SAME workspace starts while the first runs.
        let second = Staging::create(&w1.ws_dir).unwrap();
        assert!(running.root().is_dir(), "a running export's staging dir is never swept");
        assert!(running.output_dir().join("T").join("f.json").is_file());
        assert!(other.exists(), "another workspace's folder is never touched");
        // Not named .staging-* => never touched, even in this workspace.
        let keep = w1.ws_dir.join("notes");
        fs::create_dir_all(&keep).unwrap();
        drop(second);
        let _third = Staging::create(&w1.ws_dir).unwrap();
        assert!(keep.is_dir());
        // Once the running export is dropped, its (removed) dir is not tracked any more.
        let root = running.root().to_path_buf();
        drop(running);
        assert!(!root.exists());
        assert!(!lock_active().contains(&root));
    }

    // ---------- 2026-10-04: sensor names as file names ----------

    #[test]
    fn file_name_problem_flags_everything_that_cannot_be_a_safe_component() {
        for bad in [
            "", ".", "..", "a/b", "a\\b", "a:b", "a*b", "a?b", "a\"b", "a<b", "a>b", "a|b", "a\0b", "a\tb", "a\nb",
            " a", "a ", "a.", "CON", "con", "Nul", "PRN", "AUX", "COM1", "com9", "LPT1", "CON.txt", "aux.x",
        ] {
            assert!(file_name_problem(bad).is_some(), "{bad:?} should be refused");
        }
        assert!(file_name_problem(&"x".repeat(256)).is_some());
        for ok in [
            "S", "Temp (C)", "温度センサー", "ท่ออากาศ", "=cmd_' C calc'!A0", "-5", "A.B", "A+B",
            "COM0", "COM10", "CONSOLE", "LPT", "x", &"x".repeat(255),
        ] {
            assert_eq!(file_name_problem(ok), None, "{ok:?} should be accepted");
        }
    }

    #[test]
    fn check_export_names_codes_every_refusal_and_names_the_field() {
        let mk = |kind: &str| ModelFilesRequest { kind: kind.into(), workspace_id: "ws".into(), ..Default::default() };
        let mut r = mk("individual");
        r.target = Some("a/b".into());
        let e = check_export_names(&r).unwrap_err();
        assert!(e.starts_with("BAD_REQUEST: the target name 'a/b'"), "{e}");
        let mut r = mk("clustering");
        r.first_sensor = Some("X".into());
        r.second_sensor = Some("NUL".into());
        assert!(check_export_names(&r).unwrap_err().contains("second_sensor"));
        let mut r = mk("relationship");
        r.target = Some("Y".into());
        r.predictors = vec!["ok".into(), "bad*".into()];
        assert!(check_export_names(&r).unwrap_err().contains("predictor"));
        // Each name is fine but the composed file name is too long.
        r.predictors = (0..6).map(|i| format!("{}{i}", "p".repeat(60))).collect();
        let e = check_export_names(&r).unwrap_err();
        assert!(e.starts_with("BAD_REQUEST") && e.contains("bytes long"), "{e}");
        // Control characters are escaped in the message, never echoed raw.
        let mut r = mk("individual");
        r.target = Some("a\u{7}b".into());
        assert!(!check_export_names(&r).unwrap_err().contains('\u{7}'));
        // A bad workspace id is coded too.
        let mut r = mk("individual");
        r.workspace_id = "../x".into();
        r.target = Some("S".into());
        assert!(check_export_names(&r).unwrap_err().starts_with("BAD_REQUEST: workspace_id"));
        // Normal requests pass.
        r.workspace_id = "ws".into();
        assert!(check_export_names(&r).is_ok());
    }

    #[test]
    fn unsafe_name_warnings_are_non_blocking_warnings() {
        let w = unsafe_name_warnings(&[("target", "ok"), ("predictor", "a/b")]);
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].code, "unsafe_file_name");
        assert_eq!(w[0].severity, crate::health_score::Severity::Warning);
        assert_eq!(w[0].field, "predictor");
        assert!(unsafe_name_warnings(&[("target", "Fine name")]).is_empty());
    }

    // ---------- 2026-10-04: overwriting another model's file ----------

    fn rel_info(preds: &[&str]) -> String {
        let p: serde_json::Map<String, serde_json::Value> =
            preds.iter().map(|s| (s.to_string(), serde_json::json!(s))).collect();
        serde_json::json!({ "model_composition": { "predictors": p } }).to_string()
    }

    #[test]
    fn overwrite_warning_for_a_relationship_with_a_different_predictor_list_in_the_same_file() {
        let d = tmp();
        let out = d.path();
        // A model with the single predictor "A+B" wrote REL_INFO_A+B_Y.json...
        write(&out.join("Y").join("REL_INFO_A+B_Y.json"), &rel_info(&["A+B"]));
        let req = ModelFilesRequest {
            kind: "relationship".into(),
            target: Some("Y".into()),
            predictors: vec!["A".into(), "B".into()],
            ..Default::default()
        };
        // ...and the [A, B] model is about to replace it.
        let w = overwrite_warnings(&req, out);
        assert_eq!(w.len(), 1, "{w:?}");
        assert!(w[0].contains("REL_INFO_A+B_Y.json") && w[0].contains("[A+B]") && w[0].contains("[A, B]"), "{}", w[0]);
        // Same predictors (a plain re-export), no previous file: nothing to say.
        write(&out.join("Y").join("REL_INFO_A+B_Y.json"), &rel_info(&["A", "B"]));
        assert!(overwrite_warnings(&req, out).is_empty());
        let other = ModelFilesRequest { predictors: vec!["C".into()], ..req.clone() };
        assert!(overwrite_warnings(&other, out).is_empty());
    }

    #[test]
    fn overwrite_warning_for_two_clustering_models_with_the_same_xy_and_different_criteria() {
        let d = tmp();
        let out = d.path();
        let old = serde_json::json!({ "model_composition": { "criteria_sensor": "C1", "cluster_count": 3 } }).to_string();
        write(&out.join("Y").join("CLUS_INFO_X_Y.json"), &old);
        let mut req = ModelFilesRequest {
            kind: "clustering".into(),
            first_sensor: Some("X".into()),
            second_sensor: Some("Y".into()),
            n_clusters: Some(3),
            criteria_sensor: Some("C2".into()),
            ..Default::default()
        };
        let w = overwrite_warnings(&req, out);
        assert_eq!(w.len(), 1);
        assert!(w[0].contains("'C1'") && w[0].contains("'C2'"), "{}", w[0]);
        req.criteria_sensor = Some("C1".into());
        assert!(overwrite_warnings(&req, out).is_empty(), "same criteria + count");
        req.n_clusters = Some(1);
        assert_eq!(overwrite_warnings(&req, out).len(), 1, "3 clusters -> a single cluster");
        // Unreadable / foreign JSON never makes the export fail.
        write(&out.join("Y").join("CLUS_INFO_X_Y.json"), "not json");
        assert!(overwrite_warnings(&req, out).is_empty());
    }

    #[test]
    fn a_successful_export_reports_the_overwrite_warning() {
        use crate::csv_processor::ColumnarData;
        let n = 400;
        let ts: Vec<Option<String>> = (0..n).map(|i| Some(format!("2024-01-01T{:02}:{:02}:00", (i / 60) % 24, i % 60))).collect();
        let col = |f: &dyn Fn(usize) -> f64| (0..n).map(f).collect::<Vec<f64>>();
        let data = ColumnarData::from_parts(
            vec!["timestamp".into(), "X".into(), "Y".into(), "C".into()],
            ts,
            vec![vec![f64::NAN; n], col(&|i| (i % 17) as f64), col(&|i| (i % 13) as f64 + 0.5 * (i % 5) as f64), col(&|i| (i % 2) as f64 * 10.0)],
        );
        let app = tmp();
        let mk = |criteria: Option<&str>, n_clusters: u32, ranges: Option<Vec<ClusterRange>>| ModelFilesRequest {
            kind: "clustering".into(),
            workspace_id: "ws".into(),
            first_sensor: Some("X".into()),
            second_sensor: Some("Y".into()),
            n_clusters: Some(n_clusters),
            criteria_sensor: criteria.map(String::from),
            cluster_ranges: ranges,
            set_points: Some(SetPointsArg { outer_sd: Some(6.0), ..Default::default() }),
            ..Default::default()
        };
        let first = export_sync(&data, &mk(None, 1, None), app.path()).unwrap();
        assert!(first.ok && first.warnings.is_empty(), "{:?}", first.warnings);
        let two = mk(
            Some("C"),
            2,
            Some(vec![ClusterRange { min: None, max: Some(5.0) }, ClusterRange { min: Some(5.0), max: None }]),
        );
        let second = export_sync(&data, &two, app.path()).unwrap();
        assert!(second.ok, "{:?}", second.validation);
        assert_eq!(second.warnings.len(), 1, "{:?}", second.warnings);
        assert!(second.warnings[0].contains("CLUS_INFO_X_Y.json"));
        // Exporting the same model again: no warning.
        assert!(export_sync(&data, &two, app.path()).unwrap().warnings.is_empty());
    }
}
