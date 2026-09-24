import type { FailureModel, ModelKind } from '../types';
import { modelSensorKey } from './modelGrouping';

/** Kind words used in a suggested name. Kept literal (never the algorithm name). */
const KIND_WORD: Record<ModelKind, string> = {
    individual: 'Individual',
    relationship: 'Relationship',
    clustering: 'Clustering',
};

const norm = (s: string): string => s.trim().toLowerCase();

/**
 * Another model of the SAME sensor (workspace-wide, `modelSensorKey`) whose
 * trimmed, case-insensitive name equals `name`, or null. Empty names and
 * models with no key sensor yet never conflict. The model itself is skipped.
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

/** "<name> (<Kind>)", then "<name> (<Kind>) 2", 3 … until no same-sensor model uses it. */
export function suggestDistinctModelName(
    models: FailureModel[],
    model: Pick<FailureModel, 'id' | 'kind' | 'targetSensor' | 'xSensor'>,
    name: string,
): string {
    const base = `${name.trim()} (${KIND_WORD[model.kind]})`;
    let candidate = base;
    for (let i = 2; findSameSensorNameConflict(models, model, candidate) !== null; i++) candidate = `${base} ${i}`;
    return candidate;
}
