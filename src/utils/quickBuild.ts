import type { SensorOperationConfig, SpecialSensorRecipe } from '../types';
import type { FormulaPreviewAggregate } from '../types/formula';
import { sensorRef } from './specialSensorNaming';
import { hasTopLevelOperator, isFormulaAtom } from './formulaTokens';
import { roundExpression, splitRoundResult, withRoundResult } from './formulaRounding';
import { numberValue } from './formulaCheck';
import { insertPiece, type FormulaEdit } from './formulaFixes';

/**
 * Quick build -- the selection-aware way to START a special-sensor formula.
 * Pure generators: given the picked sensors and the chosen
 * options they return the formula TEXT (shown in the card's footer before
 * anything is committed) or, for Average / Median, the aggregate BLOCK.
 *
 * Every sensor is written by the shared brace rule (`sensorRef`, the same as
 * Rust's `sensor_ref_token`); rounding is the engine form
 * `round(X * 10^N) / 10^N` (`formulaRounding.ts`); a block rounds with
 * `multiOp.decimals`, never a `round()` wrap.
 */

export type QuickNumberOp = '+' | '-' | '*' | '/' | '^';
/** The transforms the card offers (`log10` = log₁₀; `sqrt` = √). */
export type QuickTransform = 'abs' | 'sqrt' | 'log10' | 'exp' | 'ceil' | 'floor' | 'round';
export const QUICK_TRANSFORMS: readonly QuickTransform[] = ['abs', 'sqrt', 'log10', 'exp', 'ceil', 'floor', 'round'];
export const QUICK_NUMBER_OPS: readonly QuickNumberOp[] = ['+', '-', '*', '/', '^'];

/** Formula text Quick build would write. */
export interface QuickFormula {
    kind: 'formula';
    formula: string;
    /** Has an operator outside every bracket: "Insert at cursor" brackets it
     *  when the editor already has text (`insertQuickPiece`). */
    hasTopLevelOperator: boolean;
    /** False while an option still needs input (the number, the input sensor):
     *  the footer shows the text dimmed and the buttons stay disabled. */
    ready: boolean;
    /** Why it is not ready (or a note), for the footer. */
    hint: string | null;
}

/** An Average / Median aggregate block (stands alone; skips missing values). */
export interface QuickBlock {
    kind: 'block';
    type: 'mean' | 'median';
    sources: string[];
    decimals: number | null;
    /** "Average of 3 sensors · missing values skipped". */
    label: string;
    ready: boolean;
    hint: string | null;
}

export type QuickResult = QuickFormula | QuickBlock;

/** A transform choice: `round` carries its decimals (0 = whole number). */
export interface QuickTransformChoice {
    fn: QuickTransform;
    decimals?: number;
}

/** `fn(inner)` for a transform, or the round form. */
export function applyTransform(inner: string, choice: QuickTransformChoice): string {
    if (choice.fn === 'round') return roundExpression(inner, clampDecimals(choice.decimals ?? 0));
    return `${choice.fn}(${inner.trim()})`;
}

function clampDecimals(d: number): number {
    return Math.max(0, Math.min(15, Math.trunc(Number.isFinite(d) ? d : 0)));
}

const formula = (text: string, ready = true, hint: string | null = null): QuickFormula => ({
    kind: 'formula', formula: text, hasTopLevelOperator: hasTopLevelOperator(text), ready, hint,
});

/** A typed number as a formula operand: a negative one is bracketed so
 *  `$A - (-5)` never reads as `$A --5`. Null when it is not a number. */
export function numberOperand(value: string): string | null {
    const v = value.trim();
    const neg = v.startsWith('-');
    const body = neg ? v.slice(1).trim() : v.startsWith('+') ? v.slice(1).trim() : v;
    if (!body || numberValue(body) === null) return null;
    return neg ? `(-${body})` : body;
}

/** One picked sensor. `choice` null = "As-is". */
export type QuickSingleChoice =
    | null
    | { kind: 'number'; op: QuickNumberOp; value: string }
    | { kind: 'transform'; transform: QuickTransformChoice };

export function quickSingle(tag: string, choice: QuickSingleChoice): QuickFormula {
    const a = sensorRef(tag);
    if (!choice) return formula(a, true, 'As-is: the sensor itself. Pick a number or a transform to change it.');
    if (choice.kind === 'number') {
        const operand = numberOperand(choice.value);
        if (operand === null) return formula(`${a} ${choice.op} …`, false, 'Enter the number.');
        return formula(`${a} ${choice.op} ${operand}`);
    }
    return formula(applyTransform(a, choice.transform));
}

/** Two or more picked sensors. */
export type QuickCombine = null | 'sum' | 'mean' | 'median' | 'spread' | 'absdiff' | 'efficiency';

export interface QuickMultiChoice {
    /** null = the chain with its per-gap signs. */
    combine: QuickCombine;
    /** Chain signs, one per gap (`signs[i]` sits between sensor i and i+1);
     *  missing entries are `+`. Ignored while a combination is chosen. */
    signs?: readonly QuickNumberOp[];
    /** Efficiency %: which picked sensor is the input (= 100 %). */
    inputTag?: string | null;
    /** "Then wrap" (not for blocks). */
    wrap?: QuickTransformChoice | null;
    /** Rounding of an Average / Median block (`multiOp.decimals`); null = none. */
    blockDecimals?: number | null;
}

const BLOCK_NAME = { mean: 'Average', median: 'Median' } as const;

export function quickMulti(tags: readonly string[], choice: QuickMultiChoice): QuickResult {
    const n = tags.length;
    if (n < 2) throw new RangeError('quickMulti needs 2 or more sensors');
    const refs = tags.map(sensorRef);
    const list = refs.join(', ');
    const { combine } = choice;

    if (combine === 'mean' || combine === 'median') {
        const decimals = choice.blockDecimals ?? null;
        return {
            kind: 'block', type: combine, sources: [...tags], decimals,
            label: `${BLOCK_NAME[combine]} of ${n} sensors · missing values skipped`,
            ready: true, hint: null,
        };
    }

    let inner: string;
    switch (combine) {
        case null:
            inner = refs.map((r, i) => (i === 0 ? r : `${choice.signs?.[i - 1] ?? '+'} ${r}`)).join(' ');
            break;
        case 'sum':
            inner = refs.join(' + ');
            break;
        case 'spread':
            inner = `max(${list}) - min(${list})`;
            break;
        case 'absdiff':
            if (n !== 2) return formula('abs(… - …)', false, '|A − B| needs exactly 2 sensors.');
            inner = `abs(${refs[0]} - ${refs[1]})`;
            break;
        case 'efficiency': {
            if (n !== 2) return formula('(… / …) * 100', false, 'Efficiency % needs exactly 2 sensors.');
            const input = choice.inputTag ?? null;
            if (!input || !tags.includes(input)) {
                return formula('(… / …) * 100', false, 'Mark which sensor is the input (100 %).');
            }
            const out = tags.find(t => t !== input)!;
            inner = `(${sensorRef(out)} / ${sensorRef(input)}) * 100`;
            break;
        }
        default:
            inner = refs.join(' + ');
    }
    return formula(choice.wrap ? applyTransform(inner, choice.wrap) : inner);
}

/** The `SensorOperationConfig` an Average / Median block is stored with --
 *  the same shape the existing aggregate path (`calculate_new_sensor`, mode
 *  `multi`) takes, rounding in `multiOp.decimals`. */
export function blockOperationConfig(
    type: 'mean' | 'median' | 'sum',
    decimals: number | null | undefined,
    customName?: string,
): SensorOperationConfig {
    return {
        mode: 'multi',
        multiOp: { type, ...(decimals !== null && decimals !== undefined ? { decimals } : {}) },
        ...(customName !== undefined ? { customName } : {}),
    };
}

/** The `preview_formula` aggregate for a block. */
export function blockPreviewAggregate(block: { type: 'mean' | 'median' | 'sum'; sources: readonly string[]; decimals?: number | null }): FormulaPreviewAggregate {
    return { type: block.type, sources: [...block.sources], ...(block.decimals !== null && block.decimals !== undefined ? { decimals: block.decimals } : {}) };
}

/**
 * "Insert at cursor": drop a Quick build piece over the editor selection,
 * bracketed when it has a top-level operator and the editor already has
 * other text (so `2 * ` + `$A + $B` becomes `2 * ($A + $B)`), with the
 * palette's spacing. Into an EMPTY editor the piece goes in as it is.
 */
export function insertQuickPiece(text: string, start: number, end: number, piece: QuickFormula | string): FormulaEdit {
    const f = typeof piece === 'string' ? formula(piece) : piece;
    const rest = (text.slice(0, start) + text.slice(end)).trim();
    const body = rest && f.hasTopLevelOperator && !isFormulaAtom(f.formula) ? `(${f.formula})` : f.formula;
    return insertPiece(text, start, end, body);
}

// ---------------------------------------------------------------------------
// Recipe <-> editor state
// ---------------------------------------------------------------------------

/** What the editor holds: free formula text + "Round the result", or a block. */
export type FormulaEditorState =
    | { mode: 'formula'; text: string; roundDecimals: number | null; note: FormulaEditorNote | null }
    | { mode: 'block'; type: 'mean' | 'median' | 'sum'; sources: string[]; decimals: number | null; note: FormulaEditorNote | null };

/** Why an opened recipe looks different from how it was stored:
 *  `legacy-sum` -- a Sum operation opened as `A + B + C` (same result: a row
 *  is missing when any source is); `legacy-operation` -- a one-sensor
 *  operation (`+ 10`, `sqrt`, round to N) opened as its formula. */
export type FormulaEditorNote = 'legacy-sum' | 'legacy-operation';

const SINGLE_BINARY: Record<string, QuickNumberOp> = { add: '+', subtract: '-', multiply: '*', divide: '/', power: '^' };

/** A stored recipe as editor state (Manage › Edit). */
export function recipeToEditorState(recipe: SpecialSensorRecipe): FormulaEditorState {
    if (recipe.kind === 'formula') {
        const { body, decimals } = splitRoundResult(recipe.formula);
        return { mode: 'formula', text: body, roundDecimals: decimals, note: null };
    }
    const cfg = recipe.operationConfig;
    const sources = recipe.sourceSensors ?? [];
    if (cfg.mode === 'multi') {
        const type = cfg.multiOp?.type ?? 'sum';
        const decimals = cfg.multiOp?.decimals ?? null;
        if (type === 'mean' || type === 'median') return { mode: 'block', type, sources: [...sources], decimals, note: null };
        // A legacy Sum: expanded to editable text. Its decimals (if any) become
        // "Round the result" -- the same rounding of the same value.
        return { mode: 'formula', text: sources.map(sensorRef).join(' + '), roundDecimals: decimals, note: 'legacy-sum' };
    }
    const op = cfg.singleOp;
    const a = sensorRef(sources[0] ?? '');
    if (!op) return { mode: 'formula', text: a, roundDecimals: null, note: 'legacy-operation' };
    const bin = SINGLE_BINARY[op.type];
    if (bin) {
        const operand = numberOperand(String(op.value)) ?? String(op.value);
        return { mode: 'formula', text: `${a} ${bin} ${operand}`, roundDecimals: null, note: 'legacy-operation' };
    }
    if (op.type === 'round') {
        return { mode: 'formula', text: a, roundDecimals: clampDecimals(op.value), note: 'legacy-operation' };
    }
    return { mode: 'formula', text: `${op.type}(${a})`, roundDecimals: null, note: 'legacy-operation' };
}

/** The stored formula text of a formula-mode state (round setting applied). */
export function editorStateFormula(state: Extract<FormulaEditorState, { mode: 'formula' }>): string {
    return withRoundResult(state.text, state.roundDecimals).formula;
}

/**
 * The recipe to save for `state`. When `original` is given and the editor
 * still holds exactly what `recipeToEditorState(original)` produced (the user
 * only edited description / unit / component), the ORIGINAL recipe is returned
 * unchanged -- so opening a legacy operation and saving its metadata never
 * turns it into a formula, recomputes it, or reads as a recipe change that
 * sends the models trained on it back to Incomplete.
 */
export function editorStateToRecipe(state: FormulaEditorState, tag: string, original?: SpecialSensorRecipe | null): SpecialSensorRecipe {
    if (original && sameEditorState(state, recipeToEditorState(original))) return original;
    if (state.mode === 'block') {
        return {
            kind: 'operation', tag, sourceSensors: [...state.sources],
            operationConfig: blockOperationConfig(state.type, state.decimals, tag),
        };
    }
    return { kind: 'formula', tag, formula: editorStateFormula(state) };
}

function sameEditorState(a: FormulaEditorState, b: FormulaEditorState): boolean {
    if (a.mode === 'formula' && b.mode === 'formula') return editorStateFormula(a) === editorStateFormula(b);
    if (a.mode === 'block' && b.mode === 'block') {
        return a.type === b.type && a.decimals === b.decimals
            && a.sources.length === b.sources.length && a.sources.every((s, i) => s === b.sources[i]);
    }
    return false;
}
