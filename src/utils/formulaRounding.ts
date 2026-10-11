import { excelRoundCalls, isFormulaAtom, tokenizeFormula, type ExcelRoundCall } from './formulaTokens';

/**
 * Rounding in special-sensor formulas.
 *
 * The engine's `round(x)` takes ONE value (to a whole number). N decimals are
 * written with a literal power of ten -- `round(X * 100) / 100` for 2 dp,
 * `round(X)` for 0 dp -- the form Rust's legacy converter emits
 * (`formula_diagnostics::convert_legacy_round`). Quick
 * build's round transform, the "Round the result" setting and the
 * `round_excel` fix button all write this one form; never `round(0.01, X)` and
 * never the spreadsheet order `round(X, 2)` (which the engine reads as
 * "round 2 to a multiple of X" and the gate refuses).
 *
 * An Average / Median BLOCK is not rounded this way: it stores
 * `multiOp.decimals` (`quickBuild.ts`).
 */

/** Rust's limit for a convertible `round(x, n)`: a whole n in 0..=15. */
export const MAX_ROUND_PLACES = 15;

/** `X` rounded to `decimals` places, in the engine form. `X` is bracketed
 *  unless it is one operand (`isFormulaAtom`); the result has a top-level `/`
 *  for decimals > 0, so a caller dropping it into a larger formula brackets it. */
export function roundExpression(expr: string, decimals: number): string {
    const x = expr.trim();
    if (!Number.isInteger(decimals) || decimals < 0) throw new RangeError(`decimals must be a whole number >= 0 (got ${decimals})`);
    if (decimals === 0) return `round(${x})`;
    const scale = 10 ** decimals;
    const xs = isFormulaAtom(x) ? x : `(${x})`;
    return `round(${xs} * ${scale}) / ${scale}`;
}

/** A formula with the "Round the result" setting applied, plus where the
 *  user's own text (`body`, trimmed) starts inside it -- for mapping a Rust
 *  issue range on the stored text back into the textarea. */
export interface RoundedFormula {
    formula: string;
    /** UTF-16 offset of the (trimmed) body inside `formula`. */
    bodyStart: number;
    /** Leading whitespace the textarea text has before the trimmed body. */
    bodyLead: number;
    /** Length of the trimmed body. */
    bodyLength: number;
}

/** Does the text have a bracket with no partner (`$A) + ($B`, `(($A`)? */
export function hasUnpairedBracket(text: string): boolean {
    return tokenizeFormula(text).some(t => (t.kind === 'open' || t.kind === 'close') && (t.pair ?? -1) < 0);
}

/** Apply "Round the result" (`decimals` = null: off) to the editor text.
 *  A body with an unpaired bracket is NOT wrapped: the added brackets could
 *  pair with the user's stray ones and turn a broken formula into a different
 *  valid one (`$A) + ($B` -> `round(($A) + ($B) * 100) / 100`). It is sent and
 *  saved as typed, so the check reports the user's own mistake. */
export function withRoundResult(body: string, decimals: number | null): RoundedFormula {
    const trimmed = body.trim();
    const bodyLead = body.length - body.trimStart().length;
    if (decimals === null || !trimmed || hasUnpairedBracket(trimmed)) {
        return { formula: trimmed, bodyStart: 0, bodyLead, bodyLength: trimmed.length };
    }
    const formula = roundExpression(trimmed, decimals);
    // `round(` + an added `(` when the body was bracketed.
    const bodyStart = 'round('.length + (decimals > 0 && !isFormulaAtom(trimmed) ? 1 : 0);
    return { formula, bodyStart, bodyLead, bodyLength: trimmed.length };
}

/**
 * Map a range on the STORED formula (what Rust checked) into the textarea's
 * text. Clamped to the body; `undefined` when the range lies entirely in the
 * added `round(… * 100) / 100` wrapper (the wrapper itself is never wrong for
 * a valid body, so that cannot point at anything the user typed).
 */
export function rangeToBody(range: [number, number] | undefined, r: RoundedFormula): [number, number] | undefined {
    if (!range) return undefined;
    const lo = Math.max(range[0], r.bodyStart);
    const hi = Math.min(range[1], r.bodyStart + r.bodyLength);
    if (hi < lo || (hi === lo && range[0] !== range[1])) return undefined;
    return [lo - r.bodyStart + r.bodyLead, hi - r.bodyStart + r.bodyLead];
}

/**
 * Split a stored formula into the editor's text + "Round the result" setting:
 * an outer `round(X * 10^n) / 10^n` (n 1..15) or `round(X)` becomes
 * `{ body: X, decimals: n }`. Only when re-applying the setting gives back
 * EXACTLY the stored text (so opening and saving never rewrites a formula the
 * user did not touch); otherwise `{ body: formula, decimals: null }`.
 */
export function splitRoundResult(formula: string): { body: string; decimals: number | null } {
    const f = formula.trim();
    const none = { body: formula, decimals: null };
    const toks = tokenizeFormula(f);
    if (toks.length < 4 || toks[0].kind !== 'word' || toks[0].text !== 'round' || toks[1].kind !== 'open' || toks[1].text !== '(') return none;
    const close = toks[1].pair ?? -1;
    if (close < 0) return none;
    let candidate: { body: string; decimals: number } | null = null;
    if (close === toks.length - 1) {
        candidate = { body: f.slice(toks[1].end, toks[close].start).trim(), decimals: 0 };
    } else if (close === toks.length - 3) {
        const slash = toks[close + 1];
        const scaleTok = toks[close + 2];
        const star = toks[close - 2];
        const inner = toks[close - 1];
        const n = placesOfScale(scaleTok.text);
        if (slash.text === '/' && n !== null && star?.text === '*' && inner?.text === scaleTok.text && close - 2 > 1) {
            let body = f.slice(toks[1].end, star.start).trim();
            // `round((A + B) * 100) / 100`: the bracket was added by the setting.
            const bt = tokenizeFormula(body);
            if (bt.length > 2 && bt[0].kind === 'open' && bt[0].text === '(' && bt[0].pair === bt.length - 1) {
                const unwrapped = body.slice(bt[0].end, bt[bt.length - 1].start).trim();
                if (!isFormulaAtom(unwrapped)) body = unwrapped;
            }
            candidate = { body, decimals: n };
        }
    }
    if (!candidate || !candidate.body || hasTopLevelComma(candidate.body)) return none; // `round(0.01, $A)` is a step round
    return withRoundResult(candidate.body, candidate.decimals).formula === f ? candidate : none;
}

function hasTopLevelComma(text: string): boolean {
    let depth = 0;
    for (const t of tokenizeFormula(text)) {
        if (t.kind === 'open') depth++;
        else if (t.kind === 'close') depth--;
        else if (t.kind === 'comma' && depth === 0) return true;
    }
    return false;
}

/** `100` -> 2; anything that is not 10^n with n in 1..15 -> null. */
function placesOfScale(text: string): number | null {
    const m = /^1(0{1,15})$/.exec(text);
    return m ? m[1].length : null;
}

/** How many places a spreadsheet `round(x, n)` meant: a plain whole-number
 *  `n` in 0..=15, else null. (Rust also evaluates a constant expression such
 *  as `1 + 1`; this local twin only reads a plain number -- Rust's own
 *  `converted_formula` covers the rest.) */
export function roundPlaces(n: string): number | null {
    const t = n.trim();
    if (!/^\d+(\.0*)?$/.test(t)) return null;
    const v = Number(t);
    return Number.isInteger(v) && v >= 0 && v <= MAX_ROUND_PLACES ? v : null;
}

const WS = /\s/u;

/** Can `round(…) / k` replace the call at `[start, end)` without brackets?
 *  Rust's `stands_alone`. */
function standsAlone(text: string, start: number, end: number): boolean {
    const refs = refRanges(text);
    const inRef = (i: number) => refs.some(([a, b]) => i >= a && i < b);
    const prevIdx = (from: number) => { for (let i = from - 1; i >= 0; i--) if (inRef(i) || !WS.test(text[i])) return i; return -1; };
    const nextIdx = (from: number) => { for (let i = from; i < text.length; i++) if (inRef(i) || !WS.test(text[i])) return i; return -1; };
    const valueEnd = (i: number) => inRef(i) || /[A-Za-z0-9_.)\]]/.test(text[i]);
    const p = prevIdx(start);
    let prevOk: boolean;
    if (p < 0) prevOk = true;
    else if (inRef(p)) prevOk = false;
    else if ('([,;'.includes(text[p])) prevOk = true;
    else if (text[p] === '+' || text[p] === '-') { const q = prevIdx(p); prevOk = q >= 0 && valueEnd(q); }
    else prevOk = false;
    const n = nextIdx(end);
    const nextOk = n < 0 || (!inRef(n) && ')],;+-*/'.includes(text[n]));
    return prevOk && nextOk;
}

function refRanges(text: string): Array<[number, number]> {
    return tokenizeFormula(text).filter(t => t.kind === 'sensor').map(t => [t.start, t.end] as [number, number]);
}

/** The engine-form replacement for one spreadsheet-order call, or null when
 *  its `n` is not convertible. */
export function convertExcelRoundCall(text: string, call: ExcelRoundCall): string | null {
    const places = roundPlaces(text.slice(call.n[0], call.n[1]));
    if (places === null) return null;
    const x = text.slice(call.x[0], call.x[1]).trim();
    if (places === 0) return `round(${x})`;
    const core = roundExpression(x, places);
    return standsAlone(text, call.start, call.end) ? core : `(${core})`;
}

/**
 * Local twin of Rust's `convert_legacy_round`: every convertible
 * spreadsheet-order call rewritten, right to left (nested calls included).
 * Used for the fix button when Rust gave no `converted_formula`; the stored
 * recipes on workspace open are converted by Rust itself
 * (`convert_legacy_formula`), never by this.
 */
export function convertLegacyRoundLocal(text: string): string {
    let out = text;
    const starts = excelRoundCalls(text).map(c => c.start);
    for (const start of [...starts].reverse()) {
        const call = excelRoundCalls(out).find(c => c.start === start);
        if (!call) continue;
        const rep = convertExcelRoundCall(out, call);
        if (rep === null) continue;
        out = out.slice(0, call.start) + rep + out.slice(call.end);
    }
    return out;
}
