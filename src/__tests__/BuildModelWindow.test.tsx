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

// Train in place — mocks for the three preview
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
            // the names in the strip above a time chart (the train shading — a scoring period is not drawn), in band order
            data-strip={((props.option?.series ?? []).find((s: any) => s.name === '__scopes')?.markArea?.data ?? []).filter((a: any) => a[0].label.show).map((a: any) => a[0].label.formatter).join('|')}
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
import { ALL_TIME_TRAIN, LEGACY_TESTS, ONE_TEST } from './helpers/trainTestFixture';
import { MARK_COMPLETE_CLOSE_WAIT } from '../utils/healthPersist';
import { EARLIER_SCORING_HINT_TEXT } from '../utils/modelStatus';
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

/** The detail header's sensor-level "▶ Train sensor · n of m" (
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

/** Seeds a model as Trained-and-fresh — `lastTrainedAt` set plus a
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
 *  model shows Mark incomplete instead" below) — factored out since it is
 *  needed more than once. */
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
    // Fixtures read as a CONFIGURED workspace (No
    // condition confirmed) with the legacy notice already handled, so tests that
    // are about something else don't trip the running-condition gate or the
    // hydration write-back. A test about the gate passes the key explicitly
    // (even as `undefined`), which is respected.
    if (ws.failureGroupState) {
        const fg = ws.failureGroupState;
        ws.failureGroupState = {
            ...(!('runningConditionNoneConfirmed' in fg) ? { runningConditionNoneConfirmed: true } : {}),
            ...(!('rcLegacyNotice' in fg) ? { rcLegacyNotice: null } : {}),
            // Already-migrated periods, so the periods migration's
            // write-back doesn't fire in tests about something else.
            // A train period is required to Train and a scoring
            // period to Mark complete — default
            // to having both.
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
 *  configured — open it first when a test needs to reach a
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
    if (cmd === 'count_period_rows') return Promise.resolve(fakePeriodCounts(args));
    return Promise.resolve({});
}
/** `count_period_rows` stand-in (the Running-condition settings' per-period counts): every period
 *  holds 1,000 rows; with a condition 800 of them are running (20 d), without one all are (25 d).
 *  The dataset has 5,000 rows. */
function fakePeriodCounts(args: any) {
    const cond = !!args?.filter;
    const periods = ((args?.periods ?? []) as { start?: string | null; end?: string | null }[]).map((p, i) => ({
        index: i, start: p.start ?? null, end: p.end ?? null, valid: true, invalid_reason: null,
        rows_in_period: 1000, running_rows: cond ? 800 : 1000, running_days: cond ? 20 : 25,
    }));
    return {
        total_rows: 5000,
        interval_secs: 300,
        periods,
        union: {
            rows_in_period: 1000 * periods.length,
            running_rows: periods.reduce((s, p) => s + p.running_rows, 0),
            running_days: periods.reduce((s, p) => s + p.running_days, 0),
        },
    };
}
/** The `count_period_rows` calls so far: `[periods, filter]` per call. */
const periodCountCalls = () => mockInvoke.mock.calls.filter(c => c[0] === 'count_period_rows').map(c => c[1] as { periods: { start: string | null; end: string | null }[]; filter: unknown; expected_generation: unknown });
const healthCalls = () => mockInvoke.mock.calls.filter(c => c[0] === 'compute_health_preview').map(c => (c[1] as any).request);
/** A Relation model whose preview keeps answering NOT_FITTED: the window re-fits it silently ONCE and
 *  only then settles on the "Fit no longer in memory" state. Waits until that board is on screen and
 *  the fake Rust has been quiet for a moment (longer than the preview's debounce), so nothing is
 *  asserted in the moment between the first answer and the re-fit. */
const fitGoneSettled = async (boardId: 'results-not-fitted' | 'health-not-fitted' = 'results-not-fitted') => {
    for (let i = 0; i < 12; i++) {
        await waitFor(() => expect(screen.getByTestId(boardId)).toBeTruthy(), { timeout: 3000 });
        const calls = mockInvoke.mock.calls.length;
        await act(async () => { await new Promise(r => setTimeout(r, 400)); });
        if (mockInvoke.mock.calls.length === calls && screen.queryByTestId(boardId)) return;
    }
    throw new Error('the "Fit no longer in memory" state never settled');
};

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
    fireEvent.click(screen.getByTestId('next-health-score'));
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
        expect(screen.getByText('Build Model')).toBeTruthy();
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

        // The row is the stacked SensorLabel; its description line is
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
            // The stacked label at header size; component chip after the tag.
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
            expect(tabs.map(t => t.querySelector('.f4-tab-l')!.textContent)).toEqual(['Individual', 'Relation model', 'Clustering']);
            // Workbench redesign §1: ONE state dot per tab (the words are its tooltip) and no text pill at all.
            for (const [i, id] of ['i1', 'r1', 'c1'].entries()) {
                expect(tabs[i].querySelectorAll('.f4-sdot')).toHaveLength(1);
                expect(tabs[i].querySelector('.f4-pill')).toBeNull();
                expect(tabs[i].querySelector('.f4-dirty')).toBeNull();
                const dot = screen.getByTestId(`tab-status-${id}`);
                expect(dot.textContent).toBe('');
                expect(dot.getAttribute('title')).toBeTruthy();
                expect(tabs[i].getAttribute('title')).toBe(`${['Individual', 'Relation model', 'Clustering'][i]} · ${dot.getAttribute('title')}`);
            }
            expect(screen.getByTestId('tab-status-i1').getAttribute('title')).toBe('Not trained yet');
            expect(screen.getByTestId('tab-status-i1').getAttribute('data-dot')).toBe('none');
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
            fireEvent.click(screen.getByRole('tab', { name: /Relation model/ }));
            openSettings();
            expect((screen.getByPlaceholderText('e.g. Bearing vibration model') as HTMLInputElement).value).toBe('Rel');
            fireEvent.click(screen.getByRole('tab', { name: /Individual/ }));
            openSettings();
            expect((screen.getByPlaceholderText('e.g. Bearing vibration model') as HTMLInputElement).value).toBe('Ind renamed');
        });

        it('an unsaved edit is said ONCE, in the footer — the tab carries no "edited" pill; "Save changes" exists only while the draft does', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            expect(screen.queryByTestId('save-changes')).toBeNull();
            openSettings();
            fireEvent.change(screen.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Renamed' } });
            expect(screen.queryByText('edited')).toBeNull();
            expect(screen.getByRole('tab').querySelector('.f4-pill, .f4-dirty')).toBeNull();
            expect(screen.getByTestId('footer-status').textContent).toBe('Unsaved changes to the Individual model');
            expect(screen.getByTestId('save-changes').textContent).toBe('Save changes');
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
            // Predictors are the multi picker's chips + "Add…" (the adapter is
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
            // The list badge of the Relation model says the kind as its tab does — never
            // "Relationship".
            expect(screen.getByTestId('sensor-kind-badge-r1').getAttribute('title')).toMatch(/^Relation model · /);
            fireEvent.click(screen.getByRole('tab', { name: /Relation model/ }));
            openSettings();
            fireEvent.change(screen.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'tag1' } });
            expect(screen.getByTestId('duplicate-name-warning').textContent).toContain("Same name as this sensor's Individual model — give it a different name");
            expect((screen.getByText('Save changes') as HTMLButtonElement).disabled).toBe(true);
            // the suggested name of a Relation model carries the kind as the app says it
            expect(screen.getByTestId('use-suggested-name').textContent).toBe("Use 'tag1 (Relation model)'");
            expect(document.body.textContent).not.toMatch(/Relationship/);

            // ...and the other way round: the Individual model named like the Relation model
            fireEvent.change(screen.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Rel' } });
            fireEvent.click(screen.getByRole('tab', { name: /Individual/ }));
            openSettings();
            fireEvent.change(screen.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'rel' } });
            expect(screen.getByTestId('duplicate-name-warning').textContent).toContain("Same name as this sensor's Relation model — give it a different name");
            // no user-facing text of the window says "Relationship"
            expect(document.body.textContent).not.toMatch(/Relationship/);
        });

        // A workspace saved earlier holds names the old
        // suggestion wrote ("X (Relationship)"). They are the user's data and their
        // export file names — shown and kept exactly as saved, never re-suggested.
        it('a model saved as "TAG1 (Relationship)" keeps its name: shown as saved, no warning, nothing written; a NEW suggestion skips its twin', async () => {
            render(<BuildModelWindow />);
            await deliverData({
                failureGroupState: {
                    groups: [makeGroup()],
                    models: [
                        makeModel({ id: 'i1', kind: 'individual', targetSensor: 'TAG1', name: 'TAG1' }),
                        makeModel({ id: 'r1', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2'], name: 'TAG1 (Relationship)' }),
                    ],
                },
            });
            const writesBefore = mockUpdateWorkspaceData.mock.calls.length;
            fireEvent.click(screen.getByRole('tab', { name: /Relation model/ }));
            openSettings();
            const nameInput = screen.getByPlaceholderText('e.g. Bearing vibration model') as HTMLInputElement;
            expect(nameInput.value).toBe('TAG1 (Relationship)');
            expect(screen.queryByTestId('duplicate-name-warning')).toBeNull();
            // opening the model rewrote nothing
            expect(mockUpdateWorkspaceData.mock.calls.length).toBe(writesBefore);

            // Typing the Individual model's name: the suggestion is the NEW wording, and it
            // steps past the legacy twin a sibling could hold (here the model itself owns
            // the legacy name, so the plain suggestion is free).
            fireEvent.change(nameInput, { target: { value: 'TAG1' } });
            expect(screen.getByTestId('use-suggested-name').textContent).toBe("Use 'TAG1 (Relation model)'");
            // Back to the saved legacy name: not a conflict, Save is not held back by the name.
            fireEvent.change(nameInput, { target: { value: 'TAG1 (Relationship)' } });
            expect(screen.queryByTestId('duplicate-name-warning')).toBeNull();

            // The Individual model named like the Relation model's legacy name is a real duplicate;
            // its suggestion is its own kind word.
            fireEvent.click(screen.getByRole('tab', { name: /Individual/ }));
            openSettings();
            fireEvent.change(screen.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'tag1 (relationship)' } });
            expect(screen.getByTestId('duplicate-name-warning').textContent).toContain("Same name as this sensor's Relation model — give it a different name");
            expect(screen.getByTestId('use-suggested-name').textContent).toBe("Use 'tag1 (relationship) (Individual)'");
        });

        it('the locked Target/X sensor readout can never be reassigned (no select, no input)', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            const readout = screen.queryByText('Pump Pressure (TAG1)', { selector: '.f4-readout span' });
            // Individual doesn't render a locked readout of its own in Model settings
            // (its identity IS the detail header) -- Clustering's X does, though:
            expect(readout).toBeNull();
        });
    });

    // Model settings is ONE three-column grid for all three kinds (SPEC
    // docs/design/handoff/model-settings-layout, 2026-10-12): row 1 is always
    // Model name · the kind's own setting · Training data; the sensors follow. The DOM is in
    // that order (so Tab walks the form as it reads); `.bmw-sets-kind` only groups.
    describe('Model settings layout: one grid, the same first row in every kind', () => {
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

        it('field order in every kind: Model name · the kind\'s own setting · Training data, then the sensors', async () => {
            const LABELS = /^(Model name|Boundary|Stiffness|Clusters|Training data|Predictor sensors \(≥ 1\)|X sensor|Y sensor \(target\)|Criteria sensor \(optional\)|Cluster ranges)$/;
            const cases = [
                { model: makeModel({ id: 'i1', kind: 'individual' }), order: ['Model name', 'Boundary', 'Training data'] },
                { model: makeModel({ id: 'r1', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2'] }), order: ['Model name', 'Stiffness', 'Training data', 'Predictor sensors (≥ 1)'] },
                {
                    model: makeModel({ id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2', criteriaSensor: 'TAG2', clusterRanges: [{ min: 0, max: 100 }] }),
                    order: ['Model name', 'Clusters', 'Training data', 'X sensor', 'Y sensor (target)', 'Criteria sensor (optional)', 'Cluster ranges'],
                },
            ];
            for (const { model, order } of cases) {
                render(<BuildModelWindow />);
                await deliverData({ failureGroupState: { groups: [makeGroup()], models: [model] } });
                openSettings();
                const form = screen.getByTestId('add-model-form');
                const labels = within(form).getAllByText(LABELS).filter(el => el.matches('label, .f4-lbl')).map(el => el.textContent!.replace(/ · requires.*$/, ''));
                expect(labels, model.kind).toEqual(order);
                expect(screen.getByText('Training data').closest('.f4-fld')?.className).toContain('f4-fld--traindata');
                // the form body is the one grid, whatever the kind (no kind-specific layout class)
                expect(form.className).toBe('bmw-sets-body');
                cleanup();
            }
        });

        it('Individual: Boundary is a locked read-out box ("1σ + 3σ · automatic"), not a pill', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel({ id: 'i1', kind: 'individual' })] } });
            openSettings();
            const ro = screen.getByTestId('boundary-readout');
            expect(ro.className).toBe('f4-readout ms-ro');
            expect(ro.textContent).toBe('1σ + 3σ · automatic');
            expect(ro.querySelector('svg')).toBeTruthy(); // the lock
            expect(ro.closest('.f4-fld')!.querySelector('.f4-lbl')!.textContent).toBe('Boundary');
            expect(screen.getByTestId('add-model-form').querySelector('.f4-pill')).toBeNull();
        });

        it('the kind\'s own fields sit in the .bmw-sets-kind groups (the setting of row 1, then the sensors); Model name and Training data are outside them', async () => {
            const rel = makeModel({ kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2'] });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel] } });
            openSettings();
            const form = screen.getByTestId('add-model-form');
            const groups = Array.from(form.querySelectorAll('.bmw-sets-kind'));
            expect(groups).toHaveLength(2);
            expect(within(groups[0] as HTMLElement).getByText('Stiffness')).toBeTruthy();
            expect(within(groups[1] as HTMLElement).getByText('Predictor sensors (≥ 1)')).toBeTruthy();
            for (const g of groups) {
                expect(g.contains(screen.getByText('Training data'))).toBe(false);
                expect(g.contains(screen.getByText('Model name'))).toBe(false);
            }
            // Training data sits between the two groups: the third cell of row 1.
            const train = screen.getByText('Training data').closest('.f4-fld')!;
            expect(groups[0].compareDocumentPosition(train) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
            expect(train.compareDocumentPosition(groups[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
            // the predictors take a full row; the old inline flex sizing is gone
            const pred = screen.getByText('Predictor sensors (≥ 1)').closest('.f4-fld') as HTMLElement;
            expect(pred.className).toBe('f4-fld f4-fld--grow');
            expect(pred.getAttribute('style')).toBeNull();
        });

        it('App.css: one three-column grid, 30 px controls, two columns on a narrow pane', () => {
            expect(cssBlock('.bmw-sets-body')).toMatch(/display:\s*grid/);
            expect(cssBlock('.bmw-sets-body')).toMatch(/grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/);
            // `.bmw-sets-kind` has no box of its own: its fields are cells of that grid.
            expect(cssBlock('.bmw-sets-kind')).toMatch(/display:\s*contents/);
            // wide fields and the Custom panel take a full row
            expect(APP_CSS).toMatch(/\.bmw-sets-body \.f4-fld--grow, \.bmw-sets-body \.rc-custom \{ grid-column: 1 \/ -1; \}/);
            // every control is 30 px high
            for (const control of ['.fg-inspector-input', '.f4-seg', '.bmw-step', '.f4-readout']) {
                expect(cssBlock(`.bmw-sets-body .f4-fld > ${control}`), control).toMatch(/height:\s*30px/);
            }
            expect(APP_CSS).toMatch(/@container \(max-width: 780px\) \{\s*\.bmw-sets-body \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}\s*\.bmw-sets-body \.f4-fld--name \{ grid-column: 1 \/ -1; \}/);
            // the old flex-wrap flow and Clustering's own 4-track grid are gone
            expect(cssBlock('.bmw-sets-body')).not.toMatch(/flex-wrap/);
            expect(APP_CSS).not.toMatch(/bmw-sets-body--clustering/);
        });
    });

    describe('results area', () => {
        it('shows "Not trained yet" for a fully-configured model that has never been trained', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            // ONE board shape: a title, one sentence, a mono line; its action is a text link, never a button.
            const b = screen.getByTestId('results-placeholder');
            expect(b.className).toContain('wbx-msg');
            expect(b.querySelector('.wbx-msg-t')!.textContent).toBe('Not trained yet');
            expect(b.querySelector('.wbx-msg-s')!.textContent).toBe('Train it with Train sensor ↑ — the charts of the trained model appear here.');
            expect(b.querySelector('.wbx-msg-d')!.textContent).toMatch(/^Individual · uses the workspace running condition · ≈ \d+ s$/);
            expect(b.querySelectorAll('button')).toHaveLength(1);
            const link = within(b).getByTestId('board-train-sensor');
            expect(link.className).toBe('tq-inline-link');
            expect(link.textContent).toBe('Train sensor ↑');
            fireEvent.click(link);
            expect(document.activeElement).toBe(trainSensorBtn());
        });

        // `renderResultsStage` checks `buildBlockReason` (the gate) before
        // `!m.lastTrainedAt` BY DESIGN ("incomplete config/gate" outranks "never
        // trained"): while the running condition is not set the user sees "N items
        // to fix", and once the settings modal's write lands the gate clears and
        // "Not trained yet" appears immediately.
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
            // Edits only change the modal's draft until Apply.
            expect(screen.getByTestId('results-rc-locked')).toBeTruthy();
            fireEvent.click(screen.getByTestId('rc-apply'));
            await flush();

            expect(screen.queryByTestId('results-rc-locked')).toBeNull();
            expect(screen.getByTestId('results-placeholder').querySelector('.wbx-msg-t')!.textContent).toBe('Not trained yet');
        });

        it('shows a "marked complete" message once the model is Complete (chart never shows for a Complete model)', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel({ status: true })] } });
            expect(screen.getByTestId('results-placeholder').textContent).toMatch(/Marked complete/);
        });

        // Train sensor never trains an up-to-date Complete model (and is
        // disabled when nothing else needs training) — only the ▾ menu's "<Kind> only" does.
        it('a Complete model with no train record: the board points at the Train sensor ▾ menu (not at the disabled Train sensor), and the link opens it', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel({ status: true })] } });
            const b = screen.getByTestId('results-placeholder');
            expect(b.querySelector('.wbx-msg-t')!.textContent).toBe('Marked complete');
            expect(b.querySelector('.wbx-msg-s')!.textContent).toBe('To see its charts, train it from the Train sensor ▾ menu (“Train the Individual model”). It then needs Mark complete again.');
            expect(within(b).queryByTestId('board-train-sensor')).toBeNull();
            expect(trainSensorBtn().disabled).toBe(true); // why "Train sensor ↑" would lead nowhere
            const link = within(b).getByTestId('board-train-menu');
            expect(link.className).toBe('tq-inline-link');
            expect(link.textContent).toBe('Train sensor ▾');
            expect(screen.queryByTestId('train-sensor-menu')).toBeNull();
            fireEvent.click(link);
            const caret = screen.getByTestId('train-sensor-menu-toggle');
            expect(document.activeElement).toBe(caret);
            expect(caret.getAttribute('aria-expanded')).toBe('true');
            // the row the sentence names is there and usable
            const only = within(screen.getByTestId('train-sensor-menu')).getByTestId('train-menu-only-individual') as HTMLButtonElement;
            expect(only.textContent).toMatch(/^Train the Individual model/);
            expect(only.disabled).toBe(false);
            // a second click leaves the menu open (it never toggles it shut)
            fireEvent.click(link);
            expect(screen.getByTestId('train-sensor-menu')).toBeTruthy();
        });

        it('a Complete model that cannot train at all: no link that would do nothing — the board gives the reason', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel({ status: true, kind: 'relationship', predictorSensors: [] })] } });
            const b = screen.getByTestId('results-placeholder');
            expect(b.querySelector('.wbx-msg-t')!.textContent).toBe('Marked complete');
            expect(b.querySelector('.wbx-msg-s')!.textContent).toBe("It has no charts to show, and it can't be trained yet.");
            expect(b.querySelector('.wbx-msg-d')!.textContent).toBe(screen.getByTestId('build-block-reason').textContent);
            expect(b.querySelector('.wbx-msg-d')!.textContent!.length).toBeGreaterThan(5);
            expect(b.querySelectorAll('button')).toHaveLength(0);
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

        it('no running condition yet: the results area says "Set the running condition first" with a "Running condition ↑" text link that opens the modal (no generic items list, no "Step 1")', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel()], runningConditionNoneConfirmed: false, rcLegacyNotice: null } });
            const lock = screen.getByTestId('results-rc-locked');
            expect(lock.textContent).toMatch(/Set the running condition first/);
            expect(lock.textContent).toBe('Set the running condition firstNothing that follows the workspace running condition can train until it is set — open Running condition ↑');
            expect(lock.textContent).not.toMatch(/Step\s*1/i);
            // the action is a text link to the one place for it — the board has no button of its own
            expect(screen.getByTestId('results-rc-locked-open').className).toBe('tq-inline-link');
            expect(lock.querySelector('.rcx-btn')).toBeNull();
            expect(screen.queryByTestId('results-incomplete')).toBeNull(); // nothing else is wrong with this model
            // The modal auto-opens for an unset workspace; close it, then use the lock's own button.
            fireEvent.click(screen.getByLabelText('Close'));
            expect(screen.queryByRole('dialog', { name: 'Running condition' })).toBeNull();
            fireEvent.click(screen.getByTestId('results-rc-locked-open'));
            expect(screen.getByRole('dialog', { name: 'Running condition' })).toBeTruthy();
        });

        it('no running condition yet AND another item missing: the lock message AND the (non-running-condition) items list both show', async () => {
            const rel = makeModel({ kind: 'relationship', targetSensor: 'TAG1', predictorSensors: [] });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel], runningConditionNoneConfirmed: false, rcLegacyNotice: null } });
            expect(screen.getByTestId('results-rc-locked')).toBeTruthy();
            const list = screen.getByTestId('results-incomplete');
            expect(list.textContent).toMatch(/1 item to fix before training/);
            expect(list.textContent).toMatch(/Add at least 1 predictor/);
            expect(list.textContent).not.toMatch(/running condition first/); // the lock owns that reason
        });

        it('an invalid workspace period locks with "Fix the running condition first" and the same "Running condition ↑" link', async () => {
            const periods = [{ id: 'x', start: '2026-02-01T00:00', end: '2026-01-05T00:00' }];
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel()], runningConditionNoneConfirmed: true, runningConditionTimePeriods: periods } });
            expect(screen.getByTestId('results-rc-locked').textContent).toMatch(/Fix the running condition first/);
            expect(screen.getByTestId('results-rc-locked').textContent).toMatch(/can train until it is fixed — open Running condition ↑$/);
            expect(screen.getByTestId('results-rc-locked-open').textContent).toBe('Running condition ↑');
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

        it('runs compute_clustering_preview for a Clustering model and shows the Clusters chart (no cluster summary card)', async () => {
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
            expect(screen.queryByTestId('cluster-summary')).toBeNull();
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
            expect(screen.getByTestId('results-stale').textContent).toBe('Out of dateSettings or running condition changed — train it again with Train sensor ↑ to see the charts.');
            expect(screen.getByText('Incomplete', { selector: '.model-status-pill' })).toBeTruthy(); // pill reverts, "Trained" is only for fresh
            expect(trainSensorBtn().disabled).toBe(false);
            expect(trainSensorBtn().textContent).toBe('▶ Train sensor · 1 of 1');
            expect(screen.getByTestId('footer-status').textContent).toBe('Settings or running condition changed · train again with Train sensor ↑'); // footer message
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
                cmd === 'compute_sensor_stats' ? Promise.reject(new Error('stats exploded')) : Promise.resolve({}));
            render(<BuildModelWindow />);
            await deliverData();
            await act(async () => {
                fireEvent.click(trainSensorBtn());
                await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
            });
            expect(screen.getByTestId('results-error').textContent).toMatch(/stats exploded/);
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
            // Only the model's silent re-run: the running-condition card counts with
            // `count_period_rows` (one call), never with `compute_sensor_stats`.
            expect(mockInvoke.mock.calls.filter(c => c[0] === 'compute_sensor_stats')).toHaveLength(1);
            await waitFor(() => expect(periodCountCalls()).toHaveLength(1));
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
            const health = screen.getByTestId('next-health-score') as HTMLButtonElement;
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
        it('shows ONE read-only status pill and ONE sentence - no "Save changes" without a draft, NO per-model Train (it moved to the header, customer items 8 + 9) and NO "Open full view" control (health score phase 4: the full-view page is gone)', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            expect(screen.getByText('Incomplete')).toBeTruthy();
            expect(screen.queryByText(/Open full view/)).toBeNull();
            expect(screen.queryByText('Save changes')).toBeNull(); // only while a draft exists
            const foot = screen.getByTestId('wb-footer');
            expect(foot.querySelectorAll('.model-status-pill')).toHaveLength(1);
            expect(foot.querySelectorAll('.f4-pill')).toHaveLength(0);
            expect(foot.querySelectorAll('.f4-foot-reason')).toHaveLength(1);
            expect(screen.queryByText('▶ Train model')).toBeNull();
            expect(screen.queryByText('↻ Re-train')).toBeNull();
            expect(trainSensorBtn().textContent).toBe('▶ Train sensor · 1 of 1');
            // The footer says "not trained yet" and links to the header button (which it focuses).
            expect(screen.getByTestId('footer-status').textContent).toBe('Not trained yet · Train sensor ↑');
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
            // ONE short line: the reason is said once, on the board below; the tooltip keeps the full reason.
            expect(trainSensorWhy()).toBe("Can't train · see below");
            expect(train.title).toBe("Can't train: Individual — Model name is required");
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
            expect(screen.queryByTestId('save-changes')).toBeNull();
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
            const health = screen.getByTestId('next-health-score') as HTMLButtonElement;
            expect(health.disabled).toBe(true);
        });

        it('a Complete model shows "Mark incomplete" on the Health score page, and clicking it un-marks the model (status only; its files and set points stay)', async () => {
            mockInvoke.mockImplementation(healthInvoke);
            const record = { at: '2026-10-04T01:00:00.000Z', outputDir: 'C:/data/workspaces/ws1/output', setPoints: VALID_IND, scoringIntervalSecs: 3600 };
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
            expect((screen.getByTestId('next-health-score') as HTMLButtonElement).disabled).toBe(true);
            expect(screen.queryByTestId('mark-complete')).toBeNull();
            expect(exportCalls()).toHaveLength(0);
        });
    });

    describe('running-condition gate (Feature 4-B, unchanged logic)', () => {
        const REASON = 'Set the running condition first — a condition, or Use all rows';
        const cond = [{ id: 'rcf1', sensor: 'TAG1', operation: 'greater_than', value1: '1200', value2: '' }];
        async function deliverGate(models: any[], extra: Record<string, any> = {}) {
            let disk: any = { id: 'ws1', failureGroupState: { groups: [makeGroup()], models, runningConditionNoneConfirmed: false, rcLegacyNotice: null, ...extra } };
            mockUpdateWorkspaceData.mockImplementation(async (_id: string, patch: (s: any) => any) => { disk = patch(disk); return disk; });
            await deliverData({ failureGroupState: disk.failureGroupState });
        }
        // The header's Train sensor is the control the running-condition gate blocks.
        const trainButton = trainSensorBtn;

        it('Train sensor is disabled with the "set the running condition" reason while nothing is configured', async () => {
            render(<BuildModelWindow />);
            await deliverGate([makeModel()]);
            const train = trainButton();
            expect(train.disabled).toBe(true);
            expect(TRAIN_NEEDS_RUNNING_CONDITION).toBe('Set the running condition first.');
            expect(train.title).toBe('Set the running condition first.');
            expect(trainSensorWhy()).toBe('Set the running condition first.');
            expect(screen.getByTestId('build-block-reason').textContent).toBe(REASON);
        });

        it('Save changes stays allowed while Train is blocked by the running condition', async () => {
            render(<BuildModelWindow />);
            await deliverGate([makeModel()]);
            openSettings();
            fireEvent.change(screen.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Renamed' } });
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
            // Still gated until Apply: a draft never leaks into the gate.
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

        it('the gate reason is the kind tab\'s DOT tooltip (Needs condition / Legacy · all data) — no badge pill on the tab', async () => {
            render(<BuildModelWindow />);
            await deliverGate([makeModel({ id: 'i1' })]);
            expect(screen.queryByTestId('condition-badge-i1')).toBeNull();
            expect(screen.getByRole('tab').querySelector('.f4-pill')).toBeNull();
            expect(screen.getByTestId('tab-status-i1').getAttribute('title')).toBe('Needs condition');
            expect(screen.getByTestId('tab-status-i1').className).toContain('f4-sdot--bad');
            expect(screen.getByRole('tab').getAttribute('title')).toBe('Individual · Needs condition');
            cleanup();
            render(<BuildModelWindow />);
            await deliverGate([makeModel({ id: 'i1', status: true })]);
            expect(screen.queryByTestId('condition-badge-i1')).toBeNull();
            expect(screen.getByTestId('tab-status-i1').getAttribute('title')).toBe('Legacy · all data');
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

        it('has no "N models can\'t be built yet" line any more — the Not-set card and each model\'s footer say it', async () => {
            render(<BuildModelWindow />);
            await deliverTracked({ groups: [makeGroup()], models: [makeModel(), makeModel({ id: 'm2', targetSensor: 'TAG2' })], runningConditionNoneConfirmed: false, runningConditionFilters: [], rcLegacyNotice: null });
            expect(screen.queryByTestId('rc-blocked-summary')).toBeNull();
            expect(document.body.textContent).not.toMatch(/can't be built yet/);
            expect(screen.getByTestId('rc-card').getAttribute('data-state')).toBe('unset');
            expect(screen.getByTestId('build-block-reason').textContent).toMatch(/Set the running condition first/);
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
            const notice = screen.getByTestId('category-normalisation-notice');
            expect(mockUpdateWorkspaceData).toHaveBeenCalledTimes(1);
            // the kinds are named as on the tabs: "Relation model", never "Relationship"
            expect(notice.textContent).toContain('taken from its Individual model');
            expect(notice.textContent).toMatch(/Changed: Relation model /);
            expect(notice.textContent).not.toMatch(/Relationship/);
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

    // Multi-project isolation. This window is a singleton that
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
            // The write only starts at Apply (draft edits never write).
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

        // `TimePeriodsEditor`'s date
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

            // With the explicit Apply step the half-typed date's
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
                const endField = screen.getByLabelText('P1 end') as HTMLInputElement;
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
                expect((screen.getByLabelText('P1 end') as HTMLInputElement).value).toBe('2024-02-15T12:00');
            });

            it('(b) closing via X right after typing (no blur) commits the typed date into the draft, so the discard prompt appears instead of silently dropping it', async () => {
                render(<BuildModelWindow />);
                await deliverWithPeriod();
                fireEvent.click(screen.getByTestId('rc-card-open'));
                const endField = screen.getByLabelText('P1 end') as HTMLInputElement;
                endField.focus();
                fireEvent.change(endField, { target: { value: '2024-02-15T12:00' } });

                fireEvent.click(screen.getByLabelText('Close'));
                expect(screen.getByTestId('rc-discard-prompt')).toBeTruthy();
                expect(screen.getByRole('dialog', { name: 'Running condition' })).toBeTruthy();
                // "Keep editing" returns to the draft with the typed value intact.
                fireEvent.click(screen.getByTestId('rc-discard-keep'));
                expect((screen.getByLabelText('P1 end') as HTMLInputElement).value).toBe('2024-02-15T12:00');
                expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
            });

            it('(c) a native whole-window close with an UNAPPLIED draft just closes — nothing is pending, nothing is written', async () => {
                render(<BuildModelWindow />);
                await deliverWithPeriod();
                fireEvent.click(screen.getByTestId('rc-card-open'));
                const endField = screen.getByLabelText('P1 end') as HTMLInputElement;
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
            fireEvent.click(screen.getByTestId('next-health-score'));
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

// Custom running-condition editor, Relationship X-axis
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
        // The workspace SCORING periods are copied too (seedCustomFromWorkspace).
        expect(screen.getByTestId('pm-seed-note').textContent).toMatch(/Copied 1 train period, 1 scoring period and 1 condition from Workspace/);
        const ownValue = () => within(screen.getByTestId('custom-condition')).getByLabelText('Value') as HTMLInputElement;
        expect(ownValue().value).toBe('5');
        expect(within(screen.getByTestId('custom-test-periods')).getByTestId('test-row-1')).toBeTruthy();

        fireEvent.change(ownValue(), { target: { value: '9' } });
        await act(async () => {
            fireEvent.click(screen.getByText('Save changes'));
            await Promise.resolve(); await Promise.resolve();
        });
        const state = await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value;
        const saved = state.failureGroupState.models[0];
        expect(saved.runningConditionMode).toBe('custom');
        expect(saved.customRunningConditionFilters[0].value1).toBe('9');
        expect(saved.filterTimePeriods[0].start).toBe('2026-01-01T00:00');
        // the copied scoring period is saved as the model's own: a fresh id, the same range, and nothing else
        expect(saved.customTestPeriods).toEqual([{ id: expect.any(String), start: ONE_TEST[0].start, end: ONE_TEST[0].end }]);
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
        expect((within(screen.getByTestId('custom-condition')).getByLabelText('Value') as HTMLInputElement).value).toBe('5');
        expect(screen.queryByTestId('pm-seed-note')).toBeNull();
    });

    it('"Use all rows", the AND/OR pill, and the collapsed summary line ("Custom · 2 conditions · 0 train · 0 scoring")', async () => {
        render(<BuildModelWindow />);
        // no workspace conditions/periods (train or scoring) set — nothing to seed
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel()], runningConditionTimePeriods: [], runningConditionTestPeriods: [] } });
        openSettings();
        fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
        expect(screen.queryByTestId('pm-seed-note')).toBeNull();
        const own = () => within(screen.getByTestId('custom-condition'));

        fireEvent.click(own().getByTestId('rc-add-condition'));
        fireEvent.click(own().getByTestId('rc-add-condition'));
        expect(own().getByTestId('rc-combine').textContent).toBe('AND');
        fireEvent.click(own().getByTestId('rc-combine'));
        expect(own().getByTestId('rc-combine').textContent).toBe('OR');

        // Collapse "Model settings" and check the summary line, then open it again.
        fireEvent.click(screen.getByText('Model settings', { selector: 'b' }));
        expect(screen.getByText(/Custom · 2 conditions · 0 train · 0 scoring/)).toBeTruthy();
        fireEvent.click(screen.getByText('Model settings', { selector: 'b' }));

        fireEvent.click(own().getByTestId('rc-mode-none'));
        expect(own().getByTestId('rc-mode-none').getAttribute('aria-checked')).toBe('true');
        expect(own().getByTestId('rc-none-note').textContent).toContain('Your saved conditions are kept but not applied.');
        fireEvent.click(screen.getByText('Model settings', { selector: 'b' }));
        expect(screen.getByText(/Custom · all rows · 0 train · 0 scoring/)).toBeTruthy();
    });

    // Workbench redesign §5 "Custom running condition": a reason about the model's OWN running
    // condition says where to fix it — and, once Model settings is open, points at the field.
    it('own invalid train period: "Fix P1\'s end above" while Model settings is open, "Own running condition: P1 ends before it starts. Fix it in Model settings" once it is closed', async () => {
        const own = makeModel({
            runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true,
            filterTimePeriods: [{ id: 'o1', start: '2026-03-01T00:00', end: '2026-02-01T00:00' }],
        });
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [own] } });
        // the thing to fix is INSIDE Model settings: the section opened by itself
        expect(screen.getByTestId('custom-rc-editor')).toBeTruthy();
        const reason = () => screen.getByTestId('build-block-reason').textContent;
        expect(reason()).toBe("Fix P1's end above");
        expect(within(screen.getByTestId('custom-periods')).getByTestId('period-invalid-1').textContent).toBe('P1 ends before it starts — pick an end after 2026/03/01 00:00');
        // the same words on the board's list of things to fix
        expect(within(screen.getByTestId('results-incomplete')).getByText("Fix P1's end above")).toBeTruthy();

        fireEvent.click(screen.getByText('Model settings', { selector: 'b' })); // close it
        expect(screen.queryByTestId('custom-rc-editor')).toBeNull();
        expect(reason()).toBe('Own running condition: P1 ends before it starts. Fix it in Model settings');
        expect(trainSensorBtn().disabled).toBe(true);
        expect(document.body.textContent).not.toMatch(/Period 1/);
    });

    it('own list without a train period / without a condition: "Add a train period above" and "Set a condition above, or choose Use all rows"', async () => {
        const noTrain = makeModel({ runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true, filterTimePeriods: [] });
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [noTrain] } });
        const reason = () => screen.getByTestId('build-block-reason').textContent;
        expect(reason()).toBe('Add a train period above');
        expect(within(screen.getByTestId('custom-periods')).getByTestId('periods-empty').textContent).toBe('No train period yet — add at least one');
        fireEvent.click(screen.getByText('Model settings', { selector: 'b' }));
        expect(reason()).toBe('Own running condition: no train period. Fix it in Model settings');
        fireEvent.click(screen.getByText('Model settings', { selector: 'b' }));

        // add a train period -> the next thing missing is the condition
        fireEvent.click(within(screen.getByTestId('custom-periods')).getByTestId('period-add'));
        fireEvent.click(within(screen.getByTestId('custom-condition')).getByTestId('rc-mode-condition'));
        expect(reason()).toBe('Set a condition above, or choose Use all rows');
        expect(within(screen.getByTestId('custom-condition')).getByTestId('rc-unset-warning')).toBeTruthy();
        fireEvent.click(screen.getByText('Model settings', { selector: 'b' }));
        expect(reason()).toBe('Own running condition: not set. Fix it in Model settings');
    });

    it('a Workspace-mode model keeps the plain gate reason (the fix is in the workspace settings, not "above")', async () => {
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: {
            groups: [makeGroup()], models: [makeModel()],
            runningConditionTimePeriods: [{ id: 'p', start: '2026-03-01T00:00', end: '2026-02-01T00:00' }],
        } });
        expect(screen.getByTestId('build-block-reason').textContent).toBe('P1 ends before it starts.');
    });

    // Workbench redesign §5: the model's own running condition is the SAME panel as the
    // workspace settings (timeline, one-line rows, caption), with its own period counts.
    it("the model's own panel: timeline + rows + footnote, its scoring counts asked only while it is on screen, and the highlights re-read when it is shown", async () => {
        const ownCond = { id: 'c1', sensor: 'TAG2', operation: 'greater_than', value1: '7', value2: '' };
        const ownTrain = [{ id: 'o1', start: '2026-02-01T00:00', end: '2026-02-28T23:59' }];
        const ownScore = [{ id: 'o2', start: '2026-03-01T00:00', end: '2026-03-10T00:00' }];
        const own = makeModel({
            runningConditionMode: 'custom', customRunningConditionFilters: [ownCond],
            filterTimePeriods: ownTrain, customTestPeriods: ownScore,
        });
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [own] } });
        await flush();
        // Model settings is closed (nothing to fix). Two counts, ONE each: the running-condition
        // card (the workspace's train periods) and this model's own TRAIN periods — its running
        // days feed the amber "below the recommended train time" note on the charts. No scoring
        // count: only the open panel prints one.
        expect(screen.queryByTestId('custom-rc-editor')).toBeNull();
        await waitFor(() => expect(periodCountCalls()).toHaveLength(2));
        await act(async () => { await new Promise(r => setTimeout(r, 400)); });
        expect(periodCountCalls()).toHaveLength(2);
        const cardCall = periodCountCalls().find(c => c.filter === null)!;
        const trainCall = periodCountCalls().find(c => c.filter !== null)!;
        expect(cardCall.periods).toEqual(ALL_TIME_TRAIN.map(p => ({ start: p.start || null, end: p.end || null })));
        const loads = mockLoadWorkspaceData.mock.calls.length;

        openSettings();
        // opening the panel adds ONE call — the scoring periods; the train side is remembered
        await waitFor(() => expect(periodCountCalls()).toHaveLength(3));
        const scoreCall = periodCountCalls()[2];
        // the MODEL's own lists and condition — never the workspace's
        expect(trainCall.periods).toEqual([{ start: '2026-02-01T00:00', end: '2026-02-28T23:59' }]);
        expect(scoreCall.periods).toEqual([{ start: '2026-03-01T00:00', end: '2026-03-10T00:00' }]);
        expect(scoreCall.filter).toEqual(trainCall.filter);
        expect(trainCall.filter).toEqual({ value_filters: [{ sensor: 'TAG2', operation: 'greater_than', value1: 7, value2: null }], combine: 'and' });
        expect(Object.keys(trainCall).sort()).toEqual(['expected_generation', 'filter', 'periods']);
        // ...and the Dashboard highlights are read again for its train-overlap line (one read)
        expect(mockLoadWorkspaceData.mock.calls.length).toBe(loads + 1);

        const editor = within(screen.getByTestId('custom-rc-editor'));
        expect([...editor.getByTestId('custom-rc-panel').children].map(c => c.getAttribute('data-testid')))
            .toEqual(['rc-timeline', 'custom-periods', 'custom-test-periods', 'custom-condition', 'custom-rc-footnote']);
        await waitFor(() => expect(editor.getByTestId('rc-caption-rows').textContent).toBe('800 of 5,000 rows (16%) used for training'));
        expect(editor.getByTestId('period-days-1').textContent).toBe('28 d · 20 d running');
        expect(editor.getByTestId('test-days-1').textContent).toBe('9 d · 20 d running');
        expect(editor.getByTestId('rc-timeline')).toBeTruthy(); // (no lanes here: this fixture has no dataset time range)
        expect(editor.getByTestId('custom-rc-footnote').textContent).toBe('Only this model · the workspace default is untouched · saved with Save changes');

        // Collapsing the section stops the counting; nothing more is asked while it is closed.
        fireEvent.click(screen.getByText('Model settings', { selector: 'b' }));
        await act(async () => { await new Promise(r => setTimeout(r, 450)); });
        expect(periodCountCalls()).toHaveLength(3);
    });

    // Model settings — and with them the Custom panel — are
    // drawn on the Model fit page only. `customPanelOpen` had no page term, so on the Health score
    // page the panel's counts (`count_period_rows`, a full-dataset scan) kept running and the
    // highlights were re-read from the workspace file for a panel that is not on screen.
    it('on the Health score page nothing is counted or re-read for the Custom panel, even with Model settings left open', async () => {
        mockInvoke.mockImplementation(defaultInvoke);
        const own = withTrained(makeModel({
            runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true,
            filterTimePeriods: [{ id: 'o1', start: '2026-02-01T00:00', end: '2026-02-28T23:59' }],
            customTestPeriods: [{ id: 'o2', start: '2026-03-01T00:00', end: '2026-03-10T00:00' }],
        }));
        statefulUpdateMock([own]);
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [own] } });
        await waitFor(() => expect(screen.getByTestId('results-chart')).toBeTruthy());
        openSettings();
        expect(screen.getByTestId('custom-rc-editor')).toBeTruthy();
        // card + the model's own train and scoring periods
        await waitFor(() => expect(periodCountCalls()).toHaveLength(3));

        await waitFor(() => expect((screen.getByTestId('next-health-score') as HTMLButtonElement).disabled).toBe(false));
        fireEvent.click(screen.getByTestId('next-health-score'));
        await waitFor(() => expect(screen.getByTestId('footer-back-to-fit')).toBeTruthy());
        expect(screen.queryByTestId('custom-rc-editor')).toBeNull(); // the panel is not on this page
        const counts = periodCountCalls().length;
        const loads = mockLoadWorkspaceData.mock.calls.length;
        // an edit of the set points re-renders the window several times — and a change of the
        // highlights' trigger would re-read the file
        await act(async () => { await new Promise(r => setTimeout(r, 450)); });
        expect(periodCountCalls()).toHaveLength(counts);
        expect(mockLoadWorkspaceData.mock.calls.length).toBe(loads);

        // back on Model fit (settings still open): the panel is on screen again, so it counts
        // again (the answers of a closed panel are dropped) and re-reads the highlights once
        fireEvent.click(screen.getByTestId('footer-back-to-fit'));
        await waitFor(() => expect(screen.getByTestId('custom-rc-editor')).toBeTruthy());
        await waitFor(() => expect(periodCountCalls()).toHaveLength(counts + 2));
        expect(mockLoadWorkspaceData.mock.calls.length).toBe(loads + 1);
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

    // The optional criteria sensor must be clearable.
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

    // A Clustering model has at most 5 clusters (the stepper went to 8).
    it('the cluster-count stepper stops at 5: "More clusters" is disabled there with "At most 5 clusters"; "Fewer clusters" still works', async () => {
        const clu = makeModel({
            id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2', criteriaSensor: 'TAG3',
            numClusters: 4, clusterRanges: [{ min: 0, max: 2 }, { min: 2, max: 5 }, { min: 5, max: 7 }, { min: 7, max: 10 }],
        });
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [clu] } });
        statefulUpdateMock([clu]);
        openSettings();
        await flush();
        const more = () => screen.getByRole('button', { name: 'More clusters' }) as HTMLButtonElement;
        const fewer = () => screen.getByRole('button', { name: 'Fewer clusters' }) as HTMLButtonElement;
        const count = () => fewer().nextElementSibling!.textContent;
        expect(count()).toBe('4');
        expect(more().disabled).toBe(false);
        expect(more().title).toBe('');
        fireEvent.click(more());
        await flush();
        expect(count()).toBe('5');
        expect(more().disabled).toBe(true);
        expect(more().title).toBe('At most 5 clusters');
        fireEvent.click(more()); // a click that gets through anyway changes nothing
        await flush();
        expect(count()).toBe('5');
        fireEvent.click(fewer());
        await flush();
        expect(count()).toBe('4');
        expect(more().disabled).toBe(false);
    });

    it('a model saved earlier with MORE than 5 clusters opens unchanged (no clamp: that would change its fingerprint and set it Incomplete) — it only cannot be raised; "Fewer clusters" lowers it', async () => {
        const six = Array.from({ length: 6 }, (_, i) => ({ min: i * 10, max: (i + 1) * 10 }));
        const clu = withTrained(makeModel({
            id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2', criteriaSensor: 'TAG3',
            numClusters: 6, clusterRanges: six, status: true,
        }));
        statefulUpdateMock([clu]);
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [clu] } });
        await flush();
        await act(async () => { await new Promise(r => setTimeout(r, 50)); });
        // opened: still 6, still Complete and up to date, no draft, and nothing changed it on disk
        expect(screen.getByTestId('footer-pill').textContent).toBe('Complete');
        expect(screen.queryByTestId('save-changes')).toBeNull();
        for (const r of mockUpdateWorkspaceData.mock.results) {
            const m = (await r.value).failureGroupState.models[0];
            expect(m).toMatchObject({ numClusters: 6, clusterRanges: six, status: true, trainedFingerprint: clu.trainedFingerprint });
        }
        // it trains / previews with its own 6
        const fit = mockInvoke.mock.calls.filter(c => c[0] === 'compute_clustering_preview').pop();
        expect((fit![1] as any).n_clusters).toBe(6);
        openSettings();
        await flush();
        const more = () => screen.getByRole('button', { name: 'More clusters' }) as HTMLButtonElement;
        const fewer = () => screen.getByRole('button', { name: 'Fewer clusters' }) as HTMLButtonElement;
        expect(fewer().nextElementSibling!.textContent).toBe('6');
        expect(more().disabled).toBe(true);
        expect(more().title).toBe('At most 5 clusters');
        fireEvent.click(more());
        await flush();
        expect(fewer().nextElementSibling!.textContent).toBe('6'); // never lowered by "+", never raised
        expect(screen.queryByTestId('save-changes')).toBeNull();
        fireEvent.click(fewer());
        await flush();
        expect(fewer().nextElementSibling!.textContent).toBe('5');
        expect(more().disabled).toBe(true); // 5 is the most it can be set to
        expect(screen.getByTestId('save-changes')).toBeTruthy();
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

    // A NEW Clustering model starts with 1 cluster and no ranges (Dashboard's
    // default), so it has nothing to fix. Picking a criteria sensor whose stats are still in
    // flight used to fix the range COUNT over a 0-100 placeholder and never re-divide once the
    // real [min, max] arrived. That matters for 2+ clusters (the ranges split the rows); for
    // 1 cluster Rust ignores `cluster_ranges`, so the re-divide only keeps the saved range tidy.
    it('a new default model (1 cluster, no ranges) has nothing to fix; picking a criteria sensor divides over its REAL range once stats land, and the stepper still raises the count', async () => {
        let resolveStats: (v: unknown) => void = () => {};
        mockInvoke.mockImplementation((cmd: string) => {
            if (cmd === 'compute_sensor_stats') return new Promise(res => { resolveStats = res; });
            return Promise.resolve({});
        });
        const clu = makeModel({ id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2', criteriaSensor: '', numClusters: 1, clusterRanges: [] });
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [clu] } });
        statefulUpdateMock([clu]);
        openSettings();
        expect(screen.queryByTestId('settings-to-fix')).toBeNull();
        expect(trainSensorBtn().disabled).toBe(false);

        const criteria = () => sensorPickerModalProps.filter(p => p.noun === 'criteria sensor').pop();
        await act(async () => { criteria().onSelect('TAG3'); await Promise.resolve(); });
        await act(async () => {
            resolveStats({ mean: 700, sd: 10, min: 500, max: 900, count: 100, lower1: 690, upper1: 710, lower3: 670, upper3: 730 });
            await Promise.resolve(); await Promise.resolve();
        });
        await flush();
        fireEvent.click(screen.getByRole('button', { name: 'More clusters' }));
        await flush();
        expect(pill(0)).toBe('#1: 500 – ');
        expect(bound(0).value).toBe('700');
        expect(pill(1)).toBe('#2: 700 – 900');
        await act(async () => { fireEvent.click(screen.getByText('Save changes')); await Promise.resolve(); await Promise.resolve(); });
        const m = (await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value).failureGroupState.models[0];
        expect(m).toMatchObject({ criteriaSensor: 'TAG3', numClusters: 2, clusterRanges: [{ min: 500, max: 700 }, { min: 700, max: 900 }] });
    });

    it('a new default model that picks a criteria sensor and keeps 1 cluster saves ONE range over the real [min, max], not 0-100', async () => {
        let resolveStats: (v: unknown) => void = () => {};
        mockInvoke.mockImplementation((cmd: string) => {
            if (cmd === 'compute_sensor_stats') return new Promise(res => { resolveStats = res; });
            return Promise.resolve({});
        });
        const clu = makeModel({ id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2', criteriaSensor: '', numClusters: 1, clusterRanges: [] });
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [clu] } });
        statefulUpdateMock([clu]);
        openSettings();
        const criteria = () => sensorPickerModalProps.filter(p => p.noun === 'criteria sensor').pop();
        await act(async () => { criteria().onSelect('TAG3'); await Promise.resolve(); });
        await act(async () => {
            resolveStats({ mean: 700, sd: 10, min: 500, max: 900, count: 100, lower1: 690, upper1: 710, lower3: 670, upper3: 730 });
            await Promise.resolve(); await Promise.resolve();
        });
        await flush();
        await act(async () => { fireEvent.click(screen.getByText('Save changes')); await Promise.resolve(); await Promise.resolve(); });
        const m = (await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value).failureGroupState.models[0];
        expect(m).toMatchObject({ criteriaSensor: 'TAG3', numClusters: 1, clusterRanges: [{ min: 500, max: 900 }] });
    });

    // Switching the criteria sensor A -> B used to divide B's ranges over A's
    // still-loaded [min, max] (the stats reset runs in an effect, after the render that switched)
    // and lock that result, so B never got its own real range.
    it("switching the criteria sensor A -> B divides over B's real range once B's stats land, never A's", async () => {
        let resolveB: (v: unknown) => void = () => {};
        mockInvoke.mockImplementation((cmd: string, args?: any) => {
            if (cmd === 'compute_sensor_stats' && args?.sensor === 'TAG4') return new Promise(res => { resolveB = res; });
            if (cmd === 'compute_sensor_stats') return Promise.resolve({ mean: 5, sd: 1, min: 0, max: 10, count: 100, lower1: 4, upper1: 6, lower3: 2, upper3: 8 });
            return Promise.resolve({});
        });
        const clu = makeModel({
            id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2', criteriaSensor: 'TAG3',
            numClusters: 2, clusterRanges: [{ min: 0, max: 5 }, { min: 5, max: 10 }],
        });
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [clu] } });
        statefulUpdateMock([clu]);
        openSettings();
        await flush(); // A's (TAG3) stats [0, 10] arrive
        expect(pill(1)).toBe('#2: 5 – 10');

        const criteria = () => sensorPickerModalProps.filter(p => p.noun === 'criteria sensor').pop();
        await act(async () => { criteria().onSelect('TAG4'); await Promise.resolve(); });
        await flush();
        expect(screen.getByTestId('cluster-slider-loading')).toBeTruthy(); // B's stats not here yet — A's are not shown as B's
        await act(async () => {
            resolveB({ mean: 700, sd: 10, min: 500, max: 900, count: 100, lower1: 690, upper1: 710, lower3: 670, upper3: 730 });
            await Promise.resolve(); await Promise.resolve();
        });
        await flush();
        expect(pill(0)).toBe('#1: 500 – ');
        expect(bound(0).value).toBe('700');
        expect(pill(1)).toBe('#2: 700 – 900');
        await act(async () => { fireEvent.click(screen.getByText('Save changes')); await Promise.resolve(); await Promise.resolve(); });
        const m = (await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value).failureGroupState.models[0];
        expect(m).toMatchObject({ criteriaSensor: 'TAG4', numClusters: 2, clusterRanges: [{ min: 500, max: 700 }, { min: 700, max: 900 }] });
    });

    // While a division is pending ("Loading…"), Save and Train
    // are blocked. Saving the placeholder ranges used to make them the saved key, so the real
    // division never happened and a 2+-cluster model on a 500-900 sensor trained empty clusters.
    describe('Save / Train are blocked while a cluster division waits for the criteria stats', () => {
        const STATS_500_900 = { mean: 700, sd: 10, min: 500, max: 900, count: 100, lower1: 690, upper1: 710, lower3: 670, upper3: 730 };
        const saveBtn = () => screen.getByText('Save changes').closest('button') as HTMLButtonElement;
        const lastSaved = async () => (await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value).failureGroupState.models[0];

        it('+ on a saved 2-cluster model while its stats are pending: Save/Train disabled, then 3 ranges over the real [min, max] are saved', async () => {
            let resolveStats: (v: unknown) => void = () => {};
            mockInvoke.mockImplementation((cmd: string) => {
                if (cmd === 'compute_sensor_stats') return new Promise(res => { resolveStats = res; });
                return Promise.resolve({});
            });
            const clu = makeModel({
                id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2', criteriaSensor: 'TAG3',
                numClusters: 2, clusterRanges: [{ min: 500, max: 600 }, { min: 600, max: 900 }],
            });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [clu] } });
            statefulUpdateMock([clu]);
            openSettings();
            await flush();
            // Unchanged saved key: never blocked, even while the stats are still loading.
            expect(screen.getByTestId('cluster-slider-loading')).toBeTruthy();
            expect(screen.queryByText('Save changes')).toBeNull(); // no draft yet: nothing to save
            expect(trainSensorBtn().disabled).toBe(false);

            fireEvent.click(screen.getByRole('button', { name: 'More clusters' }));
            await flush();
            expect(screen.getByTestId('cluster-slider-loading')).toBeTruthy();
            expect(saveBtn().disabled).toBe(true);
            expect(trainSensorBtn().disabled).toBe(true);
            const writesBefore = mockUpdateWorkspaceData.mock.calls.length;
            fireEvent.click(saveBtn());
            await flush();
            expect(mockUpdateWorkspaceData.mock.calls.length).toBe(writesBefore); // nothing persisted

            await act(async () => { resolveStats(STATS_500_900); await Promise.resolve(); await Promise.resolve(); });
            await flush();
            expect(saveBtn().disabled).toBe(false);
            expect(trainSensorBtn().disabled).toBe(false);
            expect(pill(0)).toBe('#1: 500 – ');
            expect(pill(2)).toMatch(/^#3: .* – 900$/);
            await act(async () => { fireEvent.click(saveBtn()); await Promise.resolve(); await Promise.resolve(); });
            const m = await lastSaved();
            expect(m.criteriaSensor).toBe('TAG3');
            expect(m.numClusters).toBe(3);
            const r = m.clusterRanges as { min: number; max: number }[];
            expect(r).toHaveLength(3);
            expect(r[0].min).toBe(500);
            expect(r[2].max).toBe(900);
            expect(r[0].max).toBeCloseTo(500 + 400 / 3, 9);
            expect(r[1].max).toBeCloseTo(500 + 800 / 3, 9);
        });

        it('switching criteria A -> B and pressing Save before B\'s stats land is blocked; once they land, Save writes ranges over B\'s range', async () => {
            let resolveB: (v: unknown) => void = () => {};
            mockInvoke.mockImplementation((cmd: string, args?: any) => {
                if (cmd === 'compute_sensor_stats' && args?.sensor === 'TAG4') return new Promise(res => { resolveB = res; });
                if (cmd === 'compute_sensor_stats') return Promise.resolve({ mean: 5, sd: 1, min: 0, max: 10, count: 100, lower1: 4, upper1: 6, lower3: 2, upper3: 8 });
                return Promise.resolve({});
            });
            const clu = makeModel({
                id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2', criteriaSensor: 'TAG3',
                numClusters: 2, clusterRanges: [{ min: 0, max: 5 }, { min: 5, max: 10 }],
            });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [clu] } });
            statefulUpdateMock([clu]);
            openSettings();
            await flush(); // A's (TAG3) stats [0, 10] arrive

            const criteria = () => sensorPickerModalProps.filter(p => p.noun === 'criteria sensor').pop();
            await act(async () => { criteria().onSelect('TAG4'); await Promise.resolve(); });
            await flush();
            expect(screen.getByTestId('cluster-slider-loading')).toBeTruthy();
            expect(saveBtn().disabled).toBe(true);
            expect(trainSensorBtn().disabled).toBe(true);
            const writesBefore = mockUpdateWorkspaceData.mock.calls.length;
            fireEvent.click(saveBtn());
            await flush();
            expect(mockUpdateWorkspaceData.mock.calls.length).toBe(writesBefore);

            await act(async () => { resolveB(STATS_500_900); await Promise.resolve(); await Promise.resolve(); });
            await flush();
            expect(saveBtn().disabled).toBe(false);
            expect(trainSensorBtn().disabled).toBe(false);
            await act(async () => { fireEvent.click(saveBtn()); await Promise.resolve(); await Promise.resolve(); });
            expect(await lastSaved()).toMatchObject({ criteriaSensor: 'TAG4', numClusters: 2, clusterRanges: [{ min: 500, max: 700 }, { min: 700, max: 900 }] });
        });

        it('a 1-cluster model picking a criteria sensor is NOT blocked while its stats are pending', async () => {
            mockInvoke.mockImplementation((cmd: string) => {
                if (cmd === 'compute_sensor_stats') return new Promise(() => {}); // never lands
                return Promise.resolve({});
            });
            const clu = makeModel({ id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2', criteriaSensor: '', numClusters: 1, clusterRanges: [] });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [clu] } });
            statefulUpdateMock([clu]);
            openSettings();
            const criteria = () => sensorPickerModalProps.filter(p => p.noun === 'criteria sensor').pop();
            await act(async () => { criteria().onSelect('TAG3'); await Promise.resolve(); });
            await flush();
            expect(screen.queryByTestId('settings-to-fix')).toBeNull();
            expect(saveBtn().disabled).toBe(false);
            expect(trainSensorBtn().disabled).toBe(false);
        });
    });

    it('an already-configured model whose criteria/count did not change keeps its saved (non-equal) ranges when stats arrive', async () => {
        const clu = makeModel({
            id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2', criteriaSensor: 'TAG3',
            numClusters: 2, clusterRanges: [{ min: 0, max: 2 }, { min: 2, max: 10 }],
        });
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [clu] } });
        openSettings();
        await flush(); // stats [0, 10] arrive
        expect(bound(0).value).toBe('2');
        expect(screen.queryByTestId('save-changes')).toBeNull();
    });

    // `duplicateWorkspace` keeps model ids. The auto-divide memory
    // and the criteria stats are keyed by model id, so a window re-pointed from W to its copy W′
    // used to read W's last division ("TAG3::3") as c1's own, see W′'s saved "TAG3::2" as a
    // change, and re-divide W′'s saved uneven ranges into an unprompted "edited" draft.
    it('re-pointed at a duplicated workspace (same model id): its saved uneven ranges are kept, its own stats are fetched, and no "edited" draft appears', async () => {
        let current = 'ws1';
        mockInvoke.mockImplementation((cmd: string, args?: any) => (cmd === 'compute_sensor_stats' && args?.sensor === 'TAG3'
            ? Promise.resolve(current === 'ws1'
                ? { mean: 5, sd: 1, min: 0, max: 10, count: 100, lower1: 4, upper1: 6, lower3: 2, upper3: 8 }
                : { mean: 700, sd: 10, min: 500, max: 900, count: 100, lower1: 690, upper1: 710, lower3: 670, upper3: 730 })
            : defaultInvoke(cmd, args)));
        const criteriaStatsCalls = () => mockInvoke.mock.calls.filter(c => c[0] === 'compute_sensor_stats' && (c[1] as any)?.sensor === 'TAG3').length;
        const clu = makeModel({
            id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2', criteriaSensor: 'TAG3',
            numClusters: 2, clusterRanges: [{ min: 0, max: 5 }, { min: 5, max: 10 }],
        });
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [clu] } });
        openSettings();
        await flush(); // W's stats [0, 10]
        // W: the user raises the count to 3 -> divided over [0, 10] (and remembered for c1).
        fireEvent.click(screen.getByRole('button', { name: 'More clusters' }));
        await flush();
        expect(pill(2)).toMatch(/^#3: .* – 10$/);
        expect(screen.getByTestId('save-changes')).toBeTruthy();

        // W′ (a duplicate): the SAME model id, saved with 2 clusters and an uneven split of its own data.
        const copy = { ...clu, clusterRanges: [{ min: 500, max: 600 }, { min: 600, max: 900 }] };
        current = 'ws2';
        const before = criteriaStatsCalls();
        await deliverData({ id: 'ws2', failureGroupState: { groups: [makeGroup()], models: [copy] } }, { workspaceId: 'ws2' });
        await flush();
        openSettings();
        await flush(); // W′'s stats [500, 900] arrive
        expect(criteriaStatsCalls()).toBeGreaterThan(before); // never W's cached stats
        expect(screen.getByTestId('cluster-slider')).toBeTruthy();
        expect(pill(0)).toBe('#1: 500 – ');
        expect(bound(0).value).toBe('600'); // the saved uneven split, not an equal 700
        expect(pill(1)).toBe('#2: 600 – 900');
        expect(screen.queryByTestId('cluster-pill-2')).toBeNull();
        expect(screen.queryByTestId('save-changes')).toBeNull();
    });

    // Exact boundaries must be typeable — dragging
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
            expect(screen.queryByTestId('save-changes')).toBeNull(); // no draft was made

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
            expect(screen.queryByTestId('save-changes')).toBeNull();
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
            expect(screen.queryByTestId('save-changes')).toBeNull();
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
            expect(screen.queryByTestId('save-changes')).toBeNull(); // c2 has no draft
            await select('tag1');
            expect(bound(0).value).toBe('3.5');
            expect(screen.getByTestId('save-changes')).toBeTruthy();
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
            expect(screen.queryByTestId('save-changes')).toBeNull();
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

    it('App.css gives the Custom running-condition panel its own full-width row of the Model settings grid', () => {
        expect(() => cssBlock('.rc-scroll')).toThrow(); // the scroll box of the old compact editor is gone
        expect(APP_CSS).toMatch(/\.bmw-sets-body \.rc-custom \{ grid-column: 1 \/ -1; \}/);
        expect(cssBlock('.rc-custom')).not.toMatch(/flex:/);
    });
});

// Running Condition Filter modal: opening it and closing it again — via ANY
// close path, with ZERO user edits — must not lose the already-saved workspace
// running condition (periods + value conditions + AND/OR). This block seeds a
// FULLY CONFIGURED workspace running condition, uses `statefulUpdateMock` so
// every `updateWorkspaceData` call is applied (via the REAL `patch` function
// BuildModelWindow builds) against an evolving in-memory "disk" snapshot —
// exactly like the production read-modify-write — then opens/closes the modal
// with no edits at all and asserts the on-disk snapshot (and the re-rendered
// modal) still show the original condition.
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
        expect((screen.getByLabelText('P1 end') as HTMLInputElement).value).toBe(seededPeriod.end);
        expect(screen.getByDisplayValue('5')).toBeTruthy();

        fireEvent.click(screen.getByLabelText('Close')); // the modal's own X — zero edits made first
        await flush();

        // Re-open and check what's actually shown now — this is what the
        // user sees and reports as "the setting doesn't stay".
        fireEvent.click(screen.getByTestId('rc-card-open'));
        expect((screen.getByLabelText('P1 end') as HTMLInputElement).value).toBe(seededPeriod.end);
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
        expect((screen.getByLabelText('P1 end') as HTMLInputElement).value).toBe(seededPeriod.end);
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
        expect((screen.getByLabelText('P1 end') as HTMLInputElement).value).toBe(seededPeriod.end);

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
        fireEvent.click(screen.getByTestId('rc-apply')); // Edits only land on Apply
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

    // `BuildModelWindow` mounts
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

// Running Condition Filter modal — explicit Apply: the modal edits a LOCAL
// DRAFT of all four workspace fields and only Apply writes (ONE
// `persistRunningCondition` call) — same mental model as the Dashboard Filter
// tab's "Apply filter". Persisted values (the card, the build gate, every
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
        fireEvent.click(screen.getByTestId('rc-card-details')); // the condition text lives under "Details"
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

    it('Apply is disabled while clean; while dirty it is enabled with the impact line next to it (which replaces "Changes not applied yet"); reverting the edit removes both', async () => {
        await openModal();
        expect(apply().disabled).toBe(true);
        expect(screen.queryByTestId('rc-impact')).toBeNull();

        fireEvent.change(screen.getByDisplayValue('5'), { target: { value: '9' } });
        expect(apply().disabled).toBe(false);
        // the only model here was never trained: nobody is affected -> the grey line
        const impact = screen.getByTestId('rc-impact');
        expect(impact.textContent).toBe('No trained or complete model is affected by this change');
        expect(impact.getAttribute('data-tone')).toBe('grey');
        expect(screen.getByTestId('rc-modal-foot').textContent).not.toContain('Changes not applied yet');
        expect(screen.queryByTestId('rc-dirty-hint')).toBeNull();

        fireEvent.change(screen.getByDisplayValue('9'), { target: { value: '5' } });
        expect(apply().disabled).toBe(true);
        expect(screen.queryByTestId('rc-impact')).toBeNull();
    });

    // `persist` had the re-point guard, `persistRunningCondition` did
    // not — an Apply whose write resolved after the window was re-pointed put the OLD workspace's
    // slice into the new workspace's state (and broadcast it from this window).
    it('an Apply whose write lands after the window was re-pointed at another workspace never puts the old slice on screen, nor broadcasts it', async () => {
        const fg = fgSeed();
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: fg });
        // ws1's write is held until after the re-point
        let release!: (v: unknown) => void;
        mockUpdateWorkspaceData.mockImplementation(() => new Promise(res => { release = res; }));
        fireEvent.click(screen.getByTestId('rc-card-open'));
        fireEvent.change(screen.getByDisplayValue('5'), { target: { value: '9' } });
        fireEvent.click(apply());
        await flush();
        expect(writes()).toBe(1);

        // the main window moved on: this window is re-pointed at ws2, which has its OWN condition
        const ws2Filter = { id: 'g1', sensor: 'TAG2', operation: 'less_than' as const, value1: '2', value2: '' };
        await deliverData({
            id: 'ws2',
            failureGroupState: {
                groups: [makeGroup()], models: [makeModel({ id: 'w2' })],
                runningConditionNoneConfirmed: false, runningConditionFilters: [ws2Filter], runningConditionTimePeriods: [seededPeriod],
            },
        }, { workspaceId: 'ws2' });
        await flush();
        fireEvent.click(screen.getByTestId('rc-card-details'));
        const chip = () => screen.getByTestId('rc-card-cond-chip').textContent;
        expect(chip()).toContain('< 2');
        mockEmit.mockClear();

        // ...and only now ws1's write resolves, with ws1's slice
        await act(async () => {
            release({ id: 'ws1', failureGroupState: { ...fg, runningConditionFilters: [{ ...seededFilter, value1: '9' }] } });
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(chip()).toContain('< 2'); // still ws2's condition — not ws1's "> 9"
        expect(screen.getAllByTestId('rc-card-cond-chip')).toHaveLength(1);
        expect(fgChangedEmits()).toHaveLength(0);
    });

    // With "Only when running" and no complete condition the count
    // is of EVERY row (an incomplete condition is not sent) — the caption used to read
    // "N of N rows (100%) used for training" while the header pill said "Required".
    it('"Only when running" without a complete condition: the caption says "set the condition to count the rows" — no "100%", no running days on the rows', async () => {
        // the condition row has no value yet: the workspace is "not set", so the modal opens by itself
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { ...fgSeed(), runningConditionFilters: [{ ...seededFilter, value1: '' }] } });
        expect(screen.getByRole('dialog', { name: 'Running condition' })).toBeTruthy();
        await waitFor(() => expect(periodCountCalls().length).toBeGreaterThan(0));
        await flush();
        expect(screen.getByTestId('rc-required-pill')).toBeTruthy();
        expect(screen.getByTestId('rc-caption-rows').textContent).toBe('set the condition to count the rows');
        expect(screen.getByTestId('rc-caption').getAttribute('data-rows')).toBe('no-condition');
        expect(screen.getByTestId('rc-caption-train').textContent).toBe('31 d train'); // no "(about … running time)"
        expect(screen.queryByTestId('period-running-1')).toBeNull();
        expect(screen.getByTestId('rc-caption').textContent).not.toMatch(/100%/);
        // completing the condition brings the numbers
        fireEvent.change(within(screen.getByTestId('rc-cond-1')).getByLabelText('Value'), { target: { value: '5' } });
        await waitFor(() => expect(screen.getByTestId('rc-caption-rows').textContent).toBe('800 of 5,000 rows (16%) used for training'), { timeout: 3000 });
        expect(screen.getByTestId('period-running-1').textContent).toBe(' · 20 d running');
        // "Use all rows" is a configured choice: every row in the periods IS what is trained on
        fireEvent.click(screen.getByTestId('rc-mode-none'));
        await waitFor(() => expect(screen.getByTestId('rc-caption-rows').textContent).toBe('1,000 of 5,000 rows (20%) used for training'), { timeout: 3000 });
    });

    describe('change warnings: the impact line before Apply, the notice after it (workbench redesign §5)', () => {
        /** A real workspace: a trained model, a Complete model, a Complete model on its OWN (Custom)
         *  running condition and an untrained one — train records computed against this very state. */
        const impactFg = () => {
            const base = {
                runningConditionNoneConfirmed: false,
                runningConditionFilters: [seededFilter],
                runningConditionCombine: 'or' as const,
                runningConditionTimePeriods: [seededPeriod],
                runningConditionTestPeriods: ONE_TEST,
                rcLegacyNotice: null,
            };
            const raw = [
                makeModel({ id: 'm1', name: 'Trained', targetSensor: 'TAG1' }),
                makeModel({ id: 'm2', name: 'Complete', targetSensor: 'TAG2', status: true }),
                makeModel({
                    id: 'm3', name: 'Own', targetSensor: 'TAG3', status: true, runningConditionMode: 'custom',
                    customRunningConditionNoneConfirmed: true, filterTimePeriods: [seededPeriod], customTestPeriods: ONE_TEST,
                }),
                makeModel({ id: 'm4', name: 'Untrained', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2'] }),
            ];
            const models = raw.map(m => (m.id === 'm4' ? m : withTrained(m, { ...base, models: raw })));
            return { groups: [makeGroup()], models, ...base };
        };
        const impact = () => screen.getByTestId('rc-impact');
        const dlg = () => within(screen.getByRole('dialog', { name: 'Running condition' }));
        const fireFg = async (payload: Record<string, any>) => {
            await act(async () => {
                for (const cb of listenCallbacks['failure-group-state-changed'] ?? []) cb({ payload });
                await Promise.resolve();
                await Promise.resolve();
            });
        };

        it('the condition changed: amber "Applying sets 2 models back to Incomplete — they need training again" (Custom and untrained models are not counted); Apply stays enabled', async () => {
            await openModal(impactFg());
            fireEvent.change(screen.getByDisplayValue('5'), { target: { value: '9' } });
            expect(impact().textContent).toBe('Applying sets 2 models back to Incomplete — they need training again');
            expect(impact().getAttribute('data-tone')).toBe('amber');
            expect(impact().className).toContain('rc-impact--amber');
            expect(screen.queryByTestId('rc-impact-quiet')).toBeNull();
            expect(apply().disabled).toBe(false);
        });

        it('a train period changed counts the same models', async () => {
            await openModal(impactFg());
            const end = dlg().getByLabelText('P1 end');
            fireEvent.change(end, { target: { value: '2024-01-20T23:59' } });
            fireEvent.blur(end);
            expect(impact().textContent).toBe('Applying sets 2 models back to Incomplete — they need training again');
        });

        it('only the scoring periods changed: "1 complete model will need Mark complete again (re-score, no training)"', async () => {
            await openModal(impactFg());
            fireEvent.click(dlg().getByTestId('test-add'));
            expect(impact().textContent).toBe('1 complete model will need Mark complete again (re-score, no training)');
            expect(impact().getAttribute('data-tone')).toBe('amber');
            expect(screen.queryByTestId('rc-impact-quiet')).toBeNull();
            expect(apply().disabled).toBe(false);
        });

        it('both changed: the train line plus the quiet "The new scoring periods are scored when they are trained again"', async () => {
            await openModal(impactFg());
            fireEvent.click(dlg().getByTestId('test-add'));
            fireEvent.change(screen.getByDisplayValue('5'), { target: { value: '9' } });
            expect(impact().firstElementChild!.textContent).toBe('Applying sets 2 models back to Incomplete — they need training again');
            expect(screen.getByTestId('rc-impact-quiet').textContent).toBe('The new scoring periods are scored when they are trained again');
        });

        it('an invalid period shows the red "Fix P1 before applying" instead of the impact line', async () => {
            await openModal(impactFg());
            const end = dlg().getByLabelText('P1 end');
            fireEvent.change(end, { target: { value: '2023-01-01T00:00' } });
            fireEvent.blur(end);
            expect(screen.queryByTestId('rc-impact')).toBeNull();
            expect(screen.getByTestId('rc-apply-block').textContent).toBe('Fix P1 before applying');
        });

        // A date typed or picked in a period row used to
        // live in the editor until blur — so there was NO impact line, the timeline and the
        // counts were stale, yet Apply was enabled and ONE click committed + persisted (a
        // Complete model was demoted with the notice only afterwards).
        it('a typed date, no blur: the impact line and the timeline follow at once — Apply is enabled only with its impact line on screen, then one click applies it', async () => {
            await openModal(impactFg());
            const end = dlg().getByLabelText('P1 end');
            const trainBefore = dlg().getByTestId('rc-caption-train').textContent;
            expect(apply().disabled).toBe(true);
            fireEvent.change(end, { target: { value: '2024-01-20T23:59' } }); // no blur
            expect(impact().textContent).toBe('Applying sets 2 models back to Incomplete — they need training again');
            expect(dlg().getByTestId('rc-caption-train').textContent).not.toBe(trainBefore);
            expect(screen.queryByTestId('rc-pending-date')).toBeNull();
            expect(apply().disabled).toBe(false);
            expect(writes()).toBe(0); // typing writes nothing

            fireEvent.click(apply());
            await flush();
            expect(writes()).toBe(1);
            const written = (await mockUpdateWorkspaceData.mock.results[0].value).failureGroupState;
            expect(written.runningConditionTimePeriods).toEqual([{ ...seededPeriod, end: '2024-01-20T23:59' }]);
            expect(written.models.find((m: any) => m.id === 'm2').status).toBe(false); // what the line said
        });

        it('a half-typed date (the field reports ""): the neutral "Finish the date in P1 to see what this changes", no impact line, Apply not enabled by it — and leaving the field writes no half value', async () => {
            await openModal(impactFg());
            const end = dlg().getByLabelText('P1 end') as HTMLInputElement;
            const trainBefore = dlg().getByTestId('rc-caption-train').textContent;
            fireEvent.change(end, { target: { value: '' } });
            const pending = screen.getByTestId('rc-pending-date');
            expect(pending.textContent).toBe('Finish the date in P1 to see what this changes');
            expect(pending.className).toContain('rc-impact--grey');
            expect(pending.getAttribute('role')).toBe('status');
            expect(screen.queryByTestId('rc-impact')).toBeNull();
            expect(screen.queryByTestId('rc-apply-block')).toBeNull(); // not "P1 needs an end date": nothing half is in the draft
            expect(dlg().getByTestId('rc-caption-train').textContent).toBe(trainBefore);
            expect(apply().disabled).toBe(true);

            fireEvent.blur(end);
            expect(screen.queryByTestId('rc-pending-date')).toBeNull();
            expect((dlg().getByLabelText('P1 end') as HTMLInputElement).value).toBe(seededPeriod.end);
            expect(apply().disabled).toBe(true);
            // nothing was edited: X closes without a "Discard?" and without a write
            fireEvent.click(dlg().getByLabelText('Close'));
            expect(screen.queryByRole('dialog', { name: 'Running condition' })).toBeNull();
            expect(writes()).toBe(0);
        });

        it('a scoring date half-typed names its row ("S1"); finishing it replaces the neutral line with the impact line', async () => {
            await openModal(impactFg());
            const end = dlg().getByLabelText('Scoring period 1 end');
            fireEvent.change(end, { target: { value: '' } });
            expect(screen.getByTestId('rc-pending-date').textContent).toBe('Finish the date in S1 to see what this changes');
            fireEvent.change(end, { target: { value: '2024-01-25T00:00' } });
            expect(screen.queryByTestId('rc-pending-date')).toBeNull();
            expect(impact().textContent).toBe('1 complete model will need Mark complete again (re-score, no training)');
        });

        it('another edit is waiting for Apply while a date is half-typed: the impact line of the draft stays, the neutral line under it — and Apply writes the draft, never the half-typed date', async () => {
            await openModal(impactFg());
            fireEvent.change(screen.getByDisplayValue('5'), { target: { value: '9' } });
            fireEvent.change(dlg().getByLabelText('P1 end'), { target: { value: '' } });
            expect(impact().firstElementChild!.textContent).toBe('Applying sets 2 models back to Incomplete — they need training again');
            expect(within(impact()).getByTestId('rc-pending-date').textContent).toBe('Finish the date in P1 to see what this changes');
            expect(apply().disabled).toBe(false);
            fireEvent.click(apply());
            await flush();
            expect(writes()).toBe(1);
            const written = (await mockUpdateWorkspaceData.mock.results[0].value).failureGroupState;
            expect(written.runningConditionFilters[0].value1).toBe('9');
            expect(written.runningConditionTimePeriods).toEqual([seededPeriod]); // the end did NOT become "End of data"
        });

        // A real datetime-local reports '' as soon as ONE
        // segment is cleared, and '' is a valid value on P1's start ("Start of data") — the same
        // Apply click (its blur) used to persist the cleared field as an OPEN bound.
        it('P1 start cleared in the focused field, then Apply: the bound is not opened (the date comes back); the × is the only way to open it', async () => {
            await openModal(impactFg());
            const start = dlg().getByLabelText('P1 start') as HTMLInputElement;
            start.focus();
            fireEvent.change(start, { target: { value: '' } });
            fireEvent.change(screen.getByDisplayValue('5'), { target: { value: '9' } }); // something to apply
            fireEvent.click(apply()); // Apply blurs the focused field first
            await flush();
            expect(writes()).toBe(1);
            const written = (await mockUpdateWorkspaceData.mock.results[0].value).failureGroupState;
            expect(written.runningConditionTimePeriods).toEqual([seededPeriod]);

            // the explicit action: × on P1 start, with its own impact line before Apply
            fireEvent.click(screen.getByTestId('rc-card-open'));
            fireEvent.click(dlg().getByTestId('period-open-toggle-start'));
            expect(dlg().getByTestId('period-open-start').textContent).toContain('Start of data');
            expect(screen.getByTestId('rc-impact')).toBeTruthy();
            fireEvent.click(apply());
            await flush();
            const again = (await mockUpdateWorkspaceData.mock.results[1].value).failureGroupState;
            expect(again.runningConditionTimePeriods).toEqual([{ ...seededPeriod, start: '' }]);
        });

        it('typing in a row never moves it: a P2 start typed before P1 keeps its row (and the focus) until blur sorts the list', async () => {
            const second = { id: 'p2', start: '2024-03-01T00:00', end: '2024-03-31T23:59' };
            await openModal({ ...impactFg(), runningConditionTimePeriods: [seededPeriod, second] });
            const field = dlg().getByLabelText('P2 start') as HTMLInputElement;
            field.focus();
            fireEvent.change(field, { target: { value: '2023-12-01T00:00' } });
            expect(dlg().getByLabelText('P2 start')).toBe(field);
            expect(document.activeElement).toBe(field);
            expect(field.value).toBe('2023-12-01T00:00');
            expect(screen.getByTestId('rc-impact')).toBeTruthy();
            fireEvent.blur(field);
            // sorted now: the edited period is P1
            expect((dlg().getByLabelText('P1 start') as HTMLInputElement).value).toBe('2023-12-01T00:00');
            expect((dlg().getByLabelText('P2 start') as HTMLInputElement).value).toBe(seededPeriod.start);
        });

        it('after Apply: the notice under the running-condition line counts the models still to train, and goes away once they are trained', async () => {
            await openModal(impactFg());
            expect(screen.queryByTestId('rc-retrain-notice')).toBeNull();
            fireEvent.change(screen.getByDisplayValue('5'), { target: { value: '9' } });
            fireEvent.click(apply());
            await flush();
            expect(writes()).toBe(1);
            const written = (await mockUpdateWorkspaceData.mock.results[0].value).failureGroupState;
            // the write itself sent the Complete Workspace-mode model back to Incomplete; the Custom one stays
            expect(written.models.find((m: any) => m.id === 'm2').status).toBe(false);
            expect(written.models.find((m: any) => m.id === 'm3').status).toBe(true);
            const notice = () => screen.getByTestId('rc-retrain-notice');
            expect(notice().textContent).toBe('Running condition changed — 2 models need training again. Use Train all, or Train sensor on each one; the amber dots in the list show which.');
            expect(notice().getAttribute('role')).toBe('status');
            // it sits right under the running-condition line
            expect(screen.getByTestId('rc-card').compareDocumentPosition(notice()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

            // one of them is trained again (as another window would report it)
            const trainedOn = (ids: string[]) => ({
                ...written,
                models: written.models.map((m: any) => (ids.includes(m.id)
                    ? { ...m, lastTrainedAt: '2026-10-10T08:00:00.000Z', trainedFingerprint: computeTrainFingerprint(m, written) }
                    : m)),
            });
            await fireFg({ ...trainedOn(['m1']), workspaceId: 'ws1', origin: 'dashboard' });
            expect(notice().textContent).toBe('Running condition changed — 1 model needs training again. Use Train all, or Train sensor on it; the amber dot in the list shows which.');
            // both trained: the notice is gone (session-only — nothing was stored for it)
            await fireFg({ ...trainedOn(['m1', 'm2']), workspaceId: 'ws1', origin: 'dashboard' });
            expect(screen.queryByTestId('rc-retrain-notice')).toBeNull();
            expect(JSON.stringify(written)).not.toMatch(/retrain/i);
        });

        it('an Apply that affects no trained model leaves no notice', async () => {
            await openModal(); // one untrained model
            fireEvent.change(screen.getByDisplayValue('5'), { target: { value: '9' } });
            fireEvent.click(apply());
            await flush();
            expect(writes()).toBe(1);
            expect(screen.queryByTestId('rc-retrain-notice')).toBeNull();
        });
    });

    it('keyboard: focus lands on the first field on open, Tab stays inside the dialog, Esc cancels and focus goes back to the opener', async () => {
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: fgSeed() });
        const opener = screen.getByTestId('rc-card-open') as HTMLButtonElement;
        opener.focus();
        fireEvent.click(opener);
        const dialog = screen.getByRole('dialog', { name: 'Running condition' });
        // the first field of the body — not the header's Close button
        expect(document.activeElement).toBe(within(dialog).getByLabelText('P1 start'));

        const close = within(dialog).getByLabelText('Close');
        const cancel = screen.getByTestId('rc-cancel');
        // Shift+Tab on the first focusable wraps to the last one (Apply is disabled while clean)
        close.focus();
        fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
        expect(document.activeElement).toBe(cancel);
        // Tab on the last wraps to the first
        fireEvent.keyDown(cancel, { key: 'Tab' });
        expect(document.activeElement).toBe(close);
        // Tab in the middle is left to the browser
        const start = within(dialog).getByLabelText('P1 start');
        start.focus();
        fireEvent.keyDown(start, { key: 'Tab' });
        expect(document.activeElement).toBe(start);
        // focus that got out of the dialog is pulled back in
        opener.focus();
        fireEvent.keyDown(opener, { key: 'Tab' });
        expect(dialog.contains(document.activeElement)).toBe(true);

        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.queryByRole('dialog', { name: 'Running condition' })).toBeNull();
        expect(document.activeElement).toBe(opener);
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

    it('an invalid train period (end before start): the row says why, Apply is disabled with the red footer line "Fix P1 before applying"', async () => {
        await openModal();
        const end = screen.getByLabelText('P1 end') as HTMLInputElement;
        fireEvent.change(end, { target: { value: '2023-01-01T00:00' } });
        fireEvent.blur(end);
        expect(screen.getByTestId('period-invalid-1').textContent).toBe('P1 ends before it starts — pick an end after 2024/01/01 00:00');
        expect(screen.getByTestId('period-row-1').getAttribute('data-invalid')).toBe('true');
        const block = screen.getByTestId('rc-apply-block');
        expect(block.textContent).toBe('Fix P1 before applying');
        expect(block.getAttribute('data-kind')).toBe('invalid-train');
        expect(block.className).toContain('rc-impact--bad');
        expect(screen.queryByTestId('rc-impact')).toBeNull();
        expect(screen.getByRole('dialog', { name: 'Running condition' }).textContent).not.toMatch(/Period 1/);
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

// The Step-1 card
// (replaces the one-line rcbar), the redesigned settings modal and its live
// per-period counts (`count_period_rows`, of the DRAFT). Since the
// card's own "N rows · x%" comes from `count_period_rows` too (ONE call for the
// persisted condition) — nothing here counts through `compute_sensor_stats`.
// The draft / Apply guarantees themselves are tested in the describe above.
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

    // The 5-step progress bar in the window header was removed at the
    // user's request (building goes back and forth; a linear progress did not fit).
    describe('window header (no step bar)', () => {
        it('shows only the title and Close — no step bar — while the Step-1 card stays', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: setFg() });
            expect(screen.queryByTestId('wb-steps')).toBeNull();
            expect(screen.queryByRole('list', { name: 'Build steps' })).toBeNull();
            expect(document.querySelector('[data-testid^="wb-step-"]')).toBeNull();
            const header = screen.getByText('Build Model').closest('[data-tauri-drag-region]') as HTMLElement;
            expect(header).not.toBeNull();
            expect(within(header).getAllByRole('button').map(b => b.getAttribute('title'))).toEqual(['Close']);
            expect(screen.getByTestId('rc-card')).toBeTruthy();
            expect(screen.queryByText(/Open full view/)).toBeNull();
        });

        it('the Step-1 card follows the PERSISTED condition: a draft in the modal does not change it until Apply', async () => {
            // A train period is required to train; periods alone never make the condition "set".
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
            // Set = ONE line (counts + span); the chips are under "Details".
            expect(screen.getByTestId('rc-card').className).toContain('rcc-line');
            expect(screen.getByTestId('rc-card-time').textContent).toBe('Train 2 periods 2026/01/01 00:00 → End');
            expect(screen.getByTestId('rc-card-test').textContent).toBe('Scoring 1 period');
            expect(screen.getByTestId('rc-card-cond').textContent).toBe('When running: 1 condition');
            expect(screen.getByTestId('rc-card').textContent).not.toMatch(/Step\s*1/i);
            fireEvent.click(screen.getByTestId('rc-card-details'));
            expect(screen.getAllByTestId('rc-card-period-chip').map(c => c.textContent)).toEqual(['P1 · 2026/01/01 00:00 → 2026/03/31 23:59', 'P2 · 2026/04/15 00:00 → End']);
            // the persisted scoring periods sit on their own "Scoring" row: S# · start → end
            expect(within(screen.getByTestId('rc-card-test')).getByText('Scoring')).toBeTruthy();
            expect(screen.getAllByTestId('rc-card-test-chip').map(c => c.textContent)).toEqual(['S1 · 2024/01/01 00:00 → 2024/01/31 23:59']);
            expect(screen.getByTestId('rc-card-cond-chip').textContent).toBe('Pump PressureTAG1 > 5 bar'); // Inline label (description then tag) + condition; description + unit come from the sensor metadata
            // Rust's `count_period_rows` of the persisted condition: 2 periods x 800 running rows of 5,000
            await waitFor(() => expect(screen.getByTestId('rc-card-rows').textContent).toBe('1,600'));
            expect(screen.getByTestId('rc-card-pct').textContent).toBe('rows · 32%');
        });

        // The card counted "rows where the FIRST sensor has a value"
        // (`compute_sensor_stats`) while the modal counts with `count_period_rows` — with gaps in
        // that sensor the two disagreed about the SAME applied condition.
        it('the card and the settings modal print the same two numbers for the applied condition (one source: count_period_rows)', async () => {
            // the first sensor has a value in only 100 rows: the old card would have read "100 rows · 100%"
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: setFg() });
            await waitFor(() => expect(screen.getByTestId('rc-card-rows').textContent).toBe('1,600'));
            expect(statsCalls()).toEqual([]); // nothing is counted through compute_sensor_stats any more
            fireEvent.click(screen.getByTestId('rc-card-open'));
            await waitFor(() => expect(screen.getByTestId('rc-caption-rows').textContent).toBe('1,600 of 5,000 rows (32%) used for training'));
            expect(screen.getByTestId('rc-card-pct').textContent).toBe('rows · 32%');
        });

        it('the Set card\'s Details view carries the small period strip (persisted periods); the one-line card has none; the modal draft moves its own strip only, Apply moves the card strip', async () => {
            const impl = (cmd: string) => cmd === 'get_dataset_time_bounds'
                ? Promise.resolve({ min: '2025-01-01 00:00:00', max: '2026-07-31 23:50:00' })
                : cmd === 'compute_sensor_stats' ? Promise.resolve({ count: 100 }) : Promise.resolve({});
            mockInvoke.mockImplementation(impl);
            // The suite's saved 2024 scoring period lies OUTSIDE this test's data
            // (2025-01 … 2026-07): a saved period only warns, it must not block this Apply.
            const fg = setFg();
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: fg });
            statefulUpdateMock(fg.models, fg);
            await flush();
            const cardCov = () => within(screen.getByTestId('rc-card')).getByTestId('period-coverage');
            // The one-line card carries no strip (2026-10-11) — it is in the Details view.
            expect(within(screen.getByTestId('rc-card')).queryByTestId('period-coverage')).toBeNull();
            fireEvent.click(screen.getByTestId('rc-card-details'));
            expect(cardCov().querySelectorAll('.f4-strip i')).toHaveLength(2);
            // the two ends of the strip: year/month, the short form of the one date format
            expect(cardCov().textContent).toContain('2025/01');
            expect(cardCov().textContent).toContain('2026/07');
            expect(cardCov().textContent).not.toMatch(/Jan|Jul/);
            const cardDays = () => within(cardCov()).getByTestId('period-coverage-days').textContent;
            const persisted = cardDays();
            expect(persisted).toMatch(/^\d+ d train · \d+ d scoring$/);

            fireEvent.click(screen.getByTestId('rc-card-open'));
            await flush();
            const dlg = within(screen.getByRole('dialog', { name: 'Running condition' }));
            // the modal has its own timeline hero (no coverage strip inside it any more)
            expect(dlg.queryByTestId('period-coverage')).toBeNull();
            const modalDays = () => dlg.getByTestId('rc-caption-train').textContent;
            const modalBefore = modalDays();
            fireEvent.change(dlg.getByLabelText('P1 end'), { target: { value: '2026-02-10T23:59' } });
            // a complete typed date moves the modal's timeline at once (no blur needed)...
            expect(modalDays()).not.toBe(modalBefore);
            const modalTyped = modalDays();
            fireEvent.blur(dlg.getByLabelText('P1 end'));
            await flush();
            expect(modalDays()).toBe(modalTyped); // ...and the blur changes nothing more
            expect(cardDays()).toBe(persisted); // the card strip is still the persisted periods (not applied)

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

        it('Set with "Use all rows": "All rows — no condition" and ONE count call without a condition', async () => {
            render(<BuildModelWindow />);
            // one train period open at both ends = the whole time range, chosen explicitly
            await deliverData({ failureGroupState: setFg({ runningConditionNoneConfirmed: true, runningConditionTimePeriods: ALL_TIME_TRAIN }) });
            expect(within(screen.getByTestId('rc-card-cond')).getByText('All rows — no condition')).toBeTruthy();
            await waitFor(() => expect(screen.getByTestId('rc-card-rows').textContent).toBe('1,000'));
            expect(periodCountCalls()).toEqual([{
                periods: ALL_TIME_TRAIN.map(p => ({ start: p.start || null, end: p.end || null })),
                filter: null, expected_generation: null,
            }]);
            expect(statsCalls()).toEqual([]);
        });

        it('Train/Test validation: NO train period = "0 rows — add a train period" on the card and no count query at all (never a whole-dataset count)', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: setFg({ runningConditionNoneConfirmed: true, runningConditionTimePeriods: [] }) });
            await flush();
            expect(screen.getByTestId('rc-card-time').textContent).toBe('No train period');
            expect(screen.getByTestId('rc-card-no-train').textContent).toBe('rows — add a train period');
            fireEvent.click(screen.getByTestId('rc-card-details'));
            expect(screen.getByTestId('rc-card-period-chip').textContent).toBe('No train period — add one');
            expect(screen.getByTestId('rc-card-no-train').textContent).toBe('rows — add a train period');
            await act(async () => { await new Promise(r => setTimeout(r, 50)); });
            expect(periodCountCalls()).toEqual([]);
            expect(statsCalls()).toEqual([]);
        });

        it('Set: the card asks ONE count per settled persisted condition — its train periods + the condition (value filters + combine), pinned to the dataset generation; no scoring call', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: setFg({ runningConditionCombine: 'or' }) }, { metadata: { headers: ['timestamp', 'TAG1', 'TAG2', 'TAG3'], total_rows: 100, generation: 7 } });
            await waitFor(() => expect(periodCountCalls()).toHaveLength(1));
            expect(periodCountCalls()[0]).toEqual({
                periods: [{ start: '2026-01-01T00:00', end: '2026-03-31T23:59' }, { start: '2026-04-15T00:00', end: null }],
                filter: { value_filters: [{ sensor: 'TAG1', operation: 'greater_than', value1: 5, value2: null }], combine: 'or' },
                expected_generation: 7,
            });
            // settled: unrelated re-renders ask nothing more
            fireEvent.click(screen.getByTestId('rc-card-details'));
            await act(async () => { await new Promise(r => setTimeout(r, 400)); });
            expect(periodCountCalls()).toHaveLength(1);
            expect(statsCalls()).toEqual([]);
        });

        it('Set: a failing count shows "— rows" and never blocks anything', async () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            mockInvoke.mockImplementation((cmd: string, args?: any) => cmd === 'count_period_rows' ? Promise.reject(new Error('NO_DATA: No data loaded')) : defaultInvoke(cmd, args));
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
            // the card asks nothing while unset: the ONE count is the auto-opened modal's own
            // (its scoring period — this workspace has no train period yet)
            await act(async () => { await new Promise(r => setTimeout(r, 50)); });
            expect(periodCountCalls().map(c => c.periods)).toEqual([ONE_TEST.map(t => ({ start: t.start, end: t.end }))]);
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
            expect(screen.getByTestId('rc-card-title').textContent).toBe('P2 needs fixing');
            expect(screen.getByTestId('rc-card-reason').textContent).toContain('P2 ends before it starts.');
            expect(screen.getByTestId('rc-card-open').textContent).toBe('Fix period');
            await act(async () => { await new Promise(r => setTimeout(r, 50)); });
            expect(periodCountCalls()).toHaveLength(0);
            expect(statsCalls()).toHaveLength(0);
            fireEvent.click(screen.getByTestId('rc-card-open'));
            expect(screen.getByRole('dialog', { name: 'Running condition' })).toBeTruthy();
            expect(screen.getByTestId('rc-fix-period-pill')).toBeTruthy();
        });

        it('the legacy banner sits UNDER the card (DOM order), not above it', async () => {
            const fg = unsetFg({ rcLegacyNotice: 'pending' });
            let disk: any = { id: 'ws1', failureGroupState: fg };
            mockUpdateWorkspaceData.mockImplementation(async (_id: string, patch: (s: any) => any) => { disk = patch(disk); return disk; });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: fg });
            const card = screen.getByTestId('rc-card');
            expect(card.compareDocumentPosition(screen.getByTestId('rc-legacy-banner')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
            expect(screen.queryByTestId('rc-blocked-summary')).toBeNull(); // the blocked-models line is gone (workbench redesign)
            // ...and the old one-line bar is gone
            expect(document.querySelector('.bmw-rcbar')).toBeNull();
            expect(screen.queryByText('RUNNING CONDITION')).toBeNull();
        });
    });

    describe('training stays locked until the running condition is set (existing gate, new message)', () => {
        it('Not set: the results area says so, Train / Mark complete stay disabled with the gate reason', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: unsetFg() });
            expect(screen.getByTestId('results-rc-locked').textContent).toContain('Set the running condition first');
            expect(screen.getByTestId('results-rc-locked').textContent).toContain('can train until it is set — open Running condition ↑');
            expect(document.body.textContent).not.toMatch(/Step\s*1/i); // no text in the window says "Step 1"
            const REASON = 'Set the running condition first — a condition, or Use all rows';
            const train = trainSensorBtn();
            expect(train.disabled).toBe(true);
            expect(train.title).toBe('Set the running condition first.');
            expect(screen.getByTestId('build-block-reason').textContent).toBe(REASON);
            expect(screen.queryByText('✓ Mark complete')).toBeNull(); // Mark complete lives on the Health score page
            expect((screen.getByTestId('next-health-score') as HTMLButtonElement).disabled).toBe(true);
        });

        it('Invalid period: same lock with the "Running condition ↑" link, Train disabled with the period reason', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: setFg({ runningConditionTimePeriods: [{ id: 'x', start: '2026-02-01T00:00', end: '2026-01-05T00:00' }] }) });
            expect(screen.getByTestId('results-rc-locked').textContent).toContain('Fix the running condition first');
            expect(trainSensorBtn().disabled).toBe(true);
            expect(trainSensorBtn().title).toBe("Can't train: Individual — Train period P1 ends before it starts");
            expect(screen.getByTestId('results-rc-locked-open').textContent).toBe('Running condition ↑');
        });

        it('Set: no lock, Train enabled', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: setFg() });
            expect(screen.queryByTestId('results-rc-locked')).toBeNull();
            expect(trainSensorBtn().disabled).toBe(false);
        });
    });

    describe('settings modal: structure + per-period counts of the DRAFT', () => {
        async function open(fg: Record<string, any> = setFg()) {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: fg });
            statefulUpdateMock(fg.models, fg);
            if (!screen.queryByRole('dialog', { name: 'Running condition' })) fireEvent.click(screen.getByTestId('rc-card-open'));
            await flush();
        }

        const caption = () => screen.getByTestId('rc-caption-rows').textContent;
        /** The running-condition card's own count of the PERSISTED condition: one call, made
         *  when the window loads (before the modal opens). Everything after it is the modal's. */
        const CARD = 1;
        /** `count_period_rows` held / answered per condition value. */
        const countsWith = (running: (value1: number | undefined) => number | Promise<unknown> | Error) =>
            mockInvoke.mockImplementation((cmd: string, args: any) => {
                if (cmd !== 'count_period_rows') return defaultInvoke(cmd, args);
                const r = running(args?.filter?.value_filters?.[0]?.value1);
                if (r instanceof Error) return Promise.reject(r);
                if (typeof r !== 'number') return r;
                const base = fakePeriodCounts(args);
                return Promise.resolve({ ...base, union: { ...base.union, running_rows: r } });
            });

        it('is the one-column "Running condition" dialog: title + subtitle, the timeline, three sections — no preview column', async () => {
            await open();
            const dialog = screen.getByRole('dialog', { name: 'Running condition' });
            const dlg = within(dialog);
            expect(dialog.className).toContain('bmw-modal--rc');
            expect(dlg.getByRole('heading', { name: 'Running condition' })).toBeTruthy();
            expect(dlg.getByText('Default for every model · a model can use its own on its settings (Custom)')).toBeTruthy();
            expect([...dialog.querySelectorAll('.rcx-sec-h b')].map(b => b.textContent)).toEqual(['Train periods', 'Scoring periods', 'When the plant is running']);
            expect(dlg.getByTestId('rc-timeline')).toBeTruthy();
            expect(dlg.getByTestId('rc-count-pill').textContent).toBe('1 condition');
            expect(dlg.getAllByTestId(/^period-row-/)).toHaveLength(2);
            // gone with the redesign: the right-hand column, the numbered steps, the callouts
            expect(dlg.queryByTestId('rc-preview')).toBeNull();
            expect(dialog.textContent).not.toMatch(/Data used for training|Which time/);
            expect(dialog.querySelector('.tpe-callout, .rcm-preview, .rcm-num')).toBeNull();
            expect(screen.queryByText('Running Condition Filter')).toBeNull();
        });

        it('while the modal is closed only the card\'s one count is asked; opening it asks TWICE (train periods, scoring periods) with snake_case keys and only the condition as the filter', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: setFg() });
            await flush();
            await act(async () => { await new Promise(r => setTimeout(r, 400)); });
            expect(periodCountCalls()).toHaveLength(CARD);

            fireEvent.click(screen.getByTestId('rc-card-open'));
            await waitFor(() => expect(periodCountCalls()).toHaveLength(CARD + 2));
            const [train, scoring] = periodCountCalls().slice(CARD);
            expect(Object.keys(train).sort()).toEqual(['expected_generation', 'filter', 'periods']);
            expect(train.periods).toEqual([{ start: '2026-01-01T00:00', end: '2026-03-31T23:59' }, { start: '2026-04-15T00:00', end: null }]);
            expect(scoring.periods).toEqual(ONE_TEST.map(t => ({ start: t.start, end: t.end })));
            // the count's filter is the condition only — never the time ranges
            for (const c of [train, scoring]) {
                expect(c.filter).toEqual({ value_filters: [{ sensor: 'TAG1', operation: 'greater_than', value1: 5, value2: null }], combine: 'and' });
            }
            await waitFor(() => expect(caption()).toBe('1,600 of 5,000 rows (32%) used for training'));
            expect(screen.getByTestId('period-days-1').textContent).toMatch(/ d · 20 d running$/);
            expect(screen.getByTestId('test-days-1').textContent).toMatch(/ d · 20 d running$/);
            // settled: nothing more is asked
            await act(async () => { await new Promise(r => setTimeout(r, 450)); });
            expect(periodCountCalls()).toHaveLength(CARD + 2);
        });

        it('typing several characters sends the counts ONCE for the final value (debounced, at most two calls), not per keystroke — the card behind keeps the persisted numbers', async () => {
            await open();
            await waitFor(() => expect(periodCountCalls()).toHaveLength(CARD + 2));
            fireEvent.click(screen.getByTestId('rc-card-details'));
            const cardBefore = screen.getByTestId('rc-card').textContent;
            const input = screen.getByDisplayValue('5');
            for (const v of ['1', '12', '123']) fireEvent.change(input, { target: { value: v } });
            expect(periodCountCalls()).toHaveLength(CARD + 2); // nothing yet
            await waitFor(() => expect(periodCountCalls()).toHaveLength(CARD + 4), { timeout: 3000 });
            await act(async () => { await new Promise(r => setTimeout(r, 450)); });
            expect(periodCountCalls()).toHaveLength(CARD + 4); // one settled draft = two calls, no more (and the card asks nothing: nothing was applied)
            for (const c of periodCountCalls().slice(CARD + 2)) expect((c.filter as any).value_filters[0].value1).toBe(123);
            expect(screen.getByTestId('rc-card').textContent).toBe(cardBefore);
            expect(screen.getByTestId('rc-card-cond-chip').textContent).toContain('> 5');
        });

        it('moving a scoring date re-counts the scoring periods only (the train side is remembered)', async () => {
            await open();
            await waitFor(() => expect(periodCountCalls()).toHaveLength(CARD + 2));
            const end = screen.getByLabelText('Scoring period 1 end') as HTMLInputElement;
            const [d, t] = ONE_TEST[0].end.split('T');
            const day = String(Math.max(1, Number(d.slice(8, 10)) - 1)).padStart(2, '0');
            fireEvent.change(end, { target: { value: `${d.slice(0, 8)}${day}T${t}` } });
            fireEvent.blur(end);
            await waitFor(() => expect(periodCountCalls()).toHaveLength(CARD + 3), { timeout: 3000 });
            await act(async () => { await new Promise(r => setTimeout(r, 450)); });
            expect(periodCountCalls()).toHaveLength(CARD + 3);
            expect(periodCountCalls()[CARD + 2].periods).toHaveLength(1);
        });

        // A typed date reaches the draft on change — but the count
        // stays debounced: several keystrokes that each give a complete date are ONE count.
        it('typing a date key by key (each key a complete date) counts ONCE for the final date, not per keystroke', async () => {
            await open();
            await waitFor(() => expect(periodCountCalls()).toHaveLength(CARD + 2));
            const end = screen.getByLabelText('P1 end');
            for (const v of ['2026-03-01T23:59', '2026-03-02T23:59', '2026-03-20T23:59']) fireEvent.change(end, { target: { value: v } });
            expect(periodCountCalls()).toHaveLength(CARD + 2); // nothing yet
            await waitFor(() => expect(periodCountCalls()).toHaveLength(CARD + 3), { timeout: 3000 });
            await act(async () => { await new Promise(r => setTimeout(r, 450)); });
            expect(periodCountCalls()).toHaveLength(CARD + 3); // the train periods only, once
            expect(periodCountCalls()[CARD + 2].periods[0]).toEqual({ start: '2026-01-01T00:00', end: '2026-03-20T23:59' });
        });

        it('while a new count is on its way the previous numbers stay (dimmed); a slow answer for an older draft never overwrites the newer one', async () => {
            await open();
            await waitFor(() => expect(caption()).toBe('1,600 of 5,000 rows (32%) used for training'));
            const release: { slow?: (v: unknown) => void } = {};
            countsWith(v => (v === 7 ? new Promise(res => { release.slow = res; }) : v === 8 ? 42 : 1600));
            fireEvent.change(screen.getByDisplayValue('5'), { target: { value: '7' } });
            // the old numbers are kept, marked as being counted again — no flicker to "Counting rows…"
            expect(caption()).toBe('1,600 of 5,000 rows (32%) used for training');
            expect(screen.getByTestId('rc-caption-rows').getAttribute('data-stale')).toBe('true');
            await waitFor(() => expect(release.slow).toBeTruthy(), { timeout: 3000 });
            fireEvent.change(screen.getByDisplayValue('7'), { target: { value: '8' } });
            await waitFor(() => expect(caption()).toBe('42 of 5,000 rows (<1%) used for training'), { timeout: 3000 });
            await act(async () => { release.slow!({ ...fakePeriodCounts({ periods: [], filter: {} }), union: { rows_in_period: 99, running_rows: 99, running_days: 1 } }); });
            expect(caption()).toBe('42 of 5,000 rows (<1%) used for training'); // the late answer was dropped
        });

        it('a failing count shows one quiet line instead of numbers and does not stop editing or Apply', async () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            await open();
            await waitFor(() => expect(periodCountCalls()).toHaveLength(CARD + 2));
            countsWith(() => new Error('boom'));
            fireEvent.change(screen.getByDisplayValue('5'), { target: { value: '9' } });
            await waitFor(() => expect(caption()).toBe("Couldn't count the rows right now"), { timeout: 3000 });
            expect(screen.getByTestId('rc-caption').getAttribute('data-rows')).toBe('error');
            expect(screen.queryByTestId('period-running-1')).toBeNull(); // rows fall back to their calendar days
            expect((screen.getByTestId('rc-apply') as HTMLButtonElement).disabled).toBe(false);
            fireEvent.click(screen.getByTestId('rc-apply'));
            await flush();
            expect(state()).toBe('set');
            expect(screen.queryByRole('dialog', { name: 'Running condition' })).toBeNull();
            warn.mockRestore();
        });

        it('a window left over from another dataset (STALE_SESSION) is told to reopen — no numbers, Apply not blocked by it', async () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            countsWith(() => new Error('STALE_SESSION: the dataset changed'));
            await open();
            await waitFor(() => expect(caption()).toBe('The data changed — close this window and open Build Model again to count the rows'), { timeout: 3000 });
            fireEvent.change(screen.getByDisplayValue('5'), { target: { value: '9' } });
            expect((screen.getByTestId('rc-apply') as HTMLButtonElement).disabled).toBe(false);
            warn.mockRestore();
        });

        it('an invalid draft period is never sent (only the valid ones are counted); the caption says to fix it and Apply is blocked', async () => {
            await open();
            await waitFor(() => expect(periodCountCalls()).toHaveLength(CARD + 2));
            const end = screen.getByLabelText('P1 end') as HTMLInputElement;
            fireEvent.change(end, { target: { value: '2025-01-01T00:00' } });
            // the typed date is in the draft at once: no blur is needed for the block to show
            expect(caption()).toBe('fix the period to count the rows');
            expect((screen.getByTestId('rc-apply') as HTMLButtonElement).disabled).toBe(true);
            fireEvent.blur(end);
            await waitFor(() => expect(periodCountCalls()).toHaveLength(CARD + 3), { timeout: 3000 });
            // P1 is invalid: only P2 went out
            expect(periodCountCalls()[CARD + 2].periods).toEqual([{ start: '2026-04-15T00:00', end: null }]);
            expect(screen.getByTestId('period-invalid-1').textContent).toMatch(/^P1 ends before it starts — pick an end after /);
            expect(screen.getByTestId('rc-apply-block').textContent).toBe('Fix P1 before applying');
            expect(screen.getByTestId('rc-fix-period-pill')).toBeTruthy();
            expect((screen.getByTestId('rc-apply') as HTMLButtonElement).disabled).toBe(true);
        });

        it('closing the modal stops the counting; opening it again counts afresh', async () => {
            await open();
            await waitFor(() => expect(periodCountCalls()).toHaveLength(CARD + 2));
            fireEvent.click(screen.getByTestId('rc-cancel'));
            await act(async () => { await new Promise(r => setTimeout(r, 450)); });
            expect(periodCountCalls()).toHaveLength(CARD + 2);
            fireEvent.click(screen.getByTestId('rc-card-open'));
            await waitFor(() => expect(periodCountCalls()).toHaveLength(CARD + 4));
        });

        it('Apply -> the Step-1 card (persisted) now shows the new condition and asks its own count for it', async () => {
            await open();
            fireEvent.change(screen.getByDisplayValue('5'), { target: { value: '9' } });
            fireEvent.click(screen.getByTestId('rc-apply'));
            await flush();
            fireEvent.click(screen.getByTestId('rc-card-details'));
            expect(screen.getByTestId('rc-card-cond-chip').textContent).toContain('> 9');
            // ONE new count for the newly persisted condition (the modal never counted "> 9": Apply
            // came before its debounce), and the optimistic mirror + the write's confirmation are
            // one settled state — not two calls
            await waitFor(() => expect(periodCountCalls().filter(c => (c.filter as any)?.value_filters?.[0]?.value1 === 9)).toHaveLength(1), { timeout: 3000 });
            await act(async () => { await new Promise(r => setTimeout(r, 450)); });
            expect(periodCountCalls().filter(c => (c.filter as any)?.value_filters?.[0]?.value1 === 9)).toHaveLength(1);
            expect(statsCalls()).toEqual([]);
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
            picker.className = 'pk-pop'; // the shared sensor picker's popover
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
        for (const sel of ['.rcc-card', '.rcc-card--req', '.rcc-card--bad', '.rcc-card--ok', '.rcm-body', '.rcm-scroll', '.rcm-per', '.rcm-per--bad', '.rcm-cond', '.rcm-joinbtn', '.bmw-modal--rc',
            '.rct', '.rct-lane', '.rct-blk', '.rct-cap', '.rcx-sec', '.rcx-sec-h', '.rcx-line', '.rcx-radio', '.rcx-footnote', '.rc-impact', '.rc-notice']) {
            expect(() => cssBlock(sel), sel).not.toThrow();
        }
        expect(cssBlock('.bmw-modal--rc')).toMatch(/display:\s*flex/);
        // workbench redesign §5: 980 px, ONE scrolling column (no 340 px preview column)
        expect(cssBlock('.bmw-modal--rc')).toMatch(/width:\s*min\(980px, 100%\)/);
        expect(cssBlock('.rcm-scroll')).toMatch(/overflow-y:\s*auto/);
        expect(cssBlock('.rcm-body')).not.toMatch(/grid-template-columns/);
        // the sensor trigger of a condition row is capped (never the full row)
        expect(cssBlock('.rcm-cond')).toMatch(/grid-template-columns:\s*minmax\(0, 360px\) auto 150px 28px/);
        // an invalid period: a thin red left edge, not a filled box
        expect(cssBlock('.rcm-per')).toMatch(/border-left:\s*2px solid transparent/);
        expect(cssBlock('.rcm-per--bad')).toMatch(/border-left-color:\s*var\(--danger\)/);
        expect(cssBlock('.rcm-per--bad')).not.toMatch(/background/);
        for (const gone of ['.bmw-rcbar', '.f4-rc', '.f4-rc-h', '.f4-prow', '.wb2-steps', '.wb2-stp', '.wb2-sn', '.wb2-sline', '.rcm-preview', '.rcm-mcard', '.rcm-step', '.tpe-callout', '.rcm-sentence']) {
            expect(() => cssBlock(gone), gone).toThrow();
        }
    });
});

// "Incomplete immediately" + the
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
        expect(screen.getByTestId('results-stale').textContent).toBe('Out of dateSettings or running condition changed — train it again with Train sensor ↑ to see the charts.');
        expect(trainSensorBtn().disabled).toBe(false); // stale = ready to train again
        expect(screen.queryByText('Mark incomplete')).toBeNull();
        // Yellow ("needs re-train"), never the green Complete dot.
        expect(screen.getByTestId('sensor-kind-badge-dot-old').className).toMatch(/f4-kb-dot--need/);
        expect(screen.getByTestId('sensor-kind-badge-dot-old').className).not.toMatch(/f4-kb-dot--complete/);
        expect(screen.getByText(/of 1 complete/).textContent).toBe('0 of 1 complete');
        // Opening it does not rewrite the stored status.
        expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
    });

    // The recipes come from the workspace FILE (never a payload);
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

    // The recipes this window judges freshness against.
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

// The Workbench's two pages per model.
// Shell (page switch, list hide/show, dots, stale banner, overlay — the header step bar was removed) and
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

    // The header's "Model fit | Health score" switch was removed (user decision 2026-10-12: the
    // footer already has the buttons). The two pages are reached from the footer only.
    describe('the two pages are reached from the footer (no page switch in the header)', () => {
        it('there is no page switch; "Next: Health score" is disabled for a model that was never trained', async () => {
            await mount([makeModel()]);
            expect(screen.queryByTestId('page-switch')).toBeNull();
            expect(screen.queryByRole('group', { name: 'Model pages' })).toBeNull();
            expect(screen.queryByTestId('footer-back-to-fit')).toBeNull(); // already on Model fit
            const health = screen.getByTestId('next-health-score') as HTMLButtonElement;
            expect(health.disabled).toBe(true);
            expect(health.title).toBe('Train the model first');
            expect(screen.queryByTestId('page-model-done')).toBeNull();
        });

        it('while stale: "Next: Health score" is disabled with the title "Re-train first"', async () => {
            await mount([{ ...withTrained(makeModel()), trainedFingerprint: 'old' }]);
            const health = screen.getByTestId('next-health-score') as HTMLButtonElement;
            expect(health.disabled).toBe(true);
            expect(health.title).toBe('Re-train first');
            expect(screen.queryByTestId('page-model-done')).toBeNull();
        });

        it('trained and fresh: "Next: Health score" opens the real page (set points + checks), "← Model fit" goes back', async () => {
            await mount([withTrained(makeModel())]);
            expect(screen.queryByTestId('page-model-done')).toBeNull();
            expect(screen.queryByTestId('page-health-done')).toBeNull();
            fireEvent.click(screen.getByTestId('next-health-score'));
            await waitFor(() => expect(screen.getByTestId('set-points-card')).toBeTruthy());
            expect(screen.getByTestId('checks-card')).toBeTruthy();
            expect(screen.queryByTestId('results-chart')).toBeNull();
            expect(screen.queryByTestId('add-model-form')).toBeNull(); // Model settings live on the Model fit page
            expect(screen.queryByTestId('next-health-score')).toBeNull(); // on the Health score page the footer offers the way back instead
            expect(screen.getByTestId('footer-back-to-fit').textContent).toContain('Model fit');
            fireEvent.click(screen.getByTestId('footer-back-to-fit'));
            expect(screen.queryByTestId('health-page')).toBeNull();
        });

        it('a Complete model shows no tick either — "Complete" is said once, by the footer pill', async () => {
            await mount([withTrained(makeModel({ status: true }))]);
            expect(screen.queryByTestId('page-model-done')).toBeNull();
            expect(screen.queryByTestId('page-health-done')).toBeNull();
            expect(screen.queryByTestId('page-switch')).toBeNull();
            expect(screen.getByTestId('footer-pill').textContent).toBe('Complete');
            expect(screen.getAllByText('Complete', { selector: '.model-status-pill' })).toHaveLength(1);
        });

        it('each model keeps its own page, and a model that turns stale (another window changed it) falls back to Model fit', async () => {
            const rel = trainedRel();
            const ind = withTrained(makeModel({ id: 'i1' }));
            await mount([ind, rel]);
            fireEvent.click(screen.getByTestId('next-health-score'));
            fireEvent.click(screen.getByRole('tab', { name: /Relation model/ }));
            expect(screen.queryByTestId('health-page')).toBeNull(); // the Relationship model is still on Model fit
            fireEvent.click(screen.getByRole('tab', { name: /Individual/ }));
            expect(screen.getByTestId('health-page')).toBeTruthy(); // ...and Individual kept its page
            // Another window changes a training input of the Relationship model: it turns stale, so
            // its page falls back to Model fit (the stored choice is not erased, just not shown).
            fireEvent.click(screen.getByRole('tab', { name: /Relation model/ }));
            // "Next" opens once the model's fit is on screen (it is closed while the fit loads).
            await waitFor(() => expect((screen.getByTestId('next-health-score') as HTMLButtonElement).disabled).toBe(false));
            fireEvent.click(screen.getByTestId('next-health-score'));
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
            expect((screen.getByTestId('next-health-score') as HTMLButtonElement).disabled).toBe(true);
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
            fireEvent.click(screen.getByTestId('next-health-score'));
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
            fireEvent.click(screen.getByRole('tab', { name: /Relation model/ }));
            fireEvent.click(screen.getByTestId('next-health-score'));
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
            expect(screen.getByTestId('tab-status-i1').getAttribute('title')).toBe('Complete');
            expect(screen.getByTestId('tab-status-r1').getAttribute('title')).toBe('Trained');
            expect(screen.getByTestId('tab-status-c1').getAttribute('title')).toBe('Re-train needed');
        });
    });

    describe('stale banner + "Out of date" overlay', () => {
        // SPEC workbench-redesign §6: the banner has NO button of its own — its sentence links
        // to the header's Train sensor, the one place to train.
        it('shows the banner only while stale: the whole sentence, a "Train sensor ↑" link that focuses Train sensor — which trains the model', async () => {
            const stale = { ...withTrained(makeModel()), trainedFingerprint: 'old' };
            await mount([stale]);
            const banner = screen.getByTestId('stale-banner');
            expect(banner.textContent).toBe('Settings or running condition changed — this model is Incomplete again. Train it again with Train sensor ↑ to update the charts. Your set points are kept.');
            expect(screen.queryByTestId('stale-retrain')).toBeNull();
            expect(banner.querySelector('.rcx-btn')).toBeNull();
            const trains = () => mockInvoke.mock.calls.filter(c => c[0] === 'compute_sensor_stats').length;
            const before = trains();
            // the link does not train by itself: it moves the focus to Train sensor
            fireEvent.click(screen.getByTestId('stale-go-train'));
            await flush();
            expect(document.activeElement).toBe(trainSensorBtn());
            expect(trains()).toBe(before);
            expect(trainSensorBtn().textContent).toBe('▶ Train sensor · 1 of 1');
            await act(async () => { fireEvent.click(trainSensorBtn()); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
            await waitFor(() => expect(trains()).toBe(before + 1));
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
            // Train sensor (where the banner points) commits the draft and the banner / overlays go away again.
            expect(screen.queryByTestId('stale-retrain')).toBeNull();
            fireEvent.click(screen.getByTestId('stale-go-train'));
            expect(document.activeElement).toBe(trainSensorBtn());
            await act(async () => { fireEvent.click(trainSensorBtn()); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
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

        it('Clustering: the cluster scatter with SD rings is the page\'s only, full-width card — no cluster summary, no side column', async () => {
            await mount([withTrained(makeModel({ id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2', numClusters: 1 }))]);
            await chartsReady();
            // the board's cards (an amber notice above them is not a card)
            expect([...screen.getByTestId('model-fit-clustering').children].filter(c => c.tagName === 'SECTION').map(c => c.getAttribute('data-testid'))).toEqual(['chart-card-cl']);
            expect(screen.getByTestId('chart-card-cl').className).toMatch(/(^| )wb2-full( |$)/);
            expect(screen.queryByTestId('cluster-summary')).toBeNull();
            expect(healthCalls()[0]).toMatchObject({ kind: 'clustering', first_sensor: 'TAG1', second_sensor: 'TAG2' });
        });

        it('the unit of the target sensor reaches the page (statistics in "bar")', async () => {
            await mount([withTrained(makeModel())]);
            await chartsReady();
            expect(screen.getByTestId('stats-card').textContent).toMatch(/Mean5 bar/);
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

        // SPEC §4 NOT_FITTED: no in-pane Re-train button — ONE board with text links ("Load it
        // again", and "Train sensor ↑" for a model it trains), and the model counts as "needs
        // training" (Train sensor filled, footer, pill, tab words).
        it('a Relationship whose fit is gone from Rust (NOT_FITTED): one board with "Load it again" + "Train sensor ↑" links, no Re-train button; it counts as needing training and Train sensor trains it again', async () => {
            mockInvoke.mockImplementation((cmd: string, args?: any) =>
                cmd === 'compute_health_preview' ? Promise.reject('NOT_FITTED: no fitted model for this key') : defaultInvoke(cmd, args));
            const rel = trainedRel();
            statefulUpdateMock([rel]);
            await mount([rel]);
            await fitGoneSettled();
            const b = screen.getByTestId('results-not-fitted');
            expect(b.className).toContain('wbx-msg');
            expect(b.querySelector('.wbx-msg-t')!.textContent).toBe('Fit no longer in memory');
            expect(b.querySelector('.wbx-msg-s')!.textContent).toBe('The fitted Relation model is no longer in memory (the data was reloaded, a special sensor changed, or many Relation models were opened). Nothing about the model changed — Load it again, or re-train it with Train sensor ↑. The charts come back when it is loaded.');
            expect(screen.queryByTestId('results-not-fitted-retrain')).toBeNull();
            expect(Array.from(b.querySelectorAll('button')).map(x => x.getAttribute('data-testid'))).toEqual(['board-load-fit', 'board-train-sensor']);
            expect(b.querySelector('.rcx-btn')).toBeNull(); // text links only
            expect(screen.queryByTestId('results-chart')).toBeNull();
            // "needs training" everywhere it is said
            expect(screen.getByTestId('wb-footer').getAttribute('data-primary')).toBe('train');
            expect(trainSensorBtn().className).toContain('rcx-btn--pri');
            expect(trainSensorBtn().textContent).toBe('▶ Train sensor · 1 of 1');
            const line = screen.getByTestId('footer-status');
            expect(line.textContent).toBe('Fit no longer in memory · load it again, or re-train with Train sensor ↑');
            expect(within(line).getByTestId('footer-load-fit').className).toBe('tq-inline-link');
            expect(line.getAttribute('data-tone')).toBe('warn');
            expect(screen.getByTestId('footer-pill').textContent).toBe('Incomplete'); // not "Trained"
            expect(screen.getByRole('tab', { name: /Relation model/ }).getAttribute('aria-label')).toBe('Relation model, Fit no longer in memory');
            expect(screen.getByTestId('tab-status-r1').className).toContain('f4-sdot--need');
            expect(screen.getByTestId('next-health-score').className).toBe('rcx-btn'); // a ghost: training comes first
            // the link goes to the ONE place to train, and that place trains it
            fireEvent.click(within(b).getByTestId('board-train-sensor'));
            expect(document.activeElement).toBe(trainSensorBtn());
            mockInvoke.mockClear();
            await act(async () => { fireEvent.click(trainSensorBtn()); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
            expect(mockInvoke).toHaveBeenCalledWith('preview_relationship_model', expect.objectContaining({ cache_key: expect.stringContaining('r1::') }));
        });

        // `reloadFit` refuses a model whose unsaved settings cannot be
        // saved, so no enabled "Load it again" may be on screen then. On the Model fit page
        // the board gives way to the list of what to fix (and wherever the link is still
        // drawn it is disabled with that reason — `fitReloadBlock`).
        it('fit gone + an unsaved draft that cannot be saved: no "Load it again" that would do nothing — the page lists what to fix; the link is back with the setting', async () => {
            mockInvoke.mockImplementation((cmd: string, args?: any) =>
                cmd === 'compute_health_preview' ? Promise.reject('NOT_FITTED: no fitted model for this key') : defaultInvoke(cmd, args));
            const rel = trainedRel();
            statefulUpdateMock([rel]);
            await mount([rel]);
            await fitGoneSettled();
            const link = () => screen.getByTestId('board-load-fit') as HTMLButtonElement;
            expect(link().disabled).toBe(false);
            openSettings();
            const relName = (rel as Record<string, any>).name as string;
            const nameBox = screen.getByDisplayValue(relName);
            fireEvent.change(nameBox, { target: { value: '' } });
            expect(screen.queryByTestId('board-load-fit')).toBeNull();
            expect(screen.queryByTestId('footer-load-fit')).toBeNull();
            expect(screen.queryByTestId('results-not-fitted')).toBeNull();
            expect(within(screen.getByTestId('results-incomplete')).getByText('Model name is required')).toBeTruthy();
            expect(screen.getByTestId('build-block-reason').textContent).toBe('Fill in the required fields above first');
            // the name back: the board and its working link are back
            fireEvent.change(nameBox, { target: { value: relName } });
            expect(screen.queryByTestId('results-incomplete')).toBeNull();
            await fitGoneSettled(); // the preview is asked again and still says the fit is gone
            expect(link().disabled).toBe(false);
        });

        // A COMPLETE model is "up to date" for Train sensor
        // (`classifyTrainPlan`), so the board's "Train sensor ↑" pointed at a disabled button — a
        // dead end reached by opening the same Relation model a third time in a workspace with
        // more Relation models than the Rust fit cache holds. Nothing about the model changed:
        // "Load it again" re-runs the silent re-fit — no write, status and fingerprint untouched.
        it('a COMPLETE Relation model whose fit is gone: "Load it again" (and no Train sensor link, which cannot train it) fits it again silently — still Complete, nothing re-trained; a load that fails comes back to the board with its reason', async () => {
            let gone = true;
            let fitMode: 'ok' | 'hold' | 'fail' = 'ok';
            let release: () => void = () => {};
            mockInvoke.mockImplementation((cmd: string, args?: any) => {
                if (cmd === 'compute_health_preview' && gone) return Promise.reject('NOT_FITTED: no fitted model for this key');
                if (cmd === 'preview_relationship_model' && fitMode === 'fail') return Promise.reject(new Error('the engine stopped'));
                if (cmd === 'preview_relationship_model' && fitMode === 'hold') return new Promise(res => { release = () => res(defaultInvoke(cmd, args)); });
                return defaultInvoke(cmd, args);
            });
            const rel = trainedRel({ status: true });
            await mount([rel]);
            await fitGoneSettled();
            const fits = () => mockInvoke.mock.calls.filter(c => c[0] === 'preview_relationship_model');
            const before = fits().length;
            const board = () => screen.getByTestId('results-not-fitted');
            const tabLabel = () => screen.getByRole('tab', { name: /Relation model/ }).getAttribute('aria-label');
            const clickLoad = () => act(async () => { fireEvent.click(within(board()).getByTestId('board-load-fit')); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
            expect(board().querySelector('.wbx-msg-s')!.textContent).toBe('The fitted Relation model is no longer in memory (the data was reloaded, a special sensor changed, or many Relation models were opened). Nothing about the model changed — Load it again. The charts come back when it is loaded.');
            // no link that cannot work: Train sensor never trains a Complete model
            expect(within(board()).queryByTestId('board-train-sensor')).toBeNull();
            expect(board().querySelectorAll('button')).toHaveLength(1);
            expect(trainSensorBtn().disabled).toBe(true);
            expect(trainSensorBtn().textContent).toBe('▶ Train sensor'); // a ghost: no "· n of m" when nothing needs it
            expect(trainSensorWhy()).toBe('1 model up to date — nothing to train');
            // it is still Complete, and the footer says what is wrong (not only "Trained …")
            expect(screen.getByTestId('footer-pill').textContent).toBe('Complete');
            const line = screen.getByTestId('footer-status');
            expect(line.textContent).toBe('Fit no longer in memory · load it again');
            expect(line.getAttribute('data-tone')).toBe('warn');
            expect(within(line).queryByTestId('footer-train-sensor')).toBeNull();
            expect(tabLabel()).toBe('Relation model, Complete · Fit no longer in memory');

            // 1) a load that FAILS: back on the same board, red, with the reason — never "Training failed"
            mockUpdateWorkspaceData.mockClear();
            fitMode = 'fail';
            await clickLoad();
            await waitFor(() => expect(board().querySelector('.wbx-msg-d')).not.toBeNull());
            expect(board().querySelector('.wbx-msg-d')!.textContent).toBe('The last attempt did not work: the engine stopped');
            expect(board().className).toContain('wbx-msg--bad');
            expect(screen.queryByTestId('results-error')).toBeNull();
            expect(fits()).toHaveLength(before + 1);
            expect(screen.getByTestId('footer-pill').textContent).toBe('Complete');
            expect(screen.getByTestId('footer-status').textContent).toBe('Fit no longer in memory · load it again');

            // 2) a load that works: "Loading the Relation model…" meanwhile, then the charts
            fitMode = 'hold';
            await clickLoad();
            await waitFor(() => expect(screen.getByTestId('results-loading')).toBeTruthy());
            expect(screen.getByTestId('results-loading').querySelector('.wbx-msg-t')!.textContent).toBe('Loading the Relation model…');
            expect(screen.queryByTestId('results-not-fitted')).toBeNull();
            expect(fits()).toHaveLength(before + 2);
            expect((fits().pop()![1] as any).cache_key).toBe(`r1::${rel.trainedFingerprint}`); // the SAME fit, not a new train
            gone = false;
            fitMode = 'ok';
            await act(async () => { release(); await Promise.resolve(); await Promise.resolve(); });
            await chartsReady();
            expect(screen.queryByTestId('results-not-fitted')).toBeNull();
            expect(screen.getByTestId('footer-pill').textContent).toBe('Complete');
            await waitFor(() => expect(tabLabel()).toBe('Relation model, Complete'));
            // nothing about the model was written by either load: status, train time and fingerprint stay
            for (const r of mockUpdateWorkspaceData.mock.results) {
                const m = (await r.value).failureGroupState.models[0];
                expect(m.status).toBe(true);
                expect(m.lastTrainedAt).toBe(rel.lastTrainedAt);
                expect(m.trainedFingerprint).toBe(rel.trainedFingerprint);
            }
        });

        // The mark is per MODEL, not only "what the open tab
        // was last told".
        it('the fit-gone mark is kept for a tab that is not open, shows at once when its tab is opened again, and is dropped when the window is re-pointed at another workspace with the same model ids', async () => {
            let gone = true;
            mockInvoke.mockImplementation((cmd: string, args?: any) =>
                cmd === 'compute_health_preview' && gone && args?.request?.kind === 'relationship'
                    ? Promise.reject('NOT_FITTED: no fitted model for this key') : defaultInvoke(cmd, args));
            const ind = withTrained(makeModel());
            const rel = trainedRel();
            await mount([ind, rel]);
            const relTab = () => screen.getByRole('tab', { name: /Relation model/ });
            fireEvent.click(relTab());
            await fitGoneSettled();
            expect(relTab().getAttribute('aria-label')).toBe('Relation model, Fit no longer in memory');
            // another tab of the sensor: the Relation model is still known as fit-gone, and still planned as ready
            fireEvent.click(screen.getByRole('tab', { name: /Individual/ }));
            await chartsReady();
            expect(relTab().getAttribute('aria-label')).toBe('Relation model, Fit no longer in memory');
            expect(trainSensorBtn().textContent).toBe('▶ Train sensor · 1 of 2');
            // back on its tab: BEFORE the next NOT_FITTED answer lands it must not read "Trained"
            fireEvent.click(relTab());
            expect(relTab().getAttribute('aria-label')).toBe('Relation model, Fit no longer in memory');
            expect(screen.getByTestId('footer-pill').textContent).toBe('Incomplete');
            expect(screen.getByTestId('footer-status').textContent).toBe('Fit no longer in memory · load it again, or re-train with Train sensor ↑');
            await fitGoneSettled();
            // a duplicated workspace: same model ids, another project — its models are not fit-gone
            gone = false;
            await deliverData({ id: 'ws2', failureGroupState: { groups: [makeGroup()], models: [ind, rel] } }, { workspaceId: 'ws2' });
            fireEvent.click(relTab());
            expect(relTab().getAttribute('aria-label')).toBe('Relation model, Trained');
            expect(screen.queryByTestId('results-not-fitted')).toBeNull();
            await chartsReady();
            expect(trainSensorBtn().textContent).toBe('▶ Train sensor');
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
            expect(screen.getByTestId('results-placeholder').querySelector('.wbx-msg-t')!.textContent).toBe('Not trained yet');
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
            fireEvent.click(screen.getByRole('tab', { name: /Relation model/ }));
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

    // The amber note used to stand next to every training input of every model — it read as a
    // warning that something was filled in wrong (real-app report 2026-10-12) and was removed.
    describe('Model settings: no "changing it sets the model to Incomplete" note beside the fields', () => {
        it('Relationship: none next to the training data, predictors or stiffness — the labels stand alone', async () => {
            await mount([REL()]);
            openSettings();
            const form = screen.getByTestId('add-model-form');
            expect(within(form).queryAllByTestId('incomplete-hint')).toHaveLength(0);
            expect(form.textContent).not.toMatch(/sets the model to Incomplete/);
            for (const label of ['Predictor sensors (≥ 1)', 'Stiffness', 'Training data']) {
                expect(screen.getByText(label).parentElement!.querySelector('.wb2-aff')).toBeNull();
            }
        });

        it('Clustering: none next to the sensors, clusters or training data either — also on a Complete model', async () => {
            await mount([withTrained(makeModel({ id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2', status: true }))]);
            openSettings();
            const form = screen.getByTestId('add-model-form');
            for (const label of ['Y sensor (target)', 'Criteria sensor (optional)', 'Clusters', 'Training data']) expect(screen.getByText(label), label).toBeTruthy();
            expect(within(form).queryAllByTestId('incomplete-hint')).toHaveLength(0);
            expect(form.textContent).not.toMatch(/sets the model to Incomplete/);
        });
    });
});

// The Health score page inside the window - the DRAFT set points,
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
 *  stores the saved validation verdict - `healthVerdict` - is not one). */
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
            await waitFor(() => expect(screen.getByTestId('hs-verdict').getAttribute('title')).toBe('Set points still empty'));
            expect(hsMarkBtn().disabled).toBe(true);
            expect(screen.getByTestId('mark-block-reason').textContent).toBe('2 set points still empty');
            hsType('sp-lower', '3');
            hsType('sp-upper', '9');
            await waitFor(() => expect(screen.getByTestId('hs-verdict').getAttribute('title')).toBe('A set point is not valid'));
            expect(screen.getByTestId('mark-block-reason').textContent).toBe('1 set point not valid — fix before marking complete');
            hsType('sp-lower', '1');
            await waitFor(() => expect(screen.getByTestId('hs-verdict').getAttribute('title')).toBe('Set points valid'));
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
            expect(screen.getByTestId('master-origin').textContent).toBe('L and H come from the master data alarm limits.');
            expect(screen.queryByTestId('sp-lower-reset')).toBeNull();
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
            fireEvent.click(screen.getByTestId('next-health-score'));
            await flush();
            expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
        });

        it('never overwrites a value the user already entered; only the snapshot is taken', async () => {
            const m = withTrained(makeModel({ healthSetPoints: { kind: 'individual', lower: 7, upper: null } }));
            await hsMount([m], { sensorMetadata: META });
            await openHealthPage();
            await flush();
            expect((await hsLastModel()).healthSetPoints).toEqual({ kind: 'individual', lower: 7, upper: 90, masterLower: 1, masterUpper: 90 });
            expect(screen.getByTestId('master-origin').textContent).toBe('L is set on this model · H comes from the master data.');
            // the master value as typed in the master data: "1", never "1.00"
            expect(screen.getByTestId('sp-lower-reset').textContent).toBe('Use master L 1');
            expect(screen.queryByTestId('sp-upper-reset')).toBeNull();
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
            expect(screen.getByTestId('master-origin').textContent).toBe('The master data has no alarm limits for this sensor — type L and H.');
            expect(hsInput('sp-lower').value).toBe('');
            expect(screen.getByTestId('hs-verdict').getAttribute('title')).toBe('Set points still empty');
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

    // The footer counts the EMPTY SET POINTS (Rust's `required` issues), not the Checks lines:
    // a Relation model's 4 empty points are ONE Checks line, and the footer used to say "1".
    it('says how many set points are empty: 4 empty Relationship points read "4 set points still empty" (the Checks card still shows ONE line)', async () => {
        await hsMount([HS_REL({ healthSetPoints: { kind: 'relationship', residualAt80Lower: null, residualAt80Upper: null, residualAt0Lower: null, residualAt0Upper: null } })]);
        await openHealthPage();
        await waitFor(() => expect(screen.getByTestId('mark-block-reason').textContent).toBe('4 set points still empty'));
        expect(hsMarkBtn().disabled).toBe(true);
        expect(hsMarkBtn().title).toBe('4 set points still empty');
        expect(screen.getAllByTestId('check-line')).toHaveLength(1);
        expect(screen.getByTestId('check-line').textContent).toMatch(/Enter 4 empty points/);
    });

    it('one empty Relationship point reads "1 set point still empty" (singular)', async () => {
        await hsMount([HS_REL({ healthSetPoints: { kind: 'relationship', residualAt80Lower: -1, residualAt80Upper: 1, residualAt0Lower: -5, residualAt0Upper: null } })]);
        await openHealthPage();
        await waitFor(() => expect(screen.getByTestId('mark-block-reason').textContent).toBe('1 set point still empty'));
        expect(hsMarkBtn().title).toBe('1 set point still empty');
    });

    it('is blocked while the preview is still loading ("Checking the set points…")', async () => {
        mockInvoke.mockImplementation((cmd: string, args?: any) => cmd === 'compute_health_preview' ? new Promise(() => {}) : healthInvoke(cmd, args));
        statefulUpdateMock([HS_IND()]);
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [HS_IND()] } });
        fireEvent.click(screen.getByTestId('next-health-score'));
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
        // ...and the scoring interval the validating preview reported (1-hour averages)
        expect(written.healthExport.scoringIntervalSecs).toBe(3600);
        expect(typeof written.healthExport.at).toBe('string');
        // No "Files saved to …" banner on the page: it is the footer's ONE sentence, with the
        // app's one date format (mono, no seconds) and the folder (the full path is the tooltip).
        const saved = screen.getByTestId('save-ok');
        expect(saved.closest('.f4-foot')).not.toBeNull();
        expect(saved.textContent).toMatch(/^Files saved \d{4}\/\d{2}\/\d{2} \d{2}:\d{2} · …\/workspaces\/ws1\/output$/);
        expect(saved.querySelector('.wbx-dt')!.textContent).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);
        expect(screen.getByTestId('footer-saved-path').getAttribute('title')).toBe('C:/data/workspaces/ws1/output');
        expect(screen.getByTestId('health-page').querySelector('.hs-save')).toBeNull();
        expect(screen.queryByTestId('save-files')).toBeNull();
        expect(screen.getByTestId('wb-footer').querySelectorAll('.f4-foot-reason')).toHaveLength(1);
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
        expect(screen.getByTestId('hs-verdict').getAttribute('title')).toBe('A set point is not valid');
        expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
        expect(screen.getByText('Trained', { selector: '.model-status-pill' })).toBeTruthy();
        expect(screen.queryByTestId('mark-incomplete')).toBeNull();
        // Changing a set point clears the refusal and brings the live Checks back.
        hsType('sp-lower', '0.5');
        await waitFor(() => expect(screen.getByTestId('check-valid')).toBeTruthy());
    });

    it.each([
        ['STALE_SESSION: the dataset was reloaded', /out of date/],
        ['The Relation model engine stopped without returning a result.', /The Relation model engine stopped without returning a result\./],
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

    // The page still showed a valid preview, so Mark complete
    // stayed enabled and failed the same way on every click.
    it('the export answers NOT_FITTED: the fit is marked gone and the preview asked again — the "Load it again" board appears and Mark complete is disabled with that reason; loading it brings Mark complete back', async () => {
        let gone = false;
        let exportFails = true;
        mockInvoke.mockImplementation((cmd: string, args?: any) => {
            if (cmd === 'export_model_files' && exportFails) { gone = true; return Promise.reject('NOT_FITTED: no fitted model for this key'); }
            if (cmd === 'compute_health_preview' && gone) return Promise.reject('NOT_FITTED: no fitted model for this key');
            return healthInvoke(cmd, args);
        });
        const rel = HS_REL({ healthSetPoints: { kind: 'relationship', residualAt80Lower: -1.5, residualAt80Upper: 1.5, residualAt0Lower: -3, residualAt0Upper: 3 } });
        statefulUpdateMock([rel]);
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel] } });
        await openHealthPage();
        await waitFor(() => expect(hsMarkBtn().disabled).toBe(false));
        const fits = () => mockInvoke.mock.calls.filter(c => c[0] === 'preview_relationship_model').length;
        const before = fits();
        await hsClickMark();
        await waitFor(() => expect(screen.getByTestId('save-error').textContent).toBe('The model was not saved. The fitted Relation model was no longer in memory, so its files were not written. Mark complete again once it is loaded.'));
        // asked again -> NOT_FITTED -> ONE silent re-fit -> still gone -> the board
        await fitGoneSettled('health-not-fitted');
        expect(fits()).toBe(before + 1);
        expect(hsMarkBtn().disabled).toBe(true);
        expect(hsMarkBtn().title).toBe('Fit no longer in memory · load it again, or re-train with Train sensor ↑');
        expect(screen.getByTestId('mark-block-reason').textContent).toBe('Fit no longer in memory · load it again, or re-train with Train sensor ↑');
        expect(screen.getByTestId('footer-pill').textContent).toBe('Incomplete');
        expect(mockInvoke.mock.calls.filter(c => c[0] === 'export_model_files')).toHaveLength(1);
        // "Load it again": the set points come back and Mark complete works
        gone = false;
        exportFails = false;
        await act(async () => { fireEvent.click(screen.getByTestId('health-load-fit')); await Promise.resolve(); await Promise.resolve(); });
        await waitFor(() => expect(screen.getByTestId('set-points-card')).toBeTruthy());
        await waitFor(() => expect(hsMarkBtn().disabled).toBe(false));
        await hsClickMark();
        await waitFor(() => expect(screen.getByTestId('footer-pill').textContent).toBe('Complete'));
    });

    it('a double click starts ONE export (guarded), disables the button and says "Saving the model files…" in the FOOTER only (no card on the page) until it finishes', async () => {
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
        expect(screen.queryByTestId('save-running')).toBeNull();
        expect(screen.getByTestId('health-page').querySelector('.hs-save')).toBeNull();
        expect(screen.getByTestId('health-page').textContent).not.toMatch(/Saving/);
        expect(screen.getByTestId('footer-status').textContent).toMatch(/Saving the model files…/);
        await act(async () => { release(); await Promise.resolve(); await Promise.resolve(); });
        await waitFor(() => expect(screen.getByTestId('save-ok')).toBeTruthy());
        expect(exportCalls()).toHaveLength(1);
    });

    it('Relationship: saving is the footer sentence too (the "can take longer than 15 seconds" line only once it IS slow), and the page stays usable meanwhile', async () => {
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
        expect(screen.queryByTestId('save-running')).toBeNull();
        expect(screen.getByTestId('footer-status').textContent).toMatch(/Saving the model files…/);
        // (the "can take longer than 15 seconds" line shows only once the save IS slow — HealthScorePage.test.tsx)
        hsType('sp-residual_at_0_upper', '3.5');
        expect(screen.getByTestId('footer-status').textContent).toMatch(/Saving the model files…/); // typing does not end the save
        expect(hsMarkBtn().disabled).toBe(true);
        expect(hsInput('sp-residual_at_0_upper').value).toBe('3.5');
        expect((screen.getByTestId('footer-back-to-fit') as HTMLButtonElement).disabled).toBe(false);
        await act(async () => { release(); await Promise.resolve(); await Promise.resolve(); });
        await waitFor(() => expect(screen.getByTestId('mark-incomplete')).toBeTruthy());
        // 3.5 was typed while the files were being written with 3: the footer says they are out of date
        await waitFor(() => expect(screen.getByTestId('files-out-of-date')).toBeTruthy());
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
    const record = { at: '2026-10-04T01:00:00.000Z', outputDir: 'C:/data/workspaces/ws1/output', setPoints: HS_SNAP, scoringIntervalSecs: 3600 };

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
        expect(screen.getByTestId('save-ok').textContent).toMatch(/^Files saved 2026\/10\/04 \d{2}:\d{2} · …\/workspaces\/ws1\/output$/); // from the stored record, in the footer
        expect(screen.getByTestId('save-ok').closest('.f4-foot')).not.toBeNull();
        hsType('sp-upper', '12');
        // said ONCE, in the footer (no banner on the page), next to its button
        const hint = screen.getByTestId('files-out-of-date');
        expect(hint.textContent).toBe('Files out of date — set points changed after saving · Mark complete again to update them');
        expect(hint.closest('.f4-foot')).not.toBeNull();
        expect(screen.getByTestId('health-page').textContent).not.toMatch(/Changed after saving/);
        expect(screen.queryByTestId('save-ok')).toBeNull();
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

// The health score moved to 1-hour averages (2026-10-11). A model that was already Complete
// STAYS Complete (user decision, Q2): its export record has no `scoringIntervalSecs`, so the
// Health score page footer says its saved results use the earlier scoring and offers
// "Mark complete again" — nothing is written until the user presses it.
describe('Health score page - saved with the earlier row-by-row scoring (a Complete model from before 1-hour averages)', () => {
    /** A record as a build BEFORE the change wrote it: no scoring interval. */
    const earlier = { at: '2026-10-04T01:00:00.000Z', outputDir: 'C:/data/workspaces/ws1/output', setPoints: HS_SNAP };
    const current = { ...earlier, scoringIntervalSecs: 3600 };
    const HINT = 'Saved results use the earlier row-by-row scoring — Mark complete again to update the files';
    const hint = () => screen.queryByTestId('earlier-scoring');
    const again = () => screen.queryByTestId('mark-complete-again') as HTMLButtonElement | null;

    it('the footer says so in its ONE sentence and "Mark complete again" is the filled button; the model stays Complete and nothing is written', async () => {
        await hsMount([HS_IND({ status: true, healthExport: earlier })]);
        mockUpdateWorkspaceData.mockClear();
        await openHealthPage();
        await waitFor(() => expect(hint()).not.toBeNull());
        expect(hint()!.textContent).toBe(HINT);
        expect(HINT).toBe(EARLIER_SCORING_HINT_TEXT);
        expect(hint()!.getAttribute('data-tone')).toBe('warn');
        expect(hint()!.closest('.f4-foot')).not.toBeNull();
        // ONE sentence: the hint takes the place of "Files saved …" (no second line, no banner on the page)
        expect(screen.getByTestId('wb-footer').querySelectorAll('.wbx-reason')).toHaveLength(1);
        expect(screen.queryByTestId('save-ok')).toBeNull();
        expect(screen.getByTestId('health-page').textContent).not.toMatch(/row-by-row/);
        // still Complete
        expect(screen.getByTestId('footer-pill').textContent).toBe('Complete');
        expect(screen.getByTestId('mark-incomplete')).toBeTruthy();
        expect(screen.queryByTestId('mark-complete')).toBeNull();
        // the filled button, the way "files out of date" does it
        expect(again()).not.toBeNull();
        expect(again()!.className).toBe('bmw-btn-ok');
        expect(again()!.textContent).toBe('✓ Mark complete again');
        expect(screen.getByTestId('wb-footer').getAttribute('data-primary')).toBe('mark');
        await waitFor(() => expect(again()!.disabled).toBe(false));
        // looking wrote nothing about the model's status or its record
        await flush();
        expect(exportCalls()).toHaveLength(0);
        for (const r of mockUpdateWorkspaceData.mock.results) {
            const m = (await r.value).failureGroupState.models[0];
            expect(m.status).toBe(true);
            expect(m.healthExport).toEqual(earlier);
        }
    });

    it('"Mark complete again" writes the files again, the record then carries scoringIntervalSecs: 3600, and the hint and the button are gone', async () => {
        await hsMount([HS_IND({ status: true, healthExport: earlier })]);
        await openHealthPage();
        await waitFor(() => expect(again()).not.toBeNull());
        await waitFor(() => expect(again()!.disabled).toBe(false));
        await act(async () => { fireEvent.click(again()!); await Promise.resolve(); });
        await waitFor(() => expect(screen.getByTestId('save-ok')).toBeTruthy());
        expect(exportCalls()).toHaveLength(1);
        expect(exportCalls()[0].set_points).toEqual({ lower: 1, upper: 9 }); // the same set points: only the files are renewed
        const written = await hsLastModel();
        expect(written.status).toBe(true);
        expect(written.healthExport.scoringIntervalSecs).toBe(3600);
        expect(written.healthExport.at).not.toBe(earlier.at);
        expect(written.healthExport.setPoints).toMatchObject({ lower: 1, upper: 9 });
        expect(hint()).toBeNull();
        expect(again()).toBeNull();
        expect(screen.getByTestId('footer-pill').textContent).toBe('Complete');
    });

    it('no hint for a record that carries the interval, for a Complete model with no record at all, and on the Model fit page', async () => {
        await hsMount([HS_IND({ status: true, healthExport: current })]);
        await openHealthPage();
        expect(hint()).toBeNull();
        expect(again()).toBeNull();
        expect(screen.getByTestId('save-ok')).toBeTruthy();
        cleanup();

        await hsMount([HS_IND({ status: true })]); // completed before export records existed: nothing saved to be out of date
        await openHealthPage();
        expect(hint()).toBeNull();
        expect(again()).toBeNull();
        cleanup();

        // the hint belongs to the Health score page: the Model fit footer keeps its own sentence and has no filled button
        await hsMount([HS_IND({ status: true, healthExport: earlier })]);
        await waitFor(() => expect(screen.getByTestId('results-chart')).toBeTruthy());
        expect(hint()).toBeNull();
        expect(again()).toBeNull();
        expect(screen.getByTestId('wb-footer').getAttribute('data-primary')).toBe('none');
        expect(screen.getByTestId('wb-footer').textContent).not.toMatch(/row-by-row/);
    });

    it('only a COMPLETE model: an Incomplete one with the same old record shows plain "Mark complete"; marking a Complete one incomplete removes the hint', async () => {
        await hsMount([HS_IND({ status: false, healthExport: earlier })]);
        await openHealthPage();
        expect(hint()).toBeNull();
        expect(again()).toBeNull();
        expect(screen.getByTestId('mark-complete')).toBeTruthy();
        cleanup();

        await hsMount([HS_IND({ status: true, healthExport: earlier })]);
        await openHealthPage();
        await waitFor(() => expect(hint()).not.toBeNull());
        await act(async () => { fireEvent.click(screen.getByTestId('mark-incomplete')); await Promise.resolve(); await Promise.resolve(); });
        await flush();
        expect((await hsLastModel()).status).toBe(false);
        expect((await hsLastModel()).healthExport).toEqual(earlier); // the old record is kept as it was
        expect(hint()).toBeNull();
        expect(again()).toBeNull();
        expect(screen.getByTestId('mark-complete')).toBeTruthy();
    });

    it('set points ALSO changed after saving: the "Files out of date" sentence says it (one sentence, one button) — Mark complete again fixes both', async () => {
        await hsMount([HS_IND({ status: true, healthExport: earlier })]);
        await openHealthPage();
        await waitFor(() => expect(hint()).not.toBeNull());
        hsType('sp-upper', '12');
        expect(hint()).toBeNull();
        expect(screen.getByTestId('files-out-of-date').textContent).toBe('Files out of date — set points changed after saving · Mark complete again to update them');
        expect(screen.getAllByTestId('mark-complete-again')).toHaveLength(1);
        await waitFor(() => expect(again()!.disabled).toBe(false));
        await act(async () => { fireEvent.click(again()!); await Promise.resolve(); });
        await waitFor(() => expect(screen.getByTestId('save-ok')).toBeTruthy());
        const written = await hsLastModel();
        expect(written.healthExport.setPoints).toMatchObject({ upper: 12 });
        expect(written.healthExport.scoringIntervalSecs).toBe(3600);
        expect(hint()).toBeNull();
        expect(screen.queryByTestId('files-out-of-date')).toBeNull();
        expect(again()).toBeNull();
    });
});

describe('Health score page - status pills and dots follow the verdict Rust gave', () => {
    it('trained with empty set points: tab pill "Set points needed" (yellow dot)', async () => {
        await hsMount([HS_IND({ healthSetPoints: HS_EMPTY_IND })]);
        await waitFor(() => expect(screen.getByTestId('tab-status-m1').getAttribute('title')).toBe('Set points needed'));
        expect(screen.getByTestId('tab-status-m1').className).toMatch(/f4-sdot--need/);
        expect(screen.getByTestId('sensor-kind-badge-dot-m1').className).toMatch(/f4-kb-dot--need/);
    });

    it('a rejected set point: "Fix set point" (red pill, red dot); the central dot state stays "trained"', async () => {
        await hsMount([HS_IND({ healthSetPoints: { kind: 'individual', lower: 3, upper: 9, masterLower: null, masterUpper: null } })]);
        await waitFor(() => expect(screen.getByTestId('tab-status-m1').getAttribute('title')).toBe('Fix set point'));
        expect(screen.getByTestId('tab-status-m1').className).toMatch(/f4-sdot--bad/);
        const dot = screen.getByTestId('sensor-kind-badge-dot-m1');
        expect(dot.className).toMatch(/f4-kb-dot--bad/);
        expect(dot.getAttribute('data-state')).toBe('trained');
        expect(screen.getByTestId('sensor-kind-badge-m1').title).toMatch(/Fix set point/);
    });

    it('valid set points: the pill is "Trained"; typing a bad value turns it red live', async () => {
        await hsMount([HS_IND()]);
        await waitFor(() => expect(screen.getByTestId('tab-status-m1').getAttribute('title')).toBe('Trained'));
        expect(screen.getByTestId('tab-status-m1').getAttribute('title')).toBe('Trained');
        await openHealthPage();
        hsType('sp-lower', '3');
        await waitFor(() => expect(screen.getByTestId('tab-status-m1').getAttribute('title')).toBe('Fix set point'));
    });

    it('a stale model keeps the central stale state - no "set points" pill on top of "Re-train"', async () => {
        await hsMount([{ ...HS_IND({ healthSetPoints: HS_EMPTY_IND }), trainedFingerprint: 'old' }]);
        expect(screen.getByTestId('tab-status-m1').getAttribute('title')).toBe('Re-train needed');
    });
});

describe('Health score page - edge cases', () => {
    it('a stale model never shows the Health score page, so Mark complete cannot be reached', async () => {
        await hsMount([{ ...HS_IND(), trainedFingerprint: 'old' }]);
        expect((screen.getByTestId('next-health-score') as HTMLButtonElement).disabled).toBe(true);
        expect(screen.queryByTestId('mark-complete')).toBeNull();
    });

    it('a failed run this session blocks the Health score page ("Re-train first")', async () => {
        mockInvoke.mockImplementation((cmd: string, args?: any) => cmd === 'compute_sensor_stats' ? Promise.reject(new Error('dataset not loaded')) : healthInvoke(cmd, args));
        statefulUpdateMock([HS_IND()]);
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [HS_IND()] } });
        await flush();
        await waitFor(() => expect((screen.getByTestId('next-health-score') as HTMLButtonElement).disabled).toBe(true));
        expect((screen.getByTestId('next-health-score') as HTMLButtonElement).title).toBe('Re-train first');
    });

    it('NOT_FITTED (Relationship fit gone from Rust\'s memory) on the Health score page: the board with "Load it again" + "Train sensor ↑", Mark complete disabled with that reason, Train sensor filled and Mark complete a ghost', async () => {
        mockInvoke.mockImplementation((cmd: string, args?: any) => cmd === 'compute_health_preview'
            ? Promise.reject('NOT_FITTED: no fitted model for this key') : healthInvoke(cmd, args));
        const rel = HS_REL();
        statefulUpdateMock([rel]);
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel] } });
        await fitGoneSettled(); // (the fit is re-filled once automatically first; the mock keeps answering NOT_FITTED)
        fireEvent.click(screen.getByTestId('next-health-score'));
        await waitFor(() => expect(screen.getByTestId('health-not-fitted')).toBeTruthy());
        await waitFor(() => expect(screen.getByTestId('mark-block-reason').textContent).toBe('Fit no longer in memory · load it again, or re-train with Train sensor ↑'));
        const board = screen.getByTestId('health-not-fitted');
        expect(board.querySelector('.wbx-msg-t')!.textContent).toBe('Fit no longer in memory');
        expect(board.querySelector('.wbx-msg-s')!.textContent).toBe('The fitted Relation model is no longer in memory (the data was reloaded, a special sensor changed, or many Relation models were opened). Nothing about the model changed — Load it again, or re-train it with Train sensor ↑. Your set points are kept and scored again when it is loaded.');
        expect(within(board).getByTestId('health-load-fit').textContent).toBe('Load it again');
        expect(screen.queryByTestId('health-not-fitted-retrain')).toBeNull();
        expect(within(screen.getByTestId('health-page')).queryByRole('button', { name: /Re-train/ })).toBeNull();
        // the reason is in the footer, with the link to the one place to train
        const why = screen.getByTestId('mark-block-reason');
        const mark = screen.getByTestId('mark-complete') as HTMLButtonElement;
        expect(mark.disabled).toBe(true);
        expect(mark.title).toBe('Fit no longer in memory · load it again, or re-train with Train sensor ↑');
        expect(within(why).getByTestId('footer-load-fit').textContent).toBe('load it again');
        // ONE filled button: this model must train again -> Train sensor; Mark complete is a ghost
        expect(screen.getByTestId('wb-footer').getAttribute('data-primary')).toBe('train');
        expect(trainSensorBtn().className).toContain('rcx-btn--pri');
        expect(mark.className).toBe('rcx-btn');
        expect(screen.getByTestId('footer-pill').textContent).toBe('Incomplete');
        // both links lead to Train sensor
        fireEvent.click(within(board).getByTestId('health-go-train-sensor'));
        expect(document.activeElement).toBe(trainSensorBtn());
        (document.activeElement as HTMLElement).blur();
        fireEvent.click(within(why).getByTestId('footer-train-sensor'));
        expect(document.activeElement).toBe(trainSensorBtn());
    });

    // The Health score page half.
    it('a COMPLETE Relation model whose fit is gone, on the Health score page: only "Load it again" (board and footer); a load that fails says why; loading it brings the set points back — still Complete, nothing re-trained', async () => {
        let gone = true;
        let fitMode: 'ok' | 'hold' | 'fail' = 'ok';
        let release: () => void = () => {};
        mockInvoke.mockImplementation((cmd: string, args?: any) => {
            if (cmd === 'compute_health_preview' && gone) return Promise.reject('NOT_FITTED: no fitted model for this key');
            if (cmd === 'preview_relationship_model' && fitMode === 'fail') return Promise.reject(new Error('the engine stopped'));
            if (cmd === 'preview_relationship_model' && fitMode === 'hold') return new Promise(res => { release = () => res(healthInvoke(cmd, args)); });
            return healthInvoke(cmd, args);
        });
        const sp = { kind: 'relationship', residualAt80Lower: -1.5, residualAt80Upper: 1.5, residualAt0Lower: -3, residualAt0Upper: 3 };
        const rel = HS_REL({ status: true, healthSetPoints: sp, healthExport: { at: '2026-10-04T01:00:00.000Z', outputDir: 'C:/data/workspaces/ws1/output', setPoints: sp, scoringIntervalSecs: 3600 } });
        statefulUpdateMock([rel]);
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel] } });
        await fitGoneSettled();
        fireEvent.click(screen.getByTestId('next-health-score'));
        await waitFor(() => expect(screen.getByTestId('health-not-fitted')).toBeTruthy());
        const board = () => screen.getByTestId('health-not-fitted');
        const fits = () => mockInvoke.mock.calls.filter(c => c[0] === 'preview_relationship_model');
        const before = fits().length;
        expect(board().querySelector('.wbx-msg-s')!.textContent).toBe('The fitted Relation model is no longer in memory (the data was reloaded, a special sensor changed, or many Relation models were opened). Nothing about the model changed — Load it again. Your set points are kept and scored again when it is loaded.');
        expect(within(board()).queryByTestId('health-go-train-sensor')).toBeNull();
        expect(within(board()).getAllByRole('button')).toHaveLength(1);
        expect(trainSensorBtn().disabled).toBe(true); // "0 of 1 · up to date": it could not have trained it
        expect(screen.getByTestId('footer-pill').textContent).toBe('Complete');
        const line = () => screen.getByTestId('footer-status');
        expect(line().textContent).toBe('Fit no longer in memory · load it again');
        expect(within(line()).queryByTestId('footer-train-sensor')).toBeNull();
        expect(screen.queryByTestId('mark-complete')).toBeNull();
        mockUpdateWorkspaceData.mockClear();

        // a load that fails
        fitMode = 'fail';
        await act(async () => { fireEvent.click(within(board()).getByTestId('health-load-fit')); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
        await waitFor(() => expect(board().querySelector('.wbx-msg-d')).not.toBeNull());
        expect(board().querySelector('.wbx-msg-d')!.textContent).toBe('The last attempt did not work: the engine stopped');
        expect(screen.getByTestId('footer-pill').textContent).toBe('Complete');
        expect(line().textContent).toBe('Fit no longer in memory · load it again');

        // the footer's link does the same; this time it loads
        fitMode = 'hold';
        await act(async () => { fireEvent.click(within(line()).getByTestId('footer-load-fit')); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
        await waitFor(() => expect(screen.getByTestId('health-loading')).toBeTruthy());
        expect(screen.getByTestId('health-loading').querySelector('.wbx-msg-t')!.textContent).toBe('Loading the Relation model…');
        expect(screen.queryByTestId('health-not-fitted')).toBeNull();
        expect(fits()).toHaveLength(before + 2);
        expect((fits().pop()![1] as any).cache_key).toBe(`r1::${rel.trainedFingerprint}`);
        gone = false;
        fitMode = 'ok';
        await act(async () => { release(); await Promise.resolve(); await Promise.resolve(); });
        await waitFor(() => expect(screen.getByTestId('set-points-card')).toBeTruthy());
        await waitFor(() => expect(screen.getByTestId('save-ok')).toBeTruthy()); // "Files saved …" again
        expect(screen.getByTestId('footer-pill').textContent).toBe('Complete');
        expect(screen.getByTestId('mark-incomplete')).toBeTruthy();
        expect(mockInvoke.mock.calls.filter(c => c[0] === 'export_model_files')).toHaveLength(0);
        for (const r of mockUpdateWorkspaceData.mock.results) {
            const m = (await r.value).failureGroupState.models[0];
            expect(m.status).toBe(true);
            expect(m.lastTrainedAt).toBe(rel.lastTrainedAt);
            expect(m.trainedFingerprint).toBe(rel.trainedFingerprint);
        }
    });
});

// The persisted validation verdict, the
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
            await waitFor(() => expect(screen.getByTestId('tab-status-m1').getAttribute('title')).toBe('Fix set point')); // live
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
// Train periods and scoring periods ("just score it"): the Running condition
// modal's Apply gate, the workspace scoring periods (start → end only: no
// label, no event time, no "From Highlights"), Mark complete needing a scoring
// period, the "Scored · N" footer pill and the "Scoring periods changed"
// notice under the Step-1 card.
// ─────────────────────────────────────────────────────────────────────────
describe('Train periods and scoring periods in the Build Model window', () => {
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

        it('a scoring period that ends before it starts is red and blocks Apply; fixing it unblocks, Apply saves the period as id / start / end only', async () => {
            await openModal(fgBase());
            const dlg = within(screen.getByRole('dialog', { name: 'Running condition' }));
            const end = () => dlg.getByLabelText('Scoring period 1 end');
            fireEvent.change(end(), { target: { value: '2023-12-01T00:00' } });
            fireEvent.blur(end());
            expect(dlg.getByTestId('test-invalid-1').textContent).toMatch(/^S1 ends before it starts — pick an end after /);
            expect(dlg.getByTestId('test-row-1').getAttribute('data-invalid')).toBe('true');
            expect(apply().disabled).toBe(true);
            expect(screen.getByTestId('rc-apply-block').getAttribute('data-kind')).toBe('invalid-test');
            expect(screen.getByTestId('rc-apply-block').textContent).toBe('Fix S1 before applying');
            fireEvent.click(apply());
            await flush();
            expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();

            fireEvent.change(end(), { target: { value: '2024-01-20T06:00' } });
            fireEvent.blur(end());
            expect(dlg.queryByTestId('test-invalid-1')).toBeNull();
            expect(apply().disabled).toBe(false);
            fireEvent.click(apply());
            await flush();
            const fg = await lastWrittenFg();
            expect(fg.runningConditionTestPeriods).toEqual([{ id: ONE_TEST[0].id, start: ONE_TEST[0].start, end: '2024-01-20T06:00' }]);
            expect(screen.queryByRole('dialog', { name: 'Running condition' })).toBeNull();
            // the card (Details) shows the persisted period as a plain S1 chip
            fireEvent.click(screen.getByTestId('rc-card-details'));
            expect(screen.getByTestId('rc-card-test-chip').textContent).toBe('S1 · 2024/01/01 00:00 → 2024/01/20 06:00');
            expect(screen.queryByTestId('rc-card-test-event')).toBeNull();
        });

        it('a scoring period overlapping the train period is information only: one quiet note, Apply still allowed', async () => {
            await openModal(fgBase());
            const dlg = within(screen.getByRole('dialog', { name: 'Running condition' }));
            // ONE_TEST (Jan 2024) lies inside the train period (Jan 2024)
            expect(dlg.getByTestId('test-overlap-1').textContent).toContain('S1 includes 31 d of train running time');
            fireEvent.click(dlg.getByTestId('test-add'));
            expect(apply().disabled).toBe(false);
            expect(screen.queryByTestId('rc-apply-block')).toBeNull();
        });

        it('the modal has no label control, no event time and no "From Highlights" for scoring periods — even when the Dashboard has highlights', async () => {
            const hl = { id: 'h1', start: '2024-03-01 00:00:00', end: '2024-03-05 00:00:00', label: 'Seal leak', color: '#f43f5e', enabled: true };
            await openModal(fgBase(), { timeHighlights: [hl] });
            const dlg = within(screen.getByRole('dialog', { name: 'Running condition' }));
            expect(dlg.getByTestId('rc-test-head').querySelector('b')!.textContent).toBe('Scoring periods');
            expect(dlg.getByTestId('test-row-1').querySelector('.tpe-pn')!.textContent).toBe('S1');
            expect(dlg.queryByTestId('test-from-hl')).toBeNull();
            expect(dlg.queryByTestId('test-hl-menu')).toBeNull();
            expect(dlg.queryByTestId('test-label-normal-1')).toBeNull();
            expect(dlg.queryByTestId('test-label-problem-1')).toBeNull();
            expect(dlg.queryByLabelText(/event time/i)).toBeNull();
            const text = screen.getByRole('dialog', { name: 'Running condition' }).textContent ?? '';
            expect(text).not.toMatch(/Known problem|From Highlights|event time|lead time|Test period|Seal leak/i);
            // the highlight is still read (it feeds the TRAIN-overlap warning only) and nothing is written onto it
            fireEvent.click(dlg.getByTestId('test-add'));
            fireEvent.click(apply());
            await flush();
            const written = (await mockUpdateWorkspaceData.mock.results[0].value);
            expect(written.failureGroupState.runningConditionTestPeriods).toHaveLength(2);
            for (const t of written.failureGroupState.runningConditionTestPeriods) expect(Object.keys(t).sort()).toEqual(['end', 'id', 'start']);
            expect(written.timeHighlights ?? [hl]).toEqual([hl]);
        });

        describe('a workspace saved before 2026-10-10 (scoring periods with label / eventTime / fromHighlight)', () => {
            it('the Step-1 card and the modal show plain S1 / S2 — no label, no event time, no error, Apply not armed', async () => {
                await openModal(fgBase({ runningConditionTestPeriods: LEGACY_TESTS }));
                expect(screen.getByTestId('rc-card-test').textContent).toBe('Scoring 2 periods'); // the one line
                fireEvent.click(screen.getByTestId('rc-card-details'));
                expect(screen.getAllByTestId('rc-card-test-chip').map(c => c.textContent)).toEqual([
                    'S1 · 2024/01/01 00:00 → 2024/01/31 23:59',
                    'S2 · 2024/03/01 00:00 → 2024/03/31 23:59',
                ]);
                const dlg = within(screen.getByRole('dialog', { name: 'Running condition' }));
                expect(dlg.getAllByTestId(/^test-row-\d+$/).map(r => r.querySelector('.tpe-pn')!.textContent)).toEqual(['S1', 'S2']);
                expect(dlg.getByTestId('rc-caption-scoring').textContent).toMatch(/^\d+ d scoring$/);
                expect(screen.getByRole('dialog', { name: 'Running condition' }).textContent).not.toMatch(/Known problem|Bearing failure|event time/i);
                expect(dlg.queryByTestId('test-invalid-1')).toBeNull();
                expect(dlg.queryByTestId('test-invalid-2')).toBeNull();
                // merely opening it is not an edit: nothing to apply, and closing asks nothing
                expect(apply().disabled).toBe(true);
                expect(screen.queryByTestId('rc-dirty-hint')).toBeNull();
                fireEvent.blur(dlg.getByLabelText('Scoring period 2 end'));
                expect(apply().disabled).toBe(true);
                expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
            });

            it('after editing ONE period and Apply, the saved list has only id / start / end on EVERY period', async () => {
                await openModal(fgBase({ runningConditionTestPeriods: LEGACY_TESTS }));
                const dlg = within(screen.getByRole('dialog', { name: 'Running condition' }));
                const end = dlg.getByLabelText('Scoring period 1 end');
                fireEvent.change(end, { target: { value: '2024-01-20T00:00' } });
                fireEvent.blur(end);
                expect(apply().disabled).toBe(false);
                fireEvent.click(apply());
                await flush();
                const fg = await lastWrittenFg();
                expect(fg.runningConditionTestPeriods).toEqual([
                    { id: 'old-1', start: '2024-01-01T00:00', end: '2024-01-20T00:00' },
                    { id: 'old-2', start: '2024-03-01T00:00', end: '2024-03-31T23:59' },
                ]);
            });

            it('editing something ELSE in the modal (a train period) and Apply also saves the scoring periods without the legacy keys', async () => {
                await openModal(fgBase({ runningConditionTestPeriods: LEGACY_TESTS }));
                const dlg = within(screen.getByRole('dialog', { name: 'Running condition' }));
                const end = dlg.getByLabelText('P1 end');
                fireEvent.change(end, { target: { value: '2024-01-25T00:00' } });
                fireEvent.blur(end);
                fireEvent.click(apply());
                await flush();
                const fg = await lastWrittenFg();
                expect(fg.runningConditionTimePeriods[0].end).toBe('2024-01-25T00:00');
                for (const t of fg.runningConditionTestPeriods) expect(Object.keys(t).sort()).toEqual(['end', 'id', 'start']);
                expect(fg.runningConditionTestPeriods.map((t: any) => t.id)).toEqual(['old-1', 'old-2']);
            });

            it('the preview / export requests carry start / end only (the fake Rust refuses anything else)', async () => {
                await hsMount([HS_IND()], {}, { runningConditionTestPeriods: LEGACY_TESTS });
                await openHealthPage();
                await waitFor(() => expect(hsMarkBtn().disabled).toBe(false));
                expect(healthCalls().slice(-1)[0].test_periods).toEqual([
                    { start: '2024-01-01T00:00', end: '2024-01-31T23:59' },
                    { start: '2024-03-01T00:00', end: '2024-03-31T23:59' },
                ]);
                expect(screen.queryByTestId('scored-pill')).toBeNull(); // no pill: the Model fit footer sentence says "scored on 2 periods"
                await hsClickMark();
                await waitFor(() => expect(exportCalls()).toHaveLength(1));
                expect(exportCalls()[0].test_periods).toEqual(healthCalls().slice(-1)[0].test_periods);
            });
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

        // Test gap. Opening the modal is now the ONLY moment the Dashboard
        // highlights are re-read (the scoring-period "From Highlights" menu, which also re-read
        // them, is gone) - so a highlight the Dashboard added AFTER this window opened must show
        // up the next time the modal opens, and one it removed must be gone the time after.
        it('the Dashboard highlights are re-read each time the modal opens: one added after this window opened raises the warning, one removed since is gone on the next open', async () => {
            const fg = fgBase();
            const hl = { id: 'h1', start: '2024-01-10 00:00:00', end: '2024-01-12 00:00:00', label: 'Trip', color: '#f43f5e', enabled: true };
            const disk = (timeHighlights: unknown[]) => ({ id: 'ws1', failureGroupState: fg, timeHighlights });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: fg }); // hydration: the workspace has NO highlight yet
            statefulUpdateMock(fg.models, fg);
            const modal = () => screen.getByRole('dialog', { name: 'Running condition' });

            // The Dashboard adds a highlight (on disk). The closed window does not poll for it.
            mockLoadWorkspaceData.mockResolvedValue(disk([hl]));
            const loads = mockLoadWorkspaceData.mock.calls.length;
            await flush();
            expect(mockLoadWorkspaceData.mock.calls.length).toBe(loads);

            fireEvent.click(screen.getByTestId('rc-card-open'));
            await waitFor(() => expect(within(modal()).getByTestId('train-hl-warning').textContent).toContain('Train P1 overlaps the highlight “Trip”'));
            expect(mockLoadWorkspaceData.mock.calls.length).toBe(loads + 1);
            expect(mockLoadWorkspaceData.mock.calls[loads][0]).toBe('ws1');
            // Re-reading is not an edit: nothing to apply, nothing written.
            expect(apply().disabled).toBe(true);
            expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();

            // Close, the Dashboard deletes the highlight, reopen: read again, warning gone.
            fireEvent.click(within(modal()).getByLabelText('Close'));
            expect(screen.queryByRole('dialog', { name: 'Running condition' })).toBeNull();
            mockLoadWorkspaceData.mockResolvedValue(disk([]));
            fireEvent.click(screen.getByTestId('rc-card-open'));
            await waitFor(() => expect(mockLoadWorkspaceData.mock.calls.length).toBe(loads + 2));
            await waitFor(() => expect(within(modal()).queryByTestId('train-hl-warning')).toBeNull());
            expect(within(modal()).getAllByTestId(/^period-row-/)).toHaveLength(1); // the train period itself was never touched
        });

        it('a failed re-read keeps the last highlights (the warning stays) and the modal still opens', async () => {
            const fg = fgBase();
            const hl = { id: 'h1', start: '2024-01-10 00:00:00', end: '2024-01-12 00:00:00', label: 'Trip', color: '#f43f5e', enabled: true };
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: fg, timeHighlights: [hl] });
            statefulUpdateMock(fg.models, fg);
            mockLoadWorkspaceData.mockRejectedValue(new Error('file is locked'));
            fireEvent.click(screen.getByTestId('rc-card-open'));
            await flush();
            const dlg = within(screen.getByRole('dialog', { name: 'Running condition' }));
            expect(dlg.getByTestId('train-hl-warning').textContent).toContain('Trip');
        });
    });

    describe('Mark complete needs a scoring period; "Scored · N" in the footer only', () => {
        it('no scoring period: Mark complete is disabled with the reason, and clicking exports nothing', async () => {
            await hsMount([HS_IND()], {}, { runningConditionTestPeriods: [] });
            await openHealthPage();
            await waitFor(() => expect(screen.getByTestId('mark-block-reason').textContent).toBe(NO_TEST_PERIOD_REASON));
            expect(NO_TEST_PERIOD_REASON).toBe('Add a scoring period before marking complete (Running condition → Edit).');
            expect(hsMarkBtn().disabled).toBe(true);
            expect(hsMarkBtn().title).toBe(NO_TEST_PERIOD_REASON);
            await hsClickMark();
            expect(exportCalls()).toHaveLength(0);
            expect(screen.queryByTestId('scored-pill')).toBeNull();
        });

        it('with a scoring period: Mark complete is enabled, the requests carry test_periods as start / end only, and the footer SENTENCE says "scored on 1 period" (no pill)', async () => {
            await hsMount([HS_IND()]);
            // Model fit footer of a trained model: ONE sentence — trained when, scored on how many periods, what is next.
            expect(screen.getByTestId('footer-status').textContent).toMatch(/^Trained \d{4}\/\d{2}\/\d{2} \d{2}:\d{2} · scored on 1 period · check the charts, then set the health set points$/);
            expect(screen.getByTestId('footer-status').querySelector('.wbx-dt')).not.toBeNull();
            await openHealthPage();
            await waitFor(() => expect(hsMarkBtn().disabled).toBe(false));
            expect(screen.getByTestId('footer-status').textContent).toBe('Set points valid — check the score chart, then Mark complete');
            expect(screen.queryByTestId('scored-pill')).toBeNull();
            expect(screen.queryByTestId('tested-pill')).toBeNull();
            expect(healthCalls().slice(-1)[0].test_periods).toEqual([{ start: ONE_TEST[0].start, end: ONE_TEST[0].end }]);
            await hsClickMark();
            await waitFor(() => expect(exportCalls()).toHaveLength(1));
            expect(exportCalls()[0].test_periods).toEqual([{ start: ONE_TEST[0].start, end: ONE_TEST[0].end }]);
            // once Complete, the Model fit footer keeps saying it — still one sentence, one pill
            await waitFor(() => expect(screen.getByTestId('mark-incomplete')).toBeTruthy());
            fireEvent.click(screen.getByTestId('footer-back-to-fit'));
            expect(screen.getByTestId('footer-status').textContent).toMatch(/^Trained \d{4}\/\d{2}\/\d{2} \d{2}:\d{2} · scored on 1 period$/);
            expect(screen.getByTestId('wb-footer').querySelectorAll('.f4-pill')).toHaveLength(0);
            expect(screen.queryByTestId('scored-pill')).toBeNull();
        });

        it('an untrained model says nothing about scoring', async () => {
            await hsMount([makeModel()]);
            expect(screen.queryByTestId('scored-pill')).toBeNull();
            expect(screen.getByTestId('footer-status').textContent).toBe('Not trained yet · Train sensor ↑');
        });
    });

    describe('"Scoring periods changed"', () => {
        it('a notice under the Step-1 card counts the models that need Mark complete again', async () => {
            await hsMount([HS_IND({ status: false, testsChangedAt: '2026-10-07T01:00:00.000Z' })]);
            expect(screen.getByTestId('tests-changed-notice').textContent)
                .toBe('Scoring periods changed — 1 complete model needs Mark complete again. It was re-scored with the same trained model, not re-trained.');
        });

        it('the Health score page shows the banner; "removed" when no scoring period is left', async () => {
            await hsMount([HS_IND({ status: false, testsChangedAt: '2026-10-07T01:00:00.000Z' })], {}, { runningConditionTestPeriods: [] });
            expect(screen.getByTestId('tests-changed-notice').textContent).toContain('Scoring periods removed');
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

    describe('Custom mode: the model\'s own scoring periods live in Model settings', () => {
        it('switching to Custom shows the scoring periods editor next to the train periods; edits stay in the draft until Save', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: fgBase({ runningConditionNoneConfirmed: true }) });
            statefulUpdateMock([makeModel()], fgBase({ runningConditionNoneConfirmed: true }));
            openSettings();
            fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
            const tests = within(screen.getByTestId('custom-test-periods'));
            expect(screen.getByTestId('custom-test-periods').textContent).toContain('Scoring periods');
            expect(screen.getByTestId('custom-test-periods').textContent).not.toMatch(/Test periods|From Highlights|Known problem/);
            expect(tests.getByTestId('test-periods-editor').className).toBe('tpe-periods'); // the same rows as the workspace settings
            expect(tests.queryByTestId('test-from-hl')).toBeNull();
            fireEvent.click(tests.getByLabelText('Remove scoring period 1'));
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

// Train / scoring periods ("just score it": no label, no event time).
describe('Train periods and scoring periods — review fixes (2026-10-07)', () => {
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
        it('a Custom model with an UNSAVED scoring-period edit: Mark complete succeeds once, files written once, disk has the edited periods', async () => {
            await hsMount([customInd()]);
            openSettings();
            const end = customTests().getByLabelText('Scoring period 1 end');
            fireEvent.change(end, { target: { value: '2024-01-25T00:00' } });
            fireEvent.blur(end);
            await openHealthPage();
            await waitFor(() => expect(hsMarkBtn().disabled).toBe(false));
            await hsClickMark();
            await waitFor(() => expect(screen.getByTestId('save-ok')).toBeTruthy());
            expect(screen.queryByTestId('save-error')).toBeNull();
            // the files describe the edited periods, and were written exactly once
            expect(exportCalls()).toHaveLength(1);
            expect(exportCalls()[0].test_periods).toEqual([{ start: ONE_TEST[0].start, end: '2024-01-25T00:00' }]);
            // what is on disk: Complete, with the edited periods (id / start / end only), no "changed" stamp left
            const fg = await lastFg();
            expect(fg.models[0].status).toBe(true);
            expect(fg.models[0].customTestPeriods).toEqual([{ id: ONE_TEST[0].id, start: ONE_TEST[0].start, end: '2024-01-25T00:00' }]);
            expect(fg.models[0].testsChangedAt).toBeUndefined();
            expect(fg.models[0].healthExport).toBeTruthy();
        });

    });

    describe('Custom scoring periods are validated on Save (should-fix 2a)', () => {
        it('a scoring period that ends before it starts blocks Save changes (and Train) with the reason; the editor says "to save"', async () => {
            await hsMount([customInd()]);
            openSettings();
            const end = () => customTests().getByLabelText('Scoring period 1 end');
            fireEvent.change(end(), { target: { value: '2023-12-01T00:00' } });
            fireEvent.blur(end());
            expect(customTests().getByTestId('test-invalid-1').textContent).toMatch(/^S1 ends before it starts — pick an end after /);
            const save = screen.getByText('Save changes') as HTMLButtonElement;
            expect(save.disabled).toBe(true);
            // the footer says it like the workspace settings do ("Fix S1 before applying"), with
            // "saving" — this model's own lists are saved with Save changes; the reason is on the
            // row (above) and on the disabled button
            expect(screen.getByTestId('build-block-reason').textContent).toBe('Fix S1 before saving');
            expect(save.title).toBe('S1 ends before it starts.');
            mockUpdateWorkspaceData.mockClear();
            fireEvent.click(save);
            await flush();
            expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
            // fixing the date lifts the block
            fireEvent.change(end(), { target: { value: '2024-01-20T06:00' } });
            fireEvent.blur(end());
            expect((screen.getByText('Save changes') as HTMLButtonElement).disabled).toBe(false);
        });

        it('a Custom model of a workspace saved before 2026-10-10: plain S1 / S2 rows, and Save changes after editing one writes id / start / end only', async () => {
            await hsMount([customInd({ customTestPeriods: LEGACY_TESTS })]);
            openSettings();
            expect(customTests().getAllByTestId(/^test-row-\d+$/).map(r => r.querySelector('.tpe-pn')!.textContent)).toEqual(['S1', 'S2']);
            expect(screen.getByTestId('custom-test-periods').textContent).not.toMatch(/Known problem|Bearing failure|event/i);
            // a legacy event time is not validated any more
            expect(screen.queryByTestId('build-block-reason')).toBeNull();
            const end = customTests().getByLabelText('Scoring period 2 end');
            fireEvent.change(end, { target: { value: '2024-03-20T00:00' } });
            fireEvent.blur(end);
            await act(async () => {
                fireEvent.click(screen.getByText('Save changes'));
                await Promise.resolve(); await Promise.resolve();
            });
            const fg = await lastFg();
            expect(fg.models[0].customTestPeriods).toEqual([
                { id: 'old-1', start: '2024-01-01T00:00', end: '2024-01-31T23:59' },
                { id: 'old-2', start: '2024-03-01T00:00', end: '2024-03-20T00:00' },
            ]);
        });

        it('a Workspace-mode model is never blocked by its (unused) custom scoring list', async () => {
            await hsMount([withTrained(makeModel({ healthSetPoints: HS_SNAP, customTestPeriods: [{ ...ONE_TEST[0], end: '' }] }))]);
            expect(screen.queryByTestId('build-block-reason')).toBeNull();
        });
    });

    // Test gap: the Custom editor in Model settings has its OWN copy of the
    // train-vs-highlight warning, fed by the model's own train periods and writing into the
    // model's DRAFT (Save changes commits it) - it was only tested for the workspace modal.
    describe('a Custom model\'s own train periods against the Dashboard highlights (test gap)', () => {
        // CUSTOM_TRAIN is 2024/01/01 -> 2024/01/11; the highlight sits inside it.
        const HL = { id: 'h1', start: '2024-01-05 00:00:00', end: '2024-01-07 00:00:00', label: 'Trip', color: '#f43f5e', enabled: true };
        const customPeriods = () => within(screen.getByTestId('custom-periods'));
        const mountCustom = async (model: any, timeHighlights: unknown[]) => {
            mockInvoke.mockImplementation(healthInvoke);
            statefulUpdateMock([model]);
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [model] }, timeHighlights });
            openSettings();
        };

        it('the warning names the model\'s own train period; "Remove the overlap" splits it in the DRAFT only, and Save changes writes the two periods to the model (workspace list untouched)', async () => {
            await mountCustom(customInd(), [HL]);
            // Only the Custom editor's warning is on screen (the workspace's own all-time train
            // period overlaps the highlight too, but that one lives in the closed modal).
            expect(screen.getAllByTestId('train-hl-warning')).toHaveLength(1);
            expect(customPeriods().getByTestId('train-hl-warning').textContent).toContain('Train P1 overlaps the highlight “Trip”');
            expect(customPeriods().getAllByTestId(/^period-row-/)).toHaveLength(1);

            mockUpdateWorkspaceData.mockClear();
            fireEvent.click(customPeriods().getByTestId('train-hl-split'));
            expect(customPeriods().queryByTestId('train-hl-warning')).toBeNull();
            expect(customPeriods().getAllByTestId(/^period-row-/)).toHaveLength(2);
            // It went into the draft: nothing on disk yet, Save changes is armed.
            await flush();
            expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
            const save = screen.getByText('Save changes') as HTMLButtonElement;
            expect(save.disabled).toBe(false);

            await act(async () => { fireEvent.click(save); await Promise.resolve(); await Promise.resolve(); });
            const fg = await lastFg();
            expect(fg.models[0].filterTimePeriods.map((p: any) => [p.start, p.end])).toEqual([
                ['2024-01-01T00:00', '2024-01-04T23:59'],
                ['2024-01-07T00:01', '2024-01-11T00:00'],
            ]);
            expect(fg.models[0].filterTimePeriods[0].id).toBe('ct'); // the first half keeps the period's id
            expect(fg.models[0].runningConditionMode).toBe('custom');
            // the workspace's own train periods are not this editor's to change
            expect(fg.runningConditionTimePeriods).toEqual(ALL_TIME_TRAIN);
            // the model's scoring periods ride along unchanged
            expect(fg.models[0].customTestPeriods).toEqual(ONE_TEST);
            // and the saved result raises no warning any more
            expect(screen.queryByTestId('train-hl-warning')).toBeNull();
        });

        it('no warning for a highlight outside the model\'s own train periods, or a disabled one - even though the WORKSPACE train period overlaps both', async () => {
            const outside = { ...HL, id: 'h2', start: '2024-02-01 00:00:00', end: '2024-02-03 00:00:00', label: 'Later' };
            await mountCustom(customInd(), [outside, { ...HL, enabled: false }]);
            expect(screen.queryByTestId('train-hl-warning')).toBeNull();
            expect(customPeriods().getAllByTestId(/^period-row-/)).toHaveLength(1);
        });
    });

    describe('scoring results are numbered by their ORIGINAL list position (should-fix 2b)', () => {
        it('[S1 invalid, S2 valid]: only S2 is sent; the tile and its overlap note say "S2" — the Model fit chart names the train period only', async () => {
            const tests = [
                { id: 'bad', start: '2024-02-10T00:00', end: '2024-02-01T00:00' },
                { ...ONE_TEST[0], id: 'good' },
            ];
            mockInvoke.mockImplementation((cmd: string, args?: any) => {
                if (cmd === 'compute_health_preview') {
                    const req = args?.request;
                    return Promise.resolve(makeSetPointAwarePreview(req, {
                        test_validation: makeValidation({
                            // one result per period SENT, numbered by wire position. Each keeps the fixture's own
                            // start / end (inside the fixture's 5-point series).
                            tests: (req?.test_periods ?? []).map((_t: any, i: number) => makeTestResult({ index: i + 1, train_rows: 10, train_days: 2 })),
                        }),
                    }));
                }
                return healthInvoke(cmd, args);
            });
            const model = HS_IND();
            statefulUpdateMock([model], { runningConditionTestPeriods: tests });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [model], runningConditionTestPeriods: tests } });
            // Model fit: the time chart highlights the train period only (user decision 2026-10-12) — a scoring
            // period has no band and no name there, so its number is read off the Health score page below.
            // (The page has no "Train and scoring periods" table any more — removed 2026-10-11.)
            const strip = () => within(screen.getByTestId('chart-card-ts')).getByTestId('echarts-mock').getAttribute('data-strip');
            await waitFor(() => expect(strip()).toBe('TRAIN'));
            expect(healthCalls().slice(-1)[0].test_periods).toEqual([{ start: ONE_TEST[0].start, end: ONE_TEST[0].end }]);
            expect(screen.queryByTestId('train-test-card')).toBeNull();
            expect(screen.getByTestId('model-fit-individual').textContent).not.toMatch(/Train and scoring periods|includes 2 d of train running time/);
            await openHealthPage();
            // ... which has no per-period tiles either (the "Scoring results" card was removed 2026-10-12)
            expect(screen.queryByTestId('test-results')).toBeNull();
            expect(screen.queryByTestId('test-result-2')).toBeNull();
        });
    });

    describe('Relation model: Train also predicts the scoring periods\' rows; slow scoring says so (should-fix 3)', () => {
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

        it('Workspace mode sends the workspace scoring periods; Custom its own; none = no test_periods key — always start / end only', async () => {
            const ws = await trainArgs(relModel());
            expect(ws.test_periods).toEqual([{ start: ONE_TEST[0].start, end: ONE_TEST[0].end }]);
            expect(ws.cache_key).toMatch(/^r1::/);

            // the model's own list still carries a legacy label / event time: never sent
            const own = [{ id: 'o1', start: '2024-03-01T00:00', end: '2024-03-10T00:00', label: 'problem', eventTime: '2024-03-05T12:00' }];
            const custom = await trainArgs(relModel({ runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true, filterTimePeriods: CUSTOM_TRAIN, customTestPeriods: own }));
            expect(custom.test_periods).toEqual([{ start: '2024-03-01T00:00', end: '2024-03-10T00:00' }]);

            const none = await trainArgs(relModel(), { runningConditionTestPeriods: [] });
            expect(none).not.toHaveProperty('test_periods');
        });

        it('a Relation-model health preview that takes a while shows the "Calculating the health score" hint — with or without scoring periods; never for another kind', async () => {
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
            await waitFor(() => expect(screen.getByTestId('slow-test-scoring').textContent).toBe('Calculating the health score with the Relation model — this can take up to ~15 s.'), { timeout: 3000 });

            cleanup();
            mockInvoke.mockClear();
            statefulUpdateMock([rel], { runningConditionTestPeriods: [] });
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel], runningConditionTestPeriods: [] } });
            await waitFor(() => expect(healthCalls().length).toBeGreaterThan(0));
            // No scoring period: the engine still predicts the training hours, so the hint shows too.
            expect(screen.queryByTestId('slow-test-scoring')).toBeNull();
            await waitFor(() => expect(screen.getByTestId('slow-test-scoring')).toBeTruthy(), { timeout: 3000 });
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
        it('a Custom model with no scoring period gets the amber "Only N d" note from its own period count (the running days Rust counted — not an estimate from a sensor\'s row count)', async () => {
            const own = customInd({ customTestPeriods: [] });
            const ownPeriods = CUSTOM_TRAIN.map(p => ({ start: p.start || null, end: p.end || null }));
            mockInvoke.mockImplementation((cmd: string, args?: any) => {
                if (cmd === 'get_dataset_time_bounds') return Promise.resolve({ min: '2024-01-01 00:00:00', max: '2024-04-10 00:00:00' }); // 100 days
                if (cmd === 'count_period_rows') {
                    // the model's OWN train periods run 10 d; the workspace's (the card) 60 d
                    const mine = JSON.stringify(args?.periods) === JSON.stringify(ownPeriods);
                    const base = fakePeriodCounts(args);
                    return Promise.resolve({ ...base, union: { ...base.union, running_days: mine ? 10 : 60 } });
                }
                return healthInvoke(cmd, args);
            });
            statefulUpdateMock([own]);
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [own] } });
            await waitFor(() => expect(screen.getByTestId('train-days-warning').textContent).toContain('Only 10 d of train running time'));
            expect(screen.getByTestId('train-days-warning').textContent).toContain('You can still train.');
            // ONE call for it (the train periods; Model settings is closed, so no scoring count),
            // and nothing through compute_sensor_stats but the model's own re-run
            expect(periodCountCalls().filter(c => JSON.stringify(c.periods) === JSON.stringify(ownPeriods))).toHaveLength(1);
        });
    });

    describe('re-pointing the window at another workspace (test gap)', () => {
        it('drops the old workspace scoring periods and Dashboard highlights at once (before the new one has loaded)', async () => {
            // A's highlight overlaps A's (all-time) train period: the amber TRAIN-overlap warning is how a highlight shows.
            const hl = { id: 'h1', start: '2024-03-01 00:00:00', end: '2024-03-05 00:00:00', label: 'Seal leak', color: '#f43f5e', enabled: true };
            render(<BuildModelWindow />);
            await deliverData({ timeHighlights: [hl] });
            fireEvent.click(screen.getByTestId('rc-card-details'));
            expect(screen.getAllByTestId('rc-card-test-chip')[0].textContent).toContain('S1 · ');
            fireEvent.click(screen.getByTestId('rc-card-open'));
            await flush();
            expect(screen.getByTestId('train-hl-warning').textContent).toContain('Seal leak');

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
            // B has nothing configured yet (its load is pending): no trace of A's S1 anywhere
            expect(screen.getByTestId('rc-card').getAttribute('data-state')).toBe('unset');
            expect(screen.queryByTestId('rc-card-test-chip')).toBeNull();
            fireEvent.click(screen.getByTestId('rc-card-open'));
            await flush();
            const dlg = within(screen.getByRole('dialog', { name: 'Running condition' }));
            expect(dlg.queryByTestId('test-row-1')).toBeNull();
            // ...and A's highlight is gone too: a train period added in B raises no overlap warning
            fireEvent.click(dlg.getByTestId('period-add'));
            expect(dlg.getAllByTestId(/^period-row-/)).toHaveLength(1);
            expect(dlg.queryByTestId('train-hl-warning')).toBeNull();
            expect(screen.getByRole('dialog', { name: 'Running condition' }).textContent).not.toContain('Seal leak');
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Train sensor / Train all with a queue:
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
        expect(screen.getByTestId('train-sensor-why').textContent).toBe('Trains Individual + Relation model · ≈ 16 s');
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

    // The ▾ menu says "Re-train" only about a model that has a
    // train record; the all-row says it only when EVERY model of the sensor has one.
    describe('Train sensor ▾ menu copy', () => {
        const openMenu = async () => { await flush(); fireEvent.click(screen.getByTestId('train-sensor-menu-toggle')); };
        const item = (key: string) => {
            const el = screen.getByTestId(`train-menu-${key}`);
            return { label: el.firstChild!.textContent, small: el.querySelector('small')!.textContent };
        };

        it('a never-trained sensor: "Train all 2 models", "Individual only", "Relation model only" — no "Re-train", no "up to date"', async () => {
            await mountModels([IND2(), REL2()]);
            await openMenu();
            // the all-row gives the time; it does NOT say "Includes up-to-date ones" (there are none)
            expect(item('retrain-all')).toEqual({ label: 'Train all 2 models', small: '≈ 16 s' });
            expect(item('only-individual')).toEqual({ label: 'Individual only', small: 'Not trained yet · ≈ 1 s' });
            expect(item('only-relationship')).toEqual({ label: 'Relation model only', small: 'Not trained yet · ≈ 15 s' });
            expect(screen.getByTestId('train-sensor-menu').textContent).not.toMatch(/re-train|up[- ]to[- ]date|Relationship/i);
        });

        it('a never-trained model that can\'t train keeps its reason, without "Re-train"', async () => {
            await mountModels([IND2(), REL2({ predictorSensors: [] })]);
            await openMenu();
            // the state line is the reason itself: it names the missing setting
            expect(item('only-relationship')).toEqual({ label: 'Relation model only', small: 'Add at least 1 predictor' });
            expect(item('retrain-all').small).toBe("≈ 1 s · 1 can't train, skipped");
            expect(screen.getByTestId('train-sensor-menu').textContent).not.toMatch(/Fill in the required fields/);
            expect((screen.getByTestId('train-menu-only-relationship') as HTMLButtonElement).disabled).toBe(true);
        });

        it('mixed (Individual trained, Relationship never): only the Individual row says "Re-train"; the all-row stays "Train all 2 models"', async () => {
            await mountModels([withTrained(IND2()), REL2()]);
            await openMenu();
            expect(item('retrain-all').label).toBe('Train all 2 models');
            expect(item('retrain-all').small).toBe('Includes the 1 up to date');
            expect(item('only-individual')).toEqual({ label: 'Re-train Individual only', small: 'Up to date · trains anyway' });
            expect(item('only-relationship')).toEqual({ label: 'Relation model only', small: 'Not trained yet · ≈ 15 s' });
        });

        it('every model trained before: "Re-train all 2 models", "Re-train Individual only", "Re-train Relation model only"', async () => {
            await mountModels([withTrained(IND2()), withTrained(REL2())]);
            await openMenu();
            expect(item('retrain-all').label).toBe('Re-train all 2 models');
            expect(item('only-individual').label).toBe('Re-train Individual only');
            expect(item('only-relationship').label).toBe('Re-train Relation model only');
        });

        // A sensor with ONE model never reads "Train all 1 model": no all-row, and its own
        // row is a whole sentence that turns into "Re-train the …" once it was trained.
        it('a sensor with ONE model: no "Train all 1 model" row; "Train the Individual model" becomes "Re-train the Individual model" after training', async () => {
            await mountModels([IND2()]);
            await openMenu();
            expect(screen.queryByTestId('train-menu-retrain-all')).toBeNull();
            expect(screen.getByTestId('train-sensor-menu').querySelectorAll('[role="menuitem"]')).toHaveLength(1);
            expect(item('only-individual')).toEqual({ label: 'Train the Individual model', small: 'Not trained yet · ≈ 1 s' });
            expect(screen.getByTestId('train-sensor-menu').textContent).not.toMatch(/all 1 model| only/);
            fireEvent.keyDown(window, { key: 'Escape' });
            await clickTrainSensor();
            await waitFor(() => expect(strip().getAttribute('data-phase')).toBe('done'));
            await openMenu();
            expect(screen.queryByTestId('train-menu-retrain-all')).toBeNull();
            expect(item('only-individual')).toEqual({ label: 'Re-train the Individual model', small: 'Up to date · trains anyway' });
        });

        it('state lines follow the model: settings changed since it was trained, and a failed run', async () => {
            // trained before, but its fingerprint no longer matches (settings / running condition changed)
            mockInvoke.mockImplementation((cmd: string, args?: any) => cmd === 'compute_sensor_stats' ? Promise.reject(new Error('stats exploded')) : healthInvoke(cmd, args));
            await mountModels([{ ...withTrained(IND2()), trainedFingerprint: 'old' }, REL2()]);
            await openMenu();
            expect(item('only-individual')).toEqual({ label: 'Re-train Individual only', small: 'Settings changed since it was trained · ≈ 1 s' });
            fireEvent.keyDown(window, { key: 'Escape' });
            // its run fails: the row says so (and the time it will take again)
            await clickTrainSensor();
            await waitFor(() => expect(strip().getAttribute('data-phase')).toBe('done'));
            await openMenu();
            expect(item('only-individual').small).toBe('Failed last run · ≈ 1 s');
        });
    });

    it('a queued model is locked ("Remove from run", Save disabled); removing it leaves it untrained', async () => {
        const release = holdStats();
        await mountModels([IND2(), REL2()]);
        // "Save changes" exists only while a draft does: give the Relation model one before the run starts.
        fireEvent.click(screen.getAllByRole('tab').find(t => t.textContent?.includes('Relation model'))!);
        expect(screen.queryByText('Save changes')).toBeNull();
        openSettings();
        fireEvent.change(screen.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Temp R draft' } });
        expect((screen.getByText('Save changes') as HTMLButtonElement).disabled).toBe(false);
        await clickTrainSensor();
        fireEvent.click(screen.getAllByRole('tab').find(t => t.textContent?.includes('Relation model'))!);
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
        // ONE line: "Trained in the run 22:41 · 2 need set points · this is 1 of 2" + the Next link
        expect(screen.getByTestId('run-setpoints-line').textContent).toMatch(/^Trained in the run \d{2}:\d{2} · 2 need set points · this is 1 of 2$/);
        expect(screen.getByTestId('run-setpoints-banner').textContent).not.toMatch(/in total|Set them here/);
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
        // amber "Skipped", the reason (the missing setting, by name) on its own line under the row
        expect(screen.getByTestId('train-row-status-r3').textContent).toBe('Skipped');
        expect(screen.getByTestId('train-row-note-r3').textContent).toBe('Add at least 1 predictor');
        expect(screen.getByTestId('train-all-foot').textContent).toBe("Trains 1 model; the 1 that can't train stays as it is");
        expect(screen.getByTestId('train-all-modal').textContent).not.toMatch(/Fill in the required fields|0 up to date/);
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
        expect(screen.getByTestId('train-all-reason').textContent).toBe('Set the running condition first.');
        expect(screen.getByTestId('train-all-reason').className).toContain('tq-why--warn');
        expect(trainSensorBtn().disabled).toBe(true);
        expect(screen.getByTestId('train-sensor-why').textContent).toBe('Set the running condition first.');
        expect(document.body.textContent).not.toMatch(/Step\s*1/i);
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

// Workspace-closing, a hung train at close, re-points
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

    // Split in two (was ONE test with a 30 ms real-time cap that then ran two more
    // act() rounds assuming the wait was still pending - on a loaded machine one round took longer
    // than 30 ms, the cap fired early, and the "second" Close simply closed the window). Each half
    // is now independent of how long a step takes: the first never lets the cap elapse, the second
    // does nothing between Stop and the notice.
    it('a hung train at close: a second "Stop after this model and close" while the first still waits is ignored - one wait, one close', async () => {
        // The cap stays at its real value (90 s): it cannot elapse inside this test, so the
        // first Stop is certainly still waiting whenever the second one arrives.
        expect(MARK_COMPLETE_CLOSE_WAIT.ms).toBeGreaterThanOrEqual(60_000);
        const release = hold('TAG2'); // held: the sidecar is "still training"
        try {
            await mountModels([IND2(), makeModel({ id: 'i4', targetSensor: 'TAG3' })]);
            await clickTrainAll();
            await act(async () => { fireEvent.click(screen.getByTitle('Close')); await Promise.resolve(); });
            await act(async () => { fireEvent.click(screen.getByTestId('close-run-stop')); await Promise.resolve(); });
            expect(screen.queryByRole('alertdialog')).toBeNull();
            // A second attempt while the first still waits: the dialog again, Stop again — ignored.
            await act(async () => { fireEvent.click(screen.getByTitle('Close')); await Promise.resolve(); });
            expect(screen.getByRole('alertdialog')).toBeTruthy(); // the run is still active: it asks again
            await act(async () => { fireEvent.click(screen.getByTestId('close-run-stop')); await Promise.resolve(); });
            expect(screen.queryByRole('alertdialog')).toBeNull();
            expect(mockClose).not.toHaveBeenCalled();
            expect(screen.queryByTestId('close-wait-notice')).toBeNull(); // nobody gave up
            // The model in training finishes: the ONE waiting Stop closes the window, once.
            await release();
            await waitFor(() => expect(mockClose).toHaveBeenCalledTimes(1));
            await flush();
            await act(async () => { await new Promise(r => setTimeout(r, 20)); });
            expect(mockClose).toHaveBeenCalledTimes(1); // a second, un-ignored Stop would have closed again
            expect(screen.queryByTestId('close-wait-notice')).toBeNull();
            // The run stopped after the model in training: the queued one never started.
            expect(statsFor('TAG3')).toHaveLength(0);
        } finally {
            await release();
        }
    });

    it('a hung train at close: "Stop after this model and close" gives up after the cap with a notice; the next close goes through', async () => {
        const wait = MARK_COMPLETE_CLOSE_WAIT.ms;
        MARK_COMPLETE_CLOSE_WAIT.ms = 30;
        try {
            hold('TAG2'); // never released: the sidecar "hangs"
            await mountModels([IND2(), makeModel({ id: 'i4', targetSensor: 'TAG3' })]);
            await clickTrainAll();
            await act(async () => { fireEvent.click(screen.getByTitle('Close')); await Promise.resolve(); });
            await act(async () => { fireEvent.click(screen.getByTestId('close-run-stop')); await Promise.resolve(); });
            // Nothing else happens until the cap has elapsed - however long that takes on this machine.
            await waitFor(() => expect(screen.getByTestId('close-wait-notice').textContent).toContain('Still training a model'));
            expect(mockClose).not.toHaveBeenCalled();
            // The next close goes through (no dialog), and a rejected close() is caught.
            mockClose.mockRejectedValueOnce(new Error('window already closing'));
            await act(async () => { fireEvent.click(screen.getByTitle('Close')); await Promise.resolve(); await Promise.resolve(); });
            expect(screen.queryByRole('alertdialog')).toBeNull();
            await waitFor(() => expect(mockClose).toHaveBeenCalledTimes(1));
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
        fireEvent.click(screen.getByTestId('next-health-score'));
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

    it('NOT_FITTED during a run: no Re-train button on either page — "Load it again" and Train sensor are both disabled with the run\'s reason (one engine call at a time)', async () => {
        const base = (cmd: string, args?: any) => cmd === 'compute_health_preview'
            ? Promise.reject('NOT_FITTED: no fitted model for this key') : healthInvoke(cmd, args);
        mockInvoke.mockImplementation(base);
        const rel = withTrained(makeModel({ id: 'r3', name: 'Rel', kind: 'relationship', targetSensor: 'TAG3', predictorSensors: ['TAG1'] }));
        const release = hold('TAG2', base);
        await mountModels([IND2(), rel]);
        fireEvent.click(screen.getAllByTestId('sensor-row-label').find(e => e.textContent?.includes('TAG3'))!);
        await fitGoneSettled(); // (after the one silent re-fit, which this fake Rust answers NOT_FITTED again)
        expect(screen.queryByTestId('results-not-fitted-retrain')).toBeNull();
        expect(trainSensorBtn().disabled).toBe(false);
        expect((screen.getByTestId('board-load-fit') as HTMLButtonElement).disabled).toBe(false);
        // A run (i2 first, held); r3 — planned ready because its fit is gone — is taken out of it again.
        await act(async () => { fireEvent.click(screen.getByTestId('train-all')); });
        await act(async () => { fireEvent.click(screen.getByTestId('train-all-start')); await Promise.resolve(); });
        fireEvent.click(screen.getByTestId('train-remove-r3'));
        fireEvent.click(screen.getByTestId('train-all-close'));
        await flush();
        await waitFor(() => expect(screen.getByTestId('results-not-fitted')).toBeTruthy());
        expect(screen.getByTestId('results-not-fitted').querySelectorAll('button')).toHaveLength(2); // only the two text links
        expect(trainSensorBtn().disabled).toBe(true);
        expect(trainSensorBtn().title).toBe('Wait for the training run to finish');
        const fitsBefore = mockInvoke.mock.calls.filter(c => c[0] === 'preview_relationship_model').length;
        const load = screen.getByTestId('board-load-fit') as HTMLButtonElement;
        expect(load.disabled).toBe(true);
        expect(load.title).toBe('Wait for the training run to finish');
        fireEvent.click(load);
        await flush();
        expect(mockInvoke.mock.calls.filter(c => c[0] === 'preview_relationship_model')).toHaveLength(fitsBefore);
        // The Health score page: the same board, and Mark complete waits for the run.
        fireEvent.click(screen.getByTestId('next-health-score'));
        await flush();
        await waitFor(() => expect(screen.getByTestId('health-not-fitted')).toBeTruthy());
        expect(screen.queryByTestId('health-not-fitted-retrain')).toBeNull();
        expect((screen.getByTestId('health-load-fit') as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByTestId('health-load-fit') as HTMLButtonElement).title).toBe('Wait for the training run to finish');
        expect((screen.getByTestId('mark-complete') as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByTestId('mark-block-reason').textContent).toBe('Wait for the training run to finish');
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
        await waitFor(() => expect(trainSensorBtn().textContent).toBe('▶ Train sensor'));
    });

    it('a model being saved (Mark complete running) is planned as can\'t train — "Its files are being saved"', async () => {
        mockInvoke.mockImplementation((cmd: string, args?: any) => cmd === 'export_model_files' ? new Promise(() => {}) : healthInvoke(cmd, args));
        await mountModels([IND3T({ healthSetPoints: VALID_IND })]);
        await openHealthPage();
        await waitFor(() => expect((screen.getByTestId('mark-complete') as HTMLButtonElement).disabled).toBe(false));
        await act(async () => { fireEvent.click(screen.getByTestId('mark-complete')); await Promise.resolve(); });
        expect(screen.getByTestId('train-sensor-why').textContent).toBe("Can't train · see below");
        expect(trainSensorBtn().title).toBe("Can't train: Individual — Its files are being saved");
        expect(trainSensorBtn().disabled).toBe(true);
        // every menu item is disabled too, so the ▾ toggle is
        expect((screen.getByTestId('train-sensor-menu-toggle') as HTMLButtonElement).disabled).toBe(true);
    });
});

// The Workbench page spine (spec
// docs/design/handoff/workbench-redesign/README.md §1; DESIGN_SYSTEM §4 "Build Model
// Workbench pages"): one control group in the header, one state dot per kind tab, one
// status sentence in the footer, at most one filled button on screen, one board shape
// for the chart-less states, one date format, scroll back to the top on a page / tab switch.
describe('Workbench redesign §1 — the page spine', () => {
    const record = { at: '2026-10-04T01:00:00.000Z', outputDir: 'C:/data/workspaces/ws1/output', setPoints: HS_SNAP, scoringIntervalSecs: 3600 };
    /** Every FILLED button in the window (a split button's ▾ half belongs to its main half; dialogs are not the page). */
    const filled = () => Array.from(document.querySelectorAll<HTMLElement>('.rcx-btn--pri, .rcx-btn--danger, .f4-btn-save, .bmw-btn-ok'))
        .filter(b => !b.classList.contains('tq-split-caret') && !b.closest('[role="dialog"]'))
        .map(b => b.getAttribute('data-testid'));
    const primary = () => screen.getByTestId('wb-footer').getAttribute('data-primary');
    const rename = () => {
        openSettings();
        fireEvent.change(screen.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Renamed' } });
    };

    describe('at most ONE filled button on screen, and it follows the state', () => {
        it('not trained yet: Train sensor (Next is a ghost — training comes first)', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            expect(filled()).toEqual(['train-sensor']);
            expect(primary()).toBe('train');
            expect(screen.getByTestId('train-sensor-menu-toggle').className).toContain('rcx-btn--pri'); // both halves follow
            expect(screen.getByTestId('next-health-score').className).toBe('rcx-btn');
            expect(screen.queryByTestId('save-changes')).toBeNull();
        });

        it('a draft: Save changes — it exists only while the draft does, and Train sensor steps back to a ghost meanwhile', async () => {
            render(<BuildModelWindow />);
            await deliverData();
            rename();
            expect(filled()).toEqual(['save-changes']);
            expect(primary()).toBe('save');
            expect(screen.getByTestId('save-changes').className).toBe('f4-btn-save');
            expect(trainSensorBtn().className).not.toContain('rcx-btn--pri');
            expect(trainSensorBtn().disabled).toBe(false); // a ghost, still usable
            await act(async () => { fireEvent.click(screen.getByTestId('save-changes')); await Promise.resolve(); await Promise.resolve(); });
            await waitFor(() => expect(screen.queryByTestId('save-changes')).toBeNull());
            expect(filled()).toEqual(['train-sensor']);
        });

        it('trained and up to date: "Next: Health score →" — Train sensor is a ghost', async () => {
            await hsMount([HS_IND()]);
            await waitFor(() => expect(screen.getByTestId('results-chart')).toBeTruthy());
            expect(filled()).toEqual(['next-health-score']);
            expect(primary()).toBe('next');
            expect(trainSensorBtn().className).not.toContain('rcx-btn--pri');
            expect(screen.getByTestId('train-sensor-menu-toggle').className).not.toContain('rcx-btn--pri');
        });

        it('a sibling model of the same sensor still needs training: Train sensor — Next is a ghost even on the trained model', async () => {
            await hsMount([HS_IND(), makeModel({ id: 'r1', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2'] })]);
            expect(screen.getAllByRole('tab').find(t => t.getAttribute('aria-selected') === 'true')!.textContent).toContain('Individual');
            expect(filled()).toEqual(['train-sensor']);
            const next = screen.getByTestId('next-health-score') as HTMLButtonElement;
            expect(next.className).toBe('rcx-btn');
            expect(next.disabled).toBe(false); // only its weight changes
        });

        it('Health score: Mark complete (green) only', async () => {
            await hsMount([HS_IND()]);
            await openHealthPage();
            expect(filled()).toEqual(['mark-complete']);
            expect(primary()).toBe('mark');
            expect(screen.getByTestId('mark-complete').className).toBe('bmw-btn-ok');
            expect(screen.getByTestId('footer-back-to-fit').className).toContain('f4-btn--plain');
        });

        it('a Complete model has NO filled button on either page; "Mark incomplete" is a text button', async () => {
            await hsMount([HS_IND({ status: true, healthExport: record })]);
            await waitFor(() => expect(screen.getByTestId('results-chart')).toBeTruthy());
            expect(filled()).toEqual([]);
            expect(primary()).toBe('none');
            await openHealthPage();
            expect(filled()).toEqual([]);
            expect(screen.getByTestId('mark-incomplete').className).toContain('f4-btn--plain');
            expect(screen.queryByTestId('mark-complete-again')).toBeNull();
            expect(screen.queryByTestId('mark-complete')).toBeNull();
        });

        it('Complete with files out of date: "Mark complete again" appears and is the one filled button', async () => {
            await hsMount([HS_IND({ status: true, healthExport: record })]);
            await openHealthPage();
            hsType('sp-upper', '12');
            expect(filled()).toEqual(['mark-complete-again']);
            expect(primary()).toBe('mark');
        });

        it('settings changed (stale): Train sensor — the stale banner has no button of its own, only the "Train sensor ↑" link', async () => {
            await hsMount([{ ...HS_IND(), trainedFingerprint: 'old' }]);
            expect(screen.getByTestId('stale-banner')).toBeTruthy();
            expect(filled()).toEqual(['train-sensor']);
            expect(screen.queryByTestId('stale-retrain')).toBeNull();
            expect(screen.getByTestId('stale-banner').querySelector('.rcx-btn')).toBeNull();
            expect(screen.getByTestId('stale-go-train').className).toBe('tq-inline-link');
            expect(screen.getByTestId('footer-status').textContent).toBe('Settings or running condition changed · train again with Train sensor ↑');
        });

        it('running condition not set / not valid: only the card\'s own button; everything in the detail pane is a ghost (a draft\'s Save too)', async () => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel()], runningConditionNoneConfirmed: false, rcLegacyNotice: null } });
            fireEvent.click(screen.getByLabelText('Close')); // the auto-opened settings modal
            expect(filled()).toEqual(['rc-card-open']);
            expect(screen.getByTestId('rc-card-open').textContent).toBe('Set running condition →');
            expect(primary()).toBe('none');
            rename();
            expect(filled()).toEqual(['rc-card-open']);
            expect(screen.getByTestId('save-changes').className).toBe('rcx-btn');
            expect((screen.getByTestId('save-changes') as HTMLButtonElement).disabled).toBe(false);
            cleanup();
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: {
                groups: [makeGroup()], models: [makeModel()], runningConditionNoneConfirmed: true,
                runningConditionTimePeriods: [{ id: 'x', start: '2026-02-01T00:00', end: '2026-01-05T00:00' }],
            } });
            expect(screen.getByTestId('rc-card').getAttribute('data-state')).toBe('invalid');
            expect(filled()).toEqual(['rc-card-open']);
            expect(screen.getByTestId('rc-card-open').className).toContain('rcx-btn--danger');
        });
    });

    describe('kind tab: ONE state dot in the list\'s colours, the words in its tooltip', () => {
        it('a model whose run failed gets the RED dot — on its tab AND in the sensor list — with "Training failed"; the board and the footer say it once each', async () => {
            mockInvoke.mockImplementation((cmd: string) =>
                cmd === 'compute_sensor_stats' ? Promise.reject(new Error('stats exploded')) : Promise.resolve({}));
            render(<BuildModelWindow />);
            await deliverData();
            // before: never trained = an empty ring, no colour
            expect(screen.getByTestId('tab-status-m1').className).toBe('f4-sdot');
            await act(async () => {
                fireEvent.click(trainSensorBtn());
                await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
            });
            await waitFor(() => expect(screen.getByTestId('results-error')).toBeTruthy());
            const dot = screen.getByTestId('tab-status-m1');
            expect(dot.className).toContain('f4-sdot--bad');
            expect(dot.getAttribute('title')).toBe('Training failed');
            expect(dot.textContent).toBe('');
            const tab = screen.getByRole('tab');
            expect(tab.getAttribute('title')).toBe('Individual · Training failed');
            // not tooltip-only: the state is part of the tab's accessible name
            expect(tab.getAttribute('aria-label')).toBe('Individual, Training failed');
            expect(screen.getByRole('tab', { name: 'Individual, Training failed' })).toBe(tab);
            expect(tab.querySelector('.f4-pill')).toBeNull();
            expect(tab.textContent).toBe('IIndividual'); // kind badge + name — no status word on the tab
            // the same red dot in the sensor list
            expect(screen.getByTestId('sensor-kind-badge-dot-m1').className).toContain('f4-kb-dot--bad');
            expect(screen.getByTestId('sensor-kind-badge-m1').getAttribute('title')).toBe('Individual · Training failed');
            // ONE board shape: title, one sentence with a text link, the error in mono
            const b = screen.getByTestId('results-error');
            expect(b.className).toContain('wbx-msg--bad');
            expect(b.querySelector('.wbx-msg-t')!.textContent).toBe('Training failed');
            expect(b.querySelector('.wbx-msg-s')!.textContent).toBe('Fix the problem, then train again with Train sensor ↑. The model keeps its last state.');
            expect(b.querySelector('.wbx-msg-d')!.textContent).toMatch(/stats exploded/);
            // ...and the footer: one pill, one sentence, in red
            const line = screen.getByTestId('footer-status');
            expect(line.textContent).toBe('Training failed · fix the problem, then Train sensor ↑');
            expect(line.getAttribute('data-tone')).toBe('bad');
            expect(line.className).toContain('f4-foot-reason--bad');
            expect(screen.getByTestId('footer-pill').textContent).toBe('Incomplete');
        });

        it('complete = green, trained = amber — the same colour classes as the list', async () => {
            await hsMount([HS_IND({ id: 'i1', status: true, healthExport: record }), HS_REL()]);
            expect(screen.getByTestId('tab-status-i1').className).toContain('f4-sdot--complete');
            expect(screen.getByTestId('tab-status-i1').getAttribute('title')).toBe('Complete');
            expect(screen.getByTestId('tab-status-r1').className).toContain('f4-sdot--need');
            for (const tab of screen.getAllByRole('tab')) expect(tab.querySelector('.f4-pill')).toBeNull();
            expect(screen.getAllByRole('tab').map(tab => tab.getAttribute('aria-label'))).toEqual(['Individual, Complete', 'Relation model, Trained']);
            // the kind name still finds its tab
            expect(screen.getByRole('tab', { name: /Relation model/ }).getAttribute('aria-selected')).toBe('false');
        });

        // The words of the gate, per reason.
        it.each([
            ['Needs category', { models: [makeModel({ category: null })] }],
            ['Needs train period', { models: [makeModel()], runningConditionTimePeriods: [] }],
            ['Fix periods', { models: [makeModel()], runningConditionTimePeriods: [{ id: 'x', start: '2026-02-01T00:00', end: '2026-01-05T00:00' }] }],
        ])('a model the gate blocks says why on its tab: "%s"', async (words, fg) => {
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], ...fg } });
            const modal = screen.queryByLabelText('Close');
            if (modal) fireEvent.click(modal); // the settings modal opens by itself when the condition is not set
            const tab = screen.getByRole('tab');
            expect(tab.getAttribute('aria-label')).toBe(`Individual, ${words}`);
            expect(tab.getAttribute('title')).toBe(`Individual · ${words}`);
            expect(screen.getByTestId('tab-status-m1').getAttribute('title')).toBe(words);
            expect(screen.getByTestId('tab-status-m1').className).toContain('f4-sdot--bad');
        });

        // An unsaved draft is said in the footer of the OPEN tab only: on another tab the tooltip must carry it.
        it('unsaved Model settings on a tab that is not open: its tooltip words end with "· unsaved changes"', async () => {
            await hsMount([HS_IND(), HS_REL()]);
            const label = (name: RegExp) => screen.getByRole('tab', { name }).getAttribute('aria-label');
            expect(label(/Individual/)).toBe('Individual, Trained');
            rename(); // a draft on the Individual model
            expect(screen.getByTestId('footer-status').textContent).toBe('Unsaved changes to the Individual model');
            fireEvent.click(screen.getByRole('tab', { name: /Relation model/ }));
            expect(screen.getByTestId('wb-footer').textContent).not.toMatch(/Unsaved/); // this tab has none
            expect(label(/Individual/)).toBe('Individual, Trained · unsaved changes');
            expect(label(/Relation model/)).not.toMatch(/unsaved/);
            expect(screen.getByRole('tab', { name: /Individual/ }).getAttribute('title')).toBe('Individual · Trained · unsaved changes');
            expect(screen.getByTestId('tab-status-m1').getAttribute('title')).toBe('Trained · unsaved changes');
            // saved: the words go back
            fireEvent.click(screen.getByRole('tab', { name: /Individual/ }));
            await act(async () => { fireEvent.click(screen.getByTestId('save-changes')); await Promise.resolve(); await Promise.resolve(); });
            await waitFor(() => expect(label(/Individual/)).toBe('Individual, Trained'));
        });
    });

    describe('Train sensor: where the reason is (the line under the button stays short)', () => {
        it('the blocked model is on ANOTHER tab: "Relation model can\'t train · see its tab"; on its own tab: "Can\'t train · see below"', async () => {
            await hsMount([HS_IND(), makeModel({ id: 'r1', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: [] })]);
            const why = () => screen.getByTestId('train-sensor-why').textContent;
            expect(screen.getAllByRole('tab').find(tab => tab.getAttribute('aria-selected') === 'true')!.textContent).toContain('Individual');
            expect(why()).toBe("Relation model can't train · see its tab");
            expect(trainSensorBtn().disabled).toBe(true);
            expect(trainSensorBtn().title).toMatch(/^Can't train: Relation model — /); // the full reason stays in the tooltip
            fireEvent.click(screen.getByRole('tab', { name: /Relation model/ }));
            expect(why()).toBe("Can't train · see below");
        });
    });

    describe('Health score page: the one filled button', () => {
        it('a Complete model whose SIBLING still needs training: Train sensor is the filled button (the Complete model has none of its own)', async () => {
            await hsMount([HS_IND({ status: true, healthExport: record }), makeModel({ id: 'r1', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2'] })]);
            await openHealthPage();
            expect(filled()).toEqual(['train-sensor']);
            expect(primary()).toBe('train');
            expect(screen.getByTestId('mark-incomplete').className).toContain('f4-btn--plain');
            expect(screen.queryByTestId('mark-complete')).toBeNull();
        });

        it('this model must train again (its fit is gone): Train sensor filled, Mark complete a ghost', async () => {
            mockInvoke.mockImplementation((cmd: string, args?: any) => cmd === 'compute_health_preview'
                ? Promise.reject('NOT_FITTED: no fitted model for this key') : healthInvoke(cmd, args));
            const rel = HS_REL();
            statefulUpdateMock([rel]);
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [rel] } });
            await fitGoneSettled();
            fireEvent.click(screen.getByTestId('next-health-score'));
            await waitFor(() => expect(screen.getByTestId('health-not-fitted')).toBeTruthy());
            await waitFor(() => expect(filled()).toEqual(['train-sensor']));
            expect(primary()).toBe('train');
            expect(screen.getByTestId('mark-complete').className).toBe('rcx-btn');
        });
    });

    describe('Health score footer: a failed Mark complete, the saved folder, a failed preview', () => {
        // "Not saved" used to stay for the rest of the session and hide the real reason.
        it('a failed save says "Not saved · fix it, then Mark complete again" with the red card — and both go as soon as a set point changes; a later empty point shows ITS reason', async () => {
            const why = "Couldn't write C:\\data\\workspaces\\ws1\\output\\TAG1\\INDV_INFO_TAG1.json — the file is open in another program.";
            mockInvoke.mockImplementation((cmd: string, args?: any) => cmd === 'export_model_files' ? Promise.reject(why) : healthInvoke(cmd, args));
            statefulUpdateMock([HS_IND()]);
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [HS_IND()] } });
            await openHealthPage();
            await waitFor(() => expect(hsMarkBtn().disabled).toBe(false));
            await hsClickMark();
            await waitFor(() => expect(screen.getByTestId('save-error')).toBeTruthy());
            // the red card carries the file; the footer says what to do
            expect(screen.getByTestId('save-error').className).toContain('hs-save--bad');
            expect(screen.getByTestId('save-error-reason').textContent).toContain('output\\TAG1\\INDV_INFO_TAG1.json');
            const line = () => screen.getByTestId('wb-footer').querySelector('.wbx-reason') as HTMLElement;
            expect(line().textContent).toBe('Not saved · fix it, then Mark complete again');
            expect(line().getAttribute('data-tone')).toBe('bad');
            expect(line().className).toContain('f4-foot-reason--bad');
            expect(screen.getByTestId('footer-pill').textContent).toBe('Trained');
            expect(hsMarkBtn().disabled).toBe(false); // can try again
            // the user changes a set point: that attempt's outcome no longer describes the page
            hsType('sp-upper', '9.5');
            expect(screen.queryByTestId('save-error')).toBeNull();
            await waitFor(() => expect(screen.getByTestId('footer-status').textContent).toBe('Set points valid — check the score chart, then Mark complete'));
            expect(screen.getByTestId('wb-footer').textContent).not.toMatch(/Not saved/);
            // ...and later empties one: the footer shows the block reason, not "Not saved"
            hsType('sp-upper', '');
            await waitFor(() => expect(screen.getByTestId('mark-block-reason').textContent).toBe('1 set point still empty'));
            expect(screen.getByTestId('wb-footer').textContent).not.toMatch(/Not saved/);
            expect(hsMarkBtn().disabled).toBe(true);
        });

        it('export REFUSED by Rust for a set point → the user fixes it → later empties one: the footer shows that block reason ("1 set point still empty"), not "Not saved"', async () => {
            const refused = { ok: false, files: [], output_dir: '', warnings: [], validation: [{ code: 'lower_equals_3sd', severity: 'error', field: 'lower', message: 'L equals the lower 3σ boundary (found at save time).' }] };
            mockInvoke.mockImplementation((cmd: string, args?: any) => cmd === 'export_model_files' ? Promise.resolve(refused) : healthInvoke(cmd, args));
            statefulUpdateMock([HS_IND()]);
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [HS_IND()] } });
            await openHealthPage();
            await waitFor(() => expect(hsMarkBtn().disabled).toBe(false));
            await hsClickMark();
            await waitFor(() => expect(screen.getByTestId('save-error')).toBeTruthy());
            expect(screen.getByTestId('check-line').textContent).toMatch(/found at save time/);
            expect(screen.getByTestId('wb-footer').querySelector('.wbx-reason')!.textContent).toBe('Not saved · fix it, then Mark complete again');
            // the user fixes the set point
            hsType('sp-lower', '0.5');
            await waitFor(() => expect(screen.getByTestId('check-valid')).toBeTruthy());
            expect(screen.queryByTestId('save-error')).toBeNull();
            await waitFor(() => expect(screen.getByTestId('footer-status').textContent).toBe('Set points valid — check the score chart, then Mark complete'));
            // ...and later empties one
            hsType('sp-lower', '');
            await waitFor(() => expect(screen.getByTestId('mark-block-reason').textContent).toBe('1 set point still empty'));
            expect(screen.getByTestId('wb-footer').textContent).not.toMatch(/Not saved/);
            expect(screen.getByTestId('mark-block-reason').getAttribute('data-tone')).toBe('warn');
        });

        it('the saved folder of a Windows path is shortened to "…\\workspaces\\<id>\\output\\<sensor>" (the full path is the tooltip)', async () => {
            const dir = 'C:\\Users\\me\\AppData\\Roaming\\com.wizard.app\\workspaces\\ws1\\output\\TAG1';
            await hsMount([HS_IND({ status: true, healthExport: { ...record, outputDir: dir } })]);
            await openHealthPage();
            const path = screen.getByTestId('footer-saved-path');
            expect(path.textContent).toBe('…\\workspaces\\ws1\\output\\TAG1');
            expect(path.getAttribute('title')).toBe(dir);
            expect(screen.getByTestId('save-ok').textContent).toMatch(/^Files saved 2026\/10\/04 \d{2}:\d{2} · …\\workspaces\\ws1\\output\\TAG1$/);
        });

        it('the health score failed to load: the red card + Retry on the page; Mark complete is disabled and the footer says what to do', async () => {
            await hsMount([HS_IND()]);
            await openHealthPage();
            await waitFor(() => expect(hsMarkBtn().disabled).toBe(false));
            let fail = true;
            mockInvoke.mockImplementation((cmd: string, args?: any) =>
                cmd === 'compute_health_preview' && fail ? Promise.reject('Failed to read column: transient I/O error.') : healthInvoke(cmd, args));
            hsType('sp-upper', '9.5');
            await waitFor(() => expect(screen.getByTestId('health-error')).toBeTruthy());
            expect(screen.getByTestId('health-error').textContent).toMatch(/^Couldn't load the health score\. .*transient I\/O error · the score and Checks are not available until it loads/);
            expect(screen.getByTestId('checks-unavailable').textContent).toBe('Not available until the health score loads.');
            expect(screen.getByTestId('mark-block-reason').textContent).toBe('The health score did not load · Retry above, then Mark complete');
            expect(hsMarkBtn().disabled).toBe(true);
            // Retry brings it back
            fail = false;
            fireEvent.click(screen.getByTestId('health-retry'));
            await waitFor(() => expect(screen.queryByTestId('health-error')).toBeNull());
            await waitFor(() => expect(hsMarkBtn().disabled).toBe(false));
        });

        // After the dataset was replaced the red card has NO
        // Retry — the footer must not point at one.
        it('the health score failed to load with STALE_SESSION (the dataset was replaced): no Retry on the card, and the footer says to close and reopen — it never points at a Retry that is not there', async () => {
            await hsMount([HS_IND()]);
            await openHealthPage();
            await waitFor(() => expect(hsMarkBtn().disabled).toBe(false));
            mockInvoke.mockImplementation((cmd: string, args?: any) =>
                cmd === 'compute_health_preview' ? Promise.reject('STALE_SESSION: the dataset was reloaded') : healthInvoke(cmd, args));
            hsType('sp-upper', '9.5');
            await waitFor(() => expect(screen.getByTestId('health-error')).toBeTruthy());
            expect(screen.queryByTestId('health-retry')).toBeNull();
            const why = screen.getByTestId('mark-block-reason');
            expect(why.textContent).toBe('The data in this window is out of date. Close it and open Build Model again from the Dashboard.');
            expect(why.textContent).not.toMatch(/Retry/);
            expect(hsMarkBtn().disabled).toBe(true);
            expect(hsMarkBtn().title).toBe('The data in this window is out of date. Close it and open Build Model again from the Dashboard.');
            // the input typed in is still there (the page was not replaced by a board)
            expect(hsInput('sp-upper').value).toBe('9.5');
        });

        it('a Complete model with files out of date whose new set point is NOT valid: "Mark complete again" is disabled and the footer says why', async () => {
            await hsMount([HS_IND({ status: true, healthExport: record })]);
            await openHealthPage();
            hsType('sp-upper', '12');
            expect(screen.getByTestId('files-out-of-date').textContent).toBe('Files out of date — set points changed after saving · Mark complete again to update them');
            hsType('sp-upper', '');
            await waitFor(() => expect(screen.getByTestId('files-out-of-date').textContent).toBe('Files out of date · 1 set point still empty'));
            expect((screen.getByTestId('mark-complete-again') as HTMLButtonElement).disabled).toBe(true);
            expect(screen.getByTestId('footer-pill').textContent).toBe('Complete');
        });
    });

    describe('keyboard focus is never dropped (review of 452d5c2)', () => {
        const focusAndSave = async () => {
            const save = screen.getByTestId('save-changes') as HTMLButtonElement;
            save.focus();
            expect(document.activeElement).toBe(save);
            await act(async () => { fireEvent.click(save); await Promise.resolve(); await Promise.resolve(); });
            await waitFor(() => expect(screen.queryByTestId('save-changes')).toBeNull());
        };

        it('the focused "Save changes" disappears once saved: the focus moves to "Next: Health score →"', async () => {
            await hsMount([HS_IND()]);
            await waitFor(() => expect(screen.getByTestId('results-chart')).toBeTruthy());
            rename();
            await focusAndSave();
            await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('next-health-score')));
        });

        it('...or to the footer (its status sentence) when "Next: Health score →" is disabled', async () => {
            statefulUpdateMock([makeModel()]);
            render(<BuildModelWindow />);
            await deliverData();
            rename();
            expect((screen.getByTestId('next-health-score') as HTMLButtonElement).disabled).toBe(true);
            await focusAndSave();
            await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('wb-footer')));
            expect(screen.getByTestId('wb-footer').getAttribute('tabindex')).toBe('-1');
        });

        it('a Save that was clicked with the mouse while the focus was elsewhere moves nothing', async () => {
            statefulUpdateMock([makeModel()]);
            render(<BuildModelWindow />);
            await deliverData();
            rename();
            const name = screen.getByPlaceholderText('e.g. Bearing vibration model') as HTMLInputElement;
            name.focus();
            await act(async () => { fireEvent.click(screen.getByTestId('save-changes')); await Promise.resolve(); await Promise.resolve(); });
            await waitFor(() => expect(screen.queryByTestId('save-changes')).toBeNull());
            expect(document.activeElement).toBe(name);
        });
    });

    it('the header has ONE control group — category switch · Train sensor (no page switch) — and the category is still saved to FailureModel.category', async () => {
        const groups = [makeGroup()];
        const models = [makeModel({ category: 'performance' })];
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups, models } });
        const ctl = screen.getByTestId('detail-controls');
        expect(ctl.className).toBe('wbx-dh-ctl');
        const kids = Array.from(ctl.children) as HTMLElement[];
        expect(kids).toHaveLength(2);
        expect(kids[0]).toBe(screen.getByRole('group', { name: 'Category' }));
        expect(kids[1].contains(trainSensorBtn())).toBe(true);
        expect(kids[1].contains(screen.getByTestId('train-sensor-why'))).toBe(true); // one short line under the button
        expect(within(kids[0]).getByRole('button', { name: 'Performance' }).getAttribute('aria-pressed')).toBe('true');
        expect(within(kids[0]).getByRole('button', { name: 'Condition' }).getAttribute('aria-pressed')).toBe('false');

        mockUpdateWorkspaceData.mockClear();
        mockUpdateWorkspaceData.mockImplementation(async (id: string, patch: (s: any) => any) => patch({ id, failureGroupState: { groups, models } }));
        fireEvent.click(within(kids[0]).getByRole('button', { name: 'Condition' }));
        await flush();
        expect(mockUpdateWorkspaceData).toHaveBeenCalled();
        const written = (await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1].value).failureGroupState.models;
        expect(written[0].category).toBe('condition');
    });

    it('Model settings opens by itself when the thing to fix is inside it (a Custom model\'s own running condition); the user can still close it', async () => {
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel({ runningConditionMode: 'custom' })] } });
        expect(screen.getByTestId('build-block-reason')).toBeTruthy(); // its own condition is not set
        expect(screen.queryByTestId('settings-to-fix')).toBeNull();     // ...which is not one of the "N to fix" fields
        expect(screen.getByTestId('add-model-form')).toBeTruthy();
        fireEvent.click(screen.getByText('Model settings', { selector: 'b' }));
        expect(screen.queryByTestId('add-model-form')).toBeNull();
        cleanup();
        // nothing to fix: it stays the collapsed one-line summary
        render(<BuildModelWindow />);
        await deliverData();
        expect(screen.queryByTestId('add-model-form')).toBeNull();
        expect(document.querySelector('.bmw-sets-sum')!.textContent).toContain('Model One');
    });

    it('switching the kind tab or the page puts the scroll area back at the top', async () => {
        await hsMount([HS_IND(), HS_REL()]);
        const sc = () => screen.getByTestId('wb-scroll');
        const el = sc();
        el.scrollTop = 180;
        fireEvent.click(screen.getByRole('tab', { name: /Relation model/ }));
        expect(sc()).toBe(el); // the same element — nothing was remounted
        expect(el.scrollTop).toBe(0);
        el.scrollTop = 90;
        fireEvent.click(screen.getByRole('tab', { name: /Individual/ }));
        expect(el.scrollTop).toBe(0);
        el.scrollTop = 60;
        await openHealthPage();
        expect(sc().scrollTop).toBe(0);
        sc().scrollTop = 40;
        fireEvent.click(screen.getByTestId('footer-back-to-fit'));
        expect(sc().scrollTop).toBe(0);
    });

    it('ONE date format: the footer prints "2026/02/09 23:50" in mono — never a locale date', async () => {
        await hsMount([{ ...HS_IND(), lastTrainedAt: '2026-02-09T23:50:00' }]);
        const line = screen.getByTestId('footer-status');
        expect(line.textContent).toMatch(/^Trained 2026\/02\/09 23:50( · scored on \d+ periods?)? · check the charts, then set the health set points$/);
        expect(line.querySelector('.wbx-dt')!.textContent).toBe('2026/02/09 23:50');
        expect(line.textContent).not.toMatch(/\b(AM|PM)\b|\d{4}-\d{2}-\d{2}|T\d\d:|Feb|:\d\d:\d\d/); // no locale form, no month name, no seconds
        expect(screen.getByTestId('wb-footer').querySelectorAll('.model-status-pill')).toHaveLength(1);
        expect(screen.getByTestId('footer-pill').textContent).toBe('Trained');
    });

    it('"Training the … · about N s" only for a model IN THE RUN; a trained model whose result is worked out again says "Loading the … model…" (no time estimate)', async () => {
        const gated = () => {
            let release: () => void = () => {};
            const gate = new Promise<void>(r => { release = r; });
            mockInvoke.mockImplementation((cmd: string, args?: any) =>
                cmd === 'compute_sensor_stats' && args?.sensor === 'TAG2' ? gate.then(() => defaultInvoke(cmd, args)) : defaultInvoke(cmd, args));
            return () => act(async () => { release(); await Promise.resolve(); await Promise.resolve(); });
        };
        // 1) in the run
        let release = gated();
        const ind = makeModel({ id: 'i2', name: 'Temp I', targetSensor: 'TAG2' });
        statefulUpdateMock([ind]);
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [ind] } });
        await act(async () => { fireEvent.click(trainSensorBtn()); await Promise.resolve(); await Promise.resolve(); });
        const run = screen.getByTestId('results-loading');
        expect(run.querySelector('.wbx-msg-t')!.textContent).toMatch(/^Training the Individual model · about \d+ s$/);
        expect(run.querySelector('.wbx-msg-s')!.textContent).toBe('Its settings are locked until it finishes. The charts appear here when it is done.');
        expect(run.querySelector('.pm-spin')).not.toBeNull();
        await release();
        cleanup();
        // 2) reopening a trained model: the silent recompute is "Loading", never "Training"
        release = gated();
        const trained = withTrained(makeModel({ id: 'i2', name: 'Temp I', targetSensor: 'TAG2' }));
        statefulUpdateMock([trained]);
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models: [trained] } });
        const load = screen.getByTestId('results-loading');
        expect(load.querySelector('.wbx-msg-t')!.textContent).toBe('Loading the Individual model…');
        expect(load.textContent).not.toMatch(/Training|about \d/);
        await release();
    });
});


// ─────────────────────────────────────────────────────────────────────────
// Spec workbench-redesign §6 (Train sensor /
// Train all copy) and §7 (page states). Every chart-less state of every KIND
// follows the spine rules: ONE board shape (title · one sentence · optional mono
// line) whose actions are text links, the status said once in the footer
// sentence, at most one filled button (`data-primary`), "Loading the … model…"
// for a trained model being worked out again vs "Training the … · about N s"
// for a model in the run — and no state is a dead end.
// ─────────────────────────────────────────────────────────────────────────
describe('Workbench redesign §7 — page states of every kind (phase D)', () => {
    // The Step-1 row count asks `compute_sensor_stats` for TAG1, so the Individual model sits
    // on TAG2: its own train can then be held / failed without touching that count.
    const KINDS = [
        {
            kind: 'individual', name: 'Individual model', tab: 'Individual', trains: 'Trains Individual', secs: '1 s',
            make: (o: Record<string, any> = {}) => makeModel({ id: 'i1', targetSensor: 'TAG2', ...o }),
            isTrain: (cmd: string, args: any) => cmd === 'compute_sensor_stats' && args?.sensor === 'TAG2',
        },
        {
            kind: 'relationship', name: 'Relation model', tab: 'Relation model', trains: 'Trains the Relation model', secs: '15 s',
            make: (o: Record<string, any> = {}) => makeModel({ id: 'r1', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2'], relStiffness: 10_000, ...o }),
            isTrain: (cmd: string) => cmd === 'preview_relationship_model',
        },
        {
            kind: 'clustering', name: 'Clustering model', tab: 'Clustering', trains: 'Trains Clustering', secs: '2 s',
            make: (o: Record<string, any> = {}) => makeModel({ id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2', numClusters: 1, ...o }),
            isTrain: (cmd: string) => cmd === 'compute_clustering_preview',
        },
    ] as const;
    type K = typeof KINDS[number];
    const each = it.each(KINDS.map(k => [k.kind, k] as const));

    const boardOf = (id: string) => {
        const b = screen.getByTestId(id);
        return {
            el: b,
            title: b.querySelector('.wbx-msg-t')!.textContent,
            text: b.querySelector('.wbx-msg-s')?.textContent ?? null,
            detail: b.querySelector('.wbx-msg-d')?.textContent ?? null,
            // a board never has a button-shaped control of its own: its actions are text links
            buttonShaped: b.querySelectorAll('.rcx-btn, .f4-btn, .bmw-btn-ok, .f4-btn-save').length,
        };
    };
    const foot = () => screen.getByTestId('wb-footer');
    const sentence = () => foot().querySelector('.wbx-reason')!.textContent;
    const primary = () => foot().getAttribute('data-primary');
    const pill = () => screen.getByTestId('footer-pill').textContent;
    const filled = () => Array.from(document.querySelectorAll<HTMLElement>('.rcx-btn--pri, .rcx-btn--danger, .f4-btn-save, .bmw-btn-ok'))
        .filter(b => !b.classList.contains('tq-split-caret') && !b.closest('[role="dialog"]'))
        .map(b => b.getAttribute('data-testid'));
    const lastModel = async (id: string) => (await mockUpdateWorkspaceData.mock.results[mockUpdateWorkspaceData.mock.results.length - 1]?.value)?.failureGroupState.models.find((m: any) => m.id === id);
    const mountK = async (models: any[], extraFg: Record<string, any> = {}) => {
        statefulUpdateMock(models, extraFg);
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models, ...extraFg } });
        await flush();
    };
    /** The model's own train command answers what `mode` says; everything else as usual. */
    const trainAnswers = (k: K, mode: { current: 'ok' | 'fail' | 'hold' }) => {
        let release: () => void = () => {};
        const gate = new Promise<void>(r => { release = r; });
        mockInvoke.mockImplementation((cmd: string, args?: any) => {
            if (!k.isTrain(cmd, args)) return healthInvoke(cmd, args);
            if (mode.current === 'fail') return Promise.reject(new Error('the engine stopped'));
            if (mode.current === 'hold') return gate.then(() => healthInvoke(cmd, args));
            return healthInvoke(cmd, args);
        });
        return () => act(async () => { release(); await Promise.resolve(); await Promise.resolve(); });
    };
    const trainCalls = (k: K) => mockInvoke.mock.calls.filter(c => k.isTrain(c[0] as string, c[1])).length;
    const openMenu = () => fireEvent.click(screen.getByTestId('train-sensor-menu-toggle'));
    const menuRow = (k: K) => {
        const el = screen.getByTestId(`train-menu-only-${k.kind}`);
        return { label: el.firstChild!.textContent, small: el.querySelector('small')!.textContent };
    };

    each('%s — not trained: the "Not trained yet" board points at Train sensor ↑; the footer says it once; Train sensor is the one filled button', async (_n, k) => {
        mockInvoke.mockImplementation(healthInvoke);
        await mountK([k.make()]);
        const b = boardOf('results-placeholder');
        expect(b.title).toBe('Not trained yet');
        expect(b.text).toBe('Train it with Train sensor ↑ — the charts of the trained model appear here.');
        expect(b.detail).toBe(`${k.tab} · uses the workspace running condition · ≈ ${k.secs}`);
        expect(b.buttonShaped).toBe(0);
        expect(pill()).toBe('Incomplete');
        expect(sentence()).toBe('Not trained yet · Train sensor ↑');
        expect(primary()).toBe('train');
        expect(filled()).toEqual(['train-sensor']);
        // §6: filled "▶ Train sensor · n of m", one short line under it, a menu row with its state line
        expect(trainSensorBtn().textContent).toBe('▶ Train sensor · 1 of 1');
        expect(trainSensorWhy()).toBe(`${k.trains} · ≈ ${k.secs}`);
        openMenu();
        expect(screen.queryByTestId('train-menu-retrain-all')).toBeNull(); // one model: never "Train all 1 model"
        expect(menuRow(k)).toEqual({ label: `Train the ${k.name}`, small: `Not trained yet · ≈ ${k.secs}` });
        // the board's link goes to the ONE place to train
        fireEvent.click(within(b.el).getByTestId('board-train-sensor'));
        expect(document.activeElement).toBe(trainSensorBtn());
    });

    each('%s — training (in the run) reads "Training the … · about N s"; a trained model being worked out again reads "Loading the … model…" (no estimate)', async (_n, k) => {
        const mode = { current: 'hold' as 'ok' | 'fail' | 'hold' };
        const release = trainAnswers(k, mode);
        await mountK([k.make()]);
        await act(async () => { fireEvent.click(trainSensorBtn()); await Promise.resolve(); await Promise.resolve(); });
        await waitFor(() => expect(boardOf('results-loading').title).toBe(`Training the ${k.name} · about ${k.secs}`));
        expect(boardOf('results-loading').text).toBe('Its settings are locked until it finishes. The charts appear here when it is done.');
        expect(boardOf('results-loading').el.className).toContain('wbx-msg--run');
        expect(sentence()).toBe(` Training now · about ${k.secs}`);
        expect(screen.getByTestId('settings-locked')).toBeTruthy();
        await release();
        await waitFor(() => expect(screen.getByTestId('train-run-strip').getAttribute('data-phase')).toBe('done'));
        cleanup();

        // The same model, trained, opened again: its result is worked out silently.
        mockInvoke.mockClear();
        const mode2 = { current: 'hold' as 'ok' | 'fail' | 'hold' };
        const release2 = trainAnswers(k, mode2);
        await mountK([withTrained(k.make())]);
        const load = boardOf('results-loading');
        expect(load.title).toBe(`Loading the ${k.name}…`);
        expect(load.text).toBe('The charts appear here when it is ready.');
        expect(load.el.textContent).not.toMatch(/Training|about \d/);
        expect(sentence()).not.toMatch(/Training now|Queued/);
        expect(screen.queryByTestId('train-run-strip')).toBeNull(); // not a run
        await release2();
    });

    each('%s — stale: the banner has no button, the board and the footer point at Train sensor ↑, which is the one filled button', async (_n, k) => {
        mockInvoke.mockImplementation(healthInvoke);
        await mountK([{ ...withTrained(k.make()), trainedFingerprint: 'old' }]);
        const banner = screen.getByTestId('stale-banner');
        expect(banner.textContent).toBe('Settings or running condition changed — this model is Incomplete again. Train it again with Train sensor ↑ to update the charts. Your set points are kept.');
        expect(banner.querySelector('.rcx-btn')).toBeNull();
        const b = boardOf('results-stale');
        expect(b.title).toBe('Out of date');
        expect(b.text).toBe('Settings or running condition changed — train it again with Train sensor ↑ to see the charts.');
        expect(b.buttonShaped).toBe(0);
        expect(pill()).toBe('Incomplete');
        expect(sentence()).toBe('Settings or running condition changed · train again with Train sensor ↑');
        expect(primary()).toBe('train');
        expect(filled()).toEqual(['train-sensor']);
        expect(trainSensorBtn().textContent).toBe('▶ Train sensor · 1 of 1');
        openMenu();
        expect(menuRow(k)).toEqual({ label: `Re-train the ${k.name}`, small: `Settings changed since it was trained · ≈ ${k.secs}` });
    });

    each('%s — blocked by the gate (no running condition): the lock board links to "Running condition ↑"; the card holds the only filled button', async (_n, k) => {
        mockInvoke.mockImplementation(healthInvoke);
        await mountK([k.make()], { runningConditionNoneConfirmed: false, rcLegacyNotice: null });
        fireEvent.click(screen.getByLabelText('Close')); // the auto-opened settings modal
        const lock = boardOf('results-rc-locked');
        expect(lock.title).toBe('Set the running condition first');
        expect(lock.text).toBe('Nothing that follows the workspace running condition can train until it is set — open Running condition ↑');
        expect(lock.buttonShaped).toBe(0);
        expect(pill()).toBe('Incomplete');
        expect(foot().querySelector('.wbx-reason')!.getAttribute('data-testid')).toBe('build-block-reason');
        expect(primary()).toBe('none');
        expect(filled()).toEqual(['rc-card-open']);
        // Train sensor: a ghost without "· n of m", disabled, with the reason as its one line
        expect(trainSensorBtn().textContent).toBe('▶ Train sensor');
        expect(trainSensorBtn().disabled).toBe(true);
        expect(trainSensorWhy()).toBe('Set the running condition first.');
        expect(screen.getByTestId('wb-footer').textContent).not.toMatch(/Fill in the required fields/);
    });

    each('%s — blocked by its own invalid Custom running condition: the reason is on the board and in the footer; no filled button; Train sensor only points down', async (_n, k) => {
        mockInvoke.mockImplementation(healthInvoke);
        await mountK([k.make({
            runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true,
            filterTimePeriods: [{ id: 'o1', start: '2026-03-01T00:00', end: '2026-02-01T00:00' }],
        })]);
        expect(within(screen.getByTestId('results-incomplete')).getByText("Fix P1's end above")).toBeTruthy();
        expect(screen.getByTestId('results-incomplete').querySelector('.wbx-msg-t')!.textContent).toBe('1 item to fix before training');
        expect(screen.getByTestId('build-block-reason').textContent).toBe("Fix P1's end above");
        expect(pill()).toBe('Incomplete');
        expect(primary()).toBe('none');
        expect(filled()).toEqual([]);
        expect(trainSensorBtn().textContent).toBe('▶ Train sensor');
        expect(trainSensorBtn().disabled).toBe(true);
        expect(trainSensorWhy()).toBe("Can't train · see below"); // short: the reason is said once, below
        expect(trainSensorBtn().title).toBe(`Can't train: ${k.tab} — Train period P1 ends before it starts`);
    });

    each('%s — failed (not Complete): "Training failed" with Train sensor ↑ — which really trains it again', async (_n, k) => {
        const mode = { current: 'fail' as 'ok' | 'fail' | 'hold' };
        trainAnswers(k, mode);
        await mountK([k.make()]);
        await act(async () => { fireEvent.click(trainSensorBtn()); await Promise.resolve(); await Promise.resolve(); });
        await waitFor(() => expect(screen.getByTestId('results-error')).toBeTruthy());
        const b = boardOf('results-error');
        expect(b.title).toBe('Training failed');
        expect(b.text).toBe('Fix the problem, then train again with Train sensor ↑. The model keeps its last state.');
        expect(b.detail).toBe('the engine stopped');
        expect(b.el.className).toContain('wbx-msg--bad');
        expect(b.buttonShaped).toBe(0);
        expect(pill()).toBe('Incomplete');
        expect(sentence()).toBe('Training failed · fix the problem, then Train sensor ↑');
        expect(foot().querySelector('.wbx-reason')!.getAttribute('data-tone')).toBe('bad');
        expect(screen.getByTestId(`tab-status-${k.make().id}`).getAttribute('data-dot')).toBe('bad');
        expect(screen.getByTestId(`tab-status-${k.make().id}`).getAttribute('title')).toBe('Training failed');
        await waitFor(() => expect(primary()).toBe('train'));
        expect(trainSensorBtn().disabled).toBe(false);
        openMenu();
        expect(menuRow(k).small).toBe(`Failed last run · ≈ ${k.secs}`);
        fireEvent.keyDown(window, { key: 'Escape' });
        // not a dead end: the same button trains it once the problem is gone
        mode.current = 'ok';
        const before = trainCalls(k);
        await act(async () => { fireEvent.click(trainSensorBtn()); await Promise.resolve(); await Promise.resolve(); });
        await waitFor(() => expect(trainCalls(k)).toBe(before + 1));
        await waitFor(() => expect(screen.queryByTestId('results-error')).toBeNull());
        await waitFor(async () => expect((await lastModel(k.make().id)).lastTrainedAt).toBeTruthy());
    });

    // Leftover of 0ce26a9: a COMPLETE model whose silent load on open failed (not a lost fit)
    // used to show "Training failed … Train sensor ↑" — but Train sensor never trains an
    // up-to-date Complete model, so that was a dead end.
    each('%s — COMPLETE and its load failed: "Couldn\'t load the …" with "Load it again" (nothing written, stays Complete) and the ▾ menu — never Train sensor ↑', async (_n, k) => {
        const mode = { current: 'fail' as 'ok' | 'fail' | 'hold' };
        trainAnswers(k, mode);
        const model: Record<string, any> = { ...withTrained(k.make()), status: true };
        await mountK([model]);
        await waitFor(() => expect(screen.getByTestId('results-load-failed')).toBeTruthy());
        expect(screen.queryByTestId('results-error')).toBeNull(); // not the "Training failed" board
        const b = boardOf('results-load-failed');
        expect(b.title).toBe(`Couldn't load the ${k.name}`);
        expect(b.text).toBe('Nothing about the model changed and it stays Complete — Load it again, or train it from the Train sensor ▾ menu (it then needs Mark complete again). The charts come back when it is loaded.');
        expect(b.detail).toBe('the engine stopped');
        expect(b.el.className).toContain('wbx-msg--bad');
        expect(b.buttonShaped).toBe(0);
        // never a link that cannot work: Train sensor is a disabled ghost for an up-to-date Complete model
        expect(b.el.textContent).not.toContain('Train sensor ↑');
        expect(within(b.el).queryByTestId('board-train-sensor')).toBeNull();
        expect(trainSensorBtn().disabled).toBe(true);
        expect(trainSensorBtn().textContent).toBe('▶ Train sensor');
        expect(trainSensorWhy()).toBe('1 model up to date — nothing to train');
        // the footer says it once, with the same way out; the model is still Complete
        expect(pill()).toBe('Complete');
        expect(sentence()).toBe("Couldn't load the model · load it again");
        expect(foot().querySelector('.wbx-reason')!.getAttribute('data-tone')).toBe('bad');
        expect(primary()).toBe('none');
        expect(filled()).toEqual([]);
        // the Health score page stays shut meanwhile, and its tooltip names the way back that works
        expect((screen.getByTestId('next-health-score') as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByTestId('next-health-score').getAttribute('title')).toBe('Load the model again first');
        expect(screen.getByTestId(`tab-status-${model.id}`).getAttribute('title')).toBe("Complete · Couldn't load the model");
        expect(screen.getByTestId(`tab-status-${model.id}`).getAttribute('data-dot')).toBe('bad');
        // the ▾ link opens the menu whose row really trains it
        fireEvent.click(within(b.el).getByTestId('board-train-menu'));
        expect((screen.getByTestId(`train-menu-only-${k.kind}`) as HTMLButtonElement).disabled).toBe(false);
        expect(menuRow(k)).toEqual({ label: `Re-train the ${k.name}`, small: 'Up to date · trains anyway · it becomes Incomplete' });
        fireEvent.keyDown(window, { key: 'Escape' });

        // "Load it again" fails again: back on the same board (never stuck on "Loading…")
        const writesBefore = mockUpdateWorkspaceData.mock.calls.length;
        let calls = trainCalls(k);
        await act(async () => { fireEvent.click(screen.getByTestId('board-load-again')); await Promise.resolve(); await Promise.resolve(); });
        await waitFor(() => expect(trainCalls(k)).toBe(calls + 1));
        await waitFor(() => expect(screen.getByTestId('results-load-failed')).toBeTruthy());

        // ...and once the problem is gone it loads: the charts are back, NOTHING was written, still Complete
        mode.current = 'ok';
        calls = trainCalls(k);
        await act(async () => { fireEvent.click(screen.getByTestId('board-load-again')); await Promise.resolve(); await Promise.resolve(); });
        await waitFor(() => expect(trainCalls(k)).toBe(calls + 1));
        await waitFor(() => expect(screen.getByTestId('results-chart')).toBeTruthy());
        expect(screen.queryByTestId('results-load-failed')).toBeNull();
        expect(pill()).toBe('Complete');
        expect(sentence()).not.toMatch(/Couldn't load/);
        expect(screen.getByTestId(`tab-status-${model.id}`).getAttribute('title')).toBe('Complete');
        const written = mockUpdateWorkspaceData.mock.calls.length > writesBefore ? await lastModel(model.id) : model;
        expect(written.status).toBe(true);
        expect(written.lastTrainedAt).toBe(model.lastTrainedAt);
        expect(written.trainedFingerprint).toBe(model.trainedFingerprint);
        // no training run was started for it
        expect(screen.queryByTestId('train-run-strip')).toBeNull();
    });

    each('%s — the charts could not be loaded (preview error): the board says the model is kept and offers "Try again", which asks again', async (_n, k) => {
        let fail = true;
        mockInvoke.mockImplementation((cmd: string, args?: any) =>
            cmd === 'compute_health_preview' && fail ? Promise.reject('NO_DATA: no rows in the training scope') : healthInvoke(cmd, args));
        await mountK([withTrained(k.make())]);
        await waitFor(() => expect(screen.getByTestId('results-health-error')).toBeTruthy());
        const b = boardOf('results-health-error');
        expect(b.title).toBe("Couldn't load the charts");
        expect(b.text).toBe('The trained model is kept — Try again.');
        expect(b.detail).toMatch(/no rows in the training scope/);
        expect(b.buttonShaped).toBe(0);
        expect(pill()).toBe('Trained');
        const before = healthCalls().length;
        fail = false;
        fireEvent.click(within(b.el).getByTestId('board-retry-charts'));
        await waitFor(() => expect(healthCalls().length).toBeGreaterThan(before));
        await waitFor(() => expect(screen.getByTestId('results-chart')).toBeTruthy());
        expect(screen.queryByTestId('results-health-error')).toBeNull();
    });

    // Leftover 3: with the workspace running condition unset, "Set running condition →" is the
    // only filled button — but a model on its OWN (Custom) condition is not blocked: its
    // Train sensor is a ghost that works, and the line under it must say so.
    each('%s — a Custom-mode model while the workspace running condition is unset: Train sensor is a working ghost and its line says nothing is blocked', async (_n, k) => {
        mockInvoke.mockImplementation(healthInvoke);
        const custom = k.make({ runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true, filterTimePeriods: ALL_TIME_TRAIN });
        await mountK([custom], { runningConditionNoneConfirmed: false, rcLegacyNotice: null });
        fireEvent.click(screen.getByLabelText('Close')); // the auto-opened settings modal
        expect(screen.queryByTestId('results-rc-locked')).toBeNull();
        expect(filled()).toEqual(['rc-card-open']);
        expect(primary()).toBe('none');
        expect(trainSensorBtn().className).not.toContain('rcx-btn--pri');
        expect(trainSensorBtn().disabled).toBe(false);
        expect(trainSensorBtn().textContent).toBe('▶ Train sensor · 1 of 1');
        expect(trainSensorWhy()).toBe(`${k.trains} · own running condition, not blocked`);
        expect(screen.getByTestId('train-sensor-why').className).not.toMatch(/tq-why--(warn|danger)/);
        expect(boardOf('results-placeholder').detail).toBe(`${k.tab} · uses its own running condition (Custom) · ≈ ${k.secs}`);
        // it works
        const before = trainCalls(k);
        await act(async () => { fireEvent.click(trainSensorBtn()); await Promise.resolve(); await Promise.resolve(); });
        await waitFor(() => expect(trainCalls(k)).toBe(before + 1));
        await waitFor(() => expect(screen.getByTestId('train-run-strip').getAttribute('data-phase')).toBe('done'));
        // trained: nothing left to train, and still "not blocked" — never "Set the running condition first."
        await waitFor(() => expect(trainSensorWhy()).toBe('1 model up to date — nothing to train · own running condition, not blocked'));
        expect(trainSensorBtn().textContent).toBe('▶ Train sensor');
        expect(filled()).toEqual(['rc-card-open']);
    });

    it('a workspace-mode sibling of that Custom model IS blocked: the line names both — what trains, and what can\'t', async () => {
        mockInvoke.mockImplementation(healthInvoke);
        const custom = makeModel({ id: 'i1', targetSensor: 'TAG2', runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true, filterTimePeriods: ALL_TIME_TRAIN });
        const ws = makeModel({ id: 'r1', kind: 'relationship', targetSensor: 'TAG2', predictorSensors: ['TAG1'] });
        await mountK([custom, ws], { runningConditionNoneConfirmed: false, rcLegacyNotice: null });
        fireEvent.click(screen.getByLabelText('Close'));
        expect(trainSensorWhy()).toBe("Trains Individual · own running condition, not blocked · Relation model can't train, skipped");
        expect(trainSensorBtn().textContent).toBe('▶ Train sensor · 1 of 2');
        expect(trainSensorBtn().disabled).toBe(false);
        openMenu();
        expect(screen.getByTestId('train-menu-only-relationship').querySelector('small')!.textContent).toBe('No running condition');
        expect((screen.getByTestId('train-menu-only-relationship') as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByTestId('train-menu-retrain-all').querySelector('small')!.textContent).toBe("≈ 1 s · 1 can't train, skipped");
    });

    // §6: "Fill in the required fields above first" is only true right under the form.
    it('a missing setting is NAMED outside the form (Train sensor tooltip, Train all); right under the form the shipped sentence stays', async () => {
        mockInvoke.mockImplementation(healthInvoke);
        const broken = makeModel({ id: 'r1', name: '', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: [] });
        const fine = makeModel({ id: 'i2', name: 'Temp I', targetSensor: 'TAG2' });
        await mountK([broken, fine]);
        fireEvent.click(screen.getAllByTestId('sensor-row-label').find(e => e.textContent?.includes('Pump Pressure'))!);
        await flush();
        // under the form: "above" is true, the shipped sentence stays
        expect(screen.getByTestId('build-block-reason').textContent).toBe('Fill in the required fields above first');
        // header: one short line, the tooltip names the first missing setting and counts the rest
        expect(trainSensorWhy()).toBe("Can't train · see below");
        expect(trainSensorBtn().title).toBe("Can't train: Relation model — Model name is required (+1 more)");
        expect(trainSensorBtn().title).not.toMatch(/Fill in the required fields|above/);
        // Train all: amber "Skipped" + Fix →, the named reason on its own line
        await act(async () => { fireEvent.click(screen.getByTestId('train-all')); });
        expect(screen.getByTestId('train-row-status-r1').textContent).toBe('Skipped');
        expect(screen.getByTestId('train-row-note-r1').textContent).toBe('Model name is required (+1 more)');
        expect(screen.getByTestId('train-row-status-i2').textContent).toBe('Ready');
        expect(screen.getByTestId('train-all-foot').textContent).toBe("Trains 1 model; the 1 that can't train stays as it is");
        expect(screen.getByTestId('train-all-modal').textContent).not.toMatch(/Fill in the required fields|above first/);
    });

    // ---- Follow-up cases ----

    // A1: a Complete model with NO train record ("Marked complete" before train records
    // existed) whose train from the ▾ row failed used to read "Couldn't load the model · load
    // it again" — a link that did nothing (there is no fit to load), with the reason nowhere.
    each('%s — COMPLETE with no train record whose ▾ train failed: "Training failed", the reason on the "Marked complete" board, the ▾ menu as the way out — never "load it again"', async (_n, k) => {
        const mode = { current: 'fail' as 'ok' | 'fail' | 'hold' };
        trainAnswers(k, mode);
        const model: Record<string, any> = k.make({ status: true }); // Complete, never trained on record
        await mountK([model]);
        expect(boardOf('results-placeholder').title).toBe('Marked complete');
        expect(boardOf('results-placeholder').detail).toBeNull();
        expect(pill()).toBe('Complete');
        mockUpdateWorkspaceData.mockClear();
        openMenu();
        await act(async () => { fireEvent.click(screen.getByTestId(`train-menu-only-${k.kind}`)); await Promise.resolve(); await Promise.resolve(); });
        await waitFor(() => expect(screen.getByTestId('board-train-error')).toBeTruthy());
        const b = boardOf('results-placeholder');
        expect(b.title).toBe('Marked complete');
        expect(b.text).toBe(`Training it did not work, so it still has no charts. Fix the problem, then train it again from the Train sensor ▾ menu (“Train the ${k.name}”). It then needs Mark complete again.`);
        expect(b.detail).toBe('Training failed: the engine stopped');
        expect(b.el.className).toContain('wbx-msg--bad');
        expect(b.buttonShaped).toBe(0);
        // never the "load it again" state: there is nothing to load
        expect(screen.queryByTestId('results-load-failed')).toBeNull();
        expect(screen.queryByTestId('footer-load-again')).toBeNull();
        expect(screen.queryByTestId('board-load-again')).toBeNull();
        // footer, tab and list say the same thing; the model is still Complete and nothing was written
        expect(pill()).toBe('Complete');
        expect(sentence()).toBe('Training failed · train it again from the Train sensor ▾ menu');
        expect(foot().querySelector('.wbx-reason')!.getAttribute('data-tone')).toBe('bad');
        expect(screen.getByTestId(`tab-status-${model.id}`).getAttribute('title')).toBe('Complete · Training failed');
        expect(screen.getByTestId(`tab-status-${model.id}`).getAttribute('data-dot')).toBe('bad');
        expect(screen.getByTestId(`sensor-kind-badge-${model.id}`).getAttribute('title')).toBe(`${k.tab} · Complete · Training failed`);
        expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
        // the way out works: the footer link opens the menu, whose row trains it once the problem is gone
        fireEvent.click(screen.getByTestId('footer-train-menu'));
        expect((screen.getByTestId(`train-menu-only-${k.kind}`) as HTMLButtonElement).disabled).toBe(false);
        mode.current = 'ok';
        const before = trainCalls(k);
        await act(async () => { fireEvent.click(screen.getByTestId(`train-menu-only-${k.kind}`)); await Promise.resolve(); await Promise.resolve(); });
        await waitFor(() => expect(trainCalls(k)).toBe(before + 1));
        await waitFor(() => expect(screen.queryByTestId('board-train-error')).toBeNull());
        await waitFor(async () => expect((await lastModel(model.id)).lastTrainedAt).toBeTruthy());
    });

    // A2: the stale banner's "Train sensor ↑" was a dead link whenever Train sensor would not
    // train THIS model.
    describe('stale banner: no link when Train sensor would not train this model', () => {
        const banner = () => screen.getByTestId('stale-banner');

        it('stale + blocked (a trained Relation model whose predictors were removed): the reason, no link', async () => {
            mockInvoke.mockImplementation(healthInvoke);
            const rel = makeModel({ id: 'r1', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2'], relStiffness: 10_000 });
            await mountK([{ ...withTrained(rel), predictorSensors: [] }]);
            expect(banner().getAttribute('data-state')).toBe('blocked');
            expect(banner().textContent).toBe("Settings or running condition changed — this model is Incomplete again. It can't be trained yet: Add at least 1 predictor. Your set points are kept.");
            expect(screen.queryByTestId('stale-go-train')).toBeNull();
            expect(banner().querySelectorAll('button')).toHaveLength(0);
            expect(trainSensorBtn().disabled).toBe(true);
        });

        it('stale + a run active on ANOTHER model: "when the training run finishes", no link; the link is back once the run is done', async () => {
            let release: () => void = () => {};
            const gate = new Promise<void>(r => { release = r; });
            mockInvoke.mockImplementation((cmd: string, args?: any) =>
                cmd === 'preview_relationship_model' ? gate.then(() => healthInvoke(cmd, args)) : healthInvoke(cmd, args));
            const stale = { ...withTrained(makeModel({ id: 'i1', targetSensor: 'TAG2' })), trainedFingerprint: 'old' };
            const rel = makeModel({ id: 'r1', kind: 'relationship', targetSensor: 'TAG2', predictorSensors: ['TAG1'] });
            await mountK([stale, rel]);
            expect(screen.getByTestId('stale-go-train')).toBeTruthy(); // nothing in the way yet
            openMenu();
            await act(async () => { fireEvent.click(screen.getByTestId('train-menu-only-relationship')); await Promise.resolve(); await Promise.resolve(); });
            await waitFor(() => expect(screen.getByTestId('train-run-strip').getAttribute('data-phase')).toBe('running'));
            expect(banner().getAttribute('data-state')).toBe('blocked');
            expect(screen.getByTestId('stale-cant-train').getAttribute('data-kind')).toBe('run');
            expect(banner().textContent).toBe('Settings or running condition changed — this model is Incomplete again. Train it again when the training run finishes. Your set points are kept.');
            expect(screen.queryByTestId('stale-go-train')).toBeNull();
            await act(async () => { release(); await Promise.resolve(); await Promise.resolve(); });
            await waitFor(() => expect(screen.getByTestId('train-run-strip').getAttribute('data-phase')).toBe('done'));
            await waitFor(() => expect(screen.getByTestId('stale-go-train')).toBeTruthy());
        });

        it('stale + the data in this window is out of date (STALE_SESSION): that sentence, no link', async () => {
            mockInvoke.mockImplementation((cmd: string, args?: any) => cmd === 'get_session_generation' ? Promise.resolve(6) : healthInvoke(cmd, args));
            const stale = { ...withTrained(makeModel({ id: 'i1', targetSensor: 'TAG2' })), trainedFingerprint: 'old' };
            statefulUpdateMock([stale]);
            render(<BuildModelWindow />);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [stale] } }, { metadata: { headers: ['timestamp', 'TAG1', 'TAG2', 'TAG3'], total_rows: 100, generation: 5 } });
            await flush();
            await act(async () => { fireEvent.click(trainSensorBtn()); await Promise.resolve(); await Promise.resolve(); });
            await waitFor(() => expect(screen.getByTestId('train-sensor-why').textContent).toBe('The data in this window is out of date. Close it and open Build Model again from the Dashboard.'));
            expect(banner().getAttribute('data-state')).toBe('blocked');
            expect(screen.getByTestId('stale-cant-train').getAttribute('data-kind')).toBe('stale');
            expect(banner().textContent).toBe('Settings or running condition changed — this model is Incomplete again. The data in this window is out of date. Close it and open Build Model again from the Dashboard. Your set points are kept.');
            expect(screen.queryByTestId('stale-go-train')).toBeNull();
        });
    });

    // A6: on the Health score page a train that failed leaves no preview to ask for — the page
    // used to be able to hang on "Loading…". (The page keeps the last answer of the model it
    // shows, so the state without one is reached from another tab: the model's Health score
    // page was open, a sibling's tab was opened, the model's ▾ re-train failed from there.)
    /** A TRAINED sibling model of another kind on the SAME sensor (its train is never
     *  `k.isTrain`): opening its tab asks for ITS preview, which replaces the answer the
     *  window held for the first model. */
    const siblingOf = (k: K) => withTrained(k.kind === 'individual'
        ? makeModel({ id: 'sib', kind: 'relationship', targetSensor: 'TAG2', predictorSensors: ['TAG1'] })
        : makeModel({ id: 'sib', targetSensor: 'TAG1' }));
    const tabOf = (label: string) => screen.getByRole('tab', { name: new RegExp(`^${label}`) });
    const failRetrainFromSiblingTab = async (k: K, mode: { current: 'ok' | 'fail' | 'hold' }) => {
        fireEvent.click(tabOf(k.tab));
        await waitFor(() => expect(screen.getByTestId('results-chart')).toBeTruthy());
        fireEvent.click(screen.getByTestId('next-health-score'));
        await waitFor(() => expect(screen.getByTestId('set-points-card')).toBeTruthy());
        fireEvent.click(tabOf(k.kind === 'individual' ? 'Relation model' : 'Individual'));
        await waitFor(() => expect(screen.getByTestId('results-chart')).toBeTruthy()); // the sibling's own answer
        mode.current = 'fail';
        const calls = trainCalls(k);
        openMenu();
        await act(async () => { fireEvent.click(screen.getByTestId(`train-menu-only-${k.kind}`)); await Promise.resolve(); await Promise.resolve(); });
        await waitFor(() => expect(trainCalls(k)).toBe(calls + 1));
        await waitFor(() => expect(screen.getByTestId('train-run-strip').getAttribute('data-phase')).toBe('done'));
        fireEvent.click(tabOf(k.tab)); // back: its Health score page, with no answer of its own left
    };
    each('%s — on the Health score page a ▾ re-train that failed (not Complete): the "Training failed" board with Train sensor ↑, never "Loading…"', async (_n, k) => {
        const mode = { current: 'ok' as 'ok' | 'fail' | 'hold' };
        trainAnswers(k, mode);
        await mountK([withTrained(k.make()), siblingOf(k)]);
        await failRetrainFromSiblingTab(k, mode);
        await waitFor(() => expect(screen.getByTestId('health-train-failed')).toBeTruthy());
        const b = boardOf('health-train-failed');
        expect(b.title).toBe('Training failed');
        expect(b.text).toBe('Fix the problem, then train again with Train sensor ↑. Your set points are kept.');
        expect(b.detail).toBe('the engine stopped');
        expect(screen.queryByTestId('health-loading')).toBeNull();
        expect(screen.queryByTestId('health-load-failed')).toBeNull();
        // the footer: why Mark complete is off, and Train sensor is the one filled button
        expect(sentence()).toBe("Couldn't refresh the result — fix the problem, then re-train.");
        expect((screen.getByTestId('mark-complete') as HTMLButtonElement).disabled).toBe(true);
        await waitFor(() => expect(primary()).toBe('train'));
        fireEvent.click(within(b.el).getByTestId('health-go-train-sensor'));
        expect(document.activeElement).toBe(trainSensorBtn());
    });

    each('%s — on the Health score page a ▾ re-train of a COMPLETE model that failed: "Couldn\'t load the …" on the page AND in the footer (red tab dot); the footer\'s "load it again" loads it — nothing written, still Complete', async (_n, k) => {
        const mode = { current: 'ok' as 'ok' | 'fail' | 'hold' };
        trainAnswers(k, mode);
        const model: Record<string, any> = { ...withTrained(k.make()), status: true };
        await mountK([model, siblingOf(k)]);
        await failRetrainFromSiblingTab(k, mode);
        await waitFor(() => expect(screen.getByTestId('footer-load-again')).toBeTruthy());
        // a failed train writes nothing: the model is still Complete
        expect(pill()).toBe('Complete');
        expect(sentence()).toBe("Couldn't load the model · load it again");
        expect(foot().querySelector('.wbx-reason')!.getAttribute('data-tone')).toBe('bad');
        expect(screen.getByTestId(`tab-status-${model.id}`).getAttribute('data-dot')).toBe('bad');
        expect(screen.getByTestId(`tab-status-${model.id}`).getAttribute('title')).toBe("Complete · Couldn't load the model");
        const b = boardOf('health-load-failed');
        expect(b.title).toBe(`Couldn't load the ${k.name}`);
        expect(b.detail).toBe('the engine stopped');
        expect(screen.queryByTestId('health-loading')).toBeNull();
        expect(screen.queryByTestId('health-train-failed')).toBeNull();
        // the footer link is the same silent load: it works once the problem is gone
        mode.current = 'ok';
        mockUpdateWorkspaceData.mockClear();
        const calls = trainCalls(k);
        expect((screen.getByTestId('footer-load-again') as HTMLButtonElement).disabled).toBe(false);
        await act(async () => { fireEvent.click(screen.getByTestId('footer-load-again')); await Promise.resolve(); await Promise.resolve(); });
        await waitFor(() => expect(trainCalls(k)).toBe(calls + 1));
        await waitFor(() => expect(screen.getByTestId('set-points-card')).toBeTruthy());
        expect(screen.queryByTestId('health-load-failed')).toBeNull();
        expect(screen.queryByTestId('footer-load-again')).toBeNull();
        expect(pill()).toBe('Complete');
        expect(screen.getByTestId(`tab-status-${model.id}`).getAttribute('title')).toBe('Complete');
        // nothing about the model was written by the load (status / train record untouched)
        for (const r of mockUpdateWorkspaceData.mock.results) {
            const m = (await r.value).failureGroupState.models.find((x: any) => x.id === model.id);
            expect(m).toMatchObject({ status: true, lastTrainedAt: model.lastTrainedAt, trainedFingerprint: model.trainedFingerprint });
        }
    });

    // A3: while the user's "load it again" runs, an earlier answer may still be on screen —
    // "Mark complete again" must not be enabled from it.
    it('Complete + files out of date + a failed ▾ re-train: "Mark complete again" stays disabled while "load it again" runs, and is back when it has loaded', async () => {
        const k = KINDS[0];
        const mode = { current: 'ok' as 'ok' | 'fail' | 'hold' };
        const release = trainAnswers(k, mode);
        const model: Record<string, any> = {
            ...withTrained(k.make({ healthSetPoints: HS_SNAP })), status: true,
            healthExport: { at: '2026-10-04T01:00:00.000Z', outputDir: 'C:/data/workspaces/ws1/output', setPoints: { ...HS_SNAP, upper: 12 }, scoringIntervalSecs: 3600 },
        };
        await mountK([model]);
        await waitFor(() => expect(screen.getByTestId('results-chart')).toBeTruthy());
        fireEvent.click(screen.getByTestId('next-health-score'));
        await waitFor(() => expect(screen.getByTestId('set-points-card')).toBeTruthy());
        const again = () => screen.getByTestId('mark-complete-again') as HTMLButtonElement;
        await waitFor(() => expect(again().disabled).toBe(false));
        mode.current = 'fail';
        openMenu();
        await act(async () => { fireEvent.click(screen.getByTestId(`train-menu-only-${k.kind}`)); await Promise.resolve(); await Promise.resolve(); });
        await waitFor(() => expect(screen.getByTestId('footer-load-again')).toBeTruthy());
        expect(again().disabled).toBe(true);
        expect(screen.getByTestId('files-out-of-date').textContent).toBe("Files out of date · Couldn't load the model · load it again");
        // the load is asked for and held: not enabled meanwhile
        mode.current = 'hold';
        const calls = trainCalls(k);
        await act(async () => { fireEvent.click(screen.getByTestId('footer-load-again')); await Promise.resolve(); await Promise.resolve(); });
        await waitFor(() => expect(trainCalls(k)).toBe(calls + 1));
        expect(again().disabled).toBe(true);
        expect(again().title).toBe('Checking the set points…');
        expect(exportCalls()).toHaveLength(0);
        await release();
        await waitFor(() => expect(again().disabled).toBe(false));
    });

    // A5 + A6: the disabled states of "Load it again" and of the ▾ menu phrase.
    it('Complete + load failed while a run is active on a sibling: "Load it again" (board and footer) is disabled with the reason, and the ▾ menu phrase says when instead of being a dead link', async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>(r => { release = r; });
        mockInvoke.mockImplementation((cmd: string, args?: any) => {
            if (cmd === 'compute_sensor_stats' && args?.sensor === 'TAG2') return Promise.reject(new Error('the engine stopped'));
            if (cmd === 'preview_relationship_model') return gate.then(() => healthInvoke(cmd, args));
            return healthInvoke(cmd, args);
        });
        const done: Record<string, any> = { ...withTrained(makeModel({ id: 'i1', targetSensor: 'TAG2' })), status: true };
        const rel = makeModel({ id: 'r1', kind: 'relationship', targetSensor: 'TAG2', predictorSensors: ['TAG1'] });
        await mountK([done, rel]);
        await waitFor(() => expect(screen.getByTestId('results-load-failed')).toBeTruthy());
        const boardLink = () => screen.getByTestId('board-load-again') as HTMLButtonElement;
        const footLink = () => screen.getByTestId('footer-load-again') as HTMLButtonElement;
        expect(boardLink().disabled).toBe(false);
        expect(footLink().disabled).toBe(false);
        expect(screen.getByTestId('board-train-menu')).toBeTruthy();
        // Train sensor trains the sibling (the Complete model is up to date): a run is active
        await act(async () => { fireEvent.click(trainSensorBtn()); await Promise.resolve(); await Promise.resolve(); });
        await waitFor(() => expect(screen.getByTestId('train-run-strip').getAttribute('data-phase')).toBe('running'));
        expect(boardLink().disabled).toBe(true);
        expect(boardLink().title).toBe('Wait for the training run to finish');
        expect(footLink().disabled).toBe(true);
        expect(footLink().title).toBe('Wait for the training run to finish');
        expect(screen.queryByTestId('board-train-menu')).toBeNull(); // not a link that does nothing
        expect(screen.getByTestId('board-train-menu-blocked').textContent).toBe('(when the training run finishes)');
        expect(boardOf('results-load-failed').text).toBe('Nothing about the model changed and it stays Complete — Load it again, or train it from the Train sensor ▾ menu (when the training run finishes) (it then needs Mark complete again). The charts come back when it is loaded.');
        const calls = mockInvoke.mock.calls.filter(c => c[0] === 'compute_sensor_stats').length;
        fireEvent.click(boardLink());
        fireEvent.click(footLink());
        expect(mockInvoke.mock.calls.filter(c => c[0] === 'compute_sensor_stats')).toHaveLength(calls);
        await act(async () => { release(); await Promise.resolve(); await Promise.resolve(); });
        await waitFor(() => expect(screen.getByTestId('train-run-strip').getAttribute('data-phase')).toBe('done'));
        await waitFor(() => expect(boardLink().disabled).toBe(false));
        expect(screen.getByTestId('board-train-menu')).toBeTruthy();
    });

    // A6: the per-kind matrix rows that only checked the board.
    each('%s — preview error: the footer no longer says "check the charts" (it names what failed); STALE_SESSION has no "Try again" and says to reopen', async (_n, k) => {
        let reject: unknown = 'NO_DATA: no rows in the training scope';
        mockInvoke.mockImplementation((cmd: string, args?: any) =>
            cmd === 'compute_health_preview' ? Promise.reject(reject) : healthInvoke(cmd, args));
        await mountK([withTrained(k.make())]);
        await waitFor(() => expect(screen.getByTestId('results-health-error')).toBeTruthy());
        expect(pill()).toBe('Trained');
        expect(sentence()).toMatch(/^Trained .* · the charts did not load — try again above$/);
        expect(sentence()).not.toMatch(/check the charts/);
        expect(foot().querySelector('.wbx-reason')!.getAttribute('data-tone')).toBe('bad');
        expect(primary()).toBe('next');
        cleanup();

        reject = 'STALE_SESSION: the dataset was reloaded';
        await mountK([withTrained(k.make())]);
        await waitFor(() => expect(screen.getByTestId('results-health-error')).toBeTruthy());
        const b = boardOf('results-health-error');
        expect(b.title).toBe("Couldn't load the charts");
        expect(b.text).toBe('The trained model is kept, but its charts can only be loaded from the data it was trained on.');
        expect(within(b.el).queryByTestId('board-retry-charts')).toBeNull();
        expect(b.buttonShaped).toBe(0);
        expect(sentence()).toMatch(/^Trained .* · the charts did not load\. The data in this window is out of date\. Close it and open Build Model again from the Dashboard\.$/);
        expect(primary()).toBe('next');
    });

    each('%s — loading (a trained model being worked out again): the footer says where the model stands, with no filled button but the next step', async (_n, k) => {
        const mode = { current: 'hold' as 'ok' | 'fail' | 'hold' };
        const release = trainAnswers(k, mode);
        await mountK([withTrained(k.make())]);
        expect(boardOf('results-loading').title).toBe(`Loading the ${k.name}…`);
        expect(pill()).toBe('Trained');
        expect(sentence()).toMatch(/^Trained .* · check the charts, then set the health set points$/);
        // "Next: Health score →" is the pane's next step, but it cannot be pressed while loading
        expect(primary()).toBe('next');
        expect((screen.getByTestId('next-health-score') as HTMLButtonElement).disabled).toBe(true);
        expect(screen.queryByTestId('footer-load-again')).toBeNull();
        await release();
        await waitFor(() => expect(screen.getByTestId('results-chart')).toBeTruthy());
        expect((screen.getByTestId('next-health-score') as HTMLButtonElement).disabled).toBe(false);
    });

    it('the list legend reads "Needs input / re-train"', async () => {
        render(<BuildModelWindow />);
        await deliverData();
        expect(screen.getByText('Needs input / re-train')).toBeTruthy();
    });
});

// "no data to train on" is stopped at the UI instead of letting
// the engine fail — "the data is 2025-01 … 2025-12: a period chosen beyond that must be warned
// about at once". Two guards, both from what the window already has (no new request beyond the
// dataset bounds, asked once per dataset):
//   B1 a period against the loaded data's time range (the dataset bounds of the timeline);
//   B2 / B3 a SETTLED count of zero running rows in the train periods.
// The rule ("stop a train that has no data and warn at
// once — NOT take away results that already exist"):
//   R1 bounds are known only for the CURRENT dataset; unknown = nothing is judged
//   R2 a period NEW / CHANGED in a draft and entirely outside the data is invalid (Apply / Save)
//   R3 a period exactly as it was SAVED and outside the data only WARNS (row + card)
//   R4 Train is blocked only when there truly is no data (no train period inside it / zero rows)
//   R5 the guards block ACTIONS only (Apply, Save changes, Train) — never a read path
// Nothing is written and no model's status changes.
// The pure rules: periodDataGuards.test.ts; the rows / timeline / card: RunningConditionDataGuards.test.tsx.
describe('Guards against "no data to train on" (2026-10-10)', () => {
    const DATA = { min: '2025-01-01 00:00:00', max: '2025-12-31 23:59:00' };
    const P_IN = { id: 'p1', start: '2025-03-01T00:00', end: '2025-04-30T23:59' };
    const P_OUT = { id: 'p1', start: '2026-02-01T00:00', end: '2026-03-01T00:00' };
    const S_IN = [{ id: 's1', start: '2025-05-01T00:00', end: '2025-05-31T23:59' }];
    const COND = { id: 'f1', sensor: 'TAG1', operation: 'greater_than', value1: '5', value2: '' };
    const OUTSIDE_REASON = 'P1 is outside the data (2025/01/01 00:00 – 2025/12/31 23:59)';
    type CountArgs = { periods: { start: string | null; end: string | null }[]; filter: { value_filters: { value1: number | null }[] } | null };
    /** `count_period_rows`: 1,000 rows per period of 5,000, `running(period, index, args)` of them running. */
    const countAnswer = (args: CountArgs, running: (p: { start: string | null; end: string | null }, i: number, args: CountArgs) => number) => {
        const periods = args.periods.map((p, i) => ({
            index: i + 1, start: p.start ?? null, end: p.end ?? null, valid: true, invalid_reason: null,
            rows_in_period: 1000, running_rows: running(p, i, args), running_days: running(p, i, args) / 288,
        }));
        const sum = periods.reduce((s, c) => s + c.running_rows, 0);
        return { total_rows: 5000, interval_secs: 300, periods, union: { rows_in_period: 1000 * periods.length, running_rows: sum, running_days: sum / 288 } };
    };
    /** What the real engine answers when a training scope holds no row (`lib.rs`; Tauri rejects with a string). */
    const ENGINE_NO_ROWS: Record<string, string> = {
        compute_sensor_stats: "No valid numeric values for sensor 'TAG1'",
        preview_relationship_model: 'No rows remain after dropping nulls.',
        compute_clustering_preview: 'No rows remain after dropping nulls.',
        compute_health_preview: 'NO_DATA: no rows in the training scope',
        export_model_files: 'NO_DATA: no rows in the training scope',
    };
    const engineCalls = (cmd: string) => mockInvoke.mock.calls.filter(c => c[0] === cmd);
    /** The fake Rust of this block: the dataset bounds, (optionally) its own row counts — and, with
     *  `noRows`, an engine that answers like the real one for an EMPTY training scope (every train /
     *  preview / export is refused with its "no rows" sentence instead of made-up numbers). */
    const rust = (opts: { bounds?: unknown; noRows?: boolean; running?: (p: { start: string | null; end: string | null }, i: number, args: CountArgs) => number | Error } = {}) =>
        mockInvoke.mockImplementation((cmd: string, args?: any) => {
            if (opts.noRows && cmd in ENGINE_NO_ROWS) return Promise.reject(ENGINE_NO_ROWS[cmd]);
            if (cmd === 'get_dataset_time_bounds') return Promise.resolve('bounds' in opts ? opts.bounds : DATA);
            if (cmd === 'count_period_rows' && opts.running) {
                try {
                    return Promise.resolve(countAnswer(args, (p, i, a) => {
                        const r = opts.running!(p, i, a);
                        if (r instanceof Error) throw r;
                        return r;
                    }));
                } catch (e) {
                    return Promise.reject(e);
                }
            }
            return healthInvoke(cmd, args);
        });
    const mountB = async (models: any[], fg: Record<string, any> = {}) => {
        const extra = { runningConditionTimePeriods: [P_IN], runningConditionTestPeriods: S_IN, ...fg };
        statefulUpdateMock(models, extra);
        render(<BuildModelWindow />);
        await deliverData({ failureGroupState: { groups: [makeGroup()], models, ...extra } });
        await flush();
    };
    const openRc = () => {
        fireEvent.click(screen.getByTestId('rc-card-open'));
        return within(screen.getByRole('dialog', { name: 'Running condition' }));
    };
    const apply = () => screen.getByTestId('rc-apply') as HTMLButtonElement;
    const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
    const footReason = () => screen.getByTestId('build-block-reason').textContent;

    describe('B1 — a period against the loaded data (the workspace modal)', () => {
        it('a TRAIN period typed beyond the data: red row with the data range, red on the timeline, "Fix period" pill, Apply disabled with "Fix P1 before applying" — at once, with no request', async () => {
            rust();
            await mountB([makeModel()]);
            const dlg = openRc();
            await flush();
            const before = mockInvoke.mock.calls.length;
            type(dlg.getByLabelText('P1 end'), P_OUT.end);
            type(dlg.getByLabelText('P1 start'), P_OUT.start);
            // judged in the same render as the edit: nothing was asked for it
            expect(dlg.getByTestId('period-invalid-1').textContent).toBe(OUTSIDE_REASON);
            expect(mockInvoke.mock.calls.length).toBe(before);
            expect(dlg.getByTestId('period-row-1').getAttribute('data-invalid')).toBe('true');
            expect(dlg.getByLabelText('P1 start').getAttribute('aria-invalid')).toBe('true');
            expect(dlg.getByLabelText('P1 end').getAttribute('aria-invalid')).toBe('true');
            expect(dlg.getByTestId('rc-tl-P1').getAttribute('data-outside')).toBe('true');
            expect(dlg.getByTestId('rc-tl-P1').className).toContain('bad');
            expect(screen.getByTestId('rc-fix-period-pill')).toBeTruthy();
            expect(apply().disabled).toBe(true);
            const block = screen.getByTestId('rc-apply-block');
            expect(block.textContent).toBe('Fix P1 before applying');
            expect(block.getAttribute('data-kind')).toBe('invalid-train');
            expect(block.className).toContain('rc-impact--bad');
            mockUpdateWorkspaceData.mockClear();
            fireEvent.click(apply());
            await flush();
            expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();

            // PARTLY outside: a quiet amber note, and Apply is allowed again
            type(dlg.getByLabelText('P1 start'), '2025-11-01T00:00');
            expect(dlg.queryByTestId('period-invalid-1')).toBeNull();
            expect(dlg.getByTestId('period-data-note-1').textContent).toBe('Only the part inside the data is used (data ends 2025/12/31)');
            expect(dlg.getByTestId('rc-tl-P1').getAttribute('data-invalid')).toBeNull();
            expect(screen.queryByTestId('rc-apply-block')).toBeNull();
            expect(apply().disabled).toBe(false);
        });

        it('a SCORING period entirely outside the data blocks Apply too ("Fix S1 before applying"); moved back inside, Apply writes it', async () => {
            rust();
            await mountB([makeModel()]);
            const dlg = openRc();
            type(dlg.getByLabelText('Scoring period 1 end'), '2026-03-01T00:00');
            type(dlg.getByLabelText('Scoring period 1 start'), '2026-02-01T00:00');
            expect(dlg.getByTestId('test-invalid-1').textContent).toBe('S1 is outside the data (2025/01/01 00:00 – 2025/12/31 23:59)');
            expect(dlg.getByTestId('rc-tl-S1').getAttribute('data-outside')).toBe('true');
            expect(apply().disabled).toBe(true);
            expect(screen.getByTestId('rc-apply-block').textContent).toBe('Fix S1 before applying');
            expect(screen.getByTestId('rc-apply-block').getAttribute('data-kind')).toBe('invalid-test');
            type(dlg.getByLabelText('Scoring period 1 start'), '2025-06-01T00:00');
            type(dlg.getByLabelText('Scoring period 1 end'), '2025-06-20T00:00');
            expect(dlg.queryByTestId('test-invalid-1')).toBeNull();
            expect(apply().disabled).toBe(false);
            mockUpdateWorkspaceData.mockClear();
            fireEvent.click(apply());
            await flush();
            const fg = (await mockUpdateWorkspaceData.mock.results[0].value).failureGroupState;
            expect(fg.runningConditionTestPeriods).toEqual([{ id: 's1', start: '2025-06-01T00:00', end: '2025-06-20T00:00' }]);
        });

        it('with the dataset bounds unknown nothing is flagged and Apply works as before', async () => {
            rust({ bounds: { min: null, max: null } });
            await mountB([makeModel()]);
            const dlg = openRc();
            type(dlg.getByLabelText('P1 end'), P_OUT.end);
            type(dlg.getByLabelText('P1 start'), P_OUT.start);
            expect(dlg.queryByTestId('period-invalid-1')).toBeNull();
            expect(screen.queryByTestId('rc-apply-block')).toBeNull();
            expect(apply().disabled).toBe(false);
        });
    });

    describe('B1 — the PERSISTED state: NO saved train period is inside the loaded data (R4)', () => {
        const NO_DATA_REASON = 'No train period is inside the data (2025/01/01 00:00 – 2025/12/31 23:59) — nothing to train on. Move a train period inside the data (Running condition → Edit).';

        it('the card turns red ("0 rows — nothing to train on" — never "P1 needs fixing"), Train is blocked with the named reason (Train sensor, the board, the footer, Train all "Skipped" + Fix →) — and nothing is written or trained', async () => {
            rust({ running: () => 800 });
            // a Workspace-mode model that would otherwise be ready, and a Custom one that IS ready
            const ws = makeModel({ id: 'm1', targetSensor: 'TAG1' });
            const own = makeModel({ id: 'm2', name: 'Own', targetSensor: 'TAG2', runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true, filterTimePeriods: [P_IN], customTestPeriods: S_IN });
            await mountB([ws, own], { runningConditionTimePeriods: [P_OUT] });
            await waitFor(() => expect(screen.getByTestId('rc-card').getAttribute('data-norows')).toBe('true'));
            // the condition IS set — the user did not just pick this period: no "needs fixing" card
            expect(screen.getByTestId('rc-card').getAttribute('data-state')).toBe('set');
            expect(screen.queryByTestId('rc-card-title')).toBeNull();
            expect(screen.getByTestId('rc-card-use').textContent).toBe('0 rows — nothing to train on');
            expect(screen.getByTestId('rc-card-outside').textContent).toBe(`⚠ ${OUTSIDE_REASON} — it is not used`);
            expect(screen.getByTestId('rc-card-open').textContent).toBe('Edit');
            // the model has nothing to show yet: its board and footer say why Train will not start
            expect(screen.queryByTestId('results-rc-locked')).toBeNull();
            expect(within(screen.getByTestId('results-incomplete')).getByText(NO_DATA_REASON)).toBeTruthy();
            expect(footReason()).toBe(NO_DATA_REASON);
            expect(screen.getByTestId('tab-status-m1').getAttribute('title')).toBe('No train period inside the data');
            expect(screen.getByTestId('tab-status-m1').getAttribute('data-dot')).toBe('bad');
            expect(screen.getByTestId('sensor-kind-badge-dot-m1').getAttribute('data-state')).toBe('blocked');
            // Train sensor: disabled, the named reason as its tooltip
            expect(trainSensorBtn().disabled).toBe(true);
            expect(trainSensorBtn().title).toBe("Can't train: Individual — No train period inside the data");
            expect(trainSensorWhy()).toBe("Can't train · see below");
            // Train all: "Skipped" with the named reason and Fix →; the Custom model is not affected
            await act(async () => { fireEvent.click(screen.getByTestId('train-all')); });
            expect(screen.getByTestId('train-row-status-m1').textContent).toBe('Skipped');
            expect(screen.getByTestId('train-row-note-m1').textContent).toBe('No train period inside the data');
            expect(screen.getByTestId('train-row-status-m2').textContent).toBe('Ready');
            fireEvent.click(screen.getByTestId('train-fix-m1'));
            // Fix → opens the Running-condition settings, where the SAVED row only warns (amber)
            const dlg = within(screen.getByRole('dialog', { name: 'Running condition' }));
            expect(dlg.queryByTestId('period-invalid-1')).toBeNull();
            expect(dlg.getByTestId('period-data-note-1').textContent).toBe(`${OUTSIDE_REASON} — it is not used`);
            expect(dlg.getByTestId('period-row-1').getAttribute('data-outside')).toBe('true');
            expect(dlg.getByTestId('rc-tl-P1').className).toContain('warn');
            expect(screen.queryByTestId('rc-fix-period-pill')).toBeNull();
            expect(screen.queryByTestId('rc-apply-block')).toBeNull();
            // it only blocks Train: nothing was written and nothing was trained
            expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
            expect(mockInvoke.mock.calls.filter(c => c[0] === 'compute_sensor_stats')).toHaveLength(0);
        });

        // The fake engine now answers like the real one for an EMPTY scope (`noRows`).
        // This test used to pass only because the mock drew charts whatever the filter was — in the
        // app the charts are computed from the loaded data, so with no row for the model there is
        // nothing to draw. What is true is said instead: the model is unchanged, ONE board names the
        // cause and the one place to fix it. Never "Couldn't load… Load it again" / "Training failed".
        it('a COMPLETE model with NO train period inside the data stays Complete (pill, dots, filter counts): ONE "No data for this model in the loaded file" board with the cause and a working "Running condition ↑" link — no "Load it again", no dead Train link — on BOTH pages; Mark incomplete works, nothing else is written', async () => {
            rust({ running: () => 800, noRows: true });
            const fgShape = { runningConditionFilters: [], runningConditionCombine: 'and', runningConditionTimePeriods: [P_OUT], runningConditionNoneConfirmed: true };
            const base = makeModel({ id: 'm1', targetSensor: 'TAG1', healthSetPoints: HS_SNAP });
            const done: Record<string, any> = { ...withTrained(base, { models: [base], ...fgShape }), status: true };
            await mountB([done], { runningConditionTimePeriods: [P_OUT] });
            await waitFor(() => expect(screen.getByTestId('rc-card').getAttribute('data-norows')).toBe('true'));
            // ── the ONE board: the title, the cause from the guard, one link ──
            const board = await waitFor(() => screen.getByTestId('results-no-data'));
            expect(board.querySelector('.wbx-msg-t')!.textContent).toBe('No data for this model in the loaded file');
            expect(within(board).getByTestId('no-data-cause').textContent).toBe('None of its train periods is inside the data (2025/01/01 00:00 – 2025/12/31 23:59).');
            expect(board.querySelector('.wbx-msg-s')!.textContent)
                .toBe('None of its train periods is inside the data (2025/01/01 00:00 – 2025/12/31 23:59). Fix it in Running condition ↑ to see its charts.');
            expect(board.querySelector('.wbx-msg-d')!.textContent).toBe('Complete · nothing about the model changed');
            expect(board.className).not.toContain('wbx-msg--bad');
            expect(within(board).getAllByRole('button')).toHaveLength(1);
            // never the "load failed" / "training failed" story, and no link to a disabled control
            for (const id of ['results-chart', 'results-load-failed', 'results-error', 'results-placeholder', 'results-not-fitted',
                'board-load-again', 'board-train-menu', 'board-train-sensor', 'footer-load-again', 'footer-train-sensor']) {
                expect(screen.queryByTestId(id), id).toBeNull();
            }
            expect(document.body.textContent).not.toMatch(/Couldn't load|Load it again|load it again|Training failed|No valid numeric values|NO_DATA/);
            // ── the model's OWN words stay ──
            expect(screen.getByTestId('footer-pill').textContent).toBe('Complete');
            expect(screen.getByTestId('footer-no-data').textContent).toBe('Complete · no rows for it in the loaded file — fix the running condition to see its charts');
            expect(screen.queryByTestId('build-block-reason')).toBeNull();
            expect(screen.getByTestId('tab-status-m1').getAttribute('data-dot')).toBe('complete');
            expect(screen.getByTestId('tab-status-m1').getAttribute('title')).toBe('Complete · no data in the loaded file');
            expect(screen.getByTestId('sensor-kind-badge-dot-m1').getAttribute('data-state')).toBe('complete');
            expect(screen.getByTestId('sensor-kind-badge-dot-m1').className).toContain('f4-kb-dot--complete');
            expect(screen.getByTestId('sensor-kind-badge-m1').getAttribute('title')).toBe('Individual · Complete · no data in the loaded file');
            // never counted under "Needs setup" next to "Complete"
            expect(screen.getByRole('button', { name: /^Needs setup/ }).textContent).toBe('Needs setup 0');
            expect(screen.getByRole('button', { name: /^Complete/ }).textContent).toBe('Complete 1');
            // training it AGAIN is what is blocked: named on the Train sensor line
            expect(trainSensorBtn().disabled).toBe(true);
            expect(trainSensorWhy()).toBe("Can't train · No train period inside the data");
            expect((screen.getByTestId('train-sensor-menu-toggle') as HTMLButtonElement).disabled).toBe(true);
            // no filled "next step": the Health score page is the same board
            expect(screen.getByTestId('wb-footer').getAttribute('data-primary')).toBe('none');
            // the engine is not asked again and again for a scope that has no row (at most the one
            // load that started before the data's range was known), and never for a health preview
            await act(async () => { await new Promise(r => setTimeout(r, 400)); });
            expect(engineCalls('compute_sensor_stats').length).toBeLessThanOrEqual(1);
            expect(engineCalls('compute_health_preview')).toHaveLength(0);

            // ── the Health score page: open (not a closed tab), the SAME board, Mark incomplete reachable ──
            const healthTab = screen.getByTestId('next-health-score') as HTMLButtonElement;
            expect(healthTab.disabled).toBe(false);
            fireEvent.click(healthTab);
            const hBoard = await waitFor(() => screen.getByTestId('results-no-data'));
            expect(hBoard.querySelector('.wbx-msg-t')!.textContent).toBe('No data for this model in the loaded file');
            expect(screen.queryByTestId('set-points-card')).toBeNull();
            expect(screen.getByTestId('footer-pill').textContent).toBe('Complete');
            expect(screen.getByTestId('footer-no-data').textContent).toBe('Complete · no rows for it in the loaded file — fix the running condition to see its charts');
            expect((screen.getByTestId('mark-incomplete') as HTMLButtonElement).disabled).toBe(false);
            await flush();
            // nothing was written by looking at it (no status, fingerprint, verdict or export change)
            expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
            expect(engineCalls('compute_health_preview')).toHaveLength(0);
            expect(exportCalls()).toHaveLength(0);

            // ── the link WORKS: it opens the Running-condition settings ──
            fireEvent.click(within(hBoard).getByTestId('board-open-rc'));
            expect(screen.getByRole('dialog', { name: 'Running condition' })).toBeTruthy();
            fireEvent.click(screen.getByTestId('rc-cancel'));

            // ── Mark incomplete: the one write the user asked for — then it is "Trained", still with no data ──
            await act(async () => { fireEvent.click(screen.getByTestId('mark-incomplete')); await Promise.resolve(); });
            await flush();
            expect(mockUpdateWorkspaceData).toHaveBeenCalledTimes(1);
            const written = await hsLastModel();
            expect(written).toMatchObject({ status: false, lastTrainedAt: done.lastTrainedAt, trainedFingerprint: done.trainedFingerprint });
            await waitFor(() => expect(screen.getByTestId('footer-pill').textContent).toBe('Trained'));
            expect(screen.getByTestId('results-no-data').querySelector('.wbx-msg-d')!.textContent).toBe('Trained · nothing about the model changed');
            // Mark complete could only fail (the export needs the data): disabled, with that reason
            expect(hsMarkBtn().disabled).toBe(true);
            expect(hsMarkBtn().title).toBe('No data for this model in the loaded file — fix the running condition (Running condition → Edit) first');
            expect(screen.getByTestId('footer-no-data').textContent).toBe('Trained · no rows for it in the loaded file — fix the running condition to see its charts');
            expect(exportCalls()).toHaveLength(0);
        });

        // The rule behind finding 1: a sentence never links to a control that is disabled.
        // A load that failed for ANOTHER reason before the data's range was known keeps its own board —
        // but once the guard holds, the menu row / Train sensor it pointed at cannot train the model.
        it('a load that failed for another reason, then "no train period inside the data" becomes known: the "Couldn\'t load…" board drops its Train sensor ▾ menu link and the "Training failed" board says "Train sensor ↑" as plain text — never a link to a disabled control', async () => {
            const fgShape = { runningConditionFilters: [], runningConditionCombine: 'and', runningConditionTimePeriods: [P_OUT], runningConditionNoneConfirmed: true };
            const base = makeModel({ id: 'm1', targetSensor: 'TAG1', healthSetPoints: HS_SNAP });
            const trained: Record<string, any> = withTrained(base, { models: [base], ...fgShape });
            for (const model of [{ ...trained, status: true }, trained]) {
                let releaseBounds: () => void = () => {};
                const boundsGate = new Promise<void>(r => { releaseBounds = r; });
                mockInvoke.mockImplementation((cmd: string, args?: any) => {
                    if (cmd === 'get_dataset_time_bounds') return boundsGate.then(() => DATA);
                    if (cmd === 'compute_sensor_stats') return Promise.reject('the engine stopped');
                    if (cmd === 'count_period_rows') return Promise.resolve(countAnswer(args, () => 800));
                    return healthInvoke(cmd, args);
                });
                await mountB([model], { runningConditionTimePeriods: [P_OUT] });
                const boardId = model.status ? 'results-load-failed' : 'results-error';
                const linkId = model.status ? 'board-train-menu' : 'board-train-sensor';
                // the data's range is not known yet: the model can train, so the link is live
                await waitFor(() => expect(screen.getByTestId(boardId)).toBeTruthy());
                expect(within(screen.getByTestId(boardId)).getByTestId(linkId)).toBeTruthy();
                await act(async () => { releaseBounds(); await Promise.resolve(); await Promise.resolve(); });
                await waitFor(() => expect(screen.getByTestId('rc-card').getAttribute('data-norows')).toBe('true'));
                // now nothing can train it: Train sensor and its ▾ are disabled…
                expect(trainSensorBtn().disabled).toBe(true);
                expect((screen.getByTestId('train-sensor-menu-toggle') as HTMLButtonElement).disabled).toBe(true);
                // …and no sentence links there any more
                const board = screen.getByTestId(boardId);
                expect(within(board).queryByTestId(linkId)).toBeNull();
                if (model.status) {
                    expect(board.querySelector('.wbx-msg-s')!.textContent)
                        .toBe('Nothing about the model changed and it stays Complete — Load it again. The charts come back when it is loaded.');
                    expect(screen.getByTestId('footer-pill').textContent).toBe('Complete');
                } else {
                    expect(board.querySelector('.wbx-msg-s')!.textContent)
                        .toBe("Fix the problem, then train again with Train sensor ↑ (it can't train yet). The model keeps its last state.");
                    expect(within(board).getByTestId('board-train-sensor-blocked').getAttribute('title'))
                        .toBe('No train period is inside the data (2025/01/01 00:00 – 2025/12/31 23:59) — nothing to train on. Move a train period inside the data (Running condition → Edit).');
                    expect(screen.queryByTestId('footer-train-sensor')).toBeNull();
                    expect(screen.getByTestId('footer-train-sensor-blocked').textContent).toBe("(it can't train yet)");
                }
                expect(board.querySelector('.wbx-msg-d')!.textContent).toBe('the engine stopped');
                cleanup();
            }
        });

        it('[inside, outside]: ONE train period inside the data next to one outside it changes nothing — a COMPLETE model keeps its charts, its Health score page and Mark incomplete', async () => {
            rust({ running: () => 800 });
            const periods = [P_IN, { ...P_OUT, id: 'p2' }];
            const fgShape = { runningConditionFilters: [], runningConditionCombine: 'and', runningConditionTimePeriods: periods, runningConditionNoneConfirmed: true };
            const base = makeModel({ id: 'm1', targetSensor: 'TAG1', healthSetPoints: HS_SNAP });
            const done: Record<string, any> = { ...withTrained(base, { models: [base], ...fgShape }), status: true };
            await mountB([done], { runningConditionTimePeriods: periods });
            await waitFor(() => expect(screen.getByTestId('rc-card-outside')).toBeTruthy());
            expect(screen.getByTestId('rc-card').getAttribute('data-norows')).toBeNull();
            await waitFor(() => expect(screen.getByTestId('results-chart')).toBeTruthy());
            expect(screen.queryByTestId('results-no-data')).toBeNull();
            expect(screen.queryByTestId('footer-no-data')).toBeNull();
            expect(screen.getByTestId('footer-pill').textContent).toBe('Complete');
            expect(screen.queryByTestId('build-block-reason')).toBeNull();
            expect(screen.getByTestId('tab-status-m1').getAttribute('data-dot')).toBe('complete');
            expect(screen.getByTestId('tab-status-m1').getAttribute('title')).toBe('Complete');
            expect(screen.getByTestId('sensor-kind-badge-dot-m1').getAttribute('data-state')).toBe('complete');
            await openHealthPage();
            expect((screen.getByTestId('mark-incomplete') as HTMLButtonElement).disabled).toBe(false);
            mockUpdateWorkspaceData.mockClear();
            await act(async () => { fireEvent.click(screen.getByTestId('mark-incomplete')); await Promise.resolve(); });
            await flush();
            expect((await hsLastModel()).status).toBe(false);
        });
    });

    describe('B2 — no rows at all (the counts the modal already asks for)', () => {
        const running = (_p: unknown, _i: number, args: CountArgs) => ((args.filter?.value_filters[0]?.value1 ?? 0) >= 100 ? 0 : 800);
        const fgCond = { runningConditionNoneConfirmed: false, runningConditionFilters: [COND] };

        it('a settled count of zero: the red line, Apply disabled with "No rows to train on" — never while the count is on its way; relaxing the condition lifts it; at most 2 counts per settled draft', async () => {
            rust({ running });
            await mountB([makeModel()], fgCond);
            const dlg = openRc();
            await waitFor(() => expect(dlg.getByTestId('rc-caption-rows').textContent).toBe('800 of 5,000 rows (16%) used for training'));
            const CARD = 1;
            expect(periodCountCalls()).toHaveLength(CARD + 2); // the card, then train + scoring of the open modal
            expect(dlg.queryByTestId('rc-no-rows')).toBeNull();

            type(dlg.getByPlaceholderText('value'), '500');
            // the draft changed: its count is not in yet — nothing is blocked on the OLD answer
            expect(dlg.queryByTestId('rc-no-rows')).toBeNull();
            expect(apply().disabled).toBe(false);
            expect(screen.queryByTestId('rc-apply-block')).toBeNull();
            // settled: zero running rows
            await waitFor(() => expect(dlg.getByTestId('rc-no-rows')).toBeTruthy(), { timeout: 3000 });
            expect(dlg.getByTestId('rc-no-rows').textContent).toBe('No rows match — nothing to train on. Widen a train period or relax the condition.');
            expect(dlg.getByTestId('rc-caption-rows').textContent).toBe('0 of 5,000 rows (0%) used for training');
            expect(apply().disabled).toBe(true);
            const block = screen.getByTestId('rc-apply-block');
            expect(block.textContent).toBe('No rows to train on');
            expect(block.getAttribute('data-kind')).toBe('no-rows');
            expect(apply().title).toBe('No rows to train on');
            await act(async () => { await new Promise(r => setTimeout(r, 450)); });
            expect(periodCountCalls()).toHaveLength(CARD + 4); // one train + one scoring call for the new condition, no more
            mockUpdateWorkspaceData.mockClear();
            fireEvent.click(apply());
            await flush();
            expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
            expect(screen.getByRole('dialog', { name: 'Running condition' })).toBeTruthy();

            // relaxing the condition: rows again, Apply allowed
            type(dlg.getByPlaceholderText('value'), '6');
            await waitFor(() => expect(dlg.getByTestId('rc-caption-rows').textContent).toBe('800 of 5,000 rows (16%) used for training'), { timeout: 3000 });
            expect(dlg.queryByTestId('rc-no-rows')).toBeNull();
            expect(screen.queryByTestId('rc-apply-block')).toBeNull();
            expect(apply().disabled).toBe(false);
        });

        it('ONE train period with no running rows while another has some: a quiet amber note on that row — Apply is not blocked', async () => {
            rust({ running: (_p, i) => (i === 1 ? 0 : 800) });
            const P2 = { id: 'p2', start: '2025-07-01T00:00', end: '2025-07-31T23:59' };
            await mountB([makeModel()], { runningConditionTimePeriods: [P_IN, P2], runningConditionTestPeriods: [] });
            const dlg = openRc();
            await waitFor(() => expect(dlg.getByTestId('period-no-rows-2').textContent).toBe('no running rows in P2'));
            expect(dlg.queryByTestId('period-no-rows-1')).toBeNull();
            expect(dlg.queryByTestId('rc-no-rows')).toBeNull();
            expect(dlg.getByTestId('period-row-2').getAttribute('data-invalid')).toBeNull();
            fireEvent.click(dlg.getByTestId('rc-mode-none')); // any edit
            fireEvent.click(dlg.getByTestId('rc-mode-condition'));
            fireEvent.click(dlg.getByTestId('rc-mode-none'));
            expect(screen.queryByTestId('rc-apply-block')).toBeNull();
        });

        it('a SCORING period with no running rows is an amber note only — it never blocks Apply', async () => {
            // the train call carries the train period, the scoring call the scoring period
            rust({ running: p => (p.start === S_IN[0].start ? 0 : 800) });
            await mountB([makeModel()], fgCond);
            const dlg = openRc();
            await waitFor(() => expect(dlg.getByTestId('test-no-rows-1').textContent).toBe('no running rows in S1'));
            expect(dlg.queryByTestId('rc-no-rows')).toBeNull();
            type(dlg.getByPlaceholderText('value'), '7');
            await waitFor(() => expect(dlg.getByTestId('test-no-rows-1')).toBeTruthy(), { timeout: 3000 });
            expect(screen.queryByTestId('rc-apply-block')).toBeNull();
            expect(apply().disabled).toBe(false);
        });

        it('a count that FAILED never blocks Apply', async () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            rust({ running: () => new Error('count failed') });
            await mountB([makeModel()], fgCond);
            const dlg = openRc();
            await waitFor(() => expect(dlg.getByTestId('rc-caption-rows').textContent).toBe("Couldn't count the rows right now"));
            type(dlg.getByPlaceholderText('value'), '500');
            await act(async () => { await new Promise(r => setTimeout(r, 500)); });
            expect(dlg.queryByTestId('rc-no-rows')).toBeNull();
            expect(screen.queryByTestId('rc-apply-block')).toBeNull();
            expect(apply().disabled).toBe(false);
            warn.mockRestore();
        });
    });

    describe('B3 — the card: the PERSISTED condition counted at zero running rows', () => {
        it('the one-line card turns red ("0 rows — nothing to train on") and Train is blocked with that reason — nothing is written, and no second count is asked', async () => {
            rust({ running: () => 0 });
            const ws = makeModel({ id: 'm1', targetSensor: 'TAG1' });
            const own = makeModel({ id: 'm2', name: 'Own', targetSensor: 'TAG2', runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true, filterTimePeriods: [P_IN], customTestPeriods: S_IN });
            await mountB([ws, own], { runningConditionNoneConfirmed: false, runningConditionFilters: [COND] });
            await waitFor(() => expect(screen.getByTestId('rc-card').getAttribute('data-norows')).toBe('true'));
            expect(screen.getByTestId('rc-card').getAttribute('data-state')).toBe('set');
            expect(screen.getByTestId('rc-card-use').textContent).toBe('0 rows — nothing to train on');
            expect(screen.getByTestId('rc-card-tick').textContent).toBe('!');
            expect(screen.getByTestId('rc-card-open').textContent).toBe('Edit');
            // the model: the reason in the footer and on the board (one link, into the settings), a red dot
            const REASON = 'No rows match — nothing to train on. Widen a train period or relax the condition (Running condition → Edit).';
            expect(footReason()).toBe(REASON);
            expect(within(screen.getByTestId('results-incomplete')).getByText(REASON)).toBeTruthy();
            expect(screen.getByTestId('tab-status-m1').getAttribute('title')).toBe('No rows to train on');
            expect(screen.getByTestId('tab-status-m1').getAttribute('data-dot')).toBe('bad');
            expect(trainSensorBtn().disabled).toBe(true);
            expect(trainSensorBtn().title).toBe("Can't train: Individual — No rows to train on");
            // Train all: "Skipped" + Fix →
            await act(async () => { fireEvent.click(screen.getByTestId('train-all')); });
            expect(screen.getByTestId('train-row-status-m1').textContent).toBe('Skipped');
            expect(screen.getByTestId('train-row-note-m1').textContent).toBe('No rows to train on');
            expect(screen.getByTestId('train-fix-m1')).toBeTruthy();
            // only the card's ONE count of the persisted condition was asked; nothing was written
            expect(periodCountCalls().filter(c => c.periods.length === 1 && c.periods[0].start === P_IN.start && c.filter !== null)).toHaveLength(1);
            expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
        });

        // With an engine that answers like the real one for an empty scope (`noRows`), a
        // TRAINED model whose scope counts zero rows has no charts to draw. It is NOT "Training failed"
        // (nobody trained it) and NOT "Incomplete" (nothing about it changed): it stays "Trained".
        it('a TRAINED model whose scope counts ZERO rows stays "Trained" (pill, amber dot — never "Training failed" / "Incomplete" / a red dot): the "No data…" board with the cause and "Running condition ↑" on both pages, Mark complete disabled with the reason — and nothing is written', async () => {
            rust({ running: () => 0, noRows: true });
            const fgShape = { runningConditionFilters: [COND], runningConditionCombine: 'and', runningConditionTimePeriods: [P_IN], runningConditionNoneConfirmed: false };
            const base = makeModel({ id: 'm1', targetSensor: 'TAG1', healthSetPoints: HS_SNAP });
            const trained: Record<string, any> = withTrained(base, { models: [base], ...fgShape });
            await mountB([trained], { runningConditionNoneConfirmed: false, runningConditionFilters: [COND] });
            await waitFor(() => expect(screen.getByTestId('rc-card').getAttribute('data-norows')).toBe('true'));
            const board = await waitFor(() => screen.getByTestId('results-no-data'));
            expect(board.querySelector('.wbx-msg-t')!.textContent).toBe('No data for this model in the loaded file');
            expect(board.querySelector('.wbx-msg-s')!.textContent)
                .toBe('No row passes the running condition in its train periods. Fix it in Running condition ↑ to see its charts.');
            expect(board.querySelector('.wbx-msg-d')!.textContent).toBe('Trained · nothing about the model changed');
            expect(within(board).getAllByRole('button')).toHaveLength(1);
            for (const id of ['results-chart', 'results-error', 'results-load-failed', 'board-train-sensor', 'board-train-menu', 'board-load-again', 'footer-train-sensor']) {
                expect(screen.queryByTestId(id), id).toBeNull();
            }
            expect(document.body.textContent).not.toMatch(/Training failed|Couldn't load|No valid numeric values|NO_DATA/);
            // its own words
            expect(screen.getByTestId('footer-pill').textContent).toBe('Trained');
            expect(screen.getByTestId('footer-no-data').textContent).toBe('Trained · no rows for it in the loaded file — fix the running condition to see its charts');
            expect(screen.queryByTestId('build-block-reason')).toBeNull();
            expect(screen.getByTestId('tab-status-m1').getAttribute('data-dot')).toBe('need');
            expect(screen.getByTestId('tab-status-m1').getAttribute('title')).toMatch(/^(Trained|Set points needed) · no data in the loaded file$/);
            expect(screen.getByTestId('sensor-kind-badge-dot-m1').getAttribute('data-state')).toBe('trained');
            expect(screen.getByTestId('sensor-kind-badge-dot-m1').className).toContain('f4-kb-dot--need');
            expect(screen.getByRole('button', { name: /^Needs setup/ }).textContent).toBe('Needs setup 0');
            // where Train is offered the reason is named
            expect(trainSensorBtn().disabled).toBe(true);
            expect(trainSensorWhy()).toBe("Can't train · No rows to train on");
            expect(trainSensorBtn().title).toBe("Can't train: Individual — No rows to train on");
            // "Next: Health score →" is reachable but never the filled next step
            expect((screen.getByTestId('next-health-score') as HTMLButtonElement).disabled).toBe(false);
            expect(screen.getByTestId('wb-footer').getAttribute('data-primary')).toBe('none');

            // ── the Health score page: the same board; Mark complete could only fail ──
            fireEvent.click(screen.getByTestId('next-health-score'));
            await waitFor(() => expect(screen.getByTestId('footer-back-to-fit')).toBeTruthy());
            expect(screen.getByTestId('results-no-data')).toBeTruthy();
            expect(screen.queryByTestId('set-points-card')).toBeNull();
            expect(hsMarkBtn().disabled).toBe(true);
            expect(hsMarkBtn().title).toBe('No data for this model in the loaded file — fix the running condition (Running condition → Edit) first');
            expect(screen.queryByTestId('mark-block-reason')).toBeNull();
            expect(screen.getByTestId('footer-no-data')).toBeTruthy();
            expect(screen.getByTestId('footer-pill').textContent).toBe('Trained');
            fireEvent.click(hsMarkBtn());
            await act(async () => { await new Promise(r => setTimeout(r, 400)); });
            // ── nothing written, nothing exported, the engine not asked for a preview ──
            expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
            expect(exportCalls()).toHaveLength(0);
            expect(engineCalls('compute_health_preview')).toHaveLength(0);
            expect(engineCalls('compute_sensor_stats').length).toBeLessThanOrEqual(1);
            // the link works
            fireEvent.click(screen.getByTestId('board-open-rc'));
            expect(screen.getByRole('dialog', { name: 'Running condition' })).toBeTruthy();
        });

        it('[inside, outside] with rows: a TRAINED model keeps its pill, its charts and its Health score page — Mark complete is not a train, the data guards do not block it', async () => {
            rust({ running: (_p, i) => (i === 0 ? 800 : 0) });
            const periods = [P_IN, { ...P_OUT, id: 'p2' }];
            const fgShape = { runningConditionFilters: [COND], runningConditionCombine: 'and', runningConditionTimePeriods: periods, runningConditionNoneConfirmed: false };
            const base = makeModel({ id: 'm1', targetSensor: 'TAG1', healthSetPoints: HS_SNAP });
            const trained: Record<string, any> = withTrained(base, { models: [base], ...fgShape });
            await mountB([trained], { runningConditionNoneConfirmed: false, runningConditionFilters: [COND], runningConditionTimePeriods: periods });
            await waitFor(() => expect(screen.getByTestId('rc-card-outside')).toBeTruthy());
            expect(screen.getByTestId('rc-card').getAttribute('data-norows')).toBeNull();
            await waitFor(() => expect(screen.getByTestId('results-chart')).toBeTruthy());
            expect(screen.queryByTestId('results-no-data')).toBeNull();
            expect(screen.getByTestId('footer-pill').textContent).toBe('Trained');
            expect(screen.queryByTestId('build-block-reason')).toBeNull();
            expect(screen.getByTestId('tab-status-m1').getAttribute('title')).not.toContain('no data');
            expect(screen.getByTestId('sensor-kind-badge-dot-m1').getAttribute('data-state')).toBe('trained');
            expect(trainSensorBtn().disabled).toBe(true); // up to date: nothing to train
            await flush();
            // the only write there may be is the saved-set-point verdict of the preview
            for (const r of mockUpdateWorkspaceData.mock.results) {
                const m = (await r.value).failureGroupState.models[0];
                expect(m).toMatchObject({ status: false, lastTrainedAt: trained.lastTrainedAt, trainedFingerprint: trained.trainedFingerprint });
            }
            await openHealthPage();
            await waitFor(() => expect(hsMarkBtn().disabled).toBe(false));
            expect(screen.queryByTestId('mark-block-reason')).toBeNull();
            await hsClickMark();
            await waitFor(() => expect(screen.getByTestId('save-ok')).toBeTruthy());
            expect(exportCalls()).toHaveLength(1);
            expect((await hsLastModel()).status).toBe(true);
        });

        it('NOT settled yet (the data range unknown, the count failed): the load is attempted as before — and the engine\'s "no rows" answer leads to the SAME board, asked ONCE, never "Training failed" / "Couldn\'t load"; nothing is written', async () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            // a Complete and a Trained model, each on its own sensor
            const fgShape = { runningConditionFilters: [COND], runningConditionCombine: 'and', runningConditionTimePeriods: [P_IN], runningConditionNoneConfirmed: false };
            const a = makeModel({ id: 'm1', targetSensor: 'TAG1', healthSetPoints: HS_SNAP });
            const b = makeModel({ id: 'm2', name: 'Two', targetSensor: 'TAG2', healthSetPoints: HS_SNAP });
            const trained: Record<string, any> = withTrained(a, { models: [a, b], ...fgShape });
            const done: Record<string, any> = { ...withTrained(b, { models: [a, b], ...fgShape }), status: true };
            rust({ bounds: { min: null, max: null }, running: () => new Error('count failed'), noRows: true });
            await mountB([trained, done], { runningConditionNoneConfirmed: false, runningConditionFilters: [COND] });
            // nothing was known up front: the card is not red, Train is not blocked by a guard
            expect(screen.getByTestId('rc-card').getAttribute('data-norows')).toBeNull();
            const board = await waitFor(() => screen.getByTestId('results-no-data'));
            expect(board.querySelector('.wbx-msg-s')!.textContent)
                .toBe('No row inside its train periods passes the running condition with values for this model. Fix it in Running condition ↑ to see its charts.');
            expect(screen.queryByTestId('results-error')).toBeNull();
            expect(screen.getByTestId('footer-pill').textContent).toBe('Trained');
            expect(screen.getByTestId('tab-status-m1').getAttribute('data-dot')).toBe('need');
            expect(screen.getByTestId('tab-status-m1').getAttribute('title')).not.toMatch(/Training failed/);
            expect(screen.getByTestId('sensor-kind-badge-dot-m1').getAttribute('data-state')).toBe('trained');
            // asked once, and not again while nothing changed
            await act(async () => { await new Promise(r => setTimeout(r, 400)); });
            expect(engineCalls('compute_sensor_stats')).toHaveLength(1);
            expect(engineCalls('compute_health_preview')).toHaveLength(0);

            // the Complete one: the same board — never "Couldn't load the model · Load it again"
            fireEvent.click(screen.getAllByTestId('sensor-row-label')[1]);
            await waitFor(() => expect(screen.getByTestId('tab-status-m2')).toBeTruthy());
            await waitFor(() => expect(screen.getByTestId('results-no-data').querySelector('.wbx-msg-d')!.textContent).toBe('Complete · nothing about the model changed'));
            expect(screen.queryByTestId('results-load-failed')).toBeNull();
            expect(screen.queryByTestId('board-load-again')).toBeNull();
            expect(screen.queryByTestId('board-train-menu')).toBeNull();
            expect(screen.getByTestId('footer-pill').textContent).toBe('Complete');
            expect(screen.getByTestId('tab-status-m2').getAttribute('data-dot')).toBe('complete');
            expect(screen.getByTestId('tab-status-m2').getAttribute('title')).toBe('Complete · no data in the loaded file');
            expect((screen.getByTestId('next-health-score') as HTMLButtonElement).disabled).toBe(false);
            await act(async () => { await new Promise(r => setTimeout(r, 400)); });
            expect(engineCalls('compute_sensor_stats')).toHaveLength(2); // one per model, no retry
            expect(document.body.textContent).not.toMatch(/Training failed|Couldn't load|No valid numeric values/);
            expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
            warn.mockRestore();
        });

        it('a count that answers STALE_SESSION (or fails any other way) never blocks Train', async () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            rust({ running: () => new Error('STALE_SESSION: the dataset changed') });
            await mountB([makeModel({ id: 'm1', targetSensor: 'TAG1' })], { runningConditionNoneConfirmed: false, runningConditionFilters: [COND] });
            await waitFor(() => expect(periodCountCalls().length).toBeGreaterThan(0));
            await flush();
            expect(screen.getByTestId('rc-card').getAttribute('data-norows')).toBeNull();
            expect(screen.queryByTestId('build-block-reason')).toBeNull();
            expect(trainSensorBtn().disabled).toBe(false);
            expect(screen.getByTestId('tab-status-m1').getAttribute('data-dot')).not.toBe('bad');
            warn.mockRestore();
        });
    });

    describe('A Custom model\'s own lists: Save changes is blocked by exactly what blocks Apply (decision 2026-10-10)', () => {
        const customModel = (over: Record<string, any> = {}) => makeModel({
            id: 'm1', targetSensor: 'TAG1', runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true,
            filterTimePeriods: [P_IN], customTestPeriods: S_IN, ...over,
        });
        const save = () => screen.getByTestId('save-changes') as HTMLButtonElement;
        const own = () => within(screen.getByTestId('custom-rc-panel'));

        it('ANY invalid own period blocks the save — a TRAIN period too: "Fix P1 before saving"; a period outside the data the same; no train period: "Add a train period"', async () => {
            rust({ running: () => 800 });
            await mountB([customModel()]);
            openSettings();
            // a reversed TRAIN period (it used to block Train only, never Save)
            type(own().getByLabelText('P1 end'), '2025-02-01T00:00');
            expect(own().getByTestId('period-invalid-1').textContent).toMatch(/^P1 ends before it starts/);
            expect(save().disabled).toBe(true);
            expect(save().title).toBe('P1 ends before it starts.');
            expect(footReason()).toBe('Fix P1 before saving');
            mockUpdateWorkspaceData.mockClear();
            fireEvent.click(save());
            await flush();
            expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
            // entirely outside the data
            type(own().getByLabelText('P1 end'), P_OUT.end);
            type(own().getByLabelText('P1 start'), P_OUT.start);
            expect(own().getByTestId('period-invalid-1').textContent).toBe(OUTSIDE_REASON);
            expect(save().disabled).toBe(true);
            expect(save().title).toBe(`${OUTSIDE_REASON}.`);
            expect(footReason()).toBe('Fix P1 before saving');
            // a scoring period outside the data
            type(own().getByLabelText('P1 start'), P_IN.start);
            type(own().getByLabelText('P1 end'), P_IN.end);
            expect(save().disabled).toBe(false);
            type(own().getByLabelText('Scoring period 1 end'), '2026-03-01T00:00');
            type(own().getByLabelText('Scoring period 1 start'), '2026-02-01T00:00');
            expect(own().getByTestId('test-invalid-1').textContent).toBe('S1 is outside the data (2025/01/01 00:00 – 2025/12/31 23:59)');
            expect(save().disabled).toBe(true);
            expect(footReason()).toBe('Fix S1 before saving');
            type(own().getByLabelText('Scoring period 1 start'), S_IN[0].start);
            type(own().getByLabelText('Scoring period 1 end'), S_IN[0].end);
            // no train period at all
            fireEvent.click(own().getByRole('button', { name: 'Remove P1' }));
            expect(save().disabled).toBe(true);
            expect(footReason()).toBe('Add a train period');
            expect(trainSensorBtn().disabled).toBe(true);
            expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
        });

        it('its own settled count of zero rows: the red line in its panel, Save changes disabled with "No rows to train on", Train blocked — never while the count is on its way', async () => {
            const EMPTY_END = '2025-04-20T23:59';
            rust({ running: p => (p.end === EMPTY_END ? 0 : 800) });
            await mountB([customModel()]);
            openSettings();
            await waitFor(() => expect(own().getByTestId('rc-caption-rows').textContent).toBe('800 of 5,000 rows (16%) used for training'));
            type(own().getByLabelText('P1 end'), EMPTY_END);
            expect(save().disabled).toBe(false); // the new count is not in yet
            await waitFor(() => expect(own().getByTestId('rc-no-rows')).toBeTruthy(), { timeout: 3000 });
            // this model uses all rows: there is no condition to relax
            expect(own().getByTestId('rc-no-rows').textContent).toBe('No rows match — nothing to train on. Widen a train period.');
            expect(save().disabled).toBe(true);
            expect(footReason()).toBe('No rows to train on');
            expect(save().title).toBe('No rows match — nothing to train on. Widen a train period in Model settings → Training data (Custom).');
            expect(trainSensorBtn().disabled).toBe(true);
            expect(trainSensorBtn().title).toBe("Can't train: Individual — No rows to train on in its own training data");
            mockUpdateWorkspaceData.mockClear();
            fireEvent.click(save());
            await flush();
            expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
            // widening the period again lifts it
            type(own().getByLabelText('P1 end'), '2025-04-25T23:59');
            await waitFor(() => expect(own().queryByTestId('rc-no-rows')).toBeNull(), { timeout: 3000 });
            expect(save().disabled).toBe(false);
        });

        it('NO saved own train period inside the data blocks Train with the named reason (nothing written); the fix is in Model settings — and the saved row only warns', async () => {
            rust({ running: () => 800 });
            await mountB([customModel({ filterTimePeriods: [P_OUT] })]);
            await waitFor(() => expect(trainSensorBtn().title).toBe("Can't train: Individual — No train period inside the data in its own training data"));
            expect(trainSensorBtn().disabled).toBe(true);
            // its Model settings opened by themselves (the fix is inside), so the wording points up
            expect(screen.getByTestId('custom-rc-panel')).toBeTruthy();
            expect(footReason()).toBe('Above: move P1 inside the data range');
            expect(own().queryByTestId('period-invalid-1')).toBeNull();
            expect(own().getByTestId('period-data-note-1').textContent).toBe(`${OUTSIDE_REASON} — it is not used`);
            // the workspace card is not about this model's own period
            expect(screen.getByTestId('rc-card').getAttribute('data-state')).toBe('set');
            expect(screen.getByTestId('rc-card').getAttribute('data-norows')).toBeNull();
            expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
        });

        it('S3 — one order for the badge and the sentence: a Custom model with neither a condition nor a train period is told about the condition first', async () => {
            rust({ running: () => 800 });
            await mountB([customModel({ customRunningConditionNoneConfirmed: false, filterTimePeriods: [] })]);
            expect(screen.getByTestId('tab-status-m1').getAttribute('title')).toBe('Needs condition');
            expect(footReason()).toBe('Set a condition above, or choose Use all rows');
            // the condition chosen: now the train period is what is missing — badge and sentence together
            fireEvent.click(own().getByTestId('rc-mode-none'));
            expect(screen.getByTestId('tab-status-m1').getAttribute('title')).toMatch(/^Needs train period/);
            expect(footReason()).toBe('Add a train period');
        });
    });

    // The stricter rule took a Complete model's charts away, called it
    // "Marked complete — it has no charts to show", gave it a green dot titled "Fix periods" and made
    // Next / Health score / Mark incomplete / Mark complete again unreachable.
    describe('R3 / R5 — a SAVED train period outside the data next to one inside it: an amber warning, nothing else changes', () => {
        const P_OUT2 = { ...P_OUT, id: 'p2' };
        const WARN = '⚠ P2 is outside the data (2025/01/01 00:00 – 2025/12/31 23:59) — it is not used';
        const fgShape = { runningConditionFilters: [], runningConditionCombine: 'and', runningConditionTimePeriods: [P_IN, P_OUT2], runningConditionNoneConfirmed: true };
        const record = { at: '2026-10-04T01:00:00.000Z', outputDir: 'C:/data/workspaces/ws1/output', setPoints: HS_SNAP, scoringIntervalSecs: 3600 };
        const trainedModel = (over: Record<string, any> = {}) => {
            const base = makeModel({ id: 'm1', targetSensor: 'TAG1', healthSetPoints: HS_SNAP });
            return { ...withTrained(base, { models: [base], ...fgShape }), ...over };
        };
        const outsideIsEmpty = (pp: { start: string | null }) => (pp.start === P_OUT2.start ? 0 : 800);

        it('a TRAINED model: the card is amber-warned (still "set"), charts + "Next: Health score →" + the preview are there, the dot and the pill keep their words, and Mark complete works', async () => {
            rust({ running: outsideIsEmpty });
            await mountB([trainedModel()], { runningConditionTimePeriods: [P_IN, P_OUT2] });
            await waitFor(() => expect(screen.getByTestId('rc-card-outside').textContent).toBe(WARN));
            const card = screen.getByTestId('rc-card');
            expect(card.getAttribute('data-state')).toBe('set');
            expect(card.getAttribute('data-norows')).toBeNull();
            expect(card.className).toContain('rcc-card--ok');
            // the count of the persisted condition is still asked and shown (the outside period simply holds no row)
            await waitFor(() => expect(screen.getByTestId('rc-card-rows').textContent).toBe('800'));
            // read paths: exactly as before the guards existed
            await waitFor(() => expect(screen.getByTestId('results-chart')).toBeTruthy());
            expect(healthCalls().length).toBeGreaterThan(0);
            expect(screen.getByTestId('footer-pill').textContent).toBe('Trained');
            expect(screen.queryByTestId('build-block-reason')).toBeNull();
            expect(screen.getByTestId('tab-status-m1').getAttribute('title')).toBe('Trained');
            expect(screen.getByTestId('tab-status-m1').getAttribute('data-dot')).not.toBe('bad');
            expect(screen.getByTestId('sensor-kind-badge-dot-m1').getAttribute('data-state')).toBe('trained');
            expect((screen.getByTestId('next-health-score') as HTMLButtonElement).disabled).toBe(false);
            // Train is not blocked either: one period inside the data is enough
            expect(trainSensorWhy()).toBe('1 model up to date — nothing to train');
            // R5: Mark complete is not blocked by the data guards
            await openHealthPage();
            await waitFor(() => expect(hsMarkBtn().disabled).toBe(false));
            await hsClickMark();
            await waitFor(() => expect(screen.getByTestId('save-ok')).toBeTruthy());
            expect(exportCalls()).toHaveLength(1);
            expect((await hsLastModel()).status).toBe(true);
        });

        it('a COMPLETE model: charts, the Health score page, "Mark complete again" and "Mark incomplete" are all available; the dot stays Complete and it is not listed under "Needs setup"', async () => {
            rust({ running: outsideIsEmpty });
            await mountB([trainedModel({ status: true, healthExport: record })], { runningConditionTimePeriods: [P_IN, P_OUT2] });
            await waitFor(() => expect(screen.getByTestId('rc-card-outside').textContent).toBe(WARN));
            await waitFor(() => expect(screen.getByTestId('results-chart')).toBeTruthy());
            expect(screen.queryByTestId('results-placeholder')).toBeNull();
            expect(screen.getByTestId('footer-pill').textContent).toBe('Complete');
            expect(screen.getByTestId('tab-status-m1').getAttribute('title')).toBe('Complete');
            expect(screen.getByTestId('tab-status-m1').getAttribute('data-dot')).toBe('complete');
            expect(screen.getByTestId('sensor-kind-badge-dot-m1').getAttribute('data-state')).toBe('complete');
            expect(screen.getByRole('button', { name: /^Needs setup/ }).textContent).toBe('Needs setup 0');
            expect(screen.getByRole('button', { name: /^Complete/ }).textContent).toBe('Complete 1');
            expect(trainSensorWhy()).toBe('1 model up to date — nothing to train');
            await openHealthPage();
            // Mark complete again (its own precondition: the set points changed after saving)
            hsType('sp-upper', '12');
            const again = await screen.findByTestId('mark-complete-again') as HTMLButtonElement;
            await waitFor(() => expect(again.disabled).toBe(false));
            await act(async () => { fireEvent.click(again); await Promise.resolve(); });
            await waitFor(() => expect(screen.getByTestId('save-ok')).toBeTruthy());
            expect(exportCalls()).toHaveLength(1);
            expect((await hsLastModel()).status).toBe(true);
            // Mark incomplete
            await act(async () => { fireEvent.click(screen.getByTestId('mark-incomplete')); await Promise.resolve(); });
            await flush();
            expect((await hsLastModel()).status).toBe(false);
        });

        it('the settings modal: the saved period warns on its row (amber, not red) and an unrelated edit applies — the outside period is written back untouched', async () => {
            rust({ running: outsideIsEmpty });
            await mountB([makeModel()], { runningConditionTimePeriods: [P_IN, P_OUT2] });
            const dlg = openRc();
            expect(dlg.getByTestId('period-data-note-2').textContent).toBe('P2 is outside the data (2025/01/01 00:00 – 2025/12/31 23:59) — it is not used');
            expect(dlg.getByTestId('period-row-2').getAttribute('data-invalid')).toBeNull();
            expect(dlg.getByTestId('rc-tl-P2').className).toContain('warn');
            expect(screen.queryByTestId('rc-fix-period-pill')).toBeNull();
            type(dlg.getByLabelText('P1 end'), '2025-04-20T23:59'); // an edit of ANOTHER period
            expect(screen.queryByTestId('rc-apply-block')).toBeNull();
            expect(apply().disabled).toBe(false);
            mockUpdateWorkspaceData.mockClear();
            fireEvent.click(apply());
            await flush();
            const fg = (await mockUpdateWorkspaceData.mock.results[0].value).failureGroupState;
            expect(fg.runningConditionTimePeriods).toEqual([{ ...P_IN, end: '2025-04-20T23:59' }, P_OUT2]);
        });
    });

    // S1: a SAVED scoring period outside the data was ignored while nothing was edited
    // and then blocked as soon as ANY draft existed — typing a model name made the pill "Incomplete",
    // replaced the charts by "S1 is outside the data" and disabled Save with no way back.
    describe('S1 — the legacy state "a saved scoring period outside the data": it warns, and never blocks an unrelated edit', () => {
        const S_OUT = [{ id: 's1', start: '2024-02-01T00:00', end: '2024-03-01T00:00' }];
        const S_WARN = 'S1 is outside the data — nothing is scored there';

        it('workspace: the card and the row warn; an unrelated Apply works; MOVING that period to another place outside the data blocks ("Fix S1 before applying")', async () => {
            rust({ running: () => 800 });
            await mountB([makeModel()], { runningConditionTestPeriods: S_OUT });
            await waitFor(() => expect(screen.getByTestId('rc-card-outside').textContent).toBe(`⚠ ${S_WARN}`));
            expect(screen.getByTestId('rc-card').className).toContain('rcc-card--ok');
            const dlg = openRc();
            expect(dlg.getByTestId('test-data-note-1').textContent).toBe(S_WARN);
            expect(dlg.getByTestId('test-row-1').getAttribute('data-invalid')).toBeNull();
            expect(dlg.getByTestId('test-row-1').getAttribute('data-outside')).toBe('true');
            // R2: changed in this draft and still outside the data — blocked at once
            type(dlg.getByLabelText('Scoring period 1 start'), '2024-02-02T00:00');
            expect(dlg.getByTestId('test-invalid-1').textContent).toBe('S1 is outside the data (2025/01/01 00:00 – 2025/12/31 23:59)');
            expect(screen.getByTestId('rc-apply-block').textContent).toBe('Fix S1 before applying');
            // typed back to what was saved: the warning again, nothing blocked
            type(dlg.getByLabelText('Scoring period 1 start'), S_OUT[0].start);
            expect(dlg.queryByTestId('test-invalid-1')).toBeNull();
            expect(screen.queryByTestId('rc-apply-block')).toBeNull();
            // R3: an unrelated edit applies, the saved scoring period is written back untouched
            type(dlg.getByLabelText('P1 end'), '2025-04-20T23:59');
            expect(apply().disabled).toBe(false);
            mockUpdateWorkspaceData.mockClear();
            fireEvent.click(apply());
            await flush();
            const fg = (await mockUpdateWorkspaceData.mock.results[0].value).failureGroupState;
            expect(fg.runningConditionTestPeriods).toEqual(S_OUT);
            expect(fg.runningConditionTimePeriods).toEqual([{ ...P_IN, end: '2025-04-20T23:59' }]);
        });

        it('a Custom model: renaming it keeps the "Trained" pill and the charts, Save changes works — and its own row warns', async () => {
            rust({ running: () => 800 });
            const base = makeModel({
                id: 'm1', targetSensor: 'TAG1', runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true,
                filterTimePeriods: [P_IN], customTestPeriods: S_OUT, healthSetPoints: HS_SNAP,
            });
            await mountB([withTrained(base, { models: [base] })]);
            await waitFor(() => expect(screen.getByTestId('results-chart')).toBeTruthy());
            expect(screen.getByTestId('footer-pill').textContent).toBe('Trained');
            openSettings();
            expect(within(screen.getByTestId('custom-rc-panel')).getByTestId('test-data-note-1').textContent).toBe(S_WARN);
            fireEvent.change(screen.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Renamed' } });
            // a draft exists now: nothing about the saved scoring period changes
            expect(screen.getByTestId('footer-pill').textContent).toBe('Trained');
            expect(screen.getByTestId('results-chart')).toBeTruthy();
            expect(screen.queryByTestId('build-block-reason')).toBeNull();
            const save = screen.getByTestId('save-changes') as HTMLButtonElement;
            expect(save.disabled).toBe(false);
            mockUpdateWorkspaceData.mockClear();
            await act(async () => { fireEvent.click(save); await Promise.resolve(); });
            await flush();
            const written = (await mockUpdateWorkspaceData.mock.results[0].value).failureGroupState.models[0];
            expect(written.name).toBe('Renamed');
            expect(written.customTestPeriods).toEqual(S_OUT);
        });

        it('switching a model to Custom copies the workspace periods: a COPIED period outside the data only warns (the user did not pick it) and Save changes works — one the user then ADDS outside the data blocks', async () => {
            rust({ running: () => 800 });
            await mountB([makeModel()], { runningConditionTimePeriods: [P_IN, { ...P_OUT, id: 'p2' }], runningConditionTestPeriods: S_OUT });
            openSettings();
            fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
            const own = within(screen.getByTestId('custom-rc-panel'));
            expect(own.getByTestId('period-data-note-2').textContent).toBe('P2 is outside the data (2025/01/01 00:00 – 2025/12/31 23:59) — it is not used');
            expect(own.queryByTestId('period-invalid-2')).toBeNull();
            expect(own.getByTestId('test-data-note-1').textContent).toBe(S_WARN);
            expect(own.queryByTestId('test-invalid-1')).toBeNull();
            const save = screen.getByTestId('save-changes') as HTMLButtonElement;
            expect(save.disabled).toBe(false);
            // R2 still holds for what the user picks here: the copied period MOVED to another place outside the data
            type(own.getByLabelText('P2 end'), '2026-04-01T00:00');
            expect(own.getByTestId('period-invalid-2').textContent).toBe('P2 is outside the data (2025/01/01 00:00 – 2025/12/31 23:59)');
            expect(save.disabled).toBe(true);
            expect(footReason()).toBe('Fix P2 before saving');
            type(own.getByLabelText('P2 end'), P_OUT.end);
            expect(save.disabled).toBe(false);
            mockUpdateWorkspaceData.mockClear();
            await act(async () => { fireEvent.click(save); await Promise.resolve(); });
            await flush();
            const written = (await mockUpdateWorkspaceData.mock.results[0].value).failureGroupState.models[0];
            expect(written.runningConditionMode).toBe('custom');
            expect(written.filterTimePeriods.map((x: any) => [x.start, x.end])).toEqual([[P_IN.start, P_IN.end], [P_OUT.start, P_OUT.end]]);
        });

        // The engine answers like the real one for an empty scope (`noRows`) — the charts
        // cannot be drawn, and the board says so with ONE link into the model's OWN settings (Custom).
        it('a Custom TRAINED model whose own scope holds no rows any more: it stays "Trained", the "No data…" board points at its Model settings (a working link) — and renaming it still saves (the scope did not change)', async () => {
            rust({ running: () => 0, noRows: true });
            const base = makeModel({
                id: 'm1', targetSensor: 'TAG1', runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true,
                filterTimePeriods: [P_IN], customTestPeriods: S_IN, healthSetPoints: HS_SNAP,
            });
            await mountB([withTrained(base, { models: [base] })]);
            await waitFor(() => expect(trainSensorWhy()).toBe("Can't train · No rows to train on in its own training data"));
            const board = await waitFor(() => screen.getByTestId('results-no-data'));
            // "Use all rows": there is no condition to name
            expect(board.querySelector('.wbx-msg-s')!.textContent).toBe('Its train periods hold no row of the data. Fix it in Model settings to see its charts.');
            expect(within(board).queryByTestId('board-open-rc')).toBeNull();
            expect(screen.queryByTestId('results-error')).toBeNull();
            expect(screen.queryByTestId('board-train-sensor')).toBeNull();
            expect(screen.getByTestId('footer-pill').textContent).toBe('Trained');
            expect(screen.getByTestId('footer-no-data').textContent)
                .toBe('Trained · no rows for it in the loaded file — fix its own running condition in Model settings to see its charts');
            // the link opens the model's own settings (they were closed: nothing in them is "missing")
            expect(screen.queryByTestId('add-model-form')).toBeNull();
            fireEvent.click(within(board).getByTestId('board-open-settings'));
            expect(screen.getByTestId('add-model-form')).toBeTruthy();
            expect(screen.getByTestId('custom-rc-panel')).toBeTruthy();
            expect(mockUpdateWorkspaceData).not.toHaveBeenCalled();
            openSettings();
            fireEvent.change(screen.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Renamed' } });
            const save = screen.getByTestId('save-changes') as HTMLButtonElement;
            expect(save.disabled).toBe(false);
            expect(screen.getByTestId('footer-pill').textContent).toBe('Trained');
            mockUpdateWorkspaceData.mockClear();
            await act(async () => { fireEvent.click(save); await Promise.resolve(); });
            await flush();
            expect((await mockUpdateWorkspaceData.mock.results[0].value).failureGroupState.models[0].name).toBe('Renamed');
        });
    });

    // S2: the Custom zero-rows guard only knew the model on screen, so with two Custom
    // models of one sensor on the same empty condition the story flipped with the open tab and the sibling
    // went to the engine.
    describe('S2 — a Custom model that is NOT the open one', () => {
        const ownLists = { runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true, customTestPeriods: S_IN };

        it('(a) two Custom models of one sensor on the SAME own scope: the settled count of the open one answers for both, whichever tab is open — no second count', async () => {
            rust({ running: () => 0 });
            const ind = makeModel({ id: 'm1', targetSensor: 'TAG1', ...ownLists, filterTimePeriods: [P_IN] });
            // its own period has ANOTHER id but the same dates: the same scope
            const rel = makeModel({ id: 'r1', name: 'Rel', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2'], ...ownLists, filterTimePeriods: [{ ...P_IN, id: 'other' }] });
            await mountB([ind, rel]);
            const BOTH = "Can't train: Individual — No rows to train on in its own training data · Relation model — No rows to train on in its own training data";
            await waitFor(() => expect(trainSensorBtn().title).toBe(BOTH));
            expect(trainSensorBtn().disabled).toBe(true);
            const ownCounts = () => periodCountCalls().filter(c => c.periods.length === 1 && c.periods[0].start === P_IN.start && c.filter === null).length;
            const asked = ownCounts();
            // the other tab: the same story (and the same answer is reused — the scope is the same)
            fireEvent.click(screen.getByTestId('tab-status-r1').closest('button')!);
            await flush();
            await waitFor(() => expect(trainSensorBtn().title).toBe(BOTH));
            expect(screen.getByTestId('tab-status-m1').getAttribute('title')).toBe('No rows to train on');
            expect(screen.getByTestId('tab-status-r1').getAttribute('title')).toBe('No rows to train on');
            expect(ownCounts()).toBeLessThanOrEqual(asked + 1); // at most the newly opened panel's own (identical) request
            expect(mockInvoke.mock.calls.filter(c => c[0] === 'compute_sensor_stats' || c[0] === 'preview_relationship_model')).toHaveLength(0);
        });

        it('(b) a scope the window never counted: the engine\'s own "no rows" answer is shown as the NAMED reason — the Train-all row, the model\'s board — not a raw failure', async () => {
            const NAMED = 'No rows to train on — no row inside the train periods passes the running condition with values for this model. Widen a train period or relax the condition in Model settings → Training data (Custom).';
            mockInvoke.mockImplementation((cmd: string, args?: any) => {
                if (cmd === 'get_dataset_time_bounds') return Promise.resolve(DATA);
                // what Rust answers for an Individual model whose training scope holds no value
                if (cmd === 'compute_sensor_stats' && args?.sensor === 'TAG2') return Promise.reject(new Error("No valid numeric values for sensor 'TAG2'"));
                return healthInvoke(cmd, args);
            });
            const ws = makeModel({ id: 'm1', targetSensor: 'TAG1' });
            // another sensor, its own (never opened, so never counted) scope
            const own = makeModel({ id: 'm2', name: 'Own', targetSensor: 'TAG2', ...ownLists, filterTimePeriods: [{ id: 'q', start: '2025-08-01T00:00', end: '2025-08-31T23:59' }] });
            await mountB([ws, own]);
            await act(async () => { fireEvent.click(screen.getByTestId('train-all')); });
            expect(screen.getByTestId('train-row-status-m2').textContent).toBe('Ready'); // not known to be empty
            await act(async () => { fireEvent.click(screen.getByTestId('train-all-start')); await Promise.resolve(); await Promise.resolve(); });
            await waitFor(() => expect(screen.getByTestId('train-row-m2').querySelector('.tq-err')?.getAttribute('title')).toBe(NAMED), { timeout: 3000 });
            expect(screen.getByTestId('train-row-m2').querySelector('.tq-err')!.textContent).toMatch(/^No rows to train on/);
            expect(screen.getByTestId('train-row-m2').textContent).not.toContain('No valid numeric values');
            expect(screen.getByTestId('train-row-status-m1').textContent).toMatch(/Trained/);
            // nothing was stamped on the model that could not train
            const models = (await Promise.all(mockUpdateWorkspaceData.mock.results.map(r => r.value))).flatMap((w: any) => w.failureGroupState.models);
            expect(models.filter((m: any) => m.id === 'm2' && m.lastTrainedAt)).toHaveLength(0);
        });

        it('(b) the guard is re-checked when the run REACHES the model: rows that vanished after the run was planned skip it with the named reason — the engine is not asked for it', async () => {
            let rows = 800;
            // every train is held until released: the run stands still on its FIRST model
            const pending: { sensor: string; release: () => void }[] = [];
            mockInvoke.mockImplementation((cmd: string, args?: any) => {
                if (cmd === 'get_dataset_time_bounds') return Promise.resolve(DATA);
                if (cmd === 'count_period_rows') return Promise.resolve(countAnswer(args, () => rows));
                if (cmd === 'compute_sensor_stats') {
                    return new Promise(res => { pending.push({ sensor: args?.sensor, release: () => res({ mean: 5, sd: 1, min: 0, max: 10, count: 100, lower1: 4, upper1: 6, lower3: 2, upper3: 8 }) }); });
                }
                return healthInvoke(cmd, args);
            });
            const fgCond = { runningConditionNoneConfirmed: false, runningConditionFilters: [COND] };
            const models = [makeModel({ id: 'm1', targetSensor: 'TAG1' }), makeModel({ id: 'm2', name: 'Two', targetSensor: 'TAG2' })];
            await mountB(models, fgCond);
            await waitFor(() => expect(screen.getByTestId('rc-card-rows').textContent).toBe('800'));
            await act(async () => { fireEvent.click(screen.getByTestId('train-all')); });
            expect(screen.getByTestId('train-row-status-m2').textContent).toBe('Ready');
            await act(async () => { fireEvent.click(screen.getByTestId('train-all-start')); await Promise.resolve(); await Promise.resolve(); });
            await waitFor(() => expect(pending).toHaveLength(1));
            const first = pending[0].sensor === 'TAG1' ? 'm1' : 'm2';
            const second = first === 'm1' ? 'm2' : 'm1';
            // while the first model trains, another window tightens the persisted condition: the card counts it again — zero
            rows = 0;
            const tighter = [{ ...COND, value1: '900' }];
            // (the fake disk holds the tightened condition too, as the other window's write would)
            statefulUpdateMock(models, { runningConditionTimePeriods: [P_IN], runningConditionTestPeriods: S_IN, runningConditionNoneConfirmed: false, runningConditionFilters: tighter });
            await act(async () => {
                for (const cb of listenCallbacks['failure-group-state-changed'] ?? []) {
                    cb({ payload: { workspaceId: 'ws1', origin: 'dashboard', groups: [makeGroup()], models, runningConditionFilters: tighter, runningConditionCombine: 'and', runningConditionNoneConfirmed: false, runningConditionTimePeriods: [P_IN], runningConditionTestPeriods: S_IN } });
                }
                await Promise.resolve();
            });
            await waitFor(() => expect(screen.getByTestId('rc-card').getAttribute('data-norows')).toBe('true'), { timeout: 3000 });
            // the run reaches the second model: skipped with the named reason, never sent to the engine
            await act(async () => { pending[0].release(); await Promise.resolve(); await Promise.resolve(); });
            await waitFor(() => expect(screen.getByTestId(`train-row-${second}`).textContent).toContain('No rows to train on'), { timeout: 3000 });
            expect(pending).toHaveLength(1); // the engine was never asked for the second model
            const stamped = (await Promise.all(mockUpdateWorkspaceData.mock.results.map(r => r.value))).flatMap((w: any) => w.failureGroupState.models).filter((m: any) => m.id === second && m.lastTrainedAt);
            expect(stamped).toHaveLength(0);
        });
    });

    // M1: the bounds were fetched once on mount, so a window re-pointed at another
    // workspace judged the new periods against the OLD data — "P1 is outside the data (2025/01/01 00:00 –
    // 2025/12/31 23:59)" for a valid 2027 period of 2027 data, Train disabled, not repairable.
    describe('M1 — the dataset bounds belong to the dataset on screen (R1)', () => {
        const DATA_2027 = { min: '2027-01-01 00:00:00', max: '2027-12-31 23:59:00' };
        const P_2027 = { id: 'p1', start: '2027-03-01T00:00', end: '2027-04-30T23:59' };
        const boundsCalls = () => mockInvoke.mock.calls.filter(c => c[0] === 'get_dataset_time_bounds').length;

        it('re-pointed at a workspace whose data is 2027: the bounds are asked again (once), the 2027 period is inside the data, Train works — and while the new answer is on its way nothing is judged against the OLD range', async () => {
            let answer: unknown = DATA;
            let hold: ((v: unknown) => void) | null = null;
            let held = false;
            mockInvoke.mockImplementation((cmd: string, args?: any) => {
                if (cmd === 'get_dataset_time_bounds') return held ? new Promise(r => { hold = r; }) : Promise.resolve(answer);
                return healthInvoke(cmd, args);
            });
            await mountB([makeModel({ id: 'm1', targetSensor: 'TAG1' })]);
            await flush();
            expect(boundsCalls()).toBe(1);
            expect(trainSensorBtn().disabled).toBe(false);

            // the main window moves on to another project (another dataset generation)
            const ws2 = { id: 'ws2', failureGroupState: { groups: [makeGroup()], models: [makeModel({ id: 'w2', targetSensor: 'TAG1' })], runningConditionNoneConfirmed: true, rcLegacyNotice: null, runningConditionTimePeriods: [P_2027], runningConditionTestPeriods: [] } };
            mockLoadWorkspaceData.mockResolvedValue(ws2);
            answer = DATA_2027;
            held = true;
            await act(async () => {
                for (const cb of listenCallbacks['build-model-data'] ?? []) {
                    cb({ payload: { workspaceId: 'ws2', sensorHeaders: ['TAG1', 'TAG2'], sensorMetadata: [], metadata: { headers: ['timestamp', 'TAG1', 'TAG2'], total_rows: 1, generation: 2 } } });
                }
                await Promise.resolve(); await Promise.resolve();
            });
            await flush();
            await waitFor(() => expect(screen.getByTestId('tab-status-w2')).toBeTruthy());
            expect(boundsCalls()).toBe(2);
            // the new dataset's range is not known yet: the OLD one must not be used — nothing is flagged
            expect(screen.getByTestId('rc-card').getAttribute('data-state')).toBe('set');
            expect(screen.getByTestId('rc-card').getAttribute('data-norows')).toBeNull();
            expect(screen.queryByTestId('rc-card-outside')).toBeNull();
            expect(trainSensorBtn().disabled).toBe(false);
            // the answer lands: still fine — the 2027 period is inside the 2027 data
            await act(async () => { hold!(DATA_2027); await Promise.resolve(); await Promise.resolve(); });
            expect(screen.queryByTestId('rc-card-outside')).toBeNull();
            expect(screen.getByTestId('rc-card').getAttribute('data-norows')).toBeNull();
            expect(screen.queryByTestId('build-block-reason')).toBeNull();
            expect(trainSensorBtn().disabled).toBe(false);
            expect(boundsCalls()).toBe(2); // once per dataset, no more
            // ...and the modal judges against the NEW range: a 2025 date is what lies outside now
            const dlg = openRc();
            type(dlg.getByLabelText('P1 end'), '2025-04-30T23:59');
            type(dlg.getByLabelText('P1 start'), '2025-03-01T00:00');
            expect(dlg.getByTestId('period-invalid-1').textContent).toBe('P1 is outside the data (2027/01/01 00:00 – 2027/12/31 23:59)');
        });

        it('the same workspace sent again (same dataset) asks nothing again', async () => {
            rust();
            await mountB([makeModel()]);
            await flush();
            expect(boundsCalls()).toBe(1);
            await deliverData({ failureGroupState: { groups: [makeGroup()], models: [makeModel()], runningConditionTimePeriods: [P_IN], runningConditionTestPeriods: S_IN } });
            await flush();
            expect(boundsCalls()).toBe(1);
        });
    });
});
