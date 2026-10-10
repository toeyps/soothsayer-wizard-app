import type { TestPeriod, TimePeriod } from '../../types';

/**
 * Train-period / scoring-period fixtures. A model needs at least one TRAIN
 * period to train (`getBuildBlockReason`) and at least one SCORING period to
 * be marked complete (`markCompleteBlockReason`).
 *
 * `ALL_TIME_TRAIN` is a single period open at both ends — the user's explicit
 * choice of the whole time range. On the wire it is still "no time filter"
 * (`buildPreviewFilterPayload` drops a fully open period), so tests written
 * before the change keep sending exactly the requests they asserted before.
 */
export const ALL_TIME_TRAIN: TimePeriod[] = [{ id: 'all-time', start: '', end: '' }];

/**
 * One closed scoring period (start → end only) — enough for Mark complete.
 *
 * January 2026: INSIDE the data of every integration dataset (the fake plant's
 * 60 hourly rows from 1 Jan 2026, and the `2026-01-01 … 2026-12-31` bounds the
 * mocked windows answer). Since 2026-10-10 a period that lies entirely outside
 * the loaded data is invalid in the Running-condition settings (Apply / Save
 * changes are disabled on it), so a fixture that is meant to be a NORMAL scoring
 * period has to be inside it.
 */
export const ONE_TEST: TestPeriod[] = [{ id: 'test-1', start: '2026-01-01T00:00', end: '2026-01-31T23:59' }];

/** The same period in January 2024 — for suites whose own train periods and
 *  typed dates are in 2024 (they mock no dataset bounds, or bounds of their own). */
export const ONE_TEST_2024: TestPeriod[] = [{ id: 'test-1', start: '2024-01-01T00:00', end: '2024-01-31T23:59' }];

/**
 * The same kind of list as a workspace saved BEFORE 2026-10-10 holds it: the
 * periods still carry the removed `label` / `eventTime` / `fromHighlight` keys.
 * Such a workspace must load, stay Complete and score exactly like one without
 * them (the keys are read-only legacy: ignored everywhere, never sent to Rust,
 * dropped only when a period passes through an edit — `toScoringPeriod`).
 */
export const LEGACY_TESTS: TestPeriod[] = [
    { id: 'old-1', start: '2024-01-01T00:00', end: '2024-01-31T23:59', label: 'normal' },
    { id: 'old-2', start: '2024-03-01T00:00', end: '2024-03-31T23:59', label: 'problem', eventTime: '2024-03-20T08:00', fromHighlight: 'Bearing failure' },
];
