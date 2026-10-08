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

// 2026-10-08: Rust now REFUSES a formula with an unknown name/function (it
// used to accept it and silently produce an all-empty sensor). A workspace
// saved before that can hold such a recipe; on reopen it must fail like any
// other broken recipe -- with Rust's reason -- not break the load.
describe('replaySpecialSensorRecipes: a formula Rust now refuses (against the fake Rust gate)', () => {
    const raw = () => ({ headers: ['timestamp', 'A', 'B'], columns: [[1, 2, 3], [4, 5, 6]] });

    it('reports the recipe as failed with Rust’s message, skips what is built on it, still builds the rest', async () => {
        const { createFakeRust } = await import('./helpers/fakeRustSession');
        const rust = createFakeRust(raw());
        const invoker = (cmd: string, args: Record<string, unknown>) => rust.invoke(cmd, args);
        const r = await replaySpecialSensorRecipes([
            formula('Circle', '$A * pi'),
            formula('Twice', '${Circle} * 2'),
            formula('Ok', '$A + $B'),
        ], invoker);
        expect(r.failed).toEqual(['Circle']);
        expect(r.skipped).toEqual(['Twice']);
        expect(r.errors).toEqual({ Circle: "Formula error: unknown name 'pi'. Write pi() for π." });
        expect(rust.has('Circle')).toBe(false);
        expect(rust.chartValues('Ok')).toEqual([5, 7, 9]);
    });

    it('carries no `errors` when everything rebuilt', async () => {
        const { createFakeRust } = await import('./helpers/fakeRustSession');
        const rust = createFakeRust(raw());
        const r = await replaySpecialSensorRecipes([formula('Ok', '$A + $B')], (cmd, args) => rust.invoke(cmd, args));
        expect(r).toStrictEqual({ failed: [], skipped: [] });
    });
});

// The fake session's formula gate must keep matching lib.rs `compile_formula`
// for the cases frontend tests rely on (the Rust unit tests pin the originals).
describe('fake Rust formula gate mirrors lib.rs messages', () => {
    const cases: [string, string | null][] = [
        ['$A * pi', "Formula error: unknown name 'pi'. Write pi() for π."],
        ['$A * e', "Formula error: unknown name 'e'. Write e() for Euler's number (2.718…)."],
        ['$A + x', "Formula error: unknown name 'x'. Write sensors as $Name, or ${Name} when the name has spaces or symbols."],
        ['sqr($A)', "Formula error: unknown function 'sqr'. Available functions: abs, sqrt, pow, exp, ln, log (base 10), log10, round, min, max, ceil, floor, sin, cos, tan, pi(), e()."],
        ['$A(2)', 'Formula error: $A is a sensor, not a function. Put an operator before the bracket, e.g. $A * (…).'],
        ['round($A, 2)', 'Formula error: round($A, 2) does not round to 2 decimal places. Write round($A * 100) / 100 instead.'],
        ['round($A + $B, 1)', 'Formula error: round($A + $B, 1) does not round to 1 decimal place. Write round(($A + $B) * 10) / 10 instead.'],
        ['round($A, 0)', 'Formula error: round($A, 0) is not supported. Write round($A) to round to a whole number.'],
        ['round($A)', null],
        ['round(0.01, $A)', null],
        ['round($A, $B)', null],
        ['round(($A + $B) * 100) / 100', null],
        ['ln($A) + log($B) + $A * pi() + e()', null],
    ];
    for (const [f, want] of cases) {
        it(f, async () => {
            const { createFakeRust } = await import('./helpers/fakeRustSession');
            const rust = createFakeRust({ headers: ['timestamp', 'A', 'B'], columns: [[1, 2], [3, 4]] });
            const v = await rust.invoke('validate_formula', { formula: f }) as { valid: boolean; error: string | null };
            expect(v.error).toBe(want);
            expect(v.valid).toBe(want === null);
            if (want) await expect(rust.invoke('evaluate_formula', { formula: f, customName: 'X' })).rejects.toBe(want);
        });
    }
    it('a parse error carries the "Formula parse error:" prefix', async () => {
        const { createFakeRust } = await import('./helpers/fakeRustSession');
        const rust = createFakeRust({ headers: ['timestamp', 'A'], columns: [[1]] });
        const v = await rust.invoke('validate_formula', { formula: '$A +' }) as { error: string };
        expect(v.error).toMatch(/^Formula parse error: /);
    });
});
