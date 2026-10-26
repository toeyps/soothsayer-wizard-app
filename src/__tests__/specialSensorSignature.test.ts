import { describe, it, expect } from 'vitest';
import { mk } from './helpers/failureModelFixture';
import type { FailureGroupStateSlice, FailureModel, SpecialSensorRecipe, WorkspaceState } from '../types';
import {
    changedRecipeKeys, demoteModelsForRecipeChange, recipeSignatures, snapshotTrainedFormulas, specialSensorsTrainedOn,
    stampTrainedFormulas, trainedFormulasChanged,
} from '../utils/specialSensorSignature';
import { applyIncompleteRule } from '../utils/incompleteRule';
import { isModelComplete, isModelStale, modelDotState, modelSetPointFlag } from '../utils/modelStatus';
import { computeTrainFingerprint, isModelTrainedFresh } from '../utils/trainFingerprint';

const F = (tag: string, formula: string): SpecialSensorRecipe => ({ kind: 'formula', tag, formula });
const AVG = (tag: string, sources: string[], decimals?: number): SpecialSensorRecipe => ({
    kind: 'operation', tag, sourceSensors: sources,
    operationConfig: { mode: 'multi', multiOp: { type: 'mean', ...(decimals !== undefined ? { decimals } : {}) }, customName: tag },
});

const fgOf = (models: FailureModel[], over: Partial<FailureGroupStateSlice> = {}): FailureGroupStateSlice => ({
    groups: [], models, runningConditionFilters: [{ id: 'rc', sensor: 'SPEED', operation: 'greater_than', value1: '1200', value2: '' }], runningConditionCombine: 'and',
    runningConditionTimePeriods: [{ id: 'w', start: '2025-01-01T00:00', end: '2025-12-31T23:59' }],
    rcLegacyNotice: null, ...over,
});
const ws = (models: FailureModel[], recipes: SpecialSensorRecipe[], over: Partial<FailureGroupStateSlice> = {}): WorkspaceState =>
    ({ id: 'ws1', name: 'W', specialSensorRecipes: recipes, failureGroupState: fgOf(models, over) } as unknown as WorkspaceState);

/** A model trained (and fresh) against `fg`, optionally Complete. */
function trained(over: Partial<FailureModel> & { id: string }, complete = true): FailureModel {
    const m = mk({ kind: 'individual', category: 'condition', ...over });
    return { ...m, status: complete, lastTrainedAt: '2026-10-01T00:00:00.000Z', trainedFingerprint: computeTrainFingerprint(m, fgOf([])) };
}

describe('recipeSignatures', () => {
    const base = [F('S1', '$RAW * 2'), F('S2', '$S1 + 1'), AVG('S3', ['S2', 'RAW2'])];

    it('ignores whitespace and the spelling of a reference, but not the text', () => {
        const a = recipeSignatures([F('X', '$A+1')]);
        expect(recipeSignatures([F('X', ' $A +  1 ')]).get('x')).toBe(a.get('x'));
        expect(recipeSignatures([F('X', '${A} + 1')]).get('x')).toBe(a.get('x'));
        expect(recipeSignatures([F('X', '$A + 2')]).get('x')).not.toBe(a.get('x'));
    });

    it('is deep: editing a source changes every special sensor built on it, and nothing else', () => {
        const before = recipeSignatures(base);
        const after = recipeSignatures([F('S1', '$RAW * 3'), base[1], base[2]]);
        expect(['s1', 's2', 's3'].map(k => before.get(k) !== after.get(k))).toEqual([true, true, true]);
        expect(changedRecipeKeys(base, [F('S1', '$RAW * 3'), base[1], base[2]])).toEqual(['s1', 's2', 's3']);
        expect(changedRecipeKeys(base, [base[0], F('S2', '$S1 + 5'), base[2]])).toEqual(['s2', 's3']);
    });

    it('is rename-proof: renaming a source rewrites its dependants\' text, not their signatures', () => {
        const before = recipeSignatures(base);
        const after = recipeSignatures([F('S1_NEW', '$RAW * 2'), F('S2', '$S1_NEW + 1'), AVG('S3', ['S2', 'RAW2'])]);
        expect(after.get('s2')).toBe(before.get('s2'));
        expect(after.get('s3')).toBe(before.get('s3'));
    });

    it('covers block decimals; customName and key order do not matter; cycles do not hang', () => {
        const a = recipeSignatures([AVG('M', ['A', 'B'])]).get('m');
        expect(recipeSignatures([AVG('M', ['A', 'B'], 2)]).get('m')).not.toBe(a);
        expect(recipeSignatures([{ kind: 'operation', tag: 'M', sourceSensors: ['A', 'B'], operationConfig: { multiOp: { type: 'mean' }, mode: 'multi', customName: 'other' } }]).get('m')).toBe(a);
        const cyc = recipeSignatures([F('P', '$Q + 1'), F('Q', '$P + 1')]);
        expect(cyc.size).toBe(2);
    });

    it('is memoised per recipes array and safe on empty input', () => {
        expect(recipeSignatures(base)).toBe(recipeSignatures(base));
        expect(recipeSignatures(undefined).size).toBe(0);
        expect(changedRecipeKeys(base, base)).toEqual([]);
    });
});

describe('snapshotTrainedFormulas / trainedFormulasChanged', () => {
    const recipes = [F('S1', '$RAW * 2'), F('S2', '$S1 + 1')];

    it('snapshots only the special sensors the model trains on (incl. its effective running condition)', () => {
        const m = mk({ id: 'r', kind: 'relationship', targetSensor: 'S2', predictorSensors: ['RAW', 'S1'] });
        expect(specialSensorsTrainedOn(m, fgOf([]), recipes)).toEqual(['s2', 's1']);
        const snap = snapshotTrainedFormulas(m, recipes, fgOf([]))!;
        expect(Object.keys(snap)).toEqual(['s2', 's1']);
        const viaRc = mk({ id: 'i', targetSensor: 'RAW' });
        const rc = { runningConditionFilters: [{ id: 'f', sensor: 's1', operation: 'greater_than' as const, value1: '1', value2: '' }] };
        expect(snapshotTrainedFormulas(viaRc, recipes, rc)).toEqual({ s1: recipeSignatures(recipes).get('s1') });
        expect(snapshotTrainedFormulas(mk({ id: 'x', targetSensor: 'RAW' }), recipes, fgOf([]))).toBeUndefined();
    });

    it('changed = a snapshot entry whose sensor now has another recipe; no snapshot / a missing sensor is never "changed"', () => {
        const m = { ...mk({ id: 'i', targetSensor: 'S2' }), trainedFormulas: snapshotTrainedFormulas(mk({ id: 'i', targetSensor: 'S2' }), recipes, fgOf([])) };
        expect(trainedFormulasChanged(m, recipes)).toBe(false);
        expect(trainedFormulasChanged(m, [F('S1', '$RAW * 9'), recipes[1]])).toBe(true); // a SOURCE of S2 changed
        expect(trainedFormulasChanged(m, [])).toBe(false);
        expect(trainedFormulasChanged(mk({ id: 'old', targetSensor: 'S2' }), [F('S2', 'anything')])).toBe(false);
    });
});

describe('the status truth with recipes (isModelStale / isModelComplete / modelDotState / isModelTrainedFresh)', () => {
    const recipes = [F('S1', '$RAW * 2')];
    const edited = [F('S1', '$RAW * 3')];

    it('a model trained on a special sensor goes stale when its recipe changes -- only when the caller passes the recipes', () => {
        const m0 = trained({ id: 'i', targetSensor: 'S1' });
        const m = { ...m0, trainedFormulas: snapshotTrainedFormulas(m0, recipes, fgOf([])) };
        const fg = fgOf([m]);
        expect(isModelStale(m, fg, recipes)).toBe(false);
        expect(isModelComplete(m, fg, recipes)).toBe(true);
        expect(isModelStale(m, fg, edited)).toBe(true);
        expect(isModelComplete(m, fg, edited)).toBe(false);
        expect(modelDotState(m, fg, null, edited)).toBe('stale');
        expect(isModelStale(m, fg)).toBe(false); // not judged without recipes
        const notComplete = { ...m, status: false };
        expect(isModelTrainedFresh(notComplete, fg, recipes)).toBe(true);
        expect(isModelTrainedFresh(notComplete, fg, edited)).toBe(false);
        expect(modelDotState(notComplete, fg, null, edited)).toBe('stale');
        expect(modelSetPointFlag({ ...notComplete, healthVerdict: 'invalid' }, fg, null, undefined, edited)).toBeNull();
        expect(modelSetPointFlag({ ...notComplete, healthVerdict: 'invalid' }, fg, null, undefined, recipes)).toBe('fix');
    });

    it('backward compatible: a model trained before snapshots existed is never stale because of recipes', () => {
        const legacy = trained({ id: 'i', targetSensor: 'S1' });
        expect(isModelStale(legacy, fgOf([legacy]), edited)).toBe(false);
        expect(isModelComplete(legacy, fgOf([legacy]), edited)).toBe(true);
    });
});

describe('stampTrainedFormulas (the write that records a train)', () => {
    const recipes = [F('S1', '$RAW * 2')];

    it('stamps a newly trained model from the recipes on disk; leaves untouched models and writes alone', () => {
        const before = mk({ id: 'i', targetSensor: 'S1', category: 'condition' });
        const after = trained({ id: 'i', targetSensor: 'S1' }, false);
        const prev = ws([before], recipes);
        const next = stampTrainedFormulas(prev, ws([after], recipes));
        expect(next.failureGroupState!.models[0].trainedFormulas).toEqual({ s1: recipeSignatures(recipes).get('s1') });
        // A second pass (or an unrelated write) changes nothing -- same reference.
        expect(stampTrainedFormulas(next, next)).toBe(next);
        const unrelated = ws([after], recipes);
        expect(stampTrainedFormulas(unrelated, unrelated)).toBe(unrelated);
    });

    it('a re-train that uses no special sensor drops an old snapshot', () => {
        const old = { ...trained({ id: 'i', targetSensor: 'S1' }, false), trainedFormulas: { s1: 'x' } };
        const retrained = { ...trained({ id: 'i', targetSensor: 'RAW' }, false), lastTrainedAt: '2026-10-09T00:00:00.000Z', trainedFormulas: { s1: 'x' } };
        const next = stampTrainedFormulas(ws([old], recipes), ws([retrained], recipes));
        expect('trainedFormulas' in next.failureGroupState!.models[0]).toBe(false);
    });
});

describe('demoteModelsForRecipeChange', () => {
    const recipes = [F('S1', '$RAW * 2'), F('S2', '$S1 + 1')];
    const edited = [F('S1', '$RAW * 3'), F('S2', '$S1 + 1')];

    it('demotes models trained on the edited sensor or one built on it (status false, fingerprint dropped, set points kept)', () => {
        const onS2 = trained({ id: 'a', targetSensor: 'S2' });
        const onRaw = trained({ id: 'b', targetSensor: 'RAW' });
        const never = mk({ id: 'c', targetSensor: 'S1' });
        const res = demoteModelsForRecipeChange([onS2, onRaw, never], fgOf([]), recipes, edited);
        expect(res.retrain).toEqual(['a']);
        expect(res.models[0]).toMatchObject({ id: 'a', status: false, lastTrainedAt: onS2.lastTrainedAt });
        expect(res.models[0].trainedFingerprint).toBeUndefined();
        expect(res.models[1]).toBe(onRaw);
        expect(res.models[2]).toBe(never);
    });

    it('demotes by snapshot too (an edit that bypassed a write rule), idempotently; nothing to do = same array', () => {
        const m0 = trained({ id: 'a', targetSensor: 'S2' });
        const m = { ...m0, trainedFormulas: snapshotTrainedFormulas(m0, recipes, fgOf([])) };
        const res = demoteModelsForRecipeChange([m], fgOf([]), edited, edited);
        expect(res.retrain).toEqual(['a']);
        expect(res.models[0].status).toBe(false);
        expect(demoteModelsForRecipeChange(res.models, fgOf([]), edited, edited).models).toBe(res.models);
        const fresh = [m];
        expect(demoteModelsForRecipeChange(fresh, fgOf([]), recipes, recipes).models).toBe(fresh);
    });
});

describe('applyIncompleteRule with special-sensor recipes (same write)', () => {
    const recipes = [F('S1', '$RAW * 2')];

    it('a write that changes a used recipe demotes the model in that write', () => {
        const m = trained({ id: 'i', targetSensor: 'S1' });
        const out = applyIncompleteRule(ws([m], recipes), ws([m], [F('S1', '$RAW * 3')]));
        expect(out.failureGroupState!.models[0]).toMatchObject({ status: false });
        expect(out.failureGroupState!.models[0].trainedFingerprint).toBeUndefined();
    });

    it('UPGRADE: an unrelated write leaves every pre-existing trained model alone (no snapshot, recipes unchanged)', () => {
        const m = trained({ id: 'i', targetSensor: 'S1' });
        const prev = ws([m], recipes);
        const next = { ...prev, name: 'Renamed' };
        const out = applyIncompleteRule(prev, next);
        expect(out).toBe(next);
    });

    it('a Train write stamps the snapshot, and the same write never demotes the model it just trained', () => {
        const before = { ...trained({ id: 'i', targetSensor: 'S1' }, false), trainedFormulas: { s1: 'stale-old' }, lastTrainedAt: '2026-09-01T00:00:00.000Z' };
        const after = { ...before, lastTrainedAt: '2026-10-09T00:00:00.000Z' };
        const out = applyIncompleteRule(ws([before], recipes), ws([after], recipes));
        const m = out.failureGroupState!.models[0];
        expect(m.trainedFormulas).toEqual({ s1: recipeSignatures(recipes).get('s1') });
        expect(m.trainedFingerprint).toBe(after.trainedFingerprint);
        expect(isModelTrainedFresh(m, out.failureGroupState, recipes)).toBe(true);
    });

    it('a later write with a mismatching snapshot (recipe changed by a writer that skipped the rule) demotes it', () => {
        const m0 = trained({ id: 'i', targetSensor: 'S1' });
        const m = { ...m0, trainedFormulas: snapshotTrainedFormulas(m0, recipes, fgOf([])) };
        const disk = ws([m], [F('S1', '$RAW * 3')]);
        const out = applyIncompleteRule(disk, { ...disk, name: 'x' });
        expect(out.failureGroupState!.models[0].status).toBe(false);
    });
});
