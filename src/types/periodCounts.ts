/** `count_period_rows` contract (TS twin of `period_counts.rs`; keep Rust's snake_case names). Per period: rows inside and how many pass the running condition, plus the same for the union of valid periods. Rejects `STALE_SESSION`, `NO_DATA`, `BAD_REQUEST` (> `MAX_COUNT_PERIODS`); an uncountable period returns `valid: false` with zeroes, left out of `union`. */

/** Most periods one call may carry. */
export const MAX_COUNT_PERIODS = 64;

/** One period of the request: the same datetime text as the train / scoring
 *  periods; blank / `null` / missing = an open bound. */
export interface PeriodCountArg {
    start?: string | null;
    end?: string | null;
}

/** Running condition as the count reads it: only `value_filters` and `combine` are read (time fields are ignored), so only these are sent. */
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
