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
/// bounded (`get_scatter_sample`).
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
    /// Timestamp text per row, round-tripped to the frontend as-is — EXCEPT
    /// a detected Buddhist-Era year (see [`normalize_buddhist_era`]), which
    /// `from_parts` rewrites to Gregorian here too, not just in `ts_parsed`.
    /// Keeping this text and `ts_parsed` derived from the exact same
    /// (possibly-corrected) string is what keeps Raw-mode display (which
    /// reads this text directly) and Aggregated-mode display (built from
    /// `ts_parsed`) agreeing on the year for the same rows.
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
    /// Assemble a dataset from already-built parts, normalizing a detected
    /// Buddhist-Era year (see [`normalize_buddhist_era`]) in `timestamps`
    /// BEFORE computing `ts_parsed` (the one-time timestamp parse), both in
    /// parallel — so every downstream consumer of either field, in Rust or
    /// shipped to the frontend, sees only the corrected Gregorian year.
    pub fn from_parts(
        headers: Vec<String>,
        timestamps: Vec<Option<String>>,
        columns: Vec<Vec<f64>>,
    ) -> Self {
        use rayon::prelude::*;
        debug_assert!(columns.iter().all(|c| c.len() == timestamps.len()));
        let timestamps: Vec<Option<String>> = timestamps
            .into_par_iter()
            .map(|t| t.map(normalize_buddhist_era))
            .collect();
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

/// Detects a Buddhist-Era (BE = CE + 543) year in the leading `YYYY` of a
/// timestamp string and rewrites it to Gregorian in place — every format
/// [`parse_timestamp`] accepts starts with `%Y`, so the first 4 characters
/// are always the year regardless of which one matches.
///
/// Detection rule: `year >= 2400`. No genuine CE sensor timestamp is ever
/// that far out (2400 CE is over 370 years away), and no genuine BE year is
/// ever under 2400 either (BE 2400 = CE 1857, decades before any plausible
/// sensor log) — safe both directions for this app's domain, so this runs
/// unconditionally with no per-import opt-in.
///
/// Why this matters beyond cosmetics: a BE date's leap day, e.g.
/// `2567-02-29` (BE 2567 = CE 2024, a real leap year), fails to parse
/// entirely if read as literal CE — CE 2567 is not a leap year, so
/// `chrono` rejects the date outright and the whole row is dropped as
/// [`TS_MISSING`]. Correcting the year here, before any parse attempt, is
/// what makes that row valid again.
fn normalize_buddhist_era(mut s: String) -> String {
    if let Some(year) = s.get(0..4).and_then(|y| y.parse::<i32>().ok()) {
        if year >= 2400 {
            // `year` came from exactly 4 ASCII digits, so `year - 543` is
            // always in [1857, 9456] — always 4 digits, same byte width.
            s.replace_range(0..4, &format!("{:04}", year - 543));
        }
    }
    s
}

/// True if `s`'s leading `YYYY` reads as a Buddhist-Era year, per
/// [`normalize_buddhist_era`]'s detection rule — without rewriting it. Used
/// only to decide whether a load-report warning is worth surfacing.
fn is_buddhist_era_year(s: &str) -> bool {
    s.get(0..4)
        .and_then(|y| y.parse::<i32>().ok())
        .is_some_and(|y| y >= 2400)
}

/// Load-report warning for detected Buddhist-Era years, or `None` if none
/// were found — `from_parts` corrects them silently, so this is the only
/// place the user finds out it happened. Scan BEFORE normalization (pass
/// the still-original timestamp text): after `from_parts` runs, every year
/// has already been rewritten and there's nothing left to detect.
fn buddhist_era_warning<'a>(timestamps: impl IntoIterator<Item = &'a str>) -> Option<String> {
    let count = timestamps
        .into_iter()
        .filter(|s| is_buddhist_era_year(s))
        .count();
    if count == 0 {
        return None;
    }
    Some(format!(
        "{} timestamp(s) used a Buddhist-Era year (พ.ศ.) — converted to Gregorian (ค.ศ.) for display and calculations",
        count
    ))
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

/// Per-file facts shown on the Prepare-dataset step (one entry per file given
/// to `load_csv`, in the order given). Every time is read with the SAME
/// parser as `ts_parsed` and AFTER Buddhist-Era -> CE normalisation; a value
/// that cannot be computed (no parseable timestamp in the file) is `None`,
/// never a placeholder.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct CsvFileInfo {
    /// File name only (no directory).
    pub name: String,
    pub size_bytes: u64,
    /// Data rows read from THIS file (before the cross-file merge drops
    /// rows without a timestamp / folds duplicate timestamps).
    pub rows: usize,
    /// Earliest / latest timestamp in this file, `"YYYY-MM-DD HH:MM:SS"`.
    #[serde(default)]
    pub start: Option<String>,
    #[serde(default)]
    pub end: Option<String>,
    /// The same instants as epoch-microseconds (for drawing a coverage bar).
    #[serde(default)]
    pub start_micros: Option<i64>,
    #[serde(default)]
    pub end_micros: Option<i64>,
}

/// Stage of a `csv-load-progress` event.
#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CsvLoadStage {
    Reading,
    Merging,
    Done,
}

/// Payload of the `csv-load-progress` event `load_csv` emits.
///
/// `reading` is sent twice per file: when it starts (`files_done == file_index`)
/// and when it has finished (`files_done == file_index + 1`). `merging` and
/// `done` carry `file_index == file_count`, `files_done == file_count`.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct CsvLoadProgress {
    /// 0-based index of the file this event is about (`file_count` for
    /// `merging` / `done`).
    pub file_index: usize,
    pub file_count: usize,
    /// File name only (empty for `merging` / `done`).
    pub file_name: String,
    pub stage: CsvLoadStage,
    /// How many files have been completely read when this event was sent.
    pub files_done: usize,
}

impl CsvLoadProgress {
    fn reading(file_index: usize, file_count: usize, file_name: &str, finished: bool) -> Self {
        CsvLoadProgress {
            file_index,
            file_count,
            file_name: file_name.to_string(),
            stage: CsvLoadStage::Reading,
            files_done: if finished { file_index + 1 } else { file_index },
        }
    }

    /// The `merging` event (`done == false`) or the final `done` event.
    pub fn after_reading(file_count: usize, done: bool) -> Self {
        CsvLoadProgress {
            file_index: file_count,
            file_count,
            file_name: String::new(),
            stage: if done { CsvLoadStage::Done } else { CsvLoadStage::Merging },
            files_done: file_count,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct CsvLoadReport {
    pub headers: Vec<String>,
    pub total_rows: usize,
    pub columns: Vec<ColumnInfo>,
    pub warnings: Vec<String>,
    /// Per-file info, in the order the files were given (JSON `files`).
    #[serde(default)]
    pub files: Vec<CsvFileInfo>,
    /// Earliest / latest valid timestamp of the MERGED dataset
    /// (`"YYYY-MM-DD HH:MM:SS"`, plus the same instants as epoch-microseconds).
    /// `None` when no row has a parseable timestamp.
    #[serde(default)]
    pub period_start: Option<String>,
    #[serde(default)]
    pub period_end: Option<String>,
    #[serde(default)]
    pub period_start_micros: Option<i64>,
    #[serde(default)]
    pub period_end_micros: Option<i64>,
    /// Typical sampling interval in seconds: the median of the positive
    /// consecutive differences of the merged, sorted timestamps (deterministic
    /// stride sample when there are millions of rows). `None` with < 2 valid
    /// timestamps or no positive difference.
    #[serde(default)]
    pub interval_seconds: Option<f64>,
    /// Empty (NaN) cells / (rows x sensor columns, timestamp column excluded)
    /// x 100, in 0..=100. `None` when there are no rows or no sensor column.
    #[serde(default)]
    pub missing_percent: Option<f64>,
    /// Session generation created by the `load_csv` call that returned this
    /// report (JSON field `generation`). `build_load_report` leaves it 0;
    /// `load_csv` stamps the real value once the dataset is installed. A caller
    /// bound to this dataset passes it back as `expectedGeneration` on the
    /// special-sensor commands so a stale window can't mutate a newer dataset.
    #[serde(default)]
    pub generation: u64,
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
    /// File size in bytes, as checked against [`MAX_CSV_BYTES`].
    pub size_bytes: u64,
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
        size_bytes: size,
    })
}

/// Extended merge result including warnings and per-column parse failure info.
pub struct MergeResult {
    pub data: ColumnarData,
    pub warnings: Vec<String>,
    /// Per-column (in merged header order) count of non-empty fields that failed f64 parse.
    pub parse_fail_counts: Vec<usize>,
    /// Per-file info in the order the files were given. Filled by
    /// [`read_merge_csvs_with_progress`]; empty for a hand-built result.
    pub files: Vec<CsvFileInfo>,
}

/// Parse one raw timestamp exactly as `ColumnarData::from_parts` does
/// (Buddhist-Era year corrected first), without allocating in the common
/// non-BE case.
fn parse_micros_normalized(s: &str) -> Option<i64> {
    if is_buddhist_era_year(s) {
        parse_timestamp(&normalize_buddhist_era(s.to_string())).map(ts_to_micros)
    } else {
        parse_timestamp(s).map(ts_to_micros)
    }
}

/// Min / max parsed instant (epoch micros) of a file's raw timestamps,
/// ignoring missing / unparseable ones. Parallel; used only for multi-file
/// loads (a single file's range is read off the merged `ts_parsed` instead).
fn raw_timestamp_range(timestamps: &[Option<String>]) -> Option<(i64, i64)> {
    timestamps
        .par_iter()
        .filter_map(|t| t.as_deref().and_then(parse_micros_normalized))
        .fold(
            || None::<(i64, i64)>,
            |acc, us| match acc {
                None => Some((us, us)),
                Some((lo, hi)) => Some((lo.min(us), hi.max(us))),
            },
        )
        .reduce(
            || None,
            |a, b| match (a, b) {
                (None, x) | (x, None) => x,
                (Some((l1, h1)), Some((l2, h2))) => Some((l1.min(l2), h1.max(h2))),
            },
        )
}

/// `"YYYY-MM-DD HH:MM:SS"` for an epoch-microsecond instant.
fn format_micros(us: i64) -> Option<String> {
    micros_to_naive(us).map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
}

fn file_info(name: String, size_bytes: u64, rows: usize, range: Option<(i64, i64)>) -> CsvFileInfo {
    CsvFileInfo {
        name,
        size_bytes,
        rows,
        start: range.and_then(|(lo, _)| format_micros(lo)),
        end: range.and_then(|(_, hi)| format_micros(hi)),
        start_micros: range.map(|(lo, _)| lo),
        end_micros: range.map(|(_, hi)| hi),
    }
}

fn file_name_only(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

pub fn read_merge_csvs_with_report(paths: Vec<String>) -> Result<MergeResult, String> {
    read_merge_csvs_with_progress(paths, &|_| {})
}

/// [`read_merge_csvs_with_report`] that also reports progress through
/// `on_progress` (`reading` start/finish per file, then `merging`; the final
/// `done` is sent by the caller once the dataset is installed). The callback
/// must never be able to fail the load, so it returns nothing.
pub fn read_merge_csvs_with_progress(
    paths: Vec<String>,
    on_progress: &dyn Fn(CsvLoadProgress),
) -> Result<MergeResult, String> {
    if paths.is_empty() {
        return Err("No file paths provided".to_string());
    }

    let mut warnings: Vec<String> = Vec::new();
    let file_count = paths.len();

    // 1. Read all files individually (with stats)
    let mut results = Vec::new();
    let mut files: Vec<CsvFileInfo> = Vec::with_capacity(file_count);
    for (i, path) in paths.iter().enumerate() {
        let name = file_name_only(path);
        on_progress(CsvLoadProgress::reading(i, file_count, &name, false));
        let r = read_csv_with_stats(path)?;
        // Several files: each file's own range needs its own parse (the
        // merged `ts_parsed` no longer knows which file a row came from).
        // One file: filled from the merged `ts_parsed` below, no extra pass.
        let range = if file_count > 1 {
            raw_timestamp_range(&r.data.timestamps)
        } else {
            None
        };
        files.push(file_info(name.clone(), r.size_bytes, r.data.n_rows(), range));
        results.push(r);
        on_progress(CsvLoadProgress::reading(i, file_count, &name, true));
    }

    if results.is_empty() {
        return Err("No data loaded".to_string());
    }
    on_progress(CsvLoadProgress::after_reading(file_count, false));

    // Single file → skip the cross-file timestamp merge entirely. That merge
    // rebuilds every row through a single-threaded BTreeMap (cloning the
    // timestamp key per row) — pure overhead when there's nothing to merge.
    // `merge_single_file` produces the SAME result (timestamp column first,
    // null-timestamp rows dropped, ordered by timestamp, duplicate timestamps
    // merged) but works on indices + per-column gathers — and does its own
    // Buddhist-Era detection, so skip the one below entirely on this path.
    if results.len() == 1 {
        let mut merged = merge_single_file(results.pop().unwrap());
        // The merged dataset IS this one file (rows without a timestamp are
        // not parseable anyway), so its range is the dataset's range.
        let (lo, hi) = ts_min_max(&merged.data.ts_parsed).unzip();
        if let Some(f) = files.first_mut() {
            *f = file_info(
                std::mem::take(&mut f.name),
                f.size_bytes,
                f.rows,
                lo.zip(hi),
            );
        }
        merged.files = files;
        return Ok(merged);
    }

    // Buddhist-Era detection across every file's raw timestamps, before any
    // merge/parse step touches them — see `buddhist_era_warning`'s docstring.
    if let Some(w) = buddhist_era_warning(
        results
            .iter()
            .flat_map(|r| r.data.timestamps.iter().flatten().map(String::as_str)),
    ) {
        warnings.push(w);
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
        files,
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
        ..
    } = result;

    // Computed before anything below partially moves `ds` — see
    // `buddhist_era_warning`'s docstring for why this has to run on the
    // still-original text.
    let be_warning = buddhist_era_warning(ds.timestamps.iter().flatten().map(String::as_str));

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
            warnings: be_warning.clone().into_iter().collect(),
            parse_fail_counts: global_fail_counts,
            files: Vec::new(),
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
        warnings: be_warning.into_iter().collect(),
        parse_fail_counts: global_fail_counts,
        files: Vec::new(),
    }
}

/// Min / max of the valid (non-[`TS_MISSING`]) values; `None` if none.
fn ts_min_max(ts: &[i64]) -> Option<(i64, i64)> {
    let mut it = ts.iter().copied().filter(|&t| t != TS_MISSING);
    let first = it.next()?;
    Some(it.fold((first, first), |(lo, hi), t| (lo.min(t), hi.max(t))))
}

/// Cap on how many consecutive-difference samples feed the median interval.
const MAX_INTERVAL_SAMPLES: usize = 2_000_000;

/// Median positive gap, in seconds, between consecutive valid timestamps of
/// the merged dataset. The merge orders rows by timestamp TEXT, which equals
/// chronological order for a uniform format — but mixed formats could differ,
/// so an out-of-order `ts` is sorted first (a copy; the common case is already
/// sorted and costs no allocation beyond the difference samples). With more
/// than [`MAX_INTERVAL_SAMPLES`] gaps a deterministic stride sample is used.
/// Equal neighbours (gap 0) are ignored. Even sample count: mean of the two
/// middle gaps. `None` if fewer than 2 valid timestamps / no positive gap.
fn median_interval_seconds(ts: &[i64]) -> Option<f64> {
    let mut valid = 0usize;
    let mut sorted = true;
    let mut prev: Option<i64> = None;
    for &t in ts {
        if t == TS_MISSING {
            continue;
        }
        valid += 1;
        if prev.is_some_and(|p| t < p) {
            sorted = false;
        }
        prev = Some(t);
    }
    if valid < 2 {
        return None;
    }

    fn sampled_gaps(it: impl Iterator<Item = i64>, n_gaps: usize) -> Vec<i64> {
        let stride = n_gaps.div_ceil(MAX_INTERVAL_SAMPLES).max(1);
        let mut out = Vec::with_capacity(n_gaps.min(MAX_INTERVAL_SAMPLES));
        let mut prev: Option<i64> = None;
        let mut k = 0usize;
        for t in it {
            if let Some(p) = prev {
                if k % stride == 0 && t > p {
                    out.push(t - p);
                }
                k += 1;
            }
            prev = Some(t);
        }
        out
    }

    let mut gaps = if sorted {
        sampled_gaps(ts.iter().copied().filter(|&t| t != TS_MISSING), valid - 1)
    } else {
        let mut v: Vec<i64> = ts.iter().copied().filter(|&t| t != TS_MISSING).collect();
        v.par_sort_unstable();
        sampled_gaps(v.into_iter(), valid - 1)
    };
    if gaps.is_empty() {
        return None;
    }
    gaps.sort_unstable();
    let n = gaps.len();
    let micros = if n % 2 == 1 {
        gaps[n / 2] as f64
    } else {
        (gaps[n / 2 - 1] as f64 + gaps[n / 2] as f64) / 2.0
    };
    Some(micros / 1_000_000.0)
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

    // Period / interval come off the already-parsed `ts_parsed`; the empty-cell
    // share reuses the per-column valid counts computed above — no new pass
    // over the sensor columns.
    let range = ts_min_max(&data.ts_parsed);
    let mut sensor_cols = 0usize;
    let mut missing_cells = 0usize;
    for (col_idx, name) in data.headers.iter().enumerate() {
        if is_timestamp(name) {
            continue;
        }
        sensor_cols += 1;
        missing_cells += total_rows - valid_counts.get(col_idx).copied().unwrap_or(0);
    }
    let missing_percent = if total_rows > 0 && sensor_cols > 0 {
        Some((missing_cells as f64 / (total_rows as f64 * sensor_cols as f64) * 100.0).clamp(0.0, 100.0))
    } else {
        None
    };

    CsvLoadReport {
        headers: data.headers.clone(),
        total_rows,
        columns,
        warnings,
        generation: 0,
        files: merge_result.files.clone(),
        period_start: range.and_then(|(lo, _)| format_micros(lo)),
        period_end: range.and_then(|(_, hi)| format_micros(hi)),
        period_start_micros: range.map(|(lo, _)| lo),
        period_end_micros: range.map(|(_, hi)| hi),
        interval_seconds: median_interval_seconds(&data.ts_parsed),
        missing_percent,
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
            size_bytes: 0,
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
            files: vec![],
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

    // ── Buddhist-Era (พ.ศ.) year detection/normalization ───────────────────

    #[test]
    fn normalize_buddhist_era_rewrites_a_be_year_leaving_the_rest_untouched() {
        assert_eq!(
            normalize_buddhist_era("2566-05-13T01:00:00+07:00".to_string()),
            "2023-05-13T01:00:00+07:00"
        );
    }

    #[test]
    fn normalize_buddhist_era_leaves_an_ordinary_ce_year_alone() {
        assert_eq!(
            normalize_buddhist_era("2024-02-29T00:00:00".to_string()),
            "2024-02-29T00:00:00"
        );
    }

    #[test]
    fn normalize_buddhist_era_leaves_garbage_alone() {
        assert_eq!(normalize_buddhist_era("t1".to_string()), "t1");
        assert_eq!(
            normalize_buddhist_era("not-a-date-string".to_string()),
            "not-a-date-string"
        );
    }

    #[test]
    fn is_buddhist_era_year_matches_the_2400_threshold() {
        assert!(!is_buddhist_era_year("2399-01-01"));
        assert!(is_buddhist_era_year("2400-01-01"));
        assert!(is_buddhist_era_year("2566-05-13T01:00:00"));
        assert!(!is_buddhist_era_year("garbage"));
    }

    #[test]
    fn buddhist_era_warning_counts_matches_and_is_none_when_absent() {
        assert_eq!(buddhist_era_warning(["2020-01-01", "2020-01-02"]), None);
        let w = buddhist_era_warning(["2566-01-01", "2020-01-01", "2567-01-02"]).unwrap();
        assert!(w.starts_with("2 "), "got: {w}");
    }

    /// The real-world case that motivated this: a Buddhist-Era leap day
    /// (BE 2567 = CE 2024, a genuine Gregorian leap year) fails to parse
    /// entirely if the year is read literally as CE 2567 — chrono rejects
    /// Feb 29 outright since CE 2567 is not a leap year. Normalizing the
    /// year to Gregorian BEFORE the parse attempt is what recovers it.
    #[test]
    fn single_file_merge_recovers_a_buddhist_era_leap_day_and_agrees_on_the_year() {
        let m = single(
            vec!["timestamp", "A"],
            vec![
                (Some("2567-02-28 00:00:00+07:00"), vec![None, Some(1.0)]),
                (Some("2567-02-29 00:00:00+07:00"), vec![None, Some(2.0)]),
            ],
            vec![0, 0],
        );
        // Both rows parse now (neither is TS_MISSING) — the leap day survives.
        assert_eq!(m.data.ts_parsed.iter().filter(|&&t| t == TS_MISSING).count(), 0);
        // The STORED text is corrected too, not just ts_parsed — Raw-mode
        // display and Aggregated-mode display must agree on the year.
        assert_eq!(
            m.data.timestamps[0].as_deref(),
            Some("2024-02-28 00:00:00+07:00")
        );
        assert_eq!(
            m.data.timestamps[1].as_deref(),
            Some("2024-02-29 00:00:00+07:00")
        );
        assert_eq!(m.warnings.len(), 1);
        assert!(m.warnings[0].starts_with("2 "), "got: {:?}", m.warnings[0]);
    }

    #[test]
    fn single_file_merge_has_no_be_warning_for_ordinary_ce_data() {
        let m = single(
            vec!["timestamp", "A"],
            vec![(Some("2024-01-01T00:00:00"), vec![None, Some(1.0)])],
            vec![0, 0],
        );
        assert!(m.warnings.is_empty());
    }

    // ── Prepare-dataset report data (files / period / interval / missing) ───

    use std::io::Write as _;
    use std::sync::Mutex;

    fn write_csv(dir: &tempfile::TempDir, name: &str, body: &str) -> String {
        let p = dir.path().join(name);
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(body.as_bytes()).unwrap();
        p.to_string_lossy().into_owned()
    }

    fn load(paths: Vec<String>) -> (MergeResult, CsvLoadReport) {
        let m = read_merge_csvs_with_report(paths).unwrap();
        let r = build_load_report(&m);
        (m, r)
    }

    fn micros(s: &str) -> i64 {
        ts_to_micros(parse_timestamp(s).unwrap())
    }

    #[test]
    fn two_overlapping_files_report_their_own_ranges_and_the_merged_period() {
        let dir = tempfile::tempdir().unwrap();
        let a = write_csv(
            &dir,
            "a.csv",
            "timestamp,S1\n2024-01-01 00:00:00,1\n2024-01-01 00:05:00,2\n2024-01-01 00:10:00,3\n",
        );
        // Starts inside a's range, ends later; deliberately listed out of order.
        let b = write_csv(
            &dir,
            "b.csv",
            "timestamp,S2\n2024-01-01 00:15:00,9\n2024-01-01 00:05:00,7\n",
        );
        let (_, rep) = load(vec![a, b]);
        assert_eq!(rep.files.len(), 2);
        assert_eq!(rep.files[0].name, "a.csv");
        assert_eq!(rep.files[0].rows, 3);
        assert_eq!(rep.files[0].start.as_deref(), Some("2024-01-01 00:00:00"));
        assert_eq!(rep.files[0].end.as_deref(), Some("2024-01-01 00:10:00"));
        assert_eq!(rep.files[0].start_micros, Some(micros("2024-01-01 00:00:00")));
        assert_eq!(rep.files[0].end_micros, Some(micros("2024-01-01 00:10:00")));
        assert_eq!(rep.files[1].name, "b.csv");
        assert_eq!(rep.files[1].rows, 2);
        assert_eq!(rep.files[1].start.as_deref(), Some("2024-01-01 00:05:00"));
        assert_eq!(rep.files[1].end.as_deref(), Some("2024-01-01 00:15:00"));
        assert!(rep.files[0].size_bytes > 0 && rep.files[1].size_bytes > 0);
        assert_eq!(rep.period_start.as_deref(), Some("2024-01-01 00:00:00"));
        assert_eq!(rep.period_end.as_deref(), Some("2024-01-01 00:15:00"));
        assert_eq!(rep.period_start_micros, Some(micros("2024-01-01 00:00:00")));
        assert_eq!(rep.period_end_micros, Some(micros("2024-01-01 00:15:00")));
        // Merged rows: 00:00, 00:05, 00:10, 00:15 -> 4 (00:05 shared).
        assert_eq!(rep.total_rows, 4);
    }

    #[test]
    fn single_file_reports_one_entry_whose_range_equals_the_period() {
        let dir = tempfile::tempdir().unwrap();
        // Unsorted on purpose: the range must be min/max, not first/last.
        let a = write_csv(
            &dir,
            "only.csv",
            "time,S1\n2024-03-01 12:00:00,1\n2024-03-01 10:00:00,2\n2024-03-01 11:00:00,3\n",
        );
        let (_, rep) = load(vec![a]);
        assert_eq!(rep.files.len(), 1);
        let f = &rep.files[0];
        assert_eq!(f.name, "only.csv");
        assert_eq!(f.rows, 3);
        assert_eq!(f.start.as_deref(), Some("2024-03-01 10:00:00"));
        assert_eq!(f.end.as_deref(), Some("2024-03-01 12:00:00"));
        assert_eq!(f.start, rep.period_start);
        assert_eq!(f.end, rep.period_end);
        assert_eq!(f.start_micros, rep.period_start_micros);
        assert_eq!(f.end_micros, rep.period_end_micros);
    }

    #[test]
    fn file_name_is_reported_without_its_directory() {
        assert_eq!(file_name_only("/tmp/x/b.csv"), "b.csv");
        let dir = tempfile::tempdir().unwrap();
        let p = write_csv(&dir, "named.csv", "timestamp,A\n2024-01-01 00:00:00,1\n");
        let (_, rep) = load(vec![p]);
        assert_eq!(rep.files[0].name, "named.csv");
    }

    #[test]
    fn buddhist_era_files_report_gregorian_years_per_file_and_overall() {
        let dir = tempfile::tempdir().unwrap();
        let a = write_csv(
            &dir,
            "be1.csv",
            "timestamp,S1\n2567-02-28 00:00:00,1\n2567-02-29 00:00:00,2\n",
        );
        let b = write_csv(&dir, "be2.csv", "timestamp,S2\n2567-03-01 06:30:00,5\n");
        let (_, rep) = load(vec![a, b]);
        assert_eq!(rep.files[0].start.as_deref(), Some("2024-02-28 00:00:00"));
        assert_eq!(rep.files[0].end.as_deref(), Some("2024-02-29 00:00:00"));
        assert_eq!(rep.files[1].start.as_deref(), Some("2024-03-01 06:30:00"));
        assert_eq!(rep.period_start.as_deref(), Some("2024-02-28 00:00:00"));
        assert_eq!(rep.period_end.as_deref(), Some("2024-03-01 06:30:00"));

        // Single-file BE path as well.
        let c = write_csv(&dir, "be3.csv", "timestamp,S1\n2567-02-29 00:00:00,1\n");
        let (_, rep1) = load(vec![c]);
        assert_eq!(rep1.files[0].start.as_deref(), Some("2024-02-29 00:00:00"));
    }

    #[test]
    fn missing_and_unparseable_timestamps_are_ignored_in_ranges() {
        let dir = tempfile::tempdir().unwrap();
        let a = write_csv(
            &dir,
            "a.csv",
            "timestamp,S1\n,1\nnot a date,2\n2024-01-01 00:00:00,3\n2024-01-01 00:01:00,4\n",
        );
        let b = write_csv(&dir, "b.csv", "timestamp,S2\n,1\ngarbage,2\n");
        let (_, rep) = load(vec![a, b]);
        assert_eq!(rep.files[0].rows, 4, "rows READ, including undated ones");
        assert_eq!(rep.files[0].start.as_deref(), Some("2024-01-01 00:00:00"));
        assert_eq!(rep.files[0].end.as_deref(), Some("2024-01-01 00:01:00"));
        // A file with no parseable timestamp has no range - None, not a fake.
        assert_eq!(rep.files[1].rows, 2);
        assert_eq!(rep.files[1].start, None);
        assert_eq!(rep.files[1].end, None);
        assert_eq!(rep.files[1].start_micros, None);
        assert_eq!(rep.files[1].end_micros, None);

        let only_bad = write_csv(&dir, "bad.csv", "timestamp,S1\n,1\nzzz,2\n");
        let (_, rep_bad) = load(vec![only_bad]);
        assert_eq!(rep_bad.period_start, None);
        assert_eq!(rep_bad.period_end_micros, None);
        assert_eq!(rep_bad.interval_seconds, None);
        assert_eq!(rep_bad.files[0].start, None);
    }

    #[test]
    fn interval_of_a_regular_five_minute_series_is_300() {
        let dir = tempfile::tempdir().unwrap();
        let mut body = String::from("timestamp,S1\n");
        for i in 0..20 {
            body.push_str(&format!(
                "2024-01-01 {:02}:{:02}:00,{}\n",
                (i * 5) / 60,
                (i * 5) % 60,
                i
            ));
        }
        let (_, rep) = load(vec![write_csv(&dir, "reg.csv", &body)]);
        assert_eq!(rep.interval_seconds, Some(300.0));
    }

    #[test]
    fn interval_of_an_irregular_series_is_the_median_gap() {
        // gaps (s): 60, 60, 60, 600, 3600 -> median 60 (odd count).
        let ts = [0i64, 60, 120, 180, 780, 4380].map(|s| s * 1_000_000);
        assert_eq!(median_interval_seconds(&ts), Some(60.0));
        // Even count of gaps: 10, 20, 30, 100 -> mean(20, 30) = 25.
        let ts = [0i64, 10, 30, 60, 160].map(|s| s * 1_000_000);
        assert_eq!(median_interval_seconds(&ts), Some(25.0));
    }

    #[test]
    fn interval_ignores_missing_duplicates_and_unsorted_input() {
        let s = 1_000_000i64;
        // Unsorted + duplicate (gap 0) + TS_MISSING: sorted valid = 0,60,60,120
        // -> positive gaps 60, 60 -> 60.
        let ts = [120 * s, TS_MISSING, 0, 60 * s, 60 * s];
        assert_eq!(median_interval_seconds(&ts), Some(60.0));
        assert_eq!(median_interval_seconds(&[]), None);
        assert_eq!(median_interval_seconds(&[5 * s]), None);
        assert_eq!(median_interval_seconds(&[TS_MISSING, 5 * s, TS_MISSING]), None);
        // All identical: no positive gap.
        assert_eq!(median_interval_seconds(&[7 * s, 7 * s, 7 * s]), None);
    }

    #[test]
    fn interval_stride_sampling_is_deterministic_and_keeps_the_median() {
        // 4.5M valid timestamps -> 4.5M gaps > MAX_INTERVAL_SAMPLES, so the
        // stride sampler (stride 3) is exercised. Gaps alternate 1 s / 1 s /
        // 10 s, so the median stays 1 s whichever third is sampled.
        let mut ts: Vec<i64> = Vec::with_capacity(4_500_000);
        let mut t = 0i64;
        for i in 0..4_500_000usize {
            ts.push(t);
            t += if i % 3 == 2 { 10_000_000 } else { 1_000_000 };
        }
        let a = median_interval_seconds(&ts);
        assert_eq!(a, median_interval_seconds(&ts));
        assert_eq!(a, Some(1.0));
    }

    #[test]
    fn missing_percent_is_exact_on_a_small_fixture() {
        let dir = tempfile::tempdir().unwrap();
        // 4 rows x 3 sensors = 12 cells. Empty: S1 row 3, S2 rows 1 and 4;
        // plus a non-numeric cell (-> NaN) in S3 row 2 => 4 empty of 12.
        let body = "timestamp,S1,S2,S3\n\
            2024-01-01 00:00:00,1,,1\n\
            2024-01-01 00:01:00,2,2,abc\n\
            2024-01-01 00:02:00,,3,3\n\
            2024-01-01 00:03:00,4,,4\n";
        let (_, rep) = load(vec![write_csv(&dir, "m.csv", body)]);
        assert_eq!(rep.total_rows, 4);
        let pct = rep.missing_percent.unwrap();
        assert!((pct - 100.0 * 4.0 / 12.0).abs() < 1e-9, "got {pct}");
    }

    #[test]
    fn missing_percent_bounds_and_none_cases() {
        let dir = tempfile::tempdir().unwrap();
        let full = write_csv(
            &dir,
            "full.csv",
            "timestamp,A\n2024-01-01 00:00:00,1\n2024-01-01 00:01:00,2\n",
        );
        assert_eq!(load(vec![full]).1.missing_percent, Some(0.0));
        let empty = write_csv(
            &dir,
            "empty.csv",
            "timestamp,A\n2024-01-01 00:00:00,\n2024-01-01 00:01:00,\n",
        );
        assert_eq!(load(vec![empty]).1.missing_percent, Some(100.0));
        // Timestamp-only file: no sensor column -> None, not 0 or NaN.
        let ts_only = write_csv(&dir, "tsonly.csv", "timestamp\n2024-01-01 00:00:00\n");
        assert_eq!(load(vec![ts_only]).1.missing_percent, None);
        // Header only: no rows -> None.
        let none = write_csv(&dir, "hdr.csv", "timestamp,A\n");
        assert_eq!(load(vec![none]).1.missing_percent, None);
    }

    #[test]
    fn multi_file_missing_percent_counts_merged_empty_cells() {
        let dir = tempfile::tempdir().unwrap();
        let a = write_csv(
            &dir,
            "a.csv",
            "timestamp,S1\n2024-01-01 00:00:00,1\n2024-01-01 00:01:00,2\n",
        );
        let b = write_csv(&dir, "b.csv", "timestamp,S2\n2024-01-01 00:00:00,5\n");
        // Merged: 2 rows x 2 sensors = 4 cells, S2 empty at 00:01 -> 25%.
        let (_, rep) = load(vec![a, b]);
        assert_eq!(rep.missing_percent, Some(25.0));
    }

    #[test]
    fn load_behaviour_is_unchanged_by_the_report_additions() {
        // Duplicate timestamp: later non-null wins, undated row dropped.
        let dir = tempfile::tempdir().unwrap();
        let a = write_csv(
            &dir,
            "a.csv",
            "timestamp,S1\n2024-01-01 00:00:00,1\n2024-01-01 00:00:00,\n,9\n2024-01-01 00:01:00,3\n",
        );
        let (m, rep) = load(vec![a]);
        assert_eq!(m.data.n_rows(), 2);
        assert_eq!(rep.total_rows, 2);
        assert_eq!(m.data.value(1, 0), Some(1.0));
        assert_eq!(rep.files[0].rows, 4);
    }

    #[test]
    fn old_report_json_without_the_new_fields_still_deserialises() {
        let rep: CsvLoadReport = serde_json::from_str(
            r#"{"headers":["timestamp"],"total_rows":0,"columns":[],"warnings":[],"generation":3}"#,
        )
        .unwrap();
        assert!(rep.files.is_empty());
        assert_eq!(rep.period_start, None);
        assert_eq!(rep.period_end_micros, None);
        assert_eq!(rep.interval_seconds, None);
        assert_eq!(rep.missing_percent, None);
        assert_eq!(rep.generation, 3);
        // A file entry saved before start/end existed also loads.
        let f: CsvFileInfo =
            serde_json::from_str(r#"{"name":"a.csv","size_bytes":10,"rows":2}"#).unwrap();
        assert_eq!(f.start, None);
        assert_eq!(f.end_micros, None);
    }

    #[test]
    fn new_report_fields_serialise_with_snake_case_keys() {
        let dir = tempfile::tempdir().unwrap();
        let p = write_csv(
            &dir,
            "j.csv",
            "timestamp,S1\n2024-01-01 00:00:00,1\n2024-01-01 00:05:00,2\n",
        );
        let (_, rep) = load(vec![p]);
        let v = serde_json::to_value(&rep).unwrap();
        assert_eq!(v["files"][0]["name"], "j.csv");
        assert!(v["files"][0]["size_bytes"].as_u64().unwrap() > 0);
        assert_eq!(v["files"][0]["rows"], 2);
        assert_eq!(v["files"][0]["start"], "2024-01-01 00:00:00");
        assert_eq!(v["files"][0]["end"], "2024-01-01 00:05:00");
        assert_eq!(v["files"][0]["start_micros"], micros("2024-01-01 00:00:00"));
        assert_eq!(v["files"][0]["end_micros"], micros("2024-01-01 00:05:00"));
        assert_eq!(v["period_start"], "2024-01-01 00:00:00");
        assert_eq!(v["period_end"], "2024-01-01 00:05:00");
        assert_eq!(v["period_start_micros"], micros("2024-01-01 00:00:00"));
        assert_eq!(v["period_end_micros"], micros("2024-01-01 00:05:00"));
        assert_eq!(v["interval_seconds"], 300.0);
        assert_eq!(v["missing_percent"], 0.0);
    }

    // ── csv-load-progress payload / sequence ────────────────────────────────

    #[test]
    fn progress_payload_json_shape() {
        let p = CsvLoadProgress::reading(1, 3, "b.csv", false);
        assert_eq!(
            serde_json::to_value(&p).unwrap(),
            serde_json::json!({
                "file_index": 1, "file_count": 3, "file_name": "b.csv",
                "stage": "reading", "files_done": 1
            })
        );
        let fin = CsvLoadProgress::reading(1, 3, "b.csv", true);
        assert_eq!(fin.files_done, 2);
        assert_eq!(
            serde_json::to_value(CsvLoadProgress::after_reading(3, false)).unwrap(),
            serde_json::json!({
                "file_index": 3, "file_count": 3, "file_name": "",
                "stage": "merging", "files_done": 3
            })
        );
        assert_eq!(
            serde_json::to_value(CsvLoadProgress::after_reading(3, true)).unwrap()["stage"],
            "done"
        );
    }

    #[test]
    fn load_emits_reading_per_file_then_merging() {
        let dir = tempfile::tempdir().unwrap();
        let a = write_csv(&dir, "a.csv", "timestamp,S1\n2024-01-01 00:00:00,1\n");
        let b = write_csv(&dir, "b.csv", "timestamp,S2\n2024-01-01 00:01:00,2\n");
        let events: Mutex<Vec<CsvLoadProgress>> = Mutex::new(Vec::new());
        read_merge_csvs_with_progress(vec![a, b], &|p| events.lock().unwrap().push(p)).unwrap();
        let ev = events.into_inner().unwrap();
        let seq: Vec<(CsvLoadStage, usize, usize, &str)> = ev
            .iter()
            .map(|e| (e.stage, e.file_index, e.files_done, e.file_name.as_str()))
            .collect();
        assert_eq!(
            seq,
            vec![
                (CsvLoadStage::Reading, 0, 0, "a.csv"),
                (CsvLoadStage::Reading, 0, 1, "a.csv"),
                (CsvLoadStage::Reading, 1, 1, "b.csv"),
                (CsvLoadStage::Reading, 1, 2, "b.csv"),
                (CsvLoadStage::Merging, 2, 2, ""),
            ]
        );
        assert!(ev.iter().all(|e| e.file_count == 2));
    }

    #[test]
    fn single_file_load_still_emits_reading_and_merging() {
        let dir = tempfile::tempdir().unwrap();
        let a = write_csv(&dir, "a.csv", "timestamp,S1\n2024-01-01 00:00:00,1\n");
        let events: Mutex<Vec<CsvLoadStage>> = Mutex::new(Vec::new());
        read_merge_csvs_with_progress(vec![a], &|p| events.lock().unwrap().push(p.stage)).unwrap();
        assert_eq!(
            events.into_inner().unwrap(),
            vec![CsvLoadStage::Reading, CsvLoadStage::Reading, CsvLoadStage::Merging]
        );
    }

    #[test]
    fn a_failing_file_stops_the_load_without_a_merging_event() {
        let dir = tempfile::tempdir().unwrap();
        let ok = write_csv(&dir, "ok.csv", "timestamp,S1\n2024-01-01 00:00:00,1\n");
        let missing = dir.path().join("nope.csv").to_string_lossy().into_owned();
        let events: Mutex<Vec<CsvLoadStage>> = Mutex::new(Vec::new());
        let r = read_merge_csvs_with_progress(vec![ok, missing], &|p| {
            events.lock().unwrap().push(p.stage)
        });
        assert!(r.is_err());
        assert!(!events.into_inner().unwrap().contains(&CsvLoadStage::Merging));
    }
}
