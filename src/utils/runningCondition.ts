import type { FailureGroupStateSlice, FailureModel, TimePeriod, WorkspaceSensorFilter } from '../types';
import { normalizeSensorTag } from '../hooks/useSensorMetaMap';
import { modelSensorKey, sensorCategory } from './modelGrouping';
import { validatePeriods } from './timePeriods';

/** The parts of the failure-group slice these helpers read. */
export type RunningConditionFg = Partial<FailureGroupStateSlice> | null | undefined;

export interface EffectiveRunningCondition {
    mode: 'workspace' | 'custom';
    filters: WorkspaceSensorFilter[];
    combine: 'and' | 'or';
    /** User explicitly chose "No condition — use all rows". */
    noneConfirmed: boolean;
    periods: TimePeriod[];
}

/** Old single range -> one period (`[]` if both empty). Deterministic id. */
function legacyPeriods(start?: string, end?: string): TimePeriod[] {
    return start || end ? [{ id: 'legacy-1', start: start ?? '', end: end ?? '' }] : [];
}

/**
 * The running condition (value conditions + periods) a model actually trains
 * with: the workspace default in 'workspace' mode, the model's own in
 * 'custom'. Periods fall back to the legacy start/end pair until the periods
 * migration has run.
 */
export function effectiveRunningCondition(model: FailureModel, fg: RunningConditionFg): EffectiveRunningCondition {
    if (model.runningConditionMode === 'custom') {
        return {
            mode: 'custom',
            filters: model.customRunningConditionFilters ?? [],
            combine: model.customRunningConditionCombine ?? 'and',
            noneConfirmed: model.customRunningConditionNoneConfirmed ?? false,
            periods: model.filterTimePeriods ?? legacyPeriods(model.filterTimeStart, model.filterTimeEnd),
        };
    }
    return {
        mode: 'workspace',
        filters: fg?.runningConditionFilters ?? [],
        combine: fg?.runningConditionCombine ?? 'and',
        noneConfirmed: fg?.runningConditionNoneConfirmed ?? false,
        periods: fg?.runningConditionTimePeriods ?? legacyPeriods(fg?.runningConditionTimeStart, fg?.runningConditionTimeEnd),
    };
}

/**
 * A row the training query will actually apply: sensor chosen (and present in
 * `headers` when given — Rust silently drops conditions on missing sensors),
 * `value1` filled, and `between` also needs `value2`.
 */
export function isCompleteCondition(f: WorkspaceSensorFilter, headers?: string[] | null): boolean {
    if (!f.sensor || !f.sensor.trim()) return false;
    if (headers) {
        const key = normalizeSensorTag(f.sensor);
        if (!headers.some((h) => normalizeSensorTag(h) === key)) return false;
    }
    if (!(f.value1 ?? '').trim()) return false;
    if (f.operation === 'between' && !(f.value2 ?? '').trim()) return false;
    return true;
}

function isConfigured(filters: WorkspaceSensorFilter[], noneConfirmed: boolean, headers?: string[] | null): boolean {
    return noneConfirmed || filters.some((f) => isCompleteCondition(f, headers));
}

/** Workspace-level: >=1 complete row OR "No condition" confirmed. Time periods never count. */
export function isWorkspaceRunningConditionConfigured(fg: RunningConditionFg, headers?: string[] | null): boolean {
    return isConfigured(fg?.runningConditionFilters ?? [], fg?.runningConditionNoneConfirmed ?? false, headers);
}

/** Is this model's EFFECTIVE running condition (workspace or Custom) configured? */
export function isRunningConditionConfigured(model: FailureModel, fg: RunningConditionFg, headers?: string[] | null): boolean {
    const eff = effectiveRunningCondition(model, fg);
    return isConfigured(eff.filters, eff.noneConfirmed, headers);
}

/**
 * The ONE gate for Build Model, Finish and re-train. Returns the first blocking
 * reason as user-facing text, else null. Order: category -> running condition
 * -> time periods.
 */
export function getBuildBlockReason(model: FailureModel, fg: RunningConditionFg, headers?: string[] | null): string | null {
    const category = model.category ?? sensorCategory(fg?.models ?? [], modelSensorKey(model));
    if (category == null) return 'Pick a category on the sensor header.';
    if (!isRunningConditionConfigured(model, fg, headers)) {
        return 'Set a running condition first, or choose "No condition — use all rows".';
    }
    const eff = effectiveRunningCondition(model, fg);
    const bad = validatePeriods(eff.periods).find((s) => s.invalid);
    if (bad) return bad.reason ?? 'Fix the training period dates.';
    return null;
}
