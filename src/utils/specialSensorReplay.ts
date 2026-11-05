import { SpecialSensorRecipe } from '../types';
import { orderRecipesByDependency } from './specialSensorDeps';
import { recomputeCall, Invoker } from './specialSensorRecompute';
import { isSessionLostError } from './staleSession';

/** Rebuild every special sensor's column in the Rust session after a workspace's CSVs load (only recipes survive a restart), in dependency order. A recipe that fails to build is reported and everything built on it is skipped; `failed` = broke, `skipped` = never tried. */
export interface ReplayResult {
    failed: string[];
    skipped: string[];
    /** Why each `failed` tag failed, in the backend's words (e.g. unknown name 'pi'); only present when something failed. */
    errors?: Record<string, string>;
}

const key = (tag: string) => tag.trim().toLowerCase();

async function readFormulaInputs(
    recipes: SpecialSensorRecipe[],
    invoker: Invoker,
): Promise<Map<string, string[]> | null> {
    const formulas = recipes.filter(r => r.kind === 'formula');
    if (formulas.length === 0) return new Map();
    try {
        const refs = await invoker('extract_formula_refs', {
            formulas: formulas.map(r => (r as { formula: string }).formula),
        });
        if (!Array.isArray(refs)) return null;
        return new Map(formulas.map((r, i) => [key(r.tag), Array.isArray(refs[i]) ? (refs[i] as string[]) : []]));
    } catch {
        // No dependency information: fall back to plain array order and
        // attempt everything. Never block a workspace open on this lookup.
        return null;
    }
}

export async function replaySpecialSensorRecipes(
    recipes: SpecialSensorRecipe[],
    invoker: Invoker,
): Promise<ReplayResult> {
    const formulaInputs = await readFormulaInputs(recipes, invoker);
    const inputsOf = (r: SpecialSensorRecipe): string[] =>
        r.kind === 'operation' ? r.sourceSensors ?? [] : formulaInputs?.get(key(r.tag)) ?? [];

    const ordered = formulaInputs ? orderRecipesByDependency(recipes, inputsOf) : recipes;

    const failed: string[] = [];
    const skipped: string[] = [];
    const errors: Record<string, string> = {};
    const broken = new Set<string>();

    for (const recipe of ordered) {
        const blockedBy = inputsOf(recipe).find(input => broken.has(key(input)));
        if (blockedBy !== undefined) {
            skipped.push(recipe.tag);
            broken.add(key(recipe.tag));
            continue;
        }
        try {
            // Same call as the Manage tab's edit-and-recompute, so they can't drift; `replace: true` keeps a repeat replay idempotent.
            const { cmd, args } = recomputeCall(recipe);
            await invoker(cmd, args);
        } catch (err) {
            // Session replaced mid-replay: every remaining recipe would fail the same way, so stop and let the caller reload.
            if (isSessionLostError(err)) throw err;
            console.warn(`Failed to restore special sensor "${recipe.tag}":`, err);
            failed.push(recipe.tag);
            errors[recipe.tag] = err instanceof Error ? err.message : String(err);
            broken.add(key(recipe.tag));
        }
    }
    return failed.length > 0 ? { failed, skipped, errors } : { failed, skipped };
}
