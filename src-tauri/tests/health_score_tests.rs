//! Health score phase 2 — contract tests through the PUBLIC `health_score`
//! surface (what any outside consumer of the model files can rely on):
//! the knots of every score, the validation codes the UI keys on, and the
//! JSON shape of the issues / summary. The heavier flows (session cache,
//! preview, export) are covered by the in-crate tests next to their code.

use tauri_app_lib::health_score::{
    assign_cluster, has_errors, select_indices, summarize, validate_clustering,
    validate_individual, validate_relationship, ClusterGeom, ClusteringParams, IndividualBand,
    IndividualParams, RelationshipParams, SetPointsArg,
};

fn approx(a: f64, b: f64) {
    assert!((a - b).abs() < 1e-9, "expected {b}, got {a}");
}

/// A consumer that only has `INDV_INFO` numbers: mean 50, sd 5.
fn indv_band() -> IndividualBand {
    IndividualBand::from_rounded(50.0, 5.0, [45.0, 55.0], [35.0, 65.0])
}

#[test]
fn individual_score_from_file_numbers_has_80_at_exactly_3_sigma() {
    let sp = SetPointsArg { lower: Some(20.0), upper: Some(90.0), ..Default::default() };
    let p = IndividualParams::new(indv_band(), &sp).unwrap();
    approx(p.score(50.0).unwrap(), 100.0);
    approx(p.score(55.0).unwrap(), 100.0);
    approx(p.score(65.0).unwrap(), 80.0); // +3σ, never 85
    approx(p.score(35.0).unwrap(), 80.0); // -3σ
    approx(p.score(90.0).unwrap(), 0.0);
    approx(p.score(20.0).unwrap(), 0.0);
    approx(p.score(77.5).unwrap(), 40.0); // halfway 65 -> 90
    assert!(p.score(f64::NAN).is_none());
}

#[test]
fn relationship_and_clustering_knots() {
    let sp = SetPointsArg {
        residual_at_80_lower: Some(-6.0),
        residual_at_80_upper: Some(6.0),
        residual_at_0_lower: Some(-12.0),
        residual_at_0_upper: Some(12.0),
        ..Default::default()
    };
    let r = RelationshipParams::new(3.0, &sp).unwrap();
    approx(r.score(3.0).unwrap(), 100.0);
    approx(r.score(6.0).unwrap(), 80.0);
    approx(r.score(-9.0).unwrap(), 40.0);
    approx(r.score(-12.0).unwrap(), 0.0);

    let g = ClusterGeom { cluster_id: 1, x_center: 0.0, y_center: 0.0, x_sd: 2.0, y_sd: 1.0, angle_deg: 0.0 };
    let c = ClusteringParams::new(
        vec![g],
        &SetPointsArg { outer_sd: Some(5.0), ..Default::default() },
    )
    .unwrap();
    approx(c.score(0, 2.0, 0.0).unwrap().0, 100.0); // on the 1x ring (x_sd = 2)
    approx(c.score(0, 6.0, 0.0).unwrap().0, 80.0); // on the 3x ring
    approx(c.score(0, 0.0, 5.0).unwrap().0, 0.0); // on the 5x ring (y_sd = 1)
}

#[test]
fn validation_codes_are_stable() {
    let b = indv_band();
    let code = |sp: SetPointsArg| validate_individual(&b, &sp).into_iter().map(|i| i.code).collect::<Vec<_>>();
    assert_eq!(code(SetPointsArg::default()), vec!["required", "required"]);
    assert_eq!(
        code(SetPointsArg { lower: Some(35.0), upper: Some(80.0), ..Default::default() }),
        vec!["lower_equals_3sd"]
    );
    assert_eq!(
        code(SetPointsArg { lower: Some(40.0), upper: Some(80.0), ..Default::default() }),
        vec!["lower_inside_3sd"]
    );
    let flat = IndividualBand::from_rounded(5.0, 0.0, [5.0; 2], [5.0; 2]);
    let v = validate_individual(&flat, &SetPointsArg { lower: Some(1.0), upper: Some(9.0), ..Default::default() });
    assert_eq!(v[0].code, "degenerate_band");

    let rel = |l80: f64| SetPointsArg {
        residual_at_80_lower: Some(l80),
        residual_at_80_upper: Some(6.0),
        residual_at_0_lower: Some(-12.0),
        residual_at_0_upper: Some(12.0),
        ..Default::default()
    };
    assert!(validate_relationship(Some(3.0), &rel(-6.0)).is_empty());
    assert_eq!(validate_relationship(Some(3.0), &rel(-3.0))[0].code, "point80_equals_band");
    assert_eq!(validate_relationship(Some(3.0), &rel(-2.0))[0].code, "point80_inside_band");
    assert_eq!(validate_relationship(Some(3.0), &rel(6.0))[0].code, "must_be_negative");

    let g = ClusterGeom { cluster_id: 1, x_center: 0.0, y_center: 0.0, x_sd: 1.0, y_sd: 1.0, angle_deg: 0.0 };
    let n = |v: Option<f64>| validate_clustering(&[g], &SetPointsArg { outer_sd: v, ..Default::default() });
    assert_eq!(n(None)[0].code, "required");
    assert_eq!(n(Some(3.0))[0].code, "outer_sd_equals_3");
    assert_eq!(n(Some(2.9))[0].code, "outer_sd_not_above_3");
    assert!(!has_errors(&n(Some(3.5))));
}

#[test]
fn issue_and_summary_json_shapes() {
    let v = validate_individual(&indv_band(), &SetPointsArg::default());
    let j = serde_json::to_value(&v[0]).unwrap();
    for k in ["code", "severity", "message", "field"] {
        assert!(j.get(k).is_some(), "missing {k}");
    }
    assert_eq!(j["severity"], "error");

    let s = summarize(&[100.0, 50.0, 10.0, f64::NAN], 10, |i| (i, Some(format!("t{i}"))));
    let j = serde_json::to_value(&s).unwrap();
    for k in ["scored", "unscored", "total_rows", "min_score", "pct_below_80", "share_80_100", "share_40_80", "share_0_40", "share_basis"] {
        assert!(j.get(k).is_some(), "missing {k}");
    }
    assert_eq!(j["min_score"]["row"], 2);
    assert_eq!(j["min_score"]["timestamp"], "t2");
    assert_eq!(j["share_basis"], "row_count");
}

#[test]
fn downsample_and_assignment_public_helpers() {
    let n = 10_000;
    let mut v = vec![1.0; n];
    v[4321] = 500.0;
    let idx = select_indices(n, 100, Some(&v), None);
    assert!(idx.len() <= 100 && idx.contains(&4321));
    let ranges = [(None, Some(10.0)), (Some(10.0), None)];
    assert_eq!(assign_cluster(9.0, &ranges), Some(0));
    assert_eq!(assign_cluster(10.0, &ranges), Some(1));
    assert_eq!(assign_cluster(f64::NAN, &ranges), None);
}
