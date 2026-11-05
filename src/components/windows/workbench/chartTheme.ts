/* ECharts canvas cannot read CSS variables, so these are literal App.css token values (oklch approximated in hex). */
import { fmtNum as fmtNumApp, fmtNumExact } from '../../sensor/sensorInfo';

export const CHART = {
    textPrimary: '#ededef',
    textSecondary: '#8c8c94',
    textFaint: '#5b5b63',
    gridLine: '#2a2a30',
    /** Faint horizontal grid. */
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
    /** Train = accent blue, scoring = magenta (`--test`); names are coloured text above the plot, inside only a faint fill. */
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

/** Blues and violets only: green/amber/red mean score 100/80/0 and magenta is the scoring-period colour. */
export const CLUSTER_COLORS = ['#3b82f6', '#a78bfa', '#38bdf8', '#818cf8', '#c084fc', '#60a5fa', '#a5b4fc', '#7dd3fc'] as const;

export const FONT = 'Inter, system-ui, sans-serif';

/* Value-axis tick labels: drop float noise but stay distinct on narrow axes. Not for time or category axes. */
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

/** Decimals follow the tick step (span/5) plus one, so neighbouring ticks never print the same text. */
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

/** Health score ticks: whole numbers only; sensor-value and residual axes keep `axisValueFormatter`/`fmtAxisValue`. */
export function fmtScoreAxisValue(v: number): string {
    if (!Number.isFinite(v)) return '';
    return String(Math.round(v) || 0); // `|| 0`: -0 reads "0"
}

/** Computed values use the app's one `fmtNum`; no value shows '—' and negative zero reads '0'. */
export function fmtNum(v: number | null | undefined): string {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    return fmtNumApp(v === 0 ? 0 : v);
}

/* User-typed numbers: `fmtNumExact` keeps every decimal; float noise (33.333333333333336) goes through `fmtNum`. */
/** Decimals in a number's shortest JS form ("33.6" → 1); scientific counts as "long". */
export const shortDecimals = (v: number): number => {
    const s = String(v);
    return /e/i.test(s) ? Infinity : (s.split('.')[1]?.length ?? 0);
};
/** Up to this many decimals a boundary reads as typed and is shown in full; more is float noise. */
export const TYPED_DECIMALS_MAX = 10;
export function fmtClusterBound(v: number): string {
    const x = v === 0 ? 0 : v; // a negative zero reads "0", never "-0"
    return shortDecimals(x) <= TYPED_DECIMALS_MAX ? fmtNumExact(x) : fmtNumApp(x);
}
