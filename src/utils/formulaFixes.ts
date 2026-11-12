import type { FormulaIssue } from '../types/formula';
import { sensorRef } from './specialSensorNaming';
import { bracketPairAt, tokenizeFormula, type FormulaToken } from './formulaTokens';

/** Pure editing helpers of the Formula editor (fix buttons, Wrap/Unwrap, palette insertion, 'Replace…'): each returns the edit to apply (new text + selection), applied as a native insertion so Ctrl+Z works. Rust decides validity. */

/** The text after an edit, and the selection `[start, end)` to restore. */
export interface FormulaEdit {
    text: string;
    selection: [number, number];
}

/** A fix button: a ready edit, or (`Replace…`) a request to open the sensor picker then call `replaceSensorEverywhere`. */
export type FormulaFix =
    | { kind: 'edit'; label: string; edit: FormulaEdit }
    | { kind: 'replace-sensor'; label: string; sensor: string };

export interface FixContext {
    /** Rust's function list (`preview_formula`'s `functions`), for "Use sqrt". */
    functions?: readonly string[] | null;
}

/** Fix for `issue` on `text`, or null; keyed on the stable issue code (front-end check or Rust), e.g. unclosed_bracket 'Add )', unknown_sensor 'Replace…'. */
export function fixForIssue(text: string, issue: FormulaIssue | null | undefined, ctx: FixContext = {}): FormulaFix | null {
    if (!issue) return null;
    const tokens = tokenizeFormula(text);
    const range = issue.range;
    switch (issue.code) {
        case 'unclosed_bracket': {
            const closers = unclosedClosers(tokens);
            if (!closers) return null;
            const trimmed = text.replace(/\s+$/u, '');
            const next = trimmed + closers;
            return { kind: 'edit', label: `Add ${closers}`, edit: { text: next, selection: [next.length, next.length] } };
        }
        case 'missing_operator': {
            if (!range) return null;
            const first = tokens.find(t => t.start >= range[0] && t.end <= range[1]);
            if (!first) return null;
            const after = text.slice(first.end);
            const rest = after.replace(/^\s+/u, '');
            const next = `${text.slice(0, first.end)} * ${rest}`;
            const caret = first.end + 3;
            return { kind: 'edit', label: 'Insert ×', edit: { text: next, selection: [caret, caret] } };
        }
        case 'unknown_function': {
            if (!range || !ctx.functions?.length) return null;
            const word = text.slice(range[0], range[1]);
            const guess = closestFunction(word, ctx.functions);
            if (!guess) return null;
            const tok = tokens.find(t => t.start === range[0]);
            const needsBracket = tok?.kind === 'word' && !tok.call;
            const piece = needsBracket ? `${guess}()` : guess;
            const next = text.slice(0, range[0]) + piece + text.slice(range[1]);
            // Inside the new brackets.
            const caret = range[0] + guess.length + (needsBracket ? 1 : 0);
            return { kind: 'edit', label: `Use ${guess}`, edit: { text: next, selection: [caret, caret] } };
        }
        case 'fn_no_bracket': {
            if (!range) return null;
            const next = `${text.slice(0, range[1])}()${text.slice(range[1])}`;
            const caret = range[1] + 1;
            return { kind: 'edit', label: 'Add ( )', edit: { text: next, selection: [caret, caret] } };
        }
        case 'unmatched_close': {
            if (!range) return null;
            const next = text.slice(0, range[0]) + text.slice(range[1]);
            return { kind: 'edit', label: 'Remove it', edit: { text: next, selection: [range[0], range[0]] } };
        }
        case 'unknown_sensor': {
            const name = sensorNameOfIssue(tokens, issue);
            return name ? { kind: 'replace-sensor', label: 'Replace…', sensor: name } : null;
        }
        default:
            return null;
    }
}

/** `)` / `]` for every bracket still open at the end, innermost first. */
function unclosedClosers(tokens: FormulaToken[]): string {
    const stack: string[] = [];
    for (const t of tokens) {
        if (t.kind === 'open') stack.push(t.text);
        else if (t.kind === 'close' && stack.length > 0) stack.pop();
    }
    return stack.reverse().map(o => (o === '(' ? ')' : ']')).join('');
}

/** The sensor an `unknown_sensor` issue is about: the reference at its range,
 *  else the name in Rust's "Sensor not found: X" message. */
function sensorNameOfIssue(tokens: FormulaToken[], issue: FormulaIssue): string | null {
    if (issue.range) {
        const t = tokens.find(x => x.kind === 'sensor' && x.start === issue.range![0]);
        if (t?.name) return t.name;
    }
    const m = /^Sensor not found: (.+)$/.exec(issue.message);
    return m ? m[1] : null;
}

/** Levenshtein distance, capped (returns cap+1 once exceeded). */
function distance(a: string, b: string, cap: number): number {
    if (Math.abs(a.length - b.length) > cap) return cap + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        let best = i;
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            best = Math.min(best, cur[j]);
        }
        if (best > cap) return cap + 1;
        prev = cur;
    }
    return prev[b.length];
}

/** Engine function `word` most likely meant: other-case match, closest by edit distance (<= 1; <= 2 for 5+ letters), or a function it prefixes. */
export function closestFunction(word: string, functions: readonly string[]): string | null {
    const w = word.toLowerCase();
    if (!w) return null;
    const exact = functions.find(f => f === w);
    if (exact && exact !== word) return exact;
    const cap = w.length >= 5 ? 2 : 1;
    let best: string | null = null;
    let bestD = cap + 1;
    for (const f of functions) {
        if (f.length < 2) continue;
        const d = distance(w, f, cap);
        if (d < bestD) { bestD = d; best = f; }
    }
    if (best) return best;
    if (w.length >= 2) return functions.find(f => f.length > w.length && f.startsWith(w)) ?? null;
    return null;
}

/** Replace every reference to `oldName` with `newTag` (braces via `sensorRef`); caret goes after the last replacement. */
export function replaceSensorEverywhere(text: string, oldName: string, newTag: string): FormulaEdit {
    const hits = tokenizeFormula(text).filter(t => t.kind === 'sensor' && t.name === oldName);
    if (hits.length === 0) return { text, selection: [text.length, text.length] };
    const piece = sensorRef(newTag);
    let out = '';
    let from = 0;
    for (const t of hits) {
        out += text.slice(from, t.start) + piece;
        from = t.end;
    }
    const caret = out.length;
    out += text.slice(from);
    return { text: out, selection: [caret, caret] };
}

/** `( … )` around the selection; the inside stays selected. Null for an empty selection. */
export function wrapSelection(text: string, start: number, end: number): FormulaEdit | null {
    if (start === end) return null;
    const [a, b] = start < end ? [start, end] : [end, start];
    return { text: `${text.slice(0, a)}(${text.slice(a, b)})${text.slice(b)}`, selection: [a + 1, b + 1] };
}

/** Remove the bracket pair at the caret/selection, selecting the former inside; a function's name goes too (`abs($A)` -> `$A`). */
export function unwrapAt(text: string, start: number, end: number, tokens: FormulaToken[] = tokenizeFormula(text)): FormulaEdit | null {
    const pair = bracketPairAt(tokens, start, end);
    if (!pair) return null;
    const o = tokens[pair[0]];
    const c = tokens[pair[1]];
    const fn = pair[0] > 0 && tokens[pair[0] - 1].kind === 'word' && tokens[pair[0] - 1].call ? tokens[pair[0] - 1] : null;
    const from = fn ? fn.start : o.start;
    const next = text.slice(0, from) + text.slice(o.end, c.start) + text.slice(c.end);
    return { text: next, selection: [from, from + (c.start - o.end)] };
}

/** Insert `piece` over the selection, padded with a space unless the neighbour is whitespace or a bracket/separator, so `$` refs never fuse. Caret lands after the piece (or at `caretInPiece`). */
export function insertPiece(text: string, start: number, end: number, piece: string, caretInPiece = piece.length): FormulaEdit {
    const before = text.slice(0, start);
    const after = text.slice(end);
    const padL = before && !/[\s([]$/u.test(before) ? ' ' : '';
    const padR = after && !/^[\s)\],;]/u.test(after) ? ' ' : '';
    const next = before + padL + piece + padR + after;
    const caret = start + padL.length + caretInPiece;
    return { text: next, selection: [caret, caret] };
}

/** A sensor reference at the selection (palette / `$` button on a list row). */
export function insertSensorAt(text: string, start: number, end: number, tag: string): FormulaEdit {
    return insertPiece(text, start, end, sensorRef(tag));
}

/** An operator pill: ` op ` over the selection. */
export function insertOperator(text: string, start: number, end: number, op: '+' | '-' | '*' | '/' | '^'): FormulaEdit {
    return insertPiece(text, start, end, op);
}

/** Function pill: wraps the selection (`abs(<selection>)`), or inserts `fn()` with the caret inside. */
export function insertFunction(text: string, start: number, end: number, name: string): FormulaEdit {
    const [a, b] = start <= end ? [start, end] : [end, start];
    const inner = text.slice(a, b);
    if (!inner) return insertPiece(text, a, b, `${name}()`, name.length + 1);
    const edit = insertPiece(text, a, b, `${name}(${inner})`, name.length + 1);
    const innerStart = edit.selection[0];
    return { text: edit.text, selection: [innerStart, innerStart + inner.length] };
}
