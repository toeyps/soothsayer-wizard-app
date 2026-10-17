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
//! Re-exporting a Relationship model with a DIFFERENT predictor list (or a
//! Clustering model — identified by its x / first sensor — with a different y
//! sensor) writes new file names, so the export also removes that model's
//! previous files ("stale siblings", see [`stale_model_files`]) in the SAME
//! all-or-nothing commit: moved aside like every backup, put back on failure,
//! deleted only when the export succeeded. `remove_model_files_in` removes one
//! model's files on request.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::csv_processor::ColumnarData;
use crate::health_preview::HealthPreviewRequest;
use crate::health_score::{has_errors, Issue, SetPointsArg};
use crate::health_validation::{self, TestPeriodArg, TestPlan, TestValidation};
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
    /// Scoring periods (`[{start,end}]`; a legacy `label` / `event_time` is
    /// accepted and ignored). When non-empty the train-only model scores these
    /// periods (the same code as `compute_health_preview`) and a `validation`
    /// block is added to the `*_INFO_*.json`. Empty / absent = no `validation`
    /// block.
    #[serde(default)]
    pub test_periods: Option<Vec<TestPeriodArg>>,
}

impl ModelFilesRequest {
    pub fn tests_requested(&self) -> bool {
        self.test_periods.as_ref().is_some_and(|t| !t.is_empty())
    }
}

/// Refusal of an export whose scoring periods (`test_periods`) are malformed (a
/// date that cannot be read, an end before its start): `ok: false` with the
/// structured issues, nothing written. `None` when there are none or they are
/// fine.
pub fn refuse_bad_test_periods(
    req: &ModelFilesRequest,
    data: &ColumnarData,
    app_data: &Path,
) -> Result<Option<ModelFilesResult>, String> {
    let Some(periods) = req.test_periods.as_deref().filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    let plan = TestPlan::resolve(periods, req.filter.as_ref(), &data.headers);
    if !has_errors(&plan.issues) {
        return Ok(None);
    }
    Ok(Some(ModelFilesResult {
        ok: false,
        files: Vec::new(),
        output_dir: output_dir_path(app_data, &req.workspace_id)?
            .to_string_lossy()
            .into_owned(),
        validation: plan.issues,
        warnings: Vec::new(),
        removed: Vec::new(),
    }))
}

/// The `validation` block of an Individual / Clustering export: the SAME
/// preview code as `compute_health_preview` (train-only model; the scoring
/// periods are scored on 1-HOUR AVERAGES of their running rows, see
/// `health_hourly`), serialized with [`health_validation::export_block`], which
/// also declares `scoring_interval_seconds: 3600` / `scoring_aggregation:
/// "mean"`. The train block and every key outside `validation` stay the raw
/// training rows' numbers.
fn individual_or_clustering_block(
    data: &ColumnarData,
    req: &ModelFilesRequest,
) -> Result<serde_json::Value, String> {
    let pv = HealthPreviewRequest {
        kind: req.kind.clone(),
        target: req.target.clone(),
        first_sensor: req.first_sensor.clone(),
        second_sensor: req.second_sensor.clone(),
        n_clusters: req.n_clusters,
        criteria_sensor: req.criteria_sensor.clone(),
        cluster_ranges: req.cluster_ranges.clone(),
        filter: req.filter.clone(),
        set_points: req.set_points.clone(),
        test_periods: req.test_periods.clone(),
        // The series is not used; keep it as small as the preview allows.
        max_points: Some(8),
        max_scatter_points: Some(1),
        ..Default::default()
    };
    let preview = if req.kind == "individual" {
        crate::health_preview::individual_preview(data, &pv)?
    } else {
        crate::health_preview::clustering_preview(data, &pv)?
    };
    let tv: TestValidation = preview
        .test_validation
        .ok_or_else(|| "internal: the validation was not computed".to_string())?;
    Ok(health_validation::export_block(&tv, &now_iso()))
}

/// The `validation` block of a Relationship export: the SAME preview code as
/// `compute_health_preview`, over the fit the export just trained (`fit`, the
/// raw training rows) and that model's predictions for the HOURLY points
/// (`extra`: the engine's answers for the hourly mean predictors of the
/// training hours and of the scoring periods, asked for in the export's one
/// sidecar run). Nothing is refitted.
///
/// Like the other two kinds the block is hourly: `tests[].scored` /
/// `pct_below_80` / `lowest` and the period metrics (`r2`, `rmse`,
/// `residual_mean`, `residual_sd`) are over 1-hour averages - residual = mean
/// actual minus the prediction at the hour's mean predictors - which is what
/// `scoring_interval_seconds: 3600` / `scoring_aggregation: "mean"` declare.
/// The `train` block stays the model's own raw-row numbers.
pub fn relationship_block(
    data: &ColumnarData,
    fit: &crate::health_score::RelFit,
    extra: &crate::health_score::RelExtra,
    req: &ModelFilesRequest,
) -> Result<serde_json::Value, String> {
    let pv = HealthPreviewRequest {
        kind: "relationship".into(),
        target: Some(fit.target.clone()),
        predictors: fit.predictors.clone(),
        filter: req.filter.clone(),
        set_points: req.set_points.clone(),
        test_periods: req.test_periods.clone(),
        max_points: Some(8),
        max_scatter_points: Some(1),
        ..Default::default()
    };
    let tv: TestValidation =
        crate::health_preview::relationship_preview_ex(data, fit, Some(extra), &pv)?
            .test_validation
            .ok_or_else(|| "internal: the validation was not computed".to_string())?;
    Ok(health_validation::export_block(&tv, &now_iso()))
}

/// `validated_at`: RFC 3339 UTC, like `model_update_record[].updated_timestamp`.
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
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
    /// File names of the model's previous files (an older predictor set / X
    /// sensor) that this successful export removed. Empty otherwise.
    pub removed: Vec<String>,
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
// A model kind's files (stale siblings / remove_model_files)
// ---------------------------------------------------------------------------
//
// Model identity: Individual / Relationship = the target (its folder);
// Clustering = the FIRST (x) sensor, whose file `CLUS_INFO_{first}_{second}.json`
// sits in the SECOND sensor's folder — so two clustering models with the same
// y share a folder, and a model whose y changed left its old file elsewhere.

/// `(prefix, extension)` of the files an Individual / Relationship model
/// writes into its target's folder. `None` for any other kind.
fn target_kind_patterns(kind: &str) -> Option<&'static [(&'static str, &'static str)]> {
    match kind {
        "individual" => Some(&[("INDV_INFO", "json")]),
        "relationship" => Some(&[("REL_DATASET", "csv"), ("REL_INFO", "json"), ("REL_MODEL", "pkl")]),
        _ => None,
    }
}

fn is_known_kind(kind: &str) -> bool {
    matches!(kind, "individual" | "relationship" | "clustering")
}

/// Does `name`, found in the folder `folder`, belong to the `kind` model whose
/// identity is `sensor`?
/// - Individual: exactly `INDV_INFO_{sensor}.json` in folder `sensor`.
/// - Relationship: `REL_{DATASET,INFO,MODEL}_` + a NON-EMPTY predictor token +
///   the exact `_{sensor}.{ext}` ending, in folder `sensor` (the ending is the
///   folder itself, so target `B` never matches `..._AB.json`).
/// - Clustering (`sensor` = the first / x sensor): exactly
///   `CLUS_INFO_{sensor}_{folder}.json` — prefix AND the folder as the suffix,
///   which is unambiguous even when names contain `_` (first `A` never
///   matches `CLUS_INFO_AB_T.json` nor `CLUS_INFO_A_B_T.json` in folder `T`).
fn is_model_file(kind: &str, sensor: &str, folder: &str, name: &str) -> bool {
    if kind == "clustering" {
        return name == format!("CLUS_INFO_{sensor}_{folder}.json");
    }
    if folder != sensor {
        return false;
    }
    let Some(pats) = target_kind_patterns(kind) else {
        return false;
    };
    pats.iter().any(|(prefix, ext)| {
        if kind == "individual" {
            return name == format!("{prefix}_{sensor}.{ext}");
        }
        let head = format!("{prefix}_");
        let tail = format!("_{sensor}.{ext}");
        name.len() > head.len() + tail.len() && name.starts_with(&head) && name.ends_with(&tail)
    })
}

/// A directory that is not a symlink (nor a junction / reparse point that
/// `symlink_metadata` reports as a link).
fn is_real_dir(p: &Path) -> bool {
    std::fs::symlink_metadata(p).map(|m| m.file_type().is_dir()).unwrap_or(false)
}

/// Names of the real (non-symlink) sub-folders directly in `output` whose name
/// is a usable sensor name (sorted).
fn sensor_folders(output: &Path) -> Vec<String> {
    if !is_real_dir(output) {
        return Vec::new();
    }
    let Ok(rd) = std::fs::read_dir(output) else {
        return Vec::new();
    };
    let mut out: Vec<String> = rd
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| e.file_name().to_str().map(String::from))
        .filter(|n| file_name_problem(n).is_none())
        .collect();
    out.sort();
    out
}

/// Names of the plain files (never symlinks) directly in `output/{folder}`
/// that belong to the `kind` model `sensor` (sorted).
fn model_files_in(output: &Path, folder: &str, kind: &str, sensor: &str) -> Vec<String> {
    let dir = output.join(folder);
    if !is_real_dir(&dir) {
        return Vec::new();
    }
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out: Vec<String> = rd
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter_map(|e| e.file_name().to_str().map(String::from))
        .filter(|n| is_model_file(kind, sensor, folder, n))
        .collect();
    out.sort();
    out
}

/// Every file of the `kind` model `sensor`, as paths relative to `output`
/// (`{folder}/{name}`): Individual / Relationship look in `output/{sensor}/`
/// only; Clustering looks in EVERY direct sub-folder (its y may have changed).
fn model_file_rels(output: &Path, kind: &str, sensor: &str) -> Vec<PathBuf> {
    let folders = if kind == "clustering" { sensor_folders(output) } else { vec![sensor.to_string()] };
    folders
        .iter()
        .flat_map(|f| {
            model_files_in(output, f, kind, sensor)
                .into_iter()
                .map(move |n| Path::new(f).join(n))
        })
        .collect()
}

/// The model's PREVIOUS files that this export replaces without overwriting
/// (a Relationship with another predictor set; a Clustering model — same x —
/// with another y, whose old file sits in the old y's folder), as paths
/// relative to `final_output`. The files this export writes itself are never
/// in the list (they are overwritten as usual); Individual has a single fixed
/// name, so nothing.
pub fn stale_model_files(req: &ModelFilesRequest, final_output: &Path) -> Vec<PathBuf> {
    let (identity, new_folder) = match req.kind.as_str() {
        "relationship" => (req.target.as_deref(), req.target.as_deref()),
        "clustering" => (req.first_sensor.as_deref(), req.second_sensor.as_deref()),
        _ => (None, None),
    };
    let (Some(identity), Some(new_folder)) = (identity, new_folder) else {
        return Vec::new();
    };
    if file_name_problem(identity).is_some() || file_name_problem(new_folder).is_some() {
        return Vec::new();
    }
    let new_rels: Vec<PathBuf> =
        composed_file_names(req).iter().map(|n| Path::new(new_folder).join(n)).collect();
    model_file_rels(final_output, &req.kind, identity)
        .into_iter()
        .filter(|r| !new_rels.contains(r))
        .collect()
}

/// Delete every file of the `kind` model identified by `sensor` from
/// `{app_data}/workspaces/{id}/output/`, leaving other models' files alone:
/// Individual / Relationship: `sensor` = the target, files in
/// `output/{sensor}/`; Clustering: `sensor` = the FIRST (x) sensor, the file
/// `CLUS_INFO_{sensor}_{folder}.json` in every direct sub-folder. Each folder
/// that ends up empty is removed. Returns how many files were removed; nothing
/// there is `Ok(0)`. Bad workspace id / kind / sensor name -> `BAD_REQUEST:`.
pub fn remove_model_files_in(
    app_data: &Path,
    workspace_id: &str,
    kind: &str,
    sensor: &str,
) -> Result<u32, String> {
    let output = output_dir_path(app_data, workspace_id).map_err(|e| format!("BAD_REQUEST: {e}"))?;
    if !is_known_kind(kind) {
        return Err(format!("BAD_REQUEST: unknown kind '{}'", shown(kind)));
    }
    if let Some(why) = file_name_problem(sensor) {
        return Err(format!(
            "BAD_REQUEST: the sensor name '{}' cannot be used in a file name: {why}",
            shown(sensor)
        ));
    }
    let mut removed = 0u32;
    let mut folders: Vec<PathBuf> = if kind == "clustering" { Vec::new() } else { vec![output.join(sensor)] };
    let mut failed: Vec<String> = Vec::new();
    // Every matching file is tried (one locked file, e.g. open in Excel, must
    // not leave the rest behind); the failures are reported together.
    for rel in model_file_rels(&output, kind, sensor) {
        let p = output.join(&rel);
        match std::fs::remove_file(&p) {
            Ok(()) => removed += 1,
            Err(e) => failed.push(format!("{}: {e}", p.display())),
        }
        if let Some(parent) = p.parent() {
            if !folders.iter().any(|f| f == parent) {
                folders.push(parent.to_path_buf());
            }
        }
    }
    // Only an EMPTY real folder is removed (remove_dir refuses anything else).
    for folder in folders {
        let empty = is_real_dir(&folder)
            && std::fs::read_dir(&folder).map(|mut rd| rd.next().is_none()).unwrap_or(false);
        if empty {
            let _ = std::fs::remove_dir(&folder);
        }
    }
    removal_outcome(removed, &failed)
}

/// `Ok(removed)` when nothing failed, otherwise an error naming every file
/// that could not be removed (and how many were).
fn removal_outcome(removed: u32, failed: &[String]) -> Result<u32, String> {
    if failed.is_empty() {
        return Ok(removed);
    }
    Err(format!(
        "Failed to remove {} file(s) ({removed} removed): {}",
        failed.len(),
        failed.join("; ")
    ))
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
#[cfg_attr(not(test), allow(dead_code))]
pub fn commit(staged_output: &Path, final_output: &Path) -> Result<Vec<WrittenFile>, String> {
    commit_replacing(staged_output, final_output, &[]).map(|(files, _)| files)
}

/// [`commit`] that also REMOVES `stale` (paths relative to `final_output`, see
/// [`stale_model_files`]) in the same transaction: each one still present as a
/// plain file (and not about to be overwritten) is moved aside to the backup
/// FIRST, so any later failure puts it back with the rest; on success it goes
/// with the staging dir. Returns the written files and the removed file names.
pub fn commit_replacing(
    staged_output: &Path,
    final_output: &Path,
    stale: &[PathBuf],
) -> Result<(Vec<WrittenFile>, Vec<String>), String> {
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
    let mut removed: Vec<String> = Vec::new();
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

    // Stale siblings LAST, once every new file is in place, into `.removed/`
    // (NOT `.backup/`): the in-process rollback below puts them back on a
    // failure, but the crash sweep (`sweep_stale_staging`) only restores
    // `.backup/` and deletes `.removed/` with the leftover dir, so a file
    // removed on purpose never comes back after a crash. Moving them last
    // means a crash can at worst leave some old files behind, never lose the
    // previous set before the new one is written.
    if failure.is_none() {
        let removed_dir = staged_output.parent().unwrap_or(staged_output).join(".removed");
        for rel in stale.iter().filter(|r| !rels.contains(r)) {
            let in_output = rel.components().all(|c| matches!(c, std::path::Component::Normal(_)));
            let dst = final_output.join(rel);
            let plain_file = std::fs::symlink_metadata(&dst)
                .map(|m| m.file_type().is_file())
                .unwrap_or(false);
            if !in_output || !plain_file {
                continue;
            }
            let b = removed_dir.join(rel);
            let moved = b
                .parent()
                .map_or(Ok(()), std::fs::create_dir_all)
                .and_then(|_| std::fs::rename(&dst, &b));
            match moved {
                Ok(()) => {
                    placed.push((dst, Some(b)));
                    removed.push(
                        rel.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                    );
                }
                Err(e) => {
                    failure = Some(format!("Failed to remove the previous file {}: {e}", dst.display()));
                    break;
                }
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

    let files = rels
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
        .collect();
    Ok((files, removed))
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
    finalize_replacing(staging, output_dir, outcome, warnings, &[])
}

/// What "Mark complete" uses: [`finalize_with`] that also removes the model's
/// previous files ([`stale_model_files`] of `req`) in the same all-or-nothing
/// commit. A refused / failed export removes nothing.
pub fn finalize_export(
    staging: Staging,
    output_dir: &Path,
    outcome: Result<(), CoreError>,
    warnings: Vec<String>,
    req: &ModelFilesRequest,
) -> Result<ModelFilesResult, String> {
    let stale = if outcome.is_ok() { stale_model_files(req, output_dir) } else { Vec::new() };
    finalize_replacing(staging, output_dir, outcome, warnings, &stale)
}

fn finalize_replacing(
    staging: Staging,
    output_dir: &Path,
    outcome: Result<(), CoreError>,
    warnings: Vec<String>,
    stale: &[PathBuf],
) -> Result<ModelFilesResult, String> {
    let output_dir_s = output_dir.to_string_lossy().into_owned();
    match outcome {
        Err(CoreError::Validation(issues)) => Ok(ModelFilesResult {
            ok: false,
            files: Vec::new(),
            output_dir: output_dir_s,
            validation: issues,
            warnings: Vec::new(),
            removed: Vec::new(),
        }),
        Err(CoreError::Other(e)) => Err(e),
        Ok(()) => {
            let (files, removed) = commit_replacing(&staging.output_dir(), output_dir, stale)?;
            Ok(ModelFilesResult {
                ok: true,
                files,
                output_dir: output_dir_s,
                validation: Vec::new(),
                warnings,
                removed,
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
    // Malformed test periods are refused here, before anything is created.
    if let Some(refused) = refuse_bad_test_periods(req, data, app_data)? {
        return Ok(refused);
    }
    let dirs = prepare_workspace(app_data, &req.workspace_id)?;
    let staging = Staging::create(&dirs.ws_dir)?;
    let save_path = staging.root().to_string_lossy().into_owned();
    // An absent set-point object is "nothing entered": refused as `required`,
    // never written as nulls.
    let empty = SetPointsArg::default();
    let sp = Some(req.set_points.as_ref().unwrap_or(&empty));

    let written: Result<String, CoreError> = match req.kind.as_str() {
        "individual" => crate::write_individual_info(
            data,
            need(&req.target, "target")?.to_string(),
            req.model_name.clone(),
            &save_path,
            req.filter.clone(),
            sp,
        )
        .map(|i| i.saved_path),
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
        .map(|i| i.saved_path),
    };
    // Train/Test validation: added to the staged INFO file, so it is committed
    // (or discarded) together with it.
    let outcome: Result<(), CoreError> = written.and_then(|info_path| {
        if !req.tests_requested() {
            return Ok(());
        }
        let block = individual_or_clustering_block(data, req)?;
        health_validation::inject_validation(Path::new(&info_path), block)?;
        Ok(())
    });
    let warnings = overwrite_warnings(req, &dirs.output_dir);
    finalize_export(staging, &dirs.output_dir, outcome, warnings, req)
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
            removed: vec!["REL_INFO_old_T.json".into()],
        };
        let j = serde_json::to_value(&res).unwrap();
        assert_eq!(j["ok"], true);
        assert_eq!(j["files"][0]["kind"], "info");
        assert_eq!(j["files"][0]["file_name"], "a.json");
        assert_eq!(j["output_dir"], "/p");
        assert_eq!(j["removed"][0], "REL_INFO_old_T.json");
    }

    // ---------- orphaned staging sweep ----------

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

    // ---------- sensor names as file names ----------

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

    // ---------- overwriting another model's file ----------

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

    // ---------- stale siblings / remove_model_files ----------

    fn rel_req(target: &str, preds: &[&str]) -> ModelFilesRequest {
        ModelFilesRequest {
            kind: "relationship".into(),
            workspace_id: "ws".into(),
            target: Some(target.into()),
            predictors: preds.iter().map(|p| p.to_string()).collect(),
            ..Default::default()
        }
    }

    fn rel_set(dir: &Path, tok: &str, target: &str, body: &str) {
        for (p, ext) in [("REL_DATASET", "csv"), ("REL_INFO", "json"), ("REL_MODEL", "pkl")] {
            write(&dir.join(target).join(format!("{p}_{tok}_{target}.{ext}")), body);
        }
    }

    fn names_in(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    /// Same folder `B`: another kind's files, a file of target `AB` (same
    /// ending), an empty-middle name and a stray file — none is the model's.
    fn neighbours(out: &Path) {
        write(&out.join("B").join("INDV_INFO_B.json"), "indv");
        write(&out.join("B").join("CLUS_INFO_X_B.json"), "clus");
        write(&out.join("B").join("REL_INFO_P_AB.json"), "other target");
        write(&out.join("B").join("REL_INFO__B.json"), "empty middle");
        write(&out.join("B").join("notes.txt"), "user");
        rel_set(out, "A", "AB", "target AB");
    }

    fn assert_neighbours_kept(out: &Path) {
        for f in ["INDV_INFO_B.json", "CLUS_INFO_X_B.json", "REL_INFO_P_AB.json", "REL_INFO__B.json", "notes.txt"] {
            assert!(out.join("B").join(f).is_file(), "{f} must be kept");
        }
        assert_eq!(names_in(&out.join("AB")).len(), 3, "the other target's folder is untouched");
    }

    #[test]
    fn is_model_file_is_anchored_on_prefix_and_exact_suffix() {
        assert!(is_model_file("relationship", "B", "B", "REL_INFO_A+C_B.json"));
        assert!(is_model_file("relationship", "B", "B", "REL_MODEL_A_B.pkl"));
        assert!(is_model_file("relationship", "B", "B", "REL_DATASET_A_B.csv"));
        assert!(is_model_file("relationship", "B", "B", "REL_INFO_P_Q_B.json"), "underscored predictor");
        assert!(!is_model_file("relationship", "B", "B", "REL_INFO_A_AB.json"), "target AB, not B");
        assert!(!is_model_file("relationship", "B", "B", "REL_INFO_A_B.pkl"), "wrong extension");
        assert!(!is_model_file("relationship", "B", "B", "REL_INFO__B.json"), "empty middle");
        assert!(!is_model_file("relationship", "B", "B", "XREL_INFO_A_B.json"));
        assert!(!is_model_file("relationship", "B", "B", "CLUS_INFO_A_B.json"));
        assert!(!is_model_file("relationship", "B", "C", "REL_INFO_A_B.json"), "only in its own folder");
        // Clustering: identity = first sensor, the folder is the exact suffix.
        assert!(is_model_file("clustering", "X", "Y", "CLUS_INFO_X_Y.json"));
        assert!(!is_model_file("clustering", "Y", "Y", "CLUS_INFO_X_Y.json"), "y is not the identity");
        assert!(!is_model_file("clustering", "A", "T", "CLUS_INFO_AB_T.json"), "first AB, not A");
        assert!(!is_model_file("clustering", "A", "T", "CLUS_INFO_A_B_T.json"), "first A_B (folder T)");
        assert!(is_model_file("clustering", "A_B", "T", "CLUS_INFO_A_B_T.json"));
        assert!(is_model_file("clustering", "A", "B_T", "CLUS_INFO_A_B_T.json"), "first A, folder B_T");
        assert!(!is_model_file("clustering", "X", "Y", "CLUS_INFO_X_XY.json"));
        assert!(is_model_file("individual", "S", "S", "INDV_INFO_S.json"));
        assert!(!is_model_file("individual", "S", "S", "INDV_INFO_XS.json"));
        assert!(!is_model_file("bogus", "S", "S", "INDV_INFO_S.json"));
    }

    #[test]
    fn relationship_reexport_with_other_predictors_replaces_the_old_set_only() {
        let d = tmp();
        let w = prepare_workspace(d.path(), "ws").unwrap();
        let out = &w.output_dir;
        rel_set(out, "A", "B", "OLD");
        neighbours(out);
        let req = rel_req("B", &["C", "D"]);
        let st = Staging::create(&w.ws_dir).unwrap();
        rel_set(&st.output_dir(), "C+D", "B", "NEW");
        let res = finalize_export(st, out, Ok(()), Vec::new(), &req).unwrap();
        assert!(res.ok);
        assert_eq!(res.files.len(), 3);
        assert_eq!(res.removed, vec!["REL_DATASET_A_B.csv", "REL_INFO_A_B.json", "REL_MODEL_A_B.pkl"]);
        for (p, ext) in [("REL_DATASET", "csv"), ("REL_INFO", "json"), ("REL_MODEL", "pkl")] {
            assert!(!out.join("B").join(format!("{p}_A_B.{ext}")).exists());
            assert_eq!(fs::read_to_string(out.join("B").join(format!("{p}_C+D_B.{ext}"))).unwrap(), "NEW");
        }
        assert_neighbours_kept(out);
        // Nothing comes back with the next export's sweep: the backups went
        // with the staging dir.
        drop(Staging::create(&w.ws_dir).unwrap());
        assert!(!out.join("B").join("REL_INFO_A_B.json").exists());
    }

    #[test]
    fn reexporting_the_same_predictors_removes_nothing() {
        let d = tmp();
        let w = prepare_workspace(d.path(), "ws").unwrap();
        rel_set(&w.output_dir, "A", "B", "OLD");
        let st = Staging::create(&w.ws_dir).unwrap();
        rel_set(&st.output_dir(), "A", "B", "NEW");
        let res = finalize_export(st, &w.output_dir, Ok(()), Vec::new(), &rel_req("B", &["A"])).unwrap();
        assert!(res.removed.is_empty());
        assert_eq!(fs::read_to_string(w.output_dir.join("B").join("REL_INFO_A_B.json")).unwrap(), "NEW");
    }

    #[test]
    fn a_failing_export_leaves_the_old_set_exactly_in_place() {
        let d = tmp();
        let w = prepare_workspace(d.path(), "ws").unwrap();
        let out = &w.output_dir;
        rel_set(out, "A", "B", "OLD");
        neighbours(out);
        let req = rel_req("B", &["C"]);

        // 1. Refused (validation): nothing committed, nothing removed.
        let st = Staging::create(&w.ws_dir).unwrap();
        rel_set(&st.output_dir(), "C", "B", "NEW");
        let issue = vec![Issue {
            code: "required".into(),
            severity: crate::health_score::Severity::Error,
            message: "x".into(),
            field: "f".into(),
        }];
        let r = finalize_export(st, out, Err(CoreError::Validation(issue)), Vec::new(), &req).unwrap();
        assert!(!r.ok && r.removed.is_empty());

        // 2. A disk failure during the commit (Z exists as a FILE, so Z/y.json
        //    cannot be created) AFTER the stale set was moved aside.
        write(&out.join("Z"), "i am a file");
        let st = Staging::create(&w.ws_dir).unwrap();
        rel_set(&st.output_dir(), "C", "B", "NEW");
        write(&st.output_dir().join("Z").join("y.json"), "NEW-Z");
        let stale = stale_model_files(&req, out);
        assert_eq!(stale.len(), 3);
        let err = commit_replacing(&st.output_dir(), out, &stale).unwrap_err();
        assert!(err.contains("Failed to write") && err.contains("nothing was changed"), "{err}");
        drop(st);

        for (p, ext) in [("REL_DATASET", "csv"), ("REL_INFO", "json"), ("REL_MODEL", "pkl")] {
            assert_eq!(fs::read_to_string(out.join("B").join(format!("{p}_A_B.{ext}"))).unwrap(), "OLD");
            assert!(!out.join("B").join(format!("{p}_C_B.{ext}")).exists());
        }
        assert_neighbours_kept(out);
        assert_eq!(fs::read_to_string(out.join("Z")).unwrap(), "i am a file");
    }

    fn clus_data() -> crate::csv_processor::ColumnarData {
        use crate::csv_processor::ColumnarData;
        let n = 400;
        let ts: Vec<Option<String>> = (0..n).map(|i| Some(format!("2024-01-01T{:02}:{:02}:00", (i / 60) % 24, i % 60))).collect();
        let col = |f: &dyn Fn(usize) -> f64| (0..n).map(f).collect::<Vec<f64>>();
        ColumnarData::from_parts(
            vec!["timestamp".into(), "X".into(), "Y".into(), "W".into()],
            ts,
            vec![vec![f64::NAN; n], col(&|i| (i % 17) as f64), col(&|i| (i % 13) as f64 + 0.5 * (i % 5) as f64), col(&|i| (i % 11) as f64 * 1.5)],
        )
    }

    fn clus_req(first: &str, second: &str) -> ModelFilesRequest {
        ModelFilesRequest {
            kind: "clustering".into(),
            workspace_id: "ws".into(),
            first_sensor: Some(first.into()),
            second_sensor: Some(second.into()),
            n_clusters: Some(1),
            set_points: Some(SetPointsArg { outer_sd: Some(6.0), ..Default::default() }),
            ..Default::default()
        }
    }

    #[test]
    fn clustering_models_sharing_a_y_sensor_never_remove_each_other() {
        let data = clus_data();
        let app = tmp();
        let ydir = app.path().join("workspaces").join("ws").join("output").join("Y");
        // x=X,y=Y and x=W,y=Y are two different models in the same folder.
        let a = export_sync(&data, &clus_req("X", "Y"), app.path()).unwrap();
        assert!(a.ok && a.removed.is_empty(), "{:?}", a.validation);
        write(&ydir.join("INDV_INFO_Y.json"), "indv");
        write(&ydir.join("REL_INFO_P_Y.json"), "rel");
        let b = export_sync(&data, &clus_req("W", "Y"), app.path()).unwrap();
        assert!(b.ok, "{:?}", b.validation);
        assert!(b.removed.is_empty(), "{:?}", b.removed);
        // Re-exporting X (same y) removes nothing either.
        let a2 = export_sync(&data, &clus_req("X", "Y"), app.path()).unwrap();
        assert!(a2.ok && a2.removed.is_empty(), "{:?}", a2.removed);
        assert_eq!(
            names_in(&ydir),
            vec!["CLUS_INFO_W_Y.json", "CLUS_INFO_X_Y.json", "INDV_INFO_Y.json", "REL_INFO_P_Y.json"]
        );
    }

    #[test]
    fn clustering_reexport_with_another_y_removes_its_old_file_in_the_old_folder() {
        let data = clus_data();
        let app = tmp();
        let out = app.path().join("workspaces").join("ws").join("output");
        assert!(export_sync(&data, &clus_req("X", "Y"), app.path()).unwrap().ok);
        assert!(export_sync(&data, &clus_req("W", "Y"), app.path()).unwrap().ok);
        // Prefix traps in other folders: first `XX`, and first `X_Q` in folder Y
        // spelled so that a loose `CLUS_INFO_X_*` match would catch it.
        write(&out.join("Y").join("CLUS_INFO_XX_Y.json"), "first XX");
        write(&out.join("Q_Y").join("CLUS_INFO_X_Q_Y.json"), "first X, y Q_Y - its own");
        write(&out.join("Y").join("CLUS_INFO_X_Q_Y.json"), "first X_Q, y Y");
        // x=X now uses y=W: the file in Y/ (and X's file in Q_Y/) are its old ones.
        let r = export_sync(&data, &clus_req("X", "W"), app.path()).unwrap();
        assert!(r.ok, "{:?}", r.validation);
        let mut removed = r.removed.clone();
        removed.sort();
        assert_eq!(removed, vec!["CLUS_INFO_X_Q_Y.json", "CLUS_INFO_X_Y.json"]);
        assert!(!out.join("Q_Y").join("CLUS_INFO_X_Q_Y.json").exists());
        assert!(out.join("Q_Y").is_dir(), "the export leaves folders in place");
        assert_eq!(
            names_in(&out.join("Y")),
            vec!["CLUS_INFO_W_Y.json", "CLUS_INFO_XX_Y.json", "CLUS_INFO_X_Q_Y.json"]
        );
        assert_eq!(names_in(&out.join("W")), vec!["CLUS_INFO_X_W.json"]);
    }

    #[test]
    fn remove_model_files_removes_only_that_kinds_files() {
        let d = tmp();
        let out = d.path().join("workspaces").join("ws").join("output");
        rel_set(&out, "A", "B", "r1");
        rel_set(&out, "C+D", "B", "r2");
        neighbours(&out);
        assert_eq!(remove_model_files_in(d.path(), "ws", "relationship", "B").unwrap(), 6);
        assert_eq!(
            names_in(&out.join("B")),
            vec!["CLUS_INFO_X_B.json", "INDV_INFO_B.json", "REL_INFO_P_AB.json", "REL_INFO__B.json", "notes.txt"]
        );
        // Clustering is identified by its FIRST sensor (X), not the folder (B).
        assert_eq!(remove_model_files_in(d.path(), "ws", "clustering", "B").unwrap(), 0);
        assert_eq!(remove_model_files_in(d.path(), "ws", "clustering", "X").unwrap(), 1);
        assert_eq!(remove_model_files_in(d.path(), "ws", "individual", "B").unwrap(), 1);
        assert!(out.join("B").join("notes.txt").is_file(), "not a model file: kept, folder kept");
        assert_eq!(names_in(&out.join("AB")).len(), 3, "another target is never touched");
        // Again: nothing there is not an error.
        assert_eq!(remove_model_files_in(d.path(), "ws", "relationship", "B").unwrap(), 0);
    }

    #[test]
    fn remove_clustering_files_by_first_sensor_across_folders() {
        let d = tmp();
        let out = d.path().join("workspaces").join("ws").join("output");
        // x=A,y=T and x=B,y=T share T/; A also has a file under U/ (old y).
        write(&out.join("T").join("CLUS_INFO_A_T.json"), "A");
        write(&out.join("T").join("CLUS_INFO_B_T.json"), "B");
        write(&out.join("T").join("CLUS_INFO_AB_T.json"), "AB");
        write(&out.join("T").join("CLUS_INFO_A_B_T.json"), "first A_B");
        write(&out.join("U").join("CLUS_INFO_A_U.json"), "A old");
        assert_eq!(remove_model_files_in(d.path(), "ws", "clustering", "A").unwrap(), 2);
        assert_eq!(
            names_in(&out.join("T")),
            vec!["CLUS_INFO_AB_T.json", "CLUS_INFO_A_B_T.json", "CLUS_INFO_B_T.json"]
        );
        assert!(!out.join("U").exists(), "U/ became empty: removed");
        // The underscore name is the model x=A_B (folder T).
        assert_eq!(remove_model_files_in(d.path(), "ws", "clustering", "A_B").unwrap(), 1);
        assert_eq!(names_in(&out.join("T")), vec!["CLUS_INFO_AB_T.json", "CLUS_INFO_B_T.json"]);
        assert_eq!(remove_model_files_in(d.path(), "ws", "clustering", "A").unwrap(), 0);
    }

    #[test]
    fn remove_model_files_removes_the_folder_once_empty() {
        let d = tmp();
        let out = d.path().join("workspaces").join("ws").join("output");
        write(&out.join("S").join("INDV_INFO_S.json"), "x");
        write(&out.join("S").join("CLUS_INFO_X_S.json"), "x");
        assert_eq!(remove_model_files_in(d.path(), "ws", "individual", "S").unwrap(), 1);
        assert!(out.join("S").is_dir(), "the clustering file is still there");
        assert_eq!(remove_model_files_in(d.path(), "ws", "clustering", "X").unwrap(), 1);
        assert!(!out.join("S").exists(), "empty folder removed");
        assert!(out.is_dir(), "the output folder itself stays");
    }

    #[test]
    fn a_crash_after_a_successful_commit_never_brings_removed_files_back() {
        let d = tmp();
        let w = prepare_workspace(d.path(), "ws").unwrap();
        let out = &w.output_dir;
        rel_set(out, "A", "B", "OLD");
        let req = rel_req("B", &["C"]);
        let st = Staging::create(&w.ws_dir).unwrap();
        rel_set(&st.output_dir(), "C", "B", "NEW");
        let stale = stale_model_files(&req, out);
        let (_, removed) = commit_replacing(&st.output_dir(), out, &stale).unwrap();
        assert_eq!(removed.len(), 3);
        // Removed files are kept apart from overwrite backups.
        assert!(st.root().join(".removed").join("B").join("REL_INFO_A_B.json").is_file());
        assert!(!st.root().join(".backup").join("B").join("REL_INFO_A_B.json").exists());
        // Simulate the crash: the staging dir outlives the process (no Drop).
        let root = st.root().to_path_buf();
        lock_active().retain(|p| p != &root);
        std::mem::forget(st);
        // ...plus a real overwrite backup whose destination was lost.
        write(&root.join(".backup").join("B").join("lost.json"), "PREVIOUS");
        drop(Staging::create(&w.ws_dir).unwrap());
        assert!(!root.exists(), "the leftover dir is swept");
        assert_eq!(fs::read_to_string(out.join("B").join("lost.json")).unwrap(), "PREVIOUS");
        for (p, ext) in [("REL_DATASET", "csv"), ("REL_INFO", "json"), ("REL_MODEL", "pkl")] {
            assert!(!out.join("B").join(format!("{p}_A_B.{ext}")).exists(), "{p} stays removed");
            assert!(out.join("B").join(format!("{p}_C_B.{ext}")).is_file());
        }
    }

    #[test]
    fn a_failure_while_moving_stale_files_rolls_everything_back() {
        let d = tmp();
        let w = prepare_workspace(d.path(), "ws").unwrap();
        let out = &w.output_dir;
        rel_set(out, "A", "B", "OLD");
        let req = rel_req("B", &["C"]);
        let st = Staging::create(&w.ws_dir).unwrap();
        rel_set(&st.output_dir(), "C", "B", "NEW");
        let stale = stale_model_files(&req, out);
        // `.removed/B/REL_INFO_A_B.json` already exists as a non-empty DIR,
        // so moving that stale file there fails after the new set was placed.
        write(&st.root().join(".removed").join("B").join("REL_INFO_A_B.json").join("x"), "block");
        let err = commit_replacing(&st.output_dir(), out, &stale).unwrap_err();
        assert!(err.contains("Failed to remove the previous file") && err.contains("nothing was changed"), "{err}");
        drop(st);
        for (p, ext) in [("REL_DATASET", "csv"), ("REL_INFO", "json"), ("REL_MODEL", "pkl")] {
            assert_eq!(fs::read_to_string(out.join("B").join(format!("{p}_A_B.{ext}"))).unwrap(), "OLD");
            assert!(!out.join("B").join(format!("{p}_C_B.{ext}")).exists());
        }
    }

    #[test]
    fn remove_model_files_tries_every_file_and_names_the_failures() {
        let d = tmp();
        let out = d.path().join("workspaces").join("ws").join("output");
        // A directory carrying a model file's name is never a plain file, so
        // it is skipped (not an error) and the walk goes on to the next folder.
        write(&out.join("T").join("CLUS_INFO_A_T.json").join("inner"), "a dir, not a file");
        write(&out.join("U").join("CLUS_INFO_A_U.json"), "A");
        assert_eq!(remove_model_files_in(d.path(), "ws", "clustering", "A").unwrap(), 1);
        assert!(out.join("T").join("CLUS_INFO_A_T.json").is_dir(), "never a plain file: untouched");
        assert!(!out.join("U").exists());
        // Aggregation: all ok -> the count; any failure -> Err naming each.
        assert_eq!(removal_outcome(3, &[]), Ok(3));
        let e = removal_outcome(2, &["p/x.json: denied".into(), "p/y.pkl: in use".into()]).unwrap_err();
        assert!(e.contains("Failed to remove 2 file(s) (2 removed)"), "{e}");
        assert!(e.contains("p/x.json: denied") && e.contains("p/y.pkl: in use"), "{e}");
    }

    /// A real locked file (Windows: opened with no sharing, like Excel does):
    /// the other files are still removed and the error names the locked one.
    #[cfg(windows)]
    #[test]
    fn remove_model_files_goes_on_past_a_locked_file() {
        use std::os::windows::fs::OpenOptionsExt;
        let d = tmp();
        let out = d.path().join("workspaces").join("ws").join("output");
        rel_set(&out, "A", "B", "r");
        let locked = out.join("B").join("REL_INFO_A_B.json");
        let handle = fs::OpenOptions::new().read(true).share_mode(0).open(&locked).unwrap();
        let e = remove_model_files_in(d.path(), "ws", "relationship", "B").unwrap_err();
        assert!(e.contains("Failed to remove 1 file(s) (2 removed)"), "{e}");
        assert!(e.contains("REL_INFO_A_B.json"), "{e}");
        assert!(!out.join("B").join("REL_DATASET_A_B.csv").exists());
        assert!(!out.join("B").join("REL_MODEL_A_B.pkl").exists());
        assert!(out.join("B").is_dir(), "not empty: kept");
        drop(handle);
        assert_eq!(remove_model_files_in(d.path(), "ws", "relationship", "B").unwrap(), 1);
        assert!(!out.join("B").exists());
    }

    #[test]
    fn remove_model_files_with_nothing_there_is_ok_zero() {
        let d = tmp();
        // No workspace folder at all: nothing is created either.
        assert_eq!(remove_model_files_in(d.path(), "ws", "individual", "S").unwrap(), 0);
        assert!(!d.path().join("workspaces").exists());
    }

    #[test]
    fn remove_model_files_refuses_bad_input() {
        let d = tmp();
        let outside = d.path().join("workspaces").join("ws").join("x");
        write(&outside.join("INDV_INFO_x.json"), "keep");
        for (ws, kind, sensor) in [
            ("../evil", "individual", "S"),
            ("", "individual", "S"),
            ("ws", "bogus", "S"),
            ("ws", "", "S"),
            ("ws", "individual", "../x"),
            ("ws", "individual", ".."),
            ("ws", "individual", "a/b"),
            ("ws", "individual", "a\\b"),
            ("ws", "individual", ""),
        ] {
            let e = remove_model_files_in(d.path(), ws, kind, sensor).unwrap_err();
            assert!(e.starts_with("BAD_REQUEST:"), "{ws:?} {kind:?} {sensor:?}: {e}");
        }
        assert!(outside.join("INDV_INFO_x.json").is_file(), "../x never reaches the workspace folder");
    }
}
