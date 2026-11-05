/** Twin of Rust's `scan_sensor_refs` (lib.rs) + `formula_diagnostics::tokenize`, so names, numbers and brackets never split differently than in the gate. DISPLAY/EDITING only; validity is Rust's call. Positions are `[start, end)` in UTF-16 units; one pass, never throws. Grammar as Rust scans it: `${...}` up to the first `}` (empty/unclosed names nothing, tokens as `bad`); `$Name` starts with a letter/digit/`_` then letters/digits/`_`/`.` (`$11PT1214A.PV` is one sensor, `$Total-Power` is `Total` minus something); numbers with optional exponent or one SI suffix; ASCII words; operators; `( ) [ ]` (fasteval treats `[ ]` like `( )`); anything else is one `bad` char. */

export type FormulaTokenKind = 'sensor' | 'number' | 'word' | 'op' | 'open' | 'close' | 'comma' | 'bad';

export interface FormulaToken {
    kind: FormulaTokenKind;
    /** `[start, end)` in UTF-16 code units. */
    start: number;
    end: number;
    /** The token's own text (`text.slice(start, end)`). */
    text: string;
    /** `sensor`: the sensor name (inside `${…}` or after `$`). */
    name?: string;
    /** `sensor`: written in the braced `${…}` form. */
    braced?: boolean;
    /** `open` / `close`: nesting depth, 0 = outermost. A `close` with no
     *  opener has depth -1. */
    depth?: number;
    /** `open`/`close`: token index of the matching bracket, -1 when none (unclosed, unmatched, wrong kind `( ]`). */
    pair?: number;
    /** `word`: directly followed (whitespace aside) by `(` or `[` -- a call. */
    call?: boolean;
}

/** One `$Name` / `${Name}` occurrence (the `scan_sensor_refs` span). */
export interface FormulaSensorRef {
    name: string;
    start: number;
    end: number;
    braced: boolean;
}

// Rust's `char::is_alphanumeric` = Unicode Alphabetic || Numeric (`\p{Alphabetic}`, not `\p{L}`: see `specialSensorNaming.ts`).
const ALNUM = /^[\p{Alphabetic}\p{N}]$/u;
const WS = /^\s$/u;
const SI_SUFFIX = new Set(['k', 'K', 'M', 'G', 'T', 'm', 'u', 'µ', 'n', 'p']);

const isAlnum = (c: string) => ALNUM.test(c);
const isAsciiDigit = (c: string) => c >= '0' && c <= '9';
const isAsciiAlpha = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const isWordChar = (c: string) => isAsciiAlpha(c) || isAsciiDigit(c) || c === '_';

/** Split into code points, each with its UTF-16 offset (BMP text -- Thai
 *  included -- has offset === index; an emoji counts 2). */
function codePoints(text: string): { chars: string[]; off: number[] } {
    const chars: string[] = [];
    const off: number[] = [];
    let at = 0;
    for (const c of text) {
        chars.push(c);
        off.push(at);
        at += c.length;
    }
    off.push(at);
    return { chars, off };
}

/** Char-index spans of every sensor reference (Rust's `scan_sensor_refs`). */
function scanRefSpans(chars: string[]): Array<{ start: number; end: number; braced: boolean; name: string }> {
    const out: Array<{ start: number; end: number; braced: boolean; name: string }> = [];
    const len = chars.length;
    let i = 0;
    while (i < len) {
        if (chars[i] !== '$') { i++; continue; }
        if (i + 1 < len && chars[i + 1] === '{') {
            let j = i + 2;
            while (j < len && chars[j] !== '}') j++;
            if (j < len) {
                const name = chars.slice(i + 2, j).join('');
                if (name) out.push({ start: i, end: j + 1, braced: true, name });
                i = j + 1;
            } else {
                i++;
            }
        } else if (i + 1 < len && (isAlnum(chars[i + 1]) || chars[i + 1] === '_')) {
            let j = i + 1;
            while (j < len && (isAlnum(chars[j]) || chars[j] === '_' || chars[j] === '.')) j++;
            out.push({ start: i, end: j, braced: false, name: chars.slice(i + 1, j).join('') });
            i = j;
        } else {
            i++;
        }
    }
    return out;
}

/** Tokenize `text`. Never throws; every non-space character lands in exactly one token. */
export function tokenizeFormula(text: string): FormulaToken[] {
    const { chars, off } = codePoints(text);
    const spans = scanRefSpans(chars);
    const len = chars.length;
    const out: FormulaToken[] = [];
    const push = (kind: FormulaTokenKind, a: number, b: number, extra: Partial<FormulaToken> = {}) => {
        out.push({ kind, start: off[a], end: off[b], text: text.slice(off[a], off[b]), ...extra });
    };
    let i = 0;
    let si = 0;
    while (i < len) {
        while (si < spans.length && spans[si].end <= i) si++;
        if (si < spans.length && spans[si].start === i) {
            const s = spans[si];
            push('sensor', s.start, s.end, { name: s.name, braced: s.braced });
            i = s.end;
            si++;
            continue;
        }
        const c = chars[i];
        if (WS.test(c)) { i++; continue; }
        const start = i;
        if (isAsciiDigit(c) || c === '.') {
            while (i < len && (isAsciiDigit(chars[i]) || chars[i] === '.')) i++;
            let exponent = false;
            if (i < len && (chars[i] === 'e' || chars[i] === 'E')) {
                let j = i + 1;
                if (j < len && (chars[j] === '+' || chars[j] === '-')) j++;
                if (j < len && isAsciiDigit(chars[j])) {
                    while (j < len && isAsciiDigit(chars[j])) j++;
                    i = j;
                    exponent = true;
                }
            }
            if (!exponent && i < len && SI_SUFFIX.has(chars[i])) i++;
            push('number', start, i);
            continue;
        }
        if (isAsciiAlpha(c) || c === '_') {
            while (i < len && isWordChar(chars[i])) i++;
            push('word', start, i);
            continue;
        }
        i++;
        switch (c) {
            case '(': case '[': push('open', start, i); break;
            case ')': case ']': push('close', start, i); break;
            case ',': case ';': push('comma', start, i); break;
            case '+': case '-': case '*': case '/': case '%': case '^': push('op', start, i); break;
            case '<': case '>':
                if (i < len && chars[i] === '=') i++;
                push('op', start, i);
                break;
            case '=': case '!':
                if (i < len && chars[i] === '=') { i++; push('op', start, i); }
                else if (c === '!') push('op', start, i);
                else push('bad', start, i);
                break;
            case '&': case '|':
                if (i < len && chars[i] === c) { i++; push('op', start, i); }
                else push('bad', start, i);
                break;
            default: push('bad', start, i);
        }
    }
    annotate(out);
    return out;
}

/** Bracket depth / pairs (a `(` only pairs with `)`, `[` with `]`) and calls. */
function annotate(toks: FormulaToken[]): void {
    const stack: number[] = [];
    for (let k = 0; k < toks.length; k++) {
        const t = toks[k];
        if (t.kind === 'word') {
            t.call = toks[k + 1]?.kind === 'open';
        } else if (t.kind === 'open') {
            t.depth = stack.length;
            t.pair = -1;
            stack.push(k);
        } else if (t.kind === 'close') {
            const want = t.text === ')' ? '(' : '[';
            const top = stack.length > 0 ? stack[stack.length - 1] : -1;
            if (top >= 0 && toks[top].text === want) {
                stack.pop();
                t.depth = toks[top].depth;
                t.pair = top;
                toks[top].pair = k;
            } else {
                // Unmatched (or the wrong kind): left unpaired and painted as lone.
                t.depth = -1;
                t.pair = -1;
            }
        }
    }
}

/** Bracket pair the caret/selection sits on (Unwrap, pair highlight): a selection exactly covering `( … )`, or a caret right next to either bracket. Returns token indices `[open, close]`. */
export function bracketPairAt(tokens: FormulaToken[], selStart: number, selEnd: number): [number, number] | null {
    const paired = (k: number) => {
        const t = tokens[k];
        return (t.kind === 'open' || t.kind === 'close') && (t.pair ?? -1) >= 0;
    };
    if (selStart !== selEnd) {
        const k = tokens.findIndex(t => t.kind === 'open' && t.start === selStart);
        if (k >= 0 && paired(k) && tokens[tokens[k].pair!].end === selEnd) return [k, tokens[k].pair!];
        return null;
    }
    // Prefer the bracket right AFTER the caret, then the one right before it.
    let k = tokens.findIndex(t => t.start === selStart && (t.kind === 'open' || t.kind === 'close'));
    if (k < 0 || !paired(k)) k = tokens.findIndex(t => t.end === selStart && (t.kind === 'open' || t.kind === 'close'));
    if (k < 0 || !paired(k)) return null;
    const other = tokens[k].pair!;
    return tokens[k].kind === 'open' ? [k, other] : [other, k];
}

/** Distinct referenced sensors in order of first appearance, each with the range of its FIRST occurrence. */
export function referencedSensors(tokens: FormulaToken[]): Array<{ name: string; start: number; end: number }> {
    const seen = new Set<string>();
    const out: Array<{ name: string; start: number; end: number }> = [];
    for (const t of tokens) {
        if (t.kind !== 'sensor' || !t.name || seen.has(t.name)) continue;
        seen.add(t.name);
        out.push({ name: t.name, start: t.start, end: t.end });
    }
    return out;
}

/** Does the formula have an operator OUTSIDE every bracket (so it needs `( … )` to be one operand of another formula)? */
export function hasTopLevelOperator(text: string, tokens: FormulaToken[] = tokenizeFormula(text)): boolean {
    let depth = 0;
    for (const t of tokens) {
        if (t.kind === 'open') depth++;
        else if (t.kind === 'close') depth = Math.max(0, depth - 1);
        else if (depth === 0 && (t.kind === 'op' || t.kind === 'comma')) return true;
    }
    return false;
}

/** Is trimmed `text` one operand safe to multiply without brackets (Rust's `is_formula_atom`): a sensor reference, plain number/name, or `name(…)`/`(…)` whose bracket closes at the very end. */
export function isFormulaAtom(text: string): boolean {
    const { chars } = codePoints(text);
    const spans = scanRefSpans(chars);
    const inRef = refMask(chars.length, spans);
    let a = 0;
    let b = chars.length;
    while (a < b && WS.test(chars[a])) a++;
    while (b > a && WS.test(chars[b - 1])) b--;
    if (a >= b) return false;
    if (spans.some(s => s.start === a && s.end === b)) return true;
    const plain = (c: string) => isWordChar(c) || c === '.';
    let allPlain = true;
    for (let i = a; i < b; i++) if (inRef[i] || !plain(chars[i])) { allPlain = false; break; }
    if (allPlain) return true;
    // Optional function name, then a bracket group that must close at `b`.
    let i = a;
    while (i < b && !inRef[i] && isWordChar(chars[i])) i++;
    if (i >= b || inRef[i] || !(chars[i] === '(' || chars[i] === '[')) return false;
    let depth = 0;
    for (let k = i; k < b; k++) {
        if (inRef[k]) continue;
        if (chars[k] === '(' || chars[k] === '[') depth++;
        else if (chars[k] === ')' || chars[k] === ']') {
            depth--;
            if (depth === 0) return k === b - 1;
        }
    }
    return false;
}

function refMask(len: number, spans: Array<{ start: number; end: number }>): boolean[] {
    const m = new Array<boolean>(len).fill(false);
    for (const s of spans) for (let i = s.start; i < s.end; i++) m[i] = true;
    return m;
}

/** A spreadsheet-order `round(x, n)` call (Rust's `ExcelRoundCall`) as UTF-16 offsets: the whole call `[start, end)` and its two arguments. */
export interface ExcelRoundCall {
    start: number;
    end: number;
    x: [number, number];
    n: [number, number];
}

/** Every `round(<expr with a sensor>, <expr without one>)` call in order of its `round` keyword; twin of Rust's `excel_round_calls`, which decides the `round_excel` refusal and the conversion. Accepts `round[ … ]` and `;`; text inside a reference is a name, not a call. */
export function excelRoundCalls(text: string): ExcelRoundCall[] {
    const { chars, off } = codePoints(text);
    const spans = scanRefSpans(chars);
    const inRef = refMask(chars.length, spans);
    const len = chars.length;
    const isWord = (i: number) => !inRef[i] && isWordChar(chars[i]);
    const hasRef = (a: number, b: number) => spans.some(s => s.start >= a && s.end <= b);
    const out: ExcelRoundCall[] = [];
    let i = 0;
    while (i + 5 <= len) {
        const end = i + 5;
        const isRound = !inRef[i]
            && chars.slice(i, end).join('') === 'round'
            && (i === 0 || !isWord(i - 1))
            && (end === len || !isWord(end));
        if (!isRound) { i++; continue; }
        let j = end;
        while (j < len && !inRef[j] && WS.test(chars[j])) j++;
        if (j < len && !inRef[j] && (chars[j] === '(' || chars[j] === '[')) {
            let depth = 0;
            const args: Array<[number, number]> = [];
            let argStart = j + 1;
            let close = -1;
            for (let k = j; k < len; k++) {
                if (inRef[k]) continue;
                const c = chars[k];
                if (c === '(' || c === '[') depth++;
                else if (c === ')' || c === ']') {
                    depth--;
                    if (depth === 0) { args.push([argStart, k]); close = k; break; }
                } else if ((c === ',' || c === ';') && depth === 1) {
                    args.push([argStart, k]);
                    argStart = k + 1;
                }
            }
            if (close >= 0 && args.length === 2) {
                const [x, n] = args;
                if (hasRef(x[0], x[1]) && !hasRef(n[0], n[1])) {
                    out.push({ start: off[i], end: off[close + 1], x: [off[x[0]], off[x[1]]], n: [off[n[0]], off[n[1]]] });
                }
            }
        }
        i = end;
    }
    return out;
}
