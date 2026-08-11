import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (...args: unknown[]) => mockInvoke(...args),
}));

import { useFormulaEditor } from '../hooks/useFormulaEditor';

const sensors = ['SensorA', 'SensorB', 'Sensor.C', 'Other'];

beforeEach(() => {
    mockInvoke.mockReset();
    vi.useFakeTimers();
});
afterEach(() => {
    vi.useRealTimers();
});

describe('useFormulaEditor', () => {
    it('starts empty with no referenced sensors', () => {
        const { result } = renderHook(() => useFormulaEditor(sensors));
        expect(result.current.formula).toBe('');
        expect(result.current.referencedSensors).toEqual([]);
    });

    it('extracts $Plain and ${Braced With Spaces} sensor references, deduplicated', () => {
        const { result } = renderHook(() => useFormulaEditor(sensors));
        act(() => result.current.setFormula('$SensorA + ${Sensor B} - $SensorA'));
        expect(result.current.referencedSensors).toEqual(['SensorA', 'Sensor B']);
    });

    it('opens autocomplete and filters suggestions when "$" is typed', () => {
        const { result } = renderHook(() => useFormulaEditor(sensors));
        act(() => result.current.setFormula('$Sen', 4));
        expect(result.current.showAutocomplete).toBe(true);
        expect(result.current.suggestions).toEqual(['SensorA', 'SensorB', 'Sensor.C']);
    });

    it('closes autocomplete once the cursor moves past the $token', () => {
        const { result } = renderHook(() => useFormulaEditor(sensors));
        act(() => result.current.setFormula('$Sen ', 5));
        expect(result.current.showAutocomplete).toBe(false);
    });

    it('caps unfiltered suggestions at 20 and offers all sensors when filter is empty', () => {
        const many = Array.from({ length: 30 }, (_, i) => `S${i}`);
        const { result } = renderHook(() => useFormulaEditor(many));
        act(() => result.current.setFormula('$', 1));
        expect(result.current.suggestions).toHaveLength(20);
    });

    it('debounces validation and calls validate_formula after 500ms', async () => {
        mockInvoke.mockResolvedValue({ valid: true, error: null, referenced_sensors: ['SensorA'] });
        const { result } = renderHook(() => useFormulaEditor(sensors));

        act(() => result.current.setFormula('$SensorA + 1'));
        expect(mockInvoke).not.toHaveBeenCalled();

        await act(async () => { await vi.advanceTimersByTimeAsync(500); });
        expect(mockInvoke).toHaveBeenCalledWith('validate_formula', { formula: '$SensorA + 1' });
        expect(result.current.validationResult).toEqual({ valid: true, error: null, referenced_sensors: ['SensorA'] });
        expect(result.current.isValidating).toBe(false);
    });

    it('does not validate an empty/whitespace formula', async () => {
        const { result } = renderHook(() => useFormulaEditor(sensors));
        act(() => result.current.setFormula('   '));
        await act(async () => { await vi.advanceTimersByTimeAsync(500); });
        expect(mockInvoke).not.toHaveBeenCalled();
        expect(result.current.validationResult).toBeNull();
    });

    it('surfaces a validation error when the backend rejects', async () => {
        mockInvoke.mockRejectedValue('bad formula');
        const { result } = renderHook(() => useFormulaEditor(sensors));
        act(() => result.current.setFormula('$Broken +'));
        await act(async () => { await vi.advanceTimersByTimeAsync(500); });
        expect(result.current.validationResult).toEqual({
            valid: false,
            error: 'bad formula',
            referenced_sensors: [],
        });
    });

    it('only fires the latest debounced validation when formula changes rapidly', async () => {
        mockInvoke.mockResolvedValue({ valid: true, error: null, referenced_sensors: [] });
        const { result } = renderHook(() => useFormulaEditor(sensors));
        act(() => result.current.setFormula('$A'));
        act(() => result.current.setFormula('$A + $B'));
        await act(async () => { await vi.advanceTimersByTimeAsync(500); });
        expect(mockInvoke).toHaveBeenCalledTimes(1);
        expect(mockInvoke).toHaveBeenCalledWith('validate_formula', { formula: '$A + $B' });
    });

    it('insertSensor wraps names with spaces/dots in ${...} and leaves plain names unwrapped', () => {
        const { result } = renderHook(() => useFormulaEditor(sensors));
        act(() => result.current.setFormula('$Sen', 4));
        act(() => result.current.insertSensor('Sensor.C'));
        expect(result.current.formula).toBe('${Sensor.C}');

        act(() => result.current.setFormula('${Sensor.C} + $Sen', 18));
        act(() => result.current.insertSensor('SensorB'));
        expect(result.current.formula).toBe('${Sensor.C} + $SensorB');
    });

    it('insertSensor closes autocomplete and schedules a 300ms validation', async () => {
        mockInvoke.mockResolvedValue({ valid: true, error: null, referenced_sensors: [] });
        const { result } = renderHook(() => useFormulaEditor(sensors));
        act(() => result.current.setFormula('$Sen', 4));
        act(() => result.current.insertSensor('SensorA'));
        expect(result.current.showAutocomplete).toBe(false);

        await act(async () => { await vi.advanceTimersByTimeAsync(300); });
        expect(mockInvoke).toHaveBeenCalledWith('validate_formula', { formula: '$SensorA' });
    });
});
