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
const sensorPickerModalProps: any[] = [];
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
    // Minimal stand-in for the popup picker (2026-09-22, extended the same
    // day to also cover single-select fields) — its own search/collapsible-
    // group/checkbox/single-vs-multi behavior is tested directly against the
    // real implementation in PredictiveModelBuild.test.tsx. Typing a value
    // and firing change stands in for "open the popup, pick it" in one step,
    // branching on `single` the same way the real component's trigger does.
    SensorPickerModal: (props: any) => {
        sensorPickerModalProps.push(props);
        return props.single ? (
            <input
                placeholder={props.value ? undefined : (props.placeholder ?? `Pick ${props.noun}...`)}
                value={props.value ?? ''}
                disabled={props.disabled}
                onChange={e => props.onSelect(e.target.value)}
            />
        ) : (
            <input
                placeholder={`Add ${props.noun}…`}
                onChange={e => props.onConfirm([...props.selected, e.target.value])}
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
    const ws: Record<string, any> = {
        id: 'ws1',
        failureGroupState: { groups: [makeGroup()], models: [makeModel()] },
        ...overrides,
    };
    // Feature 4-B gate defaults: fixtures read as a CONFIGURED workspace (No
    // condition confirmed) with the legacy notice already handled, so tests that
    // are about something else don't trip the running-condition gate or the
    // hydration write-back. A test about the gate passes the key explicitly
    // (even as `undefined`), which is respected.
    if (ws.failureGroupState) {
        const fg = ws.failureGroupState;
        ws.failureGroupState = {
            ...(!('runningConditionNoneConfirmed' in fg) ? { runningConditionNoneConfirmed: true } : {}),
            ...(!('rcLegacyNotice' in fg) ? { rcLegacyNotice: null } : {}),
            ...fg,
        };
    }
    mockLoadWorkspaceData.mockResolvedValue(ws);
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
    sensorPickerModalProps.length = 0;
    mockListen.mockClear();
    mockEmit.mockClear().mockResolvedValue(undefined);
    mockClose.mockClear().mockResolvedValue(undefined);
    mockUpdateWorkspaceData.mockReset().mockImplementation(async (id: string, patch: (s: any) => any) => {
        const prev = { id, failureGroupState: { groups: [makeGroup()], models: [makeModel()], runningConditionNoneConfirmed: true, rcLegacyNotice: null } };
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
        expect(screen.getByText('Pump Pressure (TAG1)')).toBeTruthy(); // one row per sensor, labelled by the sensor
    });

    it('shows exactly one line per sensor — no duplicate description/description(tag) lines', async () => {
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
        expect(screen.queryByText('Pump Temp (TAG2)')).toBeNull();

        await act(async () => {
            for (const cb of listenCallbacks['failure-group-state-changed'] ?? []) {
                cb({ payload: { workspaceId: 'ws1', origin: 'dashboard', groups: [makeGroup()], models: [makeModel({ id: 'm2', name: 'New Model', targetSensor: 'TAG2' })] } });
            }
        });
        expect(screen.getByText('Pump Temp (TAG2)')).toBeTruthy();
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
                groups: [makeGroup()], models: [makeModel({ id: 'x', name: 'Foreign Model', targetSensor: 'TAG2' })],
            });
            await fire('failure-group-state-changed', {
                groups: [makeGroup()], models: [makeModel({ id: 'y', name: 'Unscoped Model', targetSensor: 'TAG3' })],
            });
            expect(screen.queryByText('Pump Temp (TAG2)')).toBeNull(); // foreign model's sensor
            expect(screen.queryByText('TAG3')).toBeNull(); // unscoped model's sensor
            expect(screen.getByText('Pump Pressure (TAG1)')).toBeTruthy();
        });

        it('skips its own echo but still applies the Predictive Model page\'s broadcast (that page lives inside this window)', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            await fire('failure-group-state-changed', {
                workspaceId: 'ws1', origin: 'build-model',
                groups: [makeGroup()], models: [makeModel({ id: 'e', name: 'Echoed Model', targetSensor: 'TAG2' })],
            });
            expect(screen.queryByText('Pump Temp (TAG2)')).toBeNull();
            await fire('failure-group-state-changed', {
                workspaceId: 'ws1', origin: 'predictive-model',
                groups: [makeGroup()], models: [makeModel({ id: 'p', name: 'PM Edit', targetSensor: 'TAG2' })],
            });
            expect(screen.getByText('Pump Temp (TAG2)')).toBeTruthy();
        });

        it('stamps every failure-group broadcast it sends with its workspace id', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
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
            fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
            await act(async () => { fireEvent.click(screen.getByText('Build Model →')); });
            expect(screen.getByTestId('pm-page-mock')).toBeTruthy();

            mockLoadWorkspaceData.mockResolvedValue({
                id: 'ws2',
                failureGroupState: { groups: [makeGroup({ no: 1, name: 'Other Group' })], models: [makeModel({ id: 'other', name: 'Other Project Model', targetSensor: 'OTHER1' })], runningConditionNoneConfirmed: true, rcLegacyNotice: null },
            });
            await fire('build-model-data', {
                workspaceId: 'ws2',
                sensorHeaders: ['OTHER1'],
                sensorMetadata: [],
                metadata: { headers: ['timestamp', 'OTHER1'], total_rows: 1 },
            });

            expect(screen.queryByTestId('pm-page-mock')).toBeNull(); // model 'm1' does not exist in ws2
            expect(screen.getByText('OTHER1')).toBeTruthy();
            expect(screen.queryByText('Pump Pressure (TAG1)')).toBeNull();
        });

        it('re-delivery for the SAME workspace keeps the open PM page', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
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
                failureGroupState: { groups: [makeGroup()], models: [makeModel({ id: 'new', name: 'Fresh Model', targetSensor: 'TAG2' })], runningConditionNoneConfirmed: true, rcLegacyNotice: null },
            });
            const payload = {
                workspaceId: 'ws1', sensorHeaders: ['TAG1'], sensorMetadata: [],
                metadata: { headers: ['timestamp', 'TAG1'], total_rows: 1 },
            };
            await fire('build-model-data', payload); // first reply: its load stays pending
            await fire('build-model-data', payload); // second reply: resolves immediately
            expect(screen.getByText('TAG2')).toBeTruthy();

            await act(async () => {
                resolveFirst({ id: 'ws1', failureGroupState: { groups: [makeGroup()], models: [makeModel({ id: 'old', name: 'Stale Model', targetSensor: 'TAG3' })], runningConditionNoneConfirmed: true, rcLegacyNotice: null } });
                await Promise.resolve();
                await Promise.resolve();
            });
            expect(screen.queryByText('TAG3')).toBeNull();
            expect(screen.getByText('TAG2')).toBeTruthy();
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
            fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);

            expect(screen.getByTestId('add-model-form')).toBeTruthy();
            expect(screen.getByText('Build Model — Overview')).toBeTruthy(); // still on the same page
            expect(mockEmit).not.toHaveBeenCalledWith('open-build-model', expect.anything());
        });

        it('shows the model\'s Failure Group membership as a read-only chip list, no checkboxes (2026-09-01: editing group membership moved to the Sensor tab entirely — "ไม่ควรแก้ FG ได้ในหน้านี้ ดูได้อย่างเดียว")', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup({ no: 2, name: 'Group B' })], models: [makeModel({ groupNos: [2] })] } });
            fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
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
            fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
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
            fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);

            const fields = screen.getByTestId('add-model-form-fields');
            expect(fields.style.maxHeight).toBeTruthy();
            expect(fields.style.overflowY).toBe('auto');
            expect(within(fields).queryByText('Save changes')).toBeNull(); // footer isn't nested inside the scrollable fields box
            expect(screen.getByText('Save changes')).toBeTruthy(); // but it's still rendered, right alongside it
        });

        it('the footer is sticky to the viewport bottom, not just structurally present (regression: a form deep in a long list, or with a fields box near its own max-height, could still place the footer below the visible area with the fields box alone not being enough)', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);

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
            fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
            const saveBtn = screen.getByText('Save changes').closest('button') as HTMLButtonElement;
            const footer = saveBtn.parentElement as HTMLElement;
            expect(footer.style.borderBottomLeftRadius).toBe('10px');
            expect(footer.style.borderBottomRightRadius).toBe('10px');
        });

        it('the opened form\'s boundary is a real border wrapping the whole card (header + footer), not just a left accent bar (regression: an absolutely-positioned bar was anchored to the row\'s un-scrolled flow position and visually detached from the sticky footer once the page scrolled)', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);

            const saveBtn = screen.getByText('Save changes');
            let boundary: HTMLElement | null = screen.getAllByTestId('sensor-row-label')[0].parentElement;
            while (boundary && !boundary.style.border) boundary = boundary.parentElement;
            expect(boundary).not.toBeNull();
            expect(boundary!.contains(saveBtn)).toBe(true);
        });

        it('clicking the same row again closes its form (toggle)', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
            expect(screen.getByTestId('add-model-form')).toBeTruthy();

            fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
            expect(screen.queryByTestId('add-model-form')).toBeNull();
        });

        it('clicking a different row switches the form to the new row', async () => {
            const first = makeModel({ id: 'm1', name: 'First Model' });
            const second = makeModel({ id: 'm2', name: 'Second Model', targetSensor: 'TAG2' });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [first, second] } });

            fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
            expect((within(screen.getByTestId('add-model-form')).getByPlaceholderText('e.g. Bearing vibration model') as HTMLInputElement).value).toBe('First Model');

            fireEvent.click(screen.getAllByTestId('sensor-row-label')[1]);
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
            fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
            expect(screen.queryByText('Cancel')).toBeNull();
            const form = within(screen.getByTestId('add-model-form'));
            fireEvent.change(form.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Discarded' } });
            fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
            expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
            expect(screen.queryByTestId('add-model-form')).toBeNull();
        });

        it('Save changes is a normal-sized button, not stretched full-width (regression: .fg-build-model-btn\'s width:100% default)', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
            const saveBtn = screen.getByText('Save changes').closest('button') as HTMLButtonElement;
            expect(saveBtn.style.width).not.toBe('100%');
        });

        it('shows no "Remove model" button anywhere (2026-08-31: removed per explicit user request — model deletion moved to Dashboard\'s Failure Groups tab; Build Model only edits/trains)', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
            expect(screen.queryByText('Remove model')).toBeNull();
        });

        it('saving an edit persists it and clears the draft, showing the change immediately', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
            const form = within(screen.getByTestId('add-model-form'));
            fireEvent.change(form.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Renamed Model' } });
            await act(async () => {
                fireEvent.click(form.getByText('Save changes'));
                await Promise.resolve();
                await Promise.resolve();
            });

            // The row stays open (it holds several models' tabs); the saved name is now the stored one.
            expect((screen.getByPlaceholderText('e.g. Bearing vibration model') as HTMLInputElement).value).toBe('Renamed Model');
            expect(screen.queryByText('edited')).toBeNull();
            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(state.failureGroupState.models[0].name).toBe('Renamed Model');
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
                expect(screen.getByText('Pump Pressure (TAG1)')).toBeTruthy(); // sensor row inside the Not in Group card
            });

        });

        it('the status pill lives inside each model own tab, and toggling it persists just that model without touching the form', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            // Row header shows only a status DOT per kind chip (no pill) until the row is open.
            expect(screen.queryByText('Incomplete')).toBeNull();
            fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
            fireEvent.click(screen.getByText('Incomplete'));
            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(state.failureGroupState.models[0].status).toBe(true);
        });

        // 2026-09-09: "Build Model →" moved from the (always-visible) row
        // header into the edit form's footer, right after Save changes, and
        // is disabled until the form is valid — training an incomplete
        // model didn't make sense. Only reachable by opening the row first.
        it('"Build Model" navigates to the in-window Predictive Model page instead of opening a new window', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]); // open the row — makeModel() is already complete
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
            fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);

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
            fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]); // falls back to the sensor label since name is blank -- still opens the row
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
            fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
            fireEvent.change(screen.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Renamed before building' } });

            await act(async () => { fireEvent.click(screen.getByText('Build Model →')); });

            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(state.failureGroupState.models[0].name).toBe('Renamed before building');
            expect(screen.getByTestId('pm-page-mock')).toBeTruthy();
        });

        it('the PM page\'s Back control returns to the model overview', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
            await act(async () => { fireEvent.click(screen.getByText('Build Model →')); });
            expect(screen.getByTestId('pm-page-mock')).toBeTruthy();
            fireEvent.click(screen.getByText('Mock Back'));
            expect(screen.queryByTestId('pm-page-mock')).toBeNull();
            expect(screen.getByText('Build Model — Overview')).toBeTruthy();
            // The sensor row the user came from is still open (the draft was committed before navigating).
            expect(screen.getByTestId('add-model-form')).toBeTruthy();
        });

        it('the PM page\'s Finish control marks the model Complete and returns to the model overview', async () => {
            render(<BuildModelWindow />);
            await deliverData(); // makeModel() defaults to status: false (Incomplete)
            fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
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
            fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
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
            // The one-line summary lives on the per-model rows (Component view); the FG view's row is per sensor.
            fireEvent.click(screen.getByText('Group by Component'));
            expect(screen.getByText('Target: Pump Pressure (TAG1) · Predictors: Pump Temp (TAG2), TAG3')).toBeTruthy();
            fireEvent.click(screen.getByText('Group by Failure Group'));

            fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
            const form = within(screen.getByTestId('add-model-form'));
            // 2026-09-01: Target sensor is now a locked readout, not a select
            // offering every sensor as an option — so each predictor's label
            // only appears once now (the chip), not twice (chip + the
            // Target select's own unrelated option list).
            expect(form.getAllByText('Pump Temp (TAG2)').length).toBe(1);
            expect(form.getAllByText('TAG3').length).toBe(1);
            expect(form.getByText('Pump Pressure (TAG1)', { selector: '.model-component-readout' })).toBeTruthy(); // locked Target readout (shared, once)
        });

        it('gives each model kind a distinct single-letter icon and color', async () => {
            const ind = makeModel({ id: 'm1', name: 'Ind Model', kind: 'individual' });
            const rel = makeModel({ id: 'm2', name: 'Rel Model', kind: 'relationship', targetSensor: 'TAG2', predictorSensors: ['TAG3'] });
            const clu = makeModel({ id: 'm3', name: 'Clu Model', kind: 'clustering', targetSensor: '', xSensor: 'TAG3', ySensor: 'TAG2' });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [ind, rel, clu] } });

            const indColor = (screen.getByTestId('sensor-kind-chip-m1')).className;
            const relColor = (screen.getByTestId('sensor-kind-chip-m2')).className;
            const cluColor = (screen.getByTestId('sensor-kind-chip-m3')).className;
            expect(new Set([indColor, relColor, cluColor]).size).toBe(3);
        });

        describe('edit form validation (2026-08-31: adapted from the removed "add model" flow — there is no add anymore, only editing an existing model)', () => {
            it('Save changes is disabled once the name is cleared, re-enabled once restored', async () => {
                render(<BuildModelWindow />);
                await deliverData();
                fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
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
                fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
                const form = within(screen.getByTestId('add-model-form'));

                const save = form.getByText('Save changes').closest('button') as HTMLButtonElement;
                expect(save.disabled).toBe(true); // no predictor yet

                fireEvent.change(form.getByPlaceholderText('Add predictors…'), { target: { value: 'TAG2' } });
                expect(save.disabled).toBe(false);
            });

            it('an existing Clustering model with no Y sensor keeps Save disabled until Y is filled in (X stays locked)', async () => {
                const clu = makeModel({ id: 'm3', name: 'Clu Model', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: '' });
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups: [makeGroup()], models: [clu] } });
                fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
                const form = within(screen.getByTestId('add-model-form'));

                const save = form.getByText('Save changes').closest('button') as HTMLButtonElement;
                expect(save.disabled).toBe(true); // Y still unset
                expect(form.getAllByText('Pump Pressure (TAG1)', { selector: '.model-component-readout' }).length).toBeGreaterThan(0); // locked X readout

                fireEvent.change(form.getByPlaceholderText('Pick Y sensor...'), { target: { value: 'TAG2' } });
                expect(save.disabled).toBe(false);
            });

            it('shows no "Model kind" picker anywhere — a model\'s kind is decided once, on the Sensor tab, and can\'t be switched here anymore (2026-09-01, per explicit user request: "ลบการเปลี่ยน model kind ออก เพราะว่าเราเลือก model kind ที่หน้า dashboard แล้ว")', async () => {
                render(<BuildModelWindow />);
                await deliverData();
                fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
                const form = within(screen.getByTestId('add-model-form'));
                expect(form.queryByText('Model kind')).toBeNull();
                // Kind is only ever a (read-only) tab label; there is no select/radio to switch it.
                expect(form.queryByRole('combobox')).toBeNull();
                expect(form.queryByRole('radio')).toBeNull();
                expect(form.getAllByRole('tab')).toHaveLength(1);
            });

        });

        describe('locked auto-fill sensor (2026-09-01: Target/X can no longer be changed after the model is created, per explicit user request — "ต้องล็อคไว้ห้าม user เปลี่ยน ... human error")', () => {
            it('Individual\'s Target sensor is a read-only readout, not a select — the raw tag can\'t be reassigned', async () => {
                render(<BuildModelWindow />);
                await deliverData();
                fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
                const form = within(screen.getByTestId('add-model-form'));
                expect(form.getByText('Pump Pressure (TAG1)', { selector: '.model-component-readout' })).toBeTruthy();
                expect(form.getByText('Pump Pressure (TAG1)', { selector: '.model-component-readout' }).closest('select')).toBeNull();
            });

            it('Relationship\'s Target sensor is locked too, but its Predictors stay a normal editable multi-select', async () => {
                const rel = makeModel({ id: 'm2', name: 'Rel Model', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2'] });
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel] } });
                fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
                const form = within(screen.getByTestId('add-model-form'));
                expect(form.getByText('Pump Pressure (TAG1)', { selector: '.model-component-readout' }).closest('select')).toBeNull(); // Target: locked

                fireEvent.change(form.getByPlaceholderText('Add predictors…'), { target: { value: 'TAG3' } });
                expect(form.getByText('TAG3')).toBeTruthy(); // Predictors: still freely editable (now the chip)
            });

            it('the predictor picker passes getComponent through to PredictorPickerModal, so its popup can group by component (2026-09-18, per explicit user request: "แสดงผลเป็น by component ได้ไหม ... สามารถ search ได้ด้วย") -- the actual grouped/searchable/collapsible rendering is PredictorPickerModal\'s own behavior, covered directly against the real implementation in PredictiveModelBuild.test.tsx, since this page mocks that component out', async () => {
                const rel = makeModel({ id: 'm2', name: 'Rel Model', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: [] });
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel] } });
                fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);

                const predictorProps = sensorPickerModalProps.find(p => p.noun === 'predictors');
                expect(predictorProps).toBeTruthy();
                expect(typeof predictorProps.getComponent).toBe('function');
                expect(predictorProps.getComponent('TAG2')).toBe('Pump'); // has a component in the fixture
                expect(predictorProps.getComponent('TAG3')).toBe(''); // no metadata entry -- SensorPickerModal itself falls this back to "Uncategorized"
            });

            it('Clustering\'s X sensor is locked, but its Y sensor stays a normal editable select', async () => {
                const clu = makeModel({ id: 'm3', name: 'Clu Model', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2' });
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups: [makeGroup()], models: [clu] } });
                fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
                const form = within(screen.getByTestId('add-model-form'));
                expect(form.getAllByText('Pump Pressure (TAG1)', { selector: '.model-component-readout' }).length).toBeGreaterThan(0); // X: locked

                const yPicker = form.getByDisplayValue('TAG2') as HTMLInputElement; // Y: still freely editable
                fireEvent.change(yPicker, { target: { value: 'TAG3' } });
                expect(yPicker.value).toBe('TAG3');
            });

            it('Y sensor and Criteria sensor are both single-select popups (2026-09-22, per explicit user request: "ต้องเลือก sensor ได้แค่ตัวเดียว ตาม concept ของ model") -- not the multi-select Predictor popup', async () => {
                const clu = makeModel({ id: 'm3', name: 'Clu Model', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: '', criteriaSensor: '' });
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups: [makeGroup()], models: [clu] } });
                fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);

                const yProps = sensorPickerModalProps.find(p => p.noun === 'Y sensor');
                const criteriaProps = sensorPickerModalProps.find(p => p.noun === 'criteria sensor');
                expect(yProps).toBeTruthy();
                expect(criteriaProps).toBeTruthy();
                expect(yProps.single).toBe(true);
                expect(criteriaProps.single).toBe(true);
                expect(criteriaProps.allowNone).toBe(true); // Criteria is optional -- Y is not
                expect(yProps.allowNone).toBeFalsy();
                expect(typeof criteriaProps.getComponent).toBe('function'); // grouped by component too
            });

            it('picking a Criteria sensor updates the field\'s own value (freely editable, unlike locked X)', async () => {
                const clu = makeModel({ id: 'm3', name: 'Clu Model', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2', criteriaSensor: '' });
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups: [makeGroup()], models: [clu] } });
                fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
                const form = within(screen.getByTestId('add-model-form'));

                fireEvent.change(form.getByPlaceholderText('Pick criteria sensor...'), { target: { value: 'TAG3' } });
                expect(form.getByDisplayValue('TAG3')).toBeTruthy();
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
        /** A workspace with models but NO running condition set and none confirmed
         *  (fixtures default to configured -- see deliverData), backed by a disk
         *  that actually keeps what is written, so panel edits round-trip. */
        async function deliverUnconfigured(extra: Record<string, any> = {}) {
            let disk: any = { id: 'ws1', failureGroupState: { groups: [makeGroup()], models: [makeModel()], runningConditionNoneConfirmed: false, rcLegacyNotice: null, ...extra } };
            mockUpdateWorkspaceData.mockImplementation(async (_id: string, patch: (s: any) => any) => { disk = patch(disk); return disk; });
            await deliverData({ failureGroupState: disk.failureGroupState });
        }

        it('an unconfigured workspace shows the Required pill, an amber border, and opens the panel by itself', async () => {
            render(<BuildModelWindow />);
            await deliverUnconfigured();
            expect(screen.getByTestId('rc-required-pill').textContent).toBe('Required');
            expect(screen.getByText(/Required — add a condition, or choose "No condition — use all rows"/)).toBeTruthy();
            expect((screen.getByTestId('rc-panel') as HTMLElement).style.border).toContain('245, 158, 11');
            expect(screen.getByText('Add condition')).toBeTruthy(); // auto-opened, not collapsed
            expect(screen.queryByText(/applies to/)).toBeNull();
        });

        it('a configured workspace has no Required pill and stays collapsed', async () => {
            render(<BuildModelWindow />);
            await deliverData(); // fixtures default to "No condition" confirmed
            expect(screen.queryByTestId('rc-required-pill')).toBeNull();
            expect(screen.getByText('No condition — use all rows')).toBeTruthy();
            expect(screen.queryByText('Add condition')).toBeNull();
        });

        it('auto-opens only once per hydration: a later re-delivery does not re-open a panel the user closed', async () => {
            render(<BuildModelWindow />);
            await deliverUnconfigured();
            fireEvent.click(screen.getByText('Running Condition Filter')); // user collapses it
            expect(screen.queryByText('Add condition')).toBeNull();
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel()], runningConditionNoneConfirmed: false, rcLegacyNotice: null } });
            expect(screen.queryByText('Add condition')).toBeNull();
        });

        it('choosing "No condition" confirms it (persisted, nothing cleared), drops the Required pill and hides the condition list', async () => {
            const filters = [{ id: 'rcf1', sensor: 'TAG1', operation: 'greater_than', value1: '', value2: '' }]; // incomplete -> still unconfigured
            render(<BuildModelWindow />);
            await deliverUnconfigured({ runningConditionFilters: filters });
            expect(screen.getByTestId('rc-required-pill')).toBeTruthy();

            fireEvent.click(screen.getByRole('button', { name: 'No condition' }));
            await act(async () => { await Promise.resolve(); await Promise.resolve(); });

            const written = (await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value).failureGroupState;
            expect(written.runningConditionNoneConfirmed).toBe(true);
            expect(written.runningConditionFilters).toEqual(filters); // clears nothing
            expect(screen.queryByTestId('rc-required-pill')).toBeNull();
            expect(screen.getByTestId('rc-none-note').textContent).toMatch(/saved conditions are kept but not applied/i);
            expect(screen.queryByText('Add condition')).toBeNull();
        });

        it('adding a condition after confirming "No condition" un-confirms it (mutually exclusive)', async () => {
            render(<BuildModelWindow />);
            await deliverUnconfigured({ runningConditionNoneConfirmed: true });
            fireEvent.click(screen.getByText('Running Condition Filter')); // configured -> not auto-opened
            fireEvent.click(screen.getByRole('button', { name: 'Filter by condition' }));
            await act(async () => { await Promise.resolve(); await Promise.resolve(); });
            let written = (await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value).failureGroupState;
            expect(written.runningConditionNoneConfirmed).toBe(false);

            fireEvent.click(screen.getByText('Add condition'));
            await act(async () => { await Promise.resolve(); await Promise.resolve(); });
            written = (await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value).failureGroupState;
            expect(written.runningConditionNoneConfirmed).toBe(false);
            expect(written.runningConditionFilters).toHaveLength(1);
        });

        it('a time range alone does NOT configure the workspace', async () => {
            render(<BuildModelWindow />);
            await deliverUnconfigured({ runningConditionTimeStart: '2026-05-01T00:00', runningConditionTimeEnd: '2026-06-01T00:00' });
            expect(screen.getByTestId('rc-required-pill')).toBeTruthy();
        });

        it('expands on click and adds a condition, which persists and broadcasts', async () => {
            render(<BuildModelWindow />);
            await deliverUnconfigured(); // unconfigured workspace: the panel auto-opens
            fireEvent.click(screen.getByText('Add condition'));

            expect(mockUpdateWorkspaceData).toHaveBeenCalledWith('ws1', expect.any(Function));
            await act(async () => { await Promise.resolve(); });
            expect(mockEmit).toHaveBeenCalledWith('failure-group-state-changed', expect.objectContaining({
                runningConditionFilters: expect.arrayContaining([expect.objectContaining({ sensor: 'TAG1', operation: 'greater_than' })]),
            }));
        });

        it('editing a condition\'s value persists the new value', async () => {
            render(<BuildModelWindow />);
            await deliverUnconfigured(); // unconfigured workspace: the panel auto-opens
            fireEvent.click(screen.getByText('Add condition'));
            await act(async () => { await Promise.resolve(); });
            mockUpdateWorkspaceData.mockClear();

            fireEvent.change(screen.getByPlaceholderText('val'), { target: { value: '1200' } });
            await act(async () => { await Promise.resolve(); });
            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(state.failureGroupState.runningConditionFilters[0].value1).toBe('1200');
        });

        it('the condition\'s sensor field is a single-select SensorPickerModal grouped by component (2026-09-22 fix — see next test for the reported bug this replaces)', async () => {
            render(<BuildModelWindow />);
            await deliverUnconfigured(); // unconfigured workspace: the panel auto-opens
            fireEvent.click(screen.getByText('Add condition'));

            const rcProps = sensorPickerModalProps.find(p => p.noun === 'sensor');
            expect(rcProps).toBeTruthy();
            expect(rcProps.single).toBe(true); // one sensor per condition, not the multi-select Predictor popup
            expect(typeof rcProps.getComponent).toBe('function'); // grouped, like every other picker now
        });

        it('picking a different sensor for a condition persists it (regression: this field used to render an unusable, unreachable dropdown — plain SensorAutocomplete at full row width with no test ever actually selecting through it)', async () => {
            render(<BuildModelWindow />);
            await deliverUnconfigured(); // unconfigured workspace: the panel auto-opens
            fireEvent.click(screen.getByText('Add condition')); // defaults to sensor: 'TAG1'
            await act(async () => { await Promise.resolve(); });
            mockUpdateWorkspaceData.mockClear();

            fireEvent.change(screen.getByDisplayValue('TAG1'), { target: { value: 'TAG2' } });
            await act(async () => { await Promise.resolve(); });

            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(state.failureGroupState.runningConditionFilters[0].sensor).toBe('TAG2');
        });

        it('removing the only condition goes back to "not set"', async () => {
            render(<BuildModelWindow />);
            await deliverUnconfigured(); // unconfigured workspace: the panel auto-opens
            fireEvent.click(screen.getByText('Add condition'));
            await act(async () => { await Promise.resolve(); });

            fireEvent.click(screen.getByTitle('Remove condition'));
            await act(async () => { await Promise.resolve(); });
            expect(screen.getByText(/Required — add a condition/)).toBeTruthy();
        });

        it('the Match AND/OR toggle persists runningConditionCombine and switches the summary joiner', async () => {
            render(<BuildModelWindow />);
            await deliverUnconfigured(); // unconfigured workspace: the panel auto-opens
            fireEvent.click(screen.getByText('Add condition'));
            await act(async () => { await Promise.resolve(); });
            mockUpdateWorkspaceData.mockClear();

            fireEvent.click(screen.getByText('OR'));
            await act(async () => { await Promise.resolve(); });

            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(state.failureGroupState.runningConditionCombine).toBe('or');
        });

        it('typing into the workspace Time start/end fields persists runningConditionTimeStart/-End (debounced) — 2026-09-23: time range merged into this same panel', async () => {
            vi.useFakeTimers();
            render(<BuildModelWindow />);
            await deliverUnconfigured();

            const startInput = screen.getByText('Time start').closest('.filter-row')!.querySelector('input') as HTMLInputElement;
            fireEvent.change(startInput, { target: { value: '2026-05-01T00:00' } });
            await act(async () => { await vi.advanceTimersByTimeAsync(250); });

            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(state.failureGroupState.runningConditionTimeStart).toBe('2026-05-01T00:00');
            vi.useRealTimers();
        });

        it('passes the current workspace time range down to the PM page', async () => {
            const modelWithGroup = makeModel();
            render(<BuildModelWindow />);
            await deliverData({
                failureGroupState: {
                    groups: [makeGroup()],
                    models: [modelWithGroup],
                    runningConditionTimeStart: '2026-05-01T00:00',
                    runningConditionTimeEnd: '2026-06-01T00:00',
                },
            });
            // Same round-trip concern as the runningConditionFilters test
            // below -- commitForm's persist() resyncs local state from
            // whatever updateWorkspaceData's mock returns.
            mockUpdateWorkspaceData.mockImplementation(async (id: string, patch: (s: any) => any) => {
                const prev = {
                    id,
                    failureGroupState: {
                        groups: [makeGroup()], models: [modelWithGroup],
                        runningConditionTimeStart: '2026-05-01T00:00', runningConditionTimeEnd: '2026-06-01T00:00',
                    },
                };
                return patch(prev);
            });
            fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
            await act(async () => { fireEvent.click(screen.getByText('Build Model →')); });
            const lastProps = predictiveModelBuildProps[predictiveModelBuildProps.length - 1];
            expect(lastProps.runningConditionTimeStart).toBe('2026-05-01T00:00');
            expect(lastProps.runningConditionTimeEnd).toBe('2026-06-01T00:00');
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
            fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
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

            fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
            const form = within(screen.getByTestId('add-model-form'));
            fireEvent.change(form.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Renamed' } });
            fireEvent.click(form.getByText('Save changes'));

            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(state.failureGroupState.runningConditionFilters).toEqual([
                { id: 'rcf1', sensor: 'TAG1', operation: 'greater_than', value1: '1200', value2: '' },
            ]);
        });
    });
    // ---- Feature 4-B (2026-09-24): mandatory running condition (soft gate A) ----
    describe('running-condition gate (Feature 4-B)', () => {
        const REASON = 'Set a running condition first, or choose "No condition — use all rows".';
        const cond = [{ id: 'rcf1', sensor: 'TAG1', operation: 'greater_than', value1: '1200', value2: '' }];
        const ind = (o: Record<string, any> = {}) => makeModel({ id: 'i1', name: 'Ind', kind: 'individual', targetSensor: 'TAG1', ...o });
        const rel = (o: Record<string, any> = {}) => makeModel({ id: 'r1', name: 'Rel', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2'], ...o });
        const fgOf = (models: any[], extra: Record<string, any> = {}) => ({
            groups: [makeGroup()], models, runningConditionNoneConfirmed: false, rcLegacyNotice: null, ...extra,
        });
        /** Disk that keeps what is written, seeded with the same state that is delivered. */
        async function deliverGate(models: any[], extra: Record<string, any> = {}) {
            let disk: any = { id: 'ws1', failureGroupState: fgOf(models, extra) };
            mockUpdateWorkspaceData.mockImplementation(async (_id: string, patch: (s: any) => any) => { disk = patch(disk); return disk; });
            await deliverData({ failureGroupState: disk.failureGroupState });
        }
        const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
        const openRow = () => fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);

        it('Build Model is disabled with the gate reason (button title + inline hint) while nothing is configured, and a click never navigates', async () => {
            render(<BuildModelWindow />);
            await deliverGate([ind()]);
            openRow();
            const build = screen.getByText('Build Model →') as HTMLButtonElement;
            expect(build.disabled).toBe(true);
            expect(build.title).toBe(REASON);
            expect(screen.getByTestId('build-block-reason').textContent).toBe(REASON);
            fireEvent.click(build);
            await flush();
            expect(screen.queryByTestId('pm-page-mock')).toBeNull();
        });

        it('Save changes stays allowed while Build Model is blocked by the running condition', async () => {
            render(<BuildModelWindow />);
            await deliverGate([ind()]);
            openRow();
            expect((screen.getByText('Save changes') as HTMLButtonElement).disabled).toBe(false);
            expect((screen.getByText('Build Model →') as HTMLButtonElement).disabled).toBe(true);
        });

        it('a complete condition unlocks Build Model', async () => {
            render(<BuildModelWindow />);
            await deliverGate([ind()], { runningConditionFilters: cond });
            openRow();
            expect((screen.getByText('Build Model →') as HTMLButtonElement).disabled).toBe(false);
            expect(screen.queryByTestId('build-block-reason')).toBeNull();
        });

        it('an incomplete condition (empty value) does not unlock Build Model', async () => {
            render(<BuildModelWindow />);
            await deliverGate([ind()], { runningConditionFilters: [{ ...cond[0], value1: '' }] });
            openRow();
            expect((screen.getByText('Build Model →') as HTMLButtonElement).disabled).toBe(true);
        });

        it('a condition on a sensor that is not in the dataset does not count (Rust would drop it)', async () => {
            render(<BuildModelWindow />);
            await deliverGate([ind()], { runningConditionFilters: [{ ...cond[0], sensor: 'GONE' }] });
            openRow();
            expect((screen.getByText('Build Model →') as HTMLButtonElement).disabled).toBe(true);
        });

        it('a time range alone does NOT unlock Build Model', async () => {
            render(<BuildModelWindow />);
            await deliverGate([ind()], { runningConditionTimeStart: '2026-05-01T00:00', runningConditionTimeEnd: '2026-06-01T00:00' });
            openRow();
            expect((screen.getByText('Build Model →') as HTMLButtonElement).disabled).toBe(true);
        });

        it('confirming "No condition — use all rows" on the panel enables Build Model', async () => {
            render(<BuildModelWindow />);
            await deliverGate([ind()]);
            openRow();
            expect((screen.getByText('Build Model →') as HTMLButtonElement).disabled).toBe(true);
            fireEvent.click(screen.getByRole('button', { name: 'No condition' }));
            await flush();
            expect((screen.getByText('Build Model →') as HTMLButtonElement).disabled).toBe(false);
            fireEvent.click(screen.getByText('Build Model →'));
            await flush();
            expect(screen.getByTestId('pm-page-mock')).toBeTruthy();
        });

        it('a Custom-mode model is judged by its OWN list, not the workspace one', async () => {
            render(<BuildModelWindow />);
            // Workspace configured, but this model is Custom with nothing set -> still blocked.
            await deliverGate([ind({ runningConditionMode: 'custom' })], { runningConditionFilters: cond });
            openRow();
            expect((screen.getByText('Build Model →') as HTMLButtonElement).disabled).toBe(true);
        });

        it('a Custom model with its own condition or confirmed None is unlocked even though the workspace is unset', async () => {
            render(<BuildModelWindow />);
            await deliverGate([ind({ runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true })]);
            openRow();
            expect((screen.getByText('Build Model →') as HTMLButtonElement).disabled).toBe(false);
        });

        it('passes runningConditionNoneConfirmed and the sensor category down to the PM page', async () => {
            render(<BuildModelWindow />);
            await deliverGate([ind({ category: 'condition' })], { runningConditionNoneConfirmed: true });
            openRow();
            await act(async () => { fireEvent.click(screen.getByText('Build Model →')); });
            const props = predictiveModelBuildProps[predictiveModelBuildProps.length - 1];
            expect(props.runningConditionNoneConfirmed).toBe(true);
            expect(props.category).toBe('condition');
        });

        it('the status pill cannot be toggled toward Complete while blocked (disabled, reason as tooltip), but Complete -> Incomplete is always allowed', async () => {
            render(<BuildModelWindow />);
            await deliverGate([ind({ status: false }), rel({ status: true })]);
            openRow();
            const pill = screen.getByText('Incomplete') as HTMLButtonElement; // Individual tab is active first
            expect(pill.disabled).toBe(true);
            expect(pill.title).toBe(REASON);
            mockUpdateWorkspaceData.mockClear();
            fireEvent.click(pill);
            await flush();
            expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();

            fireEvent.click(screen.getByRole('tab', { name: /Relationship/ }));
            const complete = screen.getByText('Complete') as HTMLButtonElement;
            expect(complete.disabled).toBe(false); // legacy Complete model can still be un-marked
            fireEvent.click(complete);
            await flush();
            const written = (await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value).failureGroupState;
            expect(written.models.find((m: any) => m.id === 'r1').status).toBe(false);
        });

        it('once configured, the status pill can be marked Complete', async () => {
            render(<BuildModelWindow />);
            await deliverGate([ind()], { runningConditionFilters: cond });
            openRow();
            fireEvent.click(screen.getByText('Incomplete'));
            await flush();
            const written = (await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value).failureGroupState;
            expect(written.models[0].status).toBe(true);
        });

        it('the Component / Model Type view pill is gated the same way', async () => {
            render(<BuildModelWindow />);
            await deliverGate([ind()]);
            fireEvent.click(screen.getByText('Group by Component'));
            const pill = screen.getByText('Incomplete') as HTMLButtonElement;
            expect(pill.disabled).toBe(true);
            expect(pill.title).toBe(REASON);
        });

        it('markModelComplete refuses when the gate closed after the PM page opened (guard at the source, not just the disabled button)', async () => {
            render(<BuildModelWindow />);
            await deliverGate([ind()], { runningConditionNoneConfirmed: true });
            openRow();
            await act(async () => { fireEvent.click(screen.getByText('Build Model →')); });
            expect(screen.getByTestId('pm-page-mock')).toBeTruthy();

            // Another window un-confirms the workspace condition meanwhile.
            await act(async () => {
                for (const cb of listenCallbacks['failure-group-state-changed'] ?? []) {
                    cb({ payload: { workspaceId: 'ws1', origin: 'predictive-model', ...fgOf([ind()]) } });
                }
                await Promise.resolve();
            });
            mockUpdateWorkspaceData.mockClear();
            fireEvent.click(screen.getByText('Mock Finish'));
            await flush();
            expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
        });

        describe('badges', () => {
            it('an unconfigured sensor row shows "N blocked" and each model tab shows "Needs condition"', async () => {
                render(<BuildModelWindow />);
                await deliverGate([ind(), rel()]);
                expect(screen.getByText('2 blocked')).toBeTruthy();
                openRow();
                expect(screen.getByTestId('condition-badge-i1').textContent).toBe('Needs condition');
                expect(screen.getByTestId('condition-badge-r1').textContent).toBe('Needs condition');
            });

            it('N blocked counts only models still Incomplete; a Complete model shows "Legacy · all data" instead', async () => {
                render(<BuildModelWindow />);
                await deliverGate([ind({ status: true }), rel({ status: false })]);
                expect(screen.getByText('1 blocked')).toBeTruthy();
                openRow();
                expect(screen.getByTestId('condition-badge-i1').textContent).toBe('Legacy · all data');
                expect(screen.getByTestId('condition-badge-r1').textContent).toBe('Needs condition');
            });

            it('no badges once the workspace is configured', async () => {
                render(<BuildModelWindow />);
                await deliverGate([ind(), rel()], { runningConditionNoneConfirmed: true });
                expect(screen.queryByText(/blocked/)).toBeNull();
                openRow();
                expect(screen.queryByTestId('condition-badge-i1')).toBeNull();
            });

            it('the Component view row shows the same badge', async () => {
                render(<BuildModelWindow />);
                await deliverGate([ind()]);
                fireEvent.click(screen.getByText('Group by Component'));
                expect(screen.getByTestId('condition-badge-i1').textContent).toBe('Needs condition');
            });
        });

        describe('legacy workspace banner', () => {
            const legacyFg = (extra: Record<string, any> = {}) => fgOf([ind()], { rcLegacyNotice: 'pending', ...extra });
            async function deliverLegacy(extra: Record<string, any> = {}) {
                let disk: any = { id: 'ws1', failureGroupState: legacyFg(extra) };
                mockUpdateWorkspaceData.mockImplementation(async (_id: string, patch: (s: any) => any) => { disk = patch(disk); return disk; });
                await deliverData({ failureGroupState: disk.failureGroupState });
            }
            const written = async () => (await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value).failureGroupState;

            it('shows the banner with its three actions for a pending workspace that is still unconfigured', async () => {
                render(<BuildModelWindow />);
                await deliverLegacy();
                const banner = screen.getByTestId('rc-legacy-banner');
                expect(within(banner).getByText('Set a condition')).toBeTruthy();
                expect(within(banner).getByText('Keep using all data')).toBeTruthy();
                expect(within(banner).getByText('Remind me later')).toBeTruthy();
            });

            it('is not shown when the notice is null/handled', async () => {
                render(<BuildModelWindow />);
                await deliverGate([ind()]);
                expect(screen.queryByTestId('rc-legacy-banner')).toBeNull();
            });

            it('"Set a condition" opens the panel', async () => {
                render(<BuildModelWindow />);
                await deliverLegacy();
                fireEvent.click(screen.getByText('Running Condition Filter')); // collapse the auto-opened panel
                expect(screen.queryByText('Add condition')).toBeNull();
                fireEvent.click(screen.getByText('Set a condition'));
                expect(screen.getByText('Add condition')).toBeTruthy();
                expect(screen.getByTestId('rc-legacy-banner')).toBeTruthy(); // still pending until something is set
            });

            it('"Keep using all data" confirms No condition and clears the notice (persisted)', async () => {
                render(<BuildModelWindow />);
                await deliverLegacy();
                fireEvent.click(screen.getByText('Keep using all data'));
                await flush();
                const fg = await written();
                expect(fg.runningConditionNoneConfirmed).toBe(true);
                expect(fg.rcLegacyNotice).toBeNull();
                expect(screen.queryByTestId('rc-legacy-banner')).toBeNull();
                expect(screen.queryByTestId('rc-required-pill')).toBeNull();
            });

            it('"Remind me later" hides it for this session only and writes nothing', async () => {
                render(<BuildModelWindow />);
                await deliverLegacy();
                mockUpdateWorkspaceData.mockClear();
                fireEvent.click(screen.getByText('Remind me later'));
                await flush();
                expect(screen.queryByTestId('rc-legacy-banner')).toBeNull();
                expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();

                // A fresh mount (next session) still has the persisted 'pending' flag -> banner is back.
                cleanup();
                render(<BuildModelWindow />);
                await deliverLegacy();
                expect(screen.getByTestId('rc-legacy-banner')).toBeTruthy();
            });

            it('setting a condition through the panel settles the notice (never re-fires)', async () => {
                render(<BuildModelWindow />);
                await deliverLegacy();
                fireEvent.click(screen.getByText('Add condition'));
                await flush();
                let fg = await written();
                expect(fg.rcLegacyNotice).toBe('pending'); // empty value: still unconfigured, still pending

                fireEvent.change(screen.getByPlaceholderText('val'), { target: { value: '1200' } });
                await flush();
                fg = await written();
                expect(fg.rcLegacyNotice).toBeNull();
                expect(screen.queryByTestId('rc-legacy-banner')).toBeNull();
            });

            it('an unflagged legacy workspace is flagged AT HYDRATION and written back (stored data, not computed per render)', async () => {
                let disk: any = { id: 'ws1', failureGroupState: { groups: [makeGroup()], models: [ind()] } }; // no rcLegacyNotice key at all
                mockUpdateWorkspaceData.mockImplementation(async (_id: string, patch: (s: any) => any) => { disk = patch(disk); return disk; });
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups: [makeGroup()], models: [ind()], rcLegacyNotice: undefined, runningConditionNoneConfirmed: undefined } });
                await flush();
                expect(mockUpdateWorkspaceData).toHaveBeenCalledTimes(1);
                expect(disk.failureGroupState.rcLegacyNotice).toBe('pending');
                expect(screen.getByTestId('rc-legacy-banner')).toBeTruthy();
            });

            it('an unflagged workspace that is already configured is not written back and shows no banner', async () => {
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups: [makeGroup()], models: [ind()], rcLegacyNotice: undefined, runningConditionNoneConfirmed: true } });
                await flush();
                expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
                expect(screen.queryByTestId('rc-legacy-banner')).toBeNull();
            });

            it('a brand-new workspace with no models is never flagged', async () => {
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups: [makeGroup()], models: [], rcLegacyNotice: undefined, runningConditionNoneConfirmed: false } });
                await flush();
                expect(screen.queryByTestId('rc-legacy-banner')).toBeNull();
                expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
            });
        });
    });

    // ---- Feature 4-A (2026-09-24): one row per SENSOR per FG, category per sensor ----
    describe('one row per sensor (Feature 4-A)', () => {
        const ind = (o: Record<string, any> = {}) => makeModel({ id: 'i1', name: 'Ind', kind: 'individual', targetSensor: 'TAG1', ...o });
        const rel = (o: Record<string, any> = {}) => makeModel({ id: 'r1', name: 'Rel', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2'], ...o });
        const clu = (o: Record<string, any> = {}) => makeModel({ id: 'c1', name: 'Clu', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2', ...o });
        const groups = [makeGroup({ no: 1, name: 'Group A' }), makeGroup({ no: 2, name: 'Group B' })];

        /** What "disk" holds when a write runs -- the write's patch is applied to THIS, like the real store. */
        function seedDisk(models: any[], extra: Record<string, any> = {}) {
            mockUpdateWorkspaceData.mockImplementation(async (id: string, patch: (s: any) => any) =>
                patch({ id, failureGroupState: { groups, models, ...extra } }));
        }
        const lastWrite = async () => (await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value).failureGroupState;
        const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

        it('two or three models of one sensor render as ONE row showing only the kinds that exist', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups, models: [ind(), rel()] } });
            expect(screen.getAllByTestId('sensor-row-label')).toHaveLength(1);
            expect(screen.getByTestId('sensor-kind-chip-i1')).toBeTruthy();
            expect(screen.getByTestId('sensor-kind-chip-r1')).toBeTruthy();
            expect(document.querySelectorAll('.model-kind-icon--clustering')).toHaveLength(0); // no Clustering chip -- none exists
            expect(screen.getByText('0 of 2 complete')).toBeTruthy();
        });

        it('a Clustering model is grouped by its X sensor, and changing Y never moves the row', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups, models: [ind(), clu({ ySensor: 'TAG3' })] } });
            expect(screen.getAllByTestId('sensor-row-label')).toHaveLength(1); // X = TAG1 = Individual's target
            fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
            fireEvent.click(screen.getByRole('tab', { name: /Clustering/ }));
            fireEvent.change(screen.getByDisplayValue('TAG3'), { target: { value: 'TAG2' } });
            expect(screen.getAllByTestId('sensor-row-label')).toHaveLength(1);
        });

        it('models on different sensors make separate rows', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups, models: [ind(), rel({ targetSensor: 'TAG2', predictorSensors: ['TAG3'] })] } });
            expect(screen.getAllByTestId('sensor-row-label')).toHaveLength(2);
        });

        it('shared fields (locked sensor, component, failure groups) render ONCE, with one tab per existing kind', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups, models: [ind(), rel(), clu()] } });
            fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
            expect(screen.getAllByTestId('sensor-shared-fields')).toHaveLength(1);
            expect(screen.getAllByRole('tab')).toHaveLength(3);
            expect(within(screen.getByTestId('sensor-shared-fields')).getByText('Pump')).toBeTruthy(); // component
        });

        it('failure groups are read-only chips with an "(I only)" suffix when membership is partial', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups, models: [ind({ groupNos: [1, 2] }), rel({ groupNos: [1] })] } });
            fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]); // FG-1 row: both kinds
            const shared = within(screen.getByTestId('sensor-shared-fields'));
            expect(shared.getByText('FG-1 · Group A')).toBeTruthy();
            expect(shared.getByText(/FG-2 · Group B \(I only\)/)).toBeTruthy();
            expect(shared.queryByRole('checkbox')).toBeNull();
            expect(screen.getAllByText('also in FG-2').length).toBeGreaterThan(0); // header says the sensor is elsewhere too
        });

        it('each model tab keeps its own draft -- switching tabs does not lose an unsaved edit, and the tab is marked "edited"', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups, models: [ind(), rel()] } });
            fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
            fireEvent.change(screen.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Ind renamed' } });
            expect(screen.getByText('edited')).toBeTruthy();

            fireEvent.click(screen.getByRole('tab', { name: /Relationship/ }));
            expect((screen.getByPlaceholderText('e.g. Bearing vibration model') as HTMLInputElement).value).toBe('Rel');
            fireEvent.click(screen.getByRole('tab', { name: /Individual/ }));
            expect((screen.getByPlaceholderText('e.g. Bearing vibration model') as HTMLInputElement).value).toBe('Ind renamed');
        });

        it('Save changes only touches the active tab model, and never writes category', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups, models: [ind(), rel()] } });
            seedDisk([ind({ category: 'condition' }), rel({ category: 'condition' })]); // disk moved on since this window loaded
            fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
            fireEvent.change(screen.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Ind renamed' } });
            await act(async () => { fireEvent.click(screen.getByText('Save changes')); await Promise.resolve(); await Promise.resolve(); });
            const models = (await lastWrite()).models;
            expect(models.find((m: any) => m.id === 'i1').name).toBe('Ind renamed');
            expect(models.find((m: any) => m.id === 'r1').name).toBe('Rel');
            expect(models.every((m: any) => m.category === 'condition')).toBe(true); // a stale draft can't revert the sensor's category
        });

        it('each tab has its own status pill; toggling one leaves the other kind alone', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups, models: [ind(), rel()] } });
            seedDisk([ind(), rel()]);
            fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
            fireEvent.click(screen.getByRole('tab', { name: /Relationship/ }));
            fireEvent.click(screen.getByText('Incomplete'));
            const models = (await lastWrite()).models;
            expect(models.find((m: any) => m.id === 'r1').status).toBe(true);
            expect(models.find((m: any) => m.id === 'i1').status).toBe(false);
        });

        it('long sensor labels stay on one line (single-line ellipsis)', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups, models: [ind()] } });
            const label = screen.getAllByTestId('sensor-row-label')[0];
            expect(label.style.whiteSpace).toBe('nowrap');
            expect(label.style.textOverflow).toBe('ellipsis');
            expect(label.style.overflow).toBe('hidden');
        });

        describe('category is set once, on the sensor header', () => {
            it('there is no per-model Category field in the form, and no "Mixed" state anywhere', async () => {
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups, models: [ind({ category: 'performance' }), rel({ category: 'condition' })] } });
                fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
                const form = within(screen.getByTestId('add-model-form'));
                expect(form.queryByText('Category')).toBeNull();
                expect(screen.queryByText(/mixed/i)).toBeNull();
            });

            it('clicking a category on the header saves INSTANTLY (no Save) and writes every model of that sensor in every FG', async () => {
                const models = [ind({ groupNos: [1], category: null }), rel({ groupNos: [2], category: null }), ind({ id: 'other', targetSensor: 'TAG2', category: null })];
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups, models } });
                seedDisk(models);
                mockUpdateWorkspaceData.mockClear();
                seedDisk(models);
                fireEvent.click(within(screen.getByTestId('sensor-row-fg:1:tag1')).getByRole('button', { name: 'Condition' }));
                await flush();
                const written = (await lastWrite()).models;
                expect(written.find((m: any) => m.id === 'i1').category).toBe('condition');
                expect(written.find((m: any) => m.id === 'r1').category).toBe('condition'); // in FG-2, a different row
                expect(written.find((m: any) => m.id === 'other').category).toBeNull(); // another sensor untouched
            });

            it('the pressed state reflects the sensor category, and clicking the active one is a no-op', async () => {
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups, models: [ind({ category: 'performance' })] } });
                const row = within(screen.getByTestId('sensor-row-fg:1:tag1'));
                expect(row.getByRole('button', { name: 'Performance' }).getAttribute('aria-pressed')).toBe('true');
                expect(row.getByRole('button', { name: 'Condition' }).getAttribute('aria-pressed')).toBe('false');
                mockUpdateWorkspaceData.mockClear();
                fireEvent.click(row.getByRole('button', { name: 'Performance' }));
                await flush();
                expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
            });

            it('warns when the change also applies to other failure groups, and stays quiet for a single-FG sensor', async () => {
                const multi = [ind({ groupNos: [1, 2], category: 'performance' })];
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups, models: multi } });
                seedDisk(multi);
                fireEvent.click(within(screen.getByTestId('sensor-row-fg:1:tag1')).getByRole('button', { name: 'Condition' }));
                await flush();
                expect(screen.getAllByRole('status')[0].textContent).toMatch(/every failure group: FG-1, FG-2/);
                cleanup();

                const single = [ind({ groupNos: [1], category: 'performance' })];
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups, models: single } });
                seedDisk(single);
                fireEvent.click(within(screen.getByTestId('sensor-row-fg:1:tag1')).getByRole('button', { name: 'Condition' }));
                await flush();
                expect(screen.queryByText(/every failure group/)).toBeNull();
            });

            it('Save and Build Model stay disabled, with the reason, while the sensor has no category -- and enable once one is picked', async () => {
                const models = [ind({ category: null })];
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups, models } });
                seedDisk(models);
                fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
                expect((screen.getByText('Save changes') as HTMLButtonElement).disabled).toBe(true);
                const build = screen.getByText('Build Model →') as HTMLButtonElement;
                expect(build.disabled).toBe(true);
                expect(build.title).toBe('Pick a category on the sensor header');
                expect(screen.getAllByText('Pick a category on the sensor header').length).toBeGreaterThan(0);

                fireEvent.click(within(screen.getByTestId('sensor-row-fg:1:tag1')).getByRole('button', { name: 'Performance' }));
                await flush();
                expect((screen.getByText('Save changes') as HTMLButtonElement).disabled).toBe(false);
            });

            it('Component and Model Type views show a read-only category chip with a link back to the sensor header', async () => {
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups, models: [ind({ category: 'condition' })] } });
                fireEvent.click(screen.getByText('Group by Component'));
                expect(screen.getByTestId('model-category-chip-i1').textContent).toBe('Condition');
                expect(screen.queryByRole('button', { name: 'Condition' })).toBeNull(); // no editable control here

                fireEvent.click(screen.getByText('Change in Failure Group view'));
                expect(screen.getByTestId('sensor-row-fg:1:tag1')).toBeTruthy(); // switched to the FG view
                expect(screen.getByTestId('add-model-form')).toBeTruthy(); // ...with that sensor's row open
            });
        });

        describe('one-time category normalisation notice', () => {
            const inconsistent = () => [ind({ category: 'performance' }), rel({ category: 'condition' })];

            it('hydrating a legacy workspace normalises it, WRITES IT BACK once with the notice, and shows the notice', async () => {
                seedDisk(inconsistent());
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups, models: inconsistent() } });
                expect(screen.getByTestId('category-normalisation-notice')).toBeTruthy();
                expect(mockUpdateWorkspaceData).toHaveBeenCalledTimes(1);
                const written = await lastWrite();
                expect(written.models.map((m: any) => m.category)).toEqual(['performance', 'performance']); // Individual wins
                expect(written.categoryNormalisationNotice).toEqual([
                    expect.objectContaining({ modelId: 'r1', kind: 'relationship', from: 'condition', to: 'performance' }),
                ]);
                expect(mockEmit).toHaveBeenCalledWith('failure-group-state-changed', expect.objectContaining({ workspaceId: 'ws1', origin: 'build-model' }));
            });

            it('a consistent workspace shows no notice and is not written on open', async () => {
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups, models: [ind(), rel()] } });
                expect(screen.queryByTestId('category-normalisation-notice')).toBeNull();
                expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
            });

            it('an already-stored notice is shown but NOT re-derived or re-written', async () => {
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: {
                    groups, models: [ind(), rel()],
                    categoryNormalisationNotice: [{ modelId: 'r1', kind: 'relationship', sensorKey: 'tag1', from: 'condition', to: 'performance' }],
                } });
                expect(screen.getByTestId('category-normalisation-notice')).toBeTruthy();
                expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
            });

            it('Dismiss persists categoryNormalisationNotice: null (so it never comes back) and removes the card', async () => {
                seedDisk(inconsistent());
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups, models: inconsistent() } });
                mockUpdateWorkspaceData.mockClear();
                seedDisk(inconsistent().map(m => ({ ...m, category: 'performance' })), {
                    categoryNormalisationNotice: [{ modelId: 'r1', kind: 'relationship', sensorKey: 'tag1', from: 'condition', to: 'performance' }],
                });
                fireEvent.click(screen.getByText('Dismiss'));
                await flush();
                expect((await lastWrite()).categoryNormalisationNotice).toBeNull();
                expect(screen.queryByTestId('category-normalisation-notice')).toBeNull();
            });
        });
    });
});
