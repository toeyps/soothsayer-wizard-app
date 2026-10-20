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
//!
//! (The preview's old `unsafe_file_name` warning was dropped with the review
//! of Export results: the export sanitizes every key tag, so no sensor name
//! blocks or changes a file name any more.)

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

}
