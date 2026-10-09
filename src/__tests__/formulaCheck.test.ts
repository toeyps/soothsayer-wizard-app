import { describe, it, expect } from 'vitest';
import {
    checkAggregate, checkFormula, DIV_ZERO_MESSAGE, NO_SENSOR_MESSAGE, numberValue, roundOrderMessage, sensorResolver,
} from '../utils/formulaCheck';
import { tokenizeFormula } from '../utils/formulaTokens';

const FUNCTIONS = ['abs', 'sqrt', 'pow', 'exp', 'ln', 'log', 'log10', 'round', 'min', 'max', 'ceil', 'floor',
    'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh', 'sign', 'int', 'pi', 'e'];
const check = (f: string, ctx = {}) => checkFormula(f, tokenizeFormula(f), ctx);
const code = (f: string, ctx = {}) => {
    const i = check(f, ctx);
    return i ? [i.code, ...(i.range ?? [])] : null;
};

describe('checkFormula: the structural scan matches Rust locate_syntax_issue (codes and ranges)', () => {
    // The table in src-tauri/src/formula_diagnostics.rs
    // `structural_scan_finds_each_kind_of_problem_with_its_char_range`.
    const table: Array<[string, unknown]> = [
        ['$A + $B', null],
        ['-$A + max($A, -1)', null],
        ['pi() * $A', null],
        ['$A $B', ['missing_operator', 0, 5]],
        ['$A (1)', ['missing_operator', 0, 4]],
        ['$A + )', ['op_no_right', 3, 4]],
        ['$A )', ['unmatched_close', 3, 4]],
        ['($A]', ['unmatched_close', 3, 4]],
        ['(($A + 1)', ['unclosed_bracket', 0, 1]],
        ['$A * ()', ['empty_brackets', 5, 7]],
        ['* $A', ['op_no_left', 0, 1]],
        ['$A +', ['op_no_right', 3, 4]],
        ['$A, $B', ['stray_comma', 2, 3]],
        ['max($A,)', ['stray_comma', 6, 7]],
        ['$A @ 2', ['bad_char', 3, 4]],
        ['$A + 1.2.3', ['bad_number', 5, 10]],
        ['$A = 2', ['bad_char', 3, 4]],
    ];
    for (const [f, want] of table) {
        it(f, () => expect(code(f)).toEqual(want));
    }

    it('accepts what the engine accepts: unary signs, comparisons, SI suffixes, [ ] and ; spellings', () => {
        for (const f of ['$A * -$B', '!$A', '$A % 2', '$A ^ -2', '$A >= 2k && $B < 5m', 'round[$A]', 'max($A; $B)', '-(($A))', '.5 * $A', '$A / 1e-3']) {
            expect(check(f, { functions: FUNCTIONS }), f).toBeNull();
        }
    });

    it('an empty text has nothing to report', () => {
        expect(check('')).toBeNull();
        expect(check('   ')).toBeNull();
    });
});

describe('checkFormula: the gate order (limits -> references -> structure -> names -> round_excel -> div_zero)', () => {
    it('too_long counts UTF-16 units, too_deep counts ( [ { together and is ranged on the first bracket over', () => {
        expect(check('$A' + ' '.repeat(4095))?.code).toBe('too_long');
        expect(check(`${'('.repeat(65)}$A${')'.repeat(65)}`)).toMatchObject({ code: 'too_deep', range: [64, 65] });
        expect(check('$A', { maxLength: 1 })?.message).toBe('Formula too long (2 chars, max 1)');
        expect(check(`${'('.repeat(64)}$A${')'.repeat(64)}`)).toBeNull();
    });

    it('constant_only when there is no sensor at all (Rust message)', () => {
        expect(check('1 + 2')).toEqual({ code: 'constant_only', message: NO_SENSOR_MESSAGE });
    });

    it('unknown_sensor: the first unknown name in order, ranged on its first occurrence, before any syntax problem', () => {
        const isKnownSensor = sensorResolver(['A', 'Flow (m3/h)']);
        expect(check('$A + $Nope + $Nope', { isKnownSensor })).toEqual({ code: 'unknown_sensor', message: 'Sensor not found: Nope', range: [5, 10] });
        expect(check('$Nope +', { isKnownSensor })?.code).toBe('unknown_sensor');
        // Rust's resolve_sensor: exact, else trimmed + case-insensitive.
        expect(check('$a + ${ flow (M3/H) }', { isKnownSensor })).toBeNull();
    });

    it('names are only judged once Rust has sent its function list', () => {
        expect(check('sqr($A)')).toBeNull();
        expect(check('sqr($A)', { functions: FUNCTIONS })).toMatchObject({ code: 'unknown_function', range: [0, 3] });
        expect(check('sqr($A)', { functions: FUNCTIONS })!.message).toContain('Available functions: abs, sqrt');
        expect(check('$A * TAG1', { functions: FUNCTIONS })).toMatchObject({ code: 'unknown_function', range: [5, 9] });
        expect(check('$A * TAG1', { functions: FUNCTIONS })!.message).toMatch(/^Unknown name 'TAG1'/);
    });

    it('fn_no_bracket for a function written without its bracket, pi / e included', () => {
        expect(check('abs + $A', { functions: FUNCTIONS })).toMatchObject({ code: 'fn_no_bracket', range: [0, 3] });
        expect(check('$A * pi', { functions: FUNCTIONS })).toEqual({ code: 'fn_no_bracket', message: 'Write pi() for π.', range: [5, 7] });
        expect(check('$A * pi()', { functions: FUNCTIONS })).toBeNull();
    });

    it('round_excel for the spreadsheet order, with Rust\'s message, ranged on the call', () => {
        expect(check('round($A, 2) + 1', { functions: FUNCTIONS })).toEqual({
            code: 'round_excel',
            message: 'Formula error: round($A, 2) does not round to 2 decimal places. Write round($A * 100) / 100 instead.',
            range: [0, 12],
        });
        expect(check('round(0.01, $A)', { functions: FUNCTIONS })).toBeNull();
        expect(check('round($A * 100) / 100', { functions: FUNCTIONS })).toBeNull();
    });

    it('div_zero only when creating (Rust skips it on a Save of an existing sensor)', () => {
        expect(check('$A / 0')).toEqual({ code: 'div_zero', message: DIV_ZERO_MESSAGE, range: [3, 6] });
        expect(check('$A / 0', { mode: 'edit' })).toBeNull();
        expect(check('$A / 0 ^ 0')).toBeNull();
        expect(check('$A / 0.5')).toBeNull();
    });
});

describe('roundOrderMessage (Rust round_order_message)', () => {
    it('words each case like Rust', () => {
        expect(roundOrderMessage('$A', '0')).toBe('Formula error: round($A, 0) is not supported. Write round($A) to round to a whole number.');
        expect(roundOrderMessage('$A + $B', '1')).toBe('Formula error: round($A + $B, 1) does not round to 1 decimal place. Write round(($A + $B) * 10) / 10 instead.');
        expect(roundOrderMessage('$A', '0.5')).toBe('Formula error: round($A, 0.5) is not supported. To round to the nearest step, put the step first: round(0.5, $A).');
    });
});

describe('numberValue (Rust number_value)', () => {
    it('reads SI suffixes and refuses non-numbers', () => {
        expect(numberValue('2k')).toBe(2000);
        expect(numberValue('5m')).toBeCloseTo(0.005);
        expect(numberValue('1.')).toBe(1);
        expect(numberValue('.5')).toBe(0.5);
        expect(numberValue('2.5e-3')).toBeCloseTo(0.0025);
        expect(numberValue('1.2.3')).toBeNull();
        expect(numberValue('.')).toBeNull();
    });
});

describe('checkAggregate (Rust check_multi_operation)', () => {
    const isKnownSensor = sensorResolver(['A', 'B']);
    it('applies Rust\'s order and the create-only "at least 2"', () => {
        expect(checkAggregate({ type: 'mean', sources: [] })?.code).toBe('agg_too_few');
        expect(checkAggregate({ type: 'mean', sources: ['A', 'X'] }, { isKnownSensor })).toEqual({ code: 'unknown_sensor', message: 'Sensor not found: X' });
        expect(checkAggregate({ type: 'mode' as never, sources: ['A', 'B'] })?.code).toBe('unknown_operation');
        expect(checkAggregate({ type: 'median', sources: ['A'] })).toEqual({ code: 'agg_too_few', message: 'Median needs at least 2 sensors.' });
        expect(checkAggregate({ type: 'median', sources: ['A'] }, { mode: 'edit' })).toBeNull();
        expect(checkAggregate({ type: 'mean', sources: ['A', 'B'], decimals: 11 })?.code).toBe('bad_decimals');
        expect(checkAggregate({ type: 'mean', sources: ['A', 'B'], decimals: 1.5 })?.code).toBe('bad_decimals');
        expect(checkAggregate({ type: 'mean', sources: ['A', 'B'], decimals: 2 }, { isKnownSensor })).toBeNull();
    });
});
