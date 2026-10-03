import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';

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

// The window re-reads the models and the workspace Running condition from the
// workspace FILE (on a failure-group broadcast, and right before a delete is
// committed). `disk` is what a real writer (Build Model / Dashboard) would have
// persisted; a test that makes another window change a model writes it here
// FIRST, then broadcasts -- exactly what the real writers do.
const disk: { models: any[]; rc: any[]; missing: boolean; failRead: boolean } = { models: [], rc: [], missing: false, failRead: false };
const mockLoadWorkspace = vi.fn(async (id: string) => {
    if (disk.failRead) throw new Error('disk unavailable');
    if (disk.missing) return null;
    return { id, failureGroupState: { groups: [], models: structuredClone(disk.models), runningConditionFilters: structuredClone(disk.rc) } };
});
vi.mock('../workspaceManager', () => ({
    loadWorkspaceData: (id: string) => mockLoadWorkspace(id),
}));

// Most tests drive the window through small STAND-INS for the Explorer and the
// tooling panel. The create flow itself is covered with the REAL components in
// the "real components" describe at the bottom (one test per path) -- flip
// `real.*` to render the genuine component instead of the stand-in. A stand-in
// alone cannot see state that lives INSIDE the real tooling (it is exactly how
// "the form is not cleared after an Add" went unnoticed).
const real = vi.hoisted(() => ({ tooling: false, explorer: false }));

const explorerProps: any[] = [];
vi.mock('../components/windows/SensorExplorer', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../components/windows/SensorExplorer')>();
    return {
        default: (props: any) => {
            explorerProps.push(props);
            if (real.explorer) {
                const Real = actual.default;
                return <Real {...props} />;
            }
            return (
                <div data-testid="sensor-explorer">
                    <button onClick={() => props.onToggleSensor('TAG1')}>toggle-tag1</button>
                    <button onClick={() => props.onToggleSensor('TAG2')}>toggle-tag2</button>
                </div>
            );
        },
    };
});

const toolingProps: any[] = [];
// Partial mock: the Create tab's own tooling panel is stubbed out below
// (this file drives it through a handful of fake buttons rather than the
// real button UI), but `ButtonBuilder`/`BASE_OP_IDS` are re-exported from
// the real module untouched -- `SpecialSensorEditor` (rendered for real,
// not mocked, when the Manage tab's editor opens) imports those directly
// and needs the genuine component to exercise editing an operation-kind
// recipe end to end.
vi.mock('../components/windows/SensorTooling', async (importOriginal) => {
  const actualTooling = await importOriginal<typeof import('../components/windows/SensorTooling')>();
  return {
    ...actualTooling,
    default: (props: any) => {
        toolingProps.push(props);
        if (real.tooling) {
            const Real = actualTooling.default;
            return <Real {...props} />;
        }
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
  };
});

import AddSensorWindow from '../components/windows/AddSensorWindow';

function last<T>(arr: T[]): T {
    return arr[arr.length - 1];
}

beforeEach(() => {
    real.tooling = false; real.explorer = false;
    disk.models = []; disk.rc = []; disk.missing = false; disk.failRead = false;
    mockLoadWorkspace.mockClear();
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
            cb({ payload: { sensors, selectedSensors: [], sensorMetadata, models: [] } });
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
                cb({ payload: { sensors: ['TAG1'], selectedSensors: [], sensorMetadata: [], models: [], ...payload } });
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
                cb({ payload: { workspaceId, sensors: ['TAG1', 'TAG2'], selectedSensors: [], sensorMetadata: [], models: [] } });
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
import { createFakeRust } from './helpers/fakeRustSession';

const tkey = (s: string) => s.trim().toLowerCase();

/**
 * The backend these tests run against: the SHARED fake (`helpers/fakeRustSession`,
 * which mirrors `src-tauri/src/lib.rs`: one tokenizer, one name rule, real
 * column values, Tauri's arg-key casing) behind the small call surface this file
 * has always used. It used to be a separate, simpler fake that scanned bare names
 * with `\p{L}` and left out `.` -- unlike Rust -- so a worker test and the QA
 * integration tests could disagree about what a formula references.
 *
 * `raw` / `derived` name columns that already exist in the session; derived ones
 * are seeded as copies of the first raw column (their values are never what
 * these tests look at -- the integration tests cover values).
 */
function fakeRust(opts: { raw?: string[]; derived?: string[]; failRemove?: boolean; failEval?: string[] } = {}) {
    const raw = opts.raw ?? ['TAG1', 'TAG2'];
    const inner = createFakeRust({ headers: ['timestamp', ...raw], columns: raw.map(() => [1, 2, 3, 4]) });
    for (const name of opts.derived ?? []) {
        void inner.invoke('evaluate_formula', { formula: sensorRef(raw[0]), customName: name });
    }
    inner.calls.length = 0; // seeding is not part of what a test did
    if (opts.failRemove) inner.failOn('remove_sensor_columns', () => true, 'disk on fire', false);
    if (opts.failEval?.length) {
        inner.failOn('evaluate_formula', a => opts.failEval!.includes(a.customName), 'boom', false);
    }
    return {
        invoke: inner.invoke as (cmd: string, args?: any) => Promise<unknown>,
        /** Column headers (without the time column), as the session holds them. */
        get columns() { return inner.headers().slice(1); },
        calls: inner.calls,
        has: inner.has,
        names: (cmd: string) => inner.cmds(cmd),
        inner,
    };
}

async function openWindow(payload: Record<string, unknown> = {}) {
    render(<AddSensorWindow />);
    await act(async () => {
        for (const cb of listenCallbacks['sensors-data'] ?? []) {
            cb({ payload: { sensors: ['TAG1', 'TAG2'], selectedSensors: [], sensorMetadata: [], models: [], ...payload } });
        }
    });
    // Let the extract_formula_refs lookup settle.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

const goManage = async () => { await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /Manage/ })); }); };
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await act(async () => { await Promise.resolve(); }); };
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
        // One source: the shared fake enforces Rust's rule that a single-sensor
        // operation takes exactly one (the old lenient fake let two through).
        fireEvent.click(screen.getByText('toggle-tag1'));
        fireEvent.click(screen.getByText('set-config'));
        fillMeta();
        await act(async () => { fireEvent.click(addBtn()); });
        await flush();
        const payload = last(mockEmit.mock.calls.filter(c => c[0] === 'add-sensor-selection'))![1];
        expect(payload.sensors).toEqual(['MyCalc']);
        expect(payload.newRecipes[0].sourceSensors).toEqual(['TAG1']); // still remembered as the recipe's inputs
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
        // (TAG1 is still picked from the first visit to this tab.)
        await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /Create/ })); });
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
    // A real writer persists to the workspace file FIRST and then broadcasts;
    // the window re-reads the file (it does not trust the payload).
    const broadcast = async (payload: Record<string, unknown>) => {
        await act(async () => {
            for (const cb of listenCallbacks['failure-group-state-changed'] ?? []) cb({ payload });
        });
        await flush();
    };

    it('a model that starts using a special sensor AFTER the window opened blocks its deletion (a delete now drops the column for real)', async () => {
        const rust = fakeRust({ derived: ['A'] });
        mockInvoke.mockImplementation(rust.invoke);
        await openWindow({ workspaceId: 'ws-1', sensors: ['TAG1', 'A'], specialSensorRecipes: [recA], models: [] });
        await goManage();
        expect((screen.getByLabelText('Delete A') as HTMLButtonElement).disabled).toBe(false);

        disk.models = [usingA];
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

// ═════════════════════════════════════════════════════════════════════════
// 2026-10-03 (second pass) -- QA's 14 findings.
//
//   * every special-sensor mutation (create, edit/rename, delete-commit) goes
//     through ONE serial queue, with its checks done inside the task against
//     fresh state;
//   * a failed edit is rolled back;
//   * a delete re-checks what uses the sensor at COMMIT time (models, the
//     workspace Running condition, other special sensors);
//   * models / Running condition follow the workspace FILE, not broadcast order;
//   * the Create form is cleared after an Add (REAL tooling -- the stand-in
//     cannot see state that lives inside it);
//   * "on chart" follows what the Dashboard says it plotted.
//
// The end-to-end (two real windows) versions live in
// SpecialSensorLifecycle.integration.test.tsx.
// ═════════════════════════════════════════════════════════════════════════

describe('AddSensorWindow: real components -- every create path, and the form is cleared after each Add', () => {
    const body = () => document.querySelector('.special-sensor-body') as HTMLElement;
    const row = (tag: string) =>
        (Array.from(body().querySelectorAll('.special-sensor-row')) as HTMLElement[]).find(r => r.textContent?.includes(tag))!;
    const pickRows = async (...tags: string[]) => {
        for (const t of tags) await act(async () => { fireEvent.click(row(t)); });
    };
    const nameInput = () => body().querySelector('input[placeholder="e.g. Total Power"]') as HTMLInputElement | null;
    const labelled = (text: string) => {
        const label = (Array.from(body().querySelectorAll('label')) as HTMLElement[]).find(l => l.textContent?.replace('*', '').trim() === text)!;
        return label.parentElement!.querySelector('input, select') as HTMLInputElement;
    };
    let seq = 0;
    const fillAll = async (name: string) => {
        seq++;
        await act(async () => { fireEvent.change(nameInput()!, { target: { value: name } }); });
        await act(async () => { fireEvent.change(labelled('Description'), { target: { value: `${name} desc ${seq}` } }); });
        await act(async () => { fireEvent.change(labelled('Unit'), { target: { value: `u${seq}` } }); });
        await act(async () => { fireEvent.change(body().querySelector('select[aria-label="Component"]')!, { target: { value: 'Uncategorized' } }); });
    };
    const clickAdd = async () => { await act(async () => { fireEvent.click(addBtn()); }); await flush(); };
    const open = async () => {
        real.tooling = true; real.explorer = true;
        const rust = fakeRust();
        mockInvoke.mockImplementation(rust.invoke);
        await openWindow({ sensors: ['TAG1', 'TAG2'] });
        return rust;
    };
    const nothingLeftOver = () => {
        expect(nameInput()).toBeNull(); // nothing is being created any more
        expect(screen.queryByText(/already exists/)).toBeNull();
        expect(screen.queryByText('Fix the name before adding.')).toBeNull();
    };

    it('buttons / "+" chain: after the Add the next sensor starts from a BLANK form (no pre-filled name flagged as taken)', async () => {
        const rust = await open();
        await pickRows('TAG1', 'TAG2');
        await fillAll('First');
        await clickAdd();
        expect(rust.names('evaluate_formula').map(c => c.args)).toEqual([{ formula: '$TAG1 + $TAG2', customName: 'First' }]);
        nothingLeftOver();

        await pickRows('TAG1', 'TAG2'); // the same two sources again
        expect(nameInput()!.value).toBe('');
        expect(labelled('Description').value).toBe('');
        expect(labelled('Unit').value).toBe('');
        expect(screen.queryByText(/already exists/)).toBeNull();
        expect(screen.getByText('Fill in a name, a description, a unit, a component before adding.')).toBeTruthy();
        // ... and a second sensor really can be created straight away.
        await fillAll('Second');
        await clickAdd();
        expect(rust.names('evaluate_formula').map(c => c.args.customName)).toEqual(['First', 'Second']);
        expect(rust.columns).toEqual(expect.arrayContaining(['First', 'Second']));
    });

    it('operation shortcut ("Sum all"): creates through calculate_new_sensor, and the picked shortcut does not carry over to the next sensor', async () => {
        const rust = await open();
        await pickRows('TAG1', 'TAG2');
        const sumAll = (Array.from(body().querySelectorAll('.special-sensor-op-card')) as HTMLElement[]).find(c => c.querySelector('b')?.textContent === 'Sum all')!;
        await act(async () => { fireEvent.click(sumAll); });
        await fillAll('Total');
        await clickAdd();
        expect(rust.names('calculate_new_sensor').map(c => c.args)).toEqual([
            { sensors: ['TAG1', 'TAG2'], config: { mode: 'multi', multiOp: { type: 'sum' }, customName: 'Total' } },
        ]);
        nothingLeftOver();
        await pickRows('TAG1', 'TAG2');
        const stillOn = (Array.from(body().querySelectorAll('.special-sensor-op-card')) as HTMLElement[]).filter(c => c.className.includes('is-on'));
        expect(stillOn).toHaveLength(0);
        expect(nameInput()!.value).toBe('');
    });

    it('"Edit as text": creates through evaluate_formula, and afterwards the formula, the name AND Description/Unit/Component are all cleared (the window and the tooling agree)', async () => {
        const rust = await open();
        await act(async () => { fireEvent.click(screen.getByText('Edit as text instead')); });
        await act(async () => { fireEvent.change(body().querySelector('textarea')!, { target: { value: '$TAG1 * 3', selectionStart: 9 } }); });
        await fillAll('Once');
        expect(addBtn().disabled).toBe(false);
        await clickAdd();
        expect(rust.names('evaluate_formula').map(c => c.args)).toEqual([{ formula: '$TAG1 * 3', customName: 'Once' }]);
        nothingLeftOver();
        expect(body().querySelector('textarea')).toBeNull(); // back to buttons mode, nothing typed

        // A second formula sensor: the fields are blank AND the footer agrees.
        await act(async () => { fireEvent.click(screen.getByText('Edit as text instead')); });
        await act(async () => { fireEvent.change(body().querySelector('textarea')!, { target: { value: '$TAG2 * 3', selectionStart: 9 } }); });
        await act(async () => { fireEvent.change(nameInput()!, { target: { value: 'Twice' } }); });
        expect(labelled('Description').value).toBe('');
        expect(labelled('Unit').value).toBe('');
        expect(screen.getByText('Fill in a description, a unit, a component before adding.')).toBeTruthy();
        expect(addBtn().disabled).toBe(true);
        await fillAll('Twice');
        expect(addBtn().disabled).toBe(false);
    });

    it('"add as-is" (one raw sensor, nothing to create): adds it to the plot and creates nothing', async () => {
        const rust = await open();
        await pickRows('TAG1');
        expect(nameInput()).toBeNull();
        await clickAdd();
        expect(mockEmit).toHaveBeenCalledWith('add-sensor-selection', expect.objectContaining({ sensors: ['TAG1'], newMetadata: [], newRecipes: [] }));
        expect(rust.names('evaluate_formula')).toHaveLength(0);
        expect(rust.names('calculate_new_sensor')).toHaveLength(0);
    });

    it('a failed Add keeps the form exactly as it was (nothing is cleared)', async () => {
        const rust = await open();
        rust.inner.failOn('evaluate_formula', () => true, 'Sensor not found: GONE', false);
        await pickRows('TAG1', 'TAG2');
        await fillAll('Keep');
        await clickAdd();
        expect(screen.getByRole('alert').textContent).toContain('Sensor not found: GONE');
        expect(nameInput()!.value).toBe('Keep');
        expect(labelled('Unit').value).not.toBe('');
    });
});

describe('AddSensorWindow: deleted-but-not-applied sensors are not offered anywhere', () => {
    beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
    afterEach(() => vi.useRealTimers());

    it('the Explorer gets the LIVE list: a sensor inside its undo window is not pickable as a source; Undo brings it back', async () => {
        mockInvoke.mockImplementation(fakeRust({ derived: ['A'] }).invoke);
        await openWindow({ sensors: ['TAG1', 'A'], specialSensorRecipes: [recA] });
        expect(last(explorerProps).sensors).toEqual(['TAG1', 'A']);
        await goManage();
        await act(async () => { fireEvent.click(screen.getByLabelText('Delete A')); });
        expect(last(explorerProps).sensors).toEqual(['TAG1']);
        await act(async () => { fireEvent.click(screen.getByText('Undo')); });
        expect(last(explorerProps).sensors).toEqual(['TAG1', 'A']);
    });

    it('a deleted sensor that was already picked as a source is dropped from the form at once', async () => {
        mockInvoke.mockImplementation(fakeRust({ derived: ['A'] }).invoke);
        await openWindow({ sensors: ['TAG1', 'A'], specialSensorRecipes: [recA] });
        last(explorerProps).onToggleSensor('A');
        await flush(2);
        expect(last(toolingProps).selectedSensors).toEqual(['A']);
        await goManage();
        await act(async () => { fireEvent.click(screen.getByLabelText('Delete A')); });
        expect(last(toolingProps).selectedSensors).toEqual([]);
    });

    it('a name inside its undo window can still be reused (the delete is settled first)', async () => {
        const rust = fakeRust({ derived: ['A'] });
        mockInvoke.mockImplementation(rust.invoke);
        await openWindow({ sensors: ['TAG1', 'A'], specialSensorRecipes: [recA] });
        await goManage();
        await act(async () => { fireEvent.click(screen.getByLabelText('Delete A')); });
        // name 'A' is free for a new sensor straight away: no "already exists"
        await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /Create/ })); });
        fireEvent.click(screen.getByText('toggle-tag1'));
        fireEvent.click(screen.getByText('set-config-name-a'));
        fillMeta();
        expect(screen.queryByTestId('tooling-name-error')).toBeNull();
        await act(async () => { fireEvent.click(addBtn()); });
        await flush();
        expect(rust.names('remove_sensor_columns').map(c => c.args)).toEqual([{ names: ['A'] }]);
        expect(rust.names('calculate_new_sensor')).toHaveLength(1);
        expect(rust.names('calculate_new_sensor')[0].error).toBeUndefined();
    });
});

describe('AddSensorWindow: delete is re-checked at COMMIT time against fresh state', () => {
    beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
    afterEach(() => vi.useRealTimers());
    const uses = (over: Record<string, unknown>) => ({
        id: 'm1', groupNos: [1], name: 'Boiler model', kind: 'individual', category: null,
        notes: '', status: false, targetSensor: '', predictorSensors: [], xSensor: '', ySensor: '',
        individualChecked: true, rcMode: null, scatterXSensor: '', relModelName: '', relStiffness: 100000,
        clusterModelName: '', numClusters: 3, criteriaSensor: '', clusterRanges: [],
        filterTimePeriods: [], runningConditionMode: 'workspace', customRunningConditionFilters: [], customRunningConditionCombine: 'and',
        ...over,
    });
    async function openAndDeleteA() {
        const rust = fakeRust({ derived: ['A'] });
        mockInvoke.mockImplementation(rust.invoke);
        await openWindow({ workspaceId: 'ws-1', sensors: ['TAG1', 'A'], specialSensorRecipes: [recA] });
        await goManage();
        await act(async () => { fireEvent.click(screen.getByLabelText('Delete A')); });
        return rust;
    }
    const expire = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(8100); }); await flush(); };

    it('a model that started using it inside the undo window cancels the delete: column kept, sensor back in the list, Dashboard never told, and the user is told why', async () => {
        const rust = await openAndDeleteA();
        disk.models = [uses({ targetSensor: 'A' })];
        await expire();
        expect(rust.names('remove_sensor_columns')).toHaveLength(0);
        expect(mockEmit).not.toHaveBeenCalledWith('delete-special-sensors', expect.anything());
        expect(screen.getByLabelText('Delete A')).toBeTruthy();
        expect(last(explorerProps).sensors).toContain('A');
        expect(screen.getByRole('alert').textContent).toMatch(/Didn't delete A: it is now used by Boiler model \(target sensor\)/);
    });

    it('so does a model\'s own custom running-condition condition', async () => {
        const rust = await openAndDeleteA();
        disk.models = [uses({ runningConditionMode: 'custom', customRunningConditionFilters: [{ id: 'c1', sensor: 'a', operation: 'greater_than', value1: '1', value2: '' }] })];
        await expire();
        expect(rust.names('remove_sensor_columns')).toHaveLength(0);
        expect(screen.getByRole('alert').textContent).toMatch(/custom running condition/);
    });

    it('so does the workspace Running condition', async () => {
        const rust = await openAndDeleteA();
        disk.rc = [{ id: 'r1', sensor: 'A', operation: 'greater_than', value1: '3', value2: '' }];
        await expire();
        expect(rust.names('remove_sensor_columns')).toHaveLength(0);
        expect(screen.getByRole('alert').textContent).toMatch(/Didn't delete A: it is now used by the workspace Running condition/);
    });

    it('so does another special sensor built on it that appeared meanwhile (the Dashboard re-sent its list)', async () => {
        const rust = await openAndDeleteA();
        await act(async () => {
            for (const cb of listenCallbacks['sensors-data'] ?? []) {
                cb({ payload: { workspaceId: 'ws-1', sensors: ['TAG1', 'A', 'B'], selectedSensors: [], sensorMetadata: [], models: [], specialSensorRecipes: [recA, recB] } });
            }
        });
        await flush();
        await expire();
        expect(rust.names('remove_sensor_columns')).toHaveLength(0);
        expect(screen.getByRole('alert').textContent).toMatch(/Didn't delete A: it is now used by B/);
    });

    it('if the check itself cannot be made (the workspace file cannot be read) the delete is CANCELLED, not guessed at', async () => {
        const rust = await openAndDeleteA();
        disk.failRead = true;
        await expire();
        expect(rust.names('remove_sensor_columns')).toHaveLength(0);
        expect(screen.getByRole('alert').textContent).toMatch(/couldn't check whether anything still uses it/);
        expect(screen.getByLabelText('Delete A')).toBeTruthy();
    });

    it('with nothing using it, the commit goes ahead: it re-read the file first, then dropped the column, then told the Dashboard', async () => {
        const rust = await openAndDeleteA();
        mockLoadWorkspace.mockClear();
        await expire();
        expect(mockLoadWorkspace).toHaveBeenCalledWith('ws-1');
        expect(rust.names('remove_sensor_columns').map(c => c.args)).toEqual([{ names: ['A'] }]);
        expect(mockEmit).toHaveBeenCalledWith('delete-special-sensors', { tags: ['A'], workspaceId: 'ws-1' });
    });
});

describe('AddSensorWindow: models / Running condition follow the workspace file, and "unknown" blocks deleting', () => {
    const usingA = {
        id: 'm1', groupNos: [1], name: 'Uses A', kind: 'individual', category: null,
        notes: '', status: false, targetSensor: 'A', predictorSensors: [], xSensor: '', ySensor: '',
        individualChecked: true, rcMode: null, scatterXSensor: '', relModelName: '', relStiffness: 100000,
        clusterModelName: '', numClusters: 3, criteriaSensor: '', clusterRanges: [],
        filterTimePeriods: [], runningConditionMode: 'workspace', customRunningConditionFilters: [], customRunningConditionCombine: 'and',
    };
    const broadcast = async (payload: Record<string, unknown>) => {
        await act(async () => { for (const cb of listenCallbacks['failure-group-state-changed'] ?? []) cb({ payload }); });
        await flush();
    };
    const del = () => screen.getByLabelText('Delete A') as HTMLButtonElement;

    it('never trusts a broadcast payload: the window ends on what the FILE says, whichever order broadcasts arrive in', async () => {
        mockInvoke.mockImplementation(fakeRust({ derived: ['A'] }).invoke);
        await openWindow({ workspaceId: 'ws-1', sensors: ['TAG1', 'A'], specialSensorRecipes: [recA] });
        await goManage();
        disk.models = [usingA]; // a writer persisted this, then broadcast it
        await broadcast({ workspaceId: 'ws-1', origin: 'build-model', groups: [], models: [usingA] });
        await broadcast({ workspaceId: 'ws-1', origin: 'dashboard', groups: [], models: [] }); // an OLDER echo arriving last
        expect(del().disabled).toBe(true);
    });

    it('a Running condition that starts naming a special sensor blocks its deletion (read from the file)', async () => {
        mockInvoke.mockImplementation(fakeRust({ derived: ['A'] }).invoke);
        await openWindow({ workspaceId: 'ws-1', sensors: ['TAG1', 'A'], specialSensorRecipes: [recA] });
        await goManage();
        expect(del().disabled).toBe(false);
        disk.rc = [{ id: 'r1', sensor: 'A', operation: 'greater_than', value1: '3', value2: '' }];
        await broadcast({ workspaceId: 'ws-1', origin: 'build-model', groups: [], models: [] });
        expect(del().disabled).toBe(true);
        fireEvent.click(screen.getByText(/Used by the running condition|Used by/));
        expect(screen.getByText(/Used by the running condition:/)).toBeTruthy();
    });

    it('the Running condition handed over when the window opens blocks deletion from the start', async () => {
        mockInvoke.mockImplementation(fakeRust({ derived: ['A'] }).invoke);
        await openWindow({
            workspaceId: 'ws-1', sensors: ['TAG1', 'A'], specialSensorRecipes: [recA],
            runningConditionFilters: [{ id: 'r1', sensor: 'A', operation: 'greater_than', value1: '3', value2: '' }],
        });
        await goManage();
        expect(del().disabled).toBe(true);
    });

    it('UNKNOWN blocks: no models received at all -> deleting is off; a failed re-read turns it off again; the next successful re-read turns it back on', async () => {
        mockInvoke.mockImplementation(fakeRust({ derived: ['A'] }).invoke);
        // sensors-data without a `models` field (never received).
        render(<AddSensorWindow />);
        await act(async () => {
            for (const cb of listenCallbacks['sensors-data'] ?? []) {
                cb({ payload: { workspaceId: 'ws-1', sensors: ['TAG1', 'A'], selectedSensors: [], sensorMetadata: [], specialSensorRecipes: [recA] } });
            }
        });
        await flush();
        await goManage();
        expect(del().disabled).toBe(true);
        expect(del().title).toMatch(/Still checking/);

        await broadcast({ workspaceId: 'ws-1', origin: 'dashboard', groups: [], models: [] }); // file read succeeds
        expect(del().disabled).toBe(false);

        disk.failRead = true;
        await broadcast({ workspaceId: 'ws-1', origin: 'dashboard', groups: [], models: [] });
        expect(del().disabled).toBe(true);

        disk.failRead = false;
        await broadcast({ workspaceId: 'ws-1', origin: 'dashboard', groups: [], models: [] });
        expect(del().disabled).toBe(false);
    });

    it('a broadcast from another workspace triggers no re-read', async () => {
        mockInvoke.mockImplementation(fakeRust({ derived: ['A'] }).invoke);
        await openWindow({ workspaceId: 'ws-1', sensors: ['TAG1', 'A'], specialSensorRecipes: [recA] });
        mockLoadWorkspace.mockClear();
        await broadcast({ workspaceId: 'ws-OTHER', groups: [], models: [usingA] });
        await broadcast({ groups: [], models: [usingA] });
        expect(mockLoadWorkspace).not.toHaveBeenCalled();
    });

    it('a RENAME carries into the window\'s own models and Running condition at once: the renamed sensor is still protected before the Dashboard\'s broadcast lands', async () => {
        const rust = fakeRust({ derived: ['A', 'B'] });
        mockInvoke.mockImplementation(rust.invoke);
        await openWindow({
            workspaceId: 'ws-1', sensors: ['TAG1', 'A', 'B'], specialSensorRecipes: [recA, recB],
            models: [usingA],
            runningConditionFilters: [{ id: 'r1', sensor: 'B', operation: 'greater_than', value1: '3', value2: '' }],
        });
        await goManage();
        // Rename A -> A2 (model uses A) and B -> B2 (Running condition uses B).
        for (const [from, to] of [['A', 'A2'], ['B', 'B2']]) {
            await act(async () => { fireEvent.click(screen.getByLabelText(`Edit ${from}`)); });
            fireEvent.change(screen.getByLabelText('Name'), { target: { value: to } });
            fillEditor();
            await act(async () => { fireEvent.click(screen.getByText('Save changes')); });
            await flush();
        }
        // No broadcast was ever delivered, yet both are still blocked under their new names.
        expect((screen.getByLabelText('Delete A2') as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByLabelText('Delete B2') as HTMLButtonElement).disabled).toBe(true);
        expect(mockLoadWorkspace).not.toHaveBeenCalled();
    });
});

describe('AddSensorWindow: "on chart" follows what the Dashboard says it plotted', () => {
    const onChart = (tag: string) => {
        const rowEl = screen.getByLabelText(`Delete ${tag}`).closest('div.rounded') as HTMLElement;
        return !!within(rowEl).queryByText('on chart');
    };
    const result = async (payload: Record<string, unknown>) => {
        await act(async () => { for (const cb of listenCallbacks['add-sensor-plot-result'] ?? []) cb({ payload }); });
    };

    it('shows the badge only for sensors in the Dashboard\'s reported selection', async () => {
        mockInvoke.mockImplementation(fakeRust({ derived: ['A'] }).invoke);
        await openWindow({ workspaceId: 'ws-1', sensors: ['TAG1', 'A'], specialSensorRecipes: [recA] });
        await goManage();
        expect(onChart('A')).toBe(false);
        await result({ workspaceId: 'ws-1', selectedSensors: ['TAG1', 'A'] });
        expect(onChart('A')).toBe(true);
        await result({ workspaceId: 'ws-1', selectedSensors: ['TAG1'] });
        expect(onChart('A')).toBe(false);
    });

    it('ignores a report for another workspace', async () => {
        mockInvoke.mockImplementation(fakeRust({ derived: ['A'] }).invoke);
        await openWindow({ workspaceId: 'ws-1', sensors: ['TAG1', 'A'], specialSensorRecipes: [recA] });
        await goManage();
        await result({ workspaceId: 'ws-OTHER', selectedSensors: ['A'] });
        expect(onChart('A')).toBe(false);
    });

    it('creating a sensor does NOT mark it as on chart by itself -- only the Dashboard\'s answer does (it may refuse: Pair Plot\'s cap)', async () => {
        mockInvoke.mockImplementation(fakeRust().invoke);
        await openWindow({ workspaceId: 'ws-1' });
        fireEvent.click(screen.getByText('toggle-tag1'));
        fireEvent.click(screen.getByText('set-config'));
        fillMeta();
        await act(async () => { fireEvent.click(addBtn()); });
        await flush();
        await goManage();
        expect(onChart('MyCalc')).toBe(false);
        await result({ workspaceId: 'ws-1', selectedSensors: ['MyCalc'] });
        expect(onChart('MyCalc')).toBe(true);
    });
});

describe('AddSensorWindow: one serial queue for create / edit / delete', () => {
    beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
    afterEach(() => vi.useRealTimers());

    const saveEdit = async (tag: string, patch: { name?: string; formula?: string }) => {
        await act(async () => { fireEvent.click(screen.getByLabelText(`Edit ${tag}`)); });
        if (patch.name) fireEvent.change(screen.getByLabelText('Name'), { target: { value: patch.name } });
        if (patch.formula) fireEvent.change(screen.getByLabelText('Formula'), { target: { value: patch.formula } });
        fillEditor();
        await act(async () => { fireEvent.click(screen.getByText('Save changes')); });
        await flush();
    };
    const setupFormulaCreate = (name: string) => {
        fireEvent.click(screen.getByText('toggle-tag1'));
        fireEvent.click(screen.getByText('submit-formula')); // FormulaCalc = $TAG1 + $TAG2
        void name;
        fillMeta();
    };

    it('a Create clicked while an edit is still recomputing WAITS for it, then runs against what the edit left (it reads the new values)', async () => {
        const rust = fakeRust({ derived: ['A', 'B'] });
        mockInvoke.mockImplementation(rust.invoke);
        const gate = rust.inner.gate('evaluate_formula', a => a.customName === 'A' && a.replace === true);
        await openWindow({ workspaceId: 'ws-1', sensors: ['TAG1', 'TAG2', 'A', 'B'], specialSensorRecipes: [recA, recB] });
        await goManage();
        await saveEdit('A', { formula: '$TAG1 * 5' });
        expect(screen.getByTestId('special-sensor-busy')).toBeTruthy();

        await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /Create/ })); });
        setupFormulaCreate('FormulaCalc');
        await act(async () => { fireEvent.click(addBtn()); });
        await flush();
        // The create has NOT touched the backend yet.
        expect(rust.names('evaluate_formula').filter(c => !c.args.replace)).toHaveLength(0);
        expect(addBtn().disabled).toBe(true); // and cannot be clicked twice meanwhile

        await act(async () => { gate.release(); });
        await flush(40);
        const order = rust.names('evaluate_formula').map(c => `${c.args.customName}${c.args.replace ? '*' : ''}`);
        expect(order).toEqual(['A*', 'B*', 'FormulaCalc']);
        expect(screen.queryByTestId('special-sensor-busy')).toBeNull();
    });

    it('a failing task does not wedge the queue: after a failed edit a Create still goes through', async () => {
        const rust = fakeRust({ derived: ['A'] });
        mockInvoke.mockImplementation(rust.invoke);
        await openWindow({ workspaceId: 'ws-1', sensors: ['TAG1', 'TAG2', 'A'], specialSensorRecipes: [recA] });
        await goManage();
        rust.inner.failOn('evaluate_formula', a => a.customName === 'A' && a.replace === true, 'injected');
        await saveEdit('A', { formula: '$GONE * 5' });
        expect(screen.getByRole('alert').textContent).toMatch(/Could not recompute "A"/);

        await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /Create/ })); });
        setupFormulaCreate('FormulaCalc');
        await act(async () => { fireEvent.click(addBtn()); });
        await flush(30);
        expect(rust.names('evaluate_formula').filter(c => !c.args.replace).map(c => c.args.customName)).toEqual(['FormulaCalc']);
        expect(mockEmit).toHaveBeenCalledWith('add-sensor-selection', expect.objectContaining({ sensors: ['FormulaCalc'] }));
    });

    it('a create refused inside the queue (the name was taken while it waited) fails INLINE and does not touch the backend', async () => {
        const rust = fakeRust({ derived: ['A'] });
        mockInvoke.mockImplementation(rust.invoke);
        const gate = rust.inner.gate('evaluate_formula', a => a.customName === 'FormulaCalc' && a.replace === true);
        await openWindow({ workspaceId: 'ws-1', sensors: ['TAG1', 'TAG2', 'A'], specialSensorRecipes: [recA] });
        await goManage();
        await saveEdit('A', { name: 'FormulaCalc' }); // rename A -> FormulaCalc, held at its recompute
        await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /Create/ })); });
        setupFormulaCreate('FormulaCalc'); // the name is free as far as the window knows
        await act(async () => { fireEvent.click(addBtn()); });
        await flush();
        await act(async () => { gate.release(); });
        await flush(40);
        expect(rust.names('evaluate_formula').filter(c => !c.args.replace)).toHaveLength(0);
        // Surfaced as the name's own problem (the field is flagged, Add is off).
        expect(screen.getByTestId('tooling-name-error').textContent).toMatch(/"FormulaCalc" already exists/);
        expect(addBtn().disabled).toBe(true);
    });

    it('closing the window flushes IN ORDER: the in-flight edit finishes, then the pending delete commits, then the window closes', async () => {
        const rust = fakeRust({ derived: ['A', 'B'] });
        const timeline: string[] = [];
        mockInvoke.mockImplementation(async (cmd: string, args?: any) => {
            const r = await rust.invoke(cmd, args);
            if (cmd === 'evaluate_formula') timeline.push(`edit:${args.customName}`);
            if (cmd === 'remove_sensor_columns') timeline.push(`delete:${args.names.join(',')}`);
            return r;
        });
        mockClose.mockImplementation(async () => { timeline.push('close'); });
        const gate = rust.inner.gate('evaluate_formula', a => a.customName === 'A' && a.replace === true);
        await openWindow({ workspaceId: 'ws-1', sensors: ['TAG1', 'A', 'B', 'Z'], specialSensorRecipes: [recA, { kind: 'formula', tag: 'Z', formula: '$TAG1 + 1' }] });
        await goManage();
        await saveEdit('A', { formula: '$TAG1 * 5' });
        await act(async () => { fireEvent.click(screen.getByLabelText('Delete Z')); }); // inside its undo window
        await act(async () => { fireEvent.click(screen.getByText('Close')); });
        await flush();
        expect(mockClose).not.toHaveBeenCalled(); // waiting for the edit
        await act(async () => { gate.release(); });
        await flush(40);
        expect(timeline).toEqual(['edit:A', 'delete:Z', 'close']);
    });

    it('Undo still works while the commit is only WAITING in the queue behind a slow edit (the sensor stays, nothing is dropped)', async () => {
        const rust = fakeRust({ derived: ['A', 'Z'] });
        mockInvoke.mockImplementation(rust.invoke);
        const gate = rust.inner.gate('evaluate_formula', a => a.customName === 'A' && a.replace === true);
        await openWindow({ workspaceId: 'ws-1', sensors: ['TAG1', 'A', 'Z'], specialSensorRecipes: [recA, { kind: 'formula', tag: 'Z', formula: '$TAG1 + 1' }] });
        await goManage();
        await saveEdit('A', { formula: '$TAG1 * 5' });
        await act(async () => { fireEvent.click(screen.getByLabelText('Delete Z')); });
        await act(async () => { await vi.advanceTimersByTimeAsync(8100); }); // undo window over: commit queued behind the edit
        await act(async () => { fireEvent.click(screen.getByText('Undo')); });
        await act(async () => { gate.release(); });
        await flush(40);
        expect(rust.names('remove_sensor_columns')).toHaveLength(0);
        expect(screen.getByLabelText('Delete Z')).toBeTruthy();
        expect(mockEmit).not.toHaveBeenCalledWith('delete-special-sensors', expect.anything());
    });

    it('a second Delete makes the first one final (its commit is queued) and takes the Undo slot', async () => {
        const rust = fakeRust({ derived: ['A', 'Z'] });
        mockInvoke.mockImplementation(rust.invoke);
        await openWindow({ workspaceId: 'ws-1', sensors: ['TAG1', 'A', 'Z'], specialSensorRecipes: [recA, { kind: 'formula', tag: 'Z', formula: '$TAG1 + 1' }] });
        await goManage();
        await act(async () => { fireEvent.click(screen.getByLabelText('Delete A')); });
        await act(async () => { fireEvent.click(screen.getByLabelText('Delete Z')); });
        await flush();
        expect(rust.names('remove_sensor_columns').map(c => c.args.names)).toEqual([['A']]); // A is final already
        expect(screen.getByText('Undo').closest('div')!.textContent).toMatch(/Deleted\s*Z/); // Z can still be undone
        await act(async () => { fireEvent.click(screen.getByText('Undo')); });
        await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
        expect(rust.names('remove_sensor_columns').map(c => c.args.names)).toEqual([['A']]);
        expect(screen.getByLabelText('Delete Z')).toBeTruthy();
    });

    it('re-pointing the window at ANOTHER workspace drops a pending undo (it belonged to the old project): nothing is committed later', async () => {
        const rust = fakeRust({ derived: ['A'] });
        mockInvoke.mockImplementation(rust.invoke);
        await openWindow({ workspaceId: 'ws-1', sensors: ['TAG1', 'A'], specialSensorRecipes: [recA] });
        await goManage();
        await act(async () => { fireEvent.click(screen.getByLabelText('Delete A')); });
        await act(async () => {
            for (const cb of listenCallbacks['sensors-data'] ?? []) {
                cb({ payload: { workspaceId: 'ws-2', sensors: ['TAG1', 'A'], selectedSensors: [], sensorMetadata: [], models: [], specialSensorRecipes: [recA] } });
            }
        });
        await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
        await flush();
        expect(rust.names('remove_sensor_columns')).toHaveLength(0);
        expect(mockEmit).not.toHaveBeenCalledWith('delete-special-sensors', expect.anything());
        expect(screen.getByLabelText('Delete A')).toBeTruthy();
    });
});

describe('AddSensorWindow: a failed edit is rolled back', () => {
    const chain = [
        { kind: 'formula' as const, tag: 'A', formula: '$TAG1 * 2' },
        { kind: 'formula' as const, tag: 'B', formula: '${A} + 1' },
        { kind: 'formula' as const, tag: 'C', formula: '${B} * 3' },
    ];
    async function openChain() {
        const rust = fakeRust({ derived: ['A', 'B', 'C'] });
        mockInvoke.mockImplementation(rust.invoke);
        await openWindow({ workspaceId: 'ws-1', sensors: ['TAG1', 'A', 'B', 'C'], specialSensorRecipes: chain });
        await goManage();
        return rust;
    }
    const save = async (formula: string) => {
        await act(async () => { fireEvent.click(screen.getByLabelText('Edit A')); });
        fireEvent.change(screen.getByLabelText('Formula'), { target: { value: formula } });
        fillEditor();
        await act(async () => { fireEvent.click(screen.getByText('Save changes')); });
        await flush(40);
    };

    it('recomputing C fails: A and B are put back (recomputed from their ORIGINAL formulas), the error names C, Cancel leaves a consistent session, and other windows are told to refetch', async () => {
        const rust = await openChain();
        rust.inner.failOn('evaluate_formula', a => a.customName === 'C' && a.replace === true, 'injected');
        await save('$TAG1 * 9');
        expect(screen.getByRole('alert').textContent).toMatch(/Could not recompute "C"/);
        const writes = rust.names('evaluate_formula').filter(c => c.args.replace && !c.error).map(c => `${c.args.customName}=${c.args.formula}`);
        expect(writes).toEqual(['A=$TAG1 * 9', 'B=${A} + 1', 'A=$TAG1 * 2', 'B=${A} + 1']);
        expect(mockEmit).toHaveBeenCalledWith('special-sensor-data-changed', { workspaceId: 'ws-1' });
        expect(mockEmit).not.toHaveBeenCalledWith('update-special-sensor', expect.anything());
        // The window's recipes were never changed.
        await act(async () => { fireEvent.click(screen.getByText('Cancel')); });
        expect(screen.getByText('$TAG1 * 2')).toBeTruthy();
    });

    it('a failure on the very first write changes nothing, so no rollback and no refetch broadcast', async () => {
        const rust = await openChain();
        rust.inner.failOn('evaluate_formula', a => a.customName === 'A' && a.replace === true, 'injected');
        await save('$TAG1 * 9');
        expect(rust.names('evaluate_formula').filter(c => c.args.replace && !c.error)).toHaveLength(0);
        expect(mockEmit).not.toHaveBeenCalledWith('special-sensor-data-changed', expect.anything());
    });

    it('if the rollback ITSELF cannot restore a sensor, the error says which ones may hold wrong values (never silent)', async () => {
        const rust = await openChain();
        rust.inner.failOn('evaluate_formula', a => a.customName === 'C' && a.replace === true, 'injected', false);
        rust.inner.failOn('evaluate_formula', a => a.customName === 'A' && a.replace === true && a.formula === '$TAG1 * 2', 'cannot restore', false);
        await save('$TAG1 * 9');
        const text = screen.getByRole('alert').textContent ?? '';
        expect(text).toMatch(/could not be restored/);
        expect(text).toMatch(/\bA\b/);
    });

    it('a rename that fails part-way: the half-built NEW column is dropped, the old one and every dependent stay, and the Dashboard is never told', async () => {
        const rust = await openChain();
        rust.inner.failOn('evaluate_formula', a => a.customName === 'C' && a.replace === true, 'injected');
        await act(async () => { fireEvent.click(screen.getByLabelText('Edit A')); });
        fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'A2' } });
        fillEditor();
        await act(async () => { fireEvent.click(screen.getByText('Save changes')); });
        await flush(40);
        expect(rust.has('A2')).toBe(false);
        expect(rust.has('A')).toBe(true);
        expect(mockEmit).not.toHaveBeenCalledWith('rename-special-sensor', expect.anything());
    });
});
