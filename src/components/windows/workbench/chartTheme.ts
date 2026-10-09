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
    warnFill: 'rgba(229, 169, 61, 0.07)',
    /** Score 0 line (set points) — used by the Health score page. */
    danger: '#ee5a45',
    dangerFill: 'rgba(238, 90, 69, 0.12)',
    /** Relationship: actual (blue) vs predicted (red). */
    actual: '#6f9ee8',
    predicted: '#ee5a45',
    /** Histogram bars. */
    bar: 'rgba(120, 160, 230, 0.55)',
    normalCurve: '#e8e8ee',
    /** Train / Test scopes on every Workbench time chart (DESIGN_SYSTEM §4
     *  "Train / Test periods"): train = the accent blue (`--train`), test =
     *  magenta oklch(.74 .16 340) (`--test`), as the canvas draws them. */
    train: '#5b95f0',
    trainFill: 'rgba(77, 140, 240, 0.10)',
    test: '#e866c4',
    testFill: 'rgba(232, 102, 196, 0.11)',
    /** Dark pill behind the scope / EVENT labels. */
    scopePillBg: 'rgba(10, 10, 11, 0.82)',
} as const;

/** Same palette as PredictiveModelBuild.tsx's `CLUSTER_PALETTE` (cluster 1, 2, ...). */
export const CLUSTER_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#f43f5e', '#14b8a6', '#ec4899', '#6366f1'] as const;

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

/** Number formatting used by every workbench readout (matches the mockup's `fmt`). */
export function fmtNum(v: number | null | undefined): string {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    // No "-0.000": anything that rounds to zero at 3 decimals is plain 0.
    if (Math.abs(v) < 0.0005) v = 0;
    const a = Math.abs(v);
    if (a >= 1000) return Math.round(v).toLocaleString();
    if (a >= 100) return v.toFixed(1);
    if (a >= 1) return v.toFixed(2);
    return v.toFixed(3);
}
