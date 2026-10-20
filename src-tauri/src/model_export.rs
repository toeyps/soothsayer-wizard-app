//! What is left of the old "Mark complete -> write the model files" export.
//!
//! Since Export results phase 4 (2026-10-20) Mark complete writes NO files and
//! the Export results dialog (`workspace_export.rs`) is the only writer. The old
//! `export_model_files` / `remove_model_files` / `get_model_output_dir` commands
//! and their staging / stale-sibling machinery were removed. Kept here only what
//! the legacy `train_*` commands and the health preview still use:
//!
//! - [`CoreError`]: the error of the `train_*` file-writing cores.
//! - [`relationship_block`]: the hourly `validation` block a Relationship
//!   training run can add to its `REL_INFO_*.json`.
//! - [`file_name_problem`] / [`unsafe_name_warnings`]: the preview's
//!   non-blocking warning for a sensor name that cannot be a file name.

use crate::csv_processor::ColumnarData;
use crate::health_preview::HealthPreviewRequest;
use crate::health_score::{Issue, SetPointsArg};
use crate::health_validation::{self, TestPeriodArg, TestValidation};
use crate::PreviewFilter;

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
// Relationship validation block
// ---------------------------------------------------------------------------

/// The `validation` block of a Relationship training run with scoring periods:
/// the SAME preview code as `compute_health_preview`, over the fit just trained
/// (`fit`, the raw training rows) and that model's predictions for the HOURLY
/// points (`extra`: the engine's answers for the hourly mean predictors of the
/// training hours and of the scoring periods, asked for in the same sidecar
/// run). Nothing is refitted.
///
/// The block is hourly: `tests[].scored` / `pct_below_80` / `lowest` and the
/// period metrics (`r2`, `rmse`, `residual_mean`, `residual_sd`) are over
/// 1-hour averages - residual = mean actual minus the prediction at the hour's
/// mean predictors - which is what `scoring_interval_seconds: 3600` /
/// `scoring_aggregation: "mean"` declare. The `train` block stays the model's
/// own raw-row numbers.
pub fn relationship_block(
    data: &ColumnarData,
    fit: &crate::health_score::RelFit,
    extra: &crate::health_score::RelExtra,
    filter: Option<&PreviewFilter>,
    set_points: Option<&SetPointsArg>,
    test_periods: &[TestPeriodArg],
) -> Result<serde_json::Value, String> {
    let pv = HealthPreviewRequest {
        kind: "relationship".into(),
        target: Some(fit.target.clone()),
        predictors: fit.predictors.clone(),
        filter: filter.cloned(),
        set_points: set_points.cloned(),
        test_periods: Some(test_periods.to_vec()),
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

/// One non-blocking `unsafe_file_name` WARNING per name that cannot be used as
/// a file name, so the page can say so while the user is still looking at the
/// model (the preview itself works for any sensor name).
pub fn unsafe_name_warnings(names: &[(&str, &str)]) -> Vec<Issue> {
    names
        .iter()
        .filter_map(|(field, name)| {
            file_name_problem(name).map(|why| Issue {
                code: "unsafe_file_name".into(),
                severity: crate::health_score::Severity::Warning,
                message: format!(
                    "The {field} name '{}' has characters a file name cannot hold ({why}); \
                     Export results writes them as '_' in the file name.",
                    shown(name)
                ),
                field: (*field).to_string(),
            })
        })
        .collect()
}


// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_error_flattens_validation_messages() {
        let v = crate::health_score::validate_clustering(&[], &SetPointsArg::default());
        let s = CoreError::Validation(v).into_string();
        assert!(s.starts_with("VALIDATION: "), "{s}");
        assert_eq!(CoreError::Other("x".into()).into_string(), "x");
    }


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
    fn unsafe_name_warnings_are_non_blocking_warnings() {
        let w = unsafe_name_warnings(&[("target", "ok"), ("predictor", "a/b")]);
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].code, "unsafe_file_name");
        assert_eq!(w[0].severity, crate::health_score::Severity::Warning);
        assert_eq!(w[0].field, "predictor");
        assert!(unsafe_name_warnings(&[("target", "Fine name")]).is_empty());
    }

}
