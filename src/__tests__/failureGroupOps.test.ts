import { describe, it, expect } from 'vitest';
import {
    NOT_IN_GROUP,
    appendFailureGroup,
    applyFailureGroupDetails,
    buildInitialFailureGroups,
    isDuplicateFailureGroupName,
    nextFailureGroupNo,
} from '../components/dashboard/failureGroupOps';
import { failureGroupMetaFields, recentProjectFgChip } from '../utils/failureGroupSummary';

/**
 * The one place a Failure Group record is shaped (
 * item 5): Import step 3 and the Dashboard's Failure Groups tab must produce
 * identical groups.
 */
describe('failureGroupOps', () => {
    it('numbers a new group one past the highest in use (never reusing a deleted number below it)', () => {
        expect(nextFailureGroupNo([NOT_IN_GROUP])).toBe(1);
        expect(nextFailureGroupNo([NOT_IN_GROUP, { no: 1, name: 'A' }, { no: 4, name: 'D' }])).toBe(5);
        expect(nextFailureGroupNo([])).toBe(1);
        expect(appendFailureGroup([NOT_IN_GROUP, { no: 2, name: 'B' }], 'C')).toEqual([NOT_IN_GROUP, { no: 2, name: 'B' }, { no: 3, name: 'C' }]);
    });

    it('duplicate names: trimmed, case-insensitive, never "Not in Group", the renamed group itself excluded', () => {
        const groups = [NOT_IN_GROUP, { no: 1, name: 'Bearing overheating' }];
        expect(isDuplicateFailureGroupName(groups, '  BEARING overheating ')).toBe(true);
        expect(isDuplicateFailureGroupName(groups, 'Bearing overheating', 1)).toBe(false);
        // "Not in Group" is reserved for group 0 — always taken, whatever the list holds
        expect(isDuplicateFailureGroupName(groups, 'Not in Group')).toBe(true);
        expect(isDuplicateFailureGroupName(groups, '  not IN group ')).toBe(true);
        expect(isDuplicateFailureGroupName([], 'Not in Group')).toBe(true);
        expect(buildInitialFailureGroups([{ name: 'not in group', description: '', recommendation: '' }])).toEqual([NOT_IN_GROUP]);
        expect(isDuplicateFailureGroupName(groups, 'Seal leak')).toBe(false);
    });

    it('the "Not in Group" sentinel is frozen, so no writer can change the shared object', () => {
        expect(Object.isFrozen(NOT_IN_GROUP)).toBe(true);
        expect(() => { (NOT_IN_GROUP as { name: string }).name = 'x'; }).toThrow();
        expect(NOT_IN_GROUP.name).toBe('Not in Group');
    });

    it('step 3 builds EXACTLY what adding the groups one by one on the FG tab (+ "Edit details") would', () => {
        const drafts = [
            { name: ' Bearing overheating ', description: ' NDE runs hot ', recommendation: '' },
            { name: 'Lube oil pressure low', description: '', recommendation: '' },
            { name: 'Cooling water loss', description: '', recommendation: 'Check the CW pump' },
        ];
        // The Dashboard: + Add failure group three times, then Edit details on FG-1 and FG-3.
        let viaTab = [NOT_IN_GROUP];
        viaTab = appendFailureGroup(viaTab, 'Bearing overheating');
        viaTab = appendFailureGroup(viaTab, 'Lube oil pressure low');
        viaTab = appendFailureGroup(viaTab, 'Cooling water loss');
        viaTab = applyFailureGroupDetails(viaTab, 1, 'Bearing overheating', 'NDE runs hot', '');
        viaTab = applyFailureGroupDetails(viaTab, 3, 'Cooling water loss', '', 'Check the CW pump');

        expect(buildInitialFailureGroups(drafts)).toEqual(viaTab);
        expect(viaTab).toEqual([
            { no: 0, name: 'Not in Group' },
            { no: 1, name: 'Bearing overheating', description: 'NDE runs hot', recommendation: '' },
            { no: 2, name: 'Lube oil pressure low' },
            { no: 3, name: 'Cooling water loss', description: '', recommendation: 'Check the CW pump' },
        ]);
    });

    it('Skip (no drafts) leaves only "Not in Group" — the recent project then reads "No failure groups", not "no chip"', () => {
        const groups = buildInitialFailureGroups([]);
        expect(groups).toEqual([NOT_IN_GROUP]);
        const meta = failureGroupMetaFields(groups)!;
        expect(meta).toEqual({ failureGroupCount: 0, failureGroupNos: [] });
        expect(recentProjectFgChip(meta)?.label).toBe('No failure groups');
    });

    it('drops blank and duplicate drafts instead of writing a broken group', () => {
        expect(buildInitialFailureGroups([
            { name: '   ', description: 'x', recommendation: '' },
            { name: 'A', description: '', recommendation: '' },
            { name: 'a', description: '', recommendation: '' },
        ])).toEqual([NOT_IN_GROUP, { no: 1, name: 'A' }]);
    });
});
