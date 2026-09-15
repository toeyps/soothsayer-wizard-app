import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (cmd: string, args?: unknown) => mockInvoke(cmd, args),
}));

import SensorTooling from '../components/windows/SensorTooling';
import type { SensorMetadata } from '../types';

const sensorMetadata: SensorMetadata[] = [
    { tag: 'A', description: 'Sensor A', unit: 'bar', component: 'Pump' },
    { tag: 'B', description: 'Sensor B', unit: 'C', component: 'Motor' },
];

function makeProps(overrides: Partial<React.ComponentProps<typeof SensorTooling>> = {}) {
    return {
        selectedSensors: [] as string[],
        sensorMetadata,
        onConfigChange: vi.fn(),
        onRemoveSensor: vi.fn(),
        onFormulaSubmit: vi.fn(),
        onDescriptionChange: vi.fn(),
        onUnitChange: vi.fn(),
        onComponentChange: vi.fn(),
        ...overrides,
    };
}

beforeEach(() => {
    mockInvoke.mockReset().mockResolvedValue({ valid: true, error: null, referenced_sensors: [] });
});

afterEach(() => {
    vi.useRealTimers();
});

describe('SensorTooling', () => {
    it('shows "No sensors selected" and a getting-started hint with nothing picked', () => {
        render(<SensorTooling {...makeProps()} />);
        expect(screen.getByText('No sensors selected')).toBeTruthy();
        expect(screen.getByText('Pick sensors on the left to get started.')).toBeTruthy();
    });

    it('lists each selected sensor by description, with a remove (×) button', () => {
        const onRemoveSensor = vi.fn();
        render(<SensorTooling {...makeProps({ selectedSensors: ['A'], onRemoveSensor })} />);
        expect(screen.getByText('Sensor A')).toBeTruthy();
        fireEvent.click(screen.getByText('×'));
        expect(onRemoveSensor).toHaveBeenCalledWith('A');
    });

    describe('single-sensor mode', () => {
        it('offers number and transform operations', () => {
            render(<SensorTooling {...makeProps({ selectedSensors: ['A'] })} />);
            expect(screen.getByText('Add this sensor as-is, or apply a calculation:')).toBeTruthy();
            expect(screen.getByText('Add')).toBeTruthy();
            expect(screen.getByText('Absolute value')).toBeTruthy();
        });

        it('picking "Add" reveals a Value input and reports a legacy config', () => {
            const onConfigChange = vi.fn();
            render(<SensorTooling {...makeProps({ selectedSensors: ['A'], onConfigChange })} />);
            fireEvent.click(screen.getByText('Add'));
            expect(screen.getByText('Value')).toBeTruthy();
            expect(onConfigChange).toHaveBeenLastCalledWith(
                expect.objectContaining({ mode: 'single', singleOp: expect.objectContaining({ type: 'add' }) }),
            );
        });

        it('picking "Round" reveals a Decimal-places input', () => {
            render(<SensorTooling {...makeProps({ selectedSensors: ['A'] })} />);
            fireEvent.click(screen.getByText('Round to decimals'));
            expect(screen.getByText('Decimal places')).toBeTruthy();
        });

        it('previews "added as-is" with no operation picked', () => {
            render(<SensorTooling {...makeProps({ selectedSensors: ['A'] })} />);
            expect(screen.getByText('Sensor A added as-is.')).toBeTruthy();
        });

        it('re-clicking the active operation clears it back to "none"', () => {
            const onConfigChange = vi.fn();
            render(<SensorTooling {...makeProps({ selectedSensors: ['A'], onConfigChange })} />);
            fireEvent.click(screen.getByText('Add'));
            fireEvent.click(screen.getByText('Add'));
            expect(onConfigChange).toHaveBeenLastCalledWith(null);
        });
    });

    describe('multi-sensor mode', () => {
        it('shows the operator chain defaulting to "+", and a preview text using it', () => {
            render(<SensorTooling {...makeProps({ selectedSensors: ['A', 'B'] })} />);
            expect(screen.getByText('Combine with operators')).toBeTruthy();
            expect(screen.getByText('+')).toBeTruthy();
            expect(screen.getByText('Sensor A + Sensor B')).toBeTruthy();
        });

        it('clicking the chain operator opens a dropdown; picking one updates the formula and preview', () => {
            const onFormulaSubmit = vi.fn();
            render(<SensorTooling {...makeProps({ selectedSensors: ['A', 'B'], onFormulaSubmit })} />);
            fireEvent.click(screen.getByText('+'));
            fireEvent.click(screen.getByText('Multiply (×)'));
            expect(screen.getByText('Sensor A × Sensor B')).toBeTruthy();
            expect(onFormulaSubmit).toHaveBeenLastCalledWith('$A * $B', undefined);
        });

        // Regression: picking a "Combine all" shortcut left the per-pair
        // chain-operator buttons ("Combine with operators") fully clickable
        // even though they no longer had any effect on the result. Worse,
        // clicking one silently switched calculations right back to the
        // chain (`engine.setChainOp` always deselects the current
        // shortcut) with no visible sign of what just happened -- reported
        // as confusing.
        it('disables the chain-operator buttons once a "Combine all" shortcut is picked', () => {
            render(<SensorTooling {...makeProps({ selectedSensors: ['A', 'B'] })} />);
            fireEvent.click(screen.getByText('Sum all'));
            expect((screen.getByText('+') as HTMLButtonElement).disabled).toBe(true);
            expect(screen.getByText(/A shortcut below is selected/)).toBeTruthy();
        });

        it('clicking a disabled chain-operator button does nothing -- the shortcut stays picked', () => {
            const onConfigChange = vi.fn();
            render(<SensorTooling {...makeProps({ selectedSensors: ['A', 'B'], onConfigChange })} />);
            fireEvent.click(screen.getByText('Sum all'));
            onConfigChange.mockClear();

            fireEvent.click(screen.getByText('+'));
            expect(screen.queryByText('Multiply (×)')).toBeNull(); // dropdown never opened
            expect(onConfigChange).not.toHaveBeenCalled(); // shortcut wasn't deselected
        });

        it('re-enables the chain-operator buttons once the shortcut is cleared', () => {
            render(<SensorTooling {...makeProps({ selectedSensors: ['A', 'B'] })} />);
            fireEvent.click(screen.getByText('Sum all'));
            fireEvent.click(screen.getByText('Sum all')); // toggle it back off
            expect((screen.getByText('+') as HTMLButtonElement).disabled).toBe(false);
            expect(screen.queryByText(/A shortcut below is selected/)).toBeNull();
        });

        it('offers pairwise-only shortcuts (Absolute difference) only with exactly 2 sensors', () => {
            const { rerender } = render(<SensorTooling {...makeProps({ selectedSensors: ['A', 'B'] })} />);
            expect(screen.getByText('Absolute difference')).toBeTruthy();

            rerender(<SensorTooling {...makeProps({ selectedSensors: ['A', 'B', 'C'] })} />);
            expect(screen.queryByText('Absolute difference')).toBeNull();
        });

        it('picking "Sum all" reports a legacy multi config', () => {
            const onConfigChange = vi.fn();
            render(<SensorTooling {...makeProps({ selectedSensors: ['A', 'B'], onConfigChange })} />);
            fireEvent.click(screen.getByText('Sum all'));
            expect(onConfigChange).toHaveBeenLastCalledWith(
                expect.objectContaining({ mode: 'multi', multiOp: { type: 'sum' } }),
            );
        });

        it('picking a formula-backed shortcut (Absolute difference) reports via onFormulaSubmit, not onConfigChange', () => {
            const onConfigChange = vi.fn();
            const onFormulaSubmit = vi.fn();
            render(<SensorTooling {...makeProps({ selectedSensors: ['A', 'B'], onConfigChange, onFormulaSubmit })} />);
            onConfigChange.mockClear();
            fireEvent.click(screen.getByText('Absolute difference'));
            expect(onConfigChange).toHaveBeenLastCalledWith(null);
            expect(onFormulaSubmit).toHaveBeenLastCalledWith('abs($A - $B)', undefined);
        });

        describe('"Compare one against the rest" (base-sensor picking)', () => {
            it('auto-marks the first sensor as the base and shows the picking hint', () => {
                render(<SensorTooling {...makeProps({ selectedSensors: ['A', 'B'] })} />);
                fireEvent.click(screen.getByText('Efficiency % (output ÷ input × 100)'));
                expect(screen.getByText('Click a sensor above to mark it as the input.')).toBeTruthy();
                expect(screen.getByText('Sensor B ÷ Sensor A × 100')).toBeTruthy();
            });

            it('clicking a different sensor chip switches the base', () => {
                render(<SensorTooling {...makeProps({ selectedSensors: ['A', 'B'] })} />);
                fireEvent.click(screen.getByText('Efficiency % (output ÷ input × 100)'));
                const chips = screen.getAllByTitle('Click to mark as the starting value');
                const bChip = chips.find((c) => c.textContent?.startsWith('Sensor B'))!;
                fireEvent.click(bChip);
                expect(screen.getByText('Sensor A ÷ Sensor B × 100')).toBeTruthy();
            });
        });

        describe('"Then apply to the result" (wrap)', () => {
            it('is offered while the chain is active, and applying one updates the preview', () => {
                render(<SensorTooling {...makeProps({ selectedSensors: ['A', 'B'] })} />);
                expect(screen.getByText('Then apply to the result')).toBeTruthy();
                fireEvent.click(screen.getByText('Square root'));
                expect(screen.getByText('Square root of (Sensor A + Sensor B)')).toBeTruthy();
            });

            it('is hidden once a legacy (non-formula) shortcut like Sum is active', () => {
                render(<SensorTooling {...makeProps({ selectedSensors: ['A', 'B'] })} />);
                fireEvent.click(screen.getByText('Sum all'));
                expect(screen.queryByText('Then apply to the result')).toBeNull();
            });

            it('wrapping with "round" reveals a Decimal-places input', () => {
                render(<SensorTooling {...makeProps({ selectedSensors: ['A', 'B'] })} />);
                fireEvent.click(screen.getByText('Round to decimals'));
                expect(screen.getByText('Decimal places')).toBeTruthy();
            });
        });
    });

    describe('re-rendering without the calculation itself changing', () => {
        // Regression: `engine.build()` was called fresh on every render and
        // its result handed straight to `useEffect`s that call
        // `onConfigChange`/`onFormulaSubmit` when it changes. A plain object
        // literal is a new reference every call, so ANY re-render of this
        // component — including one caused entirely by the parent's own
        // unrelated state, with every prop passed in unchanged — re-fired
        // those effects as if the calculation had just changed.
        //
        // The reported symptom: AddSensorWindow shows "name missing" for one
        // frame after a failed Add click, then its own re-render (setting
        // that very state) cascades down here, re-invokes onConfigChange,
        // and `handleConfigChange` unconditionally clears the warning right
        // back off — so it reads as "flashes and disappears".
        it('does not re-fire onConfigChange after a re-render with nothing about the calculation changed', () => {
            const onConfigChange = vi.fn();
            const props = makeProps({ selectedSensors: ['A', 'B'], onConfigChange });
            const { rerender } = render(<SensorTooling {...props} />);
            fireEvent.click(screen.getByText('Sum all'));
            expect(onConfigChange).toHaveBeenCalled();
            onConfigChange.mockClear();

            // Same props object, same references throughout — simulates the
            // parent re-rendering for a reason that has nothing to do with
            // the calculation.
            rerender(<SensorTooling {...props} />);

            expect(onConfigChange).not.toHaveBeenCalled();
        });

        it('does not re-fire onFormulaSubmit after a re-render with nothing about the calculation changed', () => {
            const onFormulaSubmit = vi.fn();
            const props = makeProps({ selectedSensors: ['A', 'B'], onFormulaSubmit });
            const { rerender } = render(<SensorTooling {...props} />);
            // No shortcut picked -- the default "+" operator chain, which
            // resolves via onFormulaSubmit rather than onConfigChange.
            expect(onFormulaSubmit).toHaveBeenCalled();
            onFormulaSubmit.mockClear();

            rerender(<SensorTooling {...props} />);

            expect(onFormulaSubmit).not.toHaveBeenCalled();
        });
    });

    describe('changing the selection resets the operation', () => {
        it('clears the picked operation when selectedSensors changes', () => {
            const onDescriptionChange = vi.fn();
            const { rerender } = render(
                <SensorTooling {...makeProps({ selectedSensors: ['A'], onDescriptionChange })} />,
            );
            fireEvent.click(screen.getByText('Add'));
            expect(screen.getByText('Value')).toBeTruthy();

            rerender(<SensorTooling {...makeProps({ selectedSensors: ['A', 'B'], onDescriptionChange })} />);
            expect(screen.getByText('Sensor A + Sensor B')).toBeTruthy(); // back to default chain, not "Add"
        });

        // Regression: this same effect used to clear Description/Unit/Component
        // alongside the operation on every selection change. Those describe the
        // NEW sensor being created, not which raw sensors feed it, so tweaking
        // the input selection mid-flow has no business wiping them. Reported
        // symptom: fill in Component, adjust the selection, click Add -- the
        // sensor is created with an EMPTY component (defaults to
        // "Uncategorized" server-side), even though a component was clearly
        // picked moments earlier.
        it('does NOT clear Description/Unit/Component when the selection changes to a different non-empty set', () => {
            const onComponentChange = vi.fn();
            const props = makeProps({ selectedSensors: ['A'], onComponentChange });
            const { rerender } = render(<SensorTooling {...props} />);

            fireEvent.click(screen.getByText('Add'));
            fireEvent.change(screen.getByPlaceholderText('e.g. Total boiler power draw'), { target: { value: 'My Desc' } });
            fireEvent.change(screen.getByPlaceholderText('e.g. kW'), { target: { value: 'kW' } });
            fireEvent.change(screen.getByLabelText('Component'), { target: { value: 'Pump' } });
            onComponentChange.mockClear();

            // Adjust the input selection -- e.g. the user realizes they also
            // want a second sensor in the calculation -- while nothing about
            // the sensor they're naming has changed.
            rerender(<SensorTooling {...makeProps({ ...props, selectedSensors: ['A', 'B'] })} />);

            expect((screen.getByPlaceholderText('e.g. Total boiler power draw') as HTMLInputElement).value).toBe('My Desc');
            expect((screen.getByPlaceholderText('e.g. kW') as HTMLInputElement).value).toBe('kW');
            expect((screen.getByLabelText('Component') as HTMLSelectElement).value).toBe('Pump');
            expect(onComponentChange).not.toHaveBeenCalledWith('');
        });

        it('DOES clear Description/Unit/Component once the selection drops to nothing -- matches "Add sensor" starting the next round with a blank picker', () => {
            const onDescriptionChange = vi.fn();
            const onUnitChange = vi.fn();
            const onComponentChange = vi.fn();
            const props = makeProps({ selectedSensors: ['A'], onDescriptionChange, onUnitChange, onComponentChange });
            const { rerender } = render(<SensorTooling {...props} />);

            fireEvent.click(screen.getByText('Add'));
            fireEvent.change(screen.getByPlaceholderText('e.g. Total boiler power draw'), { target: { value: 'My Desc' } });
            fireEvent.change(screen.getByPlaceholderText('e.g. kW'), { target: { value: 'kW' } });
            fireEvent.change(screen.getByLabelText('Component'), { target: { value: 'Pump' } });

            rerender(<SensorTooling {...makeProps({ ...props, selectedSensors: [] })} />);

            expect(screen.queryByPlaceholderText('e.g. Total boiler power draw')).toBeNull(); // fields hidden -- nothing selected
            expect(onDescriptionChange).toHaveBeenLastCalledWith('');
            expect(onUnitChange).toHaveBeenLastCalledWith('');
            expect(onComponentChange).toHaveBeenLastCalledWith('');

            // And the next round starts genuinely blank, not pre-filled with
            // the previous sensor's leftovers.
            rerender(<SensorTooling {...makeProps({ ...props, selectedSensors: ['C'] })} />);
            fireEvent.click(screen.getByText('Add'));
            expect((screen.getByPlaceholderText('e.g. Total boiler power draw') as HTMLInputElement).value).toBe('');
        });
    });

    describe('name/description/unit/component fields', () => {
        it('are hidden when nothing would be created', () => {
            render(<SensorTooling {...makeProps({ selectedSensors: ['A'] })} />);
            expect(screen.queryByText('Name this sensor')).toBeNull();
        });

        it('appear once a calculation is chosen, and each field reports keystrokes', () => {
            const onDescriptionChange = vi.fn();
            const onUnitChange = vi.fn();
            const onComponentChange = vi.fn();
            render(
                <SensorTooling {...makeProps({
                    selectedSensors: ['A'], onDescriptionChange, onUnitChange, onComponentChange,
                })} />,
            );
            fireEvent.click(screen.getByText('Add'));
            expect(screen.getByText(/Name this sensor/)).toBeTruthy();

            fireEvent.change(screen.getByPlaceholderText('e.g. Total boiler power draw'), { target: { value: 'My Desc' } });
            expect(onDescriptionChange).toHaveBeenLastCalledWith('My Desc');

            fireEvent.change(screen.getByPlaceholderText('e.g. kW'), { target: { value: 'kW' } });
            expect(onUnitChange).toHaveBeenLastCalledWith('kW');

            fireEvent.change(screen.getByLabelText('Component'), { target: { value: 'Pump' } });
            expect(onComponentChange).toHaveBeenLastCalledWith('Pump');
        });

        it('the Component select is restricted to components that already exist on some sensor', () => {
            render(<SensorTooling {...makeProps({ selectedSensors: ['A'] })} />);
            fireEvent.click(screen.getByText('Add'));
            const select = screen.getByLabelText('Component') as HTMLSelectElement;
            const optionValues = Array.from(select.querySelectorAll('option')).map(o => o.value);
            // "Uncategorized" is always offered (a safety net for a brand-new
            // workspace with no components yet); free typing is not possible
            // -- there is no way to add an option that isn't in this list.
            expect(optionValues).toEqual(['', 'Motor', 'Pump', 'Uncategorized']);

            fireEvent.change(select, { target: { value: 'Motor' } });
            expect(select.value).toBe('Motor');
        });
    });

    describe('mode toggle', () => {
        it('"Edit as text instead" switches to the formula textarea; "Use buttons instead" switches back', () => {
            render(<SensorTooling {...makeProps({ selectedSensors: ['A'] })} />);
            fireEvent.click(screen.getByText('Edit as text instead'));
            expect(screen.getByPlaceholderText('= $SensorA + $SensorB * 2')).toBeTruthy();

            fireEvent.click(screen.getByText('Use buttons instead'));
            expect(screen.queryByPlaceholderText('= $SensorA + $SensorB * 2')).toBeNull();
        });

        it('formula mode preview falls back to a hint until something is typed', () => {
            render(<SensorTooling {...makeProps({ selectedSensors: ['A'] })} />);
            fireEvent.click(screen.getByText('Edit as text instead'));
            expect(screen.getByText('Write a formula to see a preview.')).toBeTruthy();
        });

        it('typing a formula validates it and shows referenced sensors', async () => {
            vi.useFakeTimers();
            mockInvoke.mockResolvedValue({ valid: true, error: null, referenced_sensors: ['A'] });
            render(<SensorTooling {...makeProps({ selectedSensors: ['A', 'B'] })} />);
            fireEvent.click(screen.getByText('Edit as text instead'));
            const textarea = screen.getByPlaceholderText('= $SensorA + $SensorB * 2');
            fireEvent.change(textarea, { target: { value: '$A + 1', selectionStart: 6 } });

            await act(async () => { await vi.advanceTimersByTimeAsync(500); });
            expect(mockInvoke).toHaveBeenCalledWith('validate_formula', { formula: '$A + 1' });
            expect(screen.getByText(/Valid formula/)).toBeTruthy();
            expect(screen.getByText('Referenced sensors:')).toBeTruthy();
        });

        it('toggles the syntax-help panel', () => {
            render(<SensorTooling {...makeProps({ selectedSensors: ['A'] })} />);
            fireEvent.click(screen.getByText('Edit as text instead'));
            expect(screen.queryByText('Supported syntax:')).toBeNull();
            fireEvent.click(screen.getByText('Formula Syntax Help'));
            expect(screen.getByText('Supported syntax:')).toBeTruthy();
        });
    });
});
