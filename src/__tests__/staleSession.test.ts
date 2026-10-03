import { describe, it, expect } from 'vitest';
import {
    bindToGeneration, isSessionLostError, isStaleSessionText, StaleSessionError, TaskAbortedError,
    STALE_SESSION_PREFIX,
} from '../utils/staleSession';
import { recomputeSpecialSensors } from '../utils/specialSensorRecompute';
import { replaySpecialSensorRecipes } from '../utils/specialSensorReplay';
import { runSpecialSensorEdit } from '../utils/specialSensorEdit';
import type { SpecialSensorRecipe } from '../types';
import { createFakeRust, STALE_SESSION_ERROR } from './helpers/fakeRustSession';

const F = (tag: string, formula: string): SpecialSensorRecipe => ({ kind: 'formula', tag, formula });

describe('staleSession: detecting the refusal', () => {
    it('matches on the STALE_SESSION prefix, for a bare string (how Tauri rejects) and for an Error', () => {
        expect(isStaleSessionText(STALE_SESSION_ERROR)).toBe(true);
        expect(isStaleSessionText(new Error(`${STALE_SESSION_PREFIX}: anything`))).toBe(true);
        expect(isStaleSessionText('The dataset changed while the sensor was being computed; please try again')).toBe(false);
        expect(isStaleSessionText('not STALE_SESSION: only a prefix counts')).toBe(false);
        expect(isStaleSessionText(undefined)).toBe(false);
    });

    it('"session lost" is a stale refusal OR a task that noticed its window moved on -- nothing else', () => {
        expect(isSessionLostError(new StaleSessionError())).toBe(true);
        expect(isSessionLostError(new TaskAbortedError())).toBe(true);
        expect(isSessionLostError(new Error('boom'))).toBe(false);
        expect(isSessionLostError('STALE_SESSION: x')).toBe(false); // must have gone through bindToGeneration
    });
});

describe('bindToGeneration', () => {
    const recorder = () => {
        const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
        const invoker = async (cmd: string, args: Record<string, unknown>) => { calls.push({ cmd, args }); return 'ok'; };
        return { calls, invoker };
    };

    it('stamps expectedGeneration (camelCase) on exactly the three guarded commands', async () => {
        const { calls, invoker } = recorder();
        const bound = bindToGeneration(invoker, 7);
        await bound('evaluate_formula', { formula: '$A', customName: 'X' });
        await bound('calculate_new_sensor', { sensors: ['A'], config: {} });
        await bound('remove_sensor_columns', { names: ['X'] });
        await bound('extract_formula_refs', { formulas: ['$A'] });
        await bound('rename_formula_refs', { formula: '$A', oldName: 'A', newName: 'B' });
        expect(calls.map(c => [c.cmd, c.args.expectedGeneration])).toEqual([
            ['evaluate_formula', 7], ['calculate_new_sensor', 7], ['remove_sensor_columns', 7],
            ['extract_formula_refs', undefined], ['rename_formula_refs', undefined],
        ]);
        expect(calls.every(c => !('expected_generation' in c.args))).toBe(true);
        // The caller's own arguments are kept.
        expect(calls[0].args).toEqual({ formula: '$A', customName: 'X', expectedGeneration: 7 });
    });

    it('without a generation the arguments are passed through untouched', async () => {
        const { calls, invoker } = recorder();
        await bindToGeneration(invoker, undefined)('evaluate_formula', { formula: '$A' });
        expect(calls[0].args).toEqual({ formula: '$A' });
    });

    it('turns a STALE_SESSION rejection into a StaleSessionError and leaves other failures alone', async () => {
        const stale = bindToGeneration(async () => { throw STALE_SESSION_ERROR; }, 1);
        await expect(stale('remove_sensor_columns', { names: [] })).rejects.toBeInstanceOf(StaleSessionError);
        const other = bindToGeneration(async () => { throw 'disk on fire'; }, 1);
        await expect(other('remove_sensor_columns', { names: [] })).rejects.toBe('disk on fire');
    });
});

describe('a lost session is passed up unwrapped and never rolled back', () => {
    it('recomputeSpecialSensors rethrows the stale error itself (not "Could not recompute ...")', async () => {
        const stale = new StaleSessionError();
        await expect(recomputeSpecialSensors([F('A', '$X')], async () => { throw stale; })).rejects.toBe(stale);
        await expect(recomputeSpecialSensors([F('A', '$X')], async () => { throw new Error('boom'); })).rejects.toThrow(/Could not recompute "A"/);
    });

    it('replaySpecialSensorRecipes stops at the first stale refusal instead of reporting every recipe as failed', async () => {
        const seen: string[] = [];
        const invoker = async (cmd: string, args: Record<string, unknown>) => {
            if (cmd === 'extract_formula_refs') return [[], []];
            seen.push(String(args.customName));
            throw new StaleSessionError();
        };
        await expect(replaySpecialSensorRecipes([F('A', '$X'), F('B', '$X')], invoker)).rejects.toBeInstanceOf(StaleSessionError);
        expect(seen).toEqual(['A']); // B was never tried
    });

    it('runSpecialSensorEdit: a stale refusal on the first write throws as-is and issues NO rollback command', async () => {
        const raw = { headers: ['timestamp', 'X'], columns: [[1, 2, 3]] };
        const rust = createFakeRust(raw);
        await rust.invoke('evaluate_formula', { formula: '$X * 2', customName: 'A' });
        await rust.invoke('evaluate_formula', { formula: '${A} + 1', customName: 'B' });
        rust.calls.length = 0;
        const guarded = bindToGeneration((cmd, args) => rust.invoke(cmd, args), rust.generation() + 5); // not the session's
        const recipes = [F('A', '$X * 2'), F('B', '${A} + 1')];
        await expect(runSpecialSensorEdit({ recipes, next: F('A', '$X * 9'), invoker: guarded })).rejects.toBeInstanceOf(StaleSessionError);
        const mutating = rust.calls.filter(c => ['evaluate_formula', 'calculate_new_sensor', 'remove_sensor_columns'].includes(c.cmd));
        expect(mutating.map(c => [c.cmd, c.error])).toEqual([['evaluate_formula', STALE_SESSION_ERROR]]);
        // Nothing in the session changed.
        expect(rust.resolvedValues('A')).toEqual([2, 4, 6]);
        expect(rust.resolvedValues('B')).toEqual([3, 5, 7]);
    });

    it('runSpecialSensorEdit: a NORMAL failure on a later write still rolls the earlier ones back', async () => {
        const raw = { headers: ['timestamp', 'X'], columns: [[1, 2, 3]] };
        const rust = createFakeRust(raw);
        await rust.invoke('evaluate_formula', { formula: '$X * 2', customName: 'A' });
        await rust.invoke('evaluate_formula', { formula: '${A} + 1', customName: 'B' });
        rust.failOn('evaluate_formula', a => a.customName === 'B' && a.replace === true, 'injected');
        const guarded = bindToGeneration((cmd, args) => rust.invoke(cmd, args), rust.generation());
        const recipes = [F('A', '$X * 2'), F('B', '${A} + 1')];
        await expect(runSpecialSensorEdit({ recipes, next: F('A', '$X * 9'), invoker: guarded })).rejects.toThrow(/Could not recompute "B"/);
        expect(rust.resolvedValues('A')).toEqual([2, 4, 6]); // A put back
    });
});
