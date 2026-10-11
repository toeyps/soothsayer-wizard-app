import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, waitFor, within } from '@testing-library/react';

/*
 * Three features of the Build
 * Model Workbench:
 *   (1) Custom running-condition editor — DRAFT field, committed by Save/Train;
 *   (2) Relationship X-axis switcher — IMMEDIATE `scatterXSensor` write;
 *   (3) Clustering cluster-range slider + its new `compute_sensor_stats` fetch.
 *
 * Unit tests in BuildModelWindow.test.tsx mock the sensor pickers
 * and feed data straight into state. Everything here is
 * REAL except the Tauri boundary — same harness as
 * BuildModelWorkbenchTrainCrossWindow.integration.test.tsx: Dashboard and
 * BuildModelWindow mounted side by side on ONE workspace file (real
 * workspaceManager over an in-memory plugin-fs, one event bus with a switch
 * that DROPS Build Model's broadcasts so Dashboard's mirror goes stale).
 *
 * Bugs are recorded as `it.fails` (repo convention) — each one says what the
 * correct behaviour is, so it flips to a plain failure the moment it's fixed.
 */

const h = vi.hoisted(() => ({
    listeners: {} as Record<string, Set<(e: any) => void>>,
    files: new Map<string, string>(),
    writes: [] as string[],
    store: new Map<string, unknown>(),
    drop: null as null | ((event: string, payload: any) => boolean),
    invokes: [] as { cmd: string; args: any }[],
    /** Per-sensor `compute_sensor_stats` result. */
    stats: {} as Record<string, unknown>,
    /** Per-sensor hold: a `compute_sensor_stats` call for that sensor waits on it. */
    holds: {} as Record<string, Promise<void> | undefined>,
    releasers: [] as (() => void)[],
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
    // Workspace saves go to a temp sibling and are renamed over the real file
    // (workspaceManager.writeWorkspaceJsonAtomically): record the write when it LANDS.
    writeTextFile: async (p: string, c: string) => { h.files.set(p, c); if (!p.endsWith('.tmp')) h.writes.push(p); },
    rename: async (from: string, to: string) => { h.files.set(to, h.files.get(from)!); h.files.delete(from); h.writes.push(to); },
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

const DEFAULT_STATS = { mean: 5, sd: 1, min: 0, max: 10, count: 100, lower1: 4, upper1: 6, lower3: 2, upper3: 8 };
vi.mock('@tauri-apps/api/core', () => ({
    invoke: async (cmd: string, args?: any) => {
        h.invokes.push({ cmd, args: JSON.parse(JSON.stringify(args ?? null)) });
        switch (cmd) {
            case 'get_dataset_time_bounds': return { min: '2026-01-01T00:00:00', max: '2026-12-31T23:59:00' };
            case 'compute_sensor_stats': {
                const hold = h.holds[args?.sensor];
                if (hold) await hold;
                return h.stats[args?.sensor] ?? DEFAULT_STATS;
            }
            case 'preview_relationship_model': return {
                request: 'r', error: undefined, n_rows: 3, predicted: [1, 2, 3],
                r2_per_step: [0.9], rmse2_per_step: [0.1], target_raw: [1, 2, 3],
                // One column per predictor, so the X-axis switcher has a real
                // second column to plot.
                predictor_raw: [[1, 10], [2, 20], [3, 30]],
            };
            case 'compute_clustering_preview': return {
                first_sensor: 'TAG1', second_sensor: 'TAG3', criteria_sensor: null, cluster_count: 1, n_rows: 3,
                clusters: [{ cluster_id: 1, range: null, n_rows: 3, ellipse: { x_center: 1, y_center: 1, x_sd: 1, y_sd: 1, angle_deg: 0 }, xs: [1, 2, 3], ys: [1, 2, 3] }],
            };
            case 'compute_health_preview': return makeHealthPreview(args?.request);
            default: return undefined;
        }
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
// Exposes the Relationship chart's X-axis name so the switcher's effect on
// the actual chart option is observable.
vi.mock('../components/charts/ResponsiveECharts', () => ({
    default: (p: any) => <div data-testid="echarts-mock" data-x-axis-name={p.option?.xAxis?.name ?? ''} />,
}));

import Dashboard from '../components/dashboard/Dashboard';
import BuildModelWindow from '../components/windows/BuildModelWindow';
import { makeHealthPreview } from './helpers/healthPreviewFixture';
import { emit } from '@tauri-apps/api/event';
import { updateWorkspaceData } from '../workspaceManager';
import { withFailureGroupState } from '../utils/failureGroupState';
import { computeTrainFingerprint } from '../utils/trainFingerprint';
import type { WorkspaceState } from '../types';
// Train/Test validation: train period required to Train, test period to Mark complete.
import { ALL_TIME_TRAIN, ONE_TEST } from './helpers/trainTestFixture';
import { findPickerRow, pickSingle, pickerSearch, rowTag } from './helpers/sensorPicker';

// ── fixtures ────────────────────────────────────────────────────────────

const WS_FILE = 'workspaces/ws1.json';
const HEADERS = ['TAG1', 'TAG2', 'TAG3'];
const sensorMetadata = [
    { tag: 'TAG1', description: 'Pump Pressure', unit: 'bar', component: 'Pump' },
    { tag: 'TAG2', description: 'Pump Temp', unit: 'C', component: 'Pump' },
    { tag: 'TAG3', description: 'Motor Current', unit: 'A', component: 'Motor' },
];
const BUILD_DATA = {
    workspaceId: 'ws1',
    sensorHeaders: HEADERS,
    sensorMetadata,
    metadata: { headers: ['timestamp', ...HEADERS], total_rows: 100 },
};

/** Dashboard's `makeDefaultModelForKind` shape (3 default 0-100 cluster
 *  ranges, `targetSensor: ''` + X = tag for clustering). */
function dashModel(o: Record<string, unknown> & { kind?: string; tag?: string }) {
    const { tag = 'TAG1', kind = 'individual', ...rest } = o;
    return {
        id: 'x', groupNos: [1], name: 'QA model', kind, category: 'performance', notes: '', status: false,
        targetSensor: kind === 'clustering' ? '' : tag, predictorSensors: [],
        xSensor: kind === 'clustering' ? tag : '', ySensor: '',
        individualChecked: true, rcMode: null, scatterXSensor: '', relModelName: '', relStiffness: 100_000,
        clusterModelName: '', numClusters: 3, criteriaSensor: '',
        clusterRanges: [{ min: 0, max: 33 }, { min: 33, max: 66 }, { min: 66, max: 100 }],
        filterTimePeriods: [], runningConditionMode: 'workspace', customRunningConditionFilters: [],
        customRunningConditionCombine: 'and', customRunningConditionNoneConfirmed: false,
        ...rest,
    };
}

/** Current-shape, CONFIGURED workspace ("No condition" confirmed) — raises no
 *  migration write-back and never auto-opens the Running Condition modal. */
function wsState(models: unknown[], extra: Record<string, unknown> = {}): WorkspaceState {
    return {
        id: 'ws1', name: 'QA WS', lastRoute: 'dashboard', dataFilePaths: [], metadataFilePath: null,
        selectedSensors: [], visibleSensors: [], operationConfig: null,
        failureGroupState: {
            groups: [{ no: 0, name: 'Not in Group' }, { no: 1, name: 'FG-A' }],
            models, runningConditionFilters: [], runningConditionCombine: 'and', runningConditionTimePeriods: ALL_TIME_TRAIN, runningConditionTestPeriods: ONE_TEST,
            runningConditionNoneConfirmed: true, rcLegacyNotice: null, categoryNormalisationNotice: null,
            ...extra,
        } as any,
    } as WorkspaceState;
}

const REL = () => dashModel({ id: 'r1', kind: 'relationship', tag: 'TAG1', predictorSensors: ['TAG2', 'TAG3'] });

const writeDisk = (s: unknown) => h.files.set(WS_FILE, JSON.stringify(s));
const readDisk = () => JSON.parse(h.files.get(WS_FILE)!);
const diskModel = (id: string) => readDisk().failureGroupState.models.find((m: any) => m.id === id);
const diskFresh = (id: string) => {
    const fg = readDisk().failureGroupState;
    const m = fg.models.find((x: any) => x.id === id);
    return !!m.lastTrainedAt && m.trainedFingerprint === computeTrainFingerprint(m, fg);
};
const statsCalls = (sensor: string) => h.invokes.filter(c => c.cmd === 'compute_sensor_stats' && c.args?.sensor === sensor);

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    h.releasers.push(resolve);
    return { promise, resolve };
}

async function settle(ms = 0) {
    await act(async () => { await new Promise(r => setTimeout(r, ms)); });
}

/** Waits until the Dashboard's debounced autosave has written `selectedSensors`. */
async function dashSelectTag1Saved() {
    await act(async () => { fireEvent.click(screen.getByText('dash-select-tag1')); });
    await waitFor(() => expect(readDisk().selectedSensors).toEqual(['TAG1']), { timeout: 3000 });
}
async function dashRenameFg1Saved() {
    await act(async () => { fireEvent.click(screen.getByText('dash-rename-fg1')); });
    await waitFor(() => expect(readDisk().failureGroupState.groups.find((g: any) => g.no === 1).name).toBe('FG-A renamed'), { timeout: 3000 });
}
async function dashToggleTag2Saved() {
    await act(async () => { fireEvent.click(screen.getByText('dash-toggle-tag2-individual-fg1')); });
    await waitFor(() => expect(readDisk().failureGroupState.models.some((m: any) => m.targetSensor === 'TAG2' && m.kind === 'individual')).toBe(true), { timeout: 3000 });
}

async function mountBuildModel() {
    render(<div data-testid="build-model-window"><BuildModelWindow /></div>);
    await waitFor(() => expect(screen.getByTestId('rc-card')).toBeTruthy());
    await settle(30);
}

async function mountBoth() {
    render(
        <>
            <div data-testid="dashboard-window">
                <Dashboard
                    metadata={{ headers: ['timestamp', ...HEADERS], total_rows: 100 }}
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
const bmwEl = () => screen.getByTestId('build-model-window');
const pill = () => bmwEl().querySelector('.f4-foot .model-status-pill')!.textContent;
// The Fit chart card's X-axis name. The charts come from the (debounced) health preview, so read it with waitFor.
const echartsX = () => within(bmw().getByTestId('chart-card-fit')).getByTestId('echarts-mock').getAttribute('data-x-axis-name');
const dropBuildModelBroadcasts = () => {
    h.drop = (event, payload) => event === 'failure-group-state-changed' && payload?.origin === 'build-model';
};
const selectRow = (tag: string) => fireEvent.click(bmw().getByTestId(`sensor-list-row-fg:1-${tag.toLowerCase()}`));

function openSettings() {
    if (!bmw().queryByTestId('add-model-form')) fireEvent.click(bmw().getByText('Model settings', { selector: 'b' }));
}

async function clickTrain() {
    await act(async () => { fireEvent.click(bmw().getByTestId('train-sensor')); });
    await settle(30);
}

async function clickSave() {
    await act(async () => { fireEvent.click(bmw().getByText('Save changes')); });
    await settle(30);
}

/** Drive the REAL compact single picker of the Relationship X-axis switcher. */
async function pickXAxis(tag: string) {
    await waitFor(() => expect(bmwEl().querySelector('[data-testid="fit-x-selector"]')).toBeTruthy());
    const wrap = bmwEl().querySelector('[data-testid="fit-x-selector"]') as HTMLElement;
    const trigger = within(wrap).getByRole('button', { name: 'X sensor' });
    pickSingle(trigger, tag);
    await act(async () => { await Promise.resolve(); });
    await settle(30);
}

/** Drive the REAL shared single picker for a field whose trigger currently shows `triggerText`. */
async function pickSingleSensor(triggerText: string, tag: string) {
    const trigger = bmw().getByText(triggerText).closest('button')!;
    pickSingle(trigger, tag);
    await act(async () => { await Promise.resolve(); });
    await settle(30);
}

// These cross-window flows wait on the disk (waitFor), not fixed sleeps; a whole
// train -> complete -> edit flow can exceed the 5 s default when the full suite
// runs in parallel, so the per-test budget is larger here.
vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => {
    for (const k of Object.keys(h.listeners)) delete h.listeners[k];
    h.files.clear();
    h.writes.length = 0;
    h.store.clear();
    h.drop = null;
    h.invokes.length = 0;
    h.stats = {};
    h.holds = {};
    h.releasers.length = 0;
    h.listeners['request-build-model-data'] = new Set([() => { void emit('build-model-data', BUILD_DATA); }]);
});

afterEach(() => {
    for (const r of h.releasers) r();
    cleanup();
});

// ─────────────────────────────────────────────────────────────────────────
// (1) Cross-window: the newly-editable fields vs. Dashboard's (possibly stale)
//     mirror. Dashboard's FG writers derive from DISK and its autosave adopts
//     the whole on-disk slice — these tests pin
//     that the two NEW write paths are covered by that, too.
// ─────────────────────────────────────────────────────────────────────────

describe('(1) the X-axis switcher\'s IMMEDIATE scatterXSensor write vs. Dashboard\'s mirror', () => {
    for (const lost of [false, true]) {
        it(`scatterXSensor survives Dashboard autosave / FG rename / new model (${lost ? 'broadcast LOST — stale mirror' : 'broadcast delivered'}) and reopens on the chosen axis`, async () => {
            // Two same-named models of different sensors can't collide, but the
            // Dashboard toggle below creates a TAG2 Individual — give it room.
            writeDisk(wsState([REL()]));
            await mountBoth();
            if (lost) dropBuildModelBroadcasts();

            await clickTrain();
            expect(diskFresh('r1')).toBe(true);
            await waitFor(() => expect(echartsX()).toBe('TAG2')); // first fitted predictor by default

            await pickXAxis('TAG3');
            expect(diskModel('r1').scatterXSensor).toBe('TAG3');
            await waitFor(() => expect(echartsX()).toBe('TAG3'));
            // A view choice, not a fit input: no staleness, no draft created.
            expect(pill()).toBe('Trained');
            expect(bmw().queryByTestId('save-changes')).toBeNull();
            expect(diskFresh('r1')).toBe(true);

            // Dashboard, whose mirror (in the lost case) still has scatterXSensor ''.
            await dashSelectTag1Saved();
            await dashRenameFg1Saved();
            await dashToggleTag2Saved();

            expect(readDisk().failureGroupState.models).toHaveLength(2);
            expect(diskModel('r1').scatterXSensor).toBe('TAG3');
            expect(diskFresh('r1')).toBe(true);
            // Dashboard's own broadcasts reached Build Model; the chart kept the axis.
            selectRow('TAG1');
            await waitFor(() => expect(echartsX()).toBe('TAG3'));

            // Reopen both windows from the file: auto-recompute lands on TAG3.
            cleanup();
            h.drop = null;
            await mountBoth();
            selectRow('TAG1');
            await waitFor(() => expect(echartsX()).toBe('TAG3'));
        });
    }
});

describe('(1) a Custom running condition saved from the Workbench vs. Dashboard\'s mirror', () => {
    for (const lost of [false, true]) {
        it(`a Dashboard write landing MID-EDIT keeps the unsaved draft, and the saved condition survives later Dashboard writes (${lost ? 'broadcast LOST' : 'broadcast delivered'})`, async () => {
            writeDisk(wsState([dashModel({ id: 'i1' })]));
            await mountBoth();
            if (lost) dropBuildModelBroadcasts();

            openSettings();
            fireEvent.click(bmw().getByRole('button', { name: 'Custom' }));
            fireEvent.click(bmw().getByTestId('rc-add-condition'));
            fireEvent.change(bmw().getByPlaceholderText('value'), { target: { value: '42' } });

            // Dashboard writes (and broadcasts, origin 'dashboard') while the
            // Custom editor has unsaved edits — `applyFg` must not wipe drafts.
            await act(async () => { fireEvent.click(screen.getByText('dash-rename-fg1')); });
            await settle(30);
            expect((bmw().getByPlaceholderText('value') as HTMLInputElement).value).toBe('42');
            expect(bmw().getByTestId('footer-status').textContent).toMatch(/Unsaved changes/);
            expect(diskModel('i1').runningConditionMode).toBe('workspace'); // not committed by the broadcast

            await clickSave();
            expect(diskModel('i1').runningConditionMode).toBe('custom');
            expect(diskModel('i1').customRunningConditionFilters).toEqual([expect.objectContaining({ sensor: 'TAG1', operation: 'greater_than', value1: '42' })]);

            // Dashboard autosave + a disk-derived FG write afterwards.
            await dashSelectTag1Saved();
            await dashToggleTag2Saved();
            expect(readDisk().failureGroupState.groups.find((g: any) => g.no === 1).name).toBe('FG-A renamed');
            expect(diskModel('i1').runningConditionMode).toBe('custom');
            expect(diskModel('i1').customRunningConditionFilters).toHaveLength(1);
            expect(diskModel('i1').customRunningConditionFilters[0].value1).toBe('42');
        });
    }
});

// ─────────────────────────────────────────────────────────────────────────
// (2) Custom condition + period edited live, SAVED, window closed, reopened,
//     THEN trained separately — the (6) tests in
//     BuildModelWorkbenchTrain.integration.test.tsx only cover
//     edit-then-Train-in-one-go (commit inside trainForQueue).
// ─────────────────────────────────────────────────────────────────────────

describe('(2) Custom condition/period: Save changes -> close -> reopen -> Train separately', () => {
    it('the reopened model trains against the saved condition AND period, and the editor is not re-seeded', async () => {
        writeDisk(wsState([dashModel({ id: 'i1' })], {
            // A workspace condition exists, so switching to Custom seeds from it —
            // the reopened model must NOT re-seed on top of its own saved list.
            runningConditionNoneConfirmed: false,
            runningConditionFilters: [{ id: 'ws-c', sensor: 'TAG3', operation: 'less_than', value1: '7', value2: '' }],
            // No workspace train period: the Custom model gets its own below.
            runningConditionTimePeriods: [],
        }));
        await mountBuildModel();
        openSettings();
        fireEvent.click(bmw().getByRole('button', { name: 'Custom' }));
        expect(bmw().getByTestId('pm-seed-note')).toBeTruthy();
        // Edit the seeded row instead of keeping the workspace copy.
        fireEvent.change(bmw().getByPlaceholderText('value'), { target: { value: '42' } });
        fireEvent.click(bmw().getByLabelText('Greater than'));

        // A period typed live: Add (defaults from the dataset bounds, row
        // auto-expands in compact mode), then type a new end and blur.
        const periods = within(bmw().getByTestId('custom-periods'));
        fireEvent.click(periods.getByTestId('period-add'));
        const end = periods.getByLabelText('P1 end') as HTMLInputElement;
        fireEvent.change(end, { target: { value: '2026-03-15T12:00' } });
        fireEvent.blur(end);

        await clickSave();
        const saved = diskModel('i1');
        expect(saved.runningConditionMode).toBe('custom');
        expect(saved.customRunningConditionFilters).toEqual([expect.objectContaining({ sensor: 'TAG3', operation: 'greater_than', value1: '42' })]);
        expect(saved.filterTimePeriods).toHaveLength(1);
        expect(saved.filterTimePeriods[0].end).toBe('2026-03-15T12:00');
        expect(saved.lastTrainedAt).toBeUndefined(); // saved, never trained

        // Close without training, reopen from the file.
        cleanup();
        h.invokes.length = 0;
        await mountBuildModel();
        // never trained -> no auto-recompute (no chart; the only stats queries are the Step-1 card's row count)
        expect(bmw().queryByTestId('results-chart')).toBeNull();
        openSettings();
        // Custom already has its own rows — no re-seed, no seed note, the saved value.
        expect(bmw().queryByTestId('pm-seed-note')).toBeNull();
        expect((bmw().getByPlaceholderText('value') as HTMLInputElement).value).toBe('42');

        await clickTrain();
        // Train's query is the last FILTERED one: the row counts (Step-1 card, and since
        // the active Custom model's own count for the train-days note) also
        // query this sensor, the unfiltered "total" possibly after Train (debounced).
        const call = statsCalls('TAG1').filter(c => c.args?.filter).slice(-1)[0];
        expect(call?.args?.filter?.value_filters).toEqual([{ sensor: 'TAG3', operation: 'greater_than', value1: 42, value2: null }]);
        expect(call?.args?.filter?.timestamp_ranges).toHaveLength(1);
        expect(call?.args?.filter?.timestamp_ranges[0].end).toBe('2026-03-15T12:00');
        expect(diskFresh('i1')).toBe(true);
        expect(pill()).toBe('Trained');
    });
});

// ─────────────────────────────────────────────────────────────────────────
// (3) The two draft flows side by side: X-axis (immediate) vs. everything
//     else (draft until Save).
// ─────────────────────────────────────────────────────────────────────────

describe('(3) immediate X-axis write and the pending draft do not cross-contaminate', () => {
    it('changing the X-axis while a name edit is unsaved writes ONLY scatterXSensor; the draft stays pending and Save later keeps the new axis', async () => {
        writeDisk(wsState([REL()]));
        await mountBuildModel();
        await clickTrain();

        openSettings();
        fireEvent.change(bmw().getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Renamed rel' } });
        expect(bmw().getByTestId('footer-status').textContent).toMatch(/Unsaved changes/);

        await pickXAxis('TAG3');
        // The immediate write did not commit the pending draft …
        expect(diskModel('r1').scatterXSensor).toBe('TAG3');
        expect(diskModel('r1').name).toBe('QA model');
        // … and did not discard it either.
        expect((bmw().getByPlaceholderText('e.g. Bearing vibration model') as HTMLInputElement).value).toBe('Renamed rel');
        expect(bmw().getByTestId('footer-status').textContent).toMatch(/Unsaved changes/);
        expect(pill()).toBe('Trained');

        await clickSave();
        expect(diskModel('r1').name).toBe('Renamed rel');
        expect(diskModel('r1').scatterXSensor).toBe('TAG3');
        expect(diskFresh('r1')).toBe(true);
        await waitFor(() => expect(echartsX()).toBe('TAG3'));
    });

    it('a fingerprinted draft edit made AFTER an X-axis change (stiffness) saves without reverting the axis, and re-training keeps it', async () => {
        writeDisk(wsState([REL()]));
        await mountBuildModel();
        await clickTrain();
        await pickXAxis('TAG3');

        openSettings();
        fireEvent.click(bmw().getByRole('button', { name: 'Strict' }));
        expect(bmw().getByTestId('stale-banner')).toBeTruthy(); // the charts stay, "Out of date", under the banner
        expect(bmw().getAllByTestId('chart-outdated').length).toBeGreaterThan(0);
        await clickSave();
        expect(diskModel('r1').relStiffness).toBe(1_000_000);
        expect(diskModel('r1').scatterXSensor).toBe('TAG3');

        await act(async () => { fireEvent.click(bmw().getByTestId('train-sensor')); });
        await settle(30);
        expect(diskFresh('r1')).toBe(true);
        expect(diskModel('r1').scatterXSensor).toBe('TAG3');
        await waitFor(() => expect(echartsX()).toBe('TAG3'));
    });
});

// ─────────────────────────────────────────────────────────────────────────
// (4) The slider's new criteria-stats fetch vs. fast model switching.
// ─────────────────────────────────────────────────────────────────────────

describe('(4) criteria-stats fetch races between Clustering models', () => {
    // c1: criteria TAG2, real range [0, 10]; c3: criteria TAG1, real range [500, 900].
    const C1 = () => dashModel({
        id: 'c1', kind: 'clustering', tag: 'TAG1', ySensor: 'TAG3', criteriaSensor: 'TAG2',
        clusterRanges: [{ min: 0, max: 3 }, { min: 3, max: 6 }, { min: 6, max: 10 }],
    });
    const C3 = () => dashModel({
        id: 'c3', kind: 'clustering', tag: 'TAG3', ySensor: 'TAG2', criteriaSensor: 'TAG1',
        clusterRanges: [{ min: 500, max: 600 }, { min: 600, max: 700 }, { min: 700, max: 900 }],
    });
    beforeEach(() => {
        h.stats.TAG2 = { ...DEFAULT_STATS, min: 0, max: 10 };
        h.stats.TAG1 = { ...DEFAULT_STATS, min: 500, max: 900 };
    });

    it('out-of-order resolution: the previous model\'s late reply never lands in the current model\'s slider', async () => {
        const a = deferred();
        h.holds.TAG2 = a.promise;
        writeDisk(wsState([C1(), C3()]));
        await mountBuildModel();
        selectRow('TAG1');
        openSettings();
        expect(bmw().getByTestId('cluster-slider-loading')).toBeTruthy();

        const b = deferred();
        h.holds.TAG1 = b.promise;
        selectRow('TAG3');
        openSettings();
        expect(bmw().getByTestId('cluster-slider-loading')).toBeTruthy();

        b.resolve();
        await settle(10);
        expect(bmw().getByTestId('cluster-pill-0').textContent).toBe('#1: 500 – ');
        expect((bmw().getByTestId('cluster-bound-0') as HTMLInputElement).value).toBe('600');
        a.resolve(); // c1's stale TAG2 reply arrives last
        await settle(10);
        const header = bmw().getByTestId('cluster-slider').querySelector('.pm-cluster-slider-header')!;
        expect(header.textContent).toContain('500');
        expect(header.textContent).toContain('900');
        expect(header.textContent).toContain('TAG1');
    });

    it('FIXED (2026-09-30): while the newly selected model\'s stats are loading, its slider shows the loading state, never the PREVIOUS model\'s [min, max]', async () => {
        // `criteriaStats` is one piece of state shared by every model, so it is
        // reset to null at the top of its effect, before the early return and
        // before the new fetch: c3's slider must not render with c1's bounds /
        // header until its own reply lands.
        writeDisk(wsState([C1(), C3()]));
        await mountBuildModel();
        selectRow('TAG1');
        openSettings();
        await waitFor(() => expect(bmw().getByTestId('cluster-slider')).toBeTruthy());

        h.holds.TAG1 = deferred().promise;
        selectRow('TAG3');
        openSettings();
        expect(bmw().queryByTestId('cluster-slider')).toBeNull();
        expect(bmw().getByTestId('cluster-slider-loading')).toBeTruthy();
    });

    it('FIXED (2026-09-30): dragging while the new model\'s stats are still loading is a no-op — no live handle to drag on the wrong scale', async () => {
        // Was: a consequence of the bug above — the handles stayed live
        // during the stale-stats window, and a drag mapped the pointer
        // through c1's [0, 10] — pulling c3's first split from 600 down to
        // its left clamp (500.x) although the user dragged to the MIDDLE of
        // the track. Now the loading state (no `role="slider"` at all) shows
        // instead, so there's nothing to drag until c3's own stats resolve.
        writeDisk(wsState([C1(), C3()]));
        await mountBuildModel();
        selectRow('TAG1');
        openSettings();
        await waitFor(() => expect(bmw().getByTestId('cluster-slider')).toBeTruthy());

        const hold = deferred();
        h.holds.TAG1 = hold.promise;
        selectRow('TAG3');
        openSettings();
        const handle = bmw().queryAllByRole('slider')[0];
        if (handle) {
            const track = handle.parentElement as HTMLElement;
            vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
                left: 0, width: 200, top: 0, height: 30, right: 200, bottom: 30, x: 0, y: 0, toJSON: () => ({}),
            } as DOMRect);
            fireEvent.mouseDown(handle);
            fireEvent.mouseMove(document, { clientX: 100 });
            fireEvent.mouseUp(document);
        }
        hold.resolve();
        await settle(10);
        expect(bmw().getByTestId('cluster-pill-0').textContent).toBe('#1: 500 – ');
        expect((bmw().getByTestId('cluster-bound-0') as HTMLInputElement).value).toBe('600');
        expect(bmw().queryByTestId('save-changes')).toBeNull();
    });

    it('a change to the active model\'s PERSISTED training scope (another window write, broadcast in) refetches the criteria bounds with the new filter', async () => {
        writeDisk(wsState([C1()]));
        await mountBuildModel();
        openSettings();
        await waitFor(() => expect(bmw().getByTestId('cluster-slider')).toBeTruthy());
        expect(statsCalls('TAG2').slice(-1)[0]?.args?.filter).toBeNull(); // workspace "No condition"

        await act(async () => {
            const next = await updateWorkspaceData('ws1', prev => withFailureGroupState(prev, {
                models: prev.failureGroupState!.models.map(m => m.id === 'c1' ? {
                    ...m, runningConditionMode: 'custom' as const,
                    customRunningConditionFilters: [{ id: 'pm-c', sensor: 'TAG3', operation: 'greater_than' as const, value1: '5', value2: '' }],
                } : m),
            }));
            await emit('failure-group-state-changed', { ...next!.failureGroupState, workspaceId: 'ws1', origin: 'other-window' });
        });
        await settle(10);
        expect(statsCalls('TAG2').slice(-1)[0]?.args?.filter?.value_filters).toEqual([{ sensor: 'TAG3', operation: 'greater_than', value1: 5, value2: null }]);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// (5) General bug hunt.
// ─────────────────────────────────────────────────────────────────────────

describe('(5a) cluster-range slider: ranges are never re-divided to the criteria sensor\'s real range', () => {
    it('FIXED (2026-09-30): picking a criteria sensor in the Workbench auto-divides the ranges into the sensor\'s real range', async () => {
        // The auto-divide effect: a Dashboard-created model (ranges
        // 0-33/33-66/66-100) given a criteria sensor whose data is 500-900 must
        // get its ranges re-divided across the sensor's real [min, max] (anchored
        // to the persisted model's own key — see BuildModelWindow.tsx), not three
        // zero-width segments pinned at the left edge.
        h.stats.TAG3 = { ...DEFAULT_STATS, min: 500, max: 900 };
        writeDisk(wsState([dashModel({ id: 'c1', kind: 'clustering', tag: 'TAG1', ySensor: 'TAG2' })]));
        await mountBuildModel();
        openSettings();
        await pickSingleSensor('None', 'TAG3');
        await waitFor(() => expect(bmw().getByTestId('cluster-slider')).toBeTruthy());
        await clickSave();
        const ranges = diskModel('c1').clusterRanges;
        expect(diskModel('c1').criteriaSensor).toBe('TAG3');
        expect(ranges.every((r: any) => r.min >= 500 && r.max <= 900)).toBe(true);
    });

    // The optional criteria sensor could not be cleared.
    // Through the REAL picker: the trigger's × clears it, the count drops to one cluster (the
    // only valid shape without a criteria sensor), the section stays open, Save writes it.
    it('FIXED (2026-10-09): the criteria sensor is cleared with the trigger\'s ×, leaving a valid one-cluster model', async () => {
        writeDisk(wsState([dashModel({
            id: 'c1', kind: 'clustering', tag: 'TAG1', ySensor: 'TAG2', criteriaSensor: 'TAG3',
            clusterRanges: [{ min: 0, max: 3 }, { min: 3, max: 6 }, { min: 6, max: 10 }],
        })]));
        await mountBuildModel();
        openSettings();
        await waitFor(() => expect(bmw().getByTestId('cluster-slider')).toBeTruthy());
        await act(async () => { fireEvent.click(bmw().getByRole('button', { name: 'Clear criteria sensor' })); });
        expect(bmw().getByRole('button', { name: 'criteria sensor' }).textContent).toBe('None');
        expect(bmw().getByTestId('cluster-slider-empty').textContent).toMatch(/One cluster/);
        expect(bmw().queryByRole('button', { name: 'Clear criteria sensor' })).toBeNull();
        await clickSave();
        expect(diskModel('c1')).toMatchObject({ criteriaSensor: '', numClusters: 1, clusterRanges: [] });
        expect(bmw().getByTestId('add-model-form')).toBeTruthy(); // still open after the save
    });

    it('picking the criteria sensor that was the last missing item keeps "Model settings" open', async () => {
        writeDisk(wsState([dashModel({ id: 'c1', kind: 'clustering', tag: 'TAG1', ySensor: 'TAG2' })])); // 3 clusters, no criteria
        await mountBuildModel();
        expect(bmw().getByTestId('settings-to-fix').textContent).toBe('1 to fix'); // auto-open: 2+ clusters need a criteria sensor
        await pickSingleSensor('None', 'TAG3');
        expect(bmw().queryByTestId('settings-to-fix')).toBeNull();
        expect(bmw().getByTestId('add-model-form')).toBeTruthy();
        await waitFor(() => expect(bmw().getByTestId('cluster-slider')).toBeTruthy());
    });

    it('FIXED (2026-09-30): stepping the cluster count resizes the ranges array to match', async () => {
        // `clusterRanges.length === numClusters` is an invariant the auto-divide
        // effect enforces: `numClusters` 3 -> 4 must not leave 3 ranges
        // (`executeTrain` slices, it never pads).
        writeDisk(wsState([dashModel({
            id: 'c1', kind: 'clustering', tag: 'TAG1', ySensor: 'TAG2', criteriaSensor: 'TAG3',
            clusterRanges: [{ min: 0, max: 3 }, { min: 3, max: 6 }, { min: 6, max: 10 }],
        })]));
        await mountBuildModel();
        openSettings();
        await waitFor(() => expect(bmw().getByTestId('cluster-slider')).toBeTruthy());
        fireEvent.click(bmw().getByLabelText('More clusters'));
        expect(bmw().getByText(/^#4:/)).toBeTruthy();
    });
});

describe('(5b) the running-condition gate judges the PERSISTED model, not the pending Custom draft', () => {
    it('FIXED (2026-09-30): with the Custom editor showing "Required" (no condition, not confirmed), Train is blocked — nothing runs', async () => {
        // The gate reads the DRAFT-merged model (`effectiveModelFor`): a pending
        // draft that switched to Custom with nothing set must block Train —
        // otherwise Train would commit it and train with `filter: null` (every
        // row, idle periods included).
        writeDisk(wsState([dashModel({ id: 'i1' })]));
        await mountBuildModel();
        openSettings();
        fireEvent.click(bmw().getByRole('button', { name: 'Custom' }));
        expect(bmw().getByTestId('rc-unset-warning')).toBeTruthy();

        const before = statsCalls('TAG1').length; // the Step-1 card's own row count is already in here
        await act(async () => { fireEvent.click(bmw().getByTestId('train-sensor')); });
        await settle(30);
        expect(statsCalls('TAG1')).toHaveLength(before); // Train added nothing
    });

    it('FIXED (2026-09-30, same root cause, mirror case): a persisted-but-unconfigured Custom model unblocks as soon as the user fills in a condition in the Workbench, without needing Save first', async () => {
        // Train/Test: it has its own train period; only the condition is missing.
        writeDisk(wsState([dashModel({ id: 'i1', runningConditionMode: 'custom', filterTimePeriods: ALL_TIME_TRAIN })]));
        await mountBuildModel();
        openSettings();
        fireEvent.click(bmw().getByTestId('rc-add-condition'));
        fireEvent.change(bmw().getByPlaceholderText('value'), { target: { value: '42' } });
        expect(bmw().queryByTestId('rc-unset-warning')).toBeNull();
        expect((bmw().getByTestId('train-sensor') as HTMLButtonElement).disabled).toBe(false);
    });

    it('FIXED (2026-09-30): for a Custom-mode model, the results area\'s "fix" link opens this model\'s OWN Model settings / Custom editor, not the workspace modal', async () => {
        // A Custom-mode model's gate link opens its own Model settings (its
        // condition/period editor lives inline there), not the workspace modal —
        // `incompleteItems` branches on the draft's `runningConditionMode`.
        writeDisk(wsState([dashModel({ id: 'i1', runningConditionMode: 'custom' })]));
        await mountBuildModel();
        const results = within(bmw().getByTestId('results-incomplete'));
        fireEvent.click(results.getByText('Set a condition above, or choose Use all rows'));
        expect(screen.queryByRole('dialog', { name: 'Running condition' })).toBeNull();
        expect(bmw().getByTestId('custom-rc-editor')).toBeTruthy();
    });
});

// ─────────────────────────────────────────────────────────────────────────
// (6) The redesigned Running condition modal with the REAL
//     SensorPickerModal nested inside it (BuildModelWindow.test.tsx stubs the
//     picker, so Esc ownership and a real pick are only provable here).
// ─────────────────────────────────────────────────────────────────────────
describe('(6) Running condition modal + the real nested sensor picker (2026-10-03)', () => {
    const COND5 = { id: 'f1', sensor: 'TAG1', operation: 'greater_than', value1: '5', value2: '' };
    const esc = () => act(async () => { fireEvent.keyDown(document.body, { key: 'Escape' }); await Promise.resolve(); });
    const rcDialog = () => screen.queryByRole('dialog', { name: 'Running condition' });
    // The shared single picker's anchored popover is named after its field ("sensor").
    const pickerDialog = () => screen.queryByRole('dialog', { name: 'sensor' });
    const condTrigger = () => within(within(rcDialog()!).getByTestId('rc-cond-1')).getByRole('button', { name: 'sensor' });

    async function openModalWithPicker() {
        writeDisk(wsState([dashModel({ id: 'i1' })], { runningConditionNoneConfirmed: false, runningConditionFilters: [COND5] }));
        await mountBuildModel();
        fireEvent.click(bmw().getByTestId('rc-card-open'));
        expect(rowTag(condTrigger())).toBe('TAG1');
        fireEvent.click(condTrigger());
        expect(pickerDialog()).toBeTruthy();
    }

    it('Esc inside the nested picker closes ONLY the picker (the modal stays, no discard prompt); the next Esc closes the modal', async () => {
        await openModalWithPicker();
        await esc();
        expect(pickerDialog()).toBeNull();
        expect(rcDialog()).toBeTruthy();
        expect(screen.queryByTestId('rc-discard-prompt')).toBeNull();
        await esc();
        expect(rcDialog()).toBeNull();
    });

    it('Esc with focus IN the picker search box closes only the picker (the modal capture-phase listener skips it)', async () => {
        await openModalWithPicker();
        const search = pickerSearch();
        expect(document.activeElement).toBe(search);
        await act(async () => { fireEvent.keyDown(search, { key: 'Escape' }); await Promise.resolve(); });
        expect(pickerDialog()).toBeNull();
        expect(rcDialog()).toBeTruthy();
        expect(screen.queryByTestId('rc-discard-prompt')).toBeNull();
    });

    it('Esc inside the picker over a DIRTY draft still only closes the picker; the following Esc asks before discarding', async () => {
        await openModalWithPicker();
        // the picker covers the modal; edit the draft first, then reopen the picker
        await esc();
        fireEvent.change(screen.getByDisplayValue('5'), { target: { value: '9' } });
        expect(rowTag(condTrigger())).toBe('TAG1');
        fireEvent.click(condTrigger());
        await esc();
        expect(pickerDialog()).toBeNull();
        expect(screen.queryByTestId('rc-discard-prompt')).toBeNull();
        await esc();
        expect(screen.getByTestId('rc-discard-prompt')).toBeTruthy();
        expect(rcDialog()).toBeTruthy();
    });

    it('picking a sensor through the real picker changes the DRAFT only; Apply writes it once', async () => {
        await openModalWithPicker();
        const writesBefore = h.files.get(WS_FILE);
        fireEvent.click(findPickerRow('TAG3'));
        expect(pickerDialog()).toBeNull();
        expect(condTrigger().querySelector('.sl-desc')?.textContent).toBe('Motor Current');
        expect(h.files.get(WS_FILE)).toBe(writesBefore); // nothing on disk yet
        await act(async () => { fireEvent.click(screen.getByTestId('rc-apply')); });
        await settle(30);
        expect(readDisk().failureGroupState.runningConditionFilters[0]).toMatchObject({ sensor: 'TAG3', value1: '5' });
        expect(bmw().getByTestId('rc-card-cond').textContent).toBe('When running: 1 condition'); // the one line
        fireEvent.click(bmw().getByTestId('rc-card-details'));
        expect(bmw().getByTestId('rc-card-cond-chip').textContent).toBe('Motor CurrentTAG3 > 5 A');
    });
});
