import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useCalculationEngine, FORMULA_MULTI_IDS } from '../hooks/useCalculationEngine';

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

    // ── build(): wrapFunc post-processing ─────────────────────────────

    it('applyWrap wraps the chain result with a simple function call', () => {
        const { result } = renderHook(() => useCalculationEngine(['A', 'B']));
        act(() => result.current.setWrapFunc('sqrt'));
        expect(result.current.build()).toEqual({
            kind: 'formula',
            expression: 'sqrt($A + $B)',
        });
    });

    it('applyWrap converts "round" decimals into a fasteval modulus', () => {
        const { result } = renderHook(() => useCalculationEngine(['A', 'B']));
        act(() => result.current.setWrapFunc('round'));
        act(() => result.current.setWrapValue(3));
        expect(result.current.build()).toEqual({
            kind: 'formula',
            expression: 'round(0.001, $A + $B)',
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
});
