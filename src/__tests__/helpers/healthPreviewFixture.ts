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
