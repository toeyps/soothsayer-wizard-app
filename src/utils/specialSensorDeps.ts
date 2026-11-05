import { FailureModel, ModelKind, SpecialSensorRecipe } from '../types';
import { MODEL_KIND_LABEL } from './modelNames';

/** Who still depends on a special sensor, deciding whether Manage Special Sensors lets you delete it. Blocked by another special sensor, a model's sensor field (incl. its Custom condition) or the workspace Running condition. */

/** One place a `FailureModel` names a sensor, with its UI label (the workspace condition list is passed separately). Rust silently DROPS a condition on a missing sensor: a deleted one still named there would change training rows unseen. */
const MODEL_SENSOR_FIELDS = [
    { label: 'target sensor', read: (m: FailureModel) => [m.targetSensor] },
    { label: 'predictor', read: (m: FailureModel) => m.predictorSensors ?? [] },
    { label: 'X sensor', read: (m: FailureModel) => [m.xSensor] },
    { label: 'Y sensor', read: (m: FailureModel) => [m.ySensor] },
    { label: 'criteria sensor', read: (m: FailureModel) => [m.criteriaSensor] },
    { label: 'scatter X sensor', read: (m: FailureModel) => [m.scatterXSensor] },
    // Kept even in 'workspace' mode: the list is persisted and returns when the user switches to Custom.
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

/** Whether a special sensor may still be edited; locked when a model or the workspace Running condition names it, or a special sensor built on it is itself used (one built on only by an UNUSED one is not). `unknown` locks everything. */
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

/** Tags compare trimmed and case-insensitively, as elsewhere; otherwise `Temp Diff` and `temp diff` would hide a dependency. */
const key = (tag: string) => tag.trim().toLowerCase();

/** Sensors a recipe reads: operations store them; formulas use `extract_formula_refs` output as `formulaRefs`, keyed by tag. Never `formula.includes(tag)`: with `test` and `test extend`, a formula using only the second would depend on `test`. */
function recipeInputs(
    recipe: SpecialSensorRecipe,
    formulaRefs: Map<string, string[]>,
): string[] {
    if (recipe.kind === 'operation') return recipe.sourceSensors ?? [];
    return formulaRefs.get(key(recipe.tag)) ?? [];
}

/** For every special sensor, what still depends on it. A tag missing from `formulaRefs` references nothing, so a pending lookup under-reports: offer no deletion until it returns. */
export function buildSpecialSensorUsage(args: {
    recipes: SpecialSensorRecipe[];
    formulaRefs: Map<string, string[]>;
    models: FailureModel[];
    /** The workspace-wide Running condition's conditions
     *  (`failureGroupState.runningConditionFilters`). Omitted = none. */
    runningConditionFilters?: Array<{ sensor: string }>;
    /** Sensors currently plotted on the chart. */
    selectedSensors: string[];
    /** False when `models`/`runningConditionFilters`/`formulaRefs` aren't known fresh: every `editLock` is then locked + unknown. Default true. */
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

    // special -> special. Only references BETWEEN special sensors matter; a raw CSV column isn't a deletable dependency.
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

    // Edit lock: direct uses first (model references grouped per model),
    // then the transitive part: walk everything built on a sensor, collecting downstream sensors that are used.
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

/** How a message prints a sensor (description first, then tag), e.g. `tag => sensorPlainLabel(lookup(tag))`. */
export type SensorLabelOf = (tag: string) => string;

/** The kind names of the lock sentence — the app-wide ones ("Relation model"). */
const KIND_LABEL = MODEL_KIND_LABEL;

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

/** "2 models: A (Individual, Relation model), B (Clustering)" and/or "the running condition". */
function describeSource(src: EditLockSource): string {
    const parts: string[] = [];
    if (src.models.length > 0) {
        const n = new Set(src.models.map(m => m.modelId)).size;
        parts.push(`${n} model${n > 1 ? 's' : ''}: ${listModels(src.models)}`);
    }
    if (src.runningCondition) parts.push('the running condition');
    return parts.join(' and ');
}

/** Plain-language reason a sensor's name/formula/sources are locked (Manage list, edit refusal); '' when not locked. */
export function describeEditLock(lock: EditLock, labelOf: SensorLabelOf = tag => tag): string {
    if (!lock.locked) return '';
    if (lock.unknown) {
        return 'Still checking what uses this sensor, so its name, formula and sources are held back for now.';
    }
    const sentences: string[] = [];
    if (isUsed(lock.direct)) sentences.push(`Used by ${describeSource(lock.direct)}.`);
    for (const v of lock.via) {
        sentences.push(`Built on by "${labelOf(v.tag)}", which is used by ${describeSource(v)}.`);
    }
    const subjects: string[] = [];
    if (isUsed(lock.direct)) subjects.push('it');
    for (const v of lock.via) subjects.push(`"${labelOf(v.tag)}"`);
    const all = [lock.direct, ...lock.via];
    const hasModels = all.some(s => s.models.length > 0);
    const hasRc = all.some(s => s.runningCondition);
    const where = hasModels && hasRc ? 'those models and the running condition'
        : hasRc ? 'the running condition'
            : 'those models';
    sentences.push(`Remove ${subjects.join(' and ')} from ${where} first, then you can edit it.`);
    return sentences.join(' ');
}

/** Special sensors with no Rust session column: `failed` = own recipe can't be computed (fix THIS recipe), `skipped` = built on one with no column (returns when that is fixed). Decided from `get_all_sensors`. */
export interface UnrestoredSpecialSensors {
    failed: string[];
    skipped: string[];
}

export function findUnrestoredSpecialSensors(args: {
    recipes: SpecialSensorRecipe[];
    sessionColumns: string[];
    formulaRefs: Map<string, string[]>;
}): UnrestoredSpecialSensors {
    const { recipes, sessionColumns, formulaRefs } = args;
    const present = new Set(sessionColumns.map(key));
    const missing = new Set(recipes.filter(r => !present.has(key(r.tag))).map(r => key(r.tag)));
    const failed: string[] = [];
    const skipped: string[] = [];
    for (const recipe of recipes) {
        if (!missing.has(key(recipe.tag))) continue;
        const blocked = recipeInputs(recipe, formulaRefs)
            .some(input => key(input) !== key(recipe.tag) && missing.has(key(input)));
        (blocked ? skipped : failed).push(recipe.tag);
    }
    return { failed, skipped };
}

/** Look up one sensor's usage, tolerating case differences in the tag. */
export function usageFor(
    usage: Map<string, SpecialSensorUsage>,
    tag: string,
): SpecialSensorUsage | undefined {
    return usage.get(key(tag));
}

/** Everything to recompute after `tag`'s recipe changes: the whole downstream chain, not just direct dependents; `tag` excluded. Follows `recipes` array order, possibly not a valid build order in old workspaces; pass `inputsOf` to sort it. */
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

/** Which of `nextInputs` would make `tag` depend on itself; returns the offending names (empty = safe). An edit can close a loop creating never could (`B = $A + 1`, then A edited to `${B} * 2`), so it's refused at edit time. */
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

/** Orders recipes so each comes after the special sensors it reads; stable, changes nothing already valid, raw columns ignored. Editing can break the reopen replay (A reads later-created C); a cycle (see `cycleConflicts`) keeps the original order. */
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

/** Re-sequences `recipes` by `order` (tags): unlisted ones follow in their order, unknown tags are ignored. */
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
