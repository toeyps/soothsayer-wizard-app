// ── Relationship-model stiffness (LinearGAM λ) presets ───────────────
// Stiffness is exposed to users as four discrete levels on the PM page's
// dropdown; the underlying λ is hidden everywhere user-facing. Order is
// loose → strict, matching the dropdown render order.
export const STIFFNESS_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
    { value: 1_000,     label: 'Very loose' },
    { value: 10_000,    label: 'Loose' },
    { value: 100_000,   label: 'Standard' },
    { value: 1_000_000, label: 'Strict' },
];
export const STIFFNESS_DEFAULT = 100_000;
const STIFFNESS_VALUES = new Set(STIFFNESS_OPTIONS.map(o => o.value));
/** Resolve a λ value to its human label. Unknown values (e.g. workspaces
 *  saved before this UI change, where λ defaulted to `1`) fall back to
 *  the "Standard" label so the UI never shows a bare number. */
export const stiffnessLabel = (v: number): string =>
    STIFFNESS_OPTIONS.find(o => o.value === v)?.label
    ?? STIFFNESS_OPTIONS.find(o => o.value === STIFFNESS_DEFAULT)!.label;
/** Snap a legacy / out-of-range λ to the closest preset on workspace load. */
export const snapStiffness = (v: number): number =>
    STIFFNESS_VALUES.has(v) ? v : STIFFNESS_DEFAULT;
