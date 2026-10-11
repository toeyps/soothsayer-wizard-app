//! Structured diagnostics for the special-sensor formula gate (Formula editor
//! + Quick build).
//!
//! The VERDICT on a formula is still decided by the one gate in `lib.rs`
//! (`check_formula_limits` → `resolve_formula_sources` → `compile_formula`):
//! fasteval parses it, a trial evaluation proves every name/arity resolves,
//! and the app's own refusals (`round(x, n)`, division by a literal 0) run
//! last. This module only CLASSIFIES a refusal the gate already made — a
//! stable `code` plus, where it can be located, a `range` into the user's own
//! text — so `preview_formula`, `validate_formula` and Create/Save can never
//! disagree about whether a formula is valid or what the message says.
//!
//! Ranges are `[start, end)` in UTF-16 code units of the ORIGINAL formula text
//! (what a JS string index / textarea selection uses). For Thai and every
//! other BMP character that is the same as the character index.
//!
//! Also home of the legacy `round(x, n)` → `round(x * 10^n) / 10^n`
//! converter (old workspaces are auto-converted on load). It walks the
//! SAME call scan (`crate::excel_round_calls`) as the refusal, so a formula is
//! converted exactly when, and exactly where, it would be refused.

use crate::{
    excel_round_calls, is_formula_atom, ref_mask, round_places, scan_sensor_refs, SensorRefSpan,
};
use serde::Serialize;

// ── Stable issue codes (the frontend keys fix buttons on these) ─────────────
pub(crate) const UNKNOWN_FUNCTION: &str = "unknown_function";
pub(crate) const UNKNOWN_SENSOR: &str = "unknown_sensor";
pub(crate) const BAD_ARG_COUNT: &str = "bad_arg_count";
pub(crate) const TOO_LONG: &str = "too_long";
pub(crate) const TOO_DEEP: &str = "too_deep";
pub(crate) const UNCLOSED_BRACKET: &str = "unclosed_bracket";
pub(crate) const UNMATCHED_CLOSE: &str = "unmatched_close";
pub(crate) const EMPTY_BRACKETS: &str = "empty_brackets";
pub(crate) const OP_NO_LEFT: &str = "op_no_left";
pub(crate) const OP_NO_RIGHT: &str = "op_no_right";
pub(crate) const MISSING_OPERATOR: &str = "missing_operator";
pub(crate) const STRAY_COMMA: &str = "stray_comma";
pub(crate) const FN_NO_BRACKET: &str = "fn_no_bracket";
pub(crate) const CONSTANT_ONLY: &str = "constant_only";
pub(crate) const DIV_ZERO: &str = "div_zero";
pub(crate) const BAD_NUMBER: &str = "bad_number";
pub(crate) const BAD_CHAR: &str = "bad_char";
pub(crate) const AGG_TOO_FEW: &str = "agg_too_few";
pub(crate) const ROUND_EXCEL: &str = "round_excel";
/// Aggregate block: `type` is not sum / mean / median.
pub(crate) const UNKNOWN_OPERATION: &str = "unknown_operation";
/// Aggregate block: `decimals` is not a whole number in 0..=MAX_OPERATION_DECIMALS.
pub(crate) const BAD_DECIMALS: &str = "bad_decimals";
/// Fallback when fasteval refused and nothing more specific could be located.
pub(crate) const PARSE_ERROR: &str = "parse_error";

/// One reason a formula / aggregate block is refused.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct FormulaIssue {
    pub code: &'static str,
    pub message: String,
    /// `[start, end)` in UTF-16 code units of the user's original text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<[usize; 2]>,
}

/// Every String-returning path (Create / Save / replay) keeps answering with
/// the message alone, so `?` works unchanged in those functions.
impl From<FormulaIssue> for String {
    fn from(issue: FormulaIssue) -> String {
        issue.message
    }
}

/// UTF-16 offset of every char boundary: `out[i]` = offset of char `i`,
/// `out[len]` = total length.
fn utf16_offsets(chars: &[char]) -> Vec<usize> {
    let mut out = Vec::with_capacity(chars.len() + 1);
    let mut at = 0usize;
    for c in chars {
        out.push(at);
        at += c.len_utf16();
    }
    out.push(at);
    out
}

/// Build an issue whose `range` is given in CHAR indices of `formula`.
pub(crate) fn issue_at(
    formula: &str,
    code: &'static str,
    message: impl Into<String>,
    char_range: Option<(usize, usize)>,
) -> FormulaIssue {
    let range = char_range.map(|(a, b)| {
        let chars: Vec<char> = formula.chars().collect();
        let off = utf16_offsets(&chars);
        let a = a.min(chars.len());
        let b = b.clamp(a, chars.len());
        [off[a], off[b]]
    });
    FormulaIssue { code, message: message.into(), range }
}

// ---------------------------------------------------------------------------
// Tokenizer (classification only — fasteval stays the parser of record)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TokKind {
    /// `$Name` / `${Name}` (one `scan_sensor_refs` span)
    Ref,
    Num,
    /// A bare ASCII identifier: a function name, `pi` / `e`, or a typo.
    Word,
    Op,
    Open,
    Close,
    /// `,` or `;` (fasteval accepts both as argument separators)
    Comma,
    Bad,
}

#[derive(Debug, Clone)]
pub(crate) struct Tok {
    pub kind: TokKind,
    /// char indices, end exclusive
    pub start: usize,
    pub end: usize,
    pub text: String,
    /// for `Ref`: index into the formula's `scan_sensor_refs` spans
    pub span: Option<usize>,
}

/// Split `chars` into tokens the way fasteval reads them (ASCII identifiers,
/// numbers with an exponent or one SI suffix, two-char comparison/logic
/// operators), with sensor references taken from the shared
/// `scan_sensor_refs` spans so a name never splits differently here.
pub(crate) fn tokenize(chars: &[char], spans: &[SensorRefSpan]) -> Vec<Tok> {
    use TokKind::*;
    let len = chars.len();
    let mut out = Vec::new();
    let mut i = 0;
    let mut si = 0;
    while i < len {
        while si < spans.len() && spans[si].end <= i {
            si += 1;
        }
        if si < spans.len() && spans[si].start == i {
            out.push(Tok {
                kind: Ref,
                start: i,
                end: spans[si].end,
                text: spans[si].token.clone(),
                span: Some(si),
            });
            i = spans[si].end;
            si += 1;
            continue;
        }
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        let start = i;
        let kind = if c.is_ascii_digit() || c == '.' {
            while i < len && (chars[i].is_ascii_digit() || chars[i] == '.') {
                i += 1;
            }
            let mut exponent = false;
            if i < len && (chars[i] == 'e' || chars[i] == 'E') {
                let mut j = i + 1;
                if j < len && (chars[j] == '+' || chars[j] == '-') {
                    j += 1;
                }
                if j < len && chars[j].is_ascii_digit() {
                    while j < len && chars[j].is_ascii_digit() {
                        j += 1;
                    }
                    i = j;
                    exponent = true;
                }
            }
            if !exponent
                && i < len
                && matches!(chars[i], 'k' | 'K' | 'M' | 'G' | 'T' | 'm' | 'u' | 'µ' | 'n' | 'p')
            {
                i += 1;
            }
            Num
        } else if c.is_ascii_alphabetic() || c == '_' {
            while i < len && (chars[i].is_ascii_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            Word
        } else {
            i += 1;
            match c {
                '(' | '[' => Open,
                ')' | ']' => Close,
                ',' | ';' => Comma,
                '+' | '-' | '*' | '/' | '%' | '^' => Op,
                '<' | '>' => {
                    if i < len && chars[i] == '=' {
                        i += 1;
                    }
                    Op
                }
                '=' | '!' => {
                    if i < len && chars[i] == '=' {
                        i += 1;
                        Op
                    } else if c == '!' {
                        Op
                    } else {
                        Bad
                    }
                }
                '&' | '|' => {
                    if i < len && chars[i] == c {
                        i += 1;
                        Op
                    } else {
                        Bad
                    }
                }
                _ => Bad,
            }
        };
        out.push(Tok { kind, start, end: i, text: chars[start..i].iter().collect(), span: None });
    }
    out
}

/// A number token's value (`2k` = 2000, `5m` = 0.005, …), or `None` when it
/// is not a number at all (`1.2.3`, `.`).
fn number_value(text: &str) -> Option<f64> {
    let (body, scale) = match text.chars().last() {
        Some(s @ ('k' | 'K' | 'M' | 'G' | 'T' | 'm' | 'u' | 'µ' | 'n' | 'p')) => {
            let exp = match s {
                'k' | 'K' => 3,
                'M' => 6,
                'G' => 9,
                'T' => 12,
                'm' => -3,
                'u' | 'µ' => -6,
                'n' => -9,
                _ => -12,
            };
            (&text[..text.len() - s.len_utf8()], 10f64.powi(exp))
        }
        _ => (text, 1.0),
    };
    body.parse::<f64>().ok().map(|v| v * scale)
}

fn is_unary(t: &Tok) -> bool {
    t.kind == TokKind::Op && matches!(t.text.as_str(), "+" | "-" | "!")
}

/// The first structural problem, left to right: `(code, char start, char end)`.
pub(crate) fn locate_syntax_issue(toks: &[Tok]) -> Option<(&'static str, usize, usize)> {
    use TokKind::*;
    struct Frame {
        tok: usize,
        call: bool,
    }
    let mut stack: Vec<Frame> = Vec::new();
    for (k, t) in toks.iter().enumerate() {
        let p = k.checked_sub(1).map(|j| &toks[j]);
        let n = toks.get(k + 1);
        match t.kind {
            Bad => return Some((BAD_CHAR, t.start, t.end)),
            Num if number_value(&t.text).is_none() => return Some((BAD_NUMBER, t.start, t.end)),
            Open => {
                let call = p.is_some_and(|p| p.kind == Word);
                if let Some(n) = n.filter(|n| n.kind == Close) {
                    if !call {
                        return Some((EMPTY_BRACKETS, t.start, n.end));
                    }
                }
                stack.push(Frame { tok: k, call });
            }
            Close => {
                let Some(f) = stack.pop() else {
                    return Some((UNMATCHED_CLOSE, t.start, t.end));
                };
                let want = if toks[f.tok].text == "(" { ")" } else { "]" };
                if t.text != want {
                    return Some((UNMATCHED_CLOSE, t.start, t.end));
                }
            }
            Comma => {
                let in_call = stack.last().is_some_and(|f| f.call);
                let left_ok = p.is_some_and(|p| !matches!(p.kind, Open | Comma | Op));
                let right_ok = n.is_some_and(|n| !matches!(n.kind, Close | Comma));
                if !in_call || !left_ok || !right_ok {
                    return Some((STRAY_COMMA, t.start, t.end));
                }
            }
            Op => {
                let start_ctx = p.is_none_or(|p| matches!(p.kind, Op | Comma | Open));
                if start_ctx && !is_unary(t) {
                    return Some((OP_NO_LEFT, t.start, t.end));
                }
                let right_bad =
                    n.is_none_or(|n| matches!(n.kind, Close | Comma) || (n.kind == Op && !is_unary(n)));
                if right_bad {
                    return Some((OP_NO_RIGHT, t.start, t.end));
                }
            }
            _ => {}
        }
        let value_end = matches!(t.kind, Ref | Num | Close)
            || (t.kind == Word && !n.is_some_and(|n| n.kind == Open));
        if let Some(n) = n {
            if value_end && matches!(n.kind, Ref | Num | Word | Open) {
                return Some((MISSING_OPERATOR, t.start, n.end));
            }
        }
    }
    stack.last().map(|f| {
        let o = &toks[f.tok];
        (UNCLOSED_BRACKET, o.start, o.end)
    })
}

/// One call `name(…)` / `name[…]`: tokens of the name, the opening and the
/// matching closing bracket (if any), and its top-level argument count.
struct Call {
    word: usize,
    close: Option<usize>,
    argc: usize,
}

fn calls_named<'a>(toks: &'a [Tok], name: &'a str) -> impl Iterator<Item = Call> + 'a {
    use TokKind::*;
    (0..toks.len()).filter_map(move |k| {
        let t = &toks[k];
        if t.kind != Word || t.text != name || toks.get(k + 1).is_none_or(|n| n.kind != Open) {
            return None;
        }
        let mut depth = 0i32;
        let mut argc = 0usize;
        let mut close = None;
        for (j, x) in toks.iter().enumerate().skip(k + 1) {
            match x.kind {
                Open => {
                    depth += 1;
                    if depth == 1 && toks.get(j + 1).is_some_and(|n| n.kind != Close) {
                        argc = 1;
                    }
                }
                Close => {
                    depth -= 1;
                    if depth == 0 {
                        close = Some(j);
                        break;
                    }
                }
                Comma if depth == 1 => argc += 1,
                _ => {}
            }
        }
        Some(Call { word: k, close, argc })
    })
}

/// Accepted argument counts of every engine function, for picking WHICH call
/// of a name is the wrong one.
fn arity(name: &str) -> Option<(usize, usize)> {
    Some(match name {
        "pi" | "e" => (0, 0),
        "log" | "round" => (1, 2),
        "min" | "max" => (1, usize::MAX),
        "pow" => (2, 2),
        n if crate::FORMULA_FUNCTIONS.contains(&n) => (1, 1),
        _ => return None,
    })
}

/// Char range of the call of `name` whose argument count is wrong (else the
/// first call), from the name through its closing bracket.
fn bad_call_range(toks: &[Tok], name: &str) -> Option<(usize, usize)> {
    let range = |c: &Call| {
        let end = c.close.map_or(toks[c.word + 1].end, |j| toks[j].end);
        (toks[c.word].start, end)
    };
    let wrong = |c: &Call| arity(name).is_some_and(|(lo, hi)| c.argc < lo || c.argc > hi);
    calls_named(toks, name)
        .find(wrong)
        .or_else(|| calls_named(toks, name).next())
        .map(|c| range(&c))
}

/// Char range of the first `name` NOT followed by a bracket.
fn bare_word_range(toks: &[Tok], name: &str) -> Option<(usize, usize)> {
    toks.iter()
        .enumerate()
        .find(|(k, t)| {
            t.kind == TokKind::Word
                && t.text == name
                && toks.get(k + 1).is_none_or(|n| n.kind != TokKind::Open)
        })
        .map(|(_, t)| (t.start, t.end))
}

/// Char range of the first `name(` (the name only).
fn call_word_range(toks: &[Tok], name: &str) -> Option<(usize, usize)> {
    calls_named(toks, name).next().map(|c| (toks[c.word].start, toks[c.word].end))
}

/// Char range of the first token at or after char `pos`.
fn token_range_at(toks: &[Tok], pos: usize) -> Option<(usize, usize)> {
    toks.iter().find(|t| t.end > pos).map(|t| (t.start, t.end))
}

/// The function name in one of fasteval's `WrongArgs` texts
/// (`"abs: expected one arg"`, `"expected log(x) or log(base,x)"`).
fn wrong_args_name(text: &str) -> Option<&str> {
    let text = text.strip_prefix("expected ").unwrap_or(text);
    let end = text.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).unwrap_or(text.len());
    (end > 0).then(|| &text[..end])
}

struct Ctx {
    chars: Vec<char>,
    spans: Vec<SensorRefSpan>,
    toks: Vec<Tok>,
}

impl Ctx {
    fn new(formula: &str) -> Self {
        let chars: Vec<char> = formula.chars().collect();
        let spans = scan_sensor_refs(formula);
        let toks = tokenize(&chars, &spans);
        Ctx { chars, spans, toks }
    }
}

/// Classify a fasteval PARSE refusal. `message` is the gate's own text;
/// `expr` / `byte_map` are the rewritten text and its byte → original-char
/// map (`prepare_formula_for_eval_mapped`), used to place a remaining-text
/// error the structural scan could not explain.
pub(crate) fn parse_issue(
    formula: &str,
    err: &fasteval::Error,
    message: String,
    expr: &str,
    byte_map: &[usize],
) -> FormulaIssue {
    use fasteval::Error as E;
    let ctx = Ctx::new(formula);
    let (code, range) = match err {
        E::TooDeep => (TOO_DEEP, None),
        E::TooLong | E::SlabOverflow => (TOO_LONG, None),
        E::WrongArgs(s) => (BAD_ARG_COUNT, wrong_args_name(s).and_then(|n| bad_call_range(&ctx.toks, n))),
        E::ParseF64(_) => (
            BAD_NUMBER,
            ctx.toks
                .iter()
                .find(|t| t.kind == TokKind::Num && number_value(&t.text).is_none())
                .map(|t| (t.start, t.end)),
        ),
        other => match locate_syntax_issue(&ctx.toks) {
            Some((code, a, b)) => (code, Some((a, b))),
            None => match other {
                E::UnparsedTokensRemaining(rest) => {
                    let pos = expr.len().saturating_sub(rest.len());
                    let at = byte_map.get(pos).copied().unwrap_or(ctx.chars.len());
                    (MISSING_OPERATOR, token_range_at(&ctx.toks, at))
                }
                _ => (PARSE_ERROR, None),
            },
        },
    };
    issue_at(formula, code, message, range)
}

/// Classify a trial-EVALUATION refusal (an unresolved name / arity).
/// `failed` is `(name, argument count)` of the first name the namespace could
/// not answer; `safe_names` maps generated variable names back to sensors.
pub(crate) fn eval_issue(
    formula: &str,
    err: &fasteval::Error,
    failed: Option<&(String, usize)>,
    safe_names: &[(String, String)],
    message: String,
) -> FormulaIssue {
    let name = match err {
        fasteval::Error::Undefined(name) => name,
        _ => return issue_at(formula, PARSE_ERROR, message, None),
    };
    let nargs = failed.filter(|(n, _)| n == name).map(|(_, k)| *k).unwrap_or(0);
    let ctx = Ctx::new(formula);
    let toks = &ctx.toks;

    if let Some((_, sensor)) = safe_names.iter().find(|(s, _)| s == name) {
        // `$A(2)`: a sensor followed by a bracket.
        let range = toks.iter().enumerate().find_map(|(k, t)| {
            let is_it = t.kind == TokKind::Ref
                && t.span.is_some_and(|s| ctx.spans[s].name == *sensor)
                && toks.get(k + 1).is_some_and(|n| n.kind == TokKind::Open);
            is_it.then(|| (t.start, toks[k + 1].end))
        });
        return issue_at(formula, MISSING_OPERATOR, message, range);
    }
    let (code, range) = if arity(name).is_some() {
        match bare_word_range(toks, name) {
            Some(r) if nargs == 0 => (FN_NO_BRACKET, Some(r)),
            _ => (BAD_ARG_COUNT, bad_call_range(toks, name)),
        }
    } else if nargs > 0 {
        (UNKNOWN_FUNCTION, call_word_range(toks, name))
    } else {
        (UNKNOWN_FUNCTION, bare_word_range(toks, name).or_else(|| call_word_range(toks, name)))
    };
    issue_at(formula, code, message, range)
}

/// Message for a literal division by zero (`$A / 0`). Worded about the
/// divided PART, not the whole sensor: `min($A / 0, $B)` or
/// `($A / 0 > 0) * $B` still have values, but `$A / 0` itself never does
/// (±infinity / 0÷0 is "no value"), so it is always a mistake.
pub(crate) const DIV_ZERO_MESSAGE: &str =
    "Formula error: division by 0 gives no value on any row. Divide by a sensor or a number other than 0.";

/// `$A / 0` (a literal zero, not raised to a power) — refused when a sensor
/// is CREATED (and in the editor's create-mode check); a recompute / replay
/// of a saved recipe skips it (`create_only_formula_issue` in `lib.rs`).
///
/// Refused for every formula containing it rather than only when the WHOLE
/// result would be empty: whether the empty part reaches the result depends
/// on the operators around it and on the row values (`min`, comparisons,
/// `&&`), which a text check cannot decide, and no real recipe divides by a
/// literal 0 on purpose.
pub(crate) fn division_by_zero(formula: &str) -> Option<FormulaIssue> {
    let ctx = Ctx::new(formula);
    let toks = &ctx.toks;
    toks.windows(2).enumerate().find_map(|(k, w)| {
        let hit = w[0].kind == TokKind::Op
            && w[0].text == "/"
            && w[1].kind == TokKind::Num
            && number_value(&w[1].text) == Some(0.0)
            && !toks.get(k + 2).is_some_and(|n| n.kind == TokKind::Op && n.text == "^");
        hit.then(|| issue_at(formula, DIV_ZERO, DIV_ZERO_MESSAGE, Some((w[0].start, w[1].end))))
    })
}

// ---------------------------------------------------------------------------
// Legacy `round(x, n)` converter
// ---------------------------------------------------------------------------

/// Rewrite every spreadsheet-style `round(<expr with a sensor>, <n>)` into the
/// form the refusal message recommends: `round(X * 10^n) / 10^n` (brackets
/// around X unless it is one operand), and `round(X)` for n = 0. A call whose
/// `n` is not a whole number 0..=15 (`round($A, 0.5)`) is left as it is — it
/// stays refused with its own message. Nested calls, several calls, `${…}`
/// names and fasteval's `round[ … ; … ]` spelling are all handled; formulas
/// without such a call come back unchanged, and converting twice changes
/// nothing more (the result has no two-value round left to convert).
///
/// The replacement gets an outer bracket unless the call stands alone as a
/// whole operand of `+`/`-`/a group/an argument, so the added `/ 10^n` can
/// never bind to a neighbour (`2 ^ round($A, 1)` → `2 ^ (round($A * 10) / 10)`).
pub(crate) fn convert_legacy_round(formula: &str) -> String {
    // Bounded: the scan is quadratic in the number of calls.
    if formula.chars().count() > 2 * crate::MAX_FORMULA_LEN {
        return formula.to_string();
    }
    let mut chars: Vec<char> = formula.chars().collect();
    let starts: Vec<usize> = {
        let spans = scan_sensor_refs(formula);
        let in_ref = ref_mask(chars.len(), &spans);
        excel_round_calls(&chars, &in_ref, &spans).into_iter().map(|c| c.start).collect()
    };
    // Right to left: a rewrite only moves text AFTER its own start, so every
    // earlier start (an enclosing call included) is still where it was.
    for &start in starts.iter().rev() {
        let text: String = chars.iter().collect();
        let spans = scan_sensor_refs(&text);
        let in_ref = ref_mask(chars.len(), &spans);
        let Some(call) = excel_round_calls(&chars, &in_ref, &spans).into_iter().find(|c| c.start == start)
        else {
            continue;
        };
        let n_text: String = chars[call.n.0..call.n.1].iter().collect::<String>().trim().to_string();
        let Some(places) = round_places(&n_text) else { continue };
        let x_text: String = chars[call.x.0..call.x.1].iter().collect::<String>().trim().to_string();
        let replacement = if places == 0 {
            format!("round({})", x_text)
        } else {
            let scale = 10u64.pow(places);
            let x = if is_formula_atom(&chars, &in_ref, &spans, call.x.0, call.x.1) {
                x_text
            } else {
                format!("({})", x_text)
            };
            let core = format!("round({} * {}) / {}", x, scale, scale);
            if stands_alone(&chars, &in_ref, call.start, call.end) {
                core
            } else {
                format!("({})", core)
            }
        };
        chars.splice(call.start..call.end, replacement.chars());
    }
    chars.into_iter().collect()
}

/// Can `round(…) / k` replace the call at `start..end` without brackets?
/// Only when the call is a whole operand: preceded by the start, an opening
/// bracket, a separator or a BINARY `+`/`-`, and followed by the end, a
/// closing bracket, a separator, `+`, `-`, `*` or `/` (left-to-right, so
/// `(round(..) / k) * 3` and `round(..) / k * 3` are the same evaluation).
fn stands_alone(chars: &[char], in_ref: &[bool], start: usize, end: usize) -> bool {
    let prev = (0..start).rev().find(|&i| in_ref[i] || !chars[i].is_whitespace());
    let next = (end..chars.len()).find(|&i| in_ref[i] || !chars[i].is_whitespace());
    let value_end = |i: usize| {
        in_ref[i] || chars[i].is_ascii_alphanumeric() || matches!(chars[i], '_' | '.' | ')' | ']')
    };
    let prev_ok = match prev {
        None => true,
        Some(i) if in_ref[i] => false,
        Some(i) => match chars[i] {
            '(' | '[' | ',' | ';' => true,
            '+' | '-' => (0..i).rev().find(|&j| in_ref[j] || !chars[j].is_whitespace()).is_some_and(value_end),
            _ => false,
        },
    };
    let next_ok = match next {
        None => true,
        Some(i) => !in_ref[i] && matches!(chars[i], ')' | ']' | ',' | ';' | '+' | '-' | '*' | '/'),
    };
    prev_ok && next_ok
}

#[cfg(test)]
mod tests {
    use super::*;

    fn toks(f: &str) -> Vec<Tok> {
        let chars: Vec<char> = f.chars().collect();
        tokenize(&chars, &scan_sensor_refs(f))
    }

    fn syntax(f: &str) -> Option<(&'static str, usize, usize)> {
        locate_syntax_issue(&toks(f))
    }

    #[test]
    fn tokenizer_keeps_references_numbers_and_two_char_operators_whole() {
        let t = toks("${อุณหภูมิ ถัง} >= 2.5e-3*$A.PV && !$B");
        let kinds: Vec<_> = t.iter().map(|t| (t.kind, t.text.as_str())).collect();
        assert_eq!(
            kinds,
            vec![
                (TokKind::Ref, "${อุณหภูมิ ถัง}"),
                (TokKind::Op, ">="),
                (TokKind::Num, "2.5e-3"),
                (TokKind::Op, "*"),
                (TokKind::Ref, "$A.PV"),
                (TokKind::Op, "&&"),
                (TokKind::Op, "!"),
                (TokKind::Ref, "$B"),
            ]
        );
        assert_eq!(number_value("2k"), Some(2000.0));
        assert_eq!(number_value("5m"), Some(0.005));
        assert_eq!(number_value("1.2.3"), None);
        assert_eq!(number_value("."), None);
    }

    #[test]
    fn structural_scan_finds_each_kind_of_problem_with_its_char_range() {
        assert_eq!(syntax("$A + $B"), None);
        assert_eq!(syntax("-$A + max($A, -1)"), None);
        assert_eq!(syntax("pi() * $A"), None);
        assert_eq!(syntax("$A $B"), Some((MISSING_OPERATOR, 0, 5)));
        assert_eq!(syntax("$A (1)"), Some((MISSING_OPERATOR, 0, 4)));
        assert_eq!(syntax("$A + )"), Some((OP_NO_RIGHT, 3, 4)));
        assert_eq!(syntax("$A )"), Some((UNMATCHED_CLOSE, 3, 4)));
        assert_eq!(syntax("($A]"), Some((UNMATCHED_CLOSE, 3, 4)));
        assert_eq!(syntax("(($A + 1)"), Some((UNCLOSED_BRACKET, 0, 1)));
        assert_eq!(syntax("$A * ()"), Some((EMPTY_BRACKETS, 5, 7)));
        assert_eq!(syntax("* $A"), Some((OP_NO_LEFT, 0, 1)));
        assert_eq!(syntax("$A +"), Some((OP_NO_RIGHT, 3, 4)));
        assert_eq!(syntax("$A, $B"), Some((STRAY_COMMA, 2, 3)));
        assert_eq!(syntax("max($A,)"), Some((STRAY_COMMA, 6, 7)));
        assert_eq!(syntax("$A @ 2"), Some((BAD_CHAR, 3, 4)));
        assert_eq!(syntax("$A + 1.2.3"), Some((BAD_NUMBER, 5, 10)));
        assert_eq!(syntax("$A = 2"), Some((BAD_CHAR, 3, 4)));
    }

    #[test]
    fn wrong_args_names_are_read_from_fastevals_texts() {
        assert_eq!(wrong_args_name("abs: expected one arg"), Some("abs"));
        assert_eq!(wrong_args_name("expected log(x) or log(base,x)"), Some("log"));
        assert_eq!(wrong_args_name("round: expected round(x) or round(modulus,x)"), Some("round"));
    }

    #[test]
    fn issue_ranges_are_utf16_offsets() {
        // 😀 is two UTF-16 units; Thai is one per char.
        let f = "${a😀} + $x";
        let i = issue_at(f, UNKNOWN_SENSOR, "m", Some((8, 10)));
        assert_eq!(i.range, Some([9, 11]));
        assert_eq!(&f.encode_utf16().collect::<Vec<_>>()[9..11], &"$x".encode_utf16().collect::<Vec<_>>()[..]);
        let i = issue_at("${ถัง} + $x", UNKNOWN_SENSOR, "m", Some((8, 10)));
        assert_eq!(i.range, Some([8, 10]));
        assert_eq!(issue_at("$A", PARSE_ERROR, "m", None).range, None);
    }

    #[test]
    fn issue_serializes_without_a_range_when_none_is_known() {
        let v = serde_json::to_value(issue_at("$A", TOO_LONG, "m", None)).unwrap();
        assert_eq!(v, serde_json::json!({ "code": "too_long", "message": "m" }));
        let v = serde_json::to_value(issue_at("$A", BAD_CHAR, "m", Some((0, 2)))).unwrap();
        assert_eq!(v, serde_json::json!({ "code": "bad_char", "message": "m", "range": [0, 2] }));
    }

    #[test]
    fn division_by_a_literal_zero_is_found() {
        assert_eq!(division_by_zero("$A / 0").unwrap().range, Some([3, 6]));
        assert!(division_by_zero("$A / 0.0 + 1").is_some());
        assert!(division_by_zero("$A / 0 ^ 0").is_none(), "0^0 = 1");
        assert!(division_by_zero("$A / 0.5").is_none());
        assert!(division_by_zero("$A / $B").is_none());
        assert!(division_by_zero("$A * 0").is_none());
    }

    #[test]
    fn convert_rewrites_the_excel_order_to_the_recommended_form() {
        assert_eq!(convert_legacy_round("round($A, 2)"), "round($A * 100) / 100");
        assert_eq!(convert_legacy_round("round($A, 0)"), "round($A)");
        assert_eq!(convert_legacy_round("round($A + $B, 1)"), "round(($A + $B) * 10) / 10");
        assert_eq!(convert_legacy_round("round(${Flow (m3/h)}, 3)"), "round(${Flow (m3/h)} * 1000) / 1000");
        assert_eq!(convert_legacy_round("round [ $A ; 3 ]"), "round($A * 1000) / 1000");
        assert_eq!(convert_legacy_round("round(min($A, $B), 2)"), "round(min($A, $B) * 100) / 100");
        assert_eq!(convert_legacy_round("round(-$A, 2)"), "round((-$A) * 100) / 100");
    }

    #[test]
    fn convert_handles_several_and_nested_calls_and_brackets_the_context() {
        assert_eq!(
            convert_legacy_round("round($A, 1) + round($B, 2)"),
            "round($A * 10) / 10 + round($B * 100) / 100"
        );
        assert_eq!(
            convert_legacy_round("round(round($A, 2) + $B, 1)"),
            "round((round($A * 100) / 100 + $B) * 10) / 10"
        );
        assert_eq!(convert_legacy_round("2 ^ round($A, 1)"), "2 ^ (round($A * 10) / 10)");
        assert_eq!(convert_legacy_round("3 / round($A, 1)"), "3 / (round($A * 10) / 10)");
        assert_eq!(convert_legacy_round("round($A, 1) ^ 2"), "(round($A * 10) / 10) ^ 2");
        assert_eq!(convert_legacy_round("$B - round($A, 1) * 3"), "$B - round($A * 10) / 10 * 3");
        assert_eq!(convert_legacy_round("-round($A, 1)"), "-(round($A * 10) / 10)");
        assert_eq!(convert_legacy_round("max(round($A, 1), 0)"), "max(round($A * 10) / 10, 0)");
    }

    #[test]
    fn convert_leaves_everything_else_alone_and_is_idempotent() {
        for f in [
            "$A + $B",
            "round($A)",
            "round(0.01, $A)",
            "round($B, $A)",
            "round(1.5, 2) + $A",
            "round($A, 0.5)",
            "${x round($A, 2)} * 2",
            "$round + round",
        ] {
            assert_eq!(convert_legacy_round(f), f, "{f}");
        }
        for f in ["round($A, 2)", "round(round($A, 2) + $B, 1)", "2 ^ round($A, 1)"] {
            let once = convert_legacy_round(f);
            assert_eq!(convert_legacy_round(&once), once, "{f}");
        }
        // A non-convertible outer call keeps its shape; the inner one converts.
        assert_eq!(convert_legacy_round("round(round($A, 2), 0.5)"), "round(round($A * 100) / 100, 0.5)");
    }
}
