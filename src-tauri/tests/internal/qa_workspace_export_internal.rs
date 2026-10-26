//! QA: Export results end to end (2026-10-20, `workspace_export.rs`,
//! `docs/specs/WIZARD_OUTPUT_SPEC.md` v1.0).
//!
//! The per-rule unit tests live next to the code. This file is the cross-zone
//! check: the request comes from `tests/fixtures/export_request_contract.json`,
//! which the TS side generates with the REAL request builder
//! (`src/__tests__/ExportResultsContract.integration.test.ts` pins it), the
//! data goes through the REAL CSV loader, the export goes through the public
//! `write_export`, and every spec §7 checklist item is then checked by reading
//! the written folder back — independently of the plan the writer used.
//!
//! Included from `lib.rs` with a `#[path]` line (like the other files in
//! `tests/internal/`), so it can reach the crate-private session types.

use crate::workspace_export::{plan_in, write_export, WorkspaceExportRequest};
use crate::{AppState, SessionData};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::RwLock;

const CONTRACT: &str = include_str!("../fixtures/export_request_contract.json");

const N: usize = 24;
/// Row whose time text cannot be read (kept by the loader as TS_MISSING).
const NO_TS: usize = 10;
/// Row whose timestamp repeats the one of row `DUP - 1`.
const DUP: usize = 12;

// ---------------------------------------------------------------------------
// The fixture data (raw arrays, so the expectations below are computed
// independently of the export code)
// ---------------------------------------------------------------------------

struct Raw {
    slot: Vec<Option<usize>>,
    speed: Vec<f64>,
    t1: Vec<f64>,
    p1: Vec<f64>,
    v: Vec<f64>,
    i: Vec<f64>,
    power: Vec<f64>,
    x: Vec<f64>,
    y: Vec<f64>,
    c: Vec<f64>,
}

fn raw() -> Raw {
    let slot = (0..N)
        .map(|r| match r {
            NO_TS => None,
            DUP => Some(DUP - 1),
            _ => Some(r),
        })
        .collect();
    let speed = (0..N).map(|r| match r { 3 | 4 => 0.0, 5 => 500.0, _ => 1500.0 }).collect();
    let t1 = (0..N).map(|r| if r == 7 { f64::NAN } else { 25.0 + r as f64 * 0.5 }).collect();
    let p1 = (0..N).map(|r| if r == 5 { 60.0 } else { 40.0 + r as f64 }).collect();
    let v: Vec<f64> = (0..N).map(|r| 10.0 + r as f64).collect();
    let i = vec![2.0; N];
    let power = v.iter().map(|x| x * 2.0).collect();
    let x = (0..N).map(|r| 100.0 + r as f64).collect();
    let y = (0..N).map(|r| 50.0 + 2.0 * r as f64).collect();
    // criteria 0,1,2,3,…: 2 sits ON the inner boundary (belongs to the lower
    // range: `from < value <= to`).
    let c = (0..N).map(|r| (r % 4) as f64).collect();
    Raw { slot, speed, t1, p1, v, i, power, x, y, c }
}

/// `2024-01-09 22:00:00` + 5 min per slot (24 slots stay on the same day).
fn slot_text(s: usize, sep: char) -> String {
    let m = 22 * 60 + s * 5;
    format!("2024-01-09{sep}{:02}:{:02}:00", m / 60, m % 60)
}

fn cell(v: f64) -> String {
    if v.is_nan() { String::new() } else { format!("{v}") }
}

fn csv_body(d: &Raw) -> String {
    let mut s = String::from("timestamp,SPEED,T1,P1,V,I,POWER,X,Y,C\n");
    for r in 0..N {
        // An unreadable time text keeps the row (TS_MISSING); an EMPTY one is
        // dropped by the loader already, so it would never reach the export.
        let ts = d.slot[r].map(|k| slot_text(k, ' ')).unwrap_or_else(|| "n/a".into());
        let vals = [d.speed[r], d.t1[r], d.p1[r], d.v[r], d.i[r], d.power[r], d.x[r], d.y[r], d.c[r]];
        s.push_str(&ts);
        for v in vals {
            s.push(',');
            s.push_str(&cell(v));
        }
        s.push('\n');
    }
    s
}

/// The rows the spec says a model's CSV holds: the selected rows, without the
/// ones that have no timestamp, sorted by time, the LAST row of a repeated
/// instant kept.
fn spec_rows(d: &Raw, keep: impl Fn(usize) -> bool) -> Vec<usize> {
    let mut by_slot: BTreeMap<usize, usize> = BTreeMap::new();
    for r in 0..N {
        if let (true, Some(s)) = (keep(r), d.slot[r]) {
            by_slot.insert(s, r); // later row wins
        }
    }
    by_slot.into_values().collect()
}

fn expected_csv(d: &Raw, header: &str, rows: &[usize], cols: &[&Vec<f64>]) -> String {
    let mut s = format!("{header}\n");
    for &r in rows {
        s.push_str(&format!("{}+07:00", slot_text(d.slot[r].unwrap(), 'T')));
        for c in cols {
            s.push(',');
            s.push_str(&format!("{}", c[r]));
        }
        s.push('\n');
    }
    s
}

fn load_state(generation: u64) -> (AppState, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sensors.csv");
    std::fs::write(&path, csv_body(&raw())).unwrap();
    let merged = crate::csv_processor::read_merge_csvs_with_report(vec![path.to_string_lossy().into_owned()]).unwrap();
    let state = AppState(RwLock::new(Some(SessionData {
        data: merged.data,
        paths: vec![],
        // POWER is a special sensor computed in this session (name_key form).
        derived: HashSet::from(["power".to_string()]),
        generation,
        rel_cache: Default::default(),
    })));
    (state, dir)
}

fn contract() -> WorkspaceExportRequest {
    serde_json::from_str(CONTRACT).expect("the TS request fixture deserializes into the Rust request")
}

// ---------------------------------------------------------------------------
// Readers for the written folder
// ---------------------------------------------------------------------------

/// The keys of a JSON object's top level, in file order (serde_json's map is
/// sorted, so the order is read from the text).
fn top_keys(text: &str) -> Vec<String> {
    let b = text.as_bytes();
    let (mut depth, mut i, mut keys) = (0i32, 0usize, Vec::new());
    while i < b.len() {
        match b[i] {
            b'{' | b'[' => depth += 1,
            b'}' | b']' => depth -= 1,
            b'"' => {
                let start = i + 1;
                i += 1;
                while b[i] != b'"' {
                    if b[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
                let s = &text[start..i];
                let mut j = i + 1;
                while b[j] == b' ' {
                    j += 1;
                }
                if depth == 1 && b[j] == b':' {
                    keys.push(s.to_string());
                }
            }
            _ => {}
        }
        i += 1;
    }
    keys
}

/// Top-level keys of the object found at `"<key>": {` (first occurrence).
fn keys_of(text: &str, key: &str) -> Vec<String> {
    let at = text.find(&format!("\"{key}\": {{")).unwrap_or_else(|| panic!("no object {key}"));
    object_keys_from(text, at)
}

/// Top-level keys of the FIRST object inside the array at `"<key>": [`.
fn first_item_keys(text: &str, key: &str) -> Vec<String> {
    let at = text.find(&format!("\"{key}\": [")).unwrap_or_else(|| panic!("no array {key}"));
    object_keys_from(text, at)
}

/// Top-level keys of the first `{…}` object starting at or after `at`.
fn object_keys_from(text: &str, at: usize) -> Vec<String> {
    let open = at + text[at..].find('{').unwrap();
    let mut depth = 0;
    let mut end = open;
    for (k, ch) in text[open..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    end = open + k;
                    break;
                }
            }
            _ => {}
        }
    }
    top_keys(&text[open..=end])
}

fn listing(dir: &Path) -> BTreeSet<String> {
    std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect()
}

fn read_json(p: &Path) -> (String, serde_json::Value) {
    let text = std::fs::read_to_string(p).unwrap();
    let v = serde_json::from_str(&text).unwrap();
    (text, v)
}

fn all_keys(v: &serde_json::Value, out: &mut Vec<String>) {
    match v {
        serde_json::Value::Object(m) => {
            for (k, x) in m {
                out.push(k.clone());
                all_keys(x, out);
            }
        }
        serde_json::Value::Array(a) => a.iter().for_each(|x| all_keys(x, out)),
        _ => {}
    }
}

fn all_strings(v: &serde_json::Value, out: &mut Vec<String>) {
    match v {
        serde_json::Value::String(s) => out.push(s.clone()),
        serde_json::Value::Object(m) => m.values().for_each(|x| all_strings(x, out)),
        serde_json::Value::Array(a) => a.iter().for_each(|x| all_strings(x, out)),
        _ => {}
    }
}

fn strs(v: &serde_json::Value) -> Vec<String> {
    v.as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect()
}

/// Spec §6 words that must never be a key, a file name or a column (checked
/// per `_`/`-`/`.` token, plus method/library names as substrings).
fn forbidden(name: &str) -> bool {
    let low = name.to_lowercase();
    const SUBSTR: [&str; 7] = ["gam", "gmm", "pkl", "joblib", "lambda", "rmse", "pickle"];
    const TOKENS: [&str; 14] = [
        "mean", "sd", "std", "sigma", "r2", "center", "centre", "angle", "score", "residual", "predicted", "prediction", "stiffness", "fitted",
    ];
    SUBSTR.iter().any(|w| low.contains(w)) || low.split(['_', '-', '.']).any(|t| TOKENS.contains(&t))
}

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

#[test]
fn qa_workspace_export_contract_fixture_exports_a_spec_compliant_folder() {
    let d = raw();
    let (state, _data_dir) = load_state(1);
    let req = contract();
    assert_eq!(req.models.len(), 4);

    // Dry run: the TS request is complete for Rust — no error issue at all.
    let plan = plan_in(&state, &req).unwrap();
    let errors: Vec<_> = plan.issues.iter().filter(|i| i.severity == "error").collect();
    assert!(errors.is_empty(), "the ready TS request must plan without errors: {errors:?}");
    assert!(plan.ok);
    assert_eq!(plan.files, 9);

    let out = tempfile::tempdir().unwrap();
    let progress = std::sync::Mutex::new(Vec::new());
    let res = write_export(&state, &req, out.path().to_str().unwrap(), "Yadana_MP_Train_2026-10-20_1000", &AtomicBool::new(false), |w, t, k| {
        progress.lock().unwrap().push((w, t, k.to_string()))
    })
    .unwrap();
    let root = Path::new(&res.folder).to_path_buf();
    assert_eq!(listing(out.path()), BTreeSet::from(["Yadana_MP_Train_2026-10-20_1000".to_string()]), "no staging folder left behind");
    assert_eq!(listing(&root), BTreeSet::from(["machine_info.json".to_string(), "models".to_string()]));
    assert_eq!((res.files, res.models), (9, 4));
    assert_eq!(res.rows, plan.total_rows);

    // Model keys: Workbench order, R/I = target, C = y_sensor (spec §2.1), counter per tag+kind.
    let keys: Vec<String> = progress.lock().unwrap().iter().map(|(_, _, k)| k.clone()).collect();
    assert_eq!(keys, ["T1-I1", "T1-R1", "Y-C1", "POWER-I1"]);

    // ── §7.1 machine_info.json exists, every required field filled, spec order ──
    let (mi_text, mi) = read_json(&root.join("machine_info.json"));
    assert_eq!(
        top_keys(&mi_text),
        ["schema_version", "exported_at", "plant", "machine", "running_status", "components", "sensors", "derived_sensors", "failure_groups"]
    );
    assert_eq!(keys_of(&mi_text, "machine"), ["tag", "name", "notes"]);
    assert_eq!(keys_of(&mi_text, "running_status"), ["sensor", "stop_if_lower_than"]);
    assert_eq!(mi["schema_version"], "1.0");
    let exported_at = mi["exported_at"].as_str().unwrap();
    assert_eq!(exported_at, res.exported_at);
    let b = exported_at.as_bytes();
    assert!(exported_at.len() == 25 && b[10] == b'T' && (b[19] == b'+' || b[19] == b'-') && b[22] == b':', "ISO 8601 with offset: {exported_at}");
    assert_eq!(mi["plant"], "Yadana");
    assert_eq!(mi["machine"], serde_json::json!({ "tag": "U-2010", "name": "MP Train", "notes": "Gas turbine" }));
    assert_eq!(mi["running_status"], serde_json::json!({ "sensor": "SPEED", "stop_if_lower_than": 100.0 }));
    let components = strs(&mi["components"]);
    assert_eq!(components, ["Electrical", "Engine", "Generator", "Pump"], "unique, sorted, at least one");

    let sensors = mi["sensors"].as_array().unwrap();
    let raw_tags: Vec<String> = sensors.iter().map(|s| s["tag"].as_str().unwrap().to_string()).collect();
    assert_eq!(raw_tags.iter().collect::<HashSet<_>>().len(), raw_tags.len(), "raw tags unique");
    assert_eq!(
        raw_tags.iter().cloned().collect::<BTreeSet<_>>(),
        ["C", "I", "P1", "SPEED", "T1", "V", "X", "Y"].iter().map(|s| s.to_string()).collect(),
        "raw tags used by models + the running-status sensor + the raw sources of the special sensor"
    );
    for s in sensors {
        assert_eq!(s.as_object().unwrap().len(), 5);
        assert!(!s["name"].as_str().unwrap().is_empty());
        assert_eq!(s["description"], "");
        assert!(s["unit"].is_string());
    }
    let t1 = sensors.iter().find(|s| s["tag"] == "T1").unwrap();
    assert_eq!(*t1, serde_json::json!({ "tag": "T1", "name": "Bearing temp", "description": "", "unit": "DegC", "component": "Engine" }));
    let derived = mi["derived_sensors"].as_array().unwrap();
    assert_eq!(derived.len(), 1);
    assert_eq!(derived[0]["tag"], "POWER");
    assert_eq!(derived[0]["name"], "Power");
    assert_eq!(derived[0]["unit"], "W");
    assert_eq!(derived[0]["component"], "Electrical");
    assert_eq!(derived[0]["how_to_build"], "Calculated as V × I");
    assert!(!raw_tags.contains(&"POWER".to_string()), "a derived tag never collides with a raw tag");

    // ── §7.2 every model has .json + .csv, key == file stem ──
    let models_dir = root.join("models");
    let expected_files: BTreeSet<String> = keys.iter().flat_map(|k| [format!("{k}.json"), format!("{k}.csv")]).collect();
    assert_eq!(listing(&models_dir), expected_files);
    let mut model_json: BTreeMap<String, (String, serde_json::Value)> = BTreeMap::new();
    for k in &keys {
        let (text, v) = read_json(&models_dir.join(format!("{k}.json")));
        assert_eq!(v["schema_version"], "1.0");
        assert_eq!(v["model_key"], k.as_str());
        assert_eq!(v["training_data"]["file"], format!("{k}.csv"));
        assert_eq!(keys_of(&text, "training_data"), ["file", "note"]);
        assert!(!v["training_data"]["note"].as_str().unwrap().is_empty());
        model_json.insert(k.clone(), (text, v));
    }

    // Per kind: fields and their order (spec §4).
    let (r_text, r) = &model_json["T1-R1"];
    assert_eq!(
        top_keys(r_text),
        ["schema_version", "model_key", "kind", "display_name", "category", "component", "output", "inputs", "fit_profile", "health", "training_data"]
    );
    assert_eq!(keys_of(r_text, "health"), ["warning", "failure"]);
    assert_eq!(r["kind"], "relationship");
    assert_eq!(r["display_name"], "Bearing vs load");
    assert_eq!(r["category"], "CONDITION");
    assert_eq!(r["component"], "Engine");
    assert_eq!(r["output"], "T1");
    assert_eq!(strs(&r["inputs"]), ["P1", "POWER"]);
    assert_eq!(r["fit_profile"], "standard", "the profile NAME, never the number");

    let (i_text, i) = &model_json["T1-I1"];
    assert_eq!(top_keys(i_text), ["schema_version", "model_key", "kind", "display_name", "category", "component", "sensor", "health", "training_data"]);
    assert_eq!(keys_of(i_text, "health"), ["limits"]);
    assert_eq!(i["kind"], "individual");
    assert_eq!(i["sensor"], "T1");
    assert_eq!(i["health"]["limits"], serde_json::json!({ "low": 20.0, "high": 35.0 }));
    assert_eq!(model_json["POWER-I1"].1["component"], "Electrical");
    assert_eq!(model_json["POWER-I1"].1["category"], "PERFORMANCE");

    let (c_text, c) = &model_json["Y-C1"];
    assert_eq!(
        top_keys(c_text),
        ["schema_version", "model_key", "kind", "display_name", "category", "component", "x_sensor", "y_sensor", "criteria_sensor", "regimes", "health", "training_data"]
    );
    assert_eq!(c["kind"], "clustering");
    assert_eq!((c["x_sensor"].as_str(), c["y_sensor"].as_str(), c["criteria_sensor"].as_str()), (Some("X"), Some("Y"), Some("C")));
    assert_eq!(c["component"], "Pump", "component of the KEY sensor (x_sensor)");
    // Ordered, contiguous, outer edges open; a value belongs where `from < value <= to`.
    assert_eq!(c["regimes"], serde_json::json!([{ "from": null, "to": 2.0 }, { "from": 2.0, "to": null }]));
    assert_eq!(c["health"], serde_json::json!({ "failure_distance": 5.0 }));

    // ── §7.3 every referenced tag is listed; §7.4 every component reference is in components ──
    let listed: HashSet<String> = raw_tags.iter().cloned().chain(derived.iter().map(|x| x["tag"].as_str().unwrap().to_string())).collect();
    let mut referenced = vec![mi["running_status"]["sensor"].as_str().unwrap().to_string()];
    for (_, v) in model_json.values() {
        for f in ["output", "sensor", "x_sensor", "y_sensor", "criteria_sensor"] {
            if let Some(t) = v[f].as_str() {
                referenced.push(t.to_string());
            }
        }
        if v["inputs"].is_array() {
            referenced.extend(strs(&v["inputs"]));
        }
        assert!(components.contains(&v["component"].as_str().unwrap().to_string()));
    }
    for t in &referenced {
        assert!(listed.contains(t), "{t} is referenced but not listed in sensors / derived_sensors");
    }
    for s in sensors.iter().chain(derived.iter()) {
        assert!(components.contains(&s["component"].as_str().unwrap().to_string()), "{s}");
    }

    // ── §7.5 failure groups: only groups with an exported model; keys exist ──
    let fgs = mi["failure_groups"].as_array().unwrap();
    let fg_names: Vec<&str> = fgs.iter().map(|g| g["name"].as_str().unwrap()).collect();
    assert_eq!(fg_names, ["Overheat", "Pump wear"], "the unused group is left out");
    assert_eq!(strs(&fgs[0]["models"]), ["T1-I1", "T1-R1"]);
    assert_eq!(strs(&fgs[1]["models"]), ["T1-R1", "Y-C1"]);
    assert_eq!(first_item_keys(&mi_text, "failure_groups"), ["name", "description", "recommendation", "models"]);
    assert_eq!(first_item_keys(&mi_text, "sensors"), ["tag", "name", "description", "unit", "component"]);
    assert_eq!(first_item_keys(&mi_text, "derived_sensors"), ["tag", "name", "unit", "component", "how_to_build"]);
    for g in fgs {
        assert!(!g["description"].as_str().unwrap().is_empty() && !g["recommendation"].as_str().unwrap().is_empty());
        for k in strs(&g["models"]) {
            assert!(keys.contains(&k), "failure group lists unknown model {k}");
        }
    }

    // ── §7.6 health ordering ──
    let w = &r["health"]["warning"];
    let f = &r["health"]["failure"];
    let n = |v: &serde_json::Value| v.as_f64().unwrap();
    assert!(n(&f["low"]) < n(&w["low"]) && n(&w["low"]) < 0.0 && 0.0 < n(&w["high"]) && n(&w["high"]) < n(&f["high"]));
    assert_eq!((n(&w["low"]), n(&w["high"]), n(&f["low"]), n(&f["high"])), (-4.0, 4.0, -8.0, 8.0));
    for k in ["T1-I1", "POWER-I1"] {
        let l = &model_json[k].1["health"]["limits"];
        assert!(n(&l["low"]) < n(&l["high"]));
    }
    assert!(n(&c["health"]["failure_distance"]) > 3.0);

    // ── §5 training CSVs: exactly the rows Train used, spec columns, ISO time with offset ──
    let ws_scope = |r: usize| d.speed[r] > 100.0; // SPEED > 100 inside the workspace period (all rows)
    let ind_rows = spec_rows(&d, |r| ws_scope(r) && d.t1[r].is_finite());
    let rel_rows = spec_rows(&d, |r| {
        let in_period = d.slot[r].is_some_and(|s| s >= 6); // own period from 22:30
        in_period && (d.p1[r] < 50.0 || d.speed[r] > 1000.0) && d.t1[r].is_finite()
    });
    // ranges (-inf, 2] and (2, +inf): every finite criteria value is in one
    let clu_rows = spec_rows(&d, |r| ws_scope(r) && (d.c[r] <= 2.0 || 2.0 < d.c[r]));
    let pow_rows = spec_rows(&d, ws_scope);
    let expected = [
        ("T1-I1", expected_csv(&d, "TimeStamp,T1", &ind_rows, &[&d.t1])),
        ("T1-R1", expected_csv(&d, "TimeStamp,P1,POWER,T1", &rel_rows, &[&d.p1, &d.power, &d.t1])),
        ("Y-C1", expected_csv(&d, "TimeStamp,X,Y,C", &clu_rows, &[&d.x, &d.y, &d.c])),
        ("POWER-I1", expected_csv(&d, "TimeStamp,POWER", &pow_rows, &[&d.power])),
    ];
    for (k, want) in &expected {
        let got = std::fs::read_to_string(models_dir.join(format!("{k}.csv"))).unwrap().replace("\r\n", "\n");
        assert_eq!(&got, want, "{k}.csv");
        // sorted ascending, no repeated timestamp
        let stamps: Vec<&str> = got.lines().skip(1).map(|l| l.split(',').next().unwrap()).collect();
        assert!(stamps.windows(2).all(|p| p[0] < p[1]), "{k}: sorted, unique");
        assert!(stamps.iter().all(|s| s.ends_with("+07:00")));
    }
    assert_eq!(res.rows, ind_rows.len() + rel_rows.len() + clu_rows.len() + pow_rows.len());
    // The edge cases really are in the data: the row without a time and the
    // repeated instant were dropped; a criteria value ON the inner boundary
    // (2) is written.
    assert!(!ind_rows.contains(&NO_TS) && ind_rows.contains(&DUP) && !ind_rows.contains(&(DUP - 1)));
    let clu_csv = &expected[2].1;
    assert!(clu_csv.lines().skip(1).any(|l| l.ends_with(",2")), "criteria == inner boundary is included");
    // Every model here has a train period, so the training scope itself
    // already leaves the row without a timestamp out (a period can only keep a
    // row that has a time); the "rows without a timestamp" note can only count
    // rows of a scope with no time limit. Either way it is not in any CSV.
    assert_eq!(plan.rows_without_timestamp, 0);
    // The loader already merges a repeated timestamp (later row wins), so the
    // export's own "repeated instants" counter sees none here; the CSV holds
    // the LATER row's values (checked by the exact CSV comparison above).
    assert_eq!(plan.duplicate_instants_dropped, 0);

    // ── §7.7 / §6 nothing trained, no internal names ──
    for name in listing(&models_dir).iter().chain(listing(&root).iter()) {
        assert!(name == "models" || name.ends_with(".json") || name.ends_with(".csv"), "unexpected file {name}");
        assert!(!forbidden(name), "file name {name}");
    }
    let mut every_key = Vec::new();
    let mut every_string = Vec::new();
    all_keys(&mi, &mut every_key);
    all_strings(&mi, &mut every_string);
    for (_, v) in model_json.values() {
        all_keys(v, &mut every_key);
        all_strings(v, &mut every_string);
    }
    for k in &every_key {
        assert!(!forbidden(k), "key {k}");
    }
    for (k, _) in &expected {
        let csv = std::fs::read_to_string(models_dir.join(format!("{k}.csv"))).unwrap();
        for col in csv.lines().next().unwrap().split(',') {
            assert!(!forbidden(col), "column {col} in {k}.csv");
        }
    }
    for s in &every_string {
        assert!(!s.contains("['") && !s.contains("{'"), "a Python repr in {s}");
        assert!(!s.to_lowercase().contains("lineargam"), "method name in {s}");
    }
    let all_text = format!("{mi_text}{}", model_json.values().map(|(t, _)| t.as_str()).collect::<String>());
    assert!(!all_text.contains("100000"), "the stiffness number never leaves the Wizard");
}

#[test]
fn qa_workspace_export_contract_fixture_on_a_stale_session_writes_nothing() {
    // The request was built for generation 1; another dataset was loaded since.
    let (state, _d) = load_state(2);
    let out = tempfile::tempdir().unwrap();
    let err = write_export(&state, &contract(), out.path().to_str().unwrap(), "Out", &AtomicBool::new(false), |_, _, _| {}).unwrap_err();
    assert!(err.starts_with("STALE_SESSION"), "{err}");
    assert!(listing(out.path()).is_empty());
}

#[test]
fn qa_workspace_export_unfinished_model_blocks_the_whole_export() {
    // One model loses its set points (the UI would show it as not Complete):
    // the dry run names that model, the export refuses with NOT_READY and
    // writes nothing.
    let (state, _d) = load_state(1);
    let mut req = contract();
    req.models[1].set_points = Default::default();
    let plan = plan_in(&state, &req).unwrap();
    assert!(!plan.ok);
    assert!(plan.issues.iter().any(|i| i.severity == "error" && i.model_id.as_deref() == Some("r1")), "{:?}", plan.issues);
    let out = tempfile::tempdir().unwrap();
    let err = write_export(&state, &req, out.path().to_str().unwrap(), "Out", &AtomicBool::new(false), |_, _, _| {}).unwrap_err();
    assert!(err.starts_with("NOT_READY"), "{err}");
    assert!(listing(out.path()).is_empty());
}

#[test]
fn qa_workspace_export_auto_divided_ranges_export() {
    // What BuildModelWindow's auto-divide writes for criteria 0..3 and 2
    // clusters: [{min: 0, max: 1.5}, {min: 1.5, max: 3}].
    let (state, _d) = load_state(1);
    let mut req = contract();
    let c1 = req.models.iter_mut().find(|m| m.id == "c1").unwrap();
    c1.cluster_ranges = Some(vec![
        crate::ClusterRange { min: Some(0.0), max: Some(1.5) },
        crate::ClusterRange { min: Some(1.5), max: Some(3.0) },
    ]);
    let plan = plan_in(&state, &req).unwrap();
    assert!(!plan.issues.iter().any(|i| i.code == "regimes_not_contiguous"), "{:?}", plan.issues);
    let m = plan.models.iter().find(|m| m.id == "c1").unwrap();
    let json = serde_json::to_value(&m.json).unwrap();
    assert_eq!(json["regimes"], serde_json::json!([{ "from": null, "to": 1.5 }, { "from": 1.5, "to": null }]));
    // The open outer edges keep every row: C == 0 (the data minimum, the
    // stored finite `min`) is in the first cluster, so the CSV holds the same
    // rows as the contract's own null-edged ranges.
    let open = plan_in(&state, &contract()).unwrap();
    let open_rows = open.models.iter().find(|m| m.id == "c1").unwrap().rows;
    assert_eq!(m.rows, open_rows);
    let d = raw();
    assert!(open_rows > 0 && (0..N).any(|r| d.c[r] == 0.0));
}
