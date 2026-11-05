import type { FailureModel, ModelCategory, ModelKind } from '../types';
import { modelSensorKey } from './modelGrouping';

/** The kind names users read in every window: Individual / Relation model / Clustering. Display only: the kind value stays `'relationship'`. Never the algorithm name; `UserFacingWording.test.ts` guards it. */
export const MODEL_KIND_LABEL: Record<ModelKind, string> = {
    individual: 'Individual',
    relationship: 'Relation model',
    clustering: 'Clustering',
};

/** A kind inside a sentence; the Relation model's label already ends in "model". */
export const kindModelName = (kind: ModelKind): string =>
    (kind === 'relationship' ? MODEL_KIND_LABEL[kind] : `${MODEL_KIND_LABEL[kind]} model`);

/** Kind word older workspaces used in suggested names ("Pump (Relationship)"); these are user data, never rewritten, but a new suggestion must not sit beside one as a twin. */
const LEGACY_KIND_WORD: Partial<Record<ModelKind, string>> = {
    relationship: 'Relationship',
};

const norm = (s: string): string => s.trim().toLowerCase();

/** Another model of the same sensor (workspace-wide, `modelSensorKey`) with the same trimmed, case-insensitive name, or null. Empty names and models without a key sensor never conflict. Exact text only: "X (Relationship)" and "X (Relation model)" differ, so no saved workspace is blocked. */
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

/** "<name> (<Kind>)", then " 2", 3 … until no same-sensor model uses it; a model holding the legacy spelling also counts as used (same counter). */
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

/** Another model in the workspace (any sensor or kind) with the same trimmed, case-insensitive name, or null; names are unique because the export uses them as display names. */
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

/** Long Mark complete reason for a name twin; `labelOf` gives the plain-text sensor label. */
export function nameTwinMarkCompleteReason(name: string, twin: FailureModel, labelOf: (tag: string) => string): string {
    return `Model name “${name.trim()}” is also used by the ${kindModelName(twin.kind)} of ${labelOf(modelTagOf(twin))} — rename one in Model settings`;
}

/** Mark complete blocks from the project, not the fit: no category on the model's sensor, then a name twin; `null` = neither. */
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
