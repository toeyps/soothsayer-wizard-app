/**
 * Text measurement for the long-sensor-name rules (DESIGN_SYSTEM §4 "Long sensor names"). Fit is measured
 * in the font actually rendered, never counted in characters: mono for a tag printed as the name, the UI
 * font for a description. Everything that measures takes a `MeasureText` so tests can inject widths
 * (jsdom has no layout and no canvas).
 */
export type MeasureText = (text: string, font: string) => number;

let ctx: CanvasRenderingContext2D | null = null;
let ctxTried = false;

function fallbackWidth(text: string, font: string): number {
    const size = /(\d+(?:\.\d+)?)px/.exec(font);
    return text.length * (size ? parseFloat(size[1]) : 11) * 0.55;
}

/** Width in px of `text` in a CSS `font` shorthand. An estimate when there is no canvas. */
export const textWidth: MeasureText = (text, font) => {
    if (!ctxTried) {
        ctxTried = true;
        try { ctx = document.createElement('canvas').getContext('2d'); } catch { ctx = null; }
    }
    if (!ctx) return fallbackWidth(text, font);
    ctx.font = font;
    return ctx.measureText(text).width;
};

/** The CSS `font` shorthand an element renders in. */
export function fontOf(el: Element): string {
    const cs = getComputedStyle(el);
    return `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
}

const DEFAULT_UI_FAMILY = 'Inter, system-ui, sans-serif';
const DEFAULT_MONO_FAMILY = 'Consolas, monospace';

/** The app's UI font family (from `body`). */
export function uiFontFamily(): string {
    try { return getComputedStyle(document.body).fontFamily || DEFAULT_UI_FAMILY; } catch { return DEFAULT_UI_FAMILY; }
}

/** The app's mono font family (the `--mono` token), used for a tag printed as the name. */
export function monoFontFamily(): string {
    try {
        return getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || DEFAULT_MONO_FAMILY;
    } catch { return DEFAULT_MONO_FAMILY; }
}
