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
const sensorAutocompleteProps: any[] = [];
vi.mock('../components/windows/PredictiveModelBuild', () => ({
    default: (props: any) => {
        predictiveModelBuildProps.push(props);
        return (
            <div data-testid="pm-page-mock">
                <span>PM page for {props.modelId}</span>
                <button onClick={props.onBack}>Mock Back</button>
                <button onClick={props.onFinish}>Mock Finish</button>
            </div>
        );
    },
    // Minimal stand-in for the real searchable picker (its own search/
    // component-grouping tests live in PredictiveModelBuild.test.tsx,
    // against the real implementation) — just enough to let this page's
    // wiring around it (which props reach which instance) be asserted.
    SensorAutocomplete: (props: any) => {
        sensorAutocompleteProps.push(props);
        return (
            <input
                placeholder={props.placeholder}
                value={props.value}
                onChange={e => props.onSelect(e.target.value)}
            />
        );
    },
}));

import BuildModelWindow from '../components/windows/BuildModelWindow';

function makeGroup(overrides: Record<string, any> = {}) {
    return { no: 1, name: 'Group A', description: '', recommendation: '', ...overrides };
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
    sensorAutocompleteProps.length = 0;
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

    describe('grouping by Model Type (I/R/C)', () => {
        it('shows a section per kind actually present, in fixed Individual/Relationship/Clustering order regardless of creation order, and only per row (not the section) shows the FG chip', async () => {
            // Deliberately created out of order (C, then I, then R) to prove
            // the section order is fixed, not insertion or alphabetical.
            const clu = makeModel({ id: 'm1', name: 'Clu Model', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2' });
            const ind = makeModel({ id: 'm2', name: 'Ind Model', kind: 'individual', targetSensor: 'TAG1' });
            const rel = makeModel({ id: 'm3', name: 'Rel Model', kind: 'relationship', targetSensor: 'TAG2', predictorSensors: ['TAG1'] });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [clu, ind, rel] } });
            expect(screen.queryByText(/FG-1 · Group A/)).toBeNull();

            fireEvent.click(screen.getByText('Group by Model Type'));

            const headings = screen.getAllByText(/^(Individual|Relationship|Clustering)$/).map(el => el.textContent);
            expect(headings).toEqual(['Individual', 'Relationship', 'Clustering']);
            expect(screen.getByText('Ind Model')).toBeTruthy();
            expect(screen.getByText('Rel Model')).toBeTruthy();
            expect(screen.getByText('Clu Model')).toBeTruthy();
            // One FG chip per model row, same convention Component view uses.
            expect(screen.getAllByText(/FG-1 · Group A/).length).toBe(3);
        });

        it('only shows sections for kinds that actually have a model', async () => {
            render(<BuildModelWindow />);
            await deliverData({
                failureGroupState: {
                    groups: [makeGroup()],
                    models: [makeModel({ id: 'm1', name: 'Ind Model', kind: 'individual' })],
                },
            });
            fireEvent.click(screen.getByText('Group by Model Type'));
            expect(screen.getByText('Individual')).toBeTruthy();
            expect(screen.queryByText('Relationship')).toBeNull();
            expect(screen.queryByText('Clustering')).toBeNull();
        });
    });

    it('stays in sync with a failure-group-state-changed broadcast from another window', async () => {
        render(<BuildModelWindow />);
        await deliverData();
        expect(screen.queryByText('New Model')).toBeNull();

        await act(async () => {
            for (const cb of listenCallbacks['failure-group-state-changed'] ?? []) {
                cb({ payload: { workspaceId: 'ws1', origin: 'dashboard', groups: [makeGroup()], models: [makeModel({ id: 'm2', name: 'New Model' })] } });
            }
        });
        expect(screen.getByText('New Model')).toBeTruthy();
    });

    // 2026-09-21: multi-project isolation. This window is a singleton that
    // fetches its data once; with a second project loaded in `main` it could
    // be left showing (or being fed) the previous project's data.
    describe('multi-project isolation', () => {
        async function fire(event: string, payload: any) {
            await act(async () => {
                for (const cb of listenCallbacks[event] ?? []) cb({ payload });
                await Promise.resolve();
                await Promise.resolve();
            });
        }

        it('ignores a failure-group-state-changed broadcast about another project, or one with no workspace id', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            await fire('failure-group-state-changed', {
                workspaceId: 'some-other-workspace', origin: 'dashboard',
                groups: [makeGroup()], models: [makeModel({ id: 'x', name: 'Foreign Model' })],
            });
            await fire('failure-group-state-changed', {
                groups: [makeGroup()], models: [makeModel({ id: 'y', name: 'Unscoped Model' })],
            });
            expect(screen.queryByText('Foreign Model')).toBeNull();
            expect(screen.queryByText('Unscoped Model')).toBeNull();
            expect(screen.getByText('Model One')).toBeTruthy();
        });

        it('skips its own echo but still applies the Predictive Model page\'s broadcast (that page lives inside this window)', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            await fire('failure-group-state-changed', {
                workspaceId: 'ws1', origin: 'build-model',
                groups: [makeGroup()], models: [makeModel({ id: 'e', name: 'Echoed Model' })],
            });
            expect(screen.queryByText('Echoed Model')).toBeNull();
            await fire('failure-group-state-changed', {
                workspaceId: 'ws1', origin: 'predictive-model',
                groups: [makeGroup()], models: [makeModel({ id: 'p', name: 'PM Edit' })],
            });
            expect(screen.getByText('PM Edit')).toBeTruthy();
        });

        it('stamps every failure-group broadcast it sends with its workspace id', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Incomplete')); // toggles the status pill -> persist()
            await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
            expect(mockEmit).toHaveBeenCalledWith('failure-group-state-changed', expect.objectContaining({
                workspaceId: 'ws1',
                origin: 'build-model',
            }));
        });

        it('being re-pointed at a DIFFERENT workspace drops the old one\'s open PM page and shows only the new workspace\'s models', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Model One'));
            await act(async () => { fireEvent.click(screen.getByText('Build Model →')); });
            expect(screen.getByTestId('pm-page-mock')).toBeTruthy();

            mockLoadWorkspaceData.mockResolvedValue({
                id: 'ws2',
                failureGroupState: { groups: [makeGroup({ no: 1, name: 'Other Group' })], models: [makeModel({ id: 'other', name: 'Other Project Model' })] },
            });
            await fire('build-model-data', {
                workspaceId: 'ws2',
                sensorHeaders: ['OTHER1'],
                sensorMetadata: [],
                metadata: { headers: ['timestamp', 'OTHER1'], total_rows: 1 },
            });

            expect(screen.queryByTestId('pm-page-mock')).toBeNull(); // model 'm1' does not exist in ws2
            expect(screen.getByText('Other Project Model')).toBeTruthy();
            expect(screen.queryByText('Model One')).toBeNull();
        });

        it('re-delivery for the SAME workspace keeps the open PM page', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Model One'));
            await act(async () => { fireEvent.click(screen.getByText('Build Model →')); });
            await deliverData();
            expect(screen.getByTestId('pm-page-mock')).toBeTruthy();
        });

        it('a slow, superseded load cannot overwrite the result of a newer one (several build-model-data replies used to race and the last to finish won)', async () => {
            render(<BuildModelWindow />);
            let resolveFirst!: (v: any) => void;
            mockLoadWorkspaceData.mockReturnValueOnce(new Promise(res => { resolveFirst = res; }));
            mockLoadWorkspaceData.mockResolvedValueOnce({
                id: 'ws1',
                failureGroupState: { groups: [makeGroup()], models: [makeModel({ id: 'new', name: 'Fresh Model' })] },
            });
            const payload = {
                workspaceId: 'ws1', sensorHeaders: ['TAG1'], sensorMetadata: [],
                metadata: { headers: ['timestamp', 'TAG1'], total_rows: 1 },
            };
            await fire('build-model-data', payload); // first reply: its load stays pending
            await fire('build-model-data', payload); // second reply: resolves immediately
            expect(screen.getByText('Fresh Model')).toBeTruthy();

            await act(async () => {
                resolveFirst({ id: 'ws1', failureGroupState: { groups: [makeGroup()], models: [makeModel({ id: 'old', name: 'Stale Model' })] } });
                await Promise.resolve();
                await Promise.resolve();
            });
            expect(screen.queryByText('Stale Model')).toBeNull();
            expect(screen.getByText('Fresh Model')).toBeTruthy();
        });
    });

    it('Close calls the Tauri window close API', async () => {
        render(<BuildModelWindow />);
        await deliverData();
        fireEvent.click(screen.getByTitle('Close'));
        expect(mockClose).toHaveBeenCalled();
    });

    describe('group cards are read-only headers (2026-08-31: "Edit details" — Name/Description/Recommendation — moved to Dashboard\'s Failure Groups tab entirely, per explicit user request)', () => {
        it('the group name is plain text, not clickable-to-rename, and there is no "Edit details" control anywhere', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Group A'));
            // Clicking the bare name must NOT reveal a rename input.
            expect(screen.queryByDisplayValue('Group A')).toBeNull();
            expect(screen.queryByText('Edit details')).toBeNull();
            expect(screen.queryByText('Hide details')).toBeNull();
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

        it('shows the model\'s Failure Group membership as a read-only chip list, no checkboxes (2026-09-01: editing group membership moved to the Sensor tab entirely — "ไม่ควรแก้ FG ได้ในหน้านี้ ดูได้อย่างเดียว")', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup({ no: 2, name: 'Group B' })], models: [makeModel({ groupNos: [2] })] } });
            fireEvent.click(screen.getByText('Model One'));
            const form = within(screen.getByTestId('add-model-form'));
            expect(form.getByText('FG-2 · Group B')).toBeTruthy();
            expect(form.queryByRole('checkbox')).toBeNull();
        });

        it('only lists the model\'s current Failure Groups — a group it does not belong to is neither shown nor selectable here (regression against the old checkbox list, which offered every group)', async () => {
            render(<BuildModelWindow />);
            await deliverData({
                failureGroupState: {
                    groups: [makeGroup({ no: 1, name: 'Group A' }), makeGroup({ no: 2, name: 'Group B' })],
                    models: [makeModel({ groupNos: [1] })],
                },
            });
            fireEvent.click(screen.getByText('Model One'));
            const form = within(screen.getByTestId('add-model-form'));
            expect(form.getByText('FG-1 · Group A')).toBeTruthy();
            expect(form.queryByText('FG-2 · Group B')).toBeNull();

            await act(async () => {
                fireEvent.click(screen.getByText('Save changes'));
                await Promise.resolve();
                await Promise.resolve();
            });
            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            const saved = state.failureGroupState.models.find((m: any) => m.id === 'm1');
            expect(saved.groupNos).toEqual([1]); // unchanged
        });

        it('the Save changes footer sits structurally outside the bounded, independently-scrollable fields box (regression: a tall form previously had no reliable, always-visible place for its own button, requiring exactly the right page scroll position to reach it)', async () => {
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

        it('the sticky footer\'s own bottom corners are rounded to match the editing card\'s border-radius (regression: no overflow:hidden on the card -- the previous item -- means the footer\'s flat, opaque (--card-bg) background paints straight over the card\'s rounded bottom corners once it settles at the bottom of the scroll, reading as the accent border simply not connecting there; reported 2026-09-17)', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Model One'));
            const saveBtn = screen.getByText('Save changes').closest('button') as HTMLButtonElement;
            const footer = saveBtn.parentElement as HTMLElement;
            expect(footer.style.borderBottomLeftRadius).toBe('10px');
            expect(footer.style.borderBottomRightRadius).toBe('10px');
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

        it('shows no "Add Model" button anywhere (2026-08-31: removed per explicit user request — toggling a sensor into a group, Sensor tab, is now the sole way a model comes into existence)', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            expect(screen.queryByText('Add Model')).toBeNull();
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

        it('Save changes is a normal-sized button, not stretched full-width (regression: .fg-build-model-btn\'s width:100% default)', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Model One'));
            const saveBtn = screen.getByText('Save changes').closest('button') as HTMLButtonElement;
            expect(saveBtn.style.width).not.toBe('100%');
        });

        it('shows no "Remove model" button anywhere (2026-08-31: removed per explicit user request — model deletion moved to Dashboard\'s Failure Groups tab; Build Model only edits/trains)', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Model One'));
            expect(screen.queryByText('Remove model')).toBeNull();
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

        describe('"Not in Group" (FG-0) — a model without a failure group', () => {
            it('is always shown in the FG-grouped view, even with zero real groups and zero ungrouped models', async () => {
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups: [], models: [] } });
                expect(screen.getByText('Not in Group')).toBeTruthy();
                expect(screen.getAllByText('No models yet')).toHaveLength(1);
            });

            it('has no rename/delete controls — it is a permanent, non-editable bucket (2026-08-31: no group has "Edit details" here anymore anyway — see the read-only-headers test above)', async () => {
                render(<BuildModelWindow />);
                await deliverData();
                expect(screen.queryByText('Edit details')).toBeNull();
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

        });

        it('toggling the status pill persists the change without opening the form', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Incomplete'));
            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(state.failureGroupState.models[0].status).toBe(true);
            expect(screen.queryByTestId('add-model-form')).toBeNull();
        });

        // 2026-09-09: "Build Model →" moved from the (always-visible) row
        // header into the edit form's footer, right after Save changes, and
        // is disabled until the form is valid — training an incomplete
        // model didn't make sense. Only reachable by opening the row first.
        it('"Build Model" navigates to the in-window Predictive Model page instead of opening a new window', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Model One')); // open the row — makeModel() is already complete
            await act(async () => { fireEvent.click(screen.getByText('Build Model →')); });
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

        it('waits for commitForm\'s persist to actually land before navigating to the PM page (2026-09-18 regression: the write used to be fire-and-forget, so the PM page could hydrate from the model record from BEFORE this commit -- e.g. predictors just picked on this form, required for Relationship, showing as "No predictors selected" the instant the page opened)', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Model One'));

            let resolvePersist!: (v: unknown) => void;
            mockUpdateWorkspaceData.mockImplementation(() => new Promise(resolve => { resolvePersist = resolve; }));

            fireEvent.click(screen.getByText('Build Model →'));
            // The persist() write hasn't resolved yet -- navigation must not
            // have happened either, or the PM page could read the workspace
            // file before this commit lands.
            expect(screen.queryByTestId('pm-page-mock')).toBeNull();

            await act(async () => {
                resolvePersist({ id: 'ws1', failureGroupState: { groups: [makeGroup()], models: [makeModel()] } });
                await Promise.resolve();
            });
            expect(screen.getByTestId('pm-page-mock')).toBeTruthy();
        });

        it('is disabled until the form is valid, and shows why', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel({ name: '' })] } });
            fireEvent.click(screen.getByText('Pump Pressure (TAG1)')); // falls back to the sensor label since name is blank -- still opens the row
            const buildBtn = screen.getByText('Build Model →') as HTMLButtonElement;
            expect(buildBtn.disabled).toBe(true);
            expect(buildBtn.title).toMatch(/Fill in the required fields/);

            fireEvent.click(buildBtn);
            expect(screen.queryByTestId('pm-page-mock')).toBeNull(); // disabled click is a no-op

            fireEvent.change(screen.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Now named' } });
            expect((screen.getByText('Build Model →') as HTMLButtonElement).disabled).toBe(false);
        });

        it('saves any unsaved draft edits before navigating, so training never silently uses stale values', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Model One'));
            fireEvent.change(screen.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Renamed before building' } });

            await act(async () => { fireEvent.click(screen.getByText('Build Model →')); });

            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(state.failureGroupState.models[0].name).toBe('Renamed before building');
            expect(screen.getByTestId('pm-page-mock')).toBeTruthy();
        });

        it('the PM page\'s Back control returns to the model overview', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Model One'));
            await act(async () => { fireEvent.click(screen.getByText('Build Model →')); });
            expect(screen.getByTestId('pm-page-mock')).toBeTruthy();
            fireEvent.click(screen.getByText('Mock Back'));
            expect(screen.queryByTestId('pm-page-mock')).toBeNull();
            expect(screen.queryByText('Build Model →')).toBeNull(); // the row's editor closed along with the old model reference
        });

        it('the PM page\'s Finish control marks the model Complete and returns to the model overview', async () => {
            render(<BuildModelWindow />);
            await deliverData(); // makeModel() defaults to status: false (Incomplete)
            fireEvent.click(screen.getByText('Model One'));
            await act(async () => { fireEvent.click(screen.getByText('Build Model →')); });
            expect(screen.getByTestId('pm-page-mock')).toBeTruthy();

            fireEvent.click(screen.getByText('Mock Finish'));

            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(state.failureGroupState.models[0].status).toBe(true);
            expect(screen.queryByTestId('pm-page-mock')).toBeNull(); // Finish also navigates back, like Back
        });

        it('Finish never flips an already-complete model back to Incomplete (one-directional, unlike the overview\'s toggle pill)', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel({ status: true })] } });
            fireEvent.click(screen.getByText('Model One'));
            await act(async () => { fireEvent.click(screen.getByText('Build Model →')); });

            fireEvent.click(screen.getByText('Mock Finish'));

            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(state.failureGroupState.models[0].status).toBe(true);
        });

        it('treats a name identical to its own target tag as unset (legacy-migrated models) and falls back to "description (tag)"', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel({ name: 'TAG1', targetSensor: 'TAG1' })] } });
            expect(screen.getByText('Pump Pressure (TAG1)')).toBeTruthy();
        });

        it('shows sensors as "description (tag)" in the summary line, predictor chips, and the locked Target readout', async () => {
            const rel = makeModel({ id: 'm1', name: 'Rel Model', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2', 'TAG3'] });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel] } });
            expect(screen.getByText('Target: Pump Pressure (TAG1) · Predictors: Pump Temp (TAG2), TAG3')).toBeTruthy();

            fireEvent.click(screen.getByText('Rel Model'));
            const form = within(screen.getByTestId('add-model-form'));
            // 2026-09-01: Target sensor is now a locked readout, not a select
            // offering every sensor as an option — so each predictor's label
            // only appears once now (the chip), not twice (chip + the
            // Target select's own unrelated option list).
            expect(form.getAllByText('Pump Temp (TAG2)').length).toBe(1);
            expect(form.getAllByText('TAG3').length).toBe(1);
            expect(form.getByText('Pump Pressure (TAG1)', { selector: '.model-component-readout' })).toBeTruthy(); // locked Target readout
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

        describe('edit form validation (2026-08-31: adapted from the removed "add model" flow — there is no add anymore, only editing an existing model)', () => {
            it('Save changes is disabled once the name is cleared, re-enabled once restored', async () => {
                render(<BuildModelWindow />);
                await deliverData();
                fireEvent.click(screen.getByText('Model One'));
                const form = within(screen.getByTestId('add-model-form'));

                const save = form.getByText('Save changes').closest('button') as HTMLButtonElement;
                expect(save.disabled).toBe(false); // Model One starts fully valid

                fireEvent.change(form.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: '' } });
                expect(save.disabled).toBe(true);

                fireEvent.change(form.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Model One' } });
                expect(save.disabled).toBe(false);
            });

            it('an existing Relationship model with no predictors keeps Save disabled until at least one is added', async () => {
                const rel = makeModel({ id: 'm2', name: 'Rel Model', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: [] });
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel] } });
                fireEvent.click(screen.getByText('Rel Model'));
                const form = within(screen.getByTestId('add-model-form'));

                const save = form.getByText('Save changes').closest('button') as HTMLButtonElement;
                expect(save.disabled).toBe(true); // no predictor yet

                fireEvent.change(form.getByPlaceholderText('Search sensor tag or description…'), { target: { value: 'TAG2' } });
                fireEvent.click(form.getByText('Pump Temp (TAG2)'));
                expect(save.disabled).toBe(false);
            });

            it('an existing Clustering model with no Y sensor keeps Save disabled until Y is filled in (X stays locked)', async () => {
                const clu = makeModel({ id: 'm3', name: 'Clu Model', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: '' });
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups: [makeGroup()], models: [clu] } });
                fireEvent.click(screen.getByText('Clu Model'));
                const form = within(screen.getByTestId('add-model-form'));

                const save = form.getByText('Save changes').closest('button') as HTMLButtonElement;
                expect(save.disabled).toBe(true); // Y still unset
                expect(form.getByText('Pump Pressure (TAG1)', { selector: '.model-component-readout' })).toBeTruthy(); // locked X readout

                const yy = form.getByText('Select…').closest('select') as HTMLSelectElement;
                fireEvent.change(yy, { target: { value: 'TAG2' } });
                expect(save.disabled).toBe(false);
            });

            it('shows no "Model kind" picker anywhere — a model\'s kind is decided once, on the Sensor tab, and can\'t be switched here anymore (2026-09-01, per explicit user request: "ลบการเปลี่ยน model kind ออก เพราะว่าเราเลือก model kind ที่หน้า dashboard แล้ว")', async () => {
                render(<BuildModelWindow />);
                await deliverData();
                fireEvent.click(screen.getByText('Model One'));
                const form = within(screen.getByTestId('add-model-form'));
                expect(form.queryByText('Model kind')).toBeNull();
                expect(form.queryByText('Individual')).toBeNull();
                expect(form.queryByText('Relationship')).toBeNull();
                expect(form.queryByText('Clustering')).toBeNull();
            });

        });

        describe('locked auto-fill sensor (2026-09-01: Target/X can no longer be changed after the model is created, per explicit user request — "ต้องล็อคไว้ห้าม user เปลี่ยน ... human error")', () => {
            it('Individual\'s Target sensor is a read-only readout, not a select — the raw tag can\'t be reassigned', async () => {
                render(<BuildModelWindow />);
                await deliverData();
                fireEvent.click(screen.getByText('Model One'));
                const form = within(screen.getByTestId('add-model-form'));
                expect(form.getByText('Pump Pressure (TAG1)')).toBeTruthy();
                expect(form.getByText('Pump Pressure (TAG1)').closest('select')).toBeNull();
            });

            it('Relationship\'s Target sensor is locked too, but its Predictors stay a normal editable multi-select', async () => {
                const rel = makeModel({ id: 'm2', name: 'Rel Model', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2'] });
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel] } });
                fireEvent.click(screen.getByText('Rel Model'));
                const form = within(screen.getByTestId('add-model-form'));
                expect(form.getByText('Pump Pressure (TAG1)').closest('select')).toBeNull(); // Target: locked

                fireEvent.change(form.getByPlaceholderText('Search sensor tag or description…'), { target: { value: 'TAG3' } });
                fireEvent.click(form.getByText('TAG3')); // no description in the fixture -- bare tag
                expect(form.getByText('TAG3')).toBeTruthy(); // Predictors: still freely editable (now the chip)
            });

            it('the predictor picker passes getComponent through to SensorAutocomplete, so its dropdown can group by component (2026-09-18, per explicit user request: "แสดงผลเป็น by component ได้ไหม ... สามารถ search ได้ด้วย") -- the actual grouped/searchable rendering is SensorAutocomplete\'s own behavior, covered directly against the real implementation in PredictiveModelBuild.test.tsx, since this page mocks that component out', async () => {
                const rel = makeModel({ id: 'm2', name: 'Rel Model', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: [] });
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel] } });
                fireEvent.click(screen.getByText('Rel Model'));

                const predictorProps = sensorAutocompleteProps.find(p => p.placeholder === 'Search sensor tag or description…');
                expect(predictorProps).toBeTruthy();
                expect(typeof predictorProps.getComponent).toBe('function');
                expect(predictorProps.getComponent('TAG2')).toBe('Pump'); // has a component in the fixture
                expect(predictorProps.getComponent('TAG3')).toBe(''); // no metadata entry -- SensorAutocomplete itself falls this back to "Uncategorized"
            });

            it('Clustering\'s X sensor is locked, but its Y sensor stays a normal editable select', async () => {
                const clu = makeModel({ id: 'm3', name: 'Clu Model', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2' });
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups: [makeGroup()], models: [clu] } });
                fireEvent.click(screen.getByText('Clu Model'));
                const form = within(screen.getByTestId('add-model-form'));
                expect(form.getByText('Pump Pressure (TAG1)', { selector: '.model-component-readout' })).toBeTruthy(); // X: locked

                const ySelect = form.getByDisplayValue('Pump Temp (TAG2)') as HTMLSelectElement; // Y: still a select
                fireEvent.change(ySelect, { target: { value: 'TAG3' } });
                expect(ySelect.value).toBe('TAG3');
            });

            it('a fresh clustering model (X set, Y still unset) is grouped under its X sensor\'s component in "Group by Component" view, not left in "Uncategorized" (2026-09-01 fix — component derivation only looked at Y before)', async () => {
                const clu = makeModel({ id: 'm3', name: 'Clu Model', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: '' });
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups: [makeGroup()], models: [clu] } });
                fireEvent.click(screen.getByText('Group by Component'));
                expect(screen.getAllByText('Pump').length).toBeGreaterThan(0);
                expect(screen.queryByText('Uncategorized')).toBeNull();
            });
        });
    });

    // 2026-09-15: workspace-wide, set once here instead of per model — see
    // this file's own PredictiveModelBuild mock (`predictiveModelBuildProps`)
    // for confirming the value actually reaches that page too.
    describe('Running Condition Filter panel', () => {
        it('shows "not set" and applies-to-none until a condition is added', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            expect(screen.getByText('Running Condition Filter')).toBeTruthy();
            expect(screen.getByText(/Not set — every model trains on the full dataset/)).toBeTruthy();
            expect(screen.queryByText(/applies to/)).toBeNull();
        });

        it('expands on click and adds a condition, which persists and broadcasts', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Running Condition Filter'));
            fireEvent.click(screen.getByText('Add condition (AND)'));

            expect(mockUpdateWorkspaceData).toHaveBeenCalledWith('ws1', expect.any(Function));
            await act(async () => { await Promise.resolve(); });
            expect(mockEmit).toHaveBeenCalledWith('failure-group-state-changed', expect.objectContaining({
                runningConditionFilters: expect.arrayContaining([expect.objectContaining({ sensor: 'TAG1', operation: 'greater_than' })]),
            }));
        });

        it('editing a condition\'s value persists the new value', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Running Condition Filter'));
            fireEvent.click(screen.getByText('Add condition (AND)'));
            await act(async () => { await Promise.resolve(); });
            mockUpdateWorkspaceData.mockClear();

            fireEvent.change(screen.getByPlaceholderText('val'), { target: { value: '1200' } });
            await act(async () => { await Promise.resolve(); });
            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(state.failureGroupState.runningConditionFilters[0].value1).toBe('1200');
        });

        it('removing the only condition goes back to "not set"', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Running Condition Filter'));
            fireEvent.click(screen.getByText('Add condition (AND)'));
            await act(async () => { await Promise.resolve(); });

            fireEvent.click(screen.getByTitle('Remove condition'));
            await act(async () => { await Promise.resolve(); });
            expect(screen.getByText(/Not set — every model trains on the full dataset/)).toBeTruthy();
        });

        it('passes the current filter down to the PM page as runningConditionFilters', async () => {
            const modelWithGroup = makeModel();
            const filters = [{ id: 'rcf1', sensor: 'TAG1', operation: 'greater_than', value1: '1200', value2: '' }];
            render(<BuildModelWindow />);
            await deliverData({
                failureGroupState: {
                    groups: [makeGroup()],
                    models: [modelWithGroup],
                    runningConditionFilters: filters,
                },
            });
            // commitForm's persist() round-trips through updateWorkspaceData and
            // then resyncs this window's local runningConditionFilters from
            // whatever comes back -- the default mock's `prev` (beforeEach
            // above) omits runningConditionFilters entirely, which would
            // otherwise silently wipe it here. Match deliverData's payload so
            // the round trip is realistic.
            mockUpdateWorkspaceData.mockImplementation(async (id: string, patch: (s: any) => any) => {
                const prev = { id, failureGroupState: { groups: [makeGroup()], models: [modelWithGroup], runningConditionFilters: filters } };
                return patch(prev);
            });
            fireEvent.click(screen.getByText('Model One'));
            await act(async () => { fireEvent.click(screen.getByText('Build Model →')); });
            const lastProps = predictiveModelBuildProps[predictiveModelBuildProps.length - 1];
            expect(lastProps.runningConditionFilters).toEqual(filters);
        });

        it('stays untouched when an unrelated model edit is saved (regression: the generic persist() used to drop it)', async () => {
            render(<BuildModelWindow />);
            await deliverData({
                failureGroupState: {
                    groups: [makeGroup()],
                    models: [makeModel()],
                    runningConditionFilters: [{ id: 'rcf1', sensor: 'TAG1', operation: 'greater_than', value1: '1200', value2: '' }],
                },
            });
            mockUpdateWorkspaceData.mockImplementation(async (id: string, patch: (s: any) => any) => patch({
                id,
                failureGroupState: {
                    groups: [makeGroup()],
                    models: [makeModel()],
                    runningConditionFilters: [{ id: 'rcf1', sensor: 'TAG1', operation: 'greater_than', value1: '1200', value2: '' }],
                },
            }));

            fireEvent.click(screen.getByText('Model One'));
            const form = within(screen.getByTestId('add-model-form'));
            fireEvent.change(form.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Renamed' } });
            fireEvent.click(form.getByText('Save changes'));

            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(state.failureGroupState.runningConditionFilters).toEqual([
                { id: 'rcf1', sensor: 'TAG1', operation: 'greater_than', value1: '1200', value2: '' },
            ]);
        });
    });
});
