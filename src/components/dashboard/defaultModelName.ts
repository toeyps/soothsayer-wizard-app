import type { FailureModel, ModelKind } from '../../types';
import { suggestDistinctModelName } from '../../utils/modelNames';

/** One key sensor for every model, so the same-sensor rules of
 *  `suggestDistinctModelName` apply across the WHOLE project. */
const ONE_KEY = '__project__';

/**
 * The name a NEW model starts with: always "<base> (<Kind>)" — `base` is the
 * sensor's description, or its tag — so every kind says what it is, the
 * Individual model included (user decision 2026-10-26; it used to get the bare
 * `base` when that was free). Model names are unique across the whole project
 * (a twin blocks Mark complete), so when "<base> (<Kind>)" is taken it becomes
 * "<base> (<Kind>) 2" … checked against every model of the project (an older
 * workspace's legacy kind spelling counts as used there too). Never the
 * algorithm name. An empty base stays empty.
 */
export function defaultModelName(models: readonly Pick<FailureModel, 'name'>[], base: string, kind: ModelKind): string {
    const trimmed = base.trim();
    const all = models.map((m, i) => ({ ...m, id: `__m${i}`, kind, targetSensor: ONE_KEY, xSensor: ONE_KEY })) as unknown as FailureModel[];
    if (trimmed === '') return trimmed;
    return suggestDistinctModelName(all, { id: '__new', kind, targetSensor: ONE_KEY, xSensor: ONE_KEY }, trimmed);
}
