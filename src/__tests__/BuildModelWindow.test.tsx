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

beforeEach(() => {
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
    it('requests build-model-data on mount', async () => {
        render(<BuildModelWindow />);
        await act(async () => { await Promise.resolve(); });
        expect(mockEmit).toHaveBeenCalledWith('request-build-model-data', undefined);
    });

    it('uses --card-bg for its background, matching the Dashboard\'s own Failure Groups card surface (not --bg-primary, the page canvas)', async () => {
        const { container } = render(<BuildModelWindow />);
        await deliverData();
        const root = container.firstElementChild as HTMLElement;
        expect(root.style.backgroundColor).toBe('var(--card-bg)');
    });

    it('the scrollable group list has minHeight: 0 (regression: without it, a tall expanded accordion form grows past the window instead of scrolling — the actual cause of the button row repeatedly looking cut off)', async () => {
        render(<BuildModelWindow />);
        await deliverData();
        const scrollRegion = screen.getByText('Group A').closest('[style*="overflow-y: auto"]') as HTMLElement;
        expect(scrollRegion).toBeTruthy();
        expect(scrollRegion.style.minHeight).toBe('0px');
    });

    it('shows the group, its FG-{no} badge, and its models once hydrated', async () => {
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
        expect(screen.getAllByText('Pump').length).toBeGreaterThan(0); // section header + each model's own component chip
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

    it('Close calls the Tauri window close API', async () => {
        render(<BuildModelWindow />);
        await deliverData();
        fireEvent.click(screen.getByTitle('Close'));
        expect(mockClose).toHaveBeenCalled();
    });

    describe('group "Edit details" (Name + Description + Recommendation together)', () => {
        it('the group name is plain text, not independently clickable-to-rename', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Group A'));
            // Clicking the bare name must NOT reveal a rename input on its own.
            expect(screen.queryByDisplayValue('Group A')).toBeNull();
        });

        it('"Edit details" reveals Name + Description + Recommendation together, seeded from the group', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup({ description: 'Bearing wear', recommendation: 'Replace bearing' })], models: [makeModel()] } });
            fireEvent.click(screen.getByText('Edit details'));

            expect(screen.getByDisplayValue('Group A')).toBeTruthy();
            expect(screen.getByDisplayValue('Bearing wear')).toBeTruthy();
            expect(screen.getByDisplayValue('Replace bearing')).toBeTruthy();
        });

        it('debounces a combined save of name/description/recommendation', async () => {
            vi.useFakeTimers();
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Edit details'));

            fireEvent.change(screen.getByDisplayValue('Group A'), { target: { value: 'Renamed Group' } });
            fireEvent.change(screen.getByPlaceholderText('What failure mode does this group track?'), { target: { value: 'Bearing wear' } });
            await act(async () => { await vi.advanceTimersByTimeAsync(250); });

            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(state.failureGroupState.groups[0].name).toBe('Renamed Group');
            expect(state.failureGroupState.groups[0].description).toBe('Bearing wear');
            vi.useRealTimers();
        });

        it('rejects renaming to a name already used by another group, with an inline error', async () => {
            vi.useFakeTimers();
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup(), makeGroup({ no: 2, name: 'Other Group' })], models: [makeModel()] } });
            mockUpdateWorkspaceData.mockClear();
            fireEvent.click(screen.getAllByText('Edit details')[0]);

            fireEvent.change(screen.getByDisplayValue('Group A'), { target: { value: 'other group' } });
            await act(async () => { await vi.advanceTimersByTimeAsync(250); });

            expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
            expect(screen.getByText('A failure group named "other group" already exists')).toBeTruthy();
            vi.useRealTimers();
        });

        it('"Hide details" collapses the panel', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Edit details'));
            expect(screen.getByPlaceholderText('What failure mode does this group track?')).toBeTruthy();

            fireEvent.click(screen.getByText('Hide details'));
            expect(screen.queryByPlaceholderText('What failure mode does this group track?')).toBeNull();
        });
    });

    describe('model accordion (inline, no page navigation)', () => {
        it('clicking a model row expands its edit form directly beneath it, without navigating away', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            mockEmit.mockClear();
            fireEvent.click(screen.getByText('Model One'));

            expect(screen.getByTestId('add-model-form')).toBeTruthy();
            expect(screen.getByText('Build Model — Overview')).toBeTruthy(); // still on the same page
            expect(mockEmit).not.toHaveBeenCalledWith('open-build-model', expect.anything());
        });

        it('clicking the same row again closes its form (toggle)', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Model One'));
            expect(screen.getByTestId('add-model-form')).toBeTruthy();

            fireEvent.click(screen.getByText('Model One'));
            expect(screen.queryByTestId('add-model-form')).toBeNull();
        });

        it('clicking a different row switches the form to the new row', async () => {
            const first = makeModel({ id: 'm1', name: 'First Model' });
            const second = makeModel({ id: 'm2', name: 'Second Model', targetSensor: 'TAG2' });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [first, second] } });

            fireEvent.click(screen.getByText('First Model'));
            expect((within(screen.getByTestId('add-model-form')).getByPlaceholderText('e.g. Bearing vibration model') as HTMLInputElement).value).toBe('First Model');

            fireEvent.click(screen.getByText('Second Model'));
            expect((within(screen.getByTestId('add-model-form')).getByPlaceholderText('e.g. Bearing vibration model') as HTMLInputElement).value).toBe('Second Model');
        });

        it('"+ Add Model" spans the full row width, not shrunk to its own content (regression: unlike the row divs above it, a bare button doesn\'t stretch by default, leaving its divider looking short/inconsistent)', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            const addBtn = screen.getByText('Add Model').closest('button') as HTMLButtonElement;
            expect(addBtn.style.width).toBe('100%');
        });

        it('"+ Add Model" opens a blank form under that group, closing any other open form', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Model One'));
            expect(screen.getByTestId('add-model-form')).toBeTruthy();

            fireEvent.click(screen.getByText('Add Model'));
            const form = within(screen.getByTestId('add-model-form'));
            expect((form.getByPlaceholderText('e.g. Bearing vibration model') as HTMLInputElement).value).toBe('');
        });

        it('has no separate Cancel button — re-clicking the row that opened it discards changes and closes the form', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            mockUpdateWorkspaceData.mockClear();
            fireEvent.click(screen.getByText('Model One'));
            expect(screen.queryByText('Cancel')).toBeNull();
            const form = within(screen.getByTestId('add-model-form'));
            fireEvent.change(form.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Discarded' } });
            fireEvent.click(screen.getByText('Model One'));
            expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
            expect(screen.queryByTestId('add-model-form')).toBeNull();
        });

        it('"+ Add Model" also toggles closed on a second click, discarding the blank form', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Add Model'));
            expect(screen.getByTestId('add-model-form')).toBeTruthy();
            fireEvent.click(screen.getByText('Add Model'));
            expect(screen.queryByTestId('add-model-form')).toBeNull();
        });

        it('Save/Create is a normal-sized button, not stretched full-width over Remove model (regression: .fg-build-model-btn\'s width:100% overlapping siblings)', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Model One'));
            const saveBtn = screen.getByText('Save changes').closest('button') as HTMLButtonElement;
            expect(saveBtn.style.width).not.toBe('100%');
            const removeBtn = screen.getByText('Remove model').closest('button') as HTMLButtonElement;
            expect(removeBtn.className).toContain('model-remove-btn');
        });

        it('saving an edit persists it and closes the form, showing the change immediately', async () => {
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

            expect(screen.queryByTestId('add-model-form')).toBeNull();
            expect(screen.getByText('Renamed Model')).toBeTruthy();
        });

        it('creating a new model via "+ Add Model" persists it against the right group', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup(), makeGroup({ no: 2, name: 'Group B' })], models: [makeModel()] } });
            const addButtons = screen.getAllByText('Add Model');
            fireEvent.click(addButtons[1]); // Group B's Add Model
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

            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            const created = state.failureGroupState.models.find((m: any) => m.name === 'New Model');
            expect(created.groupNo).toBe(2);
        });

        it('"Remove model" confirms, persists, and closes the form', async () => {
            vi.spyOn(window, 'confirm').mockReturnValue(true);
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Model One'));
            fireEvent.click(screen.getByText('Remove model'));
            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(state.failureGroupState.models).toHaveLength(0);
            expect(screen.queryByTestId('add-model-form')).toBeNull();
        });

        it('toggling the status pill persists the change without opening the form', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Incomplete'));
            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(state.failureGroupState.models[0].status).toBe(true);
            expect(screen.queryByTestId('add-model-form')).toBeNull();
        });

        it('"Open in Predictive Model" emits launch-predictive-model without opening the form', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Open in Predictive Model →'));
            expect(mockEmit).toHaveBeenCalledWith('launch-predictive-model', { modelId: 'm1' });
            expect(screen.queryByTestId('add-model-form')).toBeNull();
        });

        it('treats a name identical to its own target tag as unset (legacy-migrated models) and falls back to "description (tag)"', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel({ name: 'TAG1', targetSensor: 'TAG1' })] } });
            expect(screen.getByText('Pump Pressure (TAG1)')).toBeTruthy();
        });

        it('shows sensors as "description (tag)" in the summary line, predictor chips, and sensor pickers', async () => {
            const rel = makeModel({ id: 'm1', name: 'Rel Model', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2', 'TAG3'] });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel] } });
            expect(screen.getByText('Target: Pump Pressure (TAG1) · Predictors: Pump Temp (TAG2), TAG3')).toBeTruthy();

            fireEvent.click(screen.getByText('Rel Model'));
            const form = within(screen.getByTestId('add-model-form'));
            expect(form.getAllByText('Pump Temp (TAG2)').length).toBe(2);
            expect(form.getAllByText('TAG3').length).toBe(2);
            expect(form.getByText('Pump Pressure (TAG1)')).toBeTruthy();
        });

        it('gives each model kind a distinct single-letter icon and color', async () => {
            const ind = makeModel({ id: 'm1', name: 'Ind Model', kind: 'individual' });
            const rel = makeModel({ id: 'm2', name: 'Rel Model', kind: 'relationship', targetSensor: 'TAG2', predictorSensors: ['TAG3'] });
            const clu = makeModel({ id: 'm3', name: 'Clu Model', kind: 'clustering', targetSensor: '', xSensor: 'TAG2', ySensor: 'TAG3' });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [ind, rel, clu] } });

            const indColor = (screen.getByText('I').closest('.model-kind-icon') as HTMLElement).className;
            const relColor = (screen.getByText('R').closest('.model-kind-icon') as HTMLElement).className;
            const cluColor = (screen.getByText('C').closest('.model-kind-icon') as HTMLElement).className;
            expect(new Set([indColor, relColor, cluColor]).size).toBe(3);
        });

        describe('add model form validation', () => {
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
    });
});
