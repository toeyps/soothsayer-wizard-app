import { describe, it, expect } from 'vitest';
import { describeRecipe } from '../utils/specialSensorDescribe';
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
