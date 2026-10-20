//! QA: a model's output files across the two commands that touch them —
//! `export_model_files` (Mark complete, `model_export::export_sync`) writes
//! them, `remove_model_files` (model / group deleted on the Dashboard,
//! `model_export::remove_model_files_in`) must find and remove exactly those
//! files, with the identity the frontend sends (`modelOutputFiles.ts`:
//! Individual / Relation = target sensor, Clustering = X sensor). The unit
//! tests next to the code use hand-written file names; these use the names
//! the real export writes.

use crate::csv_processor::ColumnarData;
use crate::health_score::SetPointsArg;
use crate::model_export::{export_sync, remove_model_files_in, ModelFilesRequest};
use std::path::{Path, PathBuf};

fn data(names: &[&str]) -> ColumnarData {
    let n = 400;
    let ts: Vec<Option<String>> = (0..n)
        .map(|i| Some(format!("2024-01-01T{:02}:{:02}:00", (i / 60) % 24, i % 60)))
        .collect();
    let mut headers = vec!["timestamp".to_string()];
    let mut cols = vec![vec![f64::NAN; n]];
    for (k, name) in names.iter().enumerate() {
        headers.push(name.to_string());
        let m = 11 + 2 * k;
        cols.push((0..n).map(|i| (i % m) as f64 + 0.5 * ((i * (k + 1)) % 5) as f64).collect());
    }
    ColumnarData::from_parts(headers, ts, cols)
}

fn indv(ws: &str, target: &str) -> ModelFilesRequest {
    ModelFilesRequest {
        kind: "individual".into(),
        workspace_id: ws.into(),
        target: Some(target.into()),
        set_points: Some(SetPointsArg { lower: Some(-1e6), upper: Some(1e6), ..Default::default() }),
        ..Default::default()
    }
}

fn clus(ws: &str, x: &str, y: &str) -> ModelFilesRequest {
    ModelFilesRequest {
        kind: "clustering".into(),
        workspace_id: ws.into(),
        first_sensor: Some(x.into()),
        second_sensor: Some(y.into()),
        n_clusters: Some(1),
        set_points: Some(SetPointsArg { outer_sd: Some(6.0), ..Default::default() }),
        ..Default::default()
    }
}

fn out(app: &Path, ws: &str) -> PathBuf {
    app.join("workspaces").join(ws).join("output")
}

fn names_in(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
        .unwrap_or_default();
    v.sort();
    v
}

#[test]
fn mark_complete_then_delete_leaves_nothing_of_that_model_for_every_sensor_name_shape() {
    // Names with a space and brackets, an underscore (prefix traps), Thai.
    let sensors = ["Temp (C)", "A", "A_B", "ท่ออากาศ"];
    let d = data(&sensors);
    let app = tempfile::tempdir().unwrap();
    for s in sensors {
        let r = export_sync(&d, &indv("ws", s), app.path()).unwrap();
        assert!(r.ok, "{s}: {:?}", r.validation);
    }
    // Deleting `A` never touches `A_B` (and the other way round).
    assert_eq!(remove_model_files_in(app.path(), "ws", "individual", "A").unwrap(), 1);
    assert!(!out(app.path(), "ws").join("A").exists(), "its now-empty folder goes too");
    assert_eq!(names_in(&out(app.path(), "ws").join("A_B")), vec!["INDV_INFO_A_B.json"]);
    for s in ["Temp (C)", "A_B", "ท่ออากาศ"] {
        assert_eq!(remove_model_files_in(app.path(), "ws", "individual", s).unwrap(), 1, "{s}");
        assert!(!out(app.path(), "ws").join(s).exists(), "{s}");
    }
    assert!(names_in(&out(app.path(), "ws")).is_empty());
}

#[test]
fn deleting_a_clustering_model_by_its_x_sensor_removes_the_file_written_under_its_y_folder() {
    let d = data(&["X", "Y", "W"]);
    let app = tempfile::tempdir().unwrap();
    // x=X,y=Y and x=W,y=Y share Y/; Y also has its own Individual model there.
    for req in [clus("ws", "X", "Y"), clus("ws", "W", "Y"), indv("ws", "Y")] {
        let r = export_sync(&d, &req, app.path()).unwrap();
        assert!(r.ok, "{:?}", r.validation);
    }
    let ydir = out(app.path(), "ws").join("Y");
    assert_eq!(names_in(&ydir), vec!["CLUS_INFO_W_Y.json", "CLUS_INFO_X_Y.json", "INDV_INFO_Y.json"]);
    // The Y sensor is NOT the clustering model's identity: nothing goes.
    assert_eq!(remove_model_files_in(app.path(), "ws", "clustering", "Y").unwrap(), 0);
    assert_eq!(remove_model_files_in(app.path(), "ws", "clustering", "X").unwrap(), 1);
    assert_eq!(names_in(&ydir), vec!["CLUS_INFO_W_Y.json", "INDV_INFO_Y.json"]);
    // Deleting Y's Individual model keeps the clustering file that shares the folder.
    assert_eq!(remove_model_files_in(app.path(), "ws", "individual", "Y").unwrap(), 1);
    assert_eq!(names_in(&ydir), vec!["CLUS_INFO_W_Y.json"]);
    assert_eq!(remove_model_files_in(app.path(), "ws", "clustering", "W").unwrap(), 1);
    assert!(!ydir.exists());
}

#[test]
fn a_clustering_model_whose_y_changed_is_deleted_with_no_file_left_anywhere() {
    let d = data(&["X", "Y", "W"]);
    let app = tempfile::tempdir().unwrap();
    assert!(export_sync(&d, &clus("ws", "X", "Y"), app.path()).unwrap().ok);
    // Re-marked complete with another Y: the export moves the file (stale sibling).
    let r = export_sync(&d, &clus("ws", "X", "W"), app.path()).unwrap();
    assert!(r.ok);
    assert_eq!(r.removed, vec!["CLUS_INFO_X_Y.json"]);
    assert_eq!(remove_model_files_in(app.path(), "ws", "clustering", "X").unwrap(), 1);
    assert!(!out(app.path(), "ws").join("W").exists());
}

#[test]
fn deleting_in_one_workspace_never_touches_the_same_model_in_another() {
    let d = data(&["S"]);
    let app = tempfile::tempdir().unwrap();
    assert!(export_sync(&d, &indv("ws-a", "S"), app.path()).unwrap().ok);
    assert!(export_sync(&d, &indv("ws-b", "S"), app.path()).unwrap().ok);
    assert_eq!(remove_model_files_in(app.path(), "ws-a", "individual", "S").unwrap(), 1);
    assert_eq!(names_in(&out(app.path(), "ws-b").join("S")), vec!["INDV_INFO_S.json"]);
}

/// A sensor folder that is a directory junction (Windows; no admin rights
/// needed) pointing OUTSIDE the output folder is never followed: the files
/// behind it are not the workspace's and stay.
#[cfg(windows)]
#[test]
fn a_junctioned_sensor_folder_is_never_followed() {
    let app = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    for f in ["INDV_INFO_S.json", "REL_INFO_P_S.json", "CLUS_INFO_X_S.json"] {
        std::fs::write(outside.path().join(f), "not yours").unwrap();
    }
    let o = out(app.path(), "ws");
    std::fs::create_dir_all(&o).unwrap();
    let link = o.join("S");
    let made = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&link)
        .arg(outside.path())
        .output()
        .map(|r| r.status.success())
        .unwrap_or(false);
    if !made {
        eprintln!("skipped: could not create a junction here");
        return;
    }
    assert!(link.join("INDV_INFO_S.json").is_file(), "the junction resolves");
    assert_eq!(remove_model_files_in(app.path(), "ws", "individual", "S").unwrap(), 0);
    assert_eq!(remove_model_files_in(app.path(), "ws", "relationship", "S").unwrap(), 0);
    assert_eq!(remove_model_files_in(app.path(), "ws", "clustering", "X").unwrap(), 0);
    assert_eq!(names_in(outside.path()), vec!["CLUS_INFO_X_S.json", "INDV_INFO_S.json", "REL_INFO_P_S.json"]);
    assert!(link.exists(), "the junction itself is not removed either");
    // Clean up the junction before the temp dirs go (remove_dir on a junction removes the link only).
    std::fs::remove_dir(&link).unwrap();
    assert_eq!(names_in(outside.path()).len(), 3);
}
