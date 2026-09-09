import { FailureModel, SpecialSensorRecipe } from '../types';

/** Tag comparison is case-insensitive everywhere else this app matches a
 *  sensor tag (see `specialSensorDeps.ts`'s own `key()`), so it is here too. */
const key = (tag: string) => tag.trim().toLowerCase();

/**
 * Everything a special sensor's rename has to carry through, besides the
 * recipe/metadata pair itself (owned by `SpecialSensorEditor`/
 * `AddSensorWindow`'s save flow) — the flat arrays, tag-keyed records, and
 * Failure Group models scattered across `AddSensorWindow.tsx` and
 * `Dashboard.tsx` that name a sensor by its tag. Kept as small, focused pure
 * functions rather than one big "rename everywhere" helper so each call site
 * only touches the shape of state it actually owns.
 */

/** Rename every occurrence of `oldTag` inside a flat array of tags
 *  (`selectedSensors`, `visibleSensors`, `sensorHeaders`, ...). A no-op
 *  (same array reference) when `oldTag` isn't present. */
export function renameTagInArray(tags: string[], oldTag: string, newTag: string): string[] {
    const target = key(oldTag);
    if (!tags.some(t => key(t) === target)) return tags;
    return tags.map(t => (key(t) === target ? newTag : t));
}

/** Rename the key of a `Record<sensorTag, T>` map (`sensorColors`,
 *  `sensorAxisRange`, `alarmLinesEnabled`), preserving whatever value lived
 *  under the old key. A no-op if the old key isn't present. */
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

/**
 * Rename every occurrence of `oldTag` across a Failure Group model's seven
 * sensor-bearing fields (see `specialSensorDeps.ts`'s `MODEL_SENSOR_FIELDS`
 * for the read-only version of this same list — kept separate here because
 * each field needs a different write-back shape: scalar, flat array, or an
 * array of objects).
 */
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
        pmSensorFilters: (m.pmSensorFilters ?? []).map(f => (key(f.sensor) === target ? { ...f, sensor: newTag } : f)),
    }));
}

/**
 * Rename every reference to `oldTag` inside a list of OTHER special sensor
 * recipes — a formula-kind recipe's `$oldTag`/`${oldTag}` reference (via the
 * Rust `rename_formula_refs` command, which reuses the same tokenizer
 * `extract_formula_refs` does, so a name that's a prefix of another one
 * can't get corrupted), or an operation-kind recipe's `sourceSensors` entry
 * (a plain string, swapped directly). A recipe that doesn't reference
 * `oldTag` at all comes back as the SAME object reference, so callers can
 * tell nothing changed for it without a deep-equal check.
 */
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
