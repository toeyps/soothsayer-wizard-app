/** Hex `#rrggbb` → `[r, g, b, a]` in 0..1 space (alpha defaults to 1). */
export function hexToRgba(hex: string, a = 1): [number, number, number, number] {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    return [r, g, b, a];
}

/** Reverse of `hexToRgba` for the `<input type="color">` value attribute. */
export function rgbaToHex(c: [number, number, number, number]): string {
    const r = Math.round(c[0] * 255).toString(16).padStart(2, '0');
    const g = Math.round(c[1] * 255).toString(16).padStart(2, '0');
    const b = Math.round(c[2] * 255).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`;
}

/** Single source of truth for the matrix's default (non-cluster) colour —
 *  the app's indigo accent (matches LINE_CHART_COLORS, App.css, etc). Both
 *  the WebGL scatter cells (PairPlotCell) and the SVG diagonal histograms
 *  (PairPlotChart) derive from this one hex value so they never drift apart
 *  (previously each hardcoded its own close-but-different blue). */
export const ACCENT_HEX = '#6366f1';

/** `#rrggbb` + alpha → a CSS `rgba(...)` string, for backgrounds that need
 *  a translucency the plain hex can't express. */
export function hexToRgbaCss(hex: string, a: number): string {
    const [r, g, b] = hexToRgba(hex);
    return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;
}

/** Red → amber → green — same hues as LINE_CHART_COLORS' rose/amber/emerald
 *  stops, reused here for the correlation heatmap's diverging-by-magnitude
 *  scale (weak = red, strong = green, regardless of sign). */
const CORRELATION_GRADIENT_STOPS: [string, string, string] = ['#ef4444', '#f59e0b', '#10b981'];

/** Interpolates the red→amber→green gradient at `t` (0..1, meant to be fed
 *  `|r|` for a correlation coefficient). Three stops rather than a plain
 *  2-colour lerp — red straight to green through RGB space passes through a
 *  muddy olive/brown at the midpoint; routing through amber keeps every step
 *  of the gradient looking like a deliberate colour, not an accident. */
export function correlationGradientHex(t: number): string {
    const clamped = Math.max(0, Math.min(1, t));
    const [lo, mid, hi] = CORRELATION_GRADIENT_STOPS;
    const [from, to] = clamped < 0.5 ? [lo, mid] : [mid, hi];
    const localT = clamped < 0.5 ? clamped / 0.5 : (clamped - 0.5) / 0.5;
    const [r1, g1, b1] = hexToRgba(from);
    const [r2, g2, b2] = hexToRgba(to);
    const r = Math.round((r1 + (r2 - r1) * localT) * 255);
    const g = Math.round((g1 + (g2 - g1) * localT) * 255);
    const b = Math.round((b1 + (b2 - b1) * localT) * 255);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/** Cell background — pure black, deliberately NOT `--bg-primary`
 *  (`#0a0a0b`). Every cell type (WebGL canvas clear colour, the
 *  histogram's own div, and the plain scatter cell's non-canvas margin
 *  area) must render this exact value or the grid shows visibly different
 *  shades in the padding strips and the 1px gaps between cells. */
export const CANVAS_BG_HEX = '#000000';

export const CANVAS_BG: [number, number, number, number] = hexToRgba(CANVAS_BG_HEX);

/** Distinct colours auto-assigned to new time highlights / tagged points —
 *  shared across ScatterChart (time highlights, re-exported from there for
 *  callers that already import it from that module) and LineChart (Tag
 *  Point) for visual consistency across the app's range/lasso/tag-based
 *  colouring features. Cycles if more items are added than colours. Lives
 *  here (not in ScatterChart.tsx) specifically so LineChart.tsx doesn't
 *  have to import ScatterChart.tsx just for this array — that would pull
 *  regl-scatterplot's whole module graph into the Line chart's dependency
 *  chain for a plain colour list. */
export const RANGE_PALETTE: Array<[number, number, number, number]> = [
    [0.99, 0.75, 0.18, 1.0],  // amber
    [0.20, 0.83, 0.60, 1.0],  // emerald
    [0.86, 0.40, 0.97, 1.0],  // fuchsia
    [0.99, 0.45, 0.45, 1.0],  // rose
    [0.40, 0.85, 0.99, 1.0],  // sky
    [0.99, 0.55, 0.27, 1.0],  // orange
    [0.65, 0.85, 0.40, 1.0],  // lime
    [0.78, 0.66, 0.99, 1.0],  // violet
];

/** Numbered badges for tagged points (Line and Scatter's Tag Point
 *  feature) — one per `RANGE_PALETTE` entry, so a chart never runs out of
 *  distinct number+colour pairs before it runs out of tag slots. */
export const TAG_BADGES = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧'];

/** One tag per palette colour, then stop — past this a new tag would have
 *  to reuse a colour/number already on the chart, which reads as a bug
 *  ("did tag ① move?") rather than a new tag. */
export const MAX_TAGGED_POINTS = RANGE_PALETTE.length;
