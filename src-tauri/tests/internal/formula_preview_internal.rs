//! Formula editor + Quick build, Rust side:
//! `preview_formula`, the coded formula gate, `multiOp.decimals`, and the
//! legacy `round(x, n)` conversion.
//!
//! In-crate (included from `lib.rs` under `cfg(test)`, like the other files in
//! `tests/internal/`) because every function here is private.
//!
//! What is pinned:
//! * every stable issue code, with its range pointing at the user's OWN text
//!   (UTF-16 offsets — Thai, `${…}` names and an astral character included);
//! * preview == validate == Create/Save: same verdict, same message, same code;
//!   and the preview's numbers are the numbers the sensor will hold;
//! * the preview is bounded on a large dataset; generation pinning → STALE;
//! * `decimals` rounds exactly `(x * 10^n).round() / 10^n`, and a recipe
//!   saved without the field computes unrounded;
//! * the converter's output compiles, rounds exactly, is idempotent, leaves
//!   other formulas alone, and a formula with another error stays refused;
//! * `div_zero` / `agg_too_few` are CREATE-only: a replay / Save (`replace`)
//!   and a `replace` preview accept a saved recipe that has them;
//! * the chunked parallel column builders put every row back in its place
//!   (> 16,384 rows), and a superseded preview stops with `CANCELLED:`.

use crate::csv_processor::ColumnarData;
use crate::formula_diagnostics::{self as fd, convert_legacy_round};
use crate::{
    build_formula_preview, build_formula_preview_with, calculate_sensor_in_state, compute_formula_sensor,
    compute_operation_sensor, convert_legacy_formula, install_session, preview_formula_in_state,
    register_preview_request, round_to_decimals, validate_formula_against, AppState, FormulaPreview,
    FormulaPreviewAggregate, SensorOperationConfig, FORMULA_PREVIEW_CANCELLED, STALE_SESSION_ERROR,
};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::RwLock;

const NAN: f64 = f64::NAN;

fn dataset_n(n: usize) -> ColumnarData {
    let headers: Vec<String> =
        ["timestamp", "A", "B", "Flow (m3/h)", "ค่าแรงดัน", "x😀"].iter().map(|s| s.to_string()).collect();
    let ts: Vec<Option<String>> = (0..n)
        .map(|i| Some(format!("2024-01-01T{:02}:{:02}:{:02}", (i / 3600) % 24, (i / 60) % 60, i % 60)))
        .collect();
    let a: Vec<f64> = (0..n).map(|i| if i % 11 == 3 { NAN } else { (i as f64) * 0.137 - 20.0 }).collect();
    let b: Vec<f64> = (0..n).map(|i| if i % 7 == 5 { NAN } else { ((i * 37) % 101) as f64 / 7.0 + 0.5 }).collect();
    let flow: Vec<f64> = (0..n).map(|i| 100.0 + (i % 13) as f64 * 1.005).collect();
    let thai: Vec<f64> = (0..n).map(|i| 2.5 + (i % 5) as f64 * 0.125).collect();
    let emoji: Vec<f64> = (0..n).map(|i| i as f64).collect();
    ColumnarData::from_parts(headers, ts, vec![vec![NAN; n], a, b, flow, thai, emoji])
}

fn dataset() -> ColumnarData {
    dataset_n(40)
}

fn preview(data: &ColumnarData, f: &str) -> FormulaPreview {
    build_formula_preview(data, Some(f), None, None).unwrap()
}

fn agg(op: &str, sources: &[&str], decimals: Option<f64>) -> FormulaPreviewAggregate {
    FormulaPreviewAggregate {
        op_type: op.to_string(),
        sources: sources.iter().map(|s| s.to_string()).collect(),
        decimals,
    }
}

fn op_config(json: serde_json::Value) -> SensorOperationConfig {
    serde_json::from_value(json).expect("frontend operation config must deserialize")
}

fn strs(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

/// The user-text slice an issue range points at (UTF-16 offsets, as the
/// editor's JS indexes it).
fn slice16(f: &str, range: [usize; 2]) -> String {
    let units: Vec<u16> = f.encode_utf16().collect();
    String::from_utf16(&units[range[0]..range[1]]).unwrap()
}

fn same_bits(a: &[f64], b: &[f64]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| (x.is_nan() && y.is_nan()) || x.to_bits() == y.to_bits())
}

fn state_with(data: ColumnarData) -> (AppState, u64) {
    let state = AppState(RwLock::new(None));
    let generation = install_session(&state, data, vec![]).unwrap();
    (state, generation)
}

// ---------------------------------------------------------------------------
// Issue codes + ranges
// ---------------------------------------------------------------------------

/// `(formula, code, the exact user text the range must cover — or None)`.
const CODE_CASES: &[(&str, &str, Option<&str>)] = &[
    ("sqr($A)", "unknown_function", Some("sqr")),
    ("$A + nope", "unknown_function", Some("nope")),
    ("ROUND($A)", "unknown_function", Some("ROUND")),
    ("$A * abs", "fn_no_bracket", Some("abs")),
    ("$A * pi", "fn_no_bracket", Some("pi")),
    ("$A * sqrt", "fn_no_bracket", Some("sqrt")),
    ("pow($A)", "bad_arg_count", Some("pow($A)")),
    ("abs($A) + abs($A, 1)", "bad_arg_count", Some("abs($A, 1)")),
    ("sqrt($A, 2)", "bad_arg_count", Some("sqrt($A, 2)")),
    ("pi(2) * $A", "bad_arg_count", Some("pi(2)")),
    ("${ค่าแรงดัน} + $nope", "unknown_sensor", Some("$nope")),
    ("${x😀} * ${Missing (bar)}", "unknown_sensor", Some("${Missing (bar)}")),
    ("($A + 1", "unclosed_bracket", Some("(")),
    ("$A + 1)", "unmatched_close", Some(")")),
    ("($A + 1]", "unmatched_close", Some("]")),
    ("$A * ()", "empty_brackets", Some("()")),
    ("* $A", "op_no_left", Some("*")),
    ("$A +", "op_no_right", Some("+")),
    ("$A + * $B", "op_no_right", Some("+")),
    ("$A $B", "missing_operator", Some("$A $B")),
    ("${ค่าแรงดัน} 2", "missing_operator", Some("${ค่าแรงดัน} 2")),
    ("$A (1 - $B)", "missing_operator", Some("$A (")),
    ("$A, $B", "stray_comma", Some(",")),
    ("1 + 2", "constant_only", None),
    ("$A / 0", "div_zero", Some("/ 0")),
    ("${Flow (m3/h)} / 0.0 + 1", "div_zero", Some("/ 0.0")),
    ("$A + 1.2.3", "bad_number", Some("1.2.3")),
    ("$A @ 2", "bad_char", Some("@")),
    ("$A = 2", "bad_char", Some("=")),
    ("round($A, 2)", "round_excel", Some("round($A, 2)")),
    ("1 + round(${ค่าแรงดัน}, 1) * 3", "round_excel", Some("round(${ค่าแรงดัน}, 1)")),
    ("round [ $A ; 3 ]", "round_excel", Some("round [ $A ; 3 ]")),
];

#[test]
fn every_issue_code_is_produced_with_a_range_on_the_users_own_text() {
    let data = dataset();
    for &(f, code, covers) in CODE_CASES {
        let p = preview(&data, f);
        assert!(!p.ok, "{f}: expected a refusal");
        assert_eq!(p.issues.len(), 1, "{f}");
        let issue = &p.issues[0];
        assert_eq!(issue.code, code, "{f}: {}", issue.message);
        match covers {
            Some(text) => {
                let r = issue.range.unwrap_or_else(|| panic!("{f}: no range"));
                assert_eq!(slice16(f, r), text, "{f}");
            }
            None => assert_eq!(issue.range, None, "{f}"),
        }
        assert!(p.stats.is_none() && p.values.is_empty() && p.timestamps.is_empty(), "{f}");
        assert!(!p.functions.is_empty() && p.limits.max_len == 4096 && p.limits.max_depth == 64);
    }
}

#[test]
fn size_limits_are_coded_and_the_depth_range_is_the_first_bracket_over_the_limit() {
    let data = dataset();
    let long = format!("$A + {}", "1".repeat(4096));
    let p = preview(&data, &long);
    assert_eq!(p.issues[0].code, "too_long");
    assert_eq!(p.issues[0].range, None);

    let deep = format!("{}$A{}", "(".repeat(65), ")".repeat(65));
    let p = preview(&data, &deep);
    assert_eq!(p.issues[0].code, "too_deep");
    assert_eq!(p.issues[0].range, Some([64, 65]));
}

#[test]
fn thai_formulas_are_measured_in_characters_not_bytes() {
    // 2,000 Thai characters = 6,000 UTF-8 bytes: within the 4,096-character
    // limit the editor shows (a byte count used to refuse it as "too long").
    let data = dataset();
    let name = "ค่าแรงดัน";
    let refs = (0..180).map(|_| format!("${{{name}}}")).collect::<Vec<_>>().join("+");
    assert!(refs.chars().count() < 4096 && refs.len() > 4096, "test premise");
    let p = preview(&data, &refs);
    assert!(p.ok, "{:?}", p.issues);
}

#[test]
fn a_remaining_text_error_is_mapped_back_through_the_variable_rewrite() {
    // `${A}0` is rewritten to `_0 0`: fasteval stops at the second `0`. The
    // range must point at the user's `0`, not at an offset in `_0 0`.
    let data = dataset();
    let f = "${ค่าแรงดัน} + ${A}0";
    let p = preview(&data, f);
    assert_eq!(p.issues[0].code, "missing_operator");
    let covered = slice16(f, p.issues[0].range.unwrap());
    assert!(covered.contains('0'), "{covered:?}");
}

// ---------------------------------------------------------------------------
// One verdict: preview == validate == Create / Save
// ---------------------------------------------------------------------------

const VALID: &[&str] = &[
    "$A + $B",
    "${Flow (m3/h)} * 2 - ${ค่าแรงดัน}",
    "max($A, $B, ${x😀}) - min($A, $B, ${x😀})",
    "round(0.01, $A)",
    "round($A * 100) / 100",
    "abs($A - $B)",
    "($B / $A) * 100",
    "-$A ^ 2",
    "ln(${ค่าแรงดัน}) + log10($B) + exp(0) + pow($A, 2) + sqrt(abs($A))",
    "sign($A) + int($B) + ceil($A) + floor($B) + pi() + e()",
    "$A / 0.5",
    "($A > 2) && ($B < 3)",
    "2k * $A",
];

#[test]
fn preview_validate_and_create_give_the_same_verdict_code_and_message() {
    let data = dataset();
    let all = VALID.iter().copied().chain(CODE_CASES.iter().map(|c| c.0));
    for f in all {
        let p = preview(&data, f);
        let v = validate_formula_against(&data, f);
        let created = compute_formula_sensor(&data, f, Some("Z"), false);
        match created {
            Ok((_, col)) => {
                assert!(p.ok && v.valid, "{f}: preview {:?} / validate {:?}", p.issues, v.error);
                // The preview's numbers ARE the sensor's numbers.
                let stats = p.stats.as_ref().unwrap();
                let present: Vec<f64> = col.iter().copied().filter(|x| !x.is_nan()).collect();
                assert_eq!(stats.rows, col.len(), "{f}");
                assert_eq!(stats.missing, col.len() - present.len(), "{f}");
                if !present.is_empty() {
                    let mn = present.iter().copied().fold(f64::INFINITY, f64::min);
                    let mx = present.iter().copied().fold(f64::NEG_INFINITY, f64::max);
                    assert_eq!(stats.min, Some(mn), "{f}");
                    assert_eq!(stats.max, Some(mx), "{f}");
                }
                // 40 rows <= 600 points: the series is the column itself.
                let vals: Vec<f64> = p.values.iter().map(|v| v.unwrap_or(NAN)).collect();
                assert!(same_bits(&vals, &col), "{f}");
                assert_eq!(p.timestamps.len(), col.len());
            }
            Err(e) => {
                assert!(!p.ok && !v.valid, "{f}");
                assert_eq!(p.issues[0].message, e, "{f}: preview message");
                assert_eq!(v.error.as_deref(), Some(e.as_str()), "{f}: validate message");
                assert_eq!(v.code, Some(p.issues[0].code), "{f}: validate code");
                assert_eq!(v.range, p.issues[0].range, "{f}: validate range");
            }
        }
    }
}

#[test]
fn the_error_lists_the_engines_own_function_list() {
    let p = preview(&dataset(), "sqr($A)");
    assert!(p.issues[0].message.contains("Available functions: abs, sqrt"), "{}", p.issues[0].message);
    for f in ["abs", "sqrt", "ln", "log10", "round", "min", "max", "pi", "e", "atanh", "int", "sign"] {
        assert!(p.functions.contains(&f), "{f}");
    }
}

// ---------------------------------------------------------------------------
// Bounded output, generation pinning, request shape
// ---------------------------------------------------------------------------

#[test]
fn the_preview_is_bounded_on_a_large_dataset() {
    let n = 300_000;
    let data = dataset_n(n);
    let f = "${Flow (m3/h)} * $A + ${ค่าแรงดัน}";
    let p = build_formula_preview(&data, Some(f), None, Some(600)).unwrap();
    assert!(p.ok);
    assert!(p.values.len() <= 600 && !p.values.is_empty(), "{}", p.values.len());
    assert_eq!(p.timestamps.len(), p.values.len());
    let stats = p.stats.unwrap();
    assert_eq!(stats.rows, n);
    let (_, col) = compute_formula_sensor(&data, f, Some("Z"), false).unwrap();
    assert_eq!(stats.missing, col.iter().filter(|x| x.is_nan()).count());
    // Min/max-preserving: the extremes survive the downsample.
    let shown: Vec<f64> = p.values.iter().flatten().copied().collect();
    assert_eq!(shown.iter().copied().fold(f64::INFINITY, f64::min), stats.min.unwrap());
    assert_eq!(shown.iter().copied().fold(f64::NEG_INFINITY, f64::max), stats.max.unwrap());

    // A huge request is clamped; default is 600.
    let p = build_formula_preview(&data, Some(f), None, Some(10_000_000)).unwrap();
    assert!(p.values.len() <= 2000);
    let p = build_formula_preview(&data, Some(f), None, None).unwrap();
    assert!(p.values.len() <= 600);
    let p = build_formula_preview(&data, None, Some(&agg("mean", &["A", "B"], Some(1.0))), Some(50)).unwrap();
    assert!(p.ok && p.values.len() <= 50 && p.stats.unwrap().rows == n);
}

#[test]
fn a_caller_bound_to_another_dataset_is_told_stale_and_gets_no_verdict() {
    let (state, generation) = state_with(dataset());
    let ok = preview_formula_in_state(&state, Some("$A + 1"), None, None, Some(generation), false, None).unwrap();
    assert!(ok.ok);
    let ok = preview_formula_in_state(&state, Some("$A + 1"), None, None, None, false, None).unwrap();
    assert!(ok.ok, "an unpinned caller still gets an answer");
    for bad in [generation - 1, generation + 1] {
        let err = preview_formula_in_state(&state, Some("$A + 1"), None, None, Some(bad), false, None).unwrap_err();
        assert_eq!(err, STALE_SESSION_ERROR);
        // Even for a formula that would be refused: no verdict about this data.
        let err = preview_formula_in_state(&state, Some("$nope"), None, None, Some(bad), false, None).unwrap_err();
        assert_eq!(err, STALE_SESSION_ERROR);
    }
    let empty = AppState(RwLock::new(None));
    assert_eq!(preview_formula_in_state(&empty, Some("$A"), None, None, Some(1), false, None).unwrap_err(), STALE_SESSION_ERROR);
    assert_eq!(preview_formula_in_state(&empty, Some("$A"), None, None, None, false, None).unwrap_err(), "No data loaded");
}

#[test]
fn the_request_must_name_exactly_one_input() {
    let data = dataset();
    let a = agg("mean", &["A", "B"], None);
    assert!(build_formula_preview(&data, None, None, None).unwrap_err().starts_with("BAD_REQUEST:"));
    assert!(build_formula_preview(&data, Some("$A"), Some(&a), None).unwrap_err().starts_with("BAD_REQUEST:"));
}

#[test]
fn request_and_response_json_shapes() {
    // Aggregate as the editor sends it (decimals null / absent / a number).
    for json in [
        serde_json::json!({ "type": "mean", "sources": ["A", "B"] }),
        serde_json::json!({ "type": "median", "sources": ["A", "B"], "decimals": null }),
        serde_json::json!({ "type": "mean", "sources": ["A", "B"], "decimals": 2 }),
    ] {
        let a: FormulaPreviewAggregate = serde_json::from_value(json.clone()).unwrap_or_else(|e| panic!("{json}: {e}"));
        assert_eq!(a.sources, strs(&["A", "B"]));
    }
    let data = dataset();
    let v = serde_json::to_value(preview(&data, "$A + 1")).unwrap();
    for key in ["ok", "issues", "stats", "timestamps", "values", "period", "functions", "limits", "converted_formula"] {
        assert!(v.get(key).is_some(), "missing {key}: {v}");
    }
    assert_eq!(v["limits"], serde_json::json!({ "max_len": 4096, "max_depth": 64 }));
    for key in ["min", "max", "mean", "rows", "missing"] {
        assert!(v["stats"].get(key).is_some(), "stats.{key}");
    }
    assert_eq!(v["period"][0], "2024-01-01T00:00:00");
    let v = serde_json::to_value(preview(&data, "$nope")).unwrap();
    assert_eq!(v["ok"], false);
    assert_eq!(v["stats"], serde_json::Value::Null);
    assert_eq!(v["issues"][0]["code"], "unknown_sensor");
    assert_eq!(v["issues"][0]["range"], serde_json::json!([0, 5]));
    assert_eq!(v["converted_formula"], serde_json::Value::Null);
}

// ---------------------------------------------------------------------------
// multiOp.decimals
// ---------------------------------------------------------------------------

/// `(v * 10^d).round() / 10^d`, with `-0.0` written as `0.0` (`+ 0.0` does
/// exactly that in IEEE arithmetic) — what the builder promises.
fn round_dec(v: f64, d: i32) -> f64 {
    (v * 10f64.powi(d)).round() / 10f64.powi(d) + 0.0
}

fn mean_of(a: f64, b: f64) -> f64 {
    match (a.is_nan(), b.is_nan()) {
        (true, true) => NAN,
        (true, false) => b,
        (false, true) => a,
        _ => (a + b) / 2.0,
    }
}

#[test]
fn decimals_round_an_aggregate_exactly_on_create_and_in_the_preview() {
    let data = dataset();
    let a = &data.columns[1];
    let b = &data.columns[2];
    for d in [0, 1, 2, 3] {
        let cfg = op_config(serde_json::json!({
            "mode": "multi", "multiOp": { "type": "mean", "decimals": d }, "customName": "M"
        }));
        let (_, col) = compute_operation_sensor(&data, &strs(&["A", "B"]), &cfg, false).unwrap();
        let want: Vec<f64> = (0..a.len()).map(|r| round_dec(mean_of(a[r], b[r]), d)).collect();
        assert!(same_bits(&col, &want), "d={d}");

        let p = build_formula_preview(&data, None, Some(&agg("mean", &["A", "B"], Some(d as f64))), None).unwrap();
        let vals: Vec<f64> = p.values.iter().map(|v| v.unwrap_or(NAN)).collect();
        assert!(same_bits(&vals, &col), "preview d={d}");
    }
    // Hand-checked values: half away from zero, like the single-op round.
    let small = ColumnarData::from_parts(
        strs(&["timestamp", "P", "Q", "R"]),
        vec![Some("2024-01-01T00:00".into()), Some("2024-01-01T00:01".into())],
        vec![vec![NAN; 2], vec![1.234, -2.5], vec![1.236, -2.5], vec![1.235, NAN]],
    );
    let cfg = |op: &str, d: i64| {
        op_config(serde_json::json!({ "mode": "multi", "multiOp": { "type": op, "decimals": d }, "customName": "X" }))
    };
    let (_, med) = compute_operation_sensor(&small, &strs(&["P", "Q", "R"]), &cfg("median", 2), false).unwrap();
    assert_eq!(med[0], 1.24, "median 1.235 -> 1.24");
    assert_eq!(med[1], -2.5);
    let (_, mean0) = compute_operation_sensor(&small, &strs(&["P", "Q"]), &cfg("mean", 0), false).unwrap();
    assert_eq!(mean0, vec![1.0, -3.0], "-2.5 rounds away from zero");
    let (_, sum1) = compute_operation_sensor(&small, &strs(&["P", "Q"]), &cfg("sum", 1), false).unwrap();
    assert_eq!(sum1, vec![2.5, -5.0]);
}

#[test]
fn recipes_saved_before_decimals_existed_compute_bit_for_bit_as_before() {
    let data = dataset();
    let a = &data.columns[1];
    let b = &data.columns[2];
    for json in [
        serde_json::json!({ "mode": "multi", "multiOp": { "type": "mean" }, "customName": "M" }),
        serde_json::json!({ "mode": "multi", "multiOp": { "type": "mean", "decimals": null }, "customName": "M" }),
    ] {
        let cfg = op_config(json);
        let (_, col) = compute_operation_sensor(&data, &strs(&["A", "B"]), &cfg, false).unwrap();
        let want: Vec<f64> = (0..a.len()).map(|r| mean_of(a[r], b[r])).collect();
        assert!(same_bits(&col, &want));
    }
}

#[test]
fn bad_decimals_and_too_few_sources_are_refused_alike_by_create_and_preview() {
    let data = dataset();
    for d in [-1.0, 2.5, 11.0] {
        let cfg = op_config(serde_json::json!({
            "mode": "multi", "multiOp": { "type": "mean", "decimals": d }, "customName": "M"
        }));
        let err = compute_operation_sensor(&data, &strs(&["A", "B"]), &cfg, false).unwrap_err();
        let p = build_formula_preview(&data, None, Some(&agg("mean", &["A", "B"], Some(d))), None).unwrap();
        assert_eq!(p.issues[0].code, "bad_decimals");
        assert_eq!(p.issues[0].message, err, "d={d}");
    }
    // One source: refused on create and in the preview (same message)…
    let one = op_config(serde_json::json!({ "mode": "multi", "multiOp": { "type": "mean" }, "customName": "M" }));
    let err = compute_operation_sensor(&data, &strs(&["A"]), &one, false).unwrap_err();
    assert_eq!(err, "Average needs at least 2 sensors.");
    let p = build_formula_preview(&data, None, Some(&agg("mean", &["A"], None)), None).unwrap();
    assert_eq!((p.issues[0].code, p.issues[0].message.as_str()), ("agg_too_few", err.as_str()));
    // …but a legacy one-source recipe still RESTORES (replay / recompute).
    let (_, col) = compute_operation_sensor(&data, &strs(&["A"]), &one, true).unwrap();
    assert!(same_bits(&col, &data.columns[1]));

    let p = build_formula_preview(&data, None, Some(&agg("mean", &[], None)), None).unwrap();
    assert_eq!(p.issues[0].code, "agg_too_few");
    let p = build_formula_preview(&data, None, Some(&agg("mean", &["A", "nope"], None)), None).unwrap();
    assert_eq!((p.issues[0].code, p.issues[0].message.as_str()), ("unknown_sensor", "Sensor not found: nope"));
    let p = build_formula_preview(&data, None, Some(&agg("spread", &["A", "B"], None)), None).unwrap();
    assert_eq!(p.issues[0].code, "unknown_operation");
}

#[test]
fn decimals_survive_the_session_create_path() {
    // Hand-computed medians (two sources: the mean of the pair), then rounded
    // to 1 decimal — written out, not derived from the code under test.
    let data = ColumnarData::from_parts(
        strs(&["timestamp", "P", "Q"]),
        (0..4).map(|i| Some(format!("2024-01-01T00:0{i}:00"))).collect(),
        vec![vec![NAN; 4], vec![1.26, 2.0, -0.04, NAN], vec![1.0, 3.04, 0.0, 7.77]],
    );
    let want = [1.1, 2.5, 0.0, 7.8]; // 1.13, 2.52, -0.02 (-> 0, not -0), 7.77
    let (state, generation) = state_with(data);
    let cfg = op_config(serde_json::json!({
        "mode": "multi", "multiOp": { "type": "median", "decimals": 1 }, "customName": "Med1"
    }));
    let name = calculate_sensor_in_state(&state, &strs(&["P", "Q"]), &cfg, false, Some(generation), &|| {}).unwrap();
    let lock = state.0.read().unwrap();
    let s = lock.as_ref().unwrap();
    let idx = s.data.headers.iter().position(|h| *h == name).unwrap();
    assert!(same_bits(&s.data.columns[idx], &want), "{:?}", s.data.columns[idx]);
}

#[test]
fn round_to_decimals_keeps_huge_values_and_never_returns_negative_zero() {
    // Huge: scaling would overflow to infinity (-> "missing"); kept as is.
    for v in [1e300, -1e300, f64::MAX, 4_503_599_627_370_496.0, 1e17] {
        assert_eq!(round_to_decimals(v, 10.0).to_bits(), v.to_bits(), "{v}");
    }
    assert_eq!(round_to_decimals(1e300, 0.0), 1e300);
    // Just under 2^52 once scaled: still rounded.
    assert_eq!(round_to_decimals(123_456_789.123_456, 2.0), 123_456_789.12);
    // -0 -> +0.
    for v in [-0.001, -0.0, -0.4] {
        let d = if v == -0.4 { 0.0 } else { 2.0 };
        assert_eq!(round_to_decimals(v, d).to_bits(), 0.0f64.to_bits(), "{v}");
    }
    assert_eq!(round_to_decimals(-0.006, 2.0), -0.01);
    assert!(round_to_decimals(NAN, 2.0).is_nan());
    assert_eq!(round_to_decimals(f64::INFINITY, 2.0), f64::INFINITY, "left to the caller's finite check");
}

#[test]
fn the_default_name_of_a_rounded_block_carries_its_decimals() {
    let data = dataset();
    let name = |decimals: serde_json::Value| {
        let cfg = op_config(serde_json::json!({ "mode": "multi", "multiOp": { "type": "mean", "decimals": decimals } }));
        compute_operation_sensor(&data, &strs(&["A", "B"]), &cfg, false).unwrap().0
    };
    assert_eq!(name(serde_json::Value::Null), r#"Avg(["A", "B"])"#, "unchanged without decimals");
    assert_eq!(name(serde_json::json!(2)), r#"Avg(["A", "B"], 2dp)"#);
    assert_eq!(name(serde_json::json!(0)), r#"Avg(["A", "B"], 0dp)"#);
    assert_ne!(name(serde_json::json!(1)), name(serde_json::json!(2)));
}

// ---------------------------------------------------------------------------
// Create-only refusals: div_zero, agg_too_few
// ---------------------------------------------------------------------------

#[test]
fn a_saved_division_by_zero_recipe_still_replays() {
    let data = dataset();
    // Create: refused, everywhere alike, with a message that is true even
    // when the result still has values.
    for f in ["$A / 0", "min(abs($A) / 0, $B)", "($A / 0 > 0) * $B"] {
        let err = compute_formula_sensor(&data, f, Some("Z"), false).unwrap_err();
        assert_eq!(err, fd::DIV_ZERO_MESSAGE, "{f}");
        assert!(!err.contains("every row empty"), "{err}");
        let p = preview(&data, f);
        assert_eq!((p.issues[0].code, p.issues[0].message.as_str()), ("div_zero", err.as_str()), "{f}");
        assert_eq!(validate_formula_against(&data, f).code, Some("div_zero"), "{f}");
    }
    // Replay / Save of an existing sensor (`replace`): computes, and the
    // `replace` preview shows exactly what it will hold.
    assert!(compute_formula_sensor(&data, "$A / 0", Some("Z"), true).is_ok());
    for f in ["$A / 0", "min(abs($A) / 0, $B)"] {
        let (_, col) = compute_formula_sensor(&data, f, Some("Z"), true).unwrap();
        let p = build_formula_preview_with(&data, Some(f), None, None, true, &|| false).unwrap();
        assert!(p.ok, "{f}: {:?}", p.issues);
        let vals: Vec<f64> = p.values.iter().map(|v| v.unwrap_or(NAN)).collect();
        assert!(same_bits(&vals, &col), "{f}");
    }
    let (_, col) = compute_formula_sensor(&data, "$A / 0", Some("Z"), true).unwrap();
    assert!(col.iter().all(|v| v.is_nan()), "the divided part has no value");
    let (_, col) = compute_formula_sensor(&data, "min(abs($A) / 0, $B)", Some("Z"), true).unwrap();
    assert!(col.iter().any(|v| !v.is_nan()), "…but the result can");
    // Other errors are still refused on replay.
    assert!(compute_formula_sensor(&data, "$A / 0 + sqr($B)", Some("Z"), true).is_err());
}

#[test]
fn a_replace_preview_accepts_a_legacy_one_source_block_like_save_does() {
    let data = dataset();
    let one = agg("mean", &["A"], Some(1.0));
    let p = build_formula_preview(&data, None, Some(&one), None).unwrap();
    assert_eq!(p.issues[0].code, "agg_too_few", "create mode still refuses");
    let p = build_formula_preview_with(&data, None, Some(&one), None, true, &|| false).unwrap();
    assert!(p.ok, "{:?}", p.issues);
    let cfg = op_config(serde_json::json!({ "mode": "multi", "multiOp": { "type": "mean", "decimals": 1 }, "customName": "M" }));
    let (_, col) = compute_operation_sensor(&data, &strs(&["A"]), &cfg, true).unwrap();
    let vals: Vec<f64> = p.values.iter().map(|v| v.unwrap_or(NAN)).collect();
    assert!(same_bits(&vals, &col));
    // Everything else is still checked in replace mode.
    let p = build_formula_preview_with(&data, None, Some(&agg("mean", &["A", "nope"], None)), None, true, &|| false)
        .unwrap();
    assert_eq!(p.issues[0].code, "unknown_sensor");
    let p = build_formula_preview_with(&data, None, Some(&agg("mean", &[], None)), None, true, &|| false).unwrap();
    assert_eq!(p.issues[0].code, "agg_too_few", "no source at all is never a sensor");
}

// ---------------------------------------------------------------------------
// Chunked parallel builders + cancellation
// ---------------------------------------------------------------------------

const MANY_ROWS: usize = 3 * 16_384 + 123;

#[test]
fn chunked_formula_columns_keep_every_row_in_place() {
    let data = dataset_n(MANY_ROWS);
    let (idx, a, b) = (&data.columns[5], &data.columns[1], &data.columns[2]);
    // `${x😀}` is the row number: any chunk out of place shows.
    let (_, col) = compute_formula_sensor(&data, "(${x😀} * 2 + $B) - $A", Some("Z"), false).unwrap();
    assert_eq!(col.len(), MANY_ROWS);
    let want: Vec<f64> = (0..MANY_ROWS)
        .map(|r| if a[r].is_nan() || b[r].is_nan() { NAN } else { (idx[r] * 2.0 + b[r]) - a[r] })
        .collect();
    assert!(same_bits(&col, &want));
    for (r, v) in compute_formula_sensor(&data, "${x😀}", Some("Z"), false).unwrap().1.iter().enumerate() {
        assert_eq!(*v, r as f64, "row {r}");
    }
}

#[test]
fn chunked_multi_columns_keep_every_row_in_place() {
    let data = dataset_n(MANY_ROWS);
    let (idx, a, b) = (&data.columns[5], &data.columns[1], &data.columns[2]);
    let run = |op: &str, sources: &[&str], decimals: serde_json::Value| {
        let cfg = op_config(serde_json::json!({ "mode": "multi", "multiOp": { "type": op, "decimals": decimals }, "customName": "M" }));
        compute_operation_sensor(&data, &strs(sources), &cfg, false).unwrap().1
    };
    // Serial references, row by row.
    let sum: Vec<f64> = (0..MANY_ROWS).map(|r| if b[r].is_nan() { NAN } else { idx[r] + b[r] }).collect();
    assert!(same_bits(&run("sum", &["x😀", "B"], serde_json::Value::Null), &sum));
    let mean: Vec<f64> = (0..MANY_ROWS).map(|r| round_dec(mean_of(a[r], b[r]), 2)).collect();
    assert!(same_bits(&run("mean", &["A", "B"], serde_json::json!(2)), &mean));
    let med: Vec<f64> = (0..MANY_ROWS).map(|r| mean_of(idx[r], b[r])).collect();
    assert!(same_bits(&run("median", &["x😀", "B"], serde_json::Value::Null), &med));
    // And the preview's aggregate path reads the same column.
    let p = build_formula_preview(&data, None, Some(&agg("sum", &["x😀", "B"], None)), Some(2000)).unwrap();
    assert_eq!(p.stats.unwrap().missing, sum.iter().filter(|v| v.is_nan()).count());
}

#[test]
fn a_superseded_preview_stops_with_cancelled() {
    let data = dataset_n(MANY_ROWS);
    let always = || true;
    for (f, a) in [(Some("$A + $B"), None), (None, Some(agg("mean", &["A", "B"], None)))] {
        let err = build_formula_preview_with(&data, f, a.as_ref(), None, false, &always).unwrap_err();
        assert_eq!(err, FORMULA_PREVIEW_CANCELLED);
        assert!(err.starts_with("CANCELLED:"));
        // Cancelled part-way: the first chunk runs, the next check stops it.
        let calls = AtomicUsize::new(0);
        let later = || calls.fetch_add(1, Ordering::SeqCst) >= 1;
        let err = build_formula_preview_with(&data, f, a.as_ref(), None, false, &later).unwrap_err();
        assert_eq!(err, FORMULA_PREVIEW_CANCELLED);
    }
    // A refusal is cheap and still answered (nothing to cancel).
    let p = build_formula_preview_with(&data, Some("$nope"), None, None, false, &always).unwrap();
    assert_eq!(p.issues[0].code, "unknown_sensor");
}

#[test]
fn the_request_token_cancels_every_preview_but_the_latest_to_arrive() {
    let (state, _) = state_with(dataset());
    let token = AtomicU64::new(0);
    let run = |id: Option<u64>| {
        preview_formula_in_state(&state, Some("$A + 1"), None, None, None, false, id.map(|id| (&token, id)))
    };
    register_preview_request(&token, Some(1));
    assert!(run(Some(1)).unwrap().ok);
    register_preview_request(&token, Some(2));
    assert_eq!(run(Some(1)).unwrap_err(), FORMULA_PREVIEW_CANCELLED);
    assert!(run(Some(2)).unwrap().ok);
    // A reloaded window restarts its counter: last to arrive wins, not largest.
    register_preview_request(&token, Some(1));
    assert!(run(Some(1)).unwrap().ok);
    assert_eq!(run(Some(2)).unwrap_err(), FORMULA_PREVIEW_CANCELLED);
    // No id: never cancelled, and registers nothing.
    register_preview_request(&token, None);
    assert!(run(None).unwrap().ok);
    assert!(run(Some(1)).unwrap().ok);
}

// ---------------------------------------------------------------------------
// Timestamp format
// ---------------------------------------------------------------------------

#[test]
fn period_and_timestamps_use_the_rows_own_text() {
    // Space-separated text, rows NOT in time order, and an unparseable row.
    let ts = ["2024-01-02 05:00:00", "2024-01-01 00:00:00", "not a time", "2024-01-03 10:30:00", "2024-01-02 00:00:00"];
    let data = ColumnarData::from_parts(
        strs(&["timestamp", "A"]),
        ts.iter().map(|t| Some(t.to_string())).collect(),
        vec![vec![NAN; 5], vec![1.0, 2.0, 3.0, 4.0, 5.0]],
    );
    let p = preview(&data, "$A * 2");
    assert_eq!(p.timestamps, strs(&ts), "the row text, like the line chart");
    assert_eq!(p.period, Some([ts[1].to_string(), ts[3].to_string()]), "earliest / latest by parsed time");
    let none = ColumnarData::from_parts(strs(&["timestamp", "A"]), vec![Some("x".into())], vec![vec![NAN], vec![1.0]]);
    assert_eq!(preview(&none, "$A").period, None);
}

// ---------------------------------------------------------------------------
// Legacy round(x, n) conversion
// ---------------------------------------------------------------------------

#[test]
fn converted_formulas_compile_and_round_exactly() {
    let data = dataset();
    let a = data.columns[1].clone();
    let b = data.columns[2].clone();
    // The engine's row rule: a row is missing when an input the formula
    // USES is missing (or the result is not finite).
    let rows = |uses_a: bool, uses_b: bool, f: &dyn Fn(f64, f64) -> f64| -> Vec<f64> {
        (0..a.len())
            .map(|r| if (uses_a && a[r].is_nan()) || (uses_b && b[r].is_nan()) { NAN } else { f(a[r], b[r]) })
            .map(|v| if v.is_finite() { v } else { NAN })
            .collect()
    };
    let both = |f: &dyn Fn(f64, f64) -> f64| rows(true, true, f);
    let cases: Vec<(&str, Vec<f64>)> = vec![
        ("round($A, 2)", rows(true, false, &|x, _| round_dec(x, 2))),
        ("round($A, 0)", rows(true, false, &|x, _| x.round())),
        ("round($A + $B, 1) * 3", both(&|x, y| round_dec(x + y, 1) * 3.0)),
        ("2 ^ round($B, 1)", rows(false, true, &|_, y| 2f64.powf(round_dec(y, 1)))),
        ("$B - round($A, 3)", both(&|x, y| y - round_dec(x, 3))),
        ("round(round($A, 2) + $B, 1)", both(&|x, y| round_dec(round_dec(x, 2) + y, 1))),
        ("max(round($A, 1), round($B, 2))", both(&|x, y| round_dec(x, 1).max(round_dec(y, 2)))),
    ];
    for (legacy, want) in cases {
        assert_eq!(preview(&data, legacy).issues[0].code, "round_excel", "{legacy}");
        let converted = convert_legacy_round(legacy);
        let (_, got) = compute_formula_sensor(&data, &converted, Some("Z"), false)
            .unwrap_or_else(|e| panic!("{legacy} -> {converted}: {e}"));
        assert!(same_bits(&got, &want), "{legacy} -> {converted}");
        assert_eq!(convert_legacy_round(&converted), converted, "idempotent: {legacy}");
        // The preview offers exactly this conversion as the fix.
        assert_eq!(preview(&data, legacy).converted_formula.as_deref(), Some(converted.as_str()), "{legacy}");
    }
    // Brace names with symbols and Thai convert too.
    let f = "round(${Flow (m3/h)} / ${ค่าแรงดัน}, 2)";
    let c = convert_legacy_round(f);
    assert_eq!(c, "round((${Flow (m3/h)} / ${ค่าแรงดัน}) * 100) / 100");
    assert!(compute_formula_sensor(&data, &c, Some("Z"), false).is_ok());
}

#[test]
fn conversion_leaves_other_formulas_alone_and_other_errors_still_refuse() {
    let data = dataset();
    for f in VALID {
        assert_eq!(convert_legacy_round(f), *f, "{f}");
        let out = convert_legacy_formula(f.to_string());
        assert!(!out.changed && out.formula == *f);
    }
    let out = convert_legacy_formula("round($A, 2)".to_string());
    assert!(out.changed);
    assert_eq!(out.formula, "round($A * 100) / 100");

    // Another problem in the same formula: the conversion fixes the round
    // but the formula is still refused, and the preview offers no fix.
    for (f, still) in [
        ("round($A, 2) / 0", "div_zero"),
        ("round($A, 2) + sqr($B)", "unknown_function"),
        ("round($A, 2) $B", "missing_operator"),
    ] {
        let p = preview(&data, f);
        assert!(!p.ok, "{f}");
        assert_eq!(p.converted_formula, None, "{f}");
        let c = convert_legacy_round(f);
        let after = preview(&data, &c);
        assert!(!after.ok, "{f} -> {c}");
        assert_eq!(after.issues[0].code, still, "{f} -> {c}: {}", after.issues[0].message);
    }
    // An unknown sensor is reported before the round (references first).
    let p = preview(&data, "round($A, 2) + $nope");
    assert_eq!((p.issues[0].code, p.converted_formula.as_deref()), ("unknown_sensor", None));
    // A step that is not a whole number of places: refused, not converted.
    let p = preview(&data, "round($A, 0.5)");
    assert_eq!((p.issues[0].code, p.converted_formula.as_deref()), ("round_excel", None));
    assert_eq!(convert_legacy_round("round($A, 0.5)"), "round($A, 0.5)");
}

#[test]
fn conversion_and_the_size_limits() {
    let data = dataset();
    // Over the limits: returned unchanged (and still refused).
    let long = format!("round($A, 2) + {}", "1".repeat(4096));
    let out = convert_legacy_formula(long.clone());
    assert!(!out.changed && out.formula == long);
    let deep = format!("{}round($A, 2){}", "(".repeat(65), ")".repeat(65));
    let out = convert_legacy_formula(deep.clone());
    assert!(!out.changed && out.formula == deep);
    // Just inside the limit: converted, but the longer result is over it —
    // every gate answers `too_long`, so the editor offers no fix.
    let edge = format!("round($A, 2){}", " + 1".repeat(1021));
    assert_eq!(edge.encode_utf16().count(), 4096);
    let out = convert_legacy_formula(edge.clone());
    assert!(out.changed && out.formula.encode_utf16().count() > 4096);
    assert_eq!(preview(&data, &out.formula).issues[0].code, "too_long");
    assert_eq!(validate_formula_against(&data, &out.formula).code, Some("too_long"));
    assert!(compute_formula_sensor(&data, &out.formula, Some("Z"), true).unwrap_err().starts_with("Formula too long"));
    let p = preview(&data, &edge);
    assert_eq!((p.issues[0].code, p.converted_formula.as_deref()), ("round_excel", None));
}

#[test]
fn the_converter_agrees_with_the_refusal_on_every_shape() {
    // Whatever the gate refuses as round_excel and the converter changes, the
    // result no longer has a round_excel refusal — and what the gate accepts,
    // the converter never touches.
    let data = dataset();
    let shapes = [
        "round($A, 2)",
        "round ( $A , 2 )",
        "round[$A;1]",
        "round(-$A, 2)",
        "round(min($A, $B), 2)",
        "round(($A), 1)",
        "1 + round(round(0.1, $A), 2)",
        "round($A, 1 + 1)",
        "round(0.01, $A)",
        "round($B, $A)",
        "${x round($A, 2)} + round($A)",
        "$round",
    ];
    for f in shapes {
        let refused = preview(&data, f).issues.first().map(|i| i.code) == Some(fd::ROUND_EXCEL);
        let c = convert_legacy_round(f);
        if !refused {
            assert_eq!(c, f, "{f}: converted although not refused");
        } else {
            assert_ne!(c, f, "{f}: refused but not converted");
            let after = preview(&data, &c);
            assert!(after.issues.iter().all(|i| i.code != fd::ROUND_EXCEL), "{f} -> {c}");
        }
    }
}
