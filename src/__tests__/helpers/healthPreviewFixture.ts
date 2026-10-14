import type {
    ClusterStat,
    HealthPreview,
    HealthPreviewRequest,
} from '../../types/health';

/**
 * A realistic `compute_health_preview` answer for tests (health score phase
 * 3b-1). `makeHealthPreview(request)` builds the payload for whatever the
 * component asked for — kind, predictors, the chosen X predictor, cluster
 * count — so a test that mocks the `invoke` of the Build Model window only has
 * to route the command here. Small, hand-checkable numbers; the series are
 * 5 points long.
 *
 * Two series, as Rust sends them (the health score is computed on 1-hour
 * averages):
 *  - `series`  — RAW rows for the Model fit page: CSV timestamp text (`TS`),
 *    `score` ALWAYS `null`.
 *  - `hourly`  — one point per clock hour for the Health score page: hour-start
 *    timestamps (`HOURLY_TS`, Rust's `2026-01-01T00:00:00` form), values that
 *    are the hour's MEAN, and the scores (`makeSetPointAwarePreview`).
 * The hourly values are deliberately NOT the raw values (the 5 raw points
 * stand for a sample of sub-hourly rows), so a test can tell which of the two
 * a chart or a read-out actually used.
 */

/** CSV timestamp text of the 5 raw rows of `series`. */
const TS = ['2026-01-01 00:00:00', '2026-01-01 01:00:00', '2026-01-01 02:00:00', '2026-01-01 03:00:00', '2026-01-01 04:00:00'];

/** Hour starts of the 5 points of `hourly`, as Rust labels an hour. */
export const HOURLY_TS = ['2026-01-01T00:00:00', '2026-01-01T01:00:00', '2026-01-01T02:00:00', '2026-01-01T03:00:00', '2026-01-01T04:00:00'];

/** `HealthPreview.scoring_interval_secs`: the score is computed per clock hour. */
export const SCORING_INTERVAL_SECS = 3600;

export function makeClusterStat(id: number, over: Partial<ClusterStat> = {}): ClusterStat {
    return {
        cluster_id: id,
        range: id === 1 ? { min: 0, max: 50 } : { min: 50, max: 100 },
        n_rows: 40 + id,
        x_center: 10 * id,
        y_center: 20 * id,
        x_sd: 2,
        y_sd: 1,
        angle_deg: 0,
        ...over,
    };
}

export function makeHealthPreview(req: HealthPreviewRequest | Record<string, any> | undefined, over: Partial<HealthPreview> = {}): HealthPreview {
    const r = (req ?? {}) as HealthPreviewRequest;
    const kind = r.kind ?? 'individual';
    if (kind === 'relationship') {
        const predictors = r.predictors && r.predictors.length ? r.predictors : ['TAG2'];
        return {
            kind,
            stats: {
                kind: 'relationship',
                rows: 321,
                target: r.target ?? 'TAG1',
                predictors,
                r2: 0.9123,
                rmse: 0.4567,
                two_rmse: 0.9134,
                residual_mean: 0.0123,
                residual_sd: 0.4,
                residual_min: -1.2,
                residual_max: 1.4,
                r2_per_step: predictors.map((_, i) => 0.5 + i * 0.1),
                rmse2_per_step: predictors.map((_, i) => 2 - i * 0.2),
            },
            validation: [],
            valid: false,
            series: {
                kind: 'relationship',
                rows: [0, 1, 2, 3, 4],
                timestamps: TS,
                actual: [10, 11, 12, 11, 10],
                predicted: [10.1, 10.9, 12.2, 11, 9.8],
                residual: [-0.1, 0.1, -0.2, 0, 0.2],
                score: null,
                total_points: 5,
            },
            hourly: {
                kind: 'relationship',
                rows: [0, 1, 2, 3, 4],
                timestamps: HOURLY_TS,
                // Hour means; residual = actual - predicted of the hour.
                actual: [10.2, 11.2, 12.2, 11.2, 10.2],
                predicted: [10.1, 10.9, 12.2, 11, 9.8],
                residual: [0.1, 0.3, 0, 0.2, 0.4],
                score: null,
                total_points: 5,
            },
            scoring_interval_secs: SCORING_INTERVAL_SECS,
            score_summary: null,
            histogram: null,
            fit_scatter: {
                x_sensor: r.x_predictor ?? predictors[0],
                predictors,
                x: [1, 2, 3, 4, 5],
                actual: [10, 11, 12, 11, 10],
                predicted: [10.1, 10.9, 12.2, 11, 9.8],
                total: 5,
            },
            cluster_scatter: null,
            ...over,
        };
    }
    if (kind === 'clustering') {
        const n = r.n_clusters ?? 2;
        const clusters = Array.from({ length: n }, (_, i) => makeClusterStat(i + 1));
        return {
            kind,
            stats: {
                kind: 'clustering',
                rows: 100,
                assigned_rows: 95,
                unassigned_rows: 5,
                cluster_count: n,
                criteria_sensor: r.criteria_sensor ?? null,
                clusters,
                inside_3sd_ring_pct: 98.9,
            },
            validation: [],
            valid: false,
            series: {
                kind: 'clustering',
                rows: [0, 1, 2, 3, 4],
                timestamps: TS,
                x: [10, 11, 20, 21, 12],
                y: [20, 21, 40, 41, 22],
                cluster: [1, 1, 2, 2, null],
                sd_distance: [null, null, null, null, null],
                score: null,
                total_points: 5,
            },
            hourly: {
                kind: 'clustering',
                rows: [0, 1, 2, 3, 4],
                timestamps: HOURLY_TS,
                // Hour means of X / Y; the cluster every row of the hour shares (null = the
                // hour's rows do not all share one cluster, so the hour has no score).
                x: [10.5, 11.5, 20.5, 21.5, 12.5],
                y: [20.5, 21.5, 40.5, 41.5, 22.5],
                cluster: [1, 1, 2, 2, null],
                sd_distance: [null, null, null, null, null],
                score: null,
                total_points: 5,
            },
            scoring_interval_secs: SCORING_INTERVAL_SECS,
            score_summary: null,
            histogram: null,
            fit_scatter: null,
            cluster_scatter: { x: [10, 11, 20, 21, 12], y: [20, 21, 40, 41, 22], cluster: [1, 1, 2, 2, null], total: 5 },
            ...over,
        };
    }
    return {
        kind: 'individual',
        stats: {
            kind: 'individual',
            rows: 1000,
            mean: 5,
            sd: 1,
            boundary_1sd: [4, 6],
            boundary_3sd: [2, 8],
            min: 0,
            max: 10,
        },
        validation: [],
        valid: false,
        series: {
            kind: 'individual',
            rows: [0, 1, 2, 3, 4],
            timestamps: TS,
            value: [5, 5.5, 4.5, 6.2, 3.1],
            in_scope: [true, true, true, true, true],
            score: null,
            total_points: 5,
        },
        hourly: {
            kind: 'individual',
            rows: [0, 1, 2, 3, 4],
            timestamps: HOURLY_TS,
            // Hour means.
            value: [5.1, 5.4, 4.6, 6.1, 3.2],
            in_scope: [true, true, true, true, true],
            score: null,
            total_points: 5,
        },
        scoring_interval_secs: SCORING_INTERVAL_SECS,
        score_summary: null,
        histogram: {
            bin_edges: [0, 2, 4, 6, 8, 10],
            counts: [10, 150, 700, 130, 10],
            curve: [10, 140, 710, 130, 10],
            bin_width: 2,
            n: 1000,
        },
        fit_scatter: null,
        cluster_scatter: null,
        ...over,
    };
}

// ---------------------------------------------------------------------------
// Set-point-aware answers
// ---------------------------------------------------------------------------

const REQUIRED_MSG: Record<string, string> = {
    lower: 'Enter the lower set point (L): the value where health reaches 0 on the low side.',
    upper: 'Enter the upper set point (H): the value where health reaches 0 on the high side.',
    residual_at_80_lower: 'Enter 80 low (the residual where the score is 80 on the low side, negative).',
    residual_at_80_upper: 'Enter 80 high (the residual where the score is 80 on the high side, positive).',
    residual_at_0_lower: 'Enter 0 low (the residual where the score reaches 0 on the low side, negative).',
    residual_at_0_upper: 'Enter 0 high (the residual where the score reaches 0 on the high side, positive).',
    outer_sd: 'Enter the outer ring (N × SD): the distance where health reaches 0.',
};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * A `compute_health_preview` answer that FOLLOWS the request's `set_points`, the
 * way Rust does it (a tiny stand-in for `validate_*`, not a copy of the rules):
 * empty field -> a `required` issue naming it; Individual L/H that is not beyond
 * the 3SD boundary (2 / 8 in this fixture) -> `lower_inside_3sd` / `upper_inside_3sd`;
 * Clustering N <= 3 -> `outer_sd_not_above_3`; everything else valid, with a
 * 5-point HOURLY score series (100, 90, 80, 60, 30) on `hourly.score` and a
 * summary that counts hours (`share_basis: 'hour_count'`; the minimum is located
 * by its hour start). `series.score` stays `null` — the raw rows are never
 * scored. A test that wants something else passes `over`.
 */
export function makeSetPointAwarePreview(req: HealthPreviewRequest | Record<string, any> | undefined, over: Partial<HealthPreview> = {}): HealthPreview {
    const r = (req ?? {}) as HealthPreviewRequest;
    const base = makeHealthPreview(r);
    const sp = (r.set_points ?? {}) as Record<string, unknown>;
    const fields = base.kind === 'individual'
        ? ['lower', 'upper']
        : base.kind === 'relationship'
            ? ['residual_at_80_lower', 'residual_at_80_upper', 'residual_at_0_lower', 'residual_at_0_upper']
            : ['outer_sd'];
    const validation: HealthPreview['validation'] = [];
    for (const f of fields) {
        if (num(sp[f]) === null) validation.push({ code: 'required', severity: 'error', message: REQUIRED_MSG[f], field: f });
    }
    if (base.kind === 'individual') {
        const l = num(sp.lower);
        const u = num(sp.upper);
        if (l !== null && l >= 2) validation.push({ code: 'lower_inside_3sd', severity: 'error', message: `The lower set point (L = ${l}) must be below the lower 3σ boundary (2).`, field: 'lower' });
        if (u !== null && u <= 8) validation.push({ code: 'upper_inside_3sd', severity: 'error', message: `The upper set point (H = ${u}) must be above the upper 3σ boundary (8).`, field: 'upper' });
    }
    if (base.kind === 'clustering') {
        const n = num(sp.outer_sd);
        if (n !== null && n <= 3) validation.push({ code: 'outer_sd_not_above_3', severity: 'error', message: `The outer ring (${n}× SD) must be more than 3× SD (the 80 point).`, field: 'outer_sd' });
    }
    const valid = validation.length === 0;
    const score = valid ? [100, 90, 80, 60, 30] : null;
    return {
        ...base,
        validation,
        valid,
        hourly: { ...base.hourly, score } as HealthPreview['hourly'],
        score_summary: valid
            ? {
                // Hours: 5 scored of the 5 training hours.
                scored: 5, unscored: 0, total_rows: 5,
                min_score: { score: 30, row: 4, timestamp: HOURLY_TS[4] },
                pct_below_80: 40, share_80_100: 60, share_40_80: 20, share_0_40: 20,
                share_basis: 'hour_count',
            }
            : null,
        ...over,
    };
}
