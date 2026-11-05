/** Wire types for `compute_health_preview` (Rust twin). Keys are Rust's snake_case. Set points go through `healthSetPointsToWire` first; errors are rejected strings 'CODE: message'. */

import type { ModelKind } from '../types';


/** Training scope filter; the builder returns `null` for no filter at all. */
export interface TrainingScopeFilter {
    timestamp_ranges: { start: string | null; end: string | null }[];
    value_filters: {
        sensor: string;
        operation: 'less_than' | 'greater_than' | 'between' | 'equals';
        value1: number | null;
        value2: number | null;
    }[];
    combine: 'and' | 'or';
}

export interface HealthClusterRange {
    min: number | null;
    max: number | null;
}

/** Set points as Rust reads them; null/missing = not entered; only the model's own kind is filled. */
export interface HealthSetPointsWire {
    /** Individual: L / H — health 0 at this value. */
    lower?: number | null;
    upper?: number | null;
    /** Relationship: residual (= actual - predicted, lower side negative). */
    residual_at_80_lower?: number | null;
    residual_at_80_upper?: number | null;
    residual_at_0_lower?: number | null;
    residual_at_0_upper?: number | null;
    /** Clustering: N (> 3) — outer ring at N x each cluster's SD. */
    outer_sd?: number | null;
}


export interface HealthPreviewRequest {
    kind: ModelKind;
    /** Individual / Relationship target. */
    target?: string | null;
    /** Relationship predictors, in the order the model was fitted with. */
    predictors?: string[];
    /** Relationship: key the fit was cached under by `preview_relationship_model`. */
    cache_key?: string | null;
    /** Relationship: which predictor is the Fit scatter's X axis (default: first). */
    x_predictor?: string | null;
    /** Clustering. */
    first_sensor?: string | null;
    second_sensor?: string | null;
    n_clusters?: number | null;
    criteria_sensor?: string | null;
    cluster_ranges?: HealthClusterRange[] | null;
    /** Training scope (Relationship ignores it: its cached fit already used it). */
    filter?: TrainingScopeFilter | null;
    set_points?: HealthSetPointsWire | null;
    /** Cap on `series` points AND on `hourly` points, each (Rust default 4000,
     *  max 100 000). */
    max_points?: number;
    /** Cap on scatter points (Rust default 8000, max 100 000). */
    max_scatter_points?: number;
    /** Individual only: also return rows outside the scope (`in_scope:false`, unscored). */
    include_out_of_scope?: boolean;
    /** Refuse with `STALE_SESSION` when the loaded dataset's generation differs. */
    expected_generation?: number;
    /** Clears Rust's remembered scoring failure and retries; sent only by the 'Try again' button. */
    retry_test_scoring?: boolean;
    /** Effective scoring periods (wire key `test_periods`); when present the response carries `test_validation`. */
    test_periods?: TestPeriodWire[];
}

/** start/end only ('' -> null); Rust ignores a legacy `label`/`event_time`. */
export interface TestPeriodWire {
    start: string | null;
    end: string | null;
}

/** Train-only summary with the kind's own metrics. `rows`/`days` and metrics are RAW; only `hours` counts 1-hour points. */
export interface ValidationTrainSummary {
    /** RAW training rows. */
    rows: number;
    /** RAW running time of those rows, in days. */
    days: number;
    /** Training HOURS: 1-hour points that hold at least one training row. */
    hours: number;
    r2?: number;
    rmse?: number;
    residual_mean?: number;
    residual_sd?: number;
    mean?: number;
    sd?: number;
    within_3sd_pct?: number;
    inside_3sd_ring_pct?: number;
}

/** Results per scoring period from the TRAIN-only model. Raw: `rows`, `days`, `train_rows`, `train_days`. 1-hour points: `hours`, `train_hours`, `scored`, `pct_below_80`, `lowest`, and the kind metrics. */
export interface TestPeriodResult {
    /** 1-based position in the request's `test_periods` (Rust sends `i + 1`); the UI numbers by list position. */
    index: number;
    start: string | null;
    end: string | null;
    /** RAW running time of the period: `rows` x the dataset's median sample
     *  interval, in days. */
    days: number;
    /** RAW dataset rows of the period that have all the model's inputs. */
    rows: number;
    /** HOURLY points of the period: clock hours with at least one of its rows. */
    hours: number;
    r2?: number;
    rmse?: number;
    residual_mean?: number;
    residual_sd?: number;
    within_3sd_pct?: number;
    mean_shift_sd?: number;
    inside_3sd_ring_pct?: number;
    /** RAW rows (and their raw running days) of this scoring period that are
     *  also train rows. */
    train_rows: number;
    train_days: number;
    /** HOURLY points of the period that are also training hours (hold at least
     *  one training row). */
    train_hours: number;
    /** HOURS that got a score. */
    scored: number;
    /** Share (%) of the scored HOURS whose score is below 80; `null` = nothing was scored. */
    pct_below_80: number | null;
    /** Lowest hourly score (whole number) and the start of that hour, e.g. `2024-01-05T13:00:00`. */
    lowest: number | null;
    lowest_at: string | null;
}

/** `compute_health_preview`'s train-vs-test comparison (named
 *  `test_validation` because `validation` is already the issue list). */
export interface ValidationResult {
    train: ValidationTrainSummary;
    train_ranges: { start: string | null; end: string | null }[];
    tests: TestPeriodResult[];
}

export type IssueSeverity = 'error' | 'warning';

/** `code` is stable; `message` is plain English; `field` names the input it belongs to. */
export interface HealthIssue {
    code: string;
    severity: IssueSeverity;
    message: string;
    field: string;
}

export interface IndividualStats {
    kind: 'individual';
    rows: number;
    mean: number;
    sd: number;
    boundary_1sd: [number, number];
    boundary_3sd: [number, number];
    min: number;
    max: number;
}

export interface RelationshipStats {
    kind: 'relationship';
    rows: number;
    target: string;
    predictors: string[];
    r2: number;
    rmse: number;
    /** 2 x RMSE — the half-width of the 100 band. */
    two_rmse: number;
    residual_mean: number;
    residual_sd: number;
    residual_min: number;
    residual_max: number;
    /** Cumulative per-predictor scores (last = the full model), for "Compare predictors". */
    r2_per_step: number[];
    rmse2_per_step: number[];
}

export interface ClusterStat {
    cluster_id: number;
    range: HealthClusterRange | null;
    n_rows: number;
    x_center: number;
    y_center: number;
    /** Major-axis SD. */
    x_sd: number;
    /** Minor-axis SD. */
    y_sd: number;
    angle_deg: number;
}

export interface ClusteringStats {
    kind: 'clustering';
    rows: number;
    assigned_rows: number;
    unassigned_rows: number;
    cluster_count: number;
    criteria_sensor: string | null;
    clusters: ClusterStat[];
    /** % of training rows inside their cluster's 3x SD ring (score >= 80); null if no row has a cluster. */
    inside_3sd_ring_pct: number | null;
}

export type HealthStats = IndividualStats | RelationshipStats | ClusteringStats;

/** Per-kind shape used as `series` (RAW rows; `score` always null) and as `hourly` (one point per clock hour). Hourly values are means of the hour's running rows; `score` is null (never 0) when unscored. */
export interface IndividualSeries {
    kind: 'individual';
    /** `series`: 0-based dataset row of each point. `hourly`: the first dataset
     *  row of the hour. */
    rows: number[];
    /** `series`: CSV timestamp text ('' when the row has none). `hourly`: the
     *  start of the hour. */
    timestamps: string[];
    /** `series`: the row's value. `hourly`: the mean of the hour's running rows. */
    value: number[];
    in_scope: boolean[];
    /** `series`: always `null`. `hourly`: one score per hour (see above). */
    score: (number | null)[] | null;
    /** Size BEFORE downsampling — rows for `series`, hours for `hourly`. */
    total_points: number;
}

/** As `hourly`: `actual` = hour's mean target, `predicted` = model on mean predictors, `residual` = actual - predicted. */
export interface RelationshipSeries {
    kind: 'relationship';
    rows: number[];
    timestamps: string[];
    actual: number[];
    predicted: (number | null)[];
    /** actual - predicted. */
    residual: (number | null)[];
    /** `series`: always `null`. `hourly`: one score per hour. */
    score: (number | null)[] | null;
    total_points: number;
}

/** As `hourly`: x/y = hour means; `cluster` = the cluster shared by EVERY row of the hour, else null with null `sd_distance`/`score` (never 0). No criteria sensor = one cluster. */
export interface ClusteringSeries {
    kind: 'clustering';
    rows: number[];
    timestamps: string[];
    x: number[];
    y: number[];
    /** 1-based cluster id; null = row in no range (`series`) or hour whose rows don't share one cluster (`hourly`). */
    cluster: (number | null)[];
    /** Distance to the cluster centre in SD units (`null` until the set points
     *  are valid, and for a row / hour with no cluster). */
    sd_distance: (number | null)[];
    /** `series`: always `null`. `hourly`: one score per hour; `null` for an
     *  hour with no cluster. */
    score: (number | null)[] | null;
    total_points: number;
}

export type HealthSeries = IndividualSeries | RelationshipSeries | ClusteringSeries;

/** Lowest score; hourly: `timestamp` = start of that hour, `row` = its first dataset row. */
export interface MinScorePoint {
    score: number;
    row: number;
    timestamp: string | null;
}

/** Summary of the TRAINING hours' scores. All counts and shares are in HOURS despite the `rows` key names on the wire. */
export interface ScoreSummary {
    /** HOURS that got a score. */
    scored: number;
    /** HOURS without one (`total_rows - scored`: an input missing / in no cluster). */
    unscored: number;
    /** Training hours (hours with at least one training row) the shares are measured against; not a row count. */
    total_rows: number;
    min_score: MinScorePoint | null;
    /** % of SCORED hours with score < 80. */
    pct_below_80: number | null;
    share_80_100: number | null;
    share_40_80: number | null;
    share_0_40: number | null;
    /** Always 'hour_count': counts and shares are 1-hour points. */
    share_basis: 'hour_count';
}

export interface HealthHistogram {
    /** counts.length + 1 ascending edges. */
    bin_edges: number[];
    counts: number[];
    /** Expected rows per bin under Normal(mean, sd) at each bin centre. */
    curve: number[];
    bin_width: number;
    n: number;
}

export interface HealthFitScatter {
    x_sensor: string;
    predictors: string[];
    x: number[];
    actual: number[];
    predicted: (number | null)[];
    total: number;
}

export interface HealthClusterScatter {
    x: number[];
    y: number[];
    cluster: (number | null)[];
    total: number;
}

export interface HealthPreview {
    kind: ModelKind;
    stats: HealthStats;
    /** Re-computed on every call. Empty = fine. */
    validation: HealthIssue[];
    /** `false` when any issue is an error (then no score is produced). */
    valid: boolean;
    /** The RAW dataset rows, for the Model fit page. `series.score` is ALWAYS
     *  `null` — read scores from `hourly`. */
    series: HealthSeries;
    /** Points the score is computed on (per-kind shape, see `IndividualSeries`); the Health score page reads this. */
    hourly: HealthSeries;
    /** The health score's sampling interval in seconds: `3600`. */
    scoring_interval_secs: number;
    /** `null` when `valid` is false. Counts HOURS (`share_basis: 'hour_count'`). */
    score_summary: ScoreSummary | null;
    /** Individual only. RAW training rows. */
    histogram: HealthHistogram | null;
    /** Relationship only. RAW training rows. */
    fit_scatter: HealthFitScatter | null;
    /** Clustering only. RAW training rows. */
    cluster_scatter: HealthClusterScatter | null;
    /** Present when the request carried `test_periods` (`null`/absent otherwise).
     *  Mixes raw rows and hours — see `TestPeriodResult`. */
    test_validation?: ValidationResult | null;
}


/** `NOT_FITTED`: Relation fit not in Rust memory, re-train. `NO_DATA`: no rows in scope. `BAD_REQUEST`: sensor/field missing. `STALE_SESSION`: generation mismatch. `SIDECAR_OUTDATED`: engine too old, update the app. */
export type HealthErrorCode = 'NOT_FITTED' | 'NO_DATA' | 'BAD_REQUEST' | 'STALE_SESSION' | 'VALIDATION' | 'SIDECAR_OUTDATED';
