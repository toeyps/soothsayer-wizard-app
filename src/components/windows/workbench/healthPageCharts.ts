import type {
    ClusterStat,
    ClusteringSeries,
    IndividualSeries,
    IndividualStats,
    RelationshipSeries,
} from '../../../types/health';
import type {
    ClusteringHealthSetPoints,
    IndividualHealthSetPoints,
    RelationshipHealthSetPoints,
} from '../../../types';
import { CHART, CLUSTER_COLORS, FONT } from './chartTheme';
import { buildTimeSeriesOption, ellipseSeries, niceExtent, type HLine } from './healthCharts';

/*
 * Pure ECharts option builders of the Health score page (health score phase
 * 3b-2, 2026-10-04): the SET-POINT chart (per kind) and the SCORE chart. Like
 * `healthCharts.ts` they take only the bounded `compute_health_preview` payload
 * plus the set points being edited (the draft), and return a plain option.
 *
 * Lines for a value that is not entered yet (null / NaN) are simply absent;
 * they appear and move as the user types.
 *
 * Hover sync: every time-based option (set-point chart of Individual /
 * Relationship, and the score chart) carries `axisPointer.link` on the X axis
 * and the page puts both charts in one ECharts group (`echarts.connect`), so the
 * same timestamp cursor and tooltip show on both. Both are drawn from the SAME
 * downsampled index set, which Rust guarantees.
 */

/** ECharts group id the two time charts are connected under. */
export const HEALTH_SYNC_GROUP = 'health-score-sync';

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

const POINT_FONT = 'JetBrains Mono, monospace';

/** `axisPointer.link` so two connected charts show one cursor. */
const SYNC = { axisPointer: { link: [{ xAxisIndex: 'all' }] } };

// ---------------------------------------------------------------------------
// Score colour (0-100)
// ---------------------------------------------------------------------------

/** The colour of a score: 80-100 green, 40-80 amber, below 40 red. */
export function scoreColor(score: number | null | undefined, alpha = 1): string {
    if (!finite(score)) return `rgba(180, 190, 210, ${0.35 * alpha})`;
    if (score >= 80) return `rgba(16, 185, 129, ${alpha})`;
    if (score >= 40) return `rgba(229, 169, 61, ${alpha})`;
    return `rgba(238, 90, 69, ${alpha})`;
}

// ---------------------------------------------------------------------------
// Set-point chart - Individual
// ---------------------------------------------------------------------------

/** Raw sensor value over time with ±1SD, ±3SD and the L / H set-point lines.
 *  No histogram on this page. */
export function buildIndividualSetPointOption(
    series: IndividualSeries,
    stats: IndividualStats,
    sp: IndividualHealthSetPoints | null,
    unit: string,
) {
    const [l1, u1] = stats.boundary_1sd;
    const [l3, u3] = stats.boundary_3sd;
    const hLines: HLine[] = [
        { y: u1, color: CHART.ok, label: '+1SD' },
        { y: l1, color: CHART.ok, label: '−1SD' },
        { y: u3, color: CHART.warn, label: '+3SD' },
        { y: l3, color: CHART.warn, label: '−3SD' },
    ];
    if (sp && finite(sp.upper)) hLines.push({ y: sp.upper, color: CHART.danger, dashed: true, label: 'H' });
    if (sp && finite(sp.lower)) hLines.push({ y: sp.lower, color: CHART.danger, dashed: true, label: 'L' });
    return {
        ...buildTimeSeriesOption({
            timestamps: series.timestamps,
            yName: unit || undefined,
            lines: [{ name: 'Value', values: series.value, color: CHART.series }],
            bands: [
                { from: l3, to: u3, color: CHART.warnFill },
                { from: l1, to: u1, color: CHART.okFill },
            ],
            hLines,
        }),
        ...SYNC,
    };
}

// ---------------------------------------------------------------------------
// Set-point chart - Relationship
// ---------------------------------------------------------------------------

/** Residual over time ONLY, with ±2RMSE, a zero line and the four 80 / 0 lines
 *  (lower and upper) the user has entered so far. */
export function buildRelationshipSetPointOption(
    series: RelationshipSeries,
    twoRmse: number,
    sp: RelationshipHealthSetPoints | null,
    unit: string,
) {
    const hLines: HLine[] = [
        { y: twoRmse, color: CHART.ok, label: '+2RMSE' },
        { y: -twoRmse, color: CHART.ok, label: '−2RMSE' },
        { y: 0, color: 'rgba(255,255,255,0.25)' },
    ];
    if (sp) {
        if (finite(sp.residualAt80Upper)) hLines.push({ y: sp.residualAt80Upper, color: CHART.warn, dashed: true, label: '80' });
        if (finite(sp.residualAt80Lower)) hLines.push({ y: sp.residualAt80Lower, color: CHART.warn, dashed: true, label: '80' });
        if (finite(sp.residualAt0Upper)) hLines.push({ y: sp.residualAt0Upper, color: CHART.danger, dashed: true, label: '0' });
        if (finite(sp.residualAt0Lower)) hLines.push({ y: sp.residualAt0Lower, color: CHART.danger, dashed: true, label: '0' });
    }
    return {
        ...buildTimeSeriesOption({
            timestamps: series.timestamps,
            yName: unit || undefined,
            lines: [{ name: 'Residual', values: series.residual, color: CHART.series }],
            bands: [{ from: -twoRmse, to: twoRmse, color: CHART.okFill }],
            hLines,
        }),
        ...SYNC,
    };
}

// ---------------------------------------------------------------------------
// Set-point chart - Clustering
// ---------------------------------------------------------------------------

/** Half-width / half-height of the box around the ellipse `sigma` x SD of a
 *  cluster (rotated by its angle) - so a ring that lies outside the data is
 *  still inside the axes. */
export function ringBox(c: Pick<ClusterStat, 'x_center' | 'y_center' | 'x_sd' | 'y_sd' | 'angle_deg'>, sigma: number) {
    const rx = c.x_sd * sigma;
    const ry = c.y_sd * sigma;
    const a = (c.angle_deg * Math.PI) / 180;
    const hx = Math.hypot(rx * Math.cos(a), ry * Math.sin(a));
    const hy = Math.hypot(rx * Math.sin(a), ry * Math.cos(a));
    return { x: [c.x_center - hx, c.x_center + hx] as [number, number], y: [c.y_center - hy, c.y_center + hy] as [number, number] };
}

export interface ClusterSetPointNames { x: string; y: string }

/**
 * Scatter of the (bounded) points with the 1x, 3x and N x SD ring of EVERY
 * cluster. Points come from `series` (not `cluster_scatter`) so a hovered point
 * is exactly one entry of the score series: they are coloured by score once the
 * set points are valid, by cluster before. The N x ring appears when N is a
 * number (any number; Rust judges it).
 */
export function buildClusterSetPointOption(
    series: ClusteringSeries,
    clusters: ClusterStat[],
    sp: ClusteringHealthSetPoints | null,
    names: ClusterSetPointNames,
    hoverIdx: number | null = null,
) {
    const outer = sp && finite(sp.outerSd) && sp.outerSd > 0 ? sp.outerSd : null;
    const n = Math.min(series.x.length, series.y.length);
    const points: (number | null)[][] = [];
    for (let i = 0; i < n; i++) {
        if (!finite(series.x[i]) || !finite(series.y[i])) { points.push([null, null, null, null]); continue; }
        points.push([series.x[i], series.y[i], series.score ? (series.score[i] ?? null) : null, series.cluster[i] ?? null]);
    }
    const colorOfCluster = (id: number | null) =>
        id === null ? 'rgba(180, 190, 210, 0.45)' : CLUSTER_COLORS[(id - 1 + CLUSTER_COLORS.length) % CLUSTER_COLORS.length];

    let xLo = Infinity; let xHi = -Infinity; let yLo = Infinity; let yHi = -Infinity;
    const take = (b: { x: [number, number]; y: [number, number] }) => {
        xLo = Math.min(xLo, b.x[0]); xHi = Math.max(xHi, b.x[1]);
        yLo = Math.min(yLo, b.y[0]); yHi = Math.max(yHi, b.y[1]);
    };
    for (let i = 0; i < n; i++) {
        if (!finite(series.x[i]) || !finite(series.y[i])) continue;
        xLo = Math.min(xLo, series.x[i]); xHi = Math.max(xHi, series.x[i]);
        yLo = Math.min(yLo, series.y[i]); yHi = Math.max(yHi, series.y[i]);
    }
    for (const c of clusters) {
        take(ringBox(c, 1));
        take(ringBox(c, 3));
        if (outer !== null) take(ringBox(c, outer));
    }
    const ext = (lo: number, hi: number): [number, number] =>
        Number.isFinite(lo) && Number.isFinite(hi) ? niceExtent(lo - (hi - lo) * 0.03, hi + (hi - lo) * 0.03) : [0, 1];
    const [xMin, xMax] = ext(xLo, xHi);
    const [yMin, yMax] = ext(yLo, yHi);

    const rings = clusters.flatMap(c => {
        const r = [
            ellipseSeries(c, 1, { name: `Cluster ${c.cluster_id} 1× SD`, stroke: CHART.ok }),
            ellipseSeries(c, 3, { name: `Cluster ${c.cluster_id} 3× SD`, stroke: CHART.warn, dashed: true }),
        ];
        if (outer !== null) r.push(ellipseSeries(c, outer, { name: `Cluster ${c.cluster_id} ${outer}× SD`, stroke: CHART.danger, dashed: true, lineWidth: 1.8 }));
        return r;
    });
    const hover = hoverIdx !== null && hoverIdx >= 0 && hoverIdx < n && finite(series.x[hoverIdx]) && finite(series.y[hoverIdx])
        ? [{
            type: 'scatter' as const,
            name: 'Hover',
            data: [[series.x[hoverIdx], series.y[hoverIdx]]],
            symbolSize: 12,
            silent: true,
            itemStyle: { color: 'rgba(255,255,255,0.15)', borderColor: '#ffffff', borderWidth: 1.5 },
            z: 6,
        }]
        : [];
    const centres = {
        type: 'scatter' as const,
        name: 'Centres',
        data: clusters.map(c => [c.x_center, c.y_center]),
        symbolSize: 5,
        silent: true,
        itemStyle: { color: CHART.textPrimary },
        label: {
            show: true,
            position: 'top' as const,
            color: CHART.textSecondary,
            fontSize: 10.5,
            formatter: (p: { dataIndex: number }) => `Cluster ${clusters[p.dataIndex]?.cluster_id ?? ''}`,
        },
        z: 4,
    };
    return {
        backgroundColor: 'transparent',
        textStyle: { fontFamily: FONT },
        animation: false,
        tooltip: {
            backgroundColor: CHART.tooltipBg,
            borderColor: CHART.tooltipBorder,
            textStyle: { color: CHART.textPrimary },
            confine: true,
            trigger: 'item',
        },
        legend: { show: false },
        grid: { left: 58, right: 18, top: 14, bottom: 40, containLabel: false },
        dataZoom: [{ type: 'inside', xAxisIndex: 0, filterMode: 'none' }, { type: 'inside', yAxisIndex: 0, filterMode: 'none' }],
        xAxis: { type: 'value', name: names.x, min: xMin, max: xMax, nameLocation: 'middle', nameGap: 24, nameTextStyle: { color: CHART.textSecondary, fontSize: 10 }, axisLabel: { color: CHART.textSecondary, fontSize: 10 }, axisLine: { lineStyle: { color: CHART.gridLine } }, axisTick: { show: false }, splitLine: { show: false } },
        yAxis: { type: 'value', name: names.y, min: yMin, max: yMax, nameLocation: 'middle', nameGap: 44, nameTextStyle: { color: CHART.textSecondary, fontSize: 10 }, axisLabel: { color: CHART.textSecondary, fontSize: 10 }, axisLine: { lineStyle: { color: CHART.gridLine } }, axisTick: { show: false }, splitLine: { show: true, lineStyle: { color: CHART.splitLine } } },
        series: [
            {
                type: 'scatter' as const,
                name: 'Points',
                data: points,
                symbolSize: 4,
                itemStyle: {
                    opacity: 0.6,
                    color: (p: { data: (number | null)[] }) => {
                        const score = p.data[2];
                        return finite(score) ? scoreColor(score, 0.9) : colorOfCluster((p.data[3] as number | null) ?? null);
                    },
                },
                z: 1,
            },
            ...rings,
            centres,
            ...hover,
        ],
    };
}

// ---------------------------------------------------------------------------
// Score chart
// ---------------------------------------------------------------------------

/** Health score (0-100) over time: a dashed line at 80, the line coloured by the
 *  score band (green 80-100, amber 40-80, red below 40), gaps where a row has no
 *  score (`null`, never 0). */
export function buildScoreOption(timestamps: string[], score: (number | null)[]) {
    const base = buildTimeSeriesOption({
        timestamps,
        yName: 'Score',
        lines: [{ name: 'Health score', values: score, color: CHART.ok, width: 1.6 }],
        hLines: [{ y: 80, color: CHART.warn, dashed: true, label: '80' }],
        bands: [
            { from: 80, to: 100, color: 'rgba(16, 185, 129, 0.06)' },
            { from: 0, to: 80, color: 'rgba(238, 90, 69, 0.05)' },
        ],
        yRange: [0, 100],
    });
    return {
        ...base,
        ...SYNC,
        yAxis: { ...base.yAxis, interval: 20 },
        visualMap: {
            show: false,
            type: 'piecewise',
            seriesIndex: 0,
            dimension: 1,
            pieces: [
                { gte: 80, color: CHART.ok },
                { gte: 40, lt: 80, color: CHART.warn },
                { lt: 40, color: CHART.danger },
            ],
            outOfRange: { color: CHART.textFaint },
        },
        // The tooltip of a connected pair stays readable on the dark card.
        tooltip: { ...base.tooltip, textStyle: { color: CHART.textPrimary, fontFamily: POINT_FONT, fontSize: 11 }, valueFormatter: (v: unknown) => (typeof v === 'number' ? String(Math.round(v)) : String(v ?? '')) },
    };
}
