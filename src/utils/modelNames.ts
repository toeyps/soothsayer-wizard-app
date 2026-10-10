import type { FailureModel, ModelKind } from '../types';
import { modelSensorKey } from './modelGrouping';

/**
 * THE kind names a user reads, in every window (Dashboard sheet, Failure Groups
 * tab, Build Model tabs / Train menu / run strip, special-sensor lock sentences,
 * suggested model names): Individual / Relation model / Clustering. User decision
 * 2026-10-10: the whole app says "Relation model", never "Relationship" — and
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
 * The kind word a suggested name carried BEFORE 2026-10-10, per kind — only where
 * it differs from today's. A workspace saved back then still holds names like
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
 * Exact text only, on purpose: "X (Relationship)" (a name saved before the
 * 2026-10-10 wording change) and "X (Relation model)" are two different names
 * here, so no saved workspace starts being blocked by this change.
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
