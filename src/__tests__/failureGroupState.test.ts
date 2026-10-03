import { describe, it, expect } from 'vitest';
import { withFailureGroupState, restoreDeletedModel } from '../utils/failureGroupState';
import type { FailureGroup, FailureModel } from '../types';

describe('withFailureGroupState', () => {
    it('applies the patch and keeps every field it was not given (the reason it exists: writers that listed fields by hand dropped the ones they did not know about)', () => {
                const prev: any = {
            id: 'ws1', name: 'A',
            failureGroupState: {
                groups: [{ no: 1, name: 'G' }], models: [{ id: 'm1' }],
                runningConditionTimePeriods: [{ id: 'p1', start: '2026-01-01T00:00', end: '2026-02-01T00:00' }], someFutureField: 'keep-me',
            },
        };
        const next: any = withFailureGroupState(prev, { runningConditionCombine: 'or' });
        expect(next.failureGroupState.runningConditionCombine).toBe('or');
        expect(next.failureGroupState.runningConditionTimePeriods).toEqual([{ id: 'p1', start: '2026-01-01T00:00', end: '2026-02-01T00:00' }]);
        expect(next.failureGroupState.someFutureField).toBe('keep-me');
        expect(next.failureGroupState.groups).toEqual([{ no: 1, name: 'G' }]);
        expect(next.name).toBe('A');
    });

    it('creates a valid slice when the workspace has none yet', () => {
                const next: any = withFailureGroupState({ id: 'ws1' } as any, { runningConditionCombine: 'or' });
        expect(next.failureGroupState).toEqual({ groups: [], models: [], runningConditionCombine: 'or' });
    });

    it('a patched field wins over the existing value', () => {
                const next: any = withFailureGroupState(
            { id: 'ws1', failureGroupState: { groups: [], models: [], runningConditionCombine: 'and' } } as any,
            { runningConditionCombine: 'or' },
        );
        expect(next.failureGroupState.runningConditionCombine).toBe('or');
    });
});

describe('restoreDeletedModel (Undo for "removing a model\'s last group deletes the model")', () => {
    const groups: FailureGroup[] = [{ no: 0, name: 'Not in Group' }, { no: 1, name: 'A' }, { no: 2, name: 'B' }];
    const model = (o: Partial<FailureModel> = {}): FailureModel => ({
        id: 'orig', groupNos: [1], name: 'N', kind: 'individual', category: 'condition', notes: 'keep', status: true,
        targetSensor: 'TAG1', predictorSensors: ['TAG2'], xSensor: '', ySensor: '',
        individualChecked: true, rcMode: null, scatterXSensor: '', relModelName: 'r', relStiffness: 5,
        clusterModelName: '', numClusters: 4, criteriaSensor: '', clusterRanges: [], filterTimePeriods: [],
        runningConditionMode: 'custom', customRunningConditionFilters: [], customRunningConditionCombine: 'or',
        ...o,
    });

    it('puts the original back, field for field (same id, settings, status)', () => {
        const original = model();
        const other = model({ id: 'other', targetSensor: 'TAG9' });
        const out = restoreDeletedModel(groups, [other], original);
        expect(out).toStrictEqual([other, original]);
    });

    it('is idempotent: a model with that id already present is left alone', () => {
        const original = model();
        const models = [original];
        expect(restoreDeletedModel(groups, models, original)).toBe(models);
    });

    it('drops a membership whose group no longer exists, and parks the model in Not in Group (0) when none is left', () => {
        expect(restoreDeletedModel([groups[0], groups[2]], [], model({ groupNos: [1] }))[0].groupNos).toEqual([0]);
        expect(restoreDeletedModel([groups[0], groups[2]], [], model({ groupNos: [1, 2] }))[0].groupNos).toEqual([2]);
    });

    it('keeps "Not in Group" (0) when that is what the model was in', () => {
        expect(restoreDeletedModel(groups, [], model({ groupNos: [0] }))[0].groupNos).toEqual([0]);
    });

    it('when the user re-added the same kind for the same sensor (a blank model, new id), the original replaces it and the memberships merge', () => {
        const blank = model({ id: 'blank', groupNos: [2], notes: '', status: false });
        const out = restoreDeletedModel(groups, [blank], model({ groupNos: [1] }));
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe('orig');
        expect(out[0].notes).toBe('keep');
        expect([...out[0].groupNos].sort()).toEqual([1, 2]);
    });

    it('a re-added model parked in "Not in Group" does not drag 0 into the merge once real groups exist', () => {
        const blank = model({ id: 'blank', groupNos: [0] });
        expect(restoreDeletedModel(groups, [blank], model({ groupNos: [1] }))[0].groupNos).toEqual([1]);
    });

    it('matches the clash by kind AND sensor key (case/whitespace-insensitive); a different kind or sensor is not a clash', () => {
        const sameSensorOtherKind = model({ id: 'rel', kind: 'relationship', targetSensor: 'TAG1' });
        const otherSensorSameKind = model({ id: 'o', targetSensor: 'TAG7' });
        const spaced = model({ id: 'sp', targetSensor: '  tag1 ', groupNos: [2] });
        expect(restoreDeletedModel(groups, [sameSensorOtherKind, otherSensorSameKind], model())).toHaveLength(3);
        const merged = restoreDeletedModel(groups, [spaced], model());
        expect(merged).toHaveLength(1);
        expect(merged[0].id).toBe('orig');
    });

    it('a Clustering model is keyed by its X sensor', () => {
        const original = model({ kind: 'clustering', targetSensor: '', xSensor: 'TAG1' });
        const blank = model({ id: 'blank', kind: 'clustering', targetSensor: '', xSensor: 'tag1', groupNos: [2] });
        const out = restoreDeletedModel(groups, [blank], original);
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe('orig');
    });
});
