import type { TestPeriodResult, ValidationResult } from '../../types/health';

/**
 * Scoring-period fixtures for UI tests: a `HealthPreview.test_validation`
 * payload as Rust returns it (`health_validation.rs`, "just score it"
 * A result is facts only: no `label`, `event_time`, `lead_days`
 * or `first_below_80`). Small, hand-checkable numbers.
 */

/** One scoring period's result (S1 by default). */
export function makeTestResult(over: Partial<TestPeriodResult> = {}): TestPeriodResult {
    return {
        index: 1,
        start: '2026-01-01T02:00',
        end: '2026-01-01T03:00',
        days: 12.5,
        rows: 300,
        train_rows: 0,
        train_days: 0,
        scored: 300,
        pct_below_80: 1.2,
        lowest: 84,
        lowest_at: '2026-01-01 02:30:00',
        ...over,
    };
}

export function makeValidation(over: Partial<ValidationResult> = {}): ValidationResult {
    return {
        train: { rows: 1200, days: 40.2, r2: 0.91, rmse: 2, residual_mean: 0.01, residual_sd: 1.9, mean: 50, sd: 2, within_3sd_pct: 99.6, inside_3sd_ring_pct: 98.9 },
        train_ranges: [{ start: '2026-01-01T00:00', end: '2026-01-01T01:30' }],
        tests: [makeTestResult()],
        ...over,
    };
}
