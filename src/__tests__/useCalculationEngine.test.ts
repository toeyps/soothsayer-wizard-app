import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useCalculationEngine, FORMULA_MULTI_IDS, sourceChangeEffect } from '../hooks/useCalculationEngine';

describe('useCalculationEngine', () => {
    // ── opGroup derivation ───────────────────────────────────────────

    it('reports opGroup "single" for 0 or 1 selected sensors', () => {
        const { result: r0 } = renderHook(() => useCalculationEngine([]));
        expect(r0.current.opGroup).toBe('single');

        const { result: r1 } = renderHook(() => useCalculationEngine(['A']));
        expect(r1.current.opGroup).toBe('single');
    });

    it('reports opGroup "multi" for 2+ selected sensors', () => {
        const { result } = renderHook(() => useCalculationEngine(['A', 'B']));
        expect(result.current.opGroup).toBe('multi');
    });

    // ── setOperationId ───────────────────────────────────────────────

    it('defaults value to 2 when picking "round", 0 for everything else', () => {
        const { result } = renderHook(() => useCalculationEngine(['A']));

        act(() => result.current.setOperationId('round'));
        expect(result.current.value).toBe(2);

        act(() => result.current.setOperationId('add'));
        expect(result.current.value).toBe(0);
    });

    it('seeds baseSensor with the first selected sensor when picking a base-needing op', () => {
        const { result } = renderHook(() => useCalculationEngine(['A', 'B']));
        act(() => result.current.setOperationId('efficiency_pct'));
        expect(result.current.baseSensor).toBe('A');
    });

    it('keeps the current baseSensor if it is still among the selected sensors', () => {
        const { result } = renderHook(() => useCalculationEngine(['A', 'B']));
        act(() => result.current.setBaseSensor('B'));
        act(() => result.current.setOperationId('efficiency_pct'));
        expect(result.current.baseSensor).toBe('B');
    });

    it('does not touch baseSensor for ops that do not need one', () => {
        const { result } = renderHook(() => useCalculationEngine(['A', 'B']));
        act(() => result.current.setOperationId('sum'));
        expect(result.current.baseSensor).toBe('');
    });

    // ── setChainOp ───────────────────────────────────────────────────

    it('setChainOp records the operator at the given index', () => {
        const { result } = renderHook(() => useCalculationEngine(['A', 'B', 'C']));
        act(() => result.current.setChainOp(0, '×'));
        act(() => result.current.setChainOp(1, '−'));
        expect(result.current.chainOps).toEqual(['×', '−']);
    });

    it('setChainOp clears any active shortcut and baseSensor (mutually exclusive)', () => {
        const { result } = renderHook(() => useCalculationEngine(['A', 'B']));
        act(() => result.current.setOperationId('efficiency_pct'));
        expect(result.current.operationId).toBe('efficiency_pct');

        act(() => result.current.setChainOp(0, '×'));
        expect(result.current.operationId).toBeNull();
        expect(result.current.baseSensor).toBe('');
    });

    // ── build(): mode gate ───────────────────────────────────────────

    it('build() returns "none" when mode is "formula" (buttons UI not in play)', () => {
        const { result } = renderHook(() => useCalculationEngine(['A']));
        act(() => result.current.setMode('formula'));
        expect(result.current.build()).toEqual({ kind: 'none' });
    });

    // ── build(): single-sensor group ─────────────────────────────────

    it('build() single group returns "none" when no operation is picked', () => {
        const { result } = renderHook(() => useCalculationEngine(['A']));
        expect(result.current.build()).toEqual({ kind: 'none' });
    });

    it('build() single group returns a legacy singleOp config', () => {
        const { result } = renderHook(() => useCalculationEngine(['A']));
        act(() => result.current.setOperationId('multiply'));
        act(() => result.current.setValue(3));
        expect(result.current.build()).toEqual({
            kind: 'legacy',
            config: {
                mode: 'single',
                singleOp: { type: 'multiply', value: 3 },
                customName: undefined,
            },
        });
    });

    it('build() single group includes customName when set', () => {
        const { result } = renderHook(() => useCalculationEngine(['A']));
        act(() => result.current.setOperationId('add'));
        act(() => result.current.setCustomName('My Sensor'));
        const built = result.current.build();
        expect(built.kind).toBe('legacy');
        expect(built.kind === 'legacy' && built.config.customName).toBe('My Sensor');
    });

    // ── build(): multi-sensor, legacy aggregate ops ──────────────────

    it.each(['sum', 'mean', 'median'])(
        'build() multi group routes "%s" through the legacy multiOp config',
        (opId) => {
            const { result } = renderHook(() => useCalculationEngine(['A', 'B', 'C']));
            act(() => result.current.setOperationId(opId));
            expect(result.current.build()).toEqual({
                kind: 'legacy',
                config: {
                    mode: 'multi',
                    multiOp: { type: opId },
                    customName: undefined,
                },
            });
        },
    );

    // ── build(): multi-sensor, formula-backed named shortcuts ────────

    it('build() "abs_diff" builds an abs() formula between the first two sensors', () => {
        const { result } = renderHook(() => useCalculationEngine(['Sensor A', 'Sensor B']));
        act(() => result.current.setOperationId('abs_diff'));
        expect(result.current.build()).toEqual({
            kind: 'formula',
            expression: 'abs(${Sensor A} - ${Sensor B})',
        });
    });

    it('build() "temp_spread" builds a max()-min() formula across all sensors', () => {
        const { result } = renderHook(() => useCalculationEngine(['A', 'B', 'C']));
        act(() => result.current.setOperationId('temp_spread'));
        expect(result.current.build()).toEqual({
            kind: 'formula',
            expression: 'max($A, $B, $C) - min($A, $B, $C)',
        });
    });

    it('build() "efficiency_pct" divides the non-base sensor by the base sensor, times 100', () => {
        const { result } = renderHook(() => useCalculationEngine(['A', 'B']));
        act(() => result.current.setOperationId('efficiency_pct'));
        act(() => result.current.setBaseSensor('A'));
        expect(result.current.build()).toEqual({
            kind: 'formula',
            expression: '($B / $A) * 100',
        });
    });

    it('build() "efficiency_pct" falls back to the first selected sensor if baseSensor is unset', () => {
        const { result } = renderHook(() => useCalculationEngine(['A', 'B']));
        act(() => result.current.setOperationId('efficiency_pct'));
        // Note: setOperationId auto-seeds baseSensor to 'A' as a side effect,
        // so this exercises the same fallback path the "unset" branch covers.
        expect(result.current.build()).toEqual({
            kind: 'formula',
            expression: '($B / $A) * 100',
        });
    });

    it('every id in FORMULA_MULTI_IDS is handled by build() without falling through to the chain', () => {
        for (const opId of FORMULA_MULTI_IDS) {
            const { result } = renderHook(() => useCalculationEngine(['A', 'B', 'C']));
            act(() => result.current.setOperationId(opId));
            const built = result.current.build();
            expect(built.kind).toBe('formula');
        }
    });

    // ── build(): multi-sensor, operator chain (default path) ─────────

    it('build() with no shortcut chosen defaults every gap to "+"', () => {
        const { result } = renderHook(() => useCalculationEngine(['A', 'B', 'C']));
        expect(result.current.build()).toEqual({
            kind: 'formula',
            expression: '$A + $B + $C',
        });
    });

    it('build() respects explicit chain operators per gap', () => {
        const { result } = renderHook(() => useCalculationEngine(['A', 'B', 'C']));
        act(() => result.current.setChainOp(0, '×'));
        act(() => result.current.setChainOp(1, '÷'));
        expect(result.current.build()).toEqual({
            kind: 'formula',
            expression: '$A * $B / $C',
        });
    });

    it('sensorRef wraps tags containing spaces or dots in ${...} braces', () => {
        const { result } = renderHook(() => useCalculationEngine(['Sensor.1', 'Plain']));
        expect(result.current.build()).toEqual({
            kind: 'formula',
            expression: '${Sensor.1} + $Plain',
        });
    });

    // The full name table (and its Rust twin) is pinned in
    // specialSensorNaming.test.ts; these check the engine really routes every
    // reference it writes through that one rule, for each shape of formula it builds.
    it('sensorRef braces every name that is not purely alphanumeric/underscore -- hyphen, slash, percent, parentheses, not just space and dot', () => {
        const { result } = renderHook(() => useCalculationEngine(['Total-Power', 'A/B', 'Eff%', '(x)', '11PT1214A']));
        expect(result.current.build()).toEqual({
            kind: 'formula',
            expression: '${Total-Power} + ${A/B} + ${Eff%} + ${(x)} + $11PT1214A',
        });
    });

    it('sensorRef applies inside the named shortcuts too (Absolute difference, Spread, Efficiency %)', () => {
        const { result } = renderHook(() => useCalculationEngine(['Total-Power', 'A/B']));
        act(() => result.current.setOperationId('abs_diff'));
        expect(result.current.build()).toEqual({ kind: 'formula', expression: 'abs(${Total-Power} - ${A/B})' });
        act(() => result.current.setOperationId('temp_spread'));
        expect(result.current.build()).toEqual({
            kind: 'formula',
            expression: 'max(${Total-Power}, ${A/B}) - min(${Total-Power}, ${A/B})',
        });
        act(() => result.current.setOperationId('efficiency_pct'));
        expect(result.current.build()).toEqual({ kind: 'formula', expression: '(${A/B} / ${Total-Power}) * 100' });
    });

    // ── build(): wrapFunc post-processing ─────────────────────────────

    it('applyWrap wraps the chain result with a simple function call', () => {
        const { result } = renderHook(() => useCalculationEngine(['A', 'B']));
        act(() => result.current.setWrapFunc('sqrt'));
        expect(result.current.build()).toEqual({
            kind: 'formula',
            expression: 'sqrt($A + $B)',
        });
    });

    // 2026-10-08: was `round(0.001, $A + $B)` -- fasteval divides by the step
    // and multiplies back, storing 1.1300000000000001 instead of 1.13.
    it('applyWrap rounds to N decimals as round(x * 10^N) / 10^N, parenthesising a chain', () => {
        const { result } = renderHook(() => useCalculationEngine(['A', 'B']));
        act(() => result.current.setWrapFunc('round'));
        act(() => result.current.setWrapValue(3));
        expect(result.current.build()).toEqual({
            kind: 'formula',
            expression: 'round(($A + $B) * 1000) / 1000',
        });
    });

    it('applyWrap "round" to 0 decimals is the one-argument round(x)', () => {
        const { result } = renderHook(() => useCalculationEngine(['A', 'B']));
        act(() => result.current.setWrapFunc('round'));
        act(() => result.current.setWrapValue(0));
        expect(result.current.build()).toEqual({ kind: 'formula', expression: 'round($A + $B)' });
    });

    it('applyWrap "round" multiplies a single function call without extra parentheses', () => {
        const { result } = renderHook(() => useCalculationEngine(['A', 'B']));
        act(() => result.current.setOperationId('abs_diff'));
        act(() => result.current.setWrapFunc('round'));
        act(() => result.current.setWrapValue(2));
        expect(result.current.build()).toEqual({ kind: 'formula', expression: 'round(abs($A - $B) * 100) / 100' });
    });

    it('applyWrap "round" parenthesises max(...) - min(...) (two calls, not one)', () => {
        const { result } = renderHook(() => useCalculationEngine(['A', 'B', 'C']));
        act(() => result.current.setOperationId('temp_spread'));
        act(() => result.current.setWrapFunc('round'));
        act(() => result.current.setWrapValue(1));
        expect(result.current.build()).toEqual({
            kind: 'formula',
            expression: 'round((max($A, $B, $C) - min($A, $B, $C)) * 10) / 10',
        });
    });

    it('applyWrap "round" ignores parentheses inside a braced sensor name', () => {
        const { result } = renderHook(() => useCalculationEngine(['Flow (m3', 'B']));
        act(() => result.current.setOperationId('abs_diff'));
        act(() => result.current.setWrapFunc('round'));
        act(() => result.current.setWrapValue(2));
        expect(result.current.build()).toEqual({ kind: 'formula', expression: 'round(abs(${Flow (m3} - $B) * 100) / 100' });
    });

    it('applyWrap "round" clamps the decimal count to a whole number in 0..15', () => {
        const { result } = renderHook(() => useCalculationEngine(['A', 'B']));
        act(() => result.current.setWrapFunc('round'));
        act(() => result.current.setWrapValue(-3));
        expect(result.current.build()).toEqual({ kind: 'formula', expression: 'round($A + $B)' });
        act(() => result.current.setWrapValue(2.7));
        expect(result.current.build()).toEqual({ kind: 'formula', expression: 'round(($A + $B) * 100) / 100' });
        act(() => result.current.setWrapValue(40));
        expect(result.current.build()).toEqual({
            kind: 'formula',
            expression: `round(($A + $B) * 1${'0'.repeat(15)}) / 1${'0'.repeat(15)}`,
        });
    });

    it('applyWrap leaves the expression untouched for an unknown/null wrapFunc', () => {
        const { result } = renderHook(() => useCalculationEngine(['A', 'B']));
        expect(result.current.build()).toEqual({
            kind: 'formula',
            expression: '$A + $B',
        });
    });

    // ── currentOperation lookup ────────────────────────────────────────

    it('currentOperation resolves the definition for the active operationId + opGroup', () => {
        const { result } = renderHook(() => useCalculationEngine(['A', 'B']));
        act(() => result.current.setOperationId('efficiency_pct'));
        expect(result.current.currentOperation?.id).toBe('efficiency_pct');
        expect(result.current.currentOperation?.requiresBase).toBe(true);
    });

    it('currentOperation is undefined when no operationId is set', () => {
        const { result } = renderHook(() => useCalculationEngine(['A']));
        expect(result.current.currentOperation).toBeUndefined();
    });

    // ── seed ───────────────────────────────────────────────────────────
    // What lets `SpecialSensorEditor.tsx`'s edit form open showing an
    // existing recipe's config instead of a blank one.

    it('seeds operationId and value, and build() reflects them without any setter calls', () => {
        const { result } = renderHook(() => useCalculationEngine(['A'], { operationId: 'multiply', value: 5 }));
        expect(result.current.operationId).toBe('multiply');
        expect(result.current.value).toBe(5);
        expect(result.current.build()).toEqual({
            kind: 'legacy',
            config: { mode: 'single', singleOp: { type: 'multiply', value: 5 }, customName: undefined },
        });
    });

    it('seeds chainOps and wrapFunc for a multi-sensor chain that was left unshortened', () => {
        const { result } = renderHook(() =>
            useCalculationEngine(['A', 'B', 'C'], { chainOps: ['−', '×'], wrapFunc: 'abs' }),
        );
        expect(result.current.build()).toEqual({
            kind: 'formula',
            expression: 'abs($A - $B * $C)',
        });
    });

    it('a seed does not stop the normal setters from working afterward', () => {
        const { result } = renderHook(() => useCalculationEngine(['A'], { operationId: 'add', value: 10 }));
        act(() => result.current.setOperationId('subtract'));
        expect(result.current.operationId).toBe('subtract');
        expect(result.current.value).toBe(0); // setOperationId's own reset, unaffected by the seed
    });

    it('an absent seed behaves exactly like no seed was passed at all', () => {
        const seeded = renderHook(() => useCalculationEngine(['A'], undefined));
        const unseeded = renderHook(() => useCalculationEngine(['A']));
        expect(seeded.result.current.build()).toEqual(unseeded.result.current.build());
    });
});

// 2026-10-08: what a change of the source list does to the picked calculation
// (shared by Create's SensorTooling and the Manage tab's SpecialSensorEditor).
describe('sourceChangeEffect', () => {
    it('keeps Sum / Average / Median / Spread when a source is added or removed (still 2+)', () => {
        for (const op of ['sum', 'mean', 'median', 'temp_spread']) {
            expect(sourceChangeEffect(['A', 'B'], ['A', 'B', 'C'], op, ''), op).toBe('keep');
            expect(sourceChangeEffect(['A', 'B', 'C'], ['A', 'C'], op, ''), op).toBe('keep');
        }
    });

    it('keeps a single-sensor operation when its one source is swapped for another', () => {
        expect(sourceChangeEffect(['A'], ['B'], 'round', '')).toBe('keep');
    });

    it('keeps the operator chain (no shortcut) within the multi group', () => {
        expect(sourceChangeEffect(['A', 'B'], ['A', 'B', 'C'], null, '')).toBe('keep');
    });

    it('resets everything when the calculation kind changes (one <-> several) or no source is left', () => {
        expect(sourceChangeEffect(['A'], ['A', 'B'], 'add', '')).toBe('reset-all');
        expect(sourceChangeEffect(['A', 'B'], ['A'], 'mean', '')).toBe('reset-all');
        expect(sourceChangeEffect(['A', 'B'], ['A'], null, '')).toBe('reset-all');
        expect(sourceChangeEffect(['A'], [], 'add', '')).toBe('reset-all');
    });

    it('resets a two-sensor-only shortcut once a third source is added', () => {
        expect(sourceChangeEffect(['A', 'B'], ['A', 'B', 'C'], 'abs_diff', '')).toBe('reset-operation');
        expect(sourceChangeEffect(['A', 'B'], ['A', 'C'], 'abs_diff', '')).toBe('keep');
    });

    it('resets Efficiency % when its starting value is removed, keeps it when the other sensor is swapped', () => {
        expect(sourceChangeEffect(['A', 'B'], ['C', 'B'], 'efficiency_pct', 'A')).toBe('reset-operation');
        expect(sourceChangeEffect(['A', 'B'], ['A', 'C'], 'efficiency_pct', 'A')).toBe('keep');
        // No explicit base = the first source.
        expect(sourceChangeEffect(['A', 'B'], ['B', 'C'], 'efficiency_pct', '')).toBe('reset-operation');
    });
});
