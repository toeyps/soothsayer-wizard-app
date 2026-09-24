import { describe, it, expect, vi } from 'vitest';
import type { FailureModel, SpecialSensorRecipe, WorkspaceSensorFilter } from '../types';
import {
    renameTagInArray,
    renameTagInRecord,
    renameTagInModels,
    renameTagInRunningConditionFilters,
    renameTagInRecipes,
} from '../utils/specialSensorRename';

function makeModel(overrides: Partial<FailureModel> = {}): FailureModel {
    return {
        id: 'm1',
        groupNos: [0],
        name: 'Test model',
        kind: 'individual',
        category: null,
        notes: '',
        status: false,
        targetSensor: '',
        predictorSensors: [],
        individualChecked: true,
        rcMode: null,
        xSensor: '',
        ySensor: '',
        scatterXSensor: '',
        relModelName: '',
        relStiffness: 100_000,
        clusterModelName: '',
        numClusters: 3,
        criteriaSensor: '',
        clusterRanges: [],
        filterTimePeriods: [],
        runningConditionMode: 'workspace',
        customRunningConditionFilters: [],
        customRunningConditionCombine: 'and',
        ...overrides,
    };
}

describe('renameTagInArray', () => {
    it('renames a matching entry, case-insensitively', () => {
        expect(renameTagInArray(['A', 'B', 'C'], 'b', 'RENAMED')).toEqual(['A', 'RENAMED', 'C']);
    });

    it('returns the SAME array reference when the tag is not present', () => {
        const arr = ['A', 'B'];
        expect(renameTagInArray(arr, 'Z', 'RENAMED')).toBe(arr);
    });

    it('renames every matching occurrence', () => {
        expect(renameTagInArray(['A', 'A', 'B'], 'A', 'X')).toEqual(['X', 'X', 'B']);
    });
});

describe('renameTagInRecord', () => {
    it('moves the value from the old key to the new one', () => {
        expect(renameTagInRecord({ A: 1, B: 2 }, 'A', 'RENAMED')).toEqual({ RENAMED: 1, B: 2 });
    });

    it('matches the key case-insensitively', () => {
        expect(renameTagInRecord({ SensorA: '#fff' }, 'sensora', 'NewName')).toEqual({ NewName: '#fff' });
    });

    it('returns the SAME record reference when the key is absent', () => {
        const rec = { A: 1 };
        expect(renameTagInRecord(rec, 'Z', 'RENAMED')).toBe(rec);
    });
});

describe('renameTagInModels', () => {
    it('renames every one of the six sensor-bearing fields', () => {
        // 2026-09-15: was seven, including `pmSensorFilters` -- that field
        // moved off FailureModel entirely to the workspace-wide
        // `runningConditionFilters` (see the describe block below for its
        // own rename helper).
        const model = makeModel({
            targetSensor: 'OLD',
            predictorSensors: ['OLD', 'OTHER'],
            xSensor: 'OLD',
            ySensor: 'OLD',
            criteriaSensor: 'OLD',
            scatterXSensor: 'OLD',
        });
        const [renamed] = renameTagInModels([model], 'OLD', 'NEW');
        expect(renamed.targetSensor).toBe('NEW');
        expect(renamed.predictorSensors).toEqual(['NEW', 'OTHER']);
        expect(renamed.xSensor).toBe('NEW');
        expect(renamed.ySensor).toBe('NEW');
        expect(renamed.criteriaSensor).toBe('NEW');
        expect(renamed.scatterXSensor).toBe('NEW');
    });

    it('leaves a model that never names the sensor untouched', () => {
        const model = makeModel({ targetSensor: 'UNRELATED' });
        const [renamed] = renameTagInModels([model], 'OLD', 'NEW');
        expect(renamed.targetSensor).toBe('UNRELATED');
    });

    it('never renames an empty field', () => {
        // A blank clustering Y sensor, say -- swapping '' -> newTag would
        // wrongly "fill in" a field the user never set.
        const model = makeModel({ targetSensor: 'OLD', ySensor: '' });
        const [renamed] = renameTagInModels([model], 'OLD', 'NEW');
        expect(renamed.ySensor).toBe('');
    });

    it('matches case-insensitively', () => {
        const model = makeModel({ targetSensor: 'old' });
        const [renamed] = renameTagInModels([model], 'OLD', 'NEW');
        expect(renamed.targetSensor).toBe('NEW');
    });
});

describe('renameTagInRunningConditionFilters', () => {
    const filters: WorkspaceSensorFilter[] = [
        { id: 'f1', sensor: 'OLD', operation: 'greater_than', value1: '1', value2: '' },
        { id: 'f2', sensor: 'OTHER', operation: 'less_than', value1: '2', value2: '' },
    ];

    it('renames a matching condition\'s sensor, case-insensitively', () => {
        const renamed = renameTagInRunningConditionFilters(filters, 'old', 'NEW');
        expect(renamed.map(f => f.sensor)).toEqual(['NEW', 'OTHER']);
    });

    it('returns the SAME array reference when no condition names the tag', () => {
        expect(renameTagInRunningConditionFilters(filters, 'UNRELATED', 'NEW')).toBe(filters);
    });
});

describe('renameTagInRecipes', () => {
    it('rewrites a formula-kind recipe via the Rust rename_formula_refs command', async () => {
        const recipe: SpecialSensorRecipe = { kind: 'formula', tag: 'CALC1', formula: '$OLD + 1' };
        const invoker = vi.fn(async () => '$NEW + 1');
        const [renamed] = await renameTagInRecipes([recipe], 'OLD', 'NEW', invoker);
        expect(invoker).toHaveBeenCalledWith('rename_formula_refs', {
            formula: '$OLD + 1',
            oldName: 'OLD',
            newName: 'NEW',
        });
        expect(renamed).toEqual({ kind: 'formula', tag: 'CALC1', formula: '$NEW + 1' });
    });

    it('returns the SAME recipe reference when the rewrite is a no-op', async () => {
        const recipe: SpecialSensorRecipe = { kind: 'formula', tag: 'CALC1', formula: '$UNRELATED + 1' };
        const invoker = vi.fn(async (_cmd: string, args: Record<string, unknown>) => args.formula as string);
        const [result] = await renameTagInRecipes([recipe], 'OLD', 'NEW', invoker);
        expect(result).toBe(recipe);
    });

    it('swaps a matching entry in an operation-kind recipe\'s sourceSensors', async () => {
        const recipe: SpecialSensorRecipe = {
            kind: 'operation',
            tag: 'CALC2',
            sourceSensors: ['OLD', 'OTHER'],
            operationConfig: { mode: 'multi', multiOp: { type: 'sum' }, customName: 'CALC2' },
        };
        const invoker = vi.fn();
        const [renamed] = await renameTagInRecipes([recipe], 'OLD', 'NEW', invoker);
        expect(renamed.kind === 'operation' && renamed.sourceSensors).toEqual(['NEW', 'OTHER']);
        expect(invoker).not.toHaveBeenCalled();
    });

    it('returns the SAME operation recipe reference when sourceSensors does not name the tag', async () => {
        const recipe: SpecialSensorRecipe = {
            kind: 'operation',
            tag: 'CALC2',
            sourceSensors: ['OTHER'],
            operationConfig: { mode: 'single', singleOp: { type: 'add', value: 1 }, customName: 'CALC2' },
        };
        const invoker = vi.fn();
        const [result] = await renameTagInRecipes([recipe], 'OLD', 'NEW', invoker);
        expect(result).toBe(recipe);
    });

    it('processes every recipe in the list independently', async () => {
        const a: SpecialSensorRecipe = { kind: 'formula', tag: 'A', formula: '$OLD * 2' };
        const b: SpecialSensorRecipe = {
            kind: 'operation',
            tag: 'B',
            sourceSensors: ['OLD'],
            operationConfig: { mode: 'single', singleOp: { type: 'add', value: 1 }, customName: 'B' },
        };
        const invoker = vi.fn(async () => '$NEW * 2');
        const [renamedA, renamedB] = await renameTagInRecipes([a, b], 'OLD', 'NEW', invoker);
        expect(renamedA).toEqual({ kind: 'formula', tag: 'A', formula: '$NEW * 2' });
        expect(renamedB.kind === 'operation' && renamedB.sourceSensors).toEqual(['NEW']);
    });
});
