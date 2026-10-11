import type { TestPeriodResult, ValidationResult } from '../../types/health';

/**
 * Scoring-period fixtures for UI tests: a `HealthPreview.test_validation`
 * payload as Rust returns it (`health_validation.rs`, "just score it"
 * A result is facts only: no `label`, `event_time`, `lead_days`
 * or `first_below_80`). Small, hand-checkable numbers.
 *
 * Units, as in the real payload (the health score is computed on 1-hour
 * averages): `rows` / `days` / `train_rows` / `train_days` are RAW dataset rows
 * and their running time; `hours` / `train_hours` / `scored` / `pct_below_80` /
 * `lowest` count 1-hour points, and `lowest_at` is the START of an hour. The
 * default numbers are picked so the units cannot be mixed up unnoticed: S1 has
 * 3 600 raw rows (5-minute data, 12.5 d) but 300 hours, and the train block
 * 11 578 raw rows (40.2 d) but 965 hours.
 */

/** One scoring period's result (S1 by default). */
export function makeTestResult(over: Partial<TestPeriodResult> = {}): TestPeriodResult {
    return {
        index: 1,
        start: '2026-01-01T02:00',
        end: '2026-01-01T03:00',
        // RAW: 3 600 five-minute rows = 12.5 d of running time.
        days: 12.5,
        rows: 3600,
        // HOURS: 300 one-hour points, all scored.
        hours: 300,
        train_rows: 0,
        train_days: 0,
        train_hours: 0,
        scored: 300,
        pct_below_80: 1.2,
        lowest: 84,
        // The START of the hour with the lowest score.
        lowest_at: '2026-01-01T02:00:00',
        ...over,
    };
}

export function makeValidation(over: Partial<ValidationResult> = {}): ValidationResult {
    return {
        // RAW rows / running days; `hours` = the training hours.
        train: { rows: 11578, days: 40.2, hours: 965, r2: 0.91, rmse: 2, residual_mean: 0.01, residual_sd: 1.9, mean: 50, sd: 2, within_3sd_pct: 99.6, inside_3sd_ring_pct: 98.9 },
        train_ranges: [{ start: '2026-01-01T00:00', end: '2026-01-01T01:30' }],
        tests: [makeTestResult()],
        ...over,
    };
}
