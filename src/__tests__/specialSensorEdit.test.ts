import { describe, it, expect } from 'vitest';
import type { SpecialSensorRecipe } from '../types';
import { runSpecialSensorEdit, SpecialSensorEditError } from '../utils/specialSensorEdit';
import { createFakeRust } from './helpers/fakeRustSession';

const F = (tag: string, formula: string): SpecialSensorRecipe => ({ kind: 'formula', tag, formula });
const SUM = (tag: string, sources: string[]): SpecialSensorRecipe =>
    ({ kind: 'operation', tag, sourceSensors: sources, operationConfig: { mode: 'multi', multiOp: { type: 'sum' }, customName: tag } });

const RAW = { headers: ['timestamp', 'TAG1', 'TAG3'], columns: [[1, 2, 3, 4], [100, 200, 300, 400]] };

/** A session that already holds every recipe's column (what the window has). */
async function session(recipes: SpecialSensorRecipe[]) {
    const rust = createFakeRust(RAW);
    for (const r of recipes) {
        if (r.kind === 'formula') await rust.invoke('evaluate_formula', { formula: r.formula, customName: r.tag });
        else await rust.invoke('calculate_new_sensor', { sensors: r.sourceSensors, config: { ...r.operationConfig, customName: r.tag } });
    }
    rust.calls.length = 0;
    return rust;
}
const run = (rust: Awaited<ReturnType<typeof session>>, args: Omit<Parameters<typeof runSpecialSensorEdit>[0], 'invoker'>) =>
    runSpecialSensorEdit({ ...args, invoker: (cmd, a) => rust.invoke(cmd, a) });

const CHAIN = [F('A', '$TAG1 * 2'), F('B', '${A} + 1'), SUM('C', ['A', 'TAG3'])];

describe('runSpecialSensorEdit -- recompute order', () => {
    it('recomputes the edited sensor first, then everything built on it, in BUILD order even when the stored list is not in build order (a workspace saved before the ordering fix)', async () => {
        // Stored: [C = $B*10, B = ${A}+1, A = $TAG1*2] -- C before B before A.
        const stored = [F('C', '$B * 10'), F('B', '${A} + 1'), F('A', '$TAG1 * 2')];
        const rust = await session([stored[2], stored[1], stored[0]]);
        const outcome = await run(rust, { recipes: stored, next: F('A', '$TAG1 * 3') });
        const order = rust.cmds('evaluate_formula').filter(c => c.args.replace).map(c => c.args.customName);
        expect(order).toEqual(['A', 'B', 'C']);
        expect(rust.resolvedValues('C')).toEqual([40, 70, 100, 130]); // B's NEW values, not its old ones
        expect(outcome.downstream.map(r => r.tag)).toEqual(['B', 'C']);
    });

    it('works for downstream operation recipes too', async () => {
        const rust = await session(CHAIN);
        await run(rust, { recipes: CHAIN, next: F('A', '$TAG1 * 3') });
        expect(rust.resolvedValues('C')).toEqual([103, 206, 309, 412]);
    });

    it('reads the references of EVERY recipe fresh from Rust (never a cached map): a cycle through a just-edited recipe is refused', async () => {
        // The list already says A = $C * 2 (a previous edit), C = $TAG3 + 1.
        const recipes = [F('A', '$C * 2'), F('C', '$TAG3 + 1')];
        const rust = await session([recipes[1], recipes[0]]);
        await expect(run(rust, { recipes, next: F('C', '$A + 1') })).rejects.toThrow(/depend on itself/);
        expect(rust.calls.filter(c => c.args?.replace)).toHaveLength(0); // nothing was written
    });

    it('refuses a formula that references no sensor, before writing anything', async () => {
        const rust = await session(CHAIN);
        await expect(run(rust, { recipes: CHAIN, next: F('A', '42') })).rejects.toThrow(/doesn't reference any sensor/);
        expect(rust.calls.filter(c => c.args?.replace)).toHaveLength(0);
    });

    it('a failed reference lookup refuses the edit (nothing changed) rather than guessing what is built on the sensor', async () => {
        const rust = await session(CHAIN);
        rust.failOn('extract_formula_refs', () => true, 'lookup down');
        const err = await run(rust, { recipes: CHAIN, next: F('A', '$TAG1 * 3') }).catch(e => e);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(/Still working out which sensors/);
        expect(rust.calls.filter(c => c.args?.replace)).toHaveLength(0);
    });

    it('reports a recipeOrder only when the edit made the stored order an invalid build order', async () => {
        const recipes = [F('A', '$TAG1 * 2'), F('C', '$TAG3 + 1')];
        const rust = await session(recipes);
        const early = await run(rust, { recipes, next: F('A', '$C * 2') });
        expect(early.recipeOrder).toEqual(['C', 'A']);
        const rust2 = await session(recipes);
        const same = await run(rust2, { recipes, next: F('A', '$TAG1 * 5') });
        expect(same.recipeOrder).toBeUndefined();
    });

    it('a rename is carried into every downstream recipe before it is replayed', async () => {
        const rust = await session(CHAIN);
        const outcome = await run(rust, { recipes: CHAIN, next: F('A2', '$TAG1 * 2'), oldTag: 'A' });
        expect(outcome.renamedDownstream.map(r => (r.kind === 'formula' ? r.formula : r.sourceSensors.join(',')))).toEqual(['$A2 + 1', 'A2,TAG3']);
        expect(rust.resolvedValues('B')).toEqual([3, 5, 7, 9]);
        // The old column is the CALLER's last step -- this function leaves it.
        expect(rust.has('A')).toBe(true);
        expect(rust.has('A2')).toBe(true);
    });
});

describe('runSpecialSensorEdit -- rollback when a step fails part-way', () => {
    it('edit A, then recomputing C fails: A and B are put back to their ORIGINAL formulas\' values, the error says which sensor failed, and the caller is told columns were touched', async () => {
        const rust = await session(CHAIN);
        const before = { A: rust.resolvedValues('A'), B: rust.resolvedValues('B'), C: rust.resolvedValues('C') };
        rust.failOn('calculate_new_sensor', a => a.config.customName === 'C', 'injected');
        const err = await run(rust, { recipes: CHAIN, next: F('A', '$TAG1 * 3') }).catch(e => e);
        expect(err).toBeInstanceOf(SpecialSensorEditError);
        const e = err as SpecialSensorEditError;
        expect(e.message).toMatch(/Could not recompute "C"/);
        expect(e.touched).toBe(true);
        expect(e.rolledBack).toBe(true);
        expect(e.inconsistent).toEqual([]);
        expect({ A: rust.resolvedValues('A'), B: rust.resolvedValues('B'), C: rust.resolvedValues('C') }).toEqual(before);
    });

    it('rollback recomputes the ORIGINAL definitions in build order with replace: true', async () => {
        const rust = await session(CHAIN);
        rust.failOn('calculate_new_sensor', a => a.config.customName === 'C', 'injected');
        await run(rust, { recipes: CHAIN, next: F('A', '$TAG1 * 3') }).catch(() => {});
        const writes = rust.calls.filter(c => c.args?.replace && !c.error).map(c =>
            `${c.cmd === 'evaluate_formula' ? c.args.customName : c.args.config.customName}:${c.args.formula ?? ''}`);
        expect(writes).toEqual(['A:$TAG1 * 3', 'B:${A} + 1', 'A:$TAG1 * 2', 'B:${A} + 1']);
    });

    it('a failure on the very FIRST write changes nothing and needs no rollback', async () => {
        const rust = await session(CHAIN);
        rust.failOn('evaluate_formula', a => a.customName === 'A' && a.replace === true, 'injected');
        const err = await run(rust, { recipes: CHAIN, next: F('A', '$TAG1 * 3') }).catch(e => e) as SpecialSensorEditError;
        expect(err.touched).toBe(false);
        expect(rust.calls.filter(c => c.args?.replace && !c.error)).toHaveLength(0);
    });

    it('a rename that fails part-way drops the half-built NEW column and leaves the old one and every dependent as they were', async () => {
        const rust = await session(CHAIN);
        const before = { A: rust.resolvedValues('A'), B: rust.resolvedValues('B') };
        rust.failOn('calculate_new_sensor', a => a.config.customName === 'C', 'injected');
        const err = await run(rust, { recipes: CHAIN, next: F('A2', '$TAG1 * 3'), oldTag: 'A' }).catch(e => e) as SpecialSensorEditError;
        expect(err.rolledBack).toBe(true);
        expect(rust.has('A2')).toBe(false);
        expect({ A: rust.resolvedValues('A'), B: rust.resolvedValues('B') }).toEqual(before);
        // B was never left reading a name that no recipe holds.
        expect(rust.cmds('remove_sensor_columns').map(c => c.args.names)).toEqual([['A2']]);
    });

    it('a case-only rename that fails part-way restores the original column (and its original casing) instead of removing it', async () => {
        const rust = await session(CHAIN);
        rust.failOn('calculate_new_sensor', a => a.config.customName === 'C', 'injected');
        await run(rust, { recipes: CHAIN, next: F('a', '$TAG1 * 3'), oldTag: 'A' }).catch(() => {});
        expect(rust.columnCount('a')).toBe(1);
        expect(rust.headers()).toContain('A');
        expect(rust.cmds('remove_sensor_columns')).toHaveLength(0);
        expect(rust.resolvedValues('A')).toEqual([2, 4, 6, 8]);
    });

    it('if the targeted rollback itself fails it falls back to a FULL re-sync from the recipes', async () => {
        const rust = await session(CHAIN);
        // C fails during the edit; then the rollback's first write (A) fails once, so the targeted path breaks.
        rust.failOn('calculate_new_sensor', a => a.config.customName === 'C', 'injected', true);
        let aWrites = 0;
        rust.failOn('evaluate_formula', a => a.customName === 'A' && a.replace === true && ++aWrites === 2, 'rollback hiccup', true);
        const err = await run(rust, { recipes: CHAIN, next: F('A', '$TAG1 * 3') }).catch(e => e) as SpecialSensorEditError;
        expect(err.inconsistent).toEqual([]); // the full replay put everything back
        expect(rust.resolvedValues('A')).toEqual([2, 4, 6, 8]);
        expect(rust.resolvedValues('B')).toEqual([3, 5, 7, 9]);
        expect(rust.resolvedValues('C')).toEqual([102, 204, 306, 408]);
    });

    it('if even the full re-sync fails, the error names the sensors that may hold wrong values (never silent)', async () => {
        const rust = await session(CHAIN);
        rust.failOn('calculate_new_sensor', a => a.config.customName === 'C', 'injected', false); // C always fails
        rust.failOn('evaluate_formula', a => a.customName === 'A' && a.replace === true && a.formula === '$TAG1 * 2', 'cannot restore', false);
        const err = await run(rust, { recipes: CHAIN, next: F('A', '$TAG1 * 3') }).catch(e => e) as SpecialSensorEditError;
        expect(err.rolledBack).toBe(false);
        expect(err.inconsistent).toEqual(expect.arrayContaining(['A', 'B', 'C']));
    });

    it('the arguments are never mutated', async () => {
        const rust = await session(CHAIN);
        const snapshot = structuredClone(CHAIN);
        await run(rust, { recipes: CHAIN, next: F('A2', '$TAG1 * 2'), oldTag: 'A' });
        expect(CHAIN).toEqual(snapshot);
    });
});

describe('runSpecialSensorEdit -- outcome', () => {
    it('applyEdit swaps in the edited recipe and the rewritten downstream ones, leaves the rest', async () => {
        const rust = await session([...CHAIN, F('Z', '$TAG3 + 1')]);
        const list = [...CHAIN, F('Z', '$TAG3 + 1')];
        const outcome = await run(rust, { recipes: list, next: F('A2', '$TAG1 * 2'), oldTag: 'A' });
        const applied = outcome.applyEdit(list);
        expect(applied.map(r => r.tag)).toEqual(['A2', 'B', 'C', 'Z']);
        expect((applied[1] as { formula: string }).formula).toBe('$A2 + 1');
        expect(applied[3]).toBe(list[3]);
    });
});
