import type { WorkspaceSensorFilter } from '../types';
import type { ExportRunningStatus } from '../types/export';
import { isCompleteCondition, type RunningConditionFg } from './runningCondition';

/*
 * The export's running status — "the machine is running when <sensor> is
 * above <value>". The customer's monitoring system needs ONE sensor and the
 * value at or below which the machine counts as stopped. Used by the export
 * only; training keeps using the running condition itself.
 */

/** Where the running status comes from:
 *  - `single-above`: the workspace running condition holds exactly one
 *    complete "sensor > value" condition — that is it;
 *  - `saved`: the user said which ("Machine is running when … is above …",
 *    `failureGroupState.runningStatus`);
 *  - `first-above`: neither, but there are several "above" conditions — the
 *    first one, which the user should check (`FIRST_ABOVE_NOTE`). */
export type RunningStatusSource = 'single-above' | 'saved' | 'first-above';

export interface ResolvedRunningStatus {
    sensor: string;
    value: number;
    source: RunningStatusSource;
}

/** UI text under a `first-above` running status. */
export const FIRST_ABOVE_NOTE = 'Taken from the first “above” condition — check it in the running condition.';

const finite = (text: string | null | undefined): number | null => {
    const t = (text ?? '').trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
};

/** The workspace's complete "sensor > value" conditions, in list order. None
 *  when "Use all rows" was chosen (there is no condition to take one from). */
export function aboveConditions(fg: RunningConditionFg, headers: string[] | null): WorkspaceSensorFilter[] {
    if (fg?.runningConditionNoneConfirmed) return [];
    return (fg?.runningConditionFilters ?? []).filter(f =>
        f.operation === 'greater_than' && isCompleteCondition(f, headers) && finite(f.value1) !== null);
}

/** The running status the export would write, or `null` when there is none. */
export function resolveRunningStatus(fg: RunningConditionFg, headers: string[] | null): ResolvedRunningStatus | null {
    const above = aboveConditions(fg, headers);
    if (above.length === 1) return { sensor: above[0].sensor, value: finite(above[0].value1)!, source: 'single-above' };
    const saved = fg?.runningStatus;
    const savedValue = finite(saved?.stopAtOrBelow);
    if (saved && saved.sensor.trim() !== '' && savedValue !== null) return { sensor: saved.sensor, value: savedValue, source: 'saved' };
    if (above.length > 0) return { sensor: above[0].sensor, value: finite(above[0].value1)!, source: 'first-above' };
    return null;
}

/** The wire shape of a resolved running status (`null` stays `null`). */
export function runningStatusToWire(rs: ResolvedRunningStatus | null): ExportRunningStatus | null {
    return rs ? { sensor: rs.sensor, stop_if_lower_than: rs.value } : null;
}
