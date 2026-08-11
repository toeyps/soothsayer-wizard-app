import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

const mockClose = vi.fn().mockResolvedValue(undefined);
const mockGetCurrentWindow = vi.fn(() => ({ close: mockClose }));
vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => mockGetCurrentWindow(),
}));

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (cmd: string, args?: unknown) => mockInvoke(cmd, args),
}));

let listenCallbacks: Record<string, Array<(e: any) => void>> = {};
const mockListen = vi.fn((event: string, cb: (e: any) => void) => {
    (listenCallbacks[event] ??= []).push(cb);
    return Promise.resolve(() => {});
});
const mockEmit = vi.fn().mockResolvedValue(undefined);
vi.mock('@tauri-apps/api/event', () => ({
    listen: (event: string, cb: any) => mockListen(event, cb),
    emit: (event: string, payload?: any) => mockEmit(event, payload),
}));

vi.mock('split.js', () => ({
    default: () => ({ destroy: vi.fn() }),
}));

const explorerProps: any[] = [];
vi.mock('../components/windows/SensorExplorer', () => ({
    default: (props: any) => {
        explorerProps.push(props);
        return (
            <div data-testid="sensor-explorer">
                <button onClick={() => props.onToggleSensor('TAG1')}>toggle-tag1</button>
                <button onClick={() => props.onToggleSensor('TAG2')}>toggle-tag2</button>
            </div>
        );
    },
}));

const toolingProps: any[] = [];
vi.mock('../components/windows/SensorTooling', () => ({
    default: (props: any) => {
        toolingProps.push(props);
        return (
            <div data-testid="sensor-tooling">
                <button onClick={() => props.onConfigChange({ mode: 'single', singleOp: { type: 'add', value: 1 }, customName: 'MyCalc' })}>
                    set-config
                </button>
                <button onClick={() => props.onConfigChange({ mode: 'single', singleOp: { type: 'add', value: 1 } })}>
                    set-config-no-name
                </button>
                <button onClick={() => props.onConfigChange(null)}>clear-config</button>
                <button onClick={() => props.onFormulaSubmit('$TAG1 + $TAG2', 'FormulaCalc')}>submit-formula</button>
                <button onClick={() => props.onRemoveSensor('TAG1')}>remove-tag1</button>
                <button onClick={() => props.onDescriptionChange('My Description')}>set-description</button>
                <button onClick={() => props.onUnitChange('bar')}>set-unit</button>
                <button onClick={() => props.onComponentChange('Pump')}>set-component</button>
            </div>
        );
    },
}));

import AddSensorWindow from '../components/windows/AddSensorWindow';

function last<T>(arr: T[]): T {
    return arr[arr.length - 1];
}

beforeEach(() => {
    explorerProps.length = 0;
    toolingProps.length = 0;
    listenCallbacks = {};
    mockListen.mockClear();
    mockEmit.mockClear().mockResolvedValue(undefined);
    mockClose.mockClear().mockResolvedValue(undefined);
    mockInvoke.mockReset().mockResolvedValue([]);
    vi.spyOn(window, 'alert').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

async function deliverSensorsData(sensors: string[], sensorMetadata: any[] = []) {
    await act(async () => {
        for (const cb of listenCallbacks['sensors-data'] ?? []) {
            cb({ payload: { sensors, selectedSensors: [], sensorMetadata } });
        }
    });
}

describe('AddSensorWindow', () => {
    it('shows a loading state until sensor data arrives', async () => {
        render(<AddSensorWindow />);
        expect(screen.getByText('Loading...')).toBeTruthy();
        await deliverSensorsData(['TAG1', 'TAG2']);
        expect(screen.queryByText('Loading...')).toBeNull();
    });

    it('requests sensors from the Dashboard on mount', async () => {
        render(<AddSensorWindow />);
        await act(async () => { await Promise.resolve(); });
        expect(mockEmit).toHaveBeenCalledWith('request-sensors', undefined);
    });

    it('falls back to get_all_sensors when no sensors-data event arrives', async () => {
        mockInvoke.mockImplementation((cmd: string) => {
            if (cmd === 'get_all_sensors') return Promise.resolve(['timestamp', 'TAG1', 'TAG2']);
            return Promise.resolve(undefined);
        });
        render(<AddSensorWindow />);
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(screen.queryByText('Loading...')).toBeNull();
        expect(last(explorerProps).sensors).toEqual(['TAG1', 'TAG2']); // 'timestamp' filtered out
    });

    it('toggling a sensor in the explorer updates the selection shared with SensorTooling', async () => {
        render(<AddSensorWindow />);
        await deliverSensorsData(['TAG1', 'TAG2']);
        fireEvent.click(screen.getByText('toggle-tag1'));
        expect(last(toolingProps).selectedSensors).toEqual(['TAG1']);
    });

    it('removing a sensor from SensorTooling deselects it (shared toggle handler)', async () => {
        render(<AddSensorWindow />);
        await deliverSensorsData(['TAG1', 'TAG2']);
        fireEvent.click(screen.getByText('toggle-tag1'));
        fireEvent.click(screen.getByText('remove-tag1'));
        expect(last(toolingProps).selectedSensors).toEqual([]);
    });

    it('adding raw sensors (no config/formula) emits them as-is with no new metadata', async () => {
        render(<AddSensorWindow />);
        await deliverSensorsData(['TAG1', 'TAG2']);
        fireEvent.click(screen.getByText('toggle-tag1'));
        await act(async () => {
            fireEvent.click(screen.getByText('Add sensor'));
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(mockEmit).toHaveBeenCalledWith('add-sensor-selection', { sensors: ['TAG1'], operation: null, newMetadata: [] });
        expect(screen.getByText(/Added 1 sensor/)).toBeTruthy();
    });

    it('blocks adding a named calculation with a blank name, without emitting', async () => {
        render(<AddSensorWindow />);
        await deliverSensorsData(['TAG1', 'TAG2']);
        fireEvent.click(screen.getByText('toggle-tag1'));
        fireEvent.click(screen.getByText('set-config-no-name'));

        await act(async () => {
            fireEvent.click(screen.getByText('Add sensor'));
            await Promise.resolve();
        });
        expect(screen.getByText('Give this sensor a name before adding it.')).toBeTruthy();
        expect(mockEmit).not.toHaveBeenCalledWith('add-sensor-selection', expect.anything());
        expect(mockInvoke).not.toHaveBeenCalledWith('calculate_new_sensor', expect.anything());
    });

    it('adding a legacy-config calculation invokes calculate_new_sensor and merges the new sensor into state', async () => {
        mockInvoke.mockImplementation((cmd: string) => {
            if (cmd === 'calculate_new_sensor') return Promise.resolve('CALC1');
            return Promise.resolve([]);
        });
        render(<AddSensorWindow />);
        await deliverSensorsData(['TAG1', 'TAG2']);
        fireEvent.click(screen.getByText('toggle-tag1'));
        fireEvent.click(screen.getByText('set-config'));
        fireEvent.click(screen.getByText('set-description'));
        fireEvent.click(screen.getByText('set-unit'));
        fireEvent.click(screen.getByText('set-component'));

        await act(async () => {
            fireEvent.click(screen.getByText('Add sensor'));
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(mockInvoke).toHaveBeenCalledWith('calculate_new_sensor', {
            sensors: ['TAG1'],
            config: { mode: 'single', singleOp: { type: 'add', value: 1 }, customName: 'MyCalc' },
        });
        expect(mockEmit).toHaveBeenCalledWith('add-sensor-selection', {
            sensors: ['TAG1', 'CALC1'],
            operation: null,
            newMetadata: [{ tag: 'CALC1', description: 'My Description', unit: 'bar', component: 'Pump' }],
        });
        expect(screen.getByText(/Added: My Description/)).toBeTruthy();
        // New sensor becomes pickable for the next round.
        expect(last(explorerProps).sensors).toContain('CALC1');
    });

    it('adding a formula calculation invokes evaluate_formula', async () => {
        mockInvoke.mockImplementation((cmd: string) => {
            if (cmd === 'evaluate_formula') return Promise.resolve('FORMULA1');
            return Promise.resolve([]);
        });
        render(<AddSensorWindow />);
        await deliverSensorsData(['TAG1', 'TAG2']);
        fireEvent.click(screen.getByText('toggle-tag1'));
        fireEvent.click(screen.getByText('toggle-tag2'));
        fireEvent.click(screen.getByText('submit-formula'));

        await act(async () => {
            fireEvent.click(screen.getByText('Add sensor'));
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(mockInvoke).toHaveBeenCalledWith('evaluate_formula', {
            formula: '$TAG1 + $TAG2',
            customName: 'FormulaCalc',
        });
        expect(mockEmit).toHaveBeenCalledWith('add-sensor-selection', expect.objectContaining({
            sensors: ['TAG1', 'TAG2', 'FORMULA1'],
        }));
    });

    it('accumulates pending sensors across multiple Add clicks (deduplicated)', async () => {
        mockInvoke.mockResolvedValue([]);
        render(<AddSensorWindow />);
        await deliverSensorsData(['TAG1', 'TAG2']);

        fireEvent.click(screen.getByText('toggle-tag1'));
        await act(async () => {
            fireEvent.click(screen.getByText('Add sensor'));
            await Promise.resolve();
            await Promise.resolve();
        });
        fireEvent.click(screen.getByText('toggle-tag2'));
        await act(async () => {
            fireEvent.click(screen.getByText('Add sensor'));
            await Promise.resolve();
            await Promise.resolve();
        });

        const lastEmitCall = last(mockEmit.mock.calls.filter((c) => c[0] === 'add-sensor-selection'))!;
        expect(lastEmitCall[1].sensors).toEqual(['TAG1', 'TAG2']);
    });

    it('shows an alert and stops loading when the backend call fails', async () => {
        mockInvoke.mockImplementation((cmd: string) => {
            if (cmd === 'calculate_new_sensor') return Promise.reject(new Error('boom'));
            return Promise.resolve([]);
        });
        render(<AddSensorWindow />);
        await deliverSensorsData(['TAG1', 'TAG2']);
        fireEvent.click(screen.getByText('toggle-tag1'));
        fireEvent.click(screen.getByText('set-config'));

        await act(async () => {
            fireEvent.click(screen.getByText('Add sensor'));
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('boom'));
    });

    it('Close closes the window', async () => {
        render(<AddSensorWindow />);
        await deliverSensorsData(['TAG1']);
        await act(async () => {
            fireEvent.click(screen.getByText('Close'));
            await Promise.resolve();
        });
        expect(mockClose).toHaveBeenCalled();
    });
});
