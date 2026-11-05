import type { HealthPreview } from './health';

/** Sidecar `preview_relationship` response. `rmse2_per_step[i]` is 2 * RMSE; the last entry of the `*_per_step` arrays is the full model. With `max_points`, predicted/target_raw/predictor_raw are one aligned strided sample: read N from `n_rows`, not `.length`. `residual` is not sent. */
export interface RelationshipPreviewResult {
  request: string;
  r2_per_step: number[];
  rmse2_per_step: number[];
  /** Total rows the fit used (the same value with or without `max_points`). */
  n_rows: number;
  /** Bounded sample (see above); every row only when `max_points` is not sent. */
  predicted: (number | null)[];
  /** Only sent when the call does NOT pass `max_points` (legacy). Nobody reads it. */
  residual?: (number | null)[];
  /** Raw target values at the sampled rows, same order as `predicted`; attached by the Rust command, not the sidecar. */
  target_raw?: number[];
  /** Raw predictor matrix at the sampled rows, `[row][predictorIndex]`, in the order of the `predictors` argument. */
  predictor_raw?: number[][];
  /** Present only on failure. */
  error?: string;
  trace?: string;
  /** Health score fields, present only when `cache_key` was passed. `cached: false` = the fit missed the byte budget or the dataset was reloaded (compute_health_preview then answers NOT_FITTED). */
  cache_key?: string;
  cached?: boolean;
  health_preview?: HealthPreview;
}

/** Ellipse parameters from a single Gaussian fit (one cluster). */
interface EllipseFit {
  x_center: number;
  y_center: number;
  x_sd: number;
  y_sd: number;
  angle_deg: number;
}

/** Half-open (min, max] range over the criteria sensor (min < v <= max); a null bound = unbounded, matching Rust's Option<f64>. */
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

/** Dashboard filter shape (sensors, time window, value gates) for get_chart_data and get_scatter_sample. */
export interface DashboardDataFilter {
  sensors: string[];
  timestamp_start: string | null;
  timestamp_end: string | null;
  /** Multiple training periods: a row is kept if it falls in any range; null = open end. Send this or the legacy start/end pair, never both. */
  timestamp_ranges?: { start: string | null; end: string | null }[];
  value_filters: {
    sensor: string;
    operation: string;
    value1: number | null;
    value2: number | null;
  }[];
}

/** Hourly-bucket aggregation mode for the dashboard's "Sampling (1 hr)" select. */
export type ChartSamplingMethod = 'raw' | 'avg' | 'max' | 'min' | 'first' | 'last';

/** Bounded columnar payload from get_chart_data; `timestamps.length <= max_points` however large the dataset. */
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

/** True first/last timestamp of the whole dataset from get_dataset_time_bounds, ignoring any time filter; anchors the relative-range buttons. Both null if no timestamp parsed. */
export interface DatasetTimeBounds {
  min: string | null;
  max: string | null;
}

/** Bounded sample for scatter/pair plot from get_scatter_sample, `rows.length <= max_points`. `headers` are in the same order as each row's `values`. */
export interface ScatterSample {
  headers: string[];
  /** Each row mirrors the Rust `CsvRecord` shape: timestamp + value columns. */
  rows: { timestamp: string | null; values: (number | null)[] }[];
  /** Total rows that passed the filter (the population sampled from). */
  total: number;
  /** Rows actually returned (`=== rows.length`). */
  sampled: number;
}
