import { describe, it, expect } from 'vitest';
import type { FailureGroupStateSlice, WorkspaceSensorFilter } from '../types';
import {
    effectiveRunningCondition, isCompleteCondition, isRunningConditionConfigured,
    isWorkspaceRunningConditionConfigured, getBuildBlockReason,
} from '../utils/runningCondition';
import { mk } from './helpers/failureModelFixture';

const f = (over: Partial<WorkspaceSensorFilter> = {}): WorkspaceSensorFilter => ({
    id: 'f', sensor: 'S1', operation: 'greater_than', value1: '10', value2: '', ...over,
});
const fg = (over: Partial<FailureGroupStateSlice> = {}): FailureGroupStateSlice => ({ groups: [], models: [], ...over });

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
        expect(e).toEqual({ mode: 'workspace', filters: [], combine: 'and', noneConfirmed: false, periods: [] });
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
    it('reads the workspace periods in workspace mode and the model own periods in custom mode; a missing list means no limit', () => {
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
    const okFg = fg({ runningConditionFilters: [f()] });
    it('null when category, condition and periods are all fine', () => {
        expect(getBuildBlockReason(mk({ id: 'a', targetSensor: 'T', category: 'condition' }), okFg)).toBeNull();
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
