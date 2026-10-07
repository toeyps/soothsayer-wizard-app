import { describe, it, expect } from 'vitest';
import type { FailureGroupStateSlice, TestPeriod, TimePeriod, WorkspaceSensorFilter } from '../types';
import {
    effectiveRunningCondition, isCompleteCondition, isRunningConditionConfigured,
    isWorkspaceRunningConditionConfigured, getBuildBlockReason,
    markCompleteBlockReason, runningConditionApplyBlock, seedCustomFromWorkspace,
    NO_TRAIN_PERIOD_REASON, NO_TRAIN_PERIOD_REASON_CUSTOM, NO_TEST_PERIOD_REASON, NO_TEST_PERIOD_REASON_CUSTOM,
    ADD_TRAIN_PERIOD_HINT,
} from '../utils/runningCondition';
import { mk } from './helpers/failureModelFixture';

const f = (over: Partial<WorkspaceSensorFilter> = {}): WorkspaceSensorFilter => ({
    id: 'f', sensor: 'S1', operation: 'greater_than', value1: '10', value2: '', ...over,
});
const fg = (over: Partial<FailureGroupStateSlice> = {}): FailureGroupStateSlice => ({ groups: [], models: [], ...over });
const TRAIN: TimePeriod[] = [{ id: 'tr', start: '2025-01-01T00:00', end: '2025-03-31T23:59' }];
const tp = (over: Partial<TestPeriod> = {}): TestPeriod => ({ id: 't', start: '2025-04-01T00:00', end: '2025-04-30T23:59', label: 'normal', ...over });

describe('isCompleteCondition', () => {
    it('needs a sensor and value1', () => {
        expect(isCompleteCondition(f())).toBe(true);
        expect(isCompleteCondition(f({ sensor: '' }))).toBe(false);
        expect(isCompleteCondition(f({ sensor: '  ' }))).toBe(false);
        expect(isCompleteCondition(f({ value1: '' }))).toBe(false);
        expect(isCompleteCondition(f({ value1: '  ' }))).toBe(false);
    });
    it('between also needs value2', () => {
        expect(isCompleteCondition(f({ operation: 'between', value2: '' }))).toBe(false);
        expect(isCompleteCondition(f({ operation: 'between', value2: '20' }))).toBe(true);
    });
    it('when headers are given the sensor must exist (case-insensitive); without headers no check', () => {
        expect(isCompleteCondition(f({ sensor: 'gone' }), ['S1', 'S2'])).toBe(false);
        expect(isCompleteCondition(f({ sensor: 's1' }), ['S1'])).toBe(true);
        expect(isCompleteCondition(f({ sensor: 'gone' }))).toBe(true);
    });
});

describe('effectiveRunningCondition', () => {
    it('workspace mode reads the workspace slice with defaults', () => {
        const e = effectiveRunningCondition(mk({ id: 'a' }), fg());
        expect(e).toEqual({ mode: 'workspace', filters: [], combine: 'and', noneConfirmed: false, periods: [], testPeriods: [] });
        expect(effectiveRunningCondition(mk({ id: 'a' }), null).mode).toBe('workspace');
    });
    it('custom mode ignores the workspace entirely', () => {
        const m = mk({ id: 'a', runningConditionMode: 'custom', customRunningConditionFilters: [f({ id: 'c' })], customRunningConditionCombine: 'or', customRunningConditionNoneConfirmed: true, filterTimePeriods: [{ id: 'p', start: '', end: '' }] });
        const e = effectiveRunningCondition(m, fg({ runningConditionFilters: [f({ id: 'w' })], runningConditionCombine: 'and', runningConditionTimePeriods: [] }));
        expect(e.filters[0].id).toBe('c');
        expect(e.combine).toBe('or');
        expect(e.noneConfirmed).toBe(true);
        expect(e.periods).toHaveLength(1);
    });
    it('test periods: workspace list in workspace mode, the model own customTestPeriods in custom mode; missing lists read as []', () => {
        const ws = [tp({ id: 'w' })];
        const own = [tp({ id: 'c', label: 'problem' })];
        expect(effectiveRunningCondition(mk({ id: 'a', customTestPeriods: own }), fg({ runningConditionTestPeriods: ws })).testPeriods).toEqual(ws);
        expect(effectiveRunningCondition(mk({ id: 'a', runningConditionMode: 'custom', customTestPeriods: own }), fg({ runningConditionTestPeriods: ws })).testPeriods).toEqual(own);
        // Old workspaces / models without the fields load unchanged and read as "no test period".
        expect(effectiveRunningCondition(mk({ id: 'a' }), fg()).testPeriods).toEqual([]);
        expect(effectiveRunningCondition(mk({ id: 'a', runningConditionMode: 'custom' }), fg({ runningConditionTestPeriods: ws })).testPeriods).toEqual([]);
    });
    it('reads the workspace periods in workspace mode and the model own periods in custom mode; a missing list reads as []', () => {
        const ws = [{ id: 'w', start: '2025-01-01T00:00', end: '2025-01-31T23:59' }];
        const own = [{ id: 'c', start: '2025-03-01T00:00', end: '2025-03-31T23:59' }];
        expect(effectiveRunningCondition(mk({ id: 'a', filterTimePeriods: own }), fg({ runningConditionTimePeriods: ws })).periods).toEqual(ws);
        expect(effectiveRunningCondition(mk({ id: 'a', runningConditionMode: 'custom', filterTimePeriods: own }), fg({ runningConditionTimePeriods: ws })).periods).toEqual(own);
        expect(effectiveRunningCondition(mk({ id: 'a' }), fg()).periods).toEqual([]);
    });
});

describe('configured rules', () => {
    it('unconfigured by default; a complete row configures; an incomplete row does not', () => {
        expect(isWorkspaceRunningConditionConfigured(fg())).toBe(false);
        expect(isWorkspaceRunningConditionConfigured(null)).toBe(false);
        expect(isWorkspaceRunningConditionConfigured(fg({ runningConditionFilters: [f({ value1: '' })] }))).toBe(false);
        expect(isWorkspaceRunningConditionConfigured(fg({ runningConditionFilters: [f()] }))).toBe(true);
    });
    it('NoneConfirmed configures', () => {
        expect(isWorkspaceRunningConditionConfigured(fg({ runningConditionNoneConfirmed: true }))).toBe(true);
    });
    it('time periods alone never count', () => {
        const s = fg({ runningConditionTimePeriods: [{ id: 'p', start: '2025-01-01T00:00', end: '2025-02-01T00:00' }] });
        expect(isWorkspaceRunningConditionConfigured(s)).toBe(false);
        expect(isRunningConditionConfigured(mk({ id: 'a' }), s)).toBe(false);
    });
    it('a row on a sensor missing from headers does not count when headers are passed', () => {
        const s = fg({ runningConditionFilters: [f({ sensor: 'deleted' })] });
        expect(isRunningConditionConfigured(mk({ id: 'a' }), s, ['S1'])).toBe(false);
        expect(isRunningConditionConfigured(mk({ id: 'a' }), s)).toBe(true);
    });
    it('Custom is judged by its own condition, independent of the workspace', () => {
        const custom = mk({ id: 'a', runningConditionMode: 'custom' });
        expect(isRunningConditionConfigured(custom, fg({ runningConditionFilters: [f()] }))).toBe(false);
        expect(isRunningConditionConfigured({ ...custom, customRunningConditionNoneConfirmed: true }, fg())).toBe(true);
        expect(isRunningConditionConfigured({ ...custom, customRunningConditionFilters: [f()] }, fg())).toBe(true);
        // workspace unset does not block a configured Custom model, and workspace NoneConfirmed does not help a Custom one
        expect(isRunningConditionConfigured(custom, fg({ runningConditionNoneConfirmed: true }))).toBe(false);
    });
});

describe('getBuildBlockReason', () => {
    const okFg = fg({ runningConditionFilters: [f()], runningConditionTimePeriods: TRAIN });
    it('null when category, condition and train periods are all fine', () => {
        expect(getBuildBlockReason(mk({ id: 'a', targetSensor: 'T', category: 'condition' }), okFg)).toBeNull();
    });
    it('Train/Test SPEC rule 1: no train period blocks Train (the old "no period = whole dataset" default is gone)', () => {
        const noTrain = fg({ runningConditionFilters: [f()] });
        expect(getBuildBlockReason(mk({ id: 'a', targetSensor: 'T', category: 'condition' }), noTrain)).toBe(NO_TRAIN_PERIOD_REASON);
        expect(NO_TRAIN_PERIOD_REASON).toMatch(/Add a train period/);
        expect(NO_TRAIN_PERIOD_REASON).toMatch(/Running condition/);
    });
    it('Custom mode: its OWN train periods count, and the reason points to Model settings', () => {
        const custom = mk({ id: 'a', targetSensor: 'T', category: 'condition', runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true });
        // Workspace train periods do not rescue a Custom model.
        expect(getBuildBlockReason(custom, okFg)).toBe(NO_TRAIN_PERIOD_REASON_CUSTOM);
        expect(NO_TRAIN_PERIOD_REASON_CUSTOM).toMatch(/Model settings/);
        expect(getBuildBlockReason({ ...custom, filterTimePeriods: TRAIN }, fg())).toBeNull();
    });
    it('a period open at both ends is an explicit train period (counts)', () => {
        const open = fg({ runningConditionNoneConfirmed: true, runningConditionTimePeriods: [{ id: 'o', start: '', end: '' }] });
        expect(getBuildBlockReason(mk({ id: 'a', category: 'condition' }), open)).toBeNull();
    });
    it('Train does NOT need a test period', () => {
        expect(getBuildBlockReason(mk({ id: 'a', targetSensor: 'T', category: 'condition' }), { ...okFg, runningConditionTestPeriods: [] })).toBeNull();
    });
    it('category comes first (precedence category -> condition -> period)', () => {
        const badPeriods = fg({ runningConditionTimePeriods: [{ id: 'p', start: '2025-02-01T00:00', end: '2025-01-01T00:00' }] });
        expect(getBuildBlockReason(mk({ id: 'a', targetSensor: 'T' }), badPeriods)).toMatch(/category/i);
    });
    it('a model inherits category from a sibling of the same sensor in fg.models', () => {
        const sibling = mk({ id: 'i', targetSensor: 'T', category: 'condition' });
        const m = mk({ id: 'r', kind: 'relationship', targetSensor: 'T' });
        expect(getBuildBlockReason(m, { ...okFg, models: [sibling, m] })).toBeNull();
    });
    it('running condition second', () => {
        const badPeriods = fg({ runningConditionTimePeriods: [{ id: 'p', start: '2025-02-01T00:00', end: '2025-01-01T00:00' }] });
        expect(getBuildBlockReason(mk({ id: 'a', targetSensor: 'T', category: 'condition' }), badPeriods)).toMatch(/running condition/i);
    });
    it('invalid period last, reporting its own reason', () => {
        const s = fg({ runningConditionNoneConfirmed: true, runningConditionTimePeriods: [{ id: 'p', start: '2025-02-01T00:00', end: '2025-01-01T00:00' }] });
        expect(getBuildBlockReason(mk({ id: 'a', targetSensor: 'T', category: 'condition' }), s)).toBe('Period 1 ends before it starts.');
    });
    it('null / undefined fg is handled', () => {
        expect(getBuildBlockReason(mk({ id: 'a', category: 'condition' }), null)).toMatch(/running condition/i);
        expect(getBuildBlockReason(mk({ id: 'a' }), undefined)).toMatch(/category/i);
    });
});

describe('markCompleteBlockReason (SPEC rule 2)', () => {
    const m = mk({ id: 'a', category: 'condition' });
    it('needs at least one test period - workspace text vs Custom text', () => {
        expect(markCompleteBlockReason(m, fg())).toBe(NO_TEST_PERIOD_REASON);
        expect(markCompleteBlockReason({ ...m, runningConditionMode: 'custom' }, fg({ runningConditionTestPeriods: [tp()] }))).toBe(NO_TEST_PERIOD_REASON_CUSTOM);
        expect(NO_TEST_PERIOD_REASON_CUSTOM).toMatch(/Model settings/);
    });
    it('null with a valid test period (Workspace and Custom)', () => {
        expect(markCompleteBlockReason(m, fg({ runningConditionTestPeriods: [tp()] }))).toBeNull();
        expect(markCompleteBlockReason({ ...m, runningConditionMode: 'custom', customTestPeriods: [tp()] }, fg())).toBeNull();
    });
    it('an invalid test period or event time blocks it', () => {
        expect(markCompleteBlockReason(m, fg({ runningConditionTestPeriods: [tp({ end: '' })] }))).toMatch(/T1 needs an end date/);
        expect(markCompleteBlockReason(m, fg({ runningConditionTestPeriods: [tp({ label: 'problem', eventTime: '2026-01-01T00:00' })] }))).toMatch(/event time must be inside T1/);
    });
});

describe('runningConditionApplyBlock (Apply of the Running-condition settings)', () => {
    it('no train period blocks Apply with the hint "Add a train period"', () => {
        expect(runningConditionApplyBlock([], [tp()])).toEqual({ kind: 'no-train', reason: ADD_TRAIN_PERIOD_HINT });
        expect(ADD_TRAIN_PERIOD_HINT).toBe('Add a train period');
    });
    it('an invalid train period comes first', () => {
        expect(runningConditionApplyBlock([{ id: 'p', start: '2025-02-01T00:00', end: '2025-01-01T00:00' }])).toEqual({ kind: 'invalid-train', reason: 'Period 1 ends before it starts.' });
    });
    it('an invalid test period / event time blocks; overlap with train does not; no test does not', () => {
        expect(runningConditionApplyBlock(TRAIN, [tp({ start: 'garbage' })])?.kind).toBe('invalid-test');
        expect(runningConditionApplyBlock(TRAIN, [tp({ label: 'problem', eventTime: '2024-12-01T00:00' })])?.kind).toBe('invalid-test');
        // Test inside train time (SPEC rule 3: may overlap) - fine.
        expect(runningConditionApplyBlock(TRAIN, [tp({ start: '2025-01-01T00:00', end: '2025-12-31T23:59' })])).toBeNull();
        expect(runningConditionApplyBlock(TRAIN, [])).toBeNull();
        expect(runningConditionApplyBlock(TRAIN)).toBeNull();
    });
});

describe('seedCustomFromWorkspace (switch to Custom, SPEC rule 7)', () => {
    let n = 0;
    const ids = { period: () => `np-${++n}`, filter: () => `nf-${++n}` };
    const ws = { filters: [f({ id: 'w' })], combine: 'or' as const, periods: TRAIN, testPeriods: [tp({ id: 'wt', label: 'problem', eventTime: '2025-04-10T00:00' })] };
    it('copies every empty list once, with fresh ids, and says how many', () => {
        n = 0;
        const r = seedCustomFromWorkspace({ customFilters: [], customPeriods: [], customTestPeriods: [] }, ws, ids);
        expect(r.copied).toEqual({ conditions: 1, periods: 1, tests: 1 });
        expect(r.patch.customCombine).toBe('or');
        expect(r.patch.customFilters?.[0]).toMatchObject({ sensor: 'S1' });
        expect(r.patch.customFilters?.[0].id).not.toBe('w');
        expect(r.patch.customPeriods?.[0]).toMatchObject({ start: TRAIN[0].start, end: TRAIN[0].end });
        expect(r.patch.customTestPeriods?.[0]).toMatchObject({ label: 'problem', eventTime: '2025-04-10T00:00' });
        expect(r.patch.customTestPeriods?.[0].id).not.toBe('wt');
    });
    it('non-destructive: a list the model already has is never overwritten (switch back and forth)', () => {
        const own = [tp({ id: 'mine' })];
        const r = seedCustomFromWorkspace({ customFilters: [f({ id: 'mf' })], customPeriods: TRAIN, customTestPeriods: own }, ws, ids);
        expect(r.patch).toEqual({});
        expect(r.copied).toEqual({ conditions: 0, periods: 0, tests: 0 });
        // Only the test list empty -> only tests copied.
        const r2 = seedCustomFromWorkspace({ customFilters: [f({ id: 'mf' })], customPeriods: TRAIN, customTestPeriods: [] }, ws, ids);
        expect(Object.keys(r2.patch)).toEqual(['customTestPeriods']);
        expect(r2.copied.tests).toBe(1);
    });
    it('nothing in the workspace -> nothing copied', () => {
        const r = seedCustomFromWorkspace({ customFilters: [], customPeriods: [], customTestPeriods: [] }, { filters: [], combine: 'and', periods: [], testPeriods: [] });
        expect(r.patch).toEqual({});
    });
});
