import { describe, it, expect } from 'vitest';
import {
    FG_CHIP_MAX_SWATCHES, failureGroupMetaFields, realFailureGroups, recentProjectFgChip, summarizeFailureGroups,
} from '../utils/failureGroupSummary';
import { FG_GROUP_PALETTE, getFgGroupColor } from '../utils/failureGroupColor';
import type { FailureGroup, FailureModel } from '../types';

const groups = (...nos: number[]): FailureGroup[] => nos.map(no => ({ no, name: no === 0 ? 'Not in Group' : `G${no}` }));
const model = (o: Partial<FailureModel>): FailureModel => ({
    id: 'm', groupNos: [1], kind: 'individual', status: false, targetSensor: 'T1', predictorSensors: [], xSensor: '', ySensor: '',
    ...o,
} as FailureModel);

describe('getFgGroupColor', () => {
    it('cycles amber, violet, green, blue from FG-1 and gives Not in Group slate (same rule as Dashboard / Build Model)', () => {
        expect([1, 2, 3, 4, 5, 8, 9].map(getFgGroupColor)).toEqual(['amber', 'violet', 'green', 'blue', 'amber', 'blue', 'amber']);
        expect(getFgGroupColor(0)).toBe('slate');
        expect(FG_GROUP_PALETTE).toEqual(['amber', 'violet', 'green', 'blue']);
    });

    it('never returns undefined for malformed numbers', () => {
        for (const n of [-1, -7, NaN, Infinity, 2.5]) expect(['amber', 'violet', 'green', 'blue', 'slate']).toContain(getFgGroupColor(n));
    });
});

describe('realFailureGroups', () => {
    it('drops Not in Group and sorts by number', () => {
        expect(realFailureGroups(groups(3, 0, 1, 2)).map(g => g.no)).toEqual([1, 2, 3]);
    });
    it('tolerates a missing or corrupt list', () => {
        expect(realFailureGroups(undefined)).toEqual([]);
        expect(realFailureGroups({} as any)).toEqual([]);
    });
    it('does not mutate its input', () => {
        const input = groups(2, 1);
        realFailureGroups(input);
        expect(input.map(g => g.no)).toEqual([2, 1]);
    });
});

describe('failureGroupMetaFields', () => {
    it('is null when the workspace has no Failure Group slice (the caller must not write a 0)', () => {
        expect(failureGroupMetaFields(undefined)).toBeNull();
        expect(failureGroupMetaFields(null)).toBeNull();
    });
    it('counts real groups and keeps the first three numbers in group-number order', () => {
        expect(failureGroupMetaFields(groups(0, 7, 2, 1, 4))).toEqual({ failureGroupCount: 4, failureGroupNos: [1, 2, 4] });
        expect(FG_CHIP_MAX_SWATCHES).toBe(3);
    });
    it('is an explicit 0 for a slice with no real groups', () => {
        expect(failureGroupMetaFields(groups(0))).toEqual({ failureGroupCount: 0, failureGroupNos: [] });
        expect(failureGroupMetaFields([])).toEqual({ failureGroupCount: 0, failureGroupNos: [] });
    });
});

describe('recentProjectFgChip', () => {
    it('shows no chip for an entry saved before the fields existed', () => {
        expect(recentProjectFgChip({})).toBeNull();
        expect(recentProjectFgChip({ failureGroupCount: undefined, failureGroupNos: [1] })).toBeNull();
        expect(recentProjectFgChip({ failureGroupCount: -1 })).toBeNull();
    });
    it('shows the neutral "No failure groups" chip at 0', () => {
        expect(recentProjectFgChip({ failureGroupCount: 0, failureGroupNos: [] })).toEqual({ count: 0, nos: [], label: 'No failure groups' });
    });
    it('pluralises and carries at most three swatch numbers', () => {
        expect(recentProjectFgChip({ failureGroupCount: 1, failureGroupNos: [2] })).toEqual({ count: 1, nos: [2], label: '1 failure group' });
        expect(recentProjectFgChip({ failureGroupCount: 5, failureGroupNos: [1, 2, 3, 4] })).toEqual({ count: 5, nos: [1, 2, 3], label: '5 failure groups' });
    });
    it('still shows the count when the numbers are missing', () => {
        expect(recentProjectFgChip({ failureGroupCount: 2 })).toEqual({ count: 2, nos: [], label: '2 failure groups' });
    });
});

describe('summarizeFailureGroups ("N groups · M sensors assigned · x of y models complete")', () => {
    it('counts real groups, distinct assigned sensors and complete models', () => {
        const models = [
            model({ id: 'a', targetSensor: 'T1', groupNos: [1], status: true }),
            // Same sensor, another kind and another group: still one sensor.
            model({ id: 'b', kind: 'relationship', targetSensor: ' t1 ', groupNos: [2] }),
            // Clustering is keyed by X, not Y.
            model({ id: 'c', kind: 'clustering', targetSensor: '', xSensor: 'X1', ySensor: 'T1', groupNos: [1, 2] }),
            // Only in Not in Group: a model, but not an assigned sensor.
            model({ id: 'd', targetSensor: 'T9', groupNos: [0], status: true }),
            // No key sensor yet: not a sensor.
            model({ id: 'e', targetSensor: '', groupNos: [1] }),
            // Points at a group that no longer exists.
            model({ id: 'f', targetSensor: 'T7', groupNos: [99] }),
        ];
        expect(summarizeFailureGroups(groups(0, 1, 2), models, null)).toEqual({
            groupCount: 2, assignedSensorCount: 2, completeModelCount: 2, totalModelCount: 6,
        });
    });

    it('uses isModelComplete: a complete model whose inputs changed since training is not counted', () => {
        const stale = model({ id: 's', status: true, lastTrainedAt: '2026-10-01T00:00:00Z', trainedFingerprint: 'old' } as any);
        expect(summarizeFailureGroups(groups(1), [stale], null).completeModelCount).toBe(0);
    });

    it('handles an empty or missing workspace', () => {
        const zero = { groupCount: 0, assignedSensorCount: 0, completeModelCount: 0, totalModelCount: 0 };
        expect(summarizeFailureGroups(undefined, undefined, undefined)).toEqual(zero);
        expect(summarizeFailureGroups(groups(0), [], null)).toEqual(zero);
    });

    it('tolerates a legacy model without groupNos', () => {
        const legacy = { ...model({ id: 'l' }), groupNos: undefined } as unknown as FailureModel;
        expect(summarizeFailureGroups(groups(1), [legacy], null)).toMatchObject({ assignedSensorCount: 0, totalModelCount: 1 });
    });
});
