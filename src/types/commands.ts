import { SensorMetadata, SensorOperationConfig } from '../types';
import { CsvLoadReport, MappingData, MappingResult } from './dataUpload';
import type { FormulaValidationResult } from './calculationEngine';

/**
 * Response shape from the Python sidecar's `preview_relationship` action.
 *
 * Phase 5: legacy `output / r2_dict / rmse2_dict` fields removed. The
 * cumulative-feature scores live in `r2_per_step` / `rmse2_per_step`
 * (last entry is the full-model score). `rmse2_per_step[i]` is `2 * RMSE`
 * — divide by 2 for plain RMSE.
 *
 * `predicted` and `residual` are aligned with the (NaN-dropped, projected)
 * input rows — same length as the `y` vector that was sent to the sidecar.
 */
export interface RelationshipPreviewResult {
  request: string;
  r2_per_step: number[];
  rmse2_per_step: number[];
  predicted: (number | null)[];
  residual: (number | null)[];
  /**
   * Raw target values (`y` vector) — same length / order as `predicted`.
   * Attached by the Rust command (NOT the sidecar) so the UI can build
   * (predictor, target) scatter pairs without re-fetching the dataset.
   */
  target_raw?: number[];
  /**
   * Raw predictor matrix — `predictor_raw[row][predictorIndex]`.
   * Outer length matches `predicted`. Inner length matches the
   * `predictors` array order passed to `preview_relationship_model`.
   */
  predictor_raw?: number[][];
  /** Present only on failure. */
  error?: string;
  trace?: string;
}

/** New: result of `train_individual_model` (writes JSON to disk). */
export interface IndividualModelInfo {
  model_name: string;
  publish_id: number;
  training_set_start_date: string;
  training_set_end_date: string;
  mean: number;
  sd: number;
  boundary_1sd: [number, number];
  boundary_3sd: [number, number];
  saved_path: string;
}

/** Ellipse parameters from a single Gaussian fit (one cluster). */
export interface EllipseFit {
  x_center: number;
  y_center: number;
  x_sd: number;
  y_sd: number;
  angle_deg: number;
}

/**
 * Half-open `[min, max)` range over the criteria sensor's value used to
 * assign rows to a cluster. `null` on either bound means "unbounded in
 * that direction" — matches Rust's `Option<f64>` (which is how
 * `wizard.py`'s `-inf` / `+inf` round-trips through JSON without
 * relying on non-finite floats).
 */
export interface ClusterRange {
  min: number | null;
  max: number | null;
}

/** Per-cluster ellipse fit returned by `compute_clustering_preview`. */
export interface ClusterDetail {
  /** 1-based cluster id, matching `wizard.py`'s string keys ("1", "2", …). */
  cluster_id: number;
  /** `null` for the single-cluster path (no criteria split). */
  range: ClusterRange | null;
  n_rows: number;
  ellipse: EllipseFit;
  /** Per-row X values for this cluster (first_sensor, NaN-dropped). */
  xs: number[];
  /** Per-row Y values for this cluster (second_sensor, NaN-dropped). */
  ys: number[];
}

/** Result of `compute_clustering_preview` — supports 1..N clusters. */
export interface ClusteringPreview {
  first_sensor: string;
  second_sensor: string;
  /** Set when `cluster_count > 1`; null on the single-cluster path. */
  criteria_sensor: string | null;
  cluster_count: number;
  /** Total rows assigned across all clusters (sum of clusters[*].n_rows). */
  n_rows: number;
  /** One entry per cluster, in cluster_id order (1..=N). */
  clusters: ClusterDetail[];
}

/** Result of `train_clustering_model` (writes JSON to disk). */
export interface ClusteringModelInfo {
  model_name: string;
  first_sensor: string;
  second_sensor: string;
  criteria_sensor: string | null;
  cluster_count: number;
  clusters: ClusterDetail[];
  saved_path: string;
}

/** New: result of `train_relationship_model`. */
export interface RelationshipTrainResult {
  model_path: string;
  r2: number;
  rmse2: number;
  n_rows: number;
  info_path: string;
}

/**
 * Shared dashboard filter shape (sensor projection + timestamp window +
 * value gates) accepted by `get_chart_data`, `get_table_page`, and
 * `get_scatter_sample`.
 */
export interface DashboardDataFilter {
  sensors: string[];
  timestamp_start: string | null;
  timestamp_end: string | null;
  value_filters: {
    sensor: string;
    operation: string;
    value1: number | null;
    value2: number | null;
  }[];
}

/** Hourly-bucket aggregation mode for the dashboard's "Sampling (1 hr)" select. */
export type ChartSamplingMethod = 'raw' | 'avg' | 'max' | 'min' | 'first' | 'last';

/**
 * Bounded, columnar chart payload from `get_chart_data`. The Rust side runs
 * the whole pipeline (filter → operation transform → optional hourly
 * aggregation → min/max decimation), so `timestamps.length <= max_points`
 * no matter how many rows the dataset holds — the WebView never receives or
 * retains the full dataset.
 */
export interface ChartViewData {
  /** Output column names; `["Result (op)"]` in multi-op mode. */
  headers: string[];
  /** Shared x-axis values, aligned with every `series[s]`. */
  timestamps: string[];
  /** `series[s][k]` = value of `headers[s]` at `timestamps[k]`; null = missing. */
  series: (number | null)[][];
  /** Rows in the filtered (post-aggregation) population — the badge count. */
  total_rows: number;
  /** First/last timestamp of the filtered population (time-range inputs). */
  ts_min: string | null;
  ts_max: string | null;
}

/** One page of the post-op/post-aggregation row set (`get_table_page`). */
export interface TablePageData {
  headers: string[];
  rows: { timestamp: string | null; values: (number | null)[] }[];
  total_rows: number;
}

/**
 * Bounded sample of the (filtered) dataset for scatter / pair-plot rendering,
 * returned by `get_scatter_sample`. `rows.length <= max_points`, so the IPC
 * payload, JS heap, and WebGL buffers stay bounded regardless of how large
 * the underlying dataset is.
 *
 * `headers` lists the resolved sensors in the SAME column order as each row's
 * `values` — `headers.length === rows[i].values.length`.
 */
export interface ScatterSample {
  headers: string[];
  /** Each row mirrors the Rust `CsvRecord` shape: timestamp + value columns. */
  rows: { timestamp: string | null; values: (number | null)[] }[];
  /** Total rows that passed the filter (the population sampled from). */
  total: number;
  /** Rows actually returned (`=== rows.length`). */
  sampled: number;
}

export type TauriCommands = {
  /** Updated: now returns CsvLoadReport instead of CsvMetadata */
  load_csv: {
    args: { paths: string[] };
    returns: CsvLoadReport;
  };
  /** New: Load a mapping CSV and return raw rows/columns */
  load_mapping_csv: {
    args: { path: string };
    returns: MappingData;
  };
  /** New: Apply sensor tag-to-name mapping */
  apply_sensor_mapping: {
    args: {
      tag_column: string;
      name_column: string;
      mapping_data: MappingData;
      dataset_headers: string[];
    };
    returns: MappingResult;
  };
  get_loaded_paths: {
    args: Record<string, never>;
    returns: string[];
  };
  /**
   * Bounded columnar chart payload: filter → operation transform → optional
   * hourly aggregation → min/max decimation, all in Rust. The response never
   * exceeds `max_points` x-positions, so chart rendering stays O(max_points)
   * regardless of dataset size.
   */
  get_chart_data: {
    args: {
      filter: DashboardDataFilter;
      sampling: ChartSamplingMethod;
      operation: SensorOperationConfig | null;
      max_points: number;
    };
    returns: ChartViewData;
  };
  /** One page of the post-op/post-aggregation row set for the data table. */
  get_table_page: {
    args: {
      filter: DashboardDataFilter;
      sampling: ChartSamplingMethod;
      operation: SensorOperationConfig | null;
      page: number;
      page_size: number;
    };
    returns: TablePageData;
  };
  get_all_sensors: {
    args: Record<string, never>;
    returns: string[];
  };
  load_metadata_command: {
    args: { path: string };
    returns: SensorMetadata[];
  };
  calculate_new_sensor: {
    args: { sensors: string[]; config: SensorOperationConfig };
    returns: string;
  };
  /**
   * Run a Relationship-model preview (LinearGAM) via the Python sidecar.
   * Returns the raw JSON payload from the sidecar — see `RelationshipPreviewResult`.
   *
   * `filter` is optional and mirrors the dashboard's filter shape; when
   * supplied the preview is built off the filtered slice (same rows the
   * user is looking at on the previous page). Pass `null`/omit to use
   * every row.
   */
  preview_relationship_model: {
    args: {
      predictors: string[];
      target: string;
      lambda: number;
      filter?: {
        timestamp_start: string | null;
        timestamp_end: string | null;
        value_filters: {
          sensor: string;
          operation: string;
          value1: number | null;
          value2: number | null;
        }[];
      } | null;
    };
    returns: RelationshipPreviewResult;
  };
  /** Evaluate a formula expression and create a new sensor column */
  evaluate_formula: {
    args: { formula: string; custom_name: string | null };
    returns: string;
  };
  /** Validate a formula without executing it */
  validate_formula: {
    args: { formula: string };
    returns: FormulaValidationResult;
  };
  /** Train + persist an Individual model. Writes INDV_INFO_*.json under
   *  `{save_path}/output/{target}/` and returns the JSON payload. */
  train_individual_model: {
    args: {
      target: string;
      model_name: string | null;
      save_path: string;
    };
    returns: IndividualModelInfo;
  };
  /**
   * GMM ellipse fit preview — supports 1..N clusters. When
   * `n_clusters === 1`, both `criteria_sensor` and `cluster_ranges` are
   * ignored (single-cluster path uses all rows). When `n_clusters > 1`,
   * both are required: rows are split into clusters by whether the
   * criteria sensor's value falls in `[range.min, range.max)`, and one
   * Gaussian is fit per cluster. No disk write — preview only.
   */
  compute_clustering_preview: {
    args: {
      first_sensor: string;
      second_sensor: string;
      n_clusters: number;
      criteria_sensor: string | null;
      cluster_ranges: ClusterRange[] | null;
    };
    returns: ClusteringPreview;
  };
  /** Train + persist a Clustering model (1..N clusters). Writes
   *  CLUS_INFO_*.json under `{save_path}/output/{second_sensor}/`,
   *  matching wizard.py's CLUSTERING_INFO shape including the
   *  per-cluster criteria-range fields. */
  train_clustering_model: {
    args: {
      first_sensor: string;
      second_sensor: string;
      n_clusters: number;
      criteria_sensor: string | null;
      cluster_ranges: ClusterRange[] | null;
      model_name: string | null;
      save_path: string;
    };
    returns: ClusteringModelInfo;
  };
  /** Train + persist a Relationship (LinearGAM) model. Sidecar writes the
   *  pickled .pkl; Rust writes the REL_INFO_*.json alongside it. */
  train_relationship_model: {
    args: {
      predictors: string[];
      target: string;
      lambda: number;
      save_path: string;
      model_name: string | null;
    };
    returns: RelationshipTrainResult;
  };
  /**
   * Return a bounded uniform random sample of the (filtered) dataset for
   * scatter / pair-plot rendering. The sample never exceeds `maxPoints` rows,
   * keeping IPC, heap, and GPU bounded for arbitrarily large datasets.
   *
   * `filter.sensors` selects which sensor columns to project (the chart's
   * visible sensors). Timestamp / value filters mirror `get_filtered_data`.
   * `max_points` uses snake_case to match the Rust param exactly, like the
   * other commands in this file (Tauri matches the key verbatim).
   */
  get_scatter_sample: {
    args: {
      filter: {
        sensors: string[];
        timestamp_start: string | null;
        timestamp_end: string | null;
        value_filters: {
          sensor: string;
          operation: string;
          value1: number | null;
          value2: number | null;
        }[];
      };
      max_points: number;
    };
    returns: ScatterSample;
  };
  /**
   * Write arbitrary bytes to a user-picked file path (CSV / PDF / PNG exports).
   * Bridges through Rust so it bypasses the fs plugin's scope restrictions
   * (Phase 2 will limit the fs plugin to `$APPDATA/**`). `contents` is the
   * `Vec<u8>` payload — Tauri IPC serializes it as `number[]`.
   */
  write_user_file: {
    args: { path: string; contents: number[] };
    returns: void;
  };
  /**
   * Append one error entry to the persistent error log
   * (`<app-log-dir>/frontend-errors.log`, e.g. `%LOCALAPPDATA%/<identifier>/logs`
   * on Windows). Called by the global error reporter (window.onerror,
   * unhandledrejection, React ErrorBoundary) so production failures — where
   * DevTools don't exist — leave a trail the user can inspect or send back.
   * Returns the log file's absolute path so the UI can point at it.
   */
  log_frontend_error: {
    args: { message: string; detail: string | null };
    returns: string;
  };
  /** Absolute path of the error log file (for display next to error toasts). */
  get_error_log_path: {
    args: {};
    returns: string;
  };
};
