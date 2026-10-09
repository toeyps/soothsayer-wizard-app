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
// Formula editor. The create flow itself is covered with the REAL components in
// the "real components" describe (one test per path) -- flip `real.*` to render
// the genuine component instead of the stand-in. An EDIT always renders the real
// editor (the stand-in only stands in for Create), so every edit / repair / lock
// test below exercises the shipped editor end to end.
const real = vi.hoisted(() => ({ editor: false, explorer: false }));

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
                    <button onClick={() => props.onInsertSensor?.('TAG2')}>insert-tag2</button>
                </div>
            );
        },
    };
});

const editorProps: any[] = [];
/** The text the stand-in last reported (its "report an issue" buttons re-report it). */
const standIn = vi.hoisted(() => ({ formula: '' }));
// Partial mock: `SensorFieldsCard` (Name / Description / Unit / Component) stays REAL --
// it is the window's own form. Only the editor's default export is stood in for Create:
// its buttons report a formula / block (`onReport`) the way the real editor does, and fill
// the real fields through the DOM.
vi.mock('../components/windows/SpecialSensorFormulaEditor', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../components/windows/SpecialSensorFormulaEditor')>();
    const React = await import('react');
    const { fireEvent: fire } = await import('@testing-library/react');
    const setField = (label: string, value: string) => {
        const el = document.querySelector(`[aria-label="${label}"]`);
        if (el) fire.change(el, { target: { value } });
    };
    const Stand = React.forwardRef((props: any, ref: any) => {
        editorProps.push(props);
        if (real.editor || props.initialRecipe) {
            const Real = actual.default;
            return <Real ref={ref} {...props} />;
        }
        const formula = (text: string, name?: string, issue: unknown = null) => {
            standIn.formula = text;
            props.onReport({ state: { mode: 'formula', text, roundDecimals: null, note: null }, issue, edited: false });
            if (name !== undefined) setField('Name', name);
        };
        const block = (name?: string) => {
            props.onReport({ state: { mode: 'block', type: 'mean', sources: ['TAG1', 'TAG2'], decimals: null, note: null }, issue: null, edited: false });
            if (name !== undefined) setField('Name', name);
        };
        return (
            <div data-testid="formula-editor">
                <button onClick={() => block('MyCalc')}>set-config</button>
                <button onClick={() => block('')}>set-config-no-name</button>
                <button onClick={() => block('tag1')}>set-config-tag1</button>
                <button onClick={() => block('  Tag2  ')}>set-config-padded-tag2</button>
                <button onClick={() => block('SPECIAL a')}>set-config-special-a</button>
                <button onClick={() => block('A')}>set-config-name-a</button>
                <button onClick={() => block('a}b')}>set-config-brace</button>
                <button onClick={() => props.onReport({ state: null, issue: null, edited: false })}>clear-config</button>
                <button onClick={() => formula('$TAG1 * 2', 'special A')}>submit-formula-special-a</button>
                <button onClick={() => formula('$TAG1 + $TAG2', 'FormulaCalc')}>submit-formula</button>
                <button onClick={() => setField('Description', 'My Description')}>set-description</button>
                <button onClick={() => setField('Unit', 'bar')}>set-unit</button>
                <button onClick={() => setField('Component', 'Uncategorized')}>set-component</button>
                <button onClick={() => formula(standIn.formula, undefined, { code: 'unknown_function', message: "Unknown function 'foo'. Available functions: abs, sqrt." })}>report-formula-issue</button>
                <button onClick={() => formula(standIn.formula)}>clear-formula-issue</button>
            </div>
        );
    });
    return { ...actual, default: Stand };
});

/** The Name field's own message (`SensorFieldsCard`). */
const nameError = () => {
    const el = document.querySelector('.fx-namerr');
    if (!el) throw new Error('no name error shown');
    return el as HTMLElement;
};
const queryNameError = () => document.querySelector('.fx-namerr');

import AddSensorWindow from '../components/windows/AddSensorWindow';

function last<T>(arr: T[]): T {
    return arr[arr.length - 1];
}

beforeEach(() => {
    real.editor = false; real.explorer = false; standIn.formula = '';
    disk.models = []; disk.rc = []; disk.missing = false; disk.failRead = false;
    mockLoadWorkspace.mockClear();
    explorerProps.length = 0;
    editorProps.length = 0;
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

    it('picking a sensor in the explorer feeds Quick build (the editor gets the picks); a second click un-picks it', async () => {
        render(<AddSensorWindow />);
        await deliverSensorsData(['TAG1', 'TAG2']);
        fireEvent.click(screen.getByText('toggle-tag1'));
        expect(last(editorProps).quickSelected).toEqual(['TAG1']);
        fireEvent.click(screen.getByText('toggle-tag2'));
        expect(last(editorProps).quickSelected).toEqual(['TAG1', 'TAG2']);
        fireEvent.click(screen.getByText('toggle-tag1'));
        expect(last(editorProps).quickSelected).toEqual(['TAG2']);
    });

    it('the explorer\'s `$` button inserts into the editor at the caret (through the editor handle)', async () => {
        real.editor = true;
        render(<AddSensorWindow />);
        await deliverSensorsData(['TAG1', 'TAG2']);
        fireEvent.click(screen.getByText('insert-tag2'));
        expect((screen.getByLabelText('Formula') as HTMLTextAreaElement).value).toBe('$TAG2');
    });

    it('"Clear picks" in Quick build empties the picks', async () => {
        real.editor = true;
        render(<AddSensorWindow />);
        await deliverSensorsData(['TAG1', 'TAG2']);
        fireEvent.click(screen.getByText('toggle-tag1'));
        expect(last(editorProps).quickSelected).toEqual(['TAG1']);
        fireEvent.click(screen.getByText('Clear picks'));
        expect(last(editorProps).quickSelected).toEqual([]);
    });

    it('picks alone build nothing: with an empty editor Add stays disabled and the footer says how to start (adding raw sensors as-is is the Dashboard\'s job)', async () => {
        render(<AddSensorWindow />);
        await deliverSensorsData(['TAG1', 'TAG2']);
        fireEvent.click(screen.getByText('toggle-tag1'));
        expect(screen.getByText('Pick sensors on the left for Quick build, or type a formula.')).toBeTruthy();
        expect((screen.getByText('Add sensor').closest('button') as HTMLButtonElement).disabled).toBe(true);
        await act(async () => {
            fireEvent.click(screen.getByText('Add sensor'));
            await Promise.resolve();
        });
        expect(mockEmit).not.toHaveBeenCalledWith('add-sensor-selection', expect.anything());
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
        fireEvent.click(screen.getByText('set-config')); // an Average block, named 'MyCalc'

        expect(screen.getByText('Fill in a description, a unit, a component before adding.')).toBeTruthy();
        expect((screen.getByText('Add sensor') as HTMLButtonElement).disabled).toBe(true);

        fireEvent.click(screen.getByText('set-description'));
        expect(screen.getByText('Fill in a unit, a component before adding.')).toBeTruthy();
        fireEvent.click(screen.getByText('set-unit'));
        fireEvent.click(screen.getByText('set-component'));
        expect(screen.queryByText(/Fill in/)).toBeNull();
        expect((screen.getByText('Add sensor') as HTMLButtonElement).disabled).toBe(false);
    });

    it('adding an Average BLOCK invokes calculate_new_sensor (the aggregate path) and merges the new sensor into state', async () => {
        mockInvoke.mockImplementation((cmd: string) => {
            if (cmd === 'calculate_new_sensor') return Promise.resolve('CALC1');
            return Promise.resolve([]);
        });
        render(<AddSensorWindow />);
        await deliverSensorsData(['TAG1', 'TAG2']);
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
            sensors: ['TAG1', 'TAG2'],
            config: { mode: 'multi', multiOp: { type: 'mean' }, customName: 'MyCalc' },
        });
        // `sensors` is a DELTA for the Dashboard's plot: just the new sensor,
        // never the sources it was built from.
        expect(mockEmit).toHaveBeenCalledWith('add-sensor-selection', {
            sensors: ['CALC1'],
            operation: null,
            newMetadata: [{ tag: 'CALC1', description: 'My Description', unit: 'bar', component: 'Uncategorized' }],
            newRecipes: [{
                kind: 'operation',
                tag: 'CALC1',
                sourceSensors: ['TAG1', 'TAG2'],
                operationConfig: { mode: 'multi', multiOp: { type: 'mean' }, customName: 'MyCalc' },
            }],
        });
        expect(screen.getByText(/Added: My Description/)).toBeTruthy();
        // New sensor becomes pickable for the next round.
        expect(last(explorerProps).sensors).toContain('CALC1');
    });

    it('a rounded block stores its own decimals (multiOp.decimals), never a round() wrap', async () => {
        mockInvoke.mockImplementation((cmd: string) => (cmd === 'calculate_new_sensor' ? Promise.resolve('AVG') : Promise.resolve([])));
        render(<AddSensorWindow />);
        await deliverSensorsData(['TAG1', 'TAG2']);
        await act(async () => {
            last(editorProps).onReport({ state: { mode: 'block', type: 'median', sources: ['TAG1', 'TAG2'], decimals: 2, note: null }, issue: null, edited: false });
        });
        fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'AVG' } });
        fireEvent.click(screen.getByText('set-description'));
        fireEvent.click(screen.getByText('set-unit'));
        fireEvent.click(screen.getByText('set-component'));
        await act(async () => { fireEvent.click(screen.getByText('Add sensor')); await Promise.resolve(); await Promise.resolve(); });
        expect(mockInvoke).toHaveBeenCalledWith('calculate_new_sensor', {
            sensors: ['TAG1', 'TAG2'],
            config: { mode: 'multi', multiOp: { type: 'median', decimals: 2 }, customName: 'AVG' },
        });
    });

    it('a formula with "Round the result" is created with the STORED text (round(X * 100) / 100)', async () => {
        mockInvoke.mockImplementation((cmd: string) => (cmd === 'evaluate_formula' ? Promise.resolve('R') : Promise.resolve([])));
        render(<AddSensorWindow />);
        await deliverSensorsData(['TAG1', 'TAG2']);
        await act(async () => {
            last(editorProps).onReport({ state: { mode: 'formula', text: '$TAG1 + $TAG2', roundDecimals: 2, note: null }, issue: null, edited: false });
        });
        fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'R' } });
        fireEvent.click(screen.getByText('set-description'));
        fireEvent.click(screen.getByText('set-unit'));
        fireEvent.click(screen.getByText('set-component'));
        await act(async () => { fireEvent.click(screen.getByText('Add sensor')); await Promise.resolve(); await Promise.resolve(); });
        expect(mockInvoke).toHaveBeenCalledWith('evaluate_formula', { formula: 'round(($TAG1 + $TAG2) * 100) / 100', customName: 'R' });
        expect(mockEmit).toHaveBeenCalledWith('add-sensor-selection', expect.objectContaining({
            newRecipes: [{ kind: 'formula', tag: 'R', formula: 'round(($TAG1 + $TAG2) * 100) / 100' }],
        }));
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
        mockInvoke.mockImplementation((cmd: string, args?: any) => {
            if (cmd === 'evaluate_formula' || cmd === 'calculate_new_sensor') return Promise.resolve(args.customName ?? args.config.customName);
            return Promise.resolve([]);
        });
        render(<AddSensorWindow />);
        await deliverSensorsData(['TAG1', 'TAG2']);
        const fill = () => {
            fireEvent.click(screen.getByText('set-description'));
            fireEvent.click(screen.getByText('set-unit'));
            fireEvent.click(screen.getByText('set-component'));
        };

        fireEvent.click(screen.getByText('submit-formula'));
        fill();
        await act(async () => {
            fireEvent.click(screen.getByText('Add sensor'));
            await Promise.resolve();
            await Promise.resolve();
        });
        fireEvent.click(screen.getByText('set-config'));
        fill();
        await act(async () => {
            fireEvent.click(screen.getByText('Add sensor'));
            await Promise.resolve();
            await Promise.resolve();
        });

        const sent = mockEmit.mock.calls.filter((c) => c[0] === 'add-sensor-selection');
        expect(sent.map(c => c[1].sensors)).toEqual([['FormulaCalc'], ['MyCalc']]);
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

    it('a formula that references no sensor at all cannot be saved: the check line says why and the footer repeats it', async () => {
        mockInvoke.mockImplementation(refsByFormula({ ...chainRefs, '42': [] }));
        await openManage({ specialSensorRecipes: [chainA] });

        await act(async () => { fireEvent.click(screen.getByLabelText('Edit A')); });
        fireEvent.change(screen.getByLabelText('Formula'), { target: { value: '42' } });
        fillEditorRequiredFields();
        expect(screen.getByTestId('formula-check').textContent).toContain('Formula contains no sensor references');
        expect(screen.getByTestId('edit-footer-hint').textContent).toContain('Formula contains no sensor references');
        expect((screen.getByText('Save changes') as HTMLButtonElement).disabled).toBe(true);
        await act(async () => {
            fireEvent.click(screen.getByText('Save changes'));
            await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        });
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
        fireEvent.change(screen.getByLabelText('Formula'), { target: { value: '$TAG1 * 7' } });
        fillEditorRequiredFields();
        await act(async () => {
            fireEvent.click(screen.getByText('Save changes'));
            await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        });

        expect(screen.getByRole('alert').textContent).toContain('Could not recompute "A"');
        expect(screen.getByText('Save changes')).toBeTruthy();
        expect(mockEmit).not.toHaveBeenCalledWith('update-special-sensor', expect.anything());
    });

    // 2026-10-08: Rust now refuses an unknown function/name at compute time with
    // a readable error -- it must reach the user, with no "Updated" toast.
    it('a recompute refused by Rust (unknown function) shows Rust’s message in the editor and no "Updated" toast', async () => {
        mockInvoke.mockImplementation((cmd: string, args?: any) => {
            if (cmd === 'extract_formula_refs') {
                return Promise.resolve((args.formulas as string[]).map((f: string) => (chainRefs as any)[f] ?? ['TAG1']));
            }
            if (cmd === 'evaluate_formula') return Promise.reject("Formula error: unknown function 'foo'. Available functions: abs, sqrt, pow, exp, ln, log (base 10), log10, round, min, max, ceil, floor, sin, cos, tan, pi(), e().");
            return Promise.resolve([]);
        });
        await openManage({ specialSensorRecipes: [chainA] });

        await act(async () => { fireEvent.click(screen.getByLabelText('Edit A')); });
        fireEvent.change(screen.getByLabelText('Formula'), { target: { value: 'foo($TAG1)' } });
        fillEditorRequiredFields();
        await act(async () => {
            fireEvent.click(screen.getByText('Save changes'));
            await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        });

        expect(screen.getByRole('alert').textContent).toContain("unknown function 'foo'");
        expect(screen.queryByText(/Updated A/)).toBeNull();
        expect(screen.queryAllByRole('status').filter(e => e.textContent?.startsWith('✓ Updated'))).toHaveLength(0);
        expect(screen.getByText('Save changes')).toBeTruthy(); // the editor stays open
        expect(mockEmit).not.toHaveBeenCalledWith('update-special-sensor', expect.anything());
    });

    it('closes the editor (back to Manage) and shows the edited recipe in the list after a successful save', async () => {
        mockInvoke.mockImplementation(refsByFormula({ ...chainRefs, '$TAG1 * 5': ['TAG1'] }));
        await openManage({ specialSensorRecipes: [chainA] });

        await act(async () => { fireEvent.click(screen.getByLabelText('Edit A')); });
        expect(screen.getByText('Edit sensor')).toBeTruthy();
        expect(screen.getByRole('tab', { name: 'Create' }).getAttribute('aria-selected')).toBe('true');
        fireEvent.change(screen.getByLabelText('Formula'), { target: { value: '$TAG1 * 5' } });
        fillEditorRequiredFields();
        await act(async () => {
            fireEvent.click(screen.getByText('Save changes'));
            await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        });

        expect(screen.queryByText('Save changes')).toBeNull();
        expect(screen.queryByText('Edit sensor')).toBeNull();
        expect(screen.getByRole('tab', { name: /Manage/ }).getAttribute('aria-selected')).toBe('true');
        expect(screen.getByText('$TAG1 * 5')).toBeTruthy();
    });

    it('Cancel edit discards the change and goes back to Manage; the picks were cleared when the edit opened', async () => {
        mockInvoke.mockImplementation(refsByFormula(chainRefs));
        await openManage({ specialSensorRecipes: [chainA] });
        await act(async () => { fireEvent.click(screen.getByRole('tab', { name: 'Create' })); });
        fireEvent.click(screen.getByText('toggle-tag1'));
        expect(last(editorProps).quickSelected).toEqual(['TAG1']);
        await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /Manage/ })); });
        await act(async () => { fireEvent.click(screen.getByLabelText('Edit A')); });
        expect(last(editorProps).quickSelected).toEqual([]);
        fireEvent.change(screen.getByLabelText('Formula'), { target: { value: '$TAG1 * 99' } });
        await act(async () => { fireEvent.click(screen.getByText('Cancel edit')); });
        expect(screen.queryByText('Save changes')).toBeNull();
        expect(screen.getByText('$TAG1 * 2')).toBeTruthy();
        expect(mockEmit).not.toHaveBeenCalledWith('update-special-sensor', expect.anything());
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

    it('a legacy Sum opens as A + B with a note; Quick build "Average" replaces it with a block, saved through calculate_new_sensor as an operation recipe', async () => {
        mockInvoke.mockImplementation((cmd: string) => (cmd === 'calculate_new_sensor' ? Promise.resolve('Total flow') : Promise.resolve([])));
        await openManage({ sensors: ['TAG1', 'TAG2'], specialSensorRecipes: [opRecipe] });

        await act(async () => { fireEvent.click(screen.getByLabelText('Edit Total flow')); });
        expect((screen.getByLabelText('Formula') as HTMLTextAreaElement).value).toBe('$TAG1 + $TAG2');
        expect(screen.getByTestId('formula-note').textContent).toContain('Opened from a Sum recipe as A + B + C');
        fireEvent.click(screen.getByText('toggle-tag1'));
        fireEvent.click(screen.getByText('toggle-tag2'));
        fireEvent.click(screen.getByRole('button', { name: 'Average' }));
        fireEvent.click(screen.getByRole('button', { name: 'Replace with this block' }));
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

    it('saving a legacy Sum without changing its maths keeps the stored operation recipe (metadata only, nothing recomputed)', async () => {
        mockInvoke.mockImplementation(() => Promise.resolve([]));
        await openManage({ sensors: ['TAG1', 'TAG2'], specialSensorRecipes: [opRecipe] });
        await act(async () => { fireEvent.click(screen.getByLabelText('Edit Total flow')); });
        fillEditorRequiredFields();
        await act(async () => {
            fireEvent.click(screen.getByText('Save changes'));
            await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        });
        expect(mockInvoke).not.toHaveBeenCalledWith('calculate_new_sensor', expect.anything());
        expect(mockInvoke).not.toHaveBeenCalledWith('evaluate_formula', expect.anything());
        expect(mockEmit).toHaveBeenCalledWith('update-special-sensor', expect.objectContaining({ recipe: opRecipe, recomputed: [] }));
    });

    // The capability the whole button-UI reuse was for: a formula-backed
    // shortcut (unreachable through the old plain dropdown) upgrades the
    // SAVED recipe from operation-kind to formula-kind, exactly like
    // building one this way from scratch would.
    it('editing an operation recipe into a formula (Quick build |A − B|) recomputes via evaluate_formula and switches to a formula recipe', async () => {
        mockInvoke.mockImplementation((cmd: string) => {
            if (cmd === 'evaluate_formula') return Promise.resolve('Total flow');
            // handleSaveEdit resolves a formula-kind result's references
            // before recomputing it -- the sensors it will actually read.
            if (cmd === 'extract_formula_refs') return Promise.resolve([['TAG1', 'TAG2']]);
            return Promise.resolve([]);
        });
        await openManage({ sensors: ['TAG1', 'TAG2'], specialSensorRecipes: [opRecipe] });

        await act(async () => { fireEvent.click(screen.getByLabelText('Edit Total flow')); });
        fireEvent.click(screen.getByText('toggle-tag1'));
        fireEvent.click(screen.getByText('toggle-tag2'));
        fireEvent.click(screen.getByRole('button', { name: '|A − B|' }));
        fireEvent.click(screen.getByRole('button', { name: 'Replace formula' }));
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
        mockInvoke.mockImplementation((cmd: string) => (cmd === 'evaluate_formula' ? Promise.resolve('FormulaCalc') : Promise.resolve([])));
        fireEvent.click(screen.getByText('submit-formula'));
        fireEvent.click(screen.getByText('set-description'));
        fireEvent.click(screen.getByText('set-unit'));
        fireEvent.click(screen.getByText('set-component'));
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
        expect(mockEmit).toHaveBeenCalledWith('add-sensor-selection', expect.objectContaining({ sensors: ['FormulaCalc'], workspaceId: 'ws-A' }));
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
        expect(payload.newRecipes[0].sourceSensors).toEqual(['TAG1', 'TAG2']); // still remembered as the recipe's inputs
    });

    it('A: picks without a formula create nothing (Add stays off) -- "add as-is" is the Dashboard\'s job now', async () => {
        mockInvoke.mockImplementation(fakeRust().invoke);
        await openWindow();
        fireEvent.click(screen.getByText('toggle-tag1'));
        fireEvent.click(screen.getByText('toggle-tag2'));
        expect(addBtn().disabled).toBe(true);
        await act(async () => { fireEvent.click(addBtn()); });
        await flush();
        expect(mockEmit).not.toHaveBeenCalledWith('add-sensor-selection', expect.anything());
    });

    it('D: a name that equals an existing sensor is flagged inline on the Name field and Add stays disabled -- nothing is sent to the backend', async () => {
        mockInvoke.mockImplementation(fakeRust().invoke);
        await openWindow();
        fireEvent.click(screen.getByText('toggle-tag1'));
        fireEvent.click(screen.getByText('set-config-tag1')); // customName 'tag1' vs existing 'TAG1'
        fillMeta();
        expect(nameError().textContent).toMatch(/"TAG1" already exists/);
        expect(addBtn().disabled).toBe(true);
        expect(screen.getByText('Fix the name before adding.')).toBeTruthy();
        await act(async () => { fireEvent.click(addBtn()); });
        expect(mockInvoke).not.toHaveBeenCalledWith('calculate_new_sensor', expect.anything());
        expect(mockEmit).not.toHaveBeenCalledWith('add-sensor-selection', expect.anything());
    });

    // 2026-10-08: `canAdd` ignored the typed formula's validate_formula result.
    it('a formula with an issue keeps Add disabled and the footer REPEATS the message; fixing it re-enables Add', async () => {
        mockInvoke.mockImplementation(fakeRust().invoke);
        await openWindow();
        fireEvent.click(screen.getByText('submit-formula-special-a'));
        fillMeta();
        expect(addBtn().disabled).toBe(false);

        fireEvent.click(screen.getByText('report-formula-issue'));
        expect(addBtn().disabled).toBe(true);
        expect(screen.getByTestId('create-footer-hint').textContent).toBe("Unknown function 'foo'. Available functions: abs, sqrt.");
        await act(async () => { fireEvent.click(addBtn()); });
        expect(mockInvoke).not.toHaveBeenCalledWith('evaluate_formula', expect.anything());

        fireEvent.click(screen.getByText('clear-formula-issue'));
        expect(addBtn().disabled).toBe(false);
        expect(screen.queryByText(/Unknown function 'foo'/)).toBeNull();
    });

    it('a later block replaces an earlier formula issue (the issue belongs to what the editor holds now)', async () => {
        mockInvoke.mockImplementation(fakeRust().invoke);
        await openWindow();
        fireEvent.click(screen.getByText('submit-formula'));
        fireEvent.click(screen.getByText('report-formula-issue'));
        fireEvent.click(screen.getByText('set-config'));
        fillMeta();
        expect(addBtn().disabled).toBe(false);
    });

    it('D: the check ignores case and surrounding whitespace', async () => {
        await openWindow();
        fireEvent.click(screen.getByText('toggle-tag1'));
        fireEvent.click(screen.getByText('set-config-padded-tag2')); // '  Tag2  '
        expect(nameError().textContent).toMatch(/already exists/);
    });

    it('D: it covers existing SPECIAL sensors too (from the Dashboard\'s sensor list and from the recipes), not only imported columns', async () => {
        await openWindow({ sensors: ['TAG1', 'special A'], specialSensorRecipes: [{ kind: 'formula', tag: 'special A', formula: '$TAG1' }] });
        fireEvent.click(screen.getByText('toggle-tag1'));
        fireEvent.click(screen.getByText('set-config-special-a'));
        expect(nameError()).toBeTruthy();
    });

    it('D: the formula path\'s name is checked as well', async () => {
        await openWindow({ sensors: ['TAG1', 'special A'], specialSensorRecipes: [{ kind: 'formula', tag: 'special A', formula: '$TAG1' }] });
        fireEvent.click(screen.getByText('toggle-tag1'));
        fireEvent.click(screen.getByText('submit-formula-special-a'));
        fillMeta();
        expect(nameError().textContent).toMatch(/"special A" already exists/);
        expect(addBtn().disabled).toBe(true);
    });

    it('E: a name containing "}" is blocked at naming time with a clear message', async () => {
        await openWindow();
        fireEvent.click(screen.getByText('toggle-tag1'));
        fireEvent.click(screen.getByText('set-config-brace'));
        fillMeta();
        expect(nameError().textContent).toMatch(/can't contain "}"/);
        expect(addBtn().disabled).toBe(true);
    });

    it('D: a free name shows no conflict', async () => {
        await openWindow();
        fireEvent.click(screen.getByText('toggle-tag1'));
        fireEvent.click(screen.getByText('set-config')); // 'MyCalc'
        expect(queryNameError()).toBeNull();
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
        expect(nameError().textContent).toMatch(/"MyCalc" already exists/);
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

        fireEvent.click(screen.getByText('submit-formula')); // what the editor holds changed -> the old failure no longer applies
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
            expect(queryNameError()).toBeNull();
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
            expect(queryNameError()).toBeNull(); // not flagged as taken
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
        expect(screen.queryByText('Save changes')).toBeNull(); // editor closed -- not reported as a failed save
        expect(screen.getByLabelText('Edit A2')).toBeTruthy();
        expect(screen.getByRole('alert').textContent).toMatch(/couldn't free the old data/);
        expect(rust.has('A2')).toBe(true);
        errSpy.mockRestore();
    });

    // 2026-10-08: while the lookup is down every sensor shows locked (a guess of
    // "nothing depends on it" is unsafe), so the rename never leaves the editor;
    // what DOES leave it -- a description-only save -- no longer recomputes at
    // all, so it needs no lookup and goes through without touching a column.
    it('C: while the "what depends on this" lookup has failed the name cannot change (held locked), and a description-only save still goes through without touching any column', async () => {
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
        expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('A'); // read-only while unknown
        await act(async () => { fireEvent.click(screen.getByText('Save changes')); });
        await flush();
        expect(mockEmit).not.toHaveBeenCalledWith('rename-special-sensor', expect.anything());
        expect(mockEmit).toHaveBeenCalledWith('update-special-sensor', expect.objectContaining({
            recipe: recA, recomputed: [], metadata: expect.objectContaining({ tag: 'A', description: 'A description' }),
        }));
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
        expect(nameError()).toBeTruthy();
        // ...rename it away...
        await goManage();
        await renameTo('A', 'A2');
        // ...and "A" can be created again (the fake backend would refuse it if A's column were still there).
        // (TAG1 is still picked from the first visit to this tab.)
        await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /Create/ })); });
        fireEvent.click(screen.getByText('set-config-name-a'));
        fillMeta();
        expect(queryNameError()).toBeNull();
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
    const nameInput = () => body().querySelector('#fx-name') as HTMLInputElement;
    const field = () => body().querySelector('textarea[aria-label="Formula"]') as HTMLTextAreaElement | null;
    const qb = () => within(body()).getByTestId('quick-build');
    let seq = 0;
    const fillAll = async (name: string) => {
        seq++;
        await act(async () => { fireEvent.change(nameInput(), { target: { value: name } }); });
        await act(async () => { fireEvent.change(within(body()).getByLabelText('Description'), { target: { value: `${name} desc ${seq}` } }); });
        await act(async () => { fireEvent.change(within(body()).getByLabelText('Unit'), { target: { value: `u${seq}` } }); });
        await act(async () => { fireEvent.change(within(body()).getByLabelText('Component'), { target: { value: 'Uncategorized' } }); });
    };
    const clickAdd = async () => { await act(async () => { fireEvent.click(addBtn()); }); await flush(); };
    const open = async () => {
        real.editor = true; real.explorer = true;
        const rust = fakeRust();
        mockInvoke.mockImplementation(rust.invoke);
        await openWindow({ sensors: ['TAG1', 'TAG2'] });
        return rust;
    };
    const nothingLeftOver = () => {
        expect(nameInput().value).toBe(''); // a blank form for the next sensor
        expect(within(body()).getByLabelText('Description')).toHaveProperty('value', '');
        expect(within(body()).getByLabelText('Unit')).toHaveProperty('value', '');
        expect(screen.queryByText(/already exists/)).toBeNull();
        expect(screen.queryByText('Fix the name before adding.')).toBeNull();
        // The picks cleared too (no "Picked" pill, Quick build back to its hint).
        expect(body().querySelectorAll('.special-sensor-row.is-picked')).toHaveLength(0);
        expect(qb().textContent).toContain('Pick sensors on the left to get started');
    };

    it('Quick build chain: pick two, "Use this formula", Add -- then the next sensor starts from a BLANK form and picks', async () => {
        const rust = await open();
        await pickRows('TAG1', 'TAG2');
        expect(within(qb()).getByTestId('quick-build-output').textContent).toBe('$TAG1 + $TAG2');
        await act(async () => { fireEvent.click(within(qb()).getByRole('button', { name: 'Use this formula' })); });
        expect(field()!.value).toBe('$TAG1 + $TAG2');
        await fillAll('First');
        await clickAdd();
        expect(rust.names('evaluate_formula').map(c => c.args)).toEqual([{ formula: '$TAG1 + $TAG2', customName: 'First' }]);
        nothingLeftOver();
        expect(field()!.value).toBe('');

        // ... and a second sensor really can be created straight away.
        await pickRows('TAG1', 'TAG2');
        await act(async () => { fireEvent.click(within(qb()).getByRole('button', { name: 'Use this formula' })); });
        expect(screen.getByText('Fill in a name, a description, a unit, a component before adding.')).toBeTruthy();
        await fillAll('Second');
        await clickAdd();
        expect(rust.names('evaluate_formula').map(c => c.args.customName)).toEqual(['First', 'Second']);
        expect(rust.columns).toEqual(expect.arrayContaining(['First', 'Second']));
    });

    it('Quick build "Average" block: creates through calculate_new_sensor (missing values skipped), and the block does not carry over', async () => {
        const rust = await open();
        await pickRows('TAG1', 'TAG2');
        await act(async () => { fireEvent.click(within(qb()).getByRole('button', { name: 'Average' })); });
        expect(within(qb()).getByTestId('quick-build-output').textContent).toBe('Average of 2 sensors · missing values skipped');
        await act(async () => { fireEvent.click(within(qb()).getByRole('button', { name: 'Use this block' })); });
        await fillAll('Total');
        await clickAdd();
        expect(rust.names('calculate_new_sensor').map(c => c.args)).toEqual([
            { sensors: ['TAG1', 'TAG2'], config: { mode: 'multi', multiOp: { type: 'mean' }, customName: 'Total' } },
        ]);
        nothingLeftOver();
        expect(screen.queryByText('Average block')).toBeNull();
        expect(field()).not.toBeNull(); // back to an empty formula field
    });

    it('a typed formula: creates through evaluate_formula, and afterwards the formula, the name AND Description/Unit/Component are all cleared', async () => {
        const rust = await open();
        await act(async () => { fireEvent.change(field()!, { target: { value: '$TAG1 * 3' } }); });
        await fillAll('Once');
        expect(addBtn().disabled).toBe(false);
        await clickAdd();
        expect(rust.names('evaluate_formula').map(c => c.args)).toEqual([{ formula: '$TAG1 * 3', customName: 'Once' }]);
        nothingLeftOver();
        expect(field()!.value).toBe('');

        // A second formula sensor: the fields are blank AND the footer agrees.
        await act(async () => { fireEvent.change(field()!, { target: { value: '$TAG2 * 3' } }); });
        await act(async () => { fireEvent.change(nameInput(), { target: { value: 'Twice' } }); });
        expect(screen.getByText('Fill in a description, a unit, a component before adding.')).toBeTruthy();
        expect(addBtn().disabled).toBe(true);
        await fillAll('Twice');
        expect(addBtn().disabled).toBe(false);
    });

    it('a formula the front-end check refuses keeps Add off and the footer repeats the message (Rust is never asked to create it)', async () => {
        const rust = await open();
        await act(async () => { fireEvent.change(field()!, { target: { value: '$TAG1 $TAG2' } }); });
        await fillAll('Bad');
        expect(addBtn().disabled).toBe(true);
        expect(screen.getByTestId('create-footer-hint').textContent).toContain('Two values side by side');
        await clickAdd();
        expect(rust.names('evaluate_formula')).toHaveLength(0);
        // The fix button on the check line repairs it in place.
        await act(async () => { fireEvent.click(within(screen.getByTestId('formula-check')).getByRole('button', { name: 'Insert ×' })); });
        expect(field()!.value).toBe('$TAG1 * $TAG2');
        expect(addBtn().disabled).toBe(false);
    });

    it('a failed Add keeps the form exactly as it was (nothing is cleared)', async () => {
        const rust = await open();
        rust.inner.failOn('evaluate_formula', () => true, 'Sensor not found: GONE', false);
        await pickRows('TAG1', 'TAG2');
        await act(async () => { fireEvent.click(within(qb()).getByRole('button', { name: 'Use this formula' })); });
        await fillAll('Keep');
        await clickAdd();
        expect(screen.getByRole('alert').textContent).toContain('Sensor not found: GONE');
        expect(nameInput().value).toBe('Keep');
        expect(field()!.value).toBe('$TAG1 + $TAG2');
        expect((within(body()).getByLabelText('Unit') as HTMLInputElement).value).not.toBe('');
        expect(body().querySelectorAll('.special-sensor-row.is-picked')).toHaveLength(2);
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
        expect(last(editorProps).quickSelected).toEqual(['A']);
        await goManage();
        await act(async () => { fireEvent.click(screen.getByLabelText('Delete A')); });
        expect(last(editorProps).quickSelected).toEqual([]);
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
        expect(queryNameError()).toBeNull();
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

    it('a model-used / Running-condition-used sensor can NOT be renamed any more (edit lock, 2026-10-03): the rename-into-models carry-over is unreachable from this window, and both stay protected from deletion', async () => {
        const rust = fakeRust({ derived: ['A', 'B'] });
        mockInvoke.mockImplementation(rust.invoke);
        disk.models = [usingA];
        disk.rc = [{ id: 'r1', sensor: 'B', operation: 'greater_than', value1: '3', value2: '' }];
        await openWindow({
            workspaceId: 'ws-1', sensors: ['TAG1', 'A', 'B'], specialSensorRecipes: [recA, recB],
            models: [usingA],
            runningConditionFilters: disk.rc,
        });
        await goManage();
        for (const from of ['A', 'B']) {
            await act(async () => { fireEvent.click(screen.getByLabelText(`Edit ${from}`)); });
            // The Name field is read-only: it cannot even be changed here.
            expect((screen.getByLabelText('Name') as HTMLInputElement).readOnly).toBe(true);
            await act(async () => { fireEvent.click(screen.getByText('Cancel edit')); });
        }
        expect(rust.calls.filter(c => c.cmd === 'remove_sensor_columns')).toHaveLength(0);
        expect((screen.getByLabelText('Delete A') as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByLabelText('Delete B') as HTMLButtonElement).disabled).toBe(true);
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

    it('an edit saved while a Create is still computing WAITS for it, then runs against what the create left', async () => {
        const rust = fakeRust({ derived: ['A', 'B'] });
        mockInvoke.mockImplementation(rust.invoke);
        const gate = rust.inner.gate('evaluate_formula', a => a.customName === 'FormulaCalc' && !a.replace);
        await openWindow({ workspaceId: 'ws-1', sensors: ['TAG1', 'TAG2', 'A', 'B'], specialSensorRecipes: [recA, recB] });
        setupFormulaCreate('FormulaCalc');
        await act(async () => { fireEvent.click(addBtn()); });
        await flush();
        expect(screen.getByTestId('special-sensor-busy')).toBeTruthy();

        await goManage();
        await saveEdit('A', { formula: '$TAG1 * 5' });
        // The edit has NOT touched the backend yet.
        expect(rust.names('evaluate_formula').filter(c => c.args.replace)).toHaveLength(0);
        expect((screen.getByText('Save changes') as HTMLButtonElement).disabled).toBe(true); // and cannot be clicked twice meanwhile

        await act(async () => { gate.release(); });
        await flush(40);
        const order = rust.names('evaluate_formula').map(c => `${c.args.customName}${c.args.replace ? '*' : ''}`);
        expect(order).toEqual(['FormulaCalc', 'A*', 'B*']);
        expect(screen.queryByTestId('special-sensor-busy')).toBeNull();
    });

    it('while an Edit is open the Create tab shows that edit (Add is off): Create waits until the edit is saved or cancelled', async () => {
        const rust = fakeRust({ derived: ['A'] });
        mockInvoke.mockImplementation(rust.invoke);
        await openWindow({ workspaceId: 'ws-1', sensors: ['TAG1', 'TAG2', 'A'], specialSensorRecipes: [recA] });
        await goManage();
        await act(async () => { fireEvent.click(screen.getByLabelText('Edit A')); });
        expect(screen.queryByText('Add sensor')).toBeNull();
        expect(screen.getByText('Save changes')).toBeTruthy();
        await act(async () => { fireEvent.click(screen.getByText('Cancel edit')); });
        await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /Create/ })); });
        expect(screen.getByText('Add sensor')).toBeTruthy();
        expect(screen.getByText('New sensor')).toBeTruthy();
    });

    it('a failing task does not wedge the queue: after a failed edit a Create still goes through', async () => {
        const rust = fakeRust({ derived: ['A'] });
        mockInvoke.mockImplementation(rust.invoke);
        await openWindow({ workspaceId: 'ws-1', sensors: ['TAG1', 'TAG2', 'A'], specialSensorRecipes: [recA] });
        await goManage();
        rust.inner.failOn('evaluate_formula', a => a.customName === 'A' && a.replace === true, 'injected');
        await saveEdit('A', { formula: '$TAG1 * 5' });
        expect(screen.getByRole('alert').textContent).toMatch(/Could not recompute "A"/);

        await act(async () => { fireEvent.click(screen.getByText('Cancel edit')); });
        await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /Create/ })); });
        setupFormulaCreate('FormulaCalc');
        await act(async () => { fireEvent.click(addBtn()); });
        await flush(30);
        expect(rust.names('evaluate_formula').filter(c => !c.args.replace).map(c => c.args.customName)).toEqual(['FormulaCalc']);
        expect(mockEmit).toHaveBeenCalledWith('add-sensor-selection', expect.objectContaining({ sensors: ['FormulaCalc'] }));
    });

    it('a rename refused inside the queue (a create took the name while it waited) fails INLINE and writes nothing', async () => {
        const rust = fakeRust({ derived: ['A'] });
        mockInvoke.mockImplementation(rust.invoke);
        const gate = rust.inner.gate('evaluate_formula', a => a.customName === 'FormulaCalc' && !a.replace);
        await openWindow({ workspaceId: 'ws-1', sensors: ['TAG1', 'TAG2', 'A'], specialSensorRecipes: [recA] });
        setupFormulaCreate('FormulaCalc');
        await act(async () => { fireEvent.click(addBtn()); }); // held at its compute
        await flush();
        await goManage();
        await saveEdit('A', { name: 'FormulaCalc' }); // the name is free as far as the window knows
        await act(async () => { gate.release(); });
        await flush(40);
        expect(rust.names('evaluate_formula').filter(c => c.args.replace)).toHaveLength(0);
        expect(mockEmit.mock.calls.some(c => c[0] === 'rename-special-sensor')).toBe(false);
        expect(screen.getAllByRole('alert').map(a => a.textContent).join(' ')).toMatch(/"FormulaCalc" is already in use by another sensor/);
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
        await goManage(); // the edit is still applying; Manage stays reachable
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
        await goManage();
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
        // A re-point resets the window to the Create tab (a different project:
        // nothing of the old binding's UI state survives) -- look at Manage again.
        await goManage();
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
        await act(async () => { fireEvent.click(screen.getByText('Cancel edit')); });
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


// ═════════════════════════════════════════════════════════════════════════
// 2026-10-03 -- EDIT LOCK. A special sensor that a model (or the workspace
// Running condition, or a sensor built on it that one of them uses) depends on
// can no longer be renamed or have its values changed -- only its description /
// unit / component. Enforced inside the serial queue against models re-read
// from the workspace file; the editor's read-only state is the friendly half.
// ═════════════════════════════════════════════════════════════════════════

describe('AddSensorWindow: edit lock for sensors a model uses', () => {
    const usingA = {
        id: 'm1', groupNos: [1], name: 'Uses A', kind: 'relationship', category: null,
        notes: '', status: true, targetSensor: 'A', predictorSensors: [], xSensor: '', ySensor: '',
        individualChecked: true, rcMode: null, scatterXSensor: '', relModelName: '', relStiffness: 100000,
        clusterModelName: '', numClusters: 3, criteriaSensor: '', clusterRanges: [],
        filterTimePeriods: [], runningConditionMode: 'workspace', customRunningConditionFilters: [], customRunningConditionCombine: 'and',
    };
    const WRITES = ['evaluate_formula', 'calculate_new_sensor', 'remove_sensor_columns', 'rename_formula_refs'];
    const writes = (rust: ReturnType<typeof fakeRust>) => rust.calls.filter(c => WRITES.includes(c.cmd) || c.args?.replace);
    const broadcast = async (payload: Record<string, unknown>) => {
        await act(async () => { for (const cb of listenCallbacks['failure-group-state-changed'] ?? []) cb({ payload }); });
        await flush();
    };
    const editorAlert = () => screen.queryAllByRole('alert').map(a => a.textContent).join(' / ');
    const save = async () => { await act(async () => { fireEvent.click(screen.getByText('Save changes')); }); await flush(); };
    const nameInput = () => screen.getByLabelText('Name') as HTMLInputElement;

    async function open(extra: Record<string, unknown> = {}, rustOpts = {}) {
        const rust = fakeRust({ derived: ['A', 'B'], ...rustOpts });
        mockInvoke.mockImplementation(rust.invoke);
        await openWindow({
            workspaceId: 'ws-1', sensors: ['TAG1', 'A', 'B'], specialSensorRecipes: [recA, recB],
            sensorMetadata: [{ tag: 'A', description: 'Sensor A', unit: 'bar', component: 'Uncategorized' }],
            ...extra,
        });
        await goManage();
        rust.calls.length = 0;
        return rust;
    }
    const edit = async (tag: string) => { await act(async () => { fireEvent.click(screen.getByLabelText(`Edit ${tag}`)); }); await flush(); };

    it('opens the editor of a model-used sensor with Name and Formula READ-ONLY, a banner naming the model, and the metadata fields still editable', async () => {
        disk.models = [usingA];
        await open({ models: [usingA] });
        await edit('A');
        expect(nameInput().readOnly).toBe(true);
        expect(nameInput().value).toBe('A');
        const formula = screen.getByLabelText('Formula') as HTMLTextAreaElement;
        expect(formula.readOnly).toBe(true);
        expect(formula.value).toBe('$TAG1 * 2');
        const banner = screen.getByTestId('edit-lock-banner');
        expect(banner.textContent).toMatch(/Name and formula are locked\./);
        expect(banner.textContent).toMatch(/Used by 1 model: Uses A \(Relationship\)\. Remove it from those models first, then you can edit it\./);
        expect((screen.getByLabelText('Description') as HTMLInputElement).readOnly).toBe(false);
        expect((screen.getByLabelText('Unit') as HTMLInputElement).readOnly).toBe(false);
        // One neutral lock pill in the header; Quick build and the palette are hidden; the
        // left list is dimmed with one sentence saying why; the footer says what Save does.
        expect(screen.getByTestId('formula-lock-pill').textContent).toContain('Used by 1 model');
        expect(screen.queryByTestId('quick-build')).toBeNull();
        expect(screen.queryByRole('toolbar', { name: 'Insert' })).toBeNull();
        expect(document.querySelector('.special-sensor-left')!.className).toContain('is-off');
        expect(screen.getByText('The formula is locked, so sensors cannot be added.')).toBeTruthy();
        expect(screen.getByTestId('edit-footer-hint').textContent).toBe('Saves the description, unit and component.');
        expect(screen.getByText('Edit sensor')).toBeTruthy();
    });

    it('a sensor no model uses opens a normal, editable editor (no banner)', async () => {
        await open();
        await edit('A');
        expect(nameInput().readOnly).toBe(false);
        expect(screen.queryByTestId('edit-lock-banner')).toBeNull();
    });

    it('METADATA-ONLY save of a locked sensor is accepted: no column is touched, the Dashboard gets update-special-sensor with the STORED recipe and nothing recomputed', async () => {
        disk.models = [usingA];
        const rust = await open({ models: [usingA] });
        await edit('A');
        fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Generator power' } });
        fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'kW' } });
        await save();
        expect(writes(rust)).toHaveLength(0);
        expect(rust.calls.filter(c => c.cmd === 'rename_formula_refs')).toHaveLength(0);
        const call = mockEmit.mock.calls.find(c => c[0] === 'update-special-sensor');
        expect(call).toBeTruthy();
        expect(call![1]).toMatchObject({
            recipe: recA, recomputed: [],
            metadata: { tag: 'A', description: 'Generator power', unit: 'kW' },
        });
        expect(mockEmit.mock.calls.some(c => c[0] === 'rename-special-sensor')).toBe(false);
        // The editor closed on success.
        expect(screen.queryByTestId('edit-lock-banner')).toBeNull();
    });

    it('RENAME of a model-used sensor is refused in the queue (even with the editor driven past its read-only state): inline reason, NO invoke that writes, nothing emitted', async () => {
        // Nothing uses A when the editor opens (unlocked, Name editable)...
        const rust = await open();
        await edit('A');
        fireEvent.change(nameInput(), { target: { value: 'A2' } });
        fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'd' } });
        fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'u' } });
        fireEvent.change(screen.getByLabelText('Component'), { target: { value: 'Uncategorized' } });
        // ...then another window makes it a model's target. NO broadcast: the
        // queued task must find out on its own, from the file.
        disk.models = [usingA];
        await save();
        expect(editorAlert()).toMatch(/Can't rename "A"\. Used by 1 model: Uses A \(Relationship\)\./);
        expect(writes(rust)).toHaveLength(0);
        expect(mockEmit.mock.calls.filter(c => c[0] === 'rename-special-sensor' || c[0] === 'update-special-sensor')).toHaveLength(0);
        expect(mockLoadWorkspace).toHaveBeenCalledWith('ws-1');
    });

    it('a formula change is refused the same way when a model started using the sensor after the editor opened -- the values stay what they were', async () => {
        const rust = await open();
        await edit('A');
        fireEvent.change(screen.getByLabelText('Formula'), { target: { value: '$TAG1 * 9' } });
        fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'd' } });
        fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'u' } });
        fireEvent.change(screen.getByLabelText('Component'), { target: { value: 'Uncategorized' } });
        disk.models = [usingA];
        await save();
        expect(editorAlert()).toMatch(/Can't change the formula, operation or sources of "A"/);
        expect(writes(rust)).toHaveLength(0);
        // The window's own recipe list still says $TAG1 * 2.
        await act(async () => { fireEvent.click(screen.getByText('Cancel edit')); });
        expect(screen.getAllByText('$TAG1 * 2').length).toBeGreaterThan(0);
        expect(screen.queryByText('$TAG1 * 9')).toBeNull();
    });

    it('the running condition locks it: banner says "Used by the running condition"; the window also learns this from sensors-data', async () => {
        await open({ runningConditionFilters: [{ id: 'r1', sensor: 'A', operation: 'greater_than', value1: '3', value2: '' }] });
        await edit('A');
        expect(screen.getByTestId('edit-lock-banner').textContent).toMatch(/Used by the running condition\./);
        expect(nameInput().readOnly).toBe(true);
    });

    it('TRANSITIVE: B is built on A and a model uses B -> A is locked too, and the explanation names B', async () => {
        const usingB = { ...usingA, id: 'm2', name: 'Uses B', kind: 'individual', targetSensor: 'B' };
        disk.models = [usingB];
        const rust = await open({ models: [usingB] });
        await edit('A');
        expect(nameInput().readOnly).toBe(true);
        expect(screen.getByTestId('edit-lock-banner').textContent)
            .toMatch(/Built on by "B", which is used by 1 model: Uses B \(Individual\)\. Remove "B" from those models first, then you can edit it\./);
        // And the queued task agrees, even if a rename is forced through.
        fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'd2' } });
        await save();
        expect(writes(rust)).toHaveLength(0); // metadata-only
    });

    it('Manage\'s expanded row explains the lock (and the Delete reason) in one place', async () => {
        disk.models = [usingA];
        await open({ models: [usingA] });
        fireEvent.click(screen.getByText('Used by 1 sensor and 1 model'));
        const lock = screen.getByTestId('edit-lock-A');
        expect(lock.textContent).toMatch(/Name and formula are locked:/);
        expect(lock.textContent).toMatch(/Used by 1 model: Uses A \(Relationship\)/);
        expect(screen.getByText(/Used by models:/)).toBeTruthy(); // the existing delete explanation is still there
    });

    it('UNLOCKS when the model stops using the sensor (Build Model broadcast -> re-read): the Name field becomes editable and a rename goes through', async () => {
        disk.models = [usingA];
        const rust = await open({ models: [usingA] });
        await edit('A');
        expect(nameInput().readOnly).toBe(true);
        disk.models = [];
        await broadcast({ workspaceId: 'ws-1', origin: 'build-model', groups: [], models: [] });
        expect(nameInput().readOnly).toBe(false);
        expect(screen.queryByTestId('edit-lock-banner')).toBeNull();
        fireEvent.change(nameInput(), { target: { value: 'A2' } });
        fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'd' } });
        fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'u' } });
        fireEvent.change(screen.getByLabelText('Component'), { target: { value: 'Uncategorized' } });
        await save();
        expect(rust.calls.some(c => c.cmd === 'remove_sensor_columns')).toBe(true);
        expect(mockEmit.mock.calls.some(c => c[0] === 'rename-special-sensor')).toBe(true);
    });

    it('UNKNOWN models (the workspace file cannot be read) hold the name/formula back: the editor says so, and a forced change is refused with no write', async () => {
        const rust = await open({ models: undefined as unknown as never });
        await edit('A');
        expect(nameInput().readOnly).toBe(true);
        expect(screen.getByTestId('edit-lock-banner').textContent).toMatch(/Still checking what uses this sensor/);
        // Make the re-read succeed: the lock lifts.
        await broadcast({ workspaceId: 'ws-1', origin: 'dashboard', groups: [], models: [] });
        expect(nameInput().readOnly).toBe(false);
        // Now the file cannot be read at the moment the edit runs.
        fireEvent.change(nameInput(), { target: { value: 'A2' } });
        fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'd' } });
        fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'u' } });
        fireEvent.change(screen.getByLabelText('Component'), { target: { value: 'Uncategorized' } });
        disk.failRead = true;
        await save();
        expect(editorAlert()).toMatch(/Can't rename "A" right now: couldn't check whether a model uses it \(disk unavailable\)/);
        expect(writes(rust)).toHaveLength(0);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// 2026-10-03 -- the window is BOUND to the dataset it was handed. The Dashboard
// sends `generation` (from `load_csv`) with `sensors-data`; every guarded Rust
// command carries it as `expectedGeneration`; a STALE_SESSION refusal stops the
// task without rollback; a different project / dataset resets the whole window
// (epoch); an OLDER payload never re-points it backwards.
// ═════════════════════════════════════════════════════════════════════════

import { STALE_SESSION_ERROR } from './helpers/fakeRustSession';

describe('AddSensorWindow: bound to the dataset generation', () => {
    beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
    afterEach(() => vi.useRealTimers());

    const GUARDED = ['evaluate_formula', 'calculate_new_sensor', 'remove_sensor_columns'];
    const guardedCalls = (rust: ReturnType<typeof fakeRust>) => rust.calls.filter(c => GUARDED.includes(c.cmd));
    const sessionGen = (rust: ReturnType<typeof fakeRust>) => rust.inner.generation();

    /** Hand the window data for `workspaceId` at `generation`, like the Dashboard does. */
    const deliver = async (payload: Record<string, unknown>) => {
        await act(async () => {
            for (const cb of listenCallbacks['sensors-data'] ?? []) {
                cb({ payload: { sensors: ['TAG1', 'TAG2'], selectedSensors: [], sensorMetadata: [], models: [], ...payload } });
            }
        });
        await flush();
    };
    const closing = async (payload: Record<string, unknown>) => {
        await act(async () => { for (const cb of listenCallbacks['workspace-closing'] ?? []) cb({ payload }); });
        await flush();
    };
    const lostBanner = () => screen.queryByTestId('special-sensor-session-lost');
    const saveEditUi = async (tag: string, patch: { name?: string; formula?: string }) => {
        await act(async () => { fireEvent.click(screen.getByLabelText(`Edit ${tag}`)); });
        if (patch.name) fireEvent.change(screen.getByLabelText('Name'), { target: { value: patch.name } });
        if (patch.formula) fireEvent.change(screen.getByLabelText('Formula'), { target: { value: patch.formula } });
        fillEditor();
        await act(async () => { fireEvent.click(screen.getByText('Save changes')); });
        await flush(40);
    };
    const addFormulaSensor = async () => {
        fireEvent.click(screen.getByText('toggle-tag1'));
        fireEvent.click(screen.getByText('submit-formula'));
        fillMeta();
        await act(async () => { fireEvent.click(addBtn()); });
        await flush(40);
    };

    describe('every guarded command carries expectedGeneration (camelCase)', () => {
        it('create (formula and operation), edit, rename (incl. the old-column removal) and delete all pin the generation the Dashboard sent', async () => {
            const rust = fakeRust({ derived: ['A', 'B'] });
            mockInvoke.mockImplementation(rust.invoke);
            const g = sessionGen(rust);
            await openWindow({ workspaceId: 'ws-A', generation: g, sensors: ['TAG1', 'TAG2', 'A', 'B'], specialSensorRecipes: [recA, recB] });

            // create: formula
            await addFormulaSensor();
            // create: operation
            fireEvent.click(screen.getByText('toggle-tag2'));
            fireEvent.click(screen.getByText('set-config'));
            fillMeta();
            await act(async () => { fireEvent.click(addBtn()); });
            await flush(40);
            // edit (recomputes A and B), then rename A -> A2 (recompute + old column removal)
            await goManage();
            await saveEditUi('A', { formula: '$TAG1 * 5' });
            await saveEditUi('A', { name: 'A2' });
            // delete
            await act(async () => { fireEvent.click(screen.getByLabelText('Delete B')); });
            await act(async () => { await vi.advanceTimersByTimeAsync(8100); });
            await flush(40);

            const calls = guardedCalls(rust);
            expect(calls.map(c => c.cmd)).toEqual(expect.arrayContaining(['evaluate_formula', 'calculate_new_sensor', 'remove_sensor_columns']));
            for (const c of calls) {
                expect(c.args.expectedGeneration, `${c.cmd} ${JSON.stringify(c.args)}`).toBe(g);
                expect('expected_generation' in c.args).toBe(false);
            }
            // The create/edit/rename/delete all really happened (nothing was refused).
            expect(calls.filter(c => c.error)).toEqual([]);
            expect(rust.names('remove_sensor_columns').map(c => c.args.names)).toEqual(expect.arrayContaining([['A'], ['B']]));
        });

        it('a payload with no generation (an older sender) leaves the arguments exactly as before -- no expectedGeneration key at all', async () => {
            const rust = fakeRust();
            mockInvoke.mockImplementation(rust.invoke);
            await openWindow({ workspaceId: 'ws-A' });
            await addFormulaSensor();
            expect(rust.names('evaluate_formula')).toHaveLength(1);
            expect('expectedGeneration' in rust.names('evaluate_formula')[0].args).toBe(false);
        });

        it('the generation is re-read from each sensors-data: after a re-bind the NEW generation is pinned', async () => {
            const rust = fakeRust();
            mockInvoke.mockImplementation(rust.invoke);
            const g = sessionGen(rust);
            await openWindow({ workspaceId: 'ws-A', generation: g });
            await deliver({ workspaceId: 'ws-A', generation: g + 7 });
            await addFormulaSensor();
            expect(rust.names('evaluate_formula')[0].args.expectedGeneration).toBe(g + 7);
        });
    });

    describe('STALE_SESSION: stop, no rollback, say so, refuse until re-bound', () => {
        it('create refused as stale: nothing is announced, the banner says what to do, Add is disabled and a further attempt sends nothing', async () => {
            const rust = fakeRust();
            mockInvoke.mockImplementation(rust.invoke);
            await openWindow({ workspaceId: 'ws-A', generation: sessionGen(rust) + 40 }); // the session has moved on
            await addFormulaSensor();

            expect(rust.names('evaluate_formula')[0].error).toBe(STALE_SESSION_ERROR);
            expect(lostBanner()?.textContent).toBe('This project was closed or reloaded — reopen Add Special Sensor from the Dashboard.');
            expect(mockEmit).not.toHaveBeenCalledWith('add-sensor-selection', expect.anything());
            expect(addBtn().disabled).toBe(true);
            const before = rust.calls.length;
            await act(async () => { fireEvent.click(addBtn()); });
            await flush();
            expect(rust.calls.length).toBe(before);
        });

        it('an edit refused as stale does NOT roll back (no recompute of the original recipes, no replay, no removal), says so in the editor and sends nothing to the Dashboard', async () => {
            const rust = fakeRust({ derived: ['A', 'B'] });
            mockInvoke.mockImplementation(rust.invoke);
            await openWindow({ workspaceId: 'ws-A', generation: sessionGen(rust) + 40, sensors: ['TAG1', 'A', 'B'], specialSensorRecipes: [recA, recB] });
            await goManage();
            rust.calls.length = 0;
            await saveEditUi('A', { name: 'A2' }); // rename: recompute A2, recompute B ..., remove old A
            // Exactly ONE guarded command went out (the first write, refused); nothing after it.
            expect(guardedCalls(rust).map(c => [c.cmd, c.error])).toEqual([['evaluate_formula', STALE_SESSION_ERROR]]);
            expect(screen.getAllByRole('alert').map(a => a.textContent).join(' / ')).toContain('This project was closed or reloaded');
            expect(mockEmit).not.toHaveBeenCalledWith('rename-special-sensor', expect.anything());
            expect(mockEmit).not.toHaveBeenCalledWith('update-special-sensor', expect.anything());
            expect(mockEmit).not.toHaveBeenCalledWith('special-sensor-data-changed', expect.anything());
            expect(lostBanner()).toBeTruthy();
        });

        it('a delete commit refused as stale drops nothing and tells the Dashboard nothing; Delete is refused afterwards', async () => {
            const rust = fakeRust({ derived: ['A', 'Z'] });
            mockInvoke.mockImplementation(rust.invoke);
            await openWindow({ workspaceId: 'ws-A', generation: sessionGen(rust) + 40, sensors: ['TAG1', 'A', 'Z'], specialSensorRecipes: [recA, { kind: 'formula', tag: 'Z', formula: '$TAG1 + 1' }] });
            await goManage();
            await act(async () => { fireEvent.click(screen.getByLabelText('Delete Z')); });
            await act(async () => { await vi.advanceTimersByTimeAsync(8100); });
            await flush(40);
            expect(rust.names('remove_sensor_columns').map(c => c.error)).toEqual([STALE_SESSION_ERROR]);
            expect(rust.has('Z')).toBe(true);
            expect(mockEmit).not.toHaveBeenCalledWith('delete-special-sensors', expect.anything());
            expect(lostBanner()).toBeTruthy();
            // Further mutations are refused: no new command goes out.
            const before = rust.calls.length;
            await act(async () => { fireEvent.click(screen.getByLabelText('Delete A')); });
            await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
            expect(rust.calls.length).toBe(before);
        });

        it('a fresh sensors-data with a NEWER generation re-binds the window: banner gone, mutations work again (with the new generation)', async () => {
            const rust = fakeRust();
            mockInvoke.mockImplementation(rust.invoke);
            const g = sessionGen(rust);
            await openWindow({ workspaceId: 'ws-A', generation: g + 40 });
            await addFormulaSensor();
            expect(lostBanner()).toBeTruthy();

            // The SAME stale generation again (a dead Dashboard) does not re-bind ...
            await deliver({ workspaceId: 'ws-A', generation: g + 40 });
            expect(lostBanner()).toBeTruthy();
            // ... a newer one does.
            await deliver({ workspaceId: 'ws-A', generation: g + 41 });
            expect(lostBanner()).toBeNull();
            expect(addBtn()).toBeTruthy();
            await act(async () => { await Promise.resolve(); });
        });

        it('a normal (non-stale) failure still rolls back exactly as before', async () => {
            const rust = fakeRust({ derived: ['A', 'B'] });
            mockInvoke.mockImplementation(rust.invoke);
            const g = sessionGen(rust);
            await openWindow({ workspaceId: 'ws-A', generation: g, sensors: ['TAG1', 'A', 'B'], specialSensorRecipes: [recA, recB] });
            await goManage();
            rust.inner.failOn('evaluate_formula', a => a.customName === 'B' && a.replace === true, 'injected');
            await saveEditUi('A', { formula: '$TAG1 * 9' });
            const writes = rust.names('evaluate_formula').filter(c => c.args.replace && !c.error).map(c => `${c.args.customName}=${c.args.formula}`);
            // A was written, B failed; the one column that HAD been overwritten (A) is put back.
            expect(writes).toEqual(['A=$TAG1 * 9', 'A=$TAG1 * 2']);
            expect(lostBanner()).toBeNull();
        });
    });

    describe('epoch: a different project / dataset resets the WHOLE window', () => {
        it('selected sources, formula draft, search, tab and the open editor are all dropped (the tooling is remounted)', async () => {
            const rust = fakeRust({ derived: ['A'] });
            mockInvoke.mockImplementation(rust.invoke);
            const g = sessionGen(rust);
            await openWindow({ workspaceId: 'ws-A', generation: g, sensors: ['TAG1', 'TAG2', 'A'], specialSensorRecipes: [recA] });
            // A picked source and a formula draft (what the tooling reports up).
            fireEvent.click(screen.getByText('toggle-tag1'));
            fireEvent.click(screen.getByText('submit-formula'));
            fillMeta();
            expect(last(editorProps).quickSelected).toEqual(['TAG1']);
            const toolingBefore = editorProps.length;
            // An editor open on A, with a draft in it.
            await goManage();
            await act(async () => { fireEvent.click(screen.getByLabelText('Edit A')); });
            fireEvent.change(screen.getByLabelText('Formula'), { target: { value: '$TAG1 * 99' } });

            await deliver({ workspaceId: 'ws-B', generation: g + 1, sensors: ['TAG1', 'TAG2', 'A'], specialSensorRecipes: [recA] });

            // Back on Create, editor gone.
            expect(screen.queryByText('Save changes')).toBeNull();
            expect(screen.getByRole('tab', { name: /Create/ }).getAttribute('aria-selected')).toBe('true');
            // The tooling was remounted (a fresh instance) and the picker is empty.
            expect(editorProps.length).toBeGreaterThan(toolingBefore);
            expect(last(editorProps).quickSelected).toEqual([]);
            // The old draft is gone: clicking Add builds nothing from it.
            await act(async () => { fireEvent.click(addBtn()); });
            await flush();
            expect(rust.names('evaluate_formula').filter(c => c.args.customName === 'FormulaCalc')).toHaveLength(0);
        });

        it('queued and in-flight work of the old project is dropped: a held create is refused and an edit queued behind it never runs or announces anything', async () => {
            const rust = fakeRust({ derived: ['A'] });
            mockInvoke.mockImplementation(rust.invoke);
            const g = sessionGen(rust);
            await openWindow({ workspaceId: 'ws-A', generation: g, sensors: ['TAG1', 'TAG2', 'A'], specialSensorRecipes: [recA] });
            const gate = rust.inner.gate('evaluate_formula', a => a.customName === 'FormulaCalc' && !a.replace);
            await addFormulaSensor();                                   // computing, held in Rust
            await goManage();
            await saveEditUi('A', { formula: '$TAG1 * 7' });          // an edit, queued behind the create
            expect(rust.names('evaluate_formula').filter(c => c.args.replace)).toHaveLength(0);

            await deliver({ workspaceId: 'ws-B', generation: g + 1 });  // re-pointed
            void rust.inner.invoke('load_csv', { paths: ['x'] });       // Rust moved on too
            await act(async () => { gate.release(); });
            await flush(60);

            expect(rust.names('evaluate_formula').filter(c => c.args.replace)).toHaveLength(0);
            const announced = mockEmit.mock.calls.filter(c => ['add-sensor-selection', 'update-special-sensor', 'rename-special-sensor', 'special-sensor-data-changed'].includes(c[0]));
            expect(announced).toEqual([]);
            // The new project's window is healthy (no banner for something that happened to the old one).
            expect(lostBanner()).toBeNull();
        });

        it('a pending undo is cancelled on re-bind and never commits against the new project', async () => {
            const rust = fakeRust({ derived: ['A'] });
            mockInvoke.mockImplementation(rust.invoke);
            const g = sessionGen(rust);
            await openWindow({ workspaceId: 'ws-A', generation: g, sensors: ['TAG1', 'A'], specialSensorRecipes: [recA] });
            await goManage();
            await act(async () => { fireEvent.click(screen.getByLabelText('Delete A')); });
            await deliver({ workspaceId: 'ws-A', generation: g + 1, sensors: ['TAG1', 'A'], specialSensorRecipes: [recA] }); // same project, reloaded
            await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
            expect(rust.names('remove_sensor_columns')).toHaveLength(0);
            expect(mockEmit).not.toHaveBeenCalledWith('delete-special-sensors', expect.anything());
        });

        it('the SAME workspace and generation again is only a data refresh: the form is kept', async () => {
            const rust = fakeRust();
            mockInvoke.mockImplementation(rust.invoke);
            const g = sessionGen(rust);
            await openWindow({ workspaceId: 'ws-A', generation: g });
            fireEvent.click(screen.getByText('toggle-tag1'));
            await deliver({ workspaceId: 'ws-A', generation: g, sensors: ['TAG1', 'TAG2', 'NEW'] });
            expect(last(editorProps).quickSelected).toEqual(['TAG1']);
            expect(last(explorerProps).sensors).toEqual(['TAG1', 'TAG2', 'NEW']);
        });
    });

    describe('monotonic rule: an OLDER payload never re-points the window backwards', () => {
        it('a sensors-data at a lower generation (the old project, or the same one) arriving after the window was re-pointed is ignored', async () => {
            const rust = fakeRust();
            mockInvoke.mockImplementation(rust.invoke);
            const g = sessionGen(rust);
            // A is the older load (generation g-1), B the session's current one (g).
            await openWindow({ workspaceId: 'ws-A', generation: g - 1, sensors: ['TAG1', 'TAG2'] });
            await deliver({ workspaceId: 'ws-B', generation: g, sensors: ['TAG1', 'TAG2', 'BONLY'] });
            await deliver({ workspaceId: 'ws-A', generation: g - 1, sensors: ['TAG1', 'TAG2', 'AONLY'] }); // late copy
            expect(last(explorerProps).sensors).toEqual(['TAG1', 'TAG2', 'BONLY']);
            // Even a same-workspace payload at a lower generation is ignored.
            await deliver({ workspaceId: 'ws-B', generation: g - 1, sensors: ['TAG1', 'OLD'] });
            expect(last(explorerProps).sensors).toEqual(['TAG1', 'TAG2', 'BONLY']);
            // And what the window emits (and pins on Rust) is still B's.
            await addFormulaSensor();
            expect(rust.names('evaluate_formula')[0].args.expectedGeneration).toBe(g);
            expect(mockEmit).toHaveBeenCalledWith('add-sensor-selection', expect.objectContaining({ workspaceId: 'ws-B', generation: g }));
        });
    });

    describe('workspace-closing: the Dashboard that bound this window is going away', () => {
        it('for the workspace/dataset this window holds: banner, Add disabled, a pending undo dropped (never committed)', async () => {
            const rust = fakeRust({ derived: ['A'] });
            mockInvoke.mockImplementation(rust.invoke);
            const g = sessionGen(rust);
            await openWindow({ workspaceId: 'ws-A', generation: g, sensors: ['TAG1', 'A'], specialSensorRecipes: [recA] });
            await goManage();
            await act(async () => { fireEvent.click(screen.getByLabelText('Delete A')); });
            await closing({ workspaceId: 'ws-A', generation: g });
            expect(lostBanner()).toBeTruthy();
            await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /Create/ })); });
            expect(addBtn().disabled).toBe(true);
            await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
            expect(rust.names('remove_sensor_columns')).toHaveLength(0);
        });

        it('a closing for ANOTHER workspace, or another generation of this one, is ignored', async () => {
            const rust = fakeRust();
            mockInvoke.mockImplementation(rust.invoke);
            const g = sessionGen(rust);
            await openWindow({ workspaceId: 'ws-B', generation: g });
            await closing({ workspaceId: 'ws-A', generation: g - 1 });
            await closing({ workspaceId: 'ws-B', generation: g - 1 });
            await closing({});
            expect(lostBanner()).toBeNull();
        });

        it('after it, the dead Dashboard\'s payload (same generation) is refused; a newer one re-binds', async () => {
            const rust = fakeRust();
            mockInvoke.mockImplementation(rust.invoke);
            const g = sessionGen(rust);
            await openWindow({ workspaceId: 'ws-A', generation: g });
            await closing({ workspaceId: 'ws-A', generation: g });
            await deliver({ workspaceId: 'ws-A', generation: g });
            expect(lostBanner()).toBeTruthy();
            await deliver({ workspaceId: 'ws-A', generation: g + 1 });
            expect(lostBanner()).toBeNull();
        });
    });
});

// ═════════════════════════════════════════════════════════════════════════
// 2026-10-08 (review S1) -- a special sensor whose recipe could not be rebuilt
// on reopen (Rust now refuses it, e.g. `round($TAG1, 2)`) has no column. Under
// the edit lock that used to be a dead end: formula frozen, Delete off. Now its
// formula/sources can be fixed (generation-pinned, rolled back on failure); the
// NAME stays locked; a healthy locked sensor is unchanged; a description-only
// save never re-sends the refused recipe.
// ═════════════════════════════════════════════════════════════════════════
describe('AddSensorWindow: fixing a special sensor that could not be restored', () => {
    const usingA = {
        id: 'm1', groupNos: [1], name: 'Uses A', kind: 'individual', category: null,
        notes: '', status: true, targetSensor: 'A', predictorSensors: [], xSensor: '', ySensor: '',
        individualChecked: true, rcMode: null, scatterXSensor: '', relModelName: '', relStiffness: 100000,
        clusterModelName: '', numClusters: 3, criteriaSensor: '', clusterRanges: [],
        filterTimePeriods: [], runningConditionMode: 'workspace', customRunningConditionFilters: [], customRunningConditionCombine: 'and',
    };
    const usingH = { ...usingA, id: 'm2', name: 'Uses H', targetSensor: 'H' };
    const badA = { kind: 'formula' as const, tag: 'A', formula: 'round($TAG1, 2)' };
    const healthyH = { kind: 'formula' as const, tag: 'H', formula: '$TAG1 * 2' };
    const onA = { kind: 'formula' as const, tag: 'B', formula: '${A} + 1' };
    const ROUND_MSG = 'Formula error: round($TAG1, 2) does not round to 2 decimal places. Write round($TAG1 * 100) / 100 instead.';
    const ROUND_TEXT = ROUND_MSG.replace(/\.$/, '');
    const meta = [
        { tag: 'A', description: 'Rounded', unit: 'bar', component: 'Uncategorized' },
        { tag: 'B', description: 'On A', unit: 'bar', component: 'Uncategorized' },
        { tag: 'H', description: 'Healthy', unit: 'bar', component: 'Uncategorized' },
    ];
    const WRITES = ['evaluate_formula', 'calculate_new_sensor', 'remove_sensor_columns'];

    async function open(payload: Record<string, unknown>, rustOpts: Parameters<typeof fakeRust>[0] = {}) {
        const rust = fakeRust(rustOpts);
        mockInvoke.mockImplementation(rust.invoke);
        // Bound to the live dataset generation, as the real Dashboard sends it:
        // a repair is only ever unlocked against the window's own dataset.
        await openWindow({ workspaceId: 'ws-1', sensors: ['TAG1', 'TAG2', 'A', 'B', 'H'], sensorMetadata: meta, generation: rust.inner.generation(), ...payload });
        await goManage();
        await flush();
        rust.calls.length = 0;
        return rust;
    }
    const edit = async (tag: string) => { await act(async () => { fireEvent.click(screen.getByLabelText(`Edit ${tag}`)); }); await flush(); };
    const save = async () => { await act(async () => { fireEvent.click(screen.getByText('Save changes')); }); await flush(40); };

    it('LOCKED + not restored: row flagged, editor unlocks the formula (not the name) with the amber note; the fix recomputes it with replace, reaches the Dashboard, and the flag goes away', async () => {
        disk.models = [usingA];
        const rust = await open({ specialSensorRecipes: [badA], models: [usingA] });
        expect(screen.getByTestId('not-restored-A').getAttribute('title')).toContain(ROUND_TEXT);

        await edit('A');
        expect(screen.getByText('No data — fix formula', { selector: '.fx-pill' })).toBeTruthy();
        expect(screen.getByTestId('restore-note').textContent).toBe(
            `This sensor has no data this session — its formula was refused when the project opened: ${ROUND_TEXT}. Fix the formula and save. The name stays locked; 1 model trained on it will need training again (set points are kept).`,
        );
        // The footer says what Saving does, with the REAL demotion count.
        expect(screen.getByTestId('edit-footer-hint').textContent)
            .toBe('Saving restores the data; 1 model goes back to Incomplete (set points kept).');
        expect(screen.queryByTestId('edit-lock-banner')).toBeNull();
        expect((screen.getByLabelText('Name') as HTMLInputElement).readOnly).toBe(true);
        expect((screen.getByLabelText('Formula') as HTMLTextAreaElement).readOnly).toBe(false);

        fireEvent.change(screen.getByLabelText('Formula'), { target: { value: 'round($TAG1 * 100) / 100' } });
        await save();

        const evals = rust.calls.filter(c => c.cmd === 'evaluate_formula');
        expect(evals.map(c => c.args)).toEqual([{ formula: 'round($TAG1 * 100) / 100', customName: 'A', replace: true, expectedGeneration: rust.inner.generation() }]);
        expect(rust.has('A')).toBe(true);
        expect(mockEmit).toHaveBeenCalledWith('update-special-sensor', expect.objectContaining({
            recipe: { kind: 'formula', tag: 'A', formula: 'round($TAG1 * 100) / 100' }, recomputed: ['A'], workspaceId: 'ws-1',
            repaired: true, affectedTags: ['A'],
        }));
        expect(mockEmit.mock.calls.some(c => c[0] === 'rename-special-sensor')).toBe(false);
        expect(screen.getByRole('status').textContent).toMatch(/Restored A\. 1 model\(s\) set back to Incomplete — train them again\./);
        await flush();
        expect(screen.queryByTestId('not-restored-A')).toBeNull();
        // Fixed = has data again = the normal lock is back.
        await edit('A');
        expect(screen.getByTestId('edit-lock-banner')).toBeTruthy();
        expect((screen.getByLabelText('Formula') as HTMLTextAreaElement).readOnly).toBe(true);
    });

    it('fixing it also rebuilds what was skipped because it was built on it (only the broken one is flagged)', async () => {
        const usingB = { ...usingA, targetSensor: 'B' };
        disk.models = [usingB];
        const rust = await open({ specialSensorRecipes: [badA, onA], models: [usingB] });
        expect(screen.getByTestId('not-restored-A')).toBeTruthy();
        expect(screen.queryByTestId('not-restored-B')).toBeNull();
        await edit('A');
        fireEvent.change(screen.getByLabelText('Formula'), { target: { value: '$TAG1 * 3' } });
        await save();
        expect(rust.calls.filter(c => c.cmd === 'evaluate_formula').map(c => c.args.customName)).toEqual(['A', 'B']);
        expect(rust.has('A')).toBe(true);
        expect(rust.has('B')).toBe(true);
        expect(screen.getByRole('status').textContent).toMatch(/Restored A and 1 sensor\(s\) built on it\. 1 model\(s\) set back to Incomplete — train them again\./);
        expect(mockEmit).toHaveBeenCalledWith('update-special-sensor', expect.objectContaining({
            recomputed: ['A', 'B'], repaired: true, affectedTags: ['A', 'B'],
        }));
    });

    it('DESCRIPTION-only save of a locked, not-restored sensor works: nothing is sent to Rust, the Dashboard gets the stored recipe and nothing recomputed', async () => {
        disk.models = [usingA];
        const rust = await open({ specialSensorRecipes: [badA], models: [usingA] });
        await edit('A');
        fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Rounded pressure' } });
        await save();
        expect(rust.calls.filter(c => WRITES.includes(c.cmd))).toHaveLength(0);
        expect(screen.queryAllByRole('alert')).toHaveLength(0);
        expect(mockEmit).toHaveBeenCalledWith('update-special-sensor', expect.objectContaining({
            recipe: badA, recomputed: [], metadata: expect.objectContaining({ tag: 'A', description: 'Rounded pressure' }),
        }));
        // Nothing was recomputed, so no model is touched (MUST-FIX 2).
        const sent = mockEmit.mock.calls.find(c => c[0] === 'update-special-sensor')![1];
        expect(sent.repaired).toBeUndefined();
        expect(sent.affectedTags).toBeUndefined();
        expect(screen.getByTestId('not-restored-A')).toBeTruthy(); // still no data -- only the text changed
    });

    it('DESCRIPTION-only save of an UNUSED not-restored sensor no longer fails on the refused recipe', async () => {
        const rust = await open({ specialSensorRecipes: [badA] });
        await edit('A');
        fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'kPa' } });
        await save();
        expect(rust.calls.filter(c => WRITES.includes(c.cmd))).toHaveLength(0);
        expect(screen.queryAllByRole('alert')).toHaveLength(0);
        expect(screen.getByRole('status').textContent).toMatch(/Updated A/);
    });

    it('a "fix" that is still the spreadsheet round(x, n) is held back before saving: the check line names it with the engine-form fix, nothing is written, the sensor stays flagged', async () => {
        disk.models = [usingA];
        const rust = await open({ specialSensorRecipes: [badA], models: [usingA] });
        await edit('A');
        fireEvent.change(screen.getByLabelText('Formula'), { target: { value: 'round($TAG1, 3)' } });
        expect(screen.getByTestId('formula-check').textContent).toMatch(/round\(\$TAG1, 3\) does not round to 3 decimal places/);
        expect(screen.getByTestId('edit-footer-hint').textContent).toMatch(/does not round to 3 decimal places/);
        expect((screen.getByText('Save changes') as HTMLButtonElement).disabled).toBe(true);
        await save();
        expect(rust.has('A')).toBe(false);
        expect(mockEmit.mock.calls.some(c => c[0] === 'update-special-sensor')).toBe(false);
        // The fix button writes the engine form.
        fireEvent.click(within(screen.getByTestId('formula-check')).getByRole('button', { name: 'Use round(… * 1000) / 1000' }));
        expect((screen.getByLabelText('Formula') as HTMLTextAreaElement).value).toBe('round($TAG1 * 1000) / 1000');
        await act(async () => { fireEvent.click(screen.getByText('Cancel edit')); });
        await flush();
        expect(screen.getByTestId('not-restored-A')).toBeTruthy();
    });

    it('a fix Rust still refuses at save time shows its message, writes nothing, and keeps the sensor flagged', async () => {
        disk.models = [usingA];
        const rust = await open({ specialSensorRecipes: [badA], models: [usingA] });
        rust.inner.failOn('evaluate_formula', a => a.customName === 'A', 'Formula error: refused by the engine.', false);
        await edit('A');
        fireEvent.change(screen.getByLabelText('Formula'), { target: { value: '$TAG1 * 4' } });
        await save();
        expect(screen.getAllByRole('alert').map(a => a.textContent).join(' ')).toMatch(/refused by the engine/);
        expect(rust.has('A')).toBe(false);
        expect(mockEmit.mock.calls.some(c => c[0] === 'update-special-sensor')).toBe(false);
        await act(async () => { fireEvent.click(screen.getByText('Cancel edit')); });
        await flush();
        expect(screen.getByTestId('not-restored-A')).toBeTruthy();
    });

    it('LOCKED + healthy stays fully locked next to a broken one', async () => {
        disk.models = [usingA, usingH];
        await open({ specialSensorRecipes: [healthyH, badA], models: [usingA, usingH] }, { derived: ['H'] });
        expect(screen.getByTestId('not-restored-A')).toBeTruthy();
        expect(screen.queryByTestId('not-restored-H')).toBeNull();
        await edit('H');
        expect(screen.getByTestId('edit-lock-banner')).toBeTruthy();
        expect(screen.queryByTestId('restore-note')).toBeNull();
        expect((screen.getByLabelText('Formula') as HTMLTextAreaElement).readOnly).toBe(true);
    });

    it('a session that is not the window’s dataset (generation pin) unlocks nothing', async () => {
        disk.models = [usingA];
        const rust = fakeRust();
        mockInvoke.mockImplementation(rust.invoke);
        await openWindow({ workspaceId: 'ws-1', sensors: ['TAG1', 'A'], sensorMetadata: meta, specialSensorRecipes: [badA], models: [usingA], generation: rust.inner.generation() + 5 });
        await goManage();
        await flush();
        expect(screen.queryByTestId('not-restored-A')).toBeNull();
        await edit('A');
        expect(screen.getByTestId('edit-lock-banner')).toBeTruthy();
    });

    it('bound to the live generation: the reason check and the fix both carry expectedGeneration', async () => {
        disk.models = [usingA];
        const rust = fakeRust();
        mockInvoke.mockImplementation(rust.invoke);
        const g = rust.inner.generation();
        await openWindow({ workspaceId: 'ws-1', sensors: ['TAG1', 'A'], sensorMetadata: meta, specialSensorRecipes: [badA], models: [usingA], generation: g });
        await goManage();
        await flush();
        expect(rust.calls.find(c => c.cmd === 'validate_formula')?.args).toEqual({ formula: 'round($TAG1, 2)', expectedGeneration: g });
        await edit('A');
        fireEvent.change(screen.getByLabelText('Formula'), { target: { value: '$TAG1 * 3' } });
        await save();
        expect(rust.calls.filter(c => c.cmd === 'evaluate_formula').map(c => c.args.expectedGeneration)).toEqual([g]);
        expect(rust.has('A')).toBe(true);
    });
    // MUST-FIX 1 (2026-10-08 review): A = round($TAG1, 2) is refused on reopen,
    // B = round(${A}, 2) is skipped, a model uses B. Fixing A must keep the fix
    // even though B's OWN formula is refused too -- B is reported and shows up
    // as broken on its own; nothing typed is lost and A is not rolled back.
    it('CHAINED, both broken: fixing A saves A, reports B as still needing a fix (with Rust\'s reason), and B is then flagged on its own', async () => {
        const badB = { kind: 'formula' as const, tag: 'B', formula: 'round(${A}, 2)' };
        const usingB = { ...usingA, id: 'mB', name: 'Uses B', targetSensor: 'B' };
        disk.models = [usingB];
        const rust = await open({ specialSensorRecipes: [badA, badB], models: [usingB] });
        expect(screen.getByTestId('not-restored-A')).toBeTruthy();
        expect(screen.queryByTestId('not-restored-B')).toBeNull(); // skipped, not failed

        await edit('A');
        fireEvent.change(screen.getByLabelText('Formula'), { target: { value: '$TAG1 * 3' } });
        await save();

        expect(screen.queryAllByRole('alert')).toHaveLength(0);
        expect(rust.has('A')).toBe(true);
        expect(rust.has('B')).toBe(false);
        expect(rust.calls.filter(c => c.cmd === 'remove_sensor_columns')).toHaveLength(0); // no rollback
        const status = screen.getByRole('status').textContent ?? '';
        expect(status).toMatch(/Restored A\. B still needs fixing: .*does not round to 2 decimal places.*\. 1 model\(s\) set back to Incomplete — train them again\.$/);
        expect(mockEmit).toHaveBeenCalledWith('update-special-sensor', expect.objectContaining({
            recipe: { kind: 'formula', tag: 'A', formula: '$TAG1 * 3' },
            recomputed: ['A'],
            repaired: true,
            affectedTags: ['A', 'B'],
        }));
        await flush();
        expect(screen.queryByTestId('not-restored-A')).toBeNull();
        expect(screen.getByTestId('not-restored-B').getAttribute('title')).toMatch(/does not round to 2 decimal places/);
        // B can now be fixed the same way.
        await edit('B');
        expect((screen.getByLabelText('Formula') as HTMLTextAreaElement).readOnly).toBe(false);
        fireEvent.change(screen.getByLabelText('Formula'), { target: { value: 'round(${A} * 100) / 100' } });
        await save();
        expect(rust.has('B')).toBe(true);
        expect(screen.queryByTestId('not-restored-B')).toBeNull();
    });

    // MUST-FIX 1a: when a repair fails AFTER the fix was written (here: a
    // sensor built on A that HAD a column cannot be recomputed), the rollback
    // REMOVES A's new column -- recomputing A's original recipe is refused by
    // Rust before it writes, which used to leave the rejected fix's values in
    // place, so A looked healthy, the lock came back and Save silently sent
    // the stored broken recipe.
    it('a failed repair leaves NO column for A (removed, not "recomputed from the original"), keeps A flagged and the typed fix in the form', async () => {
        disk.models = [usingA];
        const onA2 = { kind: 'formula' as const, tag: 'C', formula: '${A} * 2' };
        const rust = await open({ specialSensorRecipes: [badA, onA2], models: [usingA] }, { derived: ['C'] });
        rust.inner.failOn('evaluate_formula', a => a.customName === 'C' && a.replace === true, 'injected');
        expect(screen.getByTestId('not-restored-A')).toBeTruthy();

        await edit('A');
        fireEvent.change(screen.getByLabelText('Formula'), { target: { value: '$TAG1 * 3' } });
        await save();

        const alert = screen.getAllByRole('alert').map(a => a.textContent).join(' ');
        expect(alert).toMatch(/Could not recompute "C"/);
        expect(alert).not.toMatch(/previous values/);
        expect(rust.has('A')).toBe(false);
        expect(rust.calls.filter(c => c.cmd === 'remove_sensor_columns').map(c => c.args.names)).toEqual([['A']]);
        // The original, refused recipe is never re-sent as a "rollback".
        expect(rust.calls.filter(c => c.cmd === 'evaluate_formula' && c.args.formula === 'round($TAG1, 2)')).toHaveLength(0);
        expect(mockEmit.mock.calls.some(c => c[0] === 'update-special-sensor')).toBe(false);
        await flush();
        // Still the repair form, with what the user typed.
        expect((screen.getByLabelText('Formula') as HTMLTextAreaElement).value).toBe('$TAG1 * 3');
        expect((screen.getByLabelText('Formula') as HTMLTextAreaElement).readOnly).toBe(false);
        expect(screen.queryByTestId('edit-lock-banner')).toBeNull();
        expect(screen.getByTestId('restore-note')).toBeTruthy();
        // And the Manage row is still flagged.
        await goManage();
        expect(screen.getByTestId('not-restored-A')).toBeTruthy();
    });

    // SHOULD-FIX 1: the in-queue re-check is generation-pinned. Here the
    // window unlocked A against its own dataset, but by the time Save runs the
    // session answers a DIFFERENT generation: nothing is unlocked -- the normal
    // lock refuses the formula change and no column is written.
    it('in-queue re-check: a session generation that is not the window\'s unlocks nothing (the lock refuses, nothing is written)', async () => {
        disk.models = [usingA];
        const rust = await open({ specialSensorRecipes: [badA], models: [usingA] });
        await edit('A');
        fireEvent.change(screen.getByLabelText('Formula'), { target: { value: '$TAG1 * 3' } });
        const g = rust.inner.generation();
        mockInvoke.mockImplementation(async (cmd: string, args?: any) => (
            cmd === 'get_session_generation' ? g + 1 : rust.invoke(cmd, args)
        ));
        await save();
        expect(screen.getAllByRole('alert').map(a => a.textContent).join(' ')).toMatch(/Can't change the formula, operation or sources of "A"/);
        expect(rust.calls.filter(c => WRITES.includes(c.cmd))).toHaveLength(0);
        expect(mockEmit.mock.calls.some(c => c[0] === 'update-special-sensor')).toBe(false);
    });

    it('a window that was never told its generation unlocks nothing (no badge, normal lock)', async () => {
        disk.models = [usingA];
        await open({ specialSensorRecipes: [badA], models: [usingA], generation: undefined });
        expect(screen.queryByTestId('not-restored-A')).toBeNull();
        await edit('A');
        expect(screen.getByTestId('edit-lock-banner')).toBeTruthy();
    });

    // SHOULD-FIX 3: a not-restored OPERATION sensor whose stored config the
    // editor's engine would not rebuild byte-for-byte: a unit-only save must
    // still be metadata-only (the stored recipe, nothing sent to Rust).
    it('UNIT-only save of a not-restored OPERATION sensor is metadata-only even when the engine would rebuild its config differently', async () => {
        const badOp = {
            kind: 'operation' as const, tag: 'OP', sourceSensors: ['GONE'],
            operationConfig: { mode: 'single' as const, singleOp: { type: 'add' as const, value: 10 }, multiOp: { type: 'sum' as const }, customName: 'OP' },
        };
        const usingOp = { ...usingA, id: 'mOp', name: 'Uses OP', targetSensor: 'OP' };
        disk.models = [usingOp];
        const rust = await open({
            specialSensorRecipes: [badOp], models: [usingOp],
            sensorMetadata: [...meta, { tag: 'OP', description: 'Shifted', unit: 'bar', component: 'Uncategorized' }],
        });
        expect(screen.getByTestId('not-restored-OP').getAttribute('title')).toContain('Sensor not found: GONE');
        await edit('OP');
        fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'kPa' } });
        await save();
        expect(rust.calls.filter(c => WRITES.includes(c.cmd))).toHaveLength(0);
        expect(screen.queryAllByRole('alert')).toHaveLength(0);
        const sent = mockEmit.mock.calls.find(c => c[0] === 'update-special-sensor')![1];
        expect(sent.recipe).toEqual(badOp);
        expect(sent.recomputed).toEqual([]);
        expect(sent.repaired).toBeUndefined();
        expect(sent.metadata).toMatchObject({ tag: 'OP', unit: 'kPa' });
    });
});
