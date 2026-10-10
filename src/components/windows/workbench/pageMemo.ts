/*
 * Props comparison for the memoised Workbench pages (`ModelFitPage`,
 * `HealthScorePage`) — customer batch 2026-10, train queue: the Build Model
 * window re-renders on every step of a training run (list badges, the run
 * strip), and every ECharts option on those pages is rebuilt per render with
 * fresh formatter functions, which makes ECharts redraw. A page re-renders
 * only when one of its props really changed.
 *
 * COMPLETE by construction: every prop is compared, so a prop added later can
 * never be silently ignored —
 *   - by identity, by default (callbacks must therefore be stable);
 *   - `preview` (the `useHealthPreview` result, a fresh object per render) by
 *     its fields, each by identity;
 *   - the keys in `byValue` (small plain data the window rebuilds per render:
 *     the model re-read from disk, set points, scoring-period numbers …) by JSON value.
 */
export function samePageProps<T extends object>(a: T, b: T, byValue: readonly (keyof T)[]): boolean {
    const keys = new Set<keyof T>([...Object.keys(a), ...Object.keys(b)] as (keyof T)[]);
    for (const k of keys) {
        const x = a[k];
        const y = b[k];
        if (x === y) continue;
        if (k === 'preview') {
            if (!sameFields(x, y)) return false;
            continue;
        }
        if (byValue.includes(k)) {
            if (JSON.stringify(x) !== JSON.stringify(y)) return false;
            continue;
        }
        return false;
    }
    return true;
}

function sameFields(x: unknown, y: unknown): boolean {
    if (!x || !y || typeof x !== 'object' || typeof y !== 'object') return x === y;
    const ox = x as Record<string, unknown>;
    const oy = y as Record<string, unknown>;
    const keys = new Set([...Object.keys(ox), ...Object.keys(oy)]);
    for (const k of keys) if (ox[k] !== oy[k]) return false;
    return true;
}
