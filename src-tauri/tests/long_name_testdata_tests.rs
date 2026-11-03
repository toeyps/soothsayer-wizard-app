//! The long-name test data goes through the same Rust that a real import uses.
//!
//! The manual test plan's LN section tells a tester to create a project from `scripts/make-longname-testdata.py`'s
//! files. A new project needs a tag-name file that lists exactly the data's sensors, so two things must hold in the
//! real loader, not just in the script's own check:
//!   1. long headers (brackets, " - ", 150+ characters) load as sensor columns, untouched;
//!   2. a tag-name file whose descriptions are ALL blank still matches: it is the only way left to get a project whose
//!      sensors show their tag alone.
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri_app_lib::csv_processor::{apply_mapping, load_mapping_csv_data, read_merge_csvs_with_report};

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("wizard_ln_{}_{}", name, std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn sensors_of(data: &Path) -> Vec<String> {
    let merged = read_merge_csvs_with_report(vec![data.to_string_lossy().into_owned()]).unwrap();
    merged.data.headers[1..].to_vec()
}

const LONG_A: &str = "Crosshead (P-P Trend) - Vibration crosshead slide 11A - SegmentNo 1 - avg";
const LONG_B: &str = "Crosshead (P-P Trend) - Vibration crosshead slide 11B - SegmentNo 1 - avg";

#[test]
fn a_tag_name_file_with_every_description_blank_still_matches_long_tags() {
    let dir = temp_dir("blank");
    let data = dir.join("d.csv");
    let tags = dir.join("t.csv");
    fs::write(&data, format!("timestamp,{LONG_A},{LONG_B}\n2025-01-01 00:00:00,1,2\n2025-01-01 00:05:00,3,4\n")).unwrap();
    fs::write(&tags, format!("tag,description,unit,component\n{LONG_A},,mm/s,Crosshead\n{LONG_B},,mm/s,Crosshead\n")).unwrap();

    let sensors = sensors_of(&data);
    assert_eq!(sensors, vec![LONG_A.to_string(), LONG_B.to_string()], "long headers are kept as written");

    let mapping = load_mapping_csv_data(tags.to_str().unwrap()).unwrap();
    let mut all = vec!["timestamp".to_string()];
    all.extend(sensors);
    let result = apply_mapping("tag", &mapping, &all).unwrap();
    assert_eq!(result.matched.len(), 2);
    assert!(result.not_in_mapping.is_empty(), "nothing blocks Continue: {:?}", result.not_in_mapping);
    assert!(result.not_in_dataset.is_empty(), "nothing blocks Continue: {:?}", result.not_in_dataset);
    let _ = fs::remove_dir_all(&dir);
}

/// Runs the real generator. Python is a tester's tool, not a build requirement: without it this says so and passes.
#[test]
fn the_generated_ln_set_imports_and_every_pair_matches() {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/make-longname-testdata.py");
    let dir = temp_dir("generated");
    // Windows answers `python` with a store-page stub when it is not installed, so run it once before trusting it.
    let has_python = Command::new("python").arg("--version").output().is_ok_and(|o| o.status.success());
    if !has_python {
        eprintln!("skipped: python is not installed");
        return;
    }
    let out = Command::new("python").arg(&script).arg(&dir).output().unwrap();
    assert!(out.status.success(), "generator failed: {}", String::from_utf8_lossy(&out.stderr));

    let pairs = [
        ("LN-long.csv", "LN-long-tags.csv", 42),
        ("LN-long.csv", "LN-long-tags-no-descriptions.csv", 42),
        ("LN-medium.csv", "LN-medium-tags.csv", 13),
        ("LN-short.csv", "LN-short-tags.csv", 8),
        ("LN-same-description.csv", "LN-same-description-tags.csv", 6),
        ("LN-wide-4748.csv", "LN-wide-4748-tags.csv", 4748),
    ];
    for (data, tags, count) in pairs {
        let sensors = sensors_of(&dir.join(data));
        assert_eq!(sensors.len(), count, "{data}");
        let mapping = load_mapping_csv_data(dir.join(tags).to_str().unwrap()).unwrap();
        let mut all = vec!["timestamp".to_string()];
        all.extend(sensors);
        let result = apply_mapping("tag", &mapping, &all).unwrap();
        assert_eq!(result.matched.len(), count, "{tags}");
        assert!(result.not_in_mapping.is_empty(), "{tags}: {:?}", result.not_in_mapping);
        assert!(result.not_in_dataset.is_empty(), "{tags}: {:?}", result.not_in_dataset);
    }
    let _ = fs::remove_dir_all(&dir);
}
