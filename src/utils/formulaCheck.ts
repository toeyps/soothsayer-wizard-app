import type { FormulaIssue, FormulaPreviewAggregate } from '../types/formula';
import { excelRoundCalls, isFormulaAtom, tokenizeFormula, type FormulaToken } from './formulaTokens';
import { roundPlaces } from './formulaRounding';

/**
 * The cheap FRONT-END check of a special-sensor formula (customer batch
 * 2026-10, item 6): instant feedback on every keystroke, with the SAME stable
 * codes and, where it can, the same ranges as Rust's gate
 * (`formula_gate` in `src-tauri/src/lib.rs`, classified by
 * `formula_diagnostics.rs`). It runs Rust's rules in Rust's order:
 *
 *   size limits (too_long / too_deep) -> references (constant_only,
 *   unknown_sensor) -> structure (locate_syntax_issue's codes, left to right)
 *   -> names (unknown_function, fn_no_bracket) -> round_excel ->
 *   div_zero (CREATE only, like Rust's `create_only_formula_issue`).
 *
 * Rust has the last word: the editor sends the text to `preview_formula`
 * anyway (`usePreviewFormula`) and shows ITS verdict once it lands for the
 * current text (`resolveFormulaVerdict`). This pass never flags anything
 * Rust's structural scan would not, and it leaves out what it cannot know for
 * sure (argument counts; unknown functions before Rust has sent its function
 * list) -- a miss here only means the red line appears ~220 ms later.
 *
 * O(n) per call (one tokenize, a few linear scans).
 */

export const DEFAULT_MAX_FORMULA_LEN = 4096;
export const DEFAULT_MAX_FORMULA_DEPTH = 64;

/** Rust's `FORMULA_NO_REFS_ERROR`. */
export const NO_SENSOR_MESSAGE = 'Formula contains no sensor references. Use $SensorName or ${Sensor Name} syntax.';
/** Rust's `DIV_ZERO_MESSAGE`. */
export const DIV_ZERO_MESSAGE =
    'Formula error: division by 0 gives no value on any row. Divide by a sensor or a number other than 0.';

/** Functions that take no value: written `pi()` / `e()`. */
export const ZERO_ARG_FUNCTIONS: ReadonlySet<string> = new Set(['pi', 'e']);

export interface FormulaCheckContext {
    /** Does this name resolve to a column of the loaded dataset? Omitted = not
     *  checked. Build it with `sensorResolver` (Rust's `resolve_sensor`:
     *  exact, else trimmed + case-insensitive). */
    isKnownSensor?: (name: string) => boolean;
    /** The engine's function names, AS RUST SENT THEM (`preview_formula`'s
     *  `functions`). Omitted / null = names are not checked yet. */
    functions?: readonly string[] | null;
    /** `create` (default) also applies the create-only refusal `div_zero`;
     *  `edit` (Save of an existing sensor / repair, `replace: true`) skips it. */
    mode?: 'create' | 'edit';
    maxLength?: number;
    maxDepth?: number;
}

/** Rust's `resolve_sensor` as a predicate: exact name, else trimmed +
 *  case-insensitive. */
export function sensorResolver(names: Iterable<string>): (name: string) => boolean {
    const exact = new Set<string>();
    const ci = new Set<string>();
    for (const n of names) {
        exact.add(n);
        ci.add(n.trim().toLowerCase());
    }
    return (name: string) => exact.has(name) || ci.has(name.trim().toLowerCase());
}

const OP_LABEL: Record<string, string> = { '*': '×', '/': '÷', '-': '−' };
const opLabel = (op: string) => OP_LABEL[op] ?? op;

/** The first problem with `text`, or null (empty text, or nothing found). */
export function checkFormula(
    text: string,
    tokens: FormulaToken[] = tokenizeFormula(text),
    ctx: FormulaCheckContext = {},
): FormulaIssue | null {
    if (!text.trim()) return null;
    return limitIssue(text, ctx)
        ?? referenceIssue(tokens, ctx)
        ?? syntaxIssue(tokens)
        ?? nameIssue(tokens, ctx)
        ?? roundExcelIssue(text)
        ?? ((ctx.mode ?? 'create') === 'create' ? divisionByZero(tokens) : null);
}

function limitIssue(text: string, ctx: FormulaCheckContext): FormulaIssue | null {
    const maxLen = ctx.maxLength ?? DEFAULT_MAX_FORMULA_LEN;
    const maxDepth = ctx.maxDepth ?? DEFAULT_MAX_FORMULA_DEPTH;
    if (text.length > maxLen) {
        return { code: 'too_long', message: `Formula too long (${text.length} chars, max ${maxLen})` };
    }
    // Rust counts `(`, `[` and `{` (the `${…}` form too) in ONE budget, over
    // every character -- including those inside a sensor name.
    let depth = 0;
    let max = 0;
    let firstOver = -1;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '(' || c === '[' || c === '{') {
            depth++;
            if (depth > max) max = depth;
            if (depth > maxDepth && firstOver < 0) firstOver = i;
        } else if (c === ')' || c === ']' || c === '}') {
            depth--;
        }
    }
    if (max > maxDepth) {
        return {
            code: 'too_deep',
            message: `Formula too deeply nested (${max} levels, max ${maxDepth})`,
            ...(firstOver >= 0 ? { range: [firstOver, firstOver + 1] as [number, number] } : {}),
        };
    }
    return null;
}

function referenceIssue(tokens: FormulaToken[], ctx: FormulaCheckContext): FormulaIssue | null {
    const refs = tokens.filter(t => t.kind === 'sensor');
    if (refs.length === 0) return { code: 'constant_only', message: NO_SENSOR_MESSAGE };
    if (!ctx.isKnownSensor) return null;
    const seen = new Set<string>();
    for (const t of refs) {
        const name = t.name!;
        if (seen.has(name)) continue;
        seen.add(name);
        if (!ctx.isKnownSensor(name)) {
            return { code: 'unknown_sensor', message: `Sensor not found: ${name}`, range: [t.start, t.end] };
        }
    }
    return null;
}

const isUnary = (t: FormulaToken) => t.kind === 'op' && (t.text === '+' || t.text === '-' || t.text === '!');

/** Rust's `locate_syntax_issue`: the first structural problem, left to right. */
function syntaxIssue(toks: FormulaToken[]): FormulaIssue | null {
    const stack: Array<{ tok: number; call: boolean }> = [];
    for (let k = 0; k < toks.length; k++) {
        const t = toks[k];
        const p = k > 0 ? toks[k - 1] : undefined;
        const n = toks[k + 1];
        const at = (code: string, message: string, a = t.start, b = t.end): FormulaIssue => ({ code, message, range: [a, b] });
        switch (t.kind) {
            case 'bad':
                return at('bad_char', badCharMessage(t.text));
            case 'number':
                if (numberValue(t.text) === null) return at('bad_number', `"${t.text}" is not a number.`);
                break;
            case 'open': {
                const call = p?.kind === 'word';
                if (n?.kind === 'close' && !call) return at('empty_brackets', 'Empty brackets — put a value inside ( ).', t.start, n.end);
                stack.push({ tok: k, call });
                break;
            }
            case 'close': {
                const f = stack.pop();
                if (!f) return at('unmatched_close', `This "${t.text}" has no matching "${t.text === ')' ? '(' : '['}".`);
                const want = toks[f.tok].text === '(' ? ')' : ']';
                if (t.text !== want) return at('unmatched_close', `This "${t.text}" does not match the "${toks[f.tok].text}" it closes.`);
                break;
            }
            case 'comma': {
                const inCall = stack.length > 0 && stack[stack.length - 1].call;
                const leftOk = !!p && !(p.kind === 'open' || p.kind === 'comma' || p.kind === 'op');
                const rightOk = !!n && !(n.kind === 'close' || n.kind === 'comma');
                if (!inCall || !leftOk || !rightOk) {
                    return at('stray_comma', inCall
                        ? '"," must sit between two values.'
                        : '"," only separates the values of a function, such as min( … ) or max( … ).');
                }
                break;
            }
            case 'op': {
                const startCtx = !p || p.kind === 'op' || p.kind === 'comma' || p.kind === 'open';
                if (startCtx && !isUnary(t)) return at('op_no_left', `"${opLabel(t.text)}" needs a value before it.`);
                const rightBad = !n || n.kind === 'close' || n.kind === 'comma' || (n.kind === 'op' && !isUnary(n));
                if (rightBad) return at('op_no_right', `"${opLabel(t.text)}" needs a value after it.`);
                break;
            }
            default:
                break;
        }
        const valueEnd = t.kind === 'sensor' || t.kind === 'number' || t.kind === 'close'
            || (t.kind === 'word' && n?.kind !== 'open');
        if (n && valueEnd && (n.kind === 'sensor' || n.kind === 'number' || n.kind === 'word' || n.kind === 'open')) {
            return {
                code: 'missing_operator',
                message: t.kind === 'sensor' && n.kind === 'open'
                    ? `${t.text} is a sensor, not a function. Put an operator before the bracket, e.g. ${t.text} * (…).`
                    : 'Two values side by side — put an operator such as * between them.',
                range: [t.start, n.end],
            };
        }
    }
    const open = stack[stack.length - 1];
    if (open) {
        const o = toks[open.tok];
        const count = stack.length;
        return {
            code: 'unclosed_bracket',
            message: count === 1 ? `A "${o.text}" is never closed — add "${o.text === '(' ? ')' : ']'}".` : `${count} brackets are never closed — add ")".`,
            range: [o.start, o.end],
        };
    }
    return null;
}

function badCharMessage(ch: string): string {
    if (ch === '$') return 'A "$" must be followed by a sensor name: $Name, or ${Name} when the name has spaces or symbols.';
    if (ch === '{' || ch === '}') return 'Braces are only used around a sensor name: ${Sensor Name}.';
    if (ch === '=') return '"=" is not allowed — use "==" to compare.';
    return `"${ch}" is not allowed in a formula.`;
}

const SI_SCALE: Record<string, number> = { k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, m: 1e-3, u: 1e-6, 'µ': 1e-6, n: 1e-9, p: 1e-12 };

/** Rust's `number_value`: `2k` = 2000, `5m` = 0.005; null when not a number
 *  (`1.2.3`, `.`). */
export function numberValue(text: string): number | null {
    const last = text[text.length - 1];
    let body = text;
    let scale = 1;
    if (last in SI_SCALE) {
        body = text.slice(0, -1);
        scale = SI_SCALE[last];
    }
    // Rust `str::parse::<f64>`: digits, one optional '.', optional exponent; no sign here.
    if (!/^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(body)) return null;
    return Number(body) * scale;
}

/** Unknown function names and functions written without a bracket. Needs
 *  Rust's function list; a call's argument count is left to Rust. */
function nameIssue(toks: FormulaToken[], ctx: FormulaCheckContext): FormulaIssue | null {
    const fns = ctx.functions;
    if (!fns || fns.length === 0) return null;
    const known = new Set(fns);
    for (const t of toks) {
        if (t.kind !== 'word') continue;
        const w = t.text;
        if (known.has(w)) {
            if (!t.call) {
                return {
                    code: 'fn_no_bracket',
                    message: w === 'pi' ? 'Write pi() for π.'
                        : w === 'e' ? "Write e() for Euler's number (2.718…)."
                            : `${w} needs a value in brackets, e.g. ${w}($A).`,
                    range: [t.start, t.end],
                };
            }
            continue;
        }
        return {
            code: 'unknown_function',
            message: t.call
                ? `Unknown function '${w}'. Available functions: ${fns.join(', ')}.`
                : `Unknown name '${w}'. Write sensors as $Name, or \${Name} when the name has spaces or symbols.`,
            range: [t.start, t.end],
        };
    }
    return null;
}

/** Rust's `check_round_argument_order` (`round_excel`, ranged on the call). */
function roundExcelIssue(text: string): FormulaIssue | null {
    const call = excelRoundCalls(text)[0];
    if (!call) return null;
    const x = text.slice(call.x[0], call.x[1]).trim();
    const n = text.slice(call.n[0], call.n[1]).trim();
    return { code: 'round_excel', message: roundOrderMessage(x, n), range: [call.start, call.end] };
}

/** Rust's `round_order_message`. */
export function roundOrderMessage(x: string, n: string): string {
    const places = roundPlaces(n);
    if (places === 0) return `Formula error: round(${x}, ${n}) is not supported. Write round(${x}) to round to a whole number.`;
    if (places !== null) {
        const scale = 10 ** places;
        const xw = isFormulaAtom(x) ? x : `(${x})`;
        return `Formula error: round(${x}, ${n}) does not round to ${places} decimal place${places === 1 ? '' : 's'}. Write round(${xw} * ${scale}) / ${scale} instead.`;
    }
    return `Formula error: round(${x}, ${n}) is not supported. To round to the nearest step, put the step first: round(${n}, ${x}).`;
}

/** Rust's `division_by_zero`: `/ 0` (a literal zero not raised to a power). */
function divisionByZero(toks: FormulaToken[]): FormulaIssue | null {
    for (let k = 0; k + 1 < toks.length; k++) {
        const a = toks[k];
        const b = toks[k + 1];
        const raised = toks[k + 2]?.kind === 'op' && toks[k + 2].text === '^';
        if (a.kind === 'op' && a.text === '/' && b.kind === 'number' && numberValue(b.text) === 0 && !raised) {
            return { code: 'div_zero', message: DIV_ZERO_MESSAGE, range: [a.start, b.end] };
        }
    }
    return null;
}

const AGG_LABEL: Record<string, string> = { mean: 'Average', median: 'Median', sum: 'Sum' };
/** Rust's `MAX_OPERATION_DECIMALS`. */
export const MAX_BLOCK_DECIMALS = 10;

/** Rust's `check_multi_operation` for an Average / Median / Sum block. */
export function checkAggregate(
    block: FormulaPreviewAggregate,
    ctx: Pick<FormulaCheckContext, 'isKnownSensor' | 'mode'> = {},
): FormulaIssue | null {
    if (block.sources.length === 0) return { code: 'agg_too_few', message: 'No sensors selected' };
    if (ctx.isKnownSensor) {
        const miss = block.sources.find(s => !ctx.isKnownSensor!(s));
        if (miss !== undefined) return { code: 'unknown_sensor', message: `Sensor not found: ${miss}` };
    }
    if (!(block.type in AGG_LABEL)) return { code: 'unknown_operation', message: `Unknown multi operation: ${block.type}` };
    if ((ctx.mode ?? 'create') === 'create' && block.sources.length < 2) {
        return { code: 'agg_too_few', message: `${AGG_LABEL[block.type]} needs at least 2 sensors.` };
    }
    const d = block.decimals;
    if (d !== undefined && d !== null && !(Number.isInteger(d) && d >= 0 && d <= MAX_BLOCK_DECIMALS)) {
        return { code: 'bad_decimals', message: `Decimals must be a whole number from 0 to ${MAX_BLOCK_DECIMALS} (got ${d}).` };
    }
    return null;
}
