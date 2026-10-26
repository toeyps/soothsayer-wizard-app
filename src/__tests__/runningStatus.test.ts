import { describe, it, expect } from 'vitest';
import type { FailureGroupStateSlice, WorkspaceSensorFilter } from '../types';
import * as runningStatus from '../utils/runningStatus';
import { resolveRunningStatus, runningStatusToWire } from '../utils/runningStatus';

const cond = (sensor: string, operation: WorkspaceSensorFilter['operation'], value1: string, id = sensor + value1): WorkspaceSensorFilter =>
    ({ id, sensor, operation, value1, value2: operation === 'between' ? '9' : '' });
const fg = (over: Partial<FailureGroupStateSlice>): Partial<FailureGroupStateSlice> => ({ groups: [], models: [], ...over });
const H = ['SPEED', 'LOAD', 'TEMP'];

// Since 2026-10-26 the export's running status IS the one running condition
// ("Machine is running when <sensor> is above <value>").
describe('resolveRunningStatus', () => {
    it('is the one "sensor > value" running condition', () => {
        expect(resolveRunningStatus(fg({ runningConditionFilters: [cond('SPEED', 'greater_than', ' 1200 ')] }), H))
            .toEqual({ sensor: 'SPEED', value: 1200 });
    });
    it('ignores the old export-only line (runningStatus) entirely', () => {
        expect(resolveRunningStatus(fg({
            runningConditionFilters: [cond('SPEED', 'greater_than', '1200')],
            runningStatus: { sensor: 'LOAD', stopAtOrBelow: '5' },
        }), H)).toEqual({ sensor: 'SPEED', value: 1200 });
        expect(resolveRunningStatus(fg({ runningStatus: { sensor: 'LOAD', stopAtOrBelow: '5' } }), H)).toBeNull();
    });
    it('null while the running condition is not set', () => {
        expect(resolveRunningStatus(fg({}), H)).toBeNull();
        expect(resolveRunningStatus(null, H)).toBeNull();
        expect(resolveRunningStatus(fg({ runningConditionFilters: [] }), H)).toBeNull();
    });
    it('null for a row that is not a complete, numeric "above" on a known sensor', () => {
        for (const f of [cond('SPEED', 'greater_than', ''), cond('GONE', 'greater_than', '5'), cond('LOAD', 'greater_than', 'abc'), cond('TEMP', 'less_than', '40')]) {
            expect(resolveRunningStatus(fg({ runningConditionFilters: [f] }), H)).toBeNull();
        }
    });
    it('the old "source" / FIRST_ABOVE_NOTE / aboveConditions are gone', () => {
        expect('FIRST_ABOVE_NOTE' in runningStatus).toBe(false);
        expect('aboveConditions' in runningStatus).toBe(false);
        expect(Object.keys(resolveRunningStatus(fg({ runningConditionFilters: [cond('SPEED', 'greater_than', '1')] }), H) ?? {})).toEqual(['sensor', 'value']);
    });
});

describe('runningStatusToWire', () => {
    it('converts to { sensor, stop_if_lower_than }', () => {
        expect(runningStatusToWire({ sensor: 'SPEED', value: 1200 })).toEqual({ sensor: 'SPEED', stop_if_lower_than: 1200 });
        expect(runningStatusToWire(null)).toBeNull();
    });
});
