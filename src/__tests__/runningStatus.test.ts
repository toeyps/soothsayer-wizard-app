import { describe, it, expect } from 'vitest';
import type { FailureGroupStateSlice, WorkspaceSensorFilter } from '../types';
import { FIRST_ABOVE_NOTE, aboveConditions, resolveRunningStatus, runningStatusToWire } from '../utils/runningStatus';

const cond = (sensor: string, operation: WorkspaceSensorFilter['operation'], value1: string, id = sensor + value1): WorkspaceSensorFilter =>
    ({ id, sensor, operation, value1, value2: operation === 'between' ? '9' : '' });
const fg = (over: Partial<FailureGroupStateSlice>): Partial<FailureGroupStateSlice> => ({ groups: [], models: [], ...over });
const H = ['SPEED', 'LOAD', 'TEMP'];

describe('resolveRunningStatus', () => {
    it('single-above: exactly one complete "sensor > value" condition (other operators ignored)', () => {
        const r = resolveRunningStatus(fg({ runningConditionFilters: [cond('SPEED', 'greater_than', '1200'), cond('TEMP', 'less_than', '90')] }), H);
        expect(r).toEqual({ sensor: 'SPEED', value: 1200, source: 'single-above' });
    });
    it('single-above wins over a saved status', () => {
        const r = resolveRunningStatus(fg({
            runningConditionFilters: [cond('SPEED', 'greater_than', '1200')],
            runningStatus: { sensor: 'LOAD', stopAtOrBelow: '5' },
        }), H);
        expect(r?.source).toBe('single-above');
    });
    it('saved: several "above" conditions and a saved status with a value', () => {
        const r = resolveRunningStatus(fg({
            runningConditionFilters: [cond('SPEED', 'greater_than', '1200'), cond('LOAD', 'greater_than', '10')],
            runningStatus: { sensor: 'LOAD', stopAtOrBelow: ' 12.5 ' },
        }), H);
        expect(r).toEqual({ sensor: 'LOAD', value: 12.5, source: 'saved' });
    });
    it('saved: also when there is no "above" condition at all (Use all rows)', () => {
        const r = resolveRunningStatus(fg({ runningConditionNoneConfirmed: true, runningStatus: { sensor: 'SPEED', stopAtOrBelow: '0' } }), H);
        expect(r).toEqual({ sensor: 'SPEED', value: 0, source: 'saved' });
    });
    it('first-above: several "above" conditions, saved status missing or without a value', () => {
        const filters = [cond('SPEED', 'greater_than', '1200'), cond('LOAD', 'greater_than', '10')];
        expect(resolveRunningStatus(fg({ runningConditionFilters: filters }), H)).toEqual({ sensor: 'SPEED', value: 1200, source: 'first-above' });
        expect(resolveRunningStatus(fg({ runningConditionFilters: filters, runningStatus: { sensor: 'LOAD', stopAtOrBelow: '' } }), H)?.source).toBe('first-above');
        expect(resolveRunningStatus(fg({ runningConditionFilters: filters, runningStatus: { sensor: '', stopAtOrBelow: '3' } }), H)?.source).toBe('first-above');
        expect(FIRST_ABOVE_NOTE).toBe('Taken from the first “above” condition — check it in the running condition.');
    });
    it('none: no condition, no saved status; Use all rows ignores leftover conditions', () => {
        expect(resolveRunningStatus(fg({}), H)).toBeNull();
        expect(resolveRunningStatus(null, H)).toBeNull();
        expect(resolveRunningStatus(fg({ runningConditionNoneConfirmed: true, runningConditionFilters: [cond('SPEED', 'greater_than', '1')] }), H)).toBeNull();
        expect(resolveRunningStatus(fg({ runningStatus: null }), H)).toBeNull();
    });
    it('an incomplete, non-numeric or unknown-sensor "above" row does not count', () => {
        const filters = [cond('SPEED', 'greater_than', ''), cond('GONE', 'greater_than', '5'), cond('LOAD', 'greater_than', 'abc'), cond('TEMP', 'greater_than', '40')];
        expect(aboveConditions(fg({ runningConditionFilters: filters }), H).map(f => f.sensor)).toEqual(['TEMP']);
        expect(resolveRunningStatus(fg({ runningConditionFilters: filters }), H)?.source).toBe('single-above');
    });
});

describe('runningStatusToWire', () => {
    it('converts to { sensor, stop_if_lower_than }', () => {
        expect(runningStatusToWire({ sensor: 'SPEED', value: 1200, source: 'saved' })).toEqual({ sensor: 'SPEED', stop_if_lower_than: 1200 });
        expect(runningStatusToWire(null)).toBeNull();
    });
});
