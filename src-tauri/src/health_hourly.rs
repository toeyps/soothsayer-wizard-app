//! Hourly grouping for the health score.
//!
//! The health score is computed on ONE POINT PER CLOCK HOUR: the mean of the
//! hour's rows (user decision, 2026-10-11). Training is untouched - every model
//! number (mean / SD, band, ellipses, statistics, histogram, scatters) still
//! comes from the raw training rows; only what is SCORED is hourly.
//!
//! This module is the one implementation of "which hour does a row belong to
//! and what is the hour's mean". The previews (`health_preview`) hand it the
//! rows they already selected (their universe) and score the means; the
//! scoring-period results (`health_validation::build_hourly`) and the exported
//! `validation` block count and judge the same hourly points.
//!
//! Rules:
//!   * hour = clock hour of the row's parsed timestamp
//!     (`ts_parsed.div_euclid(HOUR_US)`, the Dashboard's hourly rule); the
//!     point's timestamp is the START of that hour ([`hour_label`]);
//!   * only the rows handed in (and kept by `keep`) enter a mean - a row the
//!     running condition removed is never averaged, and an hour with no such
//!     row has NO point at all (so no score: missing, never 0);
//!   * a row without a timestamp (`TS_MISSING`) belongs to no hour;
//!   * the dataset is NOT assumed to be in time order: rows of one hour that are
//!     far apart in the file still land in the same point, and the points come
//!     out in ascending time;
//!   * no minimum coverage: an hour with a single row is that row's value.

use crate::chart_query::{hour_label, HOUR_US};
use crate::csv_processor::TS_MISSING;

/// The health score's sampling interval in seconds (`scoring_interval_secs` of
/// `compute_health_preview`, `scoring_interval_seconds` of the exported block).
pub const SCORING_INTERVAL_SECS: u64 = (HOUR_US / 1_000_000) as u64;

/// How the rows of one interval become its point (`scoring_aggregation` of the
/// exported block).
pub const SCORING_AGGREGATION: &str = "mean";

/// "This position belongs to no hour" in [`HourGroups::of`].
const NO_HOUR: u32 = u32::MAX;

/// The clock hours of a row universe, ascending in time. Positions index the
/// `rows` slice given to [`HourGroups::build`]; hour indexes (`0..len()`) index
/// every per-hour vector this type returns.
#[derive(Debug, Clone, PartialEq)]
pub struct HourGroups {
    /// Hour number (`ts_parsed.div_euclid(HOUR_US)`) of each point, ascending.
    hours: Vec<i64>,
    /// Lowest dataset row of each hour.
    first_row: Vec<u32>,
    /// Rows of each hour.
    counts: Vec<u32>,
    /// Hour index of each universe position ([`NO_HOUR`] = none).
    of: Vec<u32>,
}

impl HourGroups {
    /// Group the universe `rows` (dataset row numbers; `ts_parsed` is indexed by
    /// them) by clock hour. `keep(position)` = does this row take part at all
    /// (`false` for a row that is in the raw series but out of the scored
    /// scope). One O(n) pass when the kept rows are in time order (the normal
    /// case), O(n log n) otherwise.
    pub fn build(ts_parsed: &[i64], rows: &[u32], keep: impl Fn(usize) -> bool) -> HourGroups {
        // A real timestamp never floors to `i64::MIN`, so it marks "no hour".
        const NO_KEY: i64 = i64::MIN;
        let mut keys: Vec<i64> = Vec::with_capacity(rows.len());
        let mut hours: Vec<i64> = Vec::new();
        let mut monotone = true;
        for (i, &r) in rows.iter().enumerate() {
            let ts = ts_parsed.get(r as usize).copied().unwrap_or(TS_MISSING);
            if ts == TS_MISSING || !keep(i) {
                keys.push(NO_KEY);
                continue;
            }
            let k = ts.div_euclid(HOUR_US);
            keys.push(k);
            match hours.last() {
                Some(&last) if k == last => {}
                Some(&last) if k < last => {
                    monotone = false;
                    hours.push(k);
                }
                _ => hours.push(k),
            }
        }
        if !monotone {
            hours.sort_unstable();
            hours.dedup();
        }
        let mut first_row = vec![u32::MAX; hours.len()];
        let mut counts = vec![0u32; hours.len()];
        let mut of: Vec<u32> = Vec::with_capacity(rows.len());
        let mut cur = 0usize;
        for (i, &k) in keys.iter().enumerate() {
            if k == NO_KEY {
                of.push(NO_HOUR);
                continue;
            }
            let h = if monotone {
                while hours[cur] != k {
                    cur += 1;
                }
                cur
            } else {
                hours.binary_search(&k).expect("every kept hour was collected")
            };
            first_row[h] = first_row[h].min(rows[i]);
            counts[h] += 1;
            of.push(h as u32);
        }
        HourGroups {
            hours,
            first_row,
            counts,
            of,
        }
    }

    /// Number of hourly points.
    pub fn len(&self) -> usize {
        self.hours.len()
    }

    #[cfg_attr(not(test), allow(dead_code))] // the conventional partner of `len`
    pub fn is_empty(&self) -> bool {
        self.hours.is_empty()
    }

    /// Hour index of universe position `pos` (`None` = no timestamp / not kept).
    pub fn hour_of(&self, pos: usize) -> Option<usize> {
        self.of
            .get(pos)
            .copied()
            .filter(|&h| h != NO_HOUR)
            .map(|h| h as usize)
    }

    /// Hour number (`ts_parsed.div_euclid(HOUR_US)`) of every point, ascending
    /// and unique: the hour's identity across two groupings of the same
    /// dataset (the Relation model keys its stored predictions by it).
    pub fn hour_keys(&self) -> &[i64] {
        &self.hours
    }

    /// Lowest dataset row of hour `h` (what `hourly.rows` carries).
    pub fn first_row(&self, h: usize) -> u32 {
        self.first_row[h]
    }

    /// The lowest dataset row of every hour.
    pub fn first_rows(&self) -> &[u32] {
        &self.first_row
    }

    /// Rows averaged into each hour (no minimum coverage is applied: a
    /// one-row hour is scored from that single reading - user decision).
    #[cfg_attr(not(test), allow(dead_code))] // kept for the tests / diagnostics
    pub fn counts(&self) -> &[u32] {
        &self.counts
    }

    /// Timestamp text of hour `h`: the hour's START.
    pub fn label(&self, h: usize) -> String {
        hour_label(self.hours[h])
    }

    /// Mean of `value_at(position)` over the rows of each hour. Non-finite
    /// values are skipped (an input that is missing on a row does not poison
    /// the hour); an hour with no finite value gives `NaN`.
    pub fn mean(&self, value_at: impl Fn(usize) -> f64) -> Vec<f64> {
        let mut sum = vec![0.0f64; self.len()];
        let mut n = vec![0u32; self.len()];
        for (i, &h) in self.of.iter().enumerate() {
            if h == NO_HOUR {
                continue;
            }
            let v = value_at(i);
            if v.is_finite() {
                sum[h as usize] += v;
                n[h as usize] += 1;
            }
        }
        sum.iter()
            .zip(&n)
            .map(|(&s, &c)| if c > 0 { s / f64::from(c) } else { f64::NAN })
            .collect()
    }

    /// Per hour: does at least one of its rows satisfy `flag_at(position)`?
    pub fn any(&self, flag_at: impl Fn(usize) -> bool) -> Vec<bool> {
        let mut out = vec![false; self.len()];
        for (i, &h) in self.of.iter().enumerate() {
            if h != NO_HOUR && !out[h as usize] && flag_at(i) {
                out[h as usize] = true;
            }
        }
        out
    }

    /// Per hour: the label shared by EVERY row of the hour, or `none` when its
    /// rows do not all carry the same label. A row labelled `none` agrees with
    /// no other label, so one such row among labelled ones is enough to make
    /// the hour `none` (an hour whose rows are all `none` is `none` too). One
    /// O(rows) pass; a row with no hour is never looked at.
    pub fn unanimous(&self, label_at: impl Fn(usize) -> u32, none: u32) -> Vec<u32> {
        let mut out = vec![none; self.len()];
        let mut seen = vec![false; self.len()];
        for (i, &h) in self.of.iter().enumerate() {
            if h == NO_HOUR {
                continue;
            }
            let h = h as usize;
            if !seen[h] {
                seen[h] = true;
                out[h] = label_at(i);
            } else if out[h] != none && out[h] != label_at(i) {
                // Disagreement is final: `none` never matches a later label.
                out[h] = none;
            }
        }
        out
    }

    /// The hours (ascending, unique) that hold at least one of the universe
    /// `positions` - e.g. the hourly points of one scoring period.
    pub fn members(&self, positions: impl IntoIterator<Item = usize>) -> Vec<usize> {
        let mut seen = vec![false; self.len()];
        for p in positions {
            if let Some(h) = self.hour_of(p) {
                seen[h] = true;
            }
        }
        (0..self.len()).filter(|&h| seen[h]).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN_US: i64 = 60_000_000;

    /// Timestamps `start_min + i * step_min` minutes after hour 1000.
    fn ts(n: usize, start_min: i64, step_min: i64) -> Vec<i64> {
        (0..n as i64)
            .map(|i| 1000 * HOUR_US + (start_min + i * step_min) * MIN_US)
            .collect()
    }

    fn all(n: usize) -> Vec<u32> {
        (0..n as u32).collect()
    }

    #[test]
    fn five_minute_rows_give_one_point_per_hour_with_the_mean_of_its_twelve_rows() {
        let t = ts(36, 0, 5);
        let g = HourGroups::build(&t, &all(36), |_| true);
        assert_eq!(g.len(), 3);
        assert_eq!(g.counts(), &[12, 12, 12]);
        assert_eq!(g.first_rows(), &[0, 12, 24]);
        let v: Vec<f64> = (0..36).map(|i| i as f64).collect();
        let m = g.mean(|i| v[i]);
        // Mean of 0..=11, 12..=23, 24..=35.
        assert_eq!(m, vec![5.5, 17.5, 29.5]);
        assert_eq!(g.hour_of(11), Some(0));
        assert_eq!(g.hour_of(12), Some(1));
    }

    #[test]
    fn the_label_is_the_start_of_the_clock_hour_like_the_dashboard() {
        // 2024-01-01T10:25:00 as epoch microseconds.
        let dt = chrono::NaiveDate::from_ymd_opt(2024, 1, 1)
            .unwrap()
            .and_hms_opt(10, 25, 0)
            .unwrap();
        let us = dt.and_utc().timestamp_micros();
        let g = HourGroups::build(&[us, us + 34 * MIN_US, us + 35 * MIN_US], &[0, 1, 2], |_| true);
        assert_eq!(g.len(), 2, "10:25 and 10:59 share an hour, 11:00 starts the next");
        // The hour's identity: the same number whatever rows the grouping holds.
        assert_eq!(g.hour_keys(), &[us.div_euclid(HOUR_US), us.div_euclid(HOUR_US) + 1]);
        let later_only = HourGroups::build(&[us, us + 34 * MIN_US, us + 35 * MIN_US], &[2], |_| true);
        assert_eq!(later_only.hour_keys(), &g.hour_keys()[1..]);
        assert_eq!(g.label(0), "2024-01-01T10:00:00");
        assert_eq!(g.label(1), "2024-01-01T11:00:00");
        assert_eq!(g.label(0), crate::chart_query::hour_label(us.div_euclid(HOUR_US)));
        assert_eq!(SCORING_INTERVAL_SECS, 3600);
        assert_eq!(SCORING_AGGREGATION, "mean");
    }

    #[test]
    fn rows_that_are_not_kept_never_enter_a_mean_and_an_hour_without_a_kept_row_has_no_point() {
        // Hour 0: rows 0..12 (only 3 running), hour 1: nothing running, hour 2: all.
        let t = ts(36, 0, 5);
        let running = |i: usize| matches!(i, 2 | 5 | 7) || i >= 24;
        let g = HourGroups::build(&t, &all(36), running);
        assert_eq!(g.len(), 2, "the stopped hour has no point");
        assert_eq!(g.counts(), &[3, 12]);
        assert_eq!(g.first_rows(), &[2, 24]);
        let v: Vec<f64> = (0..36).map(|i| if running(i) { 10.0 } else { 9999.0 }).collect();
        assert_eq!(g.mean(|i| v[i]), vec![10.0, 10.0], "a stopped row's value is never averaged");
        assert_eq!(g.hour_of(0), None);
        assert_eq!(g.hour_of(13), None);
        assert_eq!(g.label(1), hour_label(1002));
    }

    #[test]
    fn a_universe_that_is_a_subset_of_the_dataset_uses_the_dataset_rows_timestamps() {
        // The universe holds dataset rows 3, 4 and 30 only.
        let t = ts(36, 0, 5);
        let g = HourGroups::build(&t, &[3, 4, 30], |_| true);
        assert_eq!(g.len(), 2);
        assert_eq!(g.first_rows(), &[3, 30]);
        assert_eq!(g.counts(), &[2, 1]);
        assert_eq!(g.mean(|i| [1.0, 3.0, 8.0][i]), vec![2.0, 8.0], "a one-row hour is that row");
    }

    #[test]
    fn unsorted_timestamps_group_by_hour_and_come_out_in_time_order() {
        // Dataset order: hour 2, hour 0, hour 1, hour 0, hour 2.
        let t = vec![
            1002 * HOUR_US + 5 * MIN_US,
            1000 * HOUR_US + 50 * MIN_US,
            1001 * HOUR_US,
            1000 * HOUR_US + 10 * MIN_US,
            1002 * HOUR_US + 59 * MIN_US,
        ];
        let g = HourGroups::build(&t, &all(5), |_| true);
        assert_eq!(g.len(), 3);
        assert_eq!((g.label(0), g.label(2)), (hour_label(1000), hour_label(1002)));
        assert_eq!(g.counts(), &[2, 1, 2]);
        assert_eq!(g.first_rows(), &[1, 2, 0], "the LOWEST dataset row of the hour");
        let v = [20.0, 1.0, 5.0, 3.0, 40.0];
        assert_eq!(g.mean(|i| v[i]), vec![2.0, 5.0, 30.0]);
        assert_eq!((g.hour_of(0), g.hour_of(1), g.hour_of(3)), (Some(2), Some(0), Some(0)));
        // The same rows in time order give the very same points.
        let mut order: Vec<usize> = (0..5).collect();
        order.sort_by_key(|&i| t[i]);
        let ts_sorted: Vec<i64> = order.iter().map(|&i| t[i]).collect();
        let gs = HourGroups::build(&ts_sorted, &all(5), |_| true);
        assert_eq!(gs.mean(|i| v[order[i]]), g.mean(|i| v[i]));
        assert_eq!(gs.counts(), g.counts());
    }

    #[test]
    fn a_row_without_a_timestamp_belongs_to_no_hour() {
        let mut t = ts(6, 0, 20);
        t[1] = TS_MISSING;
        t[4] = TS_MISSING;
        let g = HourGroups::build(&t, &all(6), |_| true);
        assert_eq!(g.len(), 2);
        assert_eq!(g.counts(), &[2, 2]);
        assert_eq!((g.hour_of(1), g.hour_of(4)), (None, None));
        let v = [1.0, 1000.0, 3.0, 5.0, 1000.0, 7.0];
        assert_eq!(g.mean(|i| v[i]), vec![2.0, 6.0]);
        // Nothing but missing timestamps: no point at all (never a panic).
        let none = HourGroups::build(&[TS_MISSING; 3], &all(3), |_| true);
        assert!(none.is_empty());
        assert!(none.mean(|_| 1.0).is_empty() && none.any(|_| true).is_empty());
        assert!(HourGroups::build(&[], &[], |_| true).is_empty());
    }

    #[test]
    fn data_already_at_one_hour_or_coarser_keeps_one_point_per_row() {
        // 1 h rows: every row is its own hour, the mean is the row.
        let t = ts(5, 0, 60);
        let g = HourGroups::build(&t, &all(5), |_| true);
        assert_eq!(g.len(), 5);
        assert_eq!(g.counts(), &[1; 5]);
        let v = [3.0, 1.0, 4.0, 1.0, 5.0];
        assert_eq!(g.mean(|i| v[i]), v.to_vec());
        // 2 h rows: one point per row, the hours in between have no point
        // (nothing is interpolated).
        let t = ts(4, 30, 120);
        let g = HourGroups::build(&t, &all(4), |_| true);
        assert_eq!(g.len(), 4);
        assert_eq!(
            (0..4).map(|h| g.label(h)).collect::<Vec<_>>(),
            vec![hour_label(1000), hour_label(1002), hour_label(1004), hour_label(1006)]
        );
        assert_eq!(g.mean(|i| v[i]), v[..4].to_vec());
    }

    #[test]
    fn a_missing_input_is_skipped_and_an_hour_with_none_is_nan() {
        let t = ts(6, 0, 20);
        let g = HourGroups::build(&t, &all(6), |_| true);
        let v = [f64::NAN, 4.0, 6.0, f64::NAN, f64::NAN, f64::NAN];
        let m = g.mean(|i| v[i]);
        assert_eq!(m[0], 5.0, "the mean of the finite values");
        assert!(m[1].is_nan(), "no finite value in the hour");
        let inf = [f64::INFINITY, 1.0, 3.0, 0.0, 0.0, 0.0];
        assert_eq!(g.mean(|i| inf[i])[0], 2.0);
    }

    #[test]
    fn flags_and_period_membership_need_one_row_of_the_hour() {
        // 20-minute rows, 3 hours. Training = rows 0..=3, a period = rows 4..=6.
        let t = ts(9, 0, 20);
        let g = HourGroups::build(&t, &all(9), |_| true);
        let train = g.any(|i| i <= 3);
        assert_eq!(train, vec![true, true, false], "hour 1 holds one training row (row 3)");
        assert_eq!(g.members(4..=6), vec![1, 2], "and two rows of the period: a boundary hour is both");
        assert_eq!(g.members([8usize, 0, 8]), vec![0, 2], "ascending and unique");
        assert!(g.members(std::iter::empty()).is_empty());
        // Positions without an hour are ignored.
        let mut t2 = t.clone();
        t2[4] = TS_MISSING;
        let g2 = HourGroups::build(&t2, &all(9), |_| true);
        assert_eq!(g2.members([4usize]), Vec::<usize>::new());
        assert_eq!(g2.members([4usize, 99]), Vec::<usize>::new(), "an unknown position is not an error");
    }

    #[test]
    fn unanimous_is_the_label_every_row_of_the_hour_shares_or_none() {
        const NONE: u32 = u32::MAX;
        // 20-minute rows: 6 hours of 3 rows.
        let t = ts(18, 0, 20);
        let g = HourGroups::build(&t, &all(18), |_| true);
        let labels: [u32; 18] = [
            0, 0, 0, // all the same
            0, 1, 0, // two labels
            2, 2, NONE, // one row without a label
            NONE, NONE, NONE, // no row has one
            NONE, 1, 1, // the unlabelled row comes FIRST
            0, 2, 1, // three labels
        ];
        assert_eq!(g.unanimous(|i| labels[i], NONE), vec![0, NONE, NONE, NONE, NONE, NONE]);
        // A disagreement is final: a later row equal to the first does not undo it.
        let back: [u32; 3] = [1, 0, 1];
        let g3 = HourGroups::build(&t[..3], &all(3), |_| true);
        assert_eq!(g3.unanimous(|i| back[i], NONE), vec![NONE]);
        // A one-row hour is that row's label.
        let g1 = HourGroups::build(&ts(3, 0, 60), &all(3), |_| true);
        assert_eq!(g1.unanimous(|i| [2, NONE, 0][i], NONE), vec![2, NONE, 0]);
        // Rows that belong to no hour (no timestamp / not kept) never vote.
        let mut t2 = t[..6].to_vec();
        t2[1] = TS_MISSING;
        let g2 = HourGroups::build(&t2, &all(6), |i| i != 4);
        assert_eq!(g2.unanimous(|i| labels[i].max(u32::from(i == 1) * 7), NONE), vec![0, 0]);
        // Unsorted rows: the rows of one hour vote together wherever they are.
        let tu = vec![1002 * HOUR_US, 1000 * HOUR_US, 1002 * HOUR_US + MIN_US, 1000 * HOUR_US + MIN_US];
        let gu = HourGroups::build(&tu, &all(4), |_| true);
        assert_eq!(gu.unanimous(|i| [1, 0, 1, 2][i], NONE), vec![NONE, 1]);
        assert!(HourGroups::build(&[], &[], |_| true).unanimous(|_| 0, NONE).is_empty());
    }

    #[test]
    fn timestamps_before_1970_floor_into_their_own_hour() {
        // -30 min and +30 min are different clock hours (floor, not truncation).
        let g = HourGroups::build(&[-30 * MIN_US, 30 * MIN_US], &[0, 1], |_| true);
        assert_eq!(g.len(), 2);
        assert_eq!(g.label(0), "1969-12-31T23:00:00");
        assert_eq!(g.label(1), "1970-01-01T00:00:00");
    }
}
