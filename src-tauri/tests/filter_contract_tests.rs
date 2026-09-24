//! Feature 4 QA: the TS <-> Rust contract for the training/preview filter
//! (`timestamp_ranges`, value conditions, AND/OR `combine`).
//!
//! The real `PreviewFilter` / `DataFilter` / `TimeRangeArg` structs are
//! private to `lib.rs`, so an integration test cannot deserialize into them
//! directly. Instead this file pins the contract from both ends against ONE
//! shared fixture (`tests/fixtures/filter_contract.json`), which the frontend
//! tests also read:
//!
//!   1. The field lists in the fixture must equal the field names declared in
//!      `lib.rs`'s real structs (read from the source text) — so a rename on
//!      either side fails here instead of being silently ignored by serde
//!      (serde drops unknown keys, which would turn a misnamed
//!      `timestamp_ranges` into "no time gate at all").
//!   2. Every payload the frontend is pinned to send deserializes into
//!      strict mirrors of those structs (`deny_unknown_fields`), with JSON
//!      `null` and missing bounds both reading as an open side.
//!   3. Every non-null bound the frontend can send parses with the SAME
//!      `csv_processor::parse_timestamp` the real filter uses — the real
//!      resolver turns an unparseable bound into an error, so a format the
//!      frontend produces but Rust can't read would break every PM query.

use serde::Deserialize;
use std::collections::BTreeSet;
use tauri_app_lib::csv_processor::{parse_timestamp, ts_to_micros, ColumnarData};

const FIXTURE: &str = include_str!("fixtures/filter_contract.json");
const LIB_SRC: &str = include_str!("../src/lib.rs");

#[derive(Debug, Deserialize)]
struct Fixture {
    preview_filter_fields: Vec<String>,
    data_filter_fields: Vec<String>,
    time_range_fields: Vec<String>,
    value_filter_fields: Vec<String>,
    range_cases: Vec<RangeCase>,
    pm_payloads: Vec<PmPayload>,
}

#[derive(Debug, Deserialize)]
struct RangeCase {
    name: String,
    ranges: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct PmPayload {
    name: String,
    kind: String,
    json: serde_json::Value,
}

// Strict mirrors of lib.rs's private structs. Field names are checked
// against the real source by `fixture_field_lists_match_the_real_rust_structs`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TimeRangeMirror {
    #[serde(default)]
    start: Option<String>,
    #[serde(default)]
    end: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct ValueFilterMirror {
    sensor: String,
    operation: String,
    value1: Option<f64>,
    value2: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct PreviewFilterMirror {
    #[serde(default)]
    timestamp_start: Option<String>,
    #[serde(default)]
    timestamp_end: Option<String>,
    #[serde(default)]
    value_filters: Vec<ValueFilterMirror>,
    #[serde(default)]
    combine: Option<String>,
    #[serde(default)]
    timestamp_ranges: Vec<TimeRangeMirror>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct DataFilterMirror {
    sensors: Vec<String>,
    timestamp_start: Option<String>,
    timestamp_end: Option<String>,
    value_filters: Vec<ValueFilterMirror>,
    #[serde(default)]
    combine: Option<String>,
    #[serde(default)]
    timestamp_ranges: Vec<TimeRangeMirror>,
}

fn fixture() -> Fixture {
    serde_json::from_str(FIXTURE).expect("filter_contract.json must parse")
}

/// Field names declared inside `struct <name> { ... }` in lib.rs (attributes
/// and comments skipped). Panics if the struct is not found exactly once.
fn struct_fields(name: &str) -> BTreeSet<String> {
    let header = format!("struct {name} {{");
    let starts: Vec<_> = LIB_SRC.match_indices(&header).collect();
    assert_eq!(starts.len(), 1, "expected exactly one `{header}` in lib.rs");
    let body_start = starts[0].0 + header.len();
    let body_end = body_start + LIB_SRC[body_start..].find("\n}").expect("struct end");
    LIB_SRC[body_start..body_end]
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("//") && !l.starts_with('#'))
        .filter_map(|l| l.split(':').next())
        .map(|f| f.trim().trim_start_matches("pub ").to_string())
        .collect()
}

fn set(v: &[String]) -> BTreeSet<String> {
    v.iter().cloned().collect()
}

fn assert_bound_parses(bound: &Option<String>, ctx: &str) {
    if let Some(b) = bound {
        assert!(
            parse_timestamp(b.trim()).is_some(),
            "{ctx}: the frontend sends '{b}' but Rust's parse_timestamp rejects it"
        );
    }
}

#[test]
fn fixture_field_lists_match_the_real_rust_structs() {
    let f = fixture();
    assert_eq!(struct_fields("PreviewFilter"), set(&f.preview_filter_fields), "PreviewFilter fields drifted from the TS contract");
    assert_eq!(struct_fields("DataFilter"), set(&f.data_filter_fields), "DataFilter fields drifted from the TS contract");
    assert_eq!(struct_fields("TimeRangeArg"), set(&f.time_range_fields), "TimeRangeArg fields drifted from the TS contract");
    assert_eq!(struct_fields("PreviewValueFilter"), set(&f.value_filter_fields), "PreviewValueFilter fields drifted");
    assert_eq!(struct_fields("ValueFilter"), set(&f.value_filter_fields), "ValueFilter (DataFilter's) fields drifted");
}

#[test]
fn every_range_case_deserializes_with_null_bounds_as_open_sides() {
    for case in fixture().range_cases {
        let ranges: Vec<TimeRangeMirror> = serde_json::from_value(case.ranges.clone())
            .unwrap_or_else(|e| panic!("range case '{}' does not deserialize: {e}", case.name));
        let raw = case.ranges.as_array().unwrap();
        assert_eq!(ranges.len(), raw.len(), "{}", case.name);
        for (r, v) in ranges.iter().zip(raw) {
            assert_eq!(r.start.is_none(), v["start"].is_null(), "{}: start", case.name);
            assert_eq!(r.end.is_none(), v["end"].is_null(), "{}: end", case.name);
            assert_bound_parses(&r.start, &case.name);
            assert_bound_parses(&r.end, &case.name);
        }
    }
}

#[test]
fn empty_range_list_and_missing_key_both_mean_no_time_gate() {
    let empty: PreviewFilterMirror = serde_json::from_str(r#"{"timestamp_ranges":[],"value_filters":[],"combine":"and"}"#).unwrap();
    assert!(empty.timestamp_ranges.is_empty());
    let missing: PreviewFilterMirror = serde_json::from_str(r#"{"value_filters":[]}"#).unwrap();
    assert!(missing.timestamp_ranges.is_empty());
    // A range object with the keys omitted entirely is the same as nulls.
    let bare: TimeRangeMirror = serde_json::from_str("{}").unwrap();
    assert!(bare.start.is_none() && bare.end.is_none());
}

#[test]
fn every_pm_payload_the_frontend_sends_is_accepted_strictly() {
    for p in fixture().pm_payloads {
        match p.kind.as_str() {
            "preview" => {
                // Commands take `filter: Option<PreviewFilter>`: JSON null = no filter.
                let parsed: Option<PreviewFilterMirror> = serde_json::from_value(p.json.clone())
                    .unwrap_or_else(|e| panic!("preview payload '{}' rejected: {e}", p.name));
                if let Some(f) = parsed {
                    assert!(f.timestamp_start.is_none() && f.timestamp_end.is_none(),
                        "{}: PM payloads must never send the legacy pair alongside ranges", p.name);
                    for r in &f.timestamp_ranges {
                        assert_bound_parses(&r.start, &p.name);
                        assert_bound_parses(&r.end, &p.name);
                    }
                    if let Some(c) = &f.combine {
                        assert!(c == "and" || c == "or", "{}: combine must be and|or, got {c}", p.name);
                    }
                } else {
                    assert!(p.json.is_null());
                }
            }
            "chart" => {
                let f: DataFilterMirror = serde_json::from_value(p.json.clone())
                    .unwrap_or_else(|e| panic!("chart payload '{}' rejected: {e}", p.name));
                // The chart sends explicit nulls for the legacy pair (the TS type
                // requires the keys); null/null must read as "not given" so the
                // real resolver does not report "both legacy and ranges".
                assert!(f.timestamp_start.is_none() && f.timestamp_end.is_none(), "{}", p.name);
            }
            other => panic!("unknown payload kind {other}"),
        }
    }
}

#[test]
fn a_bound_string_and_a_csv_timestamp_with_the_same_text_land_on_the_same_instant() {
    // The filter compares bounds against `ts_parsed`, which `from_parts` fills
    // at load. Both must go through the same parser, or an inclusive bound
    // would miss the row it names.
    let texts = ["2026-01-31T23:59", "2026-03-01T00:00", "2026-01-01T00:00:30"];
    let data = ColumnarData::from_parts(
        vec!["timestamp".into(), "A".into()],
        texts.iter().map(|t| Some(t.to_string())).collect(),
        vec![vec![f64::NAN; texts.len()], vec![1.0; texts.len()]],
    );
    for (i, t) in texts.iter().enumerate() {
        let bound = ts_to_micros(parse_timestamp(t).expect("bound parses"));
        assert_eq!(data.ts_parsed[i], bound, "row {i} ('{t}')");
    }
}
