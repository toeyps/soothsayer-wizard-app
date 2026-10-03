import { FailureModel, ModelKind, SpecialSensorRecipe } from '../types';

/**
 * Who still depends on a special sensor — the check that decides whether
 * "Manage Special Sensors" lets you delete it.
 *
 * Deleting a special sensor that something else was built on top of leaves a
 * dangling reference behind: a formula that can no longer resolve `$name`, or
 * a model whose target sensor simply isn't in the data any more. Neither
 * fails loudly, so the rule (confirmed with the user) is to block the delete
 * up front rather than cascade or repair afterwards.
 *
 *   blocked  — another special sensor references it, a Failure Group model
 *              references it in ANY of its sensor-bearing fields (including a
 *              model's own Custom running condition), or the workspace-wide
 *              Running condition filter names it
 *   allowed  — merely plotted on the chart, or unused entirely
 *
 * Plotting is deliberately not a blocker: the sensor is just removed from the
 * chart along with the delete.
 */

/** One place a `FailureModel` can name a sensor, and what to call it in the UI.
 *
 *  2026-09-15: the old "PM filter" field (`pmSensorFilters`, per-model) was
 *  removed here — that concept moved to a single workspace-wide
 *  `runningConditionFilters` list (see `FailureGroupStateSlice`), which
 *  isn't per-model and so doesn't fit this array's shape.
 *
 *  2026-10-03: that gap is closed. The workspace list is passed to
 *  `buildSpecialSensorUsage` separately (`runningConditionFilters`), and a
 *  model's own Custom running-condition conditions are a field below. Rust
 *  silently DROPS a condition on a sensor that no longer exists, so a deleted
 *  special sensor still named there would make every model train on different
 *  rows without any error. */
const MODEL_SENSOR_FIELDS = [
    { label: 'target sensor', read: (m: FailureModel) => [m.targetSensor] },
    { label: 'predictor', read: (m: FailureModel) => m.predictorSensors ?? [] },
    { label: 'X sensor', read: (m: FailureModel) => [m.xSensor] },
    { label: 'Y sensor', read: (m: FailureModel) => [m.ySensor] },
    { label: 'criteria sensor', read: (m: FailureModel) => [m.criteriaSensor] },
    { label: 'scatter X sensor', read: (m: FailureModel) => [m.scatterXSensor] },
    // Kept even when the model is currently in 'workspace' mode: the list is
    // persisted and comes back the moment the user switches to Custom.
    { label: 'custom running condition', read: (m: FailureModel) => (m.customRunningConditionFilters ?? []).map(f => f.sensor) },
] as const;

/** A Failure Group model that names the sensor, and the field it names it in. */
export interface ModelReference {
    modelId: string;
    modelName: string;
    /** Which field — e.g. `target sensor`, `custom running condition`. */
    field: string;
}

/** One model that names a special sensor, with every field it names it in. */
export interface LockedModelUse {
    modelId: string;
    modelName: string;
    kind: ModelKind;
    /** e.g. `target sensor`, `predictor`, `custom running condition`. */
    fields: string[];
}

/** Who uses ONE sensor directly: models and/or the workspace Running condition. */
export interface EditLockSource {
    models: LockedModelUse[];
    runningCondition: boolean;
}

/**
 * Whether a special sensor may still be edited.
 *
 * 2026-10-03 decision (user): a special sensor used by a model is LOCKED --
 * its values and its name are frozen, because a Trained / Complete model that
 * was built from it goes stale (and the saved results / health-score input
 * become wrong) if either changes underneath it. This replaces the earlier
 * idea of putting special-sensor formulas into the train fingerprint:
 * prevention instead of detection.
 *
 * Locked when ANY of:
 *   - a model names it (any field `MODEL_SENSOR_FIELDS` lists, incl. a model's
 *     own Custom running condition),
 *   - the workspace Running condition names it (a changed sensor changes which
 *     rows EVERY model trains on),
 *   - transitively: a special sensor built on it (directly, or through other
 *     special sensors) is itself used by a model / the Running condition --
 *     changing this one changes that one's values.
 * A sensor that is merely built on by an UNUSED special sensor is not locked
 * (editing it already recomputes everything downstream).
 *
 * `unknown` means the models / references could not be read fresh: everything
 * is then treated as locked, because "nothing uses it" would be a guess.
 */
export interface EditLock {
    locked: boolean;
    unknown: boolean;
    /** Uses of this very sensor. */
    direct: EditLockSource;
    /** Downstream special sensors that are themselves used (the transitive part). */
    via: Array<EditLockSource & { tag: string }>;
}

export interface SpecialSensorUsage {
    /** The special sensor's tag, exactly as it appears in its recipe. */
    tag: string;
    /** Tags of OTHER special sensors built on top of this one. */
    dependentSensors: string[];
    /** Models that name this sensor. One model can appear twice under
     *  different fields — that is information, not a duplicate. */
    modelReferences: ModelReference[];
    /** Named by a condition of the workspace-wide Running condition filter. */
    runningCondition: boolean;
    /** Currently plotted on the dashboard chart. Never blocks a delete. */
    onChart: boolean;
    /** False exactly when `dependentSensors` or `modelReferences` is non-empty,
     *  or `runningCondition` is set. */
    deletable: boolean;
    /** Whether renaming / changing the values of this sensor is refused. */
    editLock: EditLock;
}

/** Tag comparison is case-insensitive everywhere else in the app (see the
 *  `byTag` maps in Dashboard's `add-sensor-selection` handler), so it is here
 *  too — otherwise `Temp Diff` and `temp diff` would count as two sensors and
 *  a dependency could hide in the gap between them. */
const key = (tag: string) => tag.trim().toLowerCase();

/**
 * Sensors that a recipe is built from.
 *
 * For an operation recipe the inputs are stored directly. For a formula they
 * have to be parsed out of the expression, which is Rust's job: the
 * `extract_formula_refs` command reuses the same parser the evaluator uses.
 * Pass its result in as `formulaRefs`, keyed by the recipe's tag.
 *
 * Do NOT substitute `formula.includes(tag)` for that call — with sensors named
 * `test` and `test extend`, a formula referencing only the second one reports
 * a dependency on the first, and `test` becomes permanently undeletable.
 */
function recipeInputs(
    recipe: SpecialSensorRecipe,
    formulaRefs: Map<string, string[]>,
): string[] {
    if (recipe.kind === 'operation') return recipe.sourceSensors ?? [];
    return formulaRefs.get(key(recipe.tag)) ?? [];
}

/**
 * Work out, for every special sensor, what still depends on it.
 *
 * `formulaRefs` maps a formula recipe's tag to the sensors its expression
 * references (from `extract_formula_refs`). A tag missing from the map is
 * treated as referencing nothing — so a failed or not-yet-finished lookup
 * under-reports dependencies rather than inventing them. Callers must
 * therefore not offer deletion until the lookup has actually returned.
 */
export function buildSpecialSensorUsage(args: {
    recipes: SpecialSensorRecipe[];
    formulaRefs: Map<string, string[]>;
    models: FailureModel[];
    /** The workspace-wide Running condition's conditions
     *  (`failureGroupState.runningConditionFilters`). Omitted = none. */
    runningConditionFilters?: Array<{ sensor: string }>;
    /** Sensors currently plotted on the chart. */
    selectedSensors: string[];
    /** False when `models` / `runningConditionFilters` / `formulaRefs` are not
     *  known fresh: every sensor's `editLock` is then locked + unknown.
     *  Default true. */
    failureKnown?: boolean;
}): Map<string, SpecialSensorUsage> {
    const { recipes, formulaRefs, models, selectedSensors, runningConditionFilters } = args;
    const failureKnown = args.failureKnown ?? true;

    const usage = new Map<string, SpecialSensorUsage>();
    for (const recipe of recipes) {
        usage.set(key(recipe.tag), {
            tag: recipe.tag,
            dependentSensors: [],
            modelReferences: [],
            runningCondition: false,
            onChart: false,
            deletable: true,
            editLock: { locked: false, unknown: false, direct: { models: [], runningCondition: false }, via: [] },
        });
    }

    // special -> special. Only references BETWEEN special sensors matter: a
    // recipe naming a raw CSV column is not a dependency anyone can delete.
    for (const recipe of recipes) {
        for (const input of recipeInputs(recipe, formulaRefs)) {
            const target = usage.get(key(input));
            if (!target) continue;
            if (key(input) === key(recipe.tag)) continue;
            if (!target.dependentSensors.includes(recipe.tag)) {
                target.dependentSensors.push(recipe.tag);
            }
        }
    }

    // model -> special, across every field a model can name a sensor in.
    for (const model of models) {
        for (const field of MODEL_SENSOR_FIELDS) {
            for (const sensor of field.read(model)) {
                if (!sensor) continue;
                const target = usage.get(key(sensor));
                if (!target) continue;
                const already = target.modelReferences.some(
                    r => r.modelId === model.id && r.field === field.label,
                );
                if (already) continue;
                target.modelReferences.push({
                    modelId: model.id,
                    modelName: model.name,
                    field: field.label,
                });
            }
        }
    }

    // workspace Running condition -> special.
    for (const filter of runningConditionFilters ?? []) {
        if (!filter?.sensor) continue;
        const target = usage.get(key(filter.sensor));
        if (target) target.runningCondition = true;
    }

    for (const sensor of selectedSensors) {
        const target = usage.get(key(sensor));
        if (target) target.onChart = true;
    }

    for (const entry of usage.values()) {
        entry.deletable = entry.dependentSensors.length === 0
            && entry.modelReferences.length === 0
            && !entry.runningCondition;
    }

    // Edit lock. Direct uses first (model references grouped per model), then
    // the transitive part: walk everything built on a sensor, collecting the
    // downstream sensors that are used themselves.
    const modelById = new Map(models.map(m => [m.id, m]));
    const directOf = (entry: SpecialSensorUsage): EditLockSource => {
        const byModel = new Map<string, LockedModelUse>();
        for (const ref of entry.modelReferences) {
            const existing = byModel.get(ref.modelId);
            if (existing) {
                if (!existing.fields.includes(ref.field)) existing.fields.push(ref.field);
            } else {
                byModel.set(ref.modelId, {
                    modelId: ref.modelId,
                    modelName: ref.modelName,
                    kind: modelById.get(ref.modelId)?.kind ?? 'individual',
                    fields: [ref.field],
                });
            }
        }
        return { models: [...byModel.values()], runningCondition: entry.runningCondition };
    };

    for (const entry of usage.values()) {
        const direct = directOf(entry);
        const via: EditLock['via'] = [];
        const seen = new Set<string>([key(entry.tag)]);
        const queue = [...entry.dependentSensors];
        while (queue.length > 0) {
            const next = queue.shift()!;
            if (seen.has(key(next))) continue;
            seen.add(key(next));
            const downstream = usage.get(key(next));
            if (!downstream) continue;
            const src = directOf(downstream);
            if (isUsed(src)) via.push({ tag: downstream.tag, ...src });
            queue.push(...downstream.dependentSensors);
        }
        entry.editLock = {
            locked: !failureKnown || isUsed(direct) || via.length > 0,
            unknown: !failureKnown,
            direct,
            via,
        };
    }

    return usage;
}

function isUsed(src: EditLockSource): boolean {
    return src.models.length > 0 || src.runningCondition;
}

const KIND_LABEL: Record<ModelKind, string> = {
    individual: 'Individual',
    relationship: 'Relationship',
    clustering: 'Clustering',
};

/** `Name (Kind, Kind)` per distinct model name; the first few, then "and N more". */
function listModels(models: LockedModelUse[]): string {
    const byName = new Map<string, string[]>();
    for (const m of models) {
        const name = m.modelName?.trim() || 'Untitled model';
        const kinds = byName.get(name) ?? [];
        const label = KIND_LABEL[m.kind] ?? m.kind;
        if (!kinds.includes(label)) kinds.push(label);
        byName.set(name, kinds);
    }
    const entries = [...byName.entries()].map(([name, kinds]) => `${name} (${kinds.join(', ')})`);
    const MAX = 3;
    return entries.length <= MAX
        ? entries.join(', ')
        : `${entries.slice(0, MAX).join(', ')} and ${entries.length - MAX} more`;
}

/** "2 models: A (Individual, Relationship), B (Clustering)" and/or "the running condition". */
function describeSource(src: EditLockSource): string {
    const parts: string[] = [];
    if (src.models.length > 0) {
        const n = new Set(src.models.map(m => m.modelId)).size;
        parts.push(`${n} model${n > 1 ? 's' : ''}: ${listModels(src.models)}`);
    }
    if (src.runningCondition) parts.push('the running condition');
    return parts.join(' and ');
}

/**
 * The plain-language reason a sensor's name / formula / sources are locked --
 * shown in Manage and used as the refusal message of a refused edit.
 * Empty string when the sensor is not locked.
 */
export function describeEditLock(lock: EditLock): string {
    if (!lock.locked) return '';
    if (lock.unknown) {
        return 'Still checking what uses this sensor, so its name, formula and sources are held back for now.';
    }
    const sentences: string[] = [];
    if (isUsed(lock.direct)) sentences.push(`Used by ${describeSource(lock.direct)}.`);
    for (const v of lock.via) {
        sentences.push(`Built on by "${v.tag}", which is used by ${describeSource(v)}.`);
    }
    const subjects: string[] = [];
    if (isUsed(lock.direct)) subjects.push('it');
    for (const v of lock.via) subjects.push(`"${v.tag}"`);
    const all = [lock.direct, ...lock.via];
    const hasModels = all.some(s => s.models.length > 0);
    const hasRc = all.some(s => s.runningCondition);
    const where = hasModels && hasRc ? 'those models and the running condition'
        : hasRc ? 'the running condition'
            : 'those models';
    sentences.push(`Remove ${subjects.join(' and ')} from ${where} first, then you can edit it.`);
    return sentences.join(' ');
}

/** Look up one sensor's usage, tolerating case differences in the tag. */
export function usageFor(
    usage: Map<string, SpecialSensorUsage>,
    tag: string,
): SpecialSensorUsage | undefined {
    return usage.get(key(tag));
}

/**
 * Everything that has to be recomputed after `tag`'s recipe changes, in the
 * order it must be recomputed in.
 *
 * Editing a special sensor is not a local change: a sensor built on top of it
 * was computed from its OLD values and is stale the moment it is saved. So the
 * edit has to be followed by replaying the whole downstream chain — not just
 * the direct dependents, since those have dependents of their own.
 *
 * The result is drawn from `recipes` in array order. That is only a valid
 * build order when the stored list is one -- which a workspace saved before the
 * ordering fix (2026-10-03) may not be (`[C=$B*10, B=${A}+1, A=...]`: C would be
 * recomputed from B's OLD values). Pass `inputsOf` (what each recipe reads) and
 * the result is put in dependency order (`orderRecipesByDependency`) before it
 * is returned, whatever order the list is stored in.
 *
 * `tag` itself is not included; the caller recomputes it first.
 */
export function dependentsToRecompute(
    recipes: SpecialSensorRecipe[],
    usage: Map<string, SpecialSensorUsage>,
    tag: string,
    inputsOf?: (recipe: SpecialSensorRecipe) => string[],
): SpecialSensorRecipe[] {
    const stale = new Set<string>();
    const queue = [key(tag)];
    while (queue.length > 0) {
        const current = queue.shift()!;
        for (const dependent of usage.get(current)?.dependentSensors ?? []) {
            if (stale.has(key(dependent))) continue;
            stale.add(key(dependent));
            queue.push(key(dependent));
        }
    }
    const downstream = recipes.filter(r => stale.has(key(r.tag)));
    return inputsOf ? orderRecipesByDependency(downstream, inputsOf) : downstream;
}

/**
 * Which of `nextInputs` would make `tag` depend on itself.
 *
 * An edit can introduce a cycle that creating never could: `B = $A + 1` is
 * fine, but then editing A to read `${B} * 2` closes the loop. Nothing in the
 * app would catch that later — the recipes would simply replay in order on the
 * next workspace open, each reading whatever stale column happened to be
 * there — so it has to be refused at the point of editing.
 *
 * Returns the offending input names (empty when the edit is safe), so the UI
 * can name them rather than just saying no.
 */
export function cycleConflicts(
    recipes: SpecialSensorRecipe[],
    usage: Map<string, SpecialSensorUsage>,
    tag: string,
    nextInputs: string[],
): string[] {
    const forbidden = new Set<string>([key(tag)]);
    for (const r of dependentsToRecompute(recipes, usage, tag)) forbidden.add(key(r.tag));

    const seen = new Set<string>();
    return nextInputs.filter(input => {
        if (!forbidden.has(key(input)) || seen.has(key(input))) return false;
        seen.add(key(input));
        return true;
    });
}

/**
 * Put recipes in an order where every recipe comes AFTER the special sensors
 * it is built from, changing nothing that is already in a valid order.
 *
 * The workspace-reopen replay runs recipes in array order, so the array must
 * always be a valid build order. Creating a sensor keeps it (the new recipe
 * lands last and only reads sensors that already exist), but EDITING can break
 * it: pointing an early sensor at one created later (`A` was `$raw * 2`, now
 * `$C + 1` with `C` further down the list) is allowed -- both columns exist in
 * the live session -- yet on the next open `A` would replay before `C` exists.
 *
 * Stable: repeatedly takes the first not-yet-placed recipe whose special-sensor
 * inputs are all placed. Inputs naming raw columns are ignored. A cycle (which
 * `cycleConflicts` refuses before it can be saved) falls back to the original
 * relative order for whatever is left, rather than dropping recipes.
 *
 * `inputsOf` answers what a recipe reads -- for formulas that is Rust's
 * `extract_formula_refs`, for operations its `sourceSensors`.
 */
export function orderRecipesByDependency(
    recipes: SpecialSensorRecipe[],
    inputsOf: (recipe: SpecialSensorRecipe) => string[],
): SpecialSensorRecipe[] {
    const special = new Set(recipes.map(r => key(r.tag)));
    const placed = new Set<string>();
    const remaining = [...recipes];
    const ordered: SpecialSensorRecipe[] = [];

    while (remaining.length > 0) {
        const idx = remaining.findIndex(r =>
            inputsOf(r).every(input => {
                const k = key(input);
                return !special.has(k) || k === key(r.tag) || placed.has(k);
            }),
        );
        if (idx === -1) {
            ordered.push(...remaining);
            break;
        }
        const [next] = remaining.splice(idx, 1);
        placed.add(key(next.tag));
        ordered.push(next);
    }
    return ordered;
}

/**
 * Re-sequence `recipes` to follow `order` (a list of tags). Tags missing from
 * `order` keep their relative order after the listed ones; tags in `order`
 * that match no recipe are ignored. Used by the Dashboard to apply the order
 * the Add Sensor window worked out after an edit.
 */
export function reorderRecipesByTags(
    recipes: SpecialSensorRecipe[],
    order: string[] | undefined,
): SpecialSensorRecipe[] {
    if (!order || order.length === 0) return recipes;
    const rank = new Map(order.map((tag, i) => [key(tag), i]));
    const listed = recipes.filter(r => rank.has(key(r.tag)));
    const unlisted = recipes.filter(r => !rank.has(key(r.tag)));
    listed.sort((a, b) => rank.get(key(a.tag))! - rank.get(key(b.tag))!);
    return [...listed, ...unlisted];
}
