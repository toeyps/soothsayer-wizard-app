import { SpecialSensorRecipe } from '../types';
import { orderRecipesByDependency } from './specialSensorDeps';
import { recomputeCall, Invoker } from './specialSensorRecompute';
import { isSessionLostError } from './staleSession';

/**
 * Rebuild every special sensor's column in the Rust session right after a
 * workspace's CSVs load (`DataUploadPage.handleLoadWorkspace`). The recipes
 * are the only thing that survives a restart; the computed columns do not.
 *
 * What makes this more than a loop:
 *  - Order: recipes are replayed in dependency order, not blindly in array
 *    order, so a file saved with a source sensor after its dependent (an old
 *    edit could do that -- see `orderRecipesByDependency`) still restores.
 *  - A recipe that fails to build (a source column was renamed or removed
 *    since) is reported, and every recipe built ON TOP of it is SKIPPED rather
 *    than attempted: it could only fail too, or -- worse -- read some other
 *    column that happens to share the name.
 *
 * `failed` and `skipped` are separate so the user can tell "this one broke"
 * from "this one was never tried because something it needs broke".
 */
export interface ReplayResult {
    failed: string[];
    skipped: string[];
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
    const broken = new Set<string>();

    for (const recipe of ordered) {
        const blockedBy = inputsOf(recipe).find(input => broken.has(key(input)));
        if (blockedBy !== undefined) {
            skipped.push(recipe.tag);
            broken.add(key(recipe.tag));
            continue;
        }
        try {
            // Same call the Manage tab's edit-and-recompute builds, from one
            // place, so the two can't drift apart. `replace: true` makes no
            // difference on a fresh load (nothing to replace yet) but keeps a
            // second replay in the same session idempotent.
            const { cmd, args } = recomputeCall(recipe);
            await invoker(cmd, args);
        } catch (err) {
            // The session was replaced under this replay (a stale generation):
            // every remaining recipe would fail the same way, and "couldn't be
            // restored" would be a lie -- stop and let the caller reload.
            if (isSessionLostError(err)) throw err;
            console.warn(`Failed to restore special sensor "${recipe.tag}":`, err);
            failed.push(recipe.tag);
            broken.add(key(recipe.tag));
        }
    }
    return { failed, skipped };
}
