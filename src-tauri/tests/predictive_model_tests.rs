//! Predictive-model tests needing no Tauri app or sidecar: ellipse fit, sidecar JSON contract (`preview_relationship`), ellipse field names.

use serde::{Deserialize, Serialize};
use tauri_app_lib::clustering;


#[test]
fn ellipse_fit_axis_aligned_via_public_api() {
    let xs = [12.0, 8.0, 12.0, 8.0, 10.0, 10.0];
    let ys = [21.0, 19.0, 19.0, 21.0, 20.0, 20.0];
    let fit = clustering::fit_single_cluster_ellipse(&xs, &ys).expect("ellipse fit");
    assert!((fit.x_center - 10.0).abs() < 1e-9);
    assert!((fit.y_center - 20.0).abs() < 1e-9);
    // axis-aligned → angle is a multiple of 180°
    let a = fit.angle_deg.rem_euclid(180.0);
    assert!(a < 1e-6 || (a - 180.0).abs() < 1e-6, "angle = {}", fit.angle_deg);
}

#[test]
fn ellipse_fit_errors_on_length_mismatch() {
    let err = clustering::fit_single_cluster_ellipse(&[1.0, 2.0], &[1.0]);
    assert!(err.is_err());
}

#[test]
fn ellipse_fit_errors_on_empty() {
    let err = clustering::fit_single_cluster_ellipse(&[], &[]);
    assert!(err.is_err());
}

// Sidecar JSON contract: parse a simulated response to catch drift from the Rust-side parser.

#[derive(Debug, Deserialize, Serialize)]
struct PreviewRelationshipResponse {
    request: String,
    r2_per_step: Vec<f64>,
    rmse2_per_step: Vec<f64>,
    predicted: Vec<Option<f64>>,
    residual: Vec<Option<f64>>,
}

#[test]
fn preview_relationship_response_shape_parses_cleanly() {
    let payload = r#"{
        "request": "PreviewModel/relationship",
        "r2_per_step": [0.85, 0.91],
        "rmse2_per_step": [0.34, 0.21],
        "predicted": [3.05, 3.61, null, 4.12],
        "residual": [-0.05, -0.01, null, 0.08]
    }"#;
    let parsed: PreviewRelationshipResponse = serde_json::from_str(payload).expect("parse");
    assert_eq!(parsed.request, "PreviewModel/relationship");
    assert_eq!(parsed.r2_per_step.len(), 2);
    assert_eq!(parsed.rmse2_per_step.len(), 2);
    assert_eq!(parsed.predicted.len(), 4);
    assert_eq!(parsed.residual.len(), 4);
    // NaN encoded as JSON null on the Python side → Option<f64>::None on Rust side.
    assert_eq!(parsed.predicted[2], None);
    assert_eq!(parsed.residual[2], None);
}

#[test]
fn preview_relationship_no_legacy_fields_required() {
    // The response parses with only the current fields.
    let payload = r#"{
        "request": "PreviewModel/relationship",
        "r2_per_step": [],
        "rmse2_per_step": [],
        "predicted": [],
        "residual": []
    }"#;
    let parsed: PreviewRelationshipResponse = serde_json::from_str(payload).expect("parse");
    assert_eq!(parsed.r2_per_step.len(), 0);
}

#[test]
fn sidecar_error_envelope_parses_cleanly() {
    // The sidecar wraps exceptions as `{"error": ..., "trace": ...}`.
    let payload = r#"{"error": "boom", "trace": "Traceback ..."}"#;
    #[derive(Debug, Deserialize)]
    struct Env {
        error: Option<String>,
        #[allow(dead_code)]
        trace: Option<String>,
    }
    let parsed: Env = serde_json::from_str(payload).expect("parse");
    assert_eq!(parsed.error.as_deref(), Some("boom"));
}

// Field renames would silently break the TS bindings.

#[test]
fn ellipse_fit_serialises_with_expected_field_names() {
    let xs = [0.0, 2.0, 0.0, 2.0];
    let ys = [0.0, 0.0, 2.0, 2.0];
    let fit = clustering::fit_single_cluster_ellipse(&xs, &ys).unwrap();
    let json = serde_json::to_value(&fit).expect("serialise");
    let obj = json.as_object().expect("object");
    for key in ["x_center", "y_center", "x_sd", "y_sd", "angle_deg"] {
        assert!(obj.contains_key(key), "missing key: {}", key);
    }
}
