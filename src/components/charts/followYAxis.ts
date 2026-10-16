/**
 * A time chart whose Y axis follows the ZOOM WINDOW, but never loses the reference
 * lines drawn on it (user decision 2026-10-16, Workbench Model fit + Health score pages).
 *
 * Those charts used to compute their Y range once, from every point plus every reference
 * line (±1SD / ±3SD, L / H, ±2RMSE, the 80 / 0 points), and keep it: zoomed into a quiet
 * stretch the line was a flat trace at the bottom of a tall axis ("ดูยากมากๆ"). The
 * Dashboard's line chart re-fits Y to what is visible, but there a reference line outside
 * the visible values would leave the plot — so here the range is
 *   the values INSIDE the window  ∪  every reference line,
 * the same rule as the unzoomed range, applied to the visible stretch only.
 *
 * The builder hangs a `FollowYSpec` on the option (`withFollowY`, a non-enumerable key, so
 * ECharts and deep-equality checks never see it); `ResponsiveECharts` attaches
 * `attachFollowY` to the instance. The option is only patched when the rounded range
 * changes, so hovering and small pans cost nothing.
 */

export interface FollowYSpec {
    /** Epoch ms of every point, ascending (the time axis' values). */
    xs: readonly number[];
    /** One value array per line, aligned with `xs` (`null` = a gap). */
    lines: readonly (readonly (number | null)[])[];
    /** The lowest / highest reference line or band edge (±Infinity when there is none). */
    refLo: number;
    refHi: number;
    /** The Y axis patch for a rounded range: min, max, interval and the label formatter. */
    axis: (min: number, max: number, step: number | undefined) => Record<string, unknown>;
    /** Rounds a value range out to the axis' `[min, max, step]`. */
    range: (lo: number, hi: number) => [number, number, number?];
}

const KEY = '__followY';

/** Hangs `spec` on `option` without making it a visible option key. */
export function withFollowY<T extends object>(option: T, spec: FollowYSpec): T {
    Object.defineProperty(option, KEY, { value: spec, enumerable: false });
    return option;
}

/** A copy of an option (`{ ...opt, … }`) loses the spec — it is not enumerable. Builders that
 *  copy one pass the copy through this to keep it. */
export function keepFollowY<T extends object>(from: unknown, to: T): T {
    const spec = getFollowY(from);
    return spec ? withFollowY(to, spec) : to;
}

export function getFollowY(option: unknown): FollowYSpec | null {
    return option && typeof option === 'object' ? ((option as Record<string, unknown>)[KEY] as FollowYSpec | undefined) ?? null : null;
}

/** First index with `xs[i] >= x`. */
function lowerBound(xs: readonly number[], x: number): number {
    let lo = 0;
    let hi = xs.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (xs[mid] < x) lo = mid + 1; else hi = mid;
    }
    return lo;
}

/** `[lo, hi]` of every value with `x` inside `[x0, x1]`, plus the reference lines. */
export function followRange(spec: FollowYSpec, x0: number, x1: number): [number, number, number?] | null {
    let lo = spec.refLo;
    let hi = spec.refHi;
    const a = lowerBound(spec.xs, x0);
    const b = lowerBound(spec.xs, x1 + 1e-9);
    for (const line of spec.lines) {
        for (let i = a; i < b; i++) {
            const v = line[i];
            if (typeof v === 'number' && Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
        }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
    return spec.range(lo, hi);
}

/** Keeps `inst`'s Y axis on `followRange` of its visible window. Returns the detach function. */
export function attachFollowY(inst: any, spec: FollowYSpec): () => void {
    if (!inst?.on || !inst?.getModel) return () => {};
    let lastKey = '';
    let frame: ReturnType<typeof setTimeout> | null = null;
    let detached = false;

    const apply = () => {
        frame = null;
        if (detached || inst.isDisposed?.()) return;
        const axis = inst.getModel?.()?.getComponent?.('xAxis', 0)?.axis;
        if (!axis) return;
        const [x0, x1] = axis.scale.getExtent() as [number, number];
        const r = followRange(spec, x0, x1);
        if (!r) return;
        const key = `${r[0]}|${r[1]}`;
        if (key === lastKey) return;
        lastKey = key;
        inst.setOption({ yAxis: spec.axis(r[0], r[1], r[2]) }, { lazyUpdate: true });
    };
    // Never patch from inside the chart's own update: wait for it to finish.
    const schedule = () => { if (frame === null && !detached) frame = setTimeout(apply, 0); };

    inst.on('datazoom', schedule);
    schedule();
    return () => {
        detached = true;
        if (frame !== null) clearTimeout(frame);
        inst.off?.('datazoom', schedule);
    };
}
