// Relation-model stiffness: seven named steps, one per decade from 0.1 to 100 000 (lambda hidden from users), loose to strict.
// Same table as Rust `fit_profile` and WIZARD_OUTPUT_SPEC.md §4.5.
export const STIFFNESS_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
    { value: 0.1,     label: 'Very loose' },
    { value: 1,       label: 'Loose' },
    { value: 10,      label: 'Slightly loose' },
    { value: 100,     label: 'Standard' },
    { value: 1_000,   label: 'Slightly strict' },
    { value: 10_000,  label: 'Strict' },
    { value: 100_000, label: 'Very strict' },
];
/** Step a new model starts on. */
export const STIFFNESS_DEFAULT = 100;
/** What a model saved WITHOUT a stiffness was trained with (the old default); keeps those models from going stale. */
export const STIFFNESS_LEGACY_DEFAULT = 100_000;
const STIFFNESS_VALUES = new Set(STIFFNESS_OPTIONS.map(o => o.value));
/** Lambda value to label, same step the settings field shows (unknown → nearest step, missing → legacy default). */
export const stiffnessLabel = (v: number | undefined): string => {
    const step = snapStiffness(v ?? STIFFNESS_LEGACY_DEFAULT);
    return STIFFNESS_OPTIONS.find(o => o.value === step)!.label;
};
/** Snap a λ that is not a step to the nearest step on a log scale (old 1 000 000 → 100 000); non-positive/non-finite → default. */
export const snapStiffness = (v: number): number => {
    if (STIFFNESS_VALUES.has(v)) return v;
    if (!Number.isFinite(v) || v <= 0) return STIFFNESS_DEFAULT;
    const lg = Math.log10(v);
    return STIFFNESS_OPTIONS.reduce((best, o) =>
        Math.abs(Math.log10(o.value) - lg) < Math.abs(Math.log10(best) - lg) ? o.value : best, STIFFNESS_OPTIONS[0].value);
};
