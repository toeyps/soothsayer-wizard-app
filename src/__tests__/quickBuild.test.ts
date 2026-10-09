import { describe, it, expect } from 'vitest';
import type { SpecialSensorRecipe } from '../types';
import {
    applyTransform, blockOperationConfig, blockPreviewAggregate, editorStateFormula, editorStateToRecipe,
    insertQuickPiece, numberOperand, quickMulti, quickSingle, recipeToEditorState, type QuickFormula,
} from '../utils/quickBuild';
import { checkFormula } from '../utils/formulaCheck';
import { tokenizeFormula } from '../utils/formulaTokens';

const valid = (f: string) => checkFormula(f, tokenizeFormula(f), { functions: ['abs', 'sqrt', 'log10', 'exp', 'ceil', 'floor', 'round', 'min', 'max'] });

describe('quickSingle (1 picked sensor)', () => {
    it('As-is, combine with a number, transforms; names use the shared brace rule', () => {
        expect(quickSingle('A', null)).toMatchObject({ formula: '$A', ready: true, hasTopLevelOperator: false });
        expect(quickSingle('Flow (m3/h)', { kind: 'number', op: '*', value: '1.5' })).toMatchObject({ formula: '${Flow (m3/h)} * 1.5', ready: true, hasTopLevelOperator: true });
        expect(quickSingle('A', { kind: 'number', op: '-', value: '-5' }).formula).toBe('$A - (-5)');
        expect(quickSingle('A', { kind: 'number', op: '/', value: '2k' }).formula).toBe('$A / 2k');
        expect(quickSingle('A', { kind: 'transform', transform: { fn: 'sqrt' } }).formula).toBe('sqrt($A)');
        expect(quickSingle('A', { kind: 'transform', transform: { fn: 'log10' } }).formula).toBe('log10($A)');
    });

    it('stays dim ("Enter the number") until a number is typed', () => {
        expect(quickSingle('A', { kind: 'number', op: '+', value: '' })).toMatchObject({ formula: '$A + …', ready: false, hint: 'Enter the number.' });
        expect(quickSingle('A', { kind: 'number', op: '+', value: 'abc' }).ready).toBe(false);
    });

    it('round writes round(X * 10^N) / 10^N -- never round(0.01, X)', () => {
        expect(quickSingle('A', { kind: 'transform', transform: { fn: 'round', decimals: 2 } }).formula).toBe('round($A * 100) / 100');
        expect(quickSingle('A', { kind: 'transform', transform: { fn: 'round', decimals: 0 } }).formula).toBe('round($A)');
    });

    it('everything it writes passes the check', () => {
        for (const c of [null, { kind: 'number', op: '^', value: '2' }, { kind: 'transform', transform: { fn: 'abs' } }, { kind: 'transform', transform: { fn: 'round', decimals: 3 } }] as const) {
            expect(valid(quickSingle('A', c).formula)).toBeNull();
        }
    });
});

describe('quickMulti (2+ picked sensors)', () => {
    const three = ['A', 'B', 'C'];
    it('chain with per-gap signs (+ by default)', () => {
        expect(quickMulti(three, { combine: null }).kind === 'formula' && (quickMulti(three, { combine: null }) as QuickFormula).formula).toBe('$A + $B + $C');
        expect((quickMulti(three, { combine: null, signs: ['-', '*'] }) as QuickFormula).formula).toBe('$A - $B * $C');
    });

    it('Sum ignores the signs; Spread is max(…) - min(…)', () => {
        expect((quickMulti(three, { combine: 'sum', signs: ['-', '*'] }) as QuickFormula).formula).toBe('$A + $B + $C');
        expect((quickMulti(three, { combine: 'spread' }) as QuickFormula).formula).toBe('max($A, $B, $C) - min($A, $B, $C)');
    });

    it('|A − B| and Efficiency % need exactly 2; Efficiency waits for the input sensor', () => {
        expect((quickMulti(['A', 'B'], { combine: 'absdiff' }) as QuickFormula)).toMatchObject({ formula: 'abs($A - $B)', hasTopLevelOperator: false });
        expect(quickMulti(three, { combine: 'absdiff' })).toMatchObject({ ready: false });
        expect(quickMulti(['OUT', 'IN'], { combine: 'efficiency' })).toMatchObject({ ready: false, hint: 'Mark which sensor is the input (100 %).' });
        expect(quickMulti(['OUT', 'IN'], { combine: 'efficiency', inputTag: 'IN' })).toMatchObject({ formula: '($OUT / $IN) * 100', ready: true });
        expect(quickMulti(three, { combine: 'efficiency', inputTag: 'A' }).ready).toBe(false);
    });

    it('Then wrap; round wraps in the engine form', () => {
        expect((quickMulti(['A', 'B'], { combine: null, wrap: { fn: 'abs' } }) as QuickFormula)).toMatchObject({ formula: 'abs($A + $B)', hasTopLevelOperator: false });
        expect((quickMulti(['A', 'B'], { combine: 'sum', wrap: { fn: 'round', decimals: 2 } }) as QuickFormula).formula).toBe('round(($A + $B) * 100) / 100');
    });

    it('Average / Median are BLOCKS with their own decimals, never a round() wrap', () => {
        const b = quickMulti(three, { combine: 'mean', wrap: { fn: 'round', decimals: 2 }, blockDecimals: 1 });
        expect(b).toEqual({
            kind: 'block', type: 'mean', sources: three, decimals: 1,
            label: 'Average of 3 sensors · missing values skipped', ready: true, hint: null,
        });
        expect(quickMulti(['A', 'B'], { combine: 'median' })).toMatchObject({ kind: 'block', type: 'median', decimals: null, label: 'Median of 2 sensors · missing values skipped' });
        expect(blockOperationConfig('mean', 1, 'AVG')).toEqual({ mode: 'multi', multiOp: { type: 'mean', decimals: 1 }, customName: 'AVG' });
        expect(blockOperationConfig('median', null)).toEqual({ mode: 'multi', multiOp: { type: 'median' } });
        expect(blockPreviewAggregate({ type: 'mean', sources: ['A', 'B'], decimals: 2 })).toEqual({ type: 'mean', sources: ['A', 'B'], decimals: 2 });
        expect(blockPreviewAggregate({ type: 'mean', sources: ['A', 'B'], decimals: null })).toEqual({ type: 'mean', sources: ['A', 'B'] });
    });

    it('refuses fewer than 2 sensors', () => {
        expect(() => quickMulti(['A'], { combine: null })).toThrow();
    });
});

describe('numberOperand / applyTransform', () => {
    it('numbers, signs and SI suffixes', () => {
        expect(numberOperand(' 2.5 ')).toBe('2.5');
        expect(numberOperand('-3')).toBe('(-3)');
        expect(numberOperand('+4')).toBe('4');
        expect(numberOperand('5k')).toBe('5k');
        expect(numberOperand('1e3')).toBe('1e3');
        expect(numberOperand('')).toBeNull();
        expect(numberOperand('$A')).toBeNull();
    });
    it('transforms', () => {
        expect(applyTransform('$A + $B', { fn: 'ceil' })).toBe('ceil($A + $B)');
        expect(applyTransform('$A', { fn: 'round', decimals: 99 })).toBe('round($A * 1000000000000000) / 1000000000000000');
    });
});

describe('insertQuickPiece: "Insert at cursor" brackets a piece with a top-level operator', () => {
    it('brackets into existing text, never into an empty editor or for one operand', () => {
        expect(insertQuickPiece('2 * ', 4, 4, quickSingle('A', { kind: 'number', op: '+', value: '1' }))).toEqual({ text: '2 * ($A + 1)', selection: [12, 12] });
        expect(insertQuickPiece('', 0, 0, '$A + $B').text).toBe('$A + $B');
        expect(insertQuickPiece('2 * ', 4, 4, 'abs($A - $B)').text).toBe('2 * abs($A - $B)');
        expect(insertQuickPiece('$X', 0, 2, '$A + $B').text).toBe('$A + $B'); // replacing the whole text
        expect(insertQuickPiece('$X * ', 5, 5, 'round($A * 100) / 100').text).toBe('$X * (round($A * 100) / 100)');
    });
});

describe('recipe <-> editor state', () => {
    const op = (sources: string[], operationConfig: SpecialSensorRecipe & { kind: 'operation' } extends { operationConfig: infer C } ? C : never): SpecialSensorRecipe =>
        ({ kind: 'operation', tag: 'S', sourceSensors: sources, operationConfig });

    it('a formula opens with its "Round the result" split off', () => {
        expect(recipeToEditorState({ kind: 'formula', tag: 'S', formula: 'round(($A + $B) * 100) / 100' }))
            .toEqual({ mode: 'formula', text: '$A + $B', roundDecimals: 2, note: null });
        expect(recipeToEditorState({ kind: 'formula', tag: 'S', formula: '$A * 2' }))
            .toEqual({ mode: 'formula', text: '$A * 2', roundDecimals: null, note: null });
    });

    it('Average / Median open as blocks; a legacy Sum opens as A + B + C with a note', () => {
        expect(recipeToEditorState(op(['A', 'B'], { mode: 'multi', multiOp: { type: 'mean', decimals: 2 } })))
            .toEqual({ mode: 'block', type: 'mean', sources: ['A', 'B'], decimals: 2, note: null });
        expect(recipeToEditorState(op(['A', 'B c', 'C'], { mode: 'multi', multiOp: { type: 'sum' } })))
            .toEqual({ mode: 'formula', text: '$A + ${B c} + $C', roundDecimals: null, note: 'legacy-sum' });
    });

    it('a one-sensor operation opens as its formula', () => {
        expect(recipeToEditorState(op(['A'], { mode: 'single', singleOp: { type: 'add', value: -2 } }))).toMatchObject({ text: '$A + (-2)', note: 'legacy-operation' });
        expect(recipeToEditorState(op(['A'], { mode: 'single', singleOp: { type: 'sqrt', value: 0 } }))).toMatchObject({ text: 'sqrt($A)' });
        const r = recipeToEditorState(op(['A'], { mode: 'single', singleOp: { type: 'round', value: 2 } }));
        expect(r).toMatchObject({ mode: 'formula', text: '$A', roundDecimals: 2 });
        expect(editorStateFormula(r as never)).toBe('round($A * 100) / 100');
    });

    it('editorStateToRecipe: formula / block recipes; an UNTOUCHED legacy recipe is returned as it was', () => {
        expect(editorStateToRecipe({ mode: 'formula', text: ' $A + 1 ', roundDecimals: 1, note: null }, 'S'))
            .toEqual({ kind: 'formula', tag: 'S', formula: 'round(($A + 1) * 10) / 10' });
        expect(editorStateToRecipe({ mode: 'block', type: 'median', sources: ['A', 'B'], decimals: null, note: null }, 'S'))
            .toEqual({ kind: 'operation', tag: 'S', sourceSensors: ['A', 'B'], operationConfig: { mode: 'multi', multiOp: { type: 'median' }, customName: 'S' } });
        const legacy = op(['A', 'B'], { mode: 'multi', multiOp: { type: 'sum' }, customName: 'S' });
        const opened = recipeToEditorState(legacy);
        expect(editorStateToRecipe(opened, 'S', legacy)).toBe(legacy);
        expect(editorStateToRecipe({ ...opened, text: '$A - $B' } as never, 'S', legacy)).toEqual({ kind: 'formula', tag: 'S', formula: '$A - $B' });
        const f: SpecialSensorRecipe = { kind: 'formula', tag: 'S', formula: 'round($A * 100) / 100' };
        expect(editorStateToRecipe(recipeToEditorState(f), 'S', f)).toBe(f);
    });
});
