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
} as const;

/** Same palette as PredictiveModelBuild.tsx's `CLUSTER_PALETTE` (cluster 1, 2, ...). */
export const CLUSTER_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#f43f5e', '#14b8a6', '#ec4899', '#6366f1'] as const;

export const FONT = 'Inter, system-ui, sans-serif';

/** Number formatting used by every workbench readout (matches the mockup's `fmt`). */
export function fmtNum(v: number | null | undefined): string {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1000) return Math.round(v).toLocaleString();
    if (a >= 100) return v.toFixed(1);
    if (a >= 1) return v.toFixed(2);
    return v.toFixed(3);
}
