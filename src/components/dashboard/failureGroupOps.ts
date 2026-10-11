import type { FailureGroup } from '../../types';

/**
 * The ONE place a Failure Group record is shaped. The Dashboard's Failure
 * Groups tab ("+ Add failure group", "Edit details") and the Import page's
 * step 3 both build groups through these pure helpers, so a group named at
 * setup is byte-for-byte the record the Dashboard would have created — same
 * numbering, same fields, nothing forked.
 *
 * Pure (no React, no Tauri): the Dashboard runs each one against its mirror
 * for the instant UI update and again against what is on DISK inside the
 * write (`persistFailureGroupStateFrom`).
 */

/** The permanent group 0 every workspace's `failureGroupState.groups` starts
 *  with — the Dashboard's default when a workspace has no Failure Group slice. */
export const NOT_IN_GROUP: FailureGroup = Object.freeze({ no: 0, name: 'Not in Group' });

/** Same rule everywhere a group is named: trimmed, case-insensitive,
 *  `excludeNo` = the group being renamed. The name "Not in Group" is reserved
 *  for the built-in group 0 and is always taken (whether or not the list
 *  carries the sentinel), so no real group can be confused with it. */
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

/** Appends a new, empty group named `name` (already trimmed by the caller). */
export function appendFailureGroup(groups: readonly FailureGroup[], name: string): FailureGroup[] {
    return [...groups, { no: nextFailureGroupNo(groups), name }];
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

/**
 * The `failureGroupState.groups` of a brand-new workspace from the groups
 * named on Import step 3: "Not in Group" first, then each draft in order,
 * numbered FG-1, FG-2 … exactly as if the user had added them one by one on
 * the Dashboard's Failure Groups tab and then filled in "Edit details". A
 * draft with an empty name is dropped; one with no description and no
 * recommendation stays a bare `{ no, name }`, like a group the tab created and
 * never edited. `[]` drafts (Skip) → just "Not in Group".
 */
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
