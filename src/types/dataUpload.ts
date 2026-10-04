/** Extended report returned by load_csv (replaces CsvMetadata) */
export interface CsvLoadReport {
  headers: string[];
  total_rows: number;
  columns: ColumnInfo[];
  warnings: string[];
  /** Generation of the session this load installed (see `CsvMetadata.generation`).
   *  Optional only for hand-built fixtures; the backend always sends it. */
  generation?: number;
  /** Per-file facts, in the order the paths were given (2026-10-04). Every field below is
   *  optional: old fixtures/saved reports lack them, and `null` means "unknown" — the UI must
   *  hide the matching card instead of showing a made-up value. */
  files?: CsvFileInfo[];
  /** Merged dataset period, "YYYY-MM-DD HH:MM:SS" (Buddhist-Era years already converted to CE). */
  period_start?: string | null;
  period_end?: string | null;
  period_start_micros?: number | null;
  period_end_micros?: number | null;
  /** Median gap between consecutive timestamps, in seconds. */
  interval_seconds?: number | null;
  /** Empty cells as a percentage (0–100) of rows × sensor columns. */
  missing_percent?: number | null;
}

/** One input file of a `load_csv` call. */
export interface CsvFileInfo {
  /** File name only, no directory. */
  name: string;
  size_bytes: number;
  /** Data rows read from this file (before merging / duplicate folding). */
  rows: number;
  start: string | null;
  end: string | null;
  /** Epoch microseconds of the same instants (safe as JS numbers), for the coverage bar. */
  start_micros: number | null;
  end_micros: number | null;
}

/** Payload of the global `csv-load-progress` event emitted while `load_csv` runs. */
export interface CsvLoadProgress {
  /** 0-based; equals `file_count` for the `merging` / `done` stages. */
  file_index: number;
  file_count: number;
  /** Empty for `merging` / `done`. */
  file_name: string;
  stage: 'reading' | 'merging' | 'done';
  /** Files fully read so far — drive a progress bar from this, not from event order. */
  files_done: number;
}

interface ColumnInfo {
  name: string;
  dtype: 'datetime' | 'numeric';
  null_count: number;
  /** Total non-null values */
  valid_count: number;
}

/** Raw mapping CSV data */
export interface MappingData {
  headers: string[];
  rows: string[][];
}

/** Result of applying key column mapping */
export interface MappingResult {
  /** Key values found in both mapping and dataset */
  matched: string[];
  /** Key values in mapping but not in dataset */
  not_in_dataset: string[];
  /** Columns in dataset but not found in mapping */
  not_in_mapping: string[];
}
