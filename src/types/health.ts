/**
 * Health score command contract — the TypeScript twin of
 * the Rust types in `src-tauri/src/health_preview.rs`, `health_score.rs` and
 * `model_export.rs`.
 *
 * EVERY field name here is exactly what Rust sends / expects (snake_case).
 * Do not camelCase them. The only camelCase set-point shape is the model's own
 * `FailureModel.healthSetPoints` (`HealthSetPoints` in `../types`); it is
 * converted to `HealthSetPointsWire` by `healthSetPointsToWire`
 * (`src/utils/healthRequest.ts`) before it goes over IPC.
 *
 * The command (every call needs an explicit return type):
 *
 *   invoke<HealthPreview>('compute_health_preview', { request: HealthPreviewRequest })
 *
 * Mark complete writes NO files (2026-10-20); Export results is the only
 * writer of the model files.
 *
 * Errors come back as a rejected string `"CODE: message"` — see `HealthErrorCode`
 * and `parseHealthError`.
 */

import type { ModelKind } from '../types';

// ---------------------------------------------------------------------------
// Shared request pieces
// ---------------------------------------------------------------------------

/** The training scope, same shape every preview/train command takes. The
 *  builder (`buildPreviewFilterPayload`) returns `null` for "no filter at all". */
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

/** The model's set points as Rust reads them (all optional; `null`/missing =
 *  "not entered"). Only the keys of the model's own kind are filled. */
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

// ---------------------------------------------------------------------------
// compute_health_preview
// ---------------------------------------------------------------------------

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
    /** Clear Rust's remembered test-scoring failure for this fit and try the
     *  Relation-model prediction again. Sent ONLY from the "Try again" button
     *  (`useHealthPreview.retryTestScoring`), never on ordinary previews. */
    retry_test_scoring?: boolean;
    /** The model's EFFECTIVE scoring periods (the wire key is still
     *  `test_periods`). Omitted when there are none; when present the response
     *  carries `test_validation`. Built by `toTestPeriodsWire`. */
    test_periods?: TestPeriodWire[];
}

/** One scoring period on the wire: start → end only (`''` → `null`). Rust
 *  still accepts and ignores a legacy `label` / `event_time`, but they are
 *  not sent. */
export interface TestPeriodWire {
    start: string | null;
    end: string | null;
}

/** Train-only summary inside `ValidationResult` — the kind's own metrics are
 *  present (Relationship: r2/rmse/residual_*; Individual: mean/sd/within_3sd_pct;
 *  Clustering: inside_3sd_ring_pct).
 *
 *  Units: `rows` / `days` and every metric here are RAW — the dataset rows the
 *  model was trained on and their running time (rows x the dataset's median
 *  sample interval). Only `hours` counts 1-hour points. */
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

/** Results for one scoring period, scored with the TRAIN-only model. Facts
 *  only — no label, no event time, no lead time and no verdict.
 *
 *  Units — the health score is computed on 1-HOUR AVERAGES (one point per
 *  clock hour = the mean of the hour's running rows), so two units live side
 *  by side here:
 *   - RAW rows / raw running time: `rows`, `days`, `train_rows`, `train_days`.
 *   - HOURS (1-hour points): `hours`, `train_hours`, `scored`, `pct_below_80`,
 *     `lowest`, `lowest_at`, and the kind metrics (`r2` … `inside_3sd_ring_pct`),
 *     which are computed over the period's hourly points. */
export interface TestPeriodResult {
    /** 1-based position in the request's `test_periods` (S1 = index 1) — Rust
     *  sends `i + 1`. The UI numbers periods by list position; don't mix the two. */
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
    /** The lowest HOURLY score of the period (rounded to a whole score), and
     *  the START of that hour (`2024-01-05T13:00:00`). Each point already is a
     *  1-hour average, so there is no separate "held for 1 h" window. */
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

/** One validation finding. `code` is stable; `message` is plain English the UI
 *  may show as-is; `field` names the input it belongs to (`lower`, `upper`,
 *  `sd`, `residual_at_80_lower`, `two_rmse`, `outer_sd`, `cluster_<id>`, ...). */
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
    /** Share (%) of the training rows with a cluster that sit inside its 3× SD ring
     *  (score ≥ 80) — sent with or without scoring periods; null when no training row
     *  has a usable cluster. */
    inside_3sd_ring_pct: number | null;
}

export type HealthStats = IndividualStats | RelationshipStats | ClusteringStats;

/**
 * One per-kind shape, used TWICE in a `HealthPreview`:
 *
 *  - as `series` — the RAW dataset rows (the Model fit page). One point per
 *    row: `rows` = the 0-based dataset row, `timestamps` = the CSV timestamp
 *    text ('' when the row has none). `score` is ALWAYS `null` here: the health
 *    score is not computed per row (the field stays in the type because the
 *    shape is shared).
 *  - as `hourly` — what the health score is computed on (the Health score
 *    page). One point per CLOCK HOUR: `timestamps` = the hour's START
 *    (`2024-01-05T13:00:00`), `rows` = the FIRST dataset row of that hour, every
 *    value = the MEAN of the hour's running rows, `in_scope` all `true`,
 *    `total_points` = hours before downsampling. `score` is `null` while the
 *    set points are incomplete/invalid ("Set the points above"); otherwise one
 *    entry per hour, `null` where the hour has no score (input missing / in no
 *    cluster / no prediction) — never 0. An hour with no running row has no
 *    point at all.
 */
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

/** See `IndividualSeries` for the `series` / `hourly` split. As `hourly`:
 *  `actual` = the hour's mean target, `predicted` = the model's answer for the
 *  hour's mean predictors, `residual` = that hour's actual − predicted. */
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

/**
 * See `IndividualSeries` for the `series` / `hourly` split. As `hourly`:
 * `x` / `y` = the hour's means over every row of the hour, `cluster` = the
 * cluster shared by EVERY row of the hour (each row's own cluster, from its
 * own criteria value), `sd_distance` / `score` of the point (mean x, mean y)
 * against that cluster.
 *
 * An hour whose rows do NOT all share one cluster — rows in two different
 * clusters, or any row with no cluster (criteria outside every range, or
 * criteria missing) among them — has no cluster: `cluster`, `sd_distance` and
 * `score` are all `null` for it (never 0). The hour is still a point here with
 * its mean `x` / `y` and still counts as an hour; it is only unscored. (It is
 * NOT the cluster of the hour's mean criteria value: an hour split between
 * two ranges would otherwise be scored against a cluster the machine was not
 * in.) A model with no criteria sensor has one cluster, so every hour has it.
 */
export interface ClusteringSeries {
    kind: 'clustering';
    rows: number[];
    timestamps: string[];
    x: number[];
    y: number[];
    /** 1-based cluster id. `series`: `null` = the row is in no criteria range.
     *  `hourly`: `null` = the hour's rows do not all share one cluster. */
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

/** The lowest score of a summary. For the hourly summary: `timestamp` = the
 *  START of that hour, `row` = the first dataset row of that hour. */
export interface MinScorePoint {
    score: number;
    row: number;
    timestamp: string | null;
}

/**
 * Summary of the HOURLY scores of the TRAINING hours (scoring periods have
 * their own results in `test_validation`). EVERY count and share here is in
 * HOURS (1-hour points) — the keys keep their old `rows` wording on the wire
 * (`total_rows` is a number of hours); nothing was renamed.
 */
export interface ScoreSummary {
    /** HOURS that got a score. */
    scored: number;
    /** HOURS without one (`total_rows - scored`: an input missing / in no cluster). */
    unscored: number;
    /** The HOURS the shares are measured against: the training hours (hours
     *  with at least one training row). Not a row count, despite the name. */
    total_rows: number;
    min_score: MinScorePoint | null;
    /** % of SCORED hours with score < 80. */
    pct_below_80: number | null;
    share_80_100: number | null;
    share_40_80: number | null;
    share_0_40: number | null;
    /** Always `'hour_count'`: every count and share above is in 1-hour points
     *  (it was `'row_count'` while the score was computed row by row). */
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
    /** The HOURLY points the health score is computed on (same per-kind shape
     *  as `series`, see `IndividualSeries`): one point per clock hour, every
     *  value the mean of the hour's running rows. Everything on the Health
     *  score page reads this. */
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

// ---------------------------------------------------------------------------
// Error codes (prefix of the rejected string, "CODE: message")
// ---------------------------------------------------------------------------

/** `NOT_FITTED` — Relationship has no fit in Rust's memory (not trained yet,
 *  dataset reloaded, special sensor recomputed, evicted): re-train.
 *  `NO_DATA` — no rows in scope. `BAD_REQUEST` — sensor missing / field missing.
 *  `STALE_SESSION` — `expected_generation` did not match the loaded dataset.
 *  `VALIDATION` — only from the direct `train_*` commands.
 *  `SIDECAR_OUTDATED` — the bundled Relation model engine is too old for the
 *  request (e.g. it cannot predict test rows): reinstall / update the app. */
export type HealthErrorCode = 'NOT_FITTED' | 'NO_DATA' | 'BAD_REQUEST' | 'STALE_SESSION' | 'VALIDATION' | 'SIDECAR_OUTDATED';
