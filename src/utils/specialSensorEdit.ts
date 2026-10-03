import { SpecialSensorRecipe } from '../types';
import {
    buildSpecialSensorUsage, cycleConflicts, dependentsToRecompute, orderRecipesByDependency,
} from './specialSensorDeps';
import { recomputeSpecialSensors, Invoker } from './specialSensorRecompute';
import { renameTagInRecipes } from './specialSensorRename';
import { replaySpecialSensorRecipes } from './specialSensorReplay';
import { sameTag } from './specialSensorNaming';

/**
 * The backend half of "edit (or rename) a special sensor": work out what is
 * built on it, recompute it and everything downstream IN BUILD ORDER, and --
 * if anything fails part-way -- put the session back the way it was.
 *
 * Why this is its own module: the recompute is a sequence of in-place column
 * overwrites (`replace: true`) with no transaction. A failure on the 3rd of 4
 * left the edited sensor's column holding the NEW formula's values while every
 * recipe still said the old one -- the chart showed numbers no recipe produces
 * until the workspace was reopened, and Cancel did not undo it. So a failure
 * after the first write is rolled back here: the recipes that were already
 * rewritten are recomputed from their ORIGINAL definitions (build order,
 * `replace: true`), and the half-built column of a rename is dropped.
 *
 * Everything is decided from `recipes` (the caller's FRESH list, read inside
 * the serial queue) and from references read from Rust right now -- never from
 * a cached lookup. A cached lookup that has not caught up with a just-saved
 * edit let `A -> $C*2` followed by `C -> $A+1` through as an A <-> C cycle.
 */

export interface EditArgs {
    /** The window's full, current recipe list (stored order). */
    recipes: SpecialSensorRecipe[];
    /** The edited sensor's new recipe (its `tag` is the NEW name on a rename). */
    next: SpecialSensorRecipe;
    /** The sensor's previous tag -- set exactly when it was renamed. */
    oldTag?: string;
    invoker: Invoker;
}

export interface EditOutcome {
    /** What the edited sensor reads after the edit. */
    nextInputs: string[];
    /** Downstream recipes as they were before (original definitions), in build order. */
    downstream: SpecialSensorRecipe[];
    /** Downstream recipes after a rename was carried into them (same objects when not renaming). */
    renamedDownstream: SpecialSensorRecipe[];
    /** The whole list in a valid build order, after the edit -- only when that
     *  differs from the stored order. */
    recipeOrder?: string[];
    /** Apply the edit to a recipe list (swap in the edited recipe, take the
     *  rewritten downstream ones). Pure; run it on whatever the list is now. */
    applyEdit: (list: SpecialSensorRecipe[]) => SpecialSensorRecipe[];
}

/** Thrown by `runSpecialSensorEdit`. `touched` is true when a column in the
 *  session was already overwritten before the failure (so other windows should
 *  refetch); `inconsistent` lists sensors the rollback could NOT put back. */
export class SpecialSensorEditError extends Error {
    touched = false;
    rolledBack = false;
    inconsistent: string[] = [];
}

const key = (tag: string) => tag.trim().toLowerCase();

/** Formula tag -> sensors it reads, straight from Rust (`extract_formula_refs`).
 *  The edited formula is asked about on its own, so what a recipe reads and what
 *  the edit would make it read can never be confused. */
async function readRefs(
    recipes: SpecialSensorRecipe[],
    editedFormula: string | null,
    invoker: Invoker,
): Promise<{ refsByTag: Map<string, string[]>; nextRefs: string[] }> {
    const formulaRecipes = recipes.filter(r => r.kind === 'formula') as Array<Extract<SpecialSensorRecipe, { kind: 'formula' }>>;
    const refsByTag = new Map<string, string[]>();
    if (formulaRecipes.length > 0) {
        const out = await invoker('extract_formula_refs', { formulas: formulaRecipes.map(r => r.formula) });
        if (!Array.isArray(out)) throw new Error('unexpected reply while reading formula references');
        formulaRecipes.forEach((r, i) => refsByTag.set(key(r.tag), Array.isArray(out[i]) ? (out[i] as string[]) : []));
    }
    let nextRefs: string[] = [];
    if (editedFormula !== null) {
        const out = await invoker('extract_formula_refs', { formulas: [editedFormula] });
        if (!Array.isArray(out)) throw new Error('unexpected reply while reading formula references');
        nextRefs = Array.isArray(out[0]) ? (out[0] as string[]) : [];
    }
    return { refsByTag, nextRefs };
}

export async function runSpecialSensorEdit(args: EditArgs): Promise<EditOutcome> {
    const { recipes, next, oldTag, invoker } = args;
    const newTag = next.tag;
    const identityTag = oldTag ?? next.tag;
    const removesOldColumn = !!oldTag && !sameTag(oldTag, newTag);

    // ---- Read-only phase: nothing in the session changes until the recompute.
    let refsByTag: Map<string, string[]>;
    let nextRefs: string[];
    try {
        ({ refsByTag, nextRefs } = await readRefs(
            recipes,
            next.kind === 'formula' ? next.formula : null,
            invoker,
        ));
    } catch (err) {
        // Without it this could neither find what is built on the sensor (to
        // recompute it) nor rewrite those dependents on a rename -- and would
        // then drop the old column from under them. Refuse; nothing changed.
        console.error('Failed to read formula references:', err);
        const refused = new Error('Still working out which sensors are built on this one. Try again in a moment.');
        // Set rather than passed to the constructor: the project's TS lib
        // target predates `ErrorOptions`.
        (refused as Error & { cause?: unknown }).cause = err;
        throw refused;
    }
    const nextInputs = next.kind === 'formula' ? nextRefs : (next.sourceSensors ?? []);
    if (next.kind === 'formula' && nextInputs.length === 0) {
        throw new Error('This formula doesn\'t reference any sensor. Use $Name, or ${Name With Spaces}.');
    }

    const inputsOfStored = (r: SpecialSensorRecipe): string[] =>
        r.kind === 'operation' ? r.sourceSensors ?? [] : refsByTag.get(key(r.tag)) ?? [];

    const usage = buildSpecialSensorUsage({
        recipes,
        formulaRefs: refsByTag,
        models: [],
        selectedSensors: [],
    });

    const conflicts = cycleConflicts(recipes, usage, identityTag, nextInputs);
    if (conflicts.length > 0) {
        throw new Error(`"${next.tag}" can't be built from ${conflicts.join(', ')} — that would make it depend on itself.`);
    }

    // Build order, whatever order the stored list happens to be in.
    const downstream = dependentsToRecompute(recipes, usage, identityTag, inputsOfStored);
    const originalEdited = recipes.find(r => sameTag(r.tag, identityTag));

    // Carry a rename into every downstream recipe BEFORE any of them replays.
    // Still read-only (a rewrite is text, not a column write).
    const renamedDownstream = oldTag
        ? await renameTagInRecipes(downstream, oldTag, newTag, invoker)
        : downstream;

    // ---- Write phase.
    const done: SpecialSensorRecipe[] = [];
    try {
        await recomputeSpecialSensors([next, ...renamedDownstream], invoker, r => done.push(r));
    } catch (err) {
        const failure = new SpecialSensorEditError(err instanceof Error ? err.message : String(err));
        failure.touched = done.length > 0;
        if (done.length > 0) {
            const originals = [originalEdited, ...downstream].slice(0, done.length);
            const touchedTags = new Set([identityTag, ...downstream.map(r => r.tag)].map(key));
            try {
                await recomputeSpecialSensors(
                    originals.filter((r): r is SpecialSensorRecipe => !!r),
                    invoker,
                );
                failure.rolledBack = originals.every(r => !!r);
                if (!failure.rolledBack) failure.inconsistent = [identityTag];
            } catch {
                // The targeted rollback itself failed: rebuild EVERYTHING from the
                // recipes (dependency-ordered, replace: true) as the last resort.
                try {
                    const res = await replaySpecialSensorRecipes(recipes, invoker);
                    failure.inconsistent = [...res.failed, ...res.skipped].filter(t => touchedTags.has(key(t)));
                    failure.rolledBack = failure.inconsistent.length === 0;
                } catch {
                    failure.inconsistent = [...touchedTags].map(k => recipes.find(r => key(r.tag) === k)?.tag ?? k);
                }
            }
            // The renamed sensor's NEW column was created by the first write
            // and nothing will ever point at it now.
            if (removesOldColumn) {
                try { await invoker('remove_sensor_columns', { names: [newTag] }); } catch { /* best effort */ }
            }
        }
        throw failure;
    }

    // ---- Next stored list: the edit applied, then a valid build order.
    const applyEdit = (list: SpecialSensorRecipe[]) => list.map(r => {
        if (sameTag(r.tag, identityTag)) return next;
        const rewritten = renamedDownstream.find(d => sameTag(d.tag, r.tag));
        return rewritten ?? r;
    });
    const inputsAfter = (r: SpecialSensorRecipe): string[] => {
        if (sameTag(r.tag, newTag)) return nextInputs;
        if (r.kind === 'operation') return r.sourceSensors ?? [];
        const refs = refsByTag.get(key(r.tag)) ?? [];
        return oldTag ? refs.map(x => (sameTag(x, oldTag) ? newTag : x)) : refs;
    };
    const edited = applyEdit(recipes);
    const ordered = orderRecipesByDependency(edited, inputsAfter);
    const orderChanged = ordered.some((r, i) => edited[i] !== r);

    return {
        nextInputs,
        downstream,
        renamedDownstream,
        recipeOrder: orderChanged ? ordered.map(r => r.tag) : undefined,
        applyEdit,
    };
}
