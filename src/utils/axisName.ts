/**
 * Chart axis titles for long sensor names (DESIGN_SYSTEM §4 rule 1, SPEC FINAL addition 3): "description · unit",
 * measured against the room the title really has. A title that fits prints as is.
 */
import { NAME_HEAD_MIN, displayedName, splitName, type NamedSensor } from './sensorNames';
import { textWidth, type MeasureText } from './textMeasure';

export interface AxisNamed extends NamedSensor {
    unit?: string;
}

const AXIS_FONT_FAMILY = 'Inter, system-ui, sans-serif';
export const DEFAULT_AXIS_FONT = `10px ${AXIS_FONT_FAMILY}`;

const SEP_END = /\s*[-–—·|/]\s*$/;
const SEP_FIRST = /^[-–—·|/](\s|$)/;

const unitSuffix = (info: AxisNamed): string => (info.unit ? ` · ${info.unit}` : '');
/** Word boundaries of a name: spaces, or for a name with no spaces (a bare tag) after `_ . -`. */
const boundaryRe = (name: string): RegExp => (/\s/.test(name) ? /\s+/g : /[_.-]+/g);

/** "… end + unit" in as many whole end words as fit (the unit never leaves the last word); only a last word
 *  that alone does not fit is cut from its start. */
function keepEnd(text: string, unit: string, maxPx: number, font: string, measure: MeasureText): string {
    const candidates = [0];
    for (const m of text.matchAll(boundaryRe(text))) {
        const pos = (m.index ?? 0) + m[0].length;
        if (pos > 0 && pos < text.length && !SEP_FIRST.test(text.slice(pos))) candidates.push(pos);
    }
    for (const pos of candidates) {
        const out = `… ${text.slice(pos)}${unit}`;
        if (measure(out, font) <= maxPx) return out;
    }
    const all = text + unit;
    let k = candidates[candidates.length - 1];
    while (k < all.length - 4 && measure(`… ${all.slice(k)}`, font) > maxPx) k++;
    return `… ${all.slice(k)}`;
}

function endCut(desc: string, unit: string, maxPx: number, font: string, measure: MeasureText): string {
    let k = desc.length;
    while (k > 1 && measure(`${desc.slice(0, k).trimEnd()}…${unit}`, font) > maxPx) k--;
    // End at the last whole word; a first word that alone does not fit is cut mid-word.
    if (k < desc.length && /\S/.test(desc[k])) {
        const space = desc.lastIndexOf(' ', k);
        if (space > 0) k = space;
    }
    return `${desc.slice(0, k).trimEnd()}…${unit}`;
}

/** Rule 1 on one line: whole when it fits; otherwise head + "… " + tail + unit. The head ends at a whole word;
 *  under 8 characters it is dropped. A name with no tail to keep end-cuts (the unit stays). */
export function fitAxisName(info: AxisNamed, maxPx: number, font = DEFAULT_AXIS_FONT, measure: MeasureText = textWidth): string {
    const desc = displayedName(info);
    const unit = unitSuffix(info);
    if (!(maxPx > 0) || measure(desc + unit, font) <= maxPx) return desc + unit;
    const sp = splitName(desc);
    if (!sp.head) return endCut(desc, unit, maxPx, font, measure);
    const tail = sp.tail.trimStart();
    const head = sp.head.replace(SEP_END, '');
    let lo = 0;
    let hi = head.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (measure(`${head.slice(0, mid).trimEnd()}… ${tail}${unit}`, font) <= maxPx) lo = mid; else hi = mid - 1;
    }
    let cut = lo;
    if (lo < head.length && /\S/.test(head[lo])) {
        const space = head.lastIndexOf(' ', lo);
        if (space > 0) cut = space;
    }
    const kept = head.slice(0, cut).trimEnd().replace(SEP_END, '');
    if (kept.length >= NAME_HEAD_MIN) return `${kept}… ${tail}${unit}`;
    return keepEnd(tail, unit, maxPx, font, measure);
}

export interface WrappedAxisName {
    lines: string[];
    /** True when text was left out; the full name belongs in `title`. */
    cut: boolean;
}

/**
 * "description · unit" on at most two lines at word boundaries. A break after a separator wins when both
 * lines fit, otherwise the most even break; line 2 never starts with a separator and the unit stays with the
 * last word. A name with no spaces breaks after `_ . -`. When two lines cannot hold it: line 1 keeps the start,
 * line 2 reads "… end · unit" in whole words.
 */
export function wrapAxisName(info: AxisNamed, maxPx: number, font = DEFAULT_AXIS_FONT, measure: MeasureText = textWidth): WrappedAxisName {
    const desc = displayedName(info);
    const unit = unitSuffix(info);
    if (!(maxPx > 0) || measure(desc + unit, font) <= maxPx) return { lines: [desc + unit], cut: false };
    const breaks: number[] = [];
    for (const m of desc.matchAll(boundaryRe(desc))) {
        const pos = (m.index ?? 0) + m[0].length;
        if (pos <= 0 || pos >= desc.length || SEP_FIRST.test(desc.slice(pos))) continue;
        breaks.push(pos);
    }
    let best = -1;
    let bestScore = Infinity;
    for (const pos of breaks) {
        const a = measure(desc.slice(0, pos).trimEnd(), font);
        const b = measure(desc.slice(pos) + unit, font);
        if (a > maxPx || b > maxPx) continue;
        const score = (/\s[-–—·|/]\s*$/.test(desc.slice(0, pos)) ? 0 : 1e6) + Math.max(a, b);
        if (score < bestScore) { bestScore = score; best = pos; }
    }
    if (best >= 0) return { lines: [desc.slice(0, best).trimEnd(), desc.slice(best) + unit], cut: false };
    let first = -1;
    for (const pos of breaks) if (measure(desc.slice(0, pos).trimEnd(), font) <= maxPx) first = pos;
    if (first < 0) return { lines: [fitAxisName(info, maxPx, font, measure)], cut: true };
    return { lines: [desc.slice(0, first).trimEnd(), keepEnd(desc.slice(first), unit, maxPx, font, measure)], cut: true };
}

export interface ScatterAxisTitle {
    /** null: the name fits, keep the normal markup. */
    wrapped: string[] | null;
    cut: boolean;
    /** The separate tag line still prints. */
    tagLine: boolean;
    /** The title stays on one line and the unit stays beside the tag on the tag line. */
    unitOnTagLine?: boolean;
}

export interface ScatterAxisInfo extends AxisNamed {
    /** The tag only re-spells the description (rule 3b). */
    tagHidden?: boolean;
    /** The fx badge shares line 1. */
    special?: unknown;
}

export interface ScatterAxisOptions {
    /** The UI font family of the title. */
    fontFamily: string;
    /** The mono font family, for a tag printed as the name. */
    monoFamily: string;
    /** The whole free column a rotated title may use, past the plot's length. Default: `room`. */
    chartRoom?: number;
    measure?: MeasureText;
}

/** Scatter's HTML axis titles: what to print for one axis with `room` px along the plot. */
export function scatterAxisTitle(info: ScatterAxisInfo, room: number, options: ScatterAxisOptions): ScatterAxisTitle {
    const measure = options.measure ?? textWidth;
    const tagLine = !!info.description && !info.tagHidden;
    const font = info.description ? `500 11.5px ${options.fontFamily}` : `10px ${options.monoFamily}`;
    const badge = info.special ? 22 : 0;
    const r = room - 6 - badge; // canvas vs DOM rounding
    // Canvas reads about 1.4 % wider than the DOM: same box as before unless it really overflows.
    if (tagLine) {
        if (measure(info.description!, font) * 0.985 <= r + 6) return { wrapped: null, cut: false, tagLine };
    } else if (!info.description) {
        const w = measure(info.tag, font) + (info.unit ? measure(info.unit, font) + 6 : 0);
        if (w <= (r + 6) / 0.985) return { wrapped: null, cut: false, tagLine };
    }
    const full = Math.max(r, (options.chartRoom ?? room) - 6 - badge);
    if (tagLine && measure(info.description!, font) <= full) {
        return { wrapped: [info.description!], cut: false, tagLine, unitOnTagLine: true };
    }
    const w = wrapAxisName(info, full, font, measure);
    return { wrapped: w.lines, cut: w.cut, tagLine };
}

// ---- ECharts: an option says which sensor each axis names; the chart wrapper fits the titles ----

export interface AxisNameSpec {
    x?: AxisNamed;
    y?: AxisNamed;
}

const AXIS_NAMES_KEY = '__sensorAxisNames';

/** Marks which sensor each axis of an ECharts option names (not enumerable, not part of the option). */
export function withAxisNames<T extends object>(option: T, spec: AxisNameSpec): T {
    if (!option) return option;
    Object.defineProperty(option, AXIS_NAMES_KEY, { value: spec, enumerable: false, configurable: true });
    return option;
}

/** The sensors marked by `withAxisNames`, or null. */
export function getAxisNames(option: unknown): AxisNameSpec | null {
    if (!option || typeof option !== 'object') return null;
    return ((option as Record<string, unknown>)[AXIS_NAMES_KEY] as AxisNameSpec | undefined) ?? null;
}

const px = (v: unknown, total: number, fallback: number): number => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.endsWith('%')) return (parseFloat(v) / 100) * total;
    if (typeof v === 'string' && v.trim() !== '') return parseFloat(v) || fallback;
    return fallback;
};

/* eslint-disable @typescript-eslint/no-explicit-any -- an ECharts option is an open shape */
export interface AxisNamePatch {
    /** Pass to `setOption`: `xAxis.name`, `yAxis.name` (with `\n`), `nameTextStyle.lineHeight`, `grid.left`. */
    patch: Record<string, unknown>;
    /** Pass back as `wrappedBefore` next time, so `lineHeight` is reset when the title returns to one line. */
    wrapped: boolean;
}

/**
 * The titles for a chart of `width` × `height`. The rotated Y title takes a second line instead of a middle cut
 * and only then the plot gives up that line; it may use its free column past the plot. The X title keeps the
 * one-line middle cut.
 */
export function axisNamePatch(
    spec: AxisNameSpec,
    option: any,
    width: number,
    height: number,
    wrappedBefore = false,
    measure: MeasureText = textWidth,
): AxisNamePatch {
    const g = Array.isArray(option.grid) ? option.grid[0] : option.grid ?? {};
    const top = px(g.top, height, 14);
    const bottom = px(g.bottom, height, 40);
    const plotH = height - top - bottom;
    const sizeOf = (ax: any): number => ax?.nameTextStyle?.fontSize ?? 10;
    const fontOf = (ax: any) => `${sizeOf(ax)}px ${AXIS_FONT_FAMILY}`;
    const xAx = Array.isArray(option.xAxis) ? option.xAxis[0] : option.xAxis;
    const yAx = Array.isArray(option.yAxis) ? option.yAxis[0] : option.yAxis;
    const patch: Record<string, unknown> = {};
    let left = px(g.left, width, 58);
    let wrapped = false;
    if (spec.y) {
        const y = wrapAxisName(spec.y, plotH + 2 * Math.min(top, bottom) - 8, fontOf(yAx), measure);
        wrapped = y.lines.length > 1;
        const lineHeight = sizeOf(yAx) + 3;
        if (wrapped) left += lineHeight;
        patch.yAxis = {
            name: y.lines.join('\n'),
            ...(wrapped ? { nameTextStyle: { lineHeight } } : wrappedBefore ? { nameTextStyle: { lineHeight: null } } : {}),
        };
        if (wrapped || wrappedBefore) patch.grid = { left };
    }
    if (spec.x) {
        const plotW = width - left - px(g.right, width, 18);
        patch.xAxis = { name: fitAxisName(spec.x, plotW - 8, fontOf(xAx), measure) };
    }
    return { patch, wrapped };
}

/** The patch that would change nothing on a chart showing `option`: same shape as `axisNamePatch` for titles that fit. */
function ownNamesPatch(spec: AxisNameSpec, option: any): Record<string, unknown> {
    const nameOf = (ax: any) => ({ name: (Array.isArray(ax) ? ax[0] : ax)?.name });
    return {
        ...(spec.y ? { yAxis: nameOf(option.yAxis) } : {}),
        ...(spec.x ? { xAxis: nameOf(option.xAxis) } : {}),
    };
}

/** Fits the titles named by `spec` on an ECharts instance now and whenever it resizes. Touches the chart only when
 *  the titles differ from what it shows (it starts out showing `option`'s own). Returns the cleanup. */
export function attachAxisNames(inst: any, spec: AxisNameSpec, option: any, measure: MeasureText = textWidth): () => void {
    let last = JSON.stringify(ownNamesPatch(spec, option));
    let wrappedBefore = false;
    let raf = 0;
    const apply = () => {
        if (!inst || inst.isDisposed?.()) return;
        const { patch, wrapped } = axisNamePatch(spec, option, inst.getWidth(), inst.getHeight(), wrappedBefore, measure);
        wrappedBefore = wrapped;
        const sig = JSON.stringify(patch);
        if (sig === last) return;
        last = sig;
        inst.setOption(patch);
    };
    apply();
    let ro: ResizeObserver | null = null;
    // A disposed chart has no DOM: observing null would throw and blank the whole window.
    const dom = inst?.getDom?.();
    if (dom && typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(apply); });
        ro.observe(dom);
    }
    return () => { ro?.disconnect(); cancelAnimationFrame(raf); };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
