import { describe, it, expect } from 'vitest';
import { mk } from './helpers/failureModelFixture';
import type { FailureGroupStateSlice, FailureModel, TestPeriod, WorkspaceState } from '../types';
import {
    applyIncompleteRule, applyRecipeRule, changedScoringPeriodIds, changedTrainInputIds, modelsWithChangedInputs, modelsWithChangedTests, recipesDiffer,
} from '../utils/incompleteRule';
import { isModelComplete, isModelStale, modelDotState, modelSetPointFlag, NOT_TRAINED_BLOCK_REASON } from '../utils/modelStatus';
import { computeTrainFingerprint } from '../utils/trainFingerprint';
import { toScoringPeriod, toScoringPeriods } from '../utils/timePeriods';
import { markCompleteBlockReason } from '../utils/runningCondition';
import { testsChangedNotice, testsChangedState } from '../utils/trainTestValidation';
import { LEGACY_TESTS } from './helpers/trainTestFixture';

const slice = (models: FailureModel[], over: Partial<FailureGroupStateSlice> = {}): FailureGroupStateSlice => ({
    groups: [], models,
    runningConditionFilters: [], runningConditionCombine: 'and',
    // A train period is required to train since the Train/Test change (2026-10-07).
    runningConditionTimePeriods: [{ id: 'w-train', start: '2025-01-01T00:00', end: '2025-12-31T23:59' }], runningConditionNoneConfirmed: true,
    rcLegacyNotice: null,
    ...over,
});
const ws = (fg: FailureGroupStateSlice): WorkspaceState => ({ id: 'ws1', name: 'W', failureGroupState: fg } as unknown as WorkspaceState);

const cond = (v: string, id = 'f1') => ({ id, sensor: 'SPEED', operation: 'greater_than' as const, value1: v, value2: '' });
const period = (start: string, end: string, id = 'p1') => ({ id, start, end });

/** One Complete model of each kind, every field the rule watches filled in. */
const individual = () => mk({ id: 'i', kind: 'individual', targetSensor: 'T', status: true, category: 'condition' });
const relationship = () => mk({ id: 'r', kind: 'relationship', targetSensor: 'T', predictorSensors: ['P1'], relStiffness: 100_000, status: true, category: 'condition' });
const clustering = () => mk({
    id: 'c', kind: 'clustering', xSensor: 'X', ySensor: 'Y', criteriaSensor: 'C', numClusters: 2, status: true, category: 'condition',
    clusterRanges: [{ min: 0, max: 5 }, { min: 5, max: 10 }],
});

/** Edit one model in an otherwise identical workspace, return it after the rule. */
function editModel(model: FailureModel, patch: Partial<FailureModel>, fgOver: Partial<FailureGroupStateSlice> = {}): FailureModel {
    const prev = ws(slice([model], fgOver));
    const next = ws(slice([{ ...model, ...patch }], fgOver));
    return applyIncompleteRule(prev, next).failureGroupState!.models[0];
}

describe('applyIncompleteRule - a Complete model goes back to Incomplete the moment ANY training input changes', () => {
    const table: Array<[string, () => FailureModel, Partial<FailureModel>]> = [
        ['Individual: target sensor', individual, { targetSensor: 'T2' }],
        ['Relationship: predictor added', relationship, { predictorSensors: ['P1', 'P2'] }],
        ['Relationship: predictor replaced', relationship, { predictorSensors: ['P2'] }],
        ['Relationship: target sensor', relationship, { targetSensor: 'T2' }],
        ['Relationship: stiffness', relationship, { relStiffness: 1_000_000 }],
        ['Clustering: Y sensor', clustering, { ySensor: 'Y2' }],
        ['Clustering: X sensor', clustering, { xSensor: 'X2' }],
        ['Clustering: criteria sensor', clustering, { criteriaSensor: 'C2' }],
        ['Clustering: number of clusters', clustering, { numClusters: 3, clusterRanges: [{ min: 0, max: 3 }, { min: 3, max: 6 }, { min: 6, max: 10 }] }],
        ['Clustering: criteria range', clustering, { clusterRanges: [{ min: 0, max: 6 }, { min: 6, max: 10 }] }],
        ['training period added (custom mode)', individual, { runningConditionMode: 'custom', filterTimePeriods: [period('2026-01-01T00:00', '2026-02-01T00:00')] }],
        ['switch Workspace -> Custom', individual, { runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true }],
    ];
    for (const [label, make, patch] of table) {
        it(label, () => {
            const model = make();
            // Custom-mode edits start from a model that is already custom, except the switch itself.
            const before = label.startsWith('training period') ? { ...model, runningConditionMode: 'custom' as const } : model;
            const after = editModel(before, patch);
            expect(after.status).toBe(false);
        });
    }

    it('Custom conditions / AND-OR / "no condition" / periods of a Custom-mode model', () => {
        const custom = (): FailureModel => ({
            ...individual(), runningConditionMode: 'custom', customRunningConditionNoneConfirmed: false,
            customRunningConditionFilters: [cond('100')], customRunningConditionCombine: 'and',
            filterTimePeriods: [period('2026-01-01T00:00', '2026-02-01T00:00')],
        });
        expect(editModel(custom(), { customRunningConditionFilters: [cond('200')] }).status).toBe(false);
        expect(editModel(custom(), { customRunningConditionFilters: [cond('100'), cond('5', 'f2')] }).status).toBe(false);
        expect(editModel(custom(), { customRunningConditionCombine: 'or' }).status).toBe(false);
        expect(editModel(custom(), { customRunningConditionNoneConfirmed: true }).status).toBe(false);
        expect(editModel(custom(), { filterTimePeriods: [period('2026-01-01T00:00', '2026-03-01T00:00')] }).status).toBe(false);
        expect(editModel(custom(), { filterTimePeriods: [] }).status).toBe(false);
    });

    it('keeps the set points, lastTrainedAt and trainedFingerprint when it demotes', () => {
        const model: FailureModel = {
            ...relationship(), lastTrainedAt: '2026-10-03T01:00:00Z', trainedFingerprint: 'fp-1',
            healthSetPoints: { kind: 'relationship', residualAt80Lower: -3, residualAt80Upper: 3, residualAt0Lower: -6, residualAt0Upper: 6 },
        };
        const after = editModel(model, { predictorSensors: ['P1', 'P2'] });
        expect(after).toMatchObject({
            status: false, lastTrainedAt: '2026-10-03T01:00:00Z', trainedFingerprint: 'fp-1',
            healthSetPoints: { residualAt80Lower: -3, residualAt0Upper: 6 },
        });
    });

    it('demotes even a Complete model that was never trained (no train record)', () => {
        expect(editModel(individual(), { targetSensor: 'T2' }).status).toBe(false);
    });
});

describe('applyIncompleteRule - what must NOT trigger it', () => {
    const untouched: Array<[string, Partial<FailureModel>]> = [
        ['set points', { healthSetPoints: { kind: 'individual', lower: 1, upper: 9 } }],
        ['the export record of the saved files (health score 3b-2)', { healthExport: { at: '2026-10-04T01:00:00Z', outputDir: 'C:/ws/output', setPoints: { kind: 'individual', lower: 1, upper: 9 } } }],
        ['model name', { name: 'Another name' }],
        ['notes', { notes: 'some notes' }],
        ['category', { category: 'performance' }],
        ['group membership', { groupNos: [1, 2] }],
        ['scatter X sensor (a view choice)', { scatterXSensor: 'P9' }],
        ['train record', { lastTrainedAt: '2026-10-03T02:00:00Z', trainedFingerprint: 'new' }],
        ['relModelName / clusterModelName', { relModelName: 'x', clusterModelName: 'y' }],
    ];
    for (const [label, patch] of untouched) {
        it(label, () => {
            expect(editModel(individual(), patch).status).toBe(true);
        });
    }

    it('reordering the same predictors', () => {
        const two = { ...relationship(), predictorSensors: ['P1', 'P2'] };
        expect(editModel(two, { predictorSensors: ['P2', 'P1'] }).status).toBe(true);
    });

    it('an incomplete condition row (no value yet) is not sent to Rust, so adding one is not a change', () => {
        const withRow = editModel(
            { ...individual(), runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true },
            { customRunningConditionFilters: [cond('')] },
        );
        expect(withRow.status).toBe(true);
    });

    it('materialising the defaults a draft fills in (stiffness / cluster count) is not a change - e.g. saving just a new name', () => {
        const rel = { ...relationship(), relStiffness: undefined as unknown as number };
        expect(editModel(rel, { relStiffness: 100_000, name: 'Renamed' }).status).toBe(true);
        const clu = { ...clustering(), numClusters: undefined as unknown as number };
        expect(editModel(clu, { numClusters: 3 }).status).toBe(true);
    });

    it('the one-time legacy time-range -> period migration is not a user edit', () => {
        const legacy = { ...individual(), runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true,
            filterTimePeriods: undefined, filterTimeStart: '2026-01-01T00:00', filterTimeEnd: '2026-02-01T00:00' } as unknown as FailureModel;
        const migrated = { ...legacy, filterTimePeriods: [period('2026-01-01T00:00', '2026-02-01T00:00', 'legacy-1')] } as FailureModel;
        const out = applyIncompleteRule(ws(slice([legacy])), ws(slice([migrated])));
        expect(out.failureGroupState!.models[0].status).toBe(true);
    });

    it('a model that is not Complete is left exactly as it is, and an untouched write returns the same object', () => {
        const incomplete = { ...individual(), status: false };
        const prev = ws(slice([incomplete]));
        const next = ws(slice([{ ...incomplete, targetSensor: 'T2' }]));
        expect(applyIncompleteRule(prev, next)).toBe(next);
        const same = ws(slice([individual()]));
        expect(applyIncompleteRule(same, same)).toBe(same);
    });

    it('a model added or removed by the write is ignored (nothing to compare)', () => {
        const prev = ws(slice([individual()]));
        const next = ws(slice([{ ...relationship(), id: 'new' }]));
        expect(applyIncompleteRule(prev, next)).toBe(next);
        expect(modelsWithChangedInputs(prev, next)).toEqual([]);
    });
});

describe('applyIncompleteRule - the WORKSPACE running condition Apply', () => {
    const wsModel = (id: string) => ({ ...individual(), id });
    const customModel = (id: string): FailureModel => ({ ...individual(), id, runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true });

    function apply(fgOver: Partial<FailureGroupStateSlice>) {
        const models = [wsModel('ws-a'), wsModel('ws-b'), customModel('custom')];
        const prev = ws(slice(models));
        const next = ws(slice(models, fgOver));
        const out = applyIncompleteRule(prev, next).failureGroupState!.models;
        return Object.fromEntries(out.map(m => [m.id, m.status]));
    }

    it('a new condition demotes every Workspace-mode model and leaves the Custom-mode one', () => {
        expect(apply({ runningConditionNoneConfirmed: false, runningConditionFilters: [cond('1200')] }))
            .toEqual({ 'ws-a': false, 'ws-b': false, custom: true });
    });

    it('AND/OR, "No condition" and workspace periods each do it too', () => {
        expect(apply({ runningConditionCombine: 'or' })).toEqual({ 'ws-a': false, 'ws-b': false, custom: true });
        expect(apply({ runningConditionNoneConfirmed: false })).toEqual({ 'ws-a': false, 'ws-b': false, custom: true });
        expect(apply({ runningConditionTimePeriods: [period('2026-01-01T00:00', '2026-02-01T00:00')] }))
            .toEqual({ 'ws-a': false, 'ws-b': false, custom: true });
    });

    it('re-applying the SAME condition changes nothing', () => {
        expect(apply({})).toEqual({ 'ws-a': true, 'ws-b': true, custom: true });
    });

    it('is idempotent: running the rule again over its own output changes nothing', () => {
        const models = [wsModel('ws-a')];
        const prev = ws(slice(models));
        const once = applyIncompleteRule(prev, ws(slice(models, { runningConditionCombine: 'or' })));
        expect(applyIncompleteRule(prev, once)).toBe(once);
    });
});

// The two comparisons are also exported at SLICE level, so a caller that only PREDICTS a write
// (the Running-condition settings' impact line, `runningConditionImpact`) runs the same rule.
describe('changedTrainInputIds / changedScoringPeriodIds - the comparisons behind the rule, on two slices', () => {
    const wsModel = (id: string) => ({ ...individual(), id });
    const customModel = (id: string): FailureModel => ({
        ...individual(), id, runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true,
        customTestPeriods: [{ id: 'own', start: '2025-03-01T00:00', end: '2025-03-31T23:59' }],
    });
    const models = [wsModel('ws-a'), wsModel('ws-b'), customModel('custom')];
    const SCORE: TestPeriod[] = [{ id: 's', start: '2025-07-01T00:00', end: '2025-07-31T23:59' }];

    it('are exactly what the state-level functions (and so the write) use', () => {
        const before = slice(models, { runningConditionTestPeriods: SCORE });
        const cases: Partial<FailureGroupStateSlice>[] = [
            { runningConditionCombine: 'or' },
            { runningConditionTestPeriods: [] },
            { runningConditionNoneConfirmed: false, runningConditionFilters: [cond('1200')], runningConditionTestPeriods: [{ ...SCORE[0], end: '2025-07-15T23:59' }] },
            {},
        ];
        for (const over of cases) {
            const after = slice(models, { runningConditionTestPeriods: SCORE, ...over });
            expect(changedTrainInputIds(before, after)).toEqual(modelsWithChangedInputs(ws(before), ws(after)));
            expect(changedScoringPeriodIds(before, after)).toEqual(modelsWithChangedTests(ws(before), ws(after)));
        }
    });

    it('a workspace change reaches the Workspace-mode models only', () => {
        const before = slice(models, { runningConditionTestPeriods: SCORE });
        expect(changedTrainInputIds(before, slice(models, { runningConditionTestPeriods: SCORE, runningConditionCombine: 'or' }))).toEqual(['ws-a', 'ws-b']);
        expect(changedScoringPeriodIds(before, slice(models, { runningConditionTestPeriods: [] }))).toEqual(['ws-a', 'ws-b']);
        expect(changedTrainInputIds(before, before)).toEqual([]);
        expect(changedScoringPeriodIds(before, before)).toEqual([]);
    });

    it('a slice without the running-condition fields reads as their defaults (no throw)', () => {
        const bare = { models: [wsModel('ws-a')] };
        expect(changedTrainInputIds(bare, bare)).toEqual([]);
        expect(changedTrainInputIds(bare, { ...bare, runningConditionNoneConfirmed: true })).toEqual(['ws-a']);
        expect(changedScoringPeriodIds(bare, { ...bare, runningConditionTestPeriods: SCORE })).toEqual(['ws-a']);
    });
});

describe('read side: a Complete model whose inputs no longer match its train record is not complete (old data)', () => {
    const fgNone = slice([]);
    const trained = (m: FailureModel, fg = fgNone): FailureModel => ({
        ...m, lastTrainedAt: '2026-10-03T00:00:00Z', trainedFingerprint: computeTrainFingerprint(m, fg),
    });

    it('fresh train record + status -> complete', () => {
        const m = trained(individual());
        expect(isModelStale(m, fgNone)).toBe(false);
        expect(isModelComplete(m, fgNone)).toBe(true);
        expect(modelDotState(m, fgNone)).toBe('complete');
    });

    it('status:true with a MISMATCHING train record -> stale, not complete (even though status is true on disk)', () => {
        const m = { ...trained(individual()), targetSensor: 'T2' };
        expect(m.status).toBe(true);
        expect(isModelStale(m, fgNone)).toBe(true);
        expect(isModelComplete(m, fgNone)).toBe(false);
        expect(modelDotState(m, fgNone)).toBe('stale');
    });

    it('the workspace condition changing makes a Workspace-mode Complete model stale, not a Custom-mode one', () => {
        const wsM = trained(individual());
        const customM = trained({ ...individual(), runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true });
        const changed = slice([], { runningConditionCombine: 'or' });
        expect(isModelComplete(wsM, changed)).toBe(false);
        expect(isModelComplete(customM, changed)).toBe(true);
    });

    it('no train record at all (legacy complete) is NOT stale and stays complete', () => {
        const legacy = individual();
        expect(isModelStale(legacy, fgNone)).toBe(false);
        expect(isModelComplete(legacy, fgNone)).toBe(true);
    });

    it('set points never make a model stale', () => {
        const m = trained(individual());
        expect(isModelComplete({ ...m, healthSetPoints: { kind: 'individual', lower: 5, upper: 50 } }, fgNone)).toBe(true);
    });

    it('neither does the export record of its saved files', () => {
        const m = trained(individual());
        const exported = { ...m, healthExport: { at: 'x', outputDir: 'C:/o', setPoints: { kind: 'individual' as const, lower: 5, upper: 50 } } };
        expect(computeTrainFingerprint(exported, fgNone)).toBe(computeTrainFingerprint(m, fgNone));
        expect(isModelComplete(exported, fgNone)).toBe(true);
    });

    it('dot states for a model that is not complete: none / trained / stale / blocked', () => {
        const base = { ...individual(), status: false };
        expect(modelDotState(base, fgNone)).toBe('none');
        expect(modelDotState(trained(base), fgNone)).toBe('trained');
        expect(modelDotState({ ...trained(base), targetSensor: 'T2' }, fgNone)).toBe('stale');
        // Gate blocks (no category): red, whatever the train record says.
        expect(modelDotState({ ...trained(base), category: null }, fgNone)).toBe('blocked');
    });

    it('exports the shared not-trained reason text', () => {
        expect(NOT_TRAINED_BLOCK_REASON).toBe('Train the model, then check the result before marking it complete.');
    });
});

describe('the saved verdict (healthVerdict) follows the same inputs rule (QA 2026-10-04)', () => {
    it('a training-input change drops the verdict - even on a model that is not Complete (nothing to demote)', () => {
        const m = mk({ id: 'i', kind: 'individual', targetSensor: 'T', status: false, category: 'condition', healthVerdict: 'invalid' });
        const out = editModel(m, { targetSensor: 'T2' });
        expect(out).not.toHaveProperty('healthVerdict');
        expect(out.status).toBe(false);
    });

    it('a Complete model keeps no verdict either, and is demoted as before', () => {
        const out = editModel({ ...individual(), healthVerdict: 'valid' }, { targetSensor: 'T2' });
        expect(out.status).toBe(false);
        expect(out).not.toHaveProperty('healthVerdict');
    });

    it('a non-trigger (a set point, the name) keeps the verdict, and the same reference comes back when nothing is dropped', () => {
        const m = mk({ id: 'i', kind: 'individual', targetSensor: 'T', status: false, category: 'condition', healthVerdict: 'incomplete' });
        expect(editModel(m, { name: 'renamed' }).healthVerdict).toBe('incomplete');
        const prev = ws(slice([m]));
        const next = ws(slice([{ ...m, notes: 'n' }]));
        expect(applyIncompleteRule(prev, next)).toBe(next);
    });

    it('a workspace Running condition change drops the verdict of a model that follows it, not of one with its own', () => {
        const follows = mk({ id: 'a', kind: 'individual', targetSensor: 'T', category: 'condition', healthVerdict: 'valid' });
        const own = mk({ id: 'b', kind: 'individual', targetSensor: 'U', category: 'condition', healthVerdict: 'valid', runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true });
        const prev = ws(slice([follows, own], { runningConditionFilters: [cond('1')] }));
        const next = ws(slice([follows, own], { runningConditionFilters: [cond('2')] }));
        const out = applyIncompleteRule(prev, next).failureGroupState!.models;
        expect(out[0]).not.toHaveProperty('healthVerdict');
        expect(out[1].healthVerdict).toBe('valid');
    });
});

describe('modelSetPointFlag - what the saved verdict says about a TRAINED model', () => {
    const fg = slice([]);
    const trainedModel = (over: Partial<FailureModel> = {}): FailureModel => {
        const m = mk({ id: 'i', kind: 'individual', targetSensor: 'T', category: 'condition', ...over });
        return { ...m, lastTrainedAt: 'x', trainedFingerprint: computeTrainFingerprint(m, fg) };
    };
    it('invalid -> fix, incomplete -> needed, valid / never judged -> null', () => {
        expect(modelSetPointFlag(trainedModel({ healthVerdict: 'invalid' }), fg)).toBe('fix');
        expect(modelSetPointFlag(trainedModel({ healthVerdict: 'incomplete' }), fg)).toBe('needed');
        expect(modelSetPointFlag(trainedModel({ healthVerdict: 'valid' }), fg)).toBeNull();
        expect(modelSetPointFlag(trainedModel(), fg)).toBeNull();
    });
    it('only a model in the "trained" state is flagged: complete, stale, blocked and never-trained ignore the verdict', () => {
        expect(modelSetPointFlag(trainedModel({ status: true, healthVerdict: 'invalid' }), fg)).toBeNull(); // complete
        expect(modelSetPointFlag({ ...trainedModel({ healthVerdict: 'invalid' }), trainedFingerprint: 'old' }, fg)).toBeNull(); // stale
        expect(modelSetPointFlag(trainedModel({ category: null, healthVerdict: 'invalid' }), fg)).toBeNull(); // blocked
        expect(modelSetPointFlag(mk({ id: 'i', kind: 'individual', targetSensor: 'T', category: 'condition', healthVerdict: 'invalid' }), fg)).toBeNull(); // never trained
    });
    it('a caller that overrides the dot state (a failed run of this session) can say so', () => {
        expect(modelSetPointFlag(trainedModel({ healthVerdict: 'invalid' }), fg, null, 'stale')).toBeNull();
        expect(modelDotState(trainedModel(), fg)).toBe('trained');
    });
});

describe('applyIncompleteRule - changing ONLY scoring periods (SPEC rules 8 & 9)', () => {
    const NOW = '2026-10-07T10:00:00.000Z';
    // A scoring period is start → end only ("just score it", 2026-10-10).
    const t1: TestPeriod = { id: 't1', start: '2026-01-01T00:00', end: '2026-01-31T23:59' };
    const t2: TestPeriod = { id: 't2', start: '2026-03-01T00:00', end: '2026-03-31T23:59' };
    const fgBase = slice([]);
    const trainedComplete = (over: Partial<FailureModel> = {}): FailureModel => {
        const m = { ...individual(), ...over };
        return { ...m, lastTrainedAt: '2026-10-01T00:00:00Z', trainedFingerprint: computeTrainFingerprint(m, fgBase), healthVerdict: 'valid' };
    };

    it('scoring periods are NOT part of the train fingerprint (workspace list and a Custom model own list)', () => {
        const m = individual();
        expect(computeTrainFingerprint(m, slice([], { runningConditionTestPeriods: [t1, t2] }))).toBe(computeTrainFingerprint(m, fgBase));
        const c = { ...m, runningConditionMode: 'custom' as const, customRunningConditionNoneConfirmed: true };
        expect(computeTrainFingerprint({ ...c, customTestPeriods: [t1] }, fgBase)).toBe(computeTrainFingerprint(c, fgBase));
    });

    it('workspace scoring list changed -> a Complete Workspace-mode model goes Incomplete + testsChangedAt in the SAME write, still trained (fresh)', () => {
        const m = trainedComplete();
        const prev = ws(slice([m]));
        const next = ws(slice([m], { runningConditionTestPeriods: [t1] }));
        const out = applyIncompleteRule(prev, next, { now: NOW });
        const after = out.failureGroupState!.models[0];
        expect(after.status).toBe(false);
        expect(after.testsChangedAt).toBe(NOW);
        // Stays trained: train record kept, fingerprint still matches, verdict kept.
        expect(after.lastTrainedAt).toBe(m.lastTrainedAt);
        expect(after.trainedFingerprint).toBe(computeTrainFingerprint(after, out.failureGroupState!));
        expect(isModelStale(after, out.failureGroupState!)).toBe(false);
        expect(after.healthVerdict).toBe('valid');
        expect(modelDotState(after, out.failureGroupState!)).toBe('trained');
        // Other slice fields survive (written through withFailureGroupState).
        expect(out.failureGroupState!.runningConditionTestPeriods).toEqual([t1]);
    });

    it('is idempotent: a second pass changes nothing (same reference)', () => {
        const m = trainedComplete();
        const prev = ws(slice([m]));
        const once = applyIncompleteRule(prev, ws(slice([m], { runningConditionTestPeriods: [t1] })), { now: NOW });
        expect(applyIncompleteRule(prev, once, { now: '2099-01-01T00:00:00Z' })).toBe(once);
        expect(applyIncompleteRule(once, once)).toBe(once);
    });

    it('a Custom model: its OWN customTestPeriods count, the workspace list does not', () => {
        const c = trainedComplete({ runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true, filterTimePeriods: [period('2025-01-01T00:00', '2025-06-30T23:59')] });
        const fixed = { ...c, trainedFingerprint: computeTrainFingerprint(c, fgBase) };
        // Workspace tests changed: the Custom model is untouched.
        const a = applyIncompleteRule(ws(slice([fixed])), ws(slice([fixed], { runningConditionTestPeriods: [t1] })), { now: NOW });
        expect(a.failureGroupState!.models[0].status).toBe(true);
        expect(a.failureGroupState!.models[0].testsChangedAt).toBeUndefined();
        // Its own tests changed: demoted with the stamp.
        const b = applyIncompleteRule(ws(slice([fixed])), ws(slice([{ ...fixed, customTestPeriods: [t2] }])), { now: NOW });
        expect(b.failureGroupState!.models[0]).toMatchObject({ status: false, testsChangedAt: NOW });
    });

    it('a start / end change, adding one, removing every one and re-ordering all count; ids and the legacy keys do not', () => {
        const m = trainedComplete();
        const run = (before: TestPeriod[], after: TestPeriod[]) =>
            applyIncompleteRule(ws(slice([m], { runningConditionTestPeriods: before })), ws(slice([m], { runningConditionTestPeriods: after })), { now: NOW })
                .failureGroupState!.models[0].status;
        expect(run([t1], [{ ...t1, start: '2026-01-02T00:00' }])).toBe(false);
        expect(run([t1], [{ ...t1, end: '2026-02-15T00:00' }])).toBe(false);
        expect(run([t1], [t1, t2])).toBe(false);
        expect(run([t1, t2], [])).toBe(false);
        expect(run([t1, t2], [t2, t1])).toBe(false); // S1 / S2 swapped: the saved results are in the other order
        expect(run([t1], [{ ...t1, id: 'other' }])).toBe(true);
        // The removed label / event time / highlight caption cannot change a result (Rust ignores
        // them), so gaining, losing or changing one is NOT a change of the scoring periods.
        expect(run([t1], [{ ...t1, label: 'problem' }])).toBe(true);
        expect(run([{ ...t1, label: 'normal' }], [{ ...t1, label: 'problem', eventTime: '2026-01-05T00:00' }])).toBe(true);
        expect(run([{ ...t2, label: 'problem', eventTime: '2026-03-20T08:00' }], [{ ...t2, label: 'problem', eventTime: '2026-03-21T08:00' }])).toBe(true);
        expect(run([{ ...t1, label: 'problem', eventTime: '2026-01-05T00:00', fromHighlight: 'Overhaul' }], [t1])).toBe(true);
    });

    // SPEC workbench-redesign §2: "keep them readable so old workspaces load. Stop writing
    // them and ignore them on load. No migration is needed." The danger this guards: dropping
    // `label` / `eventTime` from what counts must not turn every Complete model of an existing
    // workspace into "needs Mark complete again" the first time that workspace is opened or saved.
    describe('a workspace saved before 2026-10-10 (scoring periods still carrying label / eventTime / fromHighlight)', () => {
        const oldFg = (models: FailureModel[], over: Partial<FailureGroupStateSlice> = {}) => slice(models, { runningConditionTestPeriods: LEGACY_TESTS, ...over });

        it('loads: its models are Complete, pass the Mark-complete gate and show no "scoring periods changed" notice', () => {
            const m = trainedComplete();
            const fg = oldFg([m]);
            expect(isModelComplete(m, fg)).toBe(true);
            expect(isModelStale(m, fg)).toBe(false);
            expect(markCompleteBlockReason(m, fg)).toBeNull();
            expect(testsChangedState(m, fg)).toBeNull();
            expect(testsChangedNotice([m], fg)).toBeNull();
        });

        it('any write that leaves the periods alone (a rename, a Dashboard autosave, a JSON round trip) keeps it Complete — same reference, no stamp', () => {
            const m = trainedComplete();
            const prev = ws(oldFg([m]));
            const renamed = { ...prev, name: 'Renamed' } as WorkspaceState;
            expect(applyIncompleteRule(prev, renamed, { now: NOW })).toBe(renamed);
            const reread = JSON.parse(JSON.stringify(prev)) as WorkspaceState; // what a load -> save cycle hands the rule
            expect(applyIncompleteRule(prev, reread, { now: NOW })).toBe(reread);
            expect(reread.failureGroupState!.models[0]).toMatchObject({ status: true });
            expect(reread.failureGroupState!.models[0]).not.toHaveProperty('testsChangedAt');
            // nothing was migrated away: the legacy keys are still what is on disk
            expect(reread.failureGroupState!.runningConditionTestPeriods).toEqual(LEGACY_TESTS);
        });

        it('a write whose periods passed through an edit and LOST the legacy keys is not a change: still Complete, no stamp, nothing demoted', () => {
            const m = trainedComplete();
            const prev = ws(oldFg([m]));
            const stripped = toScoringPeriods(LEGACY_TESTS);
            expect(JSON.stringify(stripped)).not.toMatch(/label|eventTime|fromHighlight/);
            const next = ws(oldFg([m], { runningConditionTestPeriods: stripped }));
            const out = applyIncompleteRule(prev, next, { now: NOW });
            expect(out).toBe(next);
            expect(out.failureGroupState!.models[0].status).toBe(true);
            expect(out.failureGroupState!.models[0]).not.toHaveProperty('testsChangedAt');
            expect(modelsWithChangedTests(prev, next)).toEqual([]);
            // ...and the other way round (another window still holding the old list writes it back)
            expect(applyIncompleteRule(next, prev, { now: NOW })).toBe(prev);
        });

        it('the same for a Custom model whose OWN list is old-shaped', () => {
            const c = trainedComplete({ runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true, filterTimePeriods: [period('2025-01-01T00:00', '2025-06-30T23:59')], customTestPeriods: LEGACY_TESTS });
            const fixed = { ...c, trainedFingerprint: computeTrainFingerprint(c, fgBase) };
            const prev = ws(slice([fixed]));
            expect(isModelComplete(fixed, prev.failureGroupState!)).toBe(true);
            const next = ws(slice([{ ...fixed, customTestPeriods: toScoringPeriods(LEGACY_TESTS) }]));
            expect(applyIncompleteRule(prev, next, { now: NOW })).toBe(next);
            expect(modelsWithChangedTests(prev, next)).toEqual([]);
        });

        it('a REAL edit of an old period still counts: its end moved -> Incomplete + testsChangedAt, and what is written has no legacy key', () => {
            const m = trainedComplete();
            const prev = ws(oldFg([m]));
            const edited = [toScoringPeriod({ ...LEGACY_TESTS[0], end: '2024-02-15T00:00' }), toScoringPeriod(LEGACY_TESTS[1])];
            const out = applyIncompleteRule(prev, ws(oldFg([m], { runningConditionTestPeriods: edited })), { now: NOW });
            expect(out.failureGroupState!.models[0]).toMatchObject({ status: false, testsChangedAt: NOW });
            expect(isModelStale(out.failureGroupState!.models[0], out.failureGroupState!)).toBe(false); // still trained
            expect(JSON.stringify(out.failureGroupState!.runningConditionTestPeriods)).not.toMatch(/label|eventTime|fromHighlight/);
        });
    });

    it('a model that is not Complete gets no stamp and stays the same object', () => {
        const m = { ...trainedComplete(), status: false };
        const prev = ws(slice([m]));
        const next = ws(slice([m], { runningConditionTestPeriods: [t1] }));
        expect(applyIncompleteRule(prev, next, { now: NOW })).toBe(next);
    });

    it('a TRAIN change behaves as before (Incomplete + stale, verdict dropped) and gets no testsChangedAt, even if tests changed too', () => {
        const m = trainedComplete();
        const prev = ws(slice([m]));
        const next = ws(slice([m], {
            runningConditionTimePeriods: [period('2025-02-01T00:00', '2025-12-31T23:59')],
            runningConditionTestPeriods: [t1],
        }));
        const out = applyIncompleteRule(prev, next, { now: NOW });
        const after = out.failureGroupState!.models[0];
        expect(after.status).toBe(false);
        expect(after.testsChangedAt).toBeUndefined();
        expect(after).not.toHaveProperty('healthVerdict');
        expect(isModelStale(after, out.failureGroupState!)).toBe(true);
    });

    it('review fix 2026-10-07: a TRAIN change drops a testsChangedAt stamp left by an EARLIER tests-only change (the train rule wins)', () => {
        // Step 1: tests only -> Incomplete + stamp, still trained.
        const m = trainedComplete();
        const afterTests = applyIncompleteRule(ws(slice([m])), ws(slice([m], { runningConditionTestPeriods: [t1] })), { now: NOW });
        const stamped = afterTests.failureGroupState!.models[0];
        expect(stamped).toMatchObject({ status: false, testsChangedAt: NOW });
        // Step 2: a training input changes -> the stamp goes (a re-train is needed, not "Mark complete again").
        const next = ws(slice([stamped], {
            runningConditionTestPeriods: [t1],
            runningConditionTimePeriods: [period('2025-02-01T00:00', '2025-12-31T23:59')],
        }));
        const out = applyIncompleteRule(afterTests, next, { now: '2026-10-08T00:00:00.000Z' });
        const after = out.failureGroupState!.models[0];
        expect(after).not.toHaveProperty('testsChangedAt');
        expect(after.status).toBe(false);
        expect(isModelStale(after, out.failureGroupState!)).toBe(true);
        // idempotent
        expect(applyIncompleteRule(afterTests, out)).toBe(out);
    });

    it('review fix 2026-10-07: a stamped model with no verdict and status false still loses the stamp on a train change', () => {
        const { healthVerdict: _v, ...noVerdict } = trainedComplete({ status: false });
        void _v;
        const m: FailureModel = { ...noVerdict, testsChangedAt: NOW };
        const next = ws(slice([m], { runningConditionTimePeriods: [period('2025-03-01T00:00', '2025-12-31T23:59')] }));
        const out = applyIncompleteRule(ws(slice([m])), next, { now: NOW });
        expect(out).not.toBe(next);
        expect(out.failureGroupState!.models[0]).not.toHaveProperty('testsChangedAt');
    });

    it('modelsWithChangedTests reports exactly the models whose EFFECTIVE scoring periods changed', () => {
        const a = individual();
        const c = { ...individual(), id: 'c', runningConditionMode: 'custom' as const };
        const prev = ws(slice([a, c]));
        const next = ws(slice([a, c], { runningConditionTestPeriods: [t1] }));
        expect(modelsWithChangedTests(prev, next)).toEqual(['i']);
        expect(modelsWithChangedInputs(prev, next)).toEqual([]);
    });

    it('old workspaces without any scoring-period field compare equal (undefined vs [])', () => {
        const m = trainedComplete();
        const prev = ws(slice([m]));
        const next = ws(slice([{ ...m, customTestPeriods: [] }], { runningConditionTestPeriods: [] }));
        expect(applyIncompleteRule(prev, next)).toBe(next);
    });
});

// Customer batch 2026-10, item 6 (user decision): a special sensor's recipe is
// a training input too. Full coverage in specialSensorSignature.test.ts.
describe('applyIncompleteRule - special-sensor recipes', () => {
    const withRecipes = (fg: FailureGroupStateSlice, formula: string): WorkspaceState =>
        ({ ...ws(fg), specialSensorRecipes: [{ kind: 'formula', tag: 'T', formula }] } as WorkspaceState);
    const trainedOnT = () => {
        const m = individual();
        return { ...m, lastTrainedAt: '2026-10-01T00:00:00.000Z', trainedFingerprint: computeTrainFingerprint(m, slice([m])) };
    };

    it('changing the recipe of a sensor a Complete model trains on demotes it in the same write (out of date: fingerprint dropped)', () => {
        const m = trainedOnT();
        const out = applyIncompleteRule(withRecipes(slice([m]), '$RAW * 2'), withRecipes(slice([m]), '$RAW * 3')).failureGroupState!.models[0];
        expect(out.status).toBe(false);
        expect(out.trainedFingerprint).toBeUndefined();
        expect(out.lastTrainedAt).toBe(m.lastTrainedAt);
        expect(isModelStale(out, slice([out]))).toBe(true);
    });

    it('a write that leaves the recipes alone changes nothing (no upgrade-time demotion)', () => {
        const m = trainedOnT();
        const prev = withRecipes(slice([m]), '$RAW * 2');
        const next = { ...prev, name: 'Renamed' };
        expect(applyIncompleteRule(prev, next)).toBe(next);
    });

    it('compares recipes by CONTENT: a re-built list with the same recipes is no change', () => {
        const m = trainedOnT();
        const prev = withRecipes(slice([m]), '$RAW * 2');
        const next = withRecipes(slice([m]), '$RAW * 2'); // a new array, same content
        expect(prev.specialSensorRecipes).not.toBe(next.specialSensorRecipes);
        expect(recipesDiffer(prev.specialSensorRecipes, next.specialSensorRecipes)).toBe(false);
        expect(applyRecipeRule(prev, next)).toBe(next);
        expect(applyIncompleteRule(prev, next)).toBe(next);
    });

    it('recipesDiffer: missing lists read as empty; any content change counts', () => {
        expect(recipesDiffer(undefined, [])).toBe(false);
        expect(recipesDiffer(undefined, undefined)).toBe(false);
        expect(recipesDiffer([], [{ kind: 'formula', tag: 'T', formula: '$A' }])).toBe(true);
        expect(recipesDiffer([{ kind: 'formula', tag: 'T', formula: '$A' }], [{ kind: 'formula', tag: 'T', formula: '$B' }])).toBe(true);
    });
});
