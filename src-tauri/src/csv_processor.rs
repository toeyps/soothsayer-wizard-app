use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::BufReader;
use std::time::Instant;

/// Hard cap on the size of a single CSV the desktop app will accept.
/// At 2 GB the parsed columns (~8 bytes/cell) plus transient batch buffers
/// dominate; anything larger should be pre-processed externally.
const MAX_CSV_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Sentinel in [`ColumnarData::ts_parsed`] for a row whose timestamp is
/// missing or failed to parse. Any timestamp filter excludes such rows,
/// matching the legacy per-query parse behavior.
pub const TS_MISSING: i64 = i64::MIN;

/// Wire-format row for sampled scatter payloads and table pages. NOT the
/// in-RAM store — the loaded dataset lives in [`ColumnarData`]; records of
/// this shape are materialized only at the IPC boundary (see
/// [`ColumnarData::wire_record`]), and every command that emits them is
/// bounded (`get_scatter_sample`, `get_table_page`).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CsvRecord {
    pub timestamp: Option<String>,
    pub values: Vec<Option<f64>>,
}

/// In-RAM store for the loaded dataset — column-major.
///
/// Why columnar: `Option<f64>` occupies 16 bytes (the discriminant pads to
/// f64 alignment) and a per-row `Vec` adds a 24-byte header plus its own
/// heap allocation. One contiguous `Vec<f64>` per sensor halves the
/// dominant term (8 bytes/cell, NaN = missing) and drops the per-row
/// overhead entirely. Every aggregation in lib.rs walks columns, so this
/// is also the cache-friendly orientation for stats/filter/projection.
pub struct ColumnarData {
    /// Column names; `headers[0]` is the canonical timestamp column after
    /// the merge step.
    pub headers: Vec<String>,
    /// Original timestamp text per row, kept verbatim so rows shipped to
    /// the frontend round-trip exactly what the CSV contained.
    pub timestamps: Vec<Option<String>>,
    /// Timestamps parsed ONCE at load to epoch microseconds ([`TS_MISSING`]
    /// when absent/unparseable). Filters compare against this — never
    /// re-parse `timestamps` per query.
    pub ts_parsed: Vec<i64>,
    /// `columns[c][r]` = value of column `c` at row `r`; NaN = missing.
    /// Every column has length `n_rows()`, including the timestamp
    /// column's all-NaN placeholder, so header indices map 1:1.
    pub columns: Vec<Vec<f64>>,
}

impl ColumnarData {
    /// Assemble a dataset from already-built parts, computing `ts_parsed`
    /// (the one-time timestamp parse) in parallel.
    pub fn from_parts(
        headers: Vec<String>,
        timestamps: Vec<Option<String>>,
        columns: Vec<Vec<f64>>,
    ) -> Self {
        use rayon::prelude::*;
        debug_assert!(columns.iter().all(|c| c.len() == timestamps.len()));
        let ts_parsed: Vec<i64> = timestamps
            .par_iter()
            .map(|t| {
                t.as_deref()
                    .and_then(parse_timestamp)
                    .map(ts_to_micros)
                    .unwrap_or(TS_MISSING)
            })
            .collect();
        ColumnarData {
            headers,
            timestamps,
            ts_parsed,
            columns,
        }
    }

    pub fn n_rows(&self) -> usize {
        self.timestamps.len()
    }

    #[inline]
    pub fn col_index(&self, name: &str) -> Option<usize> {
        self.headers.iter().position(|h| h == name)
    }

    /// Cell accessor with the legacy `Option` semantics: NaN (missing)
    /// maps to `None`, everything else (including ±inf) to `Some`.
    /// Out-of-range indices also yield `None`.
    #[inline]
    pub fn value(&self, col: usize, row: usize) -> Option<f64> {
        let v = *self.columns.get(col)?.get(row)?;
        if v.is_nan() {
            None
        } else {
            Some(v)
        }
    }

    /// Materialize one row in the wire shape, projected to `col_indices`.
    pub fn wire_record(&self, row: usize, col_indices: &[usize]) -> CsvRecord {
        CsvRecord {
            timestamp: self.timestamps[row].clone(),
            values: col_indices.iter().map(|&c| self.value(c, row)).collect(),
        }
    }
}

/// Try the common timestamp formats and return the parsed `NaiveDateTime`,
/// or `None` if no format matches. Single source of truth for every
/// timestamp parse in the app (load-time row parsing and per-query filter
/// bounds alike).
pub fn parse_timestamp(s: &str) -> Option<chrono::NaiveDateTime> {
    chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f")
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S"))
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M"))
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S%.f"))
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S"))
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M"))
        .or_else(|_| {
            chrono::DateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S%:z").map(|dt| dt.naive_local())
        })
        .or_else(|_| {
            chrono::DateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%:z").map(|dt| dt.naive_local())
        })
        .or_else(|_| {
            chrono::DateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S%.f%:z")
                .map(|dt| dt.naive_local())
        })
        .or_else(|_| {
            chrono::DateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f%:z")
                .map(|dt| dt.naive_local())
        })
        .ok()
}

/// `NaiveDateTime` → epoch microseconds (the `ts_parsed` representation).
pub fn ts_to_micros(dt: chrono::NaiveDateTime) -> i64 {
    dt.and_utc().timestamp_micros()
}

/// Epoch microseconds → `NaiveDateTime`, for formatting saved-model date
/// bounds. `None` only for values outside chrono's representable range.
pub fn micros_to_naive(us: i64) -> Option<chrono::NaiveDateTime> {
    chrono::DateTime::from_timestamp_micros(us).map(|dt| dt.naive_utc())
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
///
/// `data.ts_parsed` is left EMPTY at this stage — the merge step may drop,
/// reorder, or fold rows, so the (parallel) timestamp parse happens once,
/// at the end of the merge, via [`ColumnarData::from_parts`].
pub struct ReadCsvResult {
    pub data: ColumnarData,
    /// Per-column count of non-empty fields that failed to parse as f64.
    /// Indexed by column position in headers (includes timestamp column position).
    pub parse_fail_counts: Vec<usize>,
}

pub fn read_csv_with_stats(path: &str) -> Result<ReadCsvResult, String> {
    let total_start = Instant::now();
    // Refuse pathologically-large CSVs up front so we don't OOM partway
    // through the parse. `std::fs::metadata` follows symlinks, which is
    // what we want — we want the size of what we'd actually open.
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

    // Pre-size the column vecs from file size / approx bytes-per-row so
    // they don't repeatedly reallocate (and memcpy the whole spine) while
    // ingesting millions of records; clamp so a pathological (very-few-
    // column) file can't over-allocate.
    let bytes_per_row_est = (num_cols * 8 + 20).max(1);
    let est_rows = (size as usize / bytes_per_row_est).clamp(1024, 16_000_000);

    let mut timestamps: Vec<Option<String>> = Vec::with_capacity(est_rows);
    let mut columns: Vec<Vec<f64>> = (0..num_cols)
        .map(|_| Vec::with_capacity(est_rows))
        .collect();
    let fail_counters: Vec<AtomicUsize> = (0..num_cols).map(|_| AtomicUsize::new(0)).collect();

    // Read + parse in bounded batches: at most BATCH_ROWS raw ByteRecords
    // are alive at any moment. (The previous implementation buffered the
    // ENTIRE file as ByteRecords before parsing — a whole extra file-size
    // of transient RAM on a 2 GB CSV.) Each batch is split into chunks
    // parsed to columnar blocks in parallel, then appended in order.
    const BATCH_ROWS: usize = 65_536;
    const PAR_CHUNK: usize = 4_096;

    /// One parsed chunk: its timestamps + its slice of every column.
    type ColumnarBlock = (Vec<Option<String>>, Vec<Vec<f64>>);

    let mut batch: Vec<csv::ByteRecord> = Vec::with_capacity(BATCH_ROWS);
    let mut record = csv::ByteRecord::new();
    let mut eof = false;
    let mut io_time = std::time::Duration::ZERO;
    let mut parse_time = std::time::Duration::ZERO;

    while !eof {
        batch.clear();
        let io_start = Instant::now();
        while batch.len() < BATCH_ROWS {
            if rdr
                .read_byte_record(&mut record)
                .map_err(|e| e.to_string())?
            {
                batch.push(record.clone());
            } else {
                eof = true;
                break;
            }
        }
        io_time += io_start.elapsed();
        if batch.is_empty() {
            break;
        }

        let parse_start = Instant::now();
        let blocks: Vec<ColumnarBlock> = batch
            .par_chunks(PAR_CHUNK)
            .map(|chunk| {
                let mut ts_blk: Vec<Option<String>> = Vec::with_capacity(chunk.len());
                let mut col_blk: Vec<Vec<f64>> = (0..num_cols)
                    .map(|_| Vec::with_capacity(chunk.len()))
                    .collect();
                for rec in chunk {
                    let mut ts: Option<String> = None;
                    for (c, col) in col_blk.iter_mut().enumerate() {
                        let field_str = rec
                            .get(c)
                            .map(|f| std::str::from_utf8(f).unwrap_or(""))
                            .unwrap_or("");
                        if Some(c) == timestamp_idx {
                            if !field_str.trim().is_empty() {
                                ts = Some(field_str.to_string());
                            }
                            col.push(f64::NAN);
                        } else {
                            let trimmed = field_str.trim();
                            if trimmed.is_empty() {
                                col.push(f64::NAN);
                            } else {
                                match trimmed.parse::<f64>() {
                                    Ok(v) => col.push(v),
                                    Err(_) => {
                                        fail_counters[c].fetch_add(1, Ordering::Relaxed);
                                        col.push(f64::NAN);
                                    }
                                }
                            }
                        }
                    }
                    ts_blk.push(ts);
                }
                (ts_blk, col_blk)
            })
            .collect();

        for (ts_blk, col_blk) in blocks {
            timestamps.extend(ts_blk);
            for (c, blk) in col_blk.into_iter().enumerate() {
                columns[c].extend_from_slice(&blk);
            }
        }
        parse_time += parse_start.elapsed();
    }

    println!("Reading raw bytes took: {:?}", io_time);
    println!("Parallel parsing took: {:?}", parse_time);
    println!("Total read_csv took: {:?}", total_start.elapsed());

    let parse_fail_counts: Vec<usize> = fail_counters
        .iter()
        .map(|c| c.load(Ordering::Relaxed))
        .collect();

    Ok(ReadCsvResult {
        data: ColumnarData {
            headers: header_list,
            timestamps,
            ts_parsed: Vec::new(), // filled post-merge by from_parts
            columns,
        },
        parse_fail_counts,
    })
}

/// Extended merge result including warnings and per-column parse failure info.
pub struct MergeResult {
    pub data: ColumnarData,
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

    // Single file → skip the cross-file timestamp merge entirely. That merge
    // rebuilds every row through a single-threaded BTreeMap (cloning the
    // timestamp key per row) — pure overhead when there's nothing to merge.
    // `merge_single_file` produces the SAME result (timestamp column first,
    // null-timestamp rows dropped, ordered by timestamp, duplicate timestamps
    // merged) but works on indices + per-column gathers.
    if results.len() == 1 {
        return Ok(merge_single_file(results.pop().unwrap()));
    }

    // 2. Detect duplicate column names across files
    let is_timestamp =
        |h: &str| h.eq_ignore_ascii_case("timestamp") || h.eq_ignore_ascii_case("time");

    if paths.len() > 1 {
        let mut header_sources: HashMap<String, Vec<usize>> = HashMap::new();
        for (file_idx, result) in results.iter().enumerate() {
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
                let file_nums: Vec<String> =
                    file_indices.iter().map(|i| format!("file {}", i + 1)).collect();
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
    let g = global_headers.len();

    // Build a mapping from global header name (lowercase) to global index
    let global_header_idx: HashMap<String, usize> = global_headers
        .iter()
        .enumerate()
        .map(|(i, h)| (h.to_lowercase(), i))
        .collect();

    // 4. Aggregate parse_fail_counts per global column
    let mut global_fail_counts: Vec<usize> = vec![0; g];

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

    // 5. Merge rows — keyed by timestamp string. Staging rows are already
    // NaN-missing f64 vecs in the global layout (half the footprint of the
    // old Vec<Option<f64>> staging).
    let mut merged_map: BTreeMap<String, Vec<f64>> = BTreeMap::new();

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

        for r in 0..ds.n_rows() {
            if let Some(ts) = &ds.timestamps[r] {
                let entry = merged_map
                    .entry(ts.clone())
                    .or_insert_with(|| vec![f64::NAN; g]);

                for (local_idx, &global_idx) in col_map.iter().enumerate() {
                    let v = ds.columns[local_idx][r];
                    // The local timestamp column is all-NaN, so it never
                    // overwrites slot 0 — same as the old `val.is_some()` guard.
                    if !v.is_nan() {
                        entry[global_idx] = v;
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
            let mut seen_ts: HashSet<&str> = HashSet::new();
            for ts in result.data.timestamps.iter().flatten() {
                if seen_ts.insert(ts.as_str()) {
                    *ts_file_count.entry(ts.clone()).or_insert(0) += 1;
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

    // 7. Convert the (timestamp-ordered) map into columnar storage.
    let n_out = merged_map.len();
    let mut out_timestamps: Vec<Option<String>> = Vec::with_capacity(n_out);
    let mut out_columns: Vec<Vec<f64>> = (0..g).map(|_| Vec::with_capacity(n_out)).collect();
    for (ts, vals) in merged_map {
        out_timestamps.push(Some(ts));
        for (c, v) in vals.into_iter().enumerate() {
            out_columns[c].push(v);
        }
    }

    println!("Merged {} files. Total rows: {}", results.len(), n_out);
    if n_out > 0 {
        println!(
            "Timestamp Range: {:?} - {:?}",
            out_timestamps.first().and_then(|t| t.as_ref()),
            out_timestamps.last().and_then(|t| t.as_ref())
        );
    }

    Ok(MergeResult {
        data: ColumnarData::from_parts(global_headers, out_timestamps, out_columns),
        warnings,
        parse_fail_counts: global_fail_counts,
    })
}

/// Single-file specialization of [`read_merge_csvs_with_report`]'s merge step.
///
/// Produces an identical `MergeResult` — timestamp column canonicalized to
/// the front, rows without a timestamp dropped, rows ordered by timestamp
/// (string order, matching the BTreeMap path), duplicate timestamps merged
/// (later non-null value wins) — but works on row INDICES and per-column
/// gathers instead of moving row payloads around. A clean, already-ordered
/// file with unique timestamps (the common case for sensor logs) passes the
/// parsed columns through without any copy at all.
fn merge_single_file(result: ReadCsvResult) -> MergeResult {
    let is_timestamp =
        |h: &str| h.eq_ignore_ascii_case("timestamp") || h.eq_ignore_ascii_case("time");

    let ReadCsvResult {
        data: ds,
        parse_fail_counts,
    } = result;

    // Global headers: the timestamp column first, then the rest in file order.
    let canonical_ts = ds
        .headers
        .iter()
        .find(|h| is_timestamp(h))
        .cloned()
        .unwrap_or_else(|| "timestamp".to_string());
    let mut global_headers: Vec<String> = Vec::with_capacity(ds.headers.len());
    global_headers.push(canonical_ts);
    for h in &ds.headers {
        if !is_timestamp(h) {
            global_headers.push(h.clone());
        }
    }
    let g = global_headers.len();

    // file column index → global column index.
    let global_idx: HashMap<String, usize> = global_headers
        .iter()
        .enumerate()
        .map(|(i, h)| (h.to_lowercase(), i))
        .collect();
    let col_map: Vec<usize> = ds
        .headers
        .iter()
        .map(|h| {
            if is_timestamp(h) {
                0
            } else {
                *global_idx.get(&h.to_lowercase()).unwrap_or(&0)
            }
        })
        .collect();

    // Aggregate parse-fail counts into the global (ts-first) layout.
    let mut global_fail_counts = vec![0usize; g];
    for (li, &gi) in col_map.iter().enumerate() {
        if li < parse_fail_counts.len() {
            global_fail_counts[gi] += parse_fail_counts[li];
        }
    }

    // Row selection & ordering, entirely on u32 indices (a 2 GB CSV tops out
    // far below u32::MAX rows). Rows without a timestamp are dropped (the
    // merge is keyed by timestamp), and the sort is skipped when the file is
    // already ordered.
    let mut order: Vec<u32> = (0..ds.n_rows() as u32)
        .filter(|&r| ds.timestamps[r as usize].is_some())
        .collect();
    let sorted_already = order
        .windows(2)
        .all(|w| ds.timestamps[w[0] as usize] <= ds.timestamps[w[1] as usize]);
    if !sorted_already {
        // Stable: keeps file order among equal timestamps so the duplicate
        // merge below overwrites in file order (later row wins).
        order.sort_by(|&a, &b| ds.timestamps[a as usize].cmp(&ds.timestamps[b as usize]));
    }
    let has_dups = order
        .windows(2)
        .any(|w| ds.timestamps[w[0] as usize] == ds.timestamps[w[1] as usize]);

    let identity_headers = ds.headers.len() == g
        && ds
            .headers
            .iter()
            .zip(global_headers.iter())
            .all(|(a, b)| a == b);

    // Fast path: ts-first headers, nothing dropped, already ordered, unique
    // timestamps — reuse the parsed columns without a single gather.
    if identity_headers && sorted_already && !has_dups && order.len() == ds.n_rows() {
        return MergeResult {
            data: ColumnarData::from_parts(global_headers, ds.timestamps, ds.columns),
            warnings: Vec::new(),
            parse_fail_counts: global_fail_counts,
        };
    }

    // Group runs of equal timestamps: each group becomes one output row.
    let mut groups: Vec<(u32, u32)> = Vec::new();
    let mut i = 0usize;
    while i < order.len() {
        let mut j = i + 1;
        while j < order.len()
            && ds.timestamps[order[j] as usize] == ds.timestamps[order[i] as usize]
        {
            j += 1;
        }
        groups.push((i as u32, j as u32));
        i = j;
    }

    // For each global column, the local columns feeding it, in file order.
    // Duplicate header names can map several locals to one slot; scanning
    // rows (outer, file order) then locals (inner, file order) and letting
    // the last non-NaN win reproduces the old per-row overwrite order.
    let mut sources: Vec<Vec<usize>> = vec![Vec::new(); g];
    for (li, &gi) in col_map.iter().enumerate() {
        // The local timestamp column maps to slot 0 but is all-NaN, so it
        // never writes a value (slot 0 stays the all-NaN placeholder).
        sources[gi].push(li);
    }

    let out_timestamps: Vec<Option<String>> = groups
        .iter()
        .map(|&(s, _)| ds.timestamps[order[s as usize] as usize].clone())
        .collect();

    let out_columns: Vec<Vec<f64>> = (0..g)
        .into_par_iter()
        .map(|gc| {
            let srcs = &sources[gc];
            groups
                .iter()
                .map(|&(s, e)| {
                    let mut v = f64::NAN;
                    for &oi in &order[s as usize..e as usize] {
                        for &li in srcs {
                            let x = ds.columns[li][oi as usize];
                            if !x.is_nan() {
                                v = x;
                            }
                        }
                    }
                    v
                })
                .collect()
        })
        .collect();

    MergeResult {
        data: ColumnarData::from_parts(global_headers, out_timestamps, out_columns),
        warnings: Vec::new(),
        parse_fail_counts: global_fail_counts,
    }
}

/// Build a CsvLoadReport from merge results and the final ColumnarData.
pub fn build_load_report(merge_result: &MergeResult) -> CsvLoadReport {
    let data = &merge_result.data;
    let total_rows = data.n_rows();

    let is_timestamp =
        |h: &str| h.eq_ignore_ascii_case("timestamp") || h.eq_ignore_ascii_case("time");

    // Per-column valid (non-NaN) counts — one contiguous scan per column,
    // columns in parallel. The timestamp column's validity comes from the
    // timestamps vec (its value column is the all-NaN placeholder).
    let ts_valid = data.timestamps.iter().filter(|t| t.is_some()).count();
    let valid_counts: Vec<usize> = data
        .columns
        .par_iter()
        .map(|col| col.iter().filter(|v| !v.is_nan()).count())
        .collect();

    let columns: Vec<ColumnInfo> = data
        .headers
        .iter()
        .enumerate()
        .map(|(col_idx, name)| {
            let (dtype, valid_count) = if is_timestamp(name) {
                ("datetime".to_string(), ts_valid)
            } else {
                (
                    "numeric".to_string(),
                    valid_counts.get(col_idx).copied().unwrap_or(0),
                )
            };

            ColumnInfo {
                name: name.clone(),
                dtype,
                null_count: total_rows - valid_count,
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
        let val = row
            .get(key_idx)
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a pre-merge ColumnarData from a row-major spec (readability):
    /// each row is (timestamp, per-column Option values). `ts_parsed` is
    /// left empty, exactly like `read_csv_with_stats` output.
    fn columnar(headers: Vec<&str>, rows: Vec<(Option<&str>, Vec<Option<f64>>)>) -> ColumnarData {
        let ncols = headers.len();
        let mut timestamps: Vec<Option<String>> = Vec::new();
        let mut columns: Vec<Vec<f64>> = vec![Vec::new(); ncols];
        for (ts, vals) in rows {
            timestamps.push(ts.map(String::from));
            for (c, col) in columns.iter_mut().enumerate() {
                col.push(vals.get(c).copied().flatten().unwrap_or(f64::NAN));
            }
        }
        ColumnarData {
            headers: headers.into_iter().map(String::from).collect(),
            timestamps,
            ts_parsed: Vec::new(),
            columns,
        }
    }

    fn single(
        headers: Vec<&str>,
        rows: Vec<(Option<&str>, Vec<Option<f64>>)>,
        fails: Vec<usize>,
    ) -> MergeResult {
        merge_single_file(ReadCsvResult {
            data: columnar(headers, rows),
            parse_fail_counts: fails,
        })
    }

    /// One row's values in the legacy Option shape, for readable assertions.
    fn row_vals(d: &ColumnarData, r: usize) -> Vec<Option<f64>> {
        (0..d.headers.len()).map(|c| d.value(c, r)).collect()
    }

    #[test]
    fn identity_clean_file_is_preserved() {
        let m = single(
            vec!["timestamp", "A", "B"],
            vec![
                (Some("2020-01-01T00:00"), vec![None, Some(1.0), Some(2.0)]),
                (Some("2020-01-01T00:01"), vec![None, Some(3.0), Some(4.0)]),
            ],
            vec![0, 0, 0],
        );
        assert_eq!(m.data.headers, vec!["timestamp", "A", "B"]);
        assert_eq!(m.data.n_rows(), 2);
        assert_eq!(row_vals(&m.data, 0), vec![None, Some(1.0), Some(2.0)]);
        assert_eq!(m.data.timestamps[1].as_deref(), Some("2020-01-01T00:01"));
        assert!(m.warnings.is_empty());
    }

    #[test]
    fn rows_without_timestamp_are_dropped() {
        let m = single(
            vec!["timestamp", "A"],
            vec![
                (Some("2020-01-01T00:00"), vec![None, Some(1.0)]),
                (None, vec![None, Some(9.0)]),
            ],
            vec![0, 0],
        );
        assert_eq!(m.data.n_rows(), 1);
        assert_eq!(row_vals(&m.data, 0), vec![None, Some(1.0)]);
    }

    #[test]
    fn unsorted_rows_are_sorted_by_timestamp() {
        let m = single(
            vec!["timestamp", "A"],
            vec![
                (Some("2020-01-01T00:02"), vec![None, Some(2.0)]),
                (Some("2020-01-01T00:00"), vec![None, Some(0.0)]),
                (Some("2020-01-01T00:01"), vec![None, Some(1.0)]),
            ],
            vec![0, 0],
        );
        let ts: Vec<_> = m.data.timestamps.iter().flatten().cloned().collect();
        assert_eq!(
            ts,
            vec!["2020-01-01T00:00", "2020-01-01T00:01", "2020-01-01T00:02"]
        );
        assert_eq!(row_vals(&m.data, 0), vec![None, Some(0.0)]);
    }

    #[test]
    fn duplicate_timestamps_merge_later_non_null_wins() {
        let m = single(
            vec!["timestamp", "A", "B"],
            vec![
                (Some("t"), vec![None, Some(1.0), None]), // A=1
                (Some("t"), vec![None, None, Some(2.0)]), // fills B, keeps A
                (Some("t"), vec![None, Some(5.0), None]), // overwrites A
            ],
            vec![0, 0, 0],
        );
        assert_eq!(m.data.n_rows(), 1);
        assert_eq!(row_vals(&m.data, 0), vec![None, Some(5.0), Some(2.0)]);
    }

    #[test]
    fn load_report_counts_valid_and_null_per_column() {
        let mr = MergeResult {
            data: ColumnarData::from_parts(
                vec!["timestamp".into(), "A".into(), "B".into()],
                vec![Some("t1".into()), Some("t2".into()), None],
                vec![
                    vec![f64::NAN, f64::NAN, f64::NAN],
                    vec![1.0, 2.0, f64::NAN],
                    vec![f64::NAN, 3.0, 4.0],
                ],
            ),
            warnings: vec![],
            parse_fail_counts: vec![0, 0, 0],
        };
        let rep = build_load_report(&mr);
        assert_eq!(rep.total_rows, 3);
        let col = |n: &str| rep.columns.iter().find(|c| c.name == n).unwrap();
        assert_eq!(col("timestamp").dtype, "datetime");
        assert_eq!(
            (col("timestamp").valid_count, col("timestamp").null_count),
            (2, 1)
        );
        assert_eq!(col("A").dtype, "numeric");
        assert_eq!((col("A").valid_count, col("A").null_count), (2, 1));
        assert_eq!((col("B").valid_count, col("B").null_count), (2, 1));
    }

    #[test]
    fn timestamp_is_canonicalized_to_the_front() {
        // ts NOT first → the gather branch reorders columns + values, and
        // realigns parse-fail counts to the ts-first layout.
        let m = single(
            vec!["A", "timestamp", "B"],
            vec![(Some("t1"), vec![Some(1.0), None, Some(2.0)])],
            vec![3, 0, 7],
        );
        assert_eq!(m.data.headers, vec!["timestamp", "A", "B"]);
        assert_eq!(row_vals(&m.data, 0), vec![None, Some(1.0), Some(2.0)]);
        // fail counts follow the columns: A's 3 → idx1, B's 7 → idx2.
        assert_eq!(m.parse_fail_counts, vec![0, 3, 7]);
    }

    #[test]
    fn ts_parsed_is_populated_after_merge() {
        let m = single(
            vec!["timestamp", "A"],
            vec![
                (Some("2020-01-01T00:00:00"), vec![None, Some(1.0)]),
                (Some("not a timestamp"), vec![None, Some(2.0)]),
            ],
            vec![0, 0],
        );
        assert_eq!(m.data.ts_parsed.len(), 2);
        // Sorted by STRING: "2020-..." < "not a timestamp".
        let expected = ts_to_micros(parse_timestamp("2020-01-01T00:00:00").unwrap());
        assert_eq!(m.data.ts_parsed[0], expected);
        assert_eq!(m.data.ts_parsed[1], TS_MISSING);
    }

    #[test]
    fn value_maps_nan_to_none_and_wire_record_projects() {
        let d = ColumnarData::from_parts(
            vec!["timestamp".into(), "A".into(), "B".into()],
            vec![Some("t1".into()), None],
            vec![
                vec![f64::NAN, f64::NAN],
                vec![1.5, f64::NAN],
                vec![f64::INFINITY, 4.0],
            ],
        );
        assert_eq!(d.value(1, 0), Some(1.5));
        assert_eq!(d.value(1, 1), None); // NaN → None
        assert_eq!(d.value(2, 0), Some(f64::INFINITY)); // inf preserved
        assert_eq!(d.value(99, 0), None); // out of range

        let rec = d.wire_record(0, &[2, 1]);
        assert_eq!(rec.timestamp.as_deref(), Some("t1"));
        assert_eq!(rec.values, vec![Some(f64::INFINITY), Some(1.5)]);
    }
}
