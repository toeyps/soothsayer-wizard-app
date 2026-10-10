import type {
    ClusterStat,
    HealthClusterScatter,
    HealthFitScatter,
    HealthHistogram,
    IndividualSeries,
    IndividualStats,
    RelationshipSeries,
    ValidationResult,
} from '../../../types/health';
import { testNumberFor } from '../../../utils/timePeriods';
import type { SensorInfo } from '../../sensor/sensorInfo';
import { parseLocal } from '../periodDisplay';
import { CHART, CHART_MONO, CLUSTER_COLORS, FONT, axisValueFormatter, fmtAxisValue, fmtNum } from './chartTheme';

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
 *
 * How a Workbench chart reads (workbench-redesign SPEC §3, DESIGN_SYSTEM §4
 * "Time scopes on charts" / "Quiet charts"):
 *   - train / scoring periods are NAMED in a thin strip above the plot (plain
 *     coloured mono text, two lanes) and are only a faint fill inside it;
 *   - reference lines (±1SD, ±3SD, ±2RMSE, 80) are labelled OUTSIDE the plot on
 *     its right edge; a line that names itself (`TimeLine.endLabel`) or is
 *     labelled this way needs no legend row under the chart;
 *   - only the score-100 band is filled; ±3SD is a dashed line;
 *   - the user's own set points are the strongest lines (`HLine.inside`).
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
    // Never cut off at the card's edge, and a number reads like everywhere else on the page.
    confine: true,
    valueFormatter: (v: unknown) => (typeof v === 'number' ? fmtNum(v) : String(v ?? '')),
};

const axisCommon = {
    axisLabel: { color: CHART.textSecondary, fontSize: 10 },
    axisLine: { lineStyle: { color: CHART.gridLine } },
    axisTick: { show: false },
};
/** `axisCommon` for a VALUE axis: tick labels through the app's number formatter, so a
 *  computed min/max never shows float noise ("1,713.8000000000002" on the Distribution chart). */
/** Axis line of a scatter's value axis: on the plot's EDGE. ECharts' default draws it
 *  through the other axis' zero, which reads as a stray x = 0 / y = 0 line across the
 *  points whenever the data straddles zero. */
export const EDGE_AXIS_LINE = { ...axisCommon.axisLine, onZero: false };
export const valueAxisCommon = {
    ...axisCommon,
    axisLabel: { ...axisCommon.axisLabel, formatter: fmtAxisValue },
};
/** `valueAxisCommon` for a value axis whose min/max the chart sets: label decimals follow the
 *  tick step, so a narrow axis keeps distinct labels and a long bin edge reads short. */
export function fixedValueAxisCommon(min: number, max: number) {
    return { ...axisCommon, axisLabel: { ...axisCommon.axisLabel, formatter: axisValueFormatter(min, max) } };
}

export interface TimeLine {
    name: string;
    /** One value per timestamp; `null` = a gap. */
    values: (number | null)[];
    color: string;
    width?: number;
    /** The line names itself at its right end, outside the plot ("Actual",
     *  "Predicted") — the chart then needs no legend row. */
    endLabel?: string;
}

export interface HLine {
    y: number;
    color: string;
    dashed?: boolean;
    /** Short label of the line. A reference line (±1SD, ±3SD, ±2RMSE, 80) is
     *  labelled OUTSIDE the plot, on its right edge. */
    label?: string;
    /** Line width; a reference line is 1 px. */
    width?: number;
    /** One of the USER'S set points: the label goes INSIDE the plot at the right
     *  end, above (`'top'`) or below (`'bottom'`) the line, in bold. */
    inside?: 'top' | 'bottom';
    /** A reference line of a +/− pair: its outside label sits just above
     *  (`'above'`, the + side) or below (`'below'`, the − side) the line's end
     *  instead of centred on it, so "+2RMSE" and "−2RMSE" never print on top of
     *  each other when the two lines are only a few pixels apart (a wide Y range). */
    edge?: 'above' | 'below';
}

export interface HBand {
    from: number;
    to: number;
    /** Fill colour (use an rgba with low alpha). */
    color: string;
}

// ---------------------------------------------------------------------------
// Train / scoring time scopes (2026-10-07; "just score it" 2026-10-10: a
// scoring period is only start → end — no Known-problem hatch, no EVENT line)
// ---------------------------------------------------------------------------

/** One scope band on a time chart. `start`/`end` `null` = open (runs to the
 *  edge of the data). */
export interface TimeScope {
    /** `'score'` = a scoring period (the magenta band). */
    kind: 'train' | 'score';
    start: string | null;
    end: string | null;
    /** Its name in the strip above the plot: "TRAIN", "TRAIN P2", "S1". */
    label: string;
    /** Shorter name for half-width charts: "P2", "S1". */
    short: string;
}

/** What every Workbench time chart draws on top of its data (SPEC "Screens and
 *  UI" → time scopes). Built from `HealthPreview.test_validation` by `scopesOf`
 *  and passed in explicitly through `TimeSeriesSpec.scopes`. */
export interface TimeScopes {
    ranges: TimeScope[];
    /** Use the short names (half-width charts). */
    compact?: boolean;
}

/**
 * The scopes of one health preview: every train range (none sent = the train
 * period is open at both ends, i.e. the whole time axis) and every scoring
 * period with its S-number. `null` when the preview carried no scoring
 * periods: the chart is then drawn exactly as before.
 *
 * S-numbers are the period's POSITION in the user's full list (invalid periods
 * included — they are not sent): `numbers` is `testPeriodsWirePlan(...).numbers`
 * of the list that was sent, looked up with each result's 1-based wire `index`
 * (`testNumberFor`). Without `numbers` the result's position is used (S1, S2 …).
 */
export function scopesOf(v: ValidationResult | null | undefined, numbers?: readonly number[] | null): TimeScopes | null {
    if (!v) return null;
    const tn = (t: ValidationResult['tests'][number], i: number) => testNumberFor(numbers, t.index, i);
    const train = v.train_ranges.length > 0 ? v.train_ranges : [{ start: null, end: null }];
    const many = train.length > 1;
    const ranges: TimeScope[] = [
        ...train.map((r, i) => ({
            kind: 'train' as const,
            start: r.start,
            end: r.end,
            label: many ? `TRAIN P${i + 1}` : 'TRAIN',
            short: many ? `P${i + 1}` : 'TRAIN',
        })),
        ...v.tests.map((t, i) => ({
            kind: 'score' as const,
            start: t.start,
            end: t.end,
            label: `S${tn(t, i)}`,
            short: `S${tn(t, i)}`,
        })),
    ];
    return { ranges };
}

/** The same scopes with the short names (half-width charts). */
export function compactScopes(s: TimeScopes | null | undefined): TimeScopes | null {
    return s ? { ...s, compact: true } : null;
}

/** Height of the strip above the plot that names the scopes: two text lanes,
 *  train on the upper one and scoring periods on the lower one. */
export const SCOPE_STRIP = 26;
/** Distance of a scope name from the top of the plot, per lane. */
export const SCOPE_LANE = { train: 15, score: 3 } as const;
/** Room right of the plot for the reference-line labels ("+2RMSE"). */
export const REF_LABEL_GUTTER = 52;
/** The same for a line that names itself at its end ("Predicted" is longer). */
export const END_LABEL_GUTTER = 64;

const scopeMs = (s: string | null | undefined): number | null => parseLocal(s);

/** The union of every scope range, merged, as sorted [start, end] intervals
 *  (open ends = ±Infinity). A point outside all of them is "outside every
 *  period". */
export function scopeIslands(scopes: TimeScopes): [number, number][] {
    const ivs: [number, number][] = [];
    for (const r of scopes.ranges) {
        const a = r.start ? scopeMs(r.start) : -Infinity;
        const b = r.end ? scopeMs(r.end) : Infinity;
        if (a === null || b === null || b < a) continue;
        ivs.push([a, b]);
    }
    ivs.sort((x, y) => x[0] - y[0]);
    const out: [number, number][] = [];
    for (const iv of ivs) {
        const last = out[out.length - 1];
        if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
        else out.push([iv[0], iv[1]]);
    }
    return out;
}

/** `[ms, value]` pairs with a `null` inserted wherever the line would cross
 *  time outside every period (between two islands, or into / out of
 *  unscored time), so the chart shows a gap there instead of a bridge. */
export function withScopeGaps(points: [number, number | null][], islands: [number, number][]): [number, number | null][] {
    const islandOf = (x: number) => islands.findIndex(([a, b]) => x >= a && x <= b);
    const out: [number, number | null][] = [];
    let prev = -2;
    for (let k = 0; k < points.length; k++) {
        const isl = islandOf(points[k][0]);
        if (k > 0 && (isl < 0 || prev < 0 || isl !== prev)) {
            out.push([(points[k - 1][0] + points[k][0]) / 2, null]);
        }
        out.push(points[k]);
        prev = isl;
    }
    return out;
}

/** The carrier series of the scope bands (no data of its own, drawn under the
 *  data). Each band carries its NAME in the strip above the plot — plain
 *  coloured text, never a pill and never inside the plot. */
function scopeSeries(scopes: TimeScopes, xMin: number, xMax: number): Record<string, unknown> {
    const name = { fontSize: 9, fontWeight: 600, fontFamily: CHART_MONO, padding: 0 };
    const area = scopes.ranges.flatMap(r => {
        const a = Math.max(xMin, r.start ? (scopeMs(r.start) ?? xMin) : xMin);
        const b = Math.min(xMax, r.end ? (scopeMs(r.end) ?? xMax) : xMax);
        if (!(b >= a)) return [];
        const train = r.kind === 'train';
        const line = train ? CHART.train : CHART.test;
        return [[
            {
                name: r.label,
                xAxis: a,
                // Train and scoring may overlap: train = a faint blue fill, scoring = a
                // faint magenta fill + dashed outline, so a scoring period over train
                // stays readable.
                itemStyle: train
                    ? { color: CHART.trainFill, borderWidth: 0 }
                    : { color: CHART.testFill, borderColor: CHART.testOutline, borderWidth: 1, borderType: 'dashed' },
                // Two text lanes in the strip ABOVE the plot: train names on the upper
                // lane, scoring names on the lower one (so S1 over TRAIN never collide).
                label: { ...name, show: true, color: line, position: 'top', distance: train ? SCOPE_LANE.train : SCOPE_LANE.score, formatter: scopes.compact ? r.short : r.label },
            },
            { xAxis: b },
        ]];
    });
    return {
        type: 'line',
        name: '__scopes',
        data: [],
        silent: true,
        z: 0,
        symbol: 'none',
        tooltip: { show: false },
        markArea: { silent: true, animation: false, data: area },
    };
}

export interface TimeSeriesSpec {
    timestamps: string[];
    lines: TimeLine[];
    hLines?: HLine[];
    bands?: HBand[];
    yName?: string;
    /** Fixed Y range (the Health score chart is always 0-100); overrides the
     *  data-driven one. */
    yRange?: [number, number];
    /** Train / scoring scope bands (`scopesOf`). Absent / null = no scopes (the
     *  chart is drawn as before). Only drawn on a time axis. */
    scopes?: TimeScopes | null;
}

/** Value(s) over time with horizontal reference lines and shaded bands. The
 *  Y range always includes every `hLine` / `band`, so a ±3SD line outside the
 *  data is still on screen. With `scopes`, the train / scoring periods are
 *  faint bands named in the strip above the plot, and time outside every period
 *  is a gap in the line. Reference-line labels sit outside the plot on its right
 *  edge (the grid keeps a gutter for them), set-point labels inside it. */
export function buildTimeSeriesOption(spec: TimeSeriesSpec) {
    const { timestamps, lines, hLines = [], bands = [], yName } = spec;
    const ms = parseTimestamps(timestamps);
    const scopes = ms && ms.length > 0 && spec.scopes ? spec.scopes : null;
    const islands = scopes ? scopeIslands(scopes) : null;
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
    const [yMin, yMax] = spec.yRange ?? niceExtent(lo - pad, hi + pad);

    const series: Record<string, unknown>[] = lines.map((l, i) => {
        const pairs = ms ? l.values.map((v, k) => [ms[k], v] as [number, number | null]) : null;
        const data = pairs ? (islands ? withScopeGaps(pairs, islands) : pairs) : l.values;
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
        if (l.endLabel) {
            base.endLabel = { show: true, formatter: l.endLabel, color: l.color, fontSize: 9.5, distance: 4, fontFamily: CHART_MONO };
            // Two lines that end at nearly the same value: their names move apart.
            base.labelLayout = { moveOverlap: 'shiftY' };
        }
        if (i === 0) {
            if (hLines.length) {
                base.markLine = {
                    silent: true,
                    symbol: 'none',
                    animation: false,
                    data: hLines.map(h => ({
                        yAxis: h.y,
                        lineStyle: { color: h.color, width: h.width ?? 1, type: h.dashed ? 'dashed' : 'solid' },
                        label: h.label
                            ? h.inside
                                // A set point of the user: inside the plot, at the right end.
                                ? { show: true, formatter: h.label, position: h.inside === 'top' ? 'insideEndTop' : 'insideEndBottom', distance: 3, color: h.color, fontSize: 10, fontWeight: 600, fontFamily: CHART_MONO }
                                // A reference line: outside the plot, on its right edge.
                                : { show: true, formatter: h.label, position: 'end', distance: 4, color: h.color, fontSize: 9.5, fontWeight: 'normal', fontFamily: CHART_MONO, verticalAlign: h.edge === 'above' ? 'bottom' : h.edge === 'below' ? 'top' : 'middle' }
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
    if (scopes && ms && series.length > 0) {
        // Its own (empty) carrier series, so the scope bands sit under the data and
        // never mix with the Y bands / reference lines of the first series.
        series.push(scopeSeries(scopes, ms[0], ms[ms.length - 1]));
    }

    // Room right of the plot for what is labelled there.
    const right = lines.some(l => l.endLabel)
        ? END_LABEL_GUTTER
        : hLines.some(h => h.label && !h.inside) ? REF_LABEL_GUTTER : 18;

    return {
        backgroundColor: 'transparent',
        textStyle: { fontFamily: FONT },
        animation: false,
        tooltip: { ...tooltipBase, trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: 'rgba(255,255,255,.35)', type: 'dashed' } } },
        legend: { show: false },
        grid: { left: 58, right, top: scopes ? 10 + SCOPE_STRIP : 14, bottom: 28, containLabel: false },
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
            ...fixedValueAxisCommon(yMin, yMax),
            splitLine: { show: true, lineStyle: { color: CHART.splitLine } },
        },
        series,
    };
}

// ---------------------------------------------------------------------------
// Individual
// ---------------------------------------------------------------------------

/** "Sensor value over time" with the ±1SD band (green — the only fill, the
 *  score-100 band) and the ±3SD lines (amber, dashed, no fill). */
export function buildValueOverTimeOption(series: IndividualSeries, stats: IndividualStats, unit: string, scopes: TimeScopes | null = null) {
    const [l1, u1] = stats.boundary_1sd;
    return buildTimeSeriesOption({
        timestamps: series.timestamps,
        scopes,
        yName: unit || undefined,
        lines: [{ name: 'Value', values: series.value, color: CHART.series }],
        bands: [{ from: l1, to: u1, color: CHART.okFill }],
        hLines: sdReferenceLines(stats),
    });
}

/** Individual's four reference lines on a value-over-time chart: ±1SD solid green
 *  (the edges of the score-100 band), ±3SD dashed amber (score 80, no fill). */
export function sdReferenceLines(stats: IndividualStats): HLine[] {
    const [l1, u1] = stats.boundary_1sd;
    const [l3, u3] = stats.boundary_3sd;
    return [
        { y: u1, color: CHART.ok, label: '+1SD', edge: 'above' },
        { y: l1, color: CHART.ok, label: '−1SD', edge: 'below' },
        { y: u3, color: CHART.warn, label: '+3SD', dashed: true, edge: 'above' },
        { y: l3, color: CHART.warn, label: '−3SD', dashed: true, edge: 'below' },
    ];
}

/** Relationship's reference lines on a residual chart: ±2RMSE (the edges of the
 *  score-100 band) and an unlabelled zero line. */
export function rmseReferenceLines(twoRmse: number): HLine[] {
    return [
        { y: twoRmse, color: CHART.ok, label: '+2RMSE', edge: 'above' },
        { y: -twoRmse, color: CHART.ok, label: '−2RMSE', edge: 'below' },
        { y: 0, color: 'rgba(255,255,255,0.25)' },
    ];
}

export interface VLine { x: number; color: string; label?: string; dashed?: boolean }

/** Histogram (bars = rows per bin) with the fitted normal curve and vertical
 *  reference lines (±1SD / ±3SD for Individual). `h.curve` is already in rows
 *  per bin, so it sits on the same Y axis as the bars. Both axes end on round
 *  ticks — never a raw extreme such as a bin edge 36.1987 or a count 942.7 —
 *  and the X axis always holds every reference line. */
export function buildDistributionOption(h: HealthHistogram, vLines: VLine[], unit?: string) {
    const bars = h.counts.map((c, i) => [h.bin_edges[i], h.bin_edges[i + 1], c]);
    const curve = h.curve.map((c, i) => [(h.bin_edges[i] + h.bin_edges[i + 1]) / 2, c]);
    const xs = [h.bin_edges[0], h.bin_edges[h.bin_edges.length - 1], ...vLines.map(l => l.x)].filter(Number.isFinite);
    const [xMin, xMax] = niceExtent(Math.min(...xs), Math.max(...xs));
    // 10 % headroom, rounded up to a nice tick so the top label is a round count (it was a raw
    // max × 1.1 — "1,713.8000000000002" on screen, 2026-10-09).
    const yMax = niceExtent(0, Math.max(...h.counts, ...h.curve, 1) * 1.1)[1];
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
            ...fixedValueAxisCommon(xMin, xMax),
            splitLine: { show: false },
        },
        yAxis: {
            type: 'value',
            min: 0,
            max: yMax,
            ...fixedValueAxisCommon(0, yMax),
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
                                ? { show: true, formatter: v.label, position: 'insideEndTop', color: v.color, fontSize: 10, fontFamily: CHART_MONO }
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
        xAxis: { type: 'value', name: fit.x_sensor, nameLocation: 'middle', nameGap: 24, nameTextStyle: { color: CHART.textSecondary, fontSize: 10 }, scale: true, ...valueAxisCommon, axisLine: EDGE_AXIS_LINE, splitLine: { show: false } },
        yAxis: { type: 'value', name: yName, nameLocation: 'middle', nameGap: 44, nameTextStyle: { color: CHART.textSecondary, fontSize: 10 }, scale: true, ...valueAxisCommon, axisLine: EDGE_AXIS_LINE, splitLine: { show: true, lineStyle: { color: CHART.splitLine } } },
        series: [
            { ...common, name: 'Actual', data: actual, itemStyle: { color: CHART.actual, opacity: 0.45 } },
            { ...common, name: 'Relation model', data: predicted, itemStyle: { color: CHART.predicted, opacity: 0.6 } },
        ],
    };
}

/** "Target vs predicted" over time. Each line names itself at its right end
 *  ("Actual", "Predicted"), so the card has no legend row. */
export function buildTargetVsPredictedOption(series: RelationshipSeries, unit: string, scopes: TimeScopes | null = null) {
    return buildTimeSeriesOption({
        timestamps: series.timestamps,
        scopes,
        yName: unit || undefined,
        lines: [
            { name: 'Actual', values: series.actual, color: CHART.actual, endLabel: 'Actual' },
            { name: 'Predicted', values: series.predicted, color: CHART.predicted, endLabel: 'Predicted' },
        ],
    });
}

/** "Residual over time" (actual − predicted) with the ±2RMSE band (green) and
 *  a zero line. No set-point lines here — those belong to the Health score page. */
export function buildResidualOption(series: RelationshipSeries, twoRmse: number, unit: string, scopes: TimeScopes | null = null) {
    return buildTimeSeriesOption({
        timestamps: series.timestamps,
        scopes,
        yName: unit || undefined,
        lines: [{ name: 'Residual', values: series.residual, color: CHART.series }],
        bands: [{ from: -twoRmse, to: twoRmse, color: CHART.okFill }],
        hLines: rmseReferenceLines(twoRmse),
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

/** Title of a scatter axis: the sensor's description and unit ("GENERATOR ACTIVE
 *  POWER · MW"), or the tag when it has no description. The tag itself is in the
 *  card's subtitle, so the axis is not a second place that repeats it. */
export function sensorAxisTitle(info: Pick<SensorInfo, 'tag' | 'description' | 'unit'>): string {
    return [info.description || info.tag, info.unit].filter(Boolean).join(' · ');
}

type RingShape = Pick<ClusterStat, 'x_center' | 'y_center' | 'x_sd' | 'y_sd' | 'angle_deg'>;
type RingCluster = RingShape & Pick<ClusterStat, 'cluster_id'>;

/** Half-width / half-height of the box around the ellipse `sigma` × SD of a
 *  cluster (rotated by its angle) — so a ring that lies outside the data is
 *  still inside the axes. */
export function ringBox(c: RingShape, sigma: number) {
    const rx = c.x_sd * sigma;
    const ry = c.y_sd * sigma;
    const a = (c.angle_deg * Math.PI) / 180;
    const hx = Math.hypot(rx * Math.cos(a), ry * Math.sin(a));
    const hy = Math.hypot(rx * Math.sin(a), ry * Math.cos(a));
    return { x: [c.x_center - hx, c.x_center + hx] as [number, number], y: [c.y_center - hy, c.y_center + hy] as [number, number] };
}

/** The right-most point of a cluster's `sigma` ring (a rotated ellipse). */
export function ringRightPoint(c: RingShape, sigma: number): [number, number] {
    const rx = c.x_sd * sigma;
    const ry = c.y_sd * sigma;
    const a = (c.angle_deg * Math.PI) / 180;
    const th = Math.atan2(-ry * Math.sin(a), rx * Math.cos(a));
    return [
        c.x_center + rx * Math.cos(th) * Math.cos(a) - ry * Math.sin(th) * Math.sin(a),
        c.y_center + rx * Math.cos(th) * Math.sin(a) + ry * Math.sin(th) * Math.cos(a),
    ];
}

export interface RingLevel { sigma: number; text: string; color: string }

/** Height of one ring-label line (9.5 px text + its chip padding + air). */
export const RING_LABEL_LINE = 13;

/** Every ring LEVEL is named once — at the right edge of the ring that reaches
 *  furthest right ("1× · 100", "3× · 80", "5× · 0") — instead of once per
 *  cluster or in a legend row under the chart. */
export function ringLabelSeries(clusters: RingShape[], levels: RingLevel[]) {
    // The rings of one cluster reach furthest right at (nearly) the same height, and on a wide
    // axis only a few pixels apart — so the level names are staggered one text line each around
    // that height (first level up, last level down) and can never print on top of each other.
    const mid = (levels.length - 1) / 2;
    const data = levels.flatMap((l, i) => {
        let best: [number, number] | null = null;
        for (const c of clusters) {
            const p = ringRightPoint(c, l.sigma);
            if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
            if (!best || p[0] > best[0]) best = p;
        }
        return best ? [{ name: l.text, value: best, label: { formatter: l.text, color: l.color, offset: [0, (i - mid) * RING_LABEL_LINE] } }] : [];
    });
    return {
        type: 'scatter' as const,
        name: 'Ring labels',
        data,
        symbolSize: 0,
        silent: true,
        z: 5,
        label: { show: true, position: 'right' as const, distance: 4, fontSize: 9.5, fontFamily: CHART_MONO, backgroundColor: CHART.labelChipBg, padding: [1, 3], borderRadius: 3 },
        tooltip: { show: false },
    };
}

/** "Cluster N" at each centre, in the cluster's own colour, on a dark chip so it
 *  reads over dense points. */
export function centreLabelSeries(clusters: RingCluster[], colorOf: (id: number) => string) {
    return {
        type: 'scatter' as const,
        name: 'Centres',
        data: clusters.map(c => ({ value: [c.x_center, c.y_center], label: { color: colorOf(c.cluster_id) } })),
        symbolSize: 5,
        silent: true,
        itemStyle: { color: CHART.textPrimary },
        label: {
            show: true,
            position: 'top' as const,
            fontSize: 10.5,
            fontWeight: 600,
            backgroundColor: CHART.labelChipBg,
            padding: [1, 4],
            borderRadius: 3,
            formatter: (p: { dataIndex: number }) => `Cluster ${clusters[p.dataIndex]?.cluster_id ?? ''}`,
        },
        z: 4,
    };
}

/** Share of the X span kept free right of the furthest ring, for the ring labels. */
const RING_LABEL_ROOM = 0.1;

/** Axis extents of a Clusters chart: the points AND every ring drawn (a ring is
 *  never cut by the plot's edge), rounded out to nice ticks, with room on the
 *  right for the ring labels. */
export function clusterExtent(xs: readonly number[], ys: readonly number[], clusters: RingShape[], sigmas: readonly number[]) {
    let xLo = Infinity; let xHi = -Infinity; let yLo = Infinity; let yHi = -Infinity;
    const n = Math.min(xs.length, ys.length);
    for (let i = 0; i < n; i++) {
        const x = xs[i];
        const y = ys[i];
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (x < xLo) xLo = x;
        if (x > xHi) xHi = x;
        if (y < yLo) yLo = y;
        if (y > yHi) yHi = y;
    }
    for (const c of clusters) {
        for (const sg of sigmas) {
            const b = ringBox(c, sg);
            if (![...b.x, ...b.y].every(Number.isFinite)) continue;
            xLo = Math.min(xLo, b.x[0]); xHi = Math.max(xHi, b.x[1]);
            yLo = Math.min(yLo, b.y[0]); yHi = Math.max(yHi, b.y[1]);
        }
    }
    const ext = (lo: number, hi: number, room = 0): [number, number] =>
        Number.isFinite(lo) && Number.isFinite(hi) ? niceExtent(lo - (hi - lo) * 0.03, hi + (hi - lo) * (0.03 + room)) : [0, 1];
    return { x: ext(xLo, xHi, RING_LABEL_ROOM), y: ext(yLo, yHi) };
}

/** The two value axes of a Clusters chart (Model fit and Health score draw the
 *  same ones): fixed to `clusterExtent`, the axis lines on the plot's edge. */
export function clusterAxes(names: ClusterChartNames, ex: { x: [number, number]; y: [number, number] }) {
    const title = { nameLocation: 'middle' as const, nameTextStyle: { color: CHART.textSecondary, fontSize: 10 } };
    const axis = (min: number, max: number) => {
        const common = fixedValueAxisCommon(min, max);
        return { type: 'value' as const, min, max, ...title, ...common, axisLabel: { ...common.axisLabel, hideOverlap: true }, axisLine: EDGE_AXIS_LINE };
    };
    return {
        xAxis: { ...axis(ex.x[0], ex.x[1]), name: names.x, nameGap: 24, splitLine: { show: false } },
        yAxis: { ...axis(ex.y[0], ex.y[1]), name: names.y, nameGap: 44, splitLine: { show: true, lineStyle: { color: CHART.splitLine } } },
    };
}

/** Cluster scatter (points coloured by cluster) with the 1× (green, solid) and
 *  3× (amber, dashed) SD ellipse of every cluster, a "Cluster N" label at each
 *  centre and each ring level named once at the right edge. `names` are the
 *  axis titles (description + unit; the tag is in the card's subtitle). */
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
    const centres = centreLabelSeries(clusters, colorOf);
    const ringLabels = ringLabelSeries(clusters, [
        { sigma: 1, text: '1× SD', color: CHART.ok },
        { sigma: 3, text: '3× SD', color: CHART.warn },
    ]);
    const axes = clusterAxes(names, clusterExtent(scatter.x, scatter.y, clusters, [1, 3]));
    return {
        backgroundColor: 'transparent',
        textStyle: { fontFamily: FONT },
        animation: false,
        tooltip: { ...tooltipBase, trigger: 'item' },
        legend: { show: false },
        grid: { left: 58, right: 18, top: 14, bottom: 40, containLabel: false },
        dataZoom: [{ type: 'inside', xAxisIndex: 0, filterMode: 'none' }, { type: 'inside', yAxisIndex: 0, filterMode: 'none' }],
        ...axes,
        series: [...pointSeries, ...rings, centres, ringLabels],
    };
}
