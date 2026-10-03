import type { FailureModel, TimePeriod, WorkspaceSensorFilter } from '../types';
import type { TrainingScopeFilter } from '../types/health';
import { effectiveRunningCondition, isCompleteCondition, type RunningConditionFg } from './runningCondition';
import { toFilterRanges } from './timePeriods';

/**
 * Wire shape the preview/train commands (`compute_sensor_stats`,
 * `preview_relationship_model`, `compute_clustering_preview`,
 * `compute_health_preview`, `export_model_files`) expect for `filter` —
 * `{timestamp_ranges, value_filters, combine}`, or `null` for "no filter at all".
 *
 * Extracted verbatim from `BuildModelWindow.tsx` (2026-10-03, health score
 * phase 3a) so the Workbench's Train and the health-score requests build the
 * training scope through ONE function — a request that used a different scope
 * than the Train it belongs to would score the wrong rows. Behaviour is
 * unchanged: rows the query would ignore (no sensor, missing value, sensor not
 * in `headers`) are dropped, "No condition" sends no value filters, an
 * open-both-ends period means "no time limit", and invalid periods are dropped.
 */
export function buildPreviewFilterPayload(
    eff: { filters: WorkspaceSensorFilter[]; combine: 'and' | 'or'; noneConfirmed: boolean; periods: TimePeriod[] },
    headers: string[] | null,
): TrainingScopeFilter | null {
    const rawFilters = eff.noneConfirmed ? [] : eff.filters;
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

/** The training scope of a model: its EFFECTIVE running condition (workspace
 *  default or its own Custom one) as a command `filter`. Pass the DRAFT-merged
 *  model when the UI is previewing unsaved edits. */
export function trainingScopeFilter(
    model: FailureModel,
    fg: RunningConditionFg,
    headers: string[] | null,
): TrainingScopeFilter | null {
    return buildPreviewFilterPayload(effectiveRunningCondition(model, fg), headers);
}
