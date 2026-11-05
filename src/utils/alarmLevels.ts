import type { AlarmLevel, SensorMetadata } from '../types';

/** Alarm setpoint levels, low to high, paired with their SensorMetadata field. */
export const ALARM_LEVELS: { level: AlarmLevel; metaKey: 'alarmLL' | 'alarmL' | 'alarmH' | 'alarmHH' }[] = [
    { level: 'LL', metaKey: 'alarmLL' },
    { level: 'L', metaKey: 'alarmL' },
    { level: 'H', metaKey: 'alarmH' },
    { level: 'HH', metaKey: 'alarmHH' },
];

/** Full label per alarm level (ISA-style terms). */
export const ALARM_LABELS: Record<AlarmLevel, string> = {
    LL: 'Low-low', L: 'Low', H: 'High', HH: 'High-high',
};

/** LL/HH are the shutdown tier, shown bold in the warning colour. */
export const isCriticalAlarmLevel = (level: AlarmLevel): boolean => level === 'LL' || level === 'HH';

/** Severity colour: amber for L/H, red for LL/HH. Plain hex because the ECharts canvas cannot resolve CSS variables. */
export const alarmLevelColor = (level: AlarmLevel): string =>
    isCriticalAlarmLevel(level) ? '#ef4444' : '#f59e0b';

/** Gates the whole checkbox list, so sensors with no setpoints show no dead-end UI. */
export const hasAlarmSetpoints = (meta: SensorMetadata | null | undefined): boolean =>
    !!meta && ALARM_LEVELS.some(({ metaKey }) => meta[metaKey] !== undefined);
