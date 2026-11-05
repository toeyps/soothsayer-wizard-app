/* Props comparison for the memoised Workbench pages: identity (callbacks must be stable), `preview` by its fields, keys in `byValue` by JSON value. */
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
