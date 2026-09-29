import { describe, it, expect } from 'vitest';
import { computeTrainFingerprint } from '../utils/trainFingerprint';
import { mk } from './helpers/failureModelFixture';
import type { FailureGroupStateSlice, WorkspaceSensorFilter } from '../types';

function fg(over: Partial<FailureGroupStateSlice> = {}): Partial<FailureGroupStateSlice> {
    return { groups: [], models: [], ...over };
}

function condition(over: Partial<WorkspaceSensorFilter> = {}): WorkspaceSensorFilter {
    return { id: 'c1', sensor: 'TEMP1', operation: 'greater_than', value1: '10', value2: '', ...over };
}

describe('computeTrainFingerprint', () => {
    it('is deterministic for the same model + fg', () => {
        const model = mk({ id: 'm1', kind: 'relationship', targetSensor: 'Y1', predictorSensors: ['A', 'B'] });
        const f = fg({ runningConditionFilters: [condition()] });
        expect(computeTrainFingerprint(model, f)).toBe(computeTrainFingerprint(model, f));
    });

    it('is unaffected by fields that do not change the fit (name, notes, category, status, groupNos, id)', () => {
        const base = mk({ id: 'm1', kind: 'relationship', targetSensor: 'Y1', predictorSensors: ['A', 'B'] });
        const relabelled = mk({
            id: 'm2', kind: 'relationship', targetSensor: 'Y1', predictorSensors: ['A', 'B'],
            name: 'Totally different name', notes: 'some notes', category: 'performance',
            status: true, groupNos: [2, 3],
        });
        const f = fg();
        expect(computeTrainFingerprint(relabelled, f)).toBe(computeTrainFingerprint(base, f));
    });

    it('is unaffected by predictor order (same set, different order)', () => {
        const a = mk({ id: 'm1', kind: 'relationship', targetSensor: 'Y1', predictorSensors: ['A', 'B', 'C'] });
        const b = mk({ id: 'm1', kind: 'relationship', targetSensor: 'Y1', predictorSensors: ['C', 'A', 'B'] });
        const f = fg();
        expect(computeTrainFingerprint(a, f)).toBe(computeTrainFingerprint(b, f));
    });

    it('changes when the predictor set changes', () => {
        const a = mk({ id: 'm1', kind: 'relationship', targetSensor: 'Y1', predictorSensors: ['A', 'B'] });
        const b = mk({ id: 'm1', kind: 'relationship', targetSensor: 'Y1', predictorSensors: ['A', 'B', 'C'] });
        const f = fg();
        expect(computeTrainFingerprint(a, f)).not.toBe(computeTrainFingerprint(b, f));
    });

    it('changes when the Y/target sensor changes', () => {
        const a = mk({ id: 'm1', kind: 'individual', targetSensor: 'Y1' });
        const b = mk({ id: 'm1', kind: 'individual', targetSensor: 'Y2' });
        const f = fg();
        expect(computeTrainFingerprint(a, f)).not.toBe(computeTrainFingerprint(b, f));
    });

    it('changes when clustering X/Y/criteria sensors, cluster ranges or cluster count change', () => {
        const base = mk({
            id: 'm1', kind: 'clustering', xSensor: 'X1', ySensor: 'Y1', criteriaSensor: 'C1',
            numClusters: 2, clusterRanges: [{ min: null, max: 50 }, { min: 50, max: null }],
        });
        const differentRanges = { ...base, clusterRanges: [{ min: null, max: 60 }, { min: 60, max: null }] };
        const differentCount = { ...base, numClusters: 3 };
        const differentCriteria = { ...base, criteriaSensor: 'C2' };
        const f = fg();
        const baseline = computeTrainFingerprint(base, f);
        expect(computeTrainFingerprint(differentRanges, f)).not.toBe(baseline);
        expect(computeTrainFingerprint(differentCount, f)).not.toBe(baseline);
        expect(computeTrainFingerprint(differentCriteria, f)).not.toBe(baseline);
    });

    it('changes when Relation stiffness changes', () => {
        const a = mk({ id: 'm1', kind: 'relationship', targetSensor: 'Y1', predictorSensors: ['A'], relStiffness: 2 });
        const b = mk({ id: 'm1', kind: 'relationship', targetSensor: 'Y1', predictorSensors: ['A'], relStiffness: 3 });
        const f = fg();
        expect(computeTrainFingerprint(a, f)).not.toBe(computeTrainFingerprint(b, f));
    });

    it('changes when the workspace running-condition filters change (workspace mode)', () => {
        const model = mk({ id: 'm1', kind: 'individual', targetSensor: 'Y1', runningConditionMode: 'workspace' });
        const f1 = fg({ runningConditionFilters: [condition({ value1: '10' })] });
        const f2 = fg({ runningConditionFilters: [condition({ value1: '20' })] });
        expect(computeTrainFingerprint(model, f1)).not.toBe(computeTrainFingerprint(model, f2));
    });

    it('changes when the workspace AND/OR combine mode changes', () => {
        const model = mk({ id: 'm1', kind: 'individual', targetSensor: 'Y1', runningConditionMode: 'workspace' });
        const f1 = fg({ runningConditionFilters: [condition(), condition({ id: 'c2' })], runningConditionCombine: 'and' });
        const f2 = fg({ runningConditionFilters: [condition(), condition({ id: 'c2' })], runningConditionCombine: 'or' });
        expect(computeTrainFingerprint(model, f1)).not.toBe(computeTrainFingerprint(model, f2));
    });

    it('changes when the workspace training periods change', () => {
        const model = mk({ id: 'm1', kind: 'individual', targetSensor: 'Y1', runningConditionMode: 'workspace' });
        const f1 = fg({ runningConditionTimePeriods: [{ id: 'p1', start: '2026-01-01T00:00', end: '' }] });
        const f2 = fg({ runningConditionTimePeriods: [{ id: 'p1', start: '2026-02-01T00:00', end: '' }] });
        expect(computeTrainFingerprint(model, f1)).not.toBe(computeTrainFingerprint(model, f2));
    });

    it('is unaffected by period/filter row ids — only start/end/sensor/operation/value matter', () => {
        const model = mk({ id: 'm1', kind: 'individual', targetSensor: 'Y1', runningConditionMode: 'workspace' });
        const f1 = fg({
            runningConditionFilters: [condition({ id: 'id-a' })],
            runningConditionTimePeriods: [{ id: 'period-a', start: '2026-01-01T00:00', end: '' }],
        });
        const f2 = fg({
            runningConditionFilters: [condition({ id: 'id-b' })],
            runningConditionTimePeriods: [{ id: 'period-b', start: '2026-01-01T00:00', end: '' }],
        });
        expect(computeTrainFingerprint(model, f1)).toBe(computeTrainFingerprint(model, f2));
    });

    it('changes when runningConditionMode itself flips between workspace and custom, even with equivalent filters', () => {
        const conditions = [condition()];
        const workspaceModel = mk({
            id: 'm1', kind: 'individual', targetSensor: 'Y1', runningConditionMode: 'workspace',
        });
        const customModel = mk({
            id: 'm1', kind: 'individual', targetSensor: 'Y1', runningConditionMode: 'custom',
            customRunningConditionFilters: conditions, customRunningConditionCombine: 'and',
        });
        const f = fg({ runningConditionFilters: conditions, runningConditionCombine: 'and' });
        expect(computeTrainFingerprint(workspaceModel, f)).not.toBe(computeTrainFingerprint(customModel, f));
    });

    it('changes when a custom-mode model changes its own override, independent of the workspace default', () => {
        const f = fg({ runningConditionFilters: [condition({ value1: '999' })] });
        const a = mk({
            id: 'm1', kind: 'individual', targetSensor: 'Y1', runningConditionMode: 'custom',
            customRunningConditionFilters: [condition({ value1: '10' })],
        });
        const b = mk({
            id: 'm1', kind: 'individual', targetSensor: 'Y1', runningConditionMode: 'custom',
            customRunningConditionFilters: [condition({ value1: '20' })],
        });
        expect(computeTrainFingerprint(a, f)).not.toBe(computeTrainFingerprint(b, f));
    });

    // ─── QA fixes, 2026-09-29 (see docs/PROJECT_HANDOVER.md's matching entry) ───

    it('ignores clusterRanges entirely when there is no criteria sensor, for every kind (a range list is meaningless without one)', () => {
        const noCriteriaA = mk({ id: 'm1', kind: 'clustering', xSensor: 'X1', ySensor: 'Y1', criteriaSensor: '', clusterRanges: [] });
        const noCriteriaB = mk({ id: 'm1', kind: 'clustering', xSensor: 'X1', ySensor: 'Y1', criteriaSensor: '', clusterRanges: [{ min: 0, max: 33 }, { min: 33, max: 66 }, { min: 66, max: 100 }] });
        const f = fg();
        expect(computeTrainFingerprint(noCriteriaA, f)).toBe(computeTrainFingerprint(noCriteriaB, f));

        // Same for a non-clustering kind carrying a leftover/legacy clusterRanges value.
        const indivA = mk({ id: 'm1', kind: 'individual', targetSensor: 'Y1', criteriaSensor: '', clusterRanges: [] });
        const indivB = mk({ id: 'm1', kind: 'individual', targetSensor: 'Y1', criteriaSensor: '', clusterRanges: [{ min: 0, max: 50 }, { min: 50, max: 100 }] });
        expect(computeTrainFingerprint(indivA, f)).toBe(computeTrainFingerprint(indivB, f));
    });

    it('still fingerprints clusterRanges once a criteria sensor is set', () => {
        const a = mk({ id: 'm1', kind: 'clustering', xSensor: 'X1', ySensor: 'Y1', criteriaSensor: 'C1', clusterRanges: [{ min: 0, max: 50 }, { min: 50, max: 100 }] });
        const b = mk({ id: 'm1', kind: 'clustering', xSensor: 'X1', ySensor: 'Y1', criteriaSensor: 'C1', clusterRanges: [{ min: 0, max: 60 }, { min: 60, max: 100 }] });
        const f = fg();
        expect(computeTrainFingerprint(a, f)).not.toBe(computeTrainFingerprint(b, f));
    });

    it('ignores targetSensor for clustering (derived from ySensor/xSensor, not its own input there)', () => {
        const a = mk({ id: 'm1', kind: 'clustering', xSensor: 'X1', ySensor: 'Y1', targetSensor: '' });
        const b = mk({ id: 'm1', kind: 'clustering', xSensor: 'X1', ySensor: 'Y1', targetSensor: 'Y1' });
        const f = fg();
        expect(computeTrainFingerprint(a, f)).toBe(computeTrainFingerprint(b, f));
    });

    it('still fingerprints targetSensor for Individual/Relationship', () => {
        const a = mk({ id: 'm1', kind: 'individual', targetSensor: 'Y1' });
        const b = mk({ id: 'm1', kind: 'individual', targetSensor: 'Y2' });
        const f = fg();
        expect(computeTrainFingerprint(a, f)).not.toBe(computeTrainFingerprint(b, f));
    });

    it('ignores an incomplete running-condition row (no value filled in yet) — it is never sent to Rust either', () => {
        const model = mk({ id: 'm1', kind: 'individual', targetSensor: 'Y1', runningConditionMode: 'workspace' });
        const complete = fg({ runningConditionFilters: [condition()] });
        const withBlankRowAdded = fg({ runningConditionFilters: [condition(), condition({ id: 'c2', sensor: '', value1: '' })] });
        expect(computeTrainFingerprint(model, withBlankRowAdded)).toBe(computeTrainFingerprint(model, complete));
    });

    it('still fingerprints a "between" condition missing its second value as incomplete (dropped)', () => {
        const model = mk({ id: 'm1', kind: 'individual', targetSensor: 'Y1', runningConditionMode: 'workspace' });
        const noCondition = fg({ runningConditionFilters: [] });
        const halfBetween = fg({ runningConditionFilters: [condition({ operation: 'between', value2: '' })] });
        expect(computeTrainFingerprint(model, halfBetween)).toBe(computeTrainFingerprint(model, noCondition));
    });
});
