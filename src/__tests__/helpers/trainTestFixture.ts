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
 * January 2024 — which is OUTSIDE the data of most integration datasets (the
 * fake plant's 60 hourly rows from 1 Jan 2026, the `2026-01-01 … 2026-12-31`
 * bounds the mocked windows answer). That is deliberate: it is the "saved
 * scoring period outside the loaded data" state of an old workspace, and it
 * must never get in the way — a SAVED period outside the data only warns (it
 * never blocks Apply, Save changes, Train or Mark complete; only a period that
 * is added or changed in a draft is judged against the data). For one day in
 * the stricter rule of 1e8cc7d forced this fixture into 2026; it is
 * back so every suite that uses it keeps proving the tolerance.
 */
export const ONE_TEST: TestPeriod[] = [{ id: 'test-1', start: '2024-01-01T00:00', end: '2024-01-31T23:59' }];

/**
 * The same kind of list as a workspace saved BEFORE holds it: the
 * periods still carry the removed `label` / `eventTime` / `fromHighlight` keys.
 * Such a workspace must load, stay Complete and score exactly like one without
 * them (the keys are read-only legacy: ignored everywhere, never sent to Rust,
 * dropped only when a period passes through an edit — `toScoringPeriod`).
 */
export const LEGACY_TESTS: TestPeriod[] = [
    { id: 'old-1', start: '2024-01-01T00:00', end: '2024-01-31T23:59', label: 'normal' },
    { id: 'old-2', start: '2024-03-01T00:00', end: '2024-03-31T23:59', label: 'problem', eventTime: '2024-03-20T08:00', fromHighlight: 'Bearing failure' },
];
