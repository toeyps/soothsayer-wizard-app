import type { ExportRunningStatus } from '../types/export';
import { isCompleteCondition, type RunningConditionFg } from './runningCondition';

/*
 * The export's running status — "the machine is running when <sensor> is
 * above <value>". It is ALWAYS the workspace running condition itself: the one
 * "sensor > value" line that also filters the rows for training and the health
 * score (user decision 2026-10-26). The old export-only line
 * (`failureGroupState.runningStatus`) is read only by the one-time conversion
 * (`migrateSingleRunningCondition`).
 */

export interface ResolvedRunningStatus {
    sensor: string;
    value: number;
}

/** The running status the export would write, or `null` while the running condition is not set. */
export function resolveRunningStatus(fg: RunningConditionFg, headers: string[] | null): ResolvedRunningStatus | null {
    const f = (fg?.runningConditionFilters ?? [])[0];
    if (!f || f.operation !== 'greater_than' || !isCompleteCondition(f, headers)) return null;
    const value = Number((f.value1 ?? '').trim());
    return Number.isFinite(value) ? { sensor: f.sensor, value } : null;
}

/** The wire shape of a resolved running status (`null` stays `null`). */
export function runningStatusToWire(rs: ResolvedRunningStatus | null): ExportRunningStatus | null {
    return rs ? { sensor: rs.sensor, stop_if_lower_than: rs.value } : null;
}
