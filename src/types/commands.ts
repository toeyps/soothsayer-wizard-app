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
interface EllipseFit {
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
interface ClusterRange {
  min: number | null;
  max: number | null;
}

/** Per-cluster ellipse fit returned by `compute_clustering_preview`. */
interface ClusterDetail {
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
 * value gates) accepted by `get_chart_data` and
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

/**
 * True first/last timestamp across the WHOLE loaded dataset, from
 * `get_dataset_time_bounds` — ignores whatever time filter is currently
 * applied, unlike `ChartViewData.ts_min`/`ts_max` (which reflect only the
 * filtered population). The one source of truth for "what does this dataset
 * span": labels the Time Range panel and anchors the Y/M/W/D/H relative-range
 * buttons to the data itself instead of the machine's clock. Both null when
 * every row's timestamp failed to parse (or the dataset is empty).
 */
export interface DatasetTimeBounds {
  min: string | null;
  max: string | null;
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
