import { describe, it, expect, vi } from 'vitest';
import { replaySpecialSensorRecipes } from '../utils/specialSensorReplay';
import type { SpecialSensorRecipe } from '../types';

const formula = (tag: string, f: string): SpecialSensorRecipe => ({ kind: 'formula', tag, formula: f });
const op = (tag: string, sources: string[]): SpecialSensorRecipe => ({
    kind: 'operation', tag, sourceSensors: sources,
    operationConfig: { mode: 'multi', multiOp: { type: 'sum' } },
});

/** A fake backend: `extract_formula_refs` answers from a table, every other
 *  command succeeds unless its target name is in `failing`. */
function fakeBackend(refs: Record<string, string[]>, failing: string[] = []) {
    const calls: Array<{ cmd: string; args: any }> = [];
    const invoker = vi.fn(async (cmd: string, args: any) => {
        calls.push({ cmd, args });
        if (cmd === 'extract_formula_refs') return (args.formulas as string[]).map(f => refs[f] ?? []);
        const target = cmd === 'evaluate_formula' ? args.customName : args.config.customName;
        if (failing.includes(target)) throw new Error(`Sensor not found for ${target}`);
        return target;
    });
    const built = () => calls.filter(c => c.cmd !== 'extract_formula_refs').map(c => c.args.customName ?? c.args.config.customName);
    return { invoker, calls, built };
}

describe('replaySpecialSensorRecipes', () => {
    it('rebuilds every recipe, forcing the recipe tag as the name and replace: true', async () => {
        const b = fakeBackend({ '$TAG1 * 2': ['TAG1'] });
        const r = await replaySpecialSensorRecipes([formula('A', '$TAG1 * 2'), op('B', ['TAG1', 'A'])], b.invoker);
        expect(r).toEqual({ failed: [], skipped: [] });
        expect(b.calls.find(c => c.cmd === 'evaluate_formula')!.args).toEqual({ formula: '$TAG1 * 2', customName: 'A', replace: true });
        expect(b.calls.find(c => c.cmd === 'calculate_new_sensor')!.args.replace).toBe(true);
    });

    it('replays in DEPENDENCY order even when the stored array is not one (an old edit could leave a sensor before the one it reads)', async () => {
        const b = fakeBackend({ '$C * 2': ['C'], '$TAG1 + 1': ['TAG1'] });
        await replaySpecialSensorRecipes([formula('A', '$C * 2'), formula('C', '$TAG1 + 1')], b.invoker);
        expect(b.built()).toEqual(['C', 'A']);
    });

    it('keeps array order when there is nothing to reorder', async () => {
        const b = fakeBackend({ x: ['TAG1'], y: ['TAG1'], z: ['TAG1'] });
        await replaySpecialSensorRecipes([formula('Z', 'z'), formula('X', 'x'), formula('Y', 'y')], b.invoker);
        expect(b.built()).toEqual(['Z', 'X', 'Y']);
    });

    it('a recipe that fails is reported, and the ones after it that do not need it still run', async () => {
        const b = fakeBackend({ '$GONE + 1': ['GONE'], '$TAG1 * 2': ['TAG1'] }, ['BROKEN']);
        const r = await replaySpecialSensorRecipes([formula('BROKEN', '$GONE + 1'), formula('OK', '$TAG1 * 2')], b.invoker);
        expect(r.failed).toEqual(['BROKEN']);
        expect(r.skipped).toEqual([]);
        expect(b.built()).toEqual(['BROKEN', 'OK']);
    });

    it('a recipe built ON a failed one is SKIPPED (never attempted), transitively, and reported separately from the failure', async () => {
        const b = fakeBackend(
            { '$GONE + 1': ['GONE'], '${BROKEN} * 2': ['BROKEN'], '${MID} - 1': ['MID'], '$TAG1': ['TAG1'] },
            ['BROKEN'],
        );
        const r = await replaySpecialSensorRecipes([
            formula('BROKEN', '$GONE + 1'),
            formula('MID', '${BROKEN} * 2'),
            formula('TOP', '${MID} - 1'),
            op('OPDEP', ['broken', 'TAG1']), // operation recipes depend via sourceSensors, case-insensitively
            formula('FINE', '$TAG1'),
        ], b.invoker);
        expect(r.failed).toEqual(['BROKEN']);
        expect(r.skipped).toEqual(['MID', 'TOP', 'OPDEP']);
        // The skipped ones were never sent to the backend.
        expect(b.built()).toEqual(['BROKEN', 'FINE']);
    });

    it('falls back to plain array order, attempting everything, when the dependency lookup fails -- a workspace must still open', async () => {
        const calls: string[] = [];
        const invoker = vi.fn(async (cmd: string, args: any) => {
            if (cmd === 'extract_formula_refs') throw new Error('lookup down');
            calls.push(args.customName);
            return args.customName;
        });
        const r = await replaySpecialSensorRecipes([formula('A', '$TAG1'), formula('B', '${A}')], invoker);
        expect(r).toEqual({ failed: [], skipped: [] });
        expect(calls).toEqual(['A', 'B']);
    });

    it('tolerates a lookup that answers with something unusable', async () => {
        const calls: string[] = [];
        const invoker = vi.fn(async (cmd: string, args: any) => {
            if (cmd === 'extract_formula_refs') return null;
            calls.push(args.customName);
            return args.customName;
        });
        await replaySpecialSensorRecipes([formula('A', '$TAG1')], invoker);
        expect(calls).toEqual(['A']);
    });

    it('does not look anything up when there is no formula recipe', async () => {
        const b = fakeBackend({});
        await replaySpecialSensorRecipes([op('A', ['TAG1'])], b.invoker);
        expect(b.calls.some(c => c.cmd === 'extract_formula_refs')).toBe(false);
    });
});
