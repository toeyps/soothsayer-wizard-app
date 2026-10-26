import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, waitFor, within } from '@testing-library/react';

/*
 * QA cross-zone test — ONE running condition (2026-10-26, commits cac87ed +
 * b4b520d; spec: docs/handover/2026-10.md "SPEC FINAL: running condition เดียว").
 *
 * The unit tests pin each half on its own: `workspaceMigrations.test.ts` the
 * conversion, `workspaceManager.test.ts` the read path, `BuildModelWindow.test.tsx`
 * the notice / Apply with a MOCKED workspaceManager. What only shows when the
 * pieces run together is checked here, with BOTH real windows (Dashboard + the
 * Build Model window) on ONE old workspace file:
 *   - the real workspaceManager over an in-memory plugin-fs (the read-path
 *     conversion really runs; every write is a JSON round trip);
 *   - one event bus delivering every emit to every listener (Tauri's global
 *     broadcast), with a switch to DROP the Build Model window's broadcasts so
 *     the Dashboard mirror can go stale;
 *   - Dashboard answers `request-build-model-data` for real.
 * Every content that lands in the workspace file is logged, so "the old set is
 * NEVER written back" is checked on every write, not just the last one.
 */

const h = vi.hoisted(() => ({
    listeners: {} as Record<string, Set<(e: any) => void>>,
    files: new Map<string, string>(),
    /** Every content that landed in a workspace file, in order. */
    landed: [] as { path: string; body: string }[],
    store: new Map<string, unknown>(),
    invokes: [] as { cmd: string; args: any }[],
    drop: null as null | ((event: string, payload: any) => boolean),
}));

vi.mock('@tauri-apps/api/event', () => ({
    listen: async (event: string, cb: (e: any) => void) => {
        (h.listeners[event] ??= new Set()).add(cb);
        return () => { h.listeners[event]?.delete(cb); };
    },
    emit: async (event: string, payload?: unknown) => {
        if (h.drop?.(event, payload)) return;
        for (const cb of [...(h.listeners[event] ?? [])]) cb({ event, payload, id: 0 });
    },
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
    readTextFile: async (p: string) => {
        const v = h.files.get(p);
        if (v === undefined) throw new Error(`ENOENT ${p}`);
        return v;
    },
    writeTextFile: async (p: string, c: string) => { h.files.set(p, c); if (!p.endsWith('.tmp')) h.landed.push({ path: p, body: c }); },
    rename: async (from: string, to: string) => {
        const body = h.files.get(from)!;
        h.files.set(to, body); h.files.delete(from); h.landed.push({ path: to, body });
    },
    exists: async (p: string) => p === 'workspaces' || h.files.has(p),
    mkdir: async () => {},
    remove: async (p: string) => { h.files.delete(p); },
    BaseDirectory: { AppData: 'AppData' },
}));

vi.mock('@tauri-apps/plugin-store', () => ({
    load: async () => ({
        get: async (k: string) => h.store.get(k),
        set: async (k: string, v: unknown) => { h.store.set(k, v); },
        save: async () => {},
    }),
}));

const STATS = { mean: 5, sd: 1, min: 0, max: 10, count: 100, lower1: 4, upper1: 6, lower3: 2, upper3: 8 };
vi.mock('@tauri-apps/api/core', () => ({
    invoke: async (cmd: string, args?: unknown) => {
        h.invokes.push({ cmd, args: JSON.parse(JSON.stringify(args ?? null)) });
        if (cmd === 'get_dataset_time_bounds') return { min: null, max: null };
        if (cmd === 'compute_sensor_stats') return STATS;
        return undefined;
    },
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({ close: vi.fn().mockResolvedValue(undefined), onCloseRequested: vi.fn().mockResolvedValue(() => {}) }),
}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
    WebviewWindow: class { static getByLabel = vi.fn().mockResolvedValue(null); once = vi.fn(); },
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn().mockResolvedValue(undefined) }));
vi.mock('split.js', () => ({ default: () => ({ destroy: vi.fn() }) }));
vi.mock('../errorReporter', () => ({ reportError: vi.fn() }));

// Dashboard's children — stand-ins that call the real props.
vi.mock('../components/charts', () => ({
    Chart: () => <div data-testid="chart-mock" />,
    defaultSensorColor: (tag: string) => `default-${tag}`,
    LINE_CHART_COLORS: ['c0', 'c1', 'c2', 'c3'],
    MAX_PAIR_PLOT_SENSORS: 4,
    RANGE_PALETTE: [[0.99, 0.75, 0.18, 1.0], [0.20, 0.83, 0.60, 1.0]],
}));
vi.mock('../components/dashboard/FilterPanel', () => ({ default: () => <div data-testid="filter-panel" /> }));
vi.mock('../components/dashboard/HighlightsPanel', () => ({ default: () => <div /> }));
vi.mock('../components/dashboard/ColorPlatePicker', () => ({ default: () => <div /> }));
vi.mock('../components/dashboard/SensorSelection', () => ({
    default: (p: any) => (
        <div data-testid="dash-sensor-selection">
            <button onClick={() => p.onSensorChange(['TAG1'])}>dash-select-tag1</button>
            <button onClick={() => p.onSensorChange(['TAG2'])}>dash-select-tag2</button>
            <button onClick={() => p.onRenameGroup(1, 'FG-A renamed')}>dash-rename-fg1</button>
        </div>
    ),
}));
vi.mock('../components/dashboard/FailureGroupsPanel', () => ({ default: () => <div data-testid="dash-fg-panel" /> }));
vi.mock('../hooks/useChartData', () => ({ useChartData: () => ({ view: null, loading: false, error: null }) }));
vi.mock('../hooks/useScatterSample', () => ({
    useScatterSample: () => ({ rows: [], headers: [], total: 0, sampled: 0, loading: false, error: null }),
}));
vi.mock('../components/charts/LineChart', () => ({ default: () => <div /> }));
vi.mock('../components/charts/ResponsiveECharts', () => ({ default: () => <div /> }));

import Dashboard from '../components/dashboard/Dashboard';
import BuildModelWindow from '../components/windows/BuildModelWindow';
import { loadWorkspaceData } from '../workspaceManager';
import { computeTrainFingerprint } from '../utils/trainFingerprint';
import { buildWorkspaceExportRequest } from '../utils/exportReadiness';
import { trainingScopeFilter } from '../utils/trainingScope';
import { ALL_TIME_TRAIN, ONE_TEST } from './helpers/trainTestFixture';

// ── fixtures ────────────────────────────────────────────────────────────

const WS_FILE = 'workspaces/ws1.json';
const HEADERS = ['TAG1', 'TAG2'];
const sensorMetadata = [
    { tag: 'TAG1', description: 'Pump Pressure', unit: 'bar', component: 'Pump' },
    { tag: 'TAG2', description: 'Pump Speed', unit: 'rpm', component: 'Pump' },
];

/** The kept condition: the FIRST complete "above" row of the old set. */
const KEPT = { id: 'old-b', sensor: 'TAG2', operation: 'greater_than', value1: '10', value2: '' };
/** The old workspace set: AND/OR (OR here), "<", ">", "between". */
const OLD_SET = [
    { id: 'old-a', sensor: 'TAG1', operation: 'less_than', value1: '90', value2: '' },
    KEPT,
    { id: 'old-c', sensor: 'TAG1', operation: 'between', value1: '1', value2: '5' },
];
const SAVED_STATUS = { sensor: 'TAG1', stopAtOrBelow: '3' };
const SET_POINTS = { kind: 'individual', lower: 1, upper: 9, masterLower: null, masterUpper: null };

function model(o: Record<string, unknown>) {
    return {
        id: 'x', groupNos: [1], name: 'QA model', kind: 'individual', category: 'performance', notes: '', status: false,
        targetSensor: 'TAG1', predictorSensors: [], xSensor: '', ySensor: '',
        individualChecked: true, rcMode: null, scatterXSensor: '', relModelName: '', relStiffness: 100_000,
        clusterModelName: '', numClusters: 3, criteriaSensor: '', clusterRanges: [],
        filterTimePeriods: [], runningConditionMode: 'workspace', customRunningConditionFilters: [],
        customRunningConditionCombine: 'and', customRunningConditionNoneConfirmed: false,
        ...o,
    } as any;
}

/** A Complete, trained-and-fresh model UNDER `fg` (its fingerprint taken against that fg). */
function completeUnder(fg: any, o: Record<string, unknown>) {
    const m = model({ status: true, lastTrainedAt: '2026-10-01T00:00:00Z', healthSetPoints: SET_POINTS, ...o });
    m.trainedFingerprint = computeTrainFingerprint(m, fg);
    return m;
}

/**
 * An old (pre-2026-10-26) workspace: a workspace set with OR, "<", "between"
 * and the export's own saved running status; a Complete Workspace-mode model
 * (i1, TAG1); a Complete Custom model whose own condition is a "between" only
 * (c1, TAG2 -> nothing to keep: must be set again); an old legacy-banner flag.
 */
function oldWorkspace(extraFg: Record<string, unknown> = {}) {
    const fgBase: any = {
        groups: [{ no: 0, name: 'Not in Group' }, { no: 1, name: 'FG-A' }],
        runningConditionFilters: OLD_SET,
        runningConditionCombine: 'or',
        runningConditionNoneConfirmed: false,
        runningConditionTimePeriods: ALL_TIME_TRAIN,
        runningConditionTestPeriods: ONE_TEST,
        runningStatus: SAVED_STATUS,
        rcLegacyNotice: 'pending',
        categoryNormalisationNotice: null,
        ...extraFg,
    };
    const i1 = completeUnder(fgBase, { id: 'i1', name: 'Pressure band', targetSensor: 'TAG1' });
    const c1 = completeUnder(fgBase, {
        id: 'c1', name: 'Speed own', targetSensor: 'TAG2', runningConditionMode: 'custom',
        customRunningConditionFilters: [{ id: 'own-a', sensor: 'TAG1', operation: 'between', value1: '1', value2: '5' }],
        customRunningConditionCombine: 'and', filterTimePeriods: ALL_TIME_TRAIN, customTestPeriods: ONE_TEST,
    });
    return {
        id: 'ws1', name: 'QA WS', lastRoute: 'dashboard', dataFilePaths: [], metadataFilePath: null,
        selectedSensors: [], visibleSensors: [], operationConfig: null,
        failureGroupState: { ...fgBase, models: [i1, c1] },
    };
}

const writeDisk = (s: unknown) => h.files.set(WS_FILE, JSON.stringify(s));
const readDisk = () => JSON.parse(h.files.get(WS_FILE)!);
const diskFg = () => readDisk().failureGroupState;
const diskModel = (id: string) => diskFg().models.find((m: any) => m.id === id);
const wsLanded = () => h.landed.filter(l => l.path === WS_FILE).map(l => JSON.parse(l.body));

async function settle(ms = 0) {
    await act(async () => { await new Promise(r => setTimeout(r, ms)); });
}

const bmw = () => within(screen.getByTestId('build-model-window'));

/**
 * Both windows up. `initial` is what the Dashboard starts with: `'read'` = what
 * the app really passes (App.tsx loads it through `loadWorkspaceData`, i.e.
 * already converted); `'raw'` = the worst case, a Dashboard whose mirror still
 * holds the OLD set (e.g. it was opened by an older build's state).
 */
async function mountBoth(initial: 'read' | 'raw' = 'read') {
    const initialState = initial === 'read' ? await loadWorkspaceData('ws1') : readDisk();
    render(
        <>
            <div data-testid="dashboard-window">
                <Dashboard
                    metadata={{ headers: ['timestamp', ...HEADERS], total_rows: 100 }}
                    sensorMetadata={sensorMetadata}
                    onBack={vi.fn()}
                    initialState={initialState as any}
                />
            </div>
            <div data-testid="build-model-window"><BuildModelWindow /></div>
        </>,
    );
    await waitFor(() => expect(bmw().getByTestId('rc-card')).toBeTruthy());
    await settle(350); // hydration + the Dashboard's on-mount autosave
}

/** An unrelated Dashboard edit -> its debounced full-object autosave. */
async function dashboardEdit(which: 'dash-select-tag1' | 'dash-select-tag2' = 'dash-select-tag1') {
    await act(async () => { fireEvent.click(screen.getByText(which)); });
    await settle(350);
}

const dropBuildModelBroadcasts = () => {
    h.drop = (event, payload) => event === 'failure-group-state-changed' && payload?.origin === 'build-model';
};

/** No write ever put any piece of the old shape back. */
function expectNoOldShapeEverWritten() {
    for (const ws of wsLanded()) {
        const fg = ws.failureGroupState;
        expect(fg.runningConditionFilters).toEqual([KEPT]);
        expect(fg.runningConditionCombine).toBe('and');
        expect(fg.runningConditionNoneConfirmed).toBe(false);
        expect(fg.runningStatus ?? null).toBeNull();
        expect(fg.rcLegacyNotice ?? null).toBeNull();
        const c1 = fg.models.find((m: any) => m.id === 'c1');
        expect(c1.customRunningConditionFilters).toEqual([]);
    }
}

beforeEach(() => {
    for (const k of Object.keys(h.listeners)) delete h.listeners[k];
    h.files.clear();
    h.landed.length = 0;
    h.store.clear();
    h.invokes.length = 0;
    h.drop = null;
});

afterEach(() => {
    cleanup();
});

// ─────────────────────────────────────────────────────────────────────────
// (1) the old workspace opened with BOTH windows
// ─────────────────────────────────────────────────────────────────────────

describe('(1) an old workspace opened with the Dashboard and the Build Model window both mounted', () => {
    const cases: { initial: 'read' | 'raw'; lost: boolean }[] = [
        { initial: 'read', lost: false },
        { initial: 'raw', lost: true },
    ];
    for (const { initial, lost } of cases) {
        it(`the Dashboard autosave never writes the old set back (Dashboard starts from ${initial === 'read' ? 'the converted read' : 'the RAW old file'}, broadcast ${lost ? 'LOST' : 'delivered'})`, async () => {
            writeDisk(oldWorkspace());
            if (lost) dropBuildModelBroadcasts();
            await mountBoth(initial);
            await dashboardEdit('dash-select-tag1');
            await dashboardEdit('dash-select-tag2');
            await act(async () => { fireEvent.click(screen.getByText('dash-rename-fg1')); });
            await settle(350);

            expect(wsLanded().length).toBeGreaterThan(0);
            expectNoOldShapeEverWritten();
            const fg = diskFg();
            expect(fg.groups.find((g: any) => g.no === 1).name).toBe('FG-A renamed');
            // The one notice record survives every Dashboard write.
            expect(fg.runningConditionConversion).toMatchObject({
                result: 'converted', source: 'first-above', after: { sensor: 'TAG2', value: '10' },
                customModels: [{ id: 'c1', result: 'needs-set' }],
            });
            expect([...fg.runningConditionConversion.incompleteModelIds].sort()).toEqual(['c1', 'i1']);
        });
    }

    it('demoted models: Incomplete on disk with set points, train record and fingerprint KEPT; the window says "Re-train needed" and opens no modal by itself', async () => {
        const before = oldWorkspace();
        writeDisk(before);
        await mountBoth();
        await dashboardEdit();

        for (const id of ['i1', 'c1']) {
            const was = before.failureGroupState.models.find((m: any) => m.id === id);
            const now = diskModel(id);
            expect(now.status, id).toBe(false);
            expect(now.healthSetPoints, id).toEqual(SET_POINTS);
            expect(now.lastTrainedAt, id).toBe(was.lastTrainedAt);
            expect(now.trainedFingerprint, id).toBe(was.trainedFingerprint);
            // ...and that fingerprint is out of date against the converted condition.
            expect(computeTrainFingerprint(now, diskFg()), id).not.toBe(now.trainedFingerprint);
        }

        // The conversion notice, no auto-opened modal (the condition is set).
        expect(bmw().getByTestId('rc-conversion-notice').textContent).toMatch(/Running condition is now one condition/);
        expect(bmw().queryByTestId('rc-one')).toBeNull();
        // i1's tab (TAG1, the first sensor, auto-selected) says it must be trained again.
        await waitFor(() => expect(bmw().getByTestId('tab-words-i1').textContent).toMatch(/^Re-train needed/));
    });

    it('a pure cleanup (one ">" next to a blank row) changes no rows: the Complete model stays Complete and fresh, and no notice appears', async () => {
        const ONE = { id: 'keep', sensor: 'TAG2', operation: 'greater_than', value1: '10', value2: '' };
        const blank = { id: 'blank', sensor: '', operation: 'less_than', value1: '', value2: '' };
        const fgBase: any = {
            groups: [{ no: 0, name: 'Not in Group' }, { no: 1, name: 'FG-A' }],
            runningConditionFilters: [ONE, blank], runningConditionCombine: 'and', runningConditionNoneConfirmed: false,
            runningConditionTimePeriods: ALL_TIME_TRAIN, runningConditionTestPeriods: ONE_TEST,
            rcLegacyNotice: null, categoryNormalisationNotice: null,
        };
        const i1 = completeUnder(fgBase, { id: 'i1', name: 'Pressure band' });
        writeDisk({ id: 'ws1', name: 'QA WS', lastRoute: 'dashboard', dataFilePaths: [], metadataFilePath: null, selectedSensors: [], visibleSensors: [], operationConfig: null, failureGroupState: { ...fgBase, models: [i1] } });
        await mountBoth();
        await dashboardEdit();

        const fg = diskFg();
        expect(fg.runningConditionFilters).toEqual([ONE]); // byte-for-byte
        expect(fg.runningConditionConversion).toBeNull();
        expect(diskModel('i1').status).toBe(true);
        expect(computeTrainFingerprint(diskModel('i1'), fg)).toBe(i1.trainedFingerprint);
        expect(bmw().queryByTestId('rc-conversion-notice')).toBeNull();
        await waitFor(() => expect(bmw().getByTestId('tab-words-i1').textContent).toMatch(/^Complete/));
    });
});

// ─────────────────────────────────────────────────────────────────────────
// (2) Got it persists across a Dashboard autosave and a reopen
// ─────────────────────────────────────────────────────────────────────────

describe('(2) "Got it" sticks', () => {
    it('Got it -> a Dashboard autosave (stale mirror) -> reopen: the notice stays gone and the converted condition stays', async () => {
        writeDisk(oldWorkspace());
        await mountBoth('raw');
        dropBuildModelBroadcasts(); // Dashboard does not even hear about the dismissal
        await act(async () => { fireEvent.click(bmw().getByTestId('rc-conversion-dismiss')); });
        await settle(30);
        expect(diskFg().runningConditionConversion).toBeNull();
        expect(bmw().queryByTestId('rc-conversion-notice')).toBeNull();

        await dashboardEdit();
        expect(diskFg().runningConditionConversion).toBeNull();
        expect(diskFg().runningConditionFilters).toEqual([KEPT]);

        // Reopen: the read path must not write a new notice (marker null = handled).
        cleanup();
        const reread = await loadWorkspaceData('ws1');
        expect(reread!.failureGroupState!.runningConditionConversion).toBeNull();
        await mountBoth();
        await dashboardEdit();
        expect(bmw().queryByTestId('rc-conversion-notice')).toBeNull();
        expect(diskFg().runningConditionConversion).toBeNull();
        expectNoOldShapeEverWritten();
    });
});

// ─────────────────────────────────────────────────────────────────────────
// (3) the file was edited by an OLDER build after the conversion
// ─────────────────────────────────────────────────────────────────────────

describe('(3) a file an older build wrote again (marker null + the old shape)', () => {
    it('is normalised silently on open: no notice, the marker stays null, Complete models whose rows change go Incomplete with set points kept', async () => {
        writeDisk(oldWorkspace({ runningConditionConversion: null }));
        await mountBoth();
        await dashboardEdit();

        expect(bmw().queryByTestId('rc-conversion-notice')).toBeNull();
        expect(bmw().queryByTestId('rc-card-why')).toBeNull();
        const fg = diskFg();
        expect(fg.runningConditionConversion).toBeNull();
        expect(fg.runningConditionFilters).toEqual([KEPT]);
        expect(fg.runningStatus ?? null).toBeNull();
        expect(diskModel('i1')).toMatchObject({ status: false, healthSetPoints: SET_POINTS });
        expectNoOldShapeEverWritten();
    });
});

// ─────────────────────────────────────────────────────────────────────────
// (4) the export's running_status and the training filter are the SAME row
// ─────────────────────────────────────────────────────────────────────────

describe('(4) after the conversion, export running_status and the training filter use the one condition', () => {
    const ONE_WIRE = [{ sensor: 'TAG2', operation: 'greater_than', value1: 10, value2: null }];

    it('the export request (built from what the read path returns) carries running_status = the kept row, and every Workspace-mode model trains on that same row', async () => {
        writeDisk(oldWorkspace());
        const ws = (await loadWorkspaceData('ws1'))!;
        const req = buildWorkspaceExportRequest({ workspace: ws, metadata: sensorMetadata, headers: HEADERS });
        // NOT the saved export line (TAG1 / 3) of the old file: the one condition.
        expect(req.running_status).toEqual({ sensor: 'TAG2', stop_if_lower_than: 10 });
        const i1 = req.models.find(m => m.id === 'i1')!;
        expect(i1.filter?.value_filters).toEqual(ONE_WIRE);
        expect(i1.filter?.combine).toBe('and');
        expect(trainingScopeFilter(ws.failureGroupState!.models[0], ws.failureGroupState!, HEADERS)).toEqual(i1.filter);
        // The Custom model whose own condition could not be kept has no value filter
        // (it is blocked from training until it is set again, never "all rows" with an old operator).
        const c1 = req.models.find(m => m.id === 'c1')!;
        expect(c1.filter?.value_filters ?? []).toEqual([]);
        // The running-status sensor is listed with the exported sensors' metadata.
        expect(req.sensor_meta.map(s => s.tag)).toContain('TAG2');
    });

    it('a Train in the Build Model window queries Rust with that same one row', async () => {
        writeDisk(oldWorkspace());
        await mountBoth();
        await waitFor(() => expect((bmw().getByTestId('train-sensor') as HTMLButtonElement).disabled).toBe(false));
        h.invokes.length = 0;
        await act(async () => { fireEvent.click(bmw().getByTestId('train-sensor')); });
        await settle(50);
        const stats = h.invokes.filter(c => c.cmd === 'compute_sensor_stats').slice(-1)[0];
        expect(stats?.args?.sensor).toBe('TAG1');
        expect(stats?.args?.filter?.value_filters).toEqual(ONE_WIRE);
        expect(stats?.args?.filter?.combine).toBe('and');
        // The train record now matches the converted condition.
        const i1 = diskModel('i1');
        expect(i1.trainedFingerprint).toBe(computeTrainFingerprint(i1, diskFg()));
    });
});

// ─────────────────────────────────────────────────────────────────────────
// (5) the Custom "needs-set" row of the notice survives a workspace Apply
// ─────────────────────────────────────────────────────────────────────────

describe('(5) a workspace Apply in Build Model, then a Dashboard autosave', () => {
    it('keeps only the Custom model that still needs its own condition in the notice, on disk and on screen', async () => {
        writeDisk(oldWorkspace());
        await mountBoth('raw');
        dropBuildModelBroadcasts();

        fireEvent.click(bmw().getByTestId('rc-conversion-check')); // "Check it" opens the editor
        const one = bmw().getByTestId('rc-one');
        fireEvent.change(within(one).getByLabelText('Running above this value'), { target: { value: '12' } });
        await act(async () => { fireEvent.click(bmw().getByTestId('rc-apply')); });
        await settle(50);

        const rec = () => diskFg().runningConditionConversion;
        expect(diskFg().runningConditionFilters).toEqual([{ ...KEPT, value1: '12' }]);
        expect(rec()).toMatchObject({ result: 'needs-set', after: null, customModels: [{ id: 'c1', result: 'needs-set' }] });

        await dashboardEdit();
        expect(rec()).toMatchObject({ customModels: [{ id: 'c1', result: 'needs-set' }] });
        expect(diskFg().runningConditionFilters).toEqual([{ ...KEPT, value1: '12' }]);
        const n = bmw().getByTestId('rc-conversion-notice');
        expect(n.textContent).toMatch(/Own condition/);
        expect(n.textContent).toMatch(/Speed own/);
        expect(n.textContent).not.toMatch(/Before|Incomplete again/);
    });
});
