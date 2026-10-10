/*
 * Shared look of the Build Model Workbench charts (health score phase 3b-1).
 *
 * ECharts renders to canvas and cannot read CSS custom properties, so these are
 * the literal values of the matching tokens in `src/App.css` (`--text-secondary`,
 * `--text-faint`, `--border`, `--ok`, `--warn`, `--danger` ...) — the same
 * convention LineChart.tsx uses. oklch() is NOT used here on purpose: ECharts'
 * own colour parser (gradients, opacity) is not guaranteed to understand it, so
 * the app's oklch tokens are approximated by the hex colours the approved
 * mockup's canvas ended up drawing.
 *
 * Both the Model fit page (3b-1) and the Health score page (3b-2) draw from
 * this file, so a band/line means the same colour on both.
 */
import { fmtNum as fmtNumApp, fmtNumExact } from '../../sensor/sensorInfo';

export const CHART = {
    textPrimary: '#ededef',
    textSecondary: '#8c8c94',
    textFaint: '#5b5b63',
    gridLine: '#2a2a30',
    /** Faint horizontal grid (matches the mockup's rgba(255,255,255,.05)). */
    splitLine: 'rgba(255, 255, 255, 0.06)',
    tooltipBg: 'rgba(23, 23, 28, 0.92)',
    tooltipBorder: 'rgba(255, 255, 255, 0.12)',
    /** The plotted series (raw value / actual / residual). */
    series: 'rgba(180, 190, 210, 0.75)',
    /** Score 100 band / ±1SD / ±2RMSE / 1× SD ring. */
    ok: '#10b981',
    okFill: 'rgba(16, 185, 129, 0.10)',
    /** Score 80 line / ±3SD / 3× SD ring. */
    warn: '#e5a93d',
    /** Score 0 line (set points) — used by the Health score page. */
    danger: '#ee5a45',
    /** Relationship: actual (blue) vs predicted (red). */
    actual: '#6f9ee8',
    predicted: '#ee5a45',
    /** Histogram bars. */
    bar: 'rgba(120, 160, 230, 0.55)',
    normalCurve: '#e8e8ee',
    /** Train / scoring scopes on every Workbench time chart (DESIGN_SYSTEM §4
     *  "Time scopes on charts"): train = the accent blue (`--train`), scoring =
     *  magenta oklch(.74 .16 340) (`--test` — the token keeps its name), as the
     *  canvas draws them. The names are plain coloured text in the strip above the
     *  plot; inside the plot a scope is only a faint fill (train 6 %, scoring 5 %
     *  with a dashed outline), so the data line stays readable. */
    train: '#5b95f0',
    trainFill: 'rgba(77, 140, 240, 0.06)',
    test: '#e866c4',
    testFill: 'rgba(232, 102, 196, 0.05)',
    testOutline: 'rgba(232, 102, 196, 0.45)',
    /** Dark chip behind a label that sits on top of dense points (cluster names, ring levels). */
    labelChipBg: 'rgba(10, 10, 11, 0.72)',
} as const;

/** Mono face of every label drawn ON a chart (scope names, reference lines, set points, rings). */
export const CHART_MONO = 'JetBrains Mono, Consolas, monospace';

/**
 * Cluster 1, 2, … (the Clusters charts and the cluster-range slider in Model settings).
 * Blues and violets ONLY: green, amber and red mean score 100 / 80 / 0 on these charts (the
 * 1× / 3× / N× rings and the score-coloured points), so a cluster is never drawn in one of
 * them (workbench-redesign SPEC §3). Magenta is left out too — it is the scoring-period colour.
 * Slot 7 is a light indigo, not the mockup's slate: that slate is the pre-refresh axis grey the
 * app removed from every chart (VisualRefreshFinalSweep keeps it out of these files).
 */
export const CLUSTER_COLORS = ['#3b82f6', '#a78bfa', '#38bdf8', '#818cf8', '#c084fc', '#60a5fa', '#a5b4fc', '#7dd3fc'] as const;

export const FONT = 'Inter, system-ui, sans-serif';

/*
 * Tick labels of VALUE axes (2026-10-09). A computed axis min/max (a histogram's max × 1.1, a
 * nice-extent step like 0.1 × 3) used to print float noise such as "1,713.8000000000002".
 * The labels must also stay DISTINCT however narrow the axis is, so they are never rounded to a
 * fixed 3 decimals (0.0012 / 0.0014 would both read "0.001"). Never use these on a time or
 * category axis.
 */
const groupedNumber = (v: number, maxDecimals: number): string =>
    new Intl.NumberFormat('en-US', { maximumFractionDigits: Math.max(0, Math.min(20, maxDecimals)) }).format(v);
/** Drops float noise only (12 significant digits); `|| 0` turns -0 into 0. */
const denoise = (v: number): number => Number(v.toPrecision(12)) || 0;

/** An auto-scaled value axis (ECharts picks the ticks): noise trimmed, thousands grouped,
 *  every real decimal kept. */
export function fmtAxisValue(v: number): string {
    if (!Number.isFinite(v)) return '';
    return groupedNumber(denoise(v), 20);
}

/** A value axis whose min/max the chart sets: decimals follow the tick step (about a fifth of
 *  the span) plus one spare, so neighbouring ticks never print the same text and a long bin
 *  edge reads short ("12.3", not "12.345678912"). */
export function axisValueFormatter(min: number, max: number): (v: number) => string {
    const span = Math.abs(max - min);
    if (!(span > 0) || !Number.isFinite(span)) return fmtAxisValue;
    const step = span / 5;
    const decimals = Math.max(0, -Math.floor(Math.log10(step))) + 1;
    return (v: number) => {
        if (!Number.isFinite(v)) return '';
        // A tick that is zero up to float noise reads "0", never "-0" or "0.00000000000000006".
        const x = Math.abs(v) < step * 1e-9 ? 0 : denoise(v);
        return groupedNumber(x, decimals);
    };
}

/** Tick labels of a 0-100 HEALTH SCORE axis: whole numbers only ("0", "20" … "100"), never
 *  "0.000" / "20.00". A score is a 0-100 mark, not a measured value, so it carries no decimals.
 *  Only for an axis whose values are the score — sensor-value / residual axes keep
 *  `axisValueFormatter` / `fmtAxisValue`. */
export function fmtScoreAxisValue(v: number): string {
    if (!Number.isFinite(v)) return '';
    return String(Math.round(v) || 0); // `|| 0`: -0 reads "0"
}

/**
 * A COMPUTED value on a Workbench page (statistics, read-outs, chart tooltips): the app's ONE
 * number formatter (`fmtNum` of the sensor module — up to 3 decimals, thousands separators, and
 * a non-zero value never reads as 0: 0.0002 is "0.0002", not "0.000"). This is not a second
 * formatter, only the Workbench's two edges around it: no value is the em dash the Workbench
 * uses everywhere ("—"), and a negative zero reads "0".
 */
export function fmtNum(v: number | null | undefined): string {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    return fmtNumApp(v === 0 ? 0 : v);
}

/**
 * `fmtNum` for a COMPUTED value in a table COLUMN that must line up on the decimal point (the
 * train / scoring metrics table, the automatic rows of the set-points table): always 3 decimals
 * ("5.000", "0.910") — the app formatter's own `fixed3` form (DESIGN_SYSTEM §4 "Numbers"), so a
 * non-zero value still never reads as 0 ("0.000120"). Never for a value the user typed (that one
 * stays exactly as typed, `fmtNumExact`), and not for a number standing alone in a sentence.
 */
export function fmtNumCol(v: number | null | undefined): string {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    return fmtNumApp(v === 0 ? 0 : v, true);
}

/*
 * A stored number that the USER typed (a cluster range boundary, a set point), for display.
 * `fmtNumExact` keeps every decimal of its shortest form — never padded ("4.6", not "4.60"),
 * never rounded ("4.61234" stays). A boundary that is float noise from auto-dividing or
 * dragging (33.333333333333336) is not something anyone typed and reads through `fmtNum`.
 */
/** Decimals in a number's shortest JS form ("33.6" → 1); scientific counts as "long". */
export const shortDecimals = (v: number): number => {
    const s = String(v);
    return /e/i.test(s) ? Infinity : (s.split('.')[1]?.length ?? 0);
};
/** Up to this many decimals a stored cluster boundary reads as a value someone TYPED and is
 *  shown in full; more is float noise from auto-dividing or dragging (33.333333333333336). */
export const TYPED_DECIMALS_MAX = 10;
/** A cluster boundary for display (2026-10-09): every decimal of a typed-looking value
 *  (`fmtNumExact`, never rounded), the app's `fmtNum` for a computed one. */
export function fmtClusterBound(v: number): string {
    const x = v === 0 ? 0 : v; // a negative zero reads "0", never "-0"
    return shortDecimals(x) <= TYPED_DECIMALS_MAX ? fmtNumExact(x) : fmtNumApp(x);
}
