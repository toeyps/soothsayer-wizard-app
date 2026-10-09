import { describe, it, expect, vi } from 'vitest';
import { mk } from './helpers/failureModelFixture';
import type { FailureModel, SpecialSensorRecipe, WorkspaceState } from '../types';
import {
    applyLegacyConversion, convertLegacyFormulaRecipes, legacyConversionMessage,
} from '../utils/legacyFormulaConversion';
import { convertLegacyRoundLocal } from '../utils/formulaRounding';
import { computeTrainFingerprint } from '../utils/trainFingerprint';

const F = (tag: string, formula: string): SpecialSensorRecipe => ({ kind: 'formula', tag, formula });

/** Stands in for Rust's `convert_legacy_formula` (same output on these inputs:
 *  formulaRounding.test.ts pins the local twin to Rust's own table). */
function rustInvoker() {
    return vi.fn(async (cmd: string, args: Record<string, unknown>) => {
        if (cmd !== 'convert_legacy_formula') throw new Error(`unexpected ${cmd}`);
        const formula = String(args.formula);
        const converted = convertLegacyRoundLocal(formula);
        return { formula: converted, changed: converted !== formula };
    });
}

describe('convertLegacyFormulaRecipes (before the replay)', () => {
    it('converts every spreadsheet-order round, asks Rust only about formulas that hold a spreadsheet-order round, keeps the rest as stored', async () => {
        const invoke = rustInvoker();
        const recipes: SpecialSensorRecipe[] = [
            F('A', 'round($RAW, 2)'),
            F('B', '$A + 1'),
            { kind: 'operation', tag: 'C', sourceSensors: ['A', 'B'], operationConfig: { mode: 'multi', multiOp: { type: 'mean' } } },
            F('D', 'round($RAW * 100) / 100'),
            F('E', '2 ^ round($B, 1)'),
        ];
        const pass = await convertLegacyFormulaRecipes(recipes, invoke);
        expect(invoke.mock.calls.map(c => c[1].formula)).toEqual(['round($RAW, 2)', '2 ^ round($B, 1)']); // D is already converted: no call
        expect(invoke.mock.calls.every(c => Object.keys(c[1]).join() === 'formula')).toBe(true);
        expect(pass.converted).toEqual([
            { tag: 'A', from: 'round($RAW, 2)', to: 'round($RAW * 100) / 100' },
            { tag: 'E', from: '2 ^ round($B, 1)', to: '2 ^ (round($B * 10) / 10)' },
        ]);
        expect(pass.recipes.map(r => (r.kind === 'formula' ? r.formula : r.tag))).toEqual([
            'round($RAW * 100) / 100', '$A + 1', 'C', 'round($RAW * 100) / 100', '2 ^ (round($B * 10) / 10)',
        ]);
        expect(pass.recipes[1]).toBe(recipes[1]);
    });

    it('nothing to convert: the same array, no conversions (idempotent on the next open)', async () => {
        const invoke = rustInvoker();
        const recipes = [F('A', 'round($RAW * 100) / 100'), F('B', '$A + 1'), F('C', 'round($A)'), F('D', 'round[($A + $B) * 10] / 10'), F('E', '$round, 2')];
        const pass = await convertLegacyFormulaRecipes(recipes, invoke);
        // An ordinary open of already-converted formulas: zero convert_legacy_formula calls.
        expect(invoke).not.toHaveBeenCalled();
        expect(pass).toEqual({ recipes, converted: [] });
        expect(pass.recipes).toBe(recipes);
        expect(await convertLegacyFormulaRecipes(undefined, invoke)).toEqual({ recipes: [], converted: [] });
    });

    it('a failed call (an old backend) leaves that recipe as stored', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const invoke = vi.fn(async () => { throw new Error('unknown command'); });
        const recipes = [F('A', 'round($RAW, 2)')];
        expect(await convertLegacyFormulaRecipes(recipes, invoke)).toEqual({ recipes, converted: [] });
        warn.mockRestore();
    });
});

describe('applyLegacyConversion (the one write: new text + model demotion)', () => {
    const fg = (models: FailureModel[]) => ({
        groups: [], models, runningConditionFilters: [], runningConditionCombine: 'and' as const,
        runningConditionTimePeriods: [{ id: 'w', start: '2025-01-01T00:00', end: '2025-12-31T23:59' }], runningConditionNoneConfirmed: true,
    });
    const trained = (id: string, target: string, complete: boolean): FailureModel => {
        const m = mk({ id, targetSensor: target, category: 'condition' });
        return { ...m, status: complete, lastTrainedAt: '2026-01-01T00:00:00.000Z', trainedFingerprint: computeTrainFingerprint(m, fg([])) };
    };
    const conversions = [{ tag: 'A', from: 'round($RAW, 2)', to: 'round($RAW * 100) / 100' }];

    it('rewrites the recipe and demotes models trained on it or on a sensor built on it', () => {
        const models = [trained('m1', 'A', true), trained('m2', 'B', false), trained('m3', 'RAW', true), mk({ id: 'm4', targetSensor: 'A' })];
        const state = {
            id: 'ws', name: 'W',
            specialSensorRecipes: [F('A', 'round($RAW, 2)'), F('B', '$A * 2')],
            failureGroupState: fg(models),
        } as unknown as WorkspaceState;
        const res = applyLegacyConversion(state, conversions);
        expect(res.applied).toEqual(conversions);
        expect(res.retrain).toEqual(['m1', 'm2']);
        expect(res.state.specialSensorRecipes).toEqual([F('A', 'round($RAW * 100) / 100'), F('B', '$A * 2')]);
        const out = res.state.failureGroupState!.models;
        expect(out[0]).toMatchObject({ id: 'm1', status: false });
        expect(out[0].trainedFingerprint).toBeUndefined();
        expect(out[1].trainedFingerprint).toBeUndefined();
        expect(out[2]).toBe(models[2]);
        expect(out[3]).toBe(models[3]);
        // Idempotent: applied again to the result, nothing more happens.
        expect(applyLegacyConversion(res.state, conversions)).toEqual({ state: res.state, applied: [], retrain: [] });
    });

    it('a recipe edited meanwhile (text is no longer `from`) is left alone', () => {
        const state = { id: 'ws', name: 'W', specialSensorRecipes: [F('A', '$RAW + 1')] } as unknown as WorkspaceState;
        expect(applyLegacyConversion(state, conversions)).toEqual({ state, applied: [], retrain: [] });
    });
});

describe('legacyConversionMessage', () => {
    it('says which sensors, why the values differ, and how many models need training again', () => {
        const one = [{ tag: 'LO_PRESS_MARGIN', from: 'round($A, 2)', to: 'round($A * 100) / 100' }];
        expect(legacyConversionMessage(one, 1)).toBe(
            'Updated the rounding in 1 special sensor (LO_PRESS_MARGIN): the old spreadsheet form round(x, n) is now written round(x * 10ⁿ) / 10ⁿ. '
            + 'Its values differ from what was shown before, because the old form computed them wrongly. 1 model set back to Incomplete — train it again.',
        );
        expect(legacyConversionMessage([...one, { ...one[0], tag: 'B' }], 0)).toMatch(/^Updated the rounding in 2 special sensors \(LO_PRESS_MARGIN, B\).*Their values differ.*wrongly\.$/);
        expect(legacyConversionMessage([], 3)).toBe('');
    });
});
