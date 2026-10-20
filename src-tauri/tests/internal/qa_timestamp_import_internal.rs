//! QA: timestamp import edge cases (handover 2026-10-16..19, csv_processor.rs
//! `normalize_file_timestamps`). The per-shape unit tests live next to the
//! code; these go through the WHOLE load path (CSV file on disk ->
//! `read_merge_csvs_with_report` -> `from_parts` -> `build_load_report`), so
//! they also check what the merge, the Buddhist-Era pass and the report make
//! of the rewritten text.

use crate::csv_processor::{
    apply_mapping, build_load_report, load_mapping_csv_data, load_metadata,
    normalize_file_timestamps, parse_timestamp, read_merge_csvs_with_report, ts_to_micros,
    CsvLoadReport, MergeResult, TS_MISSING,
};

fn write_csv(dir: &tempfile::TempDir, name: &str, body: &str) -> String {
    let p = dir.path().join(name);
    std::fs::write(&p, body).unwrap();
    p.to_string_lossy().into_owned()
}

/// Load the given (name, body) files as one dataset.
fn load(files: &[(&str, &str)]) -> (MergeResult, CsvLoadReport) {
    let dir = tempfile::tempdir().unwrap();
    let paths = files.iter().map(|(n, b)| write_csv(&dir, n, b)).collect();
    let m = read_merge_csvs_with_report(paths).unwrap();
    let r = build_load_report(&m);
    (m, r)
}

/// A one-column file `timestamp,A` with one row per given timestamp.
fn file_of(ts: &[&str]) -> String {
    let mut s = String::from("timestamp,A\n");
    for (i, t) in ts.iter().enumerate() {
        // Quote: a few shapes carry a comma (`Fri, 31 Jan 2025 …`).
        s.push_str(&format!("\"{t}\",{i}\n"));
    }
    s
}

fn texts(m: &MergeResult) -> Vec<String> {
    m.data.timestamps.iter().map(|t| t.clone().unwrap_or_default()).collect()
}

fn micros(s: &str) -> i64 {
    ts_to_micros(parse_timestamp(s).unwrap())
}

fn unreadable_line(r: &CsvLoadReport) -> Option<&String> {
    r.warnings.iter().find(|w| w.contains("could not be read as a date and time"))
}

/// Run one file's column through the per-file rewrite only.
fn rewrite(raw: &[&str]) -> (Vec<String>, Vec<String>) {
    let mut ts: Vec<Option<String>> = raw.iter().map(|s| Some(s.to_string())).collect();
    let w = normalize_file_timestamps("f.csv", &mut ts);
    (ts.into_iter().map(|t| t.unwrap()).collect(), w)
}

// ── Leap days ──────────────────────────────────────────────────────────────

#[test]
fn a_buddhist_era_leap_day_written_day_first_loads_as_29_feb_2024() {
    // BE 2567 = CE 2024 (leap); BE 2568 = CE 2025 (not leap).
    let (m, r) = load(&[("be.csv", &file_of(&["28/2/2567 0:00", "29/2/2567 0:00", "1/3/2567 0:00"]))]);
    assert_eq!(texts(&m), vec!["2024-02-28 00:00:00", "2024-02-29 00:00:00", "2024-03-01 00:00:00"]);
    assert_eq!(m.data.ts_parsed[1], micros("2024-02-29 00:00:00"));
    assert!(r.warnings[0].starts_with("Dates in be.csv read as day/month/year"), "{:?}", r.warnings);
    assert!(r.warnings.iter().any(|w| w.contains("Buddhist-Era")), "{:?}", r.warnings);
    assert!(unreadable_line(&r).is_none(), "{:?}", r.warnings);
}

#[test]
fn a_29_feb_in_a_non_leap_year_is_unreadable_and_counted_in_every_shape() {
    for (shape, rows) in [
        ("BE day-first", vec!["28/2/2568 0:00", "29/2/2568 0:00"]),
        ("CE month-first", vec!["2/28/2025 0:00", "2/29/2025 0:00"]),
        ("month name", vec!["28-Feb-25 0:00", "29-Feb-25 0:00"]),
        ("year first", vec!["2025/02/28 00:00", "2025/02/29 00:00"]),
    ] {
        let (m, r) = load(&[("x.csv", &file_of(&rows))]);
        let missing = m.data.ts_parsed.iter().filter(|&&t| t == TS_MISSING).count();
        assert_eq!(missing, 1, "{shape}: {:?}", texts(&m));
        assert_eq!(
            unreadable_line(&r).map(String::as_str),
            Some("1 timestamp(s) in x.csv could not be read as a date and time"),
            "{shape}: {:?}",
            r.warnings
        );
    }
}

#[test]
fn leap_days_in_ce_shapes_and_an_excel_serial() {
    // 45351 = 2024-02-29 (45658 = 2025-01-01, 307 days later).
    for rows in [
        vec!["2/29/2024 13:05"],
        vec!["29.02.2024 13:05"],
        vec!["29-Feb-2024 1:05 PM"],
        vec!["20240229130500"],
    ] {
        let (m, _) = load(&[("x.csv", &file_of(&rows))]);
        assert_eq!(texts(&m), vec!["2024-02-29 13:05:00"], "{rows:?}");
    }
    let (m, _) = load(&[("x.csv", &file_of(&["45351", "45351.5"]))]);
    assert_eq!(texts(&m), vec!["2024-02-29 00:00:00", "2024-02-29 12:00:00"]);
}

#[test]
fn excel_serials_outside_the_accepted_range_are_unreadable_not_read_as_1900() {
    // Serial 60 is Excel's fictitious 1900-02-29; 61 = 1900-03-01. The reader
    // only takes 20000..=80000 (1954..2119), so tiny serials are never dates.
    let (m, r) = load(&[("x.csv", &file_of(&["60", "61"]))]);
    assert!(m.data.ts_parsed.iter().all(|&t| t == TS_MISSING), "{:?}", texts(&m));
    assert_eq!(
        unreadable_line(&r).map(String::as_str),
        Some("2 timestamp(s) in x.csv could not be read as a date and time")
    );
    assert!(!r.warnings.iter().any(|w| w.contains("Excel serial")), "{:?}", r.warnings);
}

// ── 12-hour clock and midnight ─────────────────────────────────────────────

#[test]
fn a_12_hour_log_crossing_midnight_reads_month_day_in_order() {
    // Every value <= 12: month/day keeps 5-minute steps, day/month would jump a month.
    let (m, r) = load(&[(
        "us.csv",
        &file_of(&["1/1/2026 11:55 PM", "1/2/2026 12:00 AM", "1/2/2026 12:05 AM", "1/2/2026 12:00 PM"]),
    )]);
    assert_eq!(
        texts(&m),
        vec!["2026-01-01 23:55:00", "2026-01-02 00:00:00", "2026-01-02 00:05:00", "2026-01-02 12:00:00"]
    );
    assert!(m.data.ts_parsed.windows(2).all(|w| w[0] < w[1]));
    assert_eq!(r.warnings, vec!["Dates in us.csv read as month/day/year (1/2/2026 → 2026-01-02)"]);
}

#[test]
fn a_day_first_12_hour_log_crossing_new_year() {
    let (m, r) = load(&[("eu.csv", &file_of(&["31/12/2025 11:55 PM", "1/1/2026 12:00 AM", "1/1/2026 12:05 AM"]))]);
    assert_eq!(texts(&m), vec!["2025-12-31 23:55:00", "2026-01-01 00:00:00", "2026-01-01 00:05:00"]);
    assert_eq!(r.interval_seconds, Some(300.0));
    assert!(r.warnings[0].starts_with("Dates in eu.csv read as day/month/year (31/12/2025 → 2025-12-31)"));
}

#[test]
fn twenty_four_o_clock_and_minute_60_are_unreadable() {
    let (_, w) = rewrite(&["1/13/2026 24:00", "1/13/2026 23:60", "1/13/2026 23:59:60", "1/13/2026 0:00"]);
    assert_eq!(w.last().unwrap(), "3 timestamp(s) in f.csv could not be read as a date and time");
}

// ── Day/month decision ─────────────────────────────────────────────────────

#[test]
fn identical_gaps_under_both_readings_is_a_flagged_guess() {
    // Same day, 5-minute steps: both readings give 0 backwards steps and the
    // same total travel -> month/day, with the "check the dates" note.
    let (t, w) = rewrite(&["1/2/2026 0:00", "1/2/2026 0:05", "1/2/2026 0:10"]);
    assert_eq!(t, vec!["2026-01-02 00:00:00", "2026-01-02 00:05:00", "2026-01-02 00:10:00"]);
    assert_eq!(
        w,
        vec!["Dates in f.csv read as month/day/year (1/2/2026 → 2026-01-02) — could not be told apart from the values; check the dates"]
    );
}

#[test]
fn twelve_days_of_day_first_data_all_values_12_or_less_read_day_first() {
    // 1..12 Jan, hourly, written D/M/YYYY. Neither reading steps backwards;
    // month/day would spread the rows over a year, so the smaller travel wins.
    let mut rows = Vec::new();
    for d in 1..=12 {
        for h in 0..24 {
            rows.push(format!("{d}/1/2026 {h}:00"));
        }
    }
    let refs: Vec<&str> = rows.iter().map(String::as_str).collect();
    let (m, r) = load(&[("eu.csv", &file_of(&refs))]);
    assert_eq!(m.data.n_rows(), 12 * 24);
    assert_eq!(texts(&m)[0], "2026-01-01 00:00:00");
    assert_eq!(texts(&m).last().unwrap(), "2026-01-12 23:00:00");
    assert!(m.data.ts_parsed.windows(2).all(|w| w[1] - w[0] == 3_600_000_000));
    assert_eq!(r.warnings, vec!["Dates in eu.csv read as day/month/year (2/1/2026 → 2026-01-02)"]);
}

#[test]
fn a_large_us_file_reads_the_same_whatever_the_thread_split() {
    // 40 days of 5-minute rows (11 520) in `M/D/YYYY h:mm AM/PM`: the parallel
    // evidence fold and rewrite must give one strictly increasing series.
    let start = parse_timestamp("2026-01-01 00:00:00").unwrap();
    let mut rows = Vec::new();
    for i in 0..(40 * 288) {
        let t = start + chrono::Duration::minutes(5 * i);
        rows.push(t.format("%-m/%-d/%Y %-I:%M %p").to_string());
    }
    let refs: Vec<&str> = rows.iter().map(String::as_str).collect();
    let (m, r) = load(&[("big.csv", &file_of(&refs))]);
    assert_eq!(m.data.n_rows(), 40 * 288);
    assert!(m.data.ts_parsed.iter().all(|&t| t != TS_MISSING));
    assert!(m.data.ts_parsed.windows(2).all(|w| w[1] - w[0] == 300_000_000));
    assert_eq!(r.interval_seconds, Some(300.0));
    assert_eq!(r.period_end.as_deref(), Some("2026-02-09 23:55:00"));
    assert!(r.warnings[0].starts_with("Dates in big.csv read as month/day/year"), "{:?}", r.warnings);
    assert!(!r.warnings[0].contains("check the dates"));
}

// ── Mixed shapes inside ONE file ───────────────────────────────────────────

#[test]
fn iso_rows_and_slash_rows_in_one_file_are_read_together() {
    // The ISO rows take part in the order decision (they anchor the time line).
    let (m, r) = load(&[(
        "mixed.csv",
        &file_of(&["2026-01-01 23:50:00", "2026-01-01 23:55", "1/2/2026 0:00", "1/2/2026 0:05"]),
    )]);
    assert!(m.data.ts_parsed.iter().all(|&t| t != TS_MISSING));
    assert_eq!(m.data.ts_parsed[2], micros("2026-01-02 00:00:00"));
    assert_eq!(m.data.ts_parsed[3], micros("2026-01-02 00:05:00"));
    assert_eq!(r.warnings, vec!["Dates in mixed.csv read as month/day/year (1/2/2026 → 2026-01-02)"]);
}

#[test]
fn month_name_rows_and_slash_rows_in_one_file_get_one_line_each() {
    let (t, w) = rewrite(&["31-Jan-26 23:55", "2/1/2026 0:00", "2/1/2026 0:05"]);
    assert_eq!(t, vec!["2026-01-31 23:55:00", "2026-02-01 00:00:00", "2026-02-01 00:05:00"]);
    assert_eq!(
        w,
        vec![
            "Dates in f.csv read as month/day/year (2/1/2026 → 2026-02-01)",
            "Dates in f.csv read as day-month-year with month names (31-Jan-26 23:55 → 2026-01-31 23:55:00, 2-digit year read as 20YY)",
        ]
    );
}

// ── Empty and whitespace cells ─────────────────────────────────────────────

#[test]
fn empty_and_blank_timestamp_cells_are_dropped_not_counted_as_unreadable() {
    let body = "timestamp,A\n1/13/2026 0:00,1\n   ,2\n,3\n\" 1/13/2026 0:05 \",4\n";
    let (m, r) = load(&[("gaps.csv", body)]);
    assert_eq!(texts(&m), vec!["2026-01-13 00:00:00", "2026-01-13 00:05:00"]);
    assert!(unreadable_line(&r).is_none(), "{:?}", r.warnings);
    // Same with several files (the BTreeMap merge path).
    let (m, r) = load(&[("a.csv", body), ("b.csv", "timestamp,B\n2026-01-13 00:10:00,9\n")]);
    assert_eq!(m.data.n_rows(), 3);
    assert!(unreadable_line(&r).is_none(), "{:?}", r.warnings);
}

#[test]
fn a_one_row_file_with_a_day_over_12_is_not_a_guess() {
    let (t, w) = rewrite(&["13/1/2026"]);
    assert_eq!(t, vec!["2026-01-13 00:00:00"]);
    assert_eq!(w, vec!["Dates in f.csv read as day/month/year (13/1/2026 → 2026-01-13)"]);
}

// ── Numeric columns ────────────────────────────────────────────────────────

#[test]
fn epoch_seconds_vs_milliseconds_is_decided_by_digit_count() {
    // 10 digits = seconds, 13 = milliseconds (UTC); fractions kept.
    let (t, w) = rewrite(&["1735736700.5", "1735737000"]);
    assert_eq!(t, vec!["2025-01-01 13:05:00.5", "2025-01-01 13:10:00"]);
    assert!(w[0].contains("Unix epoch seconds (UTC)"));
    let (t, _) = rewrite(&["1735736700250.5", "1735737000000"]);
    assert_eq!(t[0], "2025-01-01 13:05:00.2505", "250.5 ms");
    assert_eq!(parse_timestamp(&t[0]).unwrap(), parse_timestamp("2025-01-01 13:05:00.2505").unwrap());
    // 9 / 11 digits are neither: unreadable and counted, never guessed.
    for rows in [vec!["173573670", "173573700"], vec!["17357367000", "17357370000"]] {
        let (t, w) = rewrite(&rows);
        assert_eq!(t, rows, "kept as written");
        assert_eq!(w, vec!["2 timestamp(s) in f.csv could not be read as a date and time"], "{rows:?}");
    }
}

#[test]
fn an_epoch_column_with_the_odd_millisecond_row_reads_the_majority() {
    let (t, w) = rewrite(&["1735736700", "1735737000", "1735737300000"]);
    assert_eq!(&t[..2], &["2025-01-01 13:05:00", "2025-01-01 13:10:00"]);
    assert_eq!(t[2], "1735737300000");
    assert_eq!(w.last().unwrap(), "1 timestamp(s) in f.csv could not be read as a date and time");
}

// ── Years: 2-digit, Buddhist era, Thai digits ──────────────────────────────

#[test]
fn a_2_digit_numeric_year_is_always_20yy_even_for_a_thai_user() {
    // Documented rule (Import page note): 2-digit = 20YY. Only a Thai MONTH
    // NAME makes a 2-digit year Buddhist era.
    let (t, w) = rewrite(&["31/01/68 13:05"]);
    assert_eq!(t, vec!["2068-01-31 13:05:00"]);
    assert!(w[0].contains("2-digit year read as 20YY"), "{w:?}");
    let (m, _) = load(&[("th.csv", &file_of(&["31 ม.ค. 68 13:05"]))]);
    assert_eq!(texts(&m), vec!["2025-01-31 13:05:00"]);
}

#[test]
fn thai_digits_in_a_numeric_date_and_time_with_a_buddhist_era_year() {
    let (m, r) = load(&[("th.csv", &file_of(&["๓๑/๐๑/๒๕๖๘ ๑๓:๐๕", "๑/๐๒/๒๕๖๘ ๐๐:๐๐"]))]);
    assert_eq!(texts(&m), vec!["2025-01-31 13:05:00", "2025-02-01 00:00:00"]);
    assert!(r.warnings[0].starts_with("Dates in th.csv read as day/month/year"), "{:?}", r.warnings);
    assert!(r.warnings.iter().any(|w| w.contains("Buddhist-Era")));
}

#[test]
fn thai_words_around_the_time_are_ignored() {
    let (t, _) = rewrite(&["วันที่ 31 ม.ค. พ.ศ. 2568 เวลา 13.05 น."]);
    // `วันที่` ("date") is not a known word: the row is not read.
    assert_eq!(t, vec!["วันที่ 31 ม.ค. พ.ศ. 2568 เวลา 13.05 น."]);
    let (t, _) = rewrite(&["31 ม.ค. พ.ศ. 2568 เวลา 13.05 น."]);
    assert_eq!(t, vec!["2568-01-31 13:05:00"], "year kept as written; from_parts converts it");
}

// ── Time zones (the wall clock as written is kept) ─────────────────────────

#[test]
fn every_zone_suffix_keeps_the_written_wall_clock() {
    for s in [
        "1/13/2026 13:05 UTC",
        "1/13/2026 13:05 GMT",
        "1/13/2026 1:05 PM GMT+7",
        "1/13/2026 1:05 PM +07:00",
        "1/13/2026 13:05:00-05:00",
        "1/13/2026 13:05:00Z",
        "1/13/2026 13:05 z",
    ] {
        let (t, _) = rewrite(&[s]);
        assert_eq!(t, vec!["2026-01-13 13:05:00"], "{s}");
    }
}

// ── Several files ──────────────────────────────────────────────────────────

#[test]
fn three_files_in_three_shapes_merge_to_one_row_per_moment() {
    let (m, r) = load(&[
        ("us.csv", "timestamp,A\n1/13/2026 1:05 PM,1\n1/13/2026 1:10 PM,2\n"),
        ("de.csv", "timestamp,B\n13.01.2026 13:05,10\n13.01.2026 13:10,20\n"),
        ("hist.csv", "\u{FEFF}TimeStamp,C\n13-Jan-26 1:05 PM,100\n13-Jan-26 1:10 PM,200\n"),
    ]);
    assert_eq!(texts(&m), vec!["2026-01-13 13:05:00", "2026-01-13 13:10:00"]);
    assert_eq!(m.data.headers, vec!["timestamp", "A", "B", "C"]);
    assert_eq!(m.data.columns[3], vec![100.0, 200.0]);
    assert_eq!(m.data.columns[1], vec![1.0, 2.0]);
    assert!(r.warnings.iter().any(|w| w.starts_with("Dates in de.csv read as day/month/year")));
    assert!(r.warnings.iter().any(|w| w == "2 duplicate timestamp(s) found across files (values were merged/overwritten)"));
}

#[test]
fn files_whose_day_month_orders_differ_are_each_read_their_own_way() {
    // Decided per FILE: a US file and a European file of the same days.
    let (m, _) = load(&[
        ("us.csv", "timestamp,A\n1/13/2026 0:00,1\n2/1/2026 0:00,2\n"),
        ("eu.csv", "timestamp,B\n13/1/2026 0:00,10\n1/2/2026 0:00,20\n"),
    ]);
    assert_eq!(texts(&m), vec!["2026-01-13 00:00:00", "2026-02-01 00:00:00"]);
    assert_eq!(m.data.columns[1], vec![1.0, 2.0]);
    assert_eq!(m.data.columns[2], vec![10.0, 20.0]);
}

/// Documented limitation (Import page note, 2026-10-15): files are merged on
/// the timestamp TEXT. A non-ISO file is rewritten to `YYYY-MM-DD HH:MM:SS`,
/// but an ISO file without seconds or with a `T` is left as written, so the
/// same moment from the two files stays two rows. Pinned so a change is
/// deliberate; see the QA report.
#[test]
fn an_iso_file_without_seconds_and_a_rewritten_file_keep_the_same_moment_twice() {
    let (m, _) = load(&[
        ("us.csv", "timestamp,A\n1/13/2026 0:00,1\n"),
        ("iso.csv", "timestamp,B\n2026-01-13 00:00,10\n"),
    ]);
    assert_eq!(m.data.n_rows(), 2, "{:?}", texts(&m));
    assert_eq!(m.data.ts_parsed[0], m.data.ts_parsed[1], "same instant, two rows");
}

// ── Header clean-up: mapping and metadata CSVs ─────────────────────────────

#[test]
fn a_bom_on_the_mapping_csv_header_does_not_hide_the_key_column() {
    let dir = tempfile::tempdir().unwrap();
    let p = write_csv(&dir, "map.csv", "\u{FEFF}Tag , Description\nA,Alpha\nB,Beta\n");
    let data = load_mapping_csv_data(&p).unwrap();
    assert_eq!(data.headers, vec!["Tag", "Description"]);
    let res = apply_mapping("Tag", &data, &["timestamp".into(), "A".into(), "C".into()]).unwrap();
    assert_eq!(res.matched, vec!["A"]);
    assert_eq!(res.not_in_dataset, vec!["B"]);
    assert_eq!(res.not_in_mapping, vec!["C"]);
}

#[test]
fn a_bom_on_the_metadata_csv_header_still_finds_the_tag_column() {
    let dir = tempfile::tempdir().unwrap();
    let p = write_csv(&dir, "meta.csv", "\u{FEFF}tag,Description , UNIT,component\nA,Alpha,bar,Pump\n,skip,,\n");
    let meta = load_metadata(&p).unwrap();
    assert_eq!(meta.len(), 1);
    assert_eq!(meta[0].tag, "A");
    assert_eq!(meta[0].description, "Alpha");
    assert_eq!(meta[0].unit, "bar");
    assert_eq!(meta[0].component, "Pump");
}

// ── Found by QA ────────────────────────────────────────────────────────────

/// A row in an ISO shape whose date does not exist (`2026-02-30`) is dropped
/// silently: `is_plain_iso` only checks the byte shape, so the rewrite skips
/// it and it is never counted in "N timestamp(s) … could not be read", while
/// the same date written `2/30/2026` IS counted. (A fix must not count a
/// Buddhist-Era ISO leap day such as `2567-02-29`, which from_parts reads.)
#[test]
#[ignore = "QA finding 2026-10-19: impossible ISO-shaped dates are not counted as unreadable"]
fn an_impossible_iso_date_is_counted_like_any_unreadable_row() {
    let (_, w) = rewrite(&["1/13/2026 0:00", "2026-02-30 00:00:00"]);
    assert_eq!(w.last().unwrap(), "1 timestamp(s) in f.csv could not be read as a date and time");
    let (_, r) = load(&[("iso.csv", "timestamp,A\n2026-01-01 00:00:00,1\n2026-02-30 00:00:00,2\n")]);
    assert!(unreadable_line(&r).is_some(), "{:?}", r.warnings);
}

/// Coordinator finding 2026-10-19: a column written twice INSIDE one file must
/// be reported (csv_processor.rs's own comment: "A column that appears twice
/// INSIDE one file is still reported"), but the check only runs for 2+ files
/// (`if paths.len() > 1`), so a single-file import is silent and the dataset
/// keeps two `FLOW_A` headers.
#[test]
#[ignore = "QA finding 2026-10-19: a duplicate column inside a SINGLE file gives no warning"]
fn a_column_twice_in_a_single_file_is_reported() {
    let (m, r) = load(&[("one.csv", "Timestamp,FLOW_A,FLOW_A\n2026-01-01 00:00:00,1,2\n")]);
    assert_eq!(
        r.warnings.iter().filter(|w| w.contains("Duplicate column")).collect::<Vec<_>>(),
        vec!["Duplicate column 'flow_a' found in file 1"],
        "headers: {:?}",
        m.data.headers
    );
}

/// The same check with two files works (pins the multi-file path the single-file
/// fix must match).
#[test]
fn a_column_twice_in_one_of_several_files_is_reported() {
    let (_, r) = load(&[
        ("a.csv", "Timestamp,FLOW_A,FLOW_A\n2026-01-01 00:00:00,1,2\n"),
        ("b.csv", "Timestamp,FLOW_B\n2026-01-01 00:05:00,3\n"),
    ]);
    assert!(r.warnings.iter().any(|w| w == "Duplicate column 'flow_a' found in file 1"), "{:?}", r.warnings);
}

/// Design limitation (coordinator 2026-10-19), pinned: a D/M/YYYY file whose
/// rows all sit on ONE date with both numbers <= 12 (`03/06/2026` = 3 June)
/// gives both readings the same fit, so it is read month/day (6 March) and
/// only the "check the dates" note warns. A single-row file is the same.
#[test]
fn one_date_with_day_and_month_12_or_less_ties_and_reads_month_day_with_a_warning() {
    let (t, w) = rewrite(&["03/06/2026 00:00", "03/06/2026 00:05", "03/06/2026 00:10"]);
    assert_eq!(t[0], "2026-03-06 00:00:00", "read as 6 March, not 3 June");
    assert_eq!(
        w,
        vec!["Dates in f.csv read as month/day/year (03/06/2026 → 2026-03-06) — could not be told apart from the values; check the dates"]
    );
    let (t, w) = rewrite(&["03/06/2026 08:00"]);
    assert_eq!(t, vec!["2026-03-06 08:00:00"]);
    assert!(w[0].ends_with("check the dates"), "{w:?}");
}

/// Unreadable rows are kept as rows (no timestamp) and counted in total_rows.
#[test]
fn unreadable_rows_stay_in_the_dataset_with_no_timestamp() {
    let (m, r) = load(&[("x.csv", &file_of(&["1/13/2026 0:00", "junk", "1/13/2026 0:05"]))]);
    assert_eq!(r.total_rows, 3);
    assert_eq!(m.data.ts_parsed.iter().filter(|&&t| t == TS_MISSING).count(), 1);
    assert_eq!(unreadable_line(&r).map(String::as_str), Some("1 timestamp(s) in x.csv could not be read as a date and time"));
}
