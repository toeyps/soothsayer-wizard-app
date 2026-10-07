import type { TestPeriod, TimePeriod } from '../../types';

/**
 * Train/Test validation (2026-10-07) fixtures. Since that change a model needs
 * at least one TRAIN period to train (`getBuildBlockReason`) and at least one
 * TEST period to be marked complete (`markCompleteBlockReason`).
 *
 * `ALL_TIME_TRAIN` is a single period open at both ends — the user's explicit
 * choice of the whole time range. On the wire it is still "no time filter"
 * (`buildPreviewFilterPayload` drops a fully open period), so tests written
 * before the change keep sending exactly the requests they asserted before.
 */
export const ALL_TIME_TRAIN: TimePeriod[] = [{ id: 'all-time', start: '', end: '' }];

/** One closed Normal test period — enough for Mark complete. */
export const ONE_TEST: TestPeriod[] = [{ id: 'test-1', start: '2024-01-01T00:00', end: '2024-01-31T23:59', label: 'normal' }];
