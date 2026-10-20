import type { FailureModel, ModelCategory, ModelKind } from '../types';
import { modelSensorKey } from './modelGrouping';

/**
 * THE kind names a user reads, in every window (Dashboard sheet, Failure Groups
 * tab, Build Model tabs / Train menu / run strip, special-sensor lock sentences,
 * suggested model names): Individual / Relation model / Clustering. The whole
 * app says "Relation model", never "Relationship" — and
 * never the algorithm name. `UserFacingWording.test.ts` guards it.
 * DISPLAY ONLY: the kind VALUE stays `'relationship'` (types, saved workspaces,
 * wire values, fingerprints).
 */
export const MODEL_KIND_LABEL: Record<ModelKind, string> = {
    individual: 'Individual',
    relationship: 'Relation model',
    clustering: 'Clustering',
};

/** A kind inside a sentence: "Individual model", "Relation model", "Clustering model"
 *  (the Relation model's label already ends in "model" — never "Relation model model"). */
export const kindModelName = (kind: ModelKind): string =>
    (kind === 'relationship' ? MODEL_KIND_LABEL[kind] : `${MODEL_KIND_LABEL[kind]} model`);

/**
 * The kind word a suggested name carried in older workspaces, per kind — only
 * where it differs from today's. Such a workspace still holds names like
 * "Pump (Relationship)": they are the user's data (and their export file names),
 * so they are never rewritten — but a new suggestion must not land next to one as
 * its twin "Pump (Relation model)".
 */
const LEGACY_KIND_WORD: Partial<Record<ModelKind, string>> = {
    relationship: 'Relationship',
};

const norm = (s: string): string => s.trim().toLowerCase();

/**
 * Another model of the SAME sensor (workspace-wide, `modelSensorKey`) whose
 * trimmed, case-insensitive name equals `name`, or null. Empty names and
 * models with no key sensor yet never conflict. The model itself is skipped.
 *
 * Exact text only, on purpose: "X (Relationship)" (a name in an older
 * workspace) and "X (Relation model)" are two different names
 * here, so no saved workspace is blocked by it.
 */
export function findSameSensorNameConflict(
    models: FailureModel[],
    model: Pick<FailureModel, 'id' | 'kind' | 'targetSensor' | 'xSensor'>,
    name: string,
): FailureModel | null {
    const n = norm(name);
    const key = modelSensorKey(model);
    if (n === '' || key === '') return null;
    return models.find(m => m.id !== model.id && modelSensorKey(m) === key && norm(m.name ?? '') === n) ?? null;
}

/**
 * "<name> (<Kind>)", then "<name> (<Kind>) 2", 3 … until no same-sensor model uses it.
 *
 * A candidate also counts as used when a same-sensor model holds its LEGACY
 * spelling ("<name> (Relationship)" for "<name> (Relation model)", same counter):
 * the two would read as one model to the user, so the counter moves on.
 */
export function suggestDistinctModelName(
    models: FailureModel[],
    model: Pick<FailureModel, 'id' | 'kind' | 'targetSensor' | 'xSensor'>,
    name: string,
): string {
    const trimmed = name.trim();
    const base = `${trimmed} (${MODEL_KIND_LABEL[model.kind]})`;
    const legacyWord = LEGACY_KIND_WORD[model.kind];
    const legacyBase = legacyWord ? `${trimmed} (${legacyWord})` : null;
    const taken = (suffix: string): boolean =>
        findSameSensorNameConflict(models, model, `${base}${suffix}`) !== null
        || (legacyBase !== null && findSameSensorNameConflict(models, model, `${legacyBase}${suffix}`) !== null);
    let suffix = '';
    for (let i = 2; taken(suffix); i++) suffix = ` ${i}`;
    return `${base}${suffix}`;
}

/**
 * Another model of the WORKSPACE — any sensor, any kind — whose trimmed,
 * case-insensitive name equals `name`, or null. The model itself is skipped
 * and an empty name never conflicts. Model names must be unique across the
 * project because the export writes each one as the model's display name.
 */
export function findWorkspaceNameTwin(
    models: readonly FailureModel[],
    model: Pick<FailureModel, 'id'>,
    name: string,
): FailureModel | null {
    const n = norm(name);
    if (n === '') return null;
    return models.find(m => m.id !== model.id && norm(m.name ?? '') === n) ?? null;
}

/** Why Save is blocked when the name is a workspace twin (`findWorkspaceNameTwin`). */
export const WORKSPACE_DUPLICATE_NAME_REASON = 'Model name is already used by another model in this project';

/** Mark complete waits for a category: it must be chosen before a model is complete. */
export const CATEGORY_FIRST_REASON = 'Pick a category on the sensor first (Performance or Condition)';

/** The sensor a model belongs to (target; X sensor for Clustering), as typed. */
export const modelTagOf = (m: Pick<FailureModel, 'kind' | 'targetSensor' | 'xSensor'>): string =>
    (m.kind === 'clustering' ? m.xSensor : m.targetSensor) ?? '';

/**
 * The long Mark complete reason for a name twin: names the other model by its
 * kind and its sensor. `labelOf` turns a tag into the plain-text sensor label
 * ("DESCRIPTION · TAG", the tag alone when there is no description).
 */
export function nameTwinMarkCompleteReason(name: string, twin: FailureModel, labelOf: (tag: string) => string): string {
    return `Model name “${name.trim()}” is also used by the ${kindModelName(twin.kind)} of ${labelOf(modelTagOf(twin))} — rename one in Model settings`;
}

/**
 * The Mark complete blocks that come from the project rather than the fit:
 * no category on the model's sensor (`category`, already resolved per sensor
 * by the caller), then a workspace name twin. `null` = neither blocks.
 */
export function markCompleteProjectBlock(
    models: readonly FailureModel[],
    model: FailureModel,
    category: ModelCategory | null | undefined,
    labelOf: (tag: string) => string,
): string | null {
    if (!category) return CATEGORY_FIRST_REASON;
    const twin = findWorkspaceNameTwin(models, model, model.name ?? '');
    return twin ? nameTwinMarkCompleteReason(model.name ?? '', twin, labelOf) : null;
}
