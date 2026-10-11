import type { FailureGroup, FailureModel, WorkspaceMetadata } from '../types';
import { modelSensorKey } from './modelGrouping';
import { isModelComplete } from './modelStatus';
import type { RunningConditionFg } from './runningCondition';

/** How many colour squares the recent-project chip shows.
 *  `WorkspaceMetadata.failureGroupNos` never holds more. */
export const FG_CHIP_MAX_SWATCHES = 3;

/** The user's own Failure Groups: the permanent group 0 ("Not in Group")
 *  sentinel removed, ordered by number — the order the Failure Groups panel
 *  lists them in. Tolerates a missing/corrupt list (returns `[]`). */
export function realFailureGroups(groups: readonly FailureGroup[] | null | undefined): FailureGroup[] {
    if (!Array.isArray(groups)) return [];
    const list: readonly FailureGroup[] = groups;
    return list.filter(g => g && typeof g.no === 'number' && g.no !== 0).sort((a, b) => a.no - b.no);
}

export type FailureGroupMetaFields = Required<Pick<WorkspaceMetadata, 'failureGroupCount' | 'failureGroupNos'>>;

/**
 * The recent-project fields for a workspace whose `failureGroupState.groups`
 * is `groups`. `null` when the workspace has no Failure Group slice at all —
 * the caller must then leave the entry's fields as they were (`undefined` for
 * a project saved before these fields existed: no chip), never write a 0.
 */
export function failureGroupMetaFields(groups: readonly FailureGroup[] | null | undefined): FailureGroupMetaFields | null {
    if (!Array.isArray(groups)) return null;
    const real = realFailureGroups(groups);
    return {
        failureGroupCount: real.length,
        failureGroupNos: real.slice(0, FG_CHIP_MAX_SWATCHES).map(g => g.no),
    };
}

/** What the recent-project card shows for an entry:
 *   - `null`  — saved before the fields existed: no chip at all
 *   - count 0 — the neutral dashed "No failure groups" chip (never amber)
 *   - count n — "n failure group(s)" with a swatch per number in `nos` */
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
    /** Distinct sensors with at least one model in at least one real group.
     *  A sensor is keyed the way the panel groups rows (`modelSensorKey`:
     *  Clustering by X, the others by target), so a sensor in three groups, or
     *  with three model kinds, counts once. Models with no key sensor yet and
     *  models only in "Not in Group" are not counted. */
    assignedSensorCount: number;
    /** `isModelComplete` — the same rule as the panel's existing "x of y
     *  models complete" chip (marked complete AND not out of date). */
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
