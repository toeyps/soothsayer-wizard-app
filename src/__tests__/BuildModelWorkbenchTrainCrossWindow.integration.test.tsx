import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, waitFor, within } from '@testing-library/react';

/*
 * Build Model Workbench Phase B QA (2026-09-29) — Dashboard and the Build
 * Model window side by side against ONE workspace file, checking the two
 * Phase B fields (`lastTrainedAt` / `trainedFingerprint`) and the Workbench's
 * staleness against the class of bug CLAUDE.md documents for Dashboard's
 * `fgGroups`/`fgModels` mirror (a stale mirror overwriting another window's
 * fresher write).
 *
 * Same harness as Feature4CrossWindow.integration.test.tsx: both REAL
 * components mounted at once, the real workspaceManager over an in-memory
 * plugin-fs, one event bus with a switch that DROPS Build Model's broadcasts
 * so Dashboard's mirror goes stale. Dashboard has no running-condition writer
 * of its own (grep: only the mirror + the disk-adopting autosave), so the
 * running-condition case below is "Build Model edits it, Dashboard's stale
 * mirror must not revert it", which is the only way that mirror could make a
 * stale model read as fresh again.
 */

const h = vi.hoisted(() => ({
    listeners: {} as Record<string, Set<(e: any) => void>>,
    files: new Map<string, string>(),
    writes: [] as string[],
    store: new Map<string, unknown>(),
    drop: null as null | ((event: string, payload: any) => boolean),
    invokes: [] as string[],
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
        h.invokes.push(cmd);
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
            <button onClick={() => p.onToggleSensorGroupKind('TAG2', 1, 'individual')}>dash-toggle-tag2-individual-fg1</button>
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
import { computeTrainFingerprint } from '../utils/trainFingerprint';
import type { WorkspaceState } from '../types';

const WS_FILE = 'workspaces/ws1.json';
const sensorMetadata = [
    { tag: 'TAG1', description: 'Pump Pressure', unit: 'bar', component: 'Pump' },
    { tag: 'TAG2', description: 'Pump Temp', unit: 'C', component: 'Pump' },
];
const COND = { id: 'rc1', sensor: 'TAG2', operation: 'greater_than', value1: '10', value2: '' };

/** Dashboard's `makeDefaultModelForKind` shape (individual). */
function dashModel(o: Record<string, unknown>) {
    return {
        id: 'x', groupNos: [1], name: 'QA model', kind: 'individual', category: 'performance', notes: '', status: false,
        targetSensor: 'TAG1', predictorSensors: [], xSensor: '', ySensor: '',
        individualChecked: true, rcMode: null, scatterXSensor: '', relModelName: '', relStiffness: 100_000,
        clusterModelName: '', numClusters: 3, criteriaSensor: '',
        clusterRanges: [{ min: 0, max: 33 }, { min: 33, max: 66 }, { min: 66, max: 100 }],
        filterTimePeriods: [], runningConditionMode: 'workspace', customRunningConditionFilters: [],
        customRunningConditionCombine: 'and', customRunningConditionNoneConfirmed: false,
        ...o,
    };
}

function wsState(fg: Record<string, unknown>): WorkspaceState {
    return {
        id: 'ws1', name: 'QA WS', lastRoute: 'dashboard', dataFilePaths: [], metadataFilePath: null,
        selectedSensors: [], visibleSensors: [], operationConfig: null,
        failureGroupState: {
            groups: [{ no: 0, name: 'Not in Group' }, { no: 1, name: 'FG-A' }],
            runningConditionCombine: 'and', runningConditionTimePeriods: [],
            rcLegacyNotice: null, categoryNormalisationNotice: null,
            ...fg,
        } as any,
    } as WorkspaceState;
}

const writeDisk = (s: unknown) => h.files.set(WS_FILE, JSON.stringify(s));
const readDisk = () => JSON.parse(h.files.get(WS_FILE)!);
const diskModel = (id: string) => readDisk().failureGroupState.models.find((m: any) => m.id === id);
const diskFresh = (id: string) => {
    const fg = readDisk().failureGroupState;
    const m = fg.models.find((x: any) => x.id === id);
    return !!m.lastTrainedAt && m.trainedFingerprint === computeTrainFingerprint(m, fg);
};

async function settle(ms = 0) {
    await act(async () => { await new Promise(r => setTimeout(r, ms)); });
}

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
    await waitFor(() => expect(within(screen.getByTestId('build-model-window')).getByTestId('rc-card')).toBeTruthy());
    await settle(350);
}

const bmw = () => within(screen.getByTestId('build-model-window'));
const pill = () => screen.getByTestId('build-model-window').querySelector('.f4-foot .model-status-pill')!.textContent;
const selectTag1 = () => fireEvent.click(bmw().getByTestId('sensor-list-row-fg:1-tag1'));
const dropBuildModelBroadcasts = () => {
    h.drop = (event, payload) => event === 'failure-group-state-changed' && payload?.origin === 'build-model';
};

async function trainTag1() {
    selectTag1();
    await act(async () => { fireEvent.click(bmw().getByText('▶ Train model')); });
    await settle(30);
    expect(diskFresh('i1')).toBe(true);
    expect(pill()).toBe('Trained');
}

beforeEach(() => {
    for (const k of Object.keys(h.listeners)) delete h.listeners[k];
    h.files.clear();
    h.writes.length = 0;
    h.store.clear();
    h.drop = null;
    h.invokes.length = 0;
});

afterEach(() => {
    cleanup();
});

describe('Workbench training metadata vs. a stale Dashboard mirror', () => {
    const start = () => wsState({
        models: [dashModel({ id: 'i1' })],
        runningConditionFilters: [], runningConditionNoneConfirmed: true,
    });

    for (const lost of [false, true]) {
        it(`Dashboard edits after a Workbench Train keep lastTrainedAt/trainedFingerprint (${lost ? 'broadcast LOST — stale mirror' : 'broadcast delivered'})`, async () => {
            writeDisk(start());
            await mountBoth();
            if (lost) dropBuildModelBroadcasts();
            await trainTag1();
            const { lastTrainedAt, trainedFingerprint } = diskModel('i1');

            // Unrelated Dashboard interaction -> debounced full-state autosave.
            await act(async () => { fireEvent.click(screen.getByText('dash-select-tag1')); });
            await settle(350);
            // Group rename (a Dashboard FG writer) and a new model for the same sensor.
            await act(async () => { fireEvent.click(screen.getByText('dash-rename-fg1')); });
            await settle(20);
            await act(async () => { fireEvent.click(screen.getByText('dash-toggle-tag1-clustering-fg1')); });
            await settle(20);
            await act(async () => { fireEvent.click(screen.getByText('dash-toggle-tag2-individual-fg1')); });
            await settle(350);

            const fg = readDisk().failureGroupState;
            expect(fg.models).toHaveLength(3);
            expect(fg.groups.find((g: any) => g.no === 1).name).toBe('FG-A renamed');
            expect(diskModel('i1').lastTrainedAt).toBe(lastTrainedAt);
            expect(diskModel('i1').trainedFingerprint).toBe(trainedFingerprint);
            expect(diskFresh('i1')).toBe(true);
            // A newly created sibling model starts untrained.
            expect(fg.models.filter((m: any) => m.id !== 'i1').every((m: any) => m.lastTrainedAt === undefined)).toBe(true);

            // The Workbench still shows TAG1's Individual as Trained.
            selectTag1();
            await waitFor(() => expect(pill()).toBe('Trained'));
        });
    }

    it('a workspace running-condition edit made in Build Model after training is not reverted by Dashboard\'s stale mirror, so the model stays stale (never falsely fresh again)', async () => {
        writeDisk(wsState({
            models: [dashModel({ id: 'i1' })],
            runningConditionFilters: [COND], runningConditionNoneConfirmed: false,
        }));
        await mountBoth();
        dropBuildModelBroadcasts(); // Dashboard's mirror keeps COND value '10'
        await trainTag1();

        // Build Model edits the workspace condition through the Edit… modal.
        fireEvent.click(bmw().getByTestId('rc-card-open'));
        const modal = within(bmw().getByRole('dialog', { name: 'Running condition' }));
        await act(async () => { fireEvent.change(modal.getByPlaceholderText('value'), { target: { value: '20' } }); });
        await settle(30);
        await act(async () => { fireEvent.click(modal.getByTestId('rc-apply')); }); // 2026-10-03: edits land only on Apply
        await settle(30);
        expect(readDisk().failureGroupState.runningConditionFilters[0].value1).toBe('20');
        expect(bmw().getByTestId('results-stale')).toBeTruthy();
        expect(pill()).toBe('Incomplete');

        // Dashboard, still holding value '10' in its mirror, autosaves.
        await act(async () => { fireEvent.click(screen.getByText('dash-select-tag1')); });
        await settle(350);
        expect(readDisk().failureGroupState.runningConditionFilters[0].value1).toBe('20');
        expect(diskFresh('i1')).toBe(false);
        expect(bmw().getByTestId('results-stale')).toBeTruthy();

        // Reopen both windows from the file: still stale.
        cleanup();
        h.drop = null;
        await mountBoth();
        selectTag1();
        expect(bmw().getByTestId('results-stale')).toBeTruthy();
        expect(bmw().getByText('↻ Re-train')).toBeTruthy();
    });

    it('a running-condition change broadcast by ANOTHER window reaches the Workbench\'s fingerprint immediately (no stale in-memory condition)', async () => {
        writeDisk(start());
        await mountBoth();
        await trainTag1();
        // Another window (the PM page's parent-of-record, or any writer) switches
        // the workspace to a real condition and broadcasts it with origin dashboard.
        const { updateWorkspaceData } = await import('../workspaceManager');
        const { withFailureGroupState } = await import('../utils/failureGroupState');
        const { emit } = await import('@tauri-apps/api/event');
        await act(async () => {
            const next = await updateWorkspaceData('ws1', prev => withFailureGroupState(prev, { runningConditionNoneConfirmed: false, runningConditionFilters: [COND as any] }));
            await emit('failure-group-state-changed', { ...next!.failureGroupState, workspaceId: 'ws1', origin: 'dashboard' });
        });
        await settle(20);
        expect(bmw().getByTestId('results-stale')).toBeTruthy();
        expect((bmw().getByTestId('page-health') as HTMLButtonElement).disabled).toBe(true); // Mark complete is only reachable from the Health score page
    });
});
