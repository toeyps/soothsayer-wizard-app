import { describe, it, expect } from 'vitest';
import { mk } from './helpers/failureModelFixture';
import type { FailureGroupStateSlice, FailureModel, WorkspaceState } from '../types';
import { applyIncompleteRule, modelsWithChangedInputs } from '../utils/incompleteRule';
import { isModelComplete, isModelStale, modelDotState, modelSetPointFlag, NOT_TRAINED_BLOCK_REASON } from '../utils/modelStatus';
import { computeTrainFingerprint } from '../utils/trainFingerprint';

const slice = (models: FailureModel[], over: Partial<FailureGroupStateSlice> = {}): FailureGroupStateSlice => ({
    groups: [], models,
    runningConditionFilters: [], runningConditionCombine: 'and',
    runningConditionTimePeriods: [], runningConditionNoneConfirmed: true,
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
