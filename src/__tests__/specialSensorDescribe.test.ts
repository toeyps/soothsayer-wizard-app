import { describe, it, expect } from 'vitest';
import { describeRecipe, describeSpecialSensor } from '../utils/specialSensorDescribe';
import type { SpecialSensorRecipe } from '../types';

const single = (type: string, value: number): SpecialSensorRecipe => ({
    kind: 'operation', tag: 'R', sourceSensors: ['TAG1'],
    operationConfig: { mode: 'single', singleOp: { type: type as never, value }, customName: 'R' },
});

describe('describeRecipe', () => {
    it('shows a formula as typed', () => {
        expect(describeRecipe({ kind: 'formula', tag: 'F', formula: '$A + 1' })).toBe('$A + 1');
    });

    it('spells out multi operations and number operations', () => {
        expect(describeRecipe({
            kind: 'operation', tag: 'M', sourceSensors: ['A', 'B'],
            operationConfig: { mode: 'multi', multiOp: { type: 'mean' }, customName: 'M' },
        })).toBe('mean(A, B)');
        expect(describeRecipe(single('add', 10))).toBe('TAG1 + 10');
        expect(describeRecipe(single('sqrt', 0))).toBe('sqrt(TAG1)');
    });

    // 2026-10-08: the decimal count used to be dropped (`round(TAG1)` for every N).
    it('"Round to decimals" includes how many decimals it keeps', () => {
        expect(describeRecipe(single('round', 0))).toBe('round(TAG1) to 0 decimals');
        expect(describeRecipe(single('round', 1))).toBe('round(TAG1) to 1 decimal');
        expect(describeRecipe(single('round', 3))).toBe('round(TAG1) to 3 decimals');
    });
});

// Customer batch 2026-10, item 6: a rounded block keeps its own decimals, and
// the Manage list / Inline labels read a human description.
describe('describeRecipe: a rounded block', () => {
    it('says how many decimals it keeps (unrounded blocks read as before)', () => {
        expect(describeRecipe({
            kind: 'operation', tag: 'M', sourceSensors: ['A', 'B'],
            operationConfig: { mode: 'multi', multiOp: { type: 'mean', decimals: 2 }, customName: 'M' },
        })).toBe('mean(A, B) to 2 decimals');
        expect(describeRecipe({
            kind: 'operation', tag: 'M', sourceSensors: ['A', 'B'],
            operationConfig: { mode: 'multi', multiOp: { type: 'median', decimals: 1 } },
        })).toBe('median(A, B) to 1 decimal');
    });
});

describe('describeSpecialSensor', () => {
    const label = (t: string) => ({ A: 'Bearing temp', B: 'Oil temp' } as Record<string, string>)[t] ?? t;

    it('a formula: its text without the round wrap, then the rounding; sources in order', () => {
        expect(describeSpecialSensor({ kind: 'formula', tag: 'F', formula: 'round(($A - ${B c}) * 100) / 100' })).toEqual({
            kind: 'formula', kindLabel: 'Formula', summary: '$A - ${B c} · rounded to 2 decimals',
            expression: 'round(($A - ${B c}) * 100) / 100', sources: ['A', 'B c'], decimals: 2,
        });
        expect(describeSpecialSensor({ kind: 'formula', tag: 'F', formula: 'abs($A)' }).summary).toBe('abs($A)');
    });

    it('Average / Median blocks and a legacy Sum read through the label', () => {
        expect(describeSpecialSensor({
            kind: 'operation', tag: 'M', sourceSensors: ['A', 'B'],
            operationConfig: { mode: 'multi', multiOp: { type: 'mean', decimals: 1 } },
        }, { label })).toMatchObject({
            kind: 'average', kindLabel: 'Average block', decimals: 1, sources: ['A', 'B'],
            summary: 'Average of Bearing temp, Oil temp · missing values skipped · rounded to 1 decimal',
        });
        expect(describeSpecialSensor({
            kind: 'operation', tag: 'M', sourceSensors: ['A', 'B'], operationConfig: { mode: 'multi', multiOp: { type: 'median' } },
        }).summary).toBe('Median of A, B · missing values skipped');
        expect(describeSpecialSensor({
            kind: 'operation', tag: 'S', sourceSensors: ['A', 'B'], operationConfig: { mode: 'multi', multiOp: { type: 'sum' } },
        }, { label })).toMatchObject({ kind: 'sum', kindLabel: 'Sum', summary: 'Sum of Bearing temp, Oil temp' });
    });

    it('a one-sensor operation', () => {
        expect(describeSpecialSensor(single('subtract', 5)).summary).toBe('TAG1 − 5');
        expect(describeSpecialSensor(single('round', 2))).toMatchObject({ kind: 'operation', summary: 'TAG1 rounded to 2 decimals', decimals: 2 });
        expect(describeSpecialSensor(single('sqrt', 0)).summary).toBe('sqrt(TAG1)');
    });
});
