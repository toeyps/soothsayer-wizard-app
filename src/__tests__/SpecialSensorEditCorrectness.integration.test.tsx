/**
 * Special sensors — "are the values right after an EDIT?" (qa-agent, 2026-10-08)
 *
 * Customer report: "special sensor บัคเยอะมาก เช็คให้ละเอียดว่าค่าที่ cal
 * ถูกต้องไหม ถ้ามาแก้สมการ หลังจากสร้าง sensor ใหม่ไปแล้ว (function edit) cal
 * ถูกต้องใช่ไหม".
 *
 * Cross-zone seams covered here (each worker's own tests cover their half):
 *
 *  1. Engine -> Rust formula contract: the formula strings `useCalculationEngine`
 *     BUILDS for shortcuts / operator chains / "then apply" wraps must be exactly
 *     the ones `src-tauri/tests/fixtures/special_sensor_formulas.json` lists —
 *     the Rust side (`tests/internal/qa_special_sensor_internal.rs` e01) proves
 *     each of those evaluates to the intended math on every row.
 *  2. SpecialSensorEditor (fe-ui) -> runSpecialSensorEdit (fe-logic) -> the fake
 *     Rust session that holds real column values (`helpers/fakeRustSession.ts`):
 *     an edit typed into the real editor recomputes the sensor AND everything
 *     built on it, checked row by row against an independent JS calculation;
 *     a rename keeps every value; a failed edit rolls the NUMBERS back; and
 *     the recipe list that would be saved, replayed onto a fresh load (the
 *     workspace reopen), reproduces exactly the values that were on screen.
 *  3. Known bugs, first recorded as `it.fails`; all three fixed 2026-10-08
 *     (fe-logic-agent) and flipped to `it` ("regression:").
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, renderHook, act } from '@testing-library/react';
import type { SensorMetadata, SpecialSensorRecipe } from '../types';
import SpecialSensorEditor from '../components/windows/SpecialSensorEditor';
import { useCalculationEngine } from '../hooks/useCalculationEngine';
import { useFormulaEditor } from '../hooks/useFormulaEditor';
import { runSpecialSensorEdit, SpecialSensorEditError } from '../utils/specialSensorEdit';
import { recomputeSpecialSensors } from '../utils/specialSensorRecompute';
import { replaySpecialSensorRecipes } from '../utils/specialSensorReplay';
import { describeRecipe } from '../utils/specialSensorDescribe';
import { createFakeRust, type FakeRust } from './helpers/fakeRustSession';
import fixture from '../../src-tauri/tests/fixtures/special_sensor_formulas.json';
import { pickMulti } from './helpers/sensorPicker';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => ({ valid: true, error: null, referenced_sensors: [] })) }));

// ── 1. Engine -> Rust formula contract ───────────────────────────────────

describe('useCalculationEngine builds exactly the formulas the Rust engine is verified against', () => {
    for (const c of fixture.cases) {
        it(`${c.ref}: ${c.expression}`, () => {
            const { result } = renderHook(() => useCalculationEngine(c.sensors));
            act(() => { c.chainOps.forEach((sym, i) => result.current.setChainOp(i, sym)); });
            if (c.operationId) act(() => result.current.setOperationId(c.operationId));
            if (c.wrapFunc) {
                act(() => result.current.setWrapFunc(c.wrapFunc));
                act(() => result.current.setWrapValue(c.wrapValue));
            }
            const built = result.current.build();
            expect(built).toEqual({ kind: 'formula', expression: c.expression });
        });
    }
});

// ── 2. Editor -> edit flow -> values ─────────────────────────────────────

const N = 48;
/** Deterministic data with missing values, zeros and negatives. */
function rawData() {
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const col = (lo: number, hi: number, missEvery: number, zeroEvery = 0) =>
        Array.from({ length: N }, (_, i) => {
            if (i % missEvery === 3) return NaN;
            if (zeroEvery && i % zeroEvery === 0) return 0;
            return Math.round((lo + (hi - lo) * rnd()) * 1000) / 1000;
        });
    return {
        headers: ['timestamp', 'A', 'B', 'C', 'Flow (m3/h)'],
        columns: [col(-50, 150, 11), col(-5, 5, 13, 7), col(0.1, 10, 17), col(0, 500, 9)],
    };
}

const F = (tag: string, formula: string): SpecialSensorRecipe => ({ kind: 'formula', tag, formula });
const CHAIN: SpecialSensorRecipe[] = [
    F('S1', '$A + ${Flow (m3/h)}'),
    F('S2', '$S1 * 2 - $B'),
    { kind: 'operation', tag: 'S3', sourceSensors: ['S1', 'C'], operationConfig: { mode: 'multi', multiOp: { type: 'mean' }, customName: 'S3' } },
    { kind: 'operation', tag: 'S4', sourceSensors: ['S2'], operationConfig: { mode: 'single', singleOp: { type: 'multiply', value: 3 }, customName: 'S4' } },
];
const META: SensorMetadata[] = CHAIN.map(r => ({ tag: r.tag, description: `${r.tag} desc`, unit: 'u', component: 'Uncategorized' }));

/** Independent reference: missing input -> missing; non-finite -> missing. */
const rowwise = (inputs: number[][], f: (v: number[]) => number): number[] =>
    inputs[0].map((_, r) => {
        const v = inputs.map(c => c[r]);
        if (v.some(Number.isNaN)) return NaN;
        const out = f(v);
        return Number.isFinite(out) ? out : NaN;
    });
const meanSkip = (inputs: number[][]): number[] =>
    inputs[0].map((_, r) => {
        const p = inputs.map(c => c[r]).filter(v => !Number.isNaN(v));
        return p.length ? p.reduce((a, b) => a + b, 0) / p.length : NaN;
    });
function chainReference(raw: ReturnType<typeof rawData>, s1: number[]) {
    const [, B, C] = raw.columns;
    const s2 = rowwise([s1, B], v => v[0] * 2 - v[1]);
    const s3 = meanSkip([s1, C]);
    const s4 = rowwise([s2], v => v[0] * 3);
    return { S1: s1, S2: s2, S3: s3, S4: s4 };
}
function expectClose(got: (number | null)[] | undefined, want: number[], ctx: string) {
    expect(got, ctx).toBeDefined();
    expect(got!.length, ctx).toBe(want.length);
    got!.forEach((g, r) => {
        const w = want[r];
        if (Number.isNaN(w)) expect(g, `${ctx} row ${r}`).toBeNull();
        else expect(g as number, `${ctx} row ${r}`).toBeCloseTo(w, 9);
    });
}

async function sessionWithChain(): Promise<FakeRust> {
    const rust = createFakeRust(rawData());
    await recomputeSpecialSensors(CHAIN, (cmd, args) => rust.invoke(cmd, args));
    return rust;
}

/** Open the REAL editor on `recipe`, apply `edit`, press Save, return what it hands the window. */
function editInEditor(recipe: SpecialSensorRecipe, edit: () => void, availableSensors: string[]) {
    const onSave = vi.fn();
    const view = render(
        <SpecialSensorEditor
            recipe={recipe}
            sensorMetadata={META}
            availableSensors={availableSensors}
            onCancel={vi.fn()}
            onSave={onSave}
            saving={false}
            error={null}
        />,
    );
    edit();
    fireEvent.click(screen.getByText('Save changes'));
    view.unmount();
    expect(onSave).toHaveBeenCalledTimes(1);
    return onSave.mock.calls[0][0] as { recipe: SpecialSensorRecipe; metadata: SensorMetadata; renamedFrom?: string };
}

const ALL = ['A', 'B', 'C', 'Flow (m3/h)', 'S1', 'S2', 'S3', 'S4'];

describe('editing a special sensor after creation: every value equals a fresh calculation', () => {
    it('create: the chain S1 -> S2 -> S3 (mean) -> S4 (x3) has the right values', async () => {
        const rust = await sessionWithChain();
        const raw = rawData();
        const want = chainReference(raw, rowwise([raw.columns[0], raw.columns[3]], v => v[0] + v[1]));
        for (const tag of ['S1', 'S2', 'S3', 'S4'] as const) expectClose(rust.chartValues(tag), want[tag], `create ${tag}`);
    });

    it('edit S1’s formula in the real editor: S1 and every sensor built on it (S2, S3, S4) are recomputed correctly; the saved list replays to the same values after reopen', async () => {
        const rust = await sessionWithChain();
        const invoker = (cmd: string, args: Record<string, unknown>) => rust.invoke(cmd, args);
        const payload = editInEditor(CHAIN[0], () => {
            fireEvent.change(screen.getByLabelText('Formula'), { target: { value: '  ($A - ${Flow (m3/h)}) / 2  ' } });
        }, ALL);
        expect(payload.recipe).toEqual(F('S1', '($A - ${Flow (m3/h)}) / 2')); // trimmed, same tag
        expect(payload.renamedFrom).toBeUndefined();

        const outcome = await runSpecialSensorEdit({ recipes: CHAIN, next: payload.recipe, invoker });
        const saved = outcome.applyEdit(CHAIN);

        const raw = rawData();
        const want = chainReference(raw, rowwise([raw.columns[0], raw.columns[3]], v => (v[0] - v[1]) / 2));
        for (const tag of ['S1', 'S2', 'S3', 'S4'] as const) expectClose(rust.chartValues(tag), want[tag], `after edit ${tag}`);
        // Exactly one column per sensor, nothing appended.
        for (const tag of ['S1', 'S2', 'S3', 'S4']) expect(rust.columnCount(tag)).toBe(1);

        // The saved recipe IS what was computed: replay it onto a fresh load.
        const onScreen = Object.fromEntries(['S1', 'S2', 'S3', 'S4'].map(t => [t, rust.chartValues(t)]));
        await rust.invoke('load_csv', { paths: ['reopen.csv'] });
        expect(rust.has('S1')).toBe(false);
        const res = await replaySpecialSensorRecipes(saved, invoker);
        expect(res).toEqual({ failed: [], skipped: [] });
        for (const t of ['S1', 'S2', 'S3', 'S4']) expect(rust.chartValues(t), `reopen ${t}`).toEqual(onScreen[t]);
        // And the formula shown after reopen is the one that was saved.
        expect(describeRecipe(saved.find(r => r.tag === 'S1')!)).toBe('($A - ${Flow (m3/h)}) / 2');
    });

    it('edit the operation S3 (mean -> median of three) through the real editor and S3 is recomputed correctly', async () => {
        const rust = await sessionWithChain();
        const invoker = (cmd: string, args: Record<string, unknown>) => rust.invoke(cmd, args);
        const payload = editInEditor(CHAIN[2], () => {
            pickMulti(screen.getByRole('button', { name: 'Add source sensors…' }), ['A']);
            fireEvent.click(screen.getByText('Median')); // Average (kept for the 3 sources) -> Median
        }, ALL);
        expect(payload.recipe).toMatchObject({ kind: 'operation', sourceSensors: ['S1', 'C', 'A'], operationConfig: { mode: 'multi', multiOp: { type: 'median' } } });
        await runSpecialSensorEdit({ recipes: CHAIN, next: payload.recipe, invoker });

        const raw = rawData();
        const s1 = rowwise([raw.columns[0], raw.columns[3]], v => v[0] + v[1]);
        const want = s1.map((_, r) => {
            const p = [s1[r], raw.columns[2][r], raw.columns[0][r]].filter(v => !Number.isNaN(v)).sort((a, b) => a - b);
            if (!p.length) return NaN;
            const m = Math.floor(p.length / 2);
            return p.length % 2 ? p[m] : (p[m - 1] + p[m]) / 2;
        });
        expectClose(rust.chartValues('S3'), want, 'S3 median');
    });

    it('rename S1 -> "ความเร็ว รวม" in the real editor: dependents are rewritten to the new name, every value is unchanged, the old column is gone', async () => {
        const rust = await sessionWithChain();
        const invoker = (cmd: string, args: Record<string, unknown>) => rust.invoke(cmd, args);
        const before = Object.fromEntries(['S1', 'S2', 'S3', 'S4'].map(t => [t, rust.chartValues(t)]));
        const payload = editInEditor(CHAIN[0], () => {
            fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'ความเร็ว รวม' } });
        }, ALL);
        expect(payload.renamedFrom).toBe('S1');
        const outcome = await runSpecialSensorEdit({ recipes: CHAIN, next: payload.recipe, oldTag: payload.renamedFrom, invoker });
        await invoker('remove_sensor_columns', { names: ['S1'] }); // the window's LAST step
        const saved = outcome.applyEdit(CHAIN);

        expect(saved.find(r => r.tag === 'S2')).toEqual(F('S2', '${ความเร็ว รวม} * 2 - $B'));
        expect(saved.find(r => r.tag === 'S3')).toMatchObject({ sourceSensors: ['ความเร็ว รวม', 'C'] });
        expect(rust.has('S1')).toBe(false);
        expect(rust.chartValues('ความเร็ว รวม')).toEqual(before.S1);
        for (const t of ['S2', 'S3', 'S4']) expect(rust.chartValues(t), t).toEqual(before[t]);

        await rust.invoke('load_csv', { paths: ['reopen.csv'] });
        expect(await replaySpecialSensorRecipes(saved, invoker)).toEqual({ failed: [], skipped: [] });
        expect(rust.chartValues('ความเร็ว รวม')).toEqual(before.S1);
        for (const t of ['S2', 'S3', 'S4']) expect(rust.chartValues(t), `reopen ${t}`).toEqual(before[t]);
    });

    it('an edit that fails part-way (S3 cannot be recomputed) puts the NUMBERS of S1 and S2 back, not just the recipes', async () => {
        const rust = await sessionWithChain();
        const invoker = (cmd: string, args: Record<string, unknown>) => rust.invoke(cmd, args);
        const before = Object.fromEntries(['S1', 'S2', 'S3', 'S4'].map(t => [t, rust.chartValues(t)]));
        rust.failOn('calculate_new_sensor', a => (a.config as { customName?: string })?.customName === 'S3', 'disk full');
        const err = await runSpecialSensorEdit({ recipes: CHAIN, next: F('S1', '$A * 1000'), invoker }).catch(e => e);
        expect(err).toBeInstanceOf(SpecialSensorEditError);
        expect((err as SpecialSensorEditError).touched).toBe(true);
        expect((err as SpecialSensorEditError).rolledBack).toBe(true);
        for (const t of ['S1', 'S2', 'S3', 'S4']) expect(rust.chartValues(t), t).toEqual(before[t]);
    });

    it('edit then edit back ("undo by hand") restores every value exactly', async () => {
        const rust = await sessionWithChain();
        const invoker = (cmd: string, args: Record<string, unknown>) => rust.invoke(cmd, args);
        const before = Object.fromEntries(['S1', 'S2', 'S3', 'S4'].map(t => [t, rust.chartValues(t)]));
        const first = await runSpecialSensorEdit({ recipes: CHAIN, next: F('S1', '$A * $A'), invoker });
        const edited = first.applyEdit(CHAIN);
        await runSpecialSensorEdit({ recipes: edited, next: CHAIN[0], invoker });
        for (const t of ['S1', 'S2', 'S3', 'S4']) expect(rust.chartValues(t), t).toEqual(before[t]);
    });
});

// ── 3. Known bugs ─────────────────────────────────────────────────────────

describe('known bugs, fixed 2026-10-08 (were it.fails)', () => {
    /**
     * BUG (MEDIUM, fe-ui-agent — SpecialSensorEditor.tsx, the `prevSourcesKey`
     * effect that calls `engine.setOperationId(null)` on ANY source change):
     * open an "Average all" sensor, add one more source, Save. The Average
     * shortcut was silently cleared when the source list changed, so the form
     * falls back to the default "+" operator chain and the saved sensor becomes
     * A + B + C (a SUM) — the values roughly triple with no warning. Same for
     * Sum/Median, and for removing a source from a 3-source average. Fix: only
     * reset when the operation no longer applies — the op group changed
     * (single <-> multi) or a base-sensor op lost its base — and keep
     * sum/mean/median (and a single op when one source is swapped for another).
     */
    it('regression: adding a source to an "Average all" sensor keeps it an average (not a silent switch to A + B + C)', () => {
        const avg: SpecialSensorRecipe = {
            kind: 'operation', tag: 'Avg', sourceSensors: ['A', 'B'],
            operationConfig: { mode: 'multi', multiOp: { type: 'mean' }, customName: 'Avg' },
        };
        const payload = editInEditor(avg, () => {
            pickMulti(screen.getByRole('button', { name: 'Add source sensors…' }), ['C']);
            fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'avg' } });
            fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'u' } });
            fireEvent.change(screen.getByLabelText('Component'), { target: { value: 'Uncategorized' } });
        }, ['A', 'B', 'C']);
        expect(payload.recipe).toEqual({
            kind: 'operation', tag: 'Avg', sourceSensors: ['A', 'B', 'C'],
            operationConfig: { mode: 'multi', multiOp: { type: 'mean' }, customName: 'Avg' },
        });
    });

    /**
     * BUG (LOW, fe-logic-agent — useFormulaEditor.ts `referencedSensors` uses
     * `/\$\{([^}]+)\}|\$(\w+)/g`): `\w` is ASCII-only and has no `.`, so the
     * "Referenced sensors" chips under the Create formula box disagree with the
     * Rust tokenizer — `$11PT1214A.PV` is listed as `11PT1214A` (a DIFFERENT
     * real sensor) and a bare Thai name is not listed at all. Display only (Rust
     * computes the right thing), but it tells the user the wrong sensor is used.
     * Fix: derive the chips from the same grammar as `scan_sensor_refs` (the
     * Unicode `PARTIAL_REF` class already in this file, plus `.`), or from the
     * `referenced_sensors` the `validate_formula` reply already carries.
     */
    it('regression: the "Referenced sensors" list follows the Rust grammar (dotted and Thai bare names)', () => {
        const { result } = renderHook(() => useFormulaEditor([]));
        act(() => result.current.setFormula('$11PT1214A.PV - $อุณหภูมิ'));
        expect(result.current.referencedSensors).toEqual(['11PT1214A.PV', 'อุณหภูมิ']);
    });

    /**
     * BUG (LOW, fe-logic-agent — utils/specialSensorDescribe.ts): "Round to
     * decimals" is described as `round(TAG1)` with the decimal count dropped, so
     * the Manage list and the LOCKED editor (which shows only this text) cannot
     * tell "round to 0" from "round to 3". Fix: `round(${sources}, ${op.value} dp)`
     * (or similar) for `round`.
     */
    it('regression: describeRecipe shows how many decimals a "Round to decimals" sensor keeps', () => {
        const r: SpecialSensorRecipe = {
            kind: 'operation', tag: 'R', sourceSensors: ['TAG1'],
            operationConfig: { mode: 'single', singleOp: { type: 'round', value: 2 }, customName: 'R' },
        };
        expect(describeRecipe(r)).toBe('round(TAG1) to 2 decimals');
    });
});
