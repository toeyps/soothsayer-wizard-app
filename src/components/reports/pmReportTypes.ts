// Relation-model stiffness presets shown as four levels (lambda hidden from users), ordered loose to strict.
export const STIFFNESS_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
    { value: 1_000,     label: 'Very loose' },
    { value: 10_000,    label: 'Loose' },
    { value: 100_000,   label: 'Standard' },
    { value: 1_000_000, label: 'Strict' },
];
export const STIFFNESS_DEFAULT = 100_000;
const STIFFNESS_VALUES = new Set(STIFFNESS_OPTIONS.map(o => o.value));
/** Lambda value to label; an unknown value falls back to the 'Standard' label. */
export const stiffnessLabel = (v: number): string =>
    STIFFNESS_OPTIONS.find(o => o.value === v)?.label
    ?? STIFFNESS_OPTIONS.find(o => o.value === STIFFNESS_DEFAULT)!.label;
/** Snap an unknown λ to the default preset (`STIFFNESS_DEFAULT`). */
export const snapStiffness = (v: number): number =>
    STIFFNESS_VALUES.has(v) ? v : STIFFNESS_DEFAULT;
