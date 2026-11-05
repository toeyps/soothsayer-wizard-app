import type { FailureModel, ModelKind } from '../../types';
import { suggestDistinctModelName } from '../../utils/modelNames';

/** One key sensor for every model, so the same-sensor rules of
 *  `suggestDistinctModelName` apply across the WHOLE project. */
const ONE_KEY = '__project__';

/** Name for a NEW model: '<base> (<Kind>)' (base = description or tag), numbered ' 2', ... when taken. Unique across the project (legacy kind spellings count as used); never the algorithm name; an empty base stays empty. */
export function defaultModelName(models: readonly Pick<FailureModel, 'name'>[], base: string, kind: ModelKind): string {
    const trimmed = base.trim();
    const all = models.map((m, i) => ({ ...m, id: `__m${i}`, kind, targetSensor: ONE_KEY, xSensor: ONE_KEY })) as unknown as FailureModel[];
    if (trimmed === '') return trimmed;
    return suggestDistinctModelName(all, { id: '__new', kind, targetSensor: ONE_KEY, xSensor: ONE_KEY }, trimmed);
}
