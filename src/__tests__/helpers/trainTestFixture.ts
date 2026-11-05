import type { TestPeriod, TimePeriod } from '../../types';

/** Train/scoring period fixtures. A model needs a train period to train (`getBuildBlockReason`) and a scoring period to be marked complete (`markCompleteBlockReason`). `ALL_TIME_TRAIN` is one period open at both ends; on the wire it is 'no time filter'. */
export const ALL_TIME_TRAIN: TimePeriod[] = [{ id: 'all-time', start: '', end: '' }];

/** One closed scoring period (start -> end), enough for Mark complete. January 2024 is OUTSIDE most integration datasets (2026): a period outside the data only warns, never blocks. */
export const ONE_TEST: TestPeriod[] = [{ id: 'test-1', start: '2024-01-01T00:00', end: '2024-01-31T23:59' }];

/** Periods with extra `label`/`eventTime`/`fromHighlight` keys, as an old workspace holds them: they load, stay Complete and score the same; the keys are never sent to Rust and dropped when a period is edited (`toScoringPeriod`). */
export const LEGACY_TESTS: TestPeriod[] = [
    { id: 'old-1', start: '2024-01-01T00:00', end: '2024-01-31T23:59', label: 'normal' },
    { id: 'old-2', start: '2024-03-01T00:00', end: '2024-03-31T23:59', label: 'problem', eventTime: '2024-03-20T08:00', fromHighlight: 'Bearing failure' },
];

/** A set running condition: the one 'sensor > value' line. Pass the sensor when the dataset has no `TAG1`. */
export const rcOn = (sensor = 'TAG1', value = '0') =>
    ({ id: 'rc-on', sensor, operation: 'greater_than' as const, value1: value, value2: '' });
export const RC_ON = rcOn();
