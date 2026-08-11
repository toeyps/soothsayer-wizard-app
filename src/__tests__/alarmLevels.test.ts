import { describe, it, expect } from 'vitest';
import type { SensorMetadata } from '../types';
import {
    ALARM_LEVELS,
    ALARM_LABELS,
    isCriticalAlarmLevel,
    alarmLevelColor,
    hasAlarmSetpoints,
} from '../utils/alarmLevels';

const baseMeta: SensorMetadata = {
    tag: 'T1',
    description: 'Test sensor',
    unit: 'C',
    component: 'Pump',
};

describe('alarmLevels', () => {
    it('ALARM_LEVELS lists all four levels low-to-high with their metadata keys', () => {
        expect(ALARM_LEVELS).toEqual([
            { level: 'LL', metaKey: 'alarmLL' },
            { level: 'L', metaKey: 'alarmL' },
            { level: 'H', metaKey: 'alarmH' },
            { level: 'HH', metaKey: 'alarmHH' },
        ]);
    });

    it('ALARM_LABELS has a human label for every level', () => {
        expect(ALARM_LABELS).toEqual({
            LL: 'Low-low', L: 'Low', H: 'High', HH: 'High-high',
        });
    });

    describe('isCriticalAlarmLevel', () => {
        it('is true for the shutdown-tier levels LL and HH', () => {
            expect(isCriticalAlarmLevel('LL')).toBe(true);
            expect(isCriticalAlarmLevel('HH')).toBe(true);
        });

        it('is false for the warning-tier levels L and H', () => {
            expect(isCriticalAlarmLevel('L')).toBe(false);
            expect(isCriticalAlarmLevel('H')).toBe(false);
        });
    });

    describe('alarmLevelColor', () => {
        it('returns red for critical levels', () => {
            expect(alarmLevelColor('LL')).toBe('#ef4444');
            expect(alarmLevelColor('HH')).toBe('#ef4444');
        });

        it('returns amber for warning levels', () => {
            expect(alarmLevelColor('L')).toBe('#f59e0b');
            expect(alarmLevelColor('H')).toBe('#f59e0b');
        });
    });

    describe('hasAlarmSetpoints', () => {
        it('is false for null or undefined metadata', () => {
            expect(hasAlarmSetpoints(null)).toBe(false);
            expect(hasAlarmSetpoints(undefined)).toBe(false);
        });

        it('is false when no alarm fields are set', () => {
            expect(hasAlarmSetpoints(baseMeta)).toBe(false);
        });

        it.each(['alarmLL', 'alarmL', 'alarmH', 'alarmHH'] as const)(
            'is true when %s is set, even to 0',
            (key) => {
                expect(hasAlarmSetpoints({ ...baseMeta, [key]: 0 })).toBe(true);
            },
        );

        it('is true when at least one of several fields is set', () => {
            expect(hasAlarmSetpoints({ ...baseMeta, alarmH: 90 })).toBe(true);
        });
    });
});
