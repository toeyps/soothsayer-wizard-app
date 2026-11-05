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

/** Default (non-cluster) colour, the app's indigo accent; WebGL cells and SVG histograms derive from this one hex. */
export const ACCENT_HEX = '#6366f1';

/** `#rrggbb` + alpha → a CSS `rgba(...)` string, for backgrounds that need
 *  a translucency the plain hex can't express. */
export function hexToRgbaCss(hex: string, a: number): string {
    const [r, g, b] = hexToRgba(hex);
    return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;
}

/** Red -> amber -> green for the correlation heatmap (weak = red, strong = green, regardless of sign). */
const CORRELATION_GRADIENT_STOPS: [string, string, string] = ['#ef4444', '#f59e0b', '#10b981'];

/** Interpolates the gradient at t (0..1, fed |r|); amber in the middle avoids the muddy olive of a straight red-to-green lerp. */
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

/** Pure black, not `--bg-primary`: every cell type must use this exact value or padding strips and 1 px gaps differ in shade. */
export const CANVAS_BG_HEX = '#000000';

export const CANVAS_BG: [number, number, number, number] = hexToRgba(CANVAS_BG_HEX);

/** Colours auto-assigned to new highlights and tagged points; here so LineChart doesn't import regl-scatterplot. */
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

/** Numbered badges for tagged points, one per `RANGE_PALETTE` entry. */
export const TAG_BADGES = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧'];

/** One tag per palette colour: more would reuse a colour/number already on the chart, which reads as a bug. */
export const MAX_TAGGED_POINTS = RANGE_PALETTE.length;
