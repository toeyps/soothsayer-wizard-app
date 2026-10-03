import { FailureModel, SpecialSensorRecipe } from '../types';
import {
    buildSpecialSensorUsage, cycleConflicts, dependentsToRecompute, describeEditLock,
    EditLock, orderRecipesByDependency, usageFor,
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

/**
 * What the edit lock (2026-10-03) is decided from -- read FRESH by the caller,
 * inside the serial queue, immediately before the edit runs.
 *
 * A special sensor that a model (or the workspace Running condition) uses --
 * directly, or through a special sensor built on it -- may not be renamed, nor
 * have its formula / operation / sources changed: a Trained or Complete model
 * built from it would go stale. Only its description / unit / component can
 * change. `known: false` (the models could not be read) is treated as locked.
 */
export interface EditFailureState {
    known: boolean;
    models: FailureModel[];
    runningConditionFilters: Array<{ sensor: string }>;
    /** Why it is not known (shown to the user). */
    reason?: string;
}

export interface EditArgs {
    /** The window's full, current recipe list (stored order). */
    recipes: SpecialSensorRecipe[];
    /** The edited sensor's new recipe (its `tag` is the NEW name on a rename). */
    next: SpecialSensorRecipe;
    /** The sensor's previous tag -- set exactly when it was renamed. */
    oldTag?: string;
    invoker: Invoker;
    /** When given, the edit lock is enforced (see `EditFailureState`). Omitted
     *  = no lock check (only callers that have no models to ask). */
    failureState?: EditFailureState;
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
    /** The recipe that was actually saved: `next`, or -- for a metadata-only save
     *  of a locked sensor -- the stored recipe, untouched. */
    recipe: SpecialSensorRecipe;
    /** True when nothing but description / unit / component changed on a locked
     *  sensor: no column was touched, nothing was recomputed. */
    metadataOnly: boolean;
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

/** Thrown (before anything is written) when the edit lock refuses a rename or a
 *  change to a locked sensor's values. */
export class SpecialSensorLockedError extends Error {
    constructor(message: string, readonly lock: EditLock) {
        super(message);
        this.name = 'SpecialSensorLockedError';
    }
}

const key = (tag: string) => tag.trim().toLowerCase();

/** JSON with sorted keys and no `undefined`, so two configs that mean the same
 *  thing compare equal whatever order they were built in. */
function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        return `{${Object.keys(obj).filter(k => obj[k] !== undefined).sort()
            .map(k => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

/**
 * Do two recipes produce the same values from the same inputs? Compared on what
 * decides the column: kind, tag, formula text (trimmed) / source sensors in
 * order + operation config. An operation's `customName` is ignored -- it is
 * forced back to the tag, so it carries no information of its own.
 */
export function recipesEquivalent(a: SpecialSensorRecipe, b: SpecialSensorRecipe): boolean {
    if (a.kind !== b.kind || a.tag !== b.tag) return false;
    if (a.kind === 'formula' && b.kind === 'formula') return a.formula.trim() === b.formula.trim();
    if (a.kind === 'operation' && b.kind === 'operation') {
        const strip = (c: SpecialSensorRecipe & { kind: 'operation' }) => {
            const { customName: _ignored, ...rest } = c.operationConfig;
            void _ignored;
            return rest;
        };
        return stableJson(a.sourceSensors) === stableJson(b.sourceSensors)
            && stableJson(strip(a)) === stableJson(strip(b));
    }
    return false;
}

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

function nextRefsOrSources(recipe: SpecialSensorRecipe, refsByTag: Map<string, string[]>): string[] {
    return recipe.kind === 'operation' ? recipe.sourceSensors ?? [] : refsByTag.get(key(recipe.tag)) ?? [];
}

export async function runSpecialSensorEdit(args: EditArgs): Promise<EditOutcome> {
    const { recipes, next, oldTag, invoker, failureState } = args;
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
        models: failureState?.models ?? [],
        runningConditionFilters: failureState?.runningConditionFilters,
        selectedSensors: [],
        failureKnown: failureState?.known ?? true,
    });

    // ---- Edit lock: decided HERE, in the read-only phase, so a refused edit
    // has not touched a single column (and the window has not changed its own
    // state either). Only a rename or a change to what the sensor computes is
    // refused; description / unit / component never are.
    const originalEdited = recipes.find(r => sameTag(r.tag, identityTag));
    if (failureState && originalEdited) {
        const lock = usageFor(usage, identityTag)?.editLock;
        if (lock?.locked) {
            const renaming = !!oldTag;
            const changesValues = !recipesEquivalent(originalEdited, { ...next, tag: originalEdited.tag } as SpecialSensorRecipe);
            if (renaming || changesValues) {
                const what = renaming ? 'rename' : 'change the formula, operation or sources of';
                const why = lock.unknown
                    ? `couldn't check whether a model uses it${failureState.reason ? ` (${failureState.reason})` : ''} — try again in a moment`
                    : describeEditLock(lock);
                throw new SpecialSensorLockedError(
                    lock.unknown
                        ? `Can't ${what} "${originalEdited.tag}" right now: ${why}.`
                        : `Can't ${what} "${originalEdited.tag}". ${why} (Its description, unit and component can still be edited.)`,
                    lock,
                );
            }
            // Metadata only: the recipe is saved exactly as stored.
            return {
                nextInputs: nextRefsOrSources(originalEdited, refsByTag),
                downstream: [],
                renamedDownstream: [],
                recipe: originalEdited,
                metadataOnly: true,
                applyEdit: list => list.map(r => (sameTag(r.tag, identityTag) ? originalEdited : r)),
            };
        }
    }

    const conflicts = cycleConflicts(recipes, usage, identityTag, nextInputs);
    if (conflicts.length > 0) {
        throw new Error(`"${next.tag}" can't be built from ${conflicts.join(', ')} — that would make it depend on itself.`);
    }

    // Build order, whatever order the stored list happens to be in.
    const downstream = dependentsToRecompute(recipes, usage, identityTag, inputsOfStored);

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
        recipe: next,
        metadataOnly: false,
        recipeOrder: orderChanged ? ordered.map(r => r.tag) : undefined,
        applyEdit,
    };
}
