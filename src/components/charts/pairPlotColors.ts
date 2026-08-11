import type { ThemeMode } from '../../hooks/useThemeMode';

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

/** Cell background — pure black/white, deliberately NOT `--bg-primary`
 *  (`#0a0a0b` in dark mode). Every cell type (WebGL canvas clear colour,
 *  the histogram's own div, and the plain scatter cell's non-canvas margin
 *  area) must render this exact value or the grid shows visibly different
 *  shades in the padding strips and the 1px gaps between cells. */
export const CANVAS_BG_HEX: Record<ThemeMode, string> = {
    dark: '#000000',
    light: '#ffffff',
};

export const CANVAS_BG: Record<ThemeMode, [number, number, number, number]> = {
    dark: hexToRgba(CANVAS_BG_HEX.dark),
    light: hexToRgba(CANVAS_BG_HEX.light),
};
