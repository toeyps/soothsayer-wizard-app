import { FailureModel, SpecialSensorRecipe } from '../types';
import {
    buildSpecialSensorUsage, cycleConflicts, dependentsToRecompute, describeEditLock,
    EditLock, orderRecipesByDependency, SensorLabelOf, usageFor,
} from './specialSensorDeps';
import { recomputeCall, recomputeSpecialSensors, Invoker } from './specialSensorRecompute';
import { renameTagInRecipes } from './specialSensorRename';
import { replaySpecialSensorRecipes } from './specialSensorReplay';
import { sameTag } from './specialSensorNaming';
import { isSessionLostError } from './staleSession';

/** Recomputes an edited special sensor and its dependents in build order; rolls back on failure (writes aren't transactional). Decide from fresh `recipes` and refs read from Rust now, never a cached lookup: a stale one lets A->C->A cycles through. */

/** Read fresh in the serial queue. A sensor used by a model or the Running condition (even indirectly) can't be renamed or recomputed; only description/unit/component may change. `known: false` (models unreadable) counts as locked. */
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
    /** When given, the edit lock is enforced; omitted = no check. */
    failureState?: EditFailureState;
    /** REPAIR mode: the sensor has no column this session; `missingBefore` lists every special sensor with no column before the edit. A downstream recipe that still fails goes to `stillBroken`, not fatal; rollback removes created columns. Never with a rename. */
    repair?: { missingBefore: string[] };
    /** How error messages name a sensor. Include `next`'s own metadata, it may
     *  be new. Default: the tag. */
    labelOf?: SensorLabelOf;
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
    /** The recipe actually saved: `next`, or the untouched stored one for a metadata-only save of a locked sensor. */
    recipe: SpecialSensorRecipe;
    /** True when only description/unit/component changed on a locked sensor: nothing was recomputed. */
    metadataOnly: boolean;
    /** Apply the edit to a recipe list; pure, run it on the current list. */
    applyEdit: (list: SpecialSensorRecipe[]) => SpecialSensorRecipe[];
    /** Repair mode: downstream sensors still without a column, in build order; `reason` is the backend message. Recipes unchanged. */
    stillBroken?: Array<{ tag: string; reason: string }>;
}

/** `touched`: a session column was already overwritten (other windows should refetch). `inconsistent`: sensors the rollback couldn't restore. */
export class SpecialSensorEditError extends Error {
    touched = false;
    rolledBack = false;
    inconsistent: string[] = [];
    /** Repair mode: created columns the rollback couldn't remove; may show refused values until reopen. */
    leftover: string[] = [];
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

/** JSON with sorted keys and no `undefined`, so equal configs compare equal. */
export function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        return `{${Object.keys(obj).filter(k => obj[k] !== undefined).sort()
            .map(k => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

/** Same values from the same inputs? Compares kind, tag, trimmed formula or ordered sources + config; `customName` ignored. */
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

/** Formula tag -> sensors it reads, from Rust; the edited formula is asked separately so old and new reads stay apart. */
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
    const { recipes, next, oldTag, invoker, failureState, repair } = args;
    const labelOf: SensorLabelOf = args.labelOf ?? (tag => tag);
    if (repair && oldTag) throw new Error("A sensor that could not be restored can't be renamed while it is being fixed.");
    const newTag = next.tag;
    const identityTag = oldTag ?? next.tag;
    const removesOldColumn = !!oldTag && !sameTag(oldTag, newTag);

    let refsByTag: Map<string, string[]>;
    let nextRefs: string[];
    try {
        ({ refsByTag, nextRefs } = await readRefs(
            recipes,
            next.kind === 'formula' ? next.formula : null,
            invoker,
        ));
    } catch (err) {
        // Without the refs we can't find or rewrite dependents, and would drop the old column from under them: refuse.
        if (isSessionLostError(err)) throw err;
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

    // Decided in the read-only phase so a refused edit touches nothing; only renames and computation changes are refused.
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
                    : describeEditLock(lock, labelOf);
                throw new SpecialSensorLockedError(
                    lock.unknown
                        ? `Can't ${what} "${labelOf(originalEdited.tag)}" right now: ${why}.`
                        : `Can't ${what} "${labelOf(originalEdited.tag)}". ${why} (Its description, unit and component can still be edited.)`,
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
        throw new Error(`"${labelOf(next.tag)}" can't be built from ${conflicts.map(c => labelOf(c)).join(', ')} — that would make it depend on itself.`);
    }

    // Build order, whatever order the stored list happens to be in.
    const downstream = dependentsToRecompute(recipes, usage, identityTag, inputsOfStored);

    // Carry a rename into every downstream recipe BEFORE any of them replays.
    // Still read-only (a rewrite is text, not a column write).
    const renamedDownstream = oldTag
        ? await renameTagInRecipes(downstream, oldTag, newTag, invoker)
        : downstream;

    const done: SpecialSensorRecipe[] = [];
    let stillBroken: Array<{ tag: string; reason: string }> | undefined;
    try {
        if (repair) {
            stillBroken = await recomputeForRepair(next, renamedDownstream, repair, inputsOfStored, invoker, r => done.push(r), labelOf);
        } else {
            await recomputeSpecialSensors([next, ...renamedDownstream], invoker, r => done.push(r), labelOf);
        }
    } catch (err) {
        // Session no longer this edit's (stale generation or re-pointed window): touch nothing; let the caller say so.
        if (isSessionLostError(err)) throw err;
        const failure = new SpecialSensorEditError(err instanceof Error ? err.message : String(err));
        failure.touched = done.length > 0;
        if (done.length > 0 && repair) {
            await rollBackRepair(failure, done, [originalEdited, ...downstream], repair, invoker);
        } else if (done.length > 0) {
            const originals = [originalEdited, ...downstream].slice(0, done.length);
            const touchedTags = new Set([identityTag, ...downstream.map(r => r.tag)].map(key));
            try {
                await recomputeSpecialSensors(
                    originals.filter((r): r is SpecialSensorRecipe => !!r),
                    invoker,
                );
                failure.rolledBack = originals.every(r => !!r);
                if (!failure.rolledBack) failure.inconsistent = [identityTag];
            } catch (rollbackErr) {
                // The session went away mid-rollback: its columns are not ours any more.
                if (isSessionLostError(rollbackErr)) throw rollbackErr;
                // Targeted rollback failed: rebuild everything from the recipes (dependency order, replace: true) as a last resort.
                try {
                    const res = await replaySpecialSensorRecipes(recipes, invoker);
                    failure.inconsistent = [...res.failed, ...res.skipped].filter(t => touchedTags.has(key(t)));
                    failure.rolledBack = failure.inconsistent.length === 0;
                } catch (replayErr) {
                    if (isSessionLostError(replayErr)) throw replayErr;
                    failure.inconsistent = [...touchedTags].map(k => recipes.find(r => key(r.tag) === k)?.tag ?? k);
                }
            }
            // The renamed sensor's NEW column was created by the first write
            // and nothing will ever point at it now.
            if (removesOldColumn) {
                try {
                    await invoker('remove_sensor_columns', { names: [newTag] });
                } catch (removeErr) {
                    if (isSessionLostError(removeErr)) throw removeErr;
                }
            }
        }
        throw failure;
    }

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
        ...(stillBroken ? { stillBroken } : {}),
    };
}

/** The message of a failed recompute, without a leading "Error:". */
function reasonOf(err: unknown): string {
    const text = err instanceof Error ? err.message : String(err);
    return text.replace(/^Error:\s*/, '').trim() || 'its calculation could not be run';
}

/** Repair recompute: the edited sensor first (failure is fatal), then downstream in build order. One with no column before that still fails is recorded and skipped with its dependents; one that HAD a column is fatal. */
async function recomputeForRepair(
    next: SpecialSensorRecipe,
    downstream: SpecialSensorRecipe[],
    repair: { missingBefore: string[] },
    inputsOf: (r: SpecialSensorRecipe) => string[],
    invoker: Invoker,
    onRecomputed: (r: SpecialSensorRecipe) => void,
    labelOf: SensorLabelOf,
): Promise<Array<{ tag: string; reason: string }>> {
    await recomputeSpecialSensors([next], invoker, onRecomputed, labelOf);
    const hadNoColumn = new Set(repair.missingBefore.map(key));
    const broken = new Map<string, string>(); // key -> tag as written
    const stillBroken: Array<{ tag: string; reason: string }> = [];
    for (const recipe of downstream) {
        const blockedBy = inputsOf(recipe).find(input => broken.has(key(input)));
        if (blockedBy !== undefined && hadNoColumn.has(key(recipe.tag))) {
            stillBroken.push({ tag: recipe.tag, reason: `built on "${labelOf(broken.get(key(blockedBy)) ?? blockedBy)}", which still needs fixing` });
            broken.set(key(recipe.tag), recipe.tag);
            continue;
        }
        const { cmd, args } = recomputeCall(recipe);
        try {
            await invoker(cmd, args);
            onRecomputed(recipe);
        } catch (err) {
            if (isSessionLostError(err)) throw err;
            if (!hadNoColumn.has(key(recipe.tag))) {
                const failure = new Error(`Could not recompute "${labelOf(recipe.tag)}": ${String(err)}`);
                (failure as Error & { cause?: unknown }).cause = err;
                throw failure;
            }
            stillBroken.push({ tag: recipe.tag, reason: reasonOf(err) });
            broken.set(key(recipe.tag), recipe.tag);
        }
    }
    return stillBroken;
}

/** Undo a failed repair: remove columns it created (originals are known-bad), recompute overwritten ones in build order. */
async function rollBackRepair(
    failure: SpecialSensorEditError,
    done: SpecialSensorRecipe[],
    originals: Array<SpecialSensorRecipe | undefined>,
    repair: { missingBefore: string[] },
    invoker: Invoker,
): Promise<void> {
    const hadNoColumn = new Set(repair.missingBefore.map(key));
    const created = done.filter(r => hadNoColumn.has(key(r.tag))).map(r => r.tag);
    const overwritten = done
        .filter(r => !hadNoColumn.has(key(r.tag)))
        .map(r => ({ tag: r.tag, original: originals.find(o => !!o && sameTag(o.tag, r.tag)) }));
    let ok = true;
    if (overwritten.length > 0) {
        const restorable = overwritten.filter((o): o is { tag: string; original: SpecialSensorRecipe } => !!o.original);
        try {
            await recomputeSpecialSensors(restorable.map(o => o.original), invoker);
            if (restorable.length !== overwritten.length) {
                failure.inconsistent = overwritten.filter(o => !o.original).map(o => o.tag);
                ok = false;
            }
        } catch (err) {
            if (isSessionLostError(err)) throw err;
            failure.inconsistent = overwritten.map(o => o.tag);
            ok = false;
        }
    }
    if (created.length > 0) {
        try {
            await invoker('remove_sensor_columns', { names: created });
        } catch (err) {
            if (isSessionLostError(err)) throw err;
            failure.leftover = created;
            ok = false;
        }
    }
    failure.rolledBack = ok;
}
