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

/** One place a `FailureModel` can name a sensor, and what to call it in the UI. */
const MODEL_SENSOR_FIELDS = [
    { label: 'target sensor', read: (m: FailureModel) => [m.targetSensor] },
    { label: 'predictor', read: (m: FailureModel) => m.predictorSensors ?? [] },
    { label: 'X sensor', read: (m: FailureModel) => [m.xSensor] },
    { label: 'Y sensor', read: (m: FailureModel) => [m.ySensor] },
    { label: 'criteria sensor', read: (m: FailureModel) => [m.criteriaSensor] },
    { label: 'scatter X sensor', read: (m: FailureModel) => [m.scatterXSensor] },
    { label: 'PM filter', read: (m: FailureModel) => (m.pmSensorFilters ?? []).map(f => f.sensor) },
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
