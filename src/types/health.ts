/**
 * Health score command contract (2026-10-03, phase 3a) — the TypeScript twin of
 * the Rust types in `src-tauri/src/health_preview.rs`, `health_score.rs` and
 * `model_export.rs`.
 *
 * EVERY field name here is exactly what Rust sends / expects (snake_case).
 * Do not camelCase them. The only camelCase set-point shape is the model's own
 * `FailureModel.healthSetPoints` (`HealthSetPoints` in `../types`); it is
 * converted to `HealthSetPointsWire` by `healthSetPointsToWire`
 * (`src/utils/healthRequest.ts`) before it goes over IPC.
 *
 * The three commands (every call needs an explicit return type):
 *
 *   invoke<HealthPreview>('compute_health_preview', { request: HealthPreviewRequest })
 *   invoke<ModelFilesResult>('export_model_files', { request: ModelFilesRequest })
 *   invoke<string>('get_model_output_dir', { workspace_id })
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
    /** Cap on `series` points (Rust default 4000, max 100 000). */
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
    /** Train/Test validation (2026-10-07): the model's EFFECTIVE test periods.
     *  Omitted when there are none; when present the response carries
     *  `test_validation`. Built by `toTestPeriodsWire`. */
    test_periods?: TestPeriodWire[];
}

/** One test period on the wire (snake_case, `''` → `null`; `event_time` only
 *  for a Known problem with a valid event time). */
export interface TestPeriodWire {
    start: string | null;
    end: string | null;
    label: 'normal' | 'problem';
    event_time?: string | null;
}

/** Train-only summary inside `ValidationResult` — the kind's own metrics are
 *  present (Relationship: r2/rmse/residual_*; Individual: mean/sd/within_3sd_pct;
 *  Clustering: inside_3sd_ring_pct). `days` = running days of train rows. */
export interface ValidationTrainSummary {
    rows: number;
    days: number;
    r2?: number;
    rmse?: number;
    residual_mean?: number;
    residual_sd?: number;
    mean?: number;
    sd?: number;
    within_3sd_pct?: number;
    inside_3sd_ring_pct?: number;
}

/** Results for one test period, scored with the TRAIN-only model. "Below 80"
 *  means sustained for 1 h of running time (Rust rule). */
export interface TestPeriodResult {
    /** 1-based position in the request's `test_periods` (T1 = index 1) — Rust
     *  sends `i + 1`. The UI numbers tests by list position; don't mix the two. */
    index: number;
    label: 'normal' | 'problem';
    start: string | null;
    end: string | null;
    event_time: string | null;
    days: number;
    rows: number;
    r2?: number;
    rmse?: number;
    residual_mean?: number;
    residual_sd?: number;
    within_3sd_pct?: number;
    mean_shift_sd?: number;
    inside_3sd_ring_pct?: number;
    /** Rows (and running days) of this test period that are also train rows. */
    train_rows?: number;
    train_days?: number;
    scored: number;
    pct_below_80: number | null;
    first_below_80: string | null;
    lowest: number | null;
    lowest_at: string | null;
    lead_days: number | null;
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
}

export type HealthStats = IndividualStats | RelationshipStats | ClusteringStats;

/** `score` is `null` while the set points are incomplete/invalid ("Set the
 *  points above"); otherwise one entry per row, `null` where a row has no score
 *  (out of scope / input missing) — never 0. */
export interface IndividualSeries {
    kind: 'individual';
    /** 0-based dataset row of each point. */
    rows: number[];
    /** CSV timestamp text ('' when the row has none). */
    timestamps: string[];
    value: number[];
    in_scope: boolean[];
    score: (number | null)[] | null;
    /** Series size BEFORE downsampling. */
    total_points: number;
}

export interface RelationshipSeries {
    kind: 'relationship';
    rows: number[];
    timestamps: string[];
    actual: number[];
    predicted: (number | null)[];
    /** actual - predicted. */
    residual: (number | null)[];
    score: (number | null)[] | null;
    total_points: number;
}

export interface ClusteringSeries {
    kind: 'clustering';
    rows: number[];
    timestamps: string[];
    x: number[];
    y: number[];
    /** 1-based cluster id; `null` = in no criteria range. */
    cluster: (number | null)[];
    /** Distance to the cluster centre in SD units (`null` until the set points are valid). */
    sd_distance: (number | null)[];
    score: (number | null)[] | null;
    total_points: number;
}

export type HealthSeries = IndividualSeries | RelationshipSeries | ClusteringSeries;

export interface MinScorePoint {
    score: number;
    row: number;
    timestamp: string | null;
}

export interface ScoreSummary {
    /** Rows that got a score. */
    scored: number;
    /** Rows without one (out of scope / input missing). */
    unscored: number;
    total_rows: number;
    min_score: MinScorePoint | null;
    /** % of SCORED rows with score < 80. */
    pct_below_80: number | null;
    share_80_100: number | null;
    share_40_80: number | null;
    share_0_40: number | null;
    /** Always `'row_count'`: shares are by row count, not by wall-clock time. */
    share_basis: 'row_count';
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
    series: HealthSeries;
    /** `null` when `valid` is false. */
    score_summary: ScoreSummary | null;
    /** Individual only. */
    histogram: HealthHistogram | null;
    /** Relationship only. */
    fit_scatter: HealthFitScatter | null;
    /** Clustering only. */
    cluster_scatter: HealthClusterScatter | null;
    /** Present when the request carried `test_periods` (`null`/absent otherwise). */
    test_validation?: ValidationResult | null;
}

// ---------------------------------------------------------------------------
// export_model_files ("Mark complete" writes the model's files)
// ---------------------------------------------------------------------------

export interface ModelFilesRequest {
    kind: ModelKind;
    /** Names the output folder `{app_data}/workspaces/{workspace_id}/output`. */
    workspace_id: string;
    model_name?: string | null;
    target?: string | null;
    predictors?: string[];
    /** Relationship stiffness as the LinearGAM lambda (required for Relationship). */
    lambda?: number | null;
    first_sensor?: string | null;
    second_sensor?: string | null;
    n_clusters?: number | null;
    criteria_sensor?: string | null;
    cluster_ranges?: HealthClusterRange[] | null;
    filter?: TrainingScopeFilter | null;
    set_points?: HealthSetPointsWire | null;
    /** Relationship: the fit's cache key (lets Rust validate before the ~15 s sidecar run). */
    cache_key?: string | null;
    expected_generation?: number;
    /** Train/Test validation (2026-10-07): written into the `*_INFO_*.json`
     *  `validation` block. Mark complete requires at least one
     *  (`markCompleteBlockReason`); the model itself is trained on the train
     *  periods only. Same wire shape as the preview's. */
    test_periods?: TestPeriodWire[];
}

export interface WrittenFile {
    /** `'info'` (`*_INFO_*.json`) | `'model'` (`.pkl`) | `'dataset'` (`.csv`). */
    kind: 'info' | 'model' | 'dataset';
    file_name: string;
    /** Absolute path in the final output folder. */
    path: string;
}

export interface ModelFilesResult {
    /** `false` = the set points failed validation: NOTHING was written. Hard
     *  failures (sidecar, disk) reject instead. */
    ok: boolean;
    files: WrittenFile[];
    /** `{app_data}/workspaces/{workspace_id}/output`. */
    output_dir: string;
    validation: HealthIssue[];
    warnings: string[];
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
