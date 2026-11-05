import { FailureModel, SpecialSensorRecipe } from '../types';

/** Tag comparison is case-insensitive, as in `specialSensorDeps.ts`'s `key()`. */
const key = (tag: string) => tag.trim().toLowerCase();

/** Carry a special sensor's rename through state that names sensors by tag: arrays, tag-keyed records, Failure Group models. Small pure functions so each call site touches only the state it owns. */

/** Rename `oldTag` in a flat tag array; returns the same array reference when absent. */
export function renameTagInArray(tags: string[], oldTag: string, newTag: string): string[] {
    const target = key(oldTag);
    if (!tags.some(t => key(t) === target)) return tags;
    return tags.map(t => (key(t) === target ? newTag : t));
}

/** Rename a key of a `Record<sensorTag, T>`, keeping its value; no-op if the key is absent. */
export function renameTagInRecord<T>(record: Record<string, T>, oldTag: string, newTag: string): Record<string, T> {
    const target = key(oldTag);
    const foundKey = Object.keys(record).find(k => key(k) === target);
    if (foundKey === undefined) return record;
    const next = { ...record };
    const value = next[foundKey];
    delete next[foundKey];
    next[newTag] = value;
    return next;
}

/** Rename `oldTag` across a model's sensor-bearing fields, including `customRunningConditionFilters`. Mirrors `MODEL_SENSOR_FIELDS` in specialSensorDeps.ts; separate because each field has its own write-back shape. */
export function renameTagInModels(models: FailureModel[], oldTag: string, newTag: string): FailureModel[] {
    const target = key(oldTag);
    const swap = (s: string) => (s && key(s) === target ? newTag : s);
    return models.map(m => ({
        ...m,
        targetSensor: swap(m.targetSensor),
        predictorSensors: (m.predictorSensors ?? []).map(swap),
        xSensor: swap(m.xSensor),
        ySensor: swap(m.ySensor),
        criteriaSensor: swap(m.criteriaSensor),
        scatterXSensor: swap(m.scatterXSensor),
        customRunningConditionFilters: (m.customRunningConditionFilters ?? []).map(f =>
            f.sensor && key(f.sensor) === target ? { ...f, sensor: newTag } : f,
        ),
    }));
}

/** Rename `oldTag` in the workspace running-condition filter; also used to re-key the Dashboard Filter tab. Rust silently drops a condition on an unknown sensor, so a stale tag would turn the filter off with no sign. */
export function renameTagInRunningConditionFilters<T extends { sensor: string }>(
    filters: T[],
    oldTag: string,
    newTag: string,
): T[] {
    const target = key(oldTag);
    if (!filters.some(f => key(f.sensor) === target)) return filters;
    return filters.map(f => (key(f.sensor) === target ? { ...f, sensor: newTag } : f));
}

/** Drop conditions naming a deleted special sensor (same case/space-insensitive match); same array when nothing matches. Filter-tab conditions don't block a delete, but Rust would ignore one on a gone column while the tab showed it applied. */
export function removeTagsFromFilters<T extends { sensor: string }>(filters: T[], tags: string[]): T[] {
    const gone = new Set(tags.map(key));
    if (!filters.some(f => gone.has(key(f.sensor)))) return filters;
    return filters.filter(f => !gone.has(key(f.sensor)));
}

/** Rename references to `oldTag` in other recipes: formulas via Rust `rename_formula_refs`, operations via `sourceSensors`. Same tokenizer as `extract_formula_refs`, so prefix names aren't corrupted. An unaffected recipe comes back as the same object. */
export async function renameTagInRecipes(
    recipes: SpecialSensorRecipe[],
    oldTag: string,
    newTag: string,
    invoker: (cmd: string, args: Record<string, unknown>) => Promise<unknown>,
): Promise<SpecialSensorRecipe[]> {
    return Promise.all(
        recipes.map(async (recipe): Promise<SpecialSensorRecipe> => {
            if (recipe.kind === 'formula') {
                const rewritten = (await invoker('rename_formula_refs', {
                    formula: recipe.formula,
                    oldName: oldTag,
                    newName: newTag,
                })) as string;
                return rewritten === recipe.formula ? recipe : { ...recipe, formula: rewritten };
            }
            const target = key(oldTag);
            if (!recipe.sourceSensors.some(s => key(s) === target)) return recipe;
            return { ...recipe, sourceSensors: recipe.sourceSensors.map(s => (key(s) === target ? newTag : s)) };
        }),
    );
}
