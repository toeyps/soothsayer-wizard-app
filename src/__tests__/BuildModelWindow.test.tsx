import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, within } from '@testing-library/react';

const mockClose = vi.fn().mockResolvedValue(undefined);
vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({ close: mockClose }),
}));

let listenCallbacks: Record<string, Array<(e: any) => void>> = {};
const mockListen = vi.fn((event: string, cb: (e: any) => void) => {
    (listenCallbacks[event] ??= []).push(cb);
    return Promise.resolve(() => {
        listenCallbacks[event] = (listenCallbacks[event] ?? []).filter((c) => c !== cb);
    });
});
const mockEmit = vi.fn().mockResolvedValue(undefined);
vi.mock('@tauri-apps/api/event', () => ({
    listen: (event: string, cb: any) => mockListen(event, cb),
    emit: (event: string, payload?: any) => mockEmit(event, payload),
}));

const mockUpdateWorkspaceData = vi.fn();
const mockLoadWorkspaceData = vi.fn();
vi.mock('../workspaceManager', () => ({
    updateWorkspaceData: (id: string, patch: any) => mockUpdateWorkspaceData(id, patch),
    loadWorkspaceData: (id: string) => mockLoadWorkspaceData(id),
}));

import BuildModelWindow from '../components/windows/BuildModelWindow';

function makeGroup(overrides: Record<string, any> = {}) {
    return { no: 1, name: 'Group A', isCollapsed: false, description: '', recommendation: '', ...overrides };
}

function makeModel(overrides: Record<string, any> = {}) {
    return {
        id: 'm1', groupNo: 1, name: 'Model One', kind: 'individual', category: 'performance', notes: '', status: false,
        targetSensor: 'TAG1', predictorSensors: [], xSensor: '', ySensor: '',
        individualChecked: true, rcMode: null, scatterXSensor: '', relModelName: '',
        relStiffness: 100_000, clusterModelName: '', numClusters: 3, criteriaSensor: '',
        clusterRanges: [], filterTimeStart: '', filterTimeEnd: '', pmSensorFilters: [],
        ...overrides,
    };
}

async function deliverData(overrides: Record<string, any> = {}) {
    const payload = {
        workspaceId: 'ws1',
        sensorHeaders: ['TAG1', 'TAG2', 'TAG3'],
        sensorMetadata: [
            { tag: 'TAG1', description: 'Pump Pressure', unit: 'bar', component: 'Pump' },
            { tag: 'TAG2', description: 'Pump Temp', unit: 'C', component: 'Pump' },
        ],
        metadata: { headers: ['timestamp', 'TAG1', 'TAG2', 'TAG3'], total_rows: 100 },
    };
    mockLoadWorkspaceData.mockResolvedValue({
        id: 'ws1',
        failureGroupState: { groups: [makeGroup()], models: [makeModel()] },
        ...overrides,
    });
    await act(async () => {
        for (const cb of listenCallbacks['build-model-data'] ?? []) cb({ payload });
        await Promise.resolve();
        await Promise.resolve();
    });
}

function withGroupNo(no = 1) {
    window.history.pushState({}, '', `/?window=build-model&groupNo=${no}`);
}

beforeEach(() => {
    withGroupNo(1);
    listenCallbacks = {};
    mockListen.mockClear();
    mockEmit.mockClear().mockResolvedValue(undefined);
    mockClose.mockClear().mockResolvedValue(undefined);
    mockUpdateWorkspaceData.mockReset().mockImplementation(async (id: string, patch: (s: any) => any) => {
        const prev = { id, failureGroupState: { groups: [makeGroup()], models: [makeModel()] } };
        return patch(prev);
    });
    mockLoadWorkspaceData.mockReset();
});

afterEach(() => {
    cleanup();
});

describe('BuildModelWindow', () => {
    it('reads groupNo from the URL and requests build-model-data on mount', async () => {
        render(<BuildModelWindow />);
        await act(async () => { await Promise.resolve(); });
        expect(mockEmit).toHaveBeenCalledWith('request-build-model-data', undefined);
    });

    it('shows the group id, name, and its models once hydrated', async () => {
        render(<BuildModelWindow />);
        await deliverData();
        expect(screen.getAllByText(/FG-1/).length).toBeGreaterThan(0);
        expect(screen.getByDisplayValue('Group A')).toBeTruthy(); // editable Name field
        expect(screen.getByText('Model One')).toBeTruthy();
    });

    describe('group name', () => {
        it('debounces a save of the name, matching mockup\'s editable Name field', async () => {
            vi.useFakeTimers();
            render(<BuildModelWindow />);
            await deliverData();

            const nameInput = screen.getByDisplayValue('Group A');
            fireEvent.change(nameInput, { target: { value: 'Renamed Group' } });
            await act(async () => { await vi.advanceTimersByTimeAsync(250); });

            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(state.failureGroupState.groups[0].name).toBe('Renamed Group');
            vi.useRealTimers();
        });

        it('rejects renaming to a name already used by another group, with an inline error', async () => {
            vi.useFakeTimers();
            mockUpdateWorkspaceData.mockClear();
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup(), makeGroup({ no: 2, name: 'Other Group' })], models: [makeModel()] } });

            const nameInput = screen.getByDisplayValue('Group A');
            fireEvent.change(nameInput, { target: { value: 'other group' } });
            await act(async () => { await vi.advanceTimersByTimeAsync(250); });

            expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
            expect(screen.getByText('A failure group named "other group" already exists')).toBeTruthy();
            vi.useRealTimers();
        });
    });

    describe('description / recommendation', () => {
        it('debounces a save of the description into this group only', async () => {
            vi.useFakeTimers();
            render(<BuildModelWindow />);
            await deliverData();

            const textarea = screen.getByPlaceholderText('What failure mode does this group track?');
            fireEvent.change(textarea, { target: { value: 'Bearing wear' } });

            await act(async () => { await vi.advanceTimersByTimeAsync(250); });
            expect(mockUpdateWorkspaceData).toHaveBeenCalledWith('ws1', expect.any(Function));
            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(state.failureGroupState.groups[0].description).toBe('Bearing wear');
            vi.useRealTimers();
        });

        it('broadcasts failure-group-state-changed after persisting', async () => {
            vi.useFakeTimers();
            render(<BuildModelWindow />);
            await deliverData();
            mockEmit.mockClear();

            fireEvent.change(screen.getByPlaceholderText('What failure mode does this group track?'), { target: { value: 'X' } });
            await act(async () => { await vi.advanceTimersByTimeAsync(250); });
            await act(async () => { await Promise.resolve(); });

            expect(mockEmit).toHaveBeenCalledWith('failure-group-state-changed', expect.any(Object));
            vi.useRealTimers();
        });
    });

    describe('model list actions', () => {
        it('toggling a model\'s status pill persists the change', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Incomplete'));
            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(state.failureGroupState.models[0].status).toBe(true);
        });

        it('"Open in Predictive Model" emits launch-predictive-model with the model id, without opening the edit form', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Open in Predictive Model →'));
            expect(mockEmit).toHaveBeenCalledWith('launch-predictive-model', { modelId: 'm1' });
            expect(screen.queryByTestId('add-model-form')).toBeNull();
        });

        it('the status pill toggles status without opening the edit form', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Incomplete'));
            expect(screen.queryByTestId('add-model-form')).toBeNull();
        });

        it('clicking the same row again closes its edit form (toggle), instead of requiring a different row to close it', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Model One'));
            expect(screen.getByTestId('add-model-form')).toBeTruthy();

            fireEvent.click(screen.getByText('Model One'));
            expect(screen.queryByTestId('add-model-form')).toBeNull();
        });

        it('clicking a different row while one is being edited switches the form to the new row', async () => {
            const first = makeModel({ id: 'm1', name: 'First Model' });
            const second = makeModel({ id: 'm2', name: 'Second Model', targetSensor: 'TAG2' });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [first, second] } });

            fireEvent.click(screen.getByText('First Model'));
            expect((within(screen.getByTestId('add-model-form')).getByPlaceholderText('e.g. Bearing vibration model') as HTMLInputElement).value).toBe('First Model');

            fireEvent.click(screen.getByText('Second Model'));
            expect((within(screen.getByTestId('add-model-form')).getByPlaceholderText('e.g. Bearing vibration model') as HTMLInputElement).value).toBe('Second Model');
        });

        it('the edit form appears right under the row that was clicked, not always at the bottom of the list', async () => {
            const first = makeModel({ id: 'm1', name: 'First Model' });
            const second = makeModel({ id: 'm2', name: 'Second Model', targetSensor: 'TAG2' });
            const third = makeModel({ id: 'm3', name: 'Third Model', targetSensor: 'TAG3' });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [first, second, third] } });

            fireEvent.click(screen.getByText('Second Model'));
            const form = screen.getByTestId('add-model-form');
            const thirdRow = screen.getByText('Third Model');
            // The form (attached to the 2nd model) must precede the 3rd
            // model's row in DOM order — if it were always appended after
            // the whole list, the 3rd row would come BEFORE the form.
            expect(form.compareDocumentPosition(thirdRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        });

        it('clicking the row opens the edit form prefilled with the model\'s current values', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Model One'));
            const form = within(screen.getByTestId('add-model-form'));
            expect((form.getByPlaceholderText('e.g. Bearing vibration model') as HTMLInputElement).value).toBe('Model One');
            expect((form.getByText('Individual').closest('button') as HTMLButtonElement).style.color).toBe('var(--accent-color)');
            expect((form.getByText('Performance').closest('button') as HTMLButtonElement).style.color).toBe('var(--accent-color)');
            expect(form.getByDisplayValue('TAG1')).toBeTruthy();
            expect(form.getByText('Save changes')).toBeTruthy();
        });

        it('saving the edit form persists changes into that specific model', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Model One'));
            const form = within(screen.getByTestId('add-model-form'));
            fireEvent.change(form.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Renamed' } });
            fireEvent.click(form.getByText('Condition'));
            fireEvent.click(form.getByText('Save changes'));

            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            const saved = state.failureGroupState.models.find((m: any) => m.id === 'm1');
            expect(saved.name).toBe('Renamed');
            expect(saved.category).toBe('condition');
        });

        it('"Remove model" inside the edit form confirms then persists the model list without it', async () => {
            vi.spyOn(window, 'confirm').mockReturnValue(true);
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Model One'));
            fireEvent.click(screen.getByText('Remove model'));
            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(state.failureGroupState.models).toHaveLength(0);
        });
    });

    describe('add model form', () => {
        it('Create model is disabled until name + kind + category + an individual sensor are all set', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Add Model'));
            const form = within(screen.getByTestId('add-model-form'));

            const create = form.getByText('Create model').closest('button') as HTMLButtonElement;
            expect(create.disabled).toBe(true);

            fireEvent.change(form.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'New Model' } });
            expect(create.disabled).toBe(true);

            fireEvent.click(form.getByText('Individual'));
            expect(create.disabled).toBe(true);

            fireEvent.click(form.getByText('Performance'));
            expect(create.disabled).toBe(true); // still missing a sensor

            const sensorSelect = form.getByDisplayValue('Select a sensor…');
            fireEvent.change(sensorSelect, { target: { value: 'TAG2' } });
            expect(create.disabled).toBe(false);
        });

        it('requires at least one predictor for a relationship model', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Add Model'));
            const form = within(screen.getByTestId('add-model-form'));
            fireEvent.change(form.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Rel Model' } });
            fireEvent.click(form.getByText('Relationship'));
            fireEvent.click(form.getByText('Condition'));

            const create = form.getByText('Create model').closest('button') as HTMLButtonElement;
            expect(create.disabled).toBe(true); // no target/predictors yet

            const [targetSelect] = form.getAllByDisplayValue('Select a sensor…');
            fireEvent.change(targetSelect, { target: { value: 'TAG1' } });
            expect(create.disabled).toBe(true); // target set, but no predictors

            fireEvent.change(form.getByDisplayValue('Add a predictor…'), { target: { value: 'TAG2' } });
            expect(create.disabled).toBe(false);
        });

        it('requires both X and Y sensors for a clustering model', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Add Model'));
            const form = within(screen.getByTestId('add-model-form'));
            fireEvent.change(form.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Cluster Model' } });
            fireEvent.click(form.getByText('Clustering'));
            fireEvent.click(form.getByText('Condition'));

            const create = form.getByText('Create model').closest('button') as HTMLButtonElement;
            expect(create.disabled).toBe(true);

            const selects = form.getAllByText('Select…').map(o => o.closest('select')!) as HTMLSelectElement[];
            fireEvent.change(selects[0], { target: { value: 'TAG1' } });
            expect(create.disabled).toBe(true);
            fireEvent.change(selects[1], { target: { value: 'TAG2' } });
            expect(create.disabled).toBe(false);
        });

        it('creating a model persists it and resets/closes the form', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Add Model'));
            const form = within(screen.getByTestId('add-model-form'));
            fireEvent.change(form.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'New Model' } });
            fireEvent.click(form.getByText('Individual'));
            fireEvent.click(form.getByText('Performance'));
            fireEvent.change(form.getByDisplayValue('Select a sensor…'), { target: { value: 'TAG2' } });
            fireEvent.click(form.getByText('Create model'));

            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(state.failureGroupState.models.some((m: any) => m.name === 'New Model' && m.targetSensor === 'TAG2')).toBe(true);
            expect(screen.queryByPlaceholderText('e.g. Bearing vibration model')).toBeNull();
        });

        it('shows the Component readout with a placeholder as soon as a kind is picked, before any sensor is chosen', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Add Model'));
            const form = within(screen.getByTestId('add-model-form'));
            expect(form.queryByText('Component')).toBeNull(); // no kind picked yet

            fireEvent.click(form.getByText('Individual'));
            expect(form.getByText('Component')).toBeTruthy();
            expect(form.getByText('Auto-filled from target sensor')).toBeTruthy();

            fireEvent.change(form.getByDisplayValue('Select a sensor…'), { target: { value: 'TAG1' } });
            expect(form.getByText('Pump')).toBeTruthy();
            expect(form.queryByText('Auto-filled from target sensor')).toBeNull();
        });

        it('gives the Condition pill a distinct (purple) active color from Performance\'s accent color', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Add Model'));
            const form = within(screen.getByTestId('add-model-form'));

            fireEvent.click(form.getByText('Condition'));
            expect((form.getByText('Condition').closest('button') as HTMLButtonElement).style.color).toBe('var(--cond)');

            fireEvent.click(form.getByText('Performance'));
            expect((form.getByText('Performance').closest('button') as HTMLButtonElement).style.color).toBe('var(--accent-color)');
        });

        it('Cancel resets the form without persisting', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            mockUpdateWorkspaceData.mockClear();
            fireEvent.click(screen.getByText('Add Model'));
            const form = within(screen.getByTestId('add-model-form'));
            fireEvent.change(form.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Discarded' } });
            fireEvent.click(form.getByText('Cancel'));
            expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
            expect(screen.queryByPlaceholderText('e.g. Bearing vibration model')).toBeNull();
        });
    });

    it('Close calls the Tauri window close API', async () => {
        render(<BuildModelWindow />);
        await deliverData();
        fireEvent.click(screen.getByTitle('Close'));
        expect(mockClose).toHaveBeenCalled();
    });
});
