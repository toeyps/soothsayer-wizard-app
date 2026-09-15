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
// Partial mock: the Create tab's own tooling panel is stubbed out below
// (this file drives it through a handful of fake buttons rather than the
// real button UI), but `ButtonBuilder`/`BASE_OP_IDS` are re-exported from
// the real module untouched -- `SpecialSensorEditor` (rendered for real,
// not mocked, when the Manage tab's editor opens) imports those directly
// and needs the genuine component to exercise editing an operation-kind
// recipe end to end.
vi.mock('../components/windows/SensorTooling', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../components/windows/SensorTooling')>()),
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
        expect(mockEmit).toHaveBeenCalledWith('add-sensor-selection', { sensors: ['TAG1'], operation: null, newMetadata: [], newRecipes: [] });
        expect(screen.getByText(/Added 1 sensor/)).toBeTruthy();
    });

    it('disables Add sensor and lists every missing field for a named calculation with no name at all', async () => {
        render(<AddSensorWindow />);
        await deliverSensorsData(['TAG1', 'TAG2']);
        fireEvent.click(screen.getByText('toggle-tag1'));
        fireEvent.click(screen.getByText('set-config-no-name'));

        expect(screen.getByText('Fill in a name, a description, a unit, a component before adding.')).toBeTruthy();
        expect((screen.getByText('Add sensor') as HTMLButtonElement).disabled).toBe(true);

        await act(async () => {
            fireEvent.click(screen.getByText('Add sensor'));
            await Promise.resolve();
        });
        expect(mockEmit).not.toHaveBeenCalledWith('add-sensor-selection', expect.anything());
        expect(mockInvoke).not.toHaveBeenCalledWith('calculate_new_sensor', expect.anything());
    });

    it('enables Add sensor only once Description/Unit/Component are filled in too, not just Name', async () => {
        render(<AddSensorWindow />);
        await deliverSensorsData(['TAG1', 'TAG2']);
        fireEvent.click(screen.getByText('toggle-tag1'));
        fireEvent.click(screen.getByText('set-config')); // has a name ('MyCalc') already

        expect(screen.getByText('Fill in a description, a unit, a component before adding.')).toBeTruthy();
        expect((screen.getByText('Add sensor') as HTMLButtonElement).disabled).toBe(true);

        fireEvent.click(screen.getByText('set-description'));
        expect(screen.getByText('Fill in a unit, a component before adding.')).toBeTruthy();
        fireEvent.click(screen.getByText('set-unit'));
        fireEvent.click(screen.getByText('set-component'));
        expect(screen.queryByText(/Fill in/)).toBeNull();
        expect((screen.getByText('Add sensor') as HTMLButtonElement).disabled).toBe(false);
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
            newRecipes: [{
                kind: 'operation',
                tag: 'CALC1',
                sourceSensors: ['TAG1'],
                operationConfig: { mode: 'single', singleOp: { type: 'add', value: 1 }, customName: 'MyCalc' },
            }],
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
        fireEvent.click(screen.getByText('set-description'));
        fireEvent.click(screen.getByText('set-unit'));
        fireEvent.click(screen.getByText('set-component'));

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
        // 2026-09-01: the recipe (not just the metadata) is what lets a
        // reopened workspace recreate this column — see
        // WorkspaceState.specialSensorRecipes.
        expect(mockEmit).toHaveBeenCalledWith('add-sensor-selection', expect.objectContaining({
            newRecipes: [{ kind: 'formula', tag: 'FORMULA1', formula: '$TAG1 + $TAG2' }],
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
        fireEvent.click(screen.getByText('set-description'));
        fireEvent.click(screen.getByText('set-unit'));
        fireEvent.click(screen.getByText('set-component'));

        await act(async () => {
            fireEvent.click(screen.getByText('Add sensor'));
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('boom'));
    });

    // ---- Manage tab -----------------------------------------------------
    //
    // Deleting a special sensor is a cross-window handshake: this window
    // decides whether it is safe, then emits 'delete-special-sensors' and
    // Dashboard does the removing. The undo window sits in between, and
    // nothing has left this window until it closes.

    const specialA = { kind: 'formula', tag: 'special A', formula: '$TAG1 * 2' };
    const specialB = { kind: 'formula', tag: 'special B', formula: '${special A} + 10' };

    async function openManage(payload: Record<string, unknown>) {
        render(<AddSensorWindow />);
        await act(async () => {
            for (const cb of listenCallbacks['sensors-data'] ?? []) {
                cb({ payload: { sensors: ['TAG1'], selectedSensors: [], sensorMetadata: [], ...payload } });
            }
        });
        // Let the extract_formula_refs lookup settle.
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /Manage/ })); });
    }

    it('lists the special sensors the Dashboard sent, and only those', async () => {
        mockInvoke.mockImplementation((cmd: string) =>
            cmd === 'extract_formula_refs' ? Promise.resolve([[ 'TAG1' ]]) : Promise.resolve([]));
        await openManage({ specialSensorRecipes: [specialA] });
        expect(screen.getByText('special A')).toBeTruthy();
        expect(screen.getByRole('tab', { name: 'Manage (1)' })).toBeTruthy();
    });

    it('holds the delete back for the undo window, then tells the Dashboard', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            mockInvoke.mockImplementation((cmd: string) =>
                cmd === 'extract_formula_refs' ? Promise.resolve([[ 'TAG1' ]]) : Promise.resolve([]));
            await openManage({ specialSensorRecipes: [specialA] });

            await act(async () => { fireEvent.click(screen.getByLabelText('Delete special A')); });
            // Gone from the list immediately, but not yet from the workspace.
            expect(screen.queryByLabelText('Delete special A')).toBeNull();
            expect(mockEmit).not.toHaveBeenCalledWith('delete-special-sensors', expect.anything());

            await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
            expect(mockEmit).toHaveBeenCalledWith('delete-special-sensors', { tags: ['special A'] });
        } finally {
            vi.useRealTimers();
        }
    });

    it('undo puts the sensor back and never tells the Dashboard', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            mockInvoke.mockImplementation((cmd: string) =>
                cmd === 'extract_formula_refs' ? Promise.resolve([[ 'TAG1' ]]) : Promise.resolve([]));
            await openManage({ specialSensorRecipes: [specialA] });

            await act(async () => { fireEvent.click(screen.getByLabelText('Delete special A')); });
            await act(async () => { fireEvent.click(screen.getByText('Undo')); });
            await act(async () => { await vi.advanceTimersByTimeAsync(20000); });

            expect(screen.getByLabelText('Delete special A')).toBeTruthy();
            expect(mockEmit).not.toHaveBeenCalledWith('delete-special-sensors', expect.anything());
        } finally {
            vi.useRealTimers();
        }
    });

    it('closing the window commits a deletion still inside its undo window', async () => {
        mockInvoke.mockImplementation((cmd: string) =>
            cmd === 'extract_formula_refs' ? Promise.resolve([[ 'TAG1' ]]) : Promise.resolve([]));
        await openManage({ specialSensorRecipes: [specialA] });

        await act(async () => { fireEvent.click(screen.getByLabelText('Delete special A')); });
        await act(async () => {
            fireEvent.click(screen.getByText('Close'));
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(mockEmit).toHaveBeenCalledWith('delete-special-sensors', { tags: ['special A'] });
        expect(mockClose).toHaveBeenCalled();
    });

    it('refuses to delete a sensor another special sensor was built on', async () => {
        mockInvoke.mockImplementation((cmd: string) =>
            cmd === 'extract_formula_refs'
                ? Promise.resolve([['TAG1'], ['special A']])
                : Promise.resolve([]));
        await openManage({ specialSensorRecipes: [specialA, specialB] });

        expect((screen.getByLabelText('Delete special A') as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByLabelText('Delete special B') as HTMLButtonElement).disabled).toBe(false);
    });

    it('refuses to delete a sensor a Failure Group model uses', async () => {
        mockInvoke.mockImplementation((cmd: string) =>
            cmd === 'extract_formula_refs' ? Promise.resolve([[ 'TAG1' ]]) : Promise.resolve([]));
        await openManage({
            specialSensorRecipes: [specialA],
            models: [{
                id: 'm1', groupNos: [1], name: 'Boiler efficiency', kind: 'individual', category: null,
                notes: '', status: false, targetSensor: 'special A', predictorSensors: [], xSensor: '', ySensor: '',
                individualChecked: true, rcMode: null, scatterXSensor: '', relModelName: '', relStiffness: 100000,
                clusterModelName: '', numClusters: 3, criteriaSensor: '', clusterRanges: [],
                filterTimeStart: '', filterTimeEnd: '', pmSensorFilters: [],
            }],
        });
        expect((screen.getByLabelText('Delete special A') as HTMLButtonElement).disabled).toBe(true);
    });

    it('a sensor created on the Create tab shows up on the Manage tab', async () => {
        mockInvoke.mockImplementation((cmd: string) => {
            if (cmd === 'calculate_new_sensor') return Promise.resolve('MyCalc');
            if (cmd === 'extract_formula_refs') return Promise.resolve([]);
            return Promise.resolve([]);
        });
        render(<AddSensorWindow />);
        await deliverSensorsData(['TAG1']);
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
        await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /Manage/ })); });
        // By its delete button, not its name -- the "Added: MyCalc" toast is
        // still on screen and matches the name too.
        expect(screen.getByLabelText('Delete MyCalc')).toBeTruthy();
    });

    // ---- Manage tab: editing --------------------------------------------
    //
    // Editing is not a local change: the sensor's column lives in the Rust
    // session and anything built on top of it was computed from the OLD
    // values, so a save recomputes the sensor and then replays the whole
    // downstream chain before telling the dashboard.

    const chainA = { kind: 'formula', tag: 'A', formula: '$TAG1 * 2' };
    const chainB = { kind: 'formula', tag: 'B', formula: '${A} + 1' };
    const chainC = { kind: 'formula', tag: 'C', formula: '${B} * 3' };

    /** extract_formula_refs answers per formula text, so a mid-edit lookup for
     *  the NEW formula gets the right answer too. */
    function refsByFormula(map: Record<string, string[]>) {
        return (cmd: string, args?: any) => {
            if (cmd === 'extract_formula_refs') {
                return Promise.resolve((args.formulas as string[]).map(f => map[f] ?? []));
            }
            return Promise.resolve([]);
        };
    }

    const chainRefs = {
        '$TAG1 * 2': ['TAG1'],
        '${A} + 1': ['A'],
        '${B} * 3': ['B'],
    };

    // The real `SpecialSensorEditor` requires Description/Unit/Component
    // filled in too (see its own test file); `openManage`'s default
    // `sensorMetadata: []` leaves every recipe's editor opening blank, so
    // these tests fill them in before saving unless they're deliberately
    // exercising a DIFFERENT reason the save gets refused.
    const fillEditorRequiredFields = () => {
        fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'A description' } });
        fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'kPa' } });
        // Component is a select restricted to existing components --
        // "Uncategorized" is the one guaranteed to exist with `sensorMetadata: []`.
        fireEvent.change(screen.getByLabelText('Component'), { target: { value: 'Uncategorized' } });
    };

    it('editing a sensor recomputes it and everything built on top of it, in order', async () => {
        mockInvoke.mockImplementation(refsByFormula({ ...chainRefs, '$TAG1 * 5': ['TAG1'] }));
        await openManage({ specialSensorRecipes: [chainA, chainB, chainC] });

        await act(async () => { fireEvent.click(screen.getByLabelText('Edit A')); });
        fireEvent.change(screen.getByLabelText('Formula'), { target: { value: '$TAG1 * 5' } });
        fillEditorRequiredFields();
        await act(async () => {
            fireEvent.click(screen.getByText('Save changes'));
            await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        });

        const recomputes = mockInvoke.mock.calls
            .filter(([cmd]) => cmd === 'evaluate_formula')
            .map(([, args]) => args.customName);
        // A first (it is what changed), then its dependents in recipe order.
        expect(recomputes).toEqual(['A', 'B', 'C']);
        // Every one of them overwrites its column rather than appending.
        for (const [cmd, args] of mockInvoke.mock.calls) {
            if (cmd === 'evaluate_formula') expect(args.replace).toBe(true);
        }
    });

    it('tells the Dashboard about the edit, with the new recipe under the same tag', async () => {
        mockInvoke.mockImplementation(refsByFormula({ ...chainRefs, '$TAG1 * 5': ['TAG1'] }));
        await openManage({ specialSensorRecipes: [chainA] });

        await act(async () => { fireEvent.click(screen.getByLabelText('Edit A')); });
        fireEvent.change(screen.getByLabelText('Formula'), { target: { value: '$TAG1 * 5' } });
        fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'A description' } });
        fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'bar' } });
        fireEvent.change(screen.getByLabelText('Component'), { target: { value: 'Uncategorized' } });
        await act(async () => {
            fireEvent.click(screen.getByText('Save changes'));
            await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        });

        expect(mockEmit).toHaveBeenCalledWith('update-special-sensor', expect.objectContaining({
            recipe: { kind: 'formula', tag: 'A', formula: '$TAG1 * 5' },
            metadata: expect.objectContaining({ tag: 'A', unit: 'bar' }),
            recomputed: ['A'],
        }));
    });

    it('refuses an edit that would make a sensor depend on itself, and changes nothing', async () => {
        mockInvoke.mockImplementation(refsByFormula({ ...chainRefs, '${C} + 1': ['C'] }));
        await openManage({ specialSensorRecipes: [chainA, chainB, chainC] });

        await act(async () => { fireEvent.click(screen.getByLabelText('Edit A')); });
        // A reading C, which is two steps downstream of A, closes the loop.
        fireEvent.change(screen.getByLabelText('Formula'), { target: { value: '${C} + 1' } });
        fillEditorRequiredFields();
        await act(async () => {
            fireEvent.click(screen.getByText('Save changes'));
            await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        });

        expect(screen.getByRole('alert').textContent).toContain('depend on itself');
        expect(mockEmit).not.toHaveBeenCalledWith('update-special-sensor', expect.anything());
        expect(mockInvoke.mock.calls.some(([cmd, args]) => cmd === 'evaluate_formula' && args.replace)).toBe(false);
    });

    it('refuses a formula that references no sensor at all', async () => {
        mockInvoke.mockImplementation(refsByFormula({ ...chainRefs, '42': [] }));
        await openManage({ specialSensorRecipes: [chainA] });

        await act(async () => { fireEvent.click(screen.getByLabelText('Edit A')); });
        fireEvent.change(screen.getByLabelText('Formula'), { target: { value: '42' } });
        fillEditorRequiredFields();
        await act(async () => {
            fireEvent.click(screen.getByText('Save changes'));
            await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        });

        expect(screen.getByRole('alert').textContent).toContain('reference any sensor');
        expect(mockEmit).not.toHaveBeenCalledWith('update-special-sensor', expect.anything());
    });

    it('a failed recompute keeps the editor open and says which sensor failed', async () => {
        mockInvoke.mockImplementation((cmd: string, args?: any) => {
            if (cmd === 'extract_formula_refs') {
                return Promise.resolve((args.formulas as string[]).map((f: string) => (chainRefs as any)[f] ?? ['TAG1']));
            }
            if (cmd === 'evaluate_formula') return Promise.reject('Sensor not found: TAG1');
            return Promise.resolve([]);
        });
        await openManage({ specialSensorRecipes: [chainA] });

        await act(async () => { fireEvent.click(screen.getByLabelText('Edit A')); });
        fireEvent.change(screen.getByLabelText('Formula'), { target: { value: '$GONE * 2' } });
        fillEditorRequiredFields();
        await act(async () => {
            fireEvent.click(screen.getByText('Save changes'));
            await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        });

        expect(screen.getByRole('alert').textContent).toContain('Could not recompute "A"');
        expect(screen.getByText('Save changes')).toBeTruthy();
        expect(mockEmit).not.toHaveBeenCalledWith('update-special-sensor', expect.anything());
    });

    it('closes the editor and shows the edited recipe in the list after a successful save', async () => {
        mockInvoke.mockImplementation(refsByFormula({ ...chainRefs, '$TAG1 * 5': ['TAG1'] }));
        await openManage({ specialSensorRecipes: [chainA] });

        await act(async () => { fireEvent.click(screen.getByLabelText('Edit A')); });
        fireEvent.change(screen.getByLabelText('Formula'), { target: { value: '$TAG1 * 5' } });
        fillEditorRequiredFields();
        await act(async () => {
            fireEvent.click(screen.getByText('Save changes'));
            await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        });

        expect(screen.queryByLabelText('Formula')).toBeNull();
        expect(screen.getByText('$TAG1 * 5')).toBeTruthy();
    });

    // Editing an operation-kind recipe (`sum(...)`, `a + 10`, ...) uses the
    // same button UI as Create (`ButtonBuilder`, seeded from the existing
    // config) rather than a separate dropdown -- see
    // `SpecialSensorEditor.test.tsx` for that component's own coverage.
    // These two exercise the real end-to-end wiring through
    // `handleSaveEdit`: recompute, persist, and tell the Dashboard.
    const opRecipe = {
        kind: 'operation' as const, tag: 'Total flow', sourceSensors: ['TAG1', 'TAG2'],
        operationConfig: { mode: 'multi' as const, multiOp: { type: 'sum' as const }, customName: 'Total flow' },
    };

    it('editing an operation recipe (Sum all -> Average all) recomputes via calculate_new_sensor and stays an operation recipe', async () => {
        mockInvoke.mockImplementation((cmd: string) => (cmd === 'calculate_new_sensor' ? Promise.resolve('Total flow') : Promise.resolve([])));
        await openManage({ specialSensorRecipes: [opRecipe] });

        await act(async () => { fireEvent.click(screen.getByLabelText('Edit Total flow')); });
        fireEvent.click(screen.getByText('Average all'));
        fillEditorRequiredFields();
        await act(async () => {
            fireEvent.click(screen.getByText('Save changes'));
            await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        });

        expect(mockInvoke).toHaveBeenCalledWith('calculate_new_sensor', {
            sensors: ['TAG1', 'TAG2'],
            config: { mode: 'multi', multiOp: { type: 'mean' }, customName: 'Total flow' },
            replace: true,
        });
        expect(mockEmit).toHaveBeenCalledWith('update-special-sensor', expect.objectContaining({
            recipe: {
                kind: 'operation', tag: 'Total flow', sourceSensors: ['TAG1', 'TAG2'],
                operationConfig: { mode: 'multi', multiOp: { type: 'mean' }, customName: 'Total flow' },
            },
        }));
    });

    // The capability the whole button-UI reuse was for: a formula-backed
    // shortcut (unreachable through the old plain dropdown) upgrades the
    // SAVED recipe from operation-kind to formula-kind, exactly like
    // building one this way from scratch would.
    it('editing an operation recipe into a formula-backed shortcut (Absolute difference) recomputes via evaluate_formula and switches to a formula recipe', async () => {
        mockInvoke.mockImplementation((cmd: string) => {
            if (cmd === 'evaluate_formula') return Promise.resolve('Total flow');
            // handleSaveEdit resolves a formula-kind result's references
            // before recomputing it -- the sensors it will actually read.
            if (cmd === 'extract_formula_refs') return Promise.resolve([['TAG1', 'TAG2']]);
            return Promise.resolve([]);
        });
        await openManage({ specialSensorRecipes: [opRecipe] });

        await act(async () => { fireEvent.click(screen.getByLabelText('Edit Total flow')); });
        fireEvent.click(screen.getByText('Absolute difference'));
        fillEditorRequiredFields();
        await act(async () => {
            fireEvent.click(screen.getByText('Save changes'));
            await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        });

        expect(mockInvoke).toHaveBeenCalledWith('evaluate_formula', {
            formula: 'abs($TAG1 - $TAG2)', customName: 'Total flow', replace: true,
        });
        expect(mockEmit).toHaveBeenCalledWith('update-special-sensor', expect.objectContaining({
            recipe: { kind: 'formula', tag: 'Total flow', formula: 'abs($TAG1 - $TAG2)' },
        }));
    });

    // ---- Manage tab: renaming --------------------------------------------
    //
    // The Name field in the editor used to be locked; it's now a real input
    // (see `SpecialSensorEditor.test.tsx` for that component's own
    // validation coverage). These exercise the cascade `handleSaveEdit` runs
    // when a save also renames the sensor: every OTHER recipe that names the
    // old tag gets rewritten via `rename_formula_refs` BEFORE anything
    // replays, and the Dashboard is told via `rename-special-sensor` instead
    // of `update-special-sensor`.

    it('renaming a sensor with nothing built on top of it emits rename-special-sensor with no updatedRecipes', async () => {
        mockInvoke.mockImplementation(refsByFormula(chainRefs));
        await openManage({ specialSensorRecipes: [chainA] });

        await act(async () => { fireEvent.click(screen.getByLabelText('Edit A')); });
        fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'A2' } });
        fillEditorRequiredFields();
        await act(async () => {
            fireEvent.click(screen.getByText('Save changes'));
            await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        });

        expect(mockInvoke).not.toHaveBeenCalledWith('rename_formula_refs', expect.anything());
        expect(mockInvoke).toHaveBeenCalledWith('evaluate_formula', expect.objectContaining({ customName: 'A2', replace: true }));
        expect(mockEmit).toHaveBeenCalledWith('rename-special-sensor', {
            oldTag: 'A',
            newTag: 'A2',
            recipe: { kind: 'formula', tag: 'A2', formula: '$TAG1 * 2' },
            metadata: expect.objectContaining({ tag: 'A2' }),
            updatedRecipes: [],
        });
        expect(mockEmit).not.toHaveBeenCalledWith('update-special-sensor', expect.anything());
        // The row now shows the new tag, not the old one.
        expect(screen.queryByLabelText('Edit A')).toBeNull();
        expect(screen.getByLabelText('Edit A2')).toBeTruthy();
    });

    it('renaming rewrites every downstream formula\'s reference before replaying it, in order', async () => {
        mockInvoke.mockImplementation((cmd: string, args?: any) => {
            if (cmd === 'extract_formula_refs') {
                return Promise.resolve((args.formulas as string[]).map((f: string) => (chainRefs as any)[f] ?? []));
            }
            if (cmd === 'rename_formula_refs') {
                expect(args).toEqual({ formula: '${A} + 1', oldName: 'A', newName: 'A2' });
                return Promise.resolve('${A2} + 1');
            }
            if (cmd === 'evaluate_formula') return Promise.resolve('ok');
            return Promise.resolve([]);
        });
        await openManage({ specialSensorRecipes: [chainA, chainB] });

        await act(async () => { fireEvent.click(screen.getByLabelText('Edit A')); });
        fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'A2' } });
        fillEditorRequiredFields();
        await act(async () => {
            fireEvent.click(screen.getByText('Save changes'));
            await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        });

        expect(mockInvoke).toHaveBeenCalledWith('rename_formula_refs', { formula: '${A} + 1', oldName: 'A', newName: 'A2' });

        const recomputes = mockInvoke.mock.calls
            .filter(([cmd]) => cmd === 'evaluate_formula')
            .map(([, args]) => [args.customName, args.formula]);
        // A2 recomputes first (it's what changed), THEN B -- reading the
        // REWRITTEN formula, not the stale one still naming "A".
        expect(recomputes).toEqual([
            ['A2', '$TAG1 * 2'],
            ['B', '${A2} + 1'],
        ]);

        expect(mockEmit).toHaveBeenCalledWith('rename-special-sensor', expect.objectContaining({
            oldTag: 'A',
            newTag: 'A2',
            updatedRecipes: [{ kind: 'formula', tag: 'B', formula: '${A2} + 1' }],
        }));
    });

    it('blocks renaming to a tag another sensor already uses', async () => {
        mockInvoke.mockImplementation(refsByFormula(chainRefs));
        await openManage({ sensors: ['TAG1', 'B'], specialSensorRecipes: [chainA] });

        await act(async () => { fireEvent.click(screen.getByLabelText('Edit A')); });
        fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'B' } });
        expect(screen.getByText(/already in use by another sensor/)).toBeTruthy();
        expect((screen.getByText('Save changes') as HTMLButtonElement).disabled).toBe(true);

        await act(async () => {
            fireEvent.click(screen.getByText('Save changes'));
            await Promise.resolve();
        });
        expect(mockEmit).not.toHaveBeenCalledWith('rename-special-sensor', expect.anything());
        expect(mockInvoke).not.toHaveBeenCalledWith('rename_formula_refs', expect.anything());
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
