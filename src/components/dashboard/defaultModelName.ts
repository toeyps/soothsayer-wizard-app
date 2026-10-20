import type { FailureModel, ModelKind } from '../../types';
import { findWorkspaceNameTwin, suggestDistinctModelName } from '../../utils/modelNames';

/** One key sensor for every model, so the same-sensor rules of
 *  `suggestDistinctModelName` apply across the WHOLE project. */
const ONE_KEY = '__project__';

/**
 * The name a NEW model starts with. Model names are unique across the whole
 * project (the export writes each as the model's display name, and a twin
 * blocks Mark complete), so the default must never be a twin:
 * - `base` (the sensor's description, or its tag) when no model in the project
 *   uses it yet — the first model of a sensor;
 * - otherwise `suggestDistinctModelName`'s "<base> (<Kind>)", "<base> (<Kind>) 2" …
 *   checked against every model of the project (an older workspace's legacy
 *   kind spelling counts as used there too). Never the algorithm name.
 */
export function defaultModelName(models: readonly Pick<FailureModel, 'name'>[], base: string, kind: ModelKind): string {
    const trimmed = base.trim();
    const all = models.map((m, i) => ({ ...m, id: `__m${i}`, kind, targetSensor: ONE_KEY, xSensor: ONE_KEY })) as unknown as FailureModel[];
    if (trimmed === '' || !findWorkspaceNameTwin(all, { id: '__new' }, trimmed)) return trimmed;
    return suggestDistinctModelName(all, { id: '__new', kind, targetSensor: ONE_KEY, xSensor: ONE_KEY }, trimmed);
}
