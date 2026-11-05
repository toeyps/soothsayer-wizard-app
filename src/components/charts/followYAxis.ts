/** Y axis follows the zoom window but keeps the reference lines: range = values inside the window plus every reference line. `withFollowY` hangs a non-enumerable `FollowYSpec` on the option; `ResponsiveECharts` attaches `attachFollowY`. */

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

/** A copy of an option (`{ ...opt }`) loses the non-enumerable spec; builders that copy pass the copy through this. */
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
