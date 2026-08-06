import type { AlarmLevel, SensorMetadata } from '../types';

/** Alarm setpoint levels, low to high, paired with their SensorMetadata field. */
export const ALARM_LEVELS: { level: AlarmLevel; metaKey: 'alarmLL' | 'alarmL' | 'alarmH' | 'alarmHH' }[] = [
    { level: 'LL', metaKey: 'alarmLL' },
    { level: 'L', metaKey: 'alarmL' },
    { level: 'H', metaKey: 'alarmH' },
    { level: 'HH', metaKey: 'alarmHH' },
];

/** Full label for each alarm level's checkbox row — short "High"/"Low" for
 *  the two common levels, "-low"/"-high" suffix for the shutdown-tier ones,
 *  standard ISA-style terminology. */
export const ALARM_LABELS: Record<AlarmLevel, string> = {
    LL: 'Low-low', L: 'Low', H: 'High', HH: 'High-high',
};

/** LL/HH are the shutdown-tier levels — the reference design calls these
 *  out visually (bold, warning color) versus the plain L/H levels. */
export const isCriticalAlarmLevel = (level: AlarmLevel): boolean => level === 'LL' || level === 'HH';

/** Severity color per level — amber for the plain L/H warning tier, red for
 *  the LL/HH shutdown tier. Fixed (not theme-conditional): a saturated
 *  amber/red reads clearly against both dark and light backgrounds, and a
 *  single constant color is what makes the checkbox text, the chart line,
 *  and the chart's on-line label all visually agree as "the same thing" —
 *  the whole point of colorng by severity instead of by sensor. Used both
 *  as a CSS color string (checkbox text) and passed straight into ECharts'
 *  canvas-rendered lineStyle/label (which can't resolve CSS custom
 *  properties), so this stays a plain hex, not `var(--warn)`/`var(--danger)`. */
export const alarmLevelColor = (level: AlarmLevel): string =>
    isCriticalAlarmLevel(level) ? '#ef4444' : '#f59e0b';

/** Whether a sensor has at least one alarm setpoint worth showing checkboxes
 *  for — gates the whole checkbox list, not just its contents, so there's no
 *  dead-end UI for sensors with no setpoints at all. */
export const hasAlarmSetpoints = (meta: SensorMetadata | null | undefined): boolean =>
    !!meta && ALARM_LEVELS.some(({ metaKey }) => meta[metaKey] !== undefined);
