import type {
    ClusterStat,
    HealthClusterScatter,
    HealthFitScatter,
    HealthHistogram,
    IndividualSeries,
    IndividualStats,
    RelationshipSeries,
} from '../../../types/health';
import { CHART, CLUSTER_COLORS, FONT } from './chartTheme';

/*
 * Pure ECharts option builders for the Build Model Workbench's health charts
 * (health score phase 3b-1, 2026-10-04). Every function takes ONLY the bounded
 * payload `compute_health_preview` returns (`HealthPreview.series` / `.stats` /
 * `.histogram` / `.fit_scatter` / `.cluster_scatter`) — never a full row array —
 * and returns a plain option object, so they are unit-testable without ECharts.
 *
 * The generic building blocks (`buildTimeSeriesOption`, `ellipseSeries`) are
 * exported so the Health score page (3b-2) can draw the same charts with the
 * extra set-point lines / score colouring on top instead of re-implementing
 * the axes: pass more `hLines`, more `bands`, or append to `series`.
 */

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** Epoch ms of every timestamp, or `null` if ANY of them does not parse (the
 *  chart then falls back to a category axis showing the raw text). The server
 *  already normalised the text (Buddhist-Era years are Gregorian by now). */
export function parseTimestamps(ts: string[]): number[] | null {
    const out = new Array<number>(ts.length);
    for (let i = 0; i < ts.length; i++) {
        const t = new Date(ts[i]).getTime();
        if (!Number.isFinite(t)) return null;
        out[i] = t;
    }
    return out;
}

/** Rounds a value range out to "nice" axis ends (1, 2, 5 x 10^n steps), so the
 *  axis never starts at 62.884400945773835. */
export function niceExtent(lo: number, hi: number): [number, number] {
    const span = hi - lo;
    if (!(span > 0) || !Number.isFinite(span)) return [lo, hi];
    const raw = span / 5;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / mag;
    const step = (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * mag;
    return [Math.floor(lo / step) * step, Math.ceil(hi / step) * step];
}

const tooltipBase = {
    backgroundColor: CHART.tooltipBg,
    borderColor: CHART.tooltipBorder,
    textStyle: { color: CHART.textPrimary },
};

const axisCommon = {
    axisLabel: { color: CHART.textSecondary, fontSize: 10 },
    axisLine: { lineStyle: { color: CHART.gridLine } },
    axisTick: { show: false },
};

export interface TimeLine {
    name: string;
    /** One value per timestamp; `null` = a gap. */
    values: (number | null)[];
    color: string;
    width?: number;
}

export interface HLine {
    y: number;
    color: string;
    dashed?: boolean;
    /** Short label drawn at the right end of the line. */
    label?: string;
}

export interface HBand {
    from: number;
    to: number;
    /** Fill colour (use an rgba with low alpha). */
    color: string;
}

export interface TimeSeriesSpec {
    timestamps: string[];
    lines: TimeLine[];
    hLines?: HLine[];
    bands?: HBand[];
    yName?: string;
}

/** Value(s) over time with horizontal reference lines and shaded bands. The
 *  Y range always includes every `hLine` / `band`, so a ±3SD line outside the
 *  data is still on screen. */
export function buildTimeSeriesOption(spec: TimeSeriesSpec) {
    const { timestamps, lines, hLines = [], bands = [], yName } = spec;
    const ms = parseTimestamps(timestamps);
    let lo = Infinity;
    let hi = -Infinity;
    const take = (v: number | null | undefined) => {
        if (typeof v === 'number' && Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    };
    for (const l of lines) for (const v of l.values) take(v);
    for (const h of hLines) take(h.y);
    for (const b of bands) { take(b.from); take(b.to); }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1; }
    const pad = (hi - lo) * 0.06 || Math.abs(hi) * 0.05 || 1;
    const [yMin, yMax] = niceExtent(lo - pad, hi + pad);

    const series = lines.map((l, i) => {
        const data = ms
            ? l.values.map((v, k) => [ms[k], v] as [number, number | null])
            : l.values;
        const base: Record<string, unknown> = {
            type: 'line',
            name: l.name,
            data,
            showSymbol: false,
            symbol: 'none',
            lineStyle: { color: l.color, width: l.width ?? 1 },
            itemStyle: { color: l.color },
            z: 2,
        };
        if (i === 0) {
            if (hLines.length) {
                base.markLine = {
                    silent: true,
                    symbol: 'none',
                    animation: false,
                    data: hLines.map(h => ({
                        yAxis: h.y,
                        lineStyle: { color: h.color, width: 1.5, type: h.dashed ? 'dashed' : 'solid' },
                        label: h.label
                            ? { show: true, formatter: h.label, position: 'insideEndTop', color: h.color, fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }
                            : { show: false },
                    })),
                };
            }
            if (bands.length) {
                base.markArea = {
                    silent: true,
                    animation: false,
                    data: bands.map(b => [{ yAxis: b.from, itemStyle: { color: b.color } }, { yAxis: b.to }]),
                };
            }
        }
        return base;
    });

    return {
        backgroundColor: 'transparent',
        textStyle: { fontFamily: FONT },
        animation: false,
        tooltip: { ...tooltipBase, trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: 'rgba(255,255,255,.35)', type: 'dashed' } } },
        legend: { show: false },
        grid: { left: 58, right: 18, top: 14, bottom: 28, containLabel: false },
        dataZoom: [{ type: 'inside', xAxisIndex: 0, filterMode: 'none' }],
        xAxis: ms
            ? { type: 'time', ...axisCommon, splitLine: { show: false } }
            : { type: 'category', data: timestamps, boundaryGap: false, ...axisCommon, axisLabel: { ...axisCommon.axisLabel, hideOverlap: true }, splitLine: { show: false } },
        yAxis: {
            type: 'value',
            name: yName,
            nameLocation: 'middle',
            nameGap: 44,
            nameTextStyle: { color: CHART.textSecondary, fontSize: 10 },
            min: yMin,
            max: yMax,
            ...axisCommon,
            splitLine: { show: true, lineStyle: { color: CHART.splitLine } },
        },
        series,
    };
}

// ---------------------------------------------------------------------------
// Individual
// ---------------------------------------------------------------------------

/** "Sensor value over time" with ±1SD (green) and ±3SD (amber) lines + zones. */
export function buildValueOverTimeOption(series: IndividualSeries, stats: IndividualStats, unit: string) {
    const [l1, u1] = stats.boundary_1sd;
    const [l3, u3] = stats.boundary_3sd;
    return buildTimeSeriesOption({
        timestamps: series.timestamps,
        yName: unit || undefined,
        lines: [{ name: 'Value', values: series.value, color: CHART.series }],
        bands: [
            { from: l3, to: u3, color: CHART.warnFill },
            { from: l1, to: u1, color: CHART.okFill },
        ],
        hLines: [
            { y: u1, color: CHART.ok, label: '+1SD' },
            { y: l1, color: CHART.ok, label: '−1SD' },
            { y: u3, color: CHART.warn, label: '+3SD' },
            { y: l3, color: CHART.warn, label: '−3SD' },
        ],
    });
}

export interface VLine { x: number; color: string; label?: string; dashed?: boolean }

/** Histogram (bars = rows per bin) with the fitted normal curve and vertical
 *  reference lines (±1SD / ±3SD for Individual). `h.curve` is already in rows
 *  per bin, so it sits on the same Y axis as the bars. */
export function buildDistributionOption(h: HealthHistogram, vLines: VLine[], unit?: string) {
    const bars = h.counts.map((c, i) => [h.bin_edges[i], h.bin_edges[i + 1], c]);
    const curve = h.curve.map((c, i) => [(h.bin_edges[i] + h.bin_edges[i + 1]) / 2, c]);
    const xMin = h.bin_edges[0];
    const xMax = h.bin_edges[h.bin_edges.length - 1];
    const yMax = Math.max(...h.counts, ...h.curve, 1) * 1.1;
    return {
        backgroundColor: 'transparent',
        textStyle: { fontFamily: FONT },
        animation: false,
        tooltip: { ...tooltipBase, trigger: 'item' },
        legend: { show: false },
        grid: { left: 52, right: 18, top: 14, bottom: 32, containLabel: false },
        xAxis: {
            type: 'value',
            min: xMin,
            max: xMax,
            name: unit || undefined,
            nameLocation: 'middle',
            nameGap: 22,
            nameTextStyle: { color: CHART.textSecondary, fontSize: 10 },
            scale: true,
            ...axisCommon,
            splitLine: { show: false },
        },
        yAxis: {
            type: 'value',
            min: 0,
            max: yMax,
            ...axisCommon,
            splitLine: { show: true, lineStyle: { color: CHART.splitLine } },
        },
        series: [
            {
                type: 'custom',
                name: 'Rows',
                data: bars,
                encode: { x: [0, 1], y: 2 },
                itemStyle: { color: CHART.bar },
                renderItem: (_params: unknown, api: any) => {
                    const left = api.coord([api.value(0), 0]);
                    const right = api.coord([api.value(1), 0]);
                    const top = api.coord([0, api.value(2)]);
                    return {
                        type: 'rect',
                        shape: { x: left[0], y: top[1], width: Math.max(right[0] - left[0] - 1, 1), height: left[1] - top[1] },
                        style: api.style(),
                    };
                },
                z: 1,
            },
            {
                type: 'line',
                name: 'Normal curve',
                data: curve,
                showSymbol: false,
                smooth: true,
                lineStyle: { color: CHART.normalCurve, width: 1.5 },
                itemStyle: { color: CHART.normalCurve },
                z: 3,
                markLine: vLines.length
                    ? {
                        silent: true,
                        symbol: 'none',
                        animation: false,
                        data: vLines.map(v => ({
                            xAxis: v.x,
                            lineStyle: { color: v.color, width: 1.2, type: v.dashed === false ? 'solid' : 'dashed' },
                            label: v.label
                                ? { show: true, formatter: v.label, position: 'insideEndTop', color: v.color, fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }
                                : { show: false },
                        })),
                    }
                    : undefined,
            },
        ],
    };
}

/** Individual's ±1SD / ±3SD vertical lines for the Distribution chart. */
export function individualVLines(stats: IndividualStats): VLine[] {
    return [
        { x: stats.boundary_1sd[0], color: CHART.ok, label: '−1SD' },
        { x: stats.boundary_1sd[1], color: CHART.ok, label: '+1SD' },
        { x: stats.boundary_3sd[0], color: CHART.warn, label: '−3SD' },
        { x: stats.boundary_3sd[1], color: CHART.warn, label: '+3SD' },
    ];
}

/** Approximate rows outside ±3SD, estimated from the histogram (the series is
 *  downsampled, so it cannot be counted from there; `stats` has no such field).
 *  Bins fully outside count whole, the bin an edge falls in counts in
 *  proportion. `null` when there is no histogram. */
export function estimateRowsOutside3sd(h: HealthHistogram | null, stats: IndividualStats): number | null {
    if (!h || h.counts.length === 0) return null;
    const [lo, hi] = stats.boundary_3sd;
    let n = 0;
    for (let i = 0; i < h.counts.length; i++) {
        const a = h.bin_edges[i];
        const b = h.bin_edges[i + 1];
        const w = b - a;
        if (!(w > 0)) continue;
        const outside = Math.max(0, Math.min(b, lo) - a) + Math.max(0, b - Math.max(a, hi));
        n += h.counts[i] * Math.min(1, outside / w);
    }
    return Math.round(n);
}

// ---------------------------------------------------------------------------
// Relationship
// ---------------------------------------------------------------------------

/** "Fit": predictor (X) against the target — actual (blue) vs the Relation
 *  model's prediction (red). */
export function buildFitScatterOption(fit: HealthFitScatter, yName: string) {
    const actual: [number, number][] = [];
    const predicted: [number, number][] = [];
    const n = Math.min(fit.x.length, fit.actual.length);
    for (let i = 0; i < n; i++) {
        const x = fit.x[i];
        if (!Number.isFinite(x)) continue;
        const a = fit.actual[i];
        if (Number.isFinite(a)) actual.push([x, a]);
        const p = fit.predicted[i];
        if (typeof p === 'number' && Number.isFinite(p)) predicted.push([x, p]);
    }
    const big = actual.length + predicted.length > 6000;
    const common = { type: 'scatter' as const, symbolSize: big ? 2.5 : 4, large: big, largeThreshold: 2000, silent: false };
    return {
        backgroundColor: 'transparent',
        textStyle: { fontFamily: FONT },
        animation: false,
        tooltip: { ...tooltipBase, trigger: 'item' },
        legend: { show: false },
        grid: { left: 58, right: 18, top: 14, bottom: 40, containLabel: false },
        dataZoom: [{ type: 'inside', xAxisIndex: 0, filterMode: 'none' }, { type: 'inside', yAxisIndex: 0, filterMode: 'none' }],
        xAxis: { type: 'value', name: fit.x_sensor, nameLocation: 'middle', nameGap: 24, nameTextStyle: { color: CHART.textSecondary, fontSize: 10 }, scale: true, ...axisCommon, splitLine: { show: false } },
        yAxis: { type: 'value', name: yName, nameLocation: 'middle', nameGap: 44, nameTextStyle: { color: CHART.textSecondary, fontSize: 10 }, scale: true, ...axisCommon, splitLine: { show: true, lineStyle: { color: CHART.splitLine } } },
        series: [
            { ...common, name: 'Actual', data: actual, itemStyle: { color: CHART.actual, opacity: 0.45 } },
            { ...common, name: 'Relation model', data: predicted, itemStyle: { color: CHART.predicted, opacity: 0.6 } },
        ],
    };
}

/** "Target vs predicted" over time. */
export function buildTargetVsPredictedOption(series: RelationshipSeries, unit: string) {
    return buildTimeSeriesOption({
        timestamps: series.timestamps,
        yName: unit || undefined,
        lines: [
            { name: 'Actual', values: series.actual, color: CHART.actual },
            { name: 'Predicted', values: series.predicted, color: CHART.predicted },
        ],
    });
}

/** "Residual over time" (actual − predicted) with the ±2RMSE band (green) and
 *  a zero line. No set-point lines here — those belong to the Health score page. */
export function buildResidualOption(series: RelationshipSeries, twoRmse: number, unit: string) {
    return buildTimeSeriesOption({
        timestamps: series.timestamps,
        yName: unit || undefined,
        lines: [{ name: 'Residual', values: series.residual, color: CHART.series }],
        bands: [{ from: -twoRmse, to: twoRmse, color: CHART.okFill }],
        hLines: [
            { y: twoRmse, color: CHART.ok, label: '+2RMSE' },
            { y: -twoRmse, color: CHART.ok, label: '−2RMSE' },
            { y: 0, color: 'rgba(255,255,255,0.25)' },
        ],
    });
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

/** One σ-ellipse of a cluster as an ECharts `custom` series. `sigma` is the
 *  multiple of the cluster's own SD (1×, 3×, and N× on the Health score page);
 *  `x_sd` is the major axis, rotated by `angle_deg` — the same convention Rust
 *  scores against. */
export function ellipseSeries(
    c: Pick<ClusterStat, 'x_center' | 'y_center' | 'x_sd' | 'y_sd' | 'angle_deg'>,
    sigma: number,
    o: { name: string; stroke: string; dashed?: boolean; lineWidth?: number; z?: number },
) {
    const rx = c.x_sd * sigma;
    const ry = c.y_sd * sigma;
    const rad = (c.angle_deg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return {
        type: 'custom' as const,
        name: o.name,
        data: [[c.x_center, c.y_center]],
        z: o.z ?? 3,
        silent: true,
        itemStyle: { color: o.stroke },
        renderItem: (params: any, api: any) => {
            const pts: number[][] = [];
            for (let th = 0; th < 2 * Math.PI; th += Math.PI / 36) {
                const x = rx * Math.cos(th);
                const y = ry * Math.sin(th);
                pts.push(api.coord([c.x_center + x * cos - y * sin, c.y_center + x * sin + y * cos]));
            }
            return {
                type: 'polygon',
                shape: { points: pts },
                style: { fill: 'none', stroke: o.stroke, lineWidth: o.lineWidth ?? 1.6, lineDash: o.dashed ? [6, 4] : [0, 0] },
                clipPath: { type: 'rect', shape: { x: params.coordSys.x, y: params.coordSys.y, width: params.coordSys.width, height: params.coordSys.height } },
            };
        },
    };
}

export interface ClusterChartNames { x: string; y: string }

/** Cluster scatter (points coloured by cluster) with the 1× (green, solid) and
 *  3× (amber, dashed) SD ellipse of every cluster and a "Cluster N" label at
 *  each centre. */
export function buildClusterOption(scatter: HealthClusterScatter, clusters: ClusterStat[], names: ClusterChartNames) {
    const byCluster = new Map<number | null, [number, number][]>();
    const n = Math.min(scatter.x.length, scatter.y.length);
    for (let i = 0; i < n; i++) {
        const x = scatter.x[i];
        const y = scatter.y[i];
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const k = scatter.cluster[i] ?? null;
        if (!byCluster.has(k)) byCluster.set(k, []);
        byCluster.get(k)!.push([x, y]);
    }
    const big = n > 6000;
    const colorOf = (id: number) => CLUSTER_COLORS[(id - 1 + CLUSTER_COLORS.length) % CLUSTER_COLORS.length];
    const pointSeries = [...byCluster.entries()].map(([id, data]) => ({
        type: 'scatter' as const,
        name: id === null ? 'No cluster' : `Cluster ${id}`,
        data,
        symbolSize: big ? 2.5 : 4,
        large: big,
        largeThreshold: 2000,
        itemStyle: { color: id === null ? 'rgba(180,190,210,0.35)' : colorOf(id), opacity: 0.5 },
        z: 1,
    }));
    const rings = clusters.flatMap(c => [
        ellipseSeries(c, 1, { name: `Cluster ${c.cluster_id} 1× SD`, stroke: CHART.ok }),
        ellipseSeries(c, 3, { name: `Cluster ${c.cluster_id} 3× SD`, stroke: CHART.warn, dashed: true }),
    ]);
    const centres = {
        type: 'scatter' as const,
        name: 'Centres',
        data: clusters.map(c => [c.x_center, c.y_center]),
        symbolSize: 5,
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
        tooltip: { ...tooltipBase, trigger: 'item' },
        legend: { show: false },
        grid: { left: 58, right: 18, top: 14, bottom: 40, containLabel: false },
        dataZoom: [{ type: 'inside', xAxisIndex: 0, filterMode: 'none' }, { type: 'inside', yAxisIndex: 0, filterMode: 'none' }],
        xAxis: { type: 'value', name: names.x, nameLocation: 'middle', nameGap: 24, nameTextStyle: { color: CHART.textSecondary, fontSize: 10 }, scale: true, ...axisCommon, splitLine: { show: false } },
        yAxis: { type: 'value', name: names.y, nameLocation: 'middle', nameGap: 44, nameTextStyle: { color: CHART.textSecondary, fontSize: 10 }, scale: true, ...axisCommon, splitLine: { show: true, lineStyle: { color: CHART.splitLine } } },
        series: [...pointSeries, ...rings, centres],
    };
}
