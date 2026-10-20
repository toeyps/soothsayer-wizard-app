import { describe, it, expect } from 'vitest';
import type { SpecialSensorRecipe } from '../types';
import { howToBuild, rawSourceTags, recipeHowToBuild, recipeOf } from '../utils/specialSensorHowToBuild';
import { withRoundResult } from '../utils/formulaRounding';

const formula = (tag: string, f: string): SpecialSensorRecipe => ({ kind: 'formula', tag, formula: f });
const block = (tag: string, type: 'mean' | 'median' | 'sum', sources: string[], decimals?: number): SpecialSensorRecipe =>
    ({ kind: 'operation', tag, sourceSensors: sources, operationConfig: { mode: 'multi', multiOp: { type, ...(decimals !== undefined ? { decimals } : {}) } } });

describe('recipeHowToBuild', () => {
    it('a formula: references as plain names, x for *', () => {
        expect(recipeHowToBuild(formula('P', '$11EI1301.PV * ${Gen Load} / 100'))).toBe('Calculated as 11EI1301.PV × Gen Load / 100');
    });
    it('a formula with Round the result', () => {
        expect(recipeHowToBuild(formula('R', withRoundResult('$A + $B', 2).formula))).toBe('Calculated as A + B, rounded to 2 decimal places');
        expect(recipeHowToBuild(formula('R1', withRoundResult('$A', 1).formula))).toBe('Calculated as A, rounded to 1 decimal place');
    });
    it('an older step round round(0.01, X)', () => {
        expect(recipeHowToBuild(formula('L', 'round(0.01, $A * 2)'))).toBe('Calculated as A × 2, rounded to 2 decimal places');
        expect(recipeHowToBuild(formula('L1', 'round(0.1, $A)'))).toBe('Calculated as A, rounded to 1 decimal place');
    });
    it('average / median / sum blocks, with and without decimals', () => {
        expect(recipeHowToBuild(block('AVG', 'mean', ['A', 'B']))).toBe('Average of A, B (rows where a source is missing use the others)');
        expect(recipeHowToBuild(block('MED', 'median', ['A', 'B', 'C'], 2))).toBe('Median of A, B, C (rows where a source is missing use the others), rounded to 2 decimal places');
        expect(recipeHowToBuild(block('SUM', 'sum', ['A', 'B']))).toBe('Sum of A, B');
    });
    it('a single operation', () => {
        const r: SpecialSensorRecipe = { kind: 'operation', tag: 'X', sourceSensors: ['A'], operationConfig: { mode: 'single', singleOp: { type: 'add', value: 10 } } };
        expect(recipeHowToBuild(r)).toBe('Calculated as A + 10');
    });
    it('howToBuild by tag (case-insensitive); unknown tag gives ""', () => {
        const recipes = [block('AVG', 'mean', ['A', 'B'])];
        expect(howToBuild(recipes, ' avg ')).toMatch(/^Average of A, B/);
        expect(howToBuild(recipes, 'NOPE')).toBe('');
        expect(howToBuild(null, 'AVG')).toBe('');
        expect(recipeOf(recipes, 'avg')?.tag).toBe('AVG');
    });
});

describe('rawSourceTags', () => {
    const recipes: SpecialSensorRecipe[] = [
        formula('POWER', '$V * $I'),
        block('AVG_P', 'mean', ['POWER', 'P2']),
        formula('TOP', '${AVG_P} + $V + $T'),
        formula('LOOP_A', '$LOOP_B + 1'),
        formula('LOOP_B', '$LOOP_A + $Z'),
    ];
    it('direct sources of a formula', () => {
        expect(rawSourceTags(recipes, 'POWER')).toEqual(['V', 'I']);
    });
    it('nested special sensors expand to raw tags, unique, first-use order', () => {
        expect(rawSourceTags(recipes, 'AVG_P')).toEqual(['V', 'I', 'P2']);
        expect(rawSourceTags(recipes, 'TOP')).toEqual(['V', 'I', 'P2', 'T']);
    });
    it('a raw tag has no sources; a cycle never loops', () => {
        expect(rawSourceTags(recipes, 'V')).toEqual([]);
        expect(rawSourceTags(recipes, 'LOOP_A')).toEqual(['Z']);
    });
});
