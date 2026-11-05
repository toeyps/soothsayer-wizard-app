import type { FailureGroup, FailureModel, WorkspaceMetadata } from '../types';
import { modelSensorKey } from './modelGrouping';
import { isModelComplete } from './modelStatus';
import type { RunningConditionFg } from './runningCondition';

/** How many colour squares the recent-project chip shows.
 *  `WorkspaceMetadata.failureGroupNos` never holds more. */
export const FG_CHIP_MAX_SWATCHES = 3;

/** Real Failure Groups (group 0 removed), ordered by number as the panel lists them; a missing/corrupt list gives `[]`. */
export function realFailureGroups(groups: readonly FailureGroup[] | null | undefined): FailureGroup[] {
    if (!Array.isArray(groups)) return [];
    const list: readonly FailureGroup[] = groups;
    return list.filter(g => g && typeof g.no === 'number' && g.no !== 0).sort((a, b) => a.no - b.no);
}

export type FailureGroupMetaFields = Required<Pick<WorkspaceMetadata, 'failureGroupCount' | 'failureGroupNos'>>;

/** Recent-project fields for `groups`. `null` when there is no slice: the caller leaves the entry's fields as they were (`undefined` = no chip) and never writes a 0. */
export function failureGroupMetaFields(groups: readonly FailureGroup[] | null | undefined): FailureGroupMetaFields | null {
    if (!Array.isArray(groups)) return null;
    const real = realFailureGroups(groups);
    return {
        failureGroupCount: real.length,
        failureGroupNos: real.slice(0, FG_CHIP_MAX_SWATCHES).map(g => g.no),
    };
}

/** Recent-project card chip: `null` = saved before the fields existed (no chip); count 0 = neutral 'No failure groups'; count n = 'n failure group(s)' with a swatch per number in `nos`. */
export interface RecentProjectFgChip {
    count: number;
    /** Group numbers to draw swatches for (colour via `getFgGroupColor`). */
    nos: number[];
    label: string;
}

export function recentProjectFgChip(
    meta: Partial<Pick<WorkspaceMetadata, 'failureGroupCount' | 'failureGroupNos'>>,
): RecentProjectFgChip | null {
    const count = meta.failureGroupCount;
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return null;
    if (count === 0) return { count: 0, nos: [], label: 'No failure groups' };
    const nos = (Array.isArray(meta.failureGroupNos) ? meta.failureGroupNos : [])
        .filter(n => typeof n === 'number' && n !== 0)
        .slice(0, FG_CHIP_MAX_SWATCHES);
    return { count, nos, label: `${count} failure group${count === 1 ? '' : 's'}` };
}

/** The Dashboard landing's "N groups · M sensors assigned · x of y models
 *  complete" line. */
export interface FailureGroupSummary {
    /** Real groups (no "Not in Group"). */
    groupCount: number;
    /** Distinct sensors with a model in a real group, keyed like the panel (`modelSensorKey`), so a sensor in several groups or kinds counts once. Models with no key sensor, or only in 'Not in Group', are not counted. */
    assignedSensorCount: number;
    /** `isModelComplete`: same rule as the panel's 'x of y models complete' chip (marked complete and not out of date). */
    completeModelCount: number;
    /** Every model in the workspace, "Not in Group" ones included — the same
     *  denominator the panel's chip already uses. */
    totalModelCount: number;
}

export function summarizeFailureGroups(
    groups: readonly FailureGroup[] | null | undefined,
    models: readonly FailureModel[] | null | undefined,
    fg: RunningConditionFg,
): FailureGroupSummary {
    const real = realFailureGroups(groups);
    const realNos = new Set(real.map(g => g.no));
    const list: readonly FailureModel[] = Array.isArray(models) ? models : [];
    const sensors = new Set<string>();
    let complete = 0;
    for (const m of list) {
        if (isModelComplete(m, fg)) complete++;
        if (!(m.groupNos ?? []).some(no => realNos.has(no))) continue;
        const key = modelSensorKey(m);
        if (key) sensors.add(key);
    }
    return {
        groupCount: real.length,
        assignedSensorCount: sensors.size,
        completeModelCount: complete,
        totalModelCount: list.length,
    };
}
