import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, waitFor, within } from '@testing-library/react';

/*
 * Build Model Workbench Phase C QA (2026-09-30) — the Dashboard's Failure
 * Groups tab status dot (`FailureGroupsPanel.tsx`'s `dotStatusFor`) against
 * the Build Model window's own pill / left-list dot, with BOTH real
 * components mounted on ONE workspace file.
 *
 * Same harness as BuildModelWorkbenchTrainCrossWindow.integration.test.tsx
 * (real workspaceManager over an in-memory plugin-fs, one event bus with a
 * switch that DROPS Build Model's `failure-group-state-changed` broadcasts so
 * Dashboard's mirror goes stale) — except `FailureGroupsPanel` is the REAL
 * component here, since the dot it renders is what is under test. Phase C's
 * own FailureGroupsPanel.test.tsx only unit-tests the panel with a hand-built
 * fg / datasetHeaders; nothing exercised the Dashboard wiring
 * (`runningConditionFg={fgExtra}`, `datasetHeaders={allSensorTags}`) or the
 * cross-window round trip until this file.
 *
 * Scenarios:
 *  1. Train in Build Model -> Dashboard dot turns blue (broadcast delivered);
 *     Mark complete -> green; Mark incomplete -> blue; workspace RC edit ->
 *     dot gone (stale). With the broadcast LOST: the file is right, and the
 *     dot recovers on the next Dashboard FG write / reopen — one case
 *     (fgExtra not adopted) was a real bug, fixed 2026-09-30; one remaining
 *     `it.fails` records a known, self-healing display lag (see its comment).
 *  2. Gate-blocked-but-fingerprint-fresh: every `getBuildBlockReason` reason
 *     that does NOT change the fingerprint must read as not-Trained in the
 *     Build Model pill, its left-list dot AND the Dashboard dot — never a
 *     disagreement between the three.
 */

const h = vi.hoisted(() => ({
    listeners: {} as Record<string, Set<(e: any) => void>>,
    files: new Map<string, string>(),
    store: new Map<string, unknown>(),
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
    writeTextFile: async (p: string, c: string) => { h.files.set(p, c); },
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
            <button onClick={() => p.onRenameGroup(1, 'FG-A renamed')}>dash-rename-fg1</button>
        </div>
    ),
}));
// NOTE: FailureGroupsPanel is deliberately NOT mocked — its dot is under test.
vi.mock('../hooks/useChartData', () => ({ useChartData: () => ({ view: null, loading: false, error: null }) }));
vi.mock('../hooks/useScatterSample', () => ({
    useScatterSample: () => ({ rows: [], headers: [], total: 0, sampled: 0, loading: false, error: null }),
}));
vi.mock('../components/charts/LineChart', () => ({ default: () => <div /> }));
vi.mock('../components/charts/ResponsiveECharts', () => ({ default: () => <div /> }));

import Dashboard from '../components/dashboard/Dashboard';
import BuildModelWindow from '../components/windows/BuildModelWindow';
import { computeTrainFingerprint, isModelTrainedFresh } from '../utils/trainFingerprint';
import { getBuildBlockReason } from '../utils/runningCondition';
import type { WorkspaceState } from '../types';

const WS_FILE = 'workspaces/ws1.json';
const HEADERS = ['timestamp', 'TAG1', 'TAG2'];
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

const BASE_FG = {
    groups: [{ no: 0, name: 'Not in Group' }, { no: 1, name: 'FG-A' }, { no: 2, name: 'FG-B' }],
    runningConditionCombine: 'and', runningConditionTimePeriods: [],
    rcLegacyNotice: null, categoryNormalisationNotice: null,
};

function wsState(fg: Record<string, unknown>): WorkspaceState {
    return {
        id: 'ws1', name: 'QA WS', lastRoute: 'dashboard', dataFilePaths: [], metadataFilePath: null,
        selectedSensors: [], visibleSensors: [], operationConfig: null,
        failureGroupState: { ...BASE_FG, ...fg } as any,
    } as WorkspaceState;
}

/** A workspace whose model(s) carry a Phase-B training stamp that is
 *  fingerprint-FRESH against the slice they're stored in. */
function wsWithTrained(fg: Record<string, unknown>, models: Record<string, unknown>[]): WorkspaceState {
    const slice = { ...BASE_FG, ...fg, models } as any;
    const stamped = models.map(m => ({
        ...m, lastTrainedAt: '2026-09-29T10:00:00.000Z', trainedFingerprint: computeTrainFingerprint(m as any, slice),
    }));
    return wsState({ ...fg, models: stamped });
}

const writeDisk = (s: unknown) => h.files.set(WS_FILE, JSON.stringify(s));
const readDisk = () => JSON.parse(h.files.get(WS_FILE)!);
const diskFresh = (id: string) => {
    const fg = readDisk().failureGroupState;
    return isModelTrainedFresh(fg.models.find((x: any) => x.id === id), fg);
};

async function settle(ms = 0) {
    await act(async () => { await new Promise(r => setTimeout(r, ms)); });
}

const dash = () => within(screen.getByTestId('dashboard-window'));
const bmw = () => within(screen.getByTestId('build-model-window'));

async function mountBoth() {
    render(
        <>
            <div data-testid="dashboard-window">
                <Dashboard
                    metadata={{ headers: HEADERS, total_rows: 100 }}
                    sensorMetadata={sensorMetadata}
                    onBack={vi.fn()}
                    initialState={readDisk()}
                />
            </div>
            <div data-testid="build-model-window"><BuildModelWindow /></div>
        </>,
    );
    await waitFor(() => expect(bmw().getByTestId('rc-card')).toBeTruthy());
    await settle(350);
    openDashFgTab();
}

const openDashFgTab = () => fireEvent.click(dash().getByRole('button', { name: 'Failure Groups' }));
const openDashSensorTab = () => fireEvent.click(dash().getByRole('button', { name: /^Sensor \(/ }));

/** Dashboard Failure Groups tab: 'none' | 'trained' | 'complete' for one badge. */
function dashDot(groupNo: number, key = 'tag1', kind = 'individual'): string {
    // The sensor row must exist, otherwise "no dot" would pass vacuously.
    expect(dash().getByTestId(`fg-sensor-row-${groupNo}:${key}`)).toBeTruthy();
    const el = screen.getByTestId('dashboard-window').querySelector(`[data-testid="fg-kind-badge-dot-${groupNo}-${key}-${kind}"]`);
    if (!el) return 'none';
    // Final visual-refresh QA sweep (2026-10-02): a dot element that is
    // present but no longer carries an `f4-kb-dot--<state>` class (e.g. a
    // later reskin finishing Phase 2's hybrid migration to `.kind-badge-dot`)
    // must fail loudly here — it used to be read back as 'none', which would
    // make every "no dot" assertion in this file pass vacuously. Build
    // Model's own dot (`bmwDot` below) already maps an unknown class to '?'.
    const state = el.className.match(/f4-kb-dot--(\w+)/)?.[1];
    expect(state, `Dashboard dot present without an f4-kb-dot--<state> class: "${el.className}"`).toBeDefined();
    return state!;
}

/** Build Model left-list dot(s) for one model id — the same model can render
 *  under several FG buckets; they must all agree. */
function bmwDot(modelId: string): string {
    expect(screen.getByTestId('build-model-window').querySelectorAll(`[data-testid="sensor-kind-badge-${modelId}"]`).length).toBeGreaterThan(0);
    const dots = [...screen.getByTestId('build-model-window').querySelectorAll(`[data-testid="sensor-kind-badge-dot-${modelId}"]`)];
    const states = new Set(dots.map(d => d.className.match(/f4-kb-dot--(\w+)/)?.[1] ?? '?'));
    if (dots.length === 0) return 'none';
    expect(states.size).toBe(1);
    return [...states][0];
}

const pill = () => screen.getByTestId('build-model-window').querySelector('.f4-foot .model-status-pill')!.textContent;
const selectTag1 = (g = 1) => fireEvent.click(bmw().getByTestId(`sensor-list-row-fg:${g}-tag1`));
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

/** A Dashboard-owned FG write that goes through `persistFailureGroupStateFrom`
 *  (FailureGroupsPanel's own "Edit details" → description, 250ms debounce). */
async function dashboardEditsFgDescription(text: string) {
    fireEvent.click(dash().getAllByText('Edit details')[0]);
    fireEvent.change(dash().getByPlaceholderText('What failure mode does this group track?'), { target: { value: text } });
    await settle(300);
    await settle(30);
    expect(readDisk().failureGroupState.groups.find((g: any) => g.no === 1).description).toBe(text);
}

beforeEach(() => {
    for (const k of Object.keys(h.listeners)) delete h.listeners[k];
    h.files.clear();
    h.store.clear();
    h.drop = null;
});

afterEach(() => {
    cleanup();
});

describe('Train in Build Model -> Dashboard Failure Groups status dot (broadcast delivered)', () => {
    it('never-trained -> Trained (blue) -> Complete (green) -> back to Trained -> stale after a workspace RC edit (no dot), matching Build Model at every step', async () => {
        writeDisk(wsState({
            models: [dashModel({ id: 'i1' })],
            runningConditionFilters: [COND], runningConditionNoneConfirmed: false,
        }));
        await mountBoth();
        selectTag1();
        expect(dashDot(1)).toBe('none');
        expect(bmwDot('i1')).toBe('none');
        expect(pill()).toBe('Incomplete');

        await trainTag1();
        await waitFor(() => expect(dashDot(1)).toBe('trained'));
        expect(bmwDot('i1')).toBe('trained');

        await act(async () => { fireEvent.click(bmw().getByText('✓ Mark complete')); });
        await settle(30);
        expect(readDisk().failureGroupState.models[0].status).toBe(true);
        expect(pill()).toBe('Complete');
        await waitFor(() => expect(dashDot(1)).toBe('complete'));
        expect(bmwDot('i1')).toBe('complete');

        await act(async () => { fireEvent.click(bmw().getByText('Mark incomplete')); });
        await settle(30);
        expect(pill()).toBe('Trained');
        await waitFor(() => expect(dashDot(1)).toBe('trained'));
        expect(bmwDot('i1')).toBe('trained');

        // Workspace running-condition edit in Build Model -> the model is stale.
        fireEvent.click(bmw().getByTestId('rc-card-open'));
        const modal = within(bmw().getByRole('dialog', { name: 'Running condition' }));
        await act(async () => { fireEvent.change(modal.getByPlaceholderText('value'), { target: { value: '20' } }); });
        await settle(30);
        await act(async () => { fireEvent.click(modal.getByTestId('rc-apply')); }); // 2026-10-03: edits land only on Apply
        await settle(30);
        expect(diskFresh('i1')).toBe(false);
        expect(pill()).toBe('Incomplete');
        expect(bmwDot('i1')).toBe('none');
        // Dashboard received the new condition via fgExtra -> its dot drops too.
        await waitFor(() => expect(dashDot(1)).toBe('none'));

        // A Dashboard autosave after all that doesn't resurrect anything.
        openDashSensorTab();
        await act(async () => { fireEvent.click(screen.getByText('dash-select-tag1')); });
        await settle(350);
        openDashFgTab();
        expect(dashDot(1)).toBe('none');
        expect(diskFresh('i1')).toBe(false);
    });

    it('a model in TWO failure groups shows the same dot in both Dashboard cards and both Build Model buckets after training', async () => {
        writeDisk(wsState({
            models: [dashModel({ id: 'i1', groupNos: [1, 2] })],
            runningConditionFilters: [], runningConditionNoneConfirmed: true,
        }));
        await mountBoth();
        expect(dashDot(1)).toBe('none');
        expect(dashDot(2)).toBe('none');
        await trainTag1();
        await waitFor(() => expect(dashDot(1)).toBe('trained'));
        expect(dashDot(2)).toBe('trained');
        expect(bmwDot('i1')).toBe('trained');
    });
});

describe('Train in Build Model with the broadcast LOST (stale Dashboard mirror)', () => {
    const start = () => wsState({
        models: [dashModel({ id: 'i1' })],
        runningConditionFilters: [COND], runningConditionNoneConfirmed: false,
    });

    it('the file stays correct through a Dashboard autosave, and the dot recovers on the next Dashboard FG write and on reopen', async () => {
        writeDisk(start());
        await mountBoth();
        dropBuildModelBroadcasts();
        await trainTag1();

        // Unrelated Dashboard interaction -> full-state autosave: must not
        // erase the training stamp (it re-reads failureGroupState from disk).
        openDashSensorTab();
        await act(async () => { fireEvent.click(screen.getByText('dash-select-tag1')); });
        await settle(350);
        openDashFgTab();
        expect(diskFresh('i1')).toBe(true);

        // A Dashboard FG write adopts the on-disk models -> dot catches up.
        await dashboardEditsFgDescription('Seal leak');
        await waitFor(() => expect(dashDot(1)).toBe('trained'));
        expect(bmwDot('i1')).toBe('trained');

        // Reopening both windows from the file: still consistent.
        cleanup();
        h.drop = null;
        await mountBoth();
        selectTag1();
        expect(dashDot(1)).toBe('trained');
        expect(bmwDot('i1')).toBe('trained');
        expect(pill()).toBe('Trained');
    });

    // KNOWN GAP (LOW) — recorded per this repo's `it.fails` convention.
    // Dashboard's Failure Groups dot reads ONLY its in-memory mirror
    // (`fgModels` / `fgExtra`). With the broadcast lost, nothing re-reads
    // disk into that mirror: the debounced autosave re-reads
    // `failureGroupState` from disk for the WRITE (CLAUDE.md 2026-09-18 fix)
    // but never adopts it into `fgModels`/`fgExtra`. So after a Train in
    // Build Model the Dashboard dot stays "no dot" (while Build Model says
    // Trained) until some Dashboard FG write or a reopen — even across an
    // autosave that just read the fresh value off disk. Data on disk is
    // never wrong; this is display-only. Flip to `it` if the autosave (or a
    // focus/visibility refresh) starts adopting the disk slice into the mirror.
    it.fails('KNOWN GAP: the Dashboard dot reflects the Train after a Dashboard autosave even though the broadcast was lost', async () => {
        writeDisk(start());
        await mountBoth();
        dropBuildModelBroadcasts();
        await trainTag1();
        openDashSensorTab();
        await act(async () => { fireEvent.click(screen.getByText('dash-select-tag1')); });
        await settle(350);
        openDashFgTab();
        expect(diskFresh('i1')).toBe(true);
        expect(bmwDot('i1')).toBe('trained');
        expect(dashDot(1)).toBe('trained'); // actual: 'none'
    });

    // FIXED 2026-09-30 (found in Feature 4's Workbench QA sweep).
    // `Dashboard.persistFailureGroupStateFrom`'s `.then` used to adopt the
    // on-disk `groups`/`models` into the mirror but NOT the rest of the slice
    // (`fgExtra` — the workspace running condition). With the broadcast lost,
    // a Dashboard FG write therefore paired FRESH models with a STALE running
    // condition, and the dot evaluated staleness against the wrong condition.
    // Fixed by adopting the whole slice in that `.then`, same as the
    // broadcast listener right above it already does.
    it('after a lost RC-edit broadcast, a Dashboard FG write must not show a stale model as Trained (fgExtra now adopted from disk)', async () => {
        writeDisk(start());
        await mountBoth();
        await trainTag1(); // broadcast delivered: Dashboard knows about the train
        await waitFor(() => expect(dashDot(1)).toBe('trained'));

        dropBuildModelBroadcasts();
        fireEvent.click(bmw().getByTestId('rc-card-open'));
        const modal = within(bmw().getByRole('dialog', { name: 'Running condition' }));
        await act(async () => { fireEvent.change(modal.getByPlaceholderText('value'), { target: { value: '20' } }); });
        await settle(30);
        await act(async () => { fireEvent.click(modal.getByTestId('rc-apply')); }); // 2026-10-03: edits land only on Apply
        await settle(30);
        expect(readDisk().failureGroupState.runningConditionFilters[0].value1).toBe('20');
        expect(diskFresh('i1')).toBe(false);
        expect(pill()).toBe('Incomplete');
        expect(bmwDot('i1')).toBe('none');

        await dashboardEditsFgDescription('Seal leak');
        expect(dashDot(1)).toBe('none'); // actual: 'trained' — disagrees with Build Model
    });
});

describe('gate-blocked but fingerprint-fresh: Build Model pill, Build Model dot and Dashboard dot never disagree', () => {
    type Case = {
        name: string;
        fg: Record<string, unknown>;
        model: Record<string, unknown>;
        blocked: boolean;
    };
    const cases: Case[] = [
        {
            name: 'control — RC sensor present, gate passes',
            fg: { runningConditionFilters: [COND], runningConditionNoneConfirmed: false },
            model: {},
            blocked: false,
        },
        {
            name: 'workspace RC sensor missing from the dataset headers',
            fg: { runningConditionFilters: [{ ...COND, sensor: 'TAG9' }], runningConditionNoneConfirmed: false },
            model: {},
            blocked: true,
        },
        {
            name: 'sensor has no category (category is not fingerprinted)',
            fg: { runningConditionFilters: [COND], runningConditionNoneConfirmed: false },
            model: { category: null },
            blocked: true,
        },
        {
            name: 'workspace training period ends before it starts',
            fg: {
                runningConditionFilters: [COND], runningConditionNoneConfirmed: false,
                runningConditionTimePeriods: [{ id: 'p1', start: '2024-02-01T00:00', end: '2024-01-01T00:00' }],
            },
            model: {},
            blocked: true,
        },
        {
            name: 'Custom-mode model whose own RC sensor is missing from the dataset',
            fg: { runningConditionFilters: [], runningConditionNoneConfirmed: true },
            model: { runningConditionMode: 'custom', customRunningConditionFilters: [{ ...COND, sensor: 'TAG9' }] },
            blocked: true,
        },
    ];

    for (const c of cases) {
        it(`${c.name} -> ${c.blocked ? 'NOT Trained' : 'Trained'} in all three places`, async () => {
            const ws = wsWithTrained(c.fg, [dashModel({ id: 'i1', ...c.model })]);
            writeDisk(ws);
            // Precondition: the persisted stamp really is fingerprint-fresh, and
            // the gate verdict is what the case says (against the same headers
            // both windows use — Dashboard's allSensorTags, which it also hands
            // Build Model as `sensors`).
            const fgOnDisk = ws.failureGroupState as any;
            const m = fgOnDisk.models[0];
            expect(isModelTrainedFresh(m, fgOnDisk)).toBe(true);
            expect(getBuildBlockReason(m, fgOnDisk, ['TAG1', 'TAG2']) !== null).toBe(c.blocked);

            await mountBoth();
            selectTag1();
            await settle(30);
            const expected = c.blocked ? 'none' : 'trained';
            expect(pill()).toBe(c.blocked ? 'Incomplete' : 'Trained');
            expect(bmwDot('i1')).toBe(expected);
            expect(dashDot(1)).toBe(expected);
            // Mark complete follows the same verdict.
            expect((bmw().getByText('✓ Mark complete') as HTMLButtonElement).disabled).toBe(c.blocked);
            // Opening the model must not rewrite the stamp either way.
            expect(readDisk().failureGroupState.models[0].trainedFingerprint).toBe(m.trainedFingerprint);
        });
    }

    it('a gate-blocked model that becomes unblocked by a Build Model edit (broadcast delivered) turns Trained in both windows at the same time', async () => {
        // Fingerprint-fresh, blocked only by the missing category.
        writeDisk(wsWithTrained(
            { runningConditionFilters: [COND], runningConditionNoneConfirmed: false },
            [dashModel({ id: 'i1', category: null })],
        ));
        await mountBoth();
        selectTag1();
        await settle(30);
        expect(pill()).toBe('Incomplete');
        expect(dashDot(1)).toBe('none');

        // Category is saved instantly from the detail header (not fingerprinted).
        await act(async () => { fireEvent.click(bmw().getByRole('button', { name: /Performance/i })); });
        await settle(30);
        expect(readDisk().failureGroupState.models[0].category).toBe('performance');
        expect(diskFresh('i1')).toBe(true);
        await waitFor(() => expect(pill()).toBe('Trained'));
        expect(bmwDot('i1')).toBe('trained');
        await waitFor(() => expect(dashDot(1)).toBe('trained'));
    });
});
