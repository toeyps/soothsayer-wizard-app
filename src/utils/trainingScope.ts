import type { FailureModel, TimePeriod, WorkspaceSensorFilter } from '../types';
import type { TrainingScopeFilter } from '../types/health';
import { effectiveRunningCondition, isCompleteCondition, type RunningConditionFg } from './runningCondition';
import { toFilterRanges } from './timePeriods';

/** Wire shape of `filter` for the preview/train commands: `{timestamp_ranges, value_filters, combine}`, or `null` for none. Train and health score must build the scope through this one function, or they score different rows. Dropped: rows with no sensor, missing value or sensor not in `headers`, and invalid periods; all data sends no value filters; an open-both-ends period means no time limit. */
export function buildPreviewFilterPayload(
    eff: { filters: WorkspaceSensorFilter[]; combine: 'and' | 'or'; allData: boolean; periods: TimePeriod[] },
    headers: string[] | null,
): TrainingScopeFilter | null {
    const rawFilters = eff.allData ? [] : eff.filters;
    const valueFilters = rawFilters
        .filter(sf => isCompleteCondition(sf, headers))
        .map(sf => ({
            sensor: sf.sensor,
            operation: sf.operation,
            value1: sf.value1 !== '' ? parseFloat(sf.value1) : null,
            value2: sf.value2 !== '' ? parseFloat(sf.value2) : null,
        }));
    const ranges = toFilterRanges(eff.periods);
    const filterRanges = ranges.some(rg => rg.start === null && rg.end === null) ? [] : ranges;
    if (valueFilters.length === 0 && filterRanges.length === 0) return null;
    return { timestamp_ranges: filterRanges, value_filters: valueFilters, combine: eff.combine };
}

/** A model's training scope: its effective running condition as a command `filter`; pass the draft-merged model when previewing unsaved edits. */
export function trainingScopeFilter(
    model: FailureModel,
    fg: RunningConditionFg,
    headers: string[] | null,
): TrainingScopeFilter | null {
    return buildPreviewFilterPayload(effectiveRunningCondition(model, fg), headers);
}
