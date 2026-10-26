//! "Export results": one folder per export holding `machine_info.json` plus
//! `models/<key>.json` + `models/<key>.csv` for every model of the workspace,
//! exactly as `docs/specs/WIZARD_OUTPUT_SPEC.md` v1.0 defines them.
//!
//! Everything here is testable without an `AppHandle`:
//!   - [`build_plan`] — the pure dry run over a loaded dataset: issues, the
//!     exact `machine_info` / model JSON, CSV columns, row counts, byte counts
//!     and a 6-row Peek. The write path builds its content with the SAME
//!     function, so what the dialog shows is what lands on disk.
//!   - [`plan_in`] — [`build_plan`] under the session read lock with the
//!     `NO_DATA` / `STALE_SESSION` guards (`plan_workspace_export`).
//!   - [`write_export`] — stage into a hidden folder next to the destination,
//!     self-check (spec §7), then rename to the first free `<folder>`,
//!     `<folder>_2` … `<folder>_99` (`export_workspace_results`). Any error or
//!     a cancel removes the staging folder; nothing else in the destination is
//!     ever touched.
//!   - [`ExportSlot`] — one export at a time + cancel by export id.
//!
//! Training rows: [`training_rows`] is THE row rule of Train (training scope
//! via `ResolvedFilter`, every model column finite, clustering with more than
//! one regime also a finite criteria value inside a range). The export then
//! drops rows without a timestamp, sorts by time (stable) and keeps the LAST
//! row of a repeated instant; both are counted and reported as warnings.
//!
//! Nothing trained leaves the Wizard (spec §1, §6): no fitted numbers, no
//! internal parameter values (the Relation model's stiffness is exported as a
//! profile NAME only), no method names in any key, file name or column.

use crate::csv_processor::{micros_to_naive, ColumnarData, TS_MISSING};
use crate::health_score::SetPointsArg;
use crate::{AppState, ClusterRange, PreviewFilter, ResolvedFilter, SessionStamp, STALE_SESSION_ERROR};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// Global event emitted after each model is written (payload built in lib.rs:
/// `{ export_id, workspace_id, written, total, model_key }`).
pub const PROGRESS_EVENT: &str = "workspace-export-progress";

const SCHEMA_VERSION: &str = "1.0";
const MACHINE_INFO_FILE: &str = "machine_info.json";
const MODELS_DIR: &str = "models";
const UNCATEGORIZED: &str = "Uncategorized";
/// How many data rows the CSV writer writes between two cancel checks.
const CANCEL_CHECK_ROWS: usize = 65_536;
/// Peek = header + this many data rows.
const PEEK_ROWS: usize = 6;
/// Highest `_N` suffix tried when `<folder>` already exists.
const MAX_FOLDER_SUFFIX: u32 = 99;
/// Same length as `exported_at` on disk (`YYYY-MM-DDTHH:MM:SS±HH:MM`), so the
/// plan's byte count of `machine_info.json` equals the written file's.
const EXPORTED_AT_PLACEHOLDER: &str = "0000-00-00T00:00:00+00:00";

// ---------------------------------------------------------------------------
// Request (snake_case wire, TS `src/types/export.ts`)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Deserialize)]
pub struct MachineArg {
    #[serde(default)]
    pub plant: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub tag: String,
    #[serde(default)]
    pub notes: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RunningStatusArg {
    #[serde(default)]
    pub sensor: String,
    pub stop_if_lower_than: f64,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SensorMetaArg {
    pub tag: String,
    /// The sensor's description (falls back to the tag when blank).
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub unit: String,
    /// Blank = "Uncategorized" (the rule lives here, not in the frontend).
    #[serde(default)]
    pub component: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct DerivedSensorArg {
    pub tag: String,
    #[serde(default)]
    pub how_to_build: String,
    /// RAW tags after expanding nested special sensors.
    #[serde(default)]
    pub source_tags: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct FailureGroupArg {
    pub no: i64,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub recommendation: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ExportModelSpec {
    pub id: String,
    /// `"individual"` | `"relationship"` | `"clustering"`; anything else is a
    /// malformed request (`BAD_REQUEST`).
    pub kind: String,
    #[serde(default)]
    pub display_name: String,
    /// `"performance"` | `"condition"` | null.
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub group_nos: Vec<i64>,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub predictors: Vec<String>,
    #[serde(default)]
    pub rel_stiffness: Option<f64>,
    #[serde(default)]
    pub x_sensor: Option<String>,
    #[serde(default)]
    pub y_sensor: Option<String>,
    #[serde(default)]
    pub n_clusters: Option<u32>,
    #[serde(default)]
    pub criteria_sensor: Option<String>,
    #[serde(default)]
    pub cluster_ranges: Option<Vec<ClusterRange>>,
    /// The SAME training scope Train sends.
    #[serde(default)]
    pub filter: Option<PreviewFilter>,
    #[serde(default)]
    pub set_points: SetPointsArg,
    #[serde(default)]
    pub training_note: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct WorkspaceExportRequest {
    pub workspace_id: String,
    #[serde(default)]
    pub expected_generation: Option<u64>,
    #[serde(default)]
    pub data_utc_offset_min: i32,
    #[serde(default)]
    pub machine: MachineArg,
    #[serde(default)]
    pub running_status: Option<RunningStatusArg>,
    #[serde(default)]
    pub sensor_meta: Vec<SensorMetaArg>,
    #[serde(default)]
    pub derived_sensors: Vec<DerivedSensorArg>,
    #[serde(default)]
    pub failure_groups: Vec<FailureGroupArg>,
    #[serde(default)]
    pub models: Vec<ExportModelSpec>,
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ExportIssue {
    pub code: &'static str,
    /// `"error"` | `"warning"`.
    pub severity: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_no: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    pub message: String,
}

impl ExportIssue {
    fn error(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(code, "error", message)
    }
    fn warning(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(code, "warning", message)
    }
    fn new(code: &'static str, severity: &'static str, message: impl Into<String>) -> Self {
        ExportIssue {
            code,
            severity,
            model_id: None,
            tag: None,
            group_no: None,
            field: None,
            message: message.into(),
        }
    }
    fn model(mut self, id: &str) -> Self {
        self.model_id = Some(id.to_string());
        self
    }
    fn tag(mut self, tag: &str) -> Self {
        self.tag = Some(tag.to_string());
        self
    }
    fn group(mut self, no: i64) -> Self {
        self.group_no = Some(no);
        self
    }
    fn field(mut self, field: &str) -> Self {
        self.field = Some(field.to_string());
        self
    }
    pub fn is_error(&self) -> bool {
        self.severity == "error"
    }
}

// ---------------------------------------------------------------------------
// Output shapes (typed, spec key order)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct MachineOut {
    pub tag: String,
    pub name: String,
    pub notes: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunningStatusOut {
    pub sensor: String,
    pub stop_if_lower_than: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SensorOut {
    pub tag: String,
    pub name: String,
    pub description: String,
    pub unit: String,
    pub component: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DerivedSensorOut {
    pub tag: String,
    pub name: String,
    pub unit: String,
    pub component: String,
    pub how_to_build: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FailureGroupOut {
    pub name: String,
    pub description: String,
    pub recommendation: String,
    pub models: Vec<String>,
}

/// `machine_info.json`. `exported_at` is `null` in the plan and the PC's local
/// time with its offset in the written file.
#[derive(Debug, Clone, Serialize)]
pub struct MachineInfo {
    pub schema_version: &'static str,
    pub exported_at: Option<String>,
    pub plant: String,
    pub machine: MachineOut,
    pub running_status: Option<RunningStatusOut>,
    pub components: Vec<String>,
    pub sensors: Vec<SensorOut>,
    pub derived_sensors: Vec<DerivedSensorOut>,
    pub failure_groups: Vec<FailureGroupOut>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LowHigh {
    pub low: Option<f64>,
    pub high: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TrainingDataOut {
    pub file: String,
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RelationshipHealth {
    pub warning: LowHigh,
    pub failure: LowHigh,
}

#[derive(Debug, Clone, Serialize)]
pub struct RelationshipJson {
    pub schema_version: &'static str,
    pub model_key: String,
    pub kind: &'static str,
    pub display_name: String,
    pub category: Option<&'static str>,
    pub component: String,
    pub output: String,
    pub inputs: Vec<String>,
    pub fit_profile: Option<&'static str>,
    pub health: RelationshipHealth,
    pub training_data: TrainingDataOut,
}

#[derive(Debug, Clone, Serialize)]
pub struct IndividualHealth {
    pub limits: LowHigh,
}

#[derive(Debug, Clone, Serialize)]
pub struct IndividualJson {
    pub schema_version: &'static str,
    pub model_key: String,
    pub kind: &'static str,
    pub display_name: String,
    pub category: Option<&'static str>,
    pub component: String,
    pub sensor: String,
    pub health: IndividualHealth,
    pub training_data: TrainingDataOut,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Regime {
    pub from: Option<f64>,
    pub to: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClusteringHealth {
    pub failure_distance: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClusteringJson {
    pub schema_version: &'static str,
    pub model_key: String,
    pub kind: &'static str,
    pub display_name: String,
    pub category: Option<&'static str>,
    pub component: String,
    pub x_sensor: String,
    pub y_sensor: String,
    pub criteria_sensor: Option<String>,
    pub regimes: Vec<Regime>,
    pub health: ClusteringHealth,
    pub training_data: TrainingDataOut,
}

/// One model's settings file, serialized as-is (no `serde_json::Value`, so the
/// spec's key order survives the trip to the frontend too).
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum ModelJson {
    Relationship(RelationshipJson),
    Individual(IndividualJson),
    Clustering(ClusteringJson),
}

#[derive(Debug, Clone, Serialize)]
pub struct PlannedModel {
    pub id: String,
    pub key: String,
    pub json: ModelJson,
    pub csv_columns: Vec<String>,
    pub rows: usize,
    /// `.json` + `.csv` bytes of this model.
    pub bytes: u64,
    /// Header + the first 6 CSV rows, exactly as written.
    pub peek: Vec<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceExportPlan {
    pub ok: bool,
    pub issues: Vec<ExportIssue>,
    pub machine_info: MachineInfo,
    pub models: Vec<PlannedModel>,
    pub total_rows: usize,
    pub total_bytes: u64,
    pub files: usize,
    pub rows_without_timestamp: usize,
    pub duplicate_instants_dropped: usize,
    pub uncategorized_tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceExportResult {
    /// Absolute path of the written folder (its name may end `_2` … `_99`).
    pub folder: String,
    pub files: usize,
    pub models: usize,
    pub rows: usize,
    pub bytes: u64,
    pub exported_at: String,
    pub warnings: Vec<String>,
}

/// Payload of [`PROGRESS_EVENT`].
#[derive(Debug, Clone, Serialize)]
pub struct ExportProgressEvent {
    pub export_id: String,
    pub workspace_id: String,
    pub written: usize,
    pub total: usize,
    pub model_key: String,
}

/// What the writer needs per model besides the public plan entry.
#[derive(Debug, Clone)]
struct ModelWork {
    col_idx: Vec<usize>,
    rows: Vec<u32>,
}

/// [`build_plan`]'s result: the public plan plus the per-model row lists the
/// writer uses (index-aligned with `plan.models`).
#[derive(Debug, Clone)]
pub struct BuiltPlan {
    pub plan: WorkspaceExportPlan,
    work: Vec<ModelWork>,
}

// ---------------------------------------------------------------------------
// Shared row rule
// ---------------------------------------------------------------------------

/// THE training-row rule of Train, in dataset order: the row passes the
/// training scope (`resolved`), every column in `cols` is finite and — when
/// `regimes` is given (clustering with more than one regime) — the criteria
/// value is finite and falls in a range under `health_score::assign_cluster`
/// (`min < v <= max`, outer edges open with two or more ranges — the same
/// rule as Train and the health score). A row inside two overlapping ranges
/// appears once.
pub(crate) fn training_rows(
    data: &ColumnarData,
    resolved: &ResolvedFilter,
    cols: &[usize],
    regimes: Option<(usize, &[ClusterRange])>,
) -> Vec<u32> {
    let noop = resolved.is_noop();
    let regimes = regimes.map(|(ci, ranges)| (ci, ClusterRange::bounds(ranges)));
    (0..data.n_rows())
        .into_par_iter()
        .filter(|&r| {
            if !noop && !resolved.keeps(data, r) {
                return false;
            }
            if !cols.iter().all(|&c| data.columns[c][r].is_finite()) {
                return false;
            }
            match &regimes {
                None => true,
                Some((ci, bounds)) => {
                    crate::health_score::assign_cluster(data.columns[*ci][r], bounds).is_some()
                }
            }
        })
        .map(|r| r as u32)
        .collect()
}

/// Drop rows without a timestamp, stable-sort by time and keep the LAST row of
/// a repeated instant. Returns `(rows, without_timestamp, duplicates_dropped)`.
fn order_by_time(data: &ColumnarData, rows: Vec<u32>) -> (Vec<u32>, usize, usize) {
    let before = rows.len();
    let mut kept: Vec<u32> = rows
        .into_iter()
        .filter(|&r| data.ts_parsed[r as usize] != TS_MISSING)
        .collect();
    let missing = before - kept.len();
    kept.sort_by_key(|&r| data.ts_parsed[r as usize]);
    let mut out: Vec<u32> = Vec::with_capacity(kept.len());
    let mut dups = 0usize;
    for r in kept {
        match out.last_mut() {
            Some(last) if data.ts_parsed[*last as usize] == data.ts_parsed[r as usize] => {
                *last = r;
                dups += 1;
            }
            _ => out.push(r),
        }
    }
    (out, missing, dups)
}

// ---------------------------------------------------------------------------
// Small rules
// ---------------------------------------------------------------------------

/// `[^A-Za-z0-9._-]` → `_` (spec §2.1).
/// A Windows reserved device name before the first dot (`CON`, `NUL.X`, ...)
/// gets a leading `_` so the key is always a usable file name.
pub(crate) fn sanitize_key_tag(tag: &str) -> String {
    let out: String = tag
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' })
        .collect();
    if is_windows_device_name(out.split('.').next().unwrap_or("")) {
        format!("_{out}")
    } else {
        out
    }
}

fn is_windows_device_name(stem: &str) -> bool {
    let u = stem.to_ascii_uppercase();
    if matches!(u.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    let b = u.as_bytes();
    b.len() == 4 && (u.starts_with("COM") || u.starts_with("LPT")) && (b'1'..=b'9').contains(&b[3])
}

/// Relation-model stiffness → profile NAME (spec §4.5; the number is never
/// exported). `None` = not one of the four profiles.
pub(crate) fn fit_profile(stiffness: Option<f64>) -> Option<&'static str> {
    let s = stiffness?;
    [(1_000.0, "very_loose"), (10_000.0, "loose"), (100_000.0, "standard"), (1_000_000.0, "strict")]
        .iter()
        .find(|(v, _)| *v == s)
        .map(|&(_, name)| name)
}

/// Clustering regimes for more than one range (spec §4.4): sorted by `min`,
/// contiguous on the INNER boundaries (`prev.max == next.min`), every inner
/// range non-empty. The first `from` and the last `to` are ALWAYS written as
/// null (open outer edges, 2026-10-20) whatever the stored value — the
/// Workbench's auto-divide stores the criteria's real data min/max there and
/// the UI cannot edit them; `assign_cluster` ignores them the same way.
/// `Err(())` = an inner gap, an overlap or a bad bound.
pub(crate) fn regimes_from_ranges(ranges: &[ClusterRange]) -> Result<Vec<Regime>, ()> {
    if ranges.len() < 2 {
        return Err(());
    }
    let finite = |b: Option<f64>| b.is_none_or(f64::is_finite);
    if !ranges.iter().all(|r| finite(r.min) && finite(r.max)) {
        return Err(());
    }
    let mut sorted: Vec<&ClusterRange> = ranges.iter().collect();
    sorted.sort_by(|a, b| {
        a.min
            .unwrap_or(f64::NEG_INFINITY)
            .partial_cmp(&b.min.unwrap_or(f64::NEG_INFINITY))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    for pair in sorted.windows(2) {
        match (pair[0].max, pair[1].min) {
            (Some(a), Some(b)) if a == b => {}
            _ => return Err(()),
        }
    }
    // Inner ranges must be non-empty; the outer ones only need their inner
    // edge (their stored outer edge is dropped).
    let last = sorted.len() - 1;
    for (i, r) in sorted.iter().enumerate() {
        if i == 0 || i == last {
            continue;
        }
        if let (Some(lo), Some(hi)) = (r.min, r.max) {
            if lo >= hi {
                return Err(());
            }
        }
    }
    Ok(sorted
        .iter()
        .enumerate()
        .map(|(i, r)| Regime {
            from: if i == 0 { None } else { r.min },
            to: if i == last { None } else { r.max },
        })
        .collect())
}

fn finite(v: Option<f64>) -> Option<f64> {
    v.filter(|x| x.is_finite())
}

/// Set-point ordering rules (spec §4.2–4.4). `None` = valid.
fn set_point_problem(kind: Kind, sp: &SetPointsArg) -> Option<&'static str> {
    match kind {
        Kind::Individual => match (finite(sp.lower), finite(sp.upper)) {
            (Some(l), Some(h)) if l < h => None,
            (Some(_), Some(_)) => Some("the low limit must be below the high limit"),
            _ => Some("both limits are required"),
        },
        Kind::Relationship => match (
            finite(sp.residual_at_0_lower),
            finite(sp.residual_at_80_lower),
            finite(sp.residual_at_80_upper),
            finite(sp.residual_at_0_upper),
        ) {
            (Some(fl), Some(wl), Some(wh), Some(fh)) => {
                if fl < wl && wl < 0.0 && 0.0 < wh && wh < fh {
                    None
                } else {
                    Some("must be failure low < warning low < 0 < warning high < failure high")
                }
            }
            _ => Some("all four values are required"),
        },
        Kind::Clustering => match finite(sp.outer_sd) {
            Some(n) if n > 3.0 => None,
            Some(_) => Some("the failure distance must be greater than 3"),
            None => Some("the failure distance is required"),
        },
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Relationship,
    Individual,
    Clustering,
}

impl Kind {
    fn parse(s: &str) -> Option<Kind> {
        match s {
            "relationship" => Some(Kind::Relationship),
            "individual" => Some(Kind::Individual),
            "clustering" => Some(Kind::Clustering),
            _ => None,
        }
    }
    fn letter(self) -> char {
        match self {
            Kind::Relationship => 'R',
            Kind::Individual => 'I',
            Kind::Clustering => 'C',
        }
    }
    fn name(self) -> &'static str {
        match self {
            Kind::Relationship => "relationship",
            Kind::Individual => "individual",
            Kind::Clustering => "clustering",
        }
    }
}

fn category_out(c: Option<&str>) -> Option<&'static str> {
    match c.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("performance") => Some("PERFORMANCE"),
        Some("condition") => Some("CONDITION"),
        _ => None,
    }
}

fn bad_request(msg: impl std::fmt::Display) -> String {
    format!("BAD_REQUEST: {msg}")
}

fn incomplete(id: &str, field: &str, message: &str) -> Box<ExportIssue> {
    Box::new(ExportIssue::error("model_incomplete", message).model(id).field(field))
}

fn required_tag<'a>(v: &'a Option<String>, field: &str, message: &str, id: &str) -> Result<&'a str, Box<ExportIssue>> {
    v.as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| incomplete(id, field, message))
}

/// `(CSV columns, key tag, regime criteria)` of one model, or the
/// `model_incomplete` issue that keeps it out of the plan.
fn model_columns(kind: Kind, m: &ExportModelSpec) -> Result<(Vec<String>, String, Option<String>), Box<ExportIssue>> {
    match kind {
        Kind::Relationship => {
            let target = required_tag(&m.target, "target", "Choose the output sensor", &m.id)?.to_string();
            if m.predictors.is_empty() || m.predictors.iter().any(|p| p.trim().is_empty()) {
                return Err(incomplete(&m.id, "predictors", "Add at least one input sensor"));
            }
            let mut cols = m.predictors.clone();
            cols.push(target.clone());
            Ok((cols, target, None))
        }
        Kind::Individual => {
            let target = required_tag(&m.target, "target", "Choose the sensor", &m.id)?.to_string();
            Ok((vec![target.clone()], target, None))
        }
        Kind::Clustering => {
            let x = required_tag(&m.x_sensor, "x_sensor", "Choose the X sensor", &m.id)?.to_string();
            let y = required_tag(&m.y_sensor, "y_sensor", "Choose the Y sensor", &m.id)?.to_string();
            let n = m.n_clusters.unwrap_or(0);
            if n == 0 {
                return Err(incomplete(&m.id, "n_clusters", "Set the number of clusters (at least 1)"));
            }
            let mut cols = vec![x.clone(), y.clone()];
            let criteria = if n > 1 {
                let c = required_tag(
                    &m.criteria_sensor,
                    "criteria_sensor",
                    "Choose the sensor that splits the clusters",
                    &m.id,
                )?
                .to_string();
                if c != x && c != y {
                    cols.push(c.clone());
                }
                Some(c)
            } else {
                None
            };
            Ok((cols, x, criteria))
        }
    }
}

/// ISO 8601 with the data's UTC offset: `YYYY-MM-DDTHH:MM:SS[.fff]±HH:MM`
/// (fraction only when non-zero, trailing zeros trimmed).
pub(crate) fn timestamp_text(us: i64, offset_min: i32) -> Option<String> {
    use chrono::Timelike;
    let dt = micros_to_naive(us)?;
    let mut s = dt.format("%Y-%m-%dT%H:%M:%S").to_string();
    let nanos = dt.nanosecond() % 1_000_000_000;
    if nanos != 0 {
        let frac = format!("{nanos:09}");
        s.push('.');
        s.push_str(frac.trim_end_matches('0'));
    }
    s.push_str(&offset_text(offset_min));
    Some(s)
}

fn offset_text(offset_min: i32) -> String {
    let sign = if offset_min < 0 { '-' } else { '+' };
    let a = offset_min.unsigned_abs();
    format!("{sign}{:02}:{:02}", a / 60, a % 60)
}

fn exported_at_now() -> String {
    chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, false)
}

// ---------------------------------------------------------------------------
// CSV writing (one writer for the byte count, the Peek and the file)
// ---------------------------------------------------------------------------

struct Counting<W> {
    inner: W,
    n: u64,
}

impl<W: Write> Write for Counting<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let k = self.inner.write(buf)?;
        self.n += k as u64;
        Ok(k)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

#[derive(Debug)]
enum CsvFail {
    Cancelled,
    Io(String),
}

/// Write the model's CSV to `w` and return `(bytes, inner writer)`. `peek`
/// (when given) receives the first [`PEEK_ROWS`] data rows' fields, exactly as
/// written. `cancel` is checked every [`CANCEL_CHECK_ROWS`] rows.
#[allow(clippy::too_many_arguments)]
fn write_csv<W: Write>(
    w: W,
    data: &ColumnarData,
    columns: &[String],
    model: &ModelWork,
    offset_min: i32,
    cancel: Option<&AtomicBool>,
    mut peek: Option<&mut Vec<Vec<String>>>,
) -> Result<(u64, W), CsvFail> {
    let io = |e: &dyn std::fmt::Display| CsvFail::Io(e.to_string());
    let mut wtr = csv::WriterBuilder::new()
        .terminator(csv::Terminator::Any(b'\n'))
        .from_writer(Counting { inner: w, n: 0 });
    let mut header = Vec::with_capacity(columns.len() + 1);
    header.push("TimeStamp");
    header.extend(columns.iter().map(String::as_str));
    wtr.write_record(&header).map_err(|e| io(&e))?;
    let mut field = String::new();
    for (i, &r) in model.rows.iter().enumerate() {
        if i % CANCEL_CHECK_ROWS == 0 && i > 0 && cancel.is_some_and(|c| c.load(Ordering::SeqCst)) {
            return Err(CsvFail::Cancelled);
        }
        let r = r as usize;
        let ts = timestamp_text(data.ts_parsed[r], offset_min)
            .ok_or_else(|| CsvFail::Io(format!("row {r} has no valid timestamp")))?;
        wtr.write_field(&ts).map_err(|e| io(&e))?;
        let mut fields: Option<Vec<String>> =
            peek.as_ref().filter(|p| p.len() < PEEK_ROWS).map(|_| vec![ts.clone()]);
        for &c in &model.col_idx {
            field.clear();
            use std::fmt::Write as _;
            let _ = write!(field, "{}", data.columns[c][r]);
            wtr.write_field(&field).map_err(|e| io(&e))?;
            if let Some(f) = fields.as_mut() {
                f.push(field.clone());
            }
        }
        wtr.write_record(None::<&[u8]>).map_err(|e| io(&e))?;
        if let (Some(p), Some(f)) = (peek.as_deref_mut(), fields) {
            p.push(f);
        }
    }
    let counting = wtr.into_inner().map_err(|e| io(&e.error().to_string()))?;
    Ok((counting.n, counting.inner))
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/// The pure dry run over `data` (see the module doc). `derived` = the
/// session's set of special-sensor name keys. `Err` only for a malformed
/// request (`BAD_REQUEST: …`); every user-fixable problem is an issue.
pub fn build_plan(
    data: &ColumnarData,
    derived: &HashSet<String>,
    req: &WorkspaceExportRequest,
) -> Result<BuiltPlan, String> {
    let mut issues: Vec<ExportIssue> = Vec::new();
    let has_col = |tag: &str| data.headers.iter().skip(1).any(|h| h == tag);
    let col_of = |tag: &str| data.headers.iter().skip(1).position(|h| h == tag).map(|i| i + 1);

    // ---- machine / offset ----
    for (field, value) in [
        ("plant", &req.machine.plant),
        ("name", &req.machine.name),
        ("tag", &req.machine.tag),
    ] {
        if value.trim().is_empty() {
            issues.push(
                ExportIssue::error("machine_missing", format!("Machine {field} is required"))
                    .field(field),
            );
        }
    }
    if !(-720..=840).contains(&req.data_utc_offset_min) {
        issues.push(ExportIssue::error(
            "offset_out_of_range",
            "The time zone offset must be between UTC-12:00 and UTC+14:00",
        ));
    }

    // ---- sensor metadata ----
    let meta: HashMap<&str, &SensorMetaArg> =
        req.sensor_meta.iter().map(|m| (m.tag.as_str(), m)).collect();
    let component_of = |tag: &str| -> String {
        meta.get(tag)
            .map(|m| m.component.trim())
            .filter(|c| !c.is_empty())
            .unwrap_or(UNCATEGORIZED)
            .to_string()
    };

    // ---- models ----
    if req.models.is_empty() {
        issues.push(ExportIssue::error("no_models", "There are no models to export"));
    }
    let mut seen_ids: HashSet<&str> = HashSet::new();
    let mut key_counters: HashMap<String, u32> = HashMap::new();
    let mut planned: Vec<PlannedModel> = Vec::new();
    let mut work: Vec<ModelWork> = Vec::new();
    let mut included: Vec<&ExportModelSpec> = Vec::new();
    let mut total_missing = 0usize;
    let mut total_dups = 0usize;

    for m in &req.models {
        if !seen_ids.insert(m.id.as_str()) {
            issues.push(
                ExportIssue::error("duplicate_model_id", "The same model appears twice").model(&m.id),
            );
            continue;
        }
        let kind = Kind::parse(&m.kind)
            .ok_or_else(|| bad_request(format!("model '{}': unknown kind '{}'", m.id, m.kind)))?;

        // Columns in CSV order + the key tag + the regime criteria. An
        // unfinished model (normal while a project is being set up) is a
        // per-model error issue and is left out of the plan, never a
        // BAD_REQUEST for the whole request.
        let (columns, key_tag, criteria) = match model_columns(kind, m) {
            Ok(v) => v,
            Err(issue) => {
                issues.push(*issue);
                continue;
            }
        };
        if kind == Kind::Relationship && m.predictors.iter().any(|p| p.trim() == key_tag) {
            issues.push(
                ExportIssue::error("input_equals_output", "An input sensor cannot also be the output sensor")
                    .model(&m.id)
                    .field("predictors")
                    .tag(&key_tag),
            );
        }
        if kind == Kind::Clustering && columns[0] == columns[1] {
            issues.push(
                ExportIssue::error("x_equals_y", "The X and Y sensors must be different")
                    .model(&m.id)
                    .field("y_sensor")
                    .tag(&columns[0]),
            );
        }

        // Key (spec §2.1): `<target_tag>-<R|I|C><n>`, target_tag = `output` /
        // `sensor` / `y_sensor` — for clustering the Y sensor, even though the
        // model belongs to (and takes its component from) the X sensor.
        let stem_tag = if kind == Kind::Clustering { &columns[1] } else { &key_tag };
        let stem = format!("{}-{}", sanitize_key_tag(stem_tag), kind.letter());
        let counter = key_counters.entry(stem.clone()).or_insert(0);
        *counter += 1;
        let key = format!("{stem}{counter}");

        // Per-model issues.
        let mut unknown = false;
        let mut referenced: Vec<&str> = columns.iter().map(String::as_str).collect();
        if let Some(c) = &criteria {
            if !referenced.contains(&c.as_str()) {
                referenced.push(c);
            }
        }
        for tag in &referenced {
            if !has_col(tag) {
                unknown = true;
                issues.push(
                    ExportIssue::error("unknown_sensor", format!("Sensor {tag} is not in the loaded data"))
                        .model(&m.id)
                        .tag(tag),
                );
            }
        }
        let category = category_out(m.category.as_deref());
        if category.is_none() {
            issues.push(
                ExportIssue::error("category_missing", "Choose Performance or Condition")
                    .model(&m.id)
                    .field("category"),
            );
        }
        if let Some(problem) = set_point_problem(kind, &m.set_points) {
            issues.push(
                ExportIssue::error("set_points_invalid", format!("Health set points: {problem}"))
                    .model(&m.id)
                    .field("set_points"),
            );
        }
        let profile = if kind == Kind::Relationship {
            let p = fit_profile(m.rel_stiffness);
            if p.is_none() {
                issues.push(
                    ExportIssue::error("fit_profile_unknown", "The fit stiffness is not one of the four profiles")
                        .model(&m.id)
                        .field("rel_stiffness"),
                );
            }
            p
        } else {
            None
        };
        let regimes: Vec<Regime> = if kind == Kind::Clustering && criteria.is_some() {
            let ranges = m.cluster_ranges.as_deref().unwrap_or(&[]);
            let n = m.n_clusters.unwrap_or(0) as usize;
            match regimes_from_ranges(ranges) {
                Ok(r) if ranges.len() == n => r,
                _ => {
                    issues.push(
                        ExportIssue::error("regimes_not_contiguous", "Cluster ranges must meet end to end")
                            .model(&m.id)
                            .field("cluster_ranges"),
                    );
                    ranges.iter().map(|r| Regime { from: r.min, to: r.max }).collect()
                }
            }
        } else {
            vec![Regime { from: None, to: None }]
        };

        // Rows.
        let (col_idx, rows) = if unknown {
            (Vec::new(), Vec::new())
        } else {
            let col_idx: Vec<usize> = columns.iter().map(|t| col_of(t).unwrap_or(0)).collect();
            let resolved = match ResolvedFilter::resolve(m.filter.as_ref(), &data.headers) {
                Ok(r) => r,
                Err(e) => {
                    issues.push(
                        ExportIssue::error("bad_training_scope", format!("The training scope cannot be used: {e}"))
                            .model(&m.id)
                            .field("filter"),
                    );
                    continue;
                }
            };
            let crit = criteria.as_deref().and_then(col_of);
            let ranges = m.cluster_ranges.as_deref().unwrap_or(&[]);
            let selected = training_rows(data, &resolved, &col_idx, crit.map(|ci| (ci, ranges)));
            let (rows, missing, dups) = order_by_time(data, selected);
            if missing > 0 {
                total_missing += missing;
                issues.push(
                    ExportIssue::warning(
                        "rows_without_timestamp",
                        format!("{missing} row(s) without a timestamp were left out"),
                    )
                    .model(&m.id),
                );
            }
            if dups > 0 {
                total_dups += dups;
                issues.push(
                    ExportIssue::warning(
                        "duplicate_instants_dropped",
                        format!("{dups} row(s) with a repeated timestamp were left out (the last one is kept)"),
                    )
                    .model(&m.id),
                );
            }
            if rows.is_empty() {
                issues.push(
                    ExportIssue::error("no_training_rows", "No rows remain in the training data").model(&m.id),
                );
            }
            (col_idx, rows)
        };

        // JSON.
        let training_data = TrainingDataOut { file: format!("{key}.csv"), note: m.training_note.clone() };
        let display_name = m.display_name.trim().to_string();
        let component = component_of(&key_tag);
        let sp = &m.set_points;
        let json = match kind {
            Kind::Relationship => ModelJson::Relationship(RelationshipJson {
                schema_version: SCHEMA_VERSION,
                model_key: key.clone(),
                kind: kind.name(),
                display_name,
                category,
                component,
                output: key_tag.clone(),
                inputs: m.predictors.clone(),
                fit_profile: profile,
                health: RelationshipHealth {
                    warning: LowHigh { low: sp.residual_at_80_lower, high: sp.residual_at_80_upper },
                    failure: LowHigh { low: sp.residual_at_0_lower, high: sp.residual_at_0_upper },
                },
                training_data,
            }),
            Kind::Individual => ModelJson::Individual(IndividualJson {
                schema_version: SCHEMA_VERSION,
                model_key: key.clone(),
                kind: kind.name(),
                display_name,
                category,
                component,
                sensor: key_tag.clone(),
                health: IndividualHealth { limits: LowHigh { low: sp.lower, high: sp.upper } },
                training_data,
            }),
            Kind::Clustering => ModelJson::Clustering(ClusteringJson {
                schema_version: SCHEMA_VERSION,
                model_key: key.clone(),
                kind: kind.name(),
                display_name,
                category,
                component,
                x_sensor: columns[0].clone(),
                y_sensor: columns[1].clone(),
                criteria_sensor: criteria.clone(),
                regimes,
                health: ClusteringHealth { failure_distance: sp.outer_sd },
                training_data,
            }),
        };

        let mw = ModelWork { col_idx, rows };
        let json_bytes = serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?.len() as u64;
        let mut peek_rows: Vec<Vec<String>> = Vec::new();
        let csv_bytes = if unknown {
            0
        } else {
            write_csv(std::io::sink(), data, &columns, &mw, req.data_utc_offset_min, None, Some(&mut peek_rows))
                .map(|(n, _)| n)
                .map_err(|e| format!("CSV size: {e:?}"))?
        };
        let mut peek = Vec::with_capacity(peek_rows.len() + 1);
        let mut header = vec!["TimeStamp".to_string()];
        header.extend(columns.iter().cloned());
        peek.push(header);
        peek.extend(peek_rows);

        planned.push(PlannedModel {
            id: m.id.clone(),
            key,
            json,
            csv_columns: columns,
            rows: mw.rows.len(),
            bytes: json_bytes + csv_bytes,
            peek,
        });
        work.push(mw);
        included.push(m);
    }

    // ---- display names unique (trimmed, case-insensitive; blank allowed) ----
    let mut name_count: HashMap<String, usize> = HashMap::new();
    for m in &included {
        let n = m.display_name.trim().to_lowercase();
        if !n.is_empty() {
            *name_count.entry(n).or_insert(0) += 1;
        }
    }
    for m in &included {
        let n = m.display_name.trim().to_lowercase();
        if name_count.get(&n).copied().unwrap_or(0) > 1 {
            issues.push(
                ExportIssue::error("display_name_duplicate", "Another model has the same name")
                    .model(&m.id)
                    .field("display_name"),
            );
        }
    }

    // ---- running status ----
    let running_status = match &req.running_status {
        Some(rs) if !rs.sensor.trim().is_empty() && rs.stop_if_lower_than.is_finite() => {
            if !has_col(&rs.sensor) {
                issues.push(
                    ExportIssue::error(
                        "running_status_sensor_unknown",
                        format!("Running-status sensor {} is not in the loaded data", rs.sensor),
                    )
                    .tag(&rs.sensor),
                );
            }
            Some(RunningStatusOut { sensor: rs.sensor.clone(), stop_if_lower_than: rs.stop_if_lower_than })
        }
        _ => {
            issues.push(ExportIssue::error(
                "running_status_missing",
                "Say when the machine is running (sensor and value)",
            ));
            None
        }
    };

    // ---- sensors / derived sensors ----
    let is_derived = |tag: &str| derived.contains(&crate::name_key(tag));
    let mut used: Vec<String> = Vec::new();
    for p in &planned {
        let mut push = |t: &str| {
            if !used.iter().any(|u| u == t) {
                used.push(t.to_string());
            }
        };
        for c in &p.csv_columns {
            push(c);
        }
        if let ModelJson::Clustering(cj) = &p.json {
            if let Some(c) = &cj.criteria_sensor {
                push(c);
            }
        }
    }
    if let Some(rs) = &running_status {
        if !used.iter().any(|u| u == &rs.sensor) {
            used.push(rs.sensor.clone());
        }
    }
    let mut raw_tags: Vec<String> = Vec::new();
    let mut derived_out: Vec<DerivedSensorOut> = Vec::new();
    let mut uncategorized: Vec<String> = Vec::new();
    let mut components: BTreeSet<String> = BTreeSet::new();
    let mut note_uncategorized = |tag: &str, component: &str, issues: &mut Vec<ExportIssue>| {
        if component == UNCATEGORIZED && !uncategorized.iter().any(|t| t == tag) {
            uncategorized.push(tag.to_string());
            issues.push(
                ExportIssue::warning("component_uncategorized", format!("{tag} has no component"))
                    .tag(tag),
            );
        }
    };
    let mut derived_seen: Vec<String> = Vec::new();
    for tag in &used {
        if !is_derived(tag) {
            if !raw_tags.contains(tag) {
                raw_tags.push(tag.clone());
            }
            continue;
        }
        if derived_seen.contains(tag) {
            continue;
        }
        derived_seen.push(tag.clone());
        let recipe = req
            .derived_sensors
            .iter()
            .find(|d| &d.tag == tag)
            .or_else(|| req.derived_sensors.iter().find(|d| crate::name_key(&d.tag) == crate::name_key(tag)));
        let how = recipe.map(|d| d.how_to_build.trim().to_string()).unwrap_or_default();
        if how.is_empty() {
            issues.push(
                ExportIssue::error("derived_recipe_missing", format!("Special sensor {tag} has no recipe"))
                    .tag(tag),
            );
        }
        if let Some(d) = recipe {
            for src in &d.source_tags {
                if is_derived(src) || raw_tags.contains(src) {
                    continue;
                }
                if !has_col(src) {
                    issues.push(
                        ExportIssue::error("unknown_sensor", format!("Sensor {src} is not in the loaded data"))
                            .tag(src),
                    );
                }
                raw_tags.push(src.clone());
            }
        }
        let component = component_of(tag);
        note_uncategorized(tag, &component, &mut issues);
        components.insert(component.clone());
        let name = meta
            .get(tag.as_str())
            .map(|m| m.name.trim())
            .filter(|n| !n.is_empty())
            .unwrap_or(tag)
            .to_string();
        let unit = meta.get(tag.as_str()).map(|m| m.unit.clone()).unwrap_or_default();
        derived_out.push(DerivedSensorOut { tag: tag.clone(), name, unit, component, how_to_build: how });
    }
    let mut sensors_out: Vec<SensorOut> = Vec::new();
    for tag in &raw_tags {
        let component = component_of(tag);
        note_uncategorized(tag, &component, &mut issues);
        components.insert(component.clone());
        let name = meta
            .get(tag.as_str())
            .map(|m| m.name.trim())
            .filter(|n| !n.is_empty())
            .unwrap_or(tag)
            .to_string();
        let unit = meta.get(tag.as_str()).map(|m| m.unit.clone()).unwrap_or_default();
        sensors_out.push(SensorOut { tag: tag.clone(), name, description: String::new(), unit, component });
    }
    for p in &planned {
        let c = match &p.json {
            ModelJson::Relationship(j) => &j.component,
            ModelJson::Individual(j) => &j.component,
            ModelJson::Clustering(j) => &j.component,
        };
        components.insert(c.clone());
    }

    // ---- failure groups (only groups with at least one exported model) ----
    let mut fg_out: Vec<FailureGroupOut> = Vec::new();
    let mut fg_seen: HashSet<i64> = HashSet::new();
    let mut fg_out_nos: Vec<i64> = Vec::new();
    for fg in &req.failure_groups {
        if !fg_seen.insert(fg.no) {
            continue;
        }
        let models: Vec<String> = included
            .iter()
            .zip(&planned)
            .filter(|(m, _)| m.group_nos.contains(&fg.no))
            .map(|(_, p)| p.key.clone())
            .collect();
        if models.is_empty() {
            continue;
        }
        for (field, value) in [
            ("name", &fg.name),
            ("description", &fg.description),
            ("recommendation", &fg.recommendation),
        ] {
            if value.trim().is_empty() {
                issues.push(
                    ExportIssue::error("fg_text_missing", format!("Failure group {field} is required"))
                        .group(fg.no)
                        .field(field),
                );
            }
        }
        fg_out_nos.push(fg.no);
        fg_out.push(FailureGroupOut {
            name: fg.name.trim().to_string(),
            description: fg.description.trim().to_string(),
            recommendation: fg.recommendation.trim().to_string(),
            models,
        });
    }

    // ---- failure-group names unique among used groups (trimmed, case-insensitive) ----
    let mut fg_name_count: HashMap<String, usize> = HashMap::new();
    for fg in &fg_out {
        let n = fg.name.to_lowercase();
        if !n.is_empty() {
            *fg_name_count.entry(n).or_insert(0) += 1;
        }
    }
    for (fg, no) in fg_out.iter().zip(&fg_out_nos) {
        if fg_name_count.get(&fg.name.to_lowercase()).copied().unwrap_or(0) > 1 {
            issues.push(
                ExportIssue::error("fg_name_duplicate", "Another failure group has the same name")
                    .group(*no)
                    .field("name"),
            );
        }
    }

    let machine_info = MachineInfo {
        schema_version: SCHEMA_VERSION,
        exported_at: None,
        plant: req.machine.plant.trim().to_string(),
        machine: MachineOut {
            tag: req.machine.tag.trim().to_string(),
            name: req.machine.name.trim().to_string(),
            notes: req.machine.notes.trim().to_string(),
        },
        running_status,
        components: components.into_iter().collect(),
        sensors: sensors_out,
        derived_sensors: derived_out,
        failure_groups: fg_out,
    };
    let mi_bytes = machine_info_text(&machine_info, EXPORTED_AT_PLACEHOLDER)?.len() as u64;

    let total_rows = planned.iter().map(|p| p.rows).sum();
    let total_bytes = planned.iter().map(|p| p.bytes).sum::<u64>() + mi_bytes;
    let files = planned.len() * 2 + 1;
    let ok = !issues.iter().any(ExportIssue::is_error);
    Ok(BuiltPlan {
        plan: WorkspaceExportPlan {
            ok,
            issues,
            machine_info,
            models: planned,
            total_rows,
            total_bytes,
            files,
            rows_without_timestamp: total_missing,
            duplicate_instants_dropped: total_dups,
            uncategorized_tags: uncategorized,
        },
        work,
    })
}

fn machine_info_text(mi: &MachineInfo, exported_at: &str) -> Result<String, String> {
    let mut with_time = mi.clone();
    with_time.exported_at = Some(exported_at.to_string());
    serde_json::to_string_pretty(&with_time).map_err(|e| e.to_string())
}

fn no_session(expected: Option<u64>) -> String {
    match expected {
        Some(_) => STALE_SESSION_ERROR.to_string(),
        None => "NO_DATA: no dataset is loaded".to_string(),
    }
}

/// [`build_plan`] under the session read lock (`plan_workspace_export`).
pub fn plan_in(state: &AppState, req: &WorkspaceExportRequest) -> Result<WorkspaceExportPlan, String> {
    plan_with_stamp(state, req).map(|(b, _)| b.plan)
}

fn plan_with_stamp(state: &AppState, req: &WorkspaceExportRequest) -> Result<(BuiltPlan, SessionStamp), String> {
    let lock = state.0.read().map_err(|e| e.to_string())?;
    let session = lock.as_ref().ok_or_else(|| no_session(req.expected_generation))?;
    crate::check_expected_generation(req.expected_generation, session.generation)?;
    Ok((build_plan(&session.data, &session.derived, req)?, session.stamp()))
}

// ---------------------------------------------------------------------------
// Destination checks
// ---------------------------------------------------------------------------

/// `^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$`, not ending with `.`, not a reserved
/// Windows device name.
pub(crate) fn validate_folder_name(name: &str) -> Result<(), String> {
    let mut chars = name.chars();
    let first_ok = chars.next().is_some_and(|c| c.is_ascii_alphanumeric());
    let rest_ok = chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if !first_ok || !rest_ok || name.len() > 120 || name.ends_with('.') {
        return Err(bad_request(format!("invalid folder name '{name}'")));
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        return Err(bad_request(format!("invalid folder name '{name}'")));
    }
    Ok(())
}

/// `\\?\C:\x` → `C:\x` (canonicalize's verbatim form is not what the user or
/// the file manager expects). UNC verbatim paths are kept as they are.
fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        if rest.as_bytes().get(1) == Some(&b':') {
            return PathBuf::from(rest);
        }
    }
    p
}

fn validate_dest(dest_dir: &str) -> Result<PathBuf, String> {
    crate::validate_save_dir(dest_dir).map_err(|e| bad_request(format!("dest_dir: {e}")))?;
    let canon = std::fs::canonicalize(dest_dir).map_err(|e| bad_request(format!("dest_dir: {e}")))?;
    Ok(strip_verbatim(canon))
}

// ---------------------------------------------------------------------------
// Staging + write
// ---------------------------------------------------------------------------

static STAGING_SEQ: AtomicU64 = AtomicU64::new(0);

/// The hidden staging folder; removed on drop unless it was renamed.
struct Staging {
    path: PathBuf,
    done: bool,
}

impl Staging {
    fn create(dest: &Path, folder: &str) -> Result<Self, String> {
        let n = STAGING_SEQ.fetch_add(1, Ordering::SeqCst);
        let path = dest.join(format!(".{folder}.partial-{}-{n}", std::process::id()));
        std::fs::create_dir(&path).map_err(|e| write_failed("the export folder", &e))?;
        Ok(Staging { path, done: false })
    }
}

impl Drop for Staging {
    fn drop(&mut self) {
        if !self.done {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}

fn write_failed(what: &str, e: &dyn std::fmt::Display) -> String {
    format!("WRITE_FAILED: {what} ({e})")
}

const CANCELLED: &str = "CANCELLED: the export was cancelled";

/// Test hooks (fail at a model) — `Default` in the app.
#[derive(Debug, Default, Clone, Copy)]
struct Hooks {
    fail_before_model: Option<usize>,
}

/// Write the export (see the module doc). `progress(written, total, key)` is
/// called after each model. Errors: `BAD_REQUEST:` / `NO_DATA:` /
/// `STALE_SESSION:` / `NOT_READY: <n> problem(s)` / `CANCELLED:` /
/// `WRITE_FAILED:` — for all of them nothing is left in `dest_dir`.
pub fn write_export(
    state: &AppState,
    req: &WorkspaceExportRequest,
    dest_dir: &str,
    folder_name: &str,
    cancel: &AtomicBool,
    progress: impl Fn(usize, usize, &str),
) -> Result<WorkspaceExportResult, String> {
    write_export_with(state, req, dest_dir, folder_name, cancel, progress, Hooks::default())
}

fn write_export_with(
    state: &AppState,
    req: &WorkspaceExportRequest,
    dest_dir: &str,
    folder_name: &str,
    cancel: &AtomicBool,
    progress: impl Fn(usize, usize, &str),
    hooks: Hooks,
) -> Result<WorkspaceExportResult, String> {
    let dest = validate_dest(dest_dir)?;
    validate_folder_name(folder_name)?;
    let (built, stamp) = plan_with_stamp(state, req)?;
    let errors = built.plan.issues.iter().filter(|i| i.is_error()).count();
    if errors > 0 {
        return Err(format!("NOT_READY: {errors} problem(s)"));
    }
    let cancelled = || cancel.load(Ordering::SeqCst);
    if cancelled() {
        return Err(CANCELLED.into());
    }

    let mut staging = Staging::create(&dest, folder_name)?;
    let exported_at = exported_at_now();
    let mi_text = machine_info_text(&built.plan.machine_info, &exported_at)?;
    let mut bytes = mi_text.len() as u64;
    std::fs::write(staging.path.join(MACHINE_INFO_FILE), &mi_text)
        .map_err(|e| write_failed(MACHINE_INFO_FILE, &e))?;
    let models_dir = staging.path.join(MODELS_DIR);
    std::fs::create_dir(&models_dir).map_err(|e| write_failed(MODELS_DIR, &e))?;

    let total = built.plan.models.len();
    for (i, (pm, mw)) in built.plan.models.iter().zip(&built.work).enumerate() {
        if cancelled() {
            return Err(CANCELLED.into());
        }
        if hooks.fail_before_model == Some(i) {
            return Err(write_failed(&format!("models/{}.json", pm.key), &"simulated failure"));
        }
        let lock = state.0.read().map_err(|e| e.to_string())?;
        let session = lock.as_ref().ok_or_else(|| STALE_SESSION_ERROR.to_string())?;
        if session.stamp() != stamp {
            return Err(STALE_SESSION_ERROR.into());
        }
        let json_name = format!("{}.json", pm.key);
        let json_text = serde_json::to_string_pretty(&pm.json).map_err(|e| e.to_string())?;
        std::fs::write(models_dir.join(&json_name), &json_text)
            .map_err(|e| write_failed(&format!("models/{json_name}"), &e))?;
        let csv_name = format!("{}.csv", pm.key);
        let csv_path = models_dir.join(&csv_name);
        let file = std::fs::File::create(&csv_path)
            .map_err(|e| write_failed(&format!("models/{csv_name}"), &e))?;
        let (n, buf) = write_csv(
            std::io::BufWriter::new(file),
            &session.data,
            &pm.csv_columns,
            mw,
            req.data_utc_offset_min,
            Some(cancel),
            None,
        )
        .map_err(|e| match e {
            CsvFail::Cancelled => CANCELLED.to_string(),
            CsvFail::Io(msg) => write_failed(&format!("models/{csv_name}"), &msg),
        })?;
        buf.into_inner()
            .map_err(|e| write_failed(&format!("models/{csv_name}"), &e.error().to_string()))?
            .sync_all()
            .map_err(|e| write_failed(&format!("models/{csv_name}"), &e))?;
        drop(lock);
        bytes += json_text.len() as u64 + n;
        progress(i + 1, total, &pm.key);
    }
    if cancelled() {
        return Err(CANCELLED.into());
    }
    self_check(&staging.path, &built.plan).map_err(|e| write_failed("self-check", &e))?;

    // Rename to the first free name.
    let mut final_path: Option<PathBuf> = None;
    for k in 1..=MAX_FOLDER_SUFFIX {
        let name = if k == 1 { folder_name.to_string() } else { format!("{folder_name}_{k}") };
        let target = dest.join(&name);
        if std::fs::symlink_metadata(&target).is_ok() {
            continue;
        }
        match std::fs::rename(&staging.path, &target) {
            Ok(()) => {
                final_path = Some(target);
                break;
            }
            Err(_) if std::fs::symlink_metadata(&target).is_ok() => continue,
            Err(e) => return Err(write_failed("the export folder", &e)),
        }
    }
    let final_path = final_path.ok_or_else(|| {
        write_failed("the export folder", &format!("{folder_name} … {folder_name}_{MAX_FOLDER_SUFFIX} all exist"))
    })?;
    staging.done = true;

    Ok(WorkspaceExportResult {
        folder: final_path.to_string_lossy().into_owned(),
        files: built.plan.files,
        models: total,
        rows: built.plan.total_rows,
        bytes,
        exported_at,
        warnings: built
            .plan
            .issues
            .iter()
            .filter(|i| !i.is_error())
            .map(|i| i.message.clone())
            .collect(),
    })
}

/// Spec §7 on the staged folder: `machine_info.json` is there and parses,
/// every model has exactly its `.json` + `.csv` (key = stem, `model_key`
/// matches), nothing else is in `models/`, every model key a failure group
/// lists exists, every referenced tag is listed and every component is known.
fn self_check(root: &Path, plan: &WorkspaceExportPlan) -> Result<(), String> {
    let mi: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(root.join(MACHINE_INFO_FILE)).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let mut expected: BTreeSet<String> = BTreeSet::new();
    for m in &plan.models {
        expected.insert(format!("{}.json", m.key));
        expected.insert(format!("{}.csv", m.key));
    }
    let found: BTreeSet<String> = std::fs::read_dir(root.join(MODELS_DIR))
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
        .collect();
    if found != expected {
        return Err("models folder does not hold exactly one .json and one .csv per model".into());
    }
    let keys: HashSet<&str> = plan.models.iter().map(|m| m.key.as_str()).collect();
    let listed: HashSet<String> = plan
        .machine_info
        .sensors
        .iter()
        .map(|s| s.tag.clone())
        .chain(plan.machine_info.derived_sensors.iter().map(|s| s.tag.clone()))
        .collect();
    let components: HashSet<&str> = plan.machine_info.components.iter().map(String::as_str).collect();
    for m in &plan.models {
        let v: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(root.join(MODELS_DIR).join(format!("{}.json", m.key)))
                .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        if v["model_key"].as_str() != Some(m.key.as_str()) {
            return Err(format!("{}: model_key does not match the file name", m.key));
        }
        if !v["component"].as_str().is_some_and(|c| components.contains(c)) {
            return Err(format!("{}: component is not in components", m.key));
        }
        if let Some(t) = m.csv_columns.iter().find(|t| !listed.contains(*t)) {
            return Err(format!("{}: sensor {t} is not listed", m.key));
        }
    }
    if let Some(rs) = mi["running_status"]["sensor"].as_str() {
        if !listed.contains(rs) {
            return Err("running-status sensor is not listed".into());
        }
    }
    for s in plan.machine_info.sensors.iter().map(|s| &s.component).chain(
        plan.machine_info.derived_sensors.iter().map(|s| &s.component),
    ) {
        if !components.contains(s.as_str()) {
            return Err(format!("component {s} is not in components"));
        }
    }
    for fg in &plan.machine_info.failure_groups {
        if let Some(k) = fg.models.iter().find(|k| !keys.contains(k.as_str())) {
            return Err(format!("failure group lists unknown model {k}"));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// One export at a time + cancel
// ---------------------------------------------------------------------------

/// The running export (`export_id` + its cancel flag).
#[derive(Default)]
pub struct ExportSlot(Mutex<Option<(String, Arc<AtomicBool>)>>);

/// Held while an export runs; frees the slot on drop.
pub struct ExportGuard<'a> {
    slot: &'a ExportSlot,
    flag: Arc<AtomicBool>,
}

impl ExportGuard<'_> {
    pub fn cancel_flag(&self) -> Arc<AtomicBool> {
        self.flag.clone()
    }
}

impl Drop for ExportGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut s) = self.slot.0.lock() {
            *s = None;
        }
    }
}

impl ExportSlot {
    pub const fn new() -> Self {
        ExportSlot(Mutex::new(None))
    }

    /// Claim the slot for `export_id`; a second export while one runs is
    /// refused (`BAD_REQUEST`).
    pub fn begin(&self, export_id: &str) -> Result<ExportGuard<'_>, String> {
        if export_id.trim().is_empty() {
            return Err(bad_request("export_id is required"));
        }
        let mut s = self.0.lock().map_err(|e| e.to_string())?;
        if s.is_some() {
            return Err(bad_request("an export is already running"));
        }
        let flag = Arc::new(AtomicBool::new(false));
        *s = Some((export_id.to_string(), flag.clone()));
        Ok(ExportGuard { slot: self, flag })
    }

    /// Ask the running export `export_id` to stop. `false` = no such export.
    pub fn cancel(&self, export_id: &str) -> bool {
        match self.0.lock() {
            Ok(s) => match s.as_ref() {
                Some((id, flag)) if id == export_id => {
                    flag.store(true, Ordering::SeqCst);
                    true
                }
                _ => false,
            },
            Err(_) => false,
        }
    }
}

/// The app's one export slot.
pub static EXPORTS: ExportSlot = ExportSlot::new();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{clustering_preview_in, SessionData};
    use std::sync::RwLock;

    // ---- fixtures ----

    /// 20 rows at 5-minute steps from 2024-01-09 22:00; columns:
    /// A = i, B = 2i, C = i % 4 (criteria 0..3), Y = 10 + i, D = derived (A - B).
    fn data_with(ts: Vec<Option<String>>) -> ColumnarData {
        let n = ts.len();
        let a: Vec<f64> = (0..n).map(|i| i as f64).collect();
        let b: Vec<f64> = (0..n).map(|i| 2.0 * i as f64).collect();
        let c: Vec<f64> = (0..n).map(|i| (i % 4) as f64).collect();
        let y: Vec<f64> = (0..n).map(|i| 10.0 + i as f64).collect();
        let d: Vec<f64> = (0..n).map(|i| -(i as f64)).collect();
        ColumnarData::from_parts(
            ["timestamp", "A", "B", "C", "Y", "D", "Odd tag/1"].iter().map(|s| s.to_string()).collect(),
            ts,
            vec![vec![f64::NAN; n], a, b, c, y, d, vec![1.5; n]],
        )
    }

    fn minute_ts(n: usize) -> Vec<Option<String>> {
        (0..n)
            .map(|i| {
                let m = 22 * 60 + i * 5;
                Some(format!("2024-01-{:02}T{:02}:{:02}:00", 9 + m / 1440, (m / 60) % 24, m % 60))
            })
            .collect()
    }

    fn data() -> ColumnarData {
        data_with(minute_ts(20))
    }

    fn derived() -> HashSet<String> {
        HashSet::from(["d".to_string()])
    }

    fn state(data: ColumnarData, generation: u64) -> AppState {
        AppState(RwLock::new(Some(SessionData {
            data,
            paths: vec![],
            derived: derived(),
            generation,
            rel_cache: Default::default(),
        })))
    }

    fn meta(tag: &str, component: &str) -> SensorMetaArg {
        SensorMetaArg { tag: tag.into(), name: format!("{tag} description"), unit: "u".into(), component: component.into() }
    }

    fn rel(id: &str, target: &str, predictors: &[&str]) -> ExportModelSpec {
        ExportModelSpec {
            id: id.into(),
            kind: "relationship".into(),
            display_name: format!("Model {id}"),
            category: Some("performance".into()),
            group_nos: vec![1],
            target: Some(target.into()),
            predictors: predictors.iter().map(|s| s.to_string()).collect(),
            rel_stiffness: Some(100_000.0),
            set_points: SetPointsArg {
                residual_at_80_lower: Some(-4.0),
                residual_at_80_upper: Some(4.0),
                residual_at_0_lower: Some(-8.0),
                residual_at_0_upper: Some(8.0),
                ..Default::default()
            },
            training_note: "running only".into(),
            ..Default::default()
        }
    }

    fn ind(id: &str, target: &str) -> ExportModelSpec {
        ExportModelSpec {
            id: id.into(),
            kind: "individual".into(),
            display_name: format!("Model {id}"),
            category: Some("condition".into()),
            target: Some(target.into()),
            set_points: SetPointsArg { lower: Some(20.0), upper: Some(35.0), ..Default::default() },
            ..Default::default()
        }
    }

    fn clus(id: &str, x: &str, y: &str, criteria: Option<&str>, ranges: Option<Vec<ClusterRange>>) -> ExportModelSpec {
        ExportModelSpec {
            id: id.into(),
            kind: "clustering".into(),
            display_name: format!("Model {id}"),
            category: Some("condition".into()),
            x_sensor: Some(x.into()),
            y_sensor: Some(y.into()),
            n_clusters: Some(ranges.as_ref().map_or(1, |r| r.len() as u32)),
            criteria_sensor: criteria.map(str::to_string),
            cluster_ranges: ranges,
            set_points: SetPointsArg { outer_sd: Some(5.0), ..Default::default() },
            ..Default::default()
        }
    }

    fn rng(min: Option<f64>, max: Option<f64>) -> ClusterRange {
        ClusterRange { min, max }
    }

    fn request(models: Vec<ExportModelSpec>) -> WorkspaceExportRequest {
        WorkspaceExportRequest {
            workspace_id: "ws1".into(),
            expected_generation: None,
            data_utc_offset_min: 420,
            machine: MachineArg { plant: "Yadana".into(), name: "MP Train".into(), tag: "U-2010".into(), notes: "".into() },
            running_status: Some(RunningStatusArg { sensor: "A".into(), stop_if_lower_than: 1.0 }),
            sensor_meta: ["A", "B", "C", "Y", "D", "Odd tag/1"].iter().map(|t| meta(t, "Gas Generator")).collect(),
            derived_sensors: vec![DerivedSensorArg {
                tag: "D".into(),
                how_to_build: "A minus B".into(),
                source_tags: vec!["A".into(), "B".into()],
            }],
            failure_groups: vec![
                FailureGroupArg { no: 1, name: "FG one".into(), description: "desc".into(), recommendation: "rec".into() },
                FailureGroupArg { no: 2, name: "FG unused".into(), description: "d".into(), recommendation: "r".into() },
            ],
            models,
        }
    }

    fn plan(req: &WorkspaceExportRequest) -> WorkspaceExportPlan {
        build_plan(&data(), &derived(), req).unwrap().plan
    }

    fn codes(p: &WorkspaceExportPlan) -> Vec<&'static str> {
        p.issues.iter().map(|i| i.code).collect()
    }

    fn json_of(m: &PlannedModel) -> serde_json::Value {
        serde_json::to_value(&m.json).unwrap()
    }

    fn keys_in_order(m: &PlannedModel) -> Vec<String> {
        // serde_json::Value sorts keys; read the order from the pretty text.
        let text = serde_json::to_string_pretty(&m.json).unwrap();
        text.lines()
            .filter(|l| l.starts_with("  \"") && !l.starts_with("    "))
            .map(|l| l.trim().split('"').nth(1).unwrap().to_string())
            .collect()
    }

    // ---- keys ----

    #[test]
    fn keys_use_the_kind_letter_a_per_tag_counter_and_y_for_clustering() {
        let p = plan(&request(vec![
            rel("r1", "Y", &["A"]),
            ind("i1", "Y"),
            rel("r2", "Y", &["B"]),
            clus("c1", "A", "Y", None, None),
            ind("i2", "Odd tag/1"),
        ]));
        let keys: Vec<&str> = p.models.iter().map(|m| m.key.as_str()).collect();
        assert_eq!(keys, ["Y-R1", "Y-I1", "Y-R2", "Y-C1", "Odd_tag_1-I1"]);
    }

    #[test]
    fn sanitized_tags_that_collide_share_one_counter() {
        assert_eq!(sanitize_key_tag("A B(1)ก"), "A_B_1__");
        assert_eq!(sanitize_key_tag("ok.Tag_-1"), "ok.Tag_-1");
        let data = ColumnarData::from_parts(
            vec!["t".into(), "A B".into(), "A_B".into()],
            minute_ts(3),
            vec![vec![f64::NAN; 3], vec![1.0, 2.0, 3.0], vec![1.0, 2.0, 3.0]],
        );
        let mut req = request(vec![ind("1", "A B"), ind("2", "A_B")]);
        req.running_status = Some(RunningStatusArg { sensor: "A_B".into(), stop_if_lower_than: 0.0 });
        let p = build_plan(&data, &HashSet::new(), &req).unwrap().plan;
        let keys: Vec<&str> = p.models.iter().map(|m| m.key.as_str()).collect();
        assert_eq!(keys, ["A_B-I1", "A_B-I2"]);
    }

    // ---- JSON per kind ----

    #[test]
    fn relationship_json_has_every_field_in_spec_order() {
        let p = plan(&request(vec![rel("r1", "Y", &["A", "B"])]));
        let m = &p.models[0];
        assert_eq!(
            keys_in_order(m),
            ["schema_version", "model_key", "kind", "display_name", "category", "component", "output", "inputs", "fit_profile", "health", "training_data"]
        );
        let j = json_of(m);
        assert_eq!(j["schema_version"], "1.0");
        assert_eq!(j["model_key"], "Y-R1");
        assert_eq!(j["kind"], "relationship");
        assert_eq!(j["display_name"], "Model r1");
        assert_eq!(j["category"], "PERFORMANCE");
        assert_eq!(j["component"], "Gas Generator");
        assert_eq!(j["output"], "Y");
        assert_eq!(j["inputs"], serde_json::json!(["A", "B"]));
        assert_eq!(j["fit_profile"], "standard");
        assert_eq!(j["health"], serde_json::json!({"warning": {"low": -4.0, "high": 4.0}, "failure": {"low": -8.0, "high": 8.0}}));
        assert_eq!(j["training_data"], serde_json::json!({"file": "Y-R1.csv", "note": "running only"}));
        assert!(p.ok, "{:?}", p.issues);
    }

    #[test]
    fn individual_json_has_every_field_in_spec_order() {
        let p = plan(&request(vec![ind("i1", "Y")]));
        let m = &p.models[0];
        assert_eq!(
            keys_in_order(m),
            ["schema_version", "model_key", "kind", "display_name", "category", "component", "sensor", "health", "training_data"]
        );
        let j = json_of(m);
        assert_eq!(j["kind"], "individual");
        assert_eq!(j["category"], "CONDITION");
        assert_eq!(j["sensor"], "Y");
        assert_eq!(j["health"], serde_json::json!({"limits": {"low": 20.0, "high": 35.0}}));
        assert_eq!(j["training_data"], serde_json::json!({"file": "Y-I1.csv", "note": ""}));
    }

    #[test]
    fn clustering_json_one_regime() {
        let p = plan(&request(vec![clus("c1", "A", "Y", Some("C"), None)]));
        let m = &p.models[0];
        assert_eq!(
            keys_in_order(m),
            ["schema_version", "model_key", "kind", "display_name", "category", "component", "x_sensor", "y_sensor", "criteria_sensor", "regimes", "health", "training_data"]
        );
        let j = json_of(m);
        assert_eq!(j["kind"], "clustering");
        assert_eq!(j["x_sensor"], "A");
        assert_eq!(j["y_sensor"], "Y");
        assert_eq!(j["criteria_sensor"], serde_json::Value::Null, "one regime: no criteria");
        assert_eq!(j["regimes"], serde_json::json!([{"from": null, "to": null}]));
        assert_eq!(j["health"], serde_json::json!({"failure_distance": 5.0}));
        assert_eq!(m.csv_columns, ["A", "Y"]);
        assert_eq!(m.rows, 20);
    }

    #[test]
    fn clustering_json_three_regimes_sorted_with_open_outer_edges() {
        let ranges = vec![rng(Some(2.0), None), rng(None, Some(1.0)), rng(Some(1.0), Some(2.0))];
        let p = plan(&request(vec![clus("c1", "A", "Y", Some("C"), Some(ranges))]));
        let j = json_of(&p.models[0]);
        assert_eq!(j["criteria_sensor"], "C");
        assert_eq!(
            j["regimes"],
            serde_json::json!([{"from": null, "to": 1.0}, {"from": 1.0, "to": 2.0}, {"from": 2.0, "to": null}])
        );
        assert_eq!(p.models[0].csv_columns, ["A", "Y", "C"]);
        assert!(p.ok, "{:?}", p.issues);
    }

    #[test]
    fn clustering_regimes_with_a_gap_or_overlap_are_not_contiguous() {
        for ranges in [
            vec![rng(None, Some(1.0)), rng(Some(1.5), None)],         // gap
            vec![rng(None, Some(2.0)), rng(Some(1.0), None)],         // overlap
            vec![rng(Some(0.0), Some(1.0)), rng(Some(1.5), Some(3.0))],          // inner gap, finite outer edges
            vec![rng(None, Some(1.0)), rng(Some(1.0), Some(2.0)), rng(Some(2.5), None)], // gap between inner edges
            vec![rng(None, Some(1.0)), rng(Some(2.0), Some(1.5)), rng(Some(1.5), None)], // empty inner range
        ] {
            let p = plan(&request(vec![clus("c1", "A", "Y", Some("C"), Some(ranges.clone()))]));
            let issue = p.issues.iter().find(|i| i.code == "regimes_not_contiguous").expect("issue");
            assert_eq!(issue.message, "Cluster ranges must meet end to end");
            assert_eq!(issue.model_id.as_deref(), Some("c1"));
            assert!(!p.ok);
        }
    }

    #[test]
    fn clustering_outer_edges_are_written_open_whatever_is_stored() {
        // What the Workbench's auto-divide stores: the criteria's real data
        // [min, max] = [0, 3] as finite outer edges (2026-10-20 fix).
        for (ranges, want) in [
            (
                vec![rng(Some(0.0), Some(1.5)), rng(Some(1.5), Some(3.0))],
                serde_json::json!([{"from": null, "to": 1.5}, {"from": 1.5, "to": null}]),
            ),
            (
                // Stored out of order: sorted by min, outer edges still open.
                vec![rng(Some(2.0), Some(3.0)), rng(Some(0.0), Some(1.0)), rng(Some(1.0), Some(2.0))],
                serde_json::json!([{"from": null, "to": 1.0}, {"from": 1.0, "to": 2.0}, {"from": 2.0, "to": null}]),
            ),
        ] {
            let p = plan(&request(vec![clus("c1", "A", "Y", Some("C"), Some(ranges))]));
            assert!(!p.issues.iter().any(|i| i.code == "regimes_not_contiguous"), "{:?}", p.issues);
            let j = serde_json::to_value(&p.models[0].json).unwrap();
            assert_eq!(j["regimes"], want);
        }
    }

    #[test]
    fn training_rows_put_values_beyond_the_outer_edges_in_the_outer_clusters() {
        // C = i % 4 over 20 rows (values 0..3). Stored outer edges [0, 3] like
        // the auto-divide: C == 0 (the data minimum) is kept, as are values
        // beyond either outer edge; only an inner gap drops rows.
        let d = data();
        let resolved = ResolvedFilter::resolve(None, &d.headers).unwrap();
        let auto = [rng(Some(0.0), Some(1.5)), rng(Some(1.5), Some(3.0))];
        assert_eq!(training_rows(&d, &resolved, &[1, 4], Some((3, &auto))).len(), 20);
        let narrow = [rng(Some(1.0), Some(1.5)), rng(Some(1.5), Some(2.0))];
        assert_eq!(training_rows(&d, &resolved, &[1, 4], Some((3, &narrow))).len(), 20, "0 below, 3 above");
        let gap = [rng(None, Some(0.5)), rng(Some(1.5), None)]; // C == 1 falls in the gap
        assert_eq!(training_rows(&d, &resolved, &[1, 4], Some((3, &gap))).len(), 15);
        // Train (the clustering preview core) splits the same way.
        let p = clustering_preview_in(&d, "A".into(), "Y".into(), 2, Some("C".into()), Some(auto.to_vec()), None).unwrap();
        assert_eq!(p.clusters.iter().map(|c| c.n_rows).collect::<Vec<_>>(), [10, 10]);
    }

    #[test]
    fn clustering_with_criteria_equal_to_x_does_not_repeat_the_column() {
        let ranges = vec![rng(None, Some(9.0)), rng(Some(9.0), None)];
        let p = plan(&request(vec![clus("c1", "A", "Y", Some("A"), Some(ranges))]));
        assert_eq!(p.models[0].csv_columns, ["A", "Y"]);
        assert_eq!(p.models[0].peek[0], ["TimeStamp", "A", "Y"]);
    }

    #[test]
    fn fit_profile_maps_the_four_values_and_flags_anything_else() {
        assert_eq!(fit_profile(Some(1_000.0)), Some("very_loose"));
        assert_eq!(fit_profile(Some(10_000.0)), Some("loose"));
        assert_eq!(fit_profile(Some(100_000.0)), Some("standard"));
        assert_eq!(fit_profile(Some(1_000_000.0)), Some("strict"));
        assert_eq!(fit_profile(Some(5.0)), None);
        assert_eq!(fit_profile(None), None);
        let mut m = rel("r1", "Y", &["A"]);
        m.rel_stiffness = Some(42.0);
        let p = plan(&request(vec![m]));
        assert!(codes(&p).contains(&"fit_profile_unknown"));
        assert_eq!(json_of(&p.models[0])["fit_profile"], serde_json::Value::Null);
    }

    #[test]
    fn set_point_ordering_rules() {
        let bad_rel = [
            (-4.0, 4.0, -3.0, 8.0),  // failure low above warning low
            (1.0, 4.0, -8.0, 8.0),   // warning low not below 0
            (-4.0, 9.0, -8.0, 8.0),  // warning high above failure high
            (-4.0, 0.0, -8.0, 8.0),  // warning high not above 0
        ];
        for (wl, wh, fl, fh) in bad_rel {
            let mut m = rel("r1", "Y", &["A"]);
            m.set_points = SetPointsArg {
                residual_at_80_lower: Some(wl),
                residual_at_80_upper: Some(wh),
                residual_at_0_lower: Some(fl),
                residual_at_0_upper: Some(fh),
                ..Default::default()
            };
            assert!(codes(&plan(&request(vec![m]))).contains(&"set_points_invalid"), "{wl} {wh} {fl} {fh}");
        }
        let mut i = ind("i1", "Y");
        i.set_points.upper = Some(20.0);
        assert!(codes(&plan(&request(vec![i]))).contains(&"set_points_invalid"));
        let mut i = ind("i1", "Y");
        i.set_points.lower = Some(f64::NAN);
        assert!(codes(&plan(&request(vec![i]))).contains(&"set_points_invalid"));
        let mut c = clus("c1", "A", "Y", None, None);
        c.set_points.outer_sd = Some(3.0);
        assert!(codes(&plan(&request(vec![c]))).contains(&"set_points_invalid"));
        let mut c = clus("c1", "A", "Y", None, None);
        c.set_points.outer_sd = None;
        assert!(codes(&plan(&request(vec![c]))).contains(&"set_points_invalid"));
        assert!(plan(&request(vec![ind("i1", "Y"), rel("r1", "Y", &["A"]), clus("c1", "A", "Y", None, None)])).ok);
    }

    // ---- CSV ----

    #[test]
    fn csv_columns_follow_the_spec_order_per_kind() {
        let p = plan(&request(vec![rel("r1", "Y", &["B", "A"]), ind("i1", "Y")]));
        assert_eq!(p.models[0].csv_columns, ["B", "A", "Y"]);
        assert_eq!(p.models[0].peek[0], ["TimeStamp", "B", "A", "Y"]);
        assert_eq!(p.models[0].peek[1], ["2024-01-09T22:00:00+07:00", "0", "0", "10"]);
        assert_eq!(p.models[0].peek.len(), 7, "header + 6 rows");
        assert_eq!(p.models[1].csv_columns, ["Y"]);
    }

    #[test]
    fn timestamp_text_carries_the_offset_and_a_fraction_only_when_non_zero() {
        let us = crate::csv_processor::ts_to_micros(
            chrono::NaiveDate::from_ymd_opt(2024, 1, 9).unwrap().and_hms_opt(22, 5, 0).unwrap(),
        );
        assert_eq!(timestamp_text(us, 420).unwrap(), "2024-01-09T22:05:00+07:00");
        assert_eq!(timestamp_text(us, -210).unwrap(), "2024-01-09T22:05:00-03:30");
        assert_eq!(timestamp_text(us, 0).unwrap(), "2024-01-09T22:05:00+00:00");
        assert_eq!(timestamp_text(us + 250_000, 420).unwrap(), "2024-01-09T22:05:00.25+07:00");
        assert_eq!(timestamp_text(us + 1, 420).unwrap(), "2024-01-09T22:05:00.000001+07:00");
    }

    #[test]
    fn fractional_seconds_and_negative_offset_reach_the_csv() {
        let ts = vec![Some("2024-01-09 22:00:00.5".to_string()), Some("2024-01-09 22:00:01".to_string())];
        let d = data_with(ts);
        let mut req = request(vec![ind("i1", "Y")]);
        req.data_utc_offset_min = -210;
        let p = build_plan(&d, &derived(), &req).unwrap().plan;
        assert_eq!(p.models[0].peek[1][0], "2024-01-09T22:00:00.5-03:30");
        assert_eq!(p.models[0].peek[2][0], "2024-01-09T22:00:01-03:30");
    }

    // ---- rows ----

    fn running_filter() -> PreviewFilter {
        serde_json::from_value(serde_json::json!({
            "timestamp_ranges": [{"start": "2024-01-09T22:10", "end": "2024-01-09T23:20"}],
            "value_filters": [{"sensor": "C", "operation": "greater_than", "value1": 0.0}]
        }))
        .unwrap()
    }

    /// Dataset with gaps (NaN) so the row rule actually drops rows.
    fn holey() -> ColumnarData {
        let mut d = data();
        d.columns[1][3] = f64::NAN; // A
        d.columns[4][7] = f64::NAN; // Y
        d.columns[3][9] = f64::NAN; // C
        d
    }

    #[test]
    fn rows_equal_the_trainers_selection_for_every_kind() {
        let d = holey();
        let f = running_filter();
        // Individual vs the health preview's in-scope rows.
        let hp_req = crate::health_preview::HealthPreviewRequest {
            kind: "individual".into(),
            target: Some("Y".into()),
            filter: Some(f.clone()),
            ..Default::default()
        };
        let ind_rows = match crate::health_preview::individual_preview(&d, &hp_req).unwrap().stats {
            crate::health_preview::HealthStats::Individual(s) => s.rows,
            _ => unreachable!(),
        };
        let mut m = ind("i1", "Y");
        m.filter = Some(f.clone());
        let p = build_plan(&d, &derived(), &request(vec![m])).unwrap().plan;
        assert_eq!(p.models[0].rows, ind_rows);

        // Clustering (one and two regimes) vs the clustering preview core.
        for (crit, ranges) in [(None, None), (Some("C"), Some(vec![rng(None, Some(1.0)), rng(Some(1.0), None)]))] {
            let n = ranges.as_ref().map_or(1, |r: &Vec<ClusterRange>| r.len() as u32);
            let core = clustering_preview_in(
                &d,
                "A".into(),
                "Y".into(),
                n,
                crit.map(str::to_string),
                ranges.clone(),
                Some(f.clone()),
            )
            .unwrap();
            let mut m = clus("c1", "A", "Y", crit, ranges);
            m.filter = Some(f.clone());
            let p = build_plan(&d, &derived(), &request(vec![m])).unwrap().plan;
            assert_eq!(p.models[0].rows, core.n_rows, "n = {n}");
        }

        // Relationship: the shared rule IS what `preview_relationship_model`
        // (Train) runs; pin it against a hand count.
        let resolved = ResolvedFilter::resolve(Some(&f), &d.headers).unwrap();
        let rows = training_rows(&d, &resolved, &[1, 2, 4], None);
        let hand: Vec<u32> = (0..20u32)
            .filter(|&r| (2..=16).contains(&r) && r % 4 != 0 && r != 3 && r != 7 && r != 9)
            .collect();
        assert_eq!(rows, hand);
        let mut m = rel("r1", "Y", &["A", "B"]);
        m.filter = Some(f);
        let p = build_plan(&d, &derived(), &request(vec![m])).unwrap().plan;
        assert_eq!(p.models[0].rows, hand.len());
    }

    #[test]
    fn cluster_range_contains_is_min_exclusive_max_inclusive() {
        // Spec §4.4 / user decision 2026-10-20: `from < value <= to`.
        let r = rng(Some(1.0), Some(2.0));
        assert!(!r.contains(1.0), "the bottom edge belongs to the range below");
        assert!(r.contains(1.000_001));
        assert!(r.contains(2.0), "the top edge is inside");
        assert!(!r.contains(2.000_001));
        assert!(rng(None, Some(1.0)).contains(-1e300) && rng(None, Some(1.0)).contains(1.0));
        assert!(!rng(Some(1.0), None).contains(1.0) && rng(Some(1.0), None).contains(1e300));
        // Training (the clustering preview core) follows it: C = i % 4 over 20
        // rows -> C <= 1 is 10 rows (0 and 1), C > 1 is 10 rows (2 and 3).
        let d = data();
        let ranges = vec![rng(None, Some(1.0)), rng(Some(1.0), None)];
        let p = clustering_preview_in(&d, "A".into(), "Y".into(), 2, Some("C".into()), Some(ranges.clone()), None).unwrap();
        assert_eq!(p.clusters.iter().map(|c| c.n_rows).collect::<Vec<_>>(), [10, 10]);
        // ... and so does the health score's assignment.
        let tuples: Vec<_> = ranges.iter().map(|r| (r.min, r.max)).collect();
        assert_eq!(crate::health_score::assign_cluster(1.0, &tuples), Some(0));
        assert_eq!(crate::health_score::assign_cluster(1.5, &tuples), Some(1));
    }

    #[test]
    fn a_row_in_two_overlapping_ranges_is_written_once() {
        let d = data();
        let resolved = ResolvedFilter::resolve(None, &d.headers).unwrap();
        let ranges = [rng(None, Some(2.0)), rng(Some(1.0), None)];
        assert_eq!(training_rows(&d, &resolved, &[1, 4], Some((3, &ranges))).len(), 20);
    }

    #[test]
    fn rows_without_a_timestamp_and_repeated_instants_are_dropped_and_counted() {
        let mut ts = minute_ts(6);
        ts[1] = None;
        ts[4] = ts[2].clone(); // repeated instant: row 4 (later) wins
        let d = data_with(ts);
        let p = build_plan(&d, &derived(), &request(vec![ind("i1", "Y")])).unwrap().plan;
        let m = &p.models[0];
        assert_eq!(m.rows, 4);
        assert_eq!(p.rows_without_timestamp, 1);
        assert_eq!(p.duplicate_instants_dropped, 1);
        let ys: Vec<&str> = m.peek[1..].iter().map(|r| r[1].as_str()).collect();
        assert_eq!(ys, ["10", "14", "13", "15"], "sorted by time, the last row of 22:10 kept");
        assert!(codes(&p).contains(&"rows_without_timestamp"));
        assert!(codes(&p).contains(&"duplicate_instants_dropped"));
        assert!(p.ok, "warnings only");
    }

    #[test]
    fn no_training_rows_is_an_error() {
        let mut m = ind("i1", "Y");
        m.filter = Some(serde_json::from_value(serde_json::json!({
            "value_filters": [{"sensor": "A", "operation": "greater_than", "value1": 1000.0}]
        })).unwrap());
        let p = plan(&request(vec![m]));
        assert!(codes(&p).contains(&"no_training_rows"));
        assert!(!p.ok);
    }

    // ---- machine_info ----

    #[test]
    fn derived_sensors_are_classified_and_their_raw_sources_listed() {
        let p = plan(&request(vec![ind("i1", "D")]));
        let mi = &p.machine_info;
        assert_eq!(mi.derived_sensors.len(), 1);
        let d = &mi.derived_sensors[0];
        assert_eq!((d.tag.as_str(), d.how_to_build.as_str(), d.name.as_str()), ("D", "A minus B", "D description"));
        let tags: Vec<&str> = mi.sensors.iter().map(|s| s.tag.as_str()).collect();
        assert_eq!(tags, ["A", "B"], "running sensor A + raw source B, D not repeated as raw");
        assert!(mi.sensors.iter().all(|s| s.description.is_empty()));
        let text = serde_json::to_string_pretty(mi).unwrap();
        let order: Vec<&str> = ["\"schema_version\"", "\"exported_at\"", "\"plant\"", "\"machine\"", "\"running_status\"", "\"components\"", "\"sensors\"", "\"derived_sensors\"", "\"failure_groups\""]
            .into_iter()
            .collect();
        let pos: Vec<usize> = order.iter().map(|k| text.find(k).unwrap()).collect();
        assert!(pos.windows(2).all(|w| w[0] < w[1]), "machine_info key order");
        assert_eq!(serde_json::to_value(mi).unwrap()["exported_at"], serde_json::Value::Null);
    }

    #[test]
    fn a_derived_sensor_without_a_recipe_is_an_error() {
        let mut req = request(vec![ind("i1", "D")]);
        req.derived_sensors.clear();
        assert!(codes(&plan(&req)).contains(&"derived_recipe_missing"));
    }

    #[test]
    fn missing_components_become_uncategorized_with_a_warning() {
        let mut req = request(vec![ind("i1", "Y")]);
        req.sensor_meta.retain(|m| m.tag != "Y");
        let p = plan(&req);
        assert_eq!(p.uncategorized_tags, ["Y"]);
        assert!(p.machine_info.components.contains(&"Uncategorized".to_string()));
        assert_eq!(json_of(&p.models[0])["component"], "Uncategorized");
        let y = p.machine_info.sensors.iter().find(|s| s.tag == "Y").unwrap();
        assert_eq!((y.name.as_str(), y.component.as_str()), ("Y", "Uncategorized"), "name falls back to the tag");
        assert!(p.issues.iter().any(|i| i.code == "component_uncategorized" && i.severity == "warning"));
        assert!(p.ok);
        assert_eq!(p.machine_info.components, ["Gas Generator", "Uncategorized"], "unique + sorted");
    }

    #[test]
    fn failure_groups_list_model_keys_and_only_used_groups() {
        let mut i = ind("i1", "Y");
        i.group_nos = vec![1, 7];
        let p = plan(&request(vec![rel("r1", "Y", &["A"]), i]));
        let fgs = &p.machine_info.failure_groups;
        assert_eq!(fgs.len(), 1);
        assert_eq!(fgs[0].name, "FG one");
        assert_eq!(fgs[0].models, ["Y-R1", "Y-I1"]);
        let mut req = request(vec![rel("r1", "Y", &["A"])]);
        req.failure_groups[0].recommendation = "  ".into();
        let p = plan(&req);
        let iss = p.issues.iter().find(|i| i.code == "fg_text_missing").unwrap();
        assert_eq!((iss.group_no, iss.field.as_deref()), (Some(1), Some("recommendation")));
    }

    #[test]
    fn request_level_issues() {
        let mut req = request(vec![]);
        req.machine.tag = " ".into();
        req.data_utc_offset_min = 900;
        req.running_status = None;
        let p = plan(&req);
        let c = codes(&p);
        for code in ["machine_missing", "offset_out_of_range", "running_status_missing", "no_models"] {
            assert!(c.contains(&code), "{code}: {c:?}");
        }
        assert_eq!(p.files, 1);
        let mut req = request(vec![ind("a", "Y"), ind("a", "A"), ind("b", "Nope")]);
        req.running_status = Some(RunningStatusArg { sensor: "Ghost".into(), stop_if_lower_than: 1.0 });
        req.models[0].display_name = " Same ".into();
        req.models[2].display_name = "same".into();
        req.models[2].category = None;
        let p = plan(&req);
        let c = codes(&p);
        for code in ["duplicate_model_id", "unknown_sensor", "running_status_sensor_unknown", "display_name_duplicate", "category_missing"] {
            assert!(c.contains(&code), "{code}: {c:?}");
        }
        assert_eq!(p.models.len(), 2, "the duplicate id is not exported twice");
        let mut bad = request(vec![ind("a", "Y")]);
        bad.models[0].kind = "neural".into();
        assert!(build_plan(&data(), &derived(), &bad).unwrap_err().starts_with("BAD_REQUEST:"));
    }

    // ---- unfinished models / spec rules (review fixes) ----

    fn issues_of<'a>(p: &'a WorkspaceExportPlan, id: &str) -> Vec<(&'static str, Option<&'a str>)> {
        p.issues
            .iter()
            .filter(|i| i.model_id.as_deref() == Some(id))
            .map(|i| (i.code, i.field.as_deref()))
            .collect()
    }

    #[test]
    fn unfinished_models_are_per_model_issues_and_the_others_are_still_planned() {
        let no_inputs = rel("r_new", "Y", &[]);
        let mut no_criteria = clus("c_new", "A", "Y", None, None);
        no_criteria.n_clusters = Some(2);
        let mut no_target = ind("i_new", "Y");
        no_target.target = Some("  ".into());
        let mut zero = clus("c_zero", "A", "Y", None, None);
        zero.n_clusters = Some(0);
        let mut no_y = clus("c_noy", "A", "Y", None, None);
        no_y.y_sensor = None;
        let mut bad_scope = ind("i_scope", "A");
        bad_scope.filter = Some(PreviewFilter { timestamp_start: Some("not a time".into()), ..Default::default() });
        let p = build_plan(
            &data(),
            &derived(),
            &request(vec![rel("r1", "Y", &["A"]), no_inputs, no_criteria, no_target, zero, no_y, bad_scope, ind("i1", "B")]),
        )
        .expect("an unfinished model must not fail the whole request")
        .plan;
        assert!(!p.ok);
        assert_eq!(issues_of(&p, "r_new"), vec![("model_incomplete", Some("predictors"))]);
        assert_eq!(issues_of(&p, "c_new"), vec![("model_incomplete", Some("criteria_sensor"))]);
        assert_eq!(issues_of(&p, "i_new"), vec![("model_incomplete", Some("target"))]);
        assert_eq!(issues_of(&p, "c_zero"), vec![("model_incomplete", Some("n_clusters"))]);
        assert_eq!(issues_of(&p, "c_noy"), vec![("model_incomplete", Some("y_sensor"))]);
        assert_eq!(issues_of(&p, "i_scope"), vec![("bad_training_scope", Some("filter"))]);
        assert!(p.issues.iter().all(|i| i.is_error() || i.code != "model_incomplete"));
        // Skipped models have no key / JSON / rows; the finished ones keep theirs.
        let ids: Vec<&str> = p.models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["r1", "i1"]);
        assert_eq!(p.files, 2 * 2 + 1);
        assert!(p.models.iter().all(|m| m.rows > 0));
    }

    #[test]
    fn export_refuses_with_not_ready_when_a_model_is_unfinished() {
        let st = state(data(), 1);
        let dir = tempfile::tempdir().unwrap();
        let req = request(vec![rel("r1", "Y", &["A"]), rel("r_new", "Y", &[])]);
        let err = write_export(&st, &req, dir.path().to_str().unwrap(), "out", &AtomicBool::new(false), |_, _, _| {})
            .unwrap_err();
        assert!(err.starts_with("NOT_READY:"), "{err}");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0, "nothing written");
    }

    #[test]
    fn relation_input_equal_to_output_is_an_error() {
        let p = plan(&request(vec![rel("r1", "Y", &["A", "Y"])]));
        assert!(!p.ok);
        let i = p.issues.iter().find(|i| i.code == "input_equals_output").expect("issue");
        assert!(i.is_error());
        assert_eq!(i.model_id.as_deref(), Some("r1"));
        assert_eq!(i.field.as_deref(), Some("predictors"));
        assert!(plan(&request(vec![rel("r1", "Y", &["A"])])).issues.iter().all(|i| i.code != "input_equals_output"));
    }

    #[test]
    fn clustering_x_equal_to_y_is_an_error() {
        let p = plan(&request(vec![clus("c1", "A", "A", None, None)]));
        assert!(!p.ok);
        let i = p.issues.iter().find(|i| i.code == "x_equals_y").expect("issue");
        assert!(i.is_error());
        assert_eq!(i.model_id.as_deref(), Some("c1"));
        assert!(plan(&request(vec![clus("c1", "A", "Y", None, None)])).issues.iter().all(|i| i.code != "x_equals_y"));
    }

    #[test]
    fn duplicate_failure_group_names_among_used_groups_are_errors() {
        let mut r2 = ind("i2", "B");
        r2.group_nos = vec![3];
        let mut r1 = ind("i1", "Y");
        r1.group_nos = vec![1];
        let mut req = request(vec![r1, r2]);
        req.failure_groups.push(FailureGroupArg {
            no: 3,
            name: "  fg ONE ".into(),
            description: "d".into(),
            recommendation: "r".into(),
        });
        let p = plan(&req);
        let groups: Vec<Option<i64>> =
            p.issues.iter().filter(|i| i.code == "fg_name_duplicate").map(|i| i.group_no).collect();
        assert_eq!(groups, vec![Some(1), Some(3)]);
        assert!(!p.ok);
        // An unused group with the same name does not count.
        let mut req = request(vec![ind("i1", "Y")]);
        req.models[0].group_nos = vec![1];
        req.failure_groups[1].name = "FG one".into();
        assert!(plan(&req).issues.iter().all(|i| i.code != "fg_name_duplicate"));
    }

    #[test]
    fn sanitize_key_tag_guards_windows_device_names() {
        assert_eq!(sanitize_key_tag("NUL.X"), "_NUL.X");
        assert_eq!(sanitize_key_tag("con"), "_con");
        assert_eq!(sanitize_key_tag("Aux"), "_Aux");
        assert_eq!(sanitize_key_tag("PRN.a.b"), "_PRN.a.b");
        assert_eq!(sanitize_key_tag("COM1"), "_COM1");
        assert_eq!(sanitize_key_tag("lpt9.v"), "_lpt9.v");
        for ok in ["COM0", "COM10", "CONSOLE", "LPT", "NULL", "A.NUL", "X-CON"] {
            assert_eq!(sanitize_key_tag(ok), ok, "{ok}");
        }
    }

    // ---- spec §6 guard ----

    fn json_keys(v: &serde_json::Value, out: &mut Vec<String>) {
        match v {
            serde_json::Value::Object(m) => {
                for (k, v) in m {
                    out.push(k.clone());
                    json_keys(v, out);
                }
            }
            serde_json::Value::Array(a) => a.iter().for_each(|v| json_keys(v, out)),
            _ => {}
        }
    }

    #[test]
    fn spec_section_6_guard_over_keys_file_names_and_columns() {
        let ranges = vec![rng(None, Some(1.0)), rng(Some(1.0), None)];
        let p = plan(&request(vec![rel("r1", "Y", &["A"]), ind("i1", "D"), clus("c1", "A", "Y", Some("C"), Some(ranges))]));
        let mut names: Vec<String> = vec![MACHINE_INFO_FILE.into(), MODELS_DIR.into()];
        json_keys(&serde_json::to_value(&p.machine_info).unwrap(), &mut names);
        for m in &p.models {
            json_keys(&json_of(m), &mut names);
            names.push(format!("{}.json", m.key));
            names.push(format!("{}.csv", m.key));
            names.extend(m.csv_columns.iter().cloned());
            names.push("TimeStamp".into());
            let j = json_of(m);
            for fixed in ["kind", "fit_profile", "category"] {
                if let Some(s) = j[fixed].as_str() {
                    names.push(s.into());
                }
            }
        }
        let substr = ["gam", "lambda", "pkl", "joblib", "gmm", "rmse", "sigma", "residual", "predict", "stiff", "center", "centre", "angle", "publish", "platform"];
        let tokens = ["mean", "sd", "r2", "std", "id"];
        for n in &names {
            let low = n.to_lowercase();
            for s in substr {
                assert!(!low.contains(s), "'{n}' contains '{s}'");
            }
            for t in low.split(|c: char| !c.is_ascii_alphanumeric()) {
                assert!(!tokens.contains(&t), "'{n}' has the token '{t}'");
            }
        }
        // And no Python-style list text in any string.
        let all = serde_json::to_string(&p.machine_info).unwrap();
        assert!(!all.contains("['") && !all.contains("{'"));
    }

    // ---- write ----

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn ok_request() -> WorkspaceExportRequest {
        let ranges = vec![rng(None, Some(1.0)), rng(Some(1.0), None)];
        request(vec![rel("r1", "Y", &["A"]), ind("i1", "D"), clus("c1", "A", "Y", Some("C"), Some(ranges))])
    }

    fn listing(dir: &Path) -> BTreeSet<String> {
        std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn written_content_equals_the_plan() {
        let st = state(data(), 1);
        let dir = tmp();
        std::fs::write(dir.path().join("keep.txt"), "x").unwrap();
        let req = ok_request();
        let plan = plan_in(&st, &req).unwrap();
        let calls = Mutex::new(Vec::new());
        let res = write_export(&st, &req, dir.path().to_str().unwrap(), "Plant_2026-10-20_1000", &AtomicBool::new(false), |w, t, k| {
            calls.lock().unwrap().push((w, t, k.to_string()))
        })
        .unwrap();
        assert_eq!(*calls.lock().unwrap(), vec![(1, 3, "Y-R1".into()), (2, 3, "D-I1".into()), (3, 3, "Y-C1".into())]);
        let root = PathBuf::from(&res.folder);
        assert!(root.is_absolute());
        assert_eq!(root.file_name().unwrap(), "Plant_2026-10-20_1000");
        assert_eq!(listing(dir.path()), BTreeSet::from(["keep.txt".to_string(), "Plant_2026-10-20_1000".to_string()]));
        assert_eq!(std::fs::read_to_string(dir.path().join("keep.txt")).unwrap(), "x");
        assert_eq!((res.files, res.models, res.rows), (7, 3, plan.total_rows));
        assert_eq!(res.bytes, plan.total_bytes, "plan byte count == written bytes");
        for m in &plan.models {
            let csv = std::fs::read_to_string(root.join("models").join(format!("{}.csv", m.key))).unwrap();
            let lines: Vec<&str> = csv.lines().collect();
            assert_eq!(lines.len(), m.rows + 1);
            for (i, row) in m.peek.iter().enumerate() {
                assert_eq!(lines[i], row.join(","), "peek line {i} of {}", m.key);
            }
            let json = std::fs::read_to_string(root.join("models").join(format!("{}.json", m.key))).unwrap();
            assert_eq!(json, serde_json::to_string_pretty(&m.json).unwrap());
        }
        let mi: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(root.join("machine_info.json")).unwrap()).unwrap();
        assert_eq!(mi["exported_at"].as_str().unwrap(), res.exported_at);
        assert_eq!(res.exported_at.len(), EXPORTED_AT_PLACEHOLDER.len());
        let mut planned = serde_json::to_value(&plan.machine_info).unwrap();
        planned["exported_at"] = mi["exported_at"].clone();
        assert_eq!(mi, planned);
    }

    #[test]
    fn an_existing_folder_gets_a_numbered_suffix() {
        let st = state(data(), 1);
        let dir = tmp();
        std::fs::create_dir(dir.path().join("Out")).unwrap();
        std::fs::write(dir.path().join("Out").join("mine.txt"), "y").unwrap();
        let d = dir.path().to_str().unwrap();
        let r2 = write_export(&st, &ok_request(), d, "Out", &AtomicBool::new(false), |_, _, _| {}).unwrap();
        assert!(r2.folder.ends_with("Out_2"), "{}", r2.folder);
        let r3 = write_export(&st, &ok_request(), d, "Out", &AtomicBool::new(false), |_, _, _| {}).unwrap();
        assert!(r3.folder.ends_with("Out_3"));
        assert_eq!(listing(&dir.path().join("Out")), BTreeSet::from(["mine.txt".to_string()]));
    }

    #[test]
    fn folder_name_validation() {
        for good in ["A", "Plant_2026-10-20_1000", "a.b-c_d", &"x".repeat(120)] {
            assert!(validate_folder_name(good).is_ok(), "{good}");
        }
        for bad in ["", "_x", ".hidden", "a b", "a/b", "a\\b", "..", "x.", "ก", "CON", "nul.txt", "COM1", &"x".repeat(121)] {
            assert!(validate_folder_name(bad).unwrap_err().starts_with("BAD_REQUEST:"), "{bad}");
        }
        let st = state(data(), 1);
        let dir = tmp();
        let err = write_export(&st, &ok_request(), dir.path().to_str().unwrap(), "../x", &AtomicBool::new(false), |_, _, _| {}).unwrap_err();
        assert!(err.starts_with("BAD_REQUEST:"), "{err}");
        let err = write_export(&st, &ok_request(), "relative/dir", "x", &AtomicBool::new(false), |_, _, _| {}).unwrap_err();
        assert!(err.starts_with("BAD_REQUEST:"), "{err}");
        assert!(listing(dir.path()).is_empty());
    }

    #[test]
    fn a_failed_write_leaves_nothing_behind() {
        let st = state(data(), 1);
        let dir = tmp();
        let err = write_export_with(
            &st,
            &ok_request(),
            dir.path().to_str().unwrap(),
            "Out",
            &AtomicBool::new(false),
            |_, _, _| {},
            Hooks { fail_before_model: Some(1) },
        )
        .unwrap_err();
        assert!(err.starts_with("WRITE_FAILED:"), "{err}");
        assert!(listing(dir.path()).is_empty(), "staging removed");
    }

    #[test]
    fn a_cancel_leaves_nothing_behind() {
        let st = state(data(), 1);
        let dir = tmp();
        let cancel = AtomicBool::new(false);
        let err = write_export(&st, &ok_request(), dir.path().to_str().unwrap(), "Out", &cancel, |w, _, _| {
            if w == 1 {
                cancel.store(true, Ordering::SeqCst);
            }
        })
        .unwrap_err();
        assert!(err.starts_with("CANCELLED:"), "{err}");
        assert!(listing(dir.path()).is_empty());
    }

    #[test]
    fn not_ready_writes_nothing() {
        let st = state(data(), 1);
        let dir = tmp();
        let mut req = ok_request();
        req.machine.plant.clear();
        req.models[0].category = None;
        let err = write_export(&st, &req, dir.path().to_str().unwrap(), "Out", &AtomicBool::new(false), |_, _, _| {}).unwrap_err();
        assert_eq!(err, "NOT_READY: 2 problem(s)");
        assert!(listing(dir.path()).is_empty());
    }

    #[test]
    fn stale_session_and_no_data() {
        let st = state(data(), 5);
        let mut req = ok_request();
        req.expected_generation = Some(4);
        assert!(plan_in(&st, &req).unwrap_err().starts_with("STALE_SESSION"));
        let dir = tmp();
        let err = write_export(&st, &req, dir.path().to_str().unwrap(), "Out", &AtomicBool::new(false), |_, _, _| {}).unwrap_err();
        assert!(err.starts_with("STALE_SESSION"));
        // The dataset changes between two models -> stale, nothing left.
        req.expected_generation = Some(5);
        let err = write_export(&st, &req, dir.path().to_str().unwrap(), "Out", &AtomicBool::new(false), |w, _, _| {
            if w == 1 {
                st.0.write().unwrap().as_mut().unwrap().generation = 6;
            }
        })
        .unwrap_err();
        assert!(err.starts_with("STALE_SESSION"), "{err}");
        assert!(listing(dir.path()).is_empty());
        let empty = AppState(RwLock::new(None));
        assert!(plan_in(&empty, &ok_request()).unwrap_err().starts_with("NO_DATA:"));
    }

    #[test]
    fn only_one_export_at_a_time_and_cancel_by_id() {
        let slot = ExportSlot::new();
        assert!(slot.begin(" ").err().is_some_and(|e| e.starts_with("BAD_REQUEST:")));
        let g = slot.begin("e1").unwrap();
        assert_eq!(slot.begin("e2").err().as_deref(), Some("BAD_REQUEST: an export is already running"));
        assert!(!slot.cancel("e2"));
        assert!(slot.cancel("e1"));
        assert!(g.cancel_flag().load(Ordering::SeqCst));
        drop(g);
        assert!(!slot.cancel("e1"), "slot freed");
        assert!(slot.begin("e2").is_ok());
    }
}
