use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::BufReader;
use std::time::Instant;

/// Hard cap on the size of a single CSV the desktop app will accept.
/// At 2 GB the per-row Vec<Option<f64>> staging memory and `to_csv` pretty-
/// printing dominate; anything larger should be pre-processed externally.
const MAX_CSV_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CsvRecord {
    pub timestamp: Option<String>,
    pub values: Vec<Option<f64>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProcessedData {
    pub headers: Vec<String>,
    pub rows: Vec<CsvRecord>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CsvMetadata {
    pub headers: Vec<String>,
    pub total_rows: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SensorMetadata {
    pub tag: String,
    pub description: String,
    pub unit: String,
    pub component: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ColumnInfo {
    pub name: String,
    pub dtype: String,
    pub null_count: usize,
    pub valid_count: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CsvLoadReport {
    pub headers: Vec<String>,
    pub total_rows: usize,
    pub columns: Vec<ColumnInfo>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MappingData {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MappingResult {
    pub matched: Vec<String>,
    pub not_in_dataset: Vec<String>,
    pub not_in_mapping: Vec<String>,
}

use rayon::prelude::*;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};

/// Result of reading a single CSV, including parse failure tracking.
pub struct ReadCsvResult {
    pub data: ProcessedData,
    /// Per-column count of non-empty fields that failed to parse as f64.
    /// Indexed by column position in headers (includes timestamp column position).
    pub parse_fail_counts: Vec<usize>,
}

pub fn read_csv_with_stats(path: &str) -> Result<ReadCsvResult, String> {
    let total_start = Instant::now();
    // Refuse pathologically-large CSVs up front so we don't OOM partway
    // through the parallel parse. `std::fs::metadata` follows symlinks,
    // which is what we want — we want the size of what we'd actually open.
    let size = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    if size > MAX_CSV_BYTES {
        let size_gb = size as f64 / (1024.0 * 1024.0 * 1024.0);
        return Err(format!(
            "CSV file too large: {:.1} GB (max 2 GB). Pre-process or split the file.",
            size_gb
        ));
    }
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut rdr = csv::Reader::from_reader(BufReader::new(file));

    let headers = rdr.headers().map_err(|e| e.to_string())?.clone();
    let header_list: Vec<String> = headers.iter().map(|s| s.trim().to_string()).collect();
    let num_cols = header_list.len();

    let timestamp_idx = header_list
        .iter()
        .position(|h| h.eq_ignore_ascii_case("timestamp") || h.eq_ignore_ascii_case("time"));

    // 1. Read all raw byte records into memory (Sequential I/O)
    let io_start = Instant::now();
    let mut raw_records = Vec::new();
    let mut byte_record = csv::ByteRecord::new();
    while rdr
        .read_byte_record(&mut byte_record)
        .map_err(|e| e.to_string())?
    {
        raw_records.push(byte_record.clone());
    }
    println!("Reading raw bytes took: {:?}", io_start.elapsed());

    // Create atomic counters for parse failures per column
    let fail_counters: Vec<AtomicUsize> = (0..num_cols).map(|_| AtomicUsize::new(0)).collect();

    // 2. Parse records in parallel (Parallel CPU)
    let parse_start = Instant::now();
    let records: Vec<CsvRecord> = raw_records
        .par_iter()
        .map(|raw_record| {
            let mut timestamp: Option<String> = None;
            let mut values: Vec<Option<f64>> = Vec::with_capacity(num_cols);

            for (i, field) in raw_record.iter().enumerate() {
                let field_str = std::str::from_utf8(field).unwrap_or("");

                if Some(i) == timestamp_idx {
                    if !field_str.trim().is_empty() {
                        timestamp = Some(field_str.to_string());
                    }
                    values.push(None);
                } else {
                    let trimmed = field_str.trim();
                    if trimmed.is_empty() {
                        values.push(None);
                    } else {
                        match trimmed.parse::<f64>() {
                            Ok(v) => values.push(Some(v)),
                            Err(_) => {
                                // Track parse failure for this column
                                if i < num_cols {
                                    fail_counters[i].fetch_add(1, Ordering::Relaxed);
                                }
                                values.push(None);
                            }
                        }
                    }
                }
            }

            CsvRecord { timestamp, values }
        })
        .collect();

    println!("Parallel parsing took: {:?}", parse_start.elapsed());
    println!("Total read_csv took: {:?}", total_start.elapsed());

    let parse_fail_counts: Vec<usize> = fail_counters
        .iter()
        .map(|c| c.load(Ordering::Relaxed))
        .collect();

    Ok(ReadCsvResult {
        data: ProcessedData {
            headers: header_list,
            rows: records,
        },
        parse_fail_counts,
    })
}

/// Legacy read_csv for backward compatibility.
#[allow(dead_code)]
pub fn read_csv(path: &str) -> Result<ProcessedData, String> {
    read_csv_with_stats(path).map(|r| r.data)
}

/// Extended merge result including warnings and per-column parse failure info.
pub struct MergeResult {
    pub data: ProcessedData,
    pub warnings: Vec<String>,
    /// Per-column (in merged header order) count of non-empty fields that failed f64 parse.
    pub parse_fail_counts: Vec<usize>,
}

pub fn read_merge_csvs_with_report(paths: Vec<String>) -> Result<MergeResult, String> {
    if paths.is_empty() {
        return Err("No file paths provided".to_string());
    }

    let mut warnings: Vec<String> = Vec::new();

    // 1. Read all files individually (with stats)
    let mut results = Vec::new();
    for path in &paths {
        results.push(read_csv_with_stats(path)?);
    }

    if results.is_empty() {
        return Err("No data loaded".to_string());
    }

    // 2. Detect duplicate column names across files
    if paths.len() > 1 {
        let mut header_sources: HashMap<String, Vec<usize>> = HashMap::new();
        for (file_idx, result) in results.iter().enumerate() {
            let is_timestamp = |h: &str| {
                h.eq_ignore_ascii_case("timestamp") || h.eq_ignore_ascii_case("time")
            };
            for h in &result.data.headers {
                if is_timestamp(h) {
                    continue;
                }
                header_sources
                    .entry(h.to_lowercase())
                    .or_default()
                    .push(file_idx);
            }
        }
        for (col_lower, file_indices) in &header_sources {
            if file_indices.len() > 1 {
                let file_nums: Vec<String> = file_indices.iter().map(|i| format!("file {}", i + 1)).collect();
                warnings.push(format!(
                    "Duplicate column '{}' found in {}",
                    col_lower,
                    file_nums.join(", ")
                ));
            }
        }
    }

    // 3. Determine global headers (Superset)
    let mut global_headers: Vec<String> = Vec::new();
    let mut seen_headers: HashSet<String> = HashSet::new();

    let is_timestamp = |h: &str| h.eq_ignore_ascii_case("timestamp") || h.eq_ignore_ascii_case("time");

    let canonical_ts_header = results[0]
        .data
        .headers
        .iter()
        .find(|h| is_timestamp(h))
        .cloned()
        .unwrap_or_else(|| "timestamp".to_string());

    global_headers.push(canonical_ts_header.clone());
    seen_headers.insert(canonical_ts_header.clone().to_lowercase());

    for result in &results {
        for h in &result.data.headers {
            if is_timestamp(h) {
                continue;
            }
            if !seen_headers.contains(&h.to_lowercase()) {
                global_headers.push(h.clone());
                seen_headers.insert(h.to_lowercase());
            }
        }
    }

    // Build a mapping from global header name (lowercase) to global index
    let global_header_idx: HashMap<String, usize> = global_headers
        .iter()
        .enumerate()
        .map(|(i, h)| (h.to_lowercase(), i))
        .collect();

    // 4. Aggregate parse_fail_counts per global column
    let mut global_fail_counts: Vec<usize> = vec![0; global_headers.len()];

    for result in &results {
        for (local_idx, h) in result.data.headers.iter().enumerate() {
            let key = if is_timestamp(h) {
                canonical_ts_header.to_lowercase()
            } else {
                h.to_lowercase()
            };
            if let Some(&global_idx) = global_header_idx.get(&key) {
                if local_idx < result.parse_fail_counts.len() {
                    global_fail_counts[global_idx] += result.parse_fail_counts[local_idx];
                }
            }
        }
    }

    // 5. Merge Rows
    let mut merged_map: BTreeMap<String, Vec<Option<f64>>> = BTreeMap::new();

    for result in &results {
        let ds = &result.data;
        let mut col_map: Vec<usize> = Vec::with_capacity(ds.headers.len());
        for h in &ds.headers {
            if is_timestamp(h) {
                col_map.push(0);
            } else if let Some(&pos) = global_header_idx.get(&h.to_lowercase()) {
                col_map.push(pos);
            } else {
                col_map.push(0);
            }
        }

        for row in &ds.rows {
            if let Some(ts) = &row.timestamp {
                let entry = merged_map
                    .entry(ts.clone())
                    .or_insert_with(|| vec![None; global_headers.len()]);

                for (local_idx, val) in row.values.iter().enumerate() {
                    if local_idx < col_map.len() {
                        let global_idx = col_map[local_idx];
                        if let Some(v) = val {
                            entry[global_idx] = Some(*v);
                        }
                    }
                }
            }
        }
    }

    // 6. Detect duplicate timestamps
    if paths.len() > 1 {
        // Count how many files contribute each timestamp
        let mut ts_file_count: HashMap<String, usize> = HashMap::new();
        for result in &results {
            let mut seen_ts: HashSet<String> = HashSet::new();
            for row in &result.data.rows {
                if let Some(ts) = &row.timestamp {
                    if seen_ts.insert(ts.clone()) {
                        *ts_file_count.entry(ts.clone()).or_insert(0) += 1;
                    }
                }
            }
        }
        let dup_count = ts_file_count.values().filter(|&&c| c > 1).count();
        if dup_count > 0 {
            warnings.push(format!(
                "{} duplicate timestamp(s) found across files (values were merged/overwritten)",
                dup_count
            ));
        }
    }

    // 7. Convert back to ProcessedData
    let merged_rows: Vec<CsvRecord> = merged_map
        .into_iter()
        .map(|(ts, values)| CsvRecord {
            timestamp: Some(ts),
            values,
        })
        .collect();

    println!(
        "Merged {} files. Total rows: {}",
        results.len(),
        merged_rows.len()
    );
    if !merged_rows.is_empty() {
        println!(
            "Timestamp Range: {:?} - {:?}",
            merged_rows.first().and_then(|r| r.timestamp.as_ref()),
            merged_rows.last().and_then(|r| r.timestamp.as_ref())
        );
    }

    Ok(MergeResult {
        data: ProcessedData {
            headers: global_headers,
            rows: merged_rows,
        },
        warnings,
        parse_fail_counts: global_fail_counts,
    })
}

#[allow(dead_code)]
pub fn read_merge_csvs(paths: Vec<String>) -> Result<ProcessedData, String> {
    read_merge_csvs_with_report(paths).map(|r| r.data)
}

/// Build a CsvLoadReport from merge results and the final ProcessedData.
pub fn build_load_report(merge_result: &MergeResult) -> CsvLoadReport {
    let data = &merge_result.data;
    let total_rows = data.rows.len();

    let is_timestamp =
        |h: &str| h.eq_ignore_ascii_case("timestamp") || h.eq_ignore_ascii_case("time");

    let columns: Vec<ColumnInfo> = data
        .headers
        .iter()
        .enumerate()
        .map(|(col_idx, name)| {
            let dtype = if is_timestamp(name) {
                "datetime".to_string()
            } else {
                "numeric".to_string()
            };

            // Count nulls and valid values for this column
            let (null_count, valid_count) = if is_timestamp(name) {
                // For the timestamp column, count based on the timestamp field
                let valid = data.rows.iter().filter(|r| r.timestamp.is_some()).count();
                (total_rows - valid, valid)
            } else {
                let valid = data
                    .rows
                    .iter()
                    .filter(|r| {
                        col_idx < r.values.len() && r.values[col_idx].is_some()
                    })
                    .count();
                (total_rows - valid, valid)
            };

            ColumnInfo {
                name: name.clone(),
                dtype,
                null_count,
                valid_count,
            }
        })
        .collect();

    // Build warnings: start with merge warnings, then add parse-failure warnings
    let mut warnings = merge_result.warnings.clone();

    for (col_idx, name) in data.headers.iter().enumerate() {
        if is_timestamp(name) {
            continue;
        }
        if col_idx < merge_result.parse_fail_counts.len() {
            let fail_count = merge_result.parse_fail_counts[col_idx];
            if fail_count > 0 {
                warnings.push(format!(
                    "Column '{}': {} non-numeric value(s) replaced with NaN",
                    name, fail_count
                ));
            }
        }
    }

    CsvLoadReport {
        headers: data.headers.clone(),
        total_rows,
        columns,
        warnings,
    }
}

/// Load a mapping CSV: returns all data as strings (no numeric parsing).
pub fn load_mapping_csv_data(path: &str) -> Result<MappingData, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut rdr = csv::Reader::from_reader(BufReader::new(file));

    let headers_record = rdr.headers().map_err(|e| e.to_string())?.clone();
    let headers: Vec<String> = headers_record
        .iter()
        .map(|s| s.trim().to_string())
        .collect();

    let mut rows: Vec<Vec<String>> = Vec::new();
    for result in rdr.records() {
        let record = result.map_err(|e| e.to_string())?;
        let row: Vec<String> = record.iter().map(|s| s.to_string()).collect();
        rows.push(row);
    }

    Ok(MappingData { headers, rows })
}

/// Apply key column mapping: compare mapping key values against dataset headers.
pub fn apply_mapping(
    key_column: &str,
    mapping_data: &MappingData,
    dataset_headers: &[String],
) -> Result<MappingResult, String> {
    // Find key column index in mapping headers
    let key_idx = mapping_data
        .headers
        .iter()
        .position(|h| h == key_column)
        .ok_or_else(|| format!("Key column '{}' not found in mapping headers", key_column))?;

    // Extract unique key values from mapping rows
    let mut key_values: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for row in &mapping_data.rows {
        let val = row.get(key_idx).map(|s| s.trim().to_string()).unwrap_or_default();
        if !val.is_empty() && seen.insert(val.clone()) {
            key_values.push(val);
        }
    }

    // Build a set of dataset headers for quick lookup
    let dataset_set: HashSet<&str> = dataset_headers.iter().map(|s| s.as_str()).collect();

    let mut matched = Vec::new();
    let mut not_in_dataset = Vec::new();

    for key in &key_values {
        if dataset_set.contains(key.as_str()) {
            matched.push(key.clone());
        } else {
            not_in_dataset.push(key.clone());
        }
    }

    // Find dataset headers not in mapping key values
    let is_timestamp =
        |h: &str| h.eq_ignore_ascii_case("timestamp") || h.eq_ignore_ascii_case("time");

    let mapping_keys: HashSet<&str> = key_values.iter().map(|s| s.as_str()).collect();
    let not_in_mapping: Vec<String> = dataset_headers
        .iter()
        .filter(|h| !is_timestamp(h) && !mapping_keys.contains(h.as_str()))
        .cloned()
        .collect();

    Ok(MappingResult {
        matched,
        not_in_dataset,
        not_in_mapping,
    })
}

pub fn load_metadata(path: &str) -> Result<Vec<SensorMetadata>, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut rdr = csv::Reader::from_reader(BufReader::new(file));
    let headers = rdr.headers().map_err(|e| e.to_string())?.clone();

    let mut tag_idx = None;
    let mut desc_idx = None;
    let mut unit_idx = None;
    let mut comp_idx = None;

    for (i, h) in headers.iter().enumerate() {
        match h.trim().to_lowercase().as_str() {
            "tag" => tag_idx = Some(i),
            "description" => desc_idx = Some(i),
            "unit" => unit_idx = Some(i),
            "component" => comp_idx = Some(i),
            _ => {}
        }
    }

    let mut metadata_list = Vec::new();

    for result in rdr.records() {
        let record = result.map_err(|e| e.to_string())?;

        let tag = tag_idx
            .and_then(|i| record.get(i))
            .unwrap_or("")
            .to_string();
        if tag.trim().is_empty() {
            continue;
        }

        let description = desc_idx
            .and_then(|i| record.get(i))
            .unwrap_or("")
            .to_string();
        let unit = unit_idx
            .and_then(|i| record.get(i))
            .unwrap_or("")
            .to_string();
        let component = comp_idx
            .and_then(|i| record.get(i))
            .unwrap_or("")
            .to_string();

        metadata_list.push(SensorMetadata {
            tag,
            description,
            unit,
            component,
        });
    }

    Ok(metadata_list)
}

#[allow(dead_code)]
pub fn sample_data(data: Vec<CsvRecord>) -> Vec<CsvRecord> {
    data
}
