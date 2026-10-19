use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::BufReader;
use std::time::Instant;

/// Hard cap on the size of a single CSV the desktop app will accept.
/// At 2 GB the parsed columns (~8 bytes/cell) plus transient batch buffers
/// dominate; anything larger should be pre-processed externally.
const MAX_CSV_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Sentinel in [`ColumnarData::ts_parsed`] for a row whose timestamp is
/// missing or failed to parse. Any timestamp filter excludes such rows,
/// matching the legacy per-query parse behavior.
pub const TS_MISSING: i64 = i64::MIN;

/// Wire-format row for sampled scatter payloads and table pages. NOT the
/// in-RAM store — the loaded dataset lives in [`ColumnarData`]; records of
/// this shape are materialized only at the IPC boundary (see
/// [`ColumnarData::wire_record`]), and every command that emits them is
/// bounded (`get_scatter_sample`).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CsvRecord {
    pub timestamp: Option<String>,
    pub values: Vec<Option<f64>>,
}

/// In-RAM store for the loaded dataset — column-major.
///
/// Why columnar: `Option<f64>` occupies 16 bytes (the discriminant pads to
/// f64 alignment) and a per-row `Vec` adds a 24-byte header plus its own
/// heap allocation. One contiguous `Vec<f64>` per sensor halves the
/// dominant term (8 bytes/cell, NaN = missing) and drops the per-row
/// overhead entirely. Every aggregation in lib.rs walks columns, so this
/// is also the cache-friendly orientation for stats/filter/projection.
pub struct ColumnarData {
    /// Column names; `headers[0]` is the canonical timestamp column after
    /// the merge step.
    pub headers: Vec<String>,
    /// Timestamp text per row, round-tripped to the frontend as-is — EXCEPT
    /// a non-ISO shape (`1/2/2026 0:05`, `2026/01/02 …`, AM/PM), which is
    /// rewritten to `YYYY-MM-DD HH:MM:SS[.f]` per file at read time
    /// ([`normalize_file_timestamps`]), and a detected Buddhist-Era year (see [`normalize_buddhist_era`]), which
    /// `from_parts` rewrites to Gregorian here too, not just in `ts_parsed`.
    /// Keeping this text and `ts_parsed` derived from the exact same
    /// (possibly-corrected) string is what keeps Raw-mode display (which
    /// reads this text directly) and Aggregated-mode display (built from
    /// `ts_parsed`) agreeing on the year for the same rows.
    pub timestamps: Vec<Option<String>>,
    /// Timestamps parsed ONCE at load to epoch microseconds ([`TS_MISSING`]
    /// when absent/unparseable). Filters compare against this — never
    /// re-parse `timestamps` per query.
    ///
    /// WRITE-ONCE: filled by [`ColumnarData::from_parts`] and never changed
    /// afterwards (special sensors only add / replace / remove VALUE columns).
    /// [`ColumnarData::sample_interval_secs`] caches a value derived from it,
    /// so a future path that changes the timestamps of a loaded dataset must
    /// build a NEW `ColumnarData` through `from_parts` (which starts with an
    /// empty cache) instead of editing this vector in place.
    pub ts_parsed: Vec<i64>,
    /// `columns[c][r]` = value of column `c` at row `r`; NaN = missing.
    /// Every column has length `n_rows()`, including the timestamp
    /// column's all-NaN placeholder, so header indices map 1:1.
    pub columns: Vec<Vec<f64>>,
    /// Cache of [`ColumnarData::sample_interval_secs`] (the median sample
    /// interval of `ts_parsed`), filled by the first call. Private, so every
    /// dataset outside this module is built by `from_parts` and starts empty:
    /// the cache lives and dies with the dataset it describes.
    sample_interval: std::sync::OnceLock<Option<f64>>,
}

impl ColumnarData {
    /// Assemble a dataset from already-built parts, normalizing a detected
    /// Buddhist-Era year (see [`normalize_buddhist_era`]) in `timestamps`
    /// BEFORE computing `ts_parsed` (the one-time timestamp parse), both in
    /// parallel — so every downstream consumer of either field, in Rust or
    /// shipped to the frontend, sees only the corrected Gregorian year.
    pub fn from_parts(
        headers: Vec<String>,
        timestamps: Vec<Option<String>>,
        columns: Vec<Vec<f64>>,
    ) -> Self {
        use rayon::prelude::*;
        debug_assert!(columns.iter().all(|c| c.len() == timestamps.len()));
        let timestamps: Vec<Option<String>> = timestamps
            .into_par_iter()
            .map(|t| t.map(normalize_buddhist_era))
            .collect();
        let ts_parsed: Vec<i64> = timestamps
            .par_iter()
            .map(|t| {
                t.as_deref()
                    .and_then(parse_timestamp)
                    .map(ts_to_micros)
                    .unwrap_or(TS_MISSING)
            })
            .collect();
        ColumnarData {
            headers,
            timestamps,
            ts_parsed,
            columns,
            sample_interval: std::sync::OnceLock::new(),
        }
    }

    pub fn n_rows(&self) -> usize {
        self.timestamps.len()
    }

    /// Median sample interval of this dataset in seconds — exactly
    /// [`median_interval_seconds`] of `ts_parsed` (`None` below 2 valid
    /// timestamps / without a positive gap), computed AT MOST ONCE per dataset.
    ///
    /// The computation is two passes over `ts_parsed`, up to 2M gap samples
    /// and a sort (plus a full sort of the timestamps when they are out of
    /// order): several times the cost of the count scan / preview it
    /// accompanies, and constant for a loaded dataset. `load_csv` fills the
    /// cache while it builds the load report (off the session lock, on the
    /// load's own blocking thread), so no later command pays for it.
    ///
    /// Never stale: the cache is a field of the dataset itself. A new load
    /// installs a new `ColumnarData` (empty cache), and `ts_parsed` is
    /// write-once (see its doc) — special sensors only touch value columns.
    pub fn sample_interval_secs(&self) -> Option<f64> {
        *self
            .sample_interval
            .get_or_init(|| median_interval_seconds(&self.ts_parsed))
    }

    #[inline]
    pub fn col_index(&self, name: &str) -> Option<usize> {
        self.headers.iter().position(|h| h == name)
    }

    /// Cell accessor with the legacy `Option` semantics: NaN (missing)
    /// maps to `None`, everything else (including ±inf) to `Some`.
    /// Out-of-range indices also yield `None`.
    #[inline]
    pub fn value(&self, col: usize, row: usize) -> Option<f64> {
        let v = *self.columns.get(col)?.get(row)?;
        if v.is_nan() {
            None
        } else {
            Some(v)
        }
    }

    /// Materialize one row in the wire shape, projected to `col_indices`.
    pub fn wire_record(&self, row: usize, col_indices: &[usize]) -> CsvRecord {
        CsvRecord {
            timestamp: self.timestamps[row].clone(),
            values: col_indices.iter().map(|&c| self.value(c, row)).collect(),
        }
    }
}

/// Detects a Buddhist-Era (BE = CE + 543) year in the leading `YYYY` of a
/// timestamp string and rewrites it to Gregorian in place — every format
/// [`parse_timestamp`] accepts starts with `%Y`, so the first 4 characters
/// are always the year regardless of which one matches.
///
/// Detection rule: `year >= 2400`. No genuine CE sensor timestamp is ever
/// that far out (2400 CE is over 370 years away), and no genuine BE year is
/// ever under 2400 either (BE 2400 = CE 1857, decades before any plausible
/// sensor log) — safe both directions for this app's domain, so this runs
/// unconditionally with no per-import opt-in.
///
/// Why this matters beyond cosmetics: a BE date's leap day, e.g.
/// `2567-02-29` (BE 2567 = CE 2024, a real leap year), fails to parse
/// entirely if read as literal CE — CE 2567 is not a leap year, so
/// `chrono` rejects the date outright and the whole row is dropped as
/// [`TS_MISSING`]. Correcting the year here, before any parse attempt, is
/// what makes that row valid again.
fn normalize_buddhist_era(mut s: String) -> String {
    if let Some(year) = s.get(0..4).and_then(|y| y.parse::<i32>().ok()) {
        if year >= 2400 {
            // `year` came from exactly 4 ASCII digits, so `year - 543` is
            // always in [1857, 9456] — always 4 digits, same byte width.
            s.replace_range(0..4, &format!("{:04}", year - 543));
        }
    }
    s
}

/// True if `s`'s leading `YYYY` reads as a Buddhist-Era year, per
/// [`normalize_buddhist_era`]'s detection rule — without rewriting it. Used
/// only to decide whether a load-report warning is worth surfacing.
fn is_buddhist_era_year(s: &str) -> bool {
    s.get(0..4)
        .and_then(|y| y.parse::<i32>().ok())
        .is_some_and(|y| y >= 2400)
}

/// Load-report warning for detected Buddhist-Era years, or `None` if none
/// were found — `from_parts` corrects them silently, so this is the only
/// place the user finds out it happened. Scan BEFORE normalization (pass
/// the still-original timestamp text): after `from_parts` runs, every year
/// has already been rewritten and there's nothing left to detect.
fn buddhist_era_warning<'a>(timestamps: impl IntoIterator<Item = &'a str>) -> Option<String> {
    let count = timestamps
        .into_iter()
        .filter(|s| is_buddhist_era_year(s))
        .count();
    if count == 0 {
        return None;
    }
    Some(format!(
        "{} timestamp(s) used a Buddhist-Era year (พ.ศ.) — converted to Gregorian (ค.ศ.) for display and calculations",
        count
    ))
}

/// Try the common timestamp formats and return the parsed `NaiveDateTime`,
/// or `None` if no format matches. Single source of truth for every
/// timestamp parse in the app (load-time row parsing and per-query filter
/// bounds alike).
///
/// Reads the year-first ISO shapes only (plus a trailing `Z`, read as the
/// wall clock written — the same way a `+07:00` offset is read). The non-ISO
/// shapes (`M/D/YYYY`, `D.M.YYYY`, `YYYY/MM/DD`, AM/PM …) are rewritten to
/// ISO text per file at read time by [`normalize_file_timestamps`] — the
/// day/month order of `A/B/YYYY` can only be decided from the whole file, so
/// a single string can never be read here.
pub fn parse_timestamp(s: &str) -> Option<chrono::NaiveDateTime> {
    parse_iso_timestamp(s).or_else(|| {
        // `…Z` (UTC designator): the app reads the wall clock as written,
        // exactly like `DateTime::naive_local()` does for `+07:00` below.
        let rest = s.strip_suffix('Z').or_else(|| s.strip_suffix('z'))?;
        if rest.ends_with(|c: char| c.is_ascii_digit()) {
            parse_naive_iso(rest)
        } else {
            None
        }
    })
}

/// The offset-less ISO shapes.
fn parse_naive_iso(s: &str) -> Option<chrono::NaiveDateTime> {
    chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f")
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S"))
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M"))
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S%.f"))
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S"))
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M"))
        .ok()
}

/// Offset-less ISO, then ISO with a `±HH:MM` offset (wall clock as written).
fn parse_iso_timestamp(s: &str) -> Option<chrono::NaiveDateTime> {
    if let Some(dt) = parse_naive_iso(s) {
        return Some(dt);
    }
    chrono::DateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S%:z")
        .map(|dt| dt.naive_local())
        .or_else(|_| {
            chrono::DateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%:z").map(|dt| dt.naive_local())
        })
        .or_else(|_| {
            chrono::DateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S%.f%:z")
                .map(|dt| dt.naive_local())
        })
        .or_else(|_| {
            chrono::DateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f%:z")
                .map(|dt| dt.naive_local())
        })
        .ok()
}

/// `NaiveDateTime` → epoch microseconds (the `ts_parsed` representation).
pub fn ts_to_micros(dt: chrono::NaiveDateTime) -> i64 {
    dt.and_utc().timestamp_micros()
}

/// Epoch microseconds → `NaiveDateTime`, for formatting saved-model date
/// bounds. `None` only for values outside chrono's representable range.
pub fn micros_to_naive(us: i64) -> Option<chrono::NaiveDateTime> {
    chrono::DateTime::from_timestamp_micros(us).map(|dt| dt.naive_utc())
}

// ── Non-ISO timestamp shapes (read per file, rewritten to ISO text) ────────
//
// Real exports come in many shapes: `1/2/2026 0:05` (US Excel),
// `2/1/2026 0:05` (most other locales), `01-Jan-25 12:00 AM` (historians),
// `Mon, 01 Jan 2025 13:05:00 +0700` (RFC), `20250131130500` (compact),
// `1 ม.ค. 2568 13:05 น.` (Thai), Excel serial numbers, Unix epochs … These are
// read ONCE per file, right after the file is read and BEFORE the multi-file
// merge (which keys rows by timestamp TEXT), and rewritten to
// `YYYY-MM-DD HH:MM:SS[.f]` so every later step (merge order, `from_parts`'
// one-time parse, the frontend's year-first `readWallClock`) sees ISO text.
// Text already in a shape `parse_timestamp` reads ([`is_plain_iso`]) is
// never touched.
//
// The parser is token based rather than one big pattern: the text is split
// on whitespace, the decoration is peeled off (weekday, time zone, AM/PM,
// Thai `น.`), the time token is taken off the end, and what is left must be
// one of a small table of date shapes (see [`parse_date_tokens`]).
//
// The year is written out AS GIVEN: a Buddhist-Era year (`1/2/2569`) stays
// `2569-01-02 …` here and is converted exactly once, by `from_parts`'
// `normalize_buddhist_era`, which also produces the BE load-report warning.
// A time zone (`Z`, `+0700`, `GMT+0700`, `UTC`) is dropped: the app reads
// the wall clock as written, exactly like `+07:00` offsets in ISO text.

/// Day/month order of an `A/B/YYYY` date — decided per FILE, never per row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DayMonthOrder {
    /// `A` is the month (`M/D/YYYY`, Excel's US default).
    MonthFirst,
    /// `A` is the day (`D/M/YYYY`).
    DayFirst,
}

/// Where the month NAME sits in a month-name date (or that it is Thai).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NameStyle {
    /// `01-Jan-25`, `1 January 2025`, `Mon, 01 Jan 2025`.
    DayFirst,
    /// `Jan 31 2025`, `Monday, January 1, 2025`, `Wed Jan 01 2025`.
    MonthFirst,
    /// `2025-Jan-31`, `2025 Jan 31`.
    YearFirst,
    /// Thai month name, day first (`1 ม.ค. 2568`).
    Thai,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LooseDate {
    /// `YYYY/MM/DD`, `YYYY.MM.DD`, `YYYY-M-D`, ISO-like texts that
    /// `parse_timestamp` does not take (`2025-01-31T130500`, lowercase `t`,
    /// comma fraction, date only) — unambiguous.
    YearFirst { y: i32, m: u32, d: u32 },
    /// `YYYYMMDD[HHMM[SS]]` — unambiguous.
    Compact { y: i32, m: u32, d: u32 },
    /// `A/B/YYYY`, `A.B.YYYY`, `A-B-YYYY` (or a 2-digit `YY`) — order
    /// decided per file.
    YearLast { a: u32, b: u32, y: i32 },
    /// A month NAME — the name settles day vs month, no per-file order.
    Named { y: i32, m: u32, d: u32, style: NameStyle },
}

/// One non-ISO timestamp, split into fields (24-hour clock already applied).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct LooseTs {
    date: LooseDate,
    h: u32,
    mi: u32,
    s: u32,
    /// Fractional-second digits as written (`frac_len` digits, leading zeros
    /// kept through the width), so the rewritten text keeps them verbatim.
    frac: u32,
    frac_len: u8,
    /// The year was written with 2 digits: read as `2000 + YY` (no sensor
    /// log predates 2000), or `2500 + YY` (Buddhist-Era) next to a Thai
    /// month name.
    two_digit_year: bool,
}

fn digits_in(s: &str, min: usize, max: usize) -> Option<u32> {
    if (min..=max).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit()) {
        s.parse().ok()
    } else {
        None
    }
}

/// `YYYY` as is, `YY` as `century + YY`; the bool says it was 2 digits.
fn year_in(s: &str, century: i32) -> Option<(i32, bool)> {
    match s.len() {
        2 => Some((century + digits_in(s, 2, 2)? as i32, true)),
        4 => Some((digits_in(s, 4, 4)? as i32, false)),
        _ => None,
    }
}

/// Month name → (1..=12, is Thai). English: 3-letter, `Sept`, or full, any
/// case, a trailing `.` allowed (`Jan.`). Thai: the abbreviations with or
/// without dots (`ม.ค.` / `มค`) and the full names (`มกราคม`).
fn month_from_name(s: &str) -> Option<(u32, bool)> {
    if s.is_ascii() {
        const NAMES: [(&str, &str); 12] = [
            ("jan", "january"),
            ("feb", "february"),
            ("mar", "march"),
            ("apr", "april"),
            ("may", "may"),
            ("jun", "june"),
            ("jul", "july"),
            ("aug", "august"),
            ("sep", "september"),
            ("oct", "october"),
            ("nov", "november"),
            ("dec", "december"),
        ];
        let s = s.strip_suffix('.').unwrap_or(s);
        if s.eq_ignore_ascii_case("sept") {
            return Some((9, false));
        }
        return NAMES
            .iter()
            .position(|(short, full)| s.eq_ignore_ascii_case(short) || s.eq_ignore_ascii_case(full))
            .map(|i| (i as u32 + 1, false));
    }
    const THAI_FULL: [&str; 12] = [
        "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
        "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
    ];
    const THAI_ABBR: [&str; 12] = [
        "มค", "กพ", "มีค", "เมย", "พค", "มิย", "กค", "สค", "กย", "ตค", "พย", "ธค",
    ];
    if let Some(i) = THAI_FULL.iter().position(|f| *f == s) {
        return Some((i as u32 + 1, true));
    }
    let no_dots: String = s.chars().filter(|&c| c != '.').collect();
    THAI_ABBR
        .iter()
        .position(|a| *a == no_dots)
        .map(|i| (i as u32 + 1, true))
}

fn is_weekday(s: &str) -> bool {
    const DAYS: [&str; 18] = [
        "mon", "monday", "tue", "tues", "tuesday", "wed", "wednesday", "thu", "thur", "thurs",
        "thursday", "fri", "friday", "sat", "saturday", "sun", "sunday", "weds",
    ];
    let s = s.strip_suffix('.').unwrap_or(s);
    DAYS.iter().any(|d| s.eq_ignore_ascii_case(d))
}

/// `+0700`, `+07:00`, `+07`, `-0500` (a whole token or a suffix).
fn is_offset(s: &str) -> bool {
    let Some(rest) = s.strip_prefix('+').or_else(|| s.strip_prefix('-')) else {
        return false;
    };
    let b = rest.as_bytes();
    match b.len() {
        1 | 2 | 4 => b.iter().all(u8::is_ascii_digit),
        5 => b[2] == b':' && [0, 1, 3, 4].iter().all(|&i| b[i].is_ascii_digit()),
        _ => false,
    }
}

/// A whole token that is only a time zone: `Z`, `UTC`, `GMT`, `GMT+0700`,
/// `UTC+7`, `+0700`, `+07:00`.
fn is_zone_token(s: &str) -> bool {
    if s.eq_ignore_ascii_case("z") || s.eq_ignore_ascii_case("utc") || s.eq_ignore_ascii_case("gmt") {
        return true;
    }
    let tail = if s.len() > 3 && (s[..3].eq_ignore_ascii_case("utc") || s[..3].eq_ignore_ascii_case("gmt")) {
        &s[3..]
    } else {
        s
    };
    is_offset(tail)
}

/// `AM`/`PM`/`a.m.`/`p.m.` (any case) → `Some(is_pm)`.
fn meridiem_of(s: &str) -> Option<bool> {
    // No allocation: this runs on the last token of every non-ISO row.
    if ["am", "a.m.", "a.m"].iter().any(|m| s.eq_ignore_ascii_case(m)) {
        Some(false)
    } else if ["pm", "p.m.", "p.m"].iter().any(|m| s.eq_ignore_ascii_case(m)) {
        Some(true)
    } else {
        None
    }
}

/// Peel a meridiem glued to a time (`1:05pm`, `1:05p.m.`).
fn split_glued_meridiem(t: &str) -> (&str, Option<bool>) {
    for (suffix, pm) in [("a.m.", false), ("p.m.", true), ("am", false), ("pm", true)] {
        if t.len() > suffix.len() {
            let cut = t.len() - suffix.len();
            if t.is_char_boundary(cut) && t[cut..].eq_ignore_ascii_case(suffix) {
                return (&t[..cut], Some(pm));
            }
        }
    }
    (t, None)
}

/// Peel a time zone glued to a time (`13:05:00Z`, `13:05:00+0700`).
fn strip_glued_zone(t: &str) -> &str {
    if let Some(rest) = t.strip_suffix('Z').or_else(|| t.strip_suffix('z')) {
        return rest;
    }
    if let Some(i) = t.rfind(['+', '-']) {
        if i > 0 && is_offset(&t[i..]) {
            return &t[..i];
        }
    }
    t
}

/// One time token → (h, mi, s, frac, frac_len). Shapes: `H:MM`, `H:MM:SS`,
/// `H:MM:SS.f` / `,f`, compact `HHMM` / `HHMMSS[.f]`, and `H.MM` after a
/// Thai `น.`. `meridiem` applies the 12-hour clock (12 AM = 00, 12 PM = 12).
fn parse_clock(t: &str, mut meridiem: Option<bool>, thai: bool) -> Option<(u32, u32, u32, u32, u8)> {
    let t = strip_glued_zone(t);
    let (t, glued) = split_glued_meridiem(t);
    if glued.is_some() {
        if meridiem.is_some() {
            return None;
        }
        meridiem = glued;
    }
    let (h, mi, s, frac, frac_len) = if t.contains(':') {
        // `H:MM`, `H:MM:SS`, `H:MM:SS.f` / `H:MM:SS,f`
        let (clock, f) = match t.find([',', '.']) {
            Some(i) => (&t[..i], Some(&t[i + 1..])),
            None => (t, None),
        };
        let mut parts = clock.split(':');
        let h = digits_in(parts.next()?, 1, 2)?;
        let mi = digits_in(parts.next()?, 2, 2)?;
        let sec = parts.next();
        if parts.next().is_some() || (sec.is_none() && f.is_some()) {
            return None;
        }
        let s = match sec {
            Some(x) => digits_in(x, 2, 2)?,
            None => 0,
        };
        let (frac, frac_len) = match f {
            Some(f) => (digits_in(f, 1, 9)?, f.len() as u8),
            None => (0, 0),
        };
        (h, mi, s, frac, frac_len)
    } else if thai && t.contains('.') {
        // Thai `13.05 น.`
        let (h, mi) = t.split_once('.')?;
        (digits_in(h, 1, 2)?, digits_in(mi, 2, 2)?, 0, 0, 0)
    } else {
        // Compact `HHMM`, `HHMMSS`, `HHMMSS.f`
        let (clock, f) = match t.find([',', '.']) {
            Some(i) => (&t[..i], Some(&t[i + 1..])),
            None => (t, None),
        };
        let (frac, frac_len) = match f {
            Some(f) if clock.len() == 6 => (digits_in(f, 1, 9)?, f.len() as u8),
            Some(_) => return None,
            None => (0, 0),
        };
        match clock.len() {
            4 => (digits_in(&clock[..2], 2, 2)?, digits_in(&clock[2..], 2, 2)?, 0, 0, 0),
            6 => (
                digits_in(&clock[..2], 2, 2)?,
                digits_in(&clock[2..4], 2, 2)?,
                digits_in(&clock[4..], 2, 2)?,
                frac,
                frac_len,
            ),
            _ => return None,
        }
    };
    let mut h = h;
    if mi > 59 || s > 59 {
        return None;
    }
    match meridiem {
        Some(pm) => {
            if !(1..=12).contains(&h) {
                return None;
            }
            h = h % 12 + if pm { 12 } else { 0 };
        }
        None => {
            if h > 23 {
                return None;
            }
        }
    }
    Some((h, mi, s, frac, frac_len))
}

/// Thai digits `๐`–`๙` → ASCII (other characters kept).
fn thai_digits_to_ascii(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '\u{0E50}'..='\u{0E59}' => char::from(b'0' + (c as u32 - 0x0E50) as u8),
            _ => c,
        })
        .collect()
}

/// A single date token: `YYYYMMDD`, `A/B/Y`, `YYYY/M/D`, `D-Mon-Y`,
/// `Mon-D-Y`, `YYYY-Mon-D` (separator `/`, `.` or `-`).
fn parse_date_token(tok: &str) -> Option<(LooseDate, bool)> {
    if tok.len() == 8 && tok.bytes().all(|b| b.is_ascii_digit()) {
        return Some((
            LooseDate::Compact {
                y: digits_in(&tok[..4], 4, 4)? as i32,
                m: digits_in(&tok[4..6], 2, 2)?,
                d: digits_in(&tok[6..], 2, 2)?,
            },
            false,
        ));
    }
    let sep = tok.chars().find(|c| matches!(c, '/' | '.' | '-'))?;
    let mut it = tok.split(sep);
    let (p1, p2, p3) = (it.next()?, it.next()?, it.next()?);
    if it.next().is_some() {
        return None;
    }
    if let Some((m, false)) = month_from_name(p2) {
        return if p1.len() == 4 {
            Some((LooseDate::Named { y: digits_in(p1, 4, 4)? as i32, m, d: digits_in(p3, 1, 2)?, style: NameStyle::YearFirst }, false))
        } else {
            let (y, yy) = year_in(p3, 2000)?;
            Some((LooseDate::Named { y, m, d: digits_in(p1, 1, 2)?, style: NameStyle::DayFirst }, yy))
        };
    }
    if let Some((m, false)) = month_from_name(p1) {
        let (y, yy) = year_in(p3, 2000)?;
        return Some((LooseDate::Named { y, m, d: digits_in(p2, 1, 2)?, style: NameStyle::MonthFirst }, yy));
    }
    if p1.len() == 4 {
        return Some((
            LooseDate::YearFirst {
                y: digits_in(p1, 4, 4)? as i32,
                m: digits_in(p2, 1, 2)?,
                d: digits_in(p3, 1, 2)?,
            },
            false,
        ));
    }
    let (y, yy) = year_in(p3, 2000)?;
    Some((LooseDate::YearLast { a: digits_in(p1, 1, 2)?, b: digits_in(p2, 1, 2)?, y }, yy))
}

/// The date-shape table: one token (see [`parse_date_token`]) or three
/// tokens `D Mon Y`, `Mon D Y`, `Y Mon D` (English or Thai month name).
fn parse_date_tokens(toks: &[&str]) -> Option<(LooseDate, bool)> {
    match *toks {
        [one] => parse_date_token(one),
        [a, b, c] => {
            if let Some((m, thai)) = month_from_name(b) {
                if a.len() == 4 && !thai {
                    let d = digits_in(c, 1, 2)?;
                    return Some((LooseDate::Named { y: digits_in(a, 4, 4)? as i32, m, d, style: NameStyle::YearFirst }, false));
                }
                let (y, yy) = year_in(c, if thai { 2500 } else { 2000 })?;
                let style = if thai { NameStyle::Thai } else { NameStyle::DayFirst };
                return Some((LooseDate::Named { y, m, d: digits_in(a, 1, 2)?, style }, yy));
            }
            let (m, thai) = month_from_name(a)?;
            if thai {
                return None;
            }
            let (y, yy) = year_in(c, 2000)?;
            Some((LooseDate::Named { y, m, d: digits_in(b, 1, 2)?, style: NameStyle::MonthFirst }, yy))
        }
        _ => None,
    }
}

/// True when `s` is in a shape [`parse_timestamp`] reads directly (ISO with
/// `T`/space, `HH:MM[:SS[.f]]`, optional `Z` or — with seconds — `±HH:MM`).
/// Such text is never rewritten. A plain byte check: cheap enough to run on
/// every row of an ISO file.
fn is_plain_iso(s: &str) -> bool {
    let b = s.as_bytes();
    let dig = |r: std::ops::Range<usize>| b.len() >= r.end && b[r].iter().all(u8::is_ascii_digit);
    if !(b.len() >= 16
        && dig(0..4)
        && b[4] == b'-'
        && dig(5..7)
        && b[7] == b'-'
        && dig(8..10)
        && (b[10] == b'T' || b[10] == b' ')
        && dig(11..13)
        && b[13] == b':'
        && dig(14..16))
    {
        return false;
    }
    let mut i = 16;
    let mut has_secs = false;
    if b.get(i) == Some(&b':') {
        if !dig(i + 1..i + 3) {
            return false;
        }
        i += 3;
        has_secs = true;
        if b.get(i) == Some(&b'.') {
            let start = i + 1;
            i = start;
            while b.get(i).is_some_and(u8::is_ascii_digit) {
                i += 1;
            }
            if i == start {
                return false;
            }
        }
    }
    match b.get(i) {
        None => true,
        Some(b'Z') | Some(b'z') => i + 1 == b.len(),
        Some(b'+') | Some(b'-') => {
            has_secs && b.len() == i + 6 && dig(i + 1..i + 3) && b[i + 3] == b':' && dig(i + 4..i + 6)
        }
        _ => false,
    }
}

/// Split a non-ISO timestamp into fields, or `None` when it is not one of
/// the known shapes. Field ranges (month ≤ 12, real calendar day) are NOT
/// checked yet: that depends on the file's day/month order.
fn parse_loose(raw: &str) -> Option<LooseTs> {
    let converted;
    let mut s = raw.trim();
    if !s.is_ascii() {
        converted = thai_digits_to_ascii(s);
        s = converted.as_str().trim();
    }
    // JS `Date.toString()`: `… GMT+0700 (Indochina Time)` — drop the comment.
    if let Some(i) = s.find('(') {
        s = s[..i].trim_end();
    }

    const MAX_TOKENS: usize = 10;
    let mut toks: [&str; MAX_TOKENS] = [""; MAX_TOKENS];
    let mut n = 0usize;
    let mut thai_marker = false;
    for (k, tok) in s.split_whitespace().enumerate() {
        let tok = tok.trim_end_matches(',');
        if tok.is_empty() {
            continue;
        }
        // Words that carry no date information.
        if tok == "น." || tok == "น" {
            thai_marker = true;
            continue;
        }
        if matches!(tok, "เวลา" | "พ.ศ." | "ค.ศ.") || tok.eq_ignore_ascii_case("at") {
            continue;
        }
        if k == 0 && is_weekday(tok) {
            continue;
        }
        if n == MAX_TOKENS {
            return None;
        }
        toks[n] = tok;
        n += 1;
    }
    let mut toks = &mut toks[..n];
    // Trailing time zone / meridiem tokens (in either order).
    let mut meridiem: Option<bool> = None;
    loop {
        match toks.last() {
            Some(t) if is_zone_token(t) => {}
            Some(t) if meridiem.is_none() && meridiem_of(t).is_some() => meridiem = meridiem_of(t),
            _ => break,
        }
        let len = toks.len();
        toks = &mut toks[..len - 1];
    }
    // `asctime`: `Jan 01 13:05:00 2025` → `Jan 01 2025 13:05:00`.
    if toks.len() == 4 && toks[2].contains(':') && toks[3].len() == 4 {
        toks.swap(2, 3);
    }

    // Take the time token off the end.
    let (date_toks, time_tok): (&[&str], Option<&str>) = match &*toks {
        [] => return None,
        [one] => {
            let b = one.as_bytes();
            if let Some(i) = (1..b.len().saturating_sub(1)).find(|&i| {
                (b[i] == b'T' || b[i] == b't') && b[i - 1].is_ascii_digit() && b[i + 1].is_ascii_digit()
            }) {
                // `20250131T130500`, `2025-01-31T130500`, `2025-01-31t13:05:00`
                let (d, t) = (&one[..i], &one[i + 1..]);
                return finish(parse_date_tokens(&[d])?, Some(t), meridiem, thai_marker);
            }
            if (b.len() == 12 || b.len() == 14) && b.iter().all(u8::is_ascii_digit) {
                // `202501311305`, `20250131130500`
                return finish(parse_date_token(&one[..8])?, Some(&one[8..]), meridiem, thai_marker);
            }
            (&toks[..], None)
        }
        [.., last] if last.contains(':') || (thai_marker && last.contains('.') && toks.len() > 1) => {
            let k = toks.len() - 1;
            (&toks[..k], Some(toks[k]))
        }
        [_, t] if matches!(t.len(), 4 | 6) && t.bytes().all(|c| c.is_ascii_digit()) => {
            // `20250131 130500`, `2025-01-31 1305`
            (&toks[..1], Some(*t))
        }
        _ => (&toks[..], None),
    };
    finish(parse_date_tokens(date_toks)?, time_tok, meridiem, thai_marker)
}

/// Combine a parsed date with an optional time token.
fn finish(
    (date, two_digit_year): (LooseDate, bool),
    time_tok: Option<&str>,
    meridiem: Option<bool>,
    thai: bool,
) -> Option<LooseTs> {
    let (h, mi, s, frac, frac_len) = match time_tok {
        Some(t) => parse_clock(t, meridiem, thai)?,
        None if meridiem.is_some() => return None,
        None => (0, 0, 0, 0, 0),
    };
    Some(LooseTs { date, h, mi, s, frac, frac_len, two_digit_year })
}

/// [`parse_loose`] for rows that need a rewrite: text `parse_timestamp`
/// already reads ([`is_plain_iso`]) is left alone.
fn loose_of(s: &str) -> Option<LooseTs> {
    if is_plain_iso(s) {
        None
    } else {
        parse_loose(s)
    }
}

impl LooseTs {
    /// (year as written, month, day) under `order`.
    fn ymd(&self, order: DayMonthOrder) -> (i32, u32, u32) {
        match self.date {
            LooseDate::YearFirst { y, m, d }
            | LooseDate::Compact { y, m, d }
            | LooseDate::Named { y, m, d, .. } => (y, m, d),
            LooseDate::YearLast { a, b, y } => match order {
                DayMonthOrder::MonthFirst => (y, a, b),
                DayMonthOrder::DayFirst => (y, b, a),
            },
        }
    }

    /// The instant under `order`, validated against the calendar with the
    /// Buddhist-Era year already corrected (BE 2567-02-29 is a real day).
    fn to_naive(self, order: DayMonthOrder) -> Option<chrono::NaiveDateTime> {
        let (y, m, d) = self.ymd(order);
        let ce = if y >= 2400 { y - 543 } else { y };
        let nanos = self.frac * 10u32.pow(9 - self.frac_len as u32);
        chrono::NaiveDate::from_ymd_opt(ce, m, d)?.and_hms_nano_opt(self.h, self.mi, self.s, nanos)
    }

    /// `YYYY-MM-DD HH:MM:SS[.f]` (year as written), or `None` when the date
    /// does not exist under `order` (e.g. `2/30/2026`, `13/13/2026`).
    fn to_iso_text(self, order: DayMonthOrder) -> Option<String> {
        self.to_naive(order)?;
        let (y, m, d) = self.ymd(order);
        let mut out = format!(
            "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
            y, m, d, self.h, self.mi, self.s
        );
        if self.frac_len > 0 {
            out.push_str(&format!(".{:0w$}", self.frac, w = self.frac_len as usize));
        }
        Some(out)
    }

    /// Which info line describes this row (`None` for year-last rows, which
    /// get the day/month order line instead).
    fn family(&self) -> Option<Family> {
        match self.date {
            LooseDate::YearLast { .. } => None,
            LooseDate::YearFirst { .. } => Some(Family::YearFirst),
            LooseDate::Compact { .. } => Some(Family::Compact),
            LooseDate::Named { style, .. } => Some(Family::Named(style)),
        }
    }
}

/// The unambiguous shape families, for the per-file info line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Family {
    YearFirst,
    Compact,
    Named(NameStyle),
}

const FAMILIES: [Family; 6] = [
    Family::YearFirst,
    Family::Compact,
    Family::Named(NameStyle::DayFirst),
    Family::Named(NameStyle::MonthFirst),
    Family::Named(NameStyle::YearFirst),
    Family::Named(NameStyle::Thai),
];

fn family_index(f: Family) -> usize {
    FAMILIES.iter().position(|&x| x == f).unwrap_or(0)
}

/// Evidence about a file's non-ISO rows (pass 1 of
/// [`normalize_file_timestamps`]).
#[derive(Default, Clone, Copy)]
struct OrderEvidence {
    /// Rows in the `A/B/YYYY` shape.
    year_last: usize,
    /// Rows where only the day-first reading is possible (`A > 12 ≥ B`).
    day_first: usize,
    /// Rows where only the month-first reading is possible (`B > 12 ≥ A`).
    month_first: usize,
    /// Some year-last row has `A != B` (otherwise both readings are equal).
    differ: bool,
    /// Some year-last row wrote a 2-digit year.
    year_last_two_digit: bool,
    /// Rows per unambiguous family (index = [`family_index`]).
    families: [usize; 6],
    /// Per family: some row wrote a 2-digit year.
    family_two_digit: [bool; 6],
}

impl OrderEvidence {
    fn add(mut self, l: &LooseTs) -> Self {
        if let LooseDate::YearLast { a, b, .. } = l.date {
            self.year_last += 1;
            if a > 12 && b <= 12 {
                self.day_first += 1;
            }
            if b > 12 && a <= 12 {
                self.month_first += 1;
            }
            self.differ |= a != b;
            self.year_last_two_digit |= l.two_digit_year;
        }
        if let Some(f) = l.family() {
            let i = family_index(f);
            self.families[i] += 1;
            self.family_two_digit[i] |= l.two_digit_year;
        }
        self
    }
    fn merge(mut self, o: Self) -> Self {
        self.year_last += o.year_last;
        self.day_first += o.day_first;
        self.month_first += o.month_first;
        self.differ |= o.differ;
        self.year_last_two_digit |= o.year_last_two_digit;
        for i in 0..FAMILIES.len() {
            self.families[i] += o.families[i];
            self.family_two_digit[i] |= o.family_two_digit[i];
        }
        self
    }
}

/// How well the rows sit in time when the year-last dates are read with
/// `order`: (backwards steps between consecutive readable rows in file
/// order, total size of all steps in seconds). Smaller is more plausible:
/// a sensor log runs forwards in small regular steps, so the wrong reading
/// either steps backwards or jumps by weeks (`1/1 23:55` → `1/2 0:00` is
/// 5 minutes as month/day but a month as day/month — in order both ways).
fn order_fit(timestamps: &[Option<String>], order: DayMonthOrder) -> (usize, u128) {
    let mut prev: Option<chrono::NaiveDateTime> = None;
    let mut back = 0usize;
    let mut travel = 0u128;
    for t in timestamps.iter().flatten() {
        let cur = match loose_of(t) {
            Some(l) => l.to_naive(order),
            None => parse_timestamp(t),
        };
        if let Some(cur) = cur {
            if let Some(p) = prev {
                if cur < p {
                    back += 1;
                }
                travel += (cur - p).num_seconds().unsigned_abs() as u128;
            }
            prev = Some(cur);
        }
    }
    (back, travel)
}

/// Appended inside a warning's example brackets when 2-digit years were read.
const TWO_DIGIT_NOTE: &str = ", 2-digit year read as 20YY";
/// The same for a Thai month-name file (2-digit years there are BE).
const TWO_DIGIT_NOTE_THAI: &str = ", 2-digit year read as พ.ศ. 25YY";

fn order_name(order: DayMonthOrder) -> &'static str {
    match order {
        DayMonthOrder::MonthFirst => "month/day/year",
        DayMonthOrder::DayFirst => "day/month/year",
    }
}

/// How the info line names an unambiguous family.
fn family_description(f: Family) -> &'static str {
    match f {
        Family::YearFirst => "year-month-day",
        Family::Compact => "compact year-month-day digits",
        Family::Named(NameStyle::DayFirst) => "day-month-year with month names",
        Family::Named(NameStyle::MonthFirst) => "month-day-year with month names",
        Family::Named(NameStyle::YearFirst) => "year-month-day with month names",
        Family::Named(NameStyle::Thai) => "day-month-year with Thai month names",
    }
}

/// The date part (before the first space) of a raw timestamp.
fn date_part_of(s: &str) -> &str {
    let s = s.trim();
    s.split_whitespace().next().unwrap_or(s)
}

// ── Numeric timestamp columns (Excel serial dates, Unix epochs) ────────────

/// What an all-numeric timestamp column holds — decided per FILE.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SerialKind {
    /// Excel 1900 date system: days since 1899-12-30 (this epoch absorbs
    /// Excel's fictitious 1900-02-29 for every serial ≥ 61), fraction = time
    /// of day, rounded to the nearest second (Excel stores float noise).
    Excel,
    /// Seconds since 1970-01-01 UTC (10 integer digits).
    EpochSeconds,
    /// Milliseconds since 1970-01-01 UTC (13 integer digits).
    EpochMillis,
}

/// `123`, `123.45` (digits, at most one `.`, a digit before it).
fn plain_number(s: &str) -> Option<(&str, &str)> {
    let s = s.trim();
    let (int, frac) = s.split_once('.').unwrap_or((s, ""));
    (!int.is_empty()
        && int.bytes().all(|b| b.is_ascii_digit())
        && frac.bytes().all(|b| b.is_ascii_digit()))
    .then_some((int, frac))
}

/// Excel serial range accepted: 20000 (1954-10-03) ..= 80000 (2119-01-10).
const EXCEL_SERIAL_RANGE: std::ops::RangeInclusive<f64> = 20000.0..=80000.0;

fn serial_kind_of(s: &str) -> Option<SerialKind> {
    let (int, _) = plain_number(s)?;
    match int.len() {
        5 => s.trim().parse::<f64>().ok().filter(|v| EXCEL_SERIAL_RANGE.contains(v)).map(|_| SerialKind::Excel),
        10 => Some(SerialKind::EpochSeconds),
        13 => Some(SerialKind::EpochMillis),
        _ => None,
    }
}

/// One numeric value → `YYYY-MM-DD HH:MM:SS[.f]` under `kind`.
fn serial_to_iso(s: &str, kind: SerialKind) -> Option<String> {
    if serial_kind_of(s)? != kind {
        return None;
    }
    let (int, frac) = plain_number(s)?;
    let dt = match kind {
        SerialKind::Excel => {
            let v: f64 = s.trim().parse().ok()?;
            let days = v.floor();
            let mut secs = ((v - days) * 86_400.0).round() as i64;
            let mut days = days as i64;
            if secs >= 86_400 {
                days += 1;
                secs -= 86_400;
            }
            let base = chrono::NaiveDate::from_ymd_opt(1899, 12, 30)?.and_hms_opt(0, 0, 0)?;
            return Some(
                (base + chrono::Duration::days(days) + chrono::Duration::seconds(secs))
                    .format("%Y-%m-%d %H:%M:%S")
                    .to_string(),
            );
        }
        SerialKind::EpochSeconds => chrono::DateTime::from_timestamp(int.parse().ok()?, 0)?.naive_utc(),
        SerialKind::EpochMillis => {
            chrono::DateTime::from_timestamp_millis(int.parse().ok()?)?.naive_utc()
        }
    };
    let mut out = dt.format("%Y-%m-%d %H:%M:%S").to_string();
    match kind {
        SerialKind::EpochMillis => {
            let ms = dt.and_utc().timestamp_subsec_millis();
            if ms != 0 || !frac.is_empty() {
                out.push_str(&format!(".{:03}{}", ms, frac));
            }
        }
        _ if !frac.is_empty() && frac.len() <= 9 => out.push_str(&format!(".{}", frac)),
        _ => {}
    }
    Some(out)
}

/// When EVERY timestamp of the file is a plain number that is not a compact
/// `YYYYMMDD…` date, read the column as Excel serials or Unix epochs (kind
/// chosen from the first readable rows) and return the warnings; `None` when
/// the column is not like that (the text path then handles it).
fn normalize_serial_column(file_name: &str, timestamps: &mut [Option<String>]) -> Option<Vec<String>> {
    let all_numeric = timestamps
        .par_iter()
        .flatten()
        .all(|s| plain_number(s).is_some_and(|(int, _)| !matches!(int.len(), 8 | 12 | 14)));
    if !all_numeric {
        return None;
    }
    // Decide from a sample: the most common kind among the first 1000 rows.
    let mut counts = [0usize; 3];
    for s in timestamps.iter().flatten().take(1000) {
        match serial_kind_of(s) {
            Some(SerialKind::Excel) => counts[0] += 1,
            Some(SerialKind::EpochSeconds) => counts[1] += 1,
            Some(SerialKind::EpochMillis) => counts[2] += 1,
            None => {}
        }
    }
    let best = (0..3).max_by_key(|&i| (counts[i], std::cmp::Reverse(i)))?;
    if counts[best] == 0 {
        return None;
    }
    let kind = [SerialKind::Excel, SerialKind::EpochSeconds, SerialKind::EpochMillis][best];
    let example = timestamps
        .iter()
        .flatten()
        .find_map(|s| serial_to_iso(s, kind).map(|iso| (s.trim().to_string(), iso)));
    let unreadable = AtomicUsize::new(0);
    timestamps.par_iter_mut().for_each(|t| {
        let Some(s) = t.as_deref() else { return };
        match serial_to_iso(s, kind) {
            Some(iso) => *t = Some(iso),
            None => {
                unreadable.fetch_add(1, Ordering::Relaxed);
            }
        }
    });
    let what = match kind {
        SerialKind::Excel => "Excel serial dates",
        SerialKind::EpochSeconds => "Unix epoch seconds (UTC)",
        SerialKind::EpochMillis => "Unix epoch milliseconds (UTC)",
    };
    let mut warnings = Vec::new();
    let mut w = format!("Times in {} read as {}", file_name, what);
    if let Some((raw, iso)) = example {
        w.push_str(&format!(" ({} → {})", raw, iso));
    }
    warnings.push(w);
    let unreadable = unreadable.into_inner();
    if unreadable > 0 {
        warnings.push(unreadable_warning(unreadable, file_name));
    }
    Some(warnings)
}

fn unreadable_warning(n: usize, file_name: &str) -> String {
    format!("{} timestamp(s) in {} could not be read as a date and time", n, file_name)
}

/// Rewrite one file's non-ISO timestamps to ISO text in place and return the
/// load-report warnings this produced (empty for a file whose timestamps are
/// all in a shape `parse_timestamp` reads — those are never touched).
///
/// - An all-numeric column → Excel serials / Unix epochs
///   ([`normalize_serial_column`]).
/// - Day/month order of `A/B/YYYY` is decided for the WHOLE file: some
///   `A > 12` → day/month; some `B > 12` → month/day; both → the file
///   contradicts itself: every year-last row is left unreadable
///   ([`TS_MISSING`]) and a warning says so; neither → the reading with fewer
///   backwards steps between consecutive readable rows wins, then the one
///   whose rows sit closer together ([`order_fit`]); a full tie → month/day
///   (Excel's default), flagged as a guess.
/// - Every other shape is unambiguous; one info line names the file's main
///   one with an example.
///
/// A row that cannot be read (unknown shape, or a date that does not exist,
/// e.g. `2/30/2026`) keeps its original text and so becomes [`TS_MISSING`];
/// those rows are counted in their own warning.
pub(crate) fn normalize_file_timestamps(
    file_name: &str,
    timestamps: &mut [Option<String>],
) -> Vec<String> {
    // Cheap exit for the common ISO file: a byte-shape check per row, and
    // `any` stops at the first row that is not plain ISO.
    if !timestamps
        .par_iter()
        .any(|t| t.as_deref().is_some_and(|s| !is_plain_iso(s)))
    {
        return Vec::new();
    }
    if let Some(w) = normalize_serial_column(file_name, timestamps) {
        return w;
    }

    let ev = timestamps
        .par_iter()
        .filter_map(|t| t.as_deref().and_then(loose_of))
        .fold(OrderEvidence::default, |acc, l| acc.add(&l))
        .reduce(OrderEvidence::default, OrderEvidence::merge);

    let mut warnings = Vec::new();
    let conflict = ev.day_first > 0 && ev.month_first > 0;
    let (order, guessed) = if conflict || ev.day_first == 0 && ev.month_first == 0 {
        if conflict || ev.year_last == 0 || !ev.differ {
            // Conflict: order unused for year-last rows. No year-last rows,
            // or every A == B: both readings are the same — nothing to guess.
            (DayMonthOrder::MonthFirst, false)
        } else {
            let mf = order_fit(timestamps, DayMonthOrder::MonthFirst);
            let df = order_fit(timestamps, DayMonthOrder::DayFirst);
            if df < mf {
                (DayMonthOrder::DayFirst, false)
            } else {
                (DayMonthOrder::MonthFirst, df == mf)
            }
        }
    } else if ev.day_first > 0 {
        (DayMonthOrder::DayFirst, false)
    } else {
        (DayMonthOrder::MonthFirst, false)
    };

    if conflict {
        let example = |want_day_first: bool| {
            timestamps
                .iter()
                .flatten()
                .find(|t| {
                    matches!(loose_of(t).map(|l| l.date), Some(LooseDate::YearLast { a, b, .. })
                        if if want_day_first { a > 12 && b <= 12 } else { b > 12 && a <= 12 })
                })
                .map(|t| date_part_of(t).to_string())
                .unwrap_or_default()
        };
        warnings.push(format!(
            "Dates in {} mix day/month/year ({}) and month/day/year ({}) — the order cannot be decided, so {} row(s) with a year-last date could not be read",
            file_name,
            example(true),
            example(false),
            ev.year_last
        ));
    }

    // Example for the order warning, taken from the ORIGINAL text (pass 2
    // overwrites it): the first readable year-last row, preferring one with
    // A != B (it shows which number became the month). Output shown in CE.
    let example = if ev.year_last > 0 && !conflict {
        let mut first: Option<(String, String)> = None;
        let mut telling: Option<(String, String)> = None;
        for s in timestamps.iter().flatten() {
            let Some(l) = loose_of(s) else { continue };
            let LooseDate::YearLast { a, b, .. } = l.date else { continue };
            let Some(iso) = l.to_iso_text(order) else { continue };
            let shown = normalize_buddhist_era(iso[..10].to_string());
            let pair = (date_part_of(s).to_string(), shown);
            if a != b {
                telling = Some(pair);
                break;
            }
            if first.is_none() {
                first = Some(pair);
            }
        }
        telling.or(first)
    } else {
        None
    };
    // The file's main unambiguous family and its first readable row, shown
    // whole (raw → rewritten text, year in CE).
    let main_family = (0..FAMILIES.len())
        .filter(|&i| ev.families[i] > 0)
        .max_by_key(|&i| (ev.families[i], std::cmp::Reverse(i)));
    let family_example = main_family.and_then(|i| {
        timestamps.iter().flatten().find_map(|s| {
            let l = loose_of(s)?;
            if l.family() != Some(FAMILIES[i]) {
                return None;
            }
            let iso = l.to_iso_text(order)?;
            Some((s.trim().to_string(), normalize_buddhist_era(iso)))
        })
    });

    // Pass 2: rewrite in place. Rows left alone (conflict / impossible date /
    // unknown shape) keep their original text, which `parse_timestamp` does
    // not read.
    let unreadable = AtomicUsize::new(0);
    timestamps.par_iter_mut().for_each(|t| {
        let Some(s) = t.as_deref() else { return };
        if is_plain_iso(s) {
            return;
        }
        let Some(l) = parse_loose(s) else {
            unreadable.fetch_add(1, Ordering::Relaxed);
            return;
        };
        if conflict && matches!(l.date, LooseDate::YearLast { .. }) {
            return; // counted in the conflict line
        }
        match l.to_iso_text(order) {
            Some(iso) => *t = Some(iso),
            None => {
                unreadable.fetch_add(1, Ordering::Relaxed);
            }
        }
    });

    if ev.year_last > 0 && !conflict {
        let mut w = format!("Dates in {} read as {}", file_name, order_name(order));
        if let Some((raw, shown)) = example {
            let yy = if ev.year_last_two_digit { TWO_DIGIT_NOTE } else { "" };
            w.push_str(&format!(" ({} → {}{})", raw, shown, yy));
        }
        if guessed {
            w.push_str(" — could not be told apart from the values; check the dates");
        }
        warnings.push(w);
    }
    if let (Some(i), Some((raw, shown))) = (main_family, family_example) {
        let yy = match (ev.family_two_digit[i], FAMILIES[i]) {
            (false, _) => "",
            (true, Family::Named(NameStyle::Thai)) => TWO_DIGIT_NOTE_THAI,
            (true, _) => TWO_DIGIT_NOTE,
        };
        warnings.push(format!(
            "Dates in {} read as {} ({} → {}{})",
            file_name,
            family_description(FAMILIES[i]),
            raw,
            shown,
            yy
        ));
    }
    let unreadable = unreadable.into_inner();
    if unreadable > 0 {
        warnings.push(unreadable_warning(unreadable, file_name));
    }
    warnings
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CsvMetadata {
    pub headers: Vec<String>,
    pub total_rows: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SensorMetadata {
    pub tag: String,
    pub description: String,
    pub unit: String,
    pub component: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ColumnInfo {
    pub name: String,
    pub dtype: String,
    pub null_count: usize,
    pub valid_count: usize,
}

/// Per-file facts shown on the Prepare-dataset step (one entry per file given
/// to `load_csv`, in the order given). Every time is read with the SAME
/// parser as `ts_parsed` and AFTER Buddhist-Era -> CE normalisation; a value
/// that cannot be computed (no parseable timestamp in the file) is `None`,
/// never a placeholder.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct CsvFileInfo {
    /// File name only (no directory).
    pub name: String,
    pub size_bytes: u64,
    /// Data rows read from THIS file (before the cross-file merge drops
    /// rows without a timestamp / folds duplicate timestamps).
    pub rows: usize,
    /// Earliest / latest timestamp in this file, `"YYYY-MM-DD HH:MM:SS"`.
    #[serde(default)]
    pub start: Option<String>,
    #[serde(default)]
    pub end: Option<String>,
    /// The same instants as epoch-microseconds (for drawing a coverage bar).
    #[serde(default)]
    pub start_micros: Option<i64>,
    #[serde(default)]
    pub end_micros: Option<i64>,
}

/// Stage of a `csv-load-progress` event.
#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CsvLoadStage {
    Reading,
    Merging,
    Done,
}

/// Payload of the `csv-load-progress` event `load_csv` emits.
///
/// `reading` is sent twice per file: when it starts (`files_done == file_index`)
/// and when it has finished (`files_done == file_index + 1`). `merging` and
/// `done` carry `file_index == file_count`, `files_done == file_count`.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct CsvLoadProgress {
    /// 0-based index of the file this event is about (`file_count` for
    /// `merging` / `done`).
    pub file_index: usize,
    pub file_count: usize,
    /// File name only (empty for `merging` / `done`).
    pub file_name: String,
    pub stage: CsvLoadStage,
    /// How many files have been completely read when this event was sent.
    pub files_done: usize,
}

impl CsvLoadProgress {
    fn reading(file_index: usize, file_count: usize, file_name: &str, finished: bool) -> Self {
        CsvLoadProgress {
            file_index,
            file_count,
            file_name: file_name.to_string(),
            stage: CsvLoadStage::Reading,
            files_done: if finished { file_index + 1 } else { file_index },
        }
    }

    /// The `merging` event (`done == false`) or the final `done` event.
    pub fn after_reading(file_count: usize, done: bool) -> Self {
        CsvLoadProgress {
            file_index: file_count,
            file_count,
            file_name: String::new(),
            stage: if done { CsvLoadStage::Done } else { CsvLoadStage::Merging },
            files_done: file_count,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct CsvLoadReport {
    pub headers: Vec<String>,
    pub total_rows: usize,
    pub columns: Vec<ColumnInfo>,
    pub warnings: Vec<String>,
    /// Per-file info, in the order the files were given (JSON `files`).
    #[serde(default)]
    pub files: Vec<CsvFileInfo>,
    /// Earliest / latest valid timestamp of the MERGED dataset
    /// (`"YYYY-MM-DD HH:MM:SS"`, plus the same instants as epoch-microseconds).
    /// `None` when no row has a parseable timestamp.
    #[serde(default)]
    pub period_start: Option<String>,
    #[serde(default)]
    pub period_end: Option<String>,
    #[serde(default)]
    pub period_start_micros: Option<i64>,
    #[serde(default)]
    pub period_end_micros: Option<i64>,
    /// Typical sampling interval in seconds: the median of the positive
    /// consecutive differences of the merged, sorted timestamps (deterministic
    /// stride sample when there are millions of rows). `None` with < 2 valid
    /// timestamps or no positive difference.
    #[serde(default)]
    pub interval_seconds: Option<f64>,
    /// Empty (NaN) cells / (rows x sensor columns, timestamp column excluded)
    /// x 100, in 0..=100. `None` when there are no rows or no sensor column.
    #[serde(default)]
    pub missing_percent: Option<f64>,
    /// Session generation created by the `load_csv` call that returned this
    /// report (JSON field `generation`). `build_load_report` leaves it 0;
    /// `load_csv` stamps the real value once the dataset is installed. A caller
    /// bound to this dataset passes it back as `expectedGeneration` on the
    /// special-sensor commands so a stale window can't mutate a newer dataset.
    #[serde(default)]
    pub generation: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MappingData {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MappingResult {
    pub matched: Vec<String>,
    pub not_in_dataset: Vec<String>,
    pub not_in_mapping: Vec<String>,
}

use rayon::prelude::*;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};

/// Result of reading a single CSV, including parse failure tracking.
///
/// `data.ts_parsed` is left EMPTY at this stage — the merge step may drop,
/// reorder, or fold rows, so the (parallel) timestamp parse happens once,
/// at the end of the merge, via [`ColumnarData::from_parts`].
pub struct ReadCsvResult {
    pub data: ColumnarData,
    /// Per-column count of non-empty fields that failed to parse as f64.
    /// Indexed by column position in headers (includes timestamp column position).
    pub parse_fail_counts: Vec<usize>,
    /// File size in bytes, as checked against [`MAX_CSV_BYTES`].
    pub size_bytes: u64,
}

/// A header name as the app uses it: surrounding whitespace and any UTF-8
/// byte-order mark (`\u{FEFF}`, written by Excel/historians at the start of
/// the file and so glued to the FIRST header) removed. Without this a
/// `\u{FEFF}TimeStamp` column is not recognised as the timestamp column.
fn clean_header(s: &str) -> String {
    s.trim_matches(|c: char| c == '\u{FEFF}' || c.is_whitespace())
        .to_string()
}

pub fn read_csv_with_stats(path: &str) -> Result<ReadCsvResult, String> {
    let total_start = Instant::now();
    // Refuse pathologically-large CSVs up front so we don't OOM partway
    // through the parse. `std::fs::metadata` follows symlinks, which is
    // what we want — we want the size of what we'd actually open.
    let size = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    if size > MAX_CSV_BYTES {
        let size_gb = size as f64 / (1024.0 * 1024.0 * 1024.0);
        return Err(format!(
            "CSV file too large: {:.1} GB (max 2 GB). Pre-process or split the file.",
            size_gb
        ));
    }
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut rdr = csv::Reader::from_reader(BufReader::new(file));

    let headers = rdr.headers().map_err(|e| e.to_string())?.clone();
    let header_list: Vec<String> = headers.iter().map(clean_header).collect();
    let num_cols = header_list.len();

    let timestamp_idx = header_list
        .iter()
        .position(|h| h.eq_ignore_ascii_case("timestamp") || h.eq_ignore_ascii_case("time"));

    // Pre-size the column vecs from file size / approx bytes-per-row so
    // they don't repeatedly reallocate (and memcpy the whole spine) while
    // ingesting millions of records; clamp so a pathological (very-few-
    // column) file can't over-allocate.
    let bytes_per_row_est = (num_cols * 8 + 20).max(1);
    let est_rows = (size as usize / bytes_per_row_est).clamp(1024, 16_000_000);

    let mut timestamps: Vec<Option<String>> = Vec::with_capacity(est_rows);
    let mut columns: Vec<Vec<f64>> = (0..num_cols)
        .map(|_| Vec::with_capacity(est_rows))
        .collect();
    let fail_counters: Vec<AtomicUsize> = (0..num_cols).map(|_| AtomicUsize::new(0)).collect();

    // Read + parse in bounded batches: at most BATCH_ROWS raw ByteRecords
    // are alive at any moment. (The previous implementation buffered the
    // ENTIRE file as ByteRecords before parsing — a whole extra file-size
    // of transient RAM on a 2 GB CSV.) Each batch is split into chunks
    // parsed to columnar blocks in parallel, then appended in order.
    const BATCH_ROWS: usize = 65_536;
    const PAR_CHUNK: usize = 4_096;

    /// One parsed chunk: its timestamps + its slice of every column.
    type ColumnarBlock = (Vec<Option<String>>, Vec<Vec<f64>>);

    let mut batch: Vec<csv::ByteRecord> = Vec::with_capacity(BATCH_ROWS);
    let mut record = csv::ByteRecord::new();
    let mut eof = false;
    let mut io_time = std::time::Duration::ZERO;
    let mut parse_time = std::time::Duration::ZERO;

    while !eof {
        batch.clear();
        let io_start = Instant::now();
        while batch.len() < BATCH_ROWS {
            if rdr
                .read_byte_record(&mut record)
                .map_err(|e| e.to_string())?
            {
                batch.push(record.clone());
            } else {
                eof = true;
                break;
            }
        }
        io_time += io_start.elapsed();
        if batch.is_empty() {
            break;
        }

        let parse_start = Instant::now();
        let blocks: Vec<ColumnarBlock> = batch
            .par_chunks(PAR_CHUNK)
            .map(|chunk| {
                let mut ts_blk: Vec<Option<String>> = Vec::with_capacity(chunk.len());
                let mut col_blk: Vec<Vec<f64>> = (0..num_cols)
                    .map(|_| Vec::with_capacity(chunk.len()))
                    .collect();
                for rec in chunk {
                    let mut ts: Option<String> = None;
                    for (c, col) in col_blk.iter_mut().enumerate() {
                        let field_str = rec
                            .get(c)
                            .map(|f| std::str::from_utf8(f).unwrap_or(""))
                            .unwrap_or("");
                        if Some(c) == timestamp_idx {
                            if !field_str.trim().is_empty() {
                                ts = Some(field_str.to_string());
                            }
                            col.push(f64::NAN);
                        } else {
                            let trimmed = field_str.trim();
                            if trimmed.is_empty() {
                                col.push(f64::NAN);
                            } else {
                                match trimmed.parse::<f64>() {
                                    Ok(v) => col.push(v),
                                    Err(_) => {
                                        fail_counters[c].fetch_add(1, Ordering::Relaxed);
                                        col.push(f64::NAN);
                                    }
                                }
                            }
                        }
                    }
                    ts_blk.push(ts);
                }
                (ts_blk, col_blk)
            })
            .collect();

        for (ts_blk, col_blk) in blocks {
            timestamps.extend(ts_blk);
            for (c, blk) in col_blk.into_iter().enumerate() {
                columns[c].extend_from_slice(&blk);
            }
        }
        parse_time += parse_start.elapsed();
    }

    println!("Reading raw bytes took: {:?}", io_time);
    println!("Parallel parsing took: {:?}", parse_time);
    println!("Total read_csv took: {:?}", total_start.elapsed());

    let parse_fail_counts: Vec<usize> = fail_counters
        .iter()
        .map(|c| c.load(Ordering::Relaxed))
        .collect();

    Ok(ReadCsvResult {
        data: ColumnarData {
            headers: header_list,
            timestamps,
            ts_parsed: Vec::new(), // filled post-merge by from_parts
            columns,
            // Never read on this pre-merge value: the merge rebuilds the
            // dataset through `from_parts`, with a cache of its own.
            sample_interval: std::sync::OnceLock::new(),
        },
        parse_fail_counts,
        size_bytes: size,
    })
}

/// Extended merge result including warnings and per-column parse failure info.
pub struct MergeResult {
    pub data: ColumnarData,
    pub warnings: Vec<String>,
    /// Per-column (in merged header order) count of non-empty fields that failed f64 parse.
    pub parse_fail_counts: Vec<usize>,
    /// Per-file info in the order the files were given. Filled by
    /// [`read_merge_csvs_with_progress`]; empty for a hand-built result.
    pub files: Vec<CsvFileInfo>,
}

/// Parse one raw timestamp exactly as `ColumnarData::from_parts` does
/// (Buddhist-Era year corrected first), without allocating in the common
/// non-BE case.
fn parse_micros_normalized(s: &str) -> Option<i64> {
    if is_buddhist_era_year(s) {
        parse_timestamp(&normalize_buddhist_era(s.to_string())).map(ts_to_micros)
    } else {
        parse_timestamp(s).map(ts_to_micros)
    }
}

/// Min / max parsed instant (epoch micros) of a file's raw timestamps,
/// ignoring missing / unparseable ones. Parallel; used only for multi-file
/// loads (a single file's range is read off the merged `ts_parsed` instead).
fn raw_timestamp_range(timestamps: &[Option<String>]) -> Option<(i64, i64)> {
    timestamps
        .par_iter()
        .filter_map(|t| t.as_deref().and_then(parse_micros_normalized))
        .fold(
            || None::<(i64, i64)>,
            |acc, us| match acc {
                None => Some((us, us)),
                Some((lo, hi)) => Some((lo.min(us), hi.max(us))),
            },
        )
        .reduce(
            || None,
            |a, b| match (a, b) {
                (None, x) | (x, None) => x,
                (Some((l1, h1)), Some((l2, h2))) => Some((l1.min(l2), h1.max(h2))),
            },
        )
}

/// `"YYYY-MM-DD HH:MM:SS"` for an epoch-microsecond instant.
fn format_micros(us: i64) -> Option<String> {
    micros_to_naive(us).map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
}

fn file_info(name: String, size_bytes: u64, rows: usize, range: Option<(i64, i64)>) -> CsvFileInfo {
    CsvFileInfo {
        name,
        size_bytes,
        rows,
        start: range.and_then(|(lo, _)| format_micros(lo)),
        end: range.and_then(|(_, hi)| format_micros(hi)),
        start_micros: range.map(|(lo, _)| lo),
        end_micros: range.map(|(_, hi)| hi),
    }
}

fn file_name_only(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

pub fn read_merge_csvs_with_report(paths: Vec<String>) -> Result<MergeResult, String> {
    read_merge_csvs_with_progress(paths, &|_| {})
}

/// [`read_merge_csvs_with_report`] that also reports progress through
/// `on_progress` (`reading` start/finish per file, then `merging`; the final
/// `done` is sent by the caller once the dataset is installed). The callback
/// must never be able to fail the load, so it returns nothing.
pub fn read_merge_csvs_with_progress(
    paths: Vec<String>,
    on_progress: &dyn Fn(CsvLoadProgress),
) -> Result<MergeResult, String> {
    if paths.is_empty() {
        return Err("No file paths provided".to_string());
    }

    let mut warnings: Vec<String> = Vec::new();
    let file_count = paths.len();

    // 1. Read all files individually (with stats)
    let mut results = Vec::new();
    let mut files: Vec<CsvFileInfo> = Vec::with_capacity(file_count);
    let mut date_warnings: Vec<String> = Vec::new();
    for (i, path) in paths.iter().enumerate() {
        let name = file_name_only(path);
        on_progress(CsvLoadProgress::reading(i, file_count, &name, false));
        let mut r = read_csv_with_stats(path)?;
        // Non-ISO shapes (`1/2/2026 0:05`, `2026/01/02 …`) → ISO text, per
        // file and before the merge, which keys rows by timestamp TEXT.
        date_warnings.extend(normalize_file_timestamps(&name, &mut r.data.timestamps));
        // Several files: each file's own range needs its own parse (the
        // merged `ts_parsed` no longer knows which file a row came from).
        // One file: filled from the merged `ts_parsed` below, no extra pass.
        let range = if file_count > 1 {
            raw_timestamp_range(&r.data.timestamps)
        } else {
            None
        };
        files.push(file_info(name.clone(), r.size_bytes, r.data.n_rows(), range));
        results.push(r);
        on_progress(CsvLoadProgress::reading(i, file_count, &name, true));
    }

    if results.is_empty() {
        return Err("No data loaded".to_string());
    }
    on_progress(CsvLoadProgress::after_reading(file_count, false));

    // Single file → skip the cross-file timestamp merge entirely. That merge
    // rebuilds every row through a single-threaded BTreeMap (cloning the
    // timestamp key per row) — pure overhead when there's nothing to merge.
    // `merge_single_file` produces the SAME result (timestamp column first,
    // null-timestamp rows dropped, ordered by timestamp, duplicate timestamps
    // merged) but works on indices + per-column gathers — and does its own
    // Buddhist-Era detection, so skip the one below entirely on this path.
    if results.len() == 1 {
        let mut merged = merge_single_file(results.pop().unwrap());
        // The merged dataset IS this one file (rows without a timestamp are
        // not parseable anyway), so its range is the dataset's range.
        let (lo, hi) = ts_min_max(&merged.data.ts_parsed).unzip();
        if let Some(f) = files.first_mut() {
            *f = file_info(
                std::mem::take(&mut f.name),
                f.size_bytes,
                f.rows,
                lo.zip(hi),
            );
        }
        merged.files = files;
        merged.warnings.splice(0..0, date_warnings);
        return Ok(merged);
    }

    warnings.extend(date_warnings);

    // Buddhist-Era detection across every file's raw timestamps, before any
    // merge/parse step touches them — see `buddhist_era_warning`'s docstring.
    if let Some(w) = buddhist_era_warning(
        results
            .iter()
            .flat_map(|r| r.data.timestamps.iter().flatten().map(String::as_str)),
    ) {
        warnings.push(w);
    }

    // 2. The same column in several files is NOT reported: adding several files means adding
    //    more of the same data (another period), so the files share their sensors by design
    //    and their values are merged on the timestamp (user decision 2026-10-19 — the old
    //    "Duplicate column 'x' found in file 1, file 2" lines listed every shared sensor).
    //    A column that appears twice INSIDE one file is still reported: only one of the two
    //    can be kept.
    let is_timestamp =
        |h: &str| h.eq_ignore_ascii_case("timestamp") || h.eq_ignore_ascii_case("time");

    if paths.len() > 1 {
        for (file_idx, result) in results.iter().enumerate() {
            let mut seen: HashSet<String> = HashSet::new();
            let mut reported: HashSet<String> = HashSet::new();
            for h in &result.data.headers {
                if is_timestamp(h) {
                    continue;
                }
                let key = h.to_lowercase();
                if !seen.insert(key.clone()) && reported.insert(key.clone()) {
                    warnings.push(format!("Duplicate column '{}' found in file {}", key, file_idx + 1));
                }
            }
        }
    }

    // 3. Determine global headers (Superset)
    let mut global_headers: Vec<String> = Vec::new();
    let mut seen_headers: HashSet<String> = HashSet::new();

    let canonical_ts_header = results[0]
        .data
        .headers
        .iter()
        .find(|h| is_timestamp(h))
        .cloned()
        .unwrap_or_else(|| "timestamp".to_string());

    global_headers.push(canonical_ts_header.clone());
    seen_headers.insert(canonical_ts_header.clone().to_lowercase());

    for result in &results {
        for h in &result.data.headers {
            if is_timestamp(h) {
                continue;
            }
            if !seen_headers.contains(&h.to_lowercase()) {
                global_headers.push(h.clone());
                seen_headers.insert(h.to_lowercase());
            }
        }
    }
    let g = global_headers.len();

    // Build a mapping from global header name (lowercase) to global index
    let global_header_idx: HashMap<String, usize> = global_headers
        .iter()
        .enumerate()
        .map(|(i, h)| (h.to_lowercase(), i))
        .collect();

    // 4. Aggregate parse_fail_counts per global column
    let mut global_fail_counts: Vec<usize> = vec![0; g];

    for result in &results {
        for (local_idx, h) in result.data.headers.iter().enumerate() {
            let key = if is_timestamp(h) {
                canonical_ts_header.to_lowercase()
            } else {
                h.to_lowercase()
            };
            if let Some(&global_idx) = global_header_idx.get(&key) {
                if local_idx < result.parse_fail_counts.len() {
                    global_fail_counts[global_idx] += result.parse_fail_counts[local_idx];
                }
            }
        }
    }

    // 5. Merge rows — keyed by timestamp string. Staging rows are already
    // NaN-missing f64 vecs in the global layout (half the footprint of the
    // old Vec<Option<f64>> staging).
    let mut merged_map: BTreeMap<String, Vec<f64>> = BTreeMap::new();

    for result in &results {
        let ds = &result.data;
        let mut col_map: Vec<usize> = Vec::with_capacity(ds.headers.len());
        for h in &ds.headers {
            if is_timestamp(h) {
                col_map.push(0);
            } else if let Some(&pos) = global_header_idx.get(&h.to_lowercase()) {
                col_map.push(pos);
            } else {
                col_map.push(0);
            }
        }

        for r in 0..ds.n_rows() {
            if let Some(ts) = &ds.timestamps[r] {
                let entry = merged_map
                    .entry(ts.clone())
                    .or_insert_with(|| vec![f64::NAN; g]);

                for (local_idx, &global_idx) in col_map.iter().enumerate() {
                    let v = ds.columns[local_idx][r];
                    // The local timestamp column is all-NaN, so it never
                    // overwrites slot 0 — same as the old `val.is_some()` guard.
                    if !v.is_nan() {
                        entry[global_idx] = v;
                    }
                }
            }
        }
    }

    // 6. Detect duplicate timestamps
    if paths.len() > 1 {
        // Count how many files contribute each timestamp
        let mut ts_file_count: HashMap<String, usize> = HashMap::new();
        for result in &results {
            let mut seen_ts: HashSet<&str> = HashSet::new();
            for ts in result.data.timestamps.iter().flatten() {
                if seen_ts.insert(ts.as_str()) {
                    *ts_file_count.entry(ts.clone()).or_insert(0) += 1;
                }
            }
        }
        let dup_count = ts_file_count.values().filter(|&&c| c > 1).count();
        if dup_count > 0 {
            warnings.push(format!(
                "{} duplicate timestamp(s) found across files (values were merged/overwritten)",
                dup_count
            ));
        }
    }

    // 7. Convert the (timestamp-ordered) map into columnar storage.
    let n_out = merged_map.len();
    let mut out_timestamps: Vec<Option<String>> = Vec::with_capacity(n_out);
    let mut out_columns: Vec<Vec<f64>> = (0..g).map(|_| Vec::with_capacity(n_out)).collect();
    for (ts, vals) in merged_map {
        out_timestamps.push(Some(ts));
        for (c, v) in vals.into_iter().enumerate() {
            out_columns[c].push(v);
        }
    }

    println!("Merged {} files. Total rows: {}", results.len(), n_out);
    if n_out > 0 {
        println!(
            "Timestamp Range: {:?} - {:?}",
            out_timestamps.first().and_then(|t| t.as_ref()),
            out_timestamps.last().and_then(|t| t.as_ref())
        );
    }

    Ok(MergeResult {
        data: ColumnarData::from_parts(global_headers, out_timestamps, out_columns),
        warnings,
        parse_fail_counts: global_fail_counts,
        files,
    })
}

/// Single-file specialization of [`read_merge_csvs_with_report`]'s merge step.
///
/// Produces an identical `MergeResult` — timestamp column canonicalized to
/// the front, rows without a timestamp dropped, rows ordered by timestamp
/// (string order, matching the BTreeMap path), duplicate timestamps merged
/// (later non-null value wins) — but works on row INDICES and per-column
/// gathers instead of moving row payloads around. A clean, already-ordered
/// file with unique timestamps (the common case for sensor logs) passes the
/// parsed columns through without any copy at all.
fn merge_single_file(result: ReadCsvResult) -> MergeResult {
    let is_timestamp =
        |h: &str| h.eq_ignore_ascii_case("timestamp") || h.eq_ignore_ascii_case("time");

    let ReadCsvResult {
        data: ds,
        parse_fail_counts,
        ..
    } = result;

    // Computed before anything below partially moves `ds` — see
    // `buddhist_era_warning`'s docstring for why this has to run on the
    // still-original text.
    let be_warning = buddhist_era_warning(ds.timestamps.iter().flatten().map(String::as_str));

    // Global headers: the timestamp column first, then the rest in file order.
    let canonical_ts = ds
        .headers
        .iter()
        .find(|h| is_timestamp(h))
        .cloned()
        .unwrap_or_else(|| "timestamp".to_string());
    let mut global_headers: Vec<String> = Vec::with_capacity(ds.headers.len());
    global_headers.push(canonical_ts);
    for h in &ds.headers {
        if !is_timestamp(h) {
            global_headers.push(h.clone());
        }
    }
    let g = global_headers.len();

    // file column index → global column index.
    let global_idx: HashMap<String, usize> = global_headers
        .iter()
        .enumerate()
        .map(|(i, h)| (h.to_lowercase(), i))
        .collect();
    let col_map: Vec<usize> = ds
        .headers
        .iter()
        .map(|h| {
            if is_timestamp(h) {
                0
            } else {
                *global_idx.get(&h.to_lowercase()).unwrap_or(&0)
            }
        })
        .collect();

    // Aggregate parse-fail counts into the global (ts-first) layout.
    let mut global_fail_counts = vec![0usize; g];
    for (li, &gi) in col_map.iter().enumerate() {
        if li < parse_fail_counts.len() {
            global_fail_counts[gi] += parse_fail_counts[li];
        }
    }

    // Row selection & ordering, entirely on u32 indices (a 2 GB CSV tops out
    // far below u32::MAX rows). Rows without a timestamp are dropped (the
    // merge is keyed by timestamp), and the sort is skipped when the file is
    // already ordered.
    let mut order: Vec<u32> = (0..ds.n_rows() as u32)
        .filter(|&r| ds.timestamps[r as usize].is_some())
        .collect();
    let sorted_already = order
        .windows(2)
        .all(|w| ds.timestamps[w[0] as usize] <= ds.timestamps[w[1] as usize]);
    if !sorted_already {
        // Stable: keeps file order among equal timestamps so the duplicate
        // merge below overwrites in file order (later row wins).
        order.sort_by(|&a, &b| ds.timestamps[a as usize].cmp(&ds.timestamps[b as usize]));
    }
    let has_dups = order
        .windows(2)
        .any(|w| ds.timestamps[w[0] as usize] == ds.timestamps[w[1] as usize]);

    let identity_headers = ds.headers.len() == g
        && ds
            .headers
            .iter()
            .zip(global_headers.iter())
            .all(|(a, b)| a == b);

    // Fast path: ts-first headers, nothing dropped, already ordered, unique
    // timestamps — reuse the parsed columns without a single gather.
    if identity_headers && sorted_already && !has_dups && order.len() == ds.n_rows() {
        return MergeResult {
            data: ColumnarData::from_parts(global_headers, ds.timestamps, ds.columns),
            warnings: be_warning.clone().into_iter().collect(),
            parse_fail_counts: global_fail_counts,
            files: Vec::new(),
        };
    }

    // Group runs of equal timestamps: each group becomes one output row.
    let mut groups: Vec<(u32, u32)> = Vec::new();
    let mut i = 0usize;
    while i < order.len() {
        let mut j = i + 1;
        while j < order.len()
            && ds.timestamps[order[j] as usize] == ds.timestamps[order[i] as usize]
        {
            j += 1;
        }
        groups.push((i as u32, j as u32));
        i = j;
    }

    // For each global column, the local columns feeding it, in file order.
    // Duplicate header names can map several locals to one slot; scanning
    // rows (outer, file order) then locals (inner, file order) and letting
    // the last non-NaN win reproduces the old per-row overwrite order.
    let mut sources: Vec<Vec<usize>> = vec![Vec::new(); g];
    for (li, &gi) in col_map.iter().enumerate() {
        // The local timestamp column maps to slot 0 but is all-NaN, so it
        // never writes a value (slot 0 stays the all-NaN placeholder).
        sources[gi].push(li);
    }

    let out_timestamps: Vec<Option<String>> = groups
        .iter()
        .map(|&(s, _)| ds.timestamps[order[s as usize] as usize].clone())
        .collect();

    let out_columns: Vec<Vec<f64>> = (0..g)
        .into_par_iter()
        .map(|gc| {
            let srcs = &sources[gc];
            groups
                .iter()
                .map(|&(s, e)| {
                    let mut v = f64::NAN;
                    for &oi in &order[s as usize..e as usize] {
                        for &li in srcs {
                            let x = ds.columns[li][oi as usize];
                            if !x.is_nan() {
                                v = x;
                            }
                        }
                    }
                    v
                })
                .collect()
        })
        .collect();

    MergeResult {
        data: ColumnarData::from_parts(global_headers, out_timestamps, out_columns),
        warnings: be_warning.into_iter().collect(),
        parse_fail_counts: global_fail_counts,
        files: Vec::new(),
    }
}

/// Min / max of the valid (non-[`TS_MISSING`]) values; `None` if none.
fn ts_min_max(ts: &[i64]) -> Option<(i64, i64)> {
    let mut it = ts.iter().copied().filter(|&t| t != TS_MISSING);
    let first = it.next()?;
    Some(it.fold((first, first), |(lo, hi), t| (lo.min(t), hi.max(t))))
}

/// Cap on how many consecutive-difference samples feed the median interval.
const MAX_INTERVAL_SAMPLES: usize = 2_000_000;

#[cfg(test)]
thread_local! {
    /// How many times [`median_interval_seconds`] ran ON THIS THREAD. Per
    /// thread so that tests running in parallel cannot disturb each other's
    /// count (the function is entered on its caller's thread).
    static MEDIAN_INTERVAL_RUNS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Test probe: runs of [`median_interval_seconds`] on the calling thread so
/// far. Tests pin "the interval is computed at most once per dataset" with the
/// difference of two readings.
#[cfg(test)]
pub(crate) fn median_interval_runs() -> usize {
    MEDIAN_INTERVAL_RUNS.with(|c| c.get())
}

/// Median positive gap, in seconds, between consecutive valid timestamps of
/// the merged dataset. The merge orders rows by timestamp TEXT, which equals
/// chronological order for a uniform format — but mixed formats could differ,
/// so an out-of-order `ts` is sorted first (a copy; the common case is already
/// sorted and costs no allocation beyond the difference samples). With more
/// than [`MAX_INTERVAL_SAMPLES`] gaps a deterministic stride sample is used.
/// Equal neighbours (gap 0) are ignored. Even sample count: mean of the two
/// middle gaps. `None` if fewer than 2 valid timestamps / no positive gap.
///
/// O(rows) + a sort: do NOT call this per query on a loaded dataset — read
/// [`ColumnarData::sample_interval_secs`], which runs it once per dataset.
pub(crate) fn median_interval_seconds(ts: &[i64]) -> Option<f64> {
    #[cfg(test)]
    MEDIAN_INTERVAL_RUNS.with(|c| c.set(c.get() + 1));
    let mut valid = 0usize;
    let mut sorted = true;
    let mut prev: Option<i64> = None;
    for &t in ts {
        if t == TS_MISSING {
            continue;
        }
        valid += 1;
        if prev.is_some_and(|p| t < p) {
            sorted = false;
        }
        prev = Some(t);
    }
    if valid < 2 {
        return None;
    }

    fn sampled_gaps(it: impl Iterator<Item = i64>, n_gaps: usize) -> Vec<i64> {
        let stride = n_gaps.div_ceil(MAX_INTERVAL_SAMPLES).max(1);
        let mut out = Vec::with_capacity(n_gaps.min(MAX_INTERVAL_SAMPLES));
        let mut prev: Option<i64> = None;
        let mut k = 0usize;
        for t in it {
            if let Some(p) = prev {
                if k % stride == 0 && t > p {
                    out.push(t - p);
                }
                k += 1;
            }
            prev = Some(t);
        }
        out
    }

    let mut gaps = if sorted {
        sampled_gaps(ts.iter().copied().filter(|&t| t != TS_MISSING), valid - 1)
    } else {
        let mut v: Vec<i64> = ts.iter().copied().filter(|&t| t != TS_MISSING).collect();
        v.par_sort_unstable();
        sampled_gaps(v.into_iter(), valid - 1)
    };
    if gaps.is_empty() {
        return None;
    }
    gaps.sort_unstable();
    let n = gaps.len();
    let micros = if n % 2 == 1 {
        gaps[n / 2] as f64
    } else {
        (gaps[n / 2 - 1] as f64 + gaps[n / 2] as f64) / 2.0
    };
    Some(micros / 1_000_000.0)
}

/// Build a CsvLoadReport from merge results and the final ColumnarData.
pub fn build_load_report(merge_result: &MergeResult) -> CsvLoadReport {
    let data = &merge_result.data;
    let total_rows = data.n_rows();

    let is_timestamp =
        |h: &str| h.eq_ignore_ascii_case("timestamp") || h.eq_ignore_ascii_case("time");

    // Per-column valid (non-NaN) counts — one contiguous scan per column,
    // columns in parallel. The timestamp column's validity comes from the
    // timestamps vec (its value column is the all-NaN placeholder).
    let ts_valid = data.timestamps.iter().filter(|t| t.is_some()).count();
    let valid_counts: Vec<usize> = data
        .columns
        .par_iter()
        .map(|col| col.iter().filter(|v| !v.is_nan()).count())
        .collect();

    let columns: Vec<ColumnInfo> = data
        .headers
        .iter()
        .enumerate()
        .map(|(col_idx, name)| {
            let (dtype, valid_count) = if is_timestamp(name) {
                ("datetime".to_string(), ts_valid)
            } else {
                (
                    "numeric".to_string(),
                    valid_counts.get(col_idx).copied().unwrap_or(0),
                )
            };

            ColumnInfo {
                name: name.clone(),
                dtype,
                null_count: total_rows - valid_count,
                valid_count,
            }
        })
        .collect();

    // Build warnings: start with merge warnings, then add parse-failure warnings
    let mut warnings = merge_result.warnings.clone();

    for (col_idx, name) in data.headers.iter().enumerate() {
        if is_timestamp(name) {
            continue;
        }
        if col_idx < merge_result.parse_fail_counts.len() {
            let fail_count = merge_result.parse_fail_counts[col_idx];
            if fail_count > 0 {
                warnings.push(format!(
                    "Column '{}': {} non-numeric value(s) replaced with NaN",
                    name, fail_count
                ));
            }
        }
    }

    // Period / interval come off the already-parsed `ts_parsed`; the empty-cell
    // share reuses the per-column valid counts computed above — no new pass
    // over the sensor columns.
    let range = ts_min_max(&data.ts_parsed);
    let mut sensor_cols = 0usize;
    let mut missing_cells = 0usize;
    for (col_idx, name) in data.headers.iter().enumerate() {
        if is_timestamp(name) {
            continue;
        }
        sensor_cols += 1;
        missing_cells += total_rows - valid_counts.get(col_idx).copied().unwrap_or(0);
    }
    let missing_percent = if total_rows > 0 && sensor_cols > 0 {
        Some((missing_cells as f64 / (total_rows as f64 * sensor_cols as f64) * 100.0).clamp(0.0, 100.0))
    } else {
        None
    };

    CsvLoadReport {
        headers: data.headers.clone(),
        total_rows,
        columns,
        warnings,
        generation: 0,
        files: merge_result.files.clone(),
        period_start: range.and_then(|(lo, _)| format_micros(lo)),
        period_end: range.and_then(|(_, hi)| format_micros(hi)),
        period_start_micros: range.map(|(lo, _)| lo),
        period_end_micros: range.map(|(_, hi)| hi),
        // Fills the dataset's interval cache: `load_csv` builds this report
        // before it installs the dataset, so the one computation happens here
        // (on the load's blocking thread) and every later command reads it.
        interval_seconds: data.sample_interval_secs(),
        missing_percent,
    }
}

/// Load a mapping CSV: returns all data as strings (no numeric parsing).
pub fn load_mapping_csv_data(path: &str) -> Result<MappingData, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut rdr = csv::Reader::from_reader(BufReader::new(file));

    let headers_record = rdr.headers().map_err(|e| e.to_string())?.clone();
    let headers: Vec<String> = headers_record.iter().map(clean_header).collect();

    let mut rows: Vec<Vec<String>> = Vec::new();
    for result in rdr.records() {
        let record = result.map_err(|e| e.to_string())?;
        let row: Vec<String> = record.iter().map(|s| s.to_string()).collect();
        rows.push(row);
    }

    Ok(MappingData { headers, rows })
}

/// Apply key column mapping: compare mapping key values against dataset headers.
pub fn apply_mapping(
    key_column: &str,
    mapping_data: &MappingData,
    dataset_headers: &[String],
) -> Result<MappingResult, String> {
    // Find key column index in mapping headers
    let key_idx = mapping_data
        .headers
        .iter()
        .position(|h| h == key_column)
        .ok_or_else(|| format!("Key column '{}' not found in mapping headers", key_column))?;

    // Extract unique key values from mapping rows
    let mut key_values: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for row in &mapping_data.rows {
        let val = row
            .get(key_idx)
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        if !val.is_empty() && seen.insert(val.clone()) {
            key_values.push(val);
        }
    }

    // Build a set of dataset headers for quick lookup
    let dataset_set: HashSet<&str> = dataset_headers.iter().map(|s| s.as_str()).collect();

    let mut matched = Vec::new();
    let mut not_in_dataset = Vec::new();

    for key in &key_values {
        if dataset_set.contains(key.as_str()) {
            matched.push(key.clone());
        } else {
            not_in_dataset.push(key.clone());
        }
    }

    // Find dataset headers not in mapping key values
    let is_timestamp =
        |h: &str| h.eq_ignore_ascii_case("timestamp") || h.eq_ignore_ascii_case("time");

    let mapping_keys: HashSet<&str> = key_values.iter().map(|s| s.as_str()).collect();
    let not_in_mapping: Vec<String> = dataset_headers
        .iter()
        .filter(|h| !is_timestamp(h) && !mapping_keys.contains(h.as_str()))
        .cloned()
        .collect();

    Ok(MappingResult {
        matched,
        not_in_dataset,
        not_in_mapping,
    })
}

pub fn load_metadata(path: &str) -> Result<Vec<SensorMetadata>, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut rdr = csv::Reader::from_reader(BufReader::new(file));
    let headers = rdr.headers().map_err(|e| e.to_string())?.clone();

    let mut tag_idx = None;
    let mut desc_idx = None;
    let mut unit_idx = None;
    let mut comp_idx = None;

    for (i, h) in headers.iter().enumerate() {
        match clean_header(h).to_lowercase().as_str() {
            "tag" => tag_idx = Some(i),
            "description" => desc_idx = Some(i),
            "unit" => unit_idx = Some(i),
            "component" => comp_idx = Some(i),
            _ => {}
        }
    }

    let mut metadata_list = Vec::new();

    for result in rdr.records() {
        let record = result.map_err(|e| e.to_string())?;

        let tag = tag_idx
            .and_then(|i| record.get(i))
            .unwrap_or("")
            .to_string();
        if tag.trim().is_empty() {
            continue;
        }

        let description = desc_idx
            .and_then(|i| record.get(i))
            .unwrap_or("")
            .to_string();
        let unit = unit_idx
            .and_then(|i| record.get(i))
            .unwrap_or("")
            .to_string();
        let component = comp_idx
            .and_then(|i| record.get(i))
            .unwrap_or("")
            .to_string();

        metadata_list.push(SensorMetadata {
            tag,
            description,
            unit,
            component,
        });
    }

    Ok(metadata_list)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What one file's timestamp column reads as: the per-file rewrite, then
    /// the same parse `from_parts` runs (Buddhist-Era year corrected first).
    fn read_file_ts(raw: &[&str]) -> (Vec<Option<chrono::NaiveDateTime>>, Vec<String>, Vec<String>) {
        let mut ts: Vec<Option<String>> = raw.iter().map(|s| Some(s.to_string())).collect();
        let warnings = normalize_file_timestamps("run-01.csv", &mut ts);
        let texts: Vec<String> = ts.iter().map(|t| t.clone().unwrap()).collect();
        let parsed = texts
            .iter()
            .map(|t| parse_timestamp(&normalize_buddhist_era(t.clone())))
            .collect();
        (parsed, texts, warnings)
    }

    fn dt(s: &str) -> chrono::NaiveDateTime {
        parse_timestamp(s).unwrap()
    }

    // The Import page lists these as the supported date/time shapes
    // (`SensorDataPanel.tsx` SUPPORTED_TIMESTAMPS): each must be read (one
    // file of that shape) to the 31 Jan 2025 13:05 wall clock, and the shapes
    // listed as NOT read must not be.
    #[test]
    fn the_timestamp_shapes_the_import_page_lists_are_the_ones_parsed() {
        let want = dt("2025-01-31 13:05:00");
        for s in [
            "2025-01-31 13:05:00",
            "2025-01-31 13:05",
            "2025-01-31T13:05:00",
            "2025-01-31 13:05:00+07:00",
            "2025-01-31T13:05:00Z",
            "2025/01/31 13:05:00",
            "1/31/2025 13:05",
            "31/01/2025 13:05",
            "31.01.2025 13:05",
            "31-01-2025 13:05",
            "1/31/2025 1:05 PM",
            "31/01/25 13:05",
            "Jan 31 2025 13:05",
            "31-Jan-25 1:05 PM",
            "Fri, 31 Jan 2025 13:05:00 +0700",
            "Friday, January 31, 2025 1:05 PM",
            "Fri Jan 31 2025 13:05:00 GMT+0700 (Indochina Time)",
            "20250131130500",
            "20250131 1305",
            "2025-01-31T130500",
            "2025-01-31t13:05:00",
            "31 ม.ค. 2568 13:05",
            "๓๑ มกราคม ๒๕๖๘ 13.05 น.",
            "1738328700",
            "1738328700000",
        ] {
            let (p, _, _) = read_file_ts(&[s]);
            assert_eq!(p[0], Some(want), "{s} should read as 2025-01-31 13:05");
        }
        let (p, _, _) = read_file_ts(&["2025-01-31 13:05:00.250"]);
        assert_eq!(p[0], Some(dt("2025-01-31 13:05:00.250")));
        let (p, _, _) = read_file_ts(&["31/01/2025"]);
        assert_eq!(p[0], Some(dt("2025-01-31 00:00:00")));
        let (p, _, _) = read_file_ts(&["01-Jan-25 12:00 AM"]);
        assert_eq!(p[0], Some(dt("2025-01-01 00:00:00")));
        let (p, _, _) = read_file_ts(&["45688.5451389"]);
        assert_eq!(p[0], Some(want), "Excel serial");
        for s in ["31/01/5 13:05", "Foo 31 2025 13:05", "12345", "2025-01-31 25:00", "13:05", "yesterday"] {
            let (p, _, _) = read_file_ts(&[s]);
            assert_eq!(p[0], None, "{s} is listed as not read");
        }
    }

    // ── Non-ISO shapes: per-row field parsing ──────────────────────────────

    #[test]
    fn each_non_iso_shape_reads_to_the_right_wall_clock() {
        let mf = DayMonthOrder::MonthFirst;
        let txt = |s: &str| parse_loose(s).and_then(|l| l.to_iso_text(mf));
        assert_eq!(txt("1/2/2026 0:05").as_deref(), Some("2026-01-02 00:05:00"));
        assert_eq!(txt("01/02/2026 23:55:07").as_deref(), Some("2026-01-02 23:55:07"));
        assert_eq!(txt("1/2/2026 0:05:09.050").as_deref(), Some("2026-01-02 00:05:09.050"));
        assert_eq!(txt("1.2.2026 7:00").as_deref(), Some("2026-01-02 07:00:00"));
        assert_eq!(txt("1-2-2026 7:00").as_deref(), Some("2026-01-02 07:00:00"));
        assert_eq!(txt("2026/1/2 7:00").as_deref(), Some("2026-01-02 07:00:00"));
        assert_eq!(txt("2026/01/02 07:00:00.5").as_deref(), Some("2026-01-02 07:00:00.5"));
        // A date with no time is midnight.
        assert_eq!(txt("1/2/2026").as_deref(), Some("2026-01-02 00:00:00"));
        assert_eq!(txt("2026/01/02").as_deref(), Some("2026-01-02 00:00:00"));
        // DayFirst swaps A and B.
        let df = parse_loose("1/2/2026 0:05").unwrap().to_iso_text(DayMonthOrder::DayFirst);
        assert_eq!(df.as_deref(), Some("2026-02-01 00:05:00"));
        // Text `parse_timestamp` already reads is never rewritten.
        assert!(loose_of("2026-01-02 00:05:00").is_none());
        assert!(loose_of("2026-01-02T00:05:00Z").is_none());
        assert!(loose_of("2026-01-02 00:05:00.5+07:00").is_none());
    }

    #[test]
    fn am_pm_twelve_o_clock_edges() {
        let txt = |s: &str| parse_loose(s).and_then(|l| l.to_iso_text(DayMonthOrder::MonthFirst));
        assert_eq!(txt("1/2/2026 12:05 AM").as_deref(), Some("2026-01-02 00:05:00"));
        assert_eq!(txt("1/2/2026 12:05 PM").as_deref(), Some("2026-01-02 12:05:00"));
        assert_eq!(txt("1/2/2026 1:05 AM").as_deref(), Some("2026-01-02 01:05:00"));
        assert_eq!(txt("1/2/2026 11:59:59 PM").as_deref(), Some("2026-01-02 23:59:59"));
        assert_eq!(txt("1/2/2026 1:05 pm").as_deref(), Some("2026-01-02 13:05:00"));
        // 0 or 13 o'clock with AM/PM is not a 12-hour time.
        assert!(parse_loose("1/2/2026 0:05 AM").is_none());
        assert!(parse_loose("1/2/2026 13:05 PM").is_none());
    }

    #[test]
    fn a_trailing_z_is_read_as_the_wall_clock_written() {
        assert_eq!(parse_timestamp("2026-02-09T23:50:00Z"), Some(dt("2026-02-09 23:50:00")));
        assert_eq!(parse_timestamp("2026-02-09 23:50:00.5Z"), Some(dt("2026-02-09 23:50:00.5")));
        assert_eq!(parse_timestamp("2026-02-09T23:50Z"), Some(dt("2026-02-09 23:50:00")));
        // Same convention as an explicit offset: the clock as written.
        assert_eq!(
            parse_timestamp("2026-02-09T23:50:00+07:00"),
            parse_timestamp("2026-02-09T23:50:00Z")
        );
        assert_eq!(parse_timestamp("Z"), None);
    }

    // ── Non-ISO shapes: day/month order per file ───────────────────────────

    #[test]
    fn a_day_over_12_in_the_first_field_means_day_month() {
        let (p, texts, w) = read_file_ts(&["12/1/2026 0:00", "13/1/2026 0:00", "1/2/2026 0:00"]);
        assert_eq!(texts, vec!["2026-01-12 00:00:00", "2026-01-13 00:00:00", "2026-02-01 00:00:00"]);
        assert!(p.iter().all(|x| x.is_some()));
        assert_eq!(w, vec!["Dates in run-01.csv read as day/month/year (12/1/2026 → 2026-01-12)"]);
    }

    #[test]
    fn a_day_over_12_in_the_second_field_means_month_day() {
        let (_, texts, w) = read_file_ts(&["1/12/2026 0:00", "1/13/2026 0:00"]);
        assert_eq!(texts, vec!["2026-01-12 00:00:00", "2026-01-13 00:00:00"]);
        assert_eq!(w, vec!["Dates in run-01.csv read as month/day/year (1/12/2026 → 2026-01-12)"]);
    }

    #[test]
    fn all_values_12_or_less_picks_the_reading_that_is_in_order() {
        // 11 Feb, 12 Feb, 1 Mar as D/M (in order) = Nov 2, Dec 2, Jan 3 as
        // M/D (one step backwards) → D/M wins.
        let (_, texts, w) = read_file_ts(&["11/2/2026", "12/2/2026", "1/3/2026"]);
        assert_eq!(texts, vec!["2026-02-11 00:00:00", "2026-02-12 00:00:00", "2026-03-01 00:00:00"]);
        assert_eq!(w, vec!["Dates in run-01.csv read as day/month/year (11/2/2026 → 2026-02-11)"]);
    }

    #[test]
    fn a_true_tie_reads_month_day_and_says_it_was_a_guess() {
        let (_, texts, w) = read_file_ts(&["3/4/2026 0:00"]);
        assert_eq!(texts, vec!["2026-03-04 00:00:00"]);
        assert_eq!(
            w,
            vec!["Dates in run-01.csv read as month/day/year (3/4/2026 → 2026-03-04) — could not be told apart from the values; check the dates"]
        );
    }

    #[test]
    fn identical_day_and_month_everywhere_is_not_a_guess() {
        let (_, texts, w) = read_file_ts(&["1/1/2026 0:00", "1/1/2026 0:05"]);
        assert_eq!(texts, vec!["2026-01-01 00:00:00", "2026-01-01 00:05:00"]);
        assert_eq!(w, vec!["Dates in run-01.csv read as month/day/year (1/1/2026 → 2026-01-01)"]);
    }

    #[test]
    fn contradicting_day_month_rows_are_unreadable_with_a_warning() {
        let raw = ["13/1/2026 0:00", "1/13/2026 0:00", "1/2/2026 0:00", "2026/01/05 00:00"];
        let (p, texts, w) = read_file_ts(&raw);
        // Every year-last row stays as written and so reads as missing; the
        // unambiguous year-first row is still read.
        assert_eq!(&texts[..3], &raw[..3]);
        assert_eq!(&p[..3], &[None, None, None]);
        assert_eq!(texts[3], "2026-01-05 00:00:00");
        assert_eq!(
            w,
            vec![
                "Dates in run-01.csv mix day/month/year (13/1/2026) and month/day/year (1/13/2026) — the order cannot be decided, so 3 row(s) with a year-last date could not be read",
                "Dates in run-01.csv read as year-month-day (2026/01/05 00:00 → 2026-01-05 00:00:00)",
            ]
        );
    }

    #[test]
    fn an_impossible_date_under_the_file_order_is_unreadable_and_counted() {
        let (p, texts, w) = read_file_ts(&["1/13/2026 0:00", "2/30/2026 0:00"]);
        assert_eq!(texts[1], "2/30/2026 0:00");
        assert_eq!(p[1], None);
        assert_eq!(w.len(), 2);
        assert_eq!(w[1], "1 timestamp(s) in run-01.csv could not be read as a date and time");
    }

    #[test]
    fn year_first_slash_only_is_rewritten_with_one_info_line() {
        let (_, texts, w) = read_file_ts(&["2026/01/02 00:05:00", "2026/01/02 00:10:00"]);
        assert_eq!(texts, vec!["2026-01-02 00:05:00", "2026-01-02 00:10:00"]);
        assert_eq!(
            w,
            vec!["Dates in run-01.csv read as year-month-day (2026/01/02 00:05:00 → 2026-01-02 00:05:00)"]
        );
    }

    // ── More shape families (weekday/RFC, compact, ISO-like, Thai, serial) ─

    fn iso(s: &str) -> Option<String> {
        loose_of(s).and_then(|l| l.to_iso_text(DayMonthOrder::MonthFirst))
    }

    #[test]
    fn weekday_and_rfc_styles_read_the_written_wall_clock() {
        let want = Some("2025-01-01 13:05:00".to_string());
        for s in [
            "Mon, 01 Jan 2025 13:05:00",
            "Wed, 01 Jan 2025 13:05:00 +0700",
            "Wed, 01 Jan 2025 13:05:00 GMT",
            "Wednesday, January 1, 2025 1:05 PM",
            "Wed Jan 01 2025 13:05:00",
            "Wed Jan 01 2025 13:05:00 GMT+0700",
            "Wed Jan 01 2025 13:05:00 GMT+0700 (Indochina Time)",
            "Wed Jan 01 2025 13:05:00 UTC",
            "Wed Jan 01 2025 13:05:00Z",
            "Wed Jan 01 2025 13:05:00+07:00",
            "Wed Jan  1 13:05:00 2025",
            "January 1, 2025 at 1:05 PM",
            "Jan. 1, 2025 1:05 p.m.",
        ] {
            assert_eq!(iso(s), want, "{s}");
        }
        let (_, _, w) = read_file_ts(&["Wed, 01 Jan 2025 13:05:00 +0700"]);
        assert_eq!(
            w,
            vec!["Dates in run-01.csv read as day-month-year with month names (Wed, 01 Jan 2025 13:05:00 +0700 → 2025-01-01 13:05:00)"]
        );
    }

    #[test]
    fn compact_digit_shapes_read() {
        assert_eq!(iso("20250131 130500").as_deref(), Some("2025-01-31 13:05:00"));
        assert_eq!(iso("20250131130500").as_deref(), Some("2025-01-31 13:05:00"));
        assert_eq!(iso("20250131T130500").as_deref(), Some("2025-01-31 13:05:00"));
        assert_eq!(iso("20250131T130500.25").as_deref(), Some("2025-01-31 13:05:00.25"));
        assert_eq!(iso("202501311305").as_deref(), Some("2025-01-31 13:05:00"));
        assert_eq!(iso("20250131").as_deref(), Some("2025-01-31 00:00:00"));
        assert_eq!(iso("20251331"), None); // month 13
        let (_, texts, w) = read_file_ts(&["20250131130500", "20250131131000"]);
        assert_eq!(texts, vec!["2025-01-31 13:05:00", "2025-01-31 13:10:00"]);
        assert_eq!(
            w,
            vec!["Dates in run-01.csv read as compact year-month-day digits (20250131130500 → 2025-01-31 13:05:00)"]
        );
    }

    #[test]
    fn iso_like_texts_parse_timestamp_does_not_take_are_rewritten() {
        assert_eq!(iso("2025-01-31T130500").as_deref(), Some("2025-01-31 13:05:00"));
        assert_eq!(iso("2025-01-31t13:05:00").as_deref(), Some("2025-01-31 13:05:00"));
        assert_eq!(iso("2025-01-31 13:05:00,250").as_deref(), Some("2025-01-31 13:05:00.250"));
        assert_eq!(iso("2025-01-31T13:05:00.250+0700").as_deref(), Some("2025-01-31 13:05:00.250"));
        assert_eq!(iso("2025-01-31 1:05pm").as_deref(), Some("2025-01-31 13:05:00"));
        assert_eq!(iso("2025-01-31 1:05 p.m.").as_deref(), Some("2025-01-31 13:05:00"));
        assert_eq!(iso("2025-01-31 12:05a.m.").as_deref(), Some("2025-01-31 00:05:00"));
        assert_eq!(iso("2025-1-31 7:05").as_deref(), Some("2025-01-31 07:05:00"));
        assert_eq!(iso("2025.01.31 13:05").as_deref(), Some("2025-01-31 13:05:00"));
        assert_eq!(iso("2025-01-31").as_deref(), Some("2025-01-31 00:00:00"));
        assert_eq!(iso("2025-Jan-31 13:05").as_deref(), Some("2025-01-31 13:05:00"));
        assert_eq!(iso("2025 Jan 31 13:05").as_deref(), Some("2025-01-31 13:05:00"));
        // A comma fraction needs seconds; hour-only times are not read.
        assert_eq!(iso("2025-01-31 13:05,5"), None);
        assert_eq!(iso("2025-01-31 13"), None);
    }

    #[test]
    fn thai_month_names_digits_and_buddhist_era_years() {
        // Rewritten text keeps the BE year; `from_parts` converts it once.
        assert_eq!(iso("1 ม.ค. 2568 13:05").as_deref(), Some("2568-01-01 13:05:00"));
        assert_eq!(iso("01 มกราคม 2568 13:05 น.").as_deref(), Some("2568-01-01 13:05:00"));
        assert_eq!(iso("1 มค 68 13:05").as_deref(), Some("2568-01-01 13:05:00"));
        assert_eq!(iso("๑ ก.พ. ๒๕๖๘ ๑๓:๐๕").as_deref(), Some("2568-02-01 13:05:00"));
        assert_eq!(iso("วันที่"), None);
        for (s, m) in [
            ("1 มี.ค. 2568", 3),
            ("1 เม.ย. 2568", 4),
            ("1 พ.ค. 2568", 5),
            ("1 มิ.ย. 2568", 6),
            ("1 ก.ค. 2568", 7),
            ("1 ส.ค. 2568", 8),
            ("1 ก.ย. 2568", 9),
            ("1 ต.ค. 2568", 10),
            ("1 พ.ย. 2568", 11),
            ("1 ธ.ค. 2568", 12),
            ("1 ธันวาคม 2568", 12),
            ("1 กุมภาพันธ์ 2568", 2),
        ] {
            assert_eq!(iso(s), Some(format!("2568-{m:02}-01 00:00:00")), "{s}");
        }
        let (p, _, w) = read_file_ts(&["1 ม.ค. 68 13:05 น.", "1 ม.ค. 68 13:10 น."]);
        assert_eq!(p[0], Some(dt("2025-01-01 13:05:00")));
        assert_eq!(
            w,
            vec!["Dates in run-01.csv read as day-month-year with Thai month names (1 ม.ค. 68 13:05 น. → 2025-01-01 13:05:00, 2-digit year read as พ.ศ. 25YY)"]
        );
    }

    #[test]
    fn an_all_numeric_column_reads_as_excel_serials_or_unix_epochs() {
        // Excel: 45658 = 2025-01-01 (the 1899-12-30 epoch absorbs the
        // fictitious 1900-02-29); fraction = time of day, nearest second.
        let (p, texts, w) = read_file_ts(&["45658", "45658.5", "45658.5416667"]);
        assert_eq!(texts, vec!["2025-01-01 00:00:00", "2025-01-01 12:00:00", "2025-01-01 13:00:00"]);
        assert!(p.iter().all(|x| x.is_some()));
        assert_eq!(w, vec!["Times in run-01.csv read as Excel serial dates (45658 → 2025-01-01 00:00:00)"]);
        assert_eq!(serial_to_iso("60", SerialKind::Excel), None); // out of range
        assert_eq!(serial_to_iso("45657.999999", SerialKind::Excel).as_deref(), Some("2025-01-01 00:00:00"));

        let (_, texts, w) = read_file_ts(&["1735736700", "1735737000"]);
        assert_eq!(texts, vec!["2025-01-01 13:05:00", "2025-01-01 13:10:00"]);
        assert_eq!(w, vec!["Times in run-01.csv read as Unix epoch seconds (UTC) (1735736700 → 2025-01-01 13:05:00)"]);

        let (_, texts, w) = read_file_ts(&["1735736700250", "1735737000000"]);
        assert_eq!(texts, vec!["2025-01-01 13:05:00.250", "2025-01-01 13:10:00"]);
        assert_eq!(
            w,
            vec!["Times in run-01.csv read as Unix epoch milliseconds (UTC) (1735736700250 → 2025-01-01 13:05:00.250)"]
        );

        // Numbers of another kind inside a numeric column: unreadable, counted.
        let (p, _, w) = read_file_ts(&["45658", "45659", "1735736700"]);
        assert_eq!(p[2], None);
        assert_eq!(w[1], "1 timestamp(s) in run-01.csv could not be read as a date and time");
    }

    #[test]
    fn numbers_mixed_with_text_dates_are_unreadable_and_counted() {
        let (p, texts, w) = read_file_ts(&["01-Jan-25 12:00 AM", "45658", "01-Jan-25 12:10 AM"]);
        assert_eq!(texts[1], "45658");
        assert_eq!(p[1], None);
        assert_eq!(w.len(), 2);
        assert_eq!(w[1], "1 timestamp(s) in run-01.csv could not be read as a date and time");
        // Also inside an otherwise ISO file.
        let (_, _, w) = read_file_ts(&["2025-01-01 00:00:00", "junk"]);
        assert_eq!(w, vec!["1 timestamp(s) in run-01.csv could not be read as a date and time"]);
    }

    #[test]
    fn plain_iso_detection_matches_what_parse_timestamp_reads() {
        for s in [
            "2025-01-31 13:05",
            "2025-01-31T13:05:00",
            "2025-01-31 13:05:00.250",
            "2025-01-31 13:05:00+07:00",
            "2025-01-31T13:05:00.5-05:00",
            "2025-01-31T13:05:00Z",
            "2025-01-31T13:05Z",
        ] {
            assert!(is_plain_iso(s), "{s}");
            assert!(parse_timestamp(s).is_some(), "{s}");
        }
        for s in ["2025-01-31", "2025-01-31T130500", "2025-01-31t13:05", "2025-01-31 13:05:00,5", "2025-01-31 1:05"] {
            assert!(!is_plain_iso(s), "{s}");
        }
    }

    #[test]
    fn iso_files_are_left_untouched() {
        let raw = ["2026-02-09T23:50:00Z", "2026-02-09 23:55", "2567-02-29 00:00:00+07:00"];
        let mut ts: Vec<Option<String>> = raw.iter().map(|s| Some(s.to_string())).collect();
        assert!(normalize_file_timestamps("a.csv", &mut ts).is_empty());
        assert_eq!(ts.iter().map(|t| t.as_deref().unwrap()).collect::<Vec<_>>(), raw);
    }

    #[test]
    fn a_buddhist_era_year_in_a_slash_date_is_converted_once() {
        // BE 2567-02-29 = CE 2024-02-29 (a real leap day) — validated in CE.
        let (p, texts, w) = read_file_ts(&["1/2/2569 0:05", "2/29/2567 0:00"]);
        // The rewrite keeps the year as written; `from_parts` converts it.
        assert_eq!(texts, vec!["2569-01-02 00:05:00", "2567-02-29 00:00:00"]);
        assert_eq!(p[0], Some(dt("2026-01-02 00:05:00")));
        assert_eq!(p[1], Some(dt("2024-02-29 00:00:00")));
        // The example is shown in CE.
        assert_eq!(w, vec!["Dates in run-01.csv read as month/day/year (1/2/2569 → 2026-01-02)"]);
    }

    // ── Month names, 2-digit years, BOM ────────────────────────────────────

    #[test]
    fn the_historian_lines_read_with_month_names_and_12_hour_clock() {
        let (p, texts, w) = read_file_ts(&[
            "01-Jan-25 12:00 AM",
            "01-Jan-25 12:05 AM",
            "01-Jan-25 12:05 PM",
            "30-Dec-25 11:55 PM",
        ]);
        assert_eq!(
            texts,
            vec!["2025-01-01 00:00:00", "2025-01-01 00:05:00", "2025-01-01 12:05:00", "2025-12-30 23:55:00"]
        );
        assert!(p.iter().all(|x| x.is_some()));
        // No order guess for month names — one info line.
        assert_eq!(
            w,
            vec!["Dates in run-01.csv read as day-month-year with month names (01-Jan-25 12:00 AM → 2025-01-01 00:00:00, 2-digit year read as 20YY)"]
        );
    }

    #[test]
    fn every_month_name_shape_reads() {
        let txt = |s: &str| parse_loose(s).and_then(|l| l.to_iso_text(DayMonthOrder::MonthFirst));
        let want = Some("2025-09-07 08:30:00".to_string());
        for s in [
            "07-Sep-25 8:30",
            "07-Sep-2025 08:30:00",
            "7-September-2025 8:30 AM",
            "07 Sep 2025 8:30",
            "7 sept 2025 08:30",
            "Sep 7 2025 8:30",
            "SEPT 07, 2025 8:30 AM",
            "September 7, 2025 08:30",
        ] {
            assert_eq!(txt(s), want, "{s}");
        }
        for (s, iso) in [
            ("1 January 2026", "2026-01-01 00:00:00"),
            ("28-feb-2026 23:59:59.5", "2026-02-28 23:59:59.5"),
            ("Mar 3 2026", "2026-03-03 00:00:00"),
            ("15-April-26 1:00 PM", "2026-04-15 13:00:00"),
            ("1-May-26", "2026-05-01 00:00:00"),
            ("1 June 2026", "2026-06-01 00:00:00"),
            ("1 July 2026", "2026-07-01 00:00:00"),
            ("1 August 2026", "2026-08-01 00:00:00"),
            ("1 October 2026", "2026-10-01 00:00:00"),
            ("1 November 2026", "2026-11-01 00:00:00"),
            ("1 December 2026", "2026-12-01 00:00:00"),
        ] {
            assert_eq!(txt(s).as_deref(), Some(iso), "{s}");
        }
        // Month-first example → "month-day-year" in the info line, 4-digit year → no 20YY note.
        let (_, _, w) = read_file_ts(&["Jan 31, 2025 13:05"]);
        assert_eq!(
            w,
            vec!["Dates in run-01.csv read as month-day-year with month names (Jan 31, 2025 13:05 → 2025-01-31 13:05:00)"]
        );
        // Not real dates / not month names.
        assert!(parse_loose("31-Feb-25").and_then(|l| l.to_iso_text(DayMonthOrder::MonthFirst)).is_none());
        assert!(parse_loose("07-Sem-25 8:30").is_none());
        assert!(parse_loose("07-Sep-125 8:30").is_none());
    }

    #[test]
    fn two_digit_numeric_years_follow_the_file_order_and_say_20yy() {
        let (_, texts, w) = read_file_ts(&["31/01/25 13:05", "01/02/25 13:05"]);
        assert_eq!(texts, vec!["2025-01-31 13:05:00", "2025-02-01 13:05:00"]);
        assert_eq!(
            w,
            vec!["Dates in run-01.csv read as day/month/year (31/01/25 → 2025-01-31, 2-digit year read as 20YY)"]
        );
        let (_, texts, w) = read_file_ts(&["1/31/25 1:05 PM"]);
        assert_eq!(texts, vec!["2025-01-31 13:05:00"]);
        assert_eq!(
            w,
            vec!["Dates in run-01.csv read as month/day/year (1/31/25 → 2025-01-31, 2-digit year read as 20YY)"]
        );
    }

    #[test]
    fn a_bom_and_any_case_of_timestamp_are_cleaned_from_headers() {
        assert_eq!(clean_header("\u{FEFF}TimeStamp"), "TimeStamp");
        assert_eq!(clean_header(" \u{FEFF} A "), "A");
        let dir = tempfile::tempdir().unwrap();
        for header in ["\u{FEFF}TimeStamp", "TIMESTAMP", "timeStamp"] {
            let p = write_csv(&dir, "bom.csv", &format!("{header},A\n2026-01-01 00:00:00,1\n"));
            let (m, rep) = load(vec![p]);
            assert_eq!(m.data.headers, vec![header.trim_start_matches('\u{FEFF}'), "A"]);
            assert_eq!(rep.columns[0].dtype, "datetime");
            assert!(m.data.ts_parsed.iter().all(|&t| t != TS_MISSING));
        }
    }

    /// The user's two historian exports (2025.csv / 2026.csv): BOM-prefixed
    /// `TimeStamp` header, `DD-Mon-YY h:mm AM/PM`, the same sensors in both.
    #[test]
    fn the_two_historian_files_load_as_one_continuous_series() {
        let dir = tempfile::tempdir().unwrap();
        let a = write_csv(
            &dir,
            "2025.csv",
            "\u{FEFF}TimeStamp,BIG3-PIC-6072.PV,BIG3-PIC-6072.OUT\n\
             01-Jan-25 12:00 AM,0,105\n01-Jan-25 12:05 AM,1,106\n30-Dec-25 11:55 PM,2,107\n",
        );
        let b = write_csv(
            &dir,
            "2026.csv",
            "\u{FEFF}TimeStamp,BIG3-PIC-6072.PV,BIG3-PIC-6072.OUT\n\
             01-Jan-26 12:00 AM,3,108\n16-Oct-26 2:10 PM,4,109\n",
        );
        let (m, rep) = load(vec![a, b]);
        assert_eq!(m.data.headers, vec!["TimeStamp", "BIG3-PIC-6072.PV", "BIG3-PIC-6072.OUT"]);
        assert!(m.data.headers.iter().all(|h| !h.contains('\u{FEFF}')));
        assert_eq!(rep.columns[0].dtype, "datetime");
        let texts: Vec<_> = m.data.timestamps.iter().map(|t| t.clone().unwrap()).collect();
        assert_eq!(
            texts,
            vec![
                "2025-01-01 00:00:00",
                "2025-01-01 00:05:00",
                "2025-12-30 23:55:00",
                "2026-01-01 00:00:00",
                "2026-10-16 14:10:00"
            ]
        );
        assert!(m.data.ts_parsed.windows(2).all(|w| w[0] < w[1]));
        assert_eq!(rep.period_start.as_deref(), Some("2025-01-01 00:00:00"));
        assert_eq!(rep.period_end.as_deref(), Some("2026-10-16 14:10:00"));
        assert_eq!(row_vals(&m.data, 4), vec![None, Some(4.0), Some(109.0)]);
        assert!(!rep.warnings.iter().any(|w| w.contains("Duplicate column")), "{:?}", rep.warnings);
        assert_eq!(
            rep.warnings,
            vec![
                "Dates in 2025.csv read as day-month-year with month names (01-Jan-25 12:00 AM → 2025-01-01 00:00:00, 2-digit year read as 20YY)",
                "Dates in 2026.csv read as day-month-year with month names (01-Jan-26 12:00 AM → 2026-01-01 00:00:00, 2-digit year read as 20YY)",
            ]
        );
    }

    // ── Non-ISO shapes: whole load path ────────────────────────────────────

    /// The real-app report (2026-10-19): 5-minute rows across midnight,
    /// month/day/year as Excel writes it on a US PC. Every value is ≤ 12, so
    /// the order is decided by which reading keeps the rows in order.
    #[test]
    fn the_reported_us_excel_file_reads_jan_1_to_jan_2() {
        let dir = tempfile::tempdir().unwrap();
        let p = write_csv(
            &dir,
            "run-01.csv",
            "timestamp,A\n1/1/2026 23:50,1\n1/1/2026 23:55,2\n1/2/2026 0:00,3\n1/2/2026 0:05,4\n",
        );
        let (m, rep) = load(vec![p]);
        let texts: Vec<_> = m.data.timestamps.iter().map(|t| t.clone().unwrap()).collect();
        assert_eq!(
            texts,
            vec!["2026-01-01 23:50:00", "2026-01-01 23:55:00", "2026-01-02 00:00:00", "2026-01-02 00:05:00"]
        );
        assert!(m.data.ts_parsed.iter().all(|&t| t != TS_MISSING));
        assert_eq!(m.data.ts_parsed[3], ts_to_micros(dt("2026-01-02 00:05:00")));
        assert_eq!(rep.interval_seconds, Some(300.0));
        assert_eq!(
            rep.warnings,
            vec!["Dates in run-01.csv read as month/day/year (1/2/2026 → 2026-01-02)"]
        );
    }

    #[test]
    fn sensors_shared_by_several_files_are_not_reported_but_a_column_twice_in_one_file_is() {
        // User decision 2026-10-19: several files = more of the same data (another period), so
        // shared sensors are the normal case and get no "Duplicate column" line.
        let dir = tempfile::tempdir().unwrap();
        let a = write_csv(&dir, "jan.csv", "timestamp,A,B
2026-01-01 00:00:00,1,2
");
        let b = write_csv(&dir, "feb.csv", "timestamp,A,B
2026-02-01 00:00:00,3,4
");
        let (_, rep) = load(vec![a, b]);
        assert!(rep.warnings.iter().all(|w| !w.contains("Duplicate column")), "{:?}", rep.warnings);

        let c = write_csv(&dir, "mar.csv", "timestamp,A,B
2026-03-01 00:00:00,5,6
");
        let d = write_csv(&dir, "apr.csv", "timestamp,A,a
2026-04-01 00:00:00,7,8
");
        let (_, rep) = load(vec![c, d]);
        assert_eq!(
            rep.warnings.iter().filter(|w| w.contains("Duplicate column")).collect::<Vec<_>>(),
            vec!["Duplicate column 'a' found in file 2"]
        );
    }

    #[test]
    fn two_files_of_the_same_moments_in_different_shapes_merge_per_moment() {
        let dir = tempfile::tempdir().unwrap();
        let a = write_csv(&dir, "us.csv", "timestamp,A\n1/13/2026 0:00,1\n1/13/2026 0:05,2\n");
        let b = write_csv(
            &dir,
            "asia.csv",
            "timestamp,B\n2026/01/13 00:00:00,10\n2026/01/13 00:05:00,20\n",
        );
        let (m, rep) = load(vec![a, b]);
        assert_eq!(m.data.n_rows(), 2);
        assert_eq!(m.data.timestamps[0].as_deref(), Some("2026-01-13 00:00:00"));
        assert_eq!(row_vals(&m.data, 1), vec![None, Some(2.0), Some(20.0)]);
        assert_eq!(rep.warnings[0], "Dates in us.csv read as month/day/year (1/13/2026 → 2026-01-13)");
        // Per-file ranges are read from the rewritten text too.
        assert_eq!(rep.files[0].start.as_deref(), Some("2026-01-13 00:00:00"));
        assert_eq!(rep.files[1].end.as_deref(), Some("2026-01-13 00:05:00"));
    }

    #[test]
    fn a_buddhist_era_slash_date_file_loads_in_ce_with_both_warnings() {
        let dir = tempfile::tempdir().unwrap();
        let p = write_csv(&dir, "be.csv", "timestamp,A\n1/13/2569 0:05,1\n");
        let (m, rep) = load(vec![p]);
        assert_eq!(m.data.timestamps[0].as_deref(), Some("2026-01-13 00:05:00"));
        assert_eq!(m.data.ts_parsed[0], ts_to_micros(dt("2026-01-13 00:05:00")));
        assert_eq!(rep.warnings.len(), 2, "{:?}", rep.warnings);
        assert_eq!(rep.warnings[0], "Dates in be.csv read as month/day/year (1/13/2569 → 2026-01-13)");
        assert!(rep.warnings[1].starts_with("1 timestamp(s) used a Buddhist-Era year"));
    }

    /// Build a pre-merge ColumnarData from a row-major spec (readability):
    /// each row is (timestamp, per-column Option values). `ts_parsed` is
    /// left empty, exactly like `read_csv_with_stats` output.
    fn columnar(headers: Vec<&str>, rows: Vec<(Option<&str>, Vec<Option<f64>>)>) -> ColumnarData {
        let ncols = headers.len();
        let mut timestamps: Vec<Option<String>> = Vec::new();
        let mut columns: Vec<Vec<f64>> = vec![Vec::new(); ncols];
        for (ts, vals) in rows {
            timestamps.push(ts.map(String::from));
            for (c, col) in columns.iter_mut().enumerate() {
                col.push(vals.get(c).copied().flatten().unwrap_or(f64::NAN));
            }
        }
        ColumnarData {
            headers: headers.into_iter().map(String::from).collect(),
            timestamps,
            ts_parsed: Vec::new(),
            columns,
            sample_interval: std::sync::OnceLock::new(),
        }
    }

    fn single(
        headers: Vec<&str>,
        rows: Vec<(Option<&str>, Vec<Option<f64>>)>,
        fails: Vec<usize>,
    ) -> MergeResult {
        merge_single_file(ReadCsvResult {
            data: columnar(headers, rows),
            parse_fail_counts: fails,
            size_bytes: 0,
        })
    }

    /// One row's values in the legacy Option shape, for readable assertions.
    fn row_vals(d: &ColumnarData, r: usize) -> Vec<Option<f64>> {
        (0..d.headers.len()).map(|c| d.value(c, r)).collect()
    }

    #[test]
    fn identity_clean_file_is_preserved() {
        let m = single(
            vec!["timestamp", "A", "B"],
            vec![
                (Some("2020-01-01T00:00"), vec![None, Some(1.0), Some(2.0)]),
                (Some("2020-01-01T00:01"), vec![None, Some(3.0), Some(4.0)]),
            ],
            vec![0, 0, 0],
        );
        assert_eq!(m.data.headers, vec!["timestamp", "A", "B"]);
        assert_eq!(m.data.n_rows(), 2);
        assert_eq!(row_vals(&m.data, 0), vec![None, Some(1.0), Some(2.0)]);
        assert_eq!(m.data.timestamps[1].as_deref(), Some("2020-01-01T00:01"));
        assert!(m.warnings.is_empty());
    }

    #[test]
    fn rows_without_timestamp_are_dropped() {
        let m = single(
            vec!["timestamp", "A"],
            vec![
                (Some("2020-01-01T00:00"), vec![None, Some(1.0)]),
                (None, vec![None, Some(9.0)]),
            ],
            vec![0, 0],
        );
        assert_eq!(m.data.n_rows(), 1);
        assert_eq!(row_vals(&m.data, 0), vec![None, Some(1.0)]);
    }

    #[test]
    fn unsorted_rows_are_sorted_by_timestamp() {
        let m = single(
            vec!["timestamp", "A"],
            vec![
                (Some("2020-01-01T00:02"), vec![None, Some(2.0)]),
                (Some("2020-01-01T00:00"), vec![None, Some(0.0)]),
                (Some("2020-01-01T00:01"), vec![None, Some(1.0)]),
            ],
            vec![0, 0],
        );
        let ts: Vec<_> = m.data.timestamps.iter().flatten().cloned().collect();
        assert_eq!(
            ts,
            vec!["2020-01-01T00:00", "2020-01-01T00:01", "2020-01-01T00:02"]
        );
        assert_eq!(row_vals(&m.data, 0), vec![None, Some(0.0)]);
    }

    #[test]
    fn duplicate_timestamps_merge_later_non_null_wins() {
        let m = single(
            vec!["timestamp", "A", "B"],
            vec![
                (Some("t"), vec![None, Some(1.0), None]), // A=1
                (Some("t"), vec![None, None, Some(2.0)]), // fills B, keeps A
                (Some("t"), vec![None, Some(5.0), None]), // overwrites A
            ],
            vec![0, 0, 0],
        );
        assert_eq!(m.data.n_rows(), 1);
        assert_eq!(row_vals(&m.data, 0), vec![None, Some(5.0), Some(2.0)]);
    }

    #[test]
    fn load_report_counts_valid_and_null_per_column() {
        let mr = MergeResult {
            data: ColumnarData::from_parts(
                vec!["timestamp".into(), "A".into(), "B".into()],
                vec![Some("t1".into()), Some("t2".into()), None],
                vec![
                    vec![f64::NAN, f64::NAN, f64::NAN],
                    vec![1.0, 2.0, f64::NAN],
                    vec![f64::NAN, 3.0, 4.0],
                ],
            ),
            warnings: vec![],
            parse_fail_counts: vec![0, 0, 0],
            files: vec![],
        };
        let rep = build_load_report(&mr);
        assert_eq!(rep.total_rows, 3);
        let col = |n: &str| rep.columns.iter().find(|c| c.name == n).unwrap();
        assert_eq!(col("timestamp").dtype, "datetime");
        assert_eq!(
            (col("timestamp").valid_count, col("timestamp").null_count),
            (2, 1)
        );
        assert_eq!(col("A").dtype, "numeric");
        assert_eq!((col("A").valid_count, col("A").null_count), (2, 1));
        assert_eq!((col("B").valid_count, col("B").null_count), (2, 1));
    }

    #[test]
    fn timestamp_is_canonicalized_to_the_front() {
        // ts NOT first → the gather branch reorders columns + values, and
        // realigns parse-fail counts to the ts-first layout.
        let m = single(
            vec!["A", "timestamp", "B"],
            vec![(Some("t1"), vec![Some(1.0), None, Some(2.0)])],
            vec![3, 0, 7],
        );
        assert_eq!(m.data.headers, vec!["timestamp", "A", "B"]);
        assert_eq!(row_vals(&m.data, 0), vec![None, Some(1.0), Some(2.0)]);
        // fail counts follow the columns: A's 3 → idx1, B's 7 → idx2.
        assert_eq!(m.parse_fail_counts, vec![0, 3, 7]);
    }

    #[test]
    fn ts_parsed_is_populated_after_merge() {
        let m = single(
            vec!["timestamp", "A"],
            vec![
                (Some("2020-01-01T00:00:00"), vec![None, Some(1.0)]),
                (Some("not a timestamp"), vec![None, Some(2.0)]),
            ],
            vec![0, 0],
        );
        assert_eq!(m.data.ts_parsed.len(), 2);
        // Sorted by STRING: "2020-..." < "not a timestamp".
        let expected = ts_to_micros(parse_timestamp("2020-01-01T00:00:00").unwrap());
        assert_eq!(m.data.ts_parsed[0], expected);
        assert_eq!(m.data.ts_parsed[1], TS_MISSING);
    }

    #[test]
    fn value_maps_nan_to_none_and_wire_record_projects() {
        let d = ColumnarData::from_parts(
            vec!["timestamp".into(), "A".into(), "B".into()],
            vec![Some("t1".into()), None],
            vec![
                vec![f64::NAN, f64::NAN],
                vec![1.5, f64::NAN],
                vec![f64::INFINITY, 4.0],
            ],
        );
        assert_eq!(d.value(1, 0), Some(1.5));
        assert_eq!(d.value(1, 1), None); // NaN → None
        assert_eq!(d.value(2, 0), Some(f64::INFINITY)); // inf preserved
        assert_eq!(d.value(99, 0), None); // out of range

        let rec = d.wire_record(0, &[2, 1]);
        assert_eq!(rec.timestamp.as_deref(), Some("t1"));
        assert_eq!(rec.values, vec![Some(f64::INFINITY), Some(1.5)]);
    }

    // ── Buddhist-Era (พ.ศ.) year detection/normalization ───────────────────

    #[test]
    fn normalize_buddhist_era_rewrites_a_be_year_leaving_the_rest_untouched() {
        assert_eq!(
            normalize_buddhist_era("2566-05-13T01:00:00+07:00".to_string()),
            "2023-05-13T01:00:00+07:00"
        );
    }

    #[test]
    fn normalize_buddhist_era_leaves_an_ordinary_ce_year_alone() {
        assert_eq!(
            normalize_buddhist_era("2024-02-29T00:00:00".to_string()),
            "2024-02-29T00:00:00"
        );
    }

    #[test]
    fn normalize_buddhist_era_leaves_garbage_alone() {
        assert_eq!(normalize_buddhist_era("t1".to_string()), "t1");
        assert_eq!(
            normalize_buddhist_era("not-a-date-string".to_string()),
            "not-a-date-string"
        );
    }

    #[test]
    fn is_buddhist_era_year_matches_the_2400_threshold() {
        assert!(!is_buddhist_era_year("2399-01-01"));
        assert!(is_buddhist_era_year("2400-01-01"));
        assert!(is_buddhist_era_year("2566-05-13T01:00:00"));
        assert!(!is_buddhist_era_year("garbage"));
    }

    #[test]
    fn buddhist_era_warning_counts_matches_and_is_none_when_absent() {
        assert_eq!(buddhist_era_warning(["2020-01-01", "2020-01-02"]), None);
        let w = buddhist_era_warning(["2566-01-01", "2020-01-01", "2567-01-02"]).unwrap();
        assert!(w.starts_with("2 "), "got: {w}");
    }

    /// The real-world case that motivated this: a Buddhist-Era leap day
    /// (BE 2567 = CE 2024, a genuine Gregorian leap year) fails to parse
    /// entirely if the year is read literally as CE 2567 — chrono rejects
    /// Feb 29 outright since CE 2567 is not a leap year. Normalizing the
    /// year to Gregorian BEFORE the parse attempt is what recovers it.
    #[test]
    fn single_file_merge_recovers_a_buddhist_era_leap_day_and_agrees_on_the_year() {
        let m = single(
            vec!["timestamp", "A"],
            vec![
                (Some("2567-02-28 00:00:00+07:00"), vec![None, Some(1.0)]),
                (Some("2567-02-29 00:00:00+07:00"), vec![None, Some(2.0)]),
            ],
            vec![0, 0],
        );
        // Both rows parse now (neither is TS_MISSING) — the leap day survives.
        assert_eq!(m.data.ts_parsed.iter().filter(|&&t| t == TS_MISSING).count(), 0);
        // The STORED text is corrected too, not just ts_parsed — Raw-mode
        // display and Aggregated-mode display must agree on the year.
        assert_eq!(
            m.data.timestamps[0].as_deref(),
            Some("2024-02-28 00:00:00+07:00")
        );
        assert_eq!(
            m.data.timestamps[1].as_deref(),
            Some("2024-02-29 00:00:00+07:00")
        );
        assert_eq!(m.warnings.len(), 1);
        assert!(m.warnings[0].starts_with("2 "), "got: {:?}", m.warnings[0]);
    }

    #[test]
    fn single_file_merge_has_no_be_warning_for_ordinary_ce_data() {
        let m = single(
            vec!["timestamp", "A"],
            vec![(Some("2024-01-01T00:00:00"), vec![None, Some(1.0)])],
            vec![0, 0],
        );
        assert!(m.warnings.is_empty());
    }

    // ── Prepare-dataset report data (files / period / interval / missing) ───

    use std::io::Write as _;
    use std::sync::Mutex;

    fn write_csv(dir: &tempfile::TempDir, name: &str, body: &str) -> String {
        let p = dir.path().join(name);
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(body.as_bytes()).unwrap();
        p.to_string_lossy().into_owned()
    }

    fn load(paths: Vec<String>) -> (MergeResult, CsvLoadReport) {
        let m = read_merge_csvs_with_report(paths).unwrap();
        let r = build_load_report(&m);
        (m, r)
    }

    fn micros(s: &str) -> i64 {
        ts_to_micros(parse_timestamp(s).unwrap())
    }

    #[test]
    fn two_overlapping_files_report_their_own_ranges_and_the_merged_period() {
        let dir = tempfile::tempdir().unwrap();
        let a = write_csv(
            &dir,
            "a.csv",
            "timestamp,S1\n2024-01-01 00:00:00,1\n2024-01-01 00:05:00,2\n2024-01-01 00:10:00,3\n",
        );
        // Starts inside a's range, ends later; deliberately listed out of order.
        let b = write_csv(
            &dir,
            "b.csv",
            "timestamp,S2\n2024-01-01 00:15:00,9\n2024-01-01 00:05:00,7\n",
        );
        let (_, rep) = load(vec![a, b]);
        assert_eq!(rep.files.len(), 2);
        assert_eq!(rep.files[0].name, "a.csv");
        assert_eq!(rep.files[0].rows, 3);
        assert_eq!(rep.files[0].start.as_deref(), Some("2024-01-01 00:00:00"));
        assert_eq!(rep.files[0].end.as_deref(), Some("2024-01-01 00:10:00"));
        assert_eq!(rep.files[0].start_micros, Some(micros("2024-01-01 00:00:00")));
        assert_eq!(rep.files[0].end_micros, Some(micros("2024-01-01 00:10:00")));
        assert_eq!(rep.files[1].name, "b.csv");
        assert_eq!(rep.files[1].rows, 2);
        assert_eq!(rep.files[1].start.as_deref(), Some("2024-01-01 00:05:00"));
        assert_eq!(rep.files[1].end.as_deref(), Some("2024-01-01 00:15:00"));
        assert!(rep.files[0].size_bytes > 0 && rep.files[1].size_bytes > 0);
        assert_eq!(rep.period_start.as_deref(), Some("2024-01-01 00:00:00"));
        assert_eq!(rep.period_end.as_deref(), Some("2024-01-01 00:15:00"));
        assert_eq!(rep.period_start_micros, Some(micros("2024-01-01 00:00:00")));
        assert_eq!(rep.period_end_micros, Some(micros("2024-01-01 00:15:00")));
        // Merged rows: 00:00, 00:05, 00:10, 00:15 -> 4 (00:05 shared).
        assert_eq!(rep.total_rows, 4);
    }

    #[test]
    fn single_file_reports_one_entry_whose_range_equals_the_period() {
        let dir = tempfile::tempdir().unwrap();
        // Unsorted on purpose: the range must be min/max, not first/last.
        let a = write_csv(
            &dir,
            "only.csv",
            "time,S1\n2024-03-01 12:00:00,1\n2024-03-01 10:00:00,2\n2024-03-01 11:00:00,3\n",
        );
        let (_, rep) = load(vec![a]);
        assert_eq!(rep.files.len(), 1);
        let f = &rep.files[0];
        assert_eq!(f.name, "only.csv");
        assert_eq!(f.rows, 3);
        assert_eq!(f.start.as_deref(), Some("2024-03-01 10:00:00"));
        assert_eq!(f.end.as_deref(), Some("2024-03-01 12:00:00"));
        assert_eq!(f.start, rep.period_start);
        assert_eq!(f.end, rep.period_end);
        assert_eq!(f.start_micros, rep.period_start_micros);
        assert_eq!(f.end_micros, rep.period_end_micros);
    }

    #[test]
    fn file_name_is_reported_without_its_directory() {
        assert_eq!(file_name_only("/tmp/x/b.csv"), "b.csv");
        let dir = tempfile::tempdir().unwrap();
        let p = write_csv(&dir, "named.csv", "timestamp,A\n2024-01-01 00:00:00,1\n");
        let (_, rep) = load(vec![p]);
        assert_eq!(rep.files[0].name, "named.csv");
    }

    #[test]
    fn buddhist_era_files_report_gregorian_years_per_file_and_overall() {
        let dir = tempfile::tempdir().unwrap();
        let a = write_csv(
            &dir,
            "be1.csv",
            "timestamp,S1\n2567-02-28 00:00:00,1\n2567-02-29 00:00:00,2\n",
        );
        let b = write_csv(&dir, "be2.csv", "timestamp,S2\n2567-03-01 06:30:00,5\n");
        let (_, rep) = load(vec![a, b]);
        assert_eq!(rep.files[0].start.as_deref(), Some("2024-02-28 00:00:00"));
        assert_eq!(rep.files[0].end.as_deref(), Some("2024-02-29 00:00:00"));
        assert_eq!(rep.files[1].start.as_deref(), Some("2024-03-01 06:30:00"));
        assert_eq!(rep.period_start.as_deref(), Some("2024-02-28 00:00:00"));
        assert_eq!(rep.period_end.as_deref(), Some("2024-03-01 06:30:00"));

        // Single-file BE path as well.
        let c = write_csv(&dir, "be3.csv", "timestamp,S1\n2567-02-29 00:00:00,1\n");
        let (_, rep1) = load(vec![c]);
        assert_eq!(rep1.files[0].start.as_deref(), Some("2024-02-29 00:00:00"));
    }

    #[test]
    fn missing_and_unparseable_timestamps_are_ignored_in_ranges() {
        let dir = tempfile::tempdir().unwrap();
        let a = write_csv(
            &dir,
            "a.csv",
            "timestamp,S1\n,1\nnot a date,2\n2024-01-01 00:00:00,3\n2024-01-01 00:01:00,4\n",
        );
        let b = write_csv(&dir, "b.csv", "timestamp,S2\n,1\ngarbage,2\n");
        let (_, rep) = load(vec![a, b]);
        assert_eq!(rep.files[0].rows, 4, "rows READ, including undated ones");
        assert_eq!(rep.files[0].start.as_deref(), Some("2024-01-01 00:00:00"));
        assert_eq!(rep.files[0].end.as_deref(), Some("2024-01-01 00:01:00"));
        // A file with no parseable timestamp has no range - None, not a fake.
        assert_eq!(rep.files[1].rows, 2);
        assert_eq!(rep.files[1].start, None);
        assert_eq!(rep.files[1].end, None);
        assert_eq!(rep.files[1].start_micros, None);
        assert_eq!(rep.files[1].end_micros, None);

        let only_bad = write_csv(&dir, "bad.csv", "timestamp,S1\n,1\nzzz,2\n");
        let (_, rep_bad) = load(vec![only_bad]);
        assert_eq!(rep_bad.period_start, None);
        assert_eq!(rep_bad.period_end_micros, None);
        assert_eq!(rep_bad.interval_seconds, None);
        assert_eq!(rep_bad.files[0].start, None);
    }

    #[test]
    fn interval_of_a_regular_five_minute_series_is_300() {
        let dir = tempfile::tempdir().unwrap();
        let mut body = String::from("timestamp,S1\n");
        for i in 0..20 {
            body.push_str(&format!(
                "2024-01-01 {:02}:{:02}:00,{}\n",
                (i * 5) / 60,
                (i * 5) % 60,
                i
            ));
        }
        let (_, rep) = load(vec![write_csv(&dir, "reg.csv", &body)]);
        assert_eq!(rep.interval_seconds, Some(300.0));
    }

    #[test]
    fn interval_of_an_irregular_series_is_the_median_gap() {
        // gaps (s): 60, 60, 60, 600, 3600 -> median 60 (odd count).
        let ts = [0i64, 60, 120, 180, 780, 4380].map(|s| s * 1_000_000);
        assert_eq!(median_interval_seconds(&ts), Some(60.0));
        // Even count of gaps: 10, 20, 30, 100 -> mean(20, 30) = 25.
        let ts = [0i64, 10, 30, 60, 160].map(|s| s * 1_000_000);
        assert_eq!(median_interval_seconds(&ts), Some(25.0));
    }

    #[test]
    fn interval_ignores_missing_duplicates_and_unsorted_input() {
        let s = 1_000_000i64;
        // Unsorted + duplicate (gap 0) + TS_MISSING: sorted valid = 0,60,60,120
        // -> positive gaps 60, 60 -> 60.
        let ts = [120 * s, TS_MISSING, 0, 60 * s, 60 * s];
        assert_eq!(median_interval_seconds(&ts), Some(60.0));
        assert_eq!(median_interval_seconds(&[]), None);
        assert_eq!(median_interval_seconds(&[5 * s]), None);
        assert_eq!(median_interval_seconds(&[TS_MISSING, 5 * s, TS_MISSING]), None);
        // All identical: no positive gap.
        assert_eq!(median_interval_seconds(&[7 * s, 7 * s, 7 * s]), None);
    }

    #[test]
    fn interval_stride_sampling_is_deterministic_and_keeps_the_median() {
        // 4.5M valid timestamps -> 4.5M gaps > MAX_INTERVAL_SAMPLES, so the
        // stride sampler (stride 3) is exercised. Gaps alternate 1 s / 1 s /
        // 10 s, so the median stays 1 s whichever third is sampled.
        let mut ts: Vec<i64> = Vec::with_capacity(4_500_000);
        let mut t = 0i64;
        for i in 0..4_500_000usize {
            ts.push(t);
            t += if i % 3 == 2 { 10_000_000 } else { 1_000_000 };
        }
        let a = median_interval_seconds(&ts);
        assert_eq!(a, median_interval_seconds(&ts));
        assert_eq!(a, Some(1.0));
    }

    // ── the per-dataset interval cache (`ColumnarData::sample_interval_secs`) ──

    /// `n` rows `step_secs` apart; `shuffle` stores them out of order.
    fn series(n: usize, step_secs: i64, shuffle: bool) -> ColumnarData {
        let base = ts_to_micros(parse_timestamp("2024-01-01T00:00:00").unwrap());
        let stamp = |i: usize| {
            micros_to_naive(base + i as i64 * step_secs * 1_000_000)
                .unwrap()
                .format("%Y-%m-%dT%H:%M:%S")
                .to_string()
        };
        // 7 is coprime with every `n` used below: a permutation.
        let order: Vec<usize> = (0..n).map(|i| if shuffle { (i * 7) % n } else { i }).collect();
        ColumnarData::from_parts(
            vec!["timestamp".into(), "A".into()],
            order.iter().map(|&i| Some(stamp(i))).collect(),
            vec![vec![f64::NAN; n], vec![1.0; n]],
        )
    }

    #[test]
    fn cached_interval_equals_a_fresh_computation_bit_for_bit() {
        let mut cases = vec![
            series(500, 60, false),
            series(500, 60, true), // out of order: the sorting branch
            series(11, 7, false),  // even number of gaps
            series(2, 3600, false),
            series(1, 60, false), // no interval at all
            series(0, 60, false),
        ];
        // Missing / unparseable timestamps and a duplicate in between.
        cases.push(ColumnarData::from_parts(
            vec!["timestamp".into(), "A".into()],
            vec![
                Some("2024-01-01T00:00:00".into()),
                None,
                Some("garbage".into()),
                Some("2024-01-01T00:00:30".into()),
                Some("2024-01-01T00:00:30".into()),
                Some("2024-01-01T00:02:00".into()),
            ],
            vec![vec![f64::NAN; 6], vec![1.0; 6]],
        ));
        for (k, d) in cases.iter().enumerate() {
            let fresh = median_interval_seconds(&d.ts_parsed);
            let cached = d.sample_interval_secs();
            assert_eq!(cached.map(f64::to_bits), fresh.map(f64::to_bits), "case {k}");
            // ... and it stays that value on every later read.
            assert_eq!(d.sample_interval_secs().map(f64::to_bits), fresh.map(f64::to_bits), "case {k}");
        }
        assert_eq!(cases[0].sample_interval_secs(), Some(60.0));
        assert_eq!(cases[1].sample_interval_secs(), Some(60.0));
        assert_eq!(cases[4].sample_interval_secs(), None);
        assert_eq!(cases[6].sample_interval_secs(), Some(60.0), "gaps 30 s and 90 s");
    }

    #[test]
    fn the_interval_is_computed_once_per_dataset_however_often_it_is_read() {
        let d = series(300, 60, true);
        let before = median_interval_runs();
        for _ in 0..5 {
            assert_eq!(d.sample_interval_secs(), Some(60.0));
        }
        assert_eq!(median_interval_runs() - before, 1);
        // "No interval" is an answer too: it is not looked for again.
        let none = series(1, 60, false);
        let before = median_interval_runs();
        for _ in 0..5 {
            assert_eq!(none.sample_interval_secs(), None);
        }
        assert_eq!(median_interval_runs() - before, 1);
    }

    #[test]
    fn a_new_dataset_never_inherits_the_interval_of_the_previous_one() {
        // What a reload does: a NEW `ColumnarData` (via `from_parts`), whose
        // cache starts empty - the old dataset's value cannot leak into it.
        let old = series(100, 60, false);
        assert_eq!(old.sample_interval_secs(), Some(60.0));
        let before = median_interval_runs();
        let new = series(100, 300, false);
        assert_eq!(median_interval_runs(), before, "building a dataset computes nothing");
        assert_eq!(new.sample_interval_secs(), Some(300.0));
        assert_eq!(median_interval_runs() - before, 1, "computed afresh for the new dataset");
        assert_eq!(old.sample_interval_secs(), Some(60.0));
        // Rebuilding a dataset from another one's parts (the only way to change
        // its timestamps) starts from an empty cache as well.
        let mut ts = new.timestamps.clone();
        ts.truncate(1);
        let rebuilt = ColumnarData::from_parts(new.headers.clone(), ts, vec![vec![f64::NAN], vec![1.0]]);
        assert_eq!(rebuilt.sample_interval_secs(), None);
    }

    #[test]
    fn the_load_report_fills_the_cache_so_no_later_reader_computes() {
        let dir = tempfile::tempdir().unwrap();
        let mut body = String::from("timestamp,S1\n");
        for i in 0..30 {
            body.push_str(&format!("2024-01-01 00:{:02}:00,{}\n", i * 2, i));
        }
        let single = write_csv(&dir, "one.csv", &body);
        let second = write_csv(&dir, "two.csv", "timestamp,S2\n2024-01-01 02:00:00,1\n2024-01-01 02:02:00,2\n");
        // Single-file fast path and the multi-file merge alike.
        for paths in [vec![single.clone()], vec![single.clone(), second]] {
            let before = median_interval_runs();
            let (m, rep) = load(paths);
            assert_eq!(median_interval_runs() - before, 1, "one computation per load");
            assert_eq!(rep.interval_seconds, Some(120.0));
            // The dataset `load_csv` installs is `m.data`: already answered.
            assert_eq!(m.data.sample_interval_secs(), rep.interval_seconds);
            assert_eq!(m.data.sample_interval_secs(), median_interval_seconds(&m.data.ts_parsed));
            assert_eq!(median_interval_runs() - before, 2, "only the explicit fresh computation above");
        }
    }

    #[test]
    fn loaded_timestamps_are_in_text_order_which_is_time_order_for_one_format_only() {
        // Documents WHEN `median_interval_seconds` takes its sorting branch.
        // Every load path (single file and multi-file merge) orders rows by the
        // timestamp TEXT, so a file whose rows are merely out of order is
        // loaded in time order...
        let shuffled = single(
            vec!["timestamp", "A"],
            vec![
                (Some("2024-01-01 00:02:00"), vec![None, Some(2.0)]),
                (Some("2024-01-01 00:00:00"), vec![None, Some(0.0)]),
                (Some("2024-01-01 00:01:00"), vec![None, Some(1.0)]),
            ],
            vec![0, 0],
        );
        assert!(shuffled.data.ts_parsed.windows(2).all(|w| w[0] <= w[1]));
        // ... and only timestamps written in MIXED ways within one dataset end
        // up out of time order: here `T` and a space as the separator (a space
        // sorts before `T`), likewise a mix of Buddhist-Era and Gregorian years
        // (ordered by the text as written, converted afterwards).
        let mixed = single(
            vec!["timestamp", "A"],
            vec![
                (Some("2024-01-01T00:00:00"), vec![None, Some(0.0)]),
                (Some("2024-01-01 00:01:00"), vec![None, Some(1.0)]),
                (Some("2024-01-01T00:02:00"), vec![None, Some(2.0)]),
                (Some("2024-01-01 00:03:00"), vec![None, Some(3.0)]),
            ],
            vec![0, 0],
        );
        assert!(!mixed.data.ts_parsed.windows(2).all(|w| w[0] <= w[1]));
        let be_and_ce = single(
            vec!["timestamp", "A"],
            vec![
                (Some("2567-01-01 00:00:00"), vec![None, Some(0.0)]), // BE 2567 = 2024
                (Some("2024-01-01 00:01:00"), vec![None, Some(1.0)]),
                (Some("2024-01-01 00:02:00"), vec![None, Some(2.0)]),
            ],
            vec![0, 0],
        );
        assert!(!be_and_ce.data.ts_parsed.windows(2).all(|w| w[0] <= w[1]));
        // The interval is right either way (and cached either way).
        for m in [&shuffled, &mixed, &be_and_ce] {
            assert_eq!(m.data.sample_interval_secs(), Some(60.0));
        }
    }

    #[test]
    fn missing_percent_is_exact_on_a_small_fixture() {
        let dir = tempfile::tempdir().unwrap();
        // 4 rows x 3 sensors = 12 cells. Empty: S1 row 3, S2 rows 1 and 4;
        // plus a non-numeric cell (-> NaN) in S3 row 2 => 4 empty of 12.
        let body = "timestamp,S1,S2,S3\n\
            2024-01-01 00:00:00,1,,1\n\
            2024-01-01 00:01:00,2,2,abc\n\
            2024-01-01 00:02:00,,3,3\n\
            2024-01-01 00:03:00,4,,4\n";
        let (_, rep) = load(vec![write_csv(&dir, "m.csv", body)]);
        assert_eq!(rep.total_rows, 4);
        let pct = rep.missing_percent.unwrap();
        assert!((pct - 100.0 * 4.0 / 12.0).abs() < 1e-9, "got {pct}");
    }

    #[test]
    fn missing_percent_bounds_and_none_cases() {
        let dir = tempfile::tempdir().unwrap();
        let full = write_csv(
            &dir,
            "full.csv",
            "timestamp,A\n2024-01-01 00:00:00,1\n2024-01-01 00:01:00,2\n",
        );
        assert_eq!(load(vec![full]).1.missing_percent, Some(0.0));
        let empty = write_csv(
            &dir,
            "empty.csv",
            "timestamp,A\n2024-01-01 00:00:00,\n2024-01-01 00:01:00,\n",
        );
        assert_eq!(load(vec![empty]).1.missing_percent, Some(100.0));
        // Timestamp-only file: no sensor column -> None, not 0 or NaN.
        let ts_only = write_csv(&dir, "tsonly.csv", "timestamp\n2024-01-01 00:00:00\n");
        assert_eq!(load(vec![ts_only]).1.missing_percent, None);
        // Header only: no rows -> None.
        let none = write_csv(&dir, "hdr.csv", "timestamp,A\n");
        assert_eq!(load(vec![none]).1.missing_percent, None);
    }

    #[test]
    fn multi_file_missing_percent_counts_merged_empty_cells() {
        let dir = tempfile::tempdir().unwrap();
        let a = write_csv(
            &dir,
            "a.csv",
            "timestamp,S1\n2024-01-01 00:00:00,1\n2024-01-01 00:01:00,2\n",
        );
        let b = write_csv(&dir, "b.csv", "timestamp,S2\n2024-01-01 00:00:00,5\n");
        // Merged: 2 rows x 2 sensors = 4 cells, S2 empty at 00:01 -> 25%.
        let (_, rep) = load(vec![a, b]);
        assert_eq!(rep.missing_percent, Some(25.0));
    }

    #[test]
    fn load_behaviour_is_unchanged_by_the_report_additions() {
        // Duplicate timestamp: later non-null wins, undated row dropped.
        let dir = tempfile::tempdir().unwrap();
        let a = write_csv(
            &dir,
            "a.csv",
            "timestamp,S1\n2024-01-01 00:00:00,1\n2024-01-01 00:00:00,\n,9\n2024-01-01 00:01:00,3\n",
        );
        let (m, rep) = load(vec![a]);
        assert_eq!(m.data.n_rows(), 2);
        assert_eq!(rep.total_rows, 2);
        assert_eq!(m.data.value(1, 0), Some(1.0));
        assert_eq!(rep.files[0].rows, 4);
    }

    #[test]
    fn old_report_json_without_the_new_fields_still_deserialises() {
        let rep: CsvLoadReport = serde_json::from_str(
            r#"{"headers":["timestamp"],"total_rows":0,"columns":[],"warnings":[],"generation":3}"#,
        )
        .unwrap();
        assert!(rep.files.is_empty());
        assert_eq!(rep.period_start, None);
        assert_eq!(rep.period_end_micros, None);
        assert_eq!(rep.interval_seconds, None);
        assert_eq!(rep.missing_percent, None);
        assert_eq!(rep.generation, 3);
        // A file entry saved before start/end existed also loads.
        let f: CsvFileInfo =
            serde_json::from_str(r#"{"name":"a.csv","size_bytes":10,"rows":2}"#).unwrap();
        assert_eq!(f.start, None);
        assert_eq!(f.end_micros, None);
    }

    #[test]
    fn new_report_fields_serialise_with_snake_case_keys() {
        let dir = tempfile::tempdir().unwrap();
        let p = write_csv(
            &dir,
            "j.csv",
            "timestamp,S1\n2024-01-01 00:00:00,1\n2024-01-01 00:05:00,2\n",
        );
        let (_, rep) = load(vec![p]);
        let v = serde_json::to_value(&rep).unwrap();
        assert_eq!(v["files"][0]["name"], "j.csv");
        assert!(v["files"][0]["size_bytes"].as_u64().unwrap() > 0);
        assert_eq!(v["files"][0]["rows"], 2);
        assert_eq!(v["files"][0]["start"], "2024-01-01 00:00:00");
        assert_eq!(v["files"][0]["end"], "2024-01-01 00:05:00");
        assert_eq!(v["files"][0]["start_micros"], micros("2024-01-01 00:00:00"));
        assert_eq!(v["files"][0]["end_micros"], micros("2024-01-01 00:05:00"));
        assert_eq!(v["period_start"], "2024-01-01 00:00:00");
        assert_eq!(v["period_end"], "2024-01-01 00:05:00");
        assert_eq!(v["period_start_micros"], micros("2024-01-01 00:00:00"));
        assert_eq!(v["period_end_micros"], micros("2024-01-01 00:05:00"));
        assert_eq!(v["interval_seconds"], 300.0);
        assert_eq!(v["missing_percent"], 0.0);
    }

    // ── csv-load-progress payload / sequence ────────────────────────────────

    #[test]
    fn progress_payload_json_shape() {
        let p = CsvLoadProgress::reading(1, 3, "b.csv", false);
        assert_eq!(
            serde_json::to_value(&p).unwrap(),
            serde_json::json!({
                "file_index": 1, "file_count": 3, "file_name": "b.csv",
                "stage": "reading", "files_done": 1
            })
        );
        let fin = CsvLoadProgress::reading(1, 3, "b.csv", true);
        assert_eq!(fin.files_done, 2);
        assert_eq!(
            serde_json::to_value(CsvLoadProgress::after_reading(3, false)).unwrap(),
            serde_json::json!({
                "file_index": 3, "file_count": 3, "file_name": "",
                "stage": "merging", "files_done": 3
            })
        );
        assert_eq!(
            serde_json::to_value(CsvLoadProgress::after_reading(3, true)).unwrap()["stage"],
            "done"
        );
    }

    #[test]
    fn load_emits_reading_per_file_then_merging() {
        let dir = tempfile::tempdir().unwrap();
        let a = write_csv(&dir, "a.csv", "timestamp,S1\n2024-01-01 00:00:00,1\n");
        let b = write_csv(&dir, "b.csv", "timestamp,S2\n2024-01-01 00:01:00,2\n");
        let events: Mutex<Vec<CsvLoadProgress>> = Mutex::new(Vec::new());
        read_merge_csvs_with_progress(vec![a, b], &|p| events.lock().unwrap().push(p)).unwrap();
        let ev = events.into_inner().unwrap();
        let seq: Vec<(CsvLoadStage, usize, usize, &str)> = ev
            .iter()
            .map(|e| (e.stage, e.file_index, e.files_done, e.file_name.as_str()))
            .collect();
        assert_eq!(
            seq,
            vec![
                (CsvLoadStage::Reading, 0, 0, "a.csv"),
                (CsvLoadStage::Reading, 0, 1, "a.csv"),
                (CsvLoadStage::Reading, 1, 1, "b.csv"),
                (CsvLoadStage::Reading, 1, 2, "b.csv"),
                (CsvLoadStage::Merging, 2, 2, ""),
            ]
        );
        assert!(ev.iter().all(|e| e.file_count == 2));
    }

    #[test]
    fn single_file_load_still_emits_reading_and_merging() {
        let dir = tempfile::tempdir().unwrap();
        let a = write_csv(&dir, "a.csv", "timestamp,S1\n2024-01-01 00:00:00,1\n");
        let events: Mutex<Vec<CsvLoadStage>> = Mutex::new(Vec::new());
        read_merge_csvs_with_progress(vec![a], &|p| events.lock().unwrap().push(p.stage)).unwrap();
        assert_eq!(
            events.into_inner().unwrap(),
            vec![CsvLoadStage::Reading, CsvLoadStage::Reading, CsvLoadStage::Merging]
        );
    }

    #[test]
    fn a_failing_file_stops_the_load_without_a_merging_event() {
        let dir = tempfile::tempdir().unwrap();
        let ok = write_csv(&dir, "ok.csv", "timestamp,S1\n2024-01-01 00:00:00,1\n");
        let missing = dir.path().join("nope.csv").to_string_lossy().into_owned();
        let events: Mutex<Vec<CsvLoadStage>> = Mutex::new(Vec::new());
        let r = read_merge_csvs_with_progress(vec![ok, missing], &|p| {
            events.lock().unwrap().push(p.stage)
        });
        assert!(r.is_err());
        assert!(!events.into_inner().unwrap().contains(&CsvLoadStage::Merging));
    }
}
