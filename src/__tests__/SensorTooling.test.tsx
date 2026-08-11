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

    describe('changing the selection resets the operation', () => {
        it('clears the picked operation and master-data fields when selectedSensors changes', () => {
            const onDescriptionChange = vi.fn();
            const { rerender } = render(
                <SensorTooling {...makeProps({ selectedSensors: ['A'], onDescriptionChange })} />,
            );
            fireEvent.click(screen.getByText('Add'));
            expect(screen.getByText('Value')).toBeTruthy();

            rerender(<SensorTooling {...makeProps({ selectedSensors: ['A', 'B'], onDescriptionChange })} />);
            expect(screen.getByText('Sensor A + Sensor B')).toBeTruthy(); // back to default chain, not "Add"
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

            fireEvent.change(screen.getByPlaceholderText('Pick or type'), { target: { value: 'Boiler' } });
            expect(onComponentChange).toHaveBeenLastCalledWith('Boiler');
        });

        it('the Component combobox suggests existing components and fills on click', () => {
            render(<SensorTooling {...makeProps({ selectedSensors: ['A'] })} />);
            fireEvent.click(screen.getByText('Add'));
            const combo = screen.getByPlaceholderText('Pick or type');
            fireEvent.focus(combo);
            expect(screen.getByText('Pump')).toBeTruthy();
            fireEvent.click(screen.getByText('Motor'));
            expect((combo as HTMLInputElement).value).toBe('Motor');
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
