//! SPECIAL SENSORS, Rust side, PRIVATE surface: are the computed values right,
//! also after a sensor is EDITED?
//!
//! Included from `lib.rs` as a `#[cfg(test)]` child module (its own `#[path]`
//! line, like `qa_health_internal`), so it can reach the private formula engine
//! (`compute_formula_sensor`, `compute_operation_sensor`, the session-level
//! `evaluate_formula_in_state` / `calculate_sensor_in_state`), the chart
//! pipeline (`chart_query::build_chart_view`) and the scatter sampler.
//!
//! Every number is checked against an INDEPENDENT reference written here as a
//! plain Rust closure per formula (never through fasteval / the registry):
//!
//!   A. formula numerics — operators, precedence, associativity, unary minus,
//!      parentheses, constants/decimals/e-notation, functions, NaN/missing,
//!      division by zero, sensor names with spaces / Thai / special chars;
//!   B. operation sensors — every single op, Sum (all-or-nothing) vs
//!      Mean/Median (skip missing), all-missing rows;
//!   C. EDIT after creation — edit a sensor that
//!      others are built on, recompute in build order exactly the way the
//!      frontend does (`replace: true`, `customName` = tag), then verify EVERY
//!      row of every affected sensor, in the raw columns, the line-chart view
//!      (raw + every hourly aggregation + min/max decimation) and the scatter
//!      sample; edit -> revert is bit-exact; operation -> formula kind change;
//!      rename (incl. Thai + space) and case-only rename; self-reference and
//!      stale-generation guards leave the data untouched;
//!   D. reopen — real CSV files (two files merged by timestamp, Buddhist-Era
//!      years incl. the BE leap day 2567-02-29), recipes replayed onto a fresh
//!      load must reproduce the edited values bit-for-bit;
//!   E. the formula strings the FRONTEND builds for
//!      shortcuts / chains / "then apply" wraps, read from the shared fixture
//!      `tests/fixtures/special_sensor_formulas.json` (the TS side pins that
//!      it builds exactly these strings) and evaluated here numerically.
//!
//! A known bug is pinned as a test asserting the CORRECT behaviour, marked
//! `#[ignore = "BUG: ..."]` (project convention) until fixed.

#![allow(clippy::type_complexity)]

use crate::chart_query::build_chart_view;
use crate::csv_processor::{read_merge_csvs_with_report, ColumnarData, TS_MISSING};
use crate::{
    calculate_sensor_in_state, compute_formula_sensor, compute_operation_sensor,
    evaluate_formula_in_state, extract_sensor_refs, install_session, remove_derived_in_state,
    rewrite_sensor_ref, sample_dataset, AppState, DataFilter, SensorOperationConfig,
    STALE_SESSION_ERROR,
};
use std::collections::BTreeMap;
use std::sync::RwLock;

// ===========================================================================
// Helpers
// ===========================================================================

const NAN: f64 = f64::NAN;

struct Rng(u64);
impl Rng {
    fn new(seed: u64) -> Self {
        Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }
    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn f(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
    fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.f()
    }
}

/// Raw sensors of the synthetic dataset. Names chosen to hit every tokenizer
/// path: spaces + parentheses + slash, Thai with combining vowels (Alphabetic
/// -> bare `$name` works), Thai with a tone mark (NOT Alphabetic -> must be
/// braced), a dash, a name that is a prefix of a dotted one, mixed case.
const RAW: [&str; 10] = [
    "A",
    "B",
    "C",
    "Flow (m3/h)",
    "อุณหภูมิ",
    "ค่าแรงดัน",
    "Total-Power",
    "11PT1214A",
    "11PT1214A.PV",
    "Temp",
];

/// 240 rows, 10 minutes apart (40 hourly buckets). ~8% of cells missing; B has
/// exact zeros (division by zero) and negatives (sqrt/pow domain).
fn dataset(seed: u64) -> ColumnarData {
    let n = 240;
    let mut rng = Rng::new(seed);
    let mut headers: Vec<String> = vec!["timestamp".into()];
    headers.extend(RAW.iter().map(|s| s.to_string()));
    let ts: Vec<Option<String>> = (0..n)
        .map(|i| {
            let mins = i * 10;
            Some(format!(
                "2024-01-{:02}T{:02}:{:02}:00",
                1 + mins / (24 * 60),
                (mins / 60) % 24,
                mins % 60
            ))
        })
        .collect();
    let mut cols = vec![vec![NAN; n]];
    for (k, _) in RAW.iter().enumerate() {
        let col: Vec<f64> = (0..n)
            .map(|i| {
                if rng.f() < 0.08 {
                    return NAN;
                }
                match k {
                    0 => rng.range(-50.0, 150.0),
                    1 => {
                        if i % 17 == 0 {
                            0.0
                        } else {
                            rng.range(-5.0, 5.0)
                        }
                    }
                    2 => rng.range(0.1, 10.0),
                    3 => rng.range(0.0, 500.0),
                    4 => rng.range(20.0, 90.0),
                    5 => rng.range(1.0, 10.0),
                    _ => rng.range(-1000.0, 1000.0),
                }
            })
            .collect();
        cols.push(col);
    }
    ColumnarData::from_parts(headers, ts, cols)
}

fn col(data: &ColumnarData, name: &str) -> Vec<f64> {
    let i = data
        .headers
        .iter()
        .position(|h| h == name)
        .unwrap_or_else(|| panic!("no column {name:?} in {:?}", data.headers));
    data.columns[i].clone()
}

/// The formula engine's documented row rule, written independently: any
/// missing input -> missing; any non-finite result -> missing.
fn reference(inputs: &[Vec<f64>], f: &dyn Fn(&[f64]) -> f64) -> Vec<f64> {
    let n = inputs[0].len();
    (0..n)
        .map(|r| {
            let v: Vec<f64> = inputs.iter().map(|c| c[r]).collect();
            if v.iter().any(|x| x.is_nan()) {
                return NAN;
            }
            let out = f(&v);
            if out.is_finite() {
                out
            } else {
                NAN
            }
        })
        .collect()
}

fn close(a: f64, b: f64, rel: f64) -> bool {
    (a.is_nan() && b.is_nan()) || (a - b).abs() <= rel * b.abs().max(1.0)
}

fn assert_col_eq(got: &[f64], want: &[f64], rel: f64, ctx: &str) {
    assert_eq!(got.len(), want.len(), "{ctx}: length");
    for (r, (g, w)) in got.iter().zip(want).enumerate() {
        assert!(close(*g, *w, rel), "{ctx}: row {r}: got {g}, expected {w}");
    }
}

fn same_bits(a: &[f64], b: &[f64]) -> bool {
    a.len() == b.len()
        && a
            .iter()
            .zip(b)
            .all(|(x, y)| (x.is_nan() && y.is_nan()) || x.to_bits() == y.to_bits())
}

fn eval(data: &ColumnarData, formula: &str) -> Result<Vec<f64>, String> {
    compute_formula_sensor(data, formula, Some("__qa_out"), false).map(|(_, c)| c)
}

/// `SensorOperationConfig` built from the exact JSON the frontend sends
/// (`recomputeCall` in `specialSensorRecompute.ts`), so the camelCase keys are
/// part of what is tested.
fn op_config(json: serde_json::Value) -> SensorOperationConfig {
    serde_json::from_value(json).expect("frontend operation config must deserialize")
}

fn single_cfg(op: &str, value: f64, tag: &str) -> SensorOperationConfig {
    op_config(serde_json::json!({
        "mode": "single", "singleOp": { "type": op, "value": value }, "customName": tag
    }))
}

fn multi_cfg(op: &str, tag: &str) -> SensorOperationConfig {
    op_config(serde_json::json!({
        "mode": "multi", "multiOp": { "type": op }, "customName": tag
    }))
}

fn strs(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

// ===========================================================================
// A. Formula numerics
// ===========================================================================

type Case = (&'static str, &'static [&'static str], fn(&[f64]) -> f64);

/// Expected values follow ordinary math conventions (and the "Formula Syntax
/// Help" panel). Everything here is computed by plain Rust.
const FORMULA_CASES: &[Case] = &[
    ("$A + $B * $C", &["A", "B", "C"], |v| v[0] + v[1] * v[2]),
    ("($A + $B) * $C", &["A", "B", "C"], |v| (v[0] + v[1]) * v[2]),
    ("$A - $B - $C", &["A", "B", "C"], |v| (v[0] - v[1]) - v[2]),
    ("$A / $B / $C", &["A", "B", "C"], |v| (v[0] / v[1]) / v[2]),
    ("$A - -$B", &["A", "B"], |v| v[0] + v[1]),
    ("-$A + $B", &["A", "B"], |v| -v[0] + v[1]),
    ("$A * -2", &["A"], |v| v[0] * -2.0),
    ("((($A)) * (($B) + (($C))))", &["A", "B", "C"], |v| v[0] * (v[1] + v[2])),
    ("[$A + 1] * 2", &["A"], |v| (v[0] + 1.0) * 2.0),
    ("0.5 * $A + 1.25e2 - .75", &["A"], |v| 0.5 * v[0] + 125.0 - 0.75),
    ("$A * 1000 / ($C + 1e-3)", &["A", "C"], |v| v[0] * 1000.0 / (v[1] + 0.001)),
    ("$A ^ 2 + $C ^ 0.5", &["A", "C"], |v| v[0] * v[0] + v[1].sqrt()),
    ("$B ^ 0.5", &["B"], |v| v[0].sqrt()), // negative B -> NaN -> missing
    ("2 ^ 3 ^ 2 + 0 * $A", &["A"], |_| 512.0), // right-associative
    ("$C ^ -1", &["C"], |v| 1.0 / v[0]),
    ("$A + $A * $A", &["A"], |v| v[0] + v[0] * v[0]),
    ("abs($A - $B)", &["A", "B"], |v| (v[0] - v[1]).abs()),
    ("sqrt(abs($A)) + pow($B, 2)", &["A", "B"], |v| v[0].abs().sqrt() + v[1] * v[1]),
    ("pow($C, $B)", &["C", "B"], |v| v[0].powf(v[1])),
    ("exp($A / 100)", &["A"], |v| (v[0] / 100.0).exp()),
    ("log10(abs($A) + 1)", &["A"], |v| (v[0].abs() + 1.0).log10()),
    ("min($A, $B, $C) + max($A, $B, $C)", &["A", "B", "C"], |v| {
        v[0].min(v[1]).min(v[2]) + v[0].max(v[1]).max(v[2])
    }),
    ("ceil($A) - floor($B)", &["A", "B"], |v| v[0].ceil() - v[1].floor()),
    ("round($A)", &["A"], |v| v[0].round()),
    // fasteval's documented two-argument form: round(modulus, x).
    ("round(0.01, $A)", &["A"], |v| (v[0] * 100.0).round() / 100.0),
    ("$A / $B", &["A", "B"], |v| v[0] / v[1]), // B == 0 -> inf -> missing
    ("($A - $A) / ($B - $B)", &["A", "B"], |_| NAN), // 0/0 -> missing
    // Sensor names.
    ("${Flow (m3/h)} / 3.6", &["Flow (m3/h)"], |v| v[0] / 3.6),
    ("$อุณหภูมิ * 1.8 + 32", &["อุณหภูมิ"], |v| v[0] * 1.8 + 32.0),
    ("${อุณหภูมิ} - ${ค่าแรงดัน}", &["อุณหภูมิ", "ค่าแรงดัน"], |v| v[0] - v[1]),
    ("${Total-Power} - $11PT1214A + ${11PT1214A.PV}", &["Total-Power", "11PT1214A", "11PT1214A.PV"], |v| {
        v[0] - v[1] + v[2]
    }),
    ("$11PT1214A.PV - $11PT1214A", &["11PT1214A.PV", "11PT1214A"], |v| v[0] - v[1]),
    ("${temp} * 2", &["Temp"], |v| v[0] * 2.0), // case-insensitive resolution
    ("${ Temp } + 1", &["Temp"], |v| v[0] + 1.0), // trimmed resolution
];

#[test]
fn a01_every_formula_case_matches_an_independent_calculation_on_every_row() {
    for seed in [1u64, 7, 42] {
        let data = dataset(seed);
        for (formula, names, f) in FORMULA_CASES {
            let got = eval(&data, formula).unwrap_or_else(|e| panic!("{formula}: {e}"));
            let inputs: Vec<Vec<f64>> = names.iter().map(|n| col(&data, n)).collect();
            let want = reference(&inputs, f);
            assert_col_eq(&got, &want, 1e-12, &format!("seed {seed}: {formula}"));
        }
    }
}

#[test]
fn a02_a_missing_input_empties_the_row_even_when_the_formula_would_not_need_it() {
    let data = dataset(3);
    let got = eval(&data, "$A + 0 * $B").unwrap();
    let a = col(&data, "A");
    let b = col(&data, "B");
    for r in 0..got.len() {
        if a[r].is_nan() || b[r].is_nan() {
            assert!(got[r].is_nan(), "row {r}");
        } else {
            assert_eq!(got[r], a[r], "row {r}");
        }
    }
    assert!(b.iter().any(|x| x.is_nan()), "fixture must contain missing B");
}

#[test]
fn a03_division_by_zero_and_domain_errors_are_missing_never_inf_or_a_number() {
    let data = dataset(5);
    let b = col(&data, "B");
    let zero_rows: Vec<usize> = (0..b.len()).filter(|&r| b[r] == 0.0).collect();
    assert!(!zero_rows.is_empty());
    for formula in ["$A / $B", "$C / $B", "log10($B)", "pow($B, -1)", "$B ^ -2"] {
        let got = eval(&data, formula).unwrap();
        for &r in &zero_rows {
            assert!(got[r].is_nan(), "{formula}: row {r} (B == 0) gave {}", got[r]);
        }
        assert!(got.iter().all(|v| v.is_nan() || v.is_finite()), "{formula}: inf stored");
    }
}

#[test]
fn a04_a_name_that_needs_braces_used_bare_is_an_error_not_a_different_calculation() {
    let data = dataset(9);
    // `$Total-Power` scans as `$Total` minus `Power`; there is no `Total`.
    let err = eval(&data, "$Total-Power").unwrap_err();
    assert!(err.contains("Sensor not found: Total"), "{err}");
    // A Thai tone mark is not alphanumeric: the bare ref stops at `ค`.
    let err = eval(&data, "$ค่าแรงดัน + 1").unwrap_err();
    assert!(err.contains("Sensor not found"), "{err}");
    // And a prefix name does not swallow the dotted one.
    assert_eq!(
        extract_sensor_refs("$11PT1214A + $11PT1214A.PV")
            .into_iter()
            .map(|(_, n)| n)
            .collect::<Vec<_>>(),
        vec!["11PT1214A", "11PT1214A.PV"]
    );
}

#[test]
fn a05_exact_header_wins_over_a_case_variant_in_formulas() {
    // Two raw columns that differ only by case: `$temp` must read `temp`,
    // `$Temp` must read `Temp`.
    let data = ColumnarData::from_parts(
        strs(&["timestamp", "Temp", "temp"]),
        vec![Some("2024-01-01T00:00:00".into()), Some("2024-01-01T00:10:00".into())],
        vec![vec![NAN; 2], vec![1.0, 2.0], vec![10.0, 20.0]],
    );
    assert_eq!(eval(&data, "$Temp").unwrap(), vec![1.0, 2.0]);
    assert_eq!(eval(&data, "$temp").unwrap(), vec![10.0, 20.0]);
}

#[test]
fn a06_large_magnitudes_keep_full_f64_precision_and_overflow_is_missing() {
    let data = ColumnarData::from_parts(
        strs(&["timestamp", "Big", "Small"]),
        vec![Some("2024-01-01T00:00:00".into()), Some("2024-01-01T00:10:00".into())],
        vec![vec![NAN; 2], vec![1.0e15, 1.0e308], vec![0.125, 10.0]],
    );
    let got = eval(&data, "$Big + $Small").unwrap();
    assert_eq!(got[0], 1.0e15 + 0.125);
    let got = eval(&data, "$Big * $Small").unwrap();
    assert_eq!(got[0], 1.25e14);
    assert!(got[1].is_nan(), "1e308 * 10 overflows to inf -> stored as missing");
}

/// Pins CURRENT fasteval behaviour that differs from what many users expect.
/// Not marked as a bug (it is a convention, Excel does the same) but the
/// customer should know: unary minus binds tighter than `^`.
#[test]
fn a07_unary_minus_binds_tighter_than_power_pinned_convention() {
    let data = dataset(11);
    let a = col(&data, "A");
    let got = eval(&data, "-$A ^ 2").unwrap();
    let want = reference(&[a.clone()], &|v| (-v[0]).powi(2));
    assert_col_eq(&got, &want, 1e-12, "-$A ^ 2 == (-A)^2 (fasteval/Excel), NOT -(A^2)");
    let got = eval(&data, "0 - $A ^ 2").unwrap();
    let want = reference(&[a], &|v| -(v[0] * v[0]));
    assert_col_eq(&got, &want, 1e-12, "0 - $A ^ 2 == -(A^2)");
}

/// Pins CURRENT behaviour: fasteval's `log(x)` is BASE 10 (not natural log),
/// and `log(b, x)` takes the base FIRST. See the BUG test below for why this
/// matters (the help panel lists `log` next to `log10`).
#[test]
fn a08_log_is_base_10_pinned() {
    let data = dataset(12);
    let c = col(&data, "C");
    let got = eval(&data, "log($C)").unwrap();
    assert_col_eq(&got, &reference(&[c.clone()], &|v| v[0].log10()), 1e-12, "log == log10");
    let got = eval(&data, "log(2, $C)").unwrap();
    assert_col_eq(&got, &reference(&[c], &|v| v[0].log2()), 1e-12, "log(base, x)");
}

/// BUG (MEDIUM): the formula help panel (`SensorTooling.tsx`, "Formula Syntax
/// Help") lists `abs, sqrt, pow, log, log10, exp, ...` — offering `log` NEXT TO
/// `log10` reads as "log = natural log", but fasteval's `log(x)` is log10, and
/// there is no `ln` at all (an `ln(...)` call silently empties every row, see
/// a10). A user typing `log($X)` for ln(X) gets values 2.303x too small.
/// Fix: add `("ln", [x]) => Some(x.ln())` to `eval_extra_math_fn` (lib.rs) and
/// spell the help out ("log = log10, ln = natural log").
#[test]
fn a09_bug_natural_log_is_available_as_ln() {
    let data = dataset(13);
    let c = col(&data, "C");
    let got = eval(&data, "ln($C)").expect("ln must be a supported function");
    assert_col_eq(&got, &reference(&[c], &|v| v[0].ln()), 1e-12, "ln($C)");
}

/// BUG (HIGH): an unknown identifier or function — `$A * pi` (fasteval wants
/// `pi()`), `ln($A)`, `sqrt($A, 2)` (wrong arity), a typo like `sqr($A)`, a
/// stray letter — is a per-row evaluation ERROR, which
/// `compute_formula_sensor` (lib.rs, the `match expr_ref.eval(..)` arm
/// `_ => new_col.push(f64::NAN)`) turns into "missing" for EVERY row and
/// returns `Ok`. The sensor is created/edited "successfully" with no data at
/// all. `validate_formula` would catch it (it test-evaluates with dummy
/// values), but neither the Create path nor the Manage-tab EDIT path gates on
/// it — the edit form never calls `validate_formula` at all.
/// Fix: in `compute_formula_sensor`, test-evaluate once with dummy values
/// (exactly as `validate_formula` does) before the row loop and return
/// `Err("Formula error: ...")` on an eval error; keep NaN only for NaN/inf
/// RESULTS. Frontend: show the validation result in `SpecialSensorEditor`.
#[test]
fn a10_bug_unknown_identifier_or_function_is_refused() {
    let data = dataset(14);
    // `ln($A)` was on this list until `ln` became a real function (a09).
    for formula in ["$A * pi", "sqrt($A, 2)", "sqr($A)", "$A + x", "$A * e", "lnn($A)"] {
        match eval(&data, formula) {
            Err(_) => {}
            Ok(c) => panic!(
                "{formula}: accepted, {} of {} rows empty",
                c.iter().filter(|v| v.is_nan()).count(),
                c.len()
            ),
        }
    }
}

/// Follow-up to a10: the refusal names the problem, and the
/// editor's live check (`validate_formula`) gives the SAME verdict and text.
#[test]
fn a10b_the_refusal_names_the_problem_and_matches_the_editor_check() {
    let data = dataset(14);
    for (formula, needle) in [
        ("$A * pi", "Write pi() for"),
        ("$A * e", "Write e() for"),
        ("sqr($A)", "unknown function 'sqr'"),
        ("sqrt($A, 2)", "sqrt takes 1 value but was given 2"),
        ("$A + x", "unknown name 'x'"),
        ("$A(2)", "$A is a sensor, not a function"),
        ("$A > 0 && nope($A)", "unknown function 'nope'"),
    ] {
        let err = eval(&data, formula).unwrap_err();
        assert!(err.starts_with("Formula error: ") && err.contains(needle), "{formula}: {err}");
        let v = crate::validate_formula_against(&data, formula);
        assert!(!v.valid, "{formula}: the editor must flag it too");
        assert_eq!(v.error.as_deref(), Some(err.as_str()), "{formula}: same message in the editor");
    }
    // NaN / inf RESULTS are still "missing" rows, not an error.
    assert!(eval(&data, "($A - $A) / ($B - $B)").unwrap().iter().all(|v| v.is_nan()));
}

/// `round(x, n)` written the spreadsheet way: fasteval reads the two
/// arguments the other way round — `round(modulus, x)` — so `round($A, 2)`
/// would round the CONSTANT 2 to a multiple of A: every row garbage (0, A or
/// 2A), with no error. The shape is REFUSED (never silently wrong) with the
/// exact formula to type instead; that suggested formula rounds to 2 decimals.
#[test]
fn a11_bug_round_with_decimals_rounds_the_sensor() {
    let data = dataset(15);
    let a = col(&data, "A");
    let err = eval(&data, "round($A, 2)").unwrap_err();
    assert_eq!(
        err,
        "Formula error: round($A, 2) does not round to 2 decimal places. Write round($A * 100) / 100 instead."
    );
    let got = eval(&data, "round($A * 100) / 100").unwrap();
    assert_col_eq(&got, &reference(std::slice::from_ref(&a), &|v| (v[0] * 100.0).round() / 100.0), 1e-12, "suggested formula");
    // The documented forms are untouched.
    let got = eval(&data, "round(0.01, $A)").unwrap();
    assert_col_eq(&got, &reference(std::slice::from_ref(&a), &|v| (v[0] * 100.0).round() / 100.0), 1e-9, "round(0.01, $A)");
    let got = eval(&data, "round($A)").unwrap();
    assert_col_eq(&got, &reference(&[a], &|v| v[0].round()), 0.0, "round($A)");
}

/// Dataset with `n` sensors S0..S{n-1}, three rows: S_i = [i, 1, 2].
fn many_sensors(n: usize) -> ColumnarData {
    let mut headers = vec!["timestamp".to_string()];
    let mut cols = vec![vec![NAN; 3]];
    for i in 0..n {
        headers.push(format!("S{i}"));
        cols.push(vec![i as f64, 1.0, 2.0]);
    }
    ColumnarData::from_parts(headers, (0..3).map(|i| Some(format!("2024-01-01T00:0{i}:00"))).collect(), cols)
}

/// BUG (LOW): fasteval's parse slab holds 64 sub-expressions, and every
/// FUNCTION ARGUMENT is one. The "Spread (max − min)" shortcut builds
/// `max($S0, …, $Sn) - min($S0, …, $Sn)` — each sensor twice — so a Spread over
/// roughly 32 or more selected sensors (31 passes, 33 fails) fails with "Formula parse error: SlabOverflow"
/// (the same is true of any hand-typed `max(...)`/`min(...)` with > 64
/// arguments). Not silent, but the shortcut is offered for any selection size.
/// Fix (lib.rs `compute_formula_sensor` + `validate_formula`): parse with
/// `fasteval::Slab::with_capacity(formula.len().max(64))` instead of
/// `Slab::new()`.
#[test]
fn a12_bug_spread_over_many_sensors_evaluates() {
    let n = 40;
    let data = many_sensors(n);
    let refs = (0..n).map(|i| format!("$S{i}")).collect::<Vec<_>>().join(", ");
    let got = eval(&data, &format!("max({refs}) - min({refs})")).expect("a 40-sensor Spread must evaluate");
    assert_eq!(got, vec![(n - 1) as f64, 0.0, 0.0]);
}

/// BUG (LOW): `MAX_FORMULA_LEN` (4096) is checked on the formula AS TYPED, but
/// fasteval has its own 4096-byte limit on the REWRITTEN expression, where every
/// `$Sx` became `__sensor_N` (longer). A chain the app's own limit accepts can
/// therefore fail with "Formula parse error: TooLong". Fix: rewrite references
/// to short variables (e.g. `v0`, `v1`, … — fasteval var names may not start
/// with a digit but `v12` is fine) and/or check the limit on the rewritten text.
#[test]
fn a13_bug_a_formula_under_the_app_length_limit_evaluates() {
    let n = 400;
    let data = many_sensors(n);
    let formula = (0..n).map(|i| format!("$S{i}")).collect::<Vec<_>>().join("+");
    assert!(formula.len() < 4096, "{} chars: within the app's own limit", formula.len());
    let got = eval(&data, &formula).expect("accepted by check_formula_limits, so it must evaluate");
    assert_eq!(got[1], n as f64);
}

/// Follow-up to a12/a13: the only size limit is the
/// app's own `check_formula_limits` (4096 chars as typed, 64 bracket levels).
#[test]
fn a12b_the_only_formula_size_limit_left_is_the_apps_own() {
    // Spread over as many sensors as fit in 4096 chars.
    let spread = |n: usize| {
        let refs = (0..n).map(|i| format!("$S{i}")).collect::<Vec<_>>().join(", ");
        format!("max({refs}) - min({refs})")
    };
    let n = (1..2000).take_while(|&n| spread(n).len() <= 4096).last().unwrap();
    assert!(n > 300, "{n}");
    let got = eval(&many_sensors(n), &spread(n)).unwrap();
    assert_eq!(got, vec![(n - 1) as f64, 0.0, 0.0]);
    let err = eval(&many_sensors(n + 1), &spread(n + 1)).unwrap_err();
    assert!(err.contains("too long"), "{err}");

    // 1024 two-character names `$xy` joined by `+` = 4095 chars typed, but
    // MORE than 4096 once rewritten (`_0` .. `_1023`): still evaluates.
    let alnum: Vec<char> = ('a'..='z').chain('0'..='9').collect();
    let names: Vec<String> = alnum
        .iter()
        .flat_map(|a| alnum.iter().map(move |b| format!("{a}{b}")))
        .take(1024)
        .collect();
    let mut headers = vec!["timestamp".to_string()];
    let mut cols = vec![vec![NAN; 1]];
    for name in &names {
        headers.push(name.clone());
        cols.push(vec![1.0]);
    }
    let data = ColumnarData::from_parts(headers, vec![Some("2024-01-01T00:00:00".into())], cols);
    let formula = names.iter().map(|s| format!("${s}")).collect::<Vec<_>>().join("+");
    assert_eq!(formula.len(), 4095);
    assert_eq!(eval(&data, &formula).unwrap(), vec![1024.0]);

    // 64 nested brackets (the app's limit) evaluate; 65 are refused by the app.
    let deep = |d: usize| format!("{}$S0{}", "(".repeat(d), ")".repeat(d));
    assert_eq!(eval(&many_sensors(1), &deep(64)).unwrap(), vec![0.0, 1.0, 2.0]);
    assert!(eval(&many_sensors(1), &deep(65)).unwrap_err().contains("too deeply nested"));
}

// ===========================================================================
// B. Operation sensors (calculate_new_sensor)
// ===========================================================================

#[test]
fn b01_every_single_operation_matches_an_independent_calculation() {
    let data = dataset(21);
    let cases: Vec<(&str, f64, Box<dyn Fn(f64) -> f64>)> = vec![
        ("add", 2.5, Box::new(|a| a + 2.5)),
        ("subtract", 7.0, Box::new(|a| a - 7.0)),
        ("multiply", -3.0, Box::new(|a| a * -3.0)),
        ("divide", 4.0, Box::new(|a| a / 4.0)),
        ("divide", 0.0, Box::new(|_| NAN)),
        ("power", 2.0, Box::new(|a| a * a)),
        ("power", 0.5, Box::new(|a| a.sqrt())),
        ("abs", 0.0, Box::new(|a| a.abs())),
        ("sqrt", 0.0, Box::new(|a| a.sqrt())),
        ("log10", 0.0, Box::new(|a| a.log10())),
        ("exp", 0.0, Box::new(|a| (a).exp())),
        ("ceil", 0.0, Box::new(|a| a.ceil())),
        ("floor", 0.0, Box::new(|a| a.floor())),
        ("round", 0.0, Box::new(|a| a.round())),
        ("round", 2.0, Box::new(|a| (a * 100.0).round() / 100.0)),
        ("round", 3.0, Box::new(|a| (a * 1000.0).round() / 1000.0)),
    ];
    for source in ["A", "B"] {
        let src = col(&data, source);
        for (op, value, f) in &cases {
            let cfg = single_cfg(op, *value, "__qa");
            let (_, got) = compute_operation_sensor(&data, &strs(&[source]), &cfg, false)
                .unwrap_or_else(|e| panic!("{op} {value}: {e}"));
            let want = reference(&[src.clone()], &|v| f(v[0]));
            assert_col_eq(&got, &want, 1e-12, &format!("{op}({source}, {value})"));
        }
    }
    // Overflow is missing, never inf.
    let (_, got) = compute_operation_sensor(&data, &strs(&["A"]), &single_cfg("exp", 0.0, "__qa"), false).unwrap();
    assert!(got.iter().all(|v| v.is_nan() || v.is_finite()));
}

#[test]
fn b02_round_to_decimals_stays_within_half_a_unit_of_the_source() {
    let data = dataset(22);
    let a = col(&data, "A");
    for d in 0..=4 {
        let (_, got) =
            compute_operation_sensor(&data, &strs(&["A"]), &single_cfg("round", d as f64, "__qa"), false).unwrap();
        let unit = 10f64.powi(-d);
        for r in 0..a.len() {
            if a[r].is_nan() {
                assert!(got[r].is_nan());
                continue;
            }
            assert!((got[r] - a[r]).abs() <= unit / 2.0 + 1e-9, "d={d} row {r}: {} vs {}", got[r], a[r]);
            let steps = got[r] / unit;
            assert!((steps - steps.round()).abs() < 1e-6, "d={d} row {r}: {} not a multiple of {unit}", got[r]);
        }
    }
}

/// Sum is all-or-nothing; Mean and Median skip missing sources; an all-missing
/// row is missing for every op.
#[test]
fn b03_sum_mean_median_missing_value_rules_on_2_to_6_sources() {
    let data = dataset(23);
    let pool = ["A", "B", "C", "Flow (m3/h)", "อุณหภูมิ", "Temp"];
    for k in 2..=pool.len() {
        let names = &pool[..k];
        let inputs: Vec<Vec<f64>> = names.iter().map(|n| col(&data, n)).collect();
        let n = inputs[0].len();
        let present = |r: usize| -> Vec<f64> { inputs.iter().map(|c| c[r]).filter(|v| !v.is_nan()).collect() };

        let (_, sum) = compute_operation_sensor(&data, &strs(names), &multi_cfg("sum", "__qa"), false).unwrap();
        let (_, mean) = compute_operation_sensor(&data, &strs(names), &multi_cfg("mean", "__qa"), false).unwrap();
        let (_, med) = compute_operation_sensor(&data, &strs(names), &multi_cfg("median", "__qa"), false).unwrap();
        for r in 0..n {
            let p = present(r);
            let want_sum = if p.len() == k { p.iter().sum::<f64>() } else { NAN };
            let want_mean = if p.is_empty() { NAN } else { p.iter().sum::<f64>() / p.len() as f64 };
            let want_med = if p.is_empty() {
                NAN
            } else {
                let mut s = p.clone();
                s.sort_by(|a, b| a.partial_cmp(b).unwrap());
                let m = s.len() / 2;
                if s.len() % 2 == 1 { s[m] } else { (s[m - 1] + s[m]) / 2.0 }
            };
            assert!(close(sum[r], want_sum, 1e-12), "k={k} sum row {r}: {} vs {want_sum}", sum[r]);
            assert!(close(mean[r], want_mean, 1e-12), "k={k} mean row {r}: {} vs {want_mean}", mean[r]);
            assert!(close(med[r], want_med, 1e-12), "k={k} median row {r}: {} vs {want_med}", med[r]);
        }
        // The fixture really exercises the partial rows.
        assert!((0..n).any(|r| { let p = present(r); !p.is_empty() && p.len() < k }));
    }
}

#[test]
fn b04_sum_operation_agrees_with_the_equivalent_plus_chain_formula() {
    // "Sum all" (operation) and "A + B + C" (the default "Combine with
    // operators" chain) must give the same values — both leave a row empty
    // when any source is missing.
    let data = dataset(24);
    let (_, sum) = compute_operation_sensor(&data, &strs(&["A", "B", "C"]), &multi_cfg("sum", "__qa"), false).unwrap();
    let chain = eval(&data, "$A + $B + $C").unwrap();
    assert_col_eq(&sum, &chain, 1e-12, "sum op vs + chain");
}

// ===========================================================================
// C. EDIT after creation — session level, exactly the frontend's call shape
// ===========================================================================

/// A special-sensor recipe, as `SpecialSensorRecipe` in `types.ts`.
#[derive(Clone)]
enum Recipe {
    Formula { tag: String, formula: String },
    Op { tag: String, sources: Vec<String>, cfg: serde_json::Value },
}

impl Recipe {
    fn f(tag: &str, formula: &str) -> Self {
        Recipe::Formula { tag: tag.into(), formula: formula.into() }
    }
    fn op(tag: &str, sources: &[&str], cfg: serde_json::Value) -> Self {
        Recipe::Op { tag: tag.into(), sources: strs(sources), cfg }
    }
}

/// `recomputeCall` (specialSensorRecompute.ts) + the Rust command, in one:
/// formula -> `evaluate_formula(formula, customName = tag, replace)`,
/// operation -> `calculate_new_sensor(sources, {...config, customName: tag}, replace)`.
fn run(state: &AppState, r: &Recipe, replace: bool, generation: Option<u64>) -> Result<String, String> {
    match r {
        Recipe::Formula { tag, formula } => {
            evaluate_formula_in_state(state, formula, Some(tag), replace, generation, &|| {})
        }
        Recipe::Op { tag, sources, cfg } => {
            let mut json = cfg.clone();
            json["customName"] = serde_json::Value::String(tag.clone());
            let cfg = op_config(json);
            calculate_sensor_in_state(state, sources, &cfg, replace, generation, &|| {})
        }
    }
}

fn snapshot(state: &AppState) -> ColumnarData {
    let lock = state.0.read().unwrap();
    let s = lock.as_ref().unwrap();
    ColumnarData::from_parts(s.data.headers.clone(), s.data.timestamps.clone(), s.data.columns.clone())
}

fn with_data<T>(state: &AppState, f: impl FnOnce(&ColumnarData) -> T) -> T {
    let lock = state.0.read().unwrap();
    f(&lock.as_ref().unwrap().data)
}

fn chart_filter(sensors: &[&str]) -> DataFilter {
    DataFilter { sensors: strs(sensors), ..Default::default() }
}

/// Independent hourly aggregation of one column (same bucket rule as the
/// chart: floor(ts / 1 h), rows with no timestamp skipped, missing values
/// ignored inside a bucket, empty bucket = None).
fn hourly(data: &ColumnarData, values: &[f64], method: &str) -> (Vec<i64>, Vec<Option<f64>>) {
    const HOUR: i64 = 3_600_000_000;
    let mut buckets: BTreeMap<i64, Vec<f64>> = BTreeMap::new();
    for (r, &ts) in data.ts_parsed.iter().enumerate() {
        if ts == TS_MISSING {
            continue;
        }
        let e = buckets.entry(ts.div_euclid(HOUR)).or_default();
        if !values[r].is_nan() {
            e.push(values[r]);
        }
    }
    let keys = buckets.keys().copied().collect();
    let vals = buckets
        .values()
        .map(|v| {
            if v.is_empty() {
                return None;
            }
            Some(match method {
                "avg" => v.iter().sum::<f64>() / v.len() as f64,
                "max" => v.iter().copied().fold(f64::NEG_INFINITY, f64::max),
                "min" => v.iter().copied().fold(f64::INFINITY, f64::min),
                "first" => v[0],
                "last" => v[v.len() - 1],
                _ => unreachable!(),
            })
        })
        .collect();
    (keys, vals)
}

/// Every place the Dashboard reads a special sensor's values from must agree
/// with `want` (the independent reference) for every sensor in `sensors`.
fn assert_everywhere(state: &AppState, sensors: &[&str], want: &[Vec<f64>], ctx: &str) {
    with_data(state, |data| {
        // 1. the stored column
        for (s, w) in sensors.iter().zip(want) {
            assert_col_eq(&col(data, s), w, 1e-12, &format!("{ctx}: column {s}"));
        }
        // 2. line chart, raw sampling (dataset < max_points -> every row)
        let view = build_chart_view(data, &chart_filter(sensors), None, "raw", 100_000).unwrap();
        assert_eq!(view.headers, strs(sensors), "{ctx}: chart headers");
        assert_eq!(view.total_rows, data.n_rows(), "{ctx}: chart rows");
        for (k, w) in want.iter().enumerate() {
            for (r, got) in view.series[k].iter().enumerate() {
                let exp = if w[r].is_nan() { None } else { Some(w[r]) };
                match (got, exp) {
                    (None, None) => {}
                    (Some(g), Some(e)) => assert!(close(*g, e, 1e-12), "{ctx}: chart raw {} row {r}: {g} vs {e}", sensors[k]),
                    _ => panic!("{ctx}: chart raw {} row {r}: {got:?} vs {exp:?}", sensors[k]),
                }
            }
        }
        // 3. line chart, every hourly aggregation
        for method in ["avg", "max", "min", "first", "last"] {
            let view = build_chart_view(data, &chart_filter(sensors), None, method, 100_000).unwrap();
            for (k, w) in want.iter().enumerate() {
                let (_, exp) = hourly(data, w, method);
                assert_eq!(view.series[k].len(), exp.len(), "{ctx}: {method} bucket count");
                for (b, (g, e)) in view.series[k].iter().zip(&exp).enumerate() {
                    match (g, e) {
                        (None, None) => {}
                        (Some(g), Some(e)) => assert!(close(*g, *e, 1e-12), "{ctx}: {method} {} bucket {b}: {g} vs {e}", sensors[k]),
                        _ => panic!("{ctx}: {method} {} bucket {b}: {g:?} vs {e:?}", sensors[k]),
                    }
                }
            }
        }
        // 4. decimated view keeps the true envelope (min & max of the series)
        let view = build_chart_view(data, &chart_filter(sensors), None, "raw", 20).unwrap();
        for (k, w) in want.iter().enumerate() {
            let finite: Vec<f64> = w.iter().copied().filter(|v| !v.is_nan()).collect();
            if finite.is_empty() {
                continue;
            }
            let lo = finite.iter().copied().fold(f64::INFINITY, f64::min);
            let hi = finite.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            let shown: Vec<f64> = view.series[k].iter().flatten().copied().collect();
            assert!(shown.iter().any(|v| close(*v, lo, 1e-12)), "{ctx}: decimated {} lost the min {lo}", sensors[k]);
            assert!(shown.iter().any(|v| close(*v, hi, 1e-12)), "{ctx}: decimated {} lost the max {hi}", sensors[k]);
        }
        // 5. scatter sample (every row, mapped back by its unique timestamp)
        let sample = sample_dataset(data, &chart_filter(sensors), 1_000_000).unwrap();
        assert_eq!(sample.headers, strs(sensors), "{ctx}: scatter headers");
        assert_eq!(sample.rows.len(), data.n_rows(), "{ctx}: scatter rows");
        let row_of: BTreeMap<String, usize> = data
            .timestamps
            .iter()
            .enumerate()
            .map(|(r, t)| (t.clone().unwrap(), r))
            .collect();
        for rec in &sample.rows {
            let r = row_of[rec.timestamp.as_ref().unwrap()];
            for (k, w) in want.iter().enumerate() {
                let exp = if w[r].is_nan() { None } else { Some(w[r]) };
                match (rec.values[k], exp) {
                    (None, None) => {}
                    (Some(g), Some(e)) => assert!(close(g, e, 1e-12), "{ctx}: scatter {} row {r}", sensors[k]),
                    (g, e) => panic!("{ctx}: scatter {} row {r}: {g:?} vs {e:?}", sensors[k]),
                }
            }
        }
    });
}

/// The fixture chain: S1 = A + Flow; S2 = S1*2 - B (built on S1);
/// S3 = mean(S1, C) (operation on a special sensor); S4 = S2 × 3 (single op on
/// a special sensor, two levels down).
fn chain_recipes() -> Vec<Recipe> {
    vec![
        Recipe::f("S1", "$A + ${Flow (m3/h)}"),
        Recipe::f("S2", "$S1 * 2 - $B"),
        Recipe::op("S3", &["S1", "C"], serde_json::json!({ "mode": "multi", "multiOp": { "type": "mean" } })),
        Recipe::op("S4", &["S2"], serde_json::json!({ "mode": "single", "singleOp": { "type": "multiply", "value": 3 } })),
    ]
}

/// Independent reference for the chain, given S1's values.
fn chain_reference(data: &ColumnarData, s1: Vec<f64>) -> Vec<Vec<f64>> {
    let b = col(data, "B");
    let c = col(data, "C");
    let s2 = reference(&[s1.clone(), b], &|v| v[0] * 2.0 - v[1]);
    let s3: Vec<f64> = (0..s1.len())
        .map(|r| {
            let p: Vec<f64> = [s1[r], c[r]].into_iter().filter(|v| !v.is_nan()).collect();
            if p.is_empty() { NAN } else { p.iter().sum::<f64>() / p.len() as f64 }
        })
        .collect();
    let s4 = reference(&[s2.clone()], &|v| v[0] * 3.0);
    vec![s1, s2, s3, s4]
}

fn s1_reference(data: &ColumnarData, f: &dyn Fn(&[f64]) -> f64) -> Vec<f64> {
    reference(&[col(data, "A"), col(data, "Flow (m3/h)")], f)
}

#[test]
fn c01_create_chain_values_are_correct_everywhere() {
    let state = AppState(RwLock::new(None));
    let g = install_session(&state, dataset(31), vec![]).unwrap();
    for r in chain_recipes() {
        run(&state, &r, false, Some(g)).unwrap();
    }
    let want = with_data(&state, |d| chain_reference(d, s1_reference(d, &|v| v[0] + v[1])));
    assert_everywhere(&state, &["S1", "S2", "S3", "S4"], &want, "after create");
}

/// THE CUSTOMER'S QUESTION: edit S1's formula after S2/S3/S4 were built on it.
/// The frontend recomputes the edited sensor and then every dependent in build
/// order (`runSpecialSensorEdit` -> `recomputeSpecialSensors([next, ...downstream])`).
#[test]
fn c02_edit_formula_of_a_base_sensor_recomputes_it_and_every_dependent_correctly_everywhere() {
    let state = AppState(RwLock::new(None));
    let g = install_session(&state, dataset(32), vec![]).unwrap();
    let recipes = chain_recipes();
    for r in &recipes {
        run(&state, r, false, Some(g)).unwrap();
    }
    let headers_before = with_data(&state, |d| d.headers.clone());

    // Edit 1: a different formula with precedence + a divisor.
    let mut edited = recipes.clone();
    edited[0] = Recipe::f("S1", "$A - ${Flow (m3/h)} / 2");
    for r in &edited {
        run(&state, r, true, Some(g)).unwrap();
    }
    let want = with_data(&state, |d| chain_reference(d, s1_reference(d, &|v| v[0] - v[1] / 2.0)));
    assert_everywhere(&state, &["S1", "S2", "S3", "S4"], &want, "after edit 1");
    assert_eq!(with_data(&state, |d| d.headers.clone()), headers_before, "edit replaces in place, no new columns");

    // Edit 2: edit again (repeated edits must not drift).
    edited[0] = Recipe::f("S1", "($A + 10) * ${Flow (m3/h)} / 100");
    for r in &edited {
        run(&state, r, true, Some(g)).unwrap();
    }
    let want = with_data(&state, |d| chain_reference(d, s1_reference(d, &|v| (v[0] + 10.0) * v[1] / 100.0)));
    assert_everywhere(&state, &["S1", "S2", "S3", "S4"], &want, "after edit 2");
}

#[test]
fn c03_edit_then_revert_restores_every_column_bit_for_bit() {
    let state = AppState(RwLock::new(None));
    let g = install_session(&state, dataset(33), vec![]).unwrap();
    let recipes = chain_recipes();
    for r in &recipes {
        run(&state, r, false, Some(g)).unwrap();
    }
    let before = snapshot(&state);

    let mut edited = recipes.clone();
    edited[0] = Recipe::f("S1", "$A * $A");
    for r in &edited {
        run(&state, r, true, Some(g)).unwrap();
    }
    // "Undo" = edit back to the stored recipe (what the rollback does too).
    for r in &recipes {
        run(&state, r, true, Some(g)).unwrap();
    }
    let after = snapshot(&state);
    assert_eq!(before.headers, after.headers);
    for (i, h) in before.headers.iter().enumerate() {
        assert!(same_bits(&before.columns[i], &after.columns[i]), "column {h} drifted");
    }
}

/// Without recomputing the dependents, a dependent keeps the OLD values — this
/// is why `runSpecialSensorEdit` must recompute downstream. Guards the
/// assumption the frontend relies on (Rust never recomputes dependents itself).
#[test]
fn c04_rust_does_not_cascade_so_the_frontend_must_recompute_downstream() {
    let state = AppState(RwLock::new(None));
    let g = install_session(&state, dataset(34), vec![]).unwrap();
    for r in chain_recipes() {
        run(&state, &r, false, Some(g)).unwrap();
    }
    let s2_before = with_data(&state, |d| col(d, "S2"));
    run(&state, &Recipe::f("S1", "$A * 0 + 1"), true, Some(g)).unwrap();
    assert!(same_bits(&with_data(&state, |d| col(d, "S2")), &s2_before), "S2 unchanged until recomputed");
}

#[test]
fn c05_edit_operation_sources_and_type_and_change_kind_operation_to_formula() {
    let state = AppState(RwLock::new(None));
    let g = install_session(&state, dataset(35), vec![]).unwrap();
    for r in chain_recipes() {
        run(&state, &r, false, Some(g)).unwrap();
    }
    // S3: mean(S1, C) -> median(S1, C, Temp)
    run(&state, &Recipe::op("S3", &["S1", "C", "Temp"], serde_json::json!({ "mode": "multi", "multiOp": { "type": "median" } })), true, Some(g)).unwrap();
    with_data(&state, |d| {
        let ins = [col(d, "S1"), col(d, "C"), col(d, "Temp")];
        let want: Vec<f64> = (0..d.n_rows())
            .map(|r| {
                let mut p: Vec<f64> = ins.iter().map(|c| c[r]).filter(|v| !v.is_nan()).collect();
                if p.is_empty() { return NAN; }
                p.sort_by(|a, b| a.partial_cmp(b).unwrap());
                let m = p.len() / 2;
                if p.len() % 2 == 1 { p[m] } else { (p[m - 1] + p[m]) / 2.0 }
            })
            .collect();
        assert_col_eq(&col(d, "S3"), &want, 1e-12, "S3 median");
    });
    // S4: single multiply 3 on S2 -> formula kind "$S2 / 4 + $C"
    run(&state, &Recipe::f("S4", "$S2 / 4 + $C"), true, Some(g)).unwrap();
    with_data(&state, |d| {
        let want = reference(&[col(d, "S2"), col(d, "C")], &|v| v[0] / 4.0 + v[1]);
        assert_col_eq(&col(d, "S4"), &want, 1e-12, "S4 now a formula");
    });
    // and back: formula -> operation (sum)
    run(&state, &Recipe::op("S4", &["S2", "C"], serde_json::json!({ "mode": "multi", "multiOp": { "type": "sum" } })), true, Some(g)).unwrap();
    with_data(&state, |d| {
        let want = reference(&[col(d, "S2"), col(d, "C")], &|v| v[0] + v[1]);
        assert_col_eq(&col(d, "S4"), &want, 1e-12, "S4 sum");
    });
}

/// Rename S1 -> "ความเร็ว รวม" (Thai + space): the frontend rewrites every
/// downstream formula with `rename_formula_refs`, recomputes the new name
/// (appended) and the rewritten dependents, then drops the old column LAST.
#[test]
fn c06_rename_with_thai_and_space_keeps_every_value_and_drops_the_old_column() {
    let state = AppState(RwLock::new(None));
    let g = install_session(&state, dataset(36), vec![]).unwrap();
    for r in chain_recipes() {
        run(&state, &r, false, Some(g)).unwrap();
    }
    let before = snapshot(&state);
    let new = "ความเร็ว รวม";

    let renamed_s2 = rewrite_sensor_ref("$S1 * 2 - $B", "S1", new);
    assert_eq!(renamed_s2, "${ความเร็ว รวม} * 2 - $B");
    run(&state, &Recipe::f(new, "$A + ${Flow (m3/h)}"), true, Some(g)).unwrap();
    run(&state, &Recipe::f("S2", &renamed_s2), true, Some(g)).unwrap();
    run(&state, &Recipe::op("S3", &[new, "C"], serde_json::json!({ "mode": "multi", "multiOp": { "type": "mean" } })), true, Some(g)).unwrap();
    run(&state, &chain_recipes()[3], true, Some(g)).unwrap();
    assert_eq!(remove_derived_in_state(&state, &strs(&["S1"]), Some(g)).unwrap(), 1);

    with_data(&state, |d| {
        assert!(d.col_index("S1").is_none(), "old column gone");
        assert!(same_bits(&col(d, new), &col(&before, "S1")), "renamed sensor keeps its values");
        for s in ["S2", "S3", "S4"] {
            assert!(same_bits(&col(d, s), &col(&before, s)), "{s} unchanged by a pure rename");
        }
        assert_eq!(d.headers.len(), before.headers.len(), "no orphan column");
    });
    // The old name is free again and reading it gives the NEW sensor's data.
    run(&state, &Recipe::f("S1", "$C * 100"), false, Some(g)).unwrap();
    with_data(&state, |d| {
        let want = reference(&[col(d, "C")], &|v| v[0] * 100.0);
        assert_col_eq(&col(d, "S1"), &want, 1e-12, "re-created S1");
    });
}

#[test]
fn c07_case_only_rename_overwrites_in_place_and_formulas_still_resolve() {
    let state = AppState(RwLock::new(None));
    let g = install_session(&state, dataset(37), vec![]).unwrap();
    for r in chain_recipes() {
        run(&state, &r, false, Some(g)).unwrap();
    }
    run(&state, &Recipe::f("s1", "$A + ${Flow (m3/h)}"), true, Some(g)).unwrap();
    with_data(&state, |d| {
        assert_eq!(d.headers.iter().filter(|h| h.eq_ignore_ascii_case("s1")).count(), 1);
        assert!(d.col_index("s1").is_some());
    });
    // A dependent whose stored formula still says `$S1` resolves case-insensitively.
    run(&state, &chain_recipes()[1], true, Some(g)).unwrap();
    let want = with_data(&state, |d| chain_reference(d, s1_reference(d, &|v| v[0] + v[1])));
    assert_everywhere(&state, &["s1", "S2"], &want[..2], "case-only rename");
}

#[test]
fn c08_an_edit_that_reads_itself_or_a_wrong_generation_changes_nothing() {
    let state = AppState(RwLock::new(None));
    let g = install_session(&state, dataset(38), vec![]).unwrap();
    for r in chain_recipes() {
        run(&state, &r, false, Some(g)).unwrap();
    }
    let before = snapshot(&state);
    let err = run(&state, &Recipe::f("S1", "$S1 + 1"), true, Some(g)).unwrap_err();
    assert!(err.contains("cannot be built from itself"), "{err}");
    let err = run(&state, &Recipe::f("S1", "${s1} * 2"), true, Some(g)).unwrap_err();
    assert!(err.contains("cannot be built from itself"), "{err} (case variant)");
    let err = run(&state, &Recipe::op("S3", &["S3", "C"], serde_json::json!({ "mode": "multi", "multiOp": { "type": "sum" } })), true, Some(g)).unwrap_err();
    assert!(err.contains("cannot be built from itself"), "{err}");
    let err = run(&state, &Recipe::f("S1", "$A * 9"), true, Some(g + 1000)).unwrap_err();
    assert_eq!(err, STALE_SESSION_ERROR);
    // A recompute may never overwrite an imported column.
    let err = run(&state, &Recipe::f("A", "$B * 2"), true, Some(g)).unwrap_err();
    assert!(err.contains("imported"), "{err}");
    let after = snapshot(&state);
    for (i, h) in before.headers.iter().enumerate() {
        assert!(same_bits(&before.columns[i], &after.columns[i]), "{h} touched by a refused edit");
    }
}

/// Editing a sensor while a DIFFERENT dataset was loaded under the window
/// (generation moved on): the column of the new dataset must not be written.
#[test]
fn c09_edit_from_a_window_bound_to_the_previous_load_is_refused() {
    let state = AppState(RwLock::new(None));
    let g1 = install_session(&state, dataset(39), vec![]).unwrap();
    for r in chain_recipes() {
        run(&state, &r, false, Some(g1)).unwrap();
    }
    let g2 = install_session(&state, dataset(40), vec![]).unwrap();
    for r in chain_recipes() {
        run(&state, &r, true, Some(g2)).unwrap(); // the reopen replay
    }
    let before = snapshot(&state);
    assert_eq!(run(&state, &Recipe::f("S1", "$A"), true, Some(g1)).unwrap_err(), STALE_SESSION_ERROR);
    assert_eq!(remove_derived_in_state(&state, &strs(&["S2"]), Some(g1)).unwrap_err(), STALE_SESSION_ERROR);
    let after = snapshot(&state);
    for (i, h) in before.headers.iter().enumerate() {
        assert!(same_bits(&before.columns[i], &after.columns[i]), "{h}");
    }
}

// ===========================================================================
// D. Reopen: real CSV files, multi-file merge, Buddhist-Era years
// ===========================================================================

fn write_csv(dir: &std::path::Path, name: &str, body: &str) -> String {
    let p = dir.join(name);
    std::fs::write(&p, body).unwrap();
    p.to_string_lossy().into_owned()
}

/// Two files, BE years (incl. the BE leap day 2567-02-29 = CE 2024-02-29,
/// which is NOT a valid date if read as CE 2567), merged by timestamp; one
/// timestamp present in both files, sensors split across files.
fn be_files(dir: &std::path::Path) -> Vec<String> {
    let mut f1 = String::from("timestamp,A,B\n");
    let mut f2 = String::from("timestamp,C,Flow (m3/h)\n");
    let mut rng = Rng::new(77);
    for h in 0..48 {
        let day = 28 + h / 24; // 28, 29 Feb (BE 2567)
        let ts = format!("2567-02-{:02} {:02}:00:00", day, h % 24);
        let a = if h % 11 == 3 { String::new() } else { format!("{:.6}", rng.range(-50.0, 150.0)) };
        let b = format!("{:.6}", rng.range(-5.0, 5.0));
        f1.push_str(&format!("{ts},{a},{b}\n"));
        if h % 2 == 0 {
            let c = format!("{:.6}", rng.range(0.1, 10.0));
            let fl = if h % 9 == 0 { String::new() } else { format!("{:.6}", rng.range(0.0, 500.0)) };
            f2.push_str(&format!("{ts},{c},{fl}\n"));
        }
    }
    // A row only in file 2 (01 Mar BE 2567).
    f2.push_str("2567-03-01 00:00:00,5.0,250.0\n");
    vec![write_csv(dir, "part1.csv", &f1), write_csv(dir, "part2.csv", &f2)]
}

#[test]
fn d01_reopen_replay_on_real_merged_be_csvs_reproduces_the_edited_values_bit_for_bit() {
    let dir = tempfile::tempdir().unwrap();
    let paths = be_files(dir.path());

    // Session 1: load, create, EDIT.
    let state = AppState(RwLock::new(None));
    let g1 = install_session(&state, read_merge_csvs_with_report(paths.clone()).unwrap().data, paths.clone()).unwrap();
    with_data(&state, |d| {
        assert!(d.ts_parsed.iter().all(|&t| t != TS_MISSING), "every BE timestamp (incl. 29 Feb) parsed");
        assert_eq!(d.n_rows(), 49);
        assert!(d.timestamps.iter().any(|t| t.as_deref() == Some("2024-02-29 23:00:00")), "BE -> CE");
    });
    let mut recipes = chain_recipes();
    for r in &recipes {
        run(&state, r, false, Some(g1)).unwrap();
    }
    recipes[0] = Recipe::f("S1", "($A - ${Flow (m3/h)}) / ($C + 1)");
    for r in &recipes {
        run(&state, r, true, Some(g1)).unwrap();
    }
    let edited = snapshot(&state);
    let want = with_data(&state, |d| {
        let s1 = reference(&[col(d, "A"), col(d, "Flow (m3/h)"), col(d, "C")], &|v| (v[0] - v[1]) / (v[2] + 1.0));
        chain_reference(d, s1)
    });
    assert_everywhere(&state, &["S1", "S2", "S3", "S4"], &want, "edited, before reopen");

    // Hand-checked row: 2024-02-28 00:00 has A, B (file 1) and C, Flow (file 2).
    with_data(&state, |d| {
        let r = d.timestamps.iter().position(|t| t.as_deref() == Some("2024-02-28 00:00:00")).unwrap();
        let (a, f, c) = (col(d, "A")[r], col(d, "Flow (m3/h)")[r], col(d, "C")[r]);
        assert!(!a.is_nan() && !c.is_nan(), "merged row has data from both files");
        let s1 = col(d, "S1")[r];
        if f.is_nan() { assert!(s1.is_nan()) } else { assert!(close(s1, (a - f) / (c + 1.0), 1e-12)) }
        // A row that exists only in file 1 (odd hour): C/Flow missing -> S1 missing, S3 = mean(S1, C) missing.
        let r1 = d.timestamps.iter().position(|t| t.as_deref() == Some("2024-02-28 01:00:00")).unwrap();
        assert!(col(d, "S1")[r1].is_nan() && col(d, "S3")[r1].is_nan());
    });

    // Session 2 ("reopen"): a NEW load of the same files, recipes replayed in
    // stored order with replace: true (replaySpecialSensorRecipes).
    let g2 = install_session(&state, read_merge_csvs_with_report(paths.clone()).unwrap().data, paths).unwrap();
    assert!(g2 > g1);
    for r in &recipes {
        run(&state, r, true, Some(g2)).unwrap();
    }
    let reopened = snapshot(&state);
    assert_eq!(edited.headers, reopened.headers);
    for (i, h) in edited.headers.iter().enumerate() {
        assert!(same_bits(&edited.columns[i], &reopened.columns[i]), "{h} differs after reopen");
    }
    assert_everywhere(&state, &["S1", "S2", "S3", "S4"], &want, "after reopen");
}

// ===========================================================================
// E. Formula strings the FRONTEND builds (shared fixture with the TS side)
// ===========================================================================

const ENGINE_FIXTURE: &str = include_str!("../fixtures/special_sensor_formulas.json");

/// Reference implementations keyed by the fixture's `ref` field.
fn engine_ref(id: &str) -> Box<dyn Fn(&[f64]) -> f64> {
    match id {
        "abs_diff" => Box::new(|v| (v[0] - v[1]).abs()),
        "spread3" => Box::new(|v| v[0].max(v[1]).max(v[2]) - v[0].min(v[1]).min(v[2])),
        "efficiency" => Box::new(|v| v[1] / v[0] * 100.0), // output / input * 100, input = v[0]
        "chain_mixed" => Box::new(|v| v[0] - v[1] * v[2] / v[3]), // fasteval precedence
        "chain_plus" => Box::new(|v| v[0] + v[1]),
        "wrap_round2" => Box::new(|v| ((v[0] + v[1]) * 100.0).round() / 100.0),
        "wrap_round7" => Box::new(|v| ((v[0] + v[1]) * 1e7).round() / 1e7),
        "wrap_sqrt" => Box::new(|v| (v[0] + v[1]).sqrt()),
        "wrap_log10" => Box::new(|v| (v[0] - v[1]).abs().log10()),
        "wrap_exp" => Box::new(|v| (v[0] - v[1]).exp()),
        other => panic!("no reference for {other}"),
    }
}

#[test]
fn e01_every_formula_the_frontend_engine_builds_evaluates_to_the_intended_math() {
    let fx: serde_json::Value = serde_json::from_str(ENGINE_FIXTURE).unwrap();
    let data = dataset(51);
    for case in fx["cases"].as_array().unwrap() {
        let formula = case["expression"].as_str().unwrap();
        let sensors: Vec<String> = case["sensors"].as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect();
        let id = case["ref"].as_str().unwrap();
        let got = eval(&data, formula).unwrap_or_else(|e| panic!("{id}: {formula}: {e}"));
        let inputs: Vec<Vec<f64>> = sensors.iter().map(|s| col(&data, s)).collect();
        let f = engine_ref(id);
        let want = reference(&inputs, &*f);
        assert_col_eq(&got, &want, 1e-9, &format!("{id}: {formula}"));
    }
}

/// The "Round to N decimals" wrap emits `round(expr * 10^n) / 10^n`, which
/// stores the exact nearest double (1.13) — like the single-sensor "Round to
/// decimals" OPERATION (`(x * 100).round() / 100`). A `round(0.01, expr)` wrap
/// (fasteval = `(x / 0.01).round() * 0.01`) would store values like
/// 1.1300000000000001.
#[test]
fn e02_bug_round_wrap_stores_the_nearest_double_to_the_decimal_value() {
    let data = ColumnarData::from_parts(
        strs(&["timestamp", "A", "B"]),
        vec![Some("2024-01-01T00:00:00".into())],
        vec![vec![NAN], vec![1.0], vec![0.13]],
    );
    let got = eval(&data, "round(($A + $B) * 100) / 100").unwrap();
    assert_eq!(got[0], 1.13, "got {:?}", got[0]);
}
