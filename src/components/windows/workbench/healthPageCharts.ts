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
import { fmtNumExact } from '../../sensor/sensorInfo';
import { CHART, CHART_MONO, CLUSTER_COLORS, FONT, fmtScoreAxisValue } from './chartTheme';
import {
    HOVER_AXIS_POINTER,
    buildTimeSeriesOption,
    centreLabelSeries,
    clusterAxes,
    clusterExtent,
    ellipseSeries,
    ringLabelSeries,
    rmseReferenceLines,
    sdReferenceLines,
    type ClusterChartNames,
    type HLine,
    type TimeScopes,
} from './healthCharts';

/*
 * Pure ECharts option builders of the Health score page: the SET-POINT chart
 * (per kind) and the SCORE chart. Like
 * `healthCharts.ts` they take only the bounded `compute_health_preview` payload
 * plus the set points being edited (the draft), and return a plain option.
 *
 * The page hands every builder here the HOURLY series (`HealthPreview.hourly`:
 * one point per clock hour, every value the mean of the hour's running rows) —
 * never the raw `series`, which is the Model fit page's and carries no score.
 *
 * Lines for a value that is not entered yet (null / NaN) are simply absent;
 * they appear and move as the user types.
 *
 * The user's set points are the STRONGEST lines of a chart (solid, 1.5 px) and
 * carry their value inside the plot at the right end — in the form the user
 * typed (`typedText`: "H 4.6", "L 2.2", "80 · +5"), never padded or rounded.
 * The computed reference lines (±1SD, ±3SD, ±2RMSE) are thin and labelled
 * outside the plot.
 *
 * Hover sync: every time-based option (set-point chart of Individual /
 * Relationship, and the score chart) carries `axisPointer.link` on the X axis
 * and the page puts both charts in one ECharts group (`echarts.connect`), so the
 * same timestamp cursor and tooltip show on both. Both are drawn from the SAME
 * downsampled index set (`hourly`), which Rust guarantees.
 */

/** ECharts group id the two time charts are connected under. */
export const HEALTH_SYNC_GROUP = 'health-score-sync';

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** Width of a set-point line (a reference line is 1 px). */
const SET_POINT_WIDTH = 1.5;

/**
 * A set point as the user typed it: every decimal of its shortest exact form,
 * thousands separators only — "4.6" (never the padded "4.60"), "4.61234" (never
 * the rounded "4.612"). The same rule Rust's validation messages follow
 * (`fmt_typed`), so the chart, the Checks and the input agree.
 *
 * As a chart label a negative carries a real minus sign (U+2212), like the
 * "−1SD" and "0 · −9" labels beside it — never the ASCII hyphen — and a negative
 * zero reads "0".
 */
export function typedText(v: number): string {
    return fmtNumExact(v === 0 ? 0 : v).replace(/^-/, '−');
}

/** A typed residual point with its sign spelled out: "+5", "−2.5", "0". */
export function signedTypedText(v: number): string {
    const sign = v > 0 ? '+' : v < 0 ? '−' : '';
    return `${sign}${typedText(Math.abs(v))}`;
}

/** `axisPointer.link` so two connected charts show one cursor. */
const SYNC = { axisPointer: { ...HOVER_AXIS_POINTER, link: [{ xAxisIndex: 'all' }] } };

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

/** The sensor's 1-hour average over time with the ±1SD band (the only fill), the dashed
 *  ±3SD lines and the L / H set-point lines ("H 4.6" above its line, "L 2.2"
 *  below). No histogram on this page. */
export function buildIndividualSetPointOption(
    series: IndividualSeries,
    stats: IndividualStats,
    sp: IndividualHealthSetPoints | null,
    unit: string,
    scopes: TimeScopes | null = null,
) {
    const [l1, u1] = stats.boundary_1sd;
    const hLines: HLine[] = sdReferenceLines(stats);
    if (sp && finite(sp.upper)) hLines.push({ y: sp.upper, color: CHART.danger, width: SET_POINT_WIDTH, label: `H ${typedText(sp.upper)}`, inside: 'top' });
    if (sp && finite(sp.lower)) hLines.push({ y: sp.lower, color: CHART.danger, width: SET_POINT_WIDTH, label: `L ${typedText(sp.lower)}`, inside: 'bottom' });
    return {
        ...buildTimeSeriesOption({
            timestamps: series.timestamps,
            scopes,
            yName: unit || undefined,
            lines: [{ name: 'Value', values: series.value, color: CHART.series }],
            bands: [{ from: l1, to: u1, color: CHART.okFill }],
            hLines,
        }),
        ...SYNC,
    };
}

// ---------------------------------------------------------------------------
// Set-point chart - Relationship
// ---------------------------------------------------------------------------

/** The hourly residual over time ONLY, with ±2RMSE, a zero line and the four 80 / 0 lines
 *  (lower and upper) the user has entered so far — each labelled with its score
 *  and its value as typed ("80 · +5" above an upper line, "0 · −9" below a
 *  lower one). */
export function buildRelationshipSetPointOption(
    series: RelationshipSeries,
    twoRmse: number,
    sp: RelationshipHealthSetPoints | null,
    unit: string,
    scopes: TimeScopes | null = null,
) {
    const hLines: HLine[] = rmseReferenceLines(twoRmse);
    if (sp) {
        const point = (y: number, score: 80 | 0, side: 'top' | 'bottom'): HLine =>
            ({ y, color: score === 80 ? CHART.warn : CHART.danger, width: SET_POINT_WIDTH, label: `${score} · ${signedTypedText(y)}`, inside: side });
        if (finite(sp.residualAt80Upper)) hLines.push(point(sp.residualAt80Upper, 80, 'top'));
        if (finite(sp.residualAt80Lower)) hLines.push(point(sp.residualAt80Lower, 80, 'bottom'));
        if (finite(sp.residualAt0Upper)) hLines.push(point(sp.residualAt0Upper, 0, 'top'));
        if (finite(sp.residualAt0Lower)) hLines.push(point(sp.residualAt0Lower, 0, 'bottom'));
    }
    return {
        ...buildTimeSeriesOption({
            timestamps: series.timestamps,
            scopes,
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

/**
 * Scatter of the (bounded) hourly points — one (mean x, mean y) per clock hour —
 * with the 1x, 3x and N x SD ring of EVERY cluster. Points come from `hourly`
 * (not the raw `cluster_scatter`) so a hovered point is exactly one entry of the
 * score series: they are coloured by score once the
 * set points are valid, by cluster before. The N x ring appears when N is a
 * number (any number; Rust judges it): it is the user's own set point, so it is
 * the strongest ring — solid red. Each ring LEVEL is named once, at the right
 * edge of the ring that reaches furthest right ("1× · 100", "3× · 80",
 * "5× · 0" with N as typed). `names` are the axis titles (description + unit).
 */
export function buildClusterSetPointOption(
    series: ClusteringSeries,
    clusters: ClusterStat[],
    sp: ClusteringHealthSetPoints | null,
    names: ClusterChartNames,
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

    // The axes hold the points AND every ring drawn, the N ring included.
    const axes = clusterAxes(names, clusterExtent(series.x, series.y, clusters, outer !== null ? [1, 3, outer] : [1, 3]));

    const rings = clusters.flatMap(c => {
        const r = [
            ellipseSeries(c, 1, { name: `Cluster ${c.cluster_id} 1× SD`, stroke: CHART.ok }),
            ellipseSeries(c, 3, { name: `Cluster ${c.cluster_id} 3× SD`, stroke: CHART.warn, dashed: true }),
        ];
        // The user's N: the strongest ring (solid, like L / H and the residual points).
        if (outer !== null) r.push(ellipseSeries(c, outer, { name: `Cluster ${c.cluster_id} ${outer}× SD`, stroke: CHART.danger, lineWidth: 1.8 }));
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
    const centres = centreLabelSeries(clusters, colorOfCluster);
    const ringLabels = ringLabelSeries(clusters, [
        { sigma: 1, text: '1× · 100', color: CHART.ok },
        { sigma: 3, text: '3× · 80', color: CHART.warn },
        ...(outer !== null ? [{ sigma: outer, text: `${typedText(outer)}× · 0`, color: CHART.danger }] : []),
    ]);
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
        ...axes,
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
            ringLabels,
            ...hover,
        ],
    };
}

// ---------------------------------------------------------------------------
// Score chart
// ---------------------------------------------------------------------------

/** Health score (0-100) over time: a dashed line at 80, the line coloured by the
 *  score band (green 80-100, amber 40-80, red below 40), gaps where an hour has no
 *  score (`null`, never 0). `timestamps` are the hour starts of `hourly`. */
export function buildScoreOption(timestamps: string[], score: (number | null)[], scopes: TimeScopes | null = null) {
    const base = buildTimeSeriesOption({
        timestamps,
        scopes,
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
        // The score axis prints whole numbers (0, 20 … 100), whatever the shared value-axis
        // formatter would do with a 0-100 range.
        yAxis: { ...base.yAxis, interval: 20, axisLabel: { ...base.yAxis.axisLabel, formatter: fmtScoreAxisValue } },
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
        tooltip: { ...base.tooltip, textStyle: { color: CHART.textPrimary, fontFamily: CHART_MONO, fontSize: 11 }, valueFormatter: (v: unknown) => (typeof v === 'number' ? String(Math.round(v)) : String(v ?? '')) },
    };
}
