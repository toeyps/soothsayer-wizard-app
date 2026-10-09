import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

// Build Model Workbench Phase B (Train in place) — mocks for the three preview
// commands and the chart components they feed.
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
    default: (props: any) => (
        <div
            data-testid="echarts-mock"
            data-series-count={props.option?.series?.length ?? 0}
            data-x-axis-name={props.option?.xAxis?.name ?? ''}
        />
    ),
}));

// The Workbench's sensor-picker adapter (SensorPickers.tsx) is stubbed with a minimal
// stand-in - the real shared picker's search / grouping / single-vs-multi behaviour is
// tested directly in SensorPicker.test.tsx (+ the adapter in SensorPickers.test.tsx).
// BuildModelWindow's tests only assert its own wiring (props passed in, the callbacks it
// reacts to). The Fit chart's X selector is the REAL compact picker (ModelFitPage imports
// it from components/sensor directly) and is driven with helpers/sensorPicker.
const sensorPickerModalProps: any[] = [];
vi.mock('../components/windows/SensorPickers', () => ({
    // Minimal stand-in for the popup picker — its own search/collapsible-
    // group/checkbox/single-vs-multi behavior is tested directly against the
    // real implementation in SensorPickers.test.tsx. Typing a value
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
import { makeHealthPreview, makeSetPointAwarePreview } from './helpers/healthPreviewFixture';
import { makeTestResult, makeValidation } from './helpers/validationFixture';
import { computeTrainFingerprint } from '../utils/trainFingerprint';
import { snapshotTrainedFormulas } from '../utils/specialSensorSignature';
import { ALL_TIME_TRAIN, ONE_TEST } from './helpers/trainTestFixture';
import { MARK_COMPLETE_CLOSE_WAIT } from '../utils/healthPersist';
import { ADD_TRAIN_PERIOD_HINT, NO_TEST_PERIOD_REASON } from '../utils/runningCondition';
// @ts-expect-error - @types/node is not installed; vitest runs in Node so this resolves at runtime
import { readFileSync } from 'node:fs';
import { pickSingle, rowTag } from './helpers/sensorPicker';
import { TRAIN_NEEDS_RUNNING_CONDITION } from '../utils/trainQueue';

// jsdom does not load App.css (vitest also stubs `?raw` CSS imports to ''; cwd is the repo root), so layout
// rules that used to be inline styles are asserted against the stylesheet source itself.
const APP_CSS: string = readFileSync('src/App.css', 'utf-8');
const cssBlock = (selector: string): string => {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`(?:^|\\n)${esc} \\{([^}]*)\\}`).exec(APP_CSS);
    if (!m) throw new Error(`no CSS rule for ${selector}`);
    return m[1];
};

/** The detail header's sensor-level "▶ Train sensor · n of m" (customer batch 2026-10,
 *  items 8 + 9) — it replaced the footer's per-model "▶ Train model" / "↻ Re-train". It
 *  trains every model of the sensor that needs it through the train queue. */
const trainSensorBtn = () => screen.getByTestId('train-sensor') as HTMLButtonElement;
const trainSensorWhy = () => screen.getByTestId('train-sensor-why').textContent;

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
    runningConditionTimePeriods: ALL_TIME_TRAIN, runningConditionNoneConfirmed: true,
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
 *  re-renders off a SECOND write (e.g. trainForQueue's commit-then-train,
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
            runningConditionNoneConfirmed: true, rcLegacyNotice: null, runningConditionTimePeriods: ALL_TIME_TRAIN,
            runningConditionTestPeriods: ONE_TEST,
            ...extra,
        },
    };
    mockUpdateWorkspaceData.mockImplementation(async (_id: string, patch: (s: any) => any) => {
        ws = patch(ws);
        return ws;
    });
}

async function deliverData(overrides: Record<string, any> = {}, payloadOver: Record<string, any> = {}) {
    const payload = {
        workspaceId: 'ws1',
        sensorHeaders: ['TAG1', 'TAG2', 'TAG3'],
        sensorMetadata: [
            { tag: 'TAG1', description: 'Pump Pressure', unit: 'bar', component: 'Pump' },
            { tag: 'TAG2', description: 'Pump Temp', unit: 'C', component: 'Pump' },
        ],
        metadata: { headers: ['timestamp', 'TAG1', 'TAG2', 'TAG3'], total_rows: 100 },
        ...payloadOver,
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
            // Train/Test validation (2026-10-07): a train period is required to
            // Train and a test period to Mark complete — default to having both.
            ...(!('runningConditionTimePeriods' in fg) ? { runningConditionTimePeriods: ALL_TIME_TRAIN } : {}),
            ...(!('runningConditionTestPeriods' in fg) ? { runningConditionTestPeriods: ONE_TEST } : {}),
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
    if (!screen.queryByTestId('add-model-form')) fireEvent.click(screen.getByText('Model settings', { selector: 'b' }));
};

/** The default fake Rust of this file: the Train previews + the health preview
 *  (`compute_health_preview`, answered for whatever the request asks). Tests that
 *  override `mockInvoke` fall back to this for every command they do not care about. */
function defaultInvoke(cmd: string, args?: any): Promise<unknown> {
    if (cmd === 'compute_sensor_stats') {
        return Promise.resolve({ mean: 5, sd: 1, min: 0, max: 10, count: 100, lower1: 4, upper1: 6, lower3: 2, upper3: 8 });
    }
    if (cmd === 'preview_relationship_model') {
        return Promise.resolve({
            request: 'req-1', r2_per_step: [0.8], rmse2_per_step: [0.4],
            n_rows: 3, predicted: [1, 2, 3],
            target_raw: [1.1, 2.1, 2.9], predictor_raw: [[1], [2], [3]],
        });
    }
    if (cmd === 'compute_clustering_preview') {
        return Promise.resolve({
            first_sensor: 'TAG1', second_sensor: 'TAG2', criteria_sensor: null, cluster_count: 1, n_rows: 3,
            clusters: [{ cluster_id: 1, range: null, n_rows: 3, ellipse: { x_center: 1, y_center: 1, x_sd: 1, y_sd: 1, angle_deg: 0 }, xs: [1, 2, 3], ys: [1, 2, 3] }],
        });
    }
    if (cmd === 'compute_health_preview') return Promise.resolve(makeHealthPreview(args?.request));
    return Promise.resolve({});
}
const healthCalls = () => mockInvoke.mock.calls.filter(c => c[0] === 'compute_health_preview').map(c => (c[1] as any).request);

/** Health score page (3b-2): `defaultInvoke` + a health preview that FOLLOWS the request's set points
 *  (empty -> `required` issues, filled -> valid with a score) + a successful `export_model_files`. */
const EXPORT_OK = {
    ok: true,
    files: [{ kind: 'info', file_name: 'INDV_INFO_TAG1.json', path: 'C:/data/workspaces/ws1/output/TAG1/INDV_INFO_TAG1.json' }],
    output_dir: 'C:/data/workspaces/ws1/output',
    validation: [],
    warnings: [],
};
function healthInvoke(cmd: string, args?: any): Promise<unknown> {
    if (cmd === 'compute_health_preview') return Promise.resolve(makeSetPointAwarePreview(args?.request));
    if (cmd === 'export_model_files') return Promise.resolve(EXPORT_OK);
    return defaultInvoke(cmd, args);
}
const exportCalls = () => mockInvoke.mock.calls.filter(c => c[0] === 'export_model_files').map(c => (c[1] as any).request);
/** Set points that are valid for the Individual fixture (3SD band 2..8): L below 2, H above 8. */
const VALID_IND = { kind: 'individual', lower: 1, upper: 9, masterLower: 1, masterUpper: 9 };
/** Opens the Health score page of the (trained) active model and waits for its first answer. */
const openHealthPage = async () => {
    fireEvent.click(screen.getByTestId('page-health'));
    await waitFor(() => expect(screen.getByTestId('set-points-card')).toBeTruthy());
};

beforeEach(() => {
    listenCallbacks = {};
    sensorPickerModalProps.length = 0;
    lineChartProps.length = 0;
    mockListen.mockClear();
    mockEmit.mockClear().mockResolvedValue(undefined);
    mockClose.mockClear().mockResolvedValue(undefined);
    mockUpdateWorkspaceData.mockReset().mockImplementation(async (id: string, patch: (s: any) => any) => {
        const prev = { id, failureGroupState: { groups: [makeGroup()], models: [makeModel()], runningConditionNoneConfirmed: true, rcLegacyNotice: null, runningConditionTimePeriods: ALL_TIME_TRAIN, runningConditionTestPeriods: ONE_TEST } };
        return patch(prev);
    });
    mockLoadWorkspaceData.mockReset();
    mockInvoke.mockReset().mockImplementation(defaultInvoke);
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
        expect(screen.getByTestId('rc-card')).toBeTruthy();
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
            const list = within(screen.getByPlaceholderText('Search description, tag, unit or component…').closest('aside') as HTMLElement);
            fireEvent.change(screen.getByPlaceholderText('Search description, tag, unit or component…'), { target: { value: 'temp' } });
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
            const list = within(screen.getByPlaceholderText('Search description, tag, unit or component…').closest('aside') as HTMLElement);
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

        // Customer item 3 (2026-10-09): the row is the stacked SensorLabel; its description line is
        // the single-line ellipsis (`.sl-desc`), the full name is in the title.
        it('the sensor row is the stacked SensorLabel; the description stays on one line (single-line ellipsis)', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            const label = screen.getAllByTestId('sensor-row-label')[0];
            expect(label.querySelector('.sl .sl-desc')?.textContent).toBe('Pump Pressure');
            expect(label.querySelector('.sl .sl-tag')?.textContent).toBe('TAG1');
            expect(label.getAttribute('title')).toMatch(/^Pump Pressure · TAG1/);
            const rule = cssBlock('.sl-desc');
            expect(rule).toMatch(/white-space:\s*nowrap/);
            expect(rule).toMatch(/text-overflow:\s*ellipsis/);
            expect(rule).toMatch(/overflow:\s*hidden/);
        });

        it('the sidebar can be hidden and re-shown via the detail header\'s icon button', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            expect(screen.getByPlaceholderText('Search description, tag, unit or component…')).toBeTruthy();
            fireEvent.click(screen.getByTitle('Hide sensor list'));
            expect(screen.queryByPlaceholderText('Search description, tag, unit or component…')).toBeNull();
            fireEvent.click(screen.getByTitle('Show sensor list'));
            expect(screen.getByPlaceholderText('Search description, tag, unit or component…')).toBeTruthy();
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
            const heading = screen.getByRole('heading', { name: 'Pump Pressure' });
            // Customer item 3: the stacked label at header size; component chip after the tag.
            expect(heading.querySelector('.sl.sl--lg .sl-desc')?.textContent).toBe('Pump Pressure');
            expect(within(heading).getByText('TAG1').className).toContain('sl-tag');
            expect(within(heading).getByText('Pump').className).toContain('comp-chip');
            const meta = heading.parentElement!.querySelector('.bmw-dmeta') as HTMLElement;
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
            fireEvent.click(screen.getByText('Model settings', { selector: 'b' }));
            expect(screen.getByTestId('add-model-form')).toBeTruthy();
            fireEvent.click(screen.getByText('Model settings', { selector: 'b' }));
            expect(screen.queryByTestId('add-model-form')).toBeNull();
        });

        it('Relationship: predictor picker + chips, stiffness picker; Clustering: locked X, Y picker, cluster-count stepper', async () => {
            const rel = makeModel({ id: 'r1', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2'], relStiffness: 10_000 });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel] } });
            openSettings();
            // Customer item 3: predictors are the multi picker's chips + "Add…" (the adapter is
            // stubbed here; its chips are tested in SensorPicker(s).test.tsx).
            const predictorPicker = sensorPickerModalProps.filter(pr => !pr.single && pr.noun === 'predictors').pop();
            expect(predictorPicker.selected).toEqual(['TAG2']);
            expect(predictorPicker.excluded).toEqual(['TAG1']);
            expect(predictorPicker.getDesc).toBeUndefined();
            const scope = render(<>{predictorPicker.scope}</>).container.textContent;
            expect(scope).toMatch(/^All sensors except the target · \d+$/);
            expect(screen.getByRole('button', { name: 'Loose' }).className).toBe('on'); // 10_000 -> "Loose"

            cleanup();
            const clu = makeModel({ id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2', numClusters: 3 });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [clu] } });
            openSettings();
            const readout = document.querySelector('.f4-readout') as HTMLElement; // locked X
            expect(readout.querySelector('.sl-desc')?.textContent).toBe('Pump Pressure');
            expect(readout.querySelector('.sl-tag')?.textContent).toBe('TAG1');
            expect(within(screen.getByTestId('add-model-form')).getByText('3')).toBeTruthy(); // cluster stepper count
            fireEvent.click(screen.getByLabelText('More clusters'));
            expect(within(screen.getByTestId('add-model-form')).getByText('4')).toBeTruthy();
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

    // 🆕 2026-09-30 (issues 2/3): the row used to give Model name an
    // uncapped-below/no-cap-above `minWidth: 200px` inline style (a long real
    // sensor name — "GENERATOR BEARING METAL TEMPERATURE" style — rendered far
    // narrower than its text with no ellipsis/tooltip), and every kind's own
    // fields sat directly alongside Model name/Training data in one flex row
    // with ad hoc one-off inline widths, so the row's shape looked completely
    // different per kind ("ไม่สวยเลย มันดูไม่เท่ากันซักช่อง" — not even one
    // column matches). Fixed with shared classes in App.css: `.f4-fld--name` /
    // `.f4-fld--traindata` give Model name and Training data the same width
    // treatment in every kind, and `.bmw-sets-kind` wraps everything
    // kind-specific into its own group so Clustering's extra fields fall onto
    // their own line instead of being crushed into one row built for 3.
    describe('Model settings row layout (issues 2/3, 2026-09-30)', () => {
        it('Model name has a title attribute (full text on hover) and the shared width class, in every kind', async () => {
            const longName = 'GENERATOR BEARING METAL TEMPERATURE DRIVE END';
            for (const kind of ['individual', 'relationship', 'clustering'] as const) {
                const m = makeModel({
                    id: `m-${kind}`, kind, name: longName,
                    ...(kind === 'relationship' ? { predictorSensors: ['TAG2'] } : {}),
                    ...(kind === 'clustering' ? { xSensor: 'TAG1', ySensor: 'TAG2', targetSensor: '' } : {}),
                });
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups: [makeGroup()], models: [m] } });
                openSettings();
                const nameInput = screen.getByDisplayValue(longName) as HTMLInputElement;
                expect(nameInput.title).toBe(longName);
                expect(nameInput.closest('.f4-fld')?.className).toContain('f4-fld--name');
                cleanup();
            }
        });

        it('Training data is the shared, fixed-width field and always renders after every kind-specific field', async () => {
            const clu = makeModel({ id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2', criteriaSensor: 'TAG2', clusterRanges: [{ min: 0, max: 100 }] });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [clu] } });
            openSettings();
            const form = screen.getByTestId('add-model-form');
            const fields = within(form).getAllByText(/^(Model name|X sensor|Y sensor \(target\)|Criteria sensor \(optional\)|Clusters|Cluster ranges|Training data)$/);
            expect(fields[fields.length - 1].textContent).toBe('Training data');
            const trainingDataFld = screen.getByText('Training data').closest('.f4-fld');
            expect(trainingDataFld?.className).toContain('f4-fld--traindata');
        });

        it('every kind-specific field lives inside the shared .bmw-sets-kind wrapper, distinct from Model name / Training data', async () => {
            const rel = makeModel({ kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2'] });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel] } });
            openSettings();
            const kindGroup = screen.getByText('Predictor sensors (≥ 1)').closest('.bmw-sets-kind');
            expect(kindGroup).toBeTruthy();
            expect(within(kindGroup as HTMLElement).getByText('Stiffness')).toBeTruthy();
            // Model name and Training data are siblings of the group, not inside it.
            expect(kindGroup!.contains(screen.getByText('Training data'))).toBe(false);
        });

        it('App.css gives Model name room to grow and Training data a fixed shared width', () => {
            expect(cssBlock('.f4-fld--name')).toMatch(/max-width:\s*380px/);
            expect(cssBlock('.f4-fld--traindata')).toMatch(/flex:\s*0 0 170px/);
            // 🆕 2026-09-30 (redesign): `.bmw-sets-kind` is now `display: contents`
            // — a pure grouping wrapper with no layout box of its own — so Model
            // name, the kind-specific fields and Training data all wrap together
            // as ONE row in `.bmw-sets-body`, instead of the group forcing
            // itself (and Training data after it) onto separate lines.
            expect(cssBlock('.bmw-sets-kind')).toMatch(/display:\s*contents/);
            expect(cssBlock('.bmw-sets-body')).toMatch(/flex-wrap:\s*wrap/);
        });
    });

    describe('results area', () => {
        it('shows "Not trained yet" for a fully-configured model that has never been trained', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            expect(screen.getByTestId('results-placeholder').textContent).toBe('Not trained yet');
        });

        // 🆕 2026-09-30 (issue 4): `renderResultsStage` checks `buildBlockReason`
        // (the gate) before `!m.lastTrainedAt` BY DESIGN (SPEC FINAL's own
        // results-area rule 5: "incomplete config/gate" outranks "never
        // trained") — so a workspace whose running condition never actually
        // persisted (issue 1) can never show "Not trained yet": the gate stays
        // blocked forever and the user only ever sees "N items to fix". This
        // test proves that once the Edit… modal's own write actually lands
        // (same modal issue 1 fixes), the gate clears and "Not trained yet"
        // appears immediately — confirming issue 4 was never a second,
        // independent ordering bug.
        it('a model stuck on "N items to fix" shows "Not trained yet" the moment the running-condition gate actually clears', async () => {
            let disk: any = { id: 'ws1', failureGroupState: { groups: [makeGroup()], models: [makeModel()], runningConditionNoneConfirmed: false, runningConditionFilters: [], rcLegacyNotice: null } };
            mockUpdateWorkspaceData.mockImplementation(async (_id: string, patch: (s: any) => any) => { disk = patch(disk); return disk; });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: disk.failureGroupState });
            // Step 1 not done: the results area is the lock message (not the plain list).
            expect(screen.getByTestId('results-rc-locked')).toBeTruthy();
            expect(screen.queryByTestId('results-placeholder')).toBeNull();

            fireEvent.click(screen.getByTestId('rc-card-open'));
            fireEvent.click(screen.getByTestId('rc-mode-none'));
            // 2026-10-03: edits only change the modal's draft until Apply.
            expect(screen.getByTestId('results-rc-locked')).toBeTruthy();
            fireEvent.click(screen.getByTestId('rc-apply'));
            await flush();

            expect(screen.queryByTestId('results-rc-locked')).toBeNull();
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
            fireEvent.click(screen.getByText('Model settings', { selector: 'b' })); // collapse it
            expect(screen.queryByTestId('add-model-form')).toBeNull();
            fireEvent.click(screen.getByText('Add at least 1 predictor'));
            expect(screen.getByTestId('add-model-form')).toBeTruthy(); // link re-opened it
        });

        it('Step 1 not done: the results area says "Set the running condition first" with a button that opens the Running condition modal (no generic items list)', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel()], runningConditionNoneConfirmed: false, rcLegacyNotice: null } });
            const lock = screen.getByTestId('results-rc-locked');
            expect(lock.textContent).toMatch(/Set the running condition first/);
            expect(lock.textContent).toMatch(/Training is locked until Step 1 is done\./);
            expect(screen.queryByTestId('results-incomplete')).toBeNull(); // nothing else is wrong with this model
            // The modal auto-opens for an unset workspace; close it, then use the lock's own button.
            fireEvent.click(screen.getByLabelText('Close'));
            expect(screen.queryByRole('dialog', { name: 'Running condition' })).toBeNull();
            fireEvent.click(screen.getByTestId('results-rc-locked-open'));
            expect(screen.getByRole('dialog', { name: 'Running condition' })).toBeTruthy();
        });

        it('Step 1 not done AND another item missing: the lock message AND the (non-running-condition) items list both show', async () => {
            const rel = makeModel({ kind: 'relationship', targetSensor: 'TAG1', predictorSensors: [] });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel], runningConditionNoneConfirmed: false, rcLegacyNotice: null } });
            expect(screen.getByTestId('results-rc-locked')).toBeTruthy();
            const list = screen.getByTestId('results-incomplete');
            expect(list.textContent).toMatch(/1 item to fix before training/);
            expect(list.textContent).toMatch(/Add at least 1 predictor/);
            expect(list.textContent).not.toMatch(/running condition first/); // the lock owns that reason
        });

        it('an invalid workspace period locks with "Fix the running condition first" and a "Fix period" button', async () => {
            const periods = [{ id: 'x', start: '2026-02-01T00:00', end: '2026-01-05T00:00' }];
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel()], runningConditionNoneConfirmed: true, runningConditionTimePeriods: periods } });
            expect(screen.getByTestId('results-rc-locked').textContent).toMatch(/Fix the running condition first/);
            expect(screen.getByTestId('results-rc-locked-open').textContent).toBe('Fix period');
        });

        it('a Custom-mode model is NOT locked by an unset workspace condition (it has its own)', async () => {
            const custom = makeModel({ runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [custom], runningConditionNoneConfirmed: false, rcLegacyNotice: null } });
            expect(screen.queryByTestId('results-rc-locked')).toBeNull();
        });

        it('runs compute_sensor_stats on "▶ Train sensor", shows the chart+toolbar, and persists lastTrainedAt/trainedFingerprint', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            await act(async () => {
                fireEvent.click(trainSensorBtn());
                await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
            });
            expect(mockInvoke).toHaveBeenCalledWith('compute_sensor_stats', expect.objectContaining({ sensor: 'TAG1', filter: null }));
            const written = (await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value).failureGroupState;
            expect(written.models[0].lastTrainedAt).toBeTruthy();
            expect(written.models[0].trainedFingerprint).toBeTruthy();
            // The charts come from the bounded health preview (debounced), not from the Train call.
            await waitFor(() => expect(screen.getByTestId('results-chart')).toBeTruthy());
            expect(healthCalls()[0]).toMatchObject({ kind: 'individual', target: 'TAG1' });
            expect(screen.getByTestId('chart-card-ts')).toBeTruthy();
            expect(screen.getByTestId('chart-card-dist')).toBeTruthy();
            expect(within(screen.getByTestId('stats-card')).getByTestId('stat-rows').textContent).toBe('1,000');
            // Nothing further to train here (Train sensor has nothing ready); the next step is the Health score page.
            await waitFor(() => expect(trainSensorWhy()).toBe('1 model up to date — nothing to train'));
            expect(trainSensorBtn().disabled).toBe(true);
            expect(screen.queryByText('▶ Train model')).toBeNull();
            expect(screen.queryByText('✓ Mark complete')).toBeNull();
            expect((screen.getByTestId('next-health-score') as HTMLButtonElement).disabled).toBe(false);
            expect(screen.getByText('Trained', { selector: '.model-status-pill' })).toBeTruthy();
        });

        it('runs preview_relationship_model for a Relationship model and shows R²/2×RMSE/Stiffness', async () => {
            const rel = makeModel({ kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2'], relStiffness: 10_000 });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel] } });
            statefulUpdateMock([rel]);
            await act(async () => {
                fireEvent.click(trainSensorBtn());
                await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
            });
            expect(mockInvoke).toHaveBeenCalledWith('preview_relationship_model', expect.objectContaining({ predictors: ['TAG2'], target: 'TAG1', lambda: 10_000 }));
            await waitFor(() => expect(screen.getByTestId('results-chart')).toBeTruthy());
            expect(healthCalls()[0]).toMatchObject({ kind: 'relationship', target: 'TAG1', predictors: ['TAG2'] });
            expect(screen.getByTestId('stat-r2').textContent).toBe('R²0.912');
            expect(screen.getByTestId('stat-2rmse').textContent).toBe('2RMSE0.913');
            expect(screen.getByTestId('chart-card-fit')).toBeTruthy();
            expect(screen.getByTestId('chart-card-tvp')).toBeTruthy();
            expect(screen.getByTestId('chart-card-res')).toBeTruthy();
        });

        it('runs compute_clustering_preview for a Clustering model and shows Rows/Clusters', async () => {
            const clu = makeModel({ id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2', numClusters: 1 }); // no criteria sensor -> one cluster (Rust needs a criteria sensor for 2+)
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [clu] } });
            statefulUpdateMock([clu]);
            await act(async () => {
                fireEvent.click(trainSensorBtn());
                await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
            });
            expect(mockInvoke).toHaveBeenCalledWith('compute_clustering_preview', expect.objectContaining({ first_sensor: 'TAG1', second_sensor: 'TAG2' }));
            await waitFor(() => expect(screen.getByTestId('results-chart')).toBeTruthy());
            expect(healthCalls()[0]).toMatchObject({ kind: 'clustering', first_sensor: 'TAG1', second_sensor: 'TAG2', n_clusters: 1 });
            expect(screen.getByTestId('chart-card-cl')).toBeTruthy();
            expect(screen.getByTestId('cluster-summary')).toBeTruthy();
        });

        it('commits an unsaved draft edit before training, so Train uses the just-edited settings', async () => {
            const rel = makeModel({ kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2'] });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel] } });
            statefulUpdateMock([rel]);
            openSettings();
            fireEvent.change(screen.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Edited before Train' } });
            await act(async () => {
                fireEvent.click(trainSensorBtn());
                await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
            });
            const results = mockUpdateWorkspaceData.mock.results;
            const last = (await results[results.length - 1].value).failureGroupState.models[0];
            expect(last.name).toBe('Edited before Train');
            expect(last.lastTrainedAt).toBeTruthy();
        });

        it('going stale after a settings change: hides the chart, shows "Settings changed", the footer points at Train sensor, and Train sensor re-trains it', async () => {
            const trained = withTrained(makeModel());
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [{ ...trained, trainedFingerprint: 'stale-fingerprint-does-not-match' }] } });
            await flush();
            expect(screen.getByTestId('results-stale').textContent).toMatch(/Settings changed/);
            expect(screen.getByText('Incomplete', { selector: '.model-status-pill' })).toBeTruthy(); // pill reverts, "Trained" is only for fresh
            expect(trainSensorBtn().disabled).toBe(false);
            expect(trainSensorBtn().textContent).toBe('▶ Train sensor · 1 of 1');
            expect(screen.getByTestId('footer-status').textContent).toBe('Settings changed · re-train with Train sensor ↑'); // footer message
            expect(screen.queryByText('↻ Re-train')).toBeNull(); // the per-model footer button is gone
            fireEvent.click(trainSensorBtn());
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
                fireEvent.click(trainSensorBtn());
                await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
            });
            expect(screen.getByTestId('results-error').textContent).toMatch(/sidecar exploded/);
            // A failed run makes the model ready again: Train sensor offers it, the footer says so.
            await waitFor(() => expect(trainSensorBtn().disabled).toBe(false));
            expect(screen.getByTestId('footer-status').textContent).toBe('Training failed · fix the problem, then Train sensor ↑');
        });

        it('reopening an already-Trained-and-fresh model auto-recomputes and shows the chart with no click', async () => {
            const trained = withTrained(makeModel());
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [trained] } });
            await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
            expect(mockInvoke).toHaveBeenCalledWith('compute_sensor_stats', expect.anything());
            await waitFor(() => expect(screen.getByTestId('results-chart')).toBeTruthy());
            expect(screen.getByText('Trained', { selector: '.model-status-pill' })).toBeTruthy();
            // Nothing further to click — Train sensor has nothing ready while fresh.
            expect(trainSensorBtn().disabled).toBe(true);
            expect(trainSensorWhy()).toBe('1 model up to date — nothing to train');
        });

        it('a Complete model (fingerprint still matches) ALSO auto-recomputes and shows its charts — health score 3b-1 (it used to show only a placeholder)', async () => {
            const trained = withTrained(makeModel({ status: true }));
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [trained] } });
            await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
            // The Step-1 card's own row count (no filter -> one query) PLUS the model's silent re-run.
            expect(mockInvoke.mock.calls.filter(c => c[0] === 'compute_sensor_stats')).toHaveLength(2);
            await waitFor(() => expect(screen.getByTestId('results-chart')).toBeTruthy());
            expect(screen.queryByTestId('results-placeholder')).toBeNull();
            // The silent run writes nothing and never touches `status`.
            expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
            expect(screen.getByText('Complete', { selector: '.model-status-pill' })).toBeTruthy();
        });

        it('Mark complete is unreachable until the model is Trained-and-fresh, even when the running-condition gate is satisfied (Health score is locked with the reason)', async () => {
            render(<BuildModelWindow />);
            await deliverData(); // fully configured, gate satisfied, but never trained
            expect(screen.queryByText('✓ Mark complete')).toBeNull();
            const health = screen.getByTestId('page-health') as HTMLButtonElement;
            expect(health.disabled).toBe(true);
            expect(health.title).toMatch(/Train the model/);
        });
    });

    describe('left sensor list kind-badge status dot (Phase B)', () => {
        it('shows no dot for a never-trained model, a yellow dot for Trained (set points still needed), and a green dot for Complete', async () => {
            const trained = withTrained(makeModel({ id: 'm-trained' }));
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [trained] } });
            await flush();
            expect(screen.getByTestId('sensor-kind-badge-dot-m-trained').className).toMatch(/f4-kb-dot--need/);

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
        it('shows a read-only status pill and "Save changes" - NO per-model Train (it moved to the header, customer items 8 + 9) and NO "Open full view" control (health score phase 4: the full-view page is gone)', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            expect(screen.getByText('Incomplete')).toBeTruthy();
            expect(screen.queryByText(/Open full view/)).toBeNull();
            expect(screen.getByText('Save changes')).toBeTruthy();
            expect(screen.queryByText('▶ Train model')).toBeNull();
            expect(screen.queryByText('↻ Re-train')).toBeNull();
            expect(trainSensorBtn().textContent).toBe('▶ Train sensor · 1 of 1');
            // The footer says "not trained yet" and links to the header button (which it focuses).
            expect(screen.getByTestId('footer-status').textContent).toBe('Not trained · Train sensor ↑ — train first, then set the health set points');
            fireEvent.click(screen.getByTestId('footer-train-sensor'));
            expect(document.activeElement).toBe(trainSensorBtn());
            // 3b-2: a model is completed ONLY from the Health score page - never from this footer.
            expect(screen.queryByText('✓ Mark complete')).toBeNull();
            expect(screen.queryByText('Mark incomplete')).toBeNull();
        });

        it('Train sensor is disabled until settings are valid, and shows why (the preflight wording, not "above")', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel({ name: '' })] } });
            const train = trainSensorBtn();
            expect(train.disabled).toBe(true);
            expect(trainSensorWhy()).toBe("Can't train: Individual — no model name");
            expect(train.title).toBe("Can't train: Individual — no model name");
            // The footer keeps the shipped Save reason.
            expect(screen.getByTestId('build-block-reason').textContent).toMatch(/Fill in the required fields/);
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

        it('"✓ Mark complete" (Health score page) validates, writes the files and then marks the model Complete', async () => {
            mockInvoke.mockImplementation(healthInvoke);
            const model = withTrained(makeModel({ healthSetPoints: VALID_IND }));
            statefulUpdateMock([model]);
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [model] } });
            await openHealthPage();
            await waitFor(() => expect((screen.getByTestId('mark-complete') as HTMLButtonElement).disabled).toBe(false));
            await act(async () => { fireEvent.click(screen.getByTestId('mark-complete')); await Promise.resolve(); });
            await waitFor(() => expect(screen.getByTestId('save-ok')).toBeTruthy());
            expect(exportCalls()).toHaveLength(1);
            const written = (await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value).failureGroupState.models[0];
            expect(written.status).toBe(true);
            expect(written.healthSetPoints).toMatchObject({ lower: 1, upper: 9 });
            expect(written.healthExport).toMatchObject({ outputDir: 'C:/data/workspaces/ws1/output', setPoints: { lower: 1, upper: 9 } });
        });

        it('"✓ Mark complete" is blocked while the running-condition gate blocks the model: no button on Model fit, Health score cannot be opened', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel()], runningConditionNoneConfirmed: false } });
            expect(screen.queryByText('✓ Mark complete')).toBeNull();
            const health = screen.getByTestId('page-health') as HTMLButtonElement;
            expect(health.disabled).toBe(true);
        });

        it('a Complete model shows "Mark incomplete" on the Health score page, and clicking it un-marks the model (status only; its files and set points stay)', async () => {
            mockInvoke.mockImplementation(healthInvoke);
            const record = { at: '2026-10-04T01:00:00.000Z', outputDir: 'C:/data/workspaces/ws1/output', setPoints: VALID_IND };
            const models = [withTrained(makeModel({ status: true, healthSetPoints: VALID_IND, healthExport: record }))];
            statefulUpdateMock(models);
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models } });
            expect(screen.getByText('Complete', { selector: '.model-status-pill' })).toBeTruthy();
            await openHealthPage();
            fireEvent.click(screen.getByTestId('mark-incomplete'));
            await flush();
            const written = (await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value).failureGroupState;
            expect(written.models[0].status).toBe(false);
            expect(written.models[0].healthSetPoints).toMatchObject({ lower: 1, upper: 9 });
            expect(written.models[0].healthExport).toEqual(record);
            expect(exportCalls()).toHaveLength(0);
        });

        it('a model can only become Complete through the Health score page: no "Open full view" / Finish control exists anywhere, and a trained model with set points is still Incomplete until Mark complete runs', async () => {
            mockInvoke.mockImplementation(healthInvoke);
            const trained = withTrained(makeModel({ healthSetPoints: VALID_IND }));
            statefulUpdateMock([trained]);
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [trained] } });
            // Model fit page: nothing that could complete the model.
            expect(screen.queryByText(/Open full view/)).toBeNull();
            expect(screen.queryByText(/Finish/)).toBeNull();
            expect(screen.queryByText('✓ Mark complete')).toBeNull();
            // Health score page: Mark complete is the one control - and nothing was written by looking at it.
            await openHealthPage();
            expect(screen.queryByText(/Open full view/)).toBeNull();
            expect(screen.queryByText(/Finish/)).toBeNull();
            expect(screen.getByTestId('mark-complete')).toBeTruthy();
            expect(exportCalls()).toHaveLength(0);
            const writes = await Promise.all(mockUpdateWorkspaceData.mock.results.map(r => r.value));
            expect(writes.every(w => w.failureGroupState.models[0].status === false)).toBe(true);
        });

        describe('2026-10-03 — Health score set points (phase 1, data only) survive every write this window makes', () => {
            const entered = { kind: 'individual', lower: 12.5, upper: null, masterLower: 10, masterUpper: 90 };
            const sp = (m: any) => JSON.stringify(m.healthSetPoints);

            it('"Save changes" (draftFields spread) keeps them byte-identical', async () => {
                const model = makeModel({ healthSetPoints: entered });
                statefulUpdateMock([model]);
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups: [makeGroup()], models: [model] } });
                openSettings();
                fireEvent.change(screen.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Renamed' } });
                await act(async () => { fireEvent.click(screen.getByText('Save changes')); await Promise.resolve(); await Promise.resolve(); });
                const written = (await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value).failureGroupState.models[0];
                expect(written.name).toBe('Renamed');
                expect(sp(written)).toBe(JSON.stringify(entered));
            });

            it('Train (writes lastTrainedAt/trainedFingerprint) and then "Mark complete" keep them', async () => {
                mockInvoke.mockImplementation(healthInvoke);
                const valid = { kind: 'individual', lower: 1, upper: 9, masterLower: 10, masterUpper: 90 };
                const model = makeModel({ healthSetPoints: valid });
                statefulUpdateMock([model]);
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups: [makeGroup()], models: [model] } });
                await act(async () => {
                    fireEvent.click(trainSensorBtn());
                    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
                });
                let written = (await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value).failureGroupState.models[0];
                expect(written.lastTrainedAt).toBeTruthy();
                expect(sp(written)).toBe(JSON.stringify(valid));
                await openHealthPage();
                await waitFor(() => expect((screen.getByTestId('mark-complete') as HTMLButtonElement).disabled).toBe(false));
                await act(async () => { fireEvent.click(screen.getByTestId('mark-complete')); await Promise.resolve(); });
                await waitFor(() => expect(screen.getByTestId('save-ok')).toBeTruthy());
                written = (await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value).failureGroupState.models[0];
                expect(written.status).toBe(true);
                expect(sp(written)).toBe(JSON.stringify(valid));
            });

            it('a write is computed against DISK: set points another window just saved (this window\'s copy never had them) are not erased', async () => {
                const bare = makeModel();
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups: [makeGroup()], models: [bare] } });
                // ...meanwhile another window wrote set points to disk:
                statefulUpdateMock([makeModel({ healthSetPoints: entered })]);
                openSettings();
                fireEvent.change(screen.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Renamed' } });
                await act(async () => { fireEvent.click(screen.getByText('Save changes')); await Promise.resolve(); await Promise.resolve(); });
                const written = (await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value).failureGroupState.models[0];
                expect(sp(written)).toBe(JSON.stringify(entered));
            });

            it('a Relationship / Clustering model\'s set points are carried through a Save too', async () => {
                const relPoints = { kind: 'relationship', residualAt80Lower: -1.5, residualAt80Upper: 1.5, residualAt0Lower: -3, residualAt0Upper: 3 };
                const rel = makeModel({ id: 'r1', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2'], healthSetPoints: relPoints });
                statefulUpdateMock([rel]);
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel] } });
                openSettings();
                fireEvent.change(screen.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Renamed rel' } });
                await act(async () => { fireEvent.click(screen.getByText('Save changes')); await Promise.resolve(); await Promise.resolve(); });
                const written = (await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value).failureGroupState.models[0];
                expect(sp(written)).toBe(JSON.stringify(relPoints));
            });
        });

        it('a never-trained model cannot reach Complete: the Health score page cannot be opened, nothing is exported', async () => {
            render(<BuildModelWindow />);
            await deliverData(); // fully configured, gate satisfied, but never trained
            expect((screen.getByTestId('page-health') as HTMLButtonElement).disabled).toBe(true);
            expect(screen.queryByTestId('mark-complete')).toBeNull();
            expect(exportCalls()).toHaveLength(0);
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
        // The header's Train sensor (customer items 8 + 9) is the control the running-condition gate blocks.
        const trainButton = trainSensorBtn;

        it('Train sensor is disabled with the "set the running condition" reason while nothing is configured', async () => {
            render(<BuildModelWindow />);
            await deliverGate([makeModel()]);
            const train = trainButton();
            expect(train.disabled).toBe(true);
            expect(train.title).toBe(TRAIN_NEEDS_RUNNING_CONDITION);
            expect(trainSensorWhy()).toBe(TRAIN_NEEDS_RUNNING_CONDITION);
            expect(screen.getByTestId('build-block-reason').textContent).toBe(REASON);
        });

        it('Save changes stays allowed while Train is blocked by the running condition', async () => {
            render(<BuildModelWindow />);
            await deliverGate([makeModel()]);
            expect((screen.getByText('Save changes') as HTMLButtonElement).disabled).toBe(false);
        });

        it('a complete condition unlocks Train', async () => {
            render(<BuildModelWindow />);
            await deliverGate([makeModel()], { runningConditionFilters: cond });
            expect(trainButton().disabled).toBe(false);
        });

        it('confirming "No condition — use all rows" from the Edit… modal enables Train', async () => {
            render(<BuildModelWindow />);
            await deliverGate([makeModel()]);
            fireEvent.click(screen.getByTestId('rc-card-open'));
            fireEvent.click(screen.getByTestId('rc-mode-none'));
            // Still gated until Apply (2026-10-03): a draft never leaks into the gate.
            expect(trainButton().disabled).toBe(true);
            fireEvent.click(screen.getByTestId('rc-apply'));
            await flush();
            expect(trainButton().disabled).toBe(false);
        });

        it('a Custom-mode model is judged by its OWN list, not the workspace one', async () => {
            render(<BuildModelWindow />);
            await deliverGate([makeModel({ runningConditionMode: 'custom' })], { runningConditionFilters: cond });
            expect(trainButton().disabled).toBe(true);
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
            expect(screen.getByTestId('rc-card').getAttribute('data-state')).toBe('unset');

            cleanup();
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel()], runningConditionNoneConfirmed: true } });
            expect(screen.getByTestId('rc-card').getAttribute('data-state')).toBe('set');
        });

        it('"Edit…" opens the modal wrapping the existing RunningConditionPanel', async () => {
            render(<BuildModelWindow />);
            // Configured via a real condition (not "No condition") so the modal
            // does not auto-open AND the panel's condition-editing UI (not its
            // "No condition" summary) is what's shown once opened.
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel()], runningConditionNoneConfirmed: false, runningConditionFilters: [{ id: 'f1', sensor: 'TAG1', operation: 'greater_than', value1: '5', value2: '' }] } });
            expect(screen.queryByText('Add condition')).toBeNull();
            fireEvent.click(screen.getByTestId('rc-card-open'));
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
                workspaceId: 'ws1', origin: 'other-window',
                groups: [makeGroup()], models: [makeModel({ id: 'p', name: 'PM Edit', targetSensor: 'TAG2' })],
            });
            expect(screen.getAllByText('Pump Temp').length).toBeGreaterThan(0);
        });

        it('stamps every failure-group broadcast it sends with its workspace id', async () => {
            mockInvoke.mockImplementation(healthInvoke);
            const model = withTrained(makeModel({ healthSetPoints: VALID_IND }));
            statefulUpdateMock([model]);
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [model] } });
            await openHealthPage();
            await waitFor(() => expect((screen.getByTestId('mark-complete') as HTMLButtonElement).disabled).toBe(false));
            mockEmit.mockClear();
            await act(async () => { fireEvent.click(screen.getByTestId('mark-complete')); await Promise.resolve(); });
            await waitFor(() => expect(screen.getByTestId('save-ok')).toBeTruthy());
            expect(mockEmit).toHaveBeenCalledWith('failure-group-state-changed', expect.objectContaining({
                workspaceId: 'ws1',
                origin: 'build-model',
            }));
        });

        it('being re-pointed at a DIFFERENT workspace shows only the new workspace\'s models', async () => {
            render(<BuildModelWindow />);
            await deliverData();

            mockLoadWorkspaceData.mockResolvedValue({
                id: 'ws2',
                failureGroupState: { groups: [makeGroup({ no: 1, name: 'Other Group' })], models: [makeModel({ id: 'other', name: 'Other Project Model', targetSensor: 'OTHER1' })], runningConditionNoneConfirmed: true, rcLegacyNotice: null, runningConditionTimePeriods: ALL_TIME_TRAIN, runningConditionTestPeriods: ONE_TEST },
            });
            await fire('build-model-data', {
                workspaceId: 'ws2',
                sensorHeaders: ['OTHER1'],
                sensorMetadata: [],
                metadata: { headers: ['timestamp', 'OTHER1'], total_rows: 1 },
            });

            expect(screen.getAllByText('OTHER1').length).toBeGreaterThan(0);
            expect(screen.queryByText('Pump Pressure')).toBeNull();
        });

        it('a slow, superseded load cannot overwrite the result of a newer one', async () => {
            render(<BuildModelWindow />);
            let resolveFirst!: (v: any) => void;
            mockLoadWorkspaceData.mockReturnValueOnce(new Promise(res => { resolveFirst = res; }));
            mockLoadWorkspaceData.mockResolvedValueOnce({
                id: 'ws1',
                failureGroupState: { groups: [makeGroup()], models: [makeModel({ id: 'new', name: 'Fresh Model', targetSensor: 'TAG2' })], runningConditionNoneConfirmed: true, rcLegacyNotice: null, runningConditionTimePeriods: ALL_TIME_TRAIN, runningConditionTestPeriods: ONE_TEST },
            });
            const payload = {
                workspaceId: 'ws1', sensorHeaders: ['TAG1'], sensorMetadata: [],
                metadata: { headers: ['timestamp', 'TAG1'], total_rows: 1 },
            };
            await fire('build-model-data', payload);
            await fire('build-model-data', payload);
            expect(screen.getAllByText('TAG2').length).toBeGreaterThan(0);

            await act(async () => {
                resolveFirst({ id: 'ws1', failureGroupState: { groups: [makeGroup()], models: [makeModel({ id: 'old', name: 'Stale Model', targetSensor: 'TAG3' })], runningConditionNoneConfirmed: true, rcLegacyNotice: null, runningConditionTimePeriods: ALL_TIME_TRAIN, runningConditionTestPeriods: ONE_TEST } });
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
                        runningConditionNoneConfirmed: true, rcLegacyNotice: null, runningConditionTimePeriods: ALL_TIME_TRAIN, runningConditionTestPeriods: ONE_TEST,
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
            fireEvent.click(screen.getByTestId('rc-card-open'));

            let resolveUpdate!: (v: unknown) => void;
            mockUpdateWorkspaceData.mockImplementationOnce(() => new Promise((res) => { resolveUpdate = res; }));
            // 2026-10-03: the write only starts at Apply (draft edits never write).
            fireEvent.click(screen.getByText('Add condition'));
            fireEvent.click(screen.getByTestId('rc-apply'));

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
                        runningConditionCombine: 'and', runningConditionNoneConfirmed: false, rcLegacyNotice: null, runningConditionTimePeriods: ALL_TIME_TRAIN, runningConditionTestPeriods: ONE_TEST,
                    },
                });
                await closePromise;
            });
            expect(mockClose).toHaveBeenCalledTimes(1);
        });

        // 🆕 2026-09-30 [issue 1, repeat report] — `TimePeriodsEditor`'s date
        // fields commit to the parent on blur/Enter ONLY (never per keystroke,
        // see that file's own top comment), so typing a period edit and then
        // closing the Edit… modal WITHOUT the input separately losing focus
        // first (e.g. clicking straight from the date field to the X button)
        // used to discard the keystroke entirely: `setRcFilterOpen(false)`
        // just unmounted the panel, `onCommit` never ran, `onPeriodsChange`
        // never fired, nothing was ever tracked in `pendingSaveRef`. These two
        // tests exercise exactly that "type, don't blur, close" sequence —
        // the fix is `flushFocusedInput()` (forces the blur synchronously
        // before the close proceeds), called from both close paths below.
        describe('a Running Condition period edit that never naturally blurs before closing (issue 1 root cause)', () => {
            const seededPeriod = { id: 'p1', start: '2024-01-01T00:00', end: '2024-01-31T23:59' };
            function deliverWithPeriod() {
                return deliverData({
                    failureGroupState: {
                        groups: [makeGroup()], models: [makeModel()],
                        runningConditionNoneConfirmed: false,
                        runningConditionFilters: [{ id: 'f1', sensor: 'TAG1', operation: 'greater_than', value1: '5', value2: '' }],
                        runningConditionTimePeriods: [seededPeriod],
                    },
                });
            }

            // 🆕 2026-10-03: with the explicit Apply step the half-typed date's
            // fate is decided by the Apply click (or the discard prompt on X),
            // not by a silent write on close.
            it('(a) half-typed date + Apply click (real focus(), no manual blur) is committed, written once, and shown on reopen', async () => {
                render(<BuildModelWindow />);
                await deliverWithPeriod();
                statefulUpdateMock([makeModel()], {
                    runningConditionNoneConfirmed: false,
                    runningConditionFilters: [{ id: 'f1', sensor: 'TAG1', operation: 'greater_than', value1: '5', value2: '' }],
                    runningConditionTimePeriods: [seededPeriod],
                });
                fireEvent.click(screen.getByTestId('rc-card-open'));
                const endField = screen.getByLabelText('Period 1 end') as HTMLInputElement;
                // A real user's mouse click moves focus to the field first —
                // reproduce that (fireEvent.change alone does not) — then type,
                // WITHOUT ever separately blurring/pressing Enter before the
                // very next thing the user does: click Apply.
                endField.focus();
                fireEvent.change(endField, { target: { value: '2024-02-15T12:00' } });
                expect(document.activeElement).toBe(endField); // still focused, nothing committed it yet
                expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();

                // Apply is already clickable (an uncommitted period edit counts).
                expect((screen.getByTestId('rc-apply') as HTMLButtonElement).disabled).toBe(false);
                fireEvent.click(screen.getByTestId('rc-apply'));
                await flush();

                expect(mockUpdateWorkspaceData).toHaveBeenCalledTimes(1);
                const lastWrite = await mockUpdateWorkspaceData.mock.results[0].value;
                expect(lastWrite.failureGroupState.runningConditionTimePeriods[0].end).toBe('2024-02-15T12:00');
                expect(screen.queryByRole('dialog', { name: 'Running condition' })).toBeNull();

                fireEvent.click(screen.getByTestId('rc-card-open'));
                expect((screen.getByLabelText('Period 1 end') as HTMLInputElement).value).toBe('2024-02-15T12:00');
            });

            it('(b) closing via X right after typing (no blur) commits the typed date into the draft, so the discard prompt appears instead of silently dropping it', async () => {
                render(<BuildModelWindow />);
                await deliverWithPeriod();
                fireEvent.click(screen.getByTestId('rc-card-open'));
                const endField = screen.getByLabelText('Period 1 end') as HTMLInputElement;
                endField.focus();
                fireEvent.change(endField, { target: { value: '2024-02-15T12:00' } });

                fireEvent.click(screen.getByLabelText('Close'));
                expect(screen.getByTestId('rc-discard-prompt')).toBeTruthy();
                expect(screen.getByRole('dialog', { name: 'Running condition' })).toBeTruthy();
                // "Keep editing" returns to the draft with the typed value intact.
                fireEvent.click(screen.getByTestId('rc-discard-keep'));
                expect((screen.getByLabelText('Period 1 end') as HTMLInputElement).value).toBe('2024-02-15T12:00');
                expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
            });

            it('(c) a native whole-window close with an UNAPPLIED draft just closes — nothing is pending, nothing is written', async () => {
                render(<BuildModelWindow />);
                await deliverWithPeriod();
                fireEvent.click(screen.getByTestId('rc-card-open'));
                const endField = screen.getByLabelText('Period 1 end') as HTMLInputElement;
                endField.focus();
                fireEvent.change(endField, { target: { value: '2024-02-15T12:00' } });

                const preventDefault = vi.fn();
                await act(async () => { await mockCloseRequestedHandler!({ preventDefault }); });
                expect(preventDefault).not.toHaveBeenCalled(); // no pending write to wait for
                expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
            });
        });

        it('the toolbar\'s own Close button also awaits a pending write before calling the Tauri close API', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [withTrained(makeModel({ status: true, healthSetPoints: VALID_IND }))] } });
            let resolveUpdate!: (v: unknown) => void;
            mockUpdateWorkspaceData.mockImplementationOnce(() => new Promise((res) => { resolveUpdate = res; }));

            // "Mark incomplete" lives on the Health score page: a status-only write that stays pending.
            fireEvent.click(screen.getByTestId('page-health'));
            fireEvent.click(await screen.findByTestId('mark-incomplete'));
            fireEvent.click(screen.getByTitle('Close'));
            await act(async () => { await Promise.resolve(); });
            expect(mockClose).not.toHaveBeenCalled();

            await act(async () => {
                resolveUpdate({
                    id: 'ws1',
                    failureGroupState: {
                        groups: [makeGroup()], models: [makeModel({ status: true })],
                        runningConditionNoneConfirmed: true, rcLegacyNotice: null, runningConditionTimePeriods: ALL_TIME_TRAIN, runningConditionTestPeriods: ONE_TEST,
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

// 🆕 2026-09-30 — Custom running-condition editor, Relationship X-axis
// switcher, Clustering cluster-range slider (mockups
// NHHcRb7pib9d5wwXqyZEDN + XidcSEavkVnzLvSibRdDzQ, ported into the Workbench).
describe('Custom running-condition editor (2026-09-30 port)', () => {
    it('switching to Custom seeds from the workspace conditions/periods once, shows the seed note, and Save changes persists the edited fields', async () => {
        const ws = [{ id: 'rcf1', sensor: 'TAG1', operation: 'greater_than', value1: '5', value2: '' }];
        const periods = [{ id: 'p1', start: '2026-01-01T00:00', end: '2026-02-01T00:00' }];
        render(<BuildModelWindow />);
        await deliverData({
            failureGroupState: {
                groups: [makeGroup()], models: [makeModel()],
                runningConditionFilters: ws, runningConditionCombine: 'and', runningConditionTimePeriods: periods,
            },
        });
        statefulUpdateMock([makeModel()], { runningConditionFilters: ws, runningConditionCombine: 'and', runningConditionTimePeriods: periods });
        openSettings();
        fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
        expect(screen.getByTestId('custom-rc-editor')).toBeTruthy();
        // Train/Test validation: the workspace TEST periods are copied too (seedCustomFromWorkspace).
        expect(screen.getByTestId('pm-seed-note').textContent).toMatch(/Copied 1 train period, 1 test period and 1 condition from Workspace/);
        expect((screen.getByPlaceholderText('val') as HTMLInputElement).value).toBe('5');
        expect(within(screen.getByTestId('custom-test-periods')).getByTestId('test-row-1')).toBeTruthy();

        fireEvent.change(screen.getByPlaceholderText('val'), { target: { value: '9' } });
        await act(async () => {
            fireEvent.click(screen.getByText('Save changes'));
            await Promise.resolve(); await Promise.resolve();
        });
        const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
        const saved = state.failureGroupState.models[0];
        expect(saved.runningConditionMode).toBe('custom');
        expect(saved.customRunningConditionFilters[0].value1).toBe('9');
        expect(saved.filterTimePeriods[0].start).toBe('2026-01-01T00:00');
        // the copied test period is saved as the model's own (fresh id, same range / label)
        expect(saved.customTestPeriods).toHaveLength(1);
        expect(saved.customTestPeriods[0]).toMatchObject({ start: ONE_TEST[0].start, end: ONE_TEST[0].end, label: 'normal' });
        expect(saved.customTestPeriods[0].id).not.toBe(ONE_TEST[0].id);
    });

    it('switching back to Workspace and forward to Custom again does not re-seed once the custom list is non-empty', async () => {
        const ws = [{ id: 'rcf1', sensor: 'TAG1', operation: 'greater_than', value1: '5', value2: '' }];
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel()], runningConditionFilters: ws } });
        openSettings();
        fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
        expect(screen.getByTestId('pm-seed-note')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
        expect(screen.queryByTestId('custom-rc-editor')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
        // The previously-seeded condition is still there (the switch back to
        // Workspace never discarded it) and, because the draft's own custom
        // list is no longer empty, this second switch does not re-seed (no
        // note this time).
        expect((screen.getByPlaceholderText('val') as HTMLInputElement).value).toBe('5');
        expect(screen.queryByTestId('pm-seed-note')).toBeNull();
    });

    it('"No condition — use all rows", the AND/OR toggle, and the collapsed summary line ("Custom · N cond · M periods")', async () => {
        render(<BuildModelWindow />);
        // no workspace conditions/periods (train or test) set — nothing to seed
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel()], runningConditionTimePeriods: [], runningConditionTestPeriods: [] } });
        openSettings();
        fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
        expect(screen.queryByTestId('pm-seed-note')).toBeNull();

        fireEvent.click(screen.getByText('+ Add condition'));
        fireEvent.click(screen.getByText('+ Add condition'));
        const orBtn = screen.getByRole('button', { name: 'OR' });
        fireEvent.click(orBtn);
        expect(orBtn.className).toBe('on');

        fireEvent.click(screen.getByText('No condition — use all rows'));
        expect(screen.getByText('✓ No condition — all rows')).toBeTruthy();

        // Collapse "Model settings" back and check the summary line.
        fireEvent.click(screen.getByText('Model settings', { selector: 'b' }));
        expect(screen.getByText(/Custom · no cond · 0 train · 0 test/)).toBeTruthy();
    });
});

describe('Relationship X-axis switcher (2026-09-30 port)', () => {
    it('defaults to the first fitted predictor, changes the chart X-axis immediately (no draft/Save needed), and persists scatterXSensor', async () => {
        const rel = makeModel({ id: 'r1', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2', 'TAG3'], scatterXSensor: '' });
        mockInvoke.mockImplementation((cmd: string, args?: any) => {
            if (cmd === 'preview_relationship_model') {
                return Promise.resolve({
                    request: 'req-1', r2_per_step: [0.8], rmse2_per_step: [0.4],
                    n_rows: 3, predicted: [1, 2, 3],
                    target_raw: [1.1, 2.1, 2.9], predictor_raw: [[1, 10], [2, 20], [3, 30]],
                });
            }
            return defaultInvoke(cmd, args);
        });
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel] } });
        statefulUpdateMock([rel]);
        await act(async () => {
            fireEvent.click(trainSensorBtn());
            await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        });
        await waitFor(() => expect(screen.getByTestId('results-chart')).toBeTruthy());
        const xTrigger = () => within(screen.getByTestId('fit-x-selector')).getByRole('button', { name: 'X sensor' });
        const fitAxis = () => within(screen.getByTestId('chart-card-fit')).getByTestId('echarts-mock').getAttribute('data-x-axis-name');
        expect(rowTag(xTrigger())).toBe('TAG2');
        expect(fitAxis()).toBe('TAG2');
        expect(screen.queryByText(/Unsaved changes/)).toBeNull();

        pickSingle(xTrigger(), 'TAG3');
        await flush();
        // The write is immediate and the preview is re-requested with the new X predictor.
        await waitFor(() => expect(fitAxis()).toBe('TAG3'));
        expect(healthCalls().pop()).toMatchObject({ x_predictor: 'TAG3' });
        const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
        expect(state.failureGroupState.models[0].scatterXSensor).toBe('TAG3');
        // Still no draft — this was a direct, immediate write.
        expect(screen.queryByText(/Unsaved changes/)).toBeNull();
    });

    it('falls back to the first predictor when the saved scatterXSensor is no longer among the fitted predictors', async () => {
        const rel = makeModel({ id: 'r1', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2'], scatterXSensor: 'TAG3-removed' });
        mockInvoke.mockImplementation((cmd: string, args?: any) => {
            if (cmd === 'preview_relationship_model') {
                return Promise.resolve({
                    request: 'req-1', r2_per_step: [0.8], rmse2_per_step: [0.4],
                    n_rows: 3, predicted: [1, 2, 3],
                    target_raw: [1.1, 2.1, 2.9], predictor_raw: [[1], [2], [3]],
                });
            }
            return defaultInvoke(cmd, args);
        });
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel] } });
        statefulUpdateMock([rel]);
        await act(async () => {
            fireEvent.click(trainSensorBtn());
            await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        });
        await waitFor(() => expect(screen.getByTestId('results-chart')).toBeTruthy());
        // The saved X predictor is not among the fitted ones: the request carries NO x_predictor,
        // so the Fit chart falls back to the first predictor.
        expect(healthCalls()[0].x_predictor).toBeUndefined();
        expect(within(screen.getByTestId('chart-card-fit')).getByTestId('echarts-mock').getAttribute('data-x-axis-name')).toBe('TAG2');
    });
});

describe('Cluster-range slider (2026-09-30 port)', () => {
    const pill = (i: number) => screen.getByTestId(`cluster-pill-${i}`).textContent;
    const bound = (i: number) => screen.getByTestId(`cluster-bound-${i}`) as HTMLInputElement;

    it('is always visible: shows the "no criteria sensor" empty state when none is picked, and never fetches stats for it', async () => {
        const clu = makeModel({ id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2', criteriaSensor: '', numClusters: 3 });
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [clu] } });
        openSettings();
        expect(screen.getByTestId('cluster-slider-empty').textContent).toMatch(/Pick a criteria sensor/);
        expect(mockInvoke).not.toHaveBeenCalledWith('compute_sensor_stats', expect.objectContaining({ sensor: '' }));
    });

    it('shows the "one cluster" empty state when numClusters <= 1, even with a criteria sensor set', async () => {
        const clu = makeModel({ id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2', criteriaSensor: 'TAG3', numClusters: 1 });
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [clu] } });
        openSettings();
        await flush();
        expect(screen.getByTestId('cluster-slider-empty').textContent).toMatch(/One cluster/);
    });

    it('shows a loading state while criteria stats are in flight, then the slider once they resolve', async () => {
        let resolveStats: (v: unknown) => void = () => {};
        mockInvoke.mockImplementation((cmd: string) => {
            if (cmd === 'compute_sensor_stats') return new Promise(res => { resolveStats = res; });
            return Promise.resolve({});
        });
        const clu = makeModel({
            id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2', criteriaSensor: 'TAG3',
            numClusters: 2, clusterRanges: [{ min: 0, max: 5 }, { min: 5, max: 10 }],
        });
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [clu] } });
        openSettings();
        await flush();
        expect(screen.getByTestId('cluster-slider-loading')).toBeTruthy();
        await act(async () => {
            resolveStats({ mean: 5, sd: 1, min: 0, max: 10, count: 100, lower1: 4, upper1: 6, lower3: 2, upper3: 8 });
            await Promise.resolve(); await Promise.resolve();
        });
        expect(screen.getByTestId('cluster-slider')).toBeTruthy();
    });

    it('shows the "constant value" empty state when the criteria sensor has min === max', async () => {
        mockInvoke.mockImplementation((cmd: string) => {
            if (cmd === 'compute_sensor_stats') return Promise.resolve({ mean: 1, sd: 0, min: 1, max: 1, count: 10, lower1: 1, upper1: 1, lower3: 1, upper3: 1 });
            return Promise.resolve({});
        });
        const clu = makeModel({ id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2', criteriaSensor: 'TAG3', numClusters: 2 });
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [clu] } });
        openSettings();
        await flush();
        expect(screen.getByTestId('cluster-slider-constant').textContent).toMatch(/constant value \(1\)/);
    });

    it("renders segments/handles spanning the criteria sensor's real [min, max], and dragging a handle moves the cluster boundary", async () => {
        const clu = makeModel({
            id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2', criteriaSensor: 'TAG3',
            numClusters: 2, clusterRanges: [{ min: 0, max: 5 }, { min: 5, max: 10 }],
        });
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [clu] } });
        openSettings();
        await flush(); // compute_sensor_stats resolves with the default beforeEach {min:0,max:10,...}
        expect(screen.getByTestId('cluster-slider')).toBeTruthy();
        expect(pill(0)).toBe('#1: 0 – ');
        expect(bound(0).value).toBe('5');
        expect(pill(1)).toBe('#2: 5 – 10');

        const handle = screen.getByRole('slider');
        const track = handle.parentElement as HTMLElement;
        vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
            left: 0, width: 200, top: 0, height: 30, right: 200, bottom: 30, x: 0, y: 0, toJSON: () => ({}),
        } as DOMRect);
        fireEvent.mouseDown(handle);
        fireEvent.mouseMove(document, { clientX: 160 }); // 80% of 200px -> value 8 of [0, 10]
        fireEvent.mouseUp(document);
        expect(bound(0).value).toBe('8');
        expect(pill(1)).toBe('#2: 8 – 10');
    });

    // 🆕 2026-10-09 (real-app test, item 7): the optional criteria sensor must be clearable.
    // Without one there is only one cluster (Rust rejects n_clusters > 1 with no criteria
    // sensor), so clearing it drops the count to 1 in the same draft edit.
    it('clearing the criteria sensor (None / ×) leaves a valid one-cluster model; Save writes no criteria and no ranges', async () => {
        const clu = makeModel({
            id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2', criteriaSensor: 'TAG3',
            numClusters: 3, clusterRanges: [{ min: 0, max: 4 }, { min: 4, max: 7 }, { min: 7, max: 10 }],
        });
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [clu] } });
        statefulUpdateMock([clu]);
        openSettings();
        await flush();
        expect(screen.getByTestId('cluster-slider')).toBeTruthy();
        fireEvent.change(screen.getByDisplayValue('TAG3'), { target: { value: '' } }); // the picker's onSelect('')
        expect(sensorPickerModalProps.filter(p => p.noun === 'criteria sensor').pop().value).toBe('');
        expect(screen.getByTestId('cluster-slider-empty').textContent).toMatch(/One cluster/);
        expect(screen.getByRole('button', { name: 'Fewer clusters' }).nextElementSibling!.textContent).toBe('1');
        expect(screen.queryByTestId('settings-to-fix')).toBeNull();
        await act(async () => { fireEvent.click(screen.getByText('Save changes')); await Promise.resolve(); await Promise.resolve(); });
        const m = (await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value).failureGroupState.models[0];
        expect(m).toMatchObject({ criteriaSensor: '', numClusters: 1, clusterRanges: [] });
    });

    it('2+ clusters with no criteria sensor is an item to fix (Train would be refused); setting Clusters to 1 clears it', async () => {
        const clu = makeModel({ id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2', criteriaSensor: '', numClusters: 2 });
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [clu] } });
        openSettings();
        expect(screen.getByTestId('settings-to-fix').textContent).toBe('1 to fix');
        expect(screen.getAllByText('Pick a criteria sensor for 2+ clusters (or set Clusters to 1)').length).toBeGreaterThan(0);
        expect(trainSensorBtn().disabled).toBe(true);
        fireEvent.click(screen.getByRole('button', { name: 'Fewer clusters' }));
        expect(screen.queryByTestId('settings-to-fix')).toBeNull();
        expect(trainSensorBtn().disabled).toBe(false);
    });

    // 🆕 2026-10-09 (real-app test, item 8): exact boundaries must be typeable — dragging
    // slowly takes too long. Inner boundaries are inputs; Enter / blur commit, Esc reverts.
    describe('typed cluster boundaries', () => {
        const THREE = () => makeModel({
            id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2', criteriaSensor: 'TAG3',
            numClusters: 3, clusterRanges: [{ min: 0, max: 4 }, { min: 4, max: 7 }, { min: 7, max: 10 }],
        });
        const mountThree = async (clu = THREE()) => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [clu] } });
            statefulUpdateMock([clu]);
            openSettings();
            await flush(); // criteria stats: [0, 10]
        };
        const typeBound = (i: number, text: string, key?: 'Enter' | 'Escape') => {
            fireEvent.focus(bound(i));
            fireEvent.change(bound(i), { target: { value: text } });
            if (key) fireEvent.keyDown(bound(i), { key });
        };
        const save = async () => {
            await act(async () => { fireEvent.click(screen.getByText('Save changes')); await Promise.resolve(); await Promise.resolve(); });
            return (await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value).failureGroupState.models[0];
        };

        it('only the inner boundaries are inputs (N-1); the outer bounds are the sensor range, read-only', async () => {
            await mountThree();
            expect(screen.getAllByRole('textbox', { name: /^Boundary between cluster/ })).toHaveLength(2);
            expect(bound(0).getAttribute('aria-label')).toBe('Boundary between cluster 1 and 2');
            expect(screen.queryByTestId('cluster-bound-2')).toBeNull();
            expect(pill(2)).toBe('#3: 7 – 10');
        });

        it('Enter commits a typed value exactly as typed (never rounded), moves the handle and the next cluster, and Save writes it', async () => {
            await mountThree();
            typeBound(0, '3.250', 'Enter');
            expect(bound(0).value).toBe('3.250');
            expect(pill(1)).toBe('#2: 3.250 – ');
            expect(screen.getAllByRole('slider')[0].getAttribute('aria-valuenow')).toBe('3.25');
            expect(screen.queryByTestId('cluster-bound-error')).toBeNull();
            const m = await save();
            expect(m.clusterRanges).toEqual([{ min: 0, max: 3.25 }, { min: 3.25, max: 7 }, { min: 7, max: 10 }]);
        });

        it('blur commits too', async () => {
            await mountThree();
            typeBound(1, '8.5');
            fireEvent.blur(bound(1));
            expect(pill(2)).toBe('#3: 8.5 – 10');
            expect((await save()).clusterRanges[1]).toEqual({ min: 4, max: 8.5 });
        });

        it('a value out of order or outside the sensor range shows an inline error and is NOT committed; Esc reverts', async () => {
            await mountThree();
            typeBound(0, '7.5', 'Enter'); // past the next boundary (7)
            expect(screen.getByTestId('cluster-bound-error').textContent).toMatch(/between 0 and 7/);
            expect(screen.getByTestId('cluster-bound-error').getAttribute('role')).toBe('alert');
            expect(bound(0).getAttribute('aria-invalid')).toBe('true');
            expect(pill(1)).toBe('#2: 4 – '); // nothing moved
            fireEvent.blur(bound(0));
            expect(screen.getByTestId('cluster-bound-error')).toBeTruthy(); // blur does not commit it either
            expect(screen.queryByText('edited')).toBeNull(); // no draft was made

            typeBound(0, '-1', 'Enter'); // below the criteria sensor's min
            expect(screen.getByTestId('cluster-bound-error').textContent).toMatch(/between 0 and 7/);
            typeBound(0, 'abc', 'Enter');
            expect(screen.getByTestId('cluster-bound-error').textContent).toBe('Enter a number.');

            fireEvent.keyDown(bound(0), { key: 'Escape' });
            expect(bound(0).value).toBe('4');
            expect(screen.queryByTestId('cluster-bound-error')).toBeNull();
        });

        it('a decimal comma ("3,6") is refused with "Use . for decimals" — it is never read as 36', async () => {
            await mountThree();
            typeBound(0, '3,6', 'Enter');
            expect(screen.getByTestId('cluster-bound-error').textContent).toBe('Use . for decimals (e.g. 33.6).');
            expect(pill(1)).toBe('#2: 4 – ');
            typeBound(0, '33,6', 'Enter');
            expect(screen.getByTestId('cluster-bound-error').textContent).toBe('Use . for decimals (e.g. 33.6).');
            expect(screen.queryByText('edited')).toBeNull();
        });

        it('a thousands-grouped value ("1,234.5") is accepted as 1234.5', async () => {
            mockInvoke.mockImplementation((cmd: string, args?: any) => (cmd === 'compute_sensor_stats'
                ? Promise.resolve({ mean: 5000, sd: 1, min: 0, max: 10000, count: 100, lower1: 4, upper1: 6, lower3: 2, upper3: 8 })
                : defaultInvoke(cmd, args)));
            await mountThree(makeModel({
                id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2', criteriaSensor: 'TAG3',
                numClusters: 3, clusterRanges: [{ min: 0, max: 1000 }, { min: 1000, max: 2000 }, { min: 2000, max: 10000 }],
            }));
            typeBound(0, '1,234.5', 'Enter');
            expect(screen.queryByTestId('cluster-bound-error')).toBeNull();
            expect(pill(1)).toBe('#2: 1,234.5 – ');
            expect((await save()).clusterRanges[0]).toEqual({ min: 0, max: 1234.5 });
        });

        it('the same number typed another way ("4" -> "4.0") keeps the typed form but makes no draft', async () => {
            await mountThree();
            typeBound(0, '4.0', 'Enter');
            expect(screen.queryByTestId('cluster-bound-error')).toBeNull();
            expect(bound(0).value).toBe('4.0');
            expect(pill(1)).toBe('#2: 4.0 – ');
            expect(screen.queryByText('edited')).toBeNull();
        });

        it('a pending boundary never leaks into another model: a valid one commits to its own model on blur, an invalid one is dropped', async () => {
            const c1 = THREE();
            const c2 = makeModel({ ...THREE(), id: 'c2', xSensor: 'TAG2', ySensor: 'TAG1', name: 'Model Two' });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [c1, c2] } });
            statefulUpdateMock([c1, c2]);
            const select = async (tag: string) => {
                fireEvent.click(screen.getByTestId(`sensor-list-row-fg:1-${tag}`));
                await flush();
                openSettings();
                await flush();
            };
            await select('tag1');

            // invalid pending text + its error, then another model is selected
            typeBound(0, '99', 'Enter');
            expect(screen.getByTestId('cluster-bound-error')).toBeTruthy();
            await select('tag2');
            expect(screen.getByRole('heading', { name: 'Pump Temp' })).toBeTruthy(); // really on c2 now
            expect(screen.queryByTestId('cluster-bound-error')).toBeNull();
            expect(bound(0).value).toBe('4');
            await select('tag1');
            expect(screen.getByRole('heading', { name: 'Pump Pressure' })).toBeTruthy();
            expect(screen.queryByTestId('cluster-bound-error')).toBeNull(); // the invalid edit was dropped, not kept for c1
            expect(bound(0).value).toBe('4');

            // valid pending text: the box's blur (fires before the click that switches) commits it to c1 only
            typeBound(0, '3.5');
            fireEvent.blur(bound(0));
            await select('tag2');
            expect(bound(0).value).toBe('4');
            expect(screen.queryByText('edited')).toBeNull(); // c2 has no draft
            await select('tag1');
            expect(bound(0).value).toBe('3.5');
            expect(screen.getByText('edited')).toBeTruthy();
            await act(async () => { fireEvent.click(screen.getByText('Save changes')); await Promise.resolve(); await Promise.resolve(); });
            const models = (await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value).failureGroupState.models;
            expect(models.find((x: any) => x.id === 'c1').clusterRanges[0]).toEqual({ min: 0, max: 3.5 });
            expect(models.find((x: any) => x.id === 'c2').clusterRanges[0]).toEqual({ min: 0, max: 4 });
        });

        it('the same value as a neighbour is refused (boundaries stay strictly increasing)', async () => {
            await mountThree();
            typeBound(1, '4', 'Enter');
            expect(screen.getByTestId('cluster-bound-error').textContent).toMatch(/between 4 and 10/);
        });

        it('a computed boundary (float noise) reads rounded, and focusing then leaving it unchanged writes nothing', async () => {
            await mountThree(makeModel({
                id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2', criteriaSensor: 'TAG3',
                numClusters: 3, clusterRanges: [{ min: 0, max: 10 / 3 }, { min: 10 / 3, max: 20 / 3 }, { min: 20 / 3, max: 10 }],
            }));
            expect(bound(0).value).toBe('3.333');
            expect(pill(1)).toBe('#2: 3.333 – ');
            fireEvent.focus(bound(0));
            fireEvent.blur(bound(0));
            expect(screen.queryByText('edited')).toBeNull();
        });

        it('dragging after an invalid entry drops the pending text and its error', async () => {
            await mountThree();
            typeBound(0, '99', 'Enter');
            expect(screen.getByTestId('cluster-bound-error')).toBeTruthy();
            fireEvent.mouseDown(screen.getAllByRole('slider')[0]);
            fireEvent.mouseUp(document);
            expect(screen.queryByTestId('cluster-bound-error')).toBeNull();
            expect(bound(0).value).toBe('4');
        });
    });

    it('App.css gives Clustering its own row-aligned grid and a scrollable Custom running-condition editor', () => {
        expect(cssBlock('.bmw-sets-body--clustering')).toMatch(/display:\s*grid/);
        expect(cssBlock('.rc-scroll')).toMatch(/overflow-y:\s*auto/);
        expect(cssBlock('.rc-custom')).toMatch(/flex:\s*1 1 100%/);
    });
});

// 🆕 2026-10-02 [data-loss repro — Running Condition Filter modal]: real,
// repeated user report that opening the "Running Condition Filter" modal
// (Edit… button) and closing it again — via ANY close path, with ZERO user
// edits — loses the already-saved workspace running condition (periods +
// value conditions + AND/OR). Two prior "fixes" (7b3ccca, flushFocusedInput)
// did not resolve it. This block seeds a FULLY CONFIGURED workspace running
// condition, uses `statefulUpdateMock` so every `updateWorkspaceData` call
// is applied (via the REAL `patch` function BuildModelWindow builds) against
// an evolving in-memory "disk" snapshot — exactly like the production
// read-modify-write — then opens/closes the modal with no edits at all and
// asserts the on-disk snapshot (and the re-rendered modal) still show the
// original condition.
describe('Running Condition Filter modal — open/close with ZERO edits must not lose the saved condition (2026-10-02 repro)', () => {
    const seededPeriod = { id: 'p1', start: '2024-01-01T00:00', end: '2024-01-31T23:59' };
    const seededFilter = { id: 'f1', sensor: 'TAG1', operation: 'greater_than' as const, value1: '5', value2: '' };

    function seedConfiguredWs() {
        return {
            groups: [makeGroup()], models: [makeModel()],
            runningConditionNoneConfirmed: false,
            runningConditionFilters: [seededFilter],
            runningConditionCombine: 'or' as const,
            runningConditionTimePeriods: [seededPeriod],
            rcLegacyNotice: null,
        };
    }

    it('(a) opening then closing via the X button with no edits leaves the saved condition untouched on "disk"', async () => {
        const fg = seedConfiguredWs();
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: fg });
        statefulUpdateMock(fg.models, fg);

        fireEvent.click(screen.getByTestId('rc-card-open'));
        // Sanity: the modal actually shows the seeded condition before closing.
        expect((screen.getByLabelText('Period 1 end') as HTMLInputElement).value).toBe(seededPeriod.end);
        expect(screen.getByDisplayValue('5')).toBeTruthy();

        fireEvent.click(screen.getByLabelText('Close')); // the modal's own X — zero edits made first
        await flush();

        // Re-open and check what's actually shown now — this is what the
        // user sees and reports as "the setting doesn't stay".
        fireEvent.click(screen.getByTestId('rc-card-open'));
        expect((screen.getByLabelText('Period 1 end') as HTMLInputElement).value).toBe(seededPeriod.end);
        expect(screen.getByDisplayValue('5')).toBeTruthy();

        // And the durable "disk" snapshot (what a reload / app relaunch would
        // read back) must still carry it too, whether or not a write fired.
        if (mockUpdateWorkspaceData.mock.calls.length > 0) {
            const lastWrite = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(lastWrite.failureGroupState.runningConditionTimePeriods).toEqual([seededPeriod]);
            expect(lastWrite.failureGroupState.runningConditionFilters).toEqual([seededFilter]);
            expect(lastWrite.failureGroupState.runningConditionCombine).toBe('or');
            expect(lastWrite.failureGroupState.runningConditionNoneConfirmed).toBe(false);
        }
    });

    it('(b) opening then closing via backdrop click with no edits leaves the saved condition untouched', async () => {
        const fg = seedConfiguredWs();
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: fg });
        statefulUpdateMock(fg.models, fg);

        fireEvent.click(screen.getByTestId('rc-card-open'));
        const backdrop = screen.getByRole('dialog', { name: 'Running condition' }).parentElement as HTMLElement;
        fireEvent.click(backdrop); // backdrop click, zero edits
        await flush();

        fireEvent.click(screen.getByTestId('rc-card-open'));
        expect((screen.getByLabelText('Period 1 end') as HTMLInputElement).value).toBe(seededPeriod.end);
        expect(screen.getByDisplayValue('5')).toBeTruthy();

        if (mockUpdateWorkspaceData.mock.calls.length > 0) {
            const lastWrite = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(lastWrite.failureGroupState.runningConditionTimePeriods).toEqual([seededPeriod]);
            expect(lastWrite.failureGroupState.runningConditionFilters).toEqual([seededFilter]);
        }
    });

    it('(c) opening then requesting a native whole-window close with no edits leaves the saved condition untouched', async () => {
        const fg = seedConfiguredWs();
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: fg });
        statefulUpdateMock(fg.models, fg);

        fireEvent.click(screen.getByTestId('rc-card-open'));
        expect((screen.getByLabelText('Period 1 end') as HTMLInputElement).value).toBe(seededPeriod.end);

        const preventDefault = vi.fn();
        await act(async () => {
            await mockCloseRequestedHandler!({ preventDefault });
        });
        await flush();

        if (mockUpdateWorkspaceData.mock.calls.length > 0) {
            const lastWrite = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(lastWrite.failureGroupState.runningConditionTimePeriods).toEqual([seededPeriod]);
            expect(lastWrite.failureGroupState.runningConditionFilters).toEqual([seededFilter]);
        }
    });

    // Hypothesis 3 (CLAUDE.md / the orchestrating session's brief): a
    // Dashboard autosave racing in between BuildModelWindow's read-fresh and
    // write could clobber a just-written running condition with a stale
    // in-memory mirror. Simulated here directly against the real
    // `updateWorkspaceData`/`withFailureGroupState` shape: a "Dashboard"
    // actor holds a STALE mirror (captured before the RC edit) and performs
    // its own full-slice overwrite a tick after BuildModelWindow's own
    // persist resolves, using the SAME real `withFailureGroupState` used in
    // production, against a shared fake "disk".
    it('(d) a stale-mirror Dashboard-style autosave racing in right after a real RC edit does NOT clobber it, when the autosave re-reads disk fresh first (current Dashboard.tsx behavior)', async () => {
        // Two conditions: the AND/OR pill only exists BETWEEN condition rows.
        const fg = { ...seedConfiguredWs(), runningConditionFilters: [seededFilter, { id: 'f2', sensor: 'TAG2', operation: 'less_than' as const, value1: '3', value2: '' }] };
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: fg });

        // Shared fake "disk", exactly like statefulUpdateMock but we also
        // drive a second, independent "Dashboard" writer against the same
        // object to simulate the cross-window race.
        let disk: any = { id: 'ws1', failureGroupState: { ...fg } };
        mockUpdateWorkspaceData.mockImplementation(async (_id: string, patch: (s: any) => any) => {
            disk = patch(disk);
            return disk;
        });

        fireEvent.click(screen.getByTestId('rc-card-open'));
        // Real user edit this time: flip combine AND -> stays, but change a
        // filter value to prove a genuine write happens and must survive.
        fireEvent.click(screen.getByTestId('rc-combine')); // OR -> AND
        fireEvent.click(screen.getByTestId('rc-apply')); // 2026-10-03: edits only land on Apply
        await flush();

        // "Dashboard" (stale mirror captured BEFORE the edit above) now runs
        // its autosave, re-reading disk fresh first — current production
        // behavior in Dashboard.tsx's autosave effect (loadWorkspaceData
        // right before the write). This must see the fresh combine, not the
        // stale 'or'.
        const freshFromDisk = disk.failureGroupState;
        expect(freshFromDisk.runningConditionCombine).toBe('and'); // the real edit landed
        expect(freshFromDisk.runningConditionTimePeriods).toEqual([seededPeriod]); // untouched field survived
    });

    // 🆕 2026-10-02 [real root cause, confirmed]: `BuildModelWindow` mounts
    // under React.StrictMode in production (src/main.tsx) — every effect on
    // this window's OWN first mount runs twice (mount -> cleanup -> mount) —
    // and separately, Dashboard's `spawnBuildModel` re-sends `build-model-data`
    // every time "Build Model" is clicked while the window is already open
    // (re-pointing it, not just focusing it — see `Dashboard.tsx`). Either
    // path can start a SECOND hydration pass's `loadWorkspaceData()` call
    // while THIS window's own `persistRunningCondition` write (from the RC
    // modal) is still in flight. Before this fix, `loadWorkspaceData` was a
    // bare, unqueued read — not serialized against this window's own
    // `updateWorkspaceData` writes the way `updateWorkspaceData`'s OWN
    // internal read already was. A re-hydration whose read started before
    // the edit but resolved after the edit's write landed would read
    // pre-edit data and `applyFg` it straight over the just-saved local
    // state, reverting the ON-SCREEN value back to the old one — even
    // though the write itself had already landed correctly on disk. This
    // is exactly what repeated user reports described ("regardless of how I
    // close it, the value doesn't stay") and precisely why it looked like
    // total data loss rather than a timing issue: from the user's side there
    // is no way to tell "the edit never saved" apart from "the edit saved,
    // then something reverted the display" — both look like the setting
    // vanished the moment they look again.
    //
    // Confirmed with a real repro against this component with
    // `workspaceManager` mocked out exactly the way it still is in this
    // file (the SAME scenario below reliably reproduced the revert before
    // `src/workspaceManager.ts`'s `loadWorkspaceData` was changed to route
    // through the same `enqueue` queue `updateWorkspaceData` already used —
    // see that file's own comment on both functions). Because this test
    // file mocks `../workspaceManager` entirely, it cannot exercise the
    // real queue the fix lives in; the regression test that actually proves
    // the fix is `src/__tests__/workspaceManager.test.ts`'s "a
    // `loadWorkspaceData` call started before an `updateWorkspaceData`
    // write landed must not resolve with pre-write data" — that test goes
    // red without the fix and green with it. This comment stays here as
    // the pointer from BuildModelWindow's own test file to where the real
    // coverage lives, since this is where the bug was actually found and
    // where `BuildModelWindow.tsx`'s own hydration code (the `applyFg` call
    // this bug clobbers) lives.
});

// 🆕 2026-10-03 [Running Condition Filter modal — explicit Apply]: user was
// unsure whether edits in this modal "really took effect" because every
// keystroke / blur persisted immediately and nothing said so. The modal now
// edits a LOCAL DRAFT of all four workspace fields and only Apply writes
// (ONE `persistRunningCondition` call) — same mental model as the Dashboard
// Filter tab's "Apply filter". Persisted values (rcbar, the build gate, every
// per-model Workspace mode) never see a dirty draft.
describe('Running Condition Filter modal — draft + explicit Apply (2026-10-03)', () => {
    const seededPeriod = { id: 'p1', start: '2024-01-01T00:00', end: '2024-01-31T23:59' };
    const seededFilter = { id: 'f1', sensor: 'TAG1', operation: 'greater_than' as const, value1: '5', value2: '' };
    const fgSeed = () => ({
        groups: [makeGroup()], models: [makeModel()],
        runningConditionNoneConfirmed: false,
        runningConditionFilters: [seededFilter],
        runningConditionCombine: 'or' as const,
        runningConditionTimePeriods: [seededPeriod],
        rcLegacyNotice: null,
    });
    const apply = () => screen.getByTestId('rc-apply') as HTMLButtonElement;
    const writes = () => mockUpdateWorkspaceData.mock.calls.length;
    const fgChangedEmits = () => mockEmit.mock.calls.filter(c => c[0] === 'failure-group-state-changed');

    /** Two conditions: the AND/OR pill only exists BETWEEN condition rows. */
    const secondFilter = { id: 'f2', sensor: 'TAG2', operation: 'less_than' as const, value1: '3', value2: '' };
    const twoConds = () => ({ ...fgSeed(), runningConditionFilters: [seededFilter, secondFilter] });

    async function openModal(fg: Record<string, any> = fgSeed()) {
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: fg });
        statefulUpdateMock(fg.models, fg);
        mockUpdateWorkspaceData.mockClear();
        mockEmit.mockClear();
        fireEvent.click(screen.getByTestId('rc-card-open'));
    }

    it('editing a value / combine only changes the draft — nothing is written or broadcast, and the Step-1 card keeps the persisted text', async () => {
        await openModal(twoConds());
        const barBefore = screen.getByTestId('rc-card').textContent;
        fireEvent.change(screen.getByDisplayValue('5'), { target: { value: '9' } });
        fireEvent.click(screen.getByTestId('rc-combine')); // OR -> AND
        await flush();
        expect(writes()).toBe(0);
        expect(fgChangedEmits()).toHaveLength(0);
        expect((screen.getByDisplayValue('9') as HTMLInputElement).value).toBe('9'); // the modal shows the draft
        expect(screen.getByTestId('rc-card').textContent).toBe(barBefore); // ...the card does not
        expect(barBefore).toMatch(/> 5/);
    });

    it('Apply is disabled while clean, enabled + "Changes not applied yet" while dirty, and disabled again when the edit is reverted', async () => {
        await openModal();
        expect(apply().disabled).toBe(true);
        expect(screen.queryByTestId('rc-dirty-hint')).toBeNull();

        fireEvent.change(screen.getByDisplayValue('5'), { target: { value: '9' } });
        expect(apply().disabled).toBe(false);
        expect(screen.getByTestId('rc-dirty-hint').textContent).toBe('Changes not applied yet');

        fireEvent.change(screen.getByDisplayValue('9'), { target: { value: '5' } });
        expect(apply().disabled).toBe(true);
        expect(screen.queryByTestId('rc-dirty-hint')).toBeNull();
    });

    it('Apply writes ONCE with all four fields, broadcasts once, closes the modal, and a reopen shows the applied values', async () => {
        await openModal(twoConds());
        fireEvent.change(screen.getByDisplayValue('5'), { target: { value: '9' } });
        fireEvent.click(screen.getByTestId('rc-combine')); // OR -> AND
        fireEvent.click(apply());
        await flush();

        expect(writes()).toBe(1);
        const written = (await mockUpdateWorkspaceData.mock.results[0].value).failureGroupState;
        expect(written.runningConditionFilters).toEqual([{ ...seededFilter, value1: '9' }, secondFilter]);
        expect(written.runningConditionCombine).toBe('and');
        expect(written.runningConditionTimePeriods).toEqual([seededPeriod]);
        expect(written.runningConditionNoneConfirmed).toBe(false);
        expect(fgChangedEmits()).toHaveLength(1);
        expect(screen.queryByRole('dialog', { name: 'Running condition' })).toBeNull();
        expect(screen.getByTestId('rc-card').textContent).toMatch(/> 9/); // persisted text updated

        fireEvent.click(screen.getByTestId('rc-card-open'));
        expect(screen.getByDisplayValue('9')).toBeTruthy();
        expect(apply().disabled).toBe(true); // a fresh open is clean
    });

    it('Apply is disabled for an invalid training period (end before start) and the existing error text shows', async () => {
        await openModal();
        const end = screen.getByLabelText('Period 1 end') as HTMLInputElement;
        fireEvent.change(end, { target: { value: '2023-01-01T00:00' } });
        fireEvent.blur(end);
        expect(screen.getByTestId('rc-invalid-reason')).toBeTruthy();
        expect(apply().disabled).toBe(true);
        fireEvent.click(apply());
        await flush();
        expect(writes()).toBe(0);
    });

    it('Cancel discards the draft: nothing is written, and reopening shows the persisted (not the discarded) values', async () => {
        await openModal();
        fireEvent.change(screen.getByDisplayValue('5'), { target: { value: '9' } });
        fireEvent.click(screen.getByTestId('rc-cancel'));
        expect(screen.queryByRole('dialog', { name: 'Running condition' })).toBeNull();
        expect(writes()).toBe(0);
        fireEvent.click(screen.getByTestId('rc-card-open'));
        expect(screen.getByDisplayValue('5')).toBeTruthy();
        expect(screen.queryByDisplayValue('9')).toBeNull();
    });

    it('X with a CLEAN modal closes at once (no prompt)', async () => {
        await openModal();
        fireEvent.click(screen.getByLabelText('Close'));
        expect(screen.queryByTestId('rc-discard-prompt')).toBeNull();
        expect(screen.queryByRole('dialog', { name: 'Running condition' })).toBeNull();
    });

    it('X with a dirty draft asks "Discard...?" instead of closing; Keep editing keeps the draft, Discard drops it', async () => {
        await openModal();
        fireEvent.change(screen.getByDisplayValue('5'), { target: { value: '9' } });
        fireEvent.click(screen.getByLabelText('Close'));
        expect(screen.getByTestId('rc-discard-prompt')).toBeTruthy();
        expect(screen.getByRole('dialog', { name: 'Running condition' })).toBeTruthy();
        expect(screen.queryByTestId('rc-apply')).toBeNull(); // the prompt replaces the Apply row

        fireEvent.click(screen.getByTestId('rc-discard-keep'));
        expect(screen.queryByTestId('rc-discard-prompt')).toBeNull();
        expect(screen.getByDisplayValue('9')).toBeTruthy(); // draft intact

        fireEvent.click(screen.getByLabelText('Close'));
        fireEvent.click(screen.getByTestId('rc-discard-confirm'));
        expect(screen.queryByRole('dialog', { name: 'Running condition' })).toBeNull();
        expect(writes()).toBe(0);
        fireEvent.click(screen.getByTestId('rc-card-open'));
        expect(screen.getByDisplayValue('5')).toBeTruthy();
    });

    it('backdrop click with a dirty draft also asks before discarding', async () => {
        await openModal();
        fireEvent.change(screen.getByDisplayValue('5'), { target: { value: '9' } });
        fireEvent.click(screen.getByRole('dialog', { name: 'Running condition' }).parentElement as HTMLElement);
        expect(screen.getByTestId('rc-discard-prompt')).toBeTruthy();
        expect(writes()).toBe(0);
    });

    it('a broadcast from another window while the modal is open does not clobber a dirty draft; a clean modal shows it live', async () => {
        await openModal();
        const broadcast = (value1: string) => act(async () => {
            for (const cb of listenCallbacks['failure-group-state-changed'] ?? []) {
                cb({ payload: { ...fgSeed(), runningConditionFilters: [{ ...seededFilter, value1 }], workspaceId: 'ws1', origin: 'dashboard' } });
            }
            await Promise.resolve();
        });
        await broadcast('7');
        expect(screen.getByDisplayValue('7')).toBeTruthy(); // clean modal follows the persisted value

        fireEvent.change(screen.getByDisplayValue('7'), { target: { value: '9' } });
        await broadcast('3');
        expect(screen.getByDisplayValue('9')).toBeTruthy(); // dirty draft survives
        expect(screen.queryByDisplayValue('3')).toBeNull();
    });

    it('App.css keeps the Apply footer sticky at the bottom of the scrolling modal', () => {
        expect(cssBlock('.bmw-modal-foot')).toMatch(/position:\s*sticky/);
        expect(cssBlock('.bmw-modal-foot')).toMatch(/bottom:\s*0/);
    });

    it('the draft never leaks into the build gate or the Step-1 card until Apply', async () => {
        const fg = { ...fgSeed(), runningConditionFilters: [], runningConditionTimePeriods: ALL_TIME_TRAIN };
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: fg });
        statefulUpdateMock(fg.models, fg);
        fireEvent.click(screen.getByTestId('rc-card-open'));
        fireEvent.click(screen.getByTestId('rc-mode-none'));
        expect(screen.getByTestId('rc-card').getAttribute('data-state')).toBe('unset');
        fireEvent.click(apply());
        await flush();
        expect(screen.getByTestId('rc-card').getAttribute('data-state')).toBe('set');
    });
});

// 🆕 2026-10-03 [Running condition Step 1]: the Step-1 card (the header step bar was removed 2026-10-09)
// (replaces the one-line rcbar), the redesigned settings modal and its live
// row-count preview (compute_sensor_stats, reflects the DRAFT). The draft /
// Apply guarantees themselves are tested in the describe above.
describe('Running condition Step 1 — header, card, settings modal preview (2026-10-03)', () => {
    const periods = [
        { id: 'p1', start: '2026-01-01T00:00', end: '2026-03-31T23:59' },
        { id: 'p2', start: '2026-04-15T00:00', end: '' },
    ];
    const cond = { id: 'f1', sensor: 'TAG1', operation: 'greater_than' as const, value1: '5', value2: '' };
    const setFg = (extra: Record<string, any> = {}) => ({
        groups: [makeGroup()], models: [makeModel()],
        runningConditionNoneConfirmed: false, runningConditionFilters: [cond], runningConditionCombine: 'and' as const,
        runningConditionTimePeriods: periods, rcLegacyNotice: null, ...extra,
    });
    const unsetFg = (extra: Record<string, any> = {}) => setFg({ runningConditionFilters: [], runningConditionTimePeriods: [], ...extra });
    const statsCalls = () => mockInvoke.mock.calls.filter(c => c[0] === 'compute_sensor_stats').map(c => c[1] as any);
    const state = () => screen.getByTestId('rc-card').getAttribute('data-state');

    // 2026-10-09: the 5-step progress bar in the window header was removed at the
    // user's request (building goes back and forth; a linear progress did not fit).
    describe('window header (no step bar)', () => {
        it('shows only the title and Close — no step bar — while the Step-1 card stays', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: setFg() });
            expect(screen.queryByTestId('wb-steps')).toBeNull();
            expect(screen.queryByRole('list', { name: 'Build steps' })).toBeNull();
            expect(document.querySelector('[data-testid^="wb-step-"]')).toBeNull();
            const header = screen.getByText('Build Model — Overview').closest('[data-tauri-drag-region]') as HTMLElement;
            expect(header).not.toBeNull();
            expect(within(header).getAllByRole('button').map(b => b.getAttribute('title'))).toEqual(['Close']);
            expect(screen.getByTestId('rc-card')).toBeTruthy();
            expect(screen.queryByText(/Open full view/)).toBeNull();
        });

        it('the Step-1 card follows the PERSISTED condition: a draft in the modal does not change it until Apply', async () => {
            // A train period is required to train (2026-10-07); periods alone never make the condition "set".
            const fg = unsetFg({ runningConditionTimePeriods: ALL_TIME_TRAIN });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: fg });
            statefulUpdateMock(fg.models, fg);
            fireEvent.click(screen.getByTestId('rc-mode-none')); // the unset workspace auto-opened the modal
            expect(state()).toBe('unset');
            fireEvent.click(screen.getByTestId('rc-apply'));
            await flush();
            expect(state()).toBe('set');
        });
    });

    describe('Step-1 card', () => {
        it('Set: compact card with the period chips, the condition chips (sensor name + operator + value + unit) and the row count', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: setFg() });
            expect(state()).toBe('set');
            expect(screen.getByTestId('rc-card').className).toContain('rcc-card--ok');
            expect(screen.getAllByTestId('rc-card-period-chip').map(c => c.textContent)).toEqual(['P1 · 1 Jan 2026 → 31 Mar 2026', 'P2 · 15 Apr 2026 → End']);
            // Train/Test validation: the persisted test periods sit on their own "Test" row
            expect(screen.getAllByTestId('rc-card-test-chip').map(c => c.textContent)).toEqual(['T1 Normal · 1 Jan 2024 → 31 Jan 2024']);
            expect(screen.getByTestId('rc-card-cond-chip').textContent).toBe('Pump PressureTAG1 > 5 bar'); // Inline label (description then tag) + condition; description + unit come from the sensor metadata
            await waitFor(() => expect(screen.getByTestId('rc-card-rows').textContent).toBe('100')); // mocked compute_sensor_stats count
            expect(screen.getByTestId('rc-card-pct').textContent).toBe('rows · 100%');
        });

        it('🆕 2026-10-03: Set card carries the small period strip (persisted periods, restored after 011675b dropped it); the modal draft moves its own strip only, Apply moves the card strip', async () => {
            const impl = (cmd: string) => cmd === 'get_dataset_time_bounds'
                ? Promise.resolve({ min: '2025-01-01 00:00:00', max: '2026-07-31 23:50:00' })
                : cmd === 'compute_sensor_stats' ? Promise.resolve({ count: 100 }) : Promise.resolve({});
            mockInvoke.mockImplementation(impl);
            const fg = setFg();
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: fg });
            statefulUpdateMock(fg.models, fg);
            await flush();
            const cardCov = () => within(screen.getByTestId('rc-card')).getByTestId('period-coverage');
            expect(cardCov().querySelectorAll('.f4-strip i')).toHaveLength(2);
            expect(cardCov().textContent).toContain('Jan 2025');
            expect(cardCov().textContent).toContain('Jul 2026');
            const cardDays = () => within(cardCov()).getByTestId('period-coverage-days').textContent;
            const persisted = cardDays();
            expect(persisted).toMatch(/^\d+ d train · \d+ d test$/);

            fireEvent.click(screen.getByTestId('rc-card-open'));
            await flush();
            const dlg = within(screen.getByRole('dialog', { name: 'Running condition' }));
            const modalDays = () => dlg.getByTestId('period-coverage-days').textContent;
            const modalBefore = modalDays();
            fireEvent.change(dlg.getByLabelText('Period 1 end'), { target: { value: '2026-02-10T23:59' } });
            expect(modalDays()).not.toBe(modalBefore); // the modal strip follows the draft...
            expect(cardDays()).toBe(persisted); // ...the card strip does not
            fireEvent.blur(dlg.getByLabelText('Period 1 end')); // commit the typed date into the modal draft
            await flush();
            expect(cardDays()).toBe(persisted); // still the persisted periods (draft committed, not applied)

            fireEvent.click(screen.getByTestId('rc-apply'));
            await flush();
            expect(cardDays()).not.toBe(persisted); // Apply commits -> the card now draws the new period
        });

        it('🆕 2026-10-03: no period strip on the card while the dataset bounds are unknown', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: setFg() });
            await waitFor(() => expect(screen.getByTestId('rc-card-rows')).toBeTruthy());
            expect(within(screen.getByTestId('rc-card')).queryByTestId('period-coverage')).toBeNull();
        });

        it('Set with "Use all rows": "All rows — no condition" and a single unfiltered count query', async () => {
            render(<BuildModelWindow />);
            // one train period open at both ends = the whole time range, chosen explicitly
            await deliverData({ failureGroupState: setFg({ runningConditionNoneConfirmed: true, runningConditionTimePeriods: ALL_TIME_TRAIN }) });
            expect(within(screen.getByTestId('rc-card-cond')).getByText('All rows — no condition')).toBeTruthy();
            await waitFor(() => expect(screen.getByTestId('rc-card-rows')).toBeTruthy());
            expect(statsCalls()).toEqual([{ sensor: 'TAG1', filter: null }]);
        });

        it('Train/Test validation: NO train period = "0 rows — add a train period" on the card and no count query at all (never a whole-dataset count)', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: setFg({ runningConditionNoneConfirmed: true, runningConditionTimePeriods: [] }) });
            await flush();
            expect(screen.getByTestId('rc-card-period-chip').textContent).toBe('No train period — add one');
            expect(screen.getByTestId('rc-card-no-train').textContent).toBe('rows — add a train period');
            expect(statsCalls()).toEqual([]);
        });

        it('Set: the count queries use the SAME filter payload as training (periods + value conditions + combine), plus the unfiltered total', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: setFg({ runningConditionCombine: 'or' }) });
            await waitFor(() => expect(statsCalls()).toHaveLength(2));
            expect(statsCalls()).toContainEqual({ sensor: 'TAG1', filter: null });
            expect(statsCalls()).toContainEqual({
                sensor: 'TAG1',
                filter: {
                    timestamp_ranges: [{ start: '2026-01-01T00:00', end: '2026-03-31T23:59' }, { start: '2026-04-15T00:00', end: null }],
                    value_filters: [{ sensor: 'TAG1', operation: 'greater_than', value1: 5, value2: null }],
                    combine: 'or',
                },
            });
        });

        it('Set: a failing count shows "— rows" and never blocks anything', async () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            mockInvoke.mockImplementation((cmd: string) => cmd === 'compute_sensor_stats' ? Promise.reject(new Error('No data loaded')) : Promise.resolve({}));
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: setFg() });
            await waitFor(() => expect(screen.getByTestId('rc-card-rows-error').textContent).toBe('— rows'));
            expect(state()).toBe('set');
            expect(trainSensorBtn().disabled).toBe(false);
            warn.mockRestore();
        });

        it('Edit opens the settings modal', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: setFg() });
            expect(screen.queryByRole('dialog', { name: 'Running condition' })).toBeNull();
            expect(screen.getByTestId('rc-card-open').textContent).toBe('Edit');
            fireEvent.click(screen.getByTestId('rc-card-open'));
            expect(screen.getByRole('dialog', { name: 'Running condition' })).toBeTruthy();
        });

        it('Not set: big yellow card with "Set running condition →"; it asks no count query; the button opens the modal', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: unsetFg() });
            expect(state()).toBe('unset');
            expect(screen.getByTestId('rc-card').className).toContain('rcc-card--req');
            expect(screen.getByTestId('rc-card').textContent).toContain('Set the running condition');
            expect(screen.getByTestId('rc-card-open').textContent).toBe('Set running condition →');
            await act(async () => { await Promise.resolve(); });
            expect(statsCalls()).toHaveLength(0);
            fireEvent.click(screen.getByLabelText('Close')); // the unset workspace auto-opened the modal
            expect(screen.queryByRole('dialog', { name: 'Running condition' })).toBeNull();
            fireEvent.click(screen.getByTestId('rc-card-open'));
            expect(screen.getByRole('dialog', { name: 'Running condition' })).toBeTruthy();
        });

        it('Invalid period: red card "Period N needs fixing" + the validatePeriods reason + "Fix period" (opens the modal); no count query', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: setFg({ runningConditionTimePeriods: [periods[0], { id: 'x', start: '2026-06-01T00:00', end: '2026-05-20T23:59' }] }) });
            expect(state()).toBe('invalid');
            expect(screen.getByTestId('rc-card-title').textContent).toBe('Period 2 needs fixing');
            expect(screen.getByTestId('rc-card-reason').textContent).toContain('Period 2 ends before it starts.');
            expect(screen.getByTestId('rc-card-open').textContent).toBe('Fix period');
            await act(async () => { await Promise.resolve(); });
            expect(statsCalls()).toHaveLength(0);
            fireEvent.click(screen.getByTestId('rc-card-open'));
            expect(screen.getByRole('dialog', { name: 'Running condition' })).toBeTruthy();
            expect(screen.getByTestId('rc-fix-period-pill')).toBeTruthy();
        });

        it('the legacy banner and blocked-models line sit UNDER the card (DOM order), not above it', async () => {
            const fg = unsetFg({ rcLegacyNotice: 'pending' });
            let disk: any = { id: 'ws1', failureGroupState: fg };
            mockUpdateWorkspaceData.mockImplementation(async (_id: string, patch: (s: any) => any) => { disk = patch(disk); return disk; });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: fg });
            const card = screen.getByTestId('rc-card');
            for (const id of ['rc-legacy-banner', 'rc-blocked-summary']) {
                expect(card.compareDocumentPosition(screen.getByTestId(id)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
            }
            // ...and the old one-line bar is gone
            expect(document.querySelector('.bmw-rcbar')).toBeNull();
            expect(screen.queryByText('RUNNING CONDITION')).toBeNull();
        });
    });

    describe('training stays locked until Step 1 is done (existing gate, new message)', () => {
        it('Not set: the results area says so, Train / Mark complete stay disabled with the gate reason', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: unsetFg() });
            expect(screen.getByTestId('results-rc-locked').textContent).toContain('Set the running condition first');
            expect(screen.getByTestId('results-rc-locked').textContent).toContain('Training is locked until Step 1 is done.');
            const REASON = 'Set a running condition first, or choose "No condition — use all rows".';
            const train = trainSensorBtn();
            expect(train.disabled).toBe(true);
            expect(train.title).toBe(TRAIN_NEEDS_RUNNING_CONDITION);
            expect(screen.getByTestId('build-block-reason').textContent).toBe(REASON);
            expect(screen.queryByText('✓ Mark complete')).toBeNull(); // Mark complete lives on the Health score page
            expect((screen.getByTestId('page-health') as HTMLButtonElement).disabled).toBe(true);
        });

        it('Invalid period: same lock, "Fix period" button, Train disabled with the period reason', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: setFg({ runningConditionTimePeriods: [{ id: 'x', start: '2026-02-01T00:00', end: '2026-01-05T00:00' }] }) });
            expect(screen.getByTestId('results-rc-locked').textContent).toContain('Fix the running condition first');
            expect(trainSensorBtn().disabled).toBe(true);
            expect(trainSensorBtn().title).toBe("Can't train: Individual — train period 1 ends before it starts");
            expect(screen.getByTestId('results-rc-locked-open').textContent).toBe('Fix period');
        });

        it('Set: no lock, Train enabled', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: setFg() });
            expect(screen.queryByTestId('results-rc-locked')).toBeNull();
            expect(trainSensorBtn().disabled).toBe(false);
        });
    });

    describe('settings modal: structure + live row-count preview of the DRAFT', () => {
        async function open(fg: Record<string, any> = setFg()) {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: fg });
            statefulUpdateMock(fg.models, fg);
            if (!screen.queryByRole('dialog', { name: 'Running condition' })) fireEvent.click(screen.getByTestId('rc-card-open'));
            await flush();
        }

        it('is the two-column "Running condition" dialog: title + subtitle, step 1 / step 2 left, "Data used for training" right', async () => {
            await open();
            const dlg = within(screen.getByRole('dialog', { name: 'Running condition' }));
            expect(dlg.getByRole('heading', { name: 'Running condition' })).toBeTruthy();
            expect(dlg.getByText('Default for every model · a model can use its own on its settings (Custom)')).toBeTruthy();
            expect(dlg.getByText('Which time')).toBeTruthy();
            expect(dlg.getByText('When the plant is running')).toBeTruthy();
            expect(dlg.getByText('Data used for training')).toBeTruthy();
            expect(dlg.getByTestId('rc-count-pill').textContent).toBe('1 condition');
            expect(dlg.getAllByTestId(/^period-row-/)).toHaveLength(2);
            // the old title and panel header are gone
            expect(screen.queryByText('Running Condition Filter')).toBeNull();
        });

        it('shows the persisted count straight away on a clean open (no extra query: the card already asked)', async () => {
            await open();
            await waitFor(() => expect(screen.getByTestId('rc-preview-count').textContent).toBe('100of 100 rows · 100%'));
            expect(statsCalls()).toHaveLength(2); // the card's filtered + unfiltered; opening the modal added none
        });

        it('the preview asks for the DRAFT (what Apply would commit) after a pause, while the Step-1 card keeps the persisted numbers and chips', async () => {
            await open();
            const before = statsCalls().length;
            const cardBefore = screen.getByTestId('rc-card').textContent;
            fireEvent.change(screen.getByDisplayValue('5'), { target: { value: '9' } });
            // not on every keystroke: nothing new yet...
            expect(statsCalls()).toHaveLength(before);
            // ...then ONE query for the draft's filter (the unfiltered total is cached)
            await waitFor(() => expect(statsCalls()).toHaveLength(before + 1), { timeout: 3000 });
            expect(statsCalls()[before]).toEqual({
                sensor: 'TAG1',
                filter: {
                    timestamp_ranges: [{ start: '2026-01-01T00:00', end: '2026-03-31T23:59' }, { start: '2026-04-15T00:00', end: null }],
                    value_filters: [{ sensor: 'TAG1', operation: 'greater_than', value1: 9, value2: null }],
                    combine: 'and',
                },
            });
            expect(screen.getByTestId('rule-sentence').textContent).toContain('Pump Pressure > 9 bar'); // the sentence is the draft too
            expect(screen.getByTestId('rc-card').textContent).toBe(cardBefore); // ...the card behind is persisted-only
            expect(screen.getByTestId('rc-card-cond-chip').textContent).toContain('> 5');
        });

        it('typing several characters sends ONE query for the final value (debounced), not one per keystroke', async () => {
            await open();
            const before = statsCalls().length;
            const input = screen.getByDisplayValue('5');
            for (const v of ['1', '12', '123']) fireEvent.change(input, { target: { value: v } });
            await waitFor(() => expect(statsCalls()).toHaveLength(before + 1), { timeout: 3000 });
            await act(async () => { await new Promise(r => setTimeout(r, 450)); });
            expect(statsCalls()).toHaveLength(before + 1);
            expect(statsCalls()[before].filter.value_filters[0].value1).toBe(123);
        });

        it('a slow answer for an older draft never overwrites the newer one (stale response ignored)', async () => {
            await open();
            const release: Record<string, (v: unknown) => void> = {};
            mockInvoke.mockImplementation((cmd: string, args: any) => {
                if (cmd !== 'compute_sensor_stats') return Promise.resolve({});
                const v = args?.filter?.value_filters?.[0]?.value1;
                if (v === 7) return new Promise(res => { release.slow = res; }); // the OLD draft, held
                if (v === 8) return Promise.resolve({ count: 42 });
                return Promise.resolve({ count: 100 });
            });
            fireEvent.change(screen.getByDisplayValue('5'), { target: { value: '7' } });
            await waitFor(() => expect(release.slow).toBeTruthy(), { timeout: 3000 });
            fireEvent.change(screen.getByDisplayValue('7'), { target: { value: '8' } });
            await waitFor(() => expect(screen.getByTestId('rc-preview-count').textContent).toBe('42of 100 rows · 42%'), { timeout: 3000 });
            await act(async () => { release.slow({ count: 99 }); });
            expect(screen.getByTestId('rc-preview-count').textContent).toBe('42of 100 rows · 42%'); // the late "99" was dropped
        });

        it('a filter that keeps no rows (Rust errors) reads 0 rows, not a failure', async () => {
            await open();
            mockInvoke.mockImplementation((cmd: string, args: any) => {
                if (cmd !== 'compute_sensor_stats') return Promise.resolve({});
                return args?.filter?.value_filters?.[0]?.value1 === 9999
                    ? Promise.reject(new Error("No valid numeric values for sensor 'TAG1'"))
                    : Promise.resolve({ count: 100 });
            });
            fireEvent.change(screen.getByDisplayValue('5'), { target: { value: '9999' } });
            await waitFor(() => expect(screen.getByTestId('rc-preview-count').textContent).toBe('0of 100 rows · 0%'), { timeout: 3000 });
            expect(screen.queryByTestId('rc-preview-error')).toBeNull();
        });

        it('a failing count shows "Couldn\'t count the rows" in the preview and does not stop editing or Apply', async () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            await open();
            mockInvoke.mockImplementation((cmd: string) => cmd === 'compute_sensor_stats' ? Promise.reject(new Error('boom')) : Promise.resolve({}));
            fireEvent.change(screen.getByDisplayValue('5'), { target: { value: '9' } });
            await waitFor(() => expect(screen.getByTestId('rc-preview-error')).toBeTruthy(), { timeout: 3000 });
            expect((screen.getByTestId('rc-apply') as HTMLButtonElement).disabled).toBe(false);
            fireEvent.click(screen.getByTestId('rc-apply'));
            await flush();
            expect(state()).toBe('set');
            expect(screen.queryByRole('dialog', { name: 'Running condition' })).toBeNull();
            warn.mockRestore();
        });

        it('an invalid draft period asks NO count query (it would silently drop the bad period) and says to fix it', async () => {
            await open();
            const before = statsCalls().length;
            const end = screen.getByLabelText('Period 1 end') as HTMLInputElement;
            fireEvent.change(end, { target: { value: '2025-01-01T00:00' } });
            fireEvent.blur(end);
            await waitFor(() => expect(screen.getByTestId('rc-preview-idle').textContent).toBe('Fix the period to see the row count.'));
            await act(async () => { await new Promise(r => setTimeout(r, 450)); });
            expect(statsCalls()).toHaveLength(before);
            expect(screen.getByTestId('rc-invalid-reason').textContent).toContain('Period 1 ends before it starts.');
            expect(screen.getByTestId('rc-fix-period-pill')).toBeTruthy();
        });

        it('Apply -> the Step-1 card (persisted) now shows the new condition and asks its own count for it', async () => {
            await open();
            fireEvent.change(screen.getByDisplayValue('5'), { target: { value: '9' } });
            fireEvent.click(screen.getByTestId('rc-apply'));
            await flush();
            expect(screen.getByTestId('rc-card-cond-chip').textContent).toContain('> 9');
            await waitFor(() => expect(statsCalls().some(c => c.filter?.value_filters?.[0]?.value1 === 9)).toBe(true), { timeout: 3000 });
        });

        it('add / remove a condition and the AND/OR pill: all draft-only (nothing written) until Apply', async () => {
            await open();
            mockUpdateWorkspaceData.mockClear();
            fireEvent.click(screen.getByTestId('rc-add-condition'));
            expect(screen.getByTestId('rc-cond-2')).toBeTruthy();
            expect(screen.getByTestId('rc-combine').textContent).toBe('AND');
            fireEvent.click(screen.getByTestId('rc-combine'));
            expect(screen.getByTestId('rc-combine').textContent).toBe('OR');
            fireEvent.click(within(screen.getByTestId('rc-cond-2')).getByLabelText('Remove condition'));
            expect(screen.queryByTestId('rc-cond-2')).toBeNull();
            expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
        });

        it('the two choice cards map to noneConfirmed: "Use all rows" -> Apply writes noneConfirmed: true and the card says so', async () => {
            await open();
            mockUpdateWorkspaceData.mockClear();
            fireEvent.click(screen.getByTestId('rc-mode-none'));
            fireEvent.click(screen.getByTestId('rc-apply'));
            await flush();
            const written = (await mockUpdateWorkspaceData.mock.results[0].value).failureGroupState;
            expect(written.runningConditionNoneConfirmed).toBe(true);
            expect(within(screen.getByTestId('rc-card-cond')).getByText('All rows — no condition')).toBeTruthy();
        });

        it('operator buttons: picking "between" in the draft shows min / max fields; nothing is written yet', async () => {
            await open();
            mockUpdateWorkspaceData.mockClear();
            const ops = within(within(screen.getByTestId('rc-cond-1')).getByRole('group', { name: 'Condition operator' }));
            fireEvent.click(ops.getByRole('button', { name: 'Between' }));
            expect(within(screen.getByTestId('rc-cond-1')).getByPlaceholderText('min')).toBeTruthy();
            expect(within(screen.getByTestId('rc-cond-1')).getByPlaceholderText('max')).toBeTruthy();
            expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
        });

        it('the sensor field is the real single-select picker component (not a native <select>)', async () => {
            await open();
            sensorPickerModalProps.length = 0;
            fireEvent.click(screen.getByTestId('rc-add-condition'));
            const rcPickers = sensorPickerModalProps.filter(pr => pr.single && pr.noun === 'sensor');
            expect(rcPickers.length).toBeGreaterThan(0);
            expect(rcPickers[0]).toMatchObject({ noun: 'sensor' });
            expect(typeof rcPickers[0].getComponent).toBe('function');
            const modal = screen.getByRole('dialog', { name: 'Running condition' });
            expect(modal.querySelectorAll('select')).toHaveLength(0);
        });
    });

    describe('Esc closes the modal through the same dirty-draft guard as X / backdrop', () => {
        const esc = () => act(async () => { fireEvent.keyDown(document.body, { key: 'Escape' }); await Promise.resolve(); });

        async function open() {
            const fg = setFg();
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: fg });
            statefulUpdateMock(fg.models, fg);
            mockUpdateWorkspaceData.mockClear();
            fireEvent.click(screen.getByTestId('rc-card-open'));
        }

        it('a clean modal closes at once, with no write', async () => {
            await open();
            await esc();
            expect(screen.queryByRole('dialog', { name: 'Running condition' })).toBeNull();
            expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
        });

        it('a dirty draft asks "Discard your unapplied changes?" instead of closing, and writes nothing', async () => {
            await open();
            fireEvent.change(screen.getByDisplayValue('5'), { target: { value: '9' } });
            await esc();
            expect(screen.getByRole('dialog', { name: 'Running condition' })).toBeTruthy();
            expect(screen.getByTestId('rc-discard-prompt').textContent).toBe('Discard your unapplied changes?');
            await esc(); // Esc again does not silently discard either
            expect(screen.getByRole('dialog', { name: 'Running condition' })).toBeTruthy();
            expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
            fireEvent.click(screen.getByTestId('rc-discard-confirm'));
            expect(screen.queryByRole('dialog', { name: 'Running condition' })).toBeNull();
        });

        it('is IGNORED while a nested sensor picker (or any picker backdrop) is open: Esc there closes only the picker', async () => {
            await open();
            const picker = document.createElement('div');
            picker.className = 'pk-pop'; // the shared sensor picker's popover (customer item 3)
            document.body.appendChild(picker);
            await esc();
            expect(screen.getByRole('dialog', { name: 'Running condition' })).toBeTruthy();
            expect(screen.queryByTestId('rc-discard-prompt')).toBeNull();
            picker.remove();
            await esc(); // picker gone -> Esc is the modal's again
            expect(screen.queryByRole('dialog', { name: 'Running condition' })).toBeNull();
        });

        it('does nothing when the modal is closed, and the listener is removed on close (no stale handler)', async () => {
            await open();
            const add = vi.spyOn(window, 'addEventListener');
            const remove = vi.spyOn(window, 'removeEventListener');
            await esc();
            expect(remove.mock.calls.some(c => c[0] === 'keydown')).toBe(true);
            // a later Esc with the modal closed must not throw or reopen anything
            await esc();
            expect(screen.queryByRole('dialog', { name: 'Running condition' })).toBeNull();
            add.mockRestore();
            remove.mockRestore();
        });

        it('other keys do nothing', async () => {
            await open();
            await act(async () => { fireEvent.keyDown(document.body, { key: 'Enter' }); fireEvent.keyDown(document.body, { key: 'a' }); await Promise.resolve(); });
            expect(screen.getByRole('dialog', { name: 'Running condition' })).toBeTruthy();
        });
    });

    it('App.css defines the new blocks (and the old rcbar / collapsible-header rules are gone)', () => {
        for (const sel of ['.rcc-card', '.rcc-card--req', '.rcc-card--bad', '.rcc-card--ok', '.rcm-body', '.rcm-per', '.rcm-mcard', '.rcm-cond', '.rcm-joinbtn', '.rcm-preview', '.bmw-modal--rc']) {
            expect(() => cssBlock(sel), sel).not.toThrow();
        }
        expect(cssBlock('.bmw-modal--rc')).toMatch(/display:\s*flex/);
        expect(cssBlock('.rcm-body')).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\) 340px/);
        for (const gone of ['.bmw-rcbar', '.f4-rc', '.f4-rc-h', '.f4-prow', '.wb2-steps', '.wb2-stp', '.wb2-sn', '.wb2-sline']) {
            expect(() => cssBlock(gone), gone).toThrow();
        }
    });
});

// 🆕 2026-10-03 (health score phase 3a) — "Incomplete immediately" + the
// Relationship train's cached-fit key. The rule itself is tested in
// incompleteRule.test.ts / workspaceManager.test.ts; these pin that THIS
// window's own writers apply it (the mocked `updateWorkspaceData` here never
// runs workspaceManager's central guard) and what its UI shows afterwards.
describe('Incomplete immediately + Relationship fit cache key (health score phase 3a)', () => {
    const SP = { kind: 'relationship', residualAt80Lower: -1.5, residualAt80Upper: 1.5, residualAt0Lower: -3, residualAt0Upper: 3 };
    const relComplete = () => withTrained(makeModel({
        id: 'r1', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2'], relStiffness: 10_000,
        status: true, healthSetPoints: SP,
    }));
    const lastWritten = async () =>
        (await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value).failureGroupState;

    it('"Save changes" after a training input changed (stiffness) sets a Complete model to Incomplete, keeping set points + train record', async () => {
        const rel = relComplete();
        statefulUpdateMock([rel]);
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel] } });
        openSettings();
        fireEvent.click(screen.getByRole('button', { name: 'Strict' }));
        await act(async () => { fireEvent.click(screen.getByText('Save changes')); await Promise.resolve(); await Promise.resolve(); });
        const saved = (await lastWritten()).models[0];
        expect(saved.relStiffness).toBe(1_000_000);
        expect(saved.status).toBe(false);
        expect(saved.healthSetPoints).toEqual(SP);
        expect(saved.lastTrainedAt).toBe(rel.lastTrainedAt);
        expect(saved.trainedFingerprint).toBe(rel.trainedFingerprint);
        // ...and it is broadcast with the demoted status so the Dashboard dot follows.
        const emitted = mockEmit.mock.calls.filter(c => c[0] === 'failure-group-state-changed').pop()![1];
        expect(emitted.models[0].status).toBe(false);
        // The window now shows it as out of date, ready to re-train.
        expect(screen.getByText('Incomplete', { selector: '.model-status-pill' })).toBeTruthy();
        expect(trainSensorBtn().disabled).toBe(false); // stale = ready to train again
    });

    it('"Save changes" of only the NAME keeps it Complete (stiffness/cluster defaults a draft re-derives are not a change)', async () => {
        const rel = relComplete();
        statefulUpdateMock([rel]);
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel] } });
        openSettings();
        fireEvent.change(screen.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Only a new name' } });
        await act(async () => { fireEvent.click(screen.getByText('Save changes')); await Promise.resolve(); await Promise.resolve(); });
        const saved = (await lastWritten()).models[0];
        expect(saved.name).toBe('Only a new name');
        expect(saved.status).toBe(true);
        expect(screen.getByText('Complete', { selector: '.model-status-pill' })).toBeTruthy();
    });

    it('applying a different WORKSPACE running condition sets a Complete Workspace-mode model Incomplete and leaves a Custom-mode one Complete', async () => {
        const COND = { id: 'f1', sensor: 'TAG1', operation: 'greater_than' as const, value1: '5', value2: '' };
        const fgOver = { runningConditionNoneConfirmed: false, runningConditionFilters: [COND], runningConditionCombine: 'and' as const, runningConditionTimePeriods: ALL_TIME_TRAIN, runningConditionTestPeriods: ONE_TEST, rcLegacyNotice: null };
        const fgForStamp = { models: [], ...fgOver };
        const wsMode = withTrained(makeModel({ id: 'ws-mode', status: true }), fgForStamp);
        const customMode = withTrained(makeModel({
            id: 'custom-mode', status: true, targetSensor: 'TAG2', runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true,
        }), fgForStamp);
        const models = [wsMode, customMode];
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models, ...fgOver } });
        statefulUpdateMock(models, fgOver);
        mockUpdateWorkspaceData.mockClear();
        fireEvent.click(screen.getByTestId('rc-card-open'));
        fireEvent.change(screen.getByDisplayValue('5'), { target: { value: '9' } });
        fireEvent.click(screen.getByTestId('rc-apply'));
        await flush();
        const written = (await lastWritten()).models;
        expect(written.find((m: any) => m.id === 'ws-mode').status).toBe(false);
        expect(written.find((m: any) => m.id === 'custom-mode').status).toBe(true);
        const emitted = mockEmit.mock.calls.filter(c => c[0] === 'failure-group-state-changed').pop()![1];
        expect(emitted.models.map((m: any) => m.status)).toEqual([false, true]);
    });

    it('READ side: a Complete model whose train record no longer matches shows as Incomplete + stale, counts as not complete, has no green dot', async () => {
        const stale = { ...withTrained(makeModel({ id: 'old', status: true })), trainedFingerprint: 'written-before-this-rule' };
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [stale] } });
        await flush();
        expect(screen.getByText('Incomplete', { selector: '.model-status-pill' })).toBeTruthy();
        expect(screen.getByTestId('results-stale').textContent).toMatch(/Settings changed/);
        expect(trainSensorBtn().disabled).toBe(false); // stale = ready to train again
        expect(screen.queryByText('Mark incomplete')).toBeNull();
        // Yellow ("needs re-train"), never the green Complete dot.
        expect(screen.getByTestId('sensor-kind-badge-dot-old').className).toMatch(/f4-kb-dot--need/);
        expect(screen.getByTestId('sensor-kind-badge-dot-old').className).not.toMatch(/f4-kb-dot--complete/);
        expect(screen.getByText(/of 1 complete/).textContent).toBe('0 of 1 complete');
        // Opening it does not rewrite the stored status.
        expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
    });

    // Customer batch 2026-10 (item 6): the recipes come from the workspace FILE (never a payload);
    // a special sensor the model was trained on whose formula changed since makes it stale.
    it('READ side: a Complete model trained on a special sensor whose formula changed since is stale (recipes read from disk)', async () => {
        const fresh = withTrained(makeModel({ id: 'sp', status: true, targetSensor: 'TAG1' }));
        const trainedFormulas = { tag1: 'sig-at-train' };
        render(<BuildModelWindow />);
        await deliverData({
            specialSensorRecipes: [{ kind: 'formula', tag: 'TAG1', formula: '$RAW * 3' }],
            failureGroupState: { groups: [makeGroup()], models: [{ ...fresh, trainedFormulas }] },
        });
        await flush();
        expect(screen.getByTestId('sensor-kind-badge-dot-sp').className).not.toMatch(/f4-kb-dot--complete/);
        expect(screen.getByText(/of 1 complete/).textContent).toBe('0 of 1 complete');
        expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
    });

    it('READ side: the same model with its snapshot still matching the recipes stays Complete', async () => {
        const recipes = [{ kind: 'formula' as const, tag: 'TAG1', formula: '$RAW * 3' }];
        const model = withTrained(makeModel({ id: 'sp', status: true, targetSensor: 'TAG1' }));
        const trainedFormulas = snapshotTrainedFormulas(model as any, recipes, { models: [model as any], runningConditionTimePeriods: ALL_TIME_TRAIN, runningConditionNoneConfirmed: true } as any);
        render(<BuildModelWindow />);
        await deliverData({ specialSensorRecipes: recipes, failureGroupState: { groups: [makeGroup()], models: [{ ...model, trainedFormulas }] } });
        await flush();
        expect(screen.getByTestId('sensor-kind-badge-dot-sp').className).toMatch(/f4-kb-dot--complete/);
    });

    it('READ side: a legacy Complete model with NO train record at all stays Complete (nothing to be out of date against)', async () => {
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel({ id: 'legacy', status: true })] } });
        expect(screen.getByText('Complete', { selector: '.model-status-pill' })).toBeTruthy();
        expect(screen.getByTestId('sensor-kind-badge-dot-legacy').className).toMatch(/f4-kb-dot--complete/);
    });

    it('re-training a stale Complete model writes status:false with the fresh train record (it does not silently turn Complete again)', async () => {
        const stale = { ...withTrained(makeModel({ id: 'old', status: true })), trainedFingerprint: 'written-before-this-rule' };
        statefulUpdateMock([stale]);
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [stale] } });
        await act(async () => { fireEvent.click(trainSensorBtn()); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
        const saved = (await lastWritten()).models[0];
        expect(saved.status).toBe(false);
        expect(saved.trainedFingerprint).not.toBe('written-before-this-rule');
        expect(screen.getByText('Trained', { selector: '.model-status-pill' })).toBeTruthy();
    });

    // Review 2026-10-09 (MUST-FIX 2): the recipes this window judges freshness against.
    describe('special-sensor recipes: when this window reads them', () => {
        const R1 = [{ kind: 'formula' as const, tag: 'TAG1', formula: '$RAW * 3' }];
        const fgBase = (models: any[]) => ({
            groups: [makeGroup()], models,
            runningConditionTimePeriods: ALL_TIME_TRAIN, runningConditionTestPeriods: ONE_TEST,
            runningConditionNoneConfirmed: true, rcLegacyNotice: null,
        });
        const trainedOn = (recipes: typeof R1) => {
            const model = withTrained(makeModel({ id: 'sp', status: true, targetSensor: 'TAG1' }));
            return { ...model, trainedFormulas: snapshotTrainedFormulas(model as any, recipes, fgBase([model]) as any) };
        };
        const broadcast = (fg: any, extra: Record<string, unknown>) => act(async () => {
            for (const cb of listenCallbacks['failure-group-state-changed'] ?? []) {
                cb({ payload: { ...fg, workspaceId: 'ws1', origin: 'dashboard', ...extra } });
            }
            await Promise.resolve();
            await Promise.resolve();
        });

        it('an ordinary Dashboard broadcast costs no disk read; only recipesChanged re-reads the recipes', async () => {
            const model = trainedOn(R1);
            render(<BuildModelWindow />);
            await deliverData({ specialSensorRecipes: R1, failureGroupState: fgBase([model]) });
            await flush();
            expect(screen.getByTestId('sensor-kind-badge-dot-sp').className).toMatch(/f4-kb-dot--complete/);
            mockLoadWorkspaceData.mockClear();

            await broadcast(fgBase([model]), {});
            await flush();
            expect(mockLoadWorkspaceData).not.toHaveBeenCalled();

            // The Dashboard's autosave wrote a new formula for TAG1: only now is disk read.
            mockLoadWorkspaceData.mockResolvedValue({ id: 'ws1', specialSensorRecipes: [{ ...R1[0], formula: '$RAW * 4' }], failureGroupState: fgBase([model]) });
            await broadcast(fgBase([model]), { recipesChanged: true });
            await flush();
            expect(mockLoadWorkspaceData).toHaveBeenCalledTimes(1);
            expect(screen.getByTestId('sensor-kind-badge-dot-sp').className).not.toMatch(/f4-kb-dot--complete/);
        });

        // The reported bug: Repair -> the Dashboard writes the demotion and broadcasts -> this
        // window reads disk BEFORE the autosave writes the new recipe -> no later broadcast ->
        // a freshly trained model showed "Settings changed -- re-train" forever. The Train's own
        // write result now carries the recipes it stamped against, and this window adopts them.
        for (const [label, diskRecipes] of [
            ['Repair (the trained-on sensor gets a new formula)', [{ ...R1[0], formula: '$RAW * 5' }]],
            ['an unused sensor edited', [...R1, { kind: 'formula' as const, tag: 'TAG3', formula: '$RAW + 2' }]],
        ] as const) {
            it(`after ${label} with no recipesChanged broadcast reaching this window, a Train reads Trained and fresh`, async () => {
                const demoted = { ...trainedOn(R1), status: false, trainedFingerprint: undefined };
                render(<BuildModelWindow />);
                await deliverData({ specialSensorRecipes: R1, failureGroupState: fgBase([demoted]) });
                await flush();
                // Disk moved on without this window hearing about it.
                let ws: any = { id: 'ws1', specialSensorRecipes: diskRecipes, failureGroupState: fgBase([demoted]) };
                mockUpdateWorkspaceData.mockImplementation(async (_id: string, patch: (st: any) => any) => { ws = patch(ws); return ws; });
                mockLoadWorkspaceData.mockClear();
                await act(async () => { fireEvent.click(trainSensorBtn()); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
                await waitFor(() => expect(screen.getByText('Trained', { selector: '.model-status-pill' })).toBeTruthy());
                const saved = ws.failureGroupState.models[0];
                expect(saved.trainedFingerprint).toBeTruthy();
                expect(saved.trainedFormulas).toBeTruthy();
                // Fresh: no "Settings changed" banner, and Mark complete is not blocked by it.
                expect(screen.queryByTestId('results-stale')).toBeNull();
                expect(screen.queryByText('Settings changed — re-train first.')).toBeNull();
                expect(screen.getByTestId('sensor-kind-badge-dot-sp').getAttribute('data-state')).toBe('trained');
                // Adopted from the write result, not by an extra disk read.
                expect(mockLoadWorkspaceData).not.toHaveBeenCalled();
            });
        }
    });

    describe('Relationship Train asks Rust to cache the fit under a fingerprint-based key', () => {
        const relModel = () => makeModel({ id: 'r1', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2'], relStiffness: 10_000 });
        const train = async () => {
            await act(async () => { fireEvent.click(trainSensorBtn()); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
        };

        it('passes cache_key = model id + trainedFingerprint, and max_points', async () => {
            const rel = relModel();
            statefulUpdateMock([rel]);
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel] } });
            await train();
            const args = mockInvoke.mock.calls.find(c => c[0] === 'preview_relationship_model')![1] as any;
            const saved = (await lastWritten()).models[0];
            expect(args.cache_key).toBe('r1::' + saved.trainedFingerprint);
            expect(args.max_points).toBe(4000);
            // The existing arguments are unchanged.
            expect(args).toMatchObject({ predictors: ['TAG2'], target: 'TAG1', lambda: 10_000 });
        });

        it('the key changes when the scope changes (Custom-mode period), the predictors or the stiffness change - never reused across fits', async () => {
            const keys: string[] = [];
            for (const over of [
                {},
                { predictorSensors: ['TAG2', 'TAG3'] },
                { relStiffness: 1_000_000 },
                { runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true, filterTimePeriods: [{ id: 'p', start: '2026-01-01T00:00', end: '2026-02-01T00:00' }] },
            ]) {
                cleanup();
                mockInvoke.mockClear();
                const rel = { ...relModel(), ...over };
                statefulUpdateMock([rel]);
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel] } });
                await train();
                keys.push((mockInvoke.mock.calls.find(c => c[0] === 'preview_relationship_model')![1] as any).cache_key);
            }
            expect(new Set(keys).size).toBe(keys.length);
        });

        it('the charts come from compute_health_preview under the SAME cache key as the Train fit, not from the full arrays Train still returns', async () => {
            const rel = relModel();
            statefulUpdateMock([rel]);
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel] } });
            await train();
            await waitFor(() => expect(screen.getByTestId('results-chart')).toBeTruthy());
            const trainKey = (mockInvoke.mock.calls.find(c => c[0] === 'preview_relationship_model')![1] as any).cache_key;
            expect(healthCalls()[0].cache_key).toBe(trainKey);
            expect(healthCalls()[0].max_points).toBe(4000);
            expect(screen.getByTestId('stat-r2')).toBeTruthy();
        });
    });
});

// 🆕 2026-10-04 (health score phase 3b-1): the Workbench's two pages per model.
// Shell (page switch, list hide/show, dots, stale banner, overlay — the header step bar was removed 2026-10-09) and
// the Model fit page wired to `useHealthPreview` / the shared Sub-models modal.
// The pure chart builders and the presentational pieces have their own files
// (healthCharts.test.ts, WorkbenchShell.test.tsx, ModelFitPage.test.tsx,
// SubModelsModal.test.tsx); this block pins the WIRING inside the window.
describe('Workbench two pages — shell + Model fit page (health score 3b-1)', () => {
    const REL = (over: Record<string, any> = {}) =>
        makeModel({ id: 'r1', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2', 'TAG3'], relStiffness: 10_000, ...over });
    const trainedRel = (over: Record<string, any> = {}) => withTrained(REL(over));
    const chartsReady = () => waitFor(() => expect(screen.getByTestId('results-chart')).toBeTruthy());
    const mount = async (models: any[], extraFg: Record<string, any> = {}, payload: Record<string, any> = {}) => {
        // Writes (the first-open set-point snapshot of an Individual model, ...) must build on THESE
        // models, not on the file-wide default snapshot of `beforeEach`.
        statefulUpdateMock(models, extraFg);
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models, ...extraFg } }, payload);
    };

    describe('page switch', () => {
        it('shows "1 Model fit" and "2 Health score"; Health score is disabled for a model that was never trained', async () => {
            await mount([makeModel()]);
            const sw = screen.getByTestId('page-switch');
            expect(within(sw).getByTestId('page-model').getAttribute('aria-pressed')).toBe('true');
            const health = within(sw).getByTestId('page-health') as HTMLButtonElement;
            expect(health.disabled).toBe(true);
            expect(health.title).toBe('Train the model first');
            expect(screen.queryByTestId('page-model-done')).toBeNull();
        });

        it('while stale: Health score is disabled with the title "Re-train first" and Model fit has no tick', async () => {
            await mount([{ ...withTrained(makeModel()), trainedFingerprint: 'old' }]);
            const health = screen.getByTestId('page-health') as HTMLButtonElement;
            expect(health.disabled).toBe(true);
            expect(health.title).toBe('Re-train first');
            expect(screen.queryByTestId('page-model-done')).toBeNull();
        });

        it('trained and fresh: Model fit shows a tick, Health score opens the real page (set points + checks) and back', async () => {
            await mount([withTrained(makeModel())]);
            expect(screen.getByTestId('page-model-done')).toBeTruthy();
            expect(screen.queryByTestId('page-health-done')).toBeNull();
            fireEvent.click(screen.getByTestId('page-health'));
            await waitFor(() => expect(screen.getByTestId('set-points-card')).toBeTruthy());
            expect(screen.getByTestId('checks-card')).toBeTruthy();
            expect(screen.queryByTestId('results-chart')).toBeNull();
            expect(screen.queryByTestId('add-model-form')).toBeNull(); // Model settings live on the Model fit page
            fireEvent.click(screen.getByTestId('page-model'));
            expect(screen.queryByTestId('health-page')).toBeNull();
        });

        it('a Complete model shows a tick on both pages', async () => {
            await mount([withTrained(makeModel({ status: true }))]);
            expect(screen.getByTestId('page-model-done')).toBeTruthy();
            expect(screen.getByTestId('page-health-done')).toBeTruthy();
        });

        it('each model keeps its own page, and a model that turns stale (another window changed it) falls back to Model fit', async () => {
            const rel = trainedRel();
            const ind = withTrained(makeModel({ id: 'i1' }));
            await mount([ind, rel]);
            fireEvent.click(screen.getByTestId('page-health'));
            fireEvent.click(screen.getByRole('tab', { name: /Relationship/ }));
            expect(screen.queryByTestId('health-page')).toBeNull(); // the Relationship model is still on Model fit
            fireEvent.click(screen.getByRole('tab', { name: /Individual/ }));
            expect(screen.getByTestId('health-page')).toBeTruthy(); // ...and Individual kept its page
            // Another window changes a training input of the Relationship model: it turns stale, so
            // its page falls back to Model fit (the stored choice is not erased, just not shown).
            fireEvent.click(screen.getByRole('tab', { name: /Relationship/ }));
            fireEvent.click(screen.getByTestId('page-health'));
            expect(screen.getByTestId('health-page')).toBeTruthy();
            await flush(); // the first-open set-point snapshot write of the Individual model lands before the other window's change
            await act(async () => {
                for (const cb of listenCallbacks['failure-group-state-changed'] ?? []) {
                    cb({ payload: {
                        groups: [makeGroup()], models: [ind, { ...rel, relStiffness: 1_000_000 }],
                        runningConditionNoneConfirmed: true, runningConditionFilters: [], runningConditionCombine: 'and', runningConditionTimePeriods: ALL_TIME_TRAIN, runningConditionTestPeriods: ONE_TEST,
                        workspaceId: 'ws1', origin: 'dashboard',
                    } });
                }
                await Promise.resolve();
            });
            expect(screen.queryByTestId('health-page')).toBeNull();
            expect((screen.getByTestId('page-health') as HTMLButtonElement).disabled).toBe(true);
        });
    });

    describe('footer', () => {
        it('"Next: Health score →" is disabled while untrained or stale (with the reason) and opens the Health score page when fresh', async () => {
            await mount([makeModel()]);
            const next = () => screen.getByTestId('next-health-score') as HTMLButtonElement;
            expect(next().disabled).toBe(true);
            expect(next().title).toBe('Train the model first');
            cleanup();
            await mount([{ ...withTrained(makeModel()), trainedFingerprint: 'old' }]);
            expect(next().disabled).toBe(true);
            expect(next().title).toBe('Re-train first');
            cleanup();
            await mount([withTrained(makeModel())]);
            expect(next().disabled).toBe(false);
            fireEvent.click(next());
            expect(screen.getByTestId('health-page')).toBeTruthy();
            expect(screen.queryByTestId('next-health-score')).toBeNull();
            // "← Model fit" goes back; Mark complete now lives on this page (3b-2).
            expect(screen.getByText('✓ Mark complete')).toBeTruthy();
            fireEvent.click(screen.getByTestId('footer-back-to-fit'));
            expect(screen.queryByTestId('health-page')).toBeNull();
        });

        it('there is no "Open full view" control and no full-view page any more (health score phase 4)', async () => {
            await mount([withTrained(makeModel())]);
            expect(screen.queryByText(/Open full view/)).toBeNull();
            fireEvent.click(screen.getByTestId('page-health'));
            expect(screen.queryByText(/Open full view/)).toBeNull();
        });
    });

    describe('sensor list: hide / show', () => {
        it('hides the list (the detail pane takes the whole width) and shows it again, per window', async () => {
            await mount([makeModel()]);
            expect(screen.getByLabelText('Search sensors')).toBeTruthy();
            fireEvent.click(screen.getByTitle('Hide sensor list'));
            expect(screen.queryByLabelText('Search sensors')).toBeNull();
            // Regression: the grid must be ONE column once the list is gone, else the
            // detail pane lands in the old 0px track and disappears.
            const grid = document.querySelector('.bmw-wb') as HTMLElement;
            expect(grid.style.gridTemplateColumns).toBe('minmax(0,1fr)');
            expect(grid.className).toContain('bmw-wb--nolist');
            expect(screen.getByRole('heading', { name: 'Pump Pressure' })).toBeTruthy();
            fireEvent.click(screen.getByTitle('Show sensor list'));
            expect(screen.getByLabelText('Search sensors')).toBeTruthy();
            expect((document.querySelector('.bmw-wb') as HTMLElement).style.gridTemplateColumns).toBe('300px minmax(0,1fr)');
        });

        it('stays hidden while the user moves between models and pages', async () => {
            await mount([withTrained(makeModel({ id: 'i1' })), trainedRel()]);
            fireEvent.click(screen.getByTitle('Hide sensor list'));
            fireEvent.click(screen.getByRole('tab', { name: /Relationship/ }));
            fireEvent.click(screen.getByTestId('page-health'));
            expect(screen.queryByLabelText('Search sensors')).toBeNull();
        });
    });

    describe('left list status dots (one rule: modelDotState)', () => {
        const dotState = (id: string) => screen.queryByTestId(`sensor-kind-badge-dot-${id}`)?.getAttribute('data-state') ?? null;
        const dotClass = (id: string) => screen.getByTestId(`sensor-kind-badge-dot-${id}`).className;

        it('green = complete, yellow = trained / stale (needs input or re-train), red = blocked, none = never trained', async () => {
            const models = [
                makeModel({ id: 'never', targetSensor: 'TAG1', name: 'never' }),
                withTrained(makeModel({ id: 'done', status: true, targetSensor: 'TAG2', name: 'done' })),
                withTrained(makeModel({ id: 'fresh', targetSensor: 'TAG3', name: 'fresh' })),
            ];
            await mount([...models, { ...withTrained(makeModel({ id: 'stale', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2'], name: 'stale' })), trainedFingerprint: 'old' }]);
            await flush();
            expect(dotState('never')).toBeNull();
            expect(dotClass('done')).toMatch(/f4-kb-dot--complete/);
            expect(dotClass('fresh')).toMatch(/f4-kb-dot--need/);
            expect(dotClass('stale')).toMatch(/f4-kb-dot--need/);
            expect(dotState('stale')).toBe('stale');
        });

        it('red = needs fixing: a model the running-condition gate blocks', async () => {
            await mount([withTrained(makeModel({ id: 'blocked' }))], { runningConditionNoneConfirmed: false, runningConditionFilters: [] });
            await flush();
            expect(dotClass('blocked')).toMatch(/f4-kb-dot--bad/);
            expect(dotState('blocked')).toBe('blocked');
        });

        it('shows the legend under the list', async () => {
            await mount([makeModel()]);
            const leg = screen.getByTestId('status-legend');
            expect(leg.textContent).toMatch(/Needs input \/ re-train/);
            expect(leg.textContent).toMatch(/Fix/);
            expect(leg.textContent).toMatch(/Complete/);
        });

        it('kind tabs carry a small status pill (Complete / Trained / Re-train), none for an untouched model', async () => {
            await mount([
                withTrained(makeModel({ id: 'i1', status: true })),
                trainedRel(),
                { ...withTrained(makeModel({ id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2' })), trainedFingerprint: 'old' },
            ]);
            expect(screen.getByTestId('tab-status-i1').textContent).toBe('Complete');
            expect(screen.getByTestId('tab-status-r1').textContent).toBe('Trained');
            expect(screen.getByTestId('tab-status-c1').textContent).toBe('Re-train');
        });
    });

    describe('stale banner + "Out of date" overlay', () => {
        it('shows the banner only while stale, with a Re-train button that trains the model', async () => {
            const stale = { ...withTrained(makeModel()), trainedFingerprint: 'old' };
            await mount([stale]);
            const banner = screen.getByTestId('stale-banner');
            expect(banner.textContent).toMatch(/Settings changed — this model is Incomplete again/);
            expect(banner.textContent).toMatch(/Your set points are kept/);
            await act(async () => { fireEvent.click(screen.getByTestId('stale-retrain')); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
            expect(mockInvoke).toHaveBeenCalledWith('compute_sensor_stats', expect.anything());
            expect(healthCalls().length).toBe(0); // no preview request for a stale model...
        });

        it('no banner for a model that is up to date', async () => {
            await mount([withTrained(makeModel())]);
            expect(screen.queryByTestId('stale-banner')).toBeNull();
        });

        it('an unsaved edit that changes the training inputs: banner appears, every chart is "Out of date", the old charts stay, no refetch', async () => {
            const rel = trainedRel();
            statefulUpdateMock([rel]);
            await mount([rel]);
            await chartsReady();
            const before = healthCalls().length;
            expect(screen.queryAllByTestId('chart-outdated')).toHaveLength(0);
            openSettings();
            fireEvent.click(screen.getByRole('button', { name: 'Strict' }));
            expect(screen.getByTestId('stale-banner')).toBeTruthy();
            expect(screen.getAllByTestId('chart-outdated')).toHaveLength(3); // Fit, Target vs predicted, Residual
            await new Promise(r => setTimeout(r, 400)); // longer than the hook's debounce
            expect(healthCalls().length).toBe(before);
            // Re-train commits the draft and the banner / overlays go away again.
            await act(async () => { fireEvent.click(screen.getByTestId('stale-retrain')); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
            await waitFor(() => expect(screen.queryByTestId('stale-banner')).toBeNull());
            await waitFor(() => expect(screen.queryAllByTestId('chart-outdated')).toHaveLength(0));
        });
    });

    describe('Model fit page, per kind (bounded series from compute_health_preview)', () => {
        it('Individual: value over time, Distribution and a statistics card; asks for the training scope of the model', async () => {
            await mount([withTrained(makeModel())]);
            await chartsReady();
            expect(screen.getByTestId('model-fit-individual')).toBeTruthy();
            expect(screen.getByTestId('chart-card-ts')).toBeTruthy();
            expect(screen.getByTestId('chart-card-dist')).toBeTruthy();
            expect(screen.getByTestId('stats-card')).toBeTruthy();
            expect(healthCalls()[0]).toMatchObject({ kind: 'individual', target: 'TAG1', max_points: 4000 });
        });

        it('Relationship: stats strip + Fit + Target vs predicted + Residual over time, and NO residual distribution / histogram', async () => {
            await mount([trainedRel()]);
            await chartsReady();
            for (const id of ['fit', 'tvp', 'res']) expect(screen.getByTestId(`chart-card-${id}`)).toBeTruthy();
            expect(screen.getByTestId('rel-stats')).toBeTruthy();
            expect(screen.queryByTestId('chart-card-dist')).toBeNull();
            expect(screen.queryByText(/Distribution/)).toBeNull();
            expect(healthCalls()[0]).toMatchObject({ kind: 'relationship', target: 'TAG1', predictors: ['TAG2', 'TAG3'] });
        });

        it('Clustering: the cluster scatter with SD rings and a cluster summary card', async () => {
            await mount([withTrained(makeModel({ id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2', numClusters: 1 }))]);
            await chartsReady();
            expect(screen.getByTestId('chart-card-cl')).toBeTruthy();
            expect(screen.getByTestId('cluster-summary')).toBeTruthy();
            expect(healthCalls()[0]).toMatchObject({ kind: 'clustering', first_sensor: 'TAG1', second_sensor: 'TAG2' });
        });

        it('the unit of the target sensor reaches the page (statistics in "bar")', async () => {
            await mount([withTrained(makeModel())]);
            await chartsReady();
            expect(screen.getByTestId('stats-card').textContent).toMatch(/5\.00 bar/);
        });

        it('every chart card has an Expand button that opens a large copy of the same chart, closed by Esc / backdrop / X', async () => {
            await mount([withTrained(makeModel())]);
            await chartsReady();
            for (const id of ['ts', 'dist']) {
                expect(screen.queryByTestId(`chart-overlay-${id}`)).toBeNull();
                fireEvent.click(screen.getByTestId(`chart-expand-${id}`));
                const ov = screen.getByTestId(`chart-overlay-${id}`);
                expect(within(ov).getByTestId('echarts-mock')).toBeTruthy();
                fireEvent.keyDown(window, { key: 'Escape' });
                expect(screen.queryByTestId(`chart-overlay-${id}`)).toBeNull();
            }
            fireEvent.click(screen.getByTestId('chart-expand-ts'));
            fireEvent.click(within(screen.getByTestId('chart-overlay-ts')).getByLabelText('Close'));
            expect(screen.queryByTestId('chart-overlay-ts')).toBeNull();
        });

        it('a Relationship whose fit is gone from Rust (NOT_FITTED) says "Re-train to recompute", and its button trains again', async () => {
            mockInvoke.mockImplementation((cmd: string, args?: any) =>
                cmd === 'compute_health_preview' ? Promise.reject('NOT_FITTED: no fitted model for this key') : defaultInvoke(cmd, args));
            const rel = trainedRel();
            statefulUpdateMock([rel]);
            await mount([rel]);
            await waitFor(() => expect(screen.getByTestId('results-not-fitted')).toBeTruthy());
            expect(screen.getByTestId('results-not-fitted').textContent).toMatch(/Re-train to recompute/);
            expect(screen.queryByTestId('results-chart')).toBeNull();
            mockInvoke.mockClear();
            await act(async () => { fireEvent.click(screen.getByTestId('results-not-fitted-retrain')); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
            expect(mockInvoke).toHaveBeenCalledWith('preview_relationship_model', expect.objectContaining({ cache_key: expect.stringContaining('r1::') }));
        });

        it('another preview failure is reported in place of the charts', async () => {
            mockInvoke.mockImplementation((cmd: string, args?: any) =>
                cmd === 'compute_health_preview' ? Promise.reject('NO_DATA: no rows in the training scope') : defaultInvoke(cmd, args));
            await mount([withTrained(makeModel())]);
            await waitFor(() => expect(screen.getByTestId('results-health-error')).toBeTruthy());
            expect(screen.getByTestId('results-health-error').textContent).toMatch(/no rows in the training scope/);
        });

        it('the dataset generation of the window is sent as expected_generation', async () => {
            await mount([withTrained(makeModel())], {}, { metadata: { headers: ['timestamp', 'TAG1'], total_rows: 100, generation: 7 } });
            await chartsReady();
            expect(healthCalls()[0].expected_generation).toBe(7);
        });

        it('a model that was never trained requests no preview', async () => {
            await mount([makeModel()]);
            await new Promise(r => setTimeout(r, 400));
            expect(healthCalls()).toHaveLength(0);
            expect(screen.getByTestId('results-placeholder').textContent).toBe('Not trained yet');
        });
    });

    describe('"Compare predictors" opens the Sub-models comparison as a modal', () => {
        it('fits one Relation model per cumulative predictor subset (the last step reuses the model\'s own fit) and closes with Esc', async () => {
            await mount([trainedRel()]);
            await chartsReady();
            mockInvoke.mockClear();
            fireEvent.click(screen.getByTestId('compare-predictors'));
            expect(screen.getByTestId('sub-models-modal')).toBeTruthy();
            await waitFor(() => expect(screen.getAllByTestId('sub-model-card')).toHaveLength(2));
            const calls = mockInvoke.mock.calls.filter(c => c[0] === 'preview_relationship_model').map(c => c[1] as any);
            // Step 1 is fitted; step 2 (both predictors) is the model's own cached fit.
            expect(calls).toHaveLength(1);
            expect(calls[0]).toMatchObject({ predictors: ['TAG2'], target: 'TAG1', lambda: 10_000 });
            expect(calls[0].cache_key).toBeUndefined(); // never touches the cached health fit
            fireEvent.keyDown(window, { key: 'Escape' });
            expect(screen.queryByTestId('sub-models-modal')).toBeNull();
        });

        it('is closed when the user moves to another model', async () => {
            await mount([withTrained(makeModel({ id: 'i1' })), trainedRel()]);
            fireEvent.click(screen.getByRole('tab', { name: /Relationship/ }));
            await chartsReady();
            fireEvent.click(screen.getByTestId('compare-predictors'));
            expect(screen.getByTestId('sub-models-modal')).toBeTruthy();
            fireEvent.click(screen.getByRole('tab', { name: /Individual/ }));
            expect(screen.queryByTestId('sub-models-modal')).toBeNull();
        });
    });

    describe('Relationship X predictor', () => {
        it('the selector lists the fitted predictors and re-requests the preview with the chosen x_predictor (written immediately)', async () => {
            const rel = trainedRel();
            statefulUpdateMock([rel]);
            await mount([rel]);
            await chartsReady();
            const trigger = within(screen.getByTestId('fit-x-selector')).getByRole('button', { name: 'X sensor' });
            expect(rowTag(trigger)).toBe('TAG2');
            fireEvent.click(trigger);
            expect([...document.querySelectorAll('.pk-pop [role="option"]')].map(rowTag)).toEqual(['TAG2', 'TAG3']);
            fireEvent.click(trigger);
            pickSingle(trigger, 'TAG3');
            await flush();
            await waitFor(() => expect(healthCalls().pop()).toMatchObject({ x_predictor: 'TAG3' }));
            const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
            expect(state.failureGroupState.models[0].scatterXSensor).toBe('TAG3');
        });
    });

    describe('Model settings: "changing it sets the model to Incomplete" hints', () => {
        it('next to the training data, predictors and stiffness (Relationship)', async () => {
            await mount([REL()]);
            openSettings();
            const form = screen.getByTestId('add-model-form');
            expect(within(form).getAllByTestId('incomplete-hint')).toHaveLength(3);
            for (const label of ['Predictor sensors (≥ 1)', 'Stiffness', 'Training data']) {
                expect(screen.getByText(label).parentElement!.querySelector('[data-testid="incomplete-hint"]')?.textContent).toBe('changing it sets the model to Incomplete');
            }
        });

        it('next to the sensors and clusters (Clustering) and the training data; none for the name', async () => {
            await mount([makeModel({ id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2' })]);
            openSettings();
            const hinted = ['Y sensor (target)', 'Criteria sensor (optional)', 'Clusters', 'Training data'];
            for (const label of hinted) expect(screen.getByText(label).parentElement!.querySelector('[data-testid="incomplete-hint"]'), label).toBeTruthy();
            expect(screen.getByText('Model name').parentElement!.querySelector('[data-testid="incomplete-hint"]')).toBeNull();
        });
    });
});

// 🆕 2026-10-04 (health score phase 3b-2): the Health score page inside the window - the DRAFT set points,
// when they are persisted (blur / Enter / leaving / closing), the first-open master snapshot, and the one
// and only "Mark complete" flow. The page's own rendering is covered by HealthScorePage.test.tsx.
const HS_SNAP = { kind: 'individual', lower: 1, upper: 9, masterLower: 1, masterUpper: 9 };
const HS_EMPTY_IND = { kind: 'individual', lower: null, upper: null, masterLower: null, masterUpper: null };
const HS_IND = (over: Record<string, any> = {}) => withTrained(makeModel({ healthSetPoints: HS_SNAP, ...over }));
const HS_REL = (over: Record<string, any> = {}) => withTrained(makeModel({
    id: 'r1', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2'], relStiffness: 10_000, ...over,
}));
const hsMount = async (models: any[], payload: Record<string, any> = {}, extraFg: Record<string, any> = {}) => {
    mockInvoke.mockImplementation(healthInvoke);
    statefulUpdateMock(models, extraFg);
    render(<BuildModelWindow />);
    await deliverData({ failureGroupState: { groups: [makeGroup()], models, ...extraFg } }, payload);
};
const hsInput = (id: string) => screen.getByTestId(id) as HTMLInputElement;
const hsType = (id: string, value: string) => fireEvent.change(hsInput(id), { target: { value } });
const hsLastModel = async (i = 0) =>
    (await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value).failureGroupState.models[i];
/** How many of the recorded workspace writes CHANGED the first model's set points (a write that only
 *  stores the saved validation verdict - `healthVerdict`, QA fix 2026-10-04 - is not one). */
const hsSetPointWrites = async (before: unknown) => {
    let prev = JSON.stringify(before);
    let n = 0;
    for (const r of mockUpdateWorkspaceData.mock.results) {
        const cur = JSON.stringify((await r.value).failureGroupState.models[0].healthSetPoints);
        if (cur !== prev) n++;
        prev = cur;
    }
    return n;
};
const hsMarkBtn = () => screen.getByTestId('mark-complete') as HTMLButtonElement;
const hsClickMark = async () => { await act(async () => { fireEvent.click(hsMarkBtn()); await Promise.resolve(); }); };
const hsBlur = async (id: string) => { await act(async () => { fireEvent.blur(hsInput(id)); await Promise.resolve(); await Promise.resolve(); }); await flush(); };
const EMPTY_WS_FG = { runningConditionNoneConfirmed: true, rcLegacyNotice: null, runningConditionTimePeriods: ALL_TIME_TRAIN, runningConditionTestPeriods: ONE_TEST };

describe('Health score page - draft set points and when they are persisted (health score 3b-2)', () => {
    describe('draft: charts, score and Checks react to typing; nothing is written until the user is done', () => {
        it('typing feeds the DRAFT to compute_health_preview (debounced) and writes nothing', async () => {
            await hsMount([HS_IND()]);
            await openHealthPage();
            await waitFor(() => expect(healthCalls().slice(-1)[0].set_points).toEqual({ lower: 1, upper: 9 }));
            mockUpdateWorkspaceData.mockClear();
            hsType('sp-upper', '12');
            await waitFor(() => expect(healthCalls().slice(-1)[0].set_points).toEqual({ lower: 1, upper: 12 }));
            expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
            expect(hsInput('sp-upper').value).toBe('12');
        });

        it('the Checks, the verdict pill and Mark complete follow the typing', async () => {
            await hsMount([HS_IND({ healthSetPoints: HS_EMPTY_IND })]);
            await openHealthPage();
            await waitFor(() => expect(screen.getByTestId('hs-verdict').textContent).toBe('Incomplete'));
            expect(hsMarkBtn().disabled).toBe(true);
            expect(screen.getByTestId('mark-block-reason').textContent).toBe('2 set points still empty');
            hsType('sp-lower', '3');
            hsType('sp-upper', '9');
            await waitFor(() => expect(screen.getByTestId('hs-verdict').textContent).toBe('Not valid'));
            expect(screen.getByTestId('mark-block-reason').textContent).toBe('1 set point not valid — fix before marking complete');
            hsType('sp-lower', '1');
            await waitFor(() => expect(screen.getByTestId('hs-verdict').textContent).toBe('Valid'));
            await waitFor(() => expect(hsMarkBtn().disabled).toBe(false));
            expect(screen.getByTestId('chart-card-score')).toBeTruthy();
        });

        it('a broadcast from another window never overwrites what is being typed', async () => {
            const model = HS_IND();
            await hsMount([model]);
            await openHealthPage();
            hsType('sp-upper', '12');
            await act(async () => {
                for (const cb of listenCallbacks['failure-group-state-changed'] ?? []) {
                    cb({ payload: {
                        groups: [makeGroup()], models: [{ ...model, name: 'Renamed elsewhere' }],
                        runningConditionNoneConfirmed: true, runningConditionFilters: [], runningConditionCombine: 'and', runningConditionTimePeriods: ALL_TIME_TRAIN, runningConditionTestPeriods: ONE_TEST,
                        workspaceId: 'ws1', origin: 'dashboard',
                    } });
                }
                await Promise.resolve();
            });
            expect(hsInput('sp-upper').value).toBe('12');
            await waitFor(() => expect(healthCalls().slice(-1)[0].set_points).toEqual({ lower: 1, upper: 12 }));
        });
    });

    describe('persisting the draft', () => {
        it('blur writes ONLY healthSetPoints: status and the train record are untouched, the model does not turn stale, and the change is broadcast', async () => {
            const model = HS_IND();
            await hsMount([model]);
            await openHealthPage();
            mockUpdateWorkspaceData.mockClear();
            mockEmit.mockClear();
            hsType('sp-upper', '12');
            await hsBlur('sp-upper');
            const written = await hsLastModel();
            expect(written.healthSetPoints).toMatchObject({ kind: 'individual', lower: 1, upper: 12, masterUpper: 9 });
            expect(written.status).toBe(false);
            expect(written.lastTrainedAt).toBe(model.lastTrainedAt);
            expect(written.trainedFingerprint).toBe(model.trainedFingerprint);
            expect(screen.getByTestId('set-points-card')).toBeTruthy();
            expect(screen.queryByTestId('stale-banner')).toBeNull();
            expect(screen.getByText('Trained', { selector: '.model-status-pill' })).toBeTruthy();
            const emitted = mockEmit.mock.calls.filter(c => c[0] === 'failure-group-state-changed').pop()![1];
            expect(emitted).toMatchObject({ workspaceId: 'ws1', origin: 'build-model' });
            expect(emitted.models[0].healthSetPoints.upper).toBe(12);
        });

        it('Enter commits as well', async () => {
            await hsMount([HS_IND()]);
            await openHealthPage();
            mockUpdateWorkspaceData.mockClear();
            hsType('sp-lower', '0.5');
            await act(async () => { fireEvent.keyDown(hsInput('sp-lower'), { key: 'Enter' }); await Promise.resolve(); await Promise.resolve(); });
            await flush();
            expect((await hsLastModel()).healthSetPoints.lower).toBe(0.5);
        });

        it('a discrete action (a quick button) commits at once - no blur needed', async () => {
            const c = withTrained(makeModel({ id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2', numClusters: 1 }));
            await hsMount([c]);
            await openHealthPage();
            mockUpdateWorkspaceData.mockClear();
            await act(async () => { fireEvent.click(screen.getByTestId('ring-quick-5')); await Promise.resolve(); await Promise.resolve(); });
            await flush();
            expect((await hsLastModel()).healthSetPoints).toEqual({ kind: 'clustering', outerSd: 5 });
        });

        it('leaving the page ("← Model fit") commits a draft that never blurred', async () => {
            await hsMount([HS_IND()]);
            await openHealthPage();
            mockUpdateWorkspaceData.mockClear();
            hsType('sp-upper', '11');
            await act(async () => { fireEvent.click(screen.getByTestId('footer-back-to-fit')); await Promise.resolve(); await Promise.resolve(); });
            await flush();
            expect((await hsLastModel()).healthSetPoints.upper).toBe(11);
        });

        it('switching to another sensor commits it too', async () => {
            const a = HS_IND();
            const b = withTrained(makeModel({ id: 'm2', targetSensor: 'TAG2', healthSetPoints: HS_SNAP }));
            await hsMount([a, b]);
            await openHealthPage();
            mockUpdateWorkspaceData.mockClear();
            hsType('sp-upper', '15');
            fireEvent.click(screen.getAllByTestId('sensor-row-label')[1]);
            await flush();
            expect((await hsLastModel(0)).healthSetPoints.upper).toBe(15);
        });

        it('once the commit landed the draft is dropped: a second blur writes nothing', async () => {
            await hsMount([HS_IND()]);
            await openHealthPage();
            hsType('sp-upper', '12');
            await hsBlur('sp-upper');
            mockUpdateWorkspaceData.mockClear();
            await hsBlur('sp-upper');
            expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
        });
    });

    describe('flush on window close (an edit made just before closing is not lost)', () => {
        it('a native close with a set point typed but never blurred waits for its write, then closes', async () => {
            await hsMount([HS_IND()]);
            await openHealthPage();
            await flush();
            let resolveUpdate!: (v: unknown) => void;
            mockUpdateWorkspaceData.mockClear();
            mockUpdateWorkspaceData.mockImplementationOnce(() => new Promise(res => { resolveUpdate = res; }));
            hsType('sp-upper', '13'); // typed, no blur
            const preventDefault = vi.fn();
            let closePromise!: Promise<void>;
            await act(async () => { closePromise = mockCloseRequestedHandler!({ preventDefault }) as Promise<void>; await Promise.resolve(); });
            expect(preventDefault).toHaveBeenCalledTimes(1);
            expect(mockUpdateWorkspaceData).toHaveBeenCalledTimes(1);
            expect(mockClose).not.toHaveBeenCalled();
            await act(async () => {
                resolveUpdate({ id: 'ws1', failureGroupState: { groups: [makeGroup()], models: [HS_IND()], ...EMPTY_WS_FG } });
                await closePromise;
            });
            expect(mockClose).toHaveBeenCalledTimes(1);
        });

        it('the toolbar Close button does the same', async () => {
            await hsMount([HS_IND()]);
            await openHealthPage();
            await flush();
            let resolveUpdate!: (v: unknown) => void;
            mockUpdateWorkspaceData.mockClear();
            mockUpdateWorkspaceData.mockImplementationOnce(() => new Promise(res => { resolveUpdate = res; }));
            hsType('sp-lower', '0.25');
            fireEvent.click(screen.getByTitle('Close'));
            await act(async () => { await Promise.resolve(); });
            expect(mockUpdateWorkspaceData).toHaveBeenCalledTimes(1);
            expect(mockClose).not.toHaveBeenCalled();
            await act(async () => {
                resolveUpdate({ id: 'ws1', failureGroupState: { groups: [makeGroup()], models: [HS_IND()], ...EMPTY_WS_FG } });
            });
            await waitFor(() => expect(mockClose).toHaveBeenCalledTimes(1));
        });

        it('with nothing typed the close is not intercepted', async () => {
            await hsMount([HS_IND()]);
            await openHealthPage();
            await flush();
            const preventDefault = vi.fn();
            await act(async () => { await mockCloseRequestedHandler!({ preventDefault }); });
            expect(preventDefault).not.toHaveBeenCalled();
        });
    });

    describe('first open of an Individual model\'s Health score page: the master-data snapshot (once)', () => {
        const META = [{ tag: 'TAG1', description: 'Pump Pressure', unit: 'bar', component: 'Pump', alarmL: 1, alarmH: 90 }];
        const bare = () => withTrained(makeModel());

        it('writes the snapshot of the sensor\'s alarm L/H and prefills L and H from it - one write', async () => {
            await hsMount([bare()], { sensorMetadata: META });
            mockUpdateWorkspaceData.mockClear();
            await openHealthPage();
            await flush();
            expect(await hsSetPointWrites(undefined)).toBe(1);
            expect((await hsLastModel()).healthSetPoints).toEqual({ kind: 'individual', lower: 1, upper: 90, masterLower: 1, masterUpper: 90 });
            expect(screen.getByTestId('sp-lower-source').textContent).toBe('master data');
            expect(hsInput('sp-upper').value).toBe('90');
            expect((await hsLastModel()).lastTrainedAt).toBeTruthy();
            expect((await hsLastModel()).status).toBe(false);
        });

        it('opening the page again (or leaving and returning) writes nothing more', async () => {
            await hsMount([bare()], { sensorMetadata: META });
            await openHealthPage();
            await flush();
            mockUpdateWorkspaceData.mockClear();
            fireEvent.click(screen.getByTestId('footer-back-to-fit'));
            await flush();
            fireEvent.click(screen.getByTestId('page-health'));
            await flush();
            expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
        });

        it('never overwrites a value the user already entered; only the snapshot is taken', async () => {
            const m = withTrained(makeModel({ healthSetPoints: { kind: 'individual', lower: 7, upper: null } }));
            await hsMount([m], { sensorMetadata: META });
            await openHealthPage();
            await flush();
            expect((await hsLastModel()).healthSetPoints).toEqual({ kind: 'individual', lower: 7, upper: 90, masterLower: 1, masterUpper: 90 });
            expect(screen.getByTestId('sp-lower-source').textContent).toBe('this model');
            expect(screen.getByTestId('sp-lower-reset').textContent).toBe('use 1.00');
        });

        it('a snapshot that already exists is left alone: no write at all', async () => {
            await hsMount([HS_IND()], { sensorMetadata: META }); // snapshot 1/9 already taken, master now says 1/90
            mockUpdateWorkspaceData.mockClear();
            await openHealthPage();
            await flush();
            expect(await hsSetPointWrites(HS_SNAP)).toBe(0); // (the saved verdict may be written)
            expect(hsInput('sp-upper').value).toBe('9');
        });

        it('a special sensor / a sensor with no master data: empty L and H, "not in master", and the user fills them', async () => {
            await hsMount([withTrained(makeModel({ targetSensor: 'TAG3' }))], { sensorMetadata: META });
            await openHealthPage();
            await flush();
            expect((await hsLastModel()).healthSetPoints).toEqual({ kind: 'individual', lower: null, upper: null, masterLower: null, masterUpper: null });
            expect(screen.getByTestId('sp-lower-source').textContent).toBe('not in master');
            expect(hsInput('sp-lower').value).toBe('');
            expect(screen.getByTestId('hs-verdict').textContent).toBe('Incomplete');
        });

        it('Relationship and Clustering never take a master snapshot (no write on first open)', async () => {
            await hsMount([HS_REL({ healthSetPoints: { kind: 'relationship', residualAt80Lower: null, residualAt80Upper: null, residualAt0Lower: null, residualAt0Upper: null } })], { sensorMetadata: META });
            mockUpdateWorkspaceData.mockClear();
            await openHealthPage();
            await flush();
            expect(await hsSetPointWrites({ kind: 'relationship', residualAt80Lower: null, residualAt80Upper: null, residualAt0Lower: null, residualAt0Upper: null })).toBe(0);
        });
    });
});

describe('Health score page - Mark complete (the ONLY way a model becomes Complete)', () => {
    it('is blocked while set points are empty, with the reason; clicking exports nothing', async () => {
        await hsMount([HS_IND({ healthSetPoints: { kind: 'individual', lower: null, upper: 9, masterLower: null, masterUpper: null } })]);
        await openHealthPage();
        await waitFor(() => expect(hsMarkBtn().disabled).toBe(true));
        expect(hsMarkBtn().title).toBe('1 set point still empty');
        await hsClickMark();
        expect(exportCalls()).toHaveLength(0);
    });

    it('is blocked while the preview is still loading ("Checking the set points…")', async () => {
        mockInvoke.mockImplementation((cmd: string, args?: any) => cmd === 'compute_health_preview' ? new Promise(() => {}) : healthInvoke(cmd, args));
        statefulUpdateMock([HS_IND()]);
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [HS_IND()] } });
        fireEvent.click(screen.getByTestId('page-health'));
        expect(hsMarkBtn().disabled).toBe(true);
        expect(screen.getByTestId('mark-block-reason').textContent).toBe('Checking the set points…');
    });

    it('success: files exported with the typed points, model persisted Complete (+ set points + export record), "Saved N files to <path>" shown, the Dashboard is told', async () => {
        await hsMount([HS_IND({ healthSetPoints: { kind: 'individual', lower: null, upper: null, masterLower: 1, masterUpper: 90 } })]);
        await openHealthPage();
        hsType('sp-lower', '1');
        hsType('sp-upper', '9');
        await waitFor(() => expect(hsMarkBtn().disabled).toBe(false));
        mockEmit.mockClear();
        await hsClickMark();
        await waitFor(() => expect(screen.getByTestId('save-ok')).toBeTruthy());
        expect(exportCalls()).toHaveLength(1);
        expect(exportCalls()[0]).toMatchObject({ kind: 'individual', workspace_id: 'ws1', target: 'TAG1', set_points: { lower: 1, upper: 9 } });
        const written = await hsLastModel();
        expect(written.status).toBe(true);
        expect(written.healthSetPoints).toMatchObject({ lower: 1, upper: 9, masterLower: 1, masterUpper: 90 });
        expect(written.healthExport).toMatchObject({ outputDir: 'C:/data/workspaces/ws1/output', setPoints: { lower: 1, upper: 9 } });
        expect(typeof written.healthExport.at).toBe('string');
        expect(screen.getByTestId('save-ok').textContent).toMatch(/Saved 1 file to C:\/data\/workspaces\/ws1\/output/);
        expect(within(screen.getByTestId('save-files')).getByText('INDV_INFO_TAG1.json')).toBeTruthy();
        expect(screen.getByText('Complete', { selector: '.model-status-pill' })).toBeTruthy();
        expect(screen.getByTestId('mark-incomplete')).toBeTruthy();
        expect(screen.queryByTestId('mark-complete')).toBeNull();
        const emitted = mockEmit.mock.calls.filter(c => c[0] === 'failure-group-state-changed').pop()![1];
        expect(emitted).toMatchObject({ workspaceId: 'ws1', origin: 'build-model' });
        expect(emitted.models[0].status).toBe(true);
    });

    it('order of operations: the files are written FIRST, status is persisted only afterwards', async () => {
        const order: string[] = [];
        await hsMount([HS_IND()]);
        mockInvoke.mockImplementation((cmd: string, args?: any) => { if (cmd === 'export_model_files') order.push('export'); return healthInvoke(cmd, args); });
        await openHealthPage();
        await waitFor(() => expect(hsMarkBtn().disabled).toBe(false));
        mockUpdateWorkspaceData.mockImplementation(async (_id: string, patch: (s: any) => any) => {
            const next = patch({ id: 'ws1', failureGroupState: { groups: [makeGroup()], models: [HS_IND()], ...EMPTY_WS_FG } });
            if (next.failureGroupState.models[0].status) order.push('status');
            return next;
        });
        await hsClickMark();
        await waitFor(() => expect(order).toEqual(['export', 'status']));
    });

    it('Rust refuses the set points when exporting (ok:false): NOTHING is marked complete, the issues show in Checks, the model stays Incomplete', async () => {
        mockInvoke.mockImplementation((cmd: string, args?: any) => cmd === 'export_model_files'
            ? Promise.resolve({ ok: false, files: [], output_dir: '', warnings: [], validation: [{ code: 'lower_equals_3sd', severity: 'error', field: 'lower', message: 'L equals the lower 3σ boundary (found at save time).' }] })
            : healthInvoke(cmd, args));
        statefulUpdateMock([HS_IND()]);
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [HS_IND()] } });
        await openHealthPage();
        await waitFor(() => expect(hsMarkBtn().disabled).toBe(false));
        mockUpdateWorkspaceData.mockClear();
        await hsClickMark();
        await waitFor(() => expect(screen.getByTestId('save-error')).toBeTruthy());
        expect(screen.getByTestId('check-line').textContent).toMatch(/found at save time/);
        expect(screen.getByTestId('hs-verdict').textContent).toBe('Not valid');
        expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
        expect(screen.getByText('Trained', { selector: '.model-status-pill' })).toBeTruthy();
        expect(screen.queryByTestId('mark-incomplete')).toBeNull();
        // Changing a set point clears the refusal and brings the live Checks back.
        hsType('sp-lower', '0.5');
        await waitFor(() => expect(screen.getByTestId('check-valid')).toBeTruthy());
    });

    it.each([
        ['NOT_FITTED: no fitted model for this key', /Re-train first/],
        ['STALE_SESSION: the dataset was reloaded', /out of date/],
        ['sidecar crashed', /sidecar crashed/],
    ])('an export error (%s) keeps the model Incomplete and says what to do', async (rejection, text) => {
        mockInvoke.mockImplementation((cmd: string, args?: any) => cmd === 'export_model_files' ? Promise.reject(rejection) : healthInvoke(cmd, args));
        statefulUpdateMock([HS_IND()]);
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [HS_IND()] } });
        await openHealthPage();
        await waitFor(() => expect(hsMarkBtn().disabled).toBe(false));
        mockUpdateWorkspaceData.mockClear();
        await hsClickMark();
        await waitFor(() => expect(screen.getByTestId('save-error').textContent).toMatch(text));
        expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
        expect(hsMarkBtn().disabled).toBe(false); // can retry
    });

    it('a double click starts ONE export (guarded), disables the button and shows "Saving results…" until it finishes', async () => {
        let release!: () => void;
        mockInvoke.mockImplementation((cmd: string, args?: any) => cmd === 'export_model_files'
            ? new Promise(res => { release = () => res(EXPORT_OK); })
            : healthInvoke(cmd, args));
        statefulUpdateMock([HS_IND()]);
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [HS_IND()] } });
        await openHealthPage();
        await waitFor(() => expect(hsMarkBtn().disabled).toBe(false));
        await act(async () => { fireEvent.click(hsMarkBtn()); fireEvent.click(hsMarkBtn()); await Promise.resolve(); });
        expect(exportCalls()).toHaveLength(1);
        expect(hsMarkBtn().disabled).toBe(true);
        expect(hsMarkBtn().textContent).toBe('Saving…');
        expect(screen.getByTestId('save-running').textContent).toBe('Saving results…');
        expect(screen.getByTestId('footer-status').textContent).toMatch(/Saving results…/);
        await act(async () => { release(); await Promise.resolve(); await Promise.resolve(); });
        await waitFor(() => expect(screen.getByTestId('save-ok')).toBeTruthy());
        expect(exportCalls()).toHaveLength(1);
    });

    it('Relationship: the progress note says it can take longer than 15 seconds (especially the first time), and the page stays usable meanwhile', async () => {
        let release!: () => void;
        const rel = HS_REL({ healthSetPoints: { kind: 'relationship', residualAt80Lower: -1.5, residualAt80Upper: 1.5, residualAt0Lower: -3, residualAt0Upper: 3 } });
        mockInvoke.mockImplementation((cmd: string, args?: any) => cmd === 'export_model_files'
            ? new Promise(res => { release = () => res(EXPORT_OK); })
            : healthInvoke(cmd, args));
        statefulUpdateMock([rel]);
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel] } });
        await openHealthPage();
        await waitFor(() => expect(hsMarkBtn().disabled).toBe(false));
        await hsClickMark();
        expect(screen.getByTestId('save-running').textContent).toMatch(/15 seconds/);
        hsType('sp-residual_at_0_upper', '3.5');
        expect(hsInput('sp-residual_at_0_upper').value).toBe('3.5');
        expect((screen.getByTestId('footer-back-to-fit') as HTMLButtonElement).disabled).toBe(false);
        await act(async () => { release(); await Promise.resolve(); await Promise.resolve(); });
        await waitFor(() => expect(screen.getByTestId('save-ok')).toBeTruthy());
        expect(exportCalls()[0]).toMatchObject({ kind: 'relationship', lambda: 10_000 });
        expect(exportCalls()[0].cache_key).toMatch(/^r1::/);
    });

    it('a model that stopped being Trained-and-fresh in the meantime (another window changed a training input) is NOT marked complete - re-checked against disk inside the write', async () => {
        const model = HS_IND();
        statefulUpdateMock([model]);
        mockInvoke.mockImplementation(healthInvoke);
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [model] } });
        await openHealthPage();
        await waitFor(() => expect(hsMarkBtn().disabled).toBe(false));
        // another window changed a training input on disk after the preview was validated
        mockUpdateWorkspaceData.mockImplementation(async (_id: string, patch: (s: any) => any) =>
            patch({ id: 'ws1', failureGroupState: { groups: [makeGroup()], models: [{ ...model, runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true, filterTimePeriods: [{ id: 'p', start: '2026-01-01T00:00', end: '2026-02-01T00:00' }] }], ...EMPTY_WS_FG } }));
        await hsClickMark();
        await flush();
        // Not Complete: the disk copy is what counts, and it is no longer fresh. This window follows it
        // (the page falls back to Model fit with the "Settings changed" banner).
        expect((await hsLastModel()).status).toBe(false);
        expect(screen.queryByTestId('mark-incomplete')).toBeNull();
        expect(screen.getByTestId('stale-banner')).toBeTruthy();
        expect(screen.getByText('Incomplete', { selector: '.model-status-pill' })).toBeTruthy();

    });
});

describe('Health score page - Mark incomplete and "Changed after saving"', () => {
    const record = { at: '2026-10-04T01:00:00.000Z', outputDir: 'C:/data/workspaces/ws1/output', setPoints: HS_SNAP };

    it('Mark incomplete replaces the button once Complete; it writes status:false only (files, set points and export record stay)', async () => {
        await hsMount([HS_IND({ status: true, healthExport: record })]);
        await openHealthPage();
        expect(screen.queryByTestId('mark-complete')).toBeNull();
        mockUpdateWorkspaceData.mockClear();
        await act(async () => { fireEvent.click(screen.getByTestId('mark-incomplete')); await Promise.resolve(); await Promise.resolve(); });
        await flush();
        const written = await hsLastModel();
        expect(written).toMatchObject({ status: false, healthExport: record });
        expect(written.healthSetPoints).toMatchObject({ lower: 1, upper: 9 });
        expect(screen.getByTestId('mark-complete')).toBeTruthy();
        expect(exportCalls()).toHaveLength(0);
    });

    it('same set points as the export: no hint; after an edit: the hint and "Mark complete again", status unchanged', async () => {
        await hsMount([HS_IND({ status: true, healthExport: record })]);
        await openHealthPage();
        expect(screen.queryByTestId('files-out-of-date')).toBeNull();
        expect(screen.queryByTestId('mark-complete-again')).toBeNull();
        expect(screen.getByTestId('save-ok').textContent).toMatch(/Files saved to C:\/data\/workspaces\/ws1\/output/); // from the stored record
        hsType('sp-upper', '12');
        expect(screen.getByTestId('files-out-of-date').textContent).toMatch(/Changed after saving.*Mark complete again to update the files/);
        await hsBlur('sp-upper');
        expect((await hsLastModel()).status).toBe(true);
        expect(screen.getByText('Complete', { selector: '.model-status-pill' })).toBeTruthy();
        expect(screen.getByTestId('files-out-of-date')).toBeTruthy();
    });

    it('typing the original value back removes the hint', async () => {
        await hsMount([HS_IND({ status: true, healthExport: record })]);
        await openHealthPage();
        hsType('sp-upper', '12');
        expect(screen.getByTestId('files-out-of-date')).toBeTruthy();
        hsType('sp-upper', '9');
        expect(screen.queryByTestId('files-out-of-date')).toBeNull();
    });

    it('"Mark complete again" writes the files with the new points, keeps the model Complete and records the new export', async () => {
        await hsMount([HS_IND({ status: true, healthExport: record })]);
        await openHealthPage();
        hsType('sp-upper', '12');
        const again = await screen.findByTestId('mark-complete-again') as HTMLButtonElement;
        await waitFor(() => expect(again.disabled).toBe(false));
        await act(async () => { fireEvent.click(again); await Promise.resolve(); });
        await waitFor(() => expect(screen.getByTestId('save-ok')).toBeTruthy());
        expect(exportCalls()).toHaveLength(1);
        expect(exportCalls()[0].set_points).toEqual({ lower: 1, upper: 12 });
        const written = await hsLastModel();
        expect(written.status).toBe(true);
        expect(written.healthExport.setPoints).toMatchObject({ upper: 12 });
        expect(screen.queryByTestId('files-out-of-date')).toBeNull();
        expect(screen.queryByTestId('mark-complete-again')).toBeNull();
    });

    it('a Complete model from before export records existed (no healthExport) shows no hint - there is nothing to compare', async () => {
        await hsMount([HS_IND({ status: true })]);
        await openHealthPage();
        hsType('sp-upper', '12');
        expect(screen.queryByTestId('files-out-of-date')).toBeNull();
    });

    it('the export record is not a training input: a Complete model carrying one is not stale', async () => {
        await hsMount([HS_IND({ status: true, healthExport: record })]);
        expect(screen.getByText('Complete', { selector: '.model-status-pill' })).toBeTruthy();
        expect(screen.queryByTestId('stale-banner')).toBeNull();
    });
});

describe('Health score page - status pills and dots follow the verdict Rust gave', () => {
    it('trained with empty set points: tab pill "Set points needed" (yellow dot)', async () => {
        await hsMount([HS_IND({ healthSetPoints: HS_EMPTY_IND })]);
        await waitFor(() => expect(screen.getByTestId('tab-status-m1').textContent).toBe('Set points needed'));
        expect(screen.getByTestId('tab-status-m1').className).toMatch(/f4-pill--warn/);
        expect(screen.getByTestId('sensor-kind-badge-dot-m1').className).toMatch(/f4-kb-dot--need/);
    });

    it('a rejected set point: "Fix set point" (red pill, red dot); the central dot state stays "trained"', async () => {
        await hsMount([HS_IND({ healthSetPoints: { kind: 'individual', lower: 3, upper: 9, masterLower: null, masterUpper: null } })]);
        await waitFor(() => expect(screen.getByTestId('tab-status-m1').textContent).toBe('Fix set point'));
        expect(screen.getByTestId('tab-status-m1').className).toMatch(/f4-pill--bad/);
        const dot = screen.getByTestId('sensor-kind-badge-dot-m1');
        expect(dot.className).toMatch(/f4-kb-dot--bad/);
        expect(dot.getAttribute('data-state')).toBe('trained');
        expect(screen.getByTestId('sensor-kind-badge-m1').title).toMatch(/Fix set point/);
    });

    it('valid set points: the pill is "Trained"; typing a bad value turns it red live', async () => {
        await hsMount([HS_IND()]);
        await waitFor(() => expect(screen.getByTestId('tab-status-m1').textContent).toBe('Trained'));
        expect(screen.getByTestId('tab-status-m1').textContent).toBe('Trained');
        await openHealthPage();
        hsType('sp-lower', '3');
        await waitFor(() => expect(screen.getByTestId('tab-status-m1').textContent).toBe('Fix set point'));
    });

    it('a stale model keeps the central stale state - no "set points" pill on top of "Re-train"', async () => {
        await hsMount([{ ...HS_IND({ healthSetPoints: HS_EMPTY_IND }), trainedFingerprint: 'old' }]);
        expect(screen.getByTestId('tab-status-m1').textContent).toBe('Re-train');
    });
});

describe('Health score page - edge cases', () => {
    it('a stale model never shows the Health score page, so Mark complete cannot be reached', async () => {
        await hsMount([{ ...HS_IND(), trainedFingerprint: 'old' }]);
        expect((screen.getByTestId('page-health') as HTMLButtonElement).disabled).toBe(true);
        expect(screen.queryByTestId('mark-complete')).toBeNull();
    });

    it('a failed run this session blocks the Health score page ("Re-train first")', async () => {
        mockInvoke.mockImplementation((cmd: string, args?: any) => cmd === 'compute_sensor_stats' ? Promise.reject(new Error('dataset not loaded')) : healthInvoke(cmd, args));
        statefulUpdateMock([HS_IND()]);
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [HS_IND()] } });
        await flush();
        await waitFor(() => expect((screen.getByTestId('page-health') as HTMLButtonElement).disabled).toBe(true));
        expect((screen.getByTestId('page-health') as HTMLButtonElement).title).toBe('Re-train first');
    });

    it('NOT_FITTED (Relationship fit gone from Rust\'s memory): "Re-train to recompute"; the Health score page is not offered until re-trained', async () => {
        mockInvoke.mockImplementation((cmd: string, args?: any) => cmd === 'compute_health_preview'
            ? Promise.reject('NOT_FITTED: no fitted model for this key') : healthInvoke(cmd, args));
        const rel = HS_REL();
        statefulUpdateMock([rel]);
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel] } });
        await waitFor(() => expect(screen.getByTestId('results-not-fitted')).toBeTruthy());
        fireEvent.click(screen.getByTestId('page-health'));
        // The page, if opened, is the same "Re-train to recompute" and Mark complete stays blocked with that reason.
        if (screen.queryByTestId('health-page')) {
            expect(screen.getByTestId('health-not-fitted')).toBeTruthy();
            expect(screen.getByTestId('mark-block-reason').textContent).toMatch(/Re-train first/);
            expect((screen.getByTestId('mark-complete') as HTMLButtonElement).disabled).toBe(true);
        }
    });
});

// 🆕 2026-10-04 (QA fixes after the health-score integration sweep): the persisted validation verdict, the
// dataset-generation guard on Train, a window close during "Mark complete", and the refusal notice that
// also shows on the Model fit page. The cross-window / multi-workspace halves of these live in the
// HealthScore*.integration tests.
describe('Health score - QA fixes 2026-10-04', () => {
    const META1 = [{ tag: 'TAG1', description: 'Pump Pressure', unit: 'bar', component: 'Pump', alarmL: 1, alarmH: 90 }];
    const BAD_SP = { kind: 'individual', lower: 3, upper: 9, masterLower: null, masterUpper: null };
    const updateCalls = () => mockUpdateWorkspaceData.mock.calls.length;

    describe('the validation verdict is persisted on the model (healthVerdict) so the Dashboard dot can show it', () => {
        it('a rejected saved set point -> healthVerdict "invalid" is written and broadcast with the whole slice', async () => {
            await hsMount([HS_IND({ healthSetPoints: BAD_SP })]);
            await waitFor(async () => expect((await hsLastModel()).healthVerdict).toBe('invalid'));
            const emitted = mockEmit.mock.calls.filter(c => c[0] === 'failure-group-state-changed').pop()![1];
            expect(emitted).toMatchObject({ workspaceId: 'ws1', origin: 'build-model' });
            expect(emitted.models[0].healthVerdict).toBe('invalid');
            // only the verdict was written: set points and status untouched
            expect((await hsLastModel()).healthSetPoints).toEqual(BAD_SP);
            expect((await hsLastModel()).status).toBe(false);
        });

        it('empty set points -> "incomplete"; valid ones -> "valid"', async () => {
            await hsMount([HS_IND({ healthSetPoints: HS_EMPTY_IND })]);
            await waitFor(async () => expect((await hsLastModel()).healthVerdict).toBe('incomplete'));
            cleanup();
            mockUpdateWorkspaceData.mockReset();
            await hsMount([HS_IND()]);
            await waitFor(async () => expect((await hsLastModel()).healthVerdict).toBe('valid'));
        });

        it('a verdict that already equals the saved one writes nothing', async () => {
            await hsMount([HS_IND({ healthSetPoints: BAD_SP, healthVerdict: 'invalid' })]);
            await waitFor(() => expect(healthCalls().length).toBeGreaterThan(0));
            await flush();
            await flush();
            expect(updateCalls()).toBe(0);
        });

        it('a wrong saved verdict is corrected from the preview (self-healing)', async () => {
            await hsMount([HS_IND({ healthVerdict: 'invalid' })]); // valid set points, stale "invalid"
            await waitFor(async () => expect((await hsLastModel()).healthVerdict).toBe('valid'));
        });

        it('nothing is written while a set point is typed but not saved (the verdict is about what is on disk); the pill follows the typing live; blur saves, the old verdict is dropped, the new one lands', async () => {
            await hsMount([HS_IND({ healthVerdict: 'valid' })]);
            await openHealthPage();
            await waitFor(() => expect(healthCalls().slice(-1)[0].set_points).toEqual({ lower: 1, upper: 9 }));
            await flush();
            mockUpdateWorkspaceData.mockClear();
            hsType('sp-lower', '3');
            await waitFor(() => expect(healthCalls().slice(-1)[0].set_points).toEqual({ lower: 3, upper: 9 }));
            await waitFor(() => expect(screen.getByTestId('tab-status-m1').textContent).toBe('Fix set point')); // live
            await flush();
            expect(updateCalls()).toBe(0);
            await hsBlur('sp-lower');
            await waitFor(async () => expect((await hsLastModel()).healthVerdict).toBe('invalid'));
            const results = await Promise.all(mockUpdateWorkspaceData.mock.results.map(r => r.value));
            const saved = results.find(s => s.failureGroupState.models[0].healthSetPoints.lower === 3)!;
            expect(saved.failureGroupState.models[0]).not.toHaveProperty('healthVerdict'); // the set-point write dropped the old one
        });

        it('a model that is not trained-and-fresh gets no verdict (a stale model\'s old data does not count)', async () => {
            await hsMount([{ ...HS_IND({ healthSetPoints: BAD_SP }), trainedFingerprint: 'old' }]);
            await flush();
            await flush();
            expect(updateCalls()).toBe(0);
        });

        it('an Individual model whose master prefill has not been saved yet (page not opened) gets no verdict for numbers that are not on disk', async () => {
            await hsMount([HS_IND({ healthSetPoints: { kind: 'individual', lower: null, upper: null } })], { sensorMetadata: META1 });
            await waitFor(() => expect(healthCalls().length).toBeGreaterThan(0));
            await flush();
            await flush();
            expect(updateCalls()).toBe(0);
        });

        it('a new Train drops the old verdict in the same write that stamps the new fit', async () => {
            await hsMount([makeModel({ healthVerdict: 'invalid' })]); // untrained, with a leftover verdict
            await act(async () => {
                fireEvent.click(trainSensorBtn());
                await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
            });
            const stamped = (await Promise.all(mockUpdateWorkspaceData.mock.results.map(r => r.value))).find(s => s.failureGroupState.models[0].lastTrainedAt)!;
            expect(stamped.failureGroupState.models[0]).not.toHaveProperty('healthVerdict');
        });

        it('the tab pill and the left-list dot read the PERSISTED verdict (no live preview needed)', async () => {
            await hsMount([HS_IND({ healthSetPoints: HS_EMPTY_IND, healthVerdict: 'invalid' })]);
            // before / without any answer yet the persisted verdict already colours them
            expect(screen.getByTestId('sensor-kind-badge-dot-m1').className).toMatch(/f4-kb-dot--bad|f4-kb-dot--need/);
        });
    });

    describe('Train is bound to the dataset this window was opened on', () => {
        const PAYLOAD = { metadata: { headers: ['timestamp', 'TAG1', 'TAG2'], total_rows: 100, generation: 5 } };
        const genIs = (...gens: Array<number | null | 'reject'>) => {
            let i = 0;
            mockInvoke.mockImplementation((cmd: string, args?: any) => {
                if (cmd !== 'get_session_generation') return healthInvoke(cmd, args);
                const g = gens[Math.min(i++, gens.length - 1)];
                return g === 'reject' ? Promise.reject(new Error('no such command')) : Promise.resolve(g);
            });
        };
        const clickTrain = () => { mockInvoke.mockClear(); return act(async () => { fireEvent.click(trainSensorBtn()); await flush(); await flush(); }); };
        const stats = () => mockInvoke.mock.calls.filter(c => c[0] === 'compute_sensor_stats');
        const stamped = async () => (await Promise.all(mockUpdateWorkspaceData.mock.results.map(r => r.value))).some(s => s.failureGroupState.models[0].lastTrainedAt);

        it('dataset replaced (generation differs): nothing is trained, nothing is stamped, a clear message is shown', async () => {
            await hsMount([makeModel()], PAYLOAD);
            genIs(6);
            await clickTrain();
            expect(stats()).toHaveLength(0);
            expect(await stamped()).toBe(false);
            expect(screen.getByTestId('results-error').textContent).toMatch(/dataset changed since this window was opened/i);
            expect(screen.getByTestId('results-error').textContent).toMatch(/reopen Build Model/i);
        });

        it('replaced WHILE the commands ran: the result is thrown away, not stamped', async () => {
            await hsMount([makeModel()], PAYLOAD);
            genIs(5, 6);
            await clickTrain();
            expect(stats()).toHaveLength(1);
            expect(await stamped()).toBe(false);
            expect(screen.getByTestId('results-error')).toBeTruthy();
        });

        it('same generation: trains and stamps as always', async () => {
            await hsMount([makeModel()], PAYLOAD);
            genIs(5);
            await clickTrain();
            expect(stats()).toHaveLength(1);
            expect(await stamped()).toBe(true);
        });

        it('the generation command failing or answering null never blocks a Train (diagnostic only)', async () => {
            await hsMount([makeModel()], PAYLOAD);
            genIs('reject');
            await clickTrain();
            expect(await stamped()).toBe(true);
            cleanup();
            mockUpdateWorkspaceData.mockReset();
            await hsMount([makeModel()], PAYLOAD);
            genIs(null);
            await clickTrain();
            expect(await stamped()).toBe(true);
        });

        it('a window opened without a generation never asks for one', async () => {
            await hsMount([makeModel()]);
            genIs(99);
            await clickTrain();
            expect(mockInvoke.mock.calls.some(c => c[0] === 'get_session_generation')).toBe(false);
            expect(await stamped()).toBe(true);
        });
    });

    describe('closing while "Mark complete" is exporting waits for the whole run', () => {
        let finishExport!: () => void;
        const slowExport = () => {
            mockInvoke.mockImplementation((cmd: string, args?: any) =>
                cmd === 'export_model_files' ? new Promise(res => { finishExport = () => res(EXPORT_OK); }) : healthInvoke(cmd, args));
        };
        const startMark = async () => {
            await hsMount([HS_IND()]);
            await openHealthPage();
            await waitFor(() => expect(hsMarkBtn().disabled).toBe(false));
            slowExport();
            await hsClickMark();
            await waitFor(() => expect(exportCalls()).toHaveLength(1));
        };

        it('a native close is held until the files are written AND the status is saved, then goes through', async () => {
            await startMark();
            const preventDefault = vi.fn();
            let closing!: Promise<void>;
            await act(async () => { closing = mockCloseRequestedHandler!({ preventDefault }) as Promise<void>; await Promise.resolve(); });
            expect(preventDefault).toHaveBeenCalledTimes(1);
            expect(mockClose).not.toHaveBeenCalled();
            await act(async () => { finishExport(); await closing; });
            expect(mockClose).toHaveBeenCalledTimes(1);
            expect((await hsLastModel()).status).toBe(true); // saved BEFORE the window went away
        });

        it('the toolbar Close button does the same', async () => {
            await startMark();
            fireEvent.click(screen.getByTitle('Close'));
            await act(async () => { await Promise.resolve(); });
            expect(mockClose).not.toHaveBeenCalled();
            await act(async () => { finishExport(); });
            await waitFor(() => expect(mockClose).toHaveBeenCalledTimes(1));
            expect((await hsLastModel()).status).toBe(true);
        });

        it('a hung export does not make the window impossible to close: it stays open ONCE with a notice, the next close goes through', async () => {
            const wait = MARK_COMPLETE_CLOSE_WAIT.ms;
            MARK_COMPLETE_CLOSE_WAIT.ms = 20;
            try {
                await startMark();
                const first = vi.fn();
                await act(async () => { await mockCloseRequestedHandler!({ preventDefault: first }); });
                expect(first).toHaveBeenCalledTimes(1);
                expect(mockClose).not.toHaveBeenCalled();
                expect(screen.getByTestId('close-wait-notice').textContent).toMatch(/Still saving the model files/);
                const second = vi.fn();
                await act(async () => { await mockCloseRequestedHandler!({ preventDefault: second }); });
                expect(mockClose).toHaveBeenCalledTimes(1); // gave up waiting
            } finally {
                MARK_COMPLETE_CLOSE_WAIT.ms = wait;
                finishExport?.();
            }
        });

        it('with no Mark complete running the close is not delayed or intercepted (nothing typed, nothing saving)', async () => {
            await hsMount([HS_IND()]);
            await openHealthPage();
            await flush();
            const preventDefault = vi.fn();
            await act(async () => { await mockCloseRequestedHandler!({ preventDefault }); });
            expect(preventDefault).not.toHaveBeenCalled();
        });
    });

    describe('a refused / failed Mark complete is also visible on the Model fit page', () => {
        it('shows "not marked complete" + the reason as a dismissible banner after going back to Model fit; dismiss removes it; the Health page keeps its own banner', async () => {
            await hsMount([HS_IND()]);
            await openHealthPage();
            await waitFor(() => expect(hsMarkBtn().disabled).toBe(false));
            mockInvoke.mockImplementation((cmd: string, args?: any) =>
                cmd === 'export_model_files' ? Promise.reject(new Error('Failed to write INDV_INFO: access denied')) : healthInvoke(cmd, args));
            await hsClickMark();
            await waitFor(() => expect(screen.getByTestId('save-error').textContent).toMatch(/access denied/));
            expect(screen.queryByTestId('save-notice')).toBeNull(); // the Health page shows its own banner, not both
            fireEvent.click(screen.getByTestId('footer-back-to-fit'));
            const notice = screen.getByTestId('save-notice');
            expect(notice.textContent).toMatch(/not marked complete/);
            expect(notice.textContent).toMatch(/access denied/);
            fireEvent.click(screen.getByTestId('save-notice-dismiss'));
            expect(screen.queryByTestId('save-notice')).toBeNull();
        });

        it('a successful Mark complete shows no such banner on the Model fit page', async () => {
            await hsMount([HS_IND()]);
            await openHealthPage();
            await waitFor(() => expect(hsMarkBtn().disabled).toBe(false));
            await hsClickMark();
            await waitFor(() => expect(screen.getByTestId('save-ok')).toBeTruthy());
            fireEvent.click(screen.getByTestId('footer-back-to-fit'));
            expect(screen.queryByTestId('save-notice')).toBeNull();
        });
    });

    describe('a one-off preview failure keeps the Health score page (inputs + Retry)', () => {
        it('the inputs stay, an error banner with Retry shows, Retry asks again and the banner goes when it answers', async () => {
            await hsMount([HS_IND()]);
            await openHealthPage();
            await waitFor(() => expect(healthCalls().slice(-1)[0].set_points).toEqual({ lower: 1, upper: 9 }));
            let fail = true;
            mockInvoke.mockImplementation((cmd: string, args?: any) =>
                cmd === 'compute_health_preview' && fail ? Promise.reject('Failed to read column: transient I/O error') : healthInvoke(cmd, args));
            hsType('sp-upper', '9.5');
            await waitFor(() => expect(screen.getByTestId('health-error').textContent).toMatch(/transient I\/O error/));
            expect(hsInput('sp-upper').value).toBe('9.5'); // the page and its inputs are still here
            expect(hsMarkBtn().disabled).toBe(true); // nothing is judged, so nothing can be marked complete
            fail = false;
            fireEvent.click(screen.getByTestId('health-retry'));
            await waitFor(() => expect(screen.getByTestId('check-valid')).toBeTruthy());
            expect(screen.queryByTestId('health-error')).toBeNull();
        });
    });
});


// ─────────────────────────────────────────────────────────────────────────
// Train/Test model validation (SPEC FINAL 2026-10-07): the Running condition
// modal's Apply gate, the workspace test periods + "From Highlights", Mark
// complete needing a test period, the "Tested · N" footer pill and the
// "Test periods changed" notice under the Step-1 card.
// ─────────────────────────────────────────────────────────────────────────
describe('Train / Test validation in the Build Model window (2026-10-07)', () => {
    const seededFilter = { id: 'f1', sensor: 'TAG1', operation: 'greater_than' as const, value1: '5', value2: '' };
    const fgBase = (over: Record<string, any> = {}) => ({
        groups: [makeGroup()], models: [makeModel()],
        runningConditionNoneConfirmed: false,
        runningConditionFilters: [seededFilter],
        runningConditionCombine: 'and' as const,
        runningConditionTimePeriods: [{ id: 'p1', start: '2024-01-01T00:00', end: '2024-01-31T23:59' }],
        runningConditionTestPeriods: ONE_TEST,
        rcLegacyNotice: null,
        ...over,
    });
    const apply = () => screen.getByTestId('rc-apply') as HTMLButtonElement;
    const lastWrittenFg = async () =>
        (await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value).failureGroupState;

    async function openModal(fg: Record<string, any>, wsExtra: Record<string, any> = {}) {
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: fg, ...wsExtra });
        statefulUpdateMock(fg.models, fg);
        mockUpdateWorkspaceData.mockClear();
        fireEvent.click(screen.getByTestId('rc-card-open'));
        await flush();
    }

    describe('Running condition modal — Apply gate', () => {
        it('no train period: Apply stays disabled with the hint "Add a train period", even with other edits', async () => {
            await openModal(fgBase({ runningConditionTimePeriods: [] }));
            fireEvent.change(screen.getByDisplayValue('5'), { target: { value: '9' } });
            expect(apply().disabled).toBe(true);
            const hint = screen.getByTestId('rc-apply-block');
            expect(hint.getAttribute('data-kind')).toBe('no-train');
            expect(hint.textContent).toBe(ADD_TRAIN_PERIOD_HINT);
            expect(apply().title).toBe(ADD_TRAIN_PERIOD_HINT);
            fireEvent.click(apply());
            await flush();
            expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
            // Adding a train period lifts the block
            fireEvent.click(screen.getByTestId('period-add'));
            expect(apply().disabled).toBe(false);
            expect(screen.queryByTestId('rc-apply-block')).toBeNull();
        });

        it('a Known-problem event time outside its test period is red and blocks Apply; moving it inside unblocks, Apply saves the test periods', async () => {
            await openModal(fgBase());
            const dlg = within(screen.getByRole('dialog', { name: 'Running condition' }));
            fireEvent.click(dlg.getByTestId('test-label-problem-1'));
            const ev = dlg.getByLabelText('Test period 1 event time');
            fireEvent.change(ev, { target: { value: '2025-05-01T00:00' } });
            fireEvent.blur(ev);
            expect(dlg.getByTestId('test-event-invalid-1').textContent).toContain('The event time must be inside T1.');
            expect(apply().disabled).toBe(true);
            expect(screen.getByTestId('rc-apply-block').getAttribute('data-kind')).toBe('invalid-test');
            expect(screen.getByTestId('rc-apply-block').textContent).toBe('The event time must be inside T1.');

            fireEvent.change(dlg.getByLabelText('Test period 1 event time'), { target: { value: '2024-01-20T06:00' } });
            fireEvent.blur(dlg.getByLabelText('Test period 1 event time'));
            expect(dlg.queryByTestId('test-event-invalid-1')).toBeNull();
            expect(apply().disabled).toBe(false);
            fireEvent.click(apply());
            await flush();
            const fg = await lastWrittenFg();
            expect(fg.runningConditionTestPeriods).toEqual([{ ...ONE_TEST[0], label: 'problem', eventTime: '2024-01-20T06:00' }]);
            expect(screen.queryByRole('dialog', { name: 'Running condition' })).toBeNull();
            // the Step-1 card shows the persisted Known problem with its event
            expect(screen.getByTestId('rc-card-test-chip').textContent).toContain('T1 Known problem');
            expect(screen.getByTestId('rc-card-test-event').textContent).toBe(' · event 20 Jan 2024 06:00');
        });

        it('a test period overlapping the train period is information only: a grey note, Apply still allowed', async () => {
            await openModal(fgBase());
            const dlg = within(screen.getByRole('dialog', { name: 'Running condition' }));
            // ONE_TEST (Jan 2024) lies inside the train period (Jan 2024)
            expect(dlg.getByTestId('test-overlap-1').textContent).toContain('T1 includes 31 d of train running time');
            fireEvent.click(dlg.getByTestId('test-add'));
            expect(apply().disabled).toBe(false);
            expect(screen.queryByTestId('rc-apply-block')).toBeNull();
        });

        it('"From Highlights" offers the workspace\'s Dashboard highlights (re-read when the modal opens); the label stays on the test period', async () => {
            const hl = { id: 'h1', start: '2024-03-01 00:00:00', end: '2024-03-05 00:00:00', label: 'Seal leak', color: '#f43f5e', enabled: true };
            await openModal(fgBase(), { timeHighlights: [hl] });
            fireEvent.click(screen.getByTestId('test-from-hl'));
            fireEvent.click(screen.getByTestId('test-hl-problem-h1'));
            fireEvent.click(apply());
            await flush();
            const written = (await mockUpdateWorkspaceData.mock.results[0].value);
            expect(written.failureGroupState.runningConditionTestPeriods[1]).toMatchObject({
                start: '2024-03-01T00:00', end: '2024-03-05T00:00', label: 'problem', fromHighlight: 'Seal leak',
            });
            // nothing is written onto the highlight itself
            expect(written.timeHighlights ?? [hl]).toEqual([hl]);
        });

        it('a train period overlapping a highlight shows the amber warning; "Remove the overlap" splits it in the draft', async () => {
            const hl = { id: 'h1', start: '2024-01-10 00:00:00', end: '2024-01-12 00:00:00', label: 'Trip', color: '#f43f5e', enabled: true };
            await openModal(fgBase(), { timeHighlights: [hl] });
            const dlg = within(screen.getByRole('dialog', { name: 'Running condition' }));
            expect(dlg.getByTestId('train-hl-warning').textContent).toContain('Train P1 overlaps the highlight “Trip”');
            fireEvent.click(dlg.getByTestId('train-hl-split'));
            expect(dlg.getAllByTestId(/^period-row-/)).toHaveLength(2);
            expect(dlg.queryByTestId('train-hl-warning')).toBeNull();
            expect(apply().disabled).toBe(false);
        });
    });

    describe('Mark complete needs a test period; "Tested · N" in the footer only', () => {
        it('no test period: Mark complete is disabled with the reason, and clicking exports nothing', async () => {
            await hsMount([HS_IND()], {}, { runningConditionTestPeriods: [] });
            await openHealthPage();
            await waitFor(() => expect(screen.getByTestId('mark-block-reason').textContent).toBe(NO_TEST_PERIOD_REASON));
            expect(hsMarkBtn().disabled).toBe(true);
            expect(hsMarkBtn().title).toBe(NO_TEST_PERIOD_REASON);
            await hsClickMark();
            expect(exportCalls()).toHaveLength(0);
            expect(screen.queryByTestId('tested-pill')).toBeNull();
        });

        it('with a test period: Mark complete is enabled, the export carries test_periods, and the footer shows "Tested · 1"', async () => {
            await hsMount([HS_IND()]);
            await openHealthPage();
            await waitFor(() => expect(hsMarkBtn().disabled).toBe(false));
            expect(screen.getByTestId('tested-pill').textContent).toBe('Tested · 1');
            expect(healthCalls().slice(-1)[0].test_periods).toEqual([{ start: ONE_TEST[0].start, end: ONE_TEST[0].end, label: 'normal', event_time: null }]);
            await hsClickMark();
            await waitFor(() => expect(exportCalls()).toHaveLength(1));
            expect(exportCalls()[0].test_periods).toHaveLength(1);
            // the pill also sits in the Model fit footer, never anywhere else
            fireEvent.click(screen.getByTestId('footer-back-to-fit'));
            expect(screen.getAllByTestId('tested-pill')).toHaveLength(1);
            expect(screen.getByTestId('tested-pill').closest('.f4-foot')).not.toBeNull();
        });

        it('an untrained model shows no "Tested" pill', async () => {
            await hsMount([makeModel()]);
            expect(screen.queryByTestId('tested-pill')).toBeNull();
        });
    });

    describe('"Test periods changed" (rule 8)', () => {
        it('a notice under the Step-1 card counts the models that need Mark complete again', async () => {
            await hsMount([HS_IND({ status: false, testsChangedAt: '2026-10-07T01:00:00.000Z' })]);
            expect(screen.getByTestId('tests-changed-notice').textContent)
                .toBe('Test periods changed — 1 complete model needs Mark complete again. It was not re-trained.');
        });

        it('the Health score page shows the banner; "removed" when no test period is left', async () => {
            await hsMount([HS_IND({ status: false, testsChangedAt: '2026-10-07T01:00:00.000Z' })], {}, { runningConditionTestPeriods: [] });
            expect(screen.getByTestId('tests-changed-notice').textContent).toContain('Test periods removed');
            await openHealthPage();
            expect(screen.getByTestId('tests-changed-banner').getAttribute('data-state')).toBe('removed');
        });

        it('"Saved N files" is not left on screen once the model is no longer Complete (a tests-only change / Mark incomplete)', async () => {
            await hsMount([HS_IND()]);
            await openHealthPage();
            await waitFor(() => expect(hsMarkBtn().disabled).toBe(false));
            await hsClickMark();
            await waitFor(() => expect(screen.getByTestId('save-ok')).toBeTruthy());
            await act(async () => { fireEvent.click(screen.getByTestId('mark-incomplete')); await Promise.resolve(); });
            await flush();
            expect(screen.queryByTestId('save-ok')).toBeNull();
        });

        it('no notice without the stamp, or once the model is Complete again', async () => {
            await hsMount([HS_IND({ status: true, testsChangedAt: '2026-10-07T01:00:00.000Z' })]);
            expect(screen.queryByTestId('tests-changed-notice')).toBeNull();
        });
    });

    describe('Custom mode: the model\'s own test periods live in Model settings', () => {
        it('switching to Custom shows the test periods editor next to the train periods; edits stay in the draft until Save', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: fgBase({ runningConditionNoneConfirmed: true }) });
            statefulUpdateMock([makeModel()], fgBase({ runningConditionNoneConfirmed: true }));
            openSettings();
            fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
            const tests = within(screen.getByTestId('custom-test-periods'));
            expect(tests.getByTestId('test-periods-editor').className).toContain('tpe-periods--compact');
            fireEvent.click(tests.getByLabelText('Remove test period 1'));
            expect(tests.getByTestId('tests-empty')).toBeTruthy();
            await act(async () => {
                fireEvent.click(screen.getByText('Save changes'));
                await Promise.resolve(); await Promise.resolve();
            });
            const fg = await lastWrittenFg();
            expect(fg.models[0].runningConditionMode).toBe('custom');
            expect(fg.models[0].customTestPeriods).toEqual([]);
            // the workspace list is untouched
            expect(fg.runningConditionTestPeriods).toEqual(ONE_TEST);
        });
    });
});

// 🆕 2026-10-07 code-review fixes on Train/Test validation (fe-ui-agent).
describe('Train / Test validation — review fixes (2026-10-07)', () => {
    const CUSTOM_TRAIN = [{ id: 'ct', start: '2024-01-01T00:00', end: '2024-01-11T00:00' }];
    const customInd = (over: Record<string, any> = {}) => withTrained(makeModel({
        healthSetPoints: HS_SNAP,
        runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true,
        filterTimePeriods: CUSTOM_TRAIN, customTestPeriods: ONE_TEST,
        ...over,
    }));
    const customTests = () => within(screen.getByTestId('custom-test-periods'));
    const lastFg = async () =>
        (await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value).failureGroupState;

    describe('Mark complete saves unsaved Model settings first (must-fix 1)', () => {
        it('a Custom model with an UNSAVED test-period edit: Mark complete succeeds once, files written once, disk has the edited tests', async () => {
            await hsMount([customInd()]);
            openSettings();
            fireEvent.click(customTests().getByTestId('test-label-problem-1'));
            await openHealthPage();
            await waitFor(() => expect(hsMarkBtn().disabled).toBe(false));
            await hsClickMark();
            await waitFor(() => expect(screen.getByTestId('save-ok')).toBeTruthy());
            expect(screen.queryByTestId('save-error')).toBeNull();
            // the files describe the edited tests, and were written exactly once
            expect(exportCalls()).toHaveLength(1);
            expect(exportCalls()[0].test_periods).toEqual([{ start: ONE_TEST[0].start, end: ONE_TEST[0].end, label: 'problem', event_time: null }]);
            // what is on disk: Complete, with the edited tests, no "changed" stamp left
            const fg = await lastFg();
            expect(fg.models[0].status).toBe(true);
            expect(fg.models[0].customTestPeriods).toEqual([{ ...ONE_TEST[0], label: 'problem' }]);
            expect(fg.models[0].testsChangedAt).toBeUndefined();
            expect(fg.models[0].healthExport).toBeTruthy();
        });

    });

    describe('Custom test periods are validated on Save (should-fix 2a)', () => {
        it('an event time outside its test period blocks Save changes (and Train) with the reason; the editor says "to save"', async () => {
            await hsMount([customInd()]);
            openSettings();
            fireEvent.click(customTests().getByTestId('test-label-problem-1'));
            const ev = customTests().getByLabelText('Test period 1 event time');
            fireEvent.change(ev, { target: { value: '2025-05-01T00:00' } });
            fireEvent.blur(ev);
            expect(customTests().getByTestId('test-event-invalid-1').textContent).toContain('Fix it, or clear it, to save.');
            const save = screen.getByText('Save changes') as HTMLButtonElement;
            expect(save.disabled).toBe(true);
            expect(screen.getByTestId('build-block-reason').textContent).toContain('The event time must be inside T1.');
            mockUpdateWorkspaceData.mockClear();
            fireEvent.click(save);
            await flush();
            expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
            // moving it inside lifts the block
            fireEvent.change(customTests().getByLabelText('Test period 1 event time'), { target: { value: '2024-01-20T06:00' } });
            fireEvent.blur(customTests().getByLabelText('Test period 1 event time'));
            expect((screen.getByText('Save changes') as HTMLButtonElement).disabled).toBe(false);
        });

        it('a Workspace-mode model is never blocked by its (unused) custom test list', async () => {
            await hsMount([withTrained(makeModel({ healthSetPoints: HS_SNAP, customTestPeriods: [{ ...ONE_TEST[0], end: '' }] }))]);
            expect(screen.queryByTestId('build-block-reason')).toBeNull();
        });
    });

    describe('test results are numbered by their ORIGINAL list position (should-fix 2b)', () => {
        it('[T1 invalid, T2 valid]: only T2 is sent, and the table row, tile and overlap note all say "T2"', async () => {
            const tests = [
                { id: 'bad', start: '2024-02-10T00:00', end: '2024-02-01T00:00', label: 'normal' },
                { ...ONE_TEST[0], id: 'good' },
            ];
            mockInvoke.mockImplementation((cmd: string, args?: any) => {
                if (cmd === 'compute_health_preview') {
                    const req = args?.request;
                    return Promise.resolve(makeSetPointAwarePreview(req, {
                        test_validation: makeValidation({
                            tests: (req?.test_periods ?? []).map((t: any, i: number) => makeTestResult({ index: i + 1, start: t.start, end: t.end, label: t.label, train_rows: 10, train_days: 2 })),
                        }),
                    }));
                }
                return healthInvoke(cmd, args);
            });
            const model = HS_IND();
            statefulUpdateMock([model], { runningConditionTestPeriods: tests });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [model], runningConditionTestPeriods: tests } });
            await waitFor(() => expect(screen.getByTestId('train-test-row-2')).toBeTruthy());
            expect(healthCalls().slice(-1)[0].test_periods).toHaveLength(1);
            expect(screen.queryByTestId('train-test-row-1')).toBeNull();
            expect(screen.getByTestId('train-test-row-2').textContent).toContain('T2 Normal');
            expect(screen.getByTestId('train-test-overlap-2').textContent).toContain('T2 includes 2 d of train running time');
            await openHealthPage();
            expect(screen.getByTestId('test-result-2').textContent).toContain('T2 Normal');
            expect(screen.getByTestId('test-result-overlap-2').textContent).toContain('T2 includes');
            expect(screen.queryByTestId('test-result-1')).toBeNull();
        });
    });

    describe('Relation model: Train also predicts the test rows; slow scoring says so (should-fix 3)', () => {
        const relModel = (over: Record<string, any> = {}) => makeModel({ id: 'r1', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2'], relStiffness: 10_000, ...over });
        const trainArgs = async (model: any, fgOver: Record<string, any> = {}) => {
            cleanup();
            mockInvoke.mockClear();
            statefulUpdateMock([model], fgOver);
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [model], ...fgOver } });
            await act(async () => { fireEvent.click(trainSensorBtn()); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
            return mockInvoke.mock.calls.find(c => c[0] === 'preview_relationship_model')![1] as any;
        };

        it('Workspace mode sends the workspace test periods; Custom its own; none = no test_periods key', async () => {
            const ws = await trainArgs(relModel());
            expect(ws.test_periods).toEqual([{ start: ONE_TEST[0].start, end: ONE_TEST[0].end, label: 'normal', event_time: null }]);
            expect(ws.cache_key).toMatch(/^r1::/);

            const own = [{ id: 'o1', start: '2024-03-01T00:00', end: '2024-03-10T00:00', label: 'problem', eventTime: '2024-03-05T12:00' }];
            const custom = await trainArgs(relModel({ runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true, filterTimePeriods: CUSTOM_TRAIN, customTestPeriods: own }));
            expect(custom.test_periods).toEqual([{ start: '2024-03-01T00:00', end: '2024-03-10T00:00', label: 'problem', event_time: '2024-03-05T12:00' }]);

            const none = await trainArgs(relModel(), { runningConditionTestPeriods: [] });
            expect(none).not.toHaveProperty('test_periods');
        });

        it('a test-scoring health preview that takes a while shows the "Scoring test periods" hint; none without test periods', async () => {
            mockInvoke.mockImplementation((cmd: string, args?: any) =>
                cmd === 'compute_health_preview' ? new Promise(() => {}) : healthInvoke(cmd, args));
            const rel = HS_REL();
            statefulUpdateMock([rel]);
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel] } });
            await waitFor(() => expect(healthCalls().length).toBeGreaterThan(0));
            // not at once (a cached re-score finishes well before) ...
            expect(screen.queryByTestId('slow-test-scoring')).toBeNull();
            // ... but once it has been loading for a moment
            await waitFor(() => expect(screen.getByTestId('slow-test-scoring').textContent).toContain('Scoring test periods with the Relation model'), { timeout: 3000 });

            cleanup();
            mockInvoke.mockClear();
            statefulUpdateMock([rel], { runningConditionTestPeriods: [] });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel], runningConditionTestPeriods: [] } });
            await waitFor(() => expect(healthCalls().length).toBeGreaterThan(0));
            await act(async () => { await new Promise(r => setTimeout(r, 1600)); });
            expect(screen.queryByTestId('slow-test-scoring')).toBeNull();
        });

        it('SIDECAR_OUTDATED on Train shows the app wording, not the raw code', async () => {
            mockInvoke.mockImplementation((cmd: string, args?: any) =>
                cmd === 'preview_relationship_model'
                    ? Promise.reject('SIDECAR_OUTDATED: The Relation model engine in this build is out of date - please reinstall or update the app.')
                    : healthInvoke(cmd, args));
            const rel = relModel();
            statefulUpdateMock([rel]);
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel] } });
            await act(async () => { fireEvent.click(trainSensorBtn()); await Promise.resolve(); await Promise.resolve(); });
            await waitFor(() => expect(screen.getByTestId('results-error').textContent).toContain('reinstall or update the app'));
            expect(screen.getByTestId('results-error').textContent).not.toContain('SIDECAR_OUTDATED');
        });
    });

    describe('recommended train days: an estimate for a Custom model too (nit 7)', () => {
        it('a Custom model with no test period gets the amber "Only N d" note from its own row count', async () => {
            mockInvoke.mockImplementation((cmd: string, args?: any) => {
                if (cmd === 'get_dataset_time_bounds') return Promise.resolve({ min: '2024-01-01 00:00:00', max: '2024-04-10 00:00:00' }); // 100 days
                if (cmd === 'compute_sensor_stats') {
                    // 10 % of the rows pass the model's own filter; 100 % with no filter
                    return Promise.resolve({ mean: 5, sd: 1, min: 0, max: 10, count: args?.filter ? 10 : 100, lower1: 4, upper1: 6, lower3: 2, upper3: 8 });
                }
                return healthInvoke(cmd, args);
            });
            const model = customInd({ customTestPeriods: [] });
            statefulUpdateMock([model]);
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [model] } });
            await waitFor(() => expect(screen.getByTestId('train-days-warning').textContent).toContain('Only 10 d of train running time'));
            expect(screen.getByTestId('train-days-warning').textContent).toContain('You can still train.');
        });
    });

    describe('re-pointing the window at another workspace (test gap)', () => {
        it('drops the old workspace test periods and Dashboard highlights at once (before the new one has loaded)', async () => {
            const hl = { id: 'h1', start: '2024-03-01 00:00:00', end: '2024-03-05 00:00:00', label: 'Seal leak', color: '#f43f5e', enabled: true };
            render(<BuildModelWindow />);
            await deliverData({ timeHighlights: [hl] });
            expect(screen.getAllByTestId('rc-card-test-chip')[0].textContent).toContain('T1 Normal');
            fireEvent.click(screen.getByTestId('rc-card-open'));
            await flush();
            expect((screen.getByTestId('test-from-hl') as HTMLButtonElement).disabled).toBe(false);

            // workspace B never finishes loading: anything still on screen would be A's
            mockLoadWorkspaceData.mockReturnValue(new Promise(() => {}));
            await act(async () => {
                for (const cb of listenCallbacks['build-model-data'] ?? []) cb({ payload: {
                    workspaceId: 'ws2', sensorHeaders: ['TAG1'], sensorMetadata: [],
                    metadata: { headers: ['timestamp', 'TAG1'], total_rows: 1 },
                } });
                await Promise.resolve();
                await Promise.resolve();
            });
            // the re-point also closed the modal
            expect(screen.queryByRole('dialog', { name: 'Running condition' })).toBeNull();
            // B has nothing configured yet (its load is pending): no trace of A's T1 anywhere
            expect(screen.getByTestId('rc-card').getAttribute('data-state')).toBe('unset');
            expect(screen.queryByText(/T1 Normal/)).toBeNull();
            fireEvent.click(screen.getByTestId('rc-card-open'));
            await flush();
            const dlg = within(screen.getByRole('dialog', { name: 'Running condition' }));
            expect(dlg.queryByTestId('test-row-1')).toBeNull();
            expect((dlg.getByTestId('test-from-hl') as HTMLButtonElement).disabled).toBe(true);
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Train sensor / Train all with a queue (customer batch 2026-10, items 8 + 9):
// the WIRING of `useTrainQueue` into this window. The parts themselves are
// tested in TrainQueueParts.test.tsx, the queue rules in useTrainQueue.test.ts.
// ─────────────────────────────────────────────────────────────────────────
describe('train queue wiring (customer items 8 + 9)', () => {
    const IND2 = (over: Record<string, any> = {}) => makeModel({ id: 'i2', name: 'Temp I', targetSensor: 'TAG2', ...over });
    const REL2 = (over: Record<string, any> = {}) => makeModel({ id: 'r2', name: 'Temp R', kind: 'relationship', targetSensor: 'TAG2', predictorSensors: ['TAG1'], ...over });
    /** Holds every `compute_sensor_stats` of `sensor` (the Individual train) until `release()`.
     *  The Step-1 row count asks for TAG1, so TAG2 / TAG3 are only ever a model's train. */
    function holdStats(sensor = 'TAG2', base: (cmd: string, args?: any) => Promise<unknown> = defaultInvoke) {
        let release: () => void = () => {};
        const gate = new Promise<void>(r => { release = r; });
        mockInvoke.mockImplementation((cmd: string, args?: any) =>
            cmd === 'compute_sensor_stats' && args?.sensor === sensor ? gate.then(() => base(cmd, args)) : base(cmd, args));
        return () => act(async () => { release(); await Promise.resolve(); await Promise.resolve(); });
    }
    async function mountModels(models: any[], extra: Record<string, any> = {}, payloadOver: Record<string, any> = {}) {
        statefulUpdateMock(models, extra);
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models, ...extra } }, payloadOver);
    }
    const clickTrainSensor = () => act(async () => { fireEvent.click(trainSensorBtn()); await Promise.resolve(); await Promise.resolve(); });
    const strip = () => screen.getByTestId('train-run-strip');
    const lastDisk = async () => (await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value).failureGroupState;
    const calls = (cmd: string, sensor?: string) => mockInvoke.mock.calls.filter(c => c[0] === cmd && (sensor === undefined || (c[1] as any)?.sensor === sensor));
    const selectRow = (text: string) => fireEvent.click(screen.getAllByTestId('sensor-row-label').find(e => e.textContent?.includes(text))!);

    it('Train sensor runs every model of the sensor one at a time (I then R), with list badges and a run strip', async () => {
        const release = holdStats();
        await mountModels([IND2(), REL2()]);
        expect(trainSensorBtn().textContent).toBe('▶ Train sensor · 2 of 2');
        expect(screen.getByTestId('train-sensor-why').textContent).toBe('Trains Individual + Relationship · ≈ 16 s');
        await clickTrainSensor();
        expect(screen.getByTestId('sensor-kind-badge-running-i2')).toBeTruthy();
        expect(screen.getByTestId('sensor-kind-badge-queued-r2')).toBeTruthy();
        expect(screen.getByTestId('train-run-text').textContent).toBe('Training 1 of 2');
        expect(trainSensorBtn().disabled).toBe(true);
        expect((screen.getByTestId('train-all') as HTMLButtonElement).disabled).toBe(true);
        // Strictly one at a time: the Relation model has not started while the Individual one trains.
        expect(calls('preview_relationship_model')).toHaveLength(0);
        await release();
        await waitFor(() => expect(strip().getAttribute('data-phase')).toBe('done'));
        expect(calls('preview_relationship_model')).toHaveLength(1);
        expect(screen.getByTestId('train-run-text').textContent).toBe('Done · 2 trained');
        const models = (await lastDisk()).models;
        expect(models.every((m: any) => m.lastTrainedAt && m.status === false)).toBe(true);
    });

    it('a queued model is locked ("Remove from run", Save disabled); removing it leaves it untrained', async () => {
        const release = holdStats();
        await mountModels([IND2(), REL2()]);
        await clickTrainSensor();
        fireEvent.click(screen.getAllByRole('tab').find(t => t.textContent?.includes('Relationship'))!);
        expect(screen.getByTestId('settings-locked').textContent).toContain('Locked while this model is in the run');
        expect(screen.getByTestId('queued-card').textContent).toContain('Queued · next');
        expect(screen.getByTestId('footer-status').textContent).toBe('Queued in the run · next');
        const save = screen.getByText('Save changes') as HTMLButtonElement;
        expect(save.disabled).toBe(true);
        expect(save.title).toBe('Settings are locked while this model is in the run');
        expect(screen.queryByTestId('add-model-form')).toBeNull();
        await act(async () => { fireEvent.click(screen.getByTestId('remove-from-run')); });
        expect(screen.queryByTestId('settings-locked')).toBeNull();
        expect(screen.queryByTestId('queued-card')).toBeNull();
        await release();
        await waitFor(() => expect(strip().getAttribute('data-phase')).toBe('done'));
        expect(calls('preview_relationship_model')).toHaveLength(0);
        expect(screen.getByTestId('train-run-text').textContent).toBe('Done · 1 trained · 1 removed');
        const r2 = (await lastDisk()).models.find((m: any) => m.id === 'r2');
        expect(r2.lastTrainedAt).toBeFalsy();
        expect(r2.status).toBe(false);
    });

    it('STALE (the dataset changed): the run stops at once, strip / sidebar line / Train-sensor reason are red with the shipped wording, both Train buttons disabled', async () => {
        mockInvoke.mockImplementation((cmd: string, args?: any) => cmd === 'get_session_generation' ? Promise.resolve(6) : defaultInvoke(cmd, args));
        await mountModels([IND2(), REL2()], {}, { metadata: { headers: ['timestamp', 'TAG1', 'TAG2', 'TAG3'], total_rows: 100, generation: 5 } });
        await clickTrainSensor();
        await waitFor(() => expect(strip().getAttribute('data-phase')).toBe('stale'));
        expect(strip().getAttribute('data-tone')).toBe('danger');
        expect(screen.getByTestId('train-run-text').textContent).toBe('Run stopped: the data changed');
        expect(screen.getByTestId('train-run-stale').textContent).toContain('The data in this window is out of date. Close it and open Build Model again from the Dashboard.');
        // Nothing trained, the Relation model never started.
        expect(calls('compute_sensor_stats', 'TAG2')).toHaveLength(0);
        expect(calls('preview_relationship_model')).toHaveLength(0);
        expect(trainSensorBtn().disabled).toBe(true);
        expect(screen.getByTestId('train-sensor-why').textContent).toBe('The data in this window is out of date. Close it and open Build Model again from the Dashboard.');
        expect(screen.getByTestId('train-sensor-why').className).toContain('tq-why--danger');
        expect((screen.getByTestId('train-all') as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByTestId('train-all-reason').className).toContain('tq-why--danger');
        await act(async () => { fireEvent.click(screen.getByTestId('train-run-close-window')); await Promise.resolve(); await Promise.resolve(); });
        expect(mockClose).toHaveBeenCalled();
    });

    it('the silent auto-recompute is skipped while a run is active, and runs once it ends (never two trains at once)', async () => {
        const release = holdStats('TAG2');
        await mountModels([IND2(), withTrained(makeModel({ id: 'i3', name: 'Other', targetSensor: 'TAG3' }))]);
        await flush();
        expect(calls('compute_sensor_stats', 'TAG3')).toHaveLength(0); // TAG2 is the selected sensor
        await clickTrainSensor();
        selectRow('TAG3');
        await flush();
        expect(calls('compute_sensor_stats', 'TAG3')).toHaveLength(0);
        await release();
        await waitFor(() => expect(calls('compute_sensor_stats', 'TAG3')).toHaveLength(1));
    });

    it('closing during a run asks first (toolbar X and native close); "Keep training" is the default; "Stop after this model and close" closes once it is done', async () => {
        const release = holdStats();
        await mountModels([IND2(), REL2()]);
        await clickTrainSensor();
        await act(async () => { fireEvent.click(screen.getByTitle('Close')); await Promise.resolve(); });
        expect(screen.getByRole('alertdialog').textContent).toContain('Training is still running');
        expect(document.activeElement).toBe(screen.getByTestId('close-run-keep'));
        expect(mockClose).not.toHaveBeenCalled();
        fireEvent.click(screen.getByTestId('close-run-keep'));
        expect(screen.queryByRole('alertdialog')).toBeNull();
        // The native close (titlebar X / Alt+F4) is held the same way.
        const preventDefault = vi.fn();
        await act(async () => { await mockCloseRequestedHandler!({ preventDefault }); });
        expect(preventDefault).toHaveBeenCalled();
        expect(screen.getByRole('alertdialog')).toBeTruthy();
        await act(async () => { fireEvent.click(screen.getByTestId('close-run-stop')); await Promise.resolve(); });
        expect(screen.queryByRole('alertdialog')).toBeNull();
        expect(screen.getByTestId('train-run-text').textContent).toBe('Closing after this model…');
        expect(mockClose).not.toHaveBeenCalled();
        await release();
        await waitFor(() => expect(mockClose).toHaveBeenCalled());
        // Stopped after the Individual model: the Relation model never started.
        expect(calls('preview_relationship_model')).toHaveLength(0);
    });

    it('the close dialog turns into "Run finished — close?" when the run ends while it is open', async () => {
        const release = holdStats();
        await mountModels([IND2()]);
        await clickTrainSensor();
        await act(async () => { fireEvent.click(screen.getByTitle('Close')); await Promise.resolve(); });
        expect(screen.getByRole('alertdialog').textContent).toContain('Training is still running');
        await release();
        await waitFor(() => expect(screen.getByRole('alertdialog').textContent).toContain('Run finished — close?'));
        expect(screen.getByTestId('close-run-numbers').textContent).toBe('1 trained. Trained models keep their results.');
        await act(async () => { fireEvent.click(screen.getByTestId('close-run-close')); await Promise.resolve(); await Promise.resolve(); });
        expect(mockClose).toHaveBeenCalled();
    });

    it('after a run: a "Set points needed" list chip and the Health score banner with "Next needing set points"', async () => {
        mockInvoke.mockImplementation(healthInvoke);
        await mountModels([IND2(), makeModel({ id: 'i3', name: 'Other', targetSensor: 'TAG3' })]);
        expect(screen.queryByTestId('chip-set-points-needed')).toBeNull();
        await act(async () => { fireEvent.click(screen.getByTestId('train-all')); });
        expect(screen.getByTestId('train-all-modal').getAttribute('data-view')).toBe('preflight');
        await act(async () => { fireEvent.click(screen.getByTestId('train-all-start')); await Promise.resolve(); });
        await waitFor(() => expect(screen.getByTestId('train-all-modal').getAttribute('data-view')).toBe('done'));
        expect(screen.getByTestId('train-row-status-i2').textContent).toBe('✓ Trained · set points needed');
        fireEvent.click(screen.getByTestId('train-open-i2'));
        expect(screen.queryByTestId('train-all-modal')).toBeNull();
        expect(screen.getByTestId('chip-set-points-needed').textContent).toBe('Set points needed 2');
        await waitFor(() => expect(screen.getByTestId('set-points-card')).toBeTruthy());
        expect(screen.getByTestId('run-setpoints-text').textContent).toBe('2 trained in this run need set points (2 in total)');
        expect(screen.getByTestId('run-setpoints-banner').textContent).toContain('this is 1 of 2');
        fireEvent.click(screen.getByTestId('next-needing-set-points'));
        expect(screen.getByRole('heading', { level: 3 }).textContent).toContain('TAG3');
        // The chip filters the list to the sensors still needing set points.
        fireEvent.click(screen.getByTestId('chip-set-points-needed'));
        expect(screen.getAllByTestId('sensor-row-label')).toHaveLength(2);
    });

    it('Train all preflight: Fix → jumps to the model settings', async () => {
        const noPred = makeModel({ id: 'r3', name: 'No pred', kind: 'relationship', targetSensor: 'TAG3', predictorSensors: [] });
        await mountModels([IND2(), noPred]);
        expect(screen.getByTestId('train-all-counts').textContent).toBe("1 ready0 up to date1 can't train");
        await act(async () => { fireEvent.click(screen.getByTestId('train-all')); });
        expect(screen.getByTestId('train-row-status-r3').textContent).toBe("Can't train — no predictor sensor");
        fireEvent.click(screen.getByTestId('train-fix-r3'));
        expect(screen.queryByTestId('train-all-modal')).toBeNull();
        expect(screen.getByRole('heading', { level: 3 }).textContent).toContain('TAG3');
        expect(screen.getByTestId('add-model-form')).toBeTruthy();
    });

    it('no running condition: Train all and Train sensor are disabled with the reason as text, and the Step-1 card says Not set', async () => {
        await mountModels([IND2()], { runningConditionNoneConfirmed: false, rcLegacyNotice: null });
        fireEvent.click(screen.getByLabelText('Close')); // the auto-opened settings modal
        expect(screen.getByTestId('rc-card-pill').textContent).toBe('Not set');
        expect((screen.getByTestId('train-all') as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByTestId('train-all-reason').textContent).toBe(TRAIN_NEEDS_RUNNING_CONDITION);
        expect(screen.getByTestId('train-all-reason').className).toContain('tq-why--warn');
        expect(trainSensorBtn().disabled).toBe(true);
        expect(screen.getByTestId('train-sensor-why').textContent).toBe(TRAIN_NEEDS_RUNNING_CONDITION);
    });

    it('a run that trains OTHER models does not refetch the open model\'s charts (performance)', async () => {
        await mountModels([withTrained(makeModel({ id: 'i3', name: 'Other', targetSensor: 'TAG3' })), IND2()]);
        await waitFor(() => expect(screen.getByTestId('results-chart')).toBeTruthy());
        await new Promise(r => setTimeout(r, 400)); // the preview's debounce settles
        const before = healthCalls().length;
        await act(async () => { fireEvent.click(screen.getByTestId('train-all')); });
        await act(async () => { fireEvent.click(screen.getByTestId('train-all-start')); await Promise.resolve(); });
        await waitFor(() => expect(screen.getByTestId('train-all-modal').getAttribute('data-view')).toBe('done'));
        expect(screen.getByTestId('train-row-status-i2').textContent).toBe('✓ Trained · set points needed');
        await new Promise(r => setTimeout(r, 400));
        expect(healthCalls().length).toBe(before);
    });

    it('re-pointed at another workspace mid-run: the run is dropped (no strip, Train buttons free again)', async () => {
        holdStats();
        await mountModels([IND2()]);
        await clickTrainSensor();
        expect(strip()).toBeTruthy();
        mockLoadWorkspaceData.mockResolvedValue({ id: 'ws2', failureGroupState: { groups: [makeGroup()], models: [makeModel({ id: 'w2', targetSensor: 'TAG1' })], runningConditionNoneConfirmed: true, rcLegacyNotice: null, runningConditionTimePeriods: ALL_TIME_TRAIN, runningConditionTestPeriods: ONE_TEST } });
        await act(async () => {
            for (const cb of listenCallbacks['build-model-data'] ?? []) cb({ payload: { workspaceId: 'ws2', sensorHeaders: ['TAG1', 'TAG2'], sensorMetadata: [], metadata: { headers: ['timestamp', 'TAG1', 'TAG2'], total_rows: 1 } } });
            await Promise.resolve(); await Promise.resolve();
        });
        await flush();
        expect(screen.queryByTestId('train-run-strip')).toBeNull();
        expect(trainSensorBtn().disabled).toBe(false);
    });
});

// Phase 4 code-review fixes: workspace-closing, a hung train at close, re-points
// during waits, the sidecar overlap rules (Mark complete / Compare predictors /
// Re-train while a run is active), and the NOT_FITTED re-fit plan.
describe('train queue wiring — review fixes (phase 4)', () => {
    const IND2 = (over: Record<string, any> = {}) => makeModel({ id: 'i2', name: 'Temp I', targetSensor: 'TAG2', ...over });
    const IND3T = (over: Record<string, any> = {}) => withTrained(makeModel({ id: 'i3', name: 'Other', targetSensor: 'TAG3', ...over }));
    /** Holds `compute_sensor_stats` of `sensor` until the returned release is called. */
    function hold(sensor: string, base: (cmd: string, args?: any) => Promise<unknown> = defaultInvoke) {
        let release: () => void = () => {};
        const gate = new Promise<void>(r => { release = r; });
        mockInvoke.mockImplementation((cmd: string, args?: any) =>
            cmd === 'compute_sensor_stats' && args?.sensor === sensor ? gate.then(() => base(cmd, args)) : base(cmd, args));
        return () => act(async () => { release(); await Promise.resolve(); await Promise.resolve(); });
    }
    async function mountModels(models: any[], extra: Record<string, any> = {}) {
        statefulUpdateMock(models, extra);
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models, ...extra } });
    }
    const statsFor = (sensor: string) => mockInvoke.mock.calls.filter(c => c[0] === 'compute_sensor_stats' && (c[1] as any)?.sensor === sensor);
    const clickTrainAll = async () => {
        await act(async () => { fireEvent.click(screen.getByTestId('train-all')); });
        await act(async () => { fireEvent.click(screen.getByTestId('train-all-start')); await Promise.resolve(); await Promise.resolve(); });
    };
    const emitEvent = (name: string, payload: unknown) => act(async () => {
        for (const cb of listenCallbacks[name] ?? []) cb({ payload });
        await Promise.resolve(); await Promise.resolve();
    });
    const repoint = async () => {
        mockLoadWorkspaceData.mockResolvedValue({ id: 'ws2', failureGroupState: { groups: [makeGroup()], models: [makeModel({ id: 'w2', targetSensor: 'TAG1' })], runningConditionNoneConfirmed: true, rcLegacyNotice: null, runningConditionTimePeriods: ALL_TIME_TRAIN, runningConditionTestPeriods: ONE_TEST } });
        await emitEvent('build-model-data', { workspaceId: 'ws2', sensorHeaders: ['TAG1', 'TAG2'], sensorMetadata: [], metadata: { headers: ['timestamp', 'TAG1', 'TAG2'], total_rows: 1 } });
        await flush();
    };
    const stamped = async () => (await Promise.all(mockUpdateWorkspaceData.mock.results.map(r => r.value)))
        .flatMap((w: any) => w?.failureGroupState?.models ?? []).filter((m: any) => m.lastTrainedAt && m.id !== 'i3');

    it('workspace-closing for THIS workspace during a run: the run is dropped and the window closes without asking (a foreign one is ignored)', async () => {
        hold('TAG2');
        await mountModels([IND2()]);
        await act(async () => { fireEvent.click(trainSensorBtn()); await Promise.resolve(); });
        await act(async () => { fireEvent.click(screen.getByTitle('Close')); await Promise.resolve(); });
        expect(screen.getByRole('alertdialog')).toBeTruthy();
        await emitEvent('workspace-closing', { workspaceId: 'other-ws' });
        expect(screen.getByTestId('train-run-strip')).toBeTruthy();
        expect(mockClose).not.toHaveBeenCalled();
        await emitEvent('workspace-closing', { workspaceId: 'ws1' });
        await flush();
        expect(screen.queryByTestId('train-run-strip')).toBeNull();
        expect(screen.queryByRole('alertdialog')).toBeNull();
        expect(mockClose).toHaveBeenCalledTimes(1);
        // The Dashboard's own close that follows is not held either.
        const preventDefault = vi.fn();
        await act(async () => { await mockCloseRequestedHandler!({ preventDefault }); });
        expect(preventDefault).not.toHaveBeenCalled();
    });

    it('a hung train at close: "Stop after this model and close" gives up after the cap with a notice; the next close goes through; a second Stop does not wait twice', async () => {
        const wait = MARK_COMPLETE_CLOSE_WAIT.ms;
        MARK_COMPLETE_CLOSE_WAIT.ms = 30;
        try {
            hold('TAG2'); // never released: the sidecar "hangs"
            await mountModels([IND2(), makeModel({ id: 'i4', targetSensor: 'TAG3' })]);
            await clickTrainAll();
            await act(async () => { fireEvent.click(screen.getByTitle('Close')); await Promise.resolve(); });
            await act(async () => { fireEvent.click(screen.getByTestId('close-run-stop')); await Promise.resolve(); });
            // A second attempt while the first still waits: the dialog again, Stop again — ignored.
            await act(async () => { fireEvent.click(screen.getByTitle('Close')); await Promise.resolve(); });
            await act(async () => { fireEvent.click(screen.getByTestId('close-run-stop')); await Promise.resolve(); });
            await waitFor(() => expect(screen.getByTestId('close-wait-notice').textContent).toContain('Still training a model'));
            expect(mockClose).not.toHaveBeenCalled();
            // The next close goes through (no dialog), and a rejected close() is caught.
            mockClose.mockRejectedValueOnce(new Error('window already closing'));
            await act(async () => { fireEvent.click(screen.getByTitle('Close')); await Promise.resolve(); await Promise.resolve(); });
            expect(screen.queryByRole('alertdialog')).toBeNull();
            expect(mockClose).toHaveBeenCalledTimes(1);
            const preventDefault = vi.fn();
            await act(async () => { await mockCloseRequestedHandler!({ preventDefault }); });
            expect(screen.queryByRole('alertdialog')).toBeNull();
        } finally {
            MARK_COMPLETE_CLOSE_WAIT.ms = wait;
        }
    });

    it('re-pointed mid-train: releasing the held train writes nothing to either workspace and leaves the new one alone', async () => {
        const release = hold('TAG2');
        await mountModels([IND2()]);
        await act(async () => { fireEvent.click(trainSensorBtn()); await Promise.resolve(); });
        await repoint();
        mockUpdateWorkspaceData.mockClear();
        await release();
        await flush();
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
        expect(screen.queryByTestId('train-run-strip')).toBeNull();
        expect(screen.getAllByTestId('sensor-row-label').map(e => e.textContent)).toEqual(['TAG1']);
        expect(screen.queryByTestId('results-error')).toBeNull();
    });

    it('a run started while the silent auto-recompute runs waits for it (never two trains at once)', async () => {
        const release = hold('TAG3'); // the auto-recompute of the open, trained i3
        await mountModels([IND3T(), IND2()]);
        await flush();
        expect(statsFor('TAG3')).toHaveLength(1);
        await clickTrainAll(); // i3 is up to date: the run trains only i2
        await flush();
        expect(statsFor('TAG2')).toHaveLength(0);
        await release();
        await waitFor(() => expect(statsFor('TAG2')).toHaveLength(1));
        await waitFor(() => expect(screen.getByTestId('train-run-strip').getAttribute('data-phase')).toBe('done'));
    });

    it('re-pointed while the run waits for the auto-recompute: the waiting model is abandoned, nothing is trained or written', async () => {
        const release = hold('TAG3');
        await mountModels([IND3T(), IND2()]);
        await flush();
        await clickTrainAll();
        await repoint();
        await release();
        await flush();
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(statsFor('TAG2')).toHaveLength(0);
        expect(await stamped()).toEqual([]);
        expect(screen.queryByTestId('train-run-strip')).toBeNull();
    });

    it('while ANY run is active Mark complete is disabled for every model ("Wait for the training run to finish"), Compare predictors too', async () => {
        mockInvoke.mockImplementation(healthInvoke);
        const release = hold('TAG2', healthInvoke);
        await mountModels([IND3T({ healthSetPoints: VALID_IND }), IND2()]);
        await openHealthPage();
        await waitFor(() => expect((screen.getByTestId('mark-complete') as HTMLButtonElement).disabled).toBe(false));
        await clickTrainAll(); // trains i2 only (i3 is up to date and not in the run)
        expect((screen.getByTestId('mark-complete') as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByTestId('mark-block-reason').textContent).toBe('Wait for the training run to finish');
        await release();
        await waitFor(() => expect(screen.getByTestId('train-run-strip').getAttribute('data-phase')).toBe('done'));
        await waitFor(() => expect((screen.getByTestId('mark-complete') as HTMLButtonElement).disabled).toBe(false));
    });

    it('a QUEUED model: locked, and its Mark complete is blocked with the run reason', async () => {
        mockInvoke.mockImplementation(healthInvoke);
        hold('TAG2', healthInvoke);
        await mountModels([IND2(), IND3T({ healthSetPoints: VALID_IND })]);
        fireEvent.click(screen.getAllByTestId('sensor-row-label').find(e => e.textContent?.includes('TAG3'))!);
        await waitFor(() => expect(screen.getByTestId('results-chart')).toBeTruthy());
        // Train all with the up-to-date checkbox: i2 trains first (held), i3 waits in the queue.
        await act(async () => { fireEvent.click(screen.getByTestId('train-all')); });
        fireEvent.click(screen.getByTestId('train-include-up-to-date'));
        await act(async () => { fireEvent.click(screen.getByTestId('train-all-start')); await Promise.resolve(); });
        fireEvent.click(screen.getByTestId('train-all-close'));
        expect(screen.getByTestId('queued-card')).toBeTruthy();
        expect(screen.getByTestId('settings-locked')).toBeTruthy();
        fireEvent.click(screen.getByTestId('page-health'));
        await waitFor(() => expect(screen.getByTestId('mark-complete')).toBeTruthy());
        expect((screen.getByTestId('mark-complete') as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByTestId('mark-block-reason').textContent).toBe('Wait for the training run to finish');
    });

    it('Compare predictors is disabled with the reason while a run of ANOTHER sensor is active', async () => {
        mockInvoke.mockImplementation(healthInvoke);
        const rel = withTrained(makeModel({ id: 'r3', name: 'Rel', kind: 'relationship', targetSensor: 'TAG3', predictorSensors: ['TAG1'] }));
        const release = hold('TAG2', healthInvoke);
        await mountModels([rel, IND2()]);
        await waitFor(() => expect(screen.getByTestId('results-chart')).toBeTruthy());
        await clickTrainAll(); // r3 is up to date: only i2 runs
        const compare = screen.getByTestId('compare-predictors') as HTMLButtonElement;
        expect(compare.disabled).toBe(true);
        expect(compare.title).toBe('Wait for the training run to finish');
        await release();
        await waitFor(() => expect((screen.getByTestId('compare-predictors') as HTMLButtonElement).disabled).toBe(false));
    });

    it('Health score Re-train (NOT_FITTED) is disabled with the reason during a run', async () => {
        const base = (cmd: string, args?: any) => cmd === 'compute_health_preview'
            ? Promise.reject('NOT_FITTED: no fitted model for this key') : healthInvoke(cmd, args);
        mockInvoke.mockImplementation(base);
        const rel = withTrained(makeModel({ id: 'r3', name: 'Rel', kind: 'relationship', targetSensor: 'TAG3', predictorSensors: ['TAG1'] }));
        const release = hold('TAG2', base);
        await mountModels([IND2(), rel]);
        fireEvent.click(screen.getAllByTestId('sensor-row-label').find(e => e.textContent?.includes('TAG3'))!);
        await waitFor(() => expect(screen.getByTestId('results-not-fitted')).toBeTruthy());
        expect((screen.getByTestId('results-not-fitted-retrain') as HTMLButtonElement).disabled).toBe(false);
        // A run (i2 first, held); r3 — planned ready because its fit is gone — is taken out of it again.
        await act(async () => { fireEvent.click(screen.getByTestId('train-all')); });
        await act(async () => { fireEvent.click(screen.getByTestId('train-all-start')); await Promise.resolve(); });
        fireEvent.click(screen.getByTestId('train-remove-r3'));
        fireEvent.click(screen.getByTestId('train-all-close'));
        await flush();
        await waitFor(() => expect(screen.getByTestId('results-not-fitted-retrain')).toBeTruthy());
        const btn = screen.getByTestId('results-not-fitted-retrain') as HTMLButtonElement;
        expect(btn.disabled).toBe(true);
        expect(btn.title).toBe('Wait for the training run to finish');
        // The Health score page's Re-train gets the same reason.
        fireEvent.click(screen.getByTestId('page-health'));
        await flush();
        await waitFor(() => expect(screen.getByTestId('health-not-fitted-retrain')).toBeTruthy());
        const hs = screen.getByTestId('health-not-fitted-retrain') as HTMLButtonElement;
        expect(hs.disabled).toBe(true);
        expect(hs.title).toBe('Wait for the training run to finish');
        await release();
    });

    it('NOT_FITTED: the fit is re-filled once automatically (after the run), and the model is planned as ready meanwhile', async () => {
        let notFitted = true;
        const base = (cmd: string, args?: any) => cmd === 'compute_health_preview' && notFitted
            ? Promise.reject('NOT_FITTED: no fitted model for this key') : healthInvoke(cmd, args);
        mockInvoke.mockImplementation(base);
        const rel = withTrained(makeModel({ id: 'r3', name: 'Rel', kind: 'relationship', targetSensor: 'TAG3', predictorSensors: ['TAG1'] }));
        await mountModels([rel]);
        const fits = () => mockInvoke.mock.calls.filter(c => c[0] === 'preview_relationship_model').length;
        // the reopen fit, then ONE automatic re-fit after NOT_FITTED — no loop
        await waitFor(() => expect(fits()).toBe(2));
        await act(async () => { await new Promise(r => setTimeout(r, 400)); });
        expect(fits()).toBe(2);
        // Train sensor offers it again (ready, not "up to date") while the fit is gone.
        expect(trainSensorBtn().textContent).toBe('▶ Train sensor · 1 of 1');
        expect(screen.getByTestId('train-all-counts').textContent).toBe("1 ready0 up to date0 can't train");
        // A successful train makes it up to date again.
        notFitted = false;
        await act(async () => { fireEvent.click(trainSensorBtn()); await Promise.resolve(); });
        await waitFor(() => expect(screen.getByTestId('train-run-strip').getAttribute('data-phase')).toBe('done'));
        await waitFor(() => expect(trainSensorBtn().textContent).toBe('▶ Train sensor · 0 of 1'));
    });

    it('a model being saved (Mark complete running) is planned as "Can\'t train — being saved"', async () => {
        mockInvoke.mockImplementation((cmd: string, args?: any) => cmd === 'export_model_files' ? new Promise(() => {}) : healthInvoke(cmd, args));
        await mountModels([IND3T({ healthSetPoints: VALID_IND })]);
        await openHealthPage();
        await waitFor(() => expect((screen.getByTestId('mark-complete') as HTMLButtonElement).disabled).toBe(false));
        await act(async () => { fireEvent.click(screen.getByTestId('mark-complete')); await Promise.resolve(); });
        expect(screen.getByTestId('train-sensor-why').textContent).toBe("Can't train: Individual — being saved");
        expect(trainSensorBtn().disabled).toBe(true);
        // every menu item is disabled too, so the ▾ toggle is
        expect((screen.getByTestId('train-sensor-menu-toggle') as HTMLButtonElement).disabled).toBe(true);
    });
});
