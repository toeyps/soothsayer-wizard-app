import type { FailureGroup } from '../../types';

/** The one place a Failure Group record is shaped: the Dashboard tab and Import step 3 build groups through these pure helpers. The Dashboard runs each against its mirror (instant UI) and against what is on DISK inside the write (`persistFailureGroupStateFrom`). */

/** The permanent group 0 every workspace starts with; the Dashboard's default when there is no Failure Group slice. */
export const NOT_IN_GROUP: FailureGroup = Object.freeze({ no: 0, name: 'Not in Group' });

/** Group-name uniqueness: trimmed, case-insensitive, `excludeNo` = group being renamed; 'Not in Group' is always taken. */
export function isDuplicateFailureGroupName(
    groups: readonly FailureGroup[],
    name: string,
    excludeNo?: number,
): boolean {
    const wanted = name.trim().toLowerCase();
    if (wanted === NOT_IN_GROUP.name.toLowerCase()) return true;
    return groups.some(g => g.no !== 0 && g.no !== excludeNo && g.name.trim().toLowerCase() === wanted);
}

/** The next free group number: one past the highest in use (never reuses a
 *  deleted group's number while a higher one exists). */
export function nextFailureGroupNo(groups: readonly FailureGroup[]): number {
    return Math.max(...groups.map(g => g.no), 0) + 1;
}

/** Appends a new, empty group named `name` (already trimmed by the caller); blank details are left out. */
export function appendFailureGroup(
    groups: readonly FailureGroup[],
    name: string,
    details: { description?: string; recommendation?: string } = {},
): FailureGroup[] {
    const g: FailureGroup = { no: nextFailureGroupNo(groups), name };
    if (details.description?.trim()) g.description = details.description;
    if (details.recommendation?.trim()) g.recommendation = details.recommendation;
    return [...groups, g];
}

/** Name + Description + Recommendation together — the FG tab's "Edit details". */
export function applyFailureGroupDetails(
    groups: readonly FailureGroup[],
    groupNo: number,
    name: string,
    description: string,
    recommendation: string,
): FailureGroup[] {
    return groups.map(g => (g.no === groupNo ? { ...g, name, description, recommendation } : g));
}

/** What the Import page's step 3 collects per group. */
export interface FailureGroupDraft {
    name: string;
    description: string;
    recommendation: string;
}

/** Initial `groups` of a new workspace from Import step 3 drafts: 'Not in Group' first, then each draft numbered FG-1, FG-2 … as if added on the Dashboard. An empty-name draft is dropped; no description/recommendation stays a bare `{ no, name }`; no drafts (Skip) gives just 'Not in Group'. */
export function buildInitialFailureGroups(drafts: readonly FailureGroupDraft[]): FailureGroup[] {
    let groups: FailureGroup[] = [NOT_IN_GROUP];
    for (const d of drafts) {
        const name = d.name.trim();
        if (!name || isDuplicateFailureGroupName(groups, name)) continue;
        groups = appendFailureGroup(groups, name);
        const description = d.description.trim();
        const recommendation = d.recommendation.trim();
        if (description || recommendation) {
            groups = applyFailureGroupDetails(groups, groups[groups.length - 1].no, name, description, recommendation);
        }
    }
    return groups;
}
