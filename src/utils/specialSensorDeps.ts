import { FailureModel, SpecialSensorRecipe } from '../types';

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
 *   blocked  — another special sensor references it, or a Failure Group model
 *              references it in ANY of its seven sensor-bearing fields
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
 *  isn't per-model and so doesn't fit this array's shape. Deleting a special
 *  sensor the running-condition filter references is NOT currently blocked
 *  by this check — a known, scoped gap (flagged to the user), not an
 *  oversight. */
const MODEL_SENSOR_FIELDS = [
    { label: 'target sensor', read: (m: FailureModel) => [m.targetSensor] },
    { label: 'predictor', read: (m: FailureModel) => m.predictorSensors ?? [] },
    { label: 'X sensor', read: (m: FailureModel) => [m.xSensor] },
    { label: 'Y sensor', read: (m: FailureModel) => [m.ySensor] },
    { label: 'criteria sensor', read: (m: FailureModel) => [m.criteriaSensor] },
    { label: 'scatter X sensor', read: (m: FailureModel) => [m.scatterXSensor] },
] as const;

/** A Failure Group model that names the sensor, and the field it names it in. */
export interface ModelReference {
    modelId: string;
    modelName: string;
    /** Which of the seven fields — e.g. `target sensor`. */
    field: string;
}

export interface SpecialSensorUsage {
    /** The special sensor's tag, exactly as it appears in its recipe. */
    tag: string;
    /** Tags of OTHER special sensors built on top of this one. */
    dependentSensors: string[];
    /** Models that name this sensor. One model can appear twice under
     *  different fields — that is information, not a duplicate. */
    modelReferences: ModelReference[];
    /** Currently plotted on the dashboard chart. Never blocks a delete. */
    onChart: boolean;
    /** False exactly when `dependentSensors` or `modelReferences` is non-empty. */
    deletable: boolean;
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
    /** Sensors currently plotted on the chart. */
    selectedSensors: string[];
}): Map<string, SpecialSensorUsage> {
    const { recipes, formulaRefs, models, selectedSensors } = args;

    const usage = new Map<string, SpecialSensorUsage>();
    for (const recipe of recipes) {
        usage.set(key(recipe.tag), {
            tag: recipe.tag,
            dependentSensors: [],
            modelReferences: [],
            onChart: false,
            deletable: true,
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

    for (const sensor of selectedSensors) {
        const target = usage.get(key(sensor));
        if (target) target.onChart = true;
    }

    for (const entry of usage.values()) {
        entry.deletable = entry.dependentSensors.length === 0 && entry.modelReferences.length === 0;
    }

    return usage;
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
 * The result is drawn from `recipes` in array order, which is what makes it
 * safe to run straight through: a recipe can only reference sensors created
 * before it, so an earlier entry is never waiting on a later one. (This is the
 * same ordering guarantee the workspace-reopen replay relies on — see
 * `WorkspaceState.specialSensorRecipes`.)
 *
 * `tag` itself is not included; the caller recomputes it first.
 */
export function dependentsToRecompute(
    recipes: SpecialSensorRecipe[],
    usage: Map<string, SpecialSensorUsage>,
    tag: string,
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
    return recipes.filter(r => stale.has(key(r.tag)));
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
