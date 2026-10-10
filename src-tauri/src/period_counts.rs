//! Per-period running-row counts for the Running-condition modal
//! (Workbench redesign 2026-10, `docs/design/handoff/workbench-redesign/README.md`
//! section 5: a period row reads `P1  date -> date  81 d · 69 d running`).
//!
//! For a list of time periods (train periods, scoring periods - the caller
//! decides) and the running condition's VALUE conditions, [`count`] returns per
//! period how many dataset rows fall inside it and how many of those are
//! "running" (pass the conditions), plus the same two numbers for the UNION of
//! the valid periods.
//!
//! Cost - nothing here may make the modal slower:
//!   * ONE pass over `ts_parsed` for all periods together (rayon fold): a row's
//!     timestamp is compared with every period's bounds (integer compares, a
//!     bit per period - hence the cap of [`MAX_PERIODS`] = 64) and the value
//!     conditions are evaluated at most ONCE per row, and only for a row that is
//!     inside at least one period. Never one scan per period, never a timestamp
//!     string parsed per row (the bounds are parsed once, up front).
//!   * Nothing per row leaves Rust: the result is O(periods).
//!
//! Definitions shared with the scoring results (`health_validation`):
//!   * the time gate and the value conditions are the SAME code
//!     (`parse_time_bound`, `ResolvedFilter::keeps`, AND/OR `combine`), with the
//!     same rules: bounds inclusive, blank / null = open, a row without a
//!     parseable timestamp is in no period, a missing sensor value never passes
//!     a condition;
//!   * `running_days` = `health_validation::days_of(running_rows, interval)`,
//!     i.e. rows x the dataset's median sample interval, one decimal - the very
//!     function behind `test_validation.tests[].days`.
//! What differs on purpose: a scoring result counts only rows where the MODEL's
//! own inputs have a value; this count is model-free (the modal edits the
//! workspace's running condition, not one model), so for a model whose sensors
//! have gaps the scoring `days` can be a little lower than the modal's.

use rayon::prelude::*;
use serde::Serialize;

use crate::csv_processor::{ColumnarData, TS_MISSING};
use crate::health_validation::{blank_to_none, days_of, sample_interval_secs};
use crate::{parse_time_bound, PreviewFilter, ResolvedFilter, TimeRangeArg};

/// Most periods one call may carry (one bit of a `u64` per period). More is
/// refused with `BAD_REQUEST`.
pub const MAX_PERIODS: usize = 64;

/// `invalid_reason` values (stable; the UI may key on them).
pub const START_UNPARSEABLE: &str = "start_unparseable";
pub const END_UNPARSEABLE: &str = "end_unparseable";
pub const ENDS_BEFORE_START: &str = "ends_before_start";

/// One period of the request, counted.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PeriodCount {
    /// 1-based position in the request's `periods` (`P1` = 1). Every requested
    /// period is answered, in order, valid or not.
    pub index: usize,
    /// The bounds as received, trimmed; `null` = open bound.
    pub start: Option<String>,
    pub end: Option<String>,
    /// `false` = the period could not be counted (see `invalid_reason`); its
    /// three numbers are then 0 and it is left out of `union`.
    pub valid: bool,
    /// `null` when valid, otherwise `"start_unparseable"`,
    /// `"end_unparseable"` or `"ends_before_start"`.
    pub invalid_reason: Option<&'static str>,
    /// Dataset rows whose timestamp is inside the period (any sensor values).
    pub rows_in_period: usize,
    /// ... of those, the rows that pass the running condition.
    pub running_rows: usize,
    /// `running_rows` as running-time days (one decimal). `0.0` when
    /// `interval_secs` is `null` (the interval is unknown).
    pub running_days: f64,
}

/// The same numbers over the UNION of the valid periods: a row inside two
/// overlapping periods counts once.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct UnionCount {
    pub rows_in_period: usize,
    pub running_rows: usize,
    pub running_days: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PeriodCounts {
    /// Rows of the loaded dataset (with or without a timestamp).
    pub total_rows: usize,
    /// The dataset's median sample interval in seconds - what turns rows into
    /// days. `null` below two valid timestamps: every `running_days` is then 0.
    pub interval_secs: Option<f64>,
    /// One entry per requested period, same order.
    pub periods: Vec<PeriodCount>,
    pub union: UnionCount,
}

/// Per-thread tally of the one pass.
#[derive(Clone)]
struct Tally {
    in_period: Vec<usize>,
    running: Vec<usize>,
    union_in: usize,
    union_running: usize,
}

impl Tally {
    fn new(n: usize) -> Self {
        Tally {
            in_period: vec![0; n],
            running: vec![0; n],
            union_in: 0,
            union_running: 0,
        }
    }

    /// One row that is inside the periods of `mask` (bit = request position).
    #[inline]
    fn add(&mut self, mask: u64, running: bool) {
        self.union_in += 1;
        if running {
            self.union_running += 1;
        }
        let mut m = mask;
        while m != 0 {
            let k = m.trailing_zeros() as usize;
            self.in_period[k] += 1;
            if running {
                self.running[k] += 1;
            }
            m &= m - 1;
        }
    }

    fn merge(mut self, other: Tally) -> Tally {
        for (a, b) in self.in_period.iter_mut().zip(&other.in_period) {
            *a += b;
        }
        for (a, b) in self.running.iter_mut().zip(&other.running) {
            *a += b;
        }
        self.union_in += other.union_in;
        self.union_running += other.union_running;
        self
    }
}

/// Count `periods` against `data`.
///
/// `filter` is the SAME payload the preview / train commands take. Only its
/// `value_filters` and `combine` are read (the running condition); its own time
/// fields (`timestamp_start` / `timestamp_end` / `timestamp_ranges`) are
/// IGNORED - each requested period is the only time gate of its own count,
/// exactly like a scoring period in `health_validation`. A condition on a
/// sensor the dataset does not have is skipped, as everywhere else.
///
/// Errors: `BAD_REQUEST: ...` for more than [`MAX_PERIODS`] periods. A period
/// that cannot be counted is NOT an error: it comes back `valid: false`.
pub fn count(
    data: &ColumnarData,
    periods: &[TimeRangeArg],
    filter: Option<&PreviewFilter>,
) -> Result<PeriodCounts, String> {
    if periods.len() > MAX_PERIODS {
        return Err(format!(
            "BAD_REQUEST: too many periods ({}); at most {MAX_PERIODS} can be counted in one call",
            periods.len()
        ));
    }
    // The running condition alone: value conditions + AND/OR, no time gate.
    let condition = PreviewFilter {
        timestamp_start: None,
        timestamp_end: None,
        value_filters: filter.map(|f| f.value_filters.clone()).unwrap_or_default(),
        combine: filter.and_then(|f| f.combine.clone()),
        timestamp_ranges: Vec::new(),
    };
    let condition = ResolvedFilter::resolve(Some(&condition), &data.headers)
        .map_err(|e| format!("BAD_REQUEST: {e}"))?;
    // No (resolvable) condition: every row inside a period is running.
    let all_running = condition.is_noop();

    // Bounds parsed ONCE; `(request position, lo, hi)` in epoch micros,
    // inclusive, an open side widened to the i64 range.
    let mut out: Vec<PeriodCount> = Vec::with_capacity(periods.len());
    let mut bounds: Vec<(usize, i64, i64)> = Vec::with_capacity(periods.len());
    for (i, p) in periods.iter().enumerate() {
        let start = blank_to_none(&p.start);
        let end = blank_to_none(&p.end);
        let s = parse_time_bound(start.as_deref(), "start");
        let e = parse_time_bound(end.as_deref(), "end");
        let invalid_reason = match (&s, &e) {
            (Err(_), _) => Some(START_UNPARSEABLE),
            (_, Err(_)) => Some(END_UNPARSEABLE),
            (Ok(Some(a)), Ok(Some(b))) if a > b => Some(ENDS_BEFORE_START),
            _ => None,
        };
        if let (None, Ok(lo), Ok(hi)) = (invalid_reason, &s, &e) {
            bounds.push((i, lo.unwrap_or(i64::MIN), hi.unwrap_or(i64::MAX)));
        }
        out.push(PeriodCount {
            index: i + 1,
            start,
            end,
            valid: invalid_reason.is_none(),
            invalid_reason,
            rows_in_period: 0,
            running_rows: 0,
            running_days: 0.0,
        });
    }

    let n_periods = periods.len();
    let tally = if bounds.is_empty() {
        // Nothing countable: no scan at all.
        Tally::new(n_periods)
    } else {
        let ts = &data.ts_parsed;
        (0..data.n_rows())
            .into_par_iter()
            .with_min_len(8192)
            .fold(
                || Tally::new(n_periods),
                |mut tally, row| {
                    let t = ts[row];
                    // A row without a parseable timestamp is in no period.
                    if t == TS_MISSING {
                        return tally;
                    }
                    let mut mask = 0u64;
                    for &(slot, lo, hi) in &bounds {
                        if t >= lo && t <= hi {
                            mask |= 1u64 << slot;
                        }
                    }
                    if mask != 0 {
                        // The condition is evaluated once, for all periods.
                        tally.add(mask, all_running || condition.keeps(data, row));
                    }
                    tally
                },
            )
            .reduce(|| Tally::new(n_periods), Tally::merge)
    };

    let interval_secs = sample_interval_secs(data);
    for (k, p) in out.iter_mut().enumerate() {
        p.rows_in_period = tally.in_period[k];
        p.running_rows = tally.running[k];
        p.running_days = days_of(tally.running[k], interval_secs);
    }
    Ok(PeriodCounts {
        total_rows: data.n_rows(),
        interval_secs,
        periods: out,
        union: UnionCount {
            rows_in_period: tally.union_in,
            running_rows: tally.union_running,
            running_days: days_of(tally.union_running, interval_secs),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::health_validation::{TestPeriodArg, TestPlan};

    const ROWS_PER_DAY: usize = 144; // 10-minute rows

    fn stamp(i: usize) -> String {
        let (day, of_day) = (i / ROWS_PER_DAY, i % ROWS_PER_DAY);
        format!("2024-01-{:02}T{:02}:{:02}:00", day + 1, of_day / 6, (of_day % 6) * 10)
    }

    /// 4 days of 10-minute rows (576). `RUN` is 1 during 06:00-17:50 and 0
    /// otherwise (72 rows a day); `LOAD` is the row number.
    fn data() -> ColumnarData {
        let n = 4 * ROWS_PER_DAY;
        let run: Vec<f64> = (0..n)
            .map(|i| {
                let h = (i % ROWS_PER_DAY) / 6;
                if (6..18).contains(&h) { 1.0 } else { 0.0 }
            })
            .collect();
        let load: Vec<f64> = (0..n).map(|i| i as f64).collect();
        ColumnarData::from_parts(
            vec!["timestamp".into(), "RUN".into(), "LOAD".into()],
            (0..n).map(|i| Some(stamp(i))).collect(),
            vec![vec![f64::NAN; n], run, load],
        )
    }

    fn period(start: &str, end: &str) -> TimeRangeArg {
        TimeRangeArg { start: Some(start.into()), end: Some(end.into()) }
    }

    fn filter(json: &str) -> PreviewFilter {
        serde_json::from_str(json).unwrap()
    }

    fn running() -> PreviewFilter {
        filter(r#"{"value_filters":[{"sensor":"RUN","operation":"greater_than","value1":0.5}]}"#)
    }

    /// `(rows_in_period, running_rows, running_days)` of every period.
    fn nums(c: &PeriodCounts) -> Vec<(usize, usize, f64)> {
        c.periods.iter().map(|p| (p.rows_in_period, p.running_rows, p.running_days)).collect()
    }

    #[test]
    fn counts_a_period_with_and_without_a_running_condition() {
        let d = data();
        // Day 1 only (bounds inclusive: 00:00 .. 23:50).
        let p = [period("2024-01-01T00:00", "2024-01-01T23:50")];
        let c = count(&d, &p, None).unwrap();
        assert_eq!(nums(&c), vec![(144, 144, 1.0)], "no condition: every row in the period is running");
        assert_eq!((c.total_rows, c.interval_secs), (576, Some(600.0)));
        let c = count(&d, &p, Some(&running())).unwrap();
        assert_eq!(nums(&c), vec![(144, 72, 0.5)]);
        assert_eq!(c.periods[0].index, 1);
        assert!(c.periods[0].valid && c.periods[0].invalid_reason.is_none());
        assert_eq!(c.periods[0].start.as_deref(), Some("2024-01-01T00:00"));
        // One period: the union is that period.
        assert_eq!(
            c.union,
            UnionCount { rows_in_period: 144, running_rows: 72, running_days: 0.5 }
        );
    }

    #[test]
    fn overlapping_periods_each_count_their_rows_and_the_union_counts_a_row_once() {
        let d = data();
        let p = [
            period("2024-01-01T00:00", "2024-01-02T23:50"), // days 1-2
            period("2024-01-02T00:00", "2024-01-03T23:50"), // days 2-3 (day 2 shared)
            period("2024-01-02T06:00", "2024-01-02T11:50"), // inside both, all running
        ];
        let c = count(&d, &p, Some(&running())).unwrap();
        assert_eq!(nums(&c), vec![(288, 144, 1.0), (288, 144, 1.0), (36, 36, 0.3)]);
        // Days 1-3 once: 432 rows, 216 running - not 288 + 288 + 36.
        assert_eq!(
            c.union,
            UnionCount { rows_in_period: 432, running_rows: 216, running_days: 1.5 }
        );
        assert_eq!(c.periods.iter().map(|p| p.index).collect::<Vec<_>>(), vec![1, 2, 3]);
    }

    #[test]
    fn open_bounds_null_or_blank_reach_the_end_of_the_data() {
        let d = data();
        let p = [
            // Open start: everything up to the end of day 2.
            TimeRangeArg { start: None, end: Some("2024-01-02T23:50".into()) },
            // Open end (blank text): from day 4 on.
            TimeRangeArg { start: Some("2024-01-04T00:00".into()), end: Some("  ".into()) },
            // Fully open: the whole dataset.
            TimeRangeArg { start: Some("".into()), end: None },
        ];
        let c = count(&d, &p, Some(&running())).unwrap();
        assert_eq!(nums(&c), vec![(288, 144, 1.0), (144, 72, 0.5), (576, 288, 2.0)]);
        assert!(c.periods.iter().all(|p| p.valid));
        // Blank text is echoed as an open bound.
        assert_eq!((c.periods[1].start.as_deref(), c.periods[1].end.clone()), (Some("2024-01-04T00:00"), None));
        assert_eq!((c.periods[2].start.clone(), c.periods[2].end.clone()), (None, None));
        assert_eq!(c.union.rows_in_period, 576);
    }

    #[test]
    fn an_invalid_period_counts_zero_with_a_flag_and_never_fails_the_call() {
        let d = data();
        let p = [
            period("2024-01-03T00:00", "2024-01-01T00:00"), // ends before it starts
            period("2024-01-01T00:00", "2024-01-01T23:50"), // fine
            period("not a date", "2024-01-01T23:50"),
            period("2024-01-01T00:00", "31/12/2024"),
            period("nope", "nope either"), // both bad: the start is reported
        ];
        let c = count(&d, &p, Some(&running())).unwrap();
        let flags: Vec<(bool, Option<&str>)> = c.periods.iter().map(|p| (p.valid, p.invalid_reason)).collect();
        assert_eq!(
            flags,
            vec![
                (false, Some("ends_before_start")),
                (true, None),
                (false, Some("start_unparseable")),
                (false, Some("end_unparseable")),
                (false, Some("start_unparseable")),
            ]
        );
        assert_eq!(
            nums(&c),
            vec![(0, 0, 0.0), (144, 72, 0.5), (0, 0, 0.0), (0, 0, 0.0), (0, 0, 0.0)]
        );
        // Positions are kept (the valid one is still P2) and the bounds echoed.
        assert_eq!(c.periods[1].index, 2);
        assert_eq!(c.periods[0].start.as_deref(), Some("2024-01-03T00:00"));
        assert_eq!(c.periods[2].start.as_deref(), Some("not a date"));
        // Invalid periods are not part of the union.
        assert_eq!(c.union.rows_in_period, 144);
        // start == end is a one-instant period, not an error.
        let one = count(&d, &[period("2024-01-01T06:00", "2024-01-01T06:00")], Some(&running())).unwrap();
        assert_eq!(nums(&one), vec![(1, 1, 0.0)]);
        assert!(one.periods[0].valid);
        // Only invalid periods: all zero, still Ok.
        let none = count(&d, &p[..1], None).unwrap();
        assert_eq!((nums(&none), none.union.rows_in_period, none.total_rows), (vec![(0, 0, 0.0)], 0, 576));
    }

    #[test]
    fn and_needs_every_condition_or_needs_one() {
        let d = data();
        let p = [period("2024-01-01T00:00", "2024-01-01T23:50")];
        // RUN > 0.5 (rows 36..108 of day 1) and LOAD < 60 (rows 0..60).
        let conds = r#""value_filters":[
            {"sensor":"RUN","operation":"greater_than","value1":0.5},
            {"sensor":"LOAD","operation":"less_than","value1":60}]"#;
        let and = count(&d, &p, Some(&filter(&format!("{{{conds}}}")))).unwrap();
        assert_eq!(nums(&and), vec![(144, 24, 0.2)], "36..60");
        let explicit_and = count(&d, &p, Some(&filter(&format!(r#"{{{conds},"combine":"and"}}"#)))).unwrap();
        assert_eq!(nums(&explicit_and), nums(&and));
        let or = count(&d, &p, Some(&filter(&format!(r#"{{{conds},"combine":"or"}}"#)))).unwrap();
        assert_eq!(nums(&or), vec![(144, 108, 0.8)], "0..108");
        assert_eq!(or.union.running_rows, 108);
    }

    #[test]
    fn rows_without_a_timestamp_are_in_no_period() {
        let mut stamps: Vec<Option<String>> = (0..ROWS_PER_DAY).map(|i| Some(stamp(i))).collect();
        // Three rows the load could not date (missing / unparseable text).
        stamps[40] = None;
        stamps[41] = Some("garbage".into());
        stamps[42] = None;
        let n = stamps.len();
        let d = ColumnarData::from_parts(
            vec!["timestamp".into(), "RUN".into()],
            stamps,
            vec![vec![f64::NAN; n], vec![1.0; n]],
        );
        let p = [
            TimeRangeArg { start: None, end: None }, // fully open
            period("2024-01-01T06:00", "2024-01-01T07:50"), // rows 36..48, 3 undated
        ];
        let c = count(&d, &p, Some(&running())).unwrap();
        assert_eq!(c.total_rows, 144, "the total still has them");
        assert_eq!(nums(&c)[0].0, 141, "even a fully open period leaves them out");
        assert_eq!((nums(&c)[1].0, nums(&c)[1].1), (9, 9));
        assert_eq!(c.union.rows_in_period, 141);
    }

    #[test]
    fn a_missing_sensor_value_is_not_running() {
        let n = ROWS_PER_DAY;
        let mut run = vec![1.0; n];
        for v in run.iter_mut().take(10) {
            *v = f64::NAN;
        }
        let d = ColumnarData::from_parts(
            vec!["timestamp".into(), "RUN".into()],
            (0..n).map(|i| Some(stamp(i))).collect(),
            vec![vec![f64::NAN; n], run],
        );
        let c = count(&d, &[TimeRangeArg::default()], Some(&running())).unwrap();
        assert_eq!(nums(&c), vec![(144, 134, 0.9)]);
        // A condition on a sensor the dataset does not have is skipped (as in
        // training): with nothing left, every row counts as running.
        let ghost = filter(r#"{"value_filters":[{"sensor":"GONE","operation":"greater_than","value1":0.5}]}"#);
        assert_eq!(nums(&count(&d, &[TimeRangeArg::default()], Some(&ghost)).unwrap()), vec![(144, 144, 1.0)]);
    }

    #[test]
    fn the_filters_own_time_fields_are_ignored() {
        let d = data();
        let p = [period("2024-01-03T00:00", "2024-01-03T23:50")];
        let plain = count(&d, &p, Some(&running())).unwrap();
        // The training payload: its periods exclude day 3 entirely, one of them
        // is even malformed, and the legacy pair is set too (a combination
        // `ResolvedFilter::resolve` refuses) - none of it matters here.
        let train = filter(
            r#"{"timestamp_start":"2024-01-01T00:00","timestamp_end":"2024-01-01T12:00",
                "timestamp_ranges":[{"start":"2024-01-01T00:00","end":"2024-01-01T23:50"},{"start":"junk","end":null}],
                "value_filters":[{"sensor":"RUN","operation":"greater_than","value1":0.5}]}"#,
        );
        assert_eq!(count(&d, &p, Some(&train)).unwrap(), plain);
        assert_eq!(nums(&plain), vec![(144, 72, 0.5)]);
    }

    #[test]
    fn agrees_with_the_scoring_results_rows_and_days() {
        // The same period + running condition through the scoring-period code
        // (`TestPlan`, what `test_validation.tests[].rows / days` come from, for
        // a model whose inputs are never missing).
        let d = data();
        let f = filter(
            r#"{"combine":"or","value_filters":[
                {"sensor":"RUN","operation":"greater_than","value1":0.5},
                {"sensor":"LOAD","operation":"between","value1":100,"value2":130}]}"#,
        );
        let bounds = [
            (Some("2024-01-01T03:00"), Some("2024-01-02T19:20")),
            (None, Some("2024-01-03T05:00")),
            (Some("2024-01-02T00:00"), None),
        ];
        let periods: Vec<TimeRangeArg> = bounds
            .iter()
            .map(|(s, e)| TimeRangeArg { start: s.map(String::from), end: e.map(String::from) })
            .collect();
        let tests: Vec<TestPeriodArg> = bounds
            .iter()
            .map(|(s, e)| TestPeriodArg { start: s.map(String::from), end: e.map(String::from) })
            .collect();
        let plan = TestPlan::resolve(&tests, Some(&f), &d.headers);
        let scored = plan.collect_rows(&d, &|_| true);
        let interval = sample_interval_secs(&d);
        let c = count(&d, &periods, Some(&f)).unwrap();
        for (j, p) in c.periods.iter().enumerate() {
            assert!(p.running_rows > 0 && p.running_rows < p.rows_in_period, "P{}: a real split", j + 1);
            assert_eq!(p.running_rows, scored[j].len(), "P{}", j + 1);
            assert_eq!(p.running_days, days_of(scored[j].len(), interval), "P{}", j + 1);
        }
    }

    #[test]
    fn unsorted_timestamps_count_the_same() {
        // A single-file load keeps the CSV's row order, which need not be
        // chronological: the count never assumes sorted timestamps.
        let n = 2 * ROWS_PER_DAY;
        let order: Vec<usize> = (0..n).map(|i| (i * 37) % n).collect(); // a permutation (37 and 288 coprime)
        let d = ColumnarData::from_parts(
            vec!["timestamp".into(), "RUN".into()],
            order.iter().map(|&i| Some(stamp(i))).collect(),
            vec![
                vec![f64::NAN; n],
                order.iter().map(|&i| if (6..18).contains(&((i % ROWS_PER_DAY) / 6)) { 1.0 } else { 0.0 }).collect(),
            ],
        );
        let c = count(&d, &[period("2024-01-02T00:00", "2024-01-02T23:50")], Some(&running())).unwrap();
        assert_eq!((c.periods[0].rows_in_period, c.periods[0].running_rows), (144, 72));
    }

    #[test]
    fn the_number_of_periods_is_capped() {
        let d = data();
        let many = |n: usize| vec![period("2024-01-01T00:00", "2024-01-01T23:50"); n];
        let err = count(&d, &many(MAX_PERIODS + 1), None).unwrap_err();
        assert!(err.starts_with("BAD_REQUEST:"), "{err}");
        assert!(err.contains("65") && err.contains("64"), "{err}");
        // Exactly the cap works, down to the last bit of the mask.
        let c = count(&d, &many(MAX_PERIODS), Some(&running())).unwrap();
        assert_eq!(c.periods.len(), 64);
        assert!(c.periods.iter().all(|p| (p.rows_in_period, p.running_rows) == (144, 72)));
        assert_eq!(c.periods[63].index, 64);
        assert_eq!((c.union.rows_in_period, c.union.running_rows), (144, 72));
        assert_eq!(MAX_PERIODS, 64);
    }

    #[test]
    fn no_periods_and_an_empty_dataset_are_zeroes_not_errors() {
        let d = data();
        let c = count(&d, &[], Some(&running())).unwrap();
        assert!(c.periods.is_empty());
        assert_eq!((c.total_rows, c.union.rows_in_period, c.union.running_rows), (576, 0, 0));
        let empty = ColumnarData::from_parts(vec!["timestamp".into(), "RUN".into()], vec![], vec![vec![], vec![]]);
        let c = count(&empty, &[TimeRangeArg::default()], Some(&running())).unwrap();
        assert_eq!((c.total_rows, c.interval_secs), (0, None));
        assert_eq!(nums(&c), vec![(0, 0, 0.0)]);
        assert!(c.periods[0].valid);
    }

    #[test]
    fn days_are_zero_when_the_sample_interval_is_unknown() {
        // One dated row: no interval, so rows cannot become days.
        let d = ColumnarData::from_parts(
            vec!["timestamp".into(), "RUN".into()],
            vec![Some(stamp(0))],
            vec![vec![f64::NAN], vec![1.0]],
        );
        let c = count(&d, &[TimeRangeArg::default()], None).unwrap();
        assert_eq!(c.interval_secs, None);
        assert_eq!(nums(&c), vec![(1, 1, 0.0)]);
    }

    #[test]
    fn result_json_shape_is_stable() {
        let d = data();
        let c = count(
            &d,
            &[period("2024-01-01T00:00", "2024-01-01T23:50"), period("2024-01-02T00:00", "2024-01-01T00:00")],
            Some(&running()),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(&c).unwrap(),
            serde_json::json!({
                "total_rows": 576,
                "interval_secs": 600.0,
                "periods": [
                    {
                        "index": 1,
                        "start": "2024-01-01T00:00",
                        "end": "2024-01-01T23:50",
                        "valid": true,
                        "invalid_reason": null,
                        "rows_in_period": 144,
                        "running_rows": 72,
                        "running_days": 0.5
                    },
                    {
                        "index": 2,
                        "start": "2024-01-02T00:00",
                        "end": "2024-01-01T00:00",
                        "valid": false,
                        "invalid_reason": "ends_before_start",
                        "rows_in_period": 0,
                        "running_rows": 0,
                        "running_days": 0.0
                    }
                ],
                "union": { "rows_in_period": 144, "running_rows": 72, "running_days": 0.5 }
            })
        );
    }

    #[test]
    fn periods_deserialize_from_what_the_frontend_holds() {
        // Period objects as the workspace stores them: extra keys are skipped,
        // null / missing / blank bounds are open.
        let p: Vec<TimeRangeArg> = serde_json::from_str(
            r#"[{"id":"p1","start":"2024-01-01T00:00","end":"2024-01-01T23:50","label":"normal"},
                {"start":null},
                {"end":""}]"#,
        )
        .unwrap();
        let c = count(&data(), &p, None).unwrap();
        assert_eq!(c.periods.iter().map(|p| p.rows_in_period).collect::<Vec<_>>(), vec![144, 576, 576]);
    }
}
