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

// PredictiveModelBuild is a large, heavy component with its own dedicated
// test file (PredictiveModelBuild.test.tsx) — stub it here so
// BuildModelWindow's tests only need to assert the page-navigation wiring
// (props passed in, onBack switching pages), not PM's own internals.
const predictiveModelBuildProps: any[] = [];
vi.mock('../components/windows/PredictiveModelBuild', () => ({
    default: (props: any) => {
        predictiveModelBuildProps.push(props);
        return (
            <div data-testid="pm-page-mock">
                <span>PM page for {props.modelId}</span>
                <button onClick={props.onBack}>Mock Back</button>
            </div>
        );
    },
}));

import BuildModelWindow from '../components/windows/BuildModelWindow';

function makeGroup(overrides: Record<string, any> = {}) {
    return { no: 1, name: 'Group A', isCollapsed: false, description: '', recommendation: '', ...overrides };
}

function makeModel(overrides: Record<string, any> = {}) {
    return {
        id: 'm1', groupNos: [1], name: 'Model One', kind: 'individual', category: 'performance', notes: '', status: false,
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
    predictiveModelBuildProps.length = 0;
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

        it('shows a "Failure groups" checkbox list inside the opened form, with the model\'s own group(s) pre-checked (2026-08-25: a model can belong to more than one group)', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup({ no: 2, name: 'Group B' })], models: [makeModel({ groupNos: [2] })] } });
            fireEvent.click(screen.getByText('Model One'));
            const checkbox = screen.getByText('FG-2 · Group B').closest('label')!.querySelector('input[type="checkbox"]') as HTMLInputElement;
            expect(checkbox.checked).toBe(true);
        });

        it('shows a static "Adding to" breadcrumb (not a checklist) inside a blank "+ Add Model" form, since the group is already fixed by which button opened it', async () => {
            // 2026-08-31: re-asking for the group here was redundant — it's
            // already fully determined by which group's own button
            // triggered the add flow. The checklist stays available only
            // when editing an existing model (see the test above).
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup({ no: 2, name: 'Group B' })], models: [] } });
            fireEvent.click(screen.getAllByText('Add Model')[0]);
            expect(screen.getByText('Adding to: FG-2 · Group B')).toBeTruthy();
            expect(screen.queryByText('Failure groups')).toBeNull();
            expect(screen.queryByRole('checkbox')).toBeNull();
        });

        it('shows a "no sensors yet" notice instead of the kind/target pickers when adding to a group with no sensors toggled into it', async () => {
            // 2026-08-31: Target/X/Y choices in add-mode come from sensors
            // already toggled into that group (Sensor tab) — an empty
            // group has nothing to build a model against yet.
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup({ no: 2, name: 'Group B' })], models: [] } });
            fireEvent.click(screen.getAllByText('Add Model')[0]);
            const form = within(screen.getByTestId('add-model-form'));
            expect(form.getByText(/no sensors yet/i)).toBeTruthy();
            expect(form.queryByText('Model kind')).toBeNull();
            expect(form.getByText('Create model').closest('button')).toHaveProperty('disabled', true);
        });

        it('auto-fills Target sensor when exactly one sensor is already in the group — no need to re-pick what was already chosen on the Sensor tab', async () => {
            // 2026-08-31: "ผมเลือก sensor เข้า FG ไปแล้ว แล้วทำไมตอนใส่
            // detail model ผมต้องมานั่งใส่ใหม่อีก ก็เป็น sensor เดิมสิ" —
            // confirmed via AskUserQuestion: applies to Individual's (and
            // Relationship's) Target only, only when the group has
            // exactly one candidate sensor.
            render(<BuildModelWindow />);
            await deliverData(); // Group A has exactly one sensor: TAG1 (the default seeded model)
            fireEvent.click(screen.getAllByText('Add Model')[0]);
            const form = within(screen.getByTestId('add-model-form'));
            fireEvent.click(form.getByText('Individual'));
            expect(form.getByDisplayValue('Pump Pressure (TAG1)')).toBeTruthy();
        });

        it('does NOT auto-fill Target when the group has more than one sensor — still requires an explicit pick', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel(), makeModel({ id: 'mem-1', targetSensor: 'TAG2', name: 'existing' })] } });
            fireEvent.click(screen.getAllByText('Add Model')[0]);
            const form = within(screen.getByTestId('add-model-form'));
            fireEvent.click(form.getByText('Individual'));
            expect(form.getByDisplayValue('Select a sensor…')).toBeTruthy();
        });

        it('does NOT auto-fill X/Y for Clustering even with exactly one sensor in the group', async () => {
            render(<BuildModelWindow />);
            await deliverData(); // Group A has exactly one sensor: TAG1
            fireEvent.click(screen.getAllByText('Add Model')[0]);
            const form = within(screen.getByTestId('add-model-form'));
            fireEvent.click(form.getByText('Clustering'));
            expect(form.getAllByDisplayValue('Select…')).toHaveLength(2); // X and Y both still blank
        });

        it('a model can be checked into more than one Failure Group at once', async () => {
            render(<BuildModelWindow />);
            await deliverData({
                failureGroupState: {
                    groups: [makeGroup({ no: 1, name: 'Group A' }), makeGroup({ no: 2, name: 'Group B' })],
                    models: [makeModel({ groupNos: [1] })],
                },
            });
            fireEvent.click(screen.getByText('Model One'));
            fireEvent.click(screen.getByText('FG-2 · Group B'));
            await act(async () => {
                fireEvent.click(screen.getByText('Save changes'));
                await Promise.resolve();
                await Promise.resolve();
            });
            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            const saved = state.failureGroupState.models.find((m: any) => m.id === 'm1');
            expect(saved.groupNos).toEqual(expect.arrayContaining([1, 2]));
            expect(saved.groupNos).toHaveLength(2);
        });

        it('the Save changes / Remove model footer sits structurally outside the bounded, independently-scrollable fields box (regression: a tall form previously had no reliable, always-visible place for its own buttons, requiring exactly the right page scroll position to reach them)', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Model One'));

            const fields = screen.getByTestId('add-model-form-fields');
            expect(fields.style.maxHeight).toBeTruthy();
            expect(fields.style.overflowY).toBe('auto');
            expect(within(fields).queryByText('Save changes')).toBeNull(); // footer isn't nested inside the scrollable fields box
            expect(screen.getByText('Save changes')).toBeTruthy(); // but it's still rendered, right alongside it
        });

        it('the footer is sticky to the viewport bottom, not just structurally present (regression: a form deep in a long list, or with a fields box near its own max-height, could still place the footer below the visible area with the fields box alone not being enough)', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Model One'));

            const saveBtn = screen.getByText('Save changes').closest('button') as HTMLButtonElement;
            const footer = saveBtn.parentElement as HTMLElement;
            expect(footer.style.position).toBe('sticky');
            expect(footer.style.bottom).toBe('0px');
        });

        it('no group card in either grouping view clips its content with overflow:hidden (regression: that broke the footer\'s sticky positioning entirely)', async () => {
            const { container } = render(<BuildModelWindow />);
            await deliverData();
            const cards = container.querySelectorAll('[style*="border-radius: 10px"]');
            expect(cards.length).toBeGreaterThan(0);
            cards.forEach(card => {
                expect((card as HTMLElement).style.overflow).not.toBe('hidden');
            });
        });

        it('the opened form\'s boundary is a real border wrapping the whole card (header + footer), not just a left accent bar (regression: an absolutely-positioned bar was anchored to the row\'s un-scrolled flow position and visually detached from the sticky footer once the page scrolled)', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Model One'));

            const saveBtn = screen.getByText('Save changes');
            let boundary: HTMLElement | null = screen.getByText('Model One').parentElement;
            while (boundary && !boundary.style.border) boundary = boundary.parentElement;
            expect(boundary).not.toBeNull();
            expect(boundary!.contains(saveBtn)).toBe(true);
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
            const addBtn = screen.getAllByText('Add Model')[0].closest('button') as HTMLButtonElement;
            expect(addBtn.style.width).toBe('100%');
        });

        it('"+ Add Model" opens a blank form under that group, closing any other open form', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Model One'));
            expect(screen.getByTestId('add-model-form')).toBeTruthy();

            fireEvent.click(screen.getAllByText('Add Model')[0]);
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
            fireEvent.click(screen.getAllByText('Add Model')[0]);
            expect(screen.getByTestId('add-model-form')).toBeTruthy();
            fireEvent.click(screen.getAllByText('Add Model')[0]);
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
            // 2026-08-31: Target/X/Y choices in add-mode are limited to
            // sensors already in the destination group — seed Group B with
            // TAG2 (via an existing individual model) so it's pickable.
            // Since it's the ONLY sensor in Group B, it also gets
            // auto-filled as Target the moment the form opens — no manual
            // selection needed.
            await deliverData({ failureGroupState: { groups: [makeGroup(), makeGroup({ no: 2, name: 'Group B' })], models: [makeModel(), makeModel({ id: 'mem-2', groupNos: [2], targetSensor: 'TAG2', name: 'existing' })] } });
            const addButtons = screen.getAllByText('Add Model');
            fireEvent.click(addButtons[1]); // Group B's Add Model
            const form = within(screen.getByTestId('add-model-form'));
            fireEvent.change(form.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'New Model' } });
            fireEvent.click(form.getByText('Individual'));
            fireEvent.click(form.getByText('Performance'));
            await act(async () => {
                fireEvent.click(form.getByText('Create model'));
                await Promise.resolve();
                await Promise.resolve();
            });

            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            const created = state.failureGroupState.models.find((m: any) => m.name === 'New Model');
            expect(created.groupNos).toEqual([2]);
        });

        describe('"Not in Group" (FG-0) — a model without a failure group', () => {
            it('is always shown in the FG-grouped view, even with zero real groups and zero ungrouped models', async () => {
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups: [], models: [] } });
                expect(screen.getByText('Not in Group')).toBeTruthy();
                expect(screen.getAllByText('No models yet')).toHaveLength(1);
            });

            it('has no "Edit details"/rename/delete controls — it is a permanent, non-editable bucket', async () => {
                render(<BuildModelWindow />);
                await deliverData();
                expect(screen.getAllByText('Edit details')).toHaveLength(1); // only the one real group
            });

            it('does not count toward the "groups" stat in the header', async () => {
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups: [], models: [makeModel({ groupNos: [0] })] } });
                expect(screen.getByText('0')).toBeTruthy(); // groups stat
            });

            it('lists a model whose groupNo is 0', async () => {
                render(<BuildModelWindow />);
                await deliverData({
                    failureGroupState: {
                        groups: [makeGroup()],
                        models: [makeModel({ id: 'm-ng', name: 'Orphan Model', groupNos: [0] })],
                    },
                });
                expect(screen.getByText('Orphan Model')).toBeTruthy();
            });

            it('creating a model via its own "+ Add Model" persists groupNo 0', async () => {
                render(<BuildModelWindow />);
                // 2026-08-31: seed TAG1 as already "not in group" (groupNos
                // [0]) so it's pickable from the add-mode sensor picker.
                await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel({ id: 'mem-0', groupNos: [0], targetSensor: 'TAG1', name: 'existing' })] } });
                const addButtons = screen.getAllByText('Add Model');
                fireEvent.click(addButtons[addButtons.length - 1]); // "Not in Group" is rendered last
                const form = within(screen.getByTestId('add-model-form'));
                fireEvent.change(form.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Standalone Model' } });
                fireEvent.click(form.getByText('Individual'));
                fireEvent.click(form.getByText('Performance'));
                fireEvent.change(form.getByDisplayValue('Select a sensor…'), { target: { value: 'TAG1' } });
                await act(async () => {
                    fireEvent.click(form.getByText('Create model'));
                    await Promise.resolve();
                    await Promise.resolve();
                });

                const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
                const created = state.failureGroupState.models.find((m: any) => m.name === 'Standalone Model');
                expect(created.groupNos).toEqual([0]);
            });

            it('"Not in Group" is exempt from the sensor restriction — offers every sensor, never shows the "no sensors yet" notice, even with zero models seeded there', async () => {
                // 2026-08-31: reported by the user right after testing —
                // "Not in Group" has no "toggle sensor in first" step like
                // a real group (via the Sensor tab), so restricting its
                // add-mode picker the same way just blocked every add.
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups: [makeGroup()], models: [] } });
                const addButtons = screen.getAllByText('Add Model');
                fireEvent.click(addButtons[addButtons.length - 1]); // "Not in Group" is rendered last
                const form = within(screen.getByTestId('add-model-form'));
                expect(form.queryByText(/no sensors yet/i)).toBeNull();
                fireEvent.click(form.getByText('Individual'));
                const select = form.getByDisplayValue('Select a sensor…') as HTMLSelectElement;
                expect(Array.from(select.options).map(o => o.value)).toEqual(expect.arrayContaining(['TAG1', 'TAG2', 'TAG3']));
            });
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

        it('"Build Model" navigates to the in-window Predictive Model page instead of opening a new window', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Build Model →'));
            // No cross-window event — this is now local page-navigation state.
            expect(mockEmit).not.toHaveBeenCalledWith('launch-predictive-model', expect.anything());
            expect(screen.getByTestId('pm-page-mock')).toBeTruthy();
            expect(screen.getByText('PM page for m1')).toBeTruthy();
            const lastProps = predictiveModelBuildProps[predictiveModelBuildProps.length - 1];
            expect(lastProps.workspaceId).toBe('ws1');
            expect(lastProps.modelId).toBe('m1');
            expect(lastProps.kind).toBe('individual'); // the model's own kind, chosen on this page — PM must not ask again
            expect(lastProps.sensorHeaders).toEqual(['TAG1', 'TAG2', 'TAG3']);
        });

        it('the PM page\'s Back control returns to the model overview', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Build Model →'));
            expect(screen.getByTestId('pm-page-mock')).toBeTruthy();
            fireEvent.click(screen.getByText('Mock Back'));
            expect(screen.queryByTestId('pm-page-mock')).toBeNull();
            expect(screen.getByText('Build Model →')).toBeTruthy();
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
                // 2026-08-31: seed TAG2 as already in Group A so it's
                // pickable from the add-mode Target sensor picker.
                await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel(), makeModel({ id: 'mem-1', targetSensor: 'TAG2', name: 'existing' })] } });
                fireEvent.click(screen.getAllByText('Add Model')[0]);
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
                fireEvent.click(screen.getAllByText('Add Model')[0]);
                const form = within(screen.getByTestId('add-model-form'));
                fireEvent.change(form.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Rel Model' } });
                fireEvent.click(form.getByText('Relationship'));
                fireEvent.click(form.getByText('Condition'));

                // 2026-08-31: Target sensor is already auto-filled — Group
                // A has exactly one sensor (TAG1, from the default seeded
                // model), so there's nothing left to pick there. Only the
                // predictor is still required.
                const create = form.getByText('Create model').closest('button') as HTMLButtonElement;
                expect(create.disabled).toBe(true);

                fireEvent.change(form.getByDisplayValue('Add a predictor…'), { target: { value: 'TAG2' } });
                expect(create.disabled).toBe(false);
            });

            it('requires both X and Y sensors for a clustering model', async () => {
                render(<BuildModelWindow />);
                // 2026-08-31: seed TAG2 as already in Group A (TAG1 already
                // is, via the default model) so both are pickable from the
                // add-mode X/Y sensor pickers.
                await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel(), makeModel({ id: 'mem-1', targetSensor: 'TAG2', name: 'existing' })] } });
                fireEvent.click(screen.getAllByText('Add Model')[0]);
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

            it('the "Model kind" picker\'s active color matches that kind\'s own row badge color (not one flat color for all three)', async () => {
                render(<BuildModelWindow />);
                await deliverData();
                fireEvent.click(screen.getAllByText('Add Model')[0]);
                const form = within(screen.getByTestId('add-model-form'));
                const individualBtn = form.getByText('Individual').closest('button') as HTMLButtonElement;
                const relBtn = form.getByText('Relationship').closest('button') as HTMLButtonElement;
                const clusterBtn = form.getByText('Clustering').closest('button') as HTMLButtonElement;

                fireEvent.click(individualBtn);
                // Matches .model-kind-icon--individual.
                expect(individualBtn.style.color).toBe('var(--accent-color)');

                fireEvent.click(relBtn);
                // Matches .model-kind-icon--relationship, not the flat accent color.
                expect(relBtn.style.color).toBe('var(--warn)');
                expect(individualBtn.style.color).toBe('var(--text-secondary)');

                fireEvent.click(clusterBtn);
                // Matches .model-kind-icon--clustering.
                expect(clusterBtn.style.color).toBe('var(--kind-clu)');
                expect(relBtn.style.color).toBe('var(--text-secondary)');
            });

            it('shows the Component readout with a placeholder as soon as a kind is picked, before any sensor is chosen', async () => {
                render(<BuildModelWindow />);
                // 2026-08-31: needs 2+ sensors already in the group, or
                // Target auto-fills immediately and there's no "before any
                // sensor is chosen" moment left to observe.
                await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel(), makeModel({ id: 'mem-1', targetSensor: 'TAG2', name: 'existing' })] } });
                fireEvent.click(screen.getAllByText('Add Model')[0]);
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
