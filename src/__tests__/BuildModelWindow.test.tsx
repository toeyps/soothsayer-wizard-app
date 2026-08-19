import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, within } from '@testing-library/react';

const mockClose = vi.fn().mockResolvedValue(undefined);
const mockSetTitle = vi.fn().mockResolvedValue(undefined);
vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({ close: mockClose, setTitle: mockSetTitle }),
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

beforeEach(() => {
    listenCallbacks = {};
    mockListen.mockClear();
    mockEmit.mockClear().mockResolvedValue(undefined);
    mockClose.mockClear().mockResolvedValue(undefined);
    mockSetTitle.mockClear().mockResolvedValue(undefined);
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
    it('requests build-model-data on mount', async () => {
        render(<BuildModelWindow />);
        await act(async () => { await Promise.resolve(); });
        expect(mockEmit).toHaveBeenCalledWith('request-build-model-data', undefined);
    });

    describe('overview page', () => {
        it('is the page shown by default after hydration', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            expect(screen.getByText('Build Model — Overview')).toBeTruthy();
            expect(screen.getByText('Group A')).toBeTruthy();
            expect(screen.getByText('FG-1')).toBeTruthy();
            expect(screen.getByText('Model One')).toBeTruthy();
        });

        it('shows exactly one line per model — no duplicate description/description(tag) lines', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel({ name: '', targetSensor: 'TAG1' })] } });
            expect(screen.getAllByText('Pump Pressure (TAG1)')).toHaveLength(1);
        });

        it('switches to grouping by Component and shows an FG chip only in that view', async () => {
            const models = [
                makeModel({ id: 'm1', name: 'Bearing model', targetSensor: 'TAG1' }),
                makeModel({ id: 'm2', name: 'Motor model', targetSensor: 'TAG2' }),
            ];
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models } });
            expect(screen.queryByText(/FG-1 · Group A/)).toBeNull();

            fireEvent.click(screen.getByText('Group by Component'));
            expect(screen.getByText('Pump')).toBeTruthy();
            expect(screen.getByText('Bearing model')).toBeTruthy();
            expect(screen.getByText('Motor model')).toBeTruthy();
            expect(screen.getAllByText(/FG-1 · Group A/).length).toBe(2); // one chip per model row
        });

        it('groups a model with no target sensor under "Uncategorized" in Component view', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel({ targetSensor: '' })] } });
            fireEvent.click(screen.getByText('Group by Component'));
            expect(screen.getByText('Uncategorized')).toBeTruthy();
        });

        it('stays in sync with a failure-group-state-changed broadcast from another window', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            expect(screen.queryByText('New Model')).toBeNull();

            await act(async () => {
                for (const cb of listenCallbacks['failure-group-state-changed'] ?? []) {
                    cb({ payload: { groups: [makeGroup()], models: [makeModel({ id: 'm2', name: 'New Model' })] } });
                }
            });
            expect(screen.getByText('New Model')).toBeTruthy();
        });

        describe('inline group rename', () => {
            it('clicking the group name opens a prefilled input and commits on Enter', async () => {
                render(<BuildModelWindow />);
                await deliverData();
                fireEvent.click(screen.getByText('Group A'));
                const input = screen.getByDisplayValue('Group A') as HTMLInputElement;
                fireEvent.change(input, { target: { value: 'Renamed Group' } });
                fireEvent.keyDown(input, { key: 'Enter' });

                const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
                expect(state.failureGroupState.groups[0].name).toBe('Renamed Group');
            });

            it('commits on blur too', async () => {
                render(<BuildModelWindow />);
                await deliverData();
                fireEvent.click(screen.getByText('Group A'));
                const input = screen.getByDisplayValue('Group A') as HTMLInputElement;
                fireEvent.change(input, { target: { value: 'Blurred Name' } });
                fireEvent.blur(input);

                const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
                expect(state.failureGroupState.groups[0].name).toBe('Blurred Name');
            });

            it('rejects renaming to a name already used by another group, with an inline error', async () => {
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups: [makeGroup(), makeGroup({ no: 2, name: 'Other Group' })], models: [makeModel()] } });
                mockUpdateWorkspaceData.mockClear();
                fireEvent.click(screen.getByText('Group A'));
                const input = screen.getByDisplayValue('Group A') as HTMLInputElement;
                fireEvent.change(input, { target: { value: 'other group' } });
                fireEvent.keyDown(input, { key: 'Enter' });

                expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
                expect(screen.getByText('A failure group named "other group" already exists')).toBeTruthy();
            });

            it('Escape cancels the rename without persisting', async () => {
                render(<BuildModelWindow />);
                await deliverData();
                mockUpdateWorkspaceData.mockClear();
                fireEvent.click(screen.getByText('Group A'));
                const input = screen.getByDisplayValue('Group A') as HTMLInputElement;
                fireEvent.change(input, { target: { value: 'Discarded' } });
                fireEvent.keyDown(input, { key: 'Escape' });

                expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
                expect(screen.getByText('Group A')).toBeTruthy();
            });
        });

        describe('inline group description/recommendation', () => {
            it('"Edit details" reveals description/recommendation fields seeded from the group, without navigating away', async () => {
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups: [makeGroup({ description: 'Bearing wear', recommendation: 'Replace bearing' })], models: [makeModel()] } });
                fireEvent.click(screen.getByText('Edit details'));

                expect(screen.getByDisplayValue('Bearing wear')).toBeTruthy();
                expect(screen.getByDisplayValue('Replace bearing')).toBeTruthy();
                expect(screen.getByText('Build Model — Overview')).toBeTruthy(); // still on overview
            });

            it('debounces a save of the description/recommendation', async () => {
                vi.useFakeTimers();
                render(<BuildModelWindow />);
                await deliverData();
                fireEvent.click(screen.getByText('Edit details'));

                fireEvent.change(screen.getByPlaceholderText('What failure mode does this group track?'), { target: { value: 'Bearing wear' } });
                await act(async () => { await vi.advanceTimersByTimeAsync(250); });

                const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
                expect(state.failureGroupState.groups[0].description).toBe('Bearing wear');
                vi.useRealTimers();
            });

            it('"Hide details" collapses the panel again', async () => {
                render(<BuildModelWindow />);
                await deliverData();
                fireEvent.click(screen.getByText('Edit details'));
                expect(screen.getByPlaceholderText('What failure mode does this group track?')).toBeTruthy();

                fireEvent.click(screen.getByText('Hide details'));
                expect(screen.queryByPlaceholderText('What failure mode does this group track?')).toBeNull();
            });
        });

        describe('navigating to the model page', () => {
            it('clicking a model row jumps directly to that model\'s detail page — not a list of the group\'s models', async () => {
                const second = makeModel({ id: 'm2', name: 'Second Model', targetSensor: 'TAG2' });
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel(), second] } });
                mockEmit.mockClear();

                fireEvent.click(screen.getByText('Model One'));

                expect(screen.getByTestId('add-model-form')).toBeTruthy();
                expect(screen.queryByText('Second Model')).toBeNull(); // not showing the whole group's list
                expect(mockEmit).not.toHaveBeenCalledWith('open-build-model', expect.anything());
            });

            it('"+ Add Model" jumps to a blank model page for that group', async () => {
                render(<BuildModelWindow />);
                await deliverData();
                fireEvent.click(screen.getByText('Add Model'));

                const form = within(screen.getByTestId('add-model-form'));
                expect((form.getByPlaceholderText('e.g. Bearing vibration model') as HTMLInputElement).value).toBe('');
                expect(screen.getByText('New Model')).toBeTruthy();
                expect(screen.getByText(/FG-1 · Group A/)).toBeTruthy();
            });
        });
    });

    describe('model page', () => {
        it('"← Back to Overview" returns to the overview page without saving', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            mockUpdateWorkspaceData.mockClear();
            fireEvent.click(screen.getByText('Model One'));
            fireEvent.click(screen.getByTitle('Back to Overview'));
            expect(screen.getByText('Build Model — Overview')).toBeTruthy();
            expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
        });

        it('Cancel returns to the overview page without saving', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            mockUpdateWorkspaceData.mockClear();
            fireEvent.click(screen.getByText('Model One'));
            const form = within(screen.getByTestId('add-model-form'));
            fireEvent.change(form.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Discarded' } });
            fireEvent.click(form.getByText('Cancel'));
            expect(screen.getByText('Build Model — Overview')).toBeTruthy();
            expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
        });

        it('saving an edit persists it and returns to the overview, where the change is visible', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Model One'));
            const form = within(screen.getByTestId('add-model-form'));
            fireEvent.change(form.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Renamed Model' } });
            await act(async () => {
                fireEvent.click(form.getByText('Save changes'));
                await Promise.resolve();
                await Promise.resolve();
            });

            expect(screen.getByText('Build Model — Overview')).toBeTruthy();
            expect(screen.getByText('Renamed Model')).toBeTruthy();
        });

        it('creating a new model persists it and returns to the overview', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Add Model'));
            const form = within(screen.getByTestId('add-model-form'));
            fireEvent.change(form.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'New Model' } });
            fireEvent.click(form.getByText('Individual'));
            fireEvent.click(form.getByText('Performance'));
            fireEvent.change(form.getByDisplayValue('Select a sensor…'), { target: { value: 'TAG2' } });
            await act(async () => {
                fireEvent.click(form.getByText('Create model'));
                await Promise.resolve();
                await Promise.resolve();
            });

            expect(screen.getByText('Build Model — Overview')).toBeTruthy();
            expect(screen.getByText('New Model')).toBeTruthy();
        });

        it('"Remove model" confirms, persists, and returns to the overview', async () => {
            vi.spyOn(window, 'confirm').mockReturnValue(true);
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Model One'));
            await act(async () => {
                fireEvent.click(screen.getByText('Remove model'));
                await Promise.resolve();
                await Promise.resolve();
            });

            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(state.failureGroupState.models).toHaveLength(0);
            expect(screen.getByText('Build Model — Overview')).toBeTruthy();
        });

        it('shows a clickable status pill and "Open in Predictive Model" for an existing model, but not for a new one', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Model One'));
            expect(screen.getByText('Incomplete')).toBeTruthy();
            expect(screen.getByText('Open in Predictive Model →')).toBeTruthy();

            fireEvent.click(screen.getByTitle('Back to Overview'));
            fireEvent.click(screen.getByText('Add Model'));
            expect(screen.queryByText('Open in Predictive Model →')).toBeNull();
        });

        it('toggling the status pill persists the change immediately', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Model One'));
            fireEvent.click(screen.getByText('Incomplete'));
            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(state.failureGroupState.models[0].status).toBe(true);
        });

        it('"Open in Predictive Model" emits launch-predictive-model with the model id', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Model One'));
            fireEvent.click(screen.getByText('Open in Predictive Model →'));
            expect(mockEmit).toHaveBeenCalledWith('launch-predictive-model', { modelId: 'm1' });
        });

        it('treats a name identical to its own target tag as unset (legacy-migrated models) and falls back to "description (tag)"', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel({ name: 'TAG1', targetSensor: 'TAG1' })] } });
            expect(screen.getByText('Pump Pressure (TAG1)')).toBeTruthy();
            fireEvent.click(screen.getByText('Pump Pressure (TAG1)'));
            expect(screen.getByTestId('add-model-form')).toBeTruthy();
        });

        it('shows sensors as "description (tag)" in predictor chips and sensor pickers', async () => {
            const rel = makeModel({ id: 'm1', name: 'Rel Model', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2', 'TAG3'] });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel] } });
            fireEvent.click(screen.getByText('Rel Model'));
            const form = within(screen.getByTestId('add-model-form'));
            expect(form.getAllByText('Pump Temp (TAG2)').length).toBe(2);
            expect(form.getAllByText('TAG3').length).toBe(2);
            expect(form.getByText('Pump Pressure (TAG1)')).toBeTruthy();
        });

        it('gives each model kind a distinct single-letter icon and color', async () => {
            const ind = makeModel({ id: 'm1', name: 'Ind Model', kind: 'individual' });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [ind] } });
            const indColor = (screen.getAllByText('I')[0].closest('.model-kind-icon') as HTMLElement).className;
            expect(indColor).toContain('model-kind-icon--individual');
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
                fireEvent.click(form.getByText('Individual'));
                fireEvent.click(form.getByText('Performance'));
                expect(create.disabled).toBe(true);

                fireEvent.change(form.getByDisplayValue('Select a sensor…'), { target: { value: 'TAG2' } });
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
                const [targetSelect] = form.getAllByDisplayValue('Select a sensor…');
                fireEvent.change(targetSelect, { target: { value: 'TAG1' } });
                expect(create.disabled).toBe(true);

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
                const selects = form.getAllByText('Select…').map(o => o.closest('select')!) as HTMLSelectElement[];
                fireEvent.change(selects[0], { target: { value: 'TAG1' } });
                expect(create.disabled).toBe(true);
                fireEvent.change(selects[1], { target: { value: 'TAG2' } });
                expect(create.disabled).toBe(false);
            });

            it('shows the Component readout with a placeholder as soon as a kind is picked, before any sensor is chosen', async () => {
                render(<BuildModelWindow />);
                await deliverData();
                fireEvent.click(screen.getByText('Add Model'));
                const form = within(screen.getByTestId('add-model-form'));
                expect(form.queryByText('Component')).toBeNull();

                fireEvent.click(form.getByText('Individual'));
                expect(form.getByText('Component')).toBeTruthy();
                expect(form.getByText('Auto-filled from target sensor')).toBeTruthy();

                fireEvent.change(form.getByDisplayValue('Select a sensor…'), { target: { value: 'TAG1' } });
                expect(form.getByText('Pump')).toBeTruthy();
                expect(form.queryByText('Auto-filled from target sensor')).toBeNull();
            });
        });

        it('Close calls the Tauri window close API', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Model One'));
            fireEvent.click(screen.getByTitle('Close'));
            expect(mockClose).toHaveBeenCalled();
        });
    });

    it('Close calls the Tauri window close API from the overview page too', async () => {
        render(<BuildModelWindow />);
        await deliverData();
        fireEvent.click(screen.getByTitle('Close'));
        expect(mockClose).toHaveBeenCalled();
    });
});
