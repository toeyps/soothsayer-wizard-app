/**
 * `count_period_rows` command contract (workbench redesign 2026-10, phase C) —
 * the TypeScript twin of `src-tauri/src/period_counts.rs`. Field names are
 * exactly what Rust sends / expects (snake_case): do not camelCase them.
 *
 *   invoke<PeriodCounts>('count_period_rows', { periods, filter, expected_generation })
 *
 * (`rename_all = "snake_case"` on the Rust side.) The only caller is
 * `countPeriodRows` in `src/utils/periodCounts.ts`, used by `usePeriodCounts`.
 *
 * For each period: how many dataset rows fall inside it and how many of those
 * are "running" (pass the running condition's value conditions), plus the same
 * numbers for the UNION of the valid periods of THAT call (a row inside two
 * overlapping periods counts once). So the train total needs the train
 * periods in a call of their own, and the scoring periods a second call.
 *
 * Errors are rejected strings: `STALE_SESSION: …` (`expected_generation` is not
 * the loaded dataset's), `NO_DATA: …` (nothing loaded), `BAD_REQUEST: …` (more
 * than `MAX_COUNT_PERIODS` periods). A period Rust cannot count is NOT an
 * error: it comes back `valid: false` with zeroes and is left out of `union`.
 */

/** Most periods one call may carry. */
export const MAX_COUNT_PERIODS = 64;

/** One period of the request: the same datetime text as the train / scoring
 *  periods; blank / `null` / missing = an open bound. */
export interface PeriodCountArg {
    start?: string | null;
    end?: string | null;
}

/** The running condition as the count reads it. The command accepts the whole
 *  training-scope filter, but only `value_filters` and `combine` are read (its
 *  time fields are ignored) — so this is all that is sent. */
export interface PeriodCountCondition {
    value_filters: {
        sensor: string;
        operation: 'less_than' | 'greater_than' | 'between' | 'equals';
        value1: number | null;
        value2: number | null;
    }[];
    combine: 'and' | 'or';
}

export type PeriodInvalidReason = 'start_unparseable' | 'end_unparseable' | 'ends_before_start';

/** One period of the request, counted. */
export interface PeriodCount {
    /** 1-based position in the request's `periods`. */
    index: number;
    /** The bounds as received, trimmed; `null` = open bound. */
    start: string | null;
    end: string | null;
    /** `false` = Rust could not count it (`invalid_reason`): zeroes, not in `union`. */
    valid: boolean;
    invalid_reason: PeriodInvalidReason | null;
    /** Dataset rows whose timestamp is inside the period. */
    rows_in_period: number;
    /** … of those, the rows that pass the running condition. */
    running_rows: number;
    /** `running_rows` as running-time days (one decimal; 0 when `interval_secs` is null). */
    running_days: number;
}

/** The same numbers over the union of the call's valid periods. */
export interface PeriodUnionCount {
    rows_in_period: number;
    running_rows: number;
    running_days: number;
}

export interface PeriodCounts {
    /** Rows of the loaded dataset (with or without a timestamp). */
    total_rows: number;
    /** The dataset's median sample interval in seconds; `null` below two valid
     *  timestamps (every `running_days` is then 0). */
    interval_secs: number | null;
    /** One entry per requested period, same order. */
    periods: PeriodCount[];
    union: PeriodUnionCount;
}
