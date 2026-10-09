import { describe, it, expect } from 'vitest';
import {
    closestFunction, fixForIssue, insertFunction, insertOperator, insertPiece, insertSensorAt,
    replaceSensorEverywhere, unwrapAt, wrapSelection, type FormulaFix,
} from '../utils/formulaFixes';
import { checkFormula, sensorResolver } from '../utils/formulaCheck';
import { tokenizeFormula } from '../utils/formulaTokens';

const FUNCTIONS = ['abs', 'sqrt', 'pow', 'exp', 'ln', 'log', 'log10', 'round', 'min', 'max', 'ceil', 'floor', 'sin', 'cos', 'tan', 'sign', 'int', 'pi', 'e'];
const issueOf = (f: string, ctx = {}) => checkFormula(f, tokenizeFormula(f), { functions: FUNCTIONS, ...ctx });
const edit = (fix: FormulaFix | null) => (fix && fix.kind === 'edit' ? fix : null);

describe('fixForIssue: one fix per stable code, usable on an issue from the check or from Rust', () => {
    it('unclosed_bracket -> "Add )" closes everything still open, innermost first', () => {
        const f = 'max(abs($A + 1), [$B ';
        const fix = edit(fixForIssue(f, issueOf(f)));
        expect(fix?.label).toBe('Add ])');
        expect(fix?.edit.text).toBe('max(abs($A + 1), [$B])');
        expect(issueOf(fix!.edit.text)?.code).not.toBe('unclosed_bracket');
        expect(edit(fixForIssue('($A', issueOf('($A')))).toMatchObject({ label: 'Add )', edit: { text: '($A)', selection: [4, 4] } });
    });

    it('missing_operator -> "Insert ×"', () => {
        expect(edit(fixForIssue('$A $B', issueOf('$A $B')))).toMatchObject({ label: 'Insert ×', edit: { text: '$A * $B', selection: [5, 5] } });
        expect(edit(fixForIssue('$A(1 - $B)', issueOf('$A(1 - $B)')))?.edit.text).toBe('$A * (1 - $B)');
    });

    it('round_excel -> "Use round(… * 100) / 100": Rust\'s converted_formula when given, else the local rewrite of that call', () => {
        const f = '2 ^ round($A, 1)';
        const issue = issueOf(f)!;
        expect(issue.code).toBe('round_excel');
        expect(edit(fixForIssue(f, issue))).toMatchObject({ label: 'Use round(… * 10) / 10', edit: { text: '2 ^ (round($A * 10) / 10)' } });
        expect(edit(fixForIssue(f, issue, { convertedFormula: 'FROM RUST' }))?.edit.text).toBe('FROM RUST');
        expect(edit(fixForIssue('round($A, 0)', issueOf('round($A, 0)')))).toMatchObject({ label: 'Use round(…)', edit: { text: 'round($A)' } });
        // Not convertible (a step that is not a whole number): no fix.
        expect(fixForIssue('round($A, 0.5)', issueOf('round($A, 0.5)'))).toBeNull();
        // A Rust issue (same code + range) works the same.
        expect(edit(fixForIssue('round($A, 2)', { code: 'round_excel', message: 'm', range: [0, 12] }))?.edit.text).toBe('round($A * 100) / 100');
    });

    it('unknown_function -> "Use sqrt" when an engine function is close; nothing otherwise', () => {
        const f = 'sqr($A)';
        expect(edit(fixForIssue(f, issueOf(f), { functions: FUNCTIONS }))).toMatchObject({ label: 'Use sqrt', edit: { text: 'sqrt($A)', selection: [4, 4] } });
        expect(edit(fixForIssue('ABS($A)', issueOf('ABS($A)'), { functions: FUNCTIONS }))?.edit.text).toBe('abs($A)');
        expect(fixForIssue('$A * zzzz($A)', issueOf('$A * zzzz($A)'), { functions: FUNCTIONS })).toBeNull();
        expect(fixForIssue(f, issueOf(f))).toBeNull(); // no function list -> no guess
    });

    it('fn_no_bracket -> "Add ( )" with the caret inside (after, for pi / e)', () => {
        expect(edit(fixForIssue('abs + $A', issueOf('abs + $A')))).toMatchObject({ label: 'Add ( )', edit: { text: 'abs() + $A', selection: [4, 4] } });
        expect(edit(fixForIssue('$A * pi', issueOf('$A * pi')))).toMatchObject({ edit: { text: '$A * pi()', selection: [9, 9] } });
    });

    it('unmatched_close -> "Remove it"', () => {
        expect(edit(fixForIssue('$A )', issueOf('$A )')))).toMatchObject({ label: 'Remove it', edit: { text: '$A ', selection: [3, 3] } });
    });

    it('unknown_sensor -> "Replace…" naming the sensor (from the range, or from Rust\'s message)', () => {
        const f = '$A + ${Old Tag}';
        const issue = issueOf(f, { isKnownSensor: sensorResolver(['A']) });
        expect(fixForIssue(f, issue)).toEqual({ kind: 'replace-sensor', label: 'Replace…', sensor: 'Old Tag' });
        expect(fixForIssue(f, { code: 'unknown_sensor', message: 'Sensor not found: Old Tag' })).toMatchObject({ sensor: 'Old Tag' });
    });

    it('no fix for codes without one, or no issue', () => {
        expect(fixForIssue('$A +', issueOf('$A +'))).toBeNull();
        expect(fixForIssue('$A', null)).toBeNull();
    });
});

describe('closestFunction', () => {
    it('case, then edit distance, then prefix', () => {
        expect(closestFunction('SQRT', FUNCTIONS)).toBe('sqrt');
        expect(closestFunction('sqr', FUNCTIONS)).toBe('sqrt');
        expect(closestFunction('flor', FUNCTIONS)).toBe('floor');
        expect(['ln', 'log']).toContain(closestFunction('lo', FUNCTIONS));
        expect(closestFunction('log1', FUNCTIONS)).toBe('log');
        expect(closestFunction('xyzzy', FUNCTIONS)).toBeNull();
    });
});

describe('replaceSensorEverywhere', () => {
    it('replaces every occurrence (either spelling) with the shared brace rule, never a prefix of a longer name', () => {
        const r = replaceSensorEverywhere('$A + ${A} * $A.PV + $A', 'A', 'Flow (m3/h)');
        expect(r.text).toBe('${Flow (m3/h)} + ${Flow (m3/h)} * $A.PV + ${Flow (m3/h)}');
        expect(r.selection).toEqual([r.text.length, r.text.length]);
        expect(replaceSensorEverywhere('$X + 1', 'X', 'B_2').text).toBe('$B_2 + 1');
        expect(replaceSensorEverywhere('$X + $Y', 'X', 'Z').selection).toEqual([2, 2]);
    });
});

describe('structural edits', () => {
    it('wrapSelection keeps the inside selected; nothing for an empty selection', () => {
        expect(wrapSelection('$A + $B * 2', 0, 7)).toEqual({ text: '($A + $B) * 2', selection: [1, 8] });
        expect(wrapSelection('$A', 1, 1)).toBeNull();
    });

    it('unwrapAt removes the pair at the caret and selects the former inside', () => {
        expect(unwrapAt('($A + $B) * 2', 0, 0)).toEqual({ text: '$A + $B * 2', selection: [0, 7] });
        // A function's own brackets go with its name.
        expect(unwrapAt('abs(($A))', 9, 9)).toEqual({ text: '($A)', selection: [0, 4] });
        expect(unwrapAt('abs(($A))', 4, 4)).toEqual({ text: 'abs($A)', selection: [4, 6] });
        expect(unwrapAt('$A + 1', 2, 2)).toBeNull();
    });

    it('insertPiece adds the palette spacing so references never fuse', () => {
        expect(insertPiece('$A', 2, 2, '+')).toEqual({ text: '$A +', selection: [4, 4] });
        expect(insertSensorAt('$A +', 4, 4, 'B c')).toEqual({ text: '$A + ${B c}', selection: [11, 11] });
        expect(insertSensorAt('max(', 4, 4, 'A')).toEqual({ text: 'max($A', selection: [6, 6] });
        expect(insertSensorAt('$A)', 2, 2, 'B')).toEqual({ text: '$A $B)', selection: [5, 5] });
        expect(insertOperator('$A$B', 2, 2, '*')).toEqual({ text: '$A * $B', selection: [4, 4] });
    });

    it('insertFunction wraps the selection (inside kept selected), or puts the caret inside fn()', () => {
        expect(insertFunction('$A - $B', 0, 7, 'abs')).toEqual({ text: 'abs($A - $B)', selection: [4, 11] });
        expect(insertFunction('', 0, 0, 'sqrt')).toEqual({ text: 'sqrt()', selection: [5, 5] });
        expect(insertFunction('$A *', 4, 4, 'pi')).toEqual({ text: '$A * pi()', selection: [9, 9] });
    });
});
