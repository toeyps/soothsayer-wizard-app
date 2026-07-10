//! Bounded, display-oriented query pipeline for the Dashboard.
//!
//! filter → operation transform → optional hourly aggregation → min/max
//! downsample, all executed Rust-side over the columnar store. The frontend
//! only ever receives O(max_points) chart points, one table page, or a CSV
//! written straight to disk — never the full dataset. This replaces the old
//! flow where `get_data` streamed every row to the WebView and React redid
//! the transforms per render (duplicating the dataset in the JS heap and
//! freezing the main thread on large CSVs).

use crate::csv_processor::{micros_to_naive, ColumnarData, CsvRecord, TS_MISSING};
use crate::{excel_safe, DataFilter, ResolvedFilter};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Write;

/// Hard ceiling on `max_points` so a bad caller can't request a "sample"
/// the size of the dataset and reintroduce the renderer OOM this module
/// exists to prevent.
const MAX_POINTS_CEILING: usize = 100_000;

/// Hard ceiling on table page size (the UI asks for 50).
const MAX_PAGE_SIZE: usize = 1_000;

const HOUR_US: i64 = 3_600_000_000;

// ---------------------------------------------------------------------------
// Wire types (deserialized from the frontend `SensorOperationConfig` verbatim)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct SingleOp {
    /// "add" | "subtract" | "multiply" | "divide" | "power"
    #[serde(rename = "type")]
    pub op_type: String,
    pub value: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiOp {
    /// "sum" | "mean" | "median" | "product" | "subtract" | "divide"
    #[serde(rename = "type")]
    pub op_type: String,
    #[serde(default)]
    pub base_sensor: Option<String>,
}

/// Mirrors the frontend `SensorOperationConfig` (camelCase keys). Extra
/// wire fields (e.g. `customName`) are ignored by serde's default behavior.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationConfig {
    /// "single" | "multi"
    pub mode: String,
    #[serde(default)]
    pub single_op: Option<SingleOp>,
    #[serde(default)]
    pub multi_op: Option<MultiOp>,
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

/// Columnar chart payload: one x-axis array + one value array per header.
/// `series[s]` aligns with `headers[s]`; `null` = missing. Bounded to
/// `max_points` rows by min/max decimation, so IPC size, JS heap, and
/// ECharts' internal buffers stay constant regardless of dataset size.
#[derive(Debug, Serialize)]
pub struct ChartView {
    pub headers: Vec<String>,
    pub timestamps: Vec<String>,
    pub series: Vec<Vec<Option<f64>>>,
    /// Rows in the (filtered, post-aggregation) population the view was
    /// decimated from — the "N Points" badge number.
    pub total_rows: usize,
    /// First/last timestamp of the filtered population (time-range inputs).
    pub ts_min: Option<String>,
    pub ts_max: Option<String>,
}

/// One page of the post-op / post-aggregation row set for the data table.
#[derive(Debug, Serialize)]
pub struct TablePage {
    pub headers: Vec<String>,
    pub rows: Vec<CsvRecord>,
    pub total_rows: usize,
}

// ---------------------------------------------------------------------------
// Resolved query context
// ---------------------------------------------------------------------------

/// Operation pre-parsed out of its wire (string) form so the per-cell hot
/// loops don't compare strings millions of times.
enum OpKind {
    None,
    Single(SingleKind),
    Multi(MultiKind),
}

enum SingleKind {
    Add(f64),
    Sub(f64),
    Mul(f64),
    Div(f64),
    Pow(f64),
    Noop,
}

enum MultiKind {
    Sum,
    Mean,
    Median,
    Product,
    /// Payload = position of the base sensor within `QueryCtx::cols`
    /// (`None` when the configured base isn't among the resolved sensors —
    /// the result column is then all-null, matching the legacy JS).
    Subtract(Option<usize>),
    Divide(Option<usize>),
}

struct QueryCtx<'a> {
    data: &'a ColumnarData,
    /// Row indices passing the dashboard filter, in dataset order.
    idx: Vec<u32>,
    /// Dataset column index per resolved sensor (requested order, unknown
    /// names dropped).
    cols: Vec<usize>,
    op: OpKind,
    /// Output header names: the resolved sensor names, or `["Result (op)"]`
    /// in multi mode.
    out_headers: Vec<String>,
}

fn resolve_ctx<'a>(
    data: &'a ColumnarData,
    filter: &DataFilter,
    operation: Option<&OperationConfig>,
) -> QueryCtx<'a> {
    let mut cols: Vec<usize> = Vec::new();
    let mut sensor_headers: Vec<String> = Vec::new();
    for s in &filter.sensors {
        if let Some(i) = data.headers.iter().position(|h| h == s) {
            cols.push(i);
            sensor_headers.push(s.clone());
        }
    }

    let preview = filter.to_preview();
    let resolved = ResolvedFilter::resolve(Some(&preview), &data.headers);
    let idx: Vec<u32> = if resolved.is_noop() {
        (0..data.n_rows() as u32).collect()
    } else {
        (0..data.n_rows() as u32)
            .filter(|&r| resolved.keeps(data, r as usize))
            .collect()
    };

    let op = match operation {
        Some(cfg) if cfg.mode == "single" => match &cfg.single_op {
            Some(s) => OpKind::Single(match s.op_type.as_str() {
                "add" => SingleKind::Add(s.value),
                "subtract" => SingleKind::Sub(s.value),
                "multiply" => SingleKind::Mul(s.value),
                "divide" => SingleKind::Div(s.value),
                "power" => SingleKind::Pow(s.value),
                _ => SingleKind::Noop,
            }),
            None => OpKind::None,
        },
        Some(cfg) if cfg.mode == "multi" => match &cfg.multi_op {
            Some(m) => {
                let base = m.base_sensor.as_ref().and_then(|b| {
                    sensor_headers.iter().position(|h| h == b)
                });
                OpKind::Multi(match m.op_type.as_str() {
                    "sum" => MultiKind::Sum,
                    "mean" => MultiKind::Mean,
                    "median" => MultiKind::Median,
                    "product" => MultiKind::Product,
                    "subtract" => MultiKind::Subtract(base),
                    "divide" => MultiKind::Divide(base),
                    // Unknown multi op → all-null result column (legacy JS
                    // left `result = null` for unmatched switch arms).
                    _ => MultiKind::Subtract(None),
                })
            }
            None => OpKind::None,
        },
        _ => OpKind::None,
    };

    let out_headers = match (&op, operation) {
        (OpKind::Multi(_), Some(cfg)) => {
            let name = cfg
                .multi_op
                .as_ref()
                .map(|m| m.op_type.as_str())
                .unwrap_or("");
            vec![format!("Result ({})", name)]
        }
        _ => sensor_headers.clone(),
    };

    QueryCtx {
        data,
        idx,
        cols,
        op,
        out_headers,
    }
}

#[inline]
fn nan_to_none(v: f64) -> Option<f64> {
    if v.is_nan() {
        None
    } else {
        Some(v)
    }
}

impl QueryCtx<'_> {
    fn n_out(&self) -> usize {
        self.out_headers.len()
    }

    /// Value of output column `c` at dataset row `r` (NaN = missing),
    /// with the operation transform applied. Mirrors the legacy JS
    /// `filteredData` math exactly, including its edge cases.
    #[inline]
    fn out_value(&self, c: usize, r: usize) -> f64 {
        match &self.op {
            OpKind::None => self.data.columns[self.cols[c]][r],
            OpKind::Single(kind) => {
                let v = self.data.columns[self.cols[c]][r];
                if v.is_nan() {
                    return f64::NAN;
                }
                match kind {
                    SingleKind::Add(x) => v + x,
                    SingleKind::Sub(x) => v - x,
                    SingleKind::Mul(x) => v * x,
                    // Legacy JS: divide-by-zero returns the value unchanged.
                    SingleKind::Div(x) => {
                        if *x != 0.0 {
                            v / x
                        } else {
                            v
                        }
                    }
                    SingleKind::Pow(x) => v.powf(*x),
                    SingleKind::Noop => v,
                }
            }
            OpKind::Multi(kind) => self.combine_multi(kind, r),
        }
    }

    /// Multi-op combine across the selected sensors at row `r`.
    fn combine_multi(&self, kind: &MultiKind, r: usize) -> f64 {
        match kind {
            MultiKind::Sum | MultiKind::Mean | MultiKind::Product | MultiKind::Median => {
                let mut valid: Vec<f64> = Vec::with_capacity(self.cols.len());
                for &col in &self.cols {
                    let v = self.data.columns[col][r];
                    if !v.is_nan() {
                        valid.push(v);
                    }
                }
                if valid.is_empty() {
                    return f64::NAN;
                }
                match kind {
                    MultiKind::Sum => valid.iter().sum(),
                    MultiKind::Mean => valid.iter().sum::<f64>() / valid.len() as f64,
                    MultiKind::Product => valid.iter().product(),
                    MultiKind::Median => {
                        valid.sort_by(|a, b| a.partial_cmp(b).unwrap());
                        let mid = valid.len() / 2;
                        if valid.len() % 2 != 0 {
                            valid[mid]
                        } else {
                            (valid[mid - 1] + valid[mid]) / 2.0
                        }
                    }
                    _ => unreachable!(),
                }
            }
            MultiKind::Subtract(base) | MultiKind::Divide(base) => {
                let Some(base_pos) = base else {
                    return f64::NAN;
                };
                let base_val = self.data.columns[self.cols[*base_pos]][r];
                if base_val.is_nan() {
                    return f64::NAN;
                }
                let mut actor_sum = 0.0;
                for (i, &col) in self.cols.iter().enumerate() {
                    if i == *base_pos {
                        continue;
                    }
                    let v = self.data.columns[col][r];
                    if !v.is_nan() {
                        actor_sum += v;
                    }
                }
                match kind {
                    MultiKind::Subtract(_) => base_val - actor_sum,
                    MultiKind::Divide(_) => {
                        if actor_sum != 0.0 {
                            base_val / actor_sum
                        } else {
                            f64::NAN
                        }
                    }
                    _ => unreachable!(),
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Hourly aggregation ("Sampling (1 hr)" select: avg/max/min/first/last)
// ---------------------------------------------------------------------------

/// Post-op rows folded into one row per wall-clock hour of the data's own
/// timestamps (load-time-parsed; rows with unparseable timestamps are
/// dropped, they can't be bucketed). Output is chronological.
struct AggRows {
    timestamps: Vec<String>,
    /// `rows[k][c]` — row-major, NaN = missing. Small: one row per hour.
    rows: Vec<Vec<f64>>,
}

#[derive(Clone, Copy)]
struct Acc {
    sum: f64,
    count: u32,
    min: f64,
    max: f64,
    first: f64,
    last: f64,
}

impl Default for Acc {
    fn default() -> Self {
        Acc {
            sum: 0.0,
            count: 0,
            min: f64::INFINITY,
            max: f64::NEG_INFINITY,
            first: f64::NAN,
            last: f64::NAN,
        }
    }
}

impl Acc {
    #[inline]
    fn add(&mut self, v: f64) {
        self.sum += v;
        self.count += 1;
        if v < self.min {
            self.min = v;
        }
        if v > self.max {
            self.max = v;
        }
        if self.first.is_nan() {
            self.first = v;
        }
        self.last = v;
    }

    fn get(&self, method: &str) -> f64 {
        if self.count == 0 {
            return f64::NAN;
        }
        match method {
            "avg" => self.sum / self.count as f64,
            "max" => self.max,
            "min" => self.min,
            "first" => self.first,
            "last" => self.last,
            _ => f64::NAN,
        }
    }
}

fn aggregate_hourly(ctx: &QueryCtx, method: &str) -> AggRows {
    let n_out = ctx.n_out();
    let mut buckets: BTreeMap<i64, Vec<Acc>> = BTreeMap::new();

    for &r in &ctx.idx {
        let r = r as usize;
        let ts = ctx.data.ts_parsed[r];
        if ts == TS_MISSING {
            continue;
        }
        let hour = ts.div_euclid(HOUR_US);
        let accs = buckets
            .entry(hour)
            .or_insert_with(|| vec![Acc::default(); n_out]);
        for (c, acc) in accs.iter_mut().enumerate() {
            let v = ctx.out_value(c, r);
            if !v.is_nan() {
                acc.add(v);
            }
        }
    }

    let mut timestamps = Vec::with_capacity(buckets.len());
    let mut rows = Vec::with_capacity(buckets.len());
    for (hour, accs) in buckets {
        let label = micros_to_naive(hour * HOUR_US)
            .map(|dt| dt.format("%Y-%m-%dT%H:%M:%S").to_string())
            .unwrap_or_default();
        timestamps.push(label);
        rows.push(accs.iter().map(|a| a.get(method)).collect());
    }
    AggRows { timestamps, rows }
}

// ---------------------------------------------------------------------------
// Min/max decimation
// ---------------------------------------------------------------------------

/// Decimate `n` logical rows down to at most `max_points` output rows.
///
/// Rows are split into `max_points / 2` contiguous buckets; each bucket
/// emits up to two rows — every series' bucket-minimum (stamped at the
/// bucket's first timestamp) and bucket-maximum (at the last). On a chart
/// where each bucket spans ~1–2 px this preserves the exact vertical
/// envelope of the raw trace (spikes included), which plain striding would
/// destroy. Under `max_points` rows it's a straight passthrough.
fn decimate(
    n: usize,
    n_cols: usize,
    ts_at: &(dyn Fn(usize) -> String + Sync),
    val_at: &(dyn Fn(usize, usize) -> f64 + Sync),
    max_points: usize,
) -> (Vec<String>, Vec<Vec<Option<f64>>>) {
    let max_points = max_points.clamp(2, MAX_POINTS_CEILING);

    if n <= max_points {
        let timestamps: Vec<String> = (0..n).map(ts_at).collect();
        let series: Vec<Vec<Option<f64>>> = (0..n_cols)
            .into_par_iter()
            .map(|c| (0..n).map(|k| nan_to_none(val_at(k, c))).collect())
            .collect();
        return (timestamps, series);
    }

    // Bucket boundaries over logical row ordinals (never empty: n > buckets).
    let buckets = (max_points / 2).max(1);
    let mut ranges: Vec<(usize, usize)> = Vec::with_capacity(buckets);
    for b in 0..buckets {
        let s = b * n / buckets;
        let e = ((b + 1) * n / buckets).min(n);
        if e > s {
            ranges.push((s, e));
        }
    }

    // Output slots per bucket: 1 for single-row buckets, else 2 (min + max).
    let mut offsets: Vec<usize> = Vec::with_capacity(ranges.len() + 1);
    offsets.push(0);
    for &(s, e) in &ranges {
        let slots = if e - s == 1 { 1 } else { 2 };
        offsets.push(offsets.last().unwrap() + slots);
    }
    let out_len = *offsets.last().unwrap();

    let mut timestamps: Vec<String> = Vec::with_capacity(out_len);
    for &(s, e) in &ranges {
        timestamps.push(ts_at(s));
        if e - s > 1 {
            timestamps.push(ts_at(e - 1));
        }
    }

    let series: Vec<Vec<Option<f64>>> = (0..n_cols)
        .into_par_iter()
        .map(|c| {
            let mut out: Vec<Option<f64>> = Vec::with_capacity(out_len);
            for &(s, e) in &ranges {
                let mut mn = f64::INFINITY;
                let mut mx = f64::NEG_INFINITY;
                let mut any = false;
                for k in s..e {
                    let v = val_at(k, c);
                    if v.is_nan() {
                        continue;
                    }
                    any = true;
                    if v < mn {
                        mn = v;
                    }
                    if v > mx {
                        mx = v;
                    }
                }
                if e - s == 1 {
                    out.push(if any { Some(mn) } else { None });
                } else if any {
                    out.push(Some(mn));
                    out.push(Some(mx));
                } else {
                    out.push(None);
                    out.push(None);
                }
            }
            out
        })
        .collect();

    (timestamps, series)
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

pub fn build_chart_view(
    data: &ColumnarData,
    filter: &DataFilter,
    operation: Option<&OperationConfig>,
    sampling: &str,
    max_points: usize,
) -> ChartView {
    let ctx = resolve_ctx(data, filter, operation);
    let headers = ctx.out_headers.clone();

    let ts_min = ctx
        .idx
        .first()
        .and_then(|&r| data.timestamps[r as usize].clone());
    let ts_max = ctx
        .idx
        .last()
        .and_then(|&r| data.timestamps[r as usize].clone());

    let (timestamps, series, total_rows) = if sampling == "raw" || headers.is_empty() {
        let n = ctx.idx.len();
        let ts_at = |k: usize| {
            ctx.data.timestamps[ctx.idx[k] as usize]
                .clone()
                .unwrap_or_default()
        };
        let val_at = |k: usize, c: usize| ctx.out_value(c, ctx.idx[k] as usize);
        let (t, s) = decimate(n, ctx.n_out(), &ts_at, &val_at, max_points);
        (t, s, n)
    } else {
        let agg = aggregate_hourly(&ctx, sampling);
        let n = agg.timestamps.len();
        let ts_at = |k: usize| agg.timestamps[k].clone();
        let val_at = |k: usize, c: usize| agg.rows[k][c];
        let (t, s) = decimate(n, ctx.n_out(), &ts_at, &val_at, max_points);
        (t, s, n)
    };

    ChartView {
        headers,
        timestamps,
        series,
        total_rows,
        ts_min,
        ts_max,
    }
}

pub fn build_table_page(
    data: &ColumnarData,
    filter: &DataFilter,
    operation: Option<&OperationConfig>,
    sampling: &str,
    page: usize,
    page_size: usize,
) -> TablePage {
    let ctx = resolve_ctx(data, filter, operation);
    let page_size = page_size.clamp(1, MAX_PAGE_SIZE);
    let start = page.saturating_mul(page_size);

    if sampling == "raw" {
        let total_rows = ctx.idx.len();
        let end = start.saturating_add(page_size).min(total_rows);
        let rows: Vec<CsvRecord> = if start < end {
            ctx.idx[start..end]
                .iter()
                .map(|&r| {
                    let r = r as usize;
                    CsvRecord {
                        timestamp: data.timestamps[r].clone(),
                        values: (0..ctx.n_out())
                            .map(|c| nan_to_none(ctx.out_value(c, r)))
                            .collect(),
                    }
                })
                .collect()
        } else {
            Vec::new()
        };
        TablePage {
            headers: ctx.out_headers,
            rows,
            total_rows,
        }
    } else {
        let agg = aggregate_hourly(&ctx, sampling);
        let total_rows = agg.timestamps.len();
        let end = start.saturating_add(page_size).min(total_rows);
        let rows: Vec<CsvRecord> = if start < end {
            (start..end)
                .map(|k| CsvRecord {
                    timestamp: Some(agg.timestamps[k].clone()),
                    values: agg.rows[k].iter().map(|&v| nan_to_none(v)).collect(),
                })
                .collect()
        } else {
            Vec::new()
        };
        TablePage {
            headers: ctx.out_headers,
            rows,
            total_rows,
        }
    }
}

/// Quote a CSV field if it contains a delimiter, quote, or newline —
/// same rule the legacy frontend exporter applied.
fn csv_field(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// Stream the full post-op / post-aggregation row set as CSV. Returns the
/// number of data rows written. String cells (headers, timestamps) are
/// passed through `excel_safe` (formula-injection defense); numeric cells
/// are written bare.
pub fn export_csv<W: Write>(
    data: &ColumnarData,
    filter: &DataFilter,
    operation: Option<&OperationConfig>,
    sampling: &str,
    w: &mut W,
) -> Result<usize, String> {
    let ctx = resolve_ctx(data, filter, operation);
    let n_out = ctx.n_out();

    let mut header_line = String::from("Timestamp");
    for h in &ctx.out_headers {
        header_line.push(',');
        header_line.push_str(&csv_field(&excel_safe(h)));
    }
    header_line.push('\n');
    w.write_all(header_line.as_bytes()).map_err(|e| e.to_string())?;

    let mut written = 0usize;
    let mut line = String::with_capacity(64);

    let mut write_row = |ts: &str, values: &mut dyn Iterator<Item = f64>,
                         w: &mut W|
     -> Result<(), String> {
        line.clear();
        line.push_str(&csv_field(&excel_safe(ts)));
        for v in values {
            line.push(',');
            if !v.is_nan() {
                line.push_str(&format!("{}", v));
            }
        }
        line.push('\n');
        w.write_all(line.as_bytes()).map_err(|e| e.to_string())
    };

    if sampling == "raw" {
        for &r in &ctx.idx {
            let r = r as usize;
            let ts = data.timestamps[r].as_deref().unwrap_or("");
            let mut vals = (0..n_out).map(|c| ctx.out_value(c, r));
            write_row(ts, &mut vals, w)?;
            written += 1;
        }
    } else {
        let agg = aggregate_hourly(&ctx, sampling);
        for k in 0..agg.timestamps.len() {
            let mut vals = agg.rows[k].iter().copied();
            write_row(&agg.timestamps[k], &mut vals, w)?;
            written += 1;
        }
    }

    Ok(written)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::csv_processor::ColumnarData;

    /// 6 rows, minute-spaced across two hours (3 rows in 00:xx, 3 in 01:xx).
    /// A = [1, 2, NaN, 4, 5, 6], B = [10, 20, 30, 40, NaN, 60].
    fn dataset() -> ColumnarData {
        let ts: Vec<Option<String>> = vec![
            Some("2020-01-01T00:00:00".into()),
            Some("2020-01-01T00:10:00".into()),
            Some("2020-01-01T00:20:00".into()),
            Some("2020-01-01T01:00:00".into()),
            Some("2020-01-01T01:10:00".into()),
            Some("2020-01-01T01:20:00".into()),
        ];
        ColumnarData::from_parts(
            vec!["timestamp".into(), "A".into(), "B".into()],
            ts,
            vec![
                vec![f64::NAN; 6],
                vec![1.0, 2.0, f64::NAN, 4.0, 5.0, 6.0],
                vec![10.0, 20.0, 30.0, 40.0, f64::NAN, 60.0],
            ],
        )
    }

    fn filter(sensors: &[&str]) -> DataFilter {
        DataFilter {
            sensors: sensors.iter().map(|s| s.to_string()).collect(),
            timestamp_start: None,
            timestamp_end: None,
            value_filters: vec![],
        }
    }

    fn single_op(op: &str, value: f64) -> OperationConfig {
        OperationConfig {
            mode: "single".into(),
            single_op: Some(SingleOp {
                op_type: op.into(),
                value,
            }),
            multi_op: None,
        }
    }

    fn multi_op(op: &str, base: Option<&str>) -> OperationConfig {
        OperationConfig {
            mode: "multi".into(),
            single_op: None,
            multi_op: Some(MultiOp {
                op_type: op.into(),
                base_sensor: base.map(String::from),
            }),
        }
    }

    #[test]
    fn raw_passthrough_under_cap() {
        let d = dataset();
        let v = build_chart_view(&d, &filter(&["A", "B"]), None, "raw", 1000);
        assert_eq!(v.headers, vec!["A", "B"]);
        assert_eq!(v.total_rows, 6);
        assert_eq!(v.timestamps.len(), 6);
        assert_eq!(v.series.len(), 2);
        assert_eq!(v.series[0][0], Some(1.0));
        assert_eq!(v.series[0][2], None); // NaN → null
        assert_eq!(v.series[1][5], Some(60.0));
        assert_eq!(v.ts_min.as_deref(), Some("2020-01-01T00:00:00"));
        assert_eq!(v.ts_max.as_deref(), Some("2020-01-01T01:20:00"));
    }

    #[test]
    fn decimation_bounds_output_and_keeps_envelope() {
        // 10k rows with one huge spike and one deep dip.
        let n = 10_000usize;
        let ts: Vec<Option<String>> = (0..n)
            .map(|i| Some(format!("2020-01-01T00:00:00.{:05}", i)))
            .collect();
        let mut a: Vec<f64> = (0..n).map(|i| (i as f64 * 0.01).sin()).collect();
        a[3_333] = 999.0; // spike
        a[7_777] = -999.0; // dip
        let d = ColumnarData::from_parts(
            vec!["timestamp".into(), "A".into()],
            ts,
            vec![vec![f64::NAN; n], a],
        );
        let v = build_chart_view(&d, &filter(&["A"]), None, "raw", 200);
        assert!(v.timestamps.len() <= 200, "bounded output");
        assert_eq!(v.total_rows, n);
        let vals: Vec<f64> = v.series[0].iter().filter_map(|x| *x).collect();
        assert!(vals.iter().any(|&x| x == 999.0), "spike survives");
        assert!(vals.iter().any(|&x| x == -999.0), "dip survives");
        // Timestamps stay in dataset order.
        let mut sorted = v.timestamps.clone();
        sorted.sort();
        assert_eq!(sorted, v.timestamps);
    }

    #[test]
    fn timestamp_filter_gates_population() {
        let d = dataset();
        let mut f = filter(&["A"]);
        f.timestamp_start = Some("2020-01-01T01:00:00".into());
        let v = build_chart_view(&d, &f, None, "raw", 1000);
        assert_eq!(v.total_rows, 3);
        assert_eq!(v.ts_min.as_deref(), Some("2020-01-01T01:00:00"));
        assert_eq!(v.series[0], vec![Some(4.0), Some(5.0), Some(6.0)]);
    }

    #[test]
    fn single_op_add_and_divide_by_zero() {
        let d = dataset();
        let v = build_chart_view(&d, &filter(&["A"]), Some(&single_op("add", 5.0)), "raw", 100);
        assert_eq!(v.series[0][0], Some(6.0));
        assert_eq!(v.series[0][2], None); // null stays null

        // Legacy JS behavior: divide by zero returns the value unchanged.
        let v = build_chart_view(&d, &filter(&["A"]), Some(&single_op("divide", 0.0)), "raw", 100);
        assert_eq!(v.series[0][0], Some(1.0));
    }

    #[test]
    fn multi_op_mean_and_median() {
        let d = dataset();
        let v = build_chart_view(&d, &filter(&["A", "B"]), Some(&multi_op("mean", None)), "raw", 100);
        assert_eq!(v.headers, vec!["Result (mean)"]);
        assert_eq!(v.series.len(), 1);
        assert_eq!(v.series[0][0], Some(5.5)); // (1+10)/2
        assert_eq!(v.series[0][2], Some(30.0)); // A null → mean of [30]
        assert_eq!(v.series[0][4], Some(5.0)); // B null → mean of [5]

        let v = build_chart_view(&d, &filter(&["A", "B"]), Some(&multi_op("median", None)), "raw", 100);
        assert_eq!(v.series[0][0], Some(5.5)); // even count → midpoint
        assert_eq!(v.series[0][2], Some(30.0)); // odd count → middle
    }

    #[test]
    fn multi_op_subtract_with_base() {
        let d = dataset();
        let v = build_chart_view(
            &d,
            &filter(&["A", "B"]),
            Some(&multi_op("subtract", Some("B"))),
            "raw",
            100,
        );
        assert_eq!(v.series[0][0], Some(9.0)); // 10 - 1
        assert_eq!(v.series[0][2], Some(30.0)); // A null → 30 - 0
        assert_eq!(v.series[0][4], None); // base (B) null → null

        // Base sensor not in selection → all-null result.
        let v = build_chart_view(
            &d,
            &filter(&["A", "B"]),
            Some(&multi_op("subtract", Some("MISSING"))),
            "raw",
            100,
        );
        assert!(v.series[0].iter().all(|x| x.is_none()));
    }

    #[test]
    fn hourly_aggregation_methods() {
        let d = dataset();
        // avg: hour0 A = (1+2)/2 = 1.5, hour1 A = (4+5+6)/3 = 5
        let v = build_chart_view(&d, &filter(&["A", "B"]), None, "avg", 100);
        assert_eq!(v.total_rows, 2);
        assert_eq!(
            v.timestamps,
            vec!["2020-01-01T00:00:00", "2020-01-01T01:00:00"]
        );
        assert_eq!(v.series[0], vec![Some(1.5), Some(5.0)]);
        assert_eq!(v.series[1], vec![Some(20.0), Some(50.0)]);

        let v = build_chart_view(&d, &filter(&["A"]), None, "max", 100);
        assert_eq!(v.series[0], vec![Some(2.0), Some(6.0)]);
        let v = build_chart_view(&d, &filter(&["A"]), None, "min", 100);
        assert_eq!(v.series[0], vec![Some(1.0), Some(4.0)]);
        let v = build_chart_view(&d, &filter(&["B"]), None, "first", 100);
        assert_eq!(v.series[0], vec![Some(10.0), Some(40.0)]);
        let v = build_chart_view(&d, &filter(&["B"]), None, "last", 100);
        assert_eq!(v.series[0], vec![Some(30.0), Some(60.0)]);
    }

    #[test]
    fn table_paging_slices_and_counts() {
        let d = dataset();
        let p = build_table_page(&d, &filter(&["A", "B"]), None, "raw", 1, 2);
        assert_eq!(p.total_rows, 6);
        assert_eq!(p.rows.len(), 2);
        assert_eq!(p.rows[0].timestamp.as_deref(), Some("2020-01-01T00:20:00"));
        assert_eq!(p.rows[0].values, vec![None, Some(30.0)]);

        // Page past the end → empty rows, total intact.
        let p = build_table_page(&d, &filter(&["A"]), None, "raw", 99, 50);
        assert_eq!(p.total_rows, 6);
        assert!(p.rows.is_empty());

        // Aggregated paging.
        let p = build_table_page(&d, &filter(&["A"]), None, "avg", 0, 50);
        assert_eq!(p.total_rows, 2);
        assert_eq!(p.rows[0].values, vec![Some(1.5)]);
    }

    #[test]
    fn export_writes_csv_with_excel_safety() {
        let ts: Vec<Option<String>> = vec![Some("2020-01-01T00:00:00".into())];
        let d = ColumnarData::from_parts(
            vec!["timestamp".into(), "=EVIL".into(), "a,b".into()],
            ts,
            vec![vec![f64::NAN], vec![1.5], vec![2.0]],
        );
        let mut buf: Vec<u8> = Vec::new();
        let written =
            export_csv(&d, &filter(&["=EVIL", "a,b"]), None, "raw", &mut buf).unwrap();
        assert_eq!(written, 1);
        let text = String::from_utf8(buf).unwrap();
        let mut lines = text.lines();
        // Formula-escaped and comma-quoted headers.
        assert_eq!(lines.next().unwrap(), "Timestamp,'=EVIL,\"a,b\"");
        assert_eq!(lines.next().unwrap(), "2020-01-01T00:00:00,1.5,2");
    }

    #[test]
    fn export_aggregated_rows() {
        let d = dataset();
        let mut buf: Vec<u8> = Vec::new();
        let written = export_csv(&d, &filter(&["A"]), None, "avg", &mut buf).unwrap();
        assert_eq!(written, 2);
        let text = String::from_utf8(buf).unwrap();
        assert!(text.contains("2020-01-01T00:00:00,1.5"));
        assert!(text.contains("2020-01-01T01:00:00,5"));
    }

    #[test]
    fn unknown_sensors_are_dropped() {
        let d = dataset();
        let v = build_chart_view(&d, &filter(&["A", "NOPE"]), None, "raw", 100);
        assert_eq!(v.headers, vec!["A"]);
        assert_eq!(v.series.len(), 1);
    }

    /// Perf smoke test over a 2M-row dataset — run explicitly with
    /// `cargo test -- --ignored perf_smoke` (prints per-query timings).
    /// Asserts the payload stays bounded; the timing printout is the
    /// evidence that dashboard interactions stay sub-second even in a
    /// debug build.
    #[test]
    #[ignore]
    fn perf_smoke_two_million_rows() {
        use std::time::Instant;
        let n = 2_000_000usize;
        let ts: Vec<Option<String>> = (0..n)
            .map(|i| {
                // One row per second, spanning ~23 days.
                let us = i as i64 * 1_000_000;
                micros_to_naive(us).map(|dt| dt.format("%Y-%m-%dT%H:%M:%S").to_string())
            })
            .collect();
        let cols: Vec<Vec<f64>> = vec![
            vec![f64::NAN; n],
            (0..n).map(|i| (i as f64 * 0.001).sin() * 100.0).collect(),
            (0..n).map(|i| (i as f64 * 0.002).cos() * 50.0).collect(),
            (0..n).map(|i| i as f64 % 977.0).collect(),
            (0..n).map(|i| (i as f64).sqrt()).collect(),
        ];
        let d = ColumnarData::from_parts(
            vec!["timestamp".into(), "A".into(), "B".into(), "C".into(), "D".into()],
            ts,
            cols,
        );
        let f = filter(&["A", "B", "C", "D"]);

        let t = Instant::now();
        let v = build_chart_view(&d, &f, None, "raw", 4000);
        println!("chart raw 2M rows x4 sensors: {:?}", t.elapsed());
        assert!(v.timestamps.len() <= 4000);
        assert_eq!(v.total_rows, n);

        let t = Instant::now();
        let v = build_chart_view(&d, &f, None, "avg", 4000);
        println!("chart hourly-avg 2M rows: {:?}", t.elapsed());
        assert!(v.timestamps.len() <= 4000);

        let t = Instant::now();
        let p = build_table_page(&d, &f, None, "raw", 20_000, 50);
        println!("table page 2M rows: {:?}", t.elapsed());
        assert_eq!(p.rows.len(), 50);
        assert_eq!(p.total_rows, n);
    }
}
