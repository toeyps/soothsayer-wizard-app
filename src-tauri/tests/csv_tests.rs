use std::io::Write;
use tempfile::NamedTempFile;
use tauri_app_lib::csv_processor;

// ============================================================
// Helper: create a temp CSV file with given content, return path
// ============================================================
fn write_temp_csv(content: &str) -> (NamedTempFile, String) {
    let mut file = NamedTempFile::new().expect("Failed to create temp file");
    file.write_all(content.as_bytes())
        .expect("Failed to write temp file");
    file.flush().expect("Failed to flush");
    let path = file.path().to_string_lossy().to_string();
    (file, path)
}

// ============================================================
// Tests for read_csv_with_stats
// ============================================================

#[test]
fn read_csv_with_stats_basic() {
    let csv = "timestamp,sensor_a,sensor_b\n\
               2024-01-01T00:00:00,1.0,2.0\n\
               2024-01-01T01:00:00,3.0,4.0\n";
    let (_f, path) = write_temp_csv(csv);

    let result = csv_processor::read_csv_with_stats(&path).unwrap();
    assert_eq!(result.data.headers, vec!["timestamp", "sensor_a", "sensor_b"]);
    assert_eq!(result.data.rows.len(), 2);
    // No parse failures expected
    assert!(result.parse_fail_counts.iter().all(|&c| c == 0));
}

#[test]
fn read_csv_with_stats_tracks_parse_failures() {
    // sensor_a has a non-numeric value "hello" in the second row
    let csv = "timestamp,sensor_a,sensor_b\n\
               2024-01-01T00:00:00,1.0,2.0\n\
               2024-01-01T01:00:00,hello,4.0\n\
               2024-01-01T02:00:00,abc,xyz\n";
    let (_f, path) = write_temp_csv(csv);

    let result = csv_processor::read_csv_with_stats(&path).unwrap();
    assert_eq!(result.data.rows.len(), 3);
    // sensor_a (idx 1) should have 2 parse failures ("hello", "abc")
    assert_eq!(result.parse_fail_counts[1], 2);
    // sensor_b (idx 2) should have 1 parse failure ("xyz")
    assert_eq!(result.parse_fail_counts[2], 1);
}

#[test]
fn read_csv_with_stats_empty_fields_are_null() {
    let csv = "timestamp,sensor_a,sensor_b\n\
               2024-01-01T00:00:00,,2.0\n\
               2024-01-01T01:00:00,3.0,\n";
    let (_f, path) = write_temp_csv(csv);

    let result = csv_processor::read_csv_with_stats(&path).unwrap();
    // Empty fields should be None, NOT counted as parse failures
    assert_eq!(result.parse_fail_counts[1], 0);
    assert_eq!(result.parse_fail_counts[2], 0);
    // Verify actual values
    assert!(result.data.rows[0].values[1].is_none()); // sensor_a row 0
    assert_eq!(result.data.rows[0].values[2], Some(2.0)); // sensor_b row 0
    assert_eq!(result.data.rows[1].values[1], Some(3.0)); // sensor_a row 1
    assert!(result.data.rows[1].values[2].is_none()); // sensor_b row 1
}

#[test]
fn read_csv_with_stats_file_not_found() {
    let result = csv_processor::read_csv_with_stats("/nonexistent/path.csv");
    assert!(result.is_err());
}

// ============================================================
// Tests for read_merge_csvs_with_report
// ============================================================

#[test]
fn merge_csvs_single_file() {
    let csv = "timestamp,sensor_a\n\
               2024-01-01T00:00:00,10.0\n\
               2024-01-01T01:00:00,20.0\n";
    let (_f, path) = write_temp_csv(csv);

    let result = csv_processor::read_merge_csvs_with_report(vec![path]).unwrap();
    assert_eq!(result.data.headers, vec!["timestamp", "sensor_a"]);
    assert_eq!(result.data.rows.len(), 2);
    assert!(result.warnings.is_empty());
}

#[test]
fn merge_csvs_two_files_different_columns() {
    let csv1 = "timestamp,sensor_a\n\
                2024-01-01T00:00:00,1.0\n";
    let csv2 = "timestamp,sensor_b\n\
                2024-01-01T00:00:00,2.0\n";
    let (_f1, path1) = write_temp_csv(csv1);
    let (_f2, path2) = write_temp_csv(csv2);

    let result = csv_processor::read_merge_csvs_with_report(vec![path1, path2]).unwrap();
    assert_eq!(result.data.headers.len(), 3); // timestamp + sensor_a + sensor_b
    assert!(result.data.headers.contains(&"sensor_a".to_string()));
    assert!(result.data.headers.contains(&"sensor_b".to_string()));
    // Same timestamp => merged into 1 row
    assert_eq!(result.data.rows.len(), 1);
}

#[test]
fn merge_csvs_warns_on_duplicate_columns() {
    let csv1 = "timestamp,sensor_a\n\
                2024-01-01T00:00:00,1.0\n";
    let csv2 = "timestamp,sensor_a\n\
                2024-01-01T01:00:00,2.0\n";
    let (_f1, path1) = write_temp_csv(csv1);
    let (_f2, path2) = write_temp_csv(csv2);

    let result = csv_processor::read_merge_csvs_with_report(vec![path1, path2]).unwrap();
    // Should have a warning about duplicate column "sensor_a"
    assert!(result.warnings.iter().any(|w| w.to_lowercase().contains("duplicate")));
    assert!(result.warnings.iter().any(|w| w.contains("sensor_a")));
}

#[test]
fn merge_csvs_empty_paths_returns_error() {
    let result = csv_processor::read_merge_csvs_with_report(vec![]);
    assert!(result.is_err());
}

// ============================================================
// Tests for build_load_report
// ============================================================

#[test]
fn build_load_report_column_info() {
    let csv = "timestamp,sensor_a,sensor_b\n\
               2024-01-01T00:00:00,1.0,2.0\n\
               2024-01-01T01:00:00,,4.0\n\
               2024-01-01T02:00:00,5.0,\n";
    let (_f, path) = write_temp_csv(csv);

    let merge_result = csv_processor::read_merge_csvs_with_report(vec![path]).unwrap();
    let report = csv_processor::build_load_report(&merge_result);

    assert_eq!(report.total_rows, 3);
    assert_eq!(report.headers.len(), 3);
    assert_eq!(report.columns.len(), 3);

    // Timestamp column
    let ts_col = &report.columns[0];
    assert_eq!(ts_col.name, "timestamp");
    assert_eq!(ts_col.dtype, "datetime");
    assert_eq!(ts_col.valid_count, 3);
    assert_eq!(ts_col.null_count, 0);

    // sensor_a: row 1 has value, row 2 is empty (null), row 3 has value => 2 valid, 1 null
    let col_a = report.columns.iter().find(|c| c.name == "sensor_a").unwrap();
    assert_eq!(col_a.dtype, "numeric");
    assert_eq!(col_a.valid_count, 2);
    assert_eq!(col_a.null_count, 1);

    // sensor_b: row 1 has value, row 2 has value, row 3 is empty => 2 valid, 1 null
    let col_b = report.columns.iter().find(|c| c.name == "sensor_b").unwrap();
    assert_eq!(col_b.dtype, "numeric");
    assert_eq!(col_b.valid_count, 2);
    assert_eq!(col_b.null_count, 1);
}

#[test]
fn build_load_report_includes_parse_failure_warnings() {
    let csv = "timestamp,sensor_a\n\
               2024-01-01T00:00:00,hello\n\
               2024-01-01T01:00:00,2.0\n";
    let (_f, path) = write_temp_csv(csv);

    let merge_result = csv_processor::read_merge_csvs_with_report(vec![path]).unwrap();
    let report = csv_processor::build_load_report(&merge_result);

    // Should have a warning about non-numeric values replaced with NaN
    assert!(report.warnings.iter().any(|w| w.contains("non-numeric") && w.contains("sensor_a")));
}

// ============================================================
// Tests for load_mapping_csv_data
// ============================================================

#[test]
fn load_mapping_csv_basic() {
    let csv = "tag,name,unit\n\
               SENS_001,Temperature,degC\n\
               SENS_002,Pressure,bar\n";
    let (_f, path) = write_temp_csv(csv);

    let result = csv_processor::load_mapping_csv_data(&path).unwrap();
    assert_eq!(result.headers, vec!["tag", "name", "unit"]);
    assert_eq!(result.rows.len(), 2);
    assert_eq!(result.rows[0], vec!["SENS_001", "Temperature", "degC"]);
    assert_eq!(result.rows[1], vec!["SENS_002", "Pressure", "bar"]);
}

#[test]
fn load_mapping_csv_empty_file_with_headers() {
    let csv = "tag,name\n";
    let (_f, path) = write_temp_csv(csv);

    let result = csv_processor::load_mapping_csv_data(&path).unwrap();
    assert_eq!(result.headers, vec!["tag", "name"]);
    assert_eq!(result.rows.len(), 0);
}

#[test]
fn load_mapping_csv_file_not_found() {
    let result = csv_processor::load_mapping_csv_data("/nonexistent/mapping.csv");
    assert!(result.is_err());
}

#[test]
fn load_mapping_csv_preserves_strings() {
    // Values with spaces, special chars, numeric-looking strings should all be strings
    let csv = "id,description\n\
               A1, Some sensor with spaces \n\
               B2,123.456\n";
    let (_f, path) = write_temp_csv(csv);

    let result = csv_processor::load_mapping_csv_data(&path).unwrap();
    assert_eq!(result.rows.len(), 2);
    // csv crate does NOT trim by default, but values are returned as-is
    assert_eq!(result.rows[1][1], "123.456"); // kept as string, not parsed
}

// ============================================================
// Tests for apply_mapping
// ============================================================

#[test]
fn apply_mapping_all_matched() {
    let mapping_data = csv_processor::MappingData {
        headers: vec!["tag".into(), "name".into()],
        rows: vec![
            vec!["SENS_A".into(), "Temperature".into()],
            vec!["SENS_B".into(), "Pressure".into()],
        ],
    };
    let dataset_headers = vec![
        "timestamp".to_string(),
        "SENS_A".to_string(),
        "SENS_B".to_string(),
    ];

    let result =
        csv_processor::apply_mapping("tag", "name", &mapping_data, &dataset_headers).unwrap();

    assert_eq!(result.mapped.len(), 2);
    assert_eq!(result.not_in_dataset.len(), 0);
    // timestamp is excluded from not_in_mapping
    assert_eq!(result.not_in_mapping.len(), 0);
}

#[test]
fn apply_mapping_some_not_in_dataset() {
    let mapping_data = csv_processor::MappingData {
        headers: vec!["tag".into(), "name".into()],
        rows: vec![
            vec!["SENS_A".into(), "Temperature".into()],
            vec!["SENS_X".into(), "Unknown".into()], // not in dataset
        ],
    };
    let dataset_headers = vec!["timestamp".to_string(), "SENS_A".to_string()];

    let result =
        csv_processor::apply_mapping("tag", "name", &mapping_data, &dataset_headers).unwrap();

    assert_eq!(result.mapped.len(), 1);
    assert_eq!(result.mapped[0].tag, "SENS_A");
    assert_eq!(result.not_in_dataset.len(), 1);
    assert_eq!(result.not_in_dataset[0].tag, "SENS_X");
    assert_eq!(result.not_in_mapping.len(), 0);
}

#[test]
fn apply_mapping_some_not_in_mapping() {
    let mapping_data = csv_processor::MappingData {
        headers: vec!["tag".into(), "name".into()],
        rows: vec![vec!["SENS_A".into(), "Temperature".into()]],
    };
    let dataset_headers = vec![
        "timestamp".to_string(),
        "SENS_A".to_string(),
        "SENS_B".to_string(), // not in mapping
    ];

    let result =
        csv_processor::apply_mapping("tag", "name", &mapping_data, &dataset_headers).unwrap();

    assert_eq!(result.mapped.len(), 1);
    assert_eq!(result.not_in_mapping.len(), 1);
    assert_eq!(result.not_in_mapping[0], "SENS_B");
}

#[test]
fn apply_mapping_empty_mapping() {
    let mapping_data = csv_processor::MappingData {
        headers: vec!["tag".into(), "name".into()],
        rows: vec![],
    };
    let dataset_headers = vec![
        "timestamp".to_string(),
        "SENS_A".to_string(),
        "SENS_B".to_string(),
    ];

    let result =
        csv_processor::apply_mapping("tag", "name", &mapping_data, &dataset_headers).unwrap();

    assert_eq!(result.mapped.len(), 0);
    assert_eq!(result.not_in_dataset.len(), 0);
    // All non-timestamp dataset columns should be not_in_mapping
    assert_eq!(result.not_in_mapping.len(), 2);
}

#[test]
fn apply_mapping_invalid_tag_column() {
    let mapping_data = csv_processor::MappingData {
        headers: vec!["tag".into(), "name".into()],
        rows: vec![],
    };
    let dataset_headers = vec!["timestamp".to_string()];

    let result = csv_processor::apply_mapping(
        "nonexistent_col",
        "name",
        &mapping_data,
        &dataset_headers,
    );
    assert!(result.is_err());
    assert!(result
        .unwrap_err()
        .contains("Tag column 'nonexistent_col' not found"));
}

#[test]
fn apply_mapping_invalid_name_column() {
    let mapping_data = csv_processor::MappingData {
        headers: vec!["tag".into(), "name".into()],
        rows: vec![],
    };
    let dataset_headers = vec!["timestamp".to_string()];

    let result = csv_processor::apply_mapping("tag", "nonexistent", &mapping_data, &dataset_headers);
    assert!(result.is_err());
    assert!(result
        .unwrap_err()
        .contains("Name column 'nonexistent' not found"));
}

#[test]
fn apply_mapping_timestamp_excluded_from_not_in_mapping() {
    // Even with empty mapping, "timestamp" and "time" columns should NOT appear in not_in_mapping
    let mapping_data = csv_processor::MappingData {
        headers: vec!["tag".into(), "name".into()],
        rows: vec![],
    };
    let dataset_headers = vec![
        "timestamp".to_string(),
        "Time".to_string(),
        "SENS_A".to_string(),
    ];

    let result =
        csv_processor::apply_mapping("tag", "name", &mapping_data, &dataset_headers).unwrap();

    // Only SENS_A should be in not_in_mapping, not timestamp/Time
    assert_eq!(result.not_in_mapping, vec!["SENS_A".to_string()]);
}
