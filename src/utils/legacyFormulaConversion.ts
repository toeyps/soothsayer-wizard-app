import type { SpecialSensorRecipe, WorkspaceState } from '../types';
import type { LegacyFormulaConversion, LegacyFormulaConversionResult } from '../types/formula';
import type { Invoker } from './specialSensorRecompute';
import { demoteModelsForRecipeChange } from './specialSensorSignature';
import { withFailureGroupState } from './failureGroupState';
import { excelRoundCalls } from './formulaTokens';

/**
 * Auto-convert legacy spreadsheet-style `round($A, 2)` on workspace open
 * (customer batch 2026-10, item 6 -- user decision 2026-10-09, taken with
 * dev). The engine's two-value round is `round(step, x)`, so `round($A, 2)`
 * rounded the CONSTANT 2 to a multiple of $A -- silently wrong values until
 * 2026-10-08, refused (`round_excel`, the sensor had no data) since. Rust's
 * `convert_legacy_formula` rewrites every such call to the engine form
 * `round($A * 100) / 100`; this module runs it over the stored recipes, and
 * persists the result with the model demotion in ONE workspace write.
 *
 * Flow on open (`DataUploadPage.handleLoadWorkspace`):
 *   1. `convertLegacyFormulaRecipes(recipes, invoke)` -- BEFORE the replay
 *      (pure text, no dataset; once per open, outside the load retry loop);
 *   2. replay the CONVERTED recipes (`replaySpecialSensorRecipes`);
 *   3. `saveLegacyFormulaConversion(id, converted)` (workspaceManager.ts) --
 *      one write: the new formula text + every model trained on a converted
 *      sensor (or on one built on it) back to Incomplete and out of date;
 *   4. hand the Dashboard the WRITTEN state (its recipes and models), never
 *      the state read before step 3 -- the Dashboard's full-overwrite autosave
 *      would otherwise write the old `round($A, 2)` text straight back;
 *   5. show `legacyConversionMessage(...)`.
 * Idempotent: a converted formula has no spreadsheet-order round left, so the
 * next open finds nothing to convert and writes nothing.
 */

/** Pre-filter: only a formula with a spreadsheet-order `round(x, n)` call is
 *  sent to Rust. `excelRoundCalls` is the local twin of Rust's own scan, so an
 *  already-converted `round(x * 100) / 100` costs no IPC call on every open
 *  (review 2026-10-09: a bare `round(` match sent every rounded formula). */
const mayNeedConversion = (formula: string): boolean => excelRoundCalls(formula).length > 0;

export interface LegacyConversionPass {
    /** The recipes to replay: converted ones replaced, everything else as stored
     *  (same array when nothing changed). */
    recipes: SpecialSensorRecipe[];
    converted: LegacyFormulaConversion[];
}

/** Ask Rust to convert every stored formula that may hold a spreadsheet-order
 *  round. A failed call (an old backend) leaves that recipe as it is -- the
 *  replay then reports it as before. */
export async function convertLegacyFormulaRecipes(
    recipes: SpecialSensorRecipe[] | null | undefined,
    invoker: Invoker,
): Promise<LegacyConversionPass> {
    const list = Array.isArray(recipes) ? recipes : [];
    const converted: LegacyFormulaConversion[] = [];
    const out = await Promise.all(list.map(async (r): Promise<SpecialSensorRecipe> => {
        if (r.kind !== 'formula' || typeof r.formula !== 'string' || !mayNeedConversion(r.formula)) return r;
        let reply: unknown;
        try {
            reply = await invoker('convert_legacy_formula', { formula: r.formula });
        } catch (err) {
            console.warn(`Could not convert the rounding of special sensor "${r.tag}":`, err);
            return r;
        }
        const res = reply as Partial<LegacyFormulaConversionResult> | null;
        if (!res || res.changed !== true || typeof res.formula !== 'string' || res.formula === r.formula) return r;
        converted.push({ tag: r.tag, from: r.formula, to: res.formula });
        return { ...r, formula: res.formula };
    }));
    // Keep `converted` in recipe order (the calls may finish in any order).
    const order = new Map(list.map((r, i) => [r.tag, i]));
    converted.sort((a, b) => (order.get(a.tag) ?? 0) - (order.get(b.tag) ?? 0));
    return { recipes: converted.length > 0 ? out : list, converted };
}

/** What a conversion write did. */
export interface LegacyConversionApplied {
    /** The state to write (the input itself when nothing applied). */
    state: WorkspaceState;
    /** The conversions that were applied (a recipe edited meanwhile -- its text
     *  is no longer `from` -- is left alone). */
    applied: LegacyFormulaConversion[];
    /** Ids of the models that must be trained again (were Complete or trained). */
    retrain: string[];
}

/**
 * Pure: `state` (what is on DISK in the write) with each conversion applied
 * and the models trained on the changed sensors demoted -- the updater
 * `saveLegacyFormulaConversion` runs inside `updateWorkspaceData`. A recipe
 * whose text is no longer `from` (edited since it was read) is not touched.
 * `applyIncompleteRule` would demote the same models on its own (a recipe
 * change); doing it here as well yields the count for the notice. Idempotent.
 */
export function applyLegacyConversion(state: WorkspaceState, conversions: LegacyFormulaConversion[]): LegacyConversionApplied {
    const before = state.specialSensorRecipes;
    if (!Array.isArray(before) || conversions.length === 0) return { state, applied: [], retrain: [] };
    const applied: LegacyFormulaConversion[] = [];
    const after = before.map(r => {
        if (r.kind !== 'formula') return r;
        const c = conversions.find(x => x.tag === r.tag && x.from === r.formula);
        if (!c) return r;
        applied.push(c);
        return { ...r, formula: c.to };
    });
    if (applied.length === 0) return { state, applied, retrain: [] };
    let next: WorkspaceState = { ...state, specialSensorRecipes: after };
    let retrain: string[] = [];
    const fg = state.failureGroupState;
    if (fg && Array.isArray(fg.models)) {
        const demoted = demoteModelsForRecipeChange(fg.models, fg, before, after);
        retrain = demoted.retrain;
        if (demoted.models !== fg.models) next = withFailureGroupState(next, { models: demoted.models });
    }
    return { state: next, applied, retrain };
}

/** The notice shown after a conversion (empty string when nothing converted). */
export function legacyConversionMessage(converted: LegacyFormulaConversion[], retrainCount: number): string {
    if (converted.length === 0) return '';
    const n = converted.length;
    const tags = converted.map(c => c.tag).join(', ');
    const parts = [
        `Updated the rounding in ${n} special sensor${n === 1 ? '' : 's'} (${tags}): the old spreadsheet form round(x, n) is now written round(x * 10ⁿ) / 10ⁿ.`,
        `${n === 1 ? 'Its' : 'Their'} values differ from what was shown before, because the old form computed them wrongly.`,
    ];
    if (retrainCount > 0) {
        parts.push(`${retrainCount} model${retrainCount === 1 ? '' : 's'} set back to Incomplete — train ${retrainCount === 1 ? 'it' : 'them'} again.`);
    }
    return parts.join(' ');
}
