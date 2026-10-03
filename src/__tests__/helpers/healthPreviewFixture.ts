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
 */

const TS = ['2026-01-01 00:00:00', '2026-01-01 01:00:00', '2026-01-01 02:00:00', '2026-01-01 03:00:00', '2026-01-01 04:00:00'];

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
// Set-point-aware answers (health score phase 3b-2)
// ---------------------------------------------------------------------------

const REQUIRED_MSG: Record<string, string> = {
    lower: 'Enter the lower set point (L): the value where health reaches 0 on the low side.',
    upper: 'Enter the upper set point (H): the value where health reaches 0 on the high side.',
    residual_at_80_lower: 'Enter the lower 80-point (residual where health is 80, negative).',
    residual_at_80_upper: 'Enter the upper 80-point (residual where health is 80, positive).',
    residual_at_0_lower: 'Enter the lower 0-point (residual where health is 0, negative).',
    residual_at_0_upper: 'Enter the upper 0-point (residual where health is 0, positive).',
    outer_sd: 'Enter the outer ring (N × SD): the distance where health reaches 0.',
};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * A `compute_health_preview` answer that FOLLOWS the request's `set_points`, the
 * way Rust does it (a tiny stand-in for `validate_*`, not a copy of the rules):
 * empty field -> a `required` issue naming it; Individual L/H that is not beyond
 * the 3SD boundary (2 / 8 in this fixture) -> `lower_inside_3sd` / `upper_inside_3sd`;
 * Clustering N <= 3 -> `outer_sd_not_above_3`; everything else valid, with a
 * 5-point score series (100, 90, 80, 60, 30) and a summary. A test that wants
 * something else passes `over`.
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
        series: { ...base.series, score } as HealthPreview['series'],
        score_summary: valid
            ? {
                scored: 5, unscored: 0, total_rows: 5,
                min_score: { score: 30, row: 4, timestamp: TS[4] },
                pct_below_80: 40, share_80_100: 60, share_40_80: 20, share_0_40: 20,
                share_basis: 'row_count',
            }
            : null,
        ...over,
    };
}
