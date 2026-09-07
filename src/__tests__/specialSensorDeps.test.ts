import { describe, it, expect } from 'vitest';
import type { FailureModel, SpecialSensorRecipe } from '../types';
import { buildSpecialSensorUsage, usageFor } from '../utils/specialSensorDeps';

function makeModel(overrides: Partial<FailureModel> = {}): FailureModel {
    return {
        id: 'm1', groupNos: [1], name: 'Model 1', kind: 'individual', category: null,
        notes: '', status: false,
        targetSensor: '', predictorSensors: [], xSensor: '', ySensor: '',
        individualChecked: true, rcMode: null, scatterXSensor: '', relModelName: '',
        relStiffness: 100_000, clusterModelName: '', numClusters: 3, criteriaSensor: '',
        clusterRanges: [], filterTimeStart: '', filterTimeEnd: '', pmSensorFilters: [],
        ...overrides,
    };
}

const formula = (tag: string, expression: string): SpecialSensorRecipe =>
    ({ kind: 'formula', tag, formula: expression });

const operation = (tag: string, sourceSensors: string[]): SpecialSensorRecipe =>
    ({ kind: 'operation', tag, sourceSensors, operationConfig: { mode: 'multi', multiOp: { type: 'sum' }, customName: tag } });

function build(args: {
    recipes: SpecialSensorRecipe[];
    formulaRefs?: Record<string, string[]>;
    models?: FailureModel[];
    selectedSensors?: string[];
}) {
    return buildSpecialSensorUsage({
        recipes: args.recipes,
        formulaRefs: new Map(Object.entries(args.formulaRefs ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
        models: args.models ?? [],
        selectedSensors: args.selectedSensors ?? [],
    });
}

describe('buildSpecialSensorUsage', () => {
    it('reports an unused special sensor as deletable', () => {
        const usage = build({ recipes: [formula('special A', '$RAW.PV * 2')], formulaRefs: { 'special A': ['RAW.PV'] } });
        const a = usageFor(usage, 'special A')!;
        expect(a.deletable).toBe(true);
        expect(a.dependentSensors).toEqual([]);
        expect(a.modelReferences).toEqual([]);
        expect(a.onChart).toBe(false);
    });

    it('blocks the source of another special sensor but not the one built on top', () => {
        const usage = build({
            recipes: [formula('special A', '$RAW.PV * 2'), formula('special B', '${special A} + 10')],
            formulaRefs: { 'special A': ['RAW.PV'], 'special B': ['special A'] },
        });
        const a = usageFor(usage, 'special A')!;
        expect(a.deletable).toBe(false);
        expect(a.dependentSensors).toEqual(['special B']);
        // B is the leaf of the chain -- nothing was built on it, so it goes.
        expect(usageFor(usage, 'special B')!.deletable).toBe(true);
    });

    it('sees an operation recipe sourceSensors entry as a dependency too', () => {
        const usage = build({
            recipes: [formula('special A', '$RAW.PV'), operation('total', ['special A', 'RAW2.PV'])],
            formulaRefs: { 'special A': ['RAW.PV'] },
        });
        expect(usageFor(usage, 'special A')!.dependentSensors).toEqual(['total']);
    });

    it('does not treat a name that is a prefix of another name as a dependency', () => {
        // The whole reason formula refs are parsed in Rust instead of matched
        // with formula.includes(tag): `test` is a substring of `test extend`.
        const usage = build({
            recipes: [
                formula('test', '$RAW.PV'),
                formula('test extend', '$RAW2.PV'),
                formula('downstream', '${test extend} + 1'),
            ],
            formulaRefs: { test: ['RAW.PV'], 'test extend': ['RAW2.PV'], downstream: ['test extend'] },
        });
        expect(usageFor(usage, 'test')!.deletable).toBe(true);
        expect(usageFor(usage, 'test extend')!.dependentSensors).toEqual(['downstream']);
    });

    it('ignores references to raw CSV columns that are not special sensors', () => {
        const usage = build({
            recipes: [formula('special A', '$RAW.PV + $OTHER.PV')],
            formulaRefs: { 'special A': ['RAW.PV', 'OTHER.PV'] },
        });
        expect(usage.size).toBe(1);
        expect(usageFor(usage, 'special A')!.deletable).toBe(true);
    });

    it('blocks a sensor named in any of the seven model sensor fields', () => {
        const fields: Array<[string, Partial<FailureModel>, string]> = [
            ['targetSensor', { targetSensor: 'S' }, 'target sensor'],
            ['predictorSensors', { predictorSensors: ['S'] }, 'predictor'],
            ['xSensor', { xSensor: 'S' }, 'X sensor'],
            ['ySensor', { ySensor: 'S' }, 'Y sensor'],
            ['criteriaSensor', { criteriaSensor: 'S' }, 'criteria sensor'],
            ['scatterXSensor', { scatterXSensor: 'S' }, 'scatter X sensor'],
            ['pmSensorFilters', { pmSensorFilters: [{ id: 'f1', sensor: 'S', operation: 'greater_than', value1: '0', value2: '' }] }, 'PM filter'],
        ];
        for (const [name, patch, label] of fields) {
            const usage = build({ recipes: [formula('S', '$RAW.PV')], models: [makeModel(patch)] });
            const s = usageFor(usage, 'S')!;
            expect(s.deletable, `${name} should block deletion`).toBe(false);
            expect(s.modelReferences).toEqual([{ modelId: 'm1', modelName: 'Model 1', field: label }]);
        }
    });

    it('lists one model twice when it names the same sensor in two fields', () => {
        const usage = build({
            recipes: [formula('S', '$RAW.PV')],
            models: [makeModel({ targetSensor: 'S', predictorSensors: ['S'] })],
        });
        expect(usageFor(usage, 'S')!.modelReferences.map(r => r.field)).toEqual(['target sensor', 'predictor']);
    });

    it('lists every model that uses the sensor, not just the first', () => {
        const usage = build({
            recipes: [formula('S', '$RAW.PV')],
            models: [
                makeModel({ id: 'm1', name: 'Boiler efficiency', targetSensor: 'S' }),
                makeModel({ id: 'm2', name: 'Feedwater relation', predictorSensors: ['S'] }),
            ],
        });
        expect(usageFor(usage, 'S')!.modelReferences).toEqual([
            { modelId: 'm1', modelName: 'Boiler efficiency', field: 'target sensor' },
            { modelId: 'm2', modelName: 'Feedwater relation', field: 'predictor' },
        ]);
    });

    it('being plotted on the chart is recorded but never blocks a delete', () => {
        const usage = build({ recipes: [formula('S', '$RAW.PV')], selectedSensors: ['RAW.PV', 'S'] });
        const s = usageFor(usage, 'S')!;
        expect(s.onChart).toBe(true);
        expect(s.deletable).toBe(true);
    });

    it('matches tags case-insensitively across recipes, models and the chart', () => {
        const usage = build({
            recipes: [formula('Special A', '$RAW.PV'), formula('B', '${special a} + 1')],
            formulaRefs: { B: ['special a'] },
            models: [makeModel({ targetSensor: 'SPECIAL A' })],
            selectedSensors: ['special a'],
        });
        const a = usageFor(usage, 'special A')!;
        expect(a.tag).toBe('Special A');
        expect(a.dependentSensors).toEqual(['B']);
        expect(a.modelReferences).toHaveLength(1);
        expect(a.onChart).toBe(true);
    });

    it('does not let a self-referencing formula block its own deletion', () => {
        const usage = build({ recipes: [formula('S', '$S + 1')], formulaRefs: { S: ['S'] } });
        expect(usageFor(usage, 'S')!.deletable).toBe(true);
    });

    it('treats a formula with no entry in formulaRefs as referencing nothing', () => {
        // Under-reporting, not inventing: callers must wait for the lookup.
        const usage = build({ recipes: [formula('A', '$RAW.PV'), formula('B', '${A} + 1')] });
        expect(usageFor(usage, 'A')!.deletable).toBe(true);
    });
});
