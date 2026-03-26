/** Extended report returned by load_csv (replaces CsvMetadata) */
export interface CsvLoadReport {
  headers: string[];
  total_rows: number;
  columns: ColumnInfo[];
  warnings: string[];
}

export interface ColumnInfo {
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
