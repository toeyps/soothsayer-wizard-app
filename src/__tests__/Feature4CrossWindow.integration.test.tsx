import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, waitFor, within } from '@testing-library/react';

/*
 * Feature 4 QA (2026-09-24) — Dashboard and the Build Model window running
 * side by side against ONE workspace file.
 *
 * Both real components are mounted at once (they are separate OS windows in
 * the app), sharing:
 *   - the real workspaceManager over an in-memory plugin-fs (JSON round trips);
 *   - one event bus that delivers every emit to every listener (Tauri's global
 *     broadcast), with a switch to DROP broadcasts so a stale Dashboard mirror
 *     can be reproduced — `failure-group-state-changed` is best-effort IPC.
 * Dashboard answers the Build Model window's `request-build-model-data` for
 * real. Dashboard's own heavy children (charts, panels) are stubbed with
 * buttons that call the same props the real panels call.
 *
 * Caveat: in the app each window has its OWN workspaceManager write queue; here
 * they share one, so this file cannot reproduce two writes interleaving
 * mid-flight — only stale-mirror/ordering problems.
 */

const h = vi.hoisted(() => ({
    listeners: {} as Record<string, Set<(e: any) => void>>,
    files: new Map<string, string>(),
    writes: [] as string[],
    store: new Map<string, unknown>(),
    /** Return true to drop a delivery (the listener never sees it). */
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
    writeTextFile: async (p: string, c: string) => { h.files.set(p, c); h.writes.push(p); },
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

vi.mock('@tauri-apps/api/core', () => ({
    invoke: (cmd: string) => {
        if (cmd === 'get_dataset_time_bounds') return Promise.resolve({ min: null, max: null });
        if (cmd === 'compute_sensor_stats') return Promise.resolve({ mean: 5, sd: 1, min: 0, max: 10, count: 100, lower1: 4, upper1: 6, lower3: 2, upper3: 8 });
        return Promise.resolve(undefined);
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
            <button onClick={() => p.onToggleSensorGroupKind('TAG1', 1, 'clustering')}>dash-toggle-tag1-clustering-fg1</button>
            <button onClick={() => p.onToggleSensorGroupKind('TAG1', 2, 'individual')}>dash-toggle-tag1-individual-fg2</button>
            <button onClick={() => p.onRenameGroup(1, 'FG-A renamed')}>dash-rename-fg1</button>
        </div>
    ),
}));
// Not visible on the default (Sensor) tab; renaming goes through the Sensor tab's own rename prop.
vi.mock('../components/dashboard/FailureGroupsPanel', () => ({ default: () => <div data-testid="dash-fg-panel" /> }));
vi.mock('../hooks/useChartData', () => ({ useChartData: () => ({ view: null, loading: false, error: null }) }));
vi.mock('../hooks/useScatterSample', () => ({
    useScatterSample: () => ({ rows: [], headers: [], total: 0, sampled: 0, loading: false, error: null }),
}));
vi.mock('../components/charts/LineChart', () => ({ default: () => <div /> }));
vi.mock('../components/charts/ResponsiveECharts', () => ({ default: () => <div /> }));

import Dashboard from '../components/dashboard/Dashboard';
import BuildModelWindow from '../components/windows/BuildModelWindow';
import type { WorkspaceState } from '../types';

// ── fixtures ────────────────────────────────────────────────────────────

const WS_FILE = 'workspaces/ws1.json';
const LEGACY_KEYS = ['runningConditionTimeStart', 'runningConditionTimeEnd', 'filterTimeStart', 'filterTimeEnd'];
const sensorMetadata = [
    { tag: 'TAG1', description: 'Pump Pressure', unit: 'bar', component: 'Pump' },
    { tag: 'TAG2', description: 'Pump Temp', unit: 'C', component: 'Pump' },
];

function baseModel(o: Record<string, unknown>) {
    return {
        id: 'x', groupNos: [1], name: 'QA model', kind: 'individual', category: 'performance', notes: '', status: false,
        targetSensor: 'TAG1', predictorSensors: [], xSensor: '', ySensor: '',
        individualChecked: true, rcMode: null, scatterXSensor: '', relModelName: '', relStiffness: 100_000,
        clusterModelName: '', numClusters: 3, criteriaSensor: '', clusterRanges: [],
        runningConditionMode: 'workspace', customRunningConditionFilters: [], customRunningConditionCombine: 'and',
        ...o,
    };
}
const model = (o: Record<string, unknown>) => ({ filterTimePeriods: [], customRunningConditionNoneConfirmed: false, ...baseModel(o) });
const v1Model = (o: Record<string, unknown>) => ({ filterTimeStart: '', filterTimeEnd: '', ...baseModel(o) });

function wsState(fg: Record<string, unknown>): WorkspaceState {
    return {
        id: 'ws1', name: 'QA WS', lastRoute: 'dashboard', dataFilePaths: [], metadataFilePath: null,
        selectedSensors: [], visibleSensors: [], operationConfig: null,
        failureGroupState: { groups: [{ no: 0, name: 'Not in Group' }, { no: 1, name: 'FG-A' }, { no: 2, name: 'FG-B' }], ...fg } as any,
    } as WorkspaceState;
}

const writeDisk = (s: unknown) => h.files.set(WS_FILE, JSON.stringify(s));
const readDisk = () => JSON.parse(h.files.get(WS_FILE)!);
const diskModels = () => readDisk().failureGroupState.models as any[];

async function settle(ms = 0) {
    await act(async () => { await new Promise(r => setTimeout(r, ms)); });
}

/** Both windows up; the Build Model window hydrated through Dashboard's reply. */
async function mountBoth() {
    render(
        <>
            <div data-testid="dashboard-window">
                <Dashboard
                    metadata={{ headers: ['timestamp', 'TAG1', 'TAG2'], total_rows: 100 }}
                    sensorMetadata={sensorMetadata}
                    onBack={vi.fn()}
                    initialState={readDisk()}
                />
            </div>
            <div data-testid="build-model-window"><BuildModelWindow /></div>
        </>,
    );
    await waitFor(() => expect(screen.queryByText('Running Condition Filter')).toBeTruthy());
    await settle(350); // hydration write-back + Dashboard's on-mount autosave
}

const bmw = () => within(screen.getByTestId('build-model-window'));
/** Dashboard's mirror stops hearing the Build Model window (lost IPC). */
const dropBuildModelBroadcasts = () => {
    h.drop = (event, payload) => event === 'failure-group-state-changed' && payload?.origin === 'build-model';
};

beforeEach(() => {
    for (const k of Object.keys(h.listeners)) delete h.listeners[k];
    h.files.clear();
    h.writes.length = 0;
    h.store.clear();
    h.drop = null;
});

afterEach(() => {
    cleanup();
});

// ─────────────────────────────────────────────────────────────────────────
// (5) category changed in Build Model, then a Dashboard toggle
// ─────────────────────────────────────────────────────────────────────────

describe('(5) a sensor category set in Build Model survives Dashboard edits', () => {
    const start = () => wsState({
        models: [model({ id: 'i1' }), model({ id: 'r1', kind: 'relationship', predictorSensors: ['TAG2'] })],
        runningConditionFilters: [], runningConditionCombine: 'and', runningConditionTimePeriods: [],
        runningConditionNoneConfirmed: true, rcLegacyNotice: null, categoryNormalisationNotice: null,
    });

    async function setTag1ToCondition() {
        const row = bmw().getByTestId('sensor-row-fg:1:tag1');
        await act(async () => { fireEvent.click(within(row).getByText('Condition')); });
        await settle(20);
        expect(diskModels().map(m => m.category)).toEqual(['condition', 'condition']);
    }

    for (const lost of [false, true]) {
        it(`${lost ? 'even with the broadcast LOST (stale Dashboard mirror)' : 'with the broadcast delivered'}: toggles keep it, new models inherit it, and the autosave does not revert it`, async () => {
            writeDisk(start());
            await mountBoth();
            if (lost) dropBuildModelBroadcasts();
            await setTag1ToCondition();

            // A new Clustering model keyed by TAG1 (X) and an extra FG for the Individual.
            await act(async () => { fireEvent.click(screen.getByText('dash-toggle-tag1-clustering-fg1')); });
            await settle(20);
            await act(async () => { fireEvent.click(screen.getByText('dash-toggle-tag1-individual-fg2')); });
            await settle(20);
            let models = diskModels();
            expect(models).toHaveLength(3);
            expect(models.map(m => [m.id === 'i1' || m.id === 'r1' ? m.id : m.kind, m.category])).toEqual([
                ['i1', 'condition'], ['r1', 'condition'], ['clustering', 'condition'],
            ]);
            expect(models.find(m => m.id === 'i1').groupNos).toEqual([1, 2]);
            expect(models.find(m => m.kind === 'clustering').filterTimePeriods).toEqual([]);

            // An unrelated Dashboard edit -> debounced full-state autosave.
            await act(async () => { fireEvent.click(screen.getByText('dash-select-tag1')); });
            await settle(350);
            models = diskModels();
            expect(models.every(m => m.category === 'condition')).toBe(true);

            // The Build Model window shows one category for the sensor, no Mixed.
            await waitFor(() => expect(within(bmw().getByTestId('sensor-row-fg:1:tag1')).getByText('Condition').getAttribute('aria-pressed')).toBe('true'));
        });
    }

    // FIXED 2026-09-24 (was a known bug). Phase 0 moved the
    // toggle / create-group / delete-model writers to "compute on disk", but
    // renameGroup / updateGroupDetails / createEmptyGroup / deleteGroup still
    // call `persistFailureGroupState(groups, fgModels)`, which writes the
    // Dashboard MIRROR's whole models array over disk. With a stale mirror
    // (lost broadcast) that reverts another window's model edits — here the
    // sensor category. The one-time normalisation will not repair it either:
    // its notice is already set, so it never re-runs.
    it('renaming a group on the Dashboard with a stale mirror keeps the category Build Model set', async () => {
        writeDisk(start());
        await mountBoth();
        dropBuildModelBroadcasts();
        await setTag1ToCondition();
        await act(async () => { fireEvent.click(screen.getByText('dash-rename-fg1')); });
        await settle(20);
        expect(readDisk().failureGroupState.groups.find((g: any) => g.no === 1).name).toBe('FG-A renamed');
        expect(diskModels().map(m => m.category)).toEqual(['condition', 'condition']);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// (4) a stale Dashboard mirror holding the OLD time keys
// ─────────────────────────────────────────────────────────────────────────

describe('(4) Dashboard opened on the v1 file, Build Model migrates it underneath', () => {
    const V1 = () => wsState({
        models: [
            v1Model({ id: 'i1' }),
            v1Model({ id: 'i2', targetSensor: 'TAG2', runningConditionMode: 'custom', filterTimeStart: '2026-03-01T00:00', filterTimeEnd: '2026-03-31T23:59' }),
        ],
        runningConditionFilters: [], runningConditionCombine: 'and',
        runningConditionTimeStart: '2026-01-01T00:00', runningConditionTimeEnd: '2026-06-30T23:59',
    });
    const WS_PERIOD = [{ id: 'legacy-1', start: '2026-01-01T00:00', end: '2026-06-30T23:59' }];
    const I2_PERIOD = [{ id: 'legacy-1', start: '2026-03-01T00:00', end: '2026-03-31T23:59' }];

    for (const lost of [false, true]) {
        it(`Dashboard's autosave never writes the old keys back (${lost ? 'broadcast lost' : 'broadcast delivered'})`, async () => {
            writeDisk(V1());
            if (lost) dropBuildModelBroadcasts();
            await mountBoth(); // Dashboard's initialState/mirror = the v1 slice with the old keys
            const fg0 = readDisk().failureGroupState;
            expect(fg0.runningConditionTimePeriods).toEqual(WS_PERIOD);

            await act(async () => { fireEvent.click(screen.getByText('dash-select-tag1')); });
            await settle(350);
            const raw = h.files.get(WS_FILE)!;
            for (const k of LEGACY_KEYS) expect(raw).not.toContain(`"${k}"`);
            const fg = JSON.parse(raw).failureGroupState;
            expect(fg.runningConditionTimePeriods).toEqual(WS_PERIOD);
            expect(fg.models.find((m: any) => m.id === 'i2').filterTimePeriods).toEqual(I2_PERIOD);
            expect(fg.rcLegacyNotice).toBe('pending');
        });
    }

    it('a stale-mirror group edit (broadcast lost) no longer puts the old model keys back: it renames the group and leaves the migrated models untouched', async () => {
        writeDisk(V1());
        dropBuildModelBroadcasts();
        await mountBoth();
        await act(async () => { fireEvent.click(screen.getByText('dash-rename-fg1')); });
        await settle(20);
        // FIXED 2026-09-24: rename is computed against DISK, so the mirror's
        // (v1, old-keys) models are never written over the migrated ones.
        const raw = h.files.get(WS_FILE)!;
        for (const k of LEGACY_KEYS) expect(raw).not.toContain(`"${k}"`);
        const fg = JSON.parse(raw).failureGroupState;
        expect(fg.groups.find((g: any) => g.no === 1).name).toBe('FG-A renamed');
        expect(fg.runningConditionTimePeriods).toEqual(WS_PERIOD);
        expect(fg.models.find((m: any) => m.id === 'i2').filterTimePeriods).toEqual(I2_PERIOD);
    });
});

describe('a brand-new workspace: the first model is created on the Dashboard', () => {
    it('Dashboard seeds the legacy markers, so the Build Model window never shows the legacy banner', async () => {
        writeDisk(wsState({ models: [] }));
        await mountBoth();
        await act(async () => { fireEvent.click(screen.getByText('dash-toggle-tag1-individual-fg2')); });
        await settle(350);
        const fg = readDisk().failureGroupState;
        expect(fg.models).toHaveLength(1);
        expect(fg.rcLegacyNotice).toBeNull();
        expect(fg.categoryNormalisationNotice).toBeNull();
        expect(screen.queryByTestId('rc-legacy-banner')).toBeNull();
    });
});
