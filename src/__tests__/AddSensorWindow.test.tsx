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
                <button onClick={() => props.onConfigChange({ mode: 'single', singleOp: { type: 'add', value: 1 }, customName: 'tag1' })}>
                    set-config-tag1
                </button>
                <button onClick={() => props.onConfigChange({ mode: 'single', singleOp: { type: 'add', value: 1 }, customName: '  Tag2  ' })}>
                    set-config-padded-tag2
                </button>
                <button onClick={() => props.onConfigChange({ mode: 'single', singleOp: { type: 'add', value: 1 }, customName: 'SPECIAL a' })}>
                    set-config-special-a
                </button>
                <button onClick={() => props.onConfigChange({ mode: 'single', singleOp: { type: 'add', value: 1 }, customName: 'A' })}>
                    set-config-name-a
                </button>
                <button onClick={() => props.onConfigChange({ mode: 'single', singleOp: { type: 'add', value: 1 }, customName: 'a}b' })}>
                    set-config-brace
                </button>
                <button onClick={() => props.onConfigChange(null)}>clear-config</button>
                <button onClick={() => props.onFormulaSubmit('$TAG1 * 2', 'special A')}>submit-formula-special-a</button>
                {props.nameError && <p data-testid="tooling-name-error">{props.nameError}</p>}
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
        // `sensors` is a DELTA for the Dashboard's plot: just the new sensor,
        // never the source ('TAG1') it was built from.
        expect(mockEmit).toHaveBeenCalledWith('add-sensor-selection', {
            sensors: ['CALC1'],
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
        // Only the new sensor is plotted -- not TAG1/TAG2, the inputs.
        expect(mockEmit).toHaveBeenCalledWith('add-sensor-selection', expect.objectContaining({
            sensors: ['FORMULA1'],
        }));
        // 2026-09-01: the recipe (not just the metadata) is what lets a
        // reopened workspace recreate this column — see
        // WorkspaceState.specialSensorRecipes.
        expect(mockEmit).toHaveBeenCalledWith('add-sensor-selection', expect.objectContaining({
            newRecipes: [{ kind: 'formula', tag: 'FORMULA1', formula: '$TAG1 + $TAG2' }],
        }));
    });

    it('each Add click sends only ITS OWN delta -- nothing is accumulated or replayed (the Dashboard merges deltas into its current selection)', async () => {
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

        const sent = mockEmit.mock.calls.filter((c) => c[0] === 'add-sensor-selection');
        expect(sent.map(c => c[1].sensors)).toEqual([['TAG1'], ['TAG2']]);
    });

    it('shows the backend error inline (no blocking alert) and unlocks the button when the backend call fails', async () => {
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
        expect(window.alert).not.toHaveBeenCalled();
        expect(screen.getByRole('alert').textContent).toContain('boom');
        expect((screen.getByText('Add sensor').closest('button') as HTMLButtonElement).disabled).toBe(false);
        // Nothing was told to the Dashboard about a sensor that was never made.
        expect(mockEmit).not.toHaveBeenCalledWith('add-sensor-selection', expect.anything());
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
                filterTimePeriods: [], pmSensorFilters: [],
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

    // Visual refresh Phase 5 (2026-10-02): the Create tab's footer close
    // button is now labelled "Cancel" (matching the approved prototype's
    // `.mf` footer -- Cancel + Add sensor), not "Close" -- "Close" is still
    // used, unchanged, on the Manage tab (see the multi-project isolation
    // describe block below, which exercises that one). Both call the same
    // `handleClose` handler.
    it('Cancel closes the window (Create tab)', async () => {
        render(<AddSensorWindow />);
        await deliverSensorsData(['TAG1']);
        await act(async () => {
            fireEvent.click(screen.getByText('Cancel'));
            await Promise.resolve();
        });
        expect(mockClose).toHaveBeenCalled();
    });
});

describe('AddSensorWindow multi-project isolation', () => {
    async function deliverFor(workspaceId: string) {
        await act(async () => {
            for (const cb of listenCallbacks['sensors-data'] ?? []) {
                cb({ payload: { workspaceId, sensors: ['TAG1', 'TAG2'], selectedSensors: [], sensorMetadata: [] } });
            }
        });
    }
    async function addTag1() {
        fireEvent.click(screen.getByText('toggle-tag1'));
        await act(async () => {
            fireEvent.click(screen.getByText('Add sensor'));
            await Promise.resolve();
            await Promise.resolve();
        });
    }

    it('stamps the workspace id it was handed on what it emits, so the Dashboard can tell whose data it is (2026-09-21: a leftover window from the previous project used to push its special sensors, component and description into the newly opened one)', async () => {
        render(<AddSensorWindow />);
        await deliverFor('ws-A');
        await addTag1();
        expect(mockEmit).toHaveBeenCalledWith('add-sensor-selection', expect.objectContaining({ sensors: ['TAG1'], workspaceId: 'ws-A' }));
    });

    it('follows the Dashboard when it re-points this window at another workspace: the LATEST sensors-data decides the id it stamps', async () => {
        render(<AddSensorWindow />);
        await deliverFor('ws-A');
        await deliverFor('ws-B');
        await addTag1();
        const sent = mockEmit.mock.calls.filter((c) => c[0] === 'add-sensor-selection');
        expect(sent).toHaveLength(1);
        expect(sent[0][1].workspaceId).toBe('ws-B');
    });
});

// ═════════════════════════════════════════════════════════════════════════
// 2026-10-03 -- special sensor fixes: real column removal, name validation,
// plot delta, rename cleanup. These run against a FAKE BACKEND that enforces
// the same rules as the Rust side (`store_derived_column`,
// `remove_sensor_columns`), so "creating X again only works because the old X
// column was dropped" is actually exercised rather than assumed.
// ═════════════════════════════════════════════════════════════════════════

import { sensorRef } from '../utils/specialSensorNaming';

const tkey = (s: string) => s.trim().toLowerCase();

function fakeRust(opts: { raw?: string[]; derived?: string[]; failRemove?: boolean; failEval?: string[] } = {}) {
    const columns: string[] = [...(opts.raw ?? ['TAG1', 'TAG2']), ...(opts.derived ?? [])];
    const derived = new Set((opts.derived ?? []).map(tkey));
    const find = (n: string) => columns.findIndex(c => tkey(c) === tkey(n));
    const refsOf = (f: string): string[] =>
        [...f.matchAll(/\$\{([^}]+)\}|\$([\p{L}\p{N}_]+)/gu)].map(m => (m[1] ?? m[2]) as string);
    const write = (name: string, replace: boolean): string => {
        const clean = name.trim();
        const i = find(clean);
        if (i >= 0) {
            if (!replace) throw `A sensor named '${clean}' already exists`;
            if (!derived.has(tkey(clean))) throw `'${clean}' is an imported data column and cannot be overwritten`;
            columns[i] = clean; // header takes the new casing, position kept
        } else {
            columns.push(clean);
            derived.add(tkey(clean));
        }
        return clean;
    };
    const calls: Array<{ cmd: string; args: any }> = [];
    const invoke = async (cmd: string, args?: any): Promise<unknown> => {
        calls.push({ cmd, args });
        switch (cmd) {
            case 'extract_formula_refs':
                return (args.formulas as string[]).map(refsOf);
            case 'rename_formula_refs':
                return (args.formula as string).replace(/\$\{([^}]+)\}|\$([\p{L}\p{N}_]+)/gu, (m: string, a?: string, b?: string) =>
                    tkey((a ?? b) as string) === tkey(args.oldName) ? sensorRef(args.newName.trim()) : m);
            case 'remove_sensor_columns': {
                if (opts.failRemove) throw 'disk on fire';
                let n = 0;
                for (const name of args.names as string[]) {
                    const i = find(name);
                    if (i >= 0 && derived.has(tkey(columns[i]))) {
                        derived.delete(tkey(columns[i]));
                        columns.splice(i, 1);
                        n++;
                    }
                }
                return n;
            }
            case 'evaluate_formula': {
                if (opts.failEval?.includes(args.customName)) throw new Error(`boom ${args.customName}`);
                for (const r of refsOf(args.formula)) if (find(r) < 0) throw `Sensor not found: ${r}`;
                return write(args.customName, !!args.replace);
            }
            case 'calculate_new_sensor': {
                for (const s of args.sensors as string[]) if (find(s) < 0) throw `Sensor not found: ${s}`;
                return write(args.config.customName, !!args.replace);
            }
            default:
                return [];
        }
    };
    return { columns, derived, calls, invoke, has: (n: string) => find(n) >= 0, names: (cmd: string) => calls.filter(c => c.cmd === cmd) };
}

async function openWindow(payload: Record<string, unknown> = {}) {
    render(<AddSensorWindow />);
    await act(async () => {
        for (const cb of listenCallbacks['sensors-data'] ?? []) {
            cb({ payload: { sensors: ['TAG1', 'TAG2'], selectedSensors: [], sensorMetadata: [], ...payload } });
        }
    });
    // Let the extract_formula_refs lookup settle.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

const goManage = async () => { await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /Manage/ })); }); };
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await act(async () => { await Promise.resolve(); }); };
const addBtn = () => screen.getByText('Add sensor').closest('button') as HTMLButtonElement;
const fillMeta = () => {
    fireEvent.click(screen.getByText('set-description'));
    fireEvent.click(screen.getByText('set-unit'));
    fireEvent.click(screen.getByText('set-component'));
};
const fillEditor = () => {
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'A description' } });
    fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'kPa' } });
    fireEvent.change(screen.getByLabelText('Component'), { target: { value: 'Uncategorized' } });
};

const recA = { kind: 'formula' as const, tag: 'A', formula: '$TAG1 * 2' };
const recB = { kind: 'formula' as const, tag: 'B', formula: '${A} + 1' };

describe('AddSensorWindow: create -- name validation, double submit, backend errors', () => {
    it('A: a created sensor reports ONLY itself to plot; the picked source sensors are not sent', async () => {
        const rust = fakeRust();
        mockInvoke.mockImplementation(rust.invoke);
        await openWindow();
        fireEvent.click(screen.getByText('toggle-tag1'));
        fireEvent.click(screen.getByText('toggle-tag2'));
        fireEvent.click(screen.getByText('set-config'));
        fillMeta();
        await act(async () => { fireEvent.click(addBtn()); });
        await flush();
        const payload = last(mockEmit.mock.calls.filter(c => c[0] === 'add-sensor-selection'))![1];
        expect(payload.sensors).toEqual(['MyCalc']);
        expect(payload.newRecipes[0].sourceSensors).toEqual(['TAG1', 'TAG2']); // still remembered as the recipe's inputs
    });

    it('A: "add as-is" has nothing to create, so it sends the picked raw sensors to plot', async () => {
        mockInvoke.mockImplementation(fakeRust().invoke);
        await openWindow();
        fireEvent.click(screen.getByText('toggle-tag1'));
        fireEvent.click(screen.getByText('toggle-tag2'));
        await act(async () => { fireEvent.click(addBtn()); });
        await flush();
        expect(mockEmit).toHaveBeenCalledWith('add-sensor-selection', expect.objectContaining({
            sensors: ['TAG1', 'TAG2'], newMetadata: [], newRecipes: [],
        }));
    });

    it('D: a name that equals an existing sensor is flagged inline on the Name field and Add stays disabled -- nothing is sent to the backend', async () => {
        mockInvoke.mockImplementation(fakeRust().invoke);
        await openWindow();
        fireEvent.click(screen.getByText('toggle-tag1'));
        fireEvent.click(screen.getByText('set-config-tag1')); // customName 'tag1' vs existing 'TAG1'
        fillMeta();
        expect(screen.getByTestId('tooling-name-error').textContent).toMatch(/"TAG1" already exists/);
        expect(addBtn().disabled).toBe(true);
        expect(screen.getByText('Fix the name before adding.')).toBeTruthy();
        await act(async () => { fireEvent.click(addBtn()); });
        expect(mockInvoke).not.toHaveBeenCalledWith('calculate_new_sensor', expect.anything());
        expect(mockEmit).not.toHaveBeenCalledWith('add-sensor-selection', expect.anything());
    });

    it('D: the check ignores case and surrounding whitespace', async () => {
        await openWindow();
        fireEvent.click(screen.getByText('toggle-tag1'));
        fireEvent.click(screen.getByText('set-config-padded-tag2')); // '  Tag2  '
        expect(screen.getByTestId('tooling-name-error').textContent).toMatch(/already exists/);
    });

    it('D: it covers existing SPECIAL sensors too (from the Dashboard\'s sensor list and from the recipes), not only imported columns', async () => {
        await openWindow({ sensors: ['TAG1', 'special A'], specialSensorRecipes: [{ kind: 'formula', tag: 'special A', formula: '$TAG1' }] });
        fireEvent.click(screen.getByText('toggle-tag1'));
        fireEvent.click(screen.getByText('set-config-special-a'));
        expect(screen.getByTestId('tooling-name-error')).toBeTruthy();
    });

    it('D: the formula path\'s name is checked as well', async () => {
        await openWindow({ sensors: ['TAG1', 'special A'], specialSensorRecipes: [{ kind: 'formula', tag: 'special A', formula: '$TAG1' }] });
        fireEvent.click(screen.getByText('toggle-tag1'));
        fireEvent.click(screen.getByText('submit-formula-special-a'));
        fillMeta();
        expect(screen.getByTestId('tooling-name-error').textContent).toMatch(/"special A" already exists/);
        expect(addBtn().disabled).toBe(true);
    });

    it('E: a name containing "}" is blocked at naming time with a clear message', async () => {
        await openWindow();
        fireEvent.click(screen.getByText('toggle-tag1'));
        fireEvent.click(screen.getByText('set-config-brace'));
        fillMeta();
        expect(screen.getByTestId('tooling-name-error').textContent).toMatch(/can't contain "}"/);
        expect(addBtn().disabled).toBe(true);
    });

    it('D: a free name shows no conflict', async () => {
        await openWindow();
        fireEvent.click(screen.getByText('toggle-tag1'));
        fireEvent.click(screen.getByText('set-config')); // 'MyCalc'
        expect(screen.queryByTestId('tooling-name-error')).toBeNull();
    });

    it('D: a double click creates ONCE -- the second click is swallowed by the in-flight guard, not turned into a duplicate-name error', async () => {
        const rust = fakeRust();
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        mockInvoke.mockImplementation(async (cmd: string, args?: any) => {
            if (cmd === 'calculate_new_sensor') await gate;
            return rust.invoke(cmd, args);
        });
        await openWindow();
        fireEvent.click(screen.getByText('toggle-tag1'));
        fireEvent.click(screen.getByText('set-config'));
        fillMeta();

        await act(async () => {
            const b = addBtn();
            b.click();
            b.click(); // both land before React re-renders the button disabled
        });
        expect(addBtn().disabled).toBe(true); // locked while the call is in flight
        await act(async () => { release(); await gate; });
        await flush();

        expect(rust.names('calculate_new_sensor')).toHaveLength(1);
        expect(mockEmit.mock.calls.filter(c => c[0] === 'add-sensor-selection')).toHaveLength(1);
        expect(screen.queryByRole('alert')).toBeNull(); // no "already exists" from a second attempt
    });

    it('D: the picker does not flash to "Loading..." while a sensor is being created', async () => {
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        const rust = fakeRust();
        mockInvoke.mockImplementation(async (cmd: string, args?: any) => {
            if (cmd === 'calculate_new_sensor') await gate;
            return rust.invoke(cmd, args);
        });
        await openWindow();
        fireEvent.click(screen.getByText('toggle-tag1'));
        fireEvent.click(screen.getByText('set-config'));
        fillMeta();
        await act(async () => { addBtn().click(); });
        expect(screen.queryByText('Loading...')).toBeNull();
        expect(screen.getByTestId('sensor-explorer')).toBeTruthy();
        await act(async () => { release(); await gate; });
        await flush();
    });

    it('D: when the backend still says "already exists" (a race), it is shown inline, the name is flagged, and no blocking alert pops up', async () => {
        const rust = fakeRust({ raw: ['TAG1', 'TAG2', 'MyCalc'] }); // window doesn't know about 'MyCalc'
        mockInvoke.mockImplementation(rust.invoke);
        await openWindow();
        fireEvent.click(screen.getByText('toggle-tag1'));
        fireEvent.click(screen.getByText('set-config')); // 'MyCalc'
        fillMeta();
        await act(async () => { fireEvent.click(addBtn()); });
        await flush();

        expect(window.alert).not.toHaveBeenCalled();
        // Surfaced as the name's own problem, so the same click can't fail again.
        expect(screen.getByTestId('tooling-name-error').textContent).toMatch(/"MyCalc" already exists/);
        expect(addBtn().disabled).toBe(true);
        expect(mockEmit).not.toHaveBeenCalledWith('add-sensor-selection', expect.anything());
    });

    it('D: a generic backend error stays inline until the user changes something, then goes away', async () => {
        mockInvoke.mockImplementation(async (cmd: string) => {
            if (cmd === 'calculate_new_sensor') throw 'Sensor not found: GONE';
            return [];
        });
        await openWindow();
        fireEvent.click(screen.getByText('toggle-tag1'));
        fireEvent.click(screen.getByText('set-config'));
        fillMeta();
        await act(async () => { fireEvent.click(addBtn()); });
        await flush();
        expect(screen.getByRole('alert').textContent).toContain('Sensor not found: GONE');
        expect(window.alert).not.toHaveBeenCalled();

        fireEvent.click(screen.getByText('toggle-tag2')); // the selection changed -> the old failure no longer applies
        expect(screen.queryByText(/Sensor not found: GONE/)).toBeNull();
    });
});

describe('AddSensorWindow: delete really drops the column', () => {
    async function deleteViaUi(tag: string) {
        await act(async () => { fireEvent.click(screen.getByLabelText(`Delete ${tag}`)); });
    }

    it('B: after the undo window it calls remove_sensor_columns with the deleted name BEFORE telling the Dashboard', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            const rust = fakeRust({ derived: ['A'] });
            const timeline: string[] = [];
            mockInvoke.mockImplementation(async (cmd: string, args?: any) => { timeline.push(`invoke:${cmd}`); return rust.invoke(cmd, args); });
            mockEmit.mockImplementation(async (e: string) => { timeline.push(`emit:${e}`); });
            await openWindow({ sensors: ['TAG1', 'A'], specialSensorRecipes: [recA] });
            await goManage();
            await deleteViaUi('A');
            expect(rust.names('remove_sensor_columns')).toHaveLength(0); // still inside the undo window

            await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
            expect(rust.names('remove_sensor_columns').map(c => c.args)).toEqual([{ names: ['A'] }]);
            expect(timeline.indexOf('invoke:remove_sensor_columns')).toBeGreaterThan(-1);
            expect(timeline.indexOf('invoke:remove_sensor_columns')).toBeLessThan(timeline.indexOf('emit:delete-special-sensors'));
            expect(rust.has('A')).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('B: Undo never touches the backend', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            const rust = fakeRust({ derived: ['A'] });
            mockInvoke.mockImplementation(rust.invoke);
            await openWindow({ sensors: ['TAG1', 'A'], specialSensorRecipes: [recA] });
            await goManage();
            await deleteViaUi('A');
            await act(async () => { fireEvent.click(screen.getByText('Undo')); });
            await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
            expect(rust.names('remove_sensor_columns')).toHaveLength(0);
            expect(rust.has('A')).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('B: closing the window mid-undo drops the column too', async () => {
        const rust = fakeRust({ derived: ['A'] });
        mockInvoke.mockImplementation(rust.invoke);
        await openWindow({ sensors: ['TAG1', 'A'], specialSensorRecipes: [recA] });
        await goManage();
        await deleteViaUi('A');
        await act(async () => { fireEvent.click(screen.getByText('Close')); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
        await flush();
        expect(rust.names('remove_sensor_columns').map(c => c.args)).toEqual([{ names: ['A'] }]);
        expect(mockClose).toHaveBeenCalled();
    });

    it('B: a failing removal is surfaced (not swallowed) but the UI deletion still completes and the Dashboard is still told', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const rust = fakeRust({ derived: ['A'], failRemove: true });
            mockInvoke.mockImplementation(rust.invoke);
            await openWindow({ sensors: ['TAG1', 'A'], specialSensorRecipes: [recA] });
            await goManage();
            await deleteViaUi('A');
            await act(async () => { await vi.advanceTimersByTimeAsync(8000); });

            const toast = screen.getByRole('alert');
            expect(toast.textContent).toMatch(/couldn't free its data/);
            expect(toast.textContent).toContain('disk on fire');
            expect(mockEmit).toHaveBeenCalledWith('delete-special-sensors', { tags: ['A'], workspaceId: undefined });
            expect(screen.queryByLabelText('Delete A')).toBeNull();
            expect(errSpy).toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('B: a sensor something else is built on is still refused -- nothing is removed', async () => {
        const rust = fakeRust({ derived: ['A', 'B'] });
        mockInvoke.mockImplementation(rust.invoke);
        await openWindow({ sensors: ['TAG1', 'A', 'B'], specialSensorRecipes: [recA, recB] });
        await goManage();
        expect((screen.getByLabelText('Delete A') as HTMLButtonElement).disabled).toBe(true);
        expect(rust.names('remove_sensor_columns')).toHaveLength(0);
    });

    it('G (the reported bug, end to end): delete X, then create X again with different numbers -- the new sensor works only because the old column was really dropped', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            const rust = fakeRust({ derived: ['special A'] });
            mockInvoke.mockImplementation(rust.invoke);
            await openWindow({ sensors: ['TAG1', 'TAG2', 'special A'], specialSensorRecipes: [{ kind: 'formula', tag: 'special A', formula: '$TAG1 * 2' }] });
            await goManage();
            await deleteViaUi('special A');
            await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
            expect(rust.has('special A')).toBe(false);

            // Back to Create: the same name is free again.
            await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /Create/ })); });
            fireEvent.click(screen.getByText('toggle-tag2'));
            fireEvent.click(screen.getByText('submit-formula-special-a')); // $TAG1 * 2 named 'special A'
            fillMeta();
            expect(screen.queryByTestId('tooling-name-error')).toBeNull();
            await act(async () => { fireEvent.click(addBtn()); });
            await flush();

            expect(rust.columns.filter(c => tkey(c) === 'special a')).toHaveLength(1); // one column, not two
            expect(mockEmit).toHaveBeenCalledWith('add-sensor-selection', expect.objectContaining({ sensors: ['special A'] }));
        } finally {
            vi.useRealTimers();
        }
    });

    it('G: the same fake backend REFUSES the recreate when remove_sensor_columns was never called (proves the fake enforces the new Rust rule the test above depends on)', async () => {
        const rust = fakeRust({ derived: ['special A'] });
        await expect(rust.invoke('evaluate_formula', { formula: '$TAG1', customName: 'special A' }))
            .rejects.toMatch(/already exists/);
    });

    it('G: a name still inside its undo window can be reused at once -- the pending delete is settled first, then the sensor is created', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            const rust = fakeRust({ derived: ['special A'] });
            const timeline: string[] = [];
            mockInvoke.mockImplementation(async (cmd: string, args?: any) => { timeline.push(cmd); return rust.invoke(cmd, args); });
            mockEmit.mockImplementation(async (e: string) => { timeline.push(`emit:${e}`); });
            await openWindow({ sensors: ['TAG1', 'TAG2', 'special A'], specialSensorRecipes: [{ kind: 'formula', tag: 'special A', formula: '$TAG1 * 2' }] });
            await goManage();
            await deleteViaUi('special A'); // inside the 8 s undo window now
            await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /Create/ })); });
            fireEvent.click(screen.getByText('toggle-tag1'));
            fireEvent.click(screen.getByText('submit-formula-special-a'));
            fillMeta();
            expect(screen.queryByTestId('tooling-name-error')).toBeNull(); // not flagged as taken
            await act(async () => { fireEvent.click(addBtn()); });
            await flush();

            expect(timeline.indexOf('remove_sensor_columns')).toBeLessThan(timeline.indexOf('evaluate_formula'));
            expect(rust.columns.filter(c => tkey(c) === 'special a')).toHaveLength(1);
            expect(mockEmit).toHaveBeenCalledWith('add-sensor-selection', expect.objectContaining({ sensors: ['special A'] }));
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('AddSensorWindow: rename drops the OLD column, last', () => {
    async function openChain(extra: Record<string, unknown> = {}, rustOpts = {}) {
        const rust = fakeRust({ derived: ['A', 'B'], ...rustOpts });
        const timeline: string[] = [];
        mockInvoke.mockImplementation(async (cmd: string, args?: any) => {
            const r = await rust.invoke(cmd, args);
            timeline.push(cmd === 'evaluate_formula' ? `eval:${args.customName}` : cmd === 'remove_sensor_columns' ? `remove:${args.names.join(',')}` : cmd);
            return r;
        });
        mockEmit.mockImplementation(async (e: string) => { timeline.push(`emit:${e}`); });
        await openWindow({ sensors: ['TAG1', 'A', 'B'], specialSensorRecipes: [recA, recB], ...extra });
        await goManage();
        return { rust, timeline };
    }
    async function renameTo(from: string, to: string) {
        await act(async () => { fireEvent.click(screen.getByLabelText(`Edit ${from}`)); });
        fireEvent.change(screen.getByLabelText('Name'), { target: { value: to } });
        fillEditor();
        await act(async () => { fireEvent.click(screen.getByText('Save changes')); });
        await flush(10);
    }

    it('C: the new column is built first, the downstream recipe is replayed against the NEW name, the Dashboard is told, and only then the OLD column is removed', async () => {
        const { rust, timeline } = await openChain();
        await renameTo('A', 'A2');

        const steps = timeline.filter(t => t.startsWith('eval:') || t.startsWith('remove:') || t.startsWith('emit:rename'));
        expect(steps).toEqual(['eval:A2', 'eval:B', 'emit:rename-special-sensor', 'remove:A']);
        // B was replayed with the rewritten formula -- no recipe was ever run against the old name after it went.
        const evalB = rust.names('evaluate_formula').find(c => c.args.customName === 'B')!;
        expect(evalB.args.formula).toBe('$A2 + 1'); // bare: A2 is alphanumeric
        expect(rust.has('A')).toBe(false);
        expect(rust.has('A2')).toBe(true);
        expect(rust.has('B')).toBe(true);
    });

    it('C: a rename that only changes the CASE does not remove anything (the backend overwrites that very column in place; removing "the old one" would delete the new)', async () => {
        const { rust } = await openChain();
        await renameTo('A', 'a');
        expect(rust.names('remove_sensor_columns')).toHaveLength(0);
        expect(rust.columns.filter(c => tkey(c) === 'a')).toEqual(['a']); // one column, new casing
        expect(mockEmit).toHaveBeenCalledWith('rename-special-sensor', expect.objectContaining({ oldTag: 'A', newTag: 'a' }));
        // The dependent still resolves: its formula was rewritten to the new spelling and replayed.
        expect(rust.names('evaluate_formula').find(c => c.args.customName === 'B')!.args.formula).toBe('$a + 1');
    });

    it('C: if a downstream recompute fails, the old column is NOT removed, the Dashboard is NOT told, and the half-built new column is cleaned up', async () => {
        const { rust } = await openChain({}, { failEval: ['B'] });
        await renameTo('A', 'A2');

        expect(screen.getByRole('alert').textContent).toContain('Could not recompute "B"');
        expect(rust.names('remove_sensor_columns').map(c => c.args.names)).toEqual([['A2']]); // only the orphan, never 'A'
        expect(rust.has('A')).toBe(true);
        expect(rust.has('A2')).toBe(false);
        expect(mockEmit).not.toHaveBeenCalledWith('rename-special-sensor', expect.anything());
    });

    it('C: if removing the old column fails AFTER everything else worked, the rename still stands and the problem is reported', async () => {
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { rust } = await openChain({}, { failRemove: true });
        await renameTo('A', 'A2');
        expect(mockEmit).toHaveBeenCalledWith('rename-special-sensor', expect.objectContaining({ oldTag: 'A', newTag: 'A2' }));
        expect(screen.queryByLabelText('Name')).toBeNull(); // editor closed -- not reported as a failed save
        expect(screen.getByLabelText('Edit A2')).toBeTruthy();
        expect(screen.getByRole('alert').textContent).toMatch(/couldn't free the old data/);
        expect(rust.has('A2')).toBe(true);
        errSpy.mockRestore();
    });

    it('C: refuses to edit while the "what depends on this" lookup has failed -- it could not rewrite dependents it does not know about, then drop the old column from under them', async () => {
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const rust = fakeRust({ derived: ['A', 'B'] });
        mockInvoke.mockImplementation(async (cmd: string, args?: any) => {
            if (cmd === 'extract_formula_refs' && (args.formulas as string[]).length > 1) throw new Error('lookup down');
            return rust.invoke(cmd, args);
        });
        await openWindow({ sensors: ['TAG1', 'A', 'B'], specialSensorRecipes: [recA, recB] });
        await goManage();
        await act(async () => { fireEvent.click(screen.getByLabelText('Edit A')); });
        fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'A2' } });
        fillEditor();
        await act(async () => { fireEvent.click(screen.getByText('Save changes')); });
        await flush();
        expect(screen.getByRole('alert').textContent).toMatch(/Still working out which sensors/);
        expect(rust.names('remove_sensor_columns')).toHaveLength(0);
        expect(rust.names('evaluate_formula')).toHaveLength(0);
        errSpy.mockRestore();
    });

    it('C: after a rename the old name is free again, end to end (the "reused an old name after a rename" bug)', async () => {
        const { rust } = await openChain();
        // While A exists, the name is taken...
        await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /Create/ })); });
        fireEvent.click(screen.getByText('toggle-tag1'));
        fireEvent.click(screen.getByText('set-config-name-a'));
        expect(screen.getByTestId('tooling-name-error')).toBeTruthy();
        // ...rename it away...
        await goManage();
        await renameTo('A', 'A2');
        // ...and "A" can be created again (the fake backend would refuse it if A's column were still there).
        await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /Create/ })); });
        fireEvent.click(screen.getByText('toggle-tag1'));
        fireEvent.click(screen.getByText('set-config-name-a'));
        fillMeta();
        expect(screen.queryByTestId('tooling-name-error')).toBeNull();
        await act(async () => { fireEvent.click(addBtn()); });
        await flush();
        expect(rust.columns.filter(c => tkey(c) === 'a')).toEqual(['A']);
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('G: an edit that points an early sensor at a LATER one reports a recipeOrder, so a reopened workspace replays them in a valid order', async () => {
        // A = $TAG1 * 2 (first), C = $TAG1 + 1 (created later). Edit A to read C.
        const recC = { kind: 'formula' as const, tag: 'C', formula: '$TAG1 + 1' };
        const rust = fakeRust({ derived: ['A', 'C'] });
        mockInvoke.mockImplementation(rust.invoke);
        await openWindow({ sensors: ['TAG1', 'A', 'C'], specialSensorRecipes: [recA, recC] });
        await goManage();
        await act(async () => { fireEvent.click(screen.getByLabelText('Edit A')); });
        fireEvent.change(screen.getByLabelText('Formula'), { target: { value: '$C * 2' } });
        fillEditor();
        await act(async () => { fireEvent.click(screen.getByText('Save changes')); });
        await flush(10);
        expect(mockEmit).toHaveBeenCalledWith('update-special-sensor', expect.objectContaining({ recipeOrder: ['C', 'A'] }));
    });

    it('G: an edit that keeps the order valid sends no recipeOrder at all', async () => {
        const rust = fakeRust({ derived: ['A', 'B'] });
        mockInvoke.mockImplementation(rust.invoke);
        await openWindow({ sensors: ['TAG1', 'A', 'B'], specialSensorRecipes: [recA, recB] });
        await goManage();
        await act(async () => { fireEvent.click(screen.getByLabelText('Edit A')); });
        fireEvent.change(screen.getByLabelText('Formula'), { target: { value: '$TAG1 * 5' } });
        fillEditor();
        await act(async () => { fireEvent.click(screen.getByText('Save changes')); });
        await flush(10);
        const sent = last(mockEmit.mock.calls.filter(c => c[0] === 'update-special-sensor'))![1];
        expect(sent.recipeOrder).toBeUndefined();
    });
});

describe('AddSensorWindow: delete protection follows models that change while the window is open', () => {
    const usingA = {
        id: 'm1', groupNos: [1], name: 'Uses A', kind: 'individual', category: null,
        notes: '', status: false, targetSensor: 'A', predictorSensors: [], xSensor: '', ySensor: '',
        individualChecked: true, rcMode: null, scatterXSensor: '', relModelName: '', relStiffness: 100000,
        clusterModelName: '', numClusters: 3, criteriaSensor: '', clusterRanges: [],
        filterTimePeriods: [], runningConditionMode: 'workspace', customRunningConditionFilters: [], customRunningConditionCombine: 'and',
    };
    const broadcast = async (payload: Record<string, unknown>) => {
        await act(async () => {
            for (const cb of listenCallbacks['failure-group-state-changed'] ?? []) cb({ payload });
        });
    };

    it('a model that starts using a special sensor AFTER the window opened blocks its deletion (a delete now drops the column for real)', async () => {
        const rust = fakeRust({ derived: ['A'] });
        mockInvoke.mockImplementation(rust.invoke);
        await openWindow({ workspaceId: 'ws-1', sensors: ['TAG1', 'A'], specialSensorRecipes: [recA], models: [] });
        await goManage();
        expect((screen.getByLabelText('Delete A') as HTMLButtonElement).disabled).toBe(false);

        await broadcast({ workspaceId: 'ws-1', groups: [], models: [usingA] });
        expect((screen.getByLabelText('Delete A') as HTMLButtonElement).disabled).toBe(true);
    });

    it('ignores a broadcast from another project (or one with no workspace id)', async () => {
        mockInvoke.mockImplementation(fakeRust({ derived: ['A'] }).invoke);
        await openWindow({ workspaceId: 'ws-1', sensors: ['TAG1', 'A'], specialSensorRecipes: [recA], models: [] });
        await goManage();
        await broadcast({ workspaceId: 'ws-OTHER', groups: [], models: [usingA] });
        await broadcast({ groups: [], models: [usingA] });
        expect((screen.getByLabelText('Delete A') as HTMLButtonElement).disabled).toBe(false);
    });
});
