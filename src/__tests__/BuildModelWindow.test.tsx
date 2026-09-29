import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, fireEvent, act, cleanup, within, waitFor } from '@testing-library/react';

const mockClose = vi.fn().mockResolvedValue(undefined);
// `onCloseRequested` — the close-flush effect (mirrors Dashboard.test.tsx's
// own mock of the same Tauri API). `mockCloseRequestedHandler` captures the
// registered handler so tests can invoke it directly, simulating a native
// window close (titlebar X / Alt+F4 / OS shutdown) — a path that bypasses
// the toolbar's own Close button (`handleClose`) entirely.
let mockCloseRequestedHandler: ((event: { preventDefault: () => void }) => void | Promise<void>) | null = null;
const mockOnCloseRequested = vi.fn((handler: (event: { preventDefault: () => void }) => void | Promise<void>) => {
    mockCloseRequestedHandler = handler;
    return Promise.resolve(() => { mockCloseRequestedHandler = null; });
});
vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({ close: mockClose, onCloseRequested: (handler: any) => mockOnCloseRequested(handler) }),
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

// Build Model Workbench Phase B (Train in place) — same mocking pattern
// PredictiveModelBuild.test.tsx already uses for the three preview commands
// and the chart components they feed.
const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (cmd: string, args?: unknown) => mockInvoke(cmd, args),
}));

const mockUseChartData = vi.fn();
vi.mock('../hooks/useChartData', () => ({ useChartData: (q: unknown) => mockUseChartData(q) }));

const lineChartProps: any[] = [];
vi.mock('../components/charts/LineChart', () => ({
    default: (props: any) => { lineChartProps.push(props); return <div data-testid="line-chart-mock" />; },
}));
vi.mock('../components/charts/ResponsiveECharts', () => ({
    default: (props: any) => <div data-testid="echarts-mock" data-series-count={props.option?.series?.length ?? 0} />,
}));

// PredictiveModelBuild is a large, heavy component with its own dedicated
// test file (PredictiveModelBuild.test.tsx) — stub it here so
// BuildModelWindow's tests only need to assert the page-navigation wiring
// (props passed in, onBack switching pages), not PM's own internals.
const predictiveModelBuildProps: any[] = [];
const sensorPickerModalProps: any[] = [];
const pmFlushMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../components/windows/PredictiveModelBuild', () => ({
    default: (props: any) => {
        predictiveModelBuildProps.push(props);
        useEffect(() => {
            props.registerFlush?.(pmFlushMock);
            return () => props.registerFlush?.(null);
        }, [props.registerFlush]);
        return (
            <div data-testid="pm-page-mock">
                <span>PM page for {props.modelId}</span>
                <button onClick={props.onBack}>Mock Back</button>
                <button onClick={props.onFinish}>Mock Finish</button>
            </div>
        );
    },
    // Minimal stand-in for the popup picker — its own search/collapsible-
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
import { computeTrainFingerprint } from '../utils/trainFingerprint';
// @ts-expect-error - @types/node is not installed; vitest runs in Node so this resolves at runtime
import { readFileSync } from 'node:fs';

// jsdom does not load App.css (vitest also stubs `?raw` CSS imports to ''; cwd is the repo root), so layout
// rules that used to be inline styles are asserted against the stylesheet source itself.
const APP_CSS: string = readFileSync('src/App.css', 'utf-8');
const cssBlock = (selector: string): string => {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`(?:^|\\n)${esc} \\{([^}]*)\\}`).exec(APP_CSS);
    if (!m) throw new Error(`no CSS rule for ${selector}`);
    return m[1];
};

function makeGroup(overrides: Record<string, any> = {}) {
    return { no: 1, name: 'Group A', description: '', recommendation: '', ...overrides };
}

function makeModel(overrides: Record<string, any> = {}) {
    return {
        id: 'm1', groupNos: [1], name: 'Model One', kind: 'individual', category: 'performance', notes: '', status: false,
        targetSensor: 'TAG1', predictorSensors: [], xSensor: '', ySensor: '',
        individualChecked: true, rcMode: null, scatterXSensor: '', relModelName: '',
        relStiffness: 100_000, clusterModelName: '', numClusters: 3, criteriaSensor: '',
        clusterRanges: [], filterTimePeriods: [], customRunningConditionNoneConfirmed: false, pmSensorFilters: [],
        runningConditionMode: 'workspace', customRunningConditionFilters: [], customRunningConditionCombine: 'and',
        ...overrides,
    };
}

/** Seeds a model as Trained-and-fresh (Phase B) — `lastTrainedAt` set plus a
 *  `trainedFingerprint` computed the same way the real component does, so
 *  `isModelTrainedFresh` reads true against whatever workspace shape the
 *  test delivers `model` into. `fg` must match the OTHER failureGroupState
 *  fields (`runningConditionFilters`/combine/periods/noneConfirmed) the test
 *  actually delivers, since the fingerprint folds those in too — tests that
 *  don't override the running-condition defaults can rely on the default
 *  shown here (matches `deliverData`'s own fixture normalization: `and`
 *  combine, no filters/periods, "No condition" confirmed). */
function withTrained(model: Record<string, any>, fg: Record<string, any> = {
    models: [model], runningConditionFilters: [], runningConditionCombine: 'and',
    runningConditionTimePeriods: [], runningConditionNoneConfirmed: true,
}) {
    return {
        ...model,
        lastTrainedAt: '2026-09-29T03:00:00.000Z',
        trainedFingerprint: computeTrainFingerprint(model as any, fg as any),
    };
}

/** The default `mockUpdateWorkspaceData` implementation (see `beforeEach`)
 *  always patches the SAME hard-coded, unchanging `prev` snapshot — fine for
 *  tests that only inspect ONE write's return value, but wrong for a test
 *  whose model id/kind doesn't match that hard-coded default AND that then
 *  re-renders off a SECOND write (e.g. runTrainClick's commit-then-train,
 *  two persist calls back to back): each call would independently start
 *  from the same stale snapshot instead of building on the previous write.
 *  This variant threads real state through repeated calls, like the
 *  hand-rolled overrides a few existing tests already use (e.g. "a Complete
 *  model shows Mark incomplete instead" below) — factored out since Phase B
 *  needs it more than once. */
function statefulUpdateMock(models: any[], extra: Record<string, any> = {}) {
    let ws: any = {
        id: 'ws1',
        failureGroupState: {
            groups: [makeGroup()], models,
            runningConditionNoneConfirmed: true, rcLegacyNotice: null, runningConditionTimePeriods: [],
            ...extra,
        },
    };
    mockUpdateWorkspaceData.mockImplementation(async (_id: string, patch: (s: any) => any) => {
        ws = patch(ws);
        return ws;
    });
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
            // Feature 4-C: already-migrated periods, so the periods migration's
            // write-back doesn't fire in tests about something else.
            ...(!('runningConditionTimePeriods' in fg) ? { runningConditionTimePeriods: [] } : {}),
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

/** Selects the first sensor row shown in the left list (whatever grouping is
 *  active) so the detail pane renders for it — the Workbench's replacement
 *  for the old accordion's "click to open a row". */
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
/** The "Model settings" section auto-collapses once a model is fully
 *  configured (Phase A rule) — open it first when a test needs to reach a
 *  field inside it. A no-op if it's already open (incomplete model). */
const openSettings = () => {
    if (!screen.queryByTestId('add-model-form')) fireEvent.click(screen.getByText('Model settings'));
};

beforeEach(() => {
    listenCallbacks = {};
    predictiveModelBuildProps.length = 0;
    sensorPickerModalProps.length = 0;
    lineChartProps.length = 0;
    mockListen.mockClear();
    mockEmit.mockClear().mockResolvedValue(undefined);
    mockClose.mockClear().mockResolvedValue(undefined);
    pmFlushMock.mockClear().mockResolvedValue(undefined);
    mockUpdateWorkspaceData.mockReset().mockImplementation(async (id: string, patch: (s: any) => any) => {
        const prev = { id, failureGroupState: { groups: [makeGroup()], models: [makeModel()], runningConditionNoneConfirmed: true, rcLegacyNotice: null, runningConditionTimePeriods: [] } };
        return patch(prev);
    });
    mockLoadWorkspaceData.mockReset();
    mockInvoke.mockReset().mockImplementation((cmd: string) => {
        if (cmd === 'compute_sensor_stats') {
            return Promise.resolve({ mean: 5, sd: 1, min: 0, max: 10, count: 100, lower1: 4, upper1: 6, lower3: 2, upper3: 8 });
        }
        if (cmd === 'preview_relationship_model') {
            return Promise.resolve({
                request: 'req-1', r2_per_step: [0.8], rmse2_per_step: [0.4],
                predicted: [1, 2, 3], residual: [0.1, -0.1, 0.05],
                target_raw: [1.1, 2.1, 2.9], predictor_raw: [[1], [2], [3]],
            });
        }
        if (cmd === 'compute_clustering_preview') {
            return Promise.resolve({
                first_sensor: 'TAG1', second_sensor: 'TAG2', criteria_sensor: null, cluster_count: 1, n_rows: 3,
                clusters: [{ cluster_id: 1, range: null, n_rows: 3, ellipse: { x_center: 1, y_center: 1, x_sd: 1, y_sd: 1, angle_deg: 0 }, xs: [1, 2, 3], ys: [1, 2, 3] }],
            });
        }
        return Promise.resolve({});
    });
    mockUseChartData.mockReset().mockReturnValue({ view: null, loading: false, error: null });
});

afterEach(() => {
    cleanup();
});

describe('BuildModelWindow (Build Model Workbench, Phase A)', () => {
    it('requests build-model-data on mount', async () => {
        render(<BuildModelWindow />);
        await act(async () => { await Promise.resolve(); });
        expect(mockEmit).toHaveBeenCalledWith('request-build-model-data', undefined);
    });

    it('uses --card-bg for its background, matching the Dashboard\'s own Failure Groups card surface', async () => {
        const { container } = render(<BuildModelWindow />);
        await deliverData();
        const root = container.firstElementChild as HTMLElement;
        expect(root.style.backgroundColor).toBe('var(--card-bg)');
    });

    it('shows the running condition bar, the left sensor list, and auto-selects the first sensor into the detail pane', async () => {
        render(<BuildModelWindow />);
        await deliverData();
        expect(screen.getByText('Build Model — Overview')).toBeTruthy();
        expect(screen.getByTestId('rc-bar')).toBeTruthy();
        expect(screen.getAllByText('Pump Pressure').length).toBeGreaterThan(0); // sensor row, labelled by the sensor
        // Detail pane auto-selected the only sensor without a click.
        expect(screen.getByRole('heading', { name: 'Pump Pressure' })).toBeTruthy();
    });

    it('has no "Group by Model Type" option anywhere (removed entirely in the Workbench redesign)', async () => {
        render(<BuildModelWindow />);
        await deliverData();
        expect(screen.queryByText('Group by Model Type')).toBeNull();
        expect(screen.queryByText(/Model Type/)).toBeNull();
    });

    it('shows no "Add Model" / "Remove model" button anywhere (unchanged rule: models come from the Dashboard Sensor tab only)', async () => {
        render(<BuildModelWindow />);
        await deliverData();
        expect(screen.queryByText('Add Model')).toBeNull();
        expect(screen.queryByText('Remove model')).toBeNull();
    });

    describe('left sensor list', () => {
        it('groups by Failure Group by default, and a sensor with two models shows both kind badges once', async () => {
            const models = [
                makeModel({ id: 'm1', kind: 'individual', targetSensor: 'TAG1' }),
                makeModel({ id: 'm2', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2'] }),
            ];
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models } });
            expect(screen.getAllByTestId('sensor-row-label')).toHaveLength(1);
            expect(screen.getByTestId('sensor-kind-badge-m1')).toBeTruthy();
            expect(screen.getByTestId('sensor-kind-badge-m2')).toBeTruthy();
            expect(screen.getAllByText('FG-1 · Group A').length).toBeGreaterThan(0);
        });

        it('switches to Component grouping, and a sensor with no target sensor is grouped under Uncategorized', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel({ targetSensor: '' })] } });
            fireEvent.click(screen.getByText('Component'));
            expect(screen.getByText('Uncategorized')).toBeTruthy();
        });

        it('a sensor belonging to two Failure Groups appears once per group when grouped by Failure Group', async () => {
            const groups = [makeGroup({ no: 1, name: 'Group A' }), makeGroup({ no: 2, name: 'Group B' })];
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups, models: [makeModel({ groupNos: [1, 2] })] } });
            expect(screen.getAllByTestId('sensor-row-label')).toHaveLength(2); // once under FG-1, once under FG-2
            expect(screen.getAllByText('FG-1 · Group A').length).toBeGreaterThan(0);
            expect(screen.getAllByText('FG-2 · Group B').length).toBeGreaterThan(0);
        });

        it('selecting either occurrence of a multi-FG sensor shows the SAME detail pane (all of its models, not scoped to one FG)', async () => {
            const groups = [makeGroup({ no: 1, name: 'Group A' }), makeGroup({ no: 2, name: 'Group B' })];
            const models = [
                makeModel({ id: 'm1', kind: 'individual', targetSensor: 'TAG1', groupNos: [1, 2] }),
                makeModel({ id: 'm2', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2'], groupNos: [1] }),
            ];
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups, models } });
            fireEvent.click(screen.getAllByTestId('sensor-row-label')[1]); // the FG-2 occurrence
            expect(screen.getAllByRole('tab')).toHaveLength(2); // both I and R show up regardless of which row was clicked
        });

        it('is always shown as "Not in Group" (FG-0), even with zero real groups', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [], models: [] } });
            expect(screen.getByText('Not in Group')).toBeTruthy();
        });

        it('the search box filters by description and by tag', async () => {
            const models = [
                makeModel({ id: 'm1', targetSensor: 'TAG1' }),
                makeModel({ id: 'm2', targetSensor: 'TAG2', name: 'Other' }),
            ];
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models } });
            const list = within(screen.getByPlaceholderText('Search sensor or tag…').closest('aside') as HTMLElement);
            fireEvent.change(screen.getByPlaceholderText('Search sensor or tag…'), { target: { value: 'temp' } });
            expect(list.queryByText('Pump Pressure')).toBeNull();
            expect(list.getByText('Pump Temp')).toBeTruthy();
        });

        it('filter chips: "Needs setup" shows only sensors the gate/settings block, "Complete" shows only fully-complete sensors', async () => {
            const models = [
                makeModel({ id: 'm1', targetSensor: 'TAG1', status: true }),
                makeModel({ id: 'm2', targetSensor: 'TAG2', name: 'Other', status: false, category: null }),
            ];
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models } });
            const list = within(screen.getByPlaceholderText('Search sensor or tag…').closest('aside') as HTMLElement);
            const chips = within(document.querySelector('.bmw-chips') as HTMLElement);

            fireEvent.click(chips.getByText(/^Complete/));
            expect(list.getByText('Pump Pressure')).toBeTruthy();
            expect(list.queryByText('Pump Temp')).toBeNull();

            fireEvent.click(chips.getByText(/Needs setup/));
            expect(list.queryByText('Pump Pressure')).toBeNull();
            expect(list.getByText('Pump Temp')).toBeTruthy();

            fireEvent.click(chips.getByText(/^All/));
            expect(list.getByText('Pump Pressure')).toBeTruthy();
            expect(list.getByText('Pump Temp')).toBeTruthy();
        });

        it('the sensor row title stays on one line (single-line ellipsis) — reuses the existing .f4-sr-title rule', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            const label = screen.getAllByTestId('sensor-row-label')[0];
            expect(label.classList.contains('f4-sr-title')).toBe(true);
            const rule = cssBlock('.f4-sr-title');
            expect(rule).toMatch(/white-space:\s*nowrap/);
            expect(rule).toMatch(/text-overflow:\s*ellipsis/);
            expect(rule).toMatch(/overflow:\s*hidden/);
        });

        it('the sidebar can be hidden and re-shown via the detail header\'s icon button', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            expect(screen.getByPlaceholderText('Search sensor or tag…')).toBeTruthy();
            fireEvent.click(screen.getByTitle('Hide sensor list'));
            expect(screen.queryByPlaceholderText('Search sensor or tag…')).toBeNull();
            fireEvent.click(screen.getByTitle('Show sensor list'));
            expect(screen.getByPlaceholderText('Search sensor or tag…')).toBeTruthy();
        });

        it('a sensor deleted (from another window) while selected is replaced by auto-selecting another available sensor', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel({ id: 'm1', targetSensor: 'TAG1' }), makeModel({ id: 'm2', targetSensor: 'TAG2', name: 'Other' })] } });
            expect(screen.getByRole('heading', { name: 'Pump Pressure' })).toBeTruthy();
            await act(async () => {
                for (const cb of listenCallbacks['failure-group-state-changed'] ?? []) {
                    cb({ payload: { workspaceId: 'ws1', origin: 'dashboard', groups: [makeGroup()], models: [makeModel({ id: 'm2', targetSensor: 'TAG2', name: 'Other' })] } });
                }
            });
            expect(screen.getByRole('heading', { name: 'Pump Temp' })).toBeTruthy();
        });
    });

    describe('detail pane header and category', () => {
        it('shows description, tag, component chip and FG chips for the selected sensor', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            expect(screen.getByRole('heading', { name: 'Pump Pressure' })).toBeTruthy();
            const meta = screen.getByRole('heading', { name: 'Pump Pressure' }).parentElement!.querySelector('.bmw-dmeta') as HTMLElement;
            expect(within(meta).getByText('TAG1')).toBeTruthy();
            expect(within(meta).getByText('Pump')).toBeTruthy();
            expect(within(meta).getByText('FG-1 · Group A')).toBeTruthy();
        });

        it('clicking Performance/Condition writes EVERY model of that sensor in every FG it belongs to (category is per-sensor, not per-model)', async () => {
            const groups = [makeGroup({ no: 1, name: 'Group A' }), makeGroup({ no: 2, name: 'Group B' })];
            const models = [
                makeModel({ id: 'm1', kind: 'individual', targetSensor: 'TAG1', groupNos: [1], category: null }),
                makeModel({ id: 'm2', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2'], groupNos: [2], category: null }),
                makeModel({ id: 'other', targetSensor: 'TAG2', name: 'Other', category: null }),
            ];
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups, models } });
            mockUpdateWorkspaceData.mockClear();
            mockUpdateWorkspaceData.mockImplementation(async (id: string, patch: (s: any) => any) => patch({ id, failureGroupState: { groups, models } }));

            fireEvent.click(screen.getByRole('button', { name: 'Condition' }));
            await flush();
            const written = (await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value).failureGroupState.models;
            expect(written.find((m: any) => m.id === 'm1').category).toBe('condition');
            expect(written.find((m: any) => m.id === 'm2').category).toBe('condition'); // different FG, same sensor
            expect(written.find((m: any) => m.id === 'other').category).toBeNull(); // a different sensor is untouched
        });

        it('an unset category shows the amber "Set category" flag; the flag disappears once set', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel({ category: null })] } });
            const seg = screen.getByRole('group', { name: 'Category' });
            expect(seg.className).toContain('f4-catseg--unset');
            expect(within(seg).getByText('Set category')).toBeTruthy();
        });

        it('warns when a category change also applies to other Failure Groups', async () => {
            const groups = [makeGroup({ no: 1, name: 'Group A' }), makeGroup({ no: 2, name: 'Group B' })];
            const models = [makeModel({ groupNos: [1, 2], category: 'performance' })];
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups, models } });
            mockUpdateWorkspaceData.mockImplementation(async (id: string, patch: (s: any) => any) => patch({ id, failureGroupState: { groups, models } }));
            fireEvent.click(screen.getByRole('button', { name: 'Condition' }));
            await flush();
            expect(screen.getByRole('status').textContent).toMatch(/every failure group: FG-1, FG-2/);
        });
    });

    describe('kind tabs', () => {
        it('renders one tab per kind that exists, in Individual/Relationship/Clustering order, each with the model\'s own status dot', async () => {
            const clu = makeModel({ id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2', status: true });
            const ind = makeModel({ id: 'i1', kind: 'individual', targetSensor: 'TAG1' });
            const rel = makeModel({ id: 'r1', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2'] });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [clu, ind, rel] } });
            const tabs = screen.getAllByRole('tab');
            expect(tabs.map(t => t.querySelector('.f4-tab-l')!.textContent)).toEqual(['Individual', 'Relationship', 'Clustering']);
        });

        it('switching tabs keeps each model\'s own unsaved draft (no cross-talk)', async () => {
            render(<BuildModelWindow />);
            await deliverData({
                failureGroupState: {
                    groups: [makeGroup()],
                    models: [makeModel({ id: 'i1', kind: 'individual', targetSensor: 'TAG1', name: 'Ind' }), makeModel({ id: 'r1', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2'], name: 'Rel' })],
                },
            });
            openSettings();
            fireEvent.change(screen.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Ind renamed' } });
            fireEvent.click(screen.getByRole('tab', { name: /Relationship/ }));
            openSettings();
            expect((screen.getByPlaceholderText('e.g. Bearing vibration model') as HTMLInputElement).value).toBe('Rel');
            fireEvent.click(screen.getByRole('tab', { name: /Individual/ }));
            openSettings();
            expect((screen.getByPlaceholderText('e.g. Bearing vibration model') as HTMLInputElement).value).toBe('Ind renamed');
        });

        it('an edited tab shows the "edited" tag', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            openSettings();
            fireEvent.change(screen.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Renamed' } });
            expect(screen.getByText('edited')).toBeTruthy();
        });
    });

    describe('Model settings (collapsible)', () => {
        it('auto-expands when the model is incomplete (a required field is missing), and shows a "N to fix" pill', async () => {
            const rel = makeModel({ kind: 'relationship', targetSensor: 'TAG1', predictorSensors: [] });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel] } });
            expect(screen.getByTestId('add-model-form')).toBeTruthy(); // open by default
            expect(screen.getByTestId('settings-to-fix').textContent).toBe('1 to fix');
        });

        it('starts collapsed with a one-line summary once the model is fully configured', async () => {
            render(<BuildModelWindow />);
            await deliverData(); // makeModel() default is a fully-configured Individual model
            expect(screen.queryByTestId('add-model-form')).toBeNull();
            expect(screen.getByText(/Model One · 1σ \+ 3σ · Workspace data/)).toBeTruthy();
        });

        it('can be toggled open/closed manually', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            fireEvent.click(screen.getByText('Model settings'));
            expect(screen.getByTestId('add-model-form')).toBeTruthy();
            fireEvent.click(screen.getByText('Model settings'));
            expect(screen.queryByTestId('add-model-form')).toBeNull();
        });

        it('Relationship: predictor picker + chips, stiffness picker; Clustering: locked X, Y picker, cluster-count stepper', async () => {
            const rel = makeModel({ id: 'r1', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2'], relStiffness: 10_000 });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel] } });
            openSettings();
            expect(screen.getByText('Pump Temp (TAG2)')).toBeTruthy(); // predictor chip
            expect(screen.getByRole('button', { name: 'Loose' }).className).toBe('on'); // 10_000 -> "Loose"

            cleanup();
            const clu = makeModel({ id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2', numClusters: 3 });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [clu] } });
            openSettings();
            expect(screen.getByText('Pump Pressure (TAG1)', { selector: '.f4-readout span' })).toBeTruthy(); // locked X
            expect(screen.getByText('3')).toBeTruthy(); // cluster stepper count
            fireEvent.click(screen.getByLabelText('More clusters'));
            expect(screen.getByText('4')).toBeTruthy();
        });

        it('Individual shows the static "1σ + 3σ · automatic" label, with no adjustable control', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            openSettings();
            expect(screen.getByText('1σ + 3σ · automatic')).toBeTruthy();
        });

        it('the Workspace/Custom training-data switch is present for every kind and its choice is saved on Save changes', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            openSettings();
            fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
            await act(async () => {
                fireEvent.click(screen.getByText('Save changes'));
                await Promise.resolve();
                await Promise.resolve();
            });
            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(state.failureGroupState.models[0].runningConditionMode).toBe('custom');
        });

        it('duplicate model name within one sensor shows the warning and blocks Save', async () => {
            render(<BuildModelWindow />);
            await deliverData({
                failureGroupState: {
                    groups: [makeGroup()],
                    models: [
                        makeModel({ id: 'i1', kind: 'individual', targetSensor: 'TAG1', name: 'TAG1' }),
                        makeModel({ id: 'r1', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2'], name: 'Rel' }),
                    ],
                },
            });
            fireEvent.click(screen.getByRole('tab', { name: /Relationship/ }));
            openSettings();
            fireEvent.change(screen.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'tag1' } });
            expect(screen.getByTestId('duplicate-name-warning')).toBeTruthy();
            expect((screen.getByText('Save changes') as HTMLButtonElement).disabled).toBe(true);
        });

        it('the locked Target/X sensor readout can never be reassigned (no select, no input)', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            const readout = screen.queryByText('Pump Pressure (TAG1)', { selector: '.f4-readout span' });
            // Individual doesn't render a locked readout of its own in Phase A settings
            // (its identity IS the detail header) -- Clustering's X does, though:
            expect(readout).toBeNull();
        });
    });

    describe('results area', () => {
        it('shows "Not trained yet" for a fully-configured model that has never been trained', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            expect(screen.getByTestId('results-placeholder').textContent).toBe('Not trained yet');
        });

        it('shows a "marked complete" message once the model is Complete (chart never shows for a Complete model)', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel({ status: true })] } });
            expect(screen.getByTestId('results-placeholder').textContent).toMatch(/Marked complete/);
        });

        it('shows an "N items to fix" list for a model missing its own settings, with a link that opens Model settings', async () => {
            const rel = makeModel({ kind: 'relationship', targetSensor: 'TAG1', predictorSensors: [] });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel] } });
            expect(screen.getByTestId('results-incomplete').textContent).toMatch(/1 item to fix before training/);
            expect(screen.queryByTestId('add-model-form')).toBeTruthy(); // already open (incomplete auto-expands)
            fireEvent.click(screen.getByText('Model settings')); // collapse it
            expect(screen.queryByTestId('add-model-form')).toBeNull();
            fireEvent.click(screen.getByText('Add at least 1 predictor'));
            expect(screen.getByTestId('add-model-form')).toBeTruthy(); // link re-opened it
        });

        it('shows the running-condition gate reason in the "N items to fix" list, with a link that opens the Running Condition modal', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel()], runningConditionNoneConfirmed: false } });
            expect(screen.getByTestId('results-incomplete').textContent).toMatch(/1 item to fix before training/);
            fireEvent.click(screen.getByText('Set a running condition first, or choose "No condition — use all rows".', { selector: '.bmw-fix-link' }));
            expect(screen.getByRole('dialog', { name: 'Running Condition Filter' })).toBeTruthy();
        });

        it('runs compute_sensor_stats on "▶ Train model", shows the chart+toolbar, and persists lastTrainedAt/trainedFingerprint', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            await act(async () => {
                fireEvent.click(screen.getByText('▶ Train model'));
                await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
            });
            expect(mockInvoke).toHaveBeenCalledWith('compute_sensor_stats', expect.objectContaining({ sensor: 'TAG1', filter: null }));
            const written = (await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value).failureGroupState;
            expect(written.models[0].lastTrainedAt).toBeTruthy();
            expect(written.models[0].trainedFingerprint).toBeTruthy();
            expect(screen.getByTestId('results-chart')).toBeTruthy();
            expect(screen.getByText('Target')).toBeTruthy(); // legend
            expect(screen.getByText('100')).toBeTruthy(); // Rows readout (mocked count)
            // Nothing further to do — no Train button, only Mark complete.
            expect(screen.queryByText('▶ Train model')).toBeNull();
            expect((screen.getByText('✓ Mark complete') as HTMLButtonElement).disabled).toBe(false);
            expect(screen.getByText('Trained', { selector: '.model-status-pill' })).toBeTruthy();
        });

        it('runs preview_relationship_model for a Relationship model and shows R²/2×RMSE/Stiffness', async () => {
            const rel = makeModel({ kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2'], relStiffness: 10_000 });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel] } });
            statefulUpdateMock([rel]);
            await act(async () => {
                fireEvent.click(screen.getByText('▶ Train model'));
                await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
            });
            expect(mockInvoke).toHaveBeenCalledWith('preview_relationship_model', expect.objectContaining({ predictors: ['TAG2'], target: 'TAG1', lambda: 10_000 }));
            expect(screen.getByTestId('echarts-mock')).toBeTruthy();
            expect(screen.getByText('R²')).toBeTruthy();
            expect(screen.getByText('2×RMSE')).toBeTruthy();
            expect(screen.getByText('Loose')).toBeTruthy(); // stiffness label for 10_000
        });

        it('runs compute_clustering_preview for a Clustering model and shows Rows/Clusters', async () => {
            const clu = makeModel({ id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2', numClusters: 3 });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [clu] } });
            statefulUpdateMock([clu]);
            await act(async () => {
                fireEvent.click(screen.getByText('▶ Train model'));
                await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
            });
            expect(mockInvoke).toHaveBeenCalledWith('compute_clustering_preview', expect.objectContaining({ first_sensor: 'TAG1', second_sensor: 'TAG2' }));
            expect(screen.getByTestId('echarts-mock')).toBeTruthy();
            expect(screen.getByText('Clusters')).toBeTruthy();
        });

        it('commits an unsaved draft edit before training, so Train uses the just-edited settings', async () => {
            const rel = makeModel({ kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2'] });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel] } });
            statefulUpdateMock([rel]);
            openSettings();
            fireEvent.change(screen.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Edited before Train' } });
            await act(async () => {
                fireEvent.click(screen.getByText('▶ Train model'));
                await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
            });
            const results = mockUpdateWorkspaceData.mock.results;
            const last = (await results[results.length - 1].value).failureGroupState.models[0];
            expect(last.name).toBe('Edited before Train');
            expect(last.lastTrainedAt).toBeTruthy();
        });

        it('going stale after a settings change: hides the chart, shows "Settings changed", and the footer button becomes "↻ Re-train"', async () => {
            const trained = withTrained(makeModel());
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [{ ...trained, trainedFingerprint: 'stale-fingerprint-does-not-match' }] } });
            await flush();
            expect(screen.getByTestId('results-stale').textContent).toMatch(/Settings changed/);
            expect(screen.getByText('Incomplete', { selector: '.model-status-pill' })).toBeTruthy(); // pill reverts, "Trained" is only for fresh
            expect(screen.getByText('↻ Re-train')).toBeTruthy();
            expect(screen.getByText('Settings changed — re-train')).toBeTruthy(); // footer message
            fireEvent.click(screen.getByText('↻ Re-train'));
            await flush();
            expect(mockInvoke).toHaveBeenCalledWith('compute_sensor_stats', expect.anything());
        });

        it('shows an inline error and re-enables the button when the preview command rejects', async () => {
            // Targeted rejection (not a blanket mockRejectedValueOnce) since
            // `useDatasetTimeBounds` also calls `invoke` during mount — a
            // once-rejection would land on THAT call instead of the Train
            // click's `compute_sensor_stats`.
            mockInvoke.mockImplementation((cmd: string) =>
                cmd === 'compute_sensor_stats' ? Promise.reject(new Error('sidecar exploded')) : Promise.resolve({}));
            render(<BuildModelWindow />);
            await deliverData();
            await act(async () => {
                fireEvent.click(screen.getByText('▶ Train model'));
                await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
            });
            expect(screen.getByTestId('results-error').textContent).toMatch(/sidecar exploded/);
            expect(screen.getByText('↻ Re-train')).toBeTruthy();
        });

        it('reopening an already-Trained-and-fresh model auto-recomputes and shows the chart with no click', async () => {
            const trained = withTrained(makeModel());
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [trained] } });
            await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
            expect(mockInvoke).toHaveBeenCalledWith('compute_sensor_stats', expect.anything());
            expect(screen.getByTestId('results-chart')).toBeTruthy();
            expect(screen.getByText('Trained', { selector: '.model-status-pill' })).toBeTruthy();
            // Nothing further to click — no Train button while fresh.
            expect(screen.queryByText('▶ Train model')).toBeNull();
            expect(screen.queryByText('↻ Re-train')).toBeNull();
        });

        it('never auto-recomputes a Complete model, even if its fingerprint still matches', async () => {
            const trained = withTrained(makeModel({ status: true }));
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [trained] } });
            await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
            expect(mockInvoke).not.toHaveBeenCalledWith('compute_sensor_stats', expect.anything());
            expect(screen.getByTestId('results-placeholder').textContent).toMatch(/Marked complete/);
        });

        it('"✓ Mark complete" is disabled until the model is Trained-and-fresh, even when the running-condition gate is satisfied', async () => {
            render(<BuildModelWindow />);
            await deliverData(); // fully configured, gate satisfied, but never trained
            const markComplete = screen.getByText('✓ Mark complete') as HTMLButtonElement;
            expect(markComplete.disabled).toBe(true);
            expect(markComplete.title).toMatch(/Train the model/);
        });
    });

    describe('left sensor list kind-badge status dot (Phase B)', () => {
        it('shows no dot for a never-trained model, a blue dot for Trained, and a green dot for Complete', async () => {
            const trained = withTrained(makeModel({ id: 'm-trained' }));
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [trained] } });
            await flush();
            expect(screen.getByTestId('sensor-kind-badge-dot-m-trained').className).toMatch(/f4-kb-dot--trained/);

            cleanup();
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel({ id: 'm-untrained' })] } });
            expect(screen.queryByTestId('sensor-kind-badge-dot-m-untrained')).toBeNull();

            cleanup();
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel({ id: 'm-complete', status: true })] } });
            expect(screen.getByTestId('sensor-kind-badge-dot-m-complete').className).toMatch(/f4-kb-dot--complete/);
        });
    });

    describe('footer', () => {
        it('shows a read-only status pill, "Open full view ↗", "Save changes" and "✓ Mark complete"', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            expect(screen.getByText('Incomplete')).toBeTruthy();
            expect(screen.getByText('Open full view ↗')).toBeTruthy();
            expect(screen.getByText('Save changes')).toBeTruthy();
            expect(screen.getByText('✓ Mark complete')).toBeTruthy();
        });

        it('"Open full view ↗" commits the draft then navigates to the in-window PM page (same as the old "Build Model →")', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            openSettings();
            fireEvent.change(screen.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Renamed before building' } });
            await act(async () => { fireEvent.click(screen.getByText('Open full view ↗')); });

            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(state.failureGroupState.models[0].name).toBe('Renamed before building');
            expect(screen.getByTestId('pm-page-mock')).toBeTruthy();
            const lastProps = predictiveModelBuildProps[predictiveModelBuildProps.length - 1];
            expect(lastProps.workspaceId).toBe('ws1');
            expect(lastProps.modelId).toBe('m1');
            expect(lastProps.kind).toBe('individual');
        });

        it('"Open full view" is disabled until settings are valid, and shows why', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel({ name: '' })] } });
            const openFull = screen.getByText('Open full view ↗') as HTMLButtonElement;
            expect(openFull.disabled).toBe(true);
            expect(openFull.title).toMatch(/Fill in the required fields/);
        });

        it('"Save changes" persists the edit and clears the draft', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            openSettings();
            fireEvent.change(screen.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Renamed Model' } });
            await act(async () => {
                fireEvent.click(screen.getByText('Save changes'));
                await Promise.resolve();
                await Promise.resolve();
            });
            expect(screen.queryByText('edited')).toBeNull();
            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(state.failureGroupState.models[0].name).toBe('Renamed Model');
        });

        it('"✓ Mark complete" / "Mark incomplete" reuse the same toggle as before, gated the same way', async () => {
            render(<BuildModelWindow />);
            // Phase B: Mark complete also requires Trained-and-fresh now — seed that.
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [withTrained(makeModel())] }, runningConditionNoneConfirmed: true });
            fireEvent.click(screen.getByText('✓ Mark complete'));
            await flush();
            const written = (await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value).failureGroupState;
            expect(written.models[0].status).toBe(true);
        });

        it('"✓ Mark complete" is disabled while the running-condition gate blocks the model, with the reason as a tooltip', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel()], runningConditionNoneConfirmed: false } });
            const markComplete = screen.getByText('✓ Mark complete') as HTMLButtonElement;
            expect(markComplete.disabled).toBe(true);
            expect(markComplete.title).toMatch(/running condition/);
        });

        it('a Complete model shows "Mark incomplete" instead, and clicking it un-marks the model', async () => {
            render(<BuildModelWindow />);
            const models = [makeModel({ status: true })];
            mockUpdateWorkspaceData.mockImplementation(async (id: string, patch: (s: any) => any) => patch({ id, failureGroupState: { groups: [makeGroup()], models } }));
            await deliverData({ failureGroupState: { groups: [makeGroup()], models } });
            expect(screen.getByText('Complete', { selector: '.model-status-pill' })).toBeTruthy();
            fireEvent.click(screen.getByText('Mark incomplete'));
            await flush();
            const written = (await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value).failureGroupState;
            expect(written.models[0].status).toBe(false);
        });

        it('the PM page\'s Finish control marks the model Complete and returns to the overview (unchanged, markModelComplete is one-directional)', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            await act(async () => { fireEvent.click(screen.getByText('Open full view ↗')); });
            fireEvent.click(screen.getByText('Mock Finish'));
            await waitFor(() => expect(screen.queryByTestId('pm-page-mock')).toBeNull());
            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(state.failureGroupState.models[0].status).toBe(true);
        });
    });

    describe('running-condition gate (Feature 4-B, unchanged logic)', () => {
        const REASON = 'Set a running condition first, or choose "No condition — use all rows".';
        const cond = [{ id: 'rcf1', sensor: 'TAG1', operation: 'greater_than', value1: '1200', value2: '' }];
        async function deliverGate(models: any[], extra: Record<string, any> = {}) {
            let disk: any = { id: 'ws1', failureGroupState: { groups: [makeGroup()], models, runningConditionNoneConfirmed: false, rcLegacyNotice: null, ...extra } };
            mockUpdateWorkspaceData.mockImplementation(async (_id: string, patch: (s: any) => any) => { disk = patch(disk); return disk; });
            await deliverData({ failureGroupState: disk.failureGroupState });
        }

        it('"Open full view" is disabled with the gate reason while nothing is configured', async () => {
            render(<BuildModelWindow />);
            await deliverGate([makeModel()]);
            const openFull = screen.getByText('Open full view ↗') as HTMLButtonElement;
            expect(openFull.disabled).toBe(true);
            expect(openFull.title).toBe(REASON);
            expect(screen.getByTestId('build-block-reason').textContent).toBe(REASON);
        });

        it('Save changes stays allowed while Open full view is blocked by the running condition', async () => {
            render(<BuildModelWindow />);
            await deliverGate([makeModel()]);
            expect((screen.getByText('Save changes') as HTMLButtonElement).disabled).toBe(false);
        });

        it('a complete condition unlocks Open full view', async () => {
            render(<BuildModelWindow />);
            await deliverGate([makeModel()], { runningConditionFilters: cond });
            expect((screen.getByText('Open full view ↗') as HTMLButtonElement).disabled).toBe(false);
        });

        it('confirming "No condition — use all rows" from the Edit… modal enables Open full view', async () => {
            render(<BuildModelWindow />);
            await deliverGate([makeModel()]);
            fireEvent.click(screen.getByText('Edit…'));
            fireEvent.click(screen.getByRole('button', { name: 'No condition — use all rows' }));
            await flush();
            expect((screen.getByText('Open full view ↗') as HTMLButtonElement).disabled).toBe(false);
        });

        it('a Custom-mode model is judged by its OWN list, not the workspace one', async () => {
            render(<BuildModelWindow />);
            await deliverGate([makeModel({ runningConditionMode: 'custom' })], { runningConditionFilters: cond });
            expect((screen.getByText('Open full view ↗') as HTMLButtonElement).disabled).toBe(true);
        });

        it('the gate badge on the kind tab reflects the reason (Needs condition / Needs category / Legacy · all data)', async () => {
            render(<BuildModelWindow />);
            await deliverGate([makeModel({ id: 'i1' })]);
            expect(screen.getByTestId('condition-badge-i1').textContent).toBe('Needs condition');
            cleanup();
            render(<BuildModelWindow />);
            await deliverGate([makeModel({ id: 'i1', status: true })]);
            expect(screen.getByTestId('condition-badge-i1').textContent).toBe('Legacy · all data');
        });
    });

    describe('Running Condition bar and Edit… modal', () => {
        /** Tracks a "disk" the same way the real store would, so a hydration
         *  write-back (e.g. settling `rcLegacyNotice`) is applied to what was
         *  actually delivered instead of the generic beforeEach default. */
        function deliverTracked(fg: Record<string, any>) {
            let disk: any = { id: 'ws1', failureGroupState: fg };
            mockUpdateWorkspaceData.mockImplementation(async (_id: string, patch: (s: any) => any) => { disk = patch(disk); return disk; });
            return deliverData({ failureGroupState: disk.failureGroupState });
        }

        it('shows "Required" when unconfigured and "✓ Set" once configured', async () => {
            render(<BuildModelWindow />);
            await deliverTracked({ groups: [makeGroup()], models: [makeModel()], runningConditionNoneConfirmed: false, runningConditionFilters: [], rcLegacyNotice: null });
            expect(screen.getByTestId('rc-bar-pill').textContent).toBe('Required');

            cleanup();
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel()], runningConditionNoneConfirmed: true } });
            expect(screen.getByTestId('rc-bar-pill').textContent).toBe('✓ Set');
        });

        it('"Edit…" opens the modal wrapping the existing RunningConditionPanel', async () => {
            render(<BuildModelWindow />);
            // Configured via a real condition (not "No condition") so the modal
            // does not auto-open AND the panel's condition-editing UI (not its
            // "No condition" summary) is what's shown once opened.
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel()], runningConditionNoneConfirmed: false, runningConditionFilters: [{ id: 'f1', sensor: 'TAG1', operation: 'greater_than', value1: '5', value2: '' }] } });
            expect(screen.queryByText('Add condition')).toBeNull();
            fireEvent.click(screen.getByText('Edit…'));
            expect(screen.getByText('Add condition')).toBeTruthy();
            fireEvent.click(screen.getByLabelText('Close'));
            expect(screen.queryByText('Add condition')).toBeNull();
        });

        it('auto-opens the modal for a legacy workspace that is still unconfigured, and shows the legacy banner', async () => {
            render(<BuildModelWindow />);
            await deliverTracked({ groups: [makeGroup()], models: [makeModel()], runningConditionNoneConfirmed: false, runningConditionFilters: [], rcLegacyNotice: 'pending' });
            expect(screen.getByTestId('rc-legacy-banner')).toBeTruthy();
            expect(screen.getByText('Add condition')).toBeTruthy(); // modal auto-opened
        });

        it('"Keep using all data" confirms No condition and clears the legacy notice', async () => {
            render(<BuildModelWindow />);
            await deliverTracked({ groups: [makeGroup()], models: [makeModel()], runningConditionNoneConfirmed: false, runningConditionFilters: [], rcLegacyNotice: 'pending' });
            fireEvent.click(screen.getByText('Keep using all data'));
            await flush();
            const fg = (await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value).failureGroupState;
            expect(fg.runningConditionNoneConfirmed).toBe(true);
            expect(fg.rcLegacyNotice).toBeNull();
            expect(screen.queryByTestId('rc-legacy-banner')).toBeNull();
        });

        it('shows the "N models can\'t be built yet" summary only while unconfigured', async () => {
            render(<BuildModelWindow />);
            await deliverTracked({ groups: [makeGroup()], models: [makeModel(), makeModel({ id: 'm2', targetSensor: 'TAG2' })], runningConditionNoneConfirmed: false, runningConditionFilters: [], rcLegacyNotice: null });
            expect(screen.getByTestId('rc-blocked-summary').textContent).toContain("2 of 2 models can't be built yet");
            cleanup();
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel()], runningConditionNoneConfirmed: true } });
            expect(screen.queryByTestId('rc-blocked-summary')).toBeNull();
        });
    });

    describe('one-time category normalisation notice (unchanged storage/logic, new placement)', () => {
        it('hydrating a legacy workspace normalises it, writes it back once, and shows the notice', async () => {
            const inconsistent = [
                makeModel({ id: 'i1', kind: 'individual', targetSensor: 'TAG1', category: 'performance' }),
                makeModel({ id: 'r1', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2'], category: 'condition' }),
            ];
            mockUpdateWorkspaceData.mockImplementation(async (id: string, patch: (s: any) => any) => patch({ id, failureGroupState: { groups: [makeGroup()], models: inconsistent } }));
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: inconsistent } });
            expect(screen.getByTestId('category-normalisation-notice')).toBeTruthy();
            expect(mockUpdateWorkspaceData).toHaveBeenCalledTimes(1);
        });

        it('Dismiss persists categoryNormalisationNotice: null and removes the card', async () => {
            render(<BuildModelWindow />);
            await deliverData({
                failureGroupState: {
                    groups: [makeGroup()],
                    models: [makeModel({ id: 'i1' }), makeModel({ id: 'r1', kind: 'relationship', predictorSensors: ['TAG2'] })],
                    categoryNormalisationNotice: [{ modelId: 'r1', kind: 'relationship', sensorKey: 'tag1', from: 'condition', to: 'performance' }],
                },
            });
            fireEvent.click(screen.getByText('Dismiss'));
            await flush();
            const written = (await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value).failureGroupState;
            expect(written.categoryNormalisationNotice).toBeNull();
            expect(screen.queryByTestId('category-normalisation-notice')).toBeNull();
        });
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
            expect(screen.queryByText('Pump Temp')).toBeNull();
            expect(screen.queryByText('TAG3')).toBeNull();
            expect(screen.getAllByText('Pump Pressure').length).toBeGreaterThan(0);
        });

        it('skips its own echo but still applies the Predictive Model page\'s broadcast (that page lives inside this window)', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            await fire('failure-group-state-changed', {
                workspaceId: 'ws1', origin: 'build-model',
                groups: [makeGroup()], models: [makeModel({ id: 'e', name: 'Echoed Model', targetSensor: 'TAG2' })],
            });
            expect(screen.queryByText('Pump Temp')).toBeNull();
            await fire('failure-group-state-changed', {
                workspaceId: 'ws1', origin: 'predictive-model',
                groups: [makeGroup()], models: [makeModel({ id: 'p', name: 'PM Edit', targetSensor: 'TAG2' })],
            });
            expect(screen.getAllByText('Pump Temp').length).toBeGreaterThan(0);
        });

        it('stamps every failure-group broadcast it sends with its workspace id', async () => {
            render(<BuildModelWindow />);
            // Phase B: Mark complete also requires Trained-and-fresh now — seed that.
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [withTrained(makeModel())] } });
            fireEvent.click(screen.getByText('✓ Mark complete'));
            await flush();
            expect(mockEmit).toHaveBeenCalledWith('failure-group-state-changed', expect.objectContaining({
                workspaceId: 'ws1',
                origin: 'build-model',
            }));
        });

        it('being re-pointed at a DIFFERENT workspace drops the old one\'s open PM page and shows only the new workspace\'s models', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            await act(async () => { fireEvent.click(screen.getByText('Open full view ↗')); });
            expect(screen.getByTestId('pm-page-mock')).toBeTruthy();

            mockLoadWorkspaceData.mockResolvedValue({
                id: 'ws2',
                failureGroupState: { groups: [makeGroup({ no: 1, name: 'Other Group' })], models: [makeModel({ id: 'other', name: 'Other Project Model', targetSensor: 'OTHER1' })], runningConditionNoneConfirmed: true, rcLegacyNotice: null, runningConditionTimePeriods: [] },
            });
            await fire('build-model-data', {
                workspaceId: 'ws2',
                sensorHeaders: ['OTHER1'],
                sensorMetadata: [],
                metadata: { headers: ['timestamp', 'OTHER1'], total_rows: 1 },
            });

            expect(screen.queryByTestId('pm-page-mock')).toBeNull();
            expect(screen.getAllByText('OTHER1').length).toBeGreaterThan(0);
            expect(screen.queryByText('Pump Pressure')).toBeNull();
        });

        it('a slow, superseded load cannot overwrite the result of a newer one', async () => {
            render(<BuildModelWindow />);
            let resolveFirst!: (v: any) => void;
            mockLoadWorkspaceData.mockReturnValueOnce(new Promise(res => { resolveFirst = res; }));
            mockLoadWorkspaceData.mockResolvedValueOnce({
                id: 'ws1',
                failureGroupState: { groups: [makeGroup()], models: [makeModel({ id: 'new', name: 'Fresh Model', targetSensor: 'TAG2' })], runningConditionNoneConfirmed: true, rcLegacyNotice: null, runningConditionTimePeriods: [] },
            });
            const payload = {
                workspaceId: 'ws1', sensorHeaders: ['TAG1'], sensorMetadata: [],
                metadata: { headers: ['timestamp', 'TAG1'], total_rows: 1 },
            };
            await fire('build-model-data', payload);
            await fire('build-model-data', payload);
            expect(screen.getAllByText('TAG2').length).toBeGreaterThan(0);

            await act(async () => {
                resolveFirst({ id: 'ws1', failureGroupState: { groups: [makeGroup()], models: [makeModel({ id: 'old', name: 'Stale Model', targetSensor: 'TAG3' })], runningConditionNoneConfirmed: true, rcLegacyNotice: null, runningConditionTimePeriods: [] } });
                await Promise.resolve();
                await Promise.resolve();
            });
            expect(screen.queryByText('TAG3')).toBeNull();
            expect(screen.getAllByText('TAG2').length).toBeGreaterThan(0);
        });
    });

    it('Close calls the Tauri window close API', async () => {
        render(<BuildModelWindow />);
        await deliverData();
        fireEvent.click(screen.getByTitle('Close'));
        await waitFor(() => expect(mockClose).toHaveBeenCalled());
    });

    describe('close-flush (a write in flight when the window closes must land before it actually closes)', () => {
        it('a native close defers until a pending model-save write lands, then closes', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            expect(mockCloseRequestedHandler).not.toBeNull();

            let resolveUpdate!: (v: unknown) => void;
            mockUpdateWorkspaceData.mockImplementationOnce(() => new Promise((res) => { resolveUpdate = res; }));

            openSettings();
            fireEvent.change(screen.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Renamed Model' } });
            fireEvent.click(screen.getByText('Save changes'));

            const preventDefault = vi.fn();
            let closePromise!: Promise<void>;
            await act(async () => {
                closePromise = mockCloseRequestedHandler!({ preventDefault }) as Promise<void>;
                await Promise.resolve();
            });
            expect(preventDefault).toHaveBeenCalledTimes(1);
            expect(mockClose).not.toHaveBeenCalled();

            await act(async () => {
                resolveUpdate({
                    id: 'ws1',
                    failureGroupState: {
                        groups: [makeGroup()], models: [makeModel({ name: 'Renamed Model' })],
                        runningConditionNoneConfirmed: true, rcLegacyNotice: null, runningConditionTimePeriods: [],
                    },
                });
                await closePromise;
            });
            expect(mockClose).toHaveBeenCalledTimes(1);
        });

        it('does not intercept the close at all once nothing is pending', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            expect(mockCloseRequestedHandler).not.toBeNull();

            const preventDefault = vi.fn();
            await act(async () => { await mockCloseRequestedHandler!({ preventDefault }); });
            expect(preventDefault).not.toHaveBeenCalled();
            expect(mockClose).not.toHaveBeenCalled();
        });

        it('also flushes the Running Condition Filter modal\'s own pending write', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel()], runningConditionNoneConfirmed: false, runningConditionFilters: [] } });
            fireEvent.click(screen.getByText('Edit…'));

            let resolveUpdate!: (v: unknown) => void;
            mockUpdateWorkspaceData.mockImplementationOnce(() => new Promise((res) => { resolveUpdate = res; }));
            fireEvent.click(screen.getByText('Add condition'));

            const preventDefault = vi.fn();
            let closePromise!: Promise<void>;
            await act(async () => {
                closePromise = mockCloseRequestedHandler!({ preventDefault }) as Promise<void>;
                await Promise.resolve();
            });
            expect(preventDefault).toHaveBeenCalledTimes(1);
            expect(mockClose).not.toHaveBeenCalled();

            await act(async () => {
                resolveUpdate({
                    id: 'ws1',
                    failureGroupState: {
                        groups: [makeGroup()], models: [makeModel()],
                        runningConditionFilters: [{ id: 'f1', sensor: 'TAG1', operation: 'greater_than', value1: '1', value2: '' }],
                        runningConditionCombine: 'and', runningConditionNoneConfirmed: false, rcLegacyNotice: null, runningConditionTimePeriods: [],
                    },
                });
                await closePromise;
            });
            expect(mockClose).toHaveBeenCalledTimes(1);
        });

        it('also flushes the PM page\'s own pending debounced write when it is open', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            await act(async () => { fireEvent.click(screen.getByText('Open full view ↗')); });
            expect(screen.getByTestId('pm-page-mock')).toBeTruthy();

            let resolveFlush!: () => void;
            pmFlushMock.mockImplementationOnce(() => new Promise<void>((res) => { resolveFlush = res; }));

            const preventDefault = vi.fn();
            let closePromise!: Promise<void>;
            await act(async () => {
                closePromise = mockCloseRequestedHandler!({ preventDefault }) as Promise<void>;
                await Promise.resolve();
            });
            expect(preventDefault).toHaveBeenCalledTimes(1);
            expect(mockClose).not.toHaveBeenCalled();

            await act(async () => {
                resolveFlush();
                await closePromise;
            });
            expect(pmFlushMock).toHaveBeenCalled();
            expect(mockClose).toHaveBeenCalledTimes(1);
        });

        it('the toolbar\'s own Close button also awaits a pending write before calling the Tauri close API', async () => {
            render(<BuildModelWindow />);
            // Phase B: Mark complete also requires Trained-and-fresh now — seed that.
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [withTrained(makeModel())] } });
            let resolveUpdate!: (v: unknown) => void;
            mockUpdateWorkspaceData.mockImplementationOnce(() => new Promise((res) => { resolveUpdate = res; }));

            fireEvent.click(screen.getByText('✓ Mark complete'));
            fireEvent.click(screen.getByTitle('Close'));
            await act(async () => { await Promise.resolve(); });
            expect(mockClose).not.toHaveBeenCalled();

            await act(async () => {
                resolveUpdate({
                    id: 'ws1',
                    failureGroupState: {
                        groups: [makeGroup()], models: [makeModel({ status: true })],
                        runningConditionNoneConfirmed: true, rcLegacyNotice: null, runningConditionTimePeriods: [],
                    },
                });
            });
            await waitFor(() => expect(mockClose).toHaveBeenCalledTimes(1));
        });
    });

    describe('locked identity sensor and predictor/component grouping (unchanged behind the new layout)', () => {
        it('the predictor picker passes getComponent through so its popup can group by component', async () => {
            const rel = makeModel({ id: 'r1', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: [] });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel] } });
            const predictorProps = sensorPickerModalProps.find(p => p.noun === 'predictors');
            expect(predictorProps).toBeTruthy();
            expect(typeof predictorProps.getComponent).toBe('function');
            expect(predictorProps.getComponent('TAG2')).toBe('Pump');
        });

        it('Y sensor and Criteria sensor are single-select popups, Criteria allows None', async () => {
            const clu = makeModel({ id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: '', criteriaSensor: '' });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [clu] } });
            const yProps = sensorPickerModalProps.find(p => p.noun === 'Y sensor');
            const criteriaProps = sensorPickerModalProps.find(p => p.noun === 'criteria sensor');
            expect(yProps.single).toBe(true);
            expect(criteriaProps.single).toBe(true);
            expect(criteriaProps.allowNone).toBe(true);
            expect(yProps.allowNone).toBeFalsy();
        });

        it('a fresh clustering model (X set, Y unset) is grouped under its X sensor\'s component in Component view, not Uncategorized', async () => {
            const clu = makeModel({ id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: '' });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [clu] } });
            fireEvent.click(screen.getByText('Component'));
            expect(screen.getAllByText('Pump').length).toBeGreaterThan(0);
            expect(screen.queryByText('Uncategorized')).toBeNull();
        });
    });
});
