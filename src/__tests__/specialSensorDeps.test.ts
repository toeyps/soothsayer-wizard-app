import { describe, it, expect } from 'vitest';
import type { FailureModel, SpecialSensorRecipe } from '../types';
import {
    buildSpecialSensorUsage,
    usageFor,
    dependentsToRecompute,
    cycleConflicts,
    orderRecipesByDependency,
    reorderRecipesByTags,
} from '../utils/specialSensorDeps';

function makeModel(overrides: Partial<FailureModel> = {}): FailureModel {
    return {
        id: 'm1', groupNos: [1], name: 'Model 1', kind: 'individual', category: null,
        notes: '', status: false,
        targetSensor: '', predictorSensors: [], xSensor: '', ySensor: '',
        individualChecked: true, rcMode: null, scatterXSensor: '', relModelName: '',
        relStiffness: 100_000, clusterModelName: '', numClusters: 3, criteriaSensor: '',
        clusterRanges: [], filterTimePeriods: [],
        runningConditionMode: 'workspace', customRunningConditionFilters: [], customRunningConditionCombine: 'and',
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

    it('blocks a sensor named in any of the six model sensor fields', () => {
        // 2026-09-15: was seven, including `pmSensorFilters` -- that field
        // moved off FailureModel to the workspace-wide
        // `runningConditionFilters`, which this delete-check does NOT yet
        // cover (a known, scoped gap -- see specialSensorDeps.ts's own
        // comment on MODEL_SENSOR_FIELDS).
        const fields: Array<[string, Partial<FailureModel>, string]> = [
            ['targetSensor', { targetSensor: 'S' }, 'target sensor'],
            ['predictorSensors', { predictorSensors: ['S'] }, 'predictor'],
            ['xSensor', { xSensor: 'S' }, 'X sensor'],
            ['ySensor', { ySensor: 'S' }, 'Y sensor'],
            ['criteriaSensor', { criteriaSensor: 'S' }, 'criteria sensor'],
            ['scatterXSensor', { scatterXSensor: 'S' }, 'scatter X sensor'],
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

describe('dependentsToRecompute', () => {
    // A -> B -> C, plus an unrelated D. Array order is creation order, which
    // is what makes the returned list safe to run straight through.
    const chain = [
        formula('A', '$RAW.PV'),
        formula('B', '${A} + 1'),
        formula('C', '${B} * 2'),
        formula('D', '$RAW2.PV'),
    ];
    const refs = { A: ['RAW.PV'], B: ['A'], C: ['B'], D: ['RAW2.PV'] };
    const usageOf = () => build({ recipes: chain, formulaRefs: refs });

    it('follows the chain past the direct dependents', () => {
        expect(dependentsToRecompute(chain, usageOf(), 'A').map(r => r.tag)).toEqual(['B', 'C']);
    });

    it('returns them in recipe order, so each one runs after what it reads', () => {
        const reversed = [chain[3], chain[2], chain[1], chain[0]];
        // Order comes from the array it is given, not from discovery order.
        expect(dependentsToRecompute(reversed, usageOf(), 'A').map(r => r.tag)).toEqual(['C', 'B']);
    });

    it('leaves out the edited sensor itself and anything unrelated to it', () => {
        const tags = dependentsToRecompute(chain, usageOf(), 'B').map(r => r.tag);
        expect(tags).toEqual(['C']);
        expect(tags).not.toContain('D');
    });

    it('is empty for a sensor nothing was built on', () => {
        expect(dependentsToRecompute(chain, usageOf(), 'D')).toEqual([]);
    });

    it('terminates on a cycle instead of looping forever', () => {
        // Not a state the app can reach through the UI (cycleConflicts
        // refuses it), but a corrupted workspace file could carry one.
        const cyclic = [formula('X', '${Y} + 1'), formula('Y', '${X} + 1')];
        const usage = build({ recipes: cyclic, formulaRefs: { X: ['Y'], Y: ['X'] } });
        expect(dependentsToRecompute(cyclic, usage, 'X').map(r => r.tag).sort()).toEqual(['X', 'Y']);
    });
});

describe('cycleConflicts', () => {
    const chain = [formula('A', '$RAW.PV'), formula('B', '${A} + 1'), formula('C', '${B} * 2')];
    const usage = () => build({ recipes: chain, formulaRefs: { A: ['RAW.PV'], B: ['A'], C: ['B'] } });

    it('allows an edit that only reads raw columns', () => {
        expect(cycleConflicts(chain, usage(), 'A', ['RAW.PV', 'OTHER.PV'])).toEqual([]);
    });

    it('refuses a sensor reading itself', () => {
        expect(cycleConflicts(chain, usage(), 'A', ['A'])).toEqual(['A']);
    });

    it('refuses a sensor reading something built on top of it, directly or further down', () => {
        expect(cycleConflicts(chain, usage(), 'A', ['B'])).toEqual(['B']);
        // C is two steps downstream — still a loop.
        expect(cycleConflicts(chain, usage(), 'A', ['C'])).toEqual(['C']);
    });

    it('still allows reading an UPSTREAM sensor', () => {
        // C already reads B; making it read A as well is not a cycle.
        expect(cycleConflicts(chain, usage(), 'C', ['A', 'B'])).toEqual([]);
    });

    it('names each offending input once, in the order given', () => {
        expect(cycleConflicts(chain, usage(), 'A', ['RAW.PV', 'C', 'B', 'c'])).toEqual(['C', 'B']);
    });
});

describe('orderRecipesByDependency', () => {
    const A = formula('A', '$RAW * 2');
    const B = formula('B', '${A} + 1');
    const C = formula('C', '${B} * 3');
    const inputsOf = (r: SpecialSensorRecipe): string[] => {
        if (r.kind === 'operation') return r.sourceSensors;
        return ({ A: ['RAW'], B: ['A'], C: ['B'], D: ['c', 'RAW'], E: ['E'] } as Record<string, string[]>)[r.tag] ?? [];
    };
    const tags = (list: SpecialSensorRecipe[]) => list.map(r => r.tag);

    it('leaves an already-valid order exactly as it is', () => {
        expect(tags(orderRecipesByDependency([A, B, C], inputsOf))).toEqual(['A', 'B', 'C']);
    });

    it('moves a recipe after a later recipe it reads (the edit-A-to-read-C case that broke the workspace-reopen replay)', () => {
        // A was edited to read C; C itself reads raw only.
        const editedA = formula('A', '$C * 2');
        const c = formula('C', '$RAW + 1');
        const inputs = (r: SpecialSensorRecipe) => (r.tag === 'A' ? ['C'] : r.tag === 'C' ? ['RAW'] : []);
        expect(tags(orderRecipesByDependency([editedA, c], inputs))).toEqual(['C', 'A']);
    });

    it('is stable: unrelated recipes keep their relative order', () => {
        const x = formula('X', '$RAW');
        const y = formula('Y', '$RAW');
        const dependsOnLast = formula('D', '${C} + $RAW');
        expect(tags(orderRecipesByDependency([dependsOnLast, x, C, y, B, A], inputsOf)))
            // D waits for C (and C for B, B for A); X and Y never move relative to each other.
            .toEqual(['X', 'Y', 'A', 'B', 'C', 'D']);
    });

    it('matches tags case-insensitively (D reads "c")', () => {
        const D = formula('D', '$c');
        expect(tags(orderRecipesByDependency([D, A, B, C], inputsOf))).toEqual(['A', 'B', 'C', 'D']);
    });

    it('treats operation recipes through their sourceSensors', () => {
        const op = operation('OP', ['A', 'RAW']);
        expect(tags(orderRecipesByDependency([op, A], inputsOf))).toEqual(['A', 'OP']);
    });

    it('ignores a recipe reading itself and inputs that are raw columns', () => {
        const E = formula('E', '$E');
        expect(tags(orderRecipesByDependency([E, A], inputsOf))).toEqual(['E', 'A']);
    });

    it('a cycle keeps the original relative order of what is left instead of dropping recipes', () => {
        const p = formula('P', '$Q');
        const q = formula('Q', '$P');
        const inputs = (r: SpecialSensorRecipe) => (r.tag === 'P' ? ['Q'] : ['P']);
        expect(tags(orderRecipesByDependency([p, q], inputs))).toEqual(['P', 'Q']);
    });

    it('does not mutate its input', () => {
        const list = [B, A];
        orderRecipesByDependency(list, inputsOf);
        expect(tags(list)).toEqual(['B', 'A']);
    });
});

describe('reorderRecipesByTags', () => {
    const A = formula('A', '$RAW');
    const B = formula('B', '$RAW');
    const C = formula('C', '$RAW');

    it('follows the given order', () => {
        expect(reorderRecipesByTags([A, B, C], ['C', 'A', 'B']).map(r => r.tag)).toEqual(['C', 'A', 'B']);
    });

    it('is a no-op (same array) when no order is given', () => {
        const list = [A, B];
        expect(reorderRecipesByTags(list, undefined)).toBe(list);
        expect(reorderRecipesByTags(list, [])).toBe(list);
    });

    it('keeps recipes missing from the order after the listed ones, in their own order, and ignores unknown tags', () => {
        expect(reorderRecipesByTags([A, B, C], ['ghost', 'c']).map(r => r.tag)).toEqual(['C', 'A', 'B']);
    });
});

// ── 2026-10-03 (second pass): running condition + build-order recompute ─────

describe('buildSpecialSensorUsage -- the Running condition', () => {
    const cond = (sensor: string) => ({ id: `c-${sensor}`, sensor, operation: 'greater_than' as const, value1: '3', value2: '' });

    it('a special sensor named by the workspace Running condition is in use: not deletable, flagged runningCondition', () => {
        const usage = buildSpecialSensorUsage({
            recipes: [formula('A', '$RAW'), formula('B', '$RAW')],
            formulaRefs: new Map(),
            models: [],
            runningConditionFilters: [cond('a')], // case-insensitive, like every other tag match
            selectedSensors: [],
        });
        expect(usageFor(usage, 'A')).toMatchObject({ runningCondition: true, deletable: false, dependentSensors: [], modelReferences: [] });
        expect(usageFor(usage, 'B')).toMatchObject({ runningCondition: false, deletable: true });
    });

    it('a raw sensor in the Running condition does not matter (only special sensors are tracked)', () => {
        const usage = buildSpecialSensorUsage({
            recipes: [formula('A', '$RAW')], formulaRefs: new Map(), models: [],
            runningConditionFilters: [cond('TAG1')], selectedSensors: [],
        });
        expect(usageFor(usage, 'A')!.deletable).toBe(true);
    });

    it('omitted / empty Running condition changes nothing', () => {
        const base = { recipes: [formula('A', '$RAW')], formulaRefs: new Map<string, string[]>(), models: [] as FailureModel[], selectedSensors: [] as string[] };
        expect(usageFor(buildSpecialSensorUsage(base), 'A')).toMatchObject({ runningCondition: false, deletable: true });
        expect(usageFor(buildSpecialSensorUsage({ ...base, runningConditionFilters: [] }), 'A')!.deletable).toBe(true);
    });

    it('a model\'s OWN custom running-condition conditions block the delete too, listed as a model reference with that field (even while the model is in workspace mode: the list comes back when it switches to Custom)', () => {
        const model = makeModel({
            id: 'm9', name: 'Pump health', runningConditionMode: 'workspace',
            customRunningConditionFilters: [cond('A')],
        });
        const usage = build({ recipes: [formula('A', '$RAW')], models: [model] });
        const info = usageFor(usage, 'A')!;
        expect(info.deletable).toBe(false);
        expect(info.modelReferences).toEqual([{ modelId: 'm9', modelName: 'Pump health', field: 'custom running condition' }]);
    });
});

describe('dependentsToRecompute -- build order', () => {
    const A = formula('A', '$RAW');
    const B = formula('B', '${A} + 1');
    const C = formula('C', '$B * 10');
    const refs: Record<string, string[]> = { a: ['RAW'], b: ['A'], c: ['B'] };
    const inputsOf = (r: SpecialSensorRecipe) => refs[r.tag.toLowerCase()] ?? [];

    it('without inputsOf: stored array order (the legacy behaviour)', () => {
        const stored = [C, B, A];
        const usage = build({ recipes: stored, formulaRefs: { A: ['RAW'], B: ['A'], C: ['B'] } });
        expect(dependentsToRecompute(stored, usage, 'A').map(r => r.tag)).toEqual(['C', 'B']);
    });

    it('with inputsOf: a stored order that is NOT a build order is put right, so a dependent is never recomputed before what it reads', () => {
        const stored = [C, B, A];
        const usage = build({ recipes: stored, formulaRefs: { A: ['RAW'], B: ['A'], C: ['B'] } });
        expect(dependentsToRecompute(stored, usage, 'A', inputsOf).map(r => r.tag)).toEqual(['B', 'C']);
    });

    it('with inputsOf and an order that is already right: unchanged', () => {
        const stored = [A, B, C];
        const usage = build({ recipes: stored, formulaRefs: { A: ['RAW'], B: ['A'], C: ['B'] } });
        expect(dependentsToRecompute(stored, usage, 'A', inputsOf).map(r => r.tag)).toEqual(['B', 'C']);
    });
});
