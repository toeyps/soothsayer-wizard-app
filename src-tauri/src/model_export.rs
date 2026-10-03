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
// Staging + all-or-nothing commit
// ---------------------------------------------------------------------------

static STAGING_SEQ: AtomicU64 = AtomicU64::new(0);

/// A private scratch directory inside the workspace folder. Removed (with
/// everything in it, incl. backups) when dropped — success or failure.
pub struct Staging {
    root: PathBuf,
}

impl Staging {
    pub fn create(ws_dir: &Path) -> Result<Self, String> {
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
    }
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
/// aside to a backup (inside the staging dir); if any step fails every
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
    for (i, rel) in rels.iter().enumerate() {
        let src = staged_output.join(rel);
        let dst = final_output.join(rel);
        let step = (|| -> std::io::Result<Option<PathBuf>> {
            if let Some(parent) = dst.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut backup = None;
            if dst.exists() {
                std::fs::create_dir_all(&backup_dir)?;
                let b = backup_dir.join(i.to_string());
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
/// commits the staged files.
pub fn finalize(
    staging: Staging,
    output_dir: &Path,
    outcome: Result<(), CoreError>,
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
                warnings: Vec::new(),
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
    finalize(staging, &dirs.output_dir, outcome)
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
}
