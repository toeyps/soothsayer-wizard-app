import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, waitFor, within } from '@testing-library/react';

/*
 * Build Model Workbench Phase B QA (2026-09-29) — cross-zone integration for
 * "Train in place" (`lastTrainedAt` / `trainedFingerprint`, see
 * `src/utils/trainFingerprint.ts` and BuildModelWindow.tsx's Workbench).
 *
 * Same harness as Feature4BuildFlow.integration.test.tsx: everything is REAL
 * except the Tauri boundary —
 *   - BuildModelWindow renders the real PredictiveModelBuild page ("Open full
 *     view ↗"), which Phase B did NOT touch and which has its own debounced
 *     persist of the model record;
 *   - the real workspaceManager runs against an in-memory plugin-fs, so every
 *     read/write is an actual JSON round trip through the real write queue;
 *   - events go through one shared in-process bus (Tauri's global broadcast).
 * Only charts are stubbed; invoke() returns canned preview results (optionally
 * held open with `h.holdStats` to simulate a slow preview).
 *
 * Unit tests in BuildModelWindow.test.tsx mock the PM page and use a model
 * fixture with `clusterRanges: []`; this file uses the model shape the
 * Dashboard ACTUALLY creates (`makeDefaultModelForKind`: three default
 * cluster ranges, `targetSensor: ''` for clustering), which is what exposed
 * the round-trip problems this file's tests documented as `it.fails`.
 *
 * 🆕 2026-09-29 (bug-fix pass): all 9 `it.fails` below are fixed and flipped
 * to plain `it` — see each test's own "FIXED" comment for its root cause and
 * `docs/PROJECT_HANDOVER.md`'s matching dated entry for the full set.
 */

const h = vi.hoisted(() => ({
    listeners: {} as Record<string, Set<(e: any) => void>>,
    emitted: [] as { event: string; payload: any }[],
    files: new Map<string, string>(),
    writes: [] as string[],
    store: new Map<string, unknown>(),
    invokes: [] as { cmd: string; args: any }[],
    /** When set, `compute_sensor_stats` for the Workbench's Train waits on this. */
    holdStats: null as null | Promise<void>,
    /** When set, `compute_sensor_stats` rejects with this message. */
    failStats: null as null | string,
}));

vi.mock('@tauri-apps/api/event', () => ({
    listen: async (event: string, cb: (e: any) => void) => {
        (h.listeners[event] ??= new Set()).add(cb);
        return () => { h.listeners[event]?.delete(cb); };
    },
    emit: async (event: string, payload?: unknown) => {
        h.emitted.push({ event, payload });
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

const STATS = { mean: 5, sd: 1, min: 0, max: 10, count: 100, lower1: 4, upper1: 6, lower3: 2, upper3: 8 };
vi.mock('@tauri-apps/api/core', () => ({
    invoke: async (cmd: string, args?: unknown) => {
        h.invokes.push({ cmd, args: JSON.parse(JSON.stringify(args ?? null)) });
        switch (cmd) {
            case 'get_dataset_time_bounds': return { min: '2026-01-01T00:00:00', max: '2026-12-31T23:59:00' };
            case 'compute_sensor_stats':
                if (h.failStats) throw new Error(h.failStats);
                if (h.holdStats) await h.holdStats;
                return STATS;
            case 'preview_relationship_model': return {
                request: 'r', error: undefined, predicted: [1, 2, 3], residual: [0, 0, 0],
                r2_per_step: [0.9], rmse2_per_step: [0.1], target_raw: [1, 2, 3], predictor_raw: [[1], [2], [3]],
            };
            case 'compute_clustering_preview': return {
                first_sensor: 'TAG1', second_sensor: 'TAG3', criteria_sensor: null, cluster_count: 1, n_rows: 3,
                clusters: [{ cluster_id: 1, range: null, n_rows: 3, ellipse: { x_center: 1, y_center: 1, x_sd: 1, y_sd: 1, angle_deg: 0 }, xs: [1, 2, 3], ys: [1, 2, 3] }],
            };
            default: return {};
        }
    },
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({ close: vi.fn().mockResolvedValue(undefined), onCloseRequested: vi.fn().mockResolvedValue(() => {}) }),
}));

vi.mock('../hooks/useChartData', () => ({
    useChartData: () => ({ view: null, loading: false, error: null }),
}));
vi.mock('../components/charts/LineChart', () => ({ default: () => <div data-testid="line-chart-mock" /> }));
vi.mock('../components/charts/ResponsiveECharts', () => ({ default: () => <div data-testid="echarts-mock" /> }));

import BuildModelWindow from '../components/windows/BuildModelWindow';
import { emit } from '@tauri-apps/api/event';
import { updateWorkspaceData, saveWorkspaceData, loadWorkspaceData, duplicateWorkspace } from '../workspaceManager';
import { withFailureGroupState } from '../utils/failureGroupState';
import { computeTrainFingerprint } from '../utils/trainFingerprint';

// ── fixtures ────────────────────────────────────────────────────────────

const WS_FILE = 'workspaces/ws1.json';
const WS2_FILE = 'workspaces/ws2.json';
const HEADERS = ['TAG1', 'TAG2', 'TAG3'];
const BUILD_DATA = {
    workspaceId: 'ws1',
    sensorHeaders: HEADERS,
    sensorMetadata: [
        { tag: 'TAG1', description: 'Pump Pressure', unit: 'bar', component: 'Pump' },
        { tag: 'TAG2', description: 'Pump Temp', unit: 'C', component: 'Pump' },
        { tag: 'TAG3', description: 'Motor Current', unit: 'A', component: 'Motor' },
    ],
    metadata: { headers: ['timestamp', ...HEADERS], total_rows: 100 },
};
const COND = { id: 'rc1', sensor: 'TAG2', operation: 'greater_than', value1: '10', value2: '' };

/** A model exactly as Dashboard.tsx's `makeDefaultModelForKind` creates it
 *  (3 default cluster ranges, `targetSensor: ''` + X = tag for clustering),
 *  plus the Feature 4 fields a current workspace carries. */
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

function wsState(fg: Record<string, unknown>, id = 'ws1') {
    return {
        id, name: `QA ${id}`, lastRoute: 'dashboard', dataFilePaths: [], metadataFilePath: null,
        selectedSensors: [], visibleSensors: [], operationConfig: null,
        failureGroupState: { groups: [{ no: 0, name: 'Not in Group' }, { no: 1, name: 'FG-A' }], ...fg },
    };
}

/** A current-shape, CONFIGURED workspace ("No condition" confirmed) that
 *  raises no migration write-back. */
function currentFg(models: unknown[], extra: Record<string, unknown> = {}) {
    return {
        models, runningConditionFilters: [], runningConditionCombine: 'and', runningConditionTimePeriods: [],
        runningConditionNoneConfirmed: true, rcLegacyNotice: null, categoryNormalisationNotice: null, ...extra,
    };
}

const writeDisk = (s: unknown, file = WS_FILE) => h.files.set(file, JSON.stringify(s));
const readDisk = (file = WS_FILE) => JSON.parse(h.files.get(file)!);
const diskModel = (id: string, file = WS_FILE) => readDisk(file).failureGroupState.models.find((m: any) => m.id === id);
const wsWrites = () => h.writes.filter(p => p === WS_FILE).length;
/** Is the stored fingerprint still the one the stored settings would produce? */
const diskFresh = (id: string) => {
    const fg = readDisk().failureGroupState;
    const m = fg.models.find((x: any) => x.id === id);
    return !!m.lastTrainedAt && m.trainedFingerprint === computeTrainFingerprint(m, fg);
};

async function settle(ms = 0) {
    await act(async () => { await new Promise(r => setTimeout(r, ms)); });
}

async function mountBuildModel() {
    render(<BuildModelWindow />);
    await waitFor(() => expect(screen.getByTestId('rc-bar')).toBeTruthy());
    await settle(30);
}

const rcModal = () => screen.queryByRole('dialog', { name: 'Running Condition Filter' });
function closeRcModal() {
    const d = rcModal();
    if (d) fireEvent.click(within(d).getByLabelText('Close'));
}
void closeRcModal;

const pill = () => document.querySelector('.f4-foot .model-status-pill')!.textContent;
const footerStatus = () => screen.getByTestId('footer-status').textContent;
const markCompleteBtn = () => screen.getByText('✓ Mark complete') as HTMLButtonElement;
const openFullViewBtn = () => screen.getByText('Open full view ↗') as HTMLButtonElement;

async function clickTrain() {
    await act(async () => { fireEvent.click(screen.getByText('▶ Train model')); });
    await settle(30);
}

/** Open full view, stay long enough for the PM page's 250 ms debounced
 *  persist to run (it writes its whole config slice once after hydration),
 *  optionally edit something there, then press Back. */
async function roundTripThroughFullView(edit?: () => void) {
    await act(async () => { fireEvent.click(openFullViewBtn()); });
    await waitFor(() => expect(screen.getByText('Finish')).toBeTruthy());
    await settle(400);
    if (edit) { edit(); await settle(400); }
    await act(async () => { fireEvent.click(screen.getByTitle('Back to Build Model overview')); });
    await settle(30);
}

beforeEach(() => {
    for (const k of Object.keys(h.listeners)) delete h.listeners[k];
    h.emitted.length = 0;
    h.files.clear();
    h.writes.length = 0;
    h.store.clear();
    h.invokes.length = 0;
    h.holdStats = null;
    h.failStats = null;
    h.listeners['request-build-model-data'] = new Set([() => { void emit('build-model-data', BUILD_DATA); }]);
});

afterEach(() => {
    cleanup();
});

// ─────────────────────────────────────────────────────────────────────────
// (1) Workbench Train -> "Open full view ↗" (PM page) -> Back
// ─────────────────────────────────────────────────────────────────────────

describe('(1) a model trained in the Workbench survives a round trip through the PM page', () => {
    it('Individual (Dashboard-created shape): the PM page\'s own persist keeps lastTrainedAt/trainedFingerprint and the model is still Trained after Back', async () => {
        writeDisk(wsState(currentFg([dashModel({ id: 'i1' })])));
        await mountBuildModel();
        await clickTrain();
        const trained = diskModel('i1');
        expect(trained.lastTrainedAt).toBeTruthy();
        expect(diskFresh('i1')).toBe(true);
        expect(pill()).toBe('Trained');

        const writesBefore = wsWrites();
        await roundTripThroughFullView();
        // The PM page really did write its slice (so this proves its spread
        // carries the two Phase B fields, not that nothing was written).
        expect(wsWrites()).toBeGreaterThan(writesBefore);
        const after = diskModel('i1');
        expect(after.lastTrainedAt).toBe(trained.lastTrainedAt);
        expect(after.trainedFingerprint).toBe(trained.trainedFingerprint);
        expect(diskFresh('i1')).toBe(true);
        expect(pill()).toBe('Trained');
        expect(footerStatus()).toBe('Check the chart, then mark it complete');
        expect(markCompleteBtn().disabled).toBe(false);
        expect(screen.getByTestId('results-chart')).toBeTruthy();
    });

    it('Relationship: an UNRELATED PM-page edit (model name) keeps it Trained; a fingerprinted one (stiffness) makes it stale', async () => {
        writeDisk(wsState(currentFg([dashModel({ id: 'r1', kind: 'relationship', predictorSensors: ['TAG2'], rcMode: 'relationship', individualChecked: false })])));
        await mountBuildModel();
        await clickTrain();
        expect(pill()).toBe('Trained');
        const fp = diskModel('r1').trainedFingerprint;

        await roundTripThroughFullView(() => {
            fireEvent.change(screen.getByPlaceholderText('Optional'), { target: { value: 'Renamed in full view' } });
        });
        expect(diskModel('r1').relModelName).toBe('Renamed in full view');
        expect(diskModel('r1').trainedFingerprint).toBe(fp);
        expect(pill()).toBe('Trained');

        await roundTripThroughFullView(() => {
            const stiffness = screen.getByText('Stiffness', { selector: 'label' }).parentElement!.querySelector('select')!;
            fireEvent.change(stiffness, { target: { value: '1000000' } });
        });
        expect(diskModel('r1').relStiffness).toBe(1_000_000);
        expect(diskModel('r1').trainedFingerprint).toBe(fp); // not rewritten — it is the evidence of staleness
        expect(screen.getByTestId('results-stale')).toBeTruthy();
        expect(pill()).toBe('Incomplete');
        expect(footerStatus()).toBe('Settings changed — re-train');
        expect(screen.getByText('↻ Re-train')).toBeTruthy();
        expect(markCompleteBtn().disabled).toBe(true);
    });

    // FIXED (qa 2026-09-29). The PM page's hydration reads `targetSensor ||
    // ySensor` for a clustering model and, when `clusterRanges` is empty
    // (what the Workbench's own Save/Train commit writes when no criteria
    // sensor is set), keeps its auto-divided [0, 33.3, 66.7, 100] ranges. Its
    // 250 ms baseline persist then writes BOTH back to the model record —
    // `computeTrainFingerprint` (src/utils/trainFingerprint.ts) now drops
    // `targetSensor` for clustering entirely (derived from ySensor/xSensor,
    // not its own input) and drops `clusterRanges` whenever there's no
    // criteria sensor (a range list is meaningless without one), so neither
    // rewrite affects the fingerprint any more.
    it('Clustering: opening the full view and pressing Back with no edit keeps it Trained', async () => {
        writeDisk(wsState(currentFg([dashModel({ id: 'c1', kind: 'clustering', ySensor: 'TAG3', clusterRanges: [], rcMode: 'clustering', individualChecked: false })])));
        await mountBuildModel();
        await clickTrain();
        expect(pill()).toBe('Trained');

        await roundTripThroughFullView();
        expect(screen.queryByTestId('results-stale')).toBeNull();
        expect(pill()).toBe('Trained');
    });

    // FIXED (qa 2026-09-29). Same root cause for Individual/Relationship:
    // their fingerprint used to include the clustering-only `clusterRanges`.
    // A model whose record has `clusterRanges: []` (the shape a v0.6.0
    // workspace stored — see Feature4BuildFlow's `v1Model`) gets the PM
    // page's auto-divided ranges written back on open — `clusterRanges` is
    // now dropped from the fingerprint whenever there's no criteria sensor
    // (true for every Individual/Relationship model), so that rewrite no
    // longer makes it go stale.
    it('Individual with an empty clusterRanges record: opening the full view and pressing Back keeps it Trained', async () => {
        writeDisk(wsState(currentFg([dashModel({ id: 'i1', clusterRanges: [] })])));
        await mountBuildModel();
        await clickTrain();
        expect(pill()).toBe('Trained');

        await roundTripThroughFullView();
        expect(pill()).toBe('Trained');
    });
});

// ─────────────────────────────────────────────────────────────────────────
// (2) Train must "stick" for every model shape that can reach the Workbench
// ─────────────────────────────────────────────────────────────────────────

describe('(2) a successful Train with no pending draft leaves the model Trained-and-fresh', () => {
    // FIXED (qa 2026-09-29). `runTrainClick` used to ALWAYS fingerprint
    // `{ ...m, ...draftFields(m, draftOf(m)) }`, even when there was no draft
    // (so nothing was committed) — for a clustering model with no criteria
    // sensor `draftFields` yields `clusterRanges: []`, but the stored record
    // keeps its 3 default ranges (Dashboard's `makeDefaultModelForKind`, or
    // the PM page's persist when Y was picked there). `runTrainClick` now
    // only merges draft fields when a draft is actually pending for that
    // model id (`effectiveModelFor`) — with no draft, it trains against the
    // persisted `m` directly, unmodified.
    it('Clustering created on the Dashboard with Y picked in the full view (3 default cluster ranges, no criteria)', async () => {
        writeDisk(wsState(currentFg([dashModel({ id: 'c1', kind: 'clustering', ySensor: 'TAG3', rcMode: 'clustering', individualChecked: false })])));
        await mountBuildModel();
        await clickTrain();
        expect(h.invokes.some(c => c.cmd === 'compute_clustering_preview')).toBe(true);
        expect(diskFresh('c1')).toBe(true);
        expect(pill()).toBe('Trained');
        expect(markCompleteBtn().disabled).toBe(false);
    });

    // FIXED (qa 2026-09-29). Same root cause: `draftFromModel` snaps a
    // legacy stiffness (e.g. the old default `1`) to 100 000, so the no-draft
    // Train used to fingerprint 100 000 while the stored record (never
    // committed) still said 1 -> stale immediately. Fixed by the same
    // `runTrainClick`/`effectiveModelFor` change above.
    it('Relationship with a legacy (non-preset) stiffness', async () => {
        writeDisk(wsState(currentFg([dashModel({ id: 'r1', kind: 'relationship', predictorSensors: ['TAG2'], relStiffness: 1 })])));
        await mountBuildModel();
        await clickTrain();
        expect(diskFresh('r1')).toBe(true);
        expect(pill()).toBe('Trained');
    });

    it('control: the same clustering model trains fresh once a draft edit is committed with it (the workaround users would stumble on)', async () => {
        writeDisk(wsState(currentFg([dashModel({ id: 'c1', kind: 'clustering', ySensor: 'TAG3', rcMode: 'clustering', individualChecked: false })])));
        await mountBuildModel();
        fireEvent.click(screen.getByText('Model settings'));
        fireEvent.change(screen.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'QA model edited' } });
        await clickTrain();
        expect(diskModel('c1').clusterRanges).toEqual([]);
        expect(diskFresh('c1')).toBe(true);
        expect(pill()).toBe('Trained');
    });
});

// ─────────────────────────────────────────────────────────────────────────
// (3) save / reload: the two fields round-trip through the workspace JSON
// ─────────────────────────────────────────────────────────────────────────

describe('(3) lastTrainedAt / trainedFingerprint survive a save + reload', () => {
    it('reopening the window (fresh load of the same file) shows the model Trained, auto-recomputes, and writes nothing', async () => {
        writeDisk(wsState(currentFg([dashModel({ id: 'i1' })])));
        await mountBuildModel();
        await clickTrain();
        const before = diskModel('i1');
        const raw = h.files.get(WS_FILE)!;

        cleanup();
        h.invokes.length = 0;
        const writes = wsWrites();
        await mountBuildModel();
        await settle(30);
        expect(wsWrites()).toBe(writes); // reopening is read-only
        expect(h.files.get(WS_FILE)).toBe(raw);
        expect(diskModel('i1').lastTrainedAt).toBe(before.lastTrainedAt);
        // Staleness after reload is computed exactly as before it.
        expect(diskFresh('i1')).toBe(true);
        expect(h.invokes.filter(c => c.cmd === 'compute_sensor_stats')).toHaveLength(1); // the silent auto-recompute
        expect(screen.getByTestId('results-chart')).toBeTruthy();
        expect(pill()).toBe('Trained');
        expect(markCompleteBtn().disabled).toBe(false);
    });

    it('a workspace condition changed on disk while the window was closed reopens as stale, with no auto-recompute', async () => {
        writeDisk(wsState(currentFg([dashModel({ id: 'i1' })])));
        await mountBuildModel();
        await clickTrain();
        cleanup();

        const s = readDisk();
        s.failureGroupState.runningConditionNoneConfirmed = false;
        s.failureGroupState.runningConditionFilters = [COND];
        writeDisk(s);
        h.invokes.length = 0;
        await mountBuildModel();
        expect(diskFresh('i1')).toBe(false);
        expect(screen.getByTestId('results-stale')).toBeTruthy();
        expect(footerStatus()).toBe('Settings changed — re-train');
        expect(h.invokes.filter(c => c.cmd === 'compute_sensor_stats')).toHaveLength(0);
    });

    it('a Complete model keeps its training metadata through reload and shows "Last trained …"', async () => {
        writeDisk(wsState(currentFg([dashModel({ id: 'i1' })])));
        await mountBuildModel();
        await clickTrain();
        await act(async () => { fireEvent.click(markCompleteBtn()); });
        await settle(30);
        expect(diskModel('i1').status).toBe(true);

        cleanup();
        await mountBuildModel();
        expect(diskModel('i1').lastTrainedAt).toBeTruthy();
        expect(pill()).toBe('Complete');
        expect(footerStatus()).toMatch(/^Last trained /);
        // Un-marking brings it straight back to Trained (the metadata was never lost).
        await act(async () => { fireEvent.click(screen.getByText('Mark incomplete')); });
        await settle(30);
        expect(pill()).toBe('Trained');
    });

    it('workspaceManager save/load/duplicate and the legacy groupNo migration all keep both fields byte-for-byte', async () => {
        const trained = {
            ...dashModel({ id: 'i1' }),
            lastTrainedAt: '2026-09-29T03:00:00.000Z',
            trainedFingerprint: 'fp-sentinel',
        };
        const { groupNos: _g, ...legacyShape } = { ...trained, id: 'i2' };
        void _g;
        await saveWorkspaceData(wsState(currentFg([trained, { ...legacyShape, groupNo: 1 }])) as any);
        const loaded = await loadWorkspaceData('ws1');
        const byId = (ws: any, id: string) => ws.failureGroupState.models.find((m: any) => m.id === id);
        expect(byId(loaded, 'i1').lastTrainedAt).toBe(trained.lastTrainedAt);
        expect(byId(loaded, 'i1').trainedFingerprint).toBe('fp-sentinel');
        // normalizeModelGroups rebuilds this record (groupNo -> groupNos) — spread must keep the fields.
        expect(byId(loaded, 'i2').groupNos).toEqual([1]);
        expect(byId(loaded, 'i2').trainedFingerprint).toBe('fp-sentinel');

        const dup = await duplicateWorkspace('ws1');
        const dupLoaded = await loadWorkspaceData(dup!.id);
        expect(byId(dupLoaded, 'i1').trainedFingerprint).toBe('fp-sentinel');
    });
});

// ─────────────────────────────────────────────────────────────────────────
// (4) a Train still in flight when the model / workspace goes away
//     (SPEC FINAL: "train ค้างแล้ว model ถูกลบ/workspace เปลี่ยน → ทิ้งผล ไม่เขียนกลับ")
// ─────────────────────────────────────────────────────────────────────────

describe('(4) a slow Train that lands after its model or workspace is gone', () => {
    let release: () => void = () => {};
    const holdPreview = () => { h.holdStats = new Promise<void>(r => { release = r; }); };

    it('model deleted on the Dashboard mid-train: nothing is written back, the model is not resurrected', async () => {
        writeDisk(wsState(currentFg([dashModel({ id: 'i1' }), dashModel({ id: 'i2', tag: 'TAG2' })])));
        await mountBuildModel();
        holdPreview();
        await act(async () => { fireEvent.click(screen.getByText('▶ Train model')); });
        expect(screen.getByText('Training…')).toBeTruthy();

        await act(async () => {
            const next = await updateWorkspaceData('ws1', prev => withFailureGroupState(prev, {
                models: prev.failureGroupState!.models.filter(m => m.id !== 'i1'),
            }));
            await emit('failure-group-state-changed', { ...next!.failureGroupState, workspaceId: 'ws1', origin: 'dashboard' });
        });
        await settle(10);
        await act(async () => { release(); });
        await settle(30);

        const models = readDisk().failureGroupState.models;
        expect(models.map((m: any) => m.id)).toEqual(['i2']);
        expect(models.some((m: any) => m.lastTrainedAt)).toBe(false);
        expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Pump Temp');
    });

    // FIXED (qa 2026-09-29). `executeTrain` used to finish with
    // `persist(...)`, whose closure captured the OLD `workspaceId`; `persist`
    // then called `applyFg(next.failureGroupState)` unconditionally, so the
    // old project's models/running condition replaced the new project's in
    // this window (workspaceIdRef already said ws2). `executeTrain` now
    // captures `workspaceIdRef.current` when the run starts and discards the
    // result (no `persist`/state update at all) if it no longer matches
    // `workspaceIdRef.current` once the preview resolves.
    it('workspace switched mid-train: the window keeps showing ONLY the new workspace\'s models', async () => {
        writeDisk(wsState(currentFg([dashModel({ id: 'i1' })])));
        writeDisk(wsState(currentFg([dashModel({ id: 'w2', tag: 'TAG3' })]), 'ws2'), WS2_FILE);
        await mountBuildModel();
        holdPreview();
        await act(async () => { fireEvent.click(screen.getByText('▶ Train model')); });

        await act(async () => { await emit('build-model-data', { ...BUILD_DATA, workspaceId: 'ws2' }); });
        await settle(30);
        expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Motor Current'); // ws2's only sensor

        await act(async () => { release(); });
        await settle(30);
        expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Motor Current');
        expect(screen.queryAllByTestId('sensor-row-label').map(e => e.textContent)).toEqual(['Motor Current']);
    });

    // FIXED (qa 2026-09-29). Same path: the abandoned run used to still
    // write lastTrainedAt/trainedFingerprint into the OLD workspace's file
    // after the window was re-pointed away from it — see the workspace-guard
    // fix above.
    it('workspace switched mid-train: the abandoned result is NOT written back to the old workspace', async () => {
        writeDisk(wsState(currentFg([dashModel({ id: 'i1' })])));
        writeDisk(wsState(currentFg([dashModel({ id: 'w2', tag: 'TAG3' })]), 'ws2'), WS2_FILE);
        await mountBuildModel();
        holdPreview();
        await act(async () => { fireEvent.click(screen.getByText('▶ Train model')); });
        await act(async () => { await emit('build-model-data', { ...BUILD_DATA, workspaceId: 'ws2' }); });
        await settle(30);
        await act(async () => { release(); });
        await settle(30);
        expect(diskModel('i1').lastTrainedAt).toBeUndefined();
        expect(diskModel('w2', WS2_FILE).lastTrainedAt).toBeUndefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────
// (5) state machine vs. gate vs. what the results area shows
// ─────────────────────────────────────────────────────────────────────────

describe('(5) pill / footer / Mark complete agree with the results area', () => {
    // FIXED (qa 2026-09-29). "Trained" used to be judged only from the
    // STORED model, so an unsaved draft edit to a fingerprinted field
    // (stiffness, predictors, Y, clusters, Workspace/Custom…) after training
    // left the old chart on screen and "✓ Mark complete" enabled. SPEC FINAL
    // results-area rule: "แก้ค่าหลัง train → ซ่อนกราฟเก่า แสดง 'Settings
    // changed — re-train to see the result'". `isModelTrainedFresh`/
    // `isModelStale` now compute the fingerprint against `effectiveModelFor`
    // (the persisted model merged with any pending draft), so this is live
    // the instant the draft changes — the persisted `trainedFingerprint`
    // write itself still only ever happens through Train.
    it('an unsaved stiffness change after training hides the old chart and blocks Mark complete', async () => {
        writeDisk(wsState(currentFg([dashModel({ id: 'r1', kind: 'relationship', predictorSensors: ['TAG2'] })])));
        await mountBuildModel();
        await clickTrain();
        expect(pill()).toBe('Trained');

        fireEvent.click(screen.getByText('Model settings'));
        fireEvent.click(screen.getByRole('button', { name: 'Strict' }));
        expect(screen.getByText('edited')).toBeTruthy(); // really a pending draft
        expect(screen.queryByTestId('results-chart')).toBeNull();
        expect(markCompleteBtn().disabled).toBe(true);
    });

    // FIXED (qa 2026-09-29, low). When the silent auto-recompute on reopen
    // fails, the results area correctly showed the error (no chart), but the
    // footer still said "Check the chart, then mark it complete", the pill
    // said Trained, and Mark complete was enabled. The footer/pill/Mark-
    // complete-enabled logic now all check `trainError[m.id]` the same way a
    // failed MANUAL Train run already did for the Train/Re-train button.
    it('a failed auto-recompute on reopen does not tell the user to "check the chart" or allow Mark complete', async () => {
        writeDisk(wsState(currentFg([dashModel({ id: 'i1' })])));
        await mountBuildModel();
        await clickTrain();
        cleanup();

        h.failStats = 'dataset not loaded';
        await mountBuildModel();
        expect(screen.getByTestId('results-error').textContent).toMatch(/dataset not loaded/);
        expect(screen.getByText('↻ Re-train')).toBeTruthy();
        expect(footerStatus()).not.toBe('Check the chart, then mark it complete');
        expect(markCompleteBtn().disabled).toBe(true);
    });

    // FIXED (qa 2026-09-29, low). The fingerprint does not (and by design
    // should not) change when the gate starts blocking for a reason outside
    // the stored inputs (here: the condition's sensor disappears from the
    // dataset) — the results area already correctly lists "1 item to fix
    // before training" for that case. The pill and the left-list dot now
    // also consult the gate (`buildBlockReason`/`getBuildBlockReason`)
    // directly, instead of relying only on the fingerprint, so they no
    // longer still say Trained while the results area disagrees.
    it('when the gate blocks a previously trained model, the pill does not still say "Trained"', async () => {
        writeDisk(wsState(currentFg([dashModel({ id: 'i1' })], { runningConditionNoneConfirmed: false, runningConditionFilters: [COND] })));
        await mountBuildModel();
        await clickTrain();
        expect(pill()).toBe('Trained');

        // Dashboard re-sends the data with TAG2 gone (e.g. its special sensor was deleted).
        await act(async () => {
            await emit('build-model-data', { ...BUILD_DATA, sensorHeaders: ['TAG1', 'TAG3'], metadata: { headers: ['timestamp', 'TAG1', 'TAG3'], total_rows: 100 } });
        });
        await settle(30);
        expect(screen.getByTestId('results-incomplete')).toBeTruthy();
        expect(markCompleteBtn().disabled).toBe(true); // the gate itself still works
        expect(pill()).not.toBe('Trained');
    });

    it('Complete -> Mark incomplete -> a settings change makes it stale, and Mark complete needs a re-train again', async () => {
        writeDisk(wsState(currentFg([dashModel({ id: 'r1', kind: 'relationship', predictorSensors: ['TAG2'] })])));
        await mountBuildModel();
        await clickTrain();
        await act(async () => { fireEvent.click(markCompleteBtn()); });
        await settle(30);
        expect(pill()).toBe('Complete');
        expect(screen.queryByText('▶ Train model')).toBeNull();
        expect(screen.queryByText('↻ Re-train')).toBeNull();

        await act(async () => { fireEvent.click(screen.getByText('Mark incomplete')); });
        await settle(30);
        expect(pill()).toBe('Trained');
        fireEvent.click(screen.getByText('Model settings'));
        fireEvent.click(screen.getByRole('button', { name: 'Strict' }));
        await act(async () => { fireEvent.click(screen.getByText('Save changes')); });
        await settle(30);
        expect(screen.getByTestId('results-stale')).toBeTruthy();
        expect(pill()).toBe('Incomplete');
        expect(markCompleteBtn().disabled).toBe(true);
        await act(async () => { fireEvent.click(screen.getByText('↻ Re-train')); });
        await settle(30);
        expect(diskFresh('r1')).toBe(true);
        expect(markCompleteBtn().disabled).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// (6) 🆕 2026-09-30: the Custom running-condition editor ported INTO the
// Workbench (previously only settable on the full PM page). Every test above
// only ever exercises a model whose custom fields were already pre-set on
// disk before mount — none of them actually TYPE into the new editor and
// then Train, which is exactly the path most likely to expose a stale-draft/
// gate-ordering bug (the gate reads the PERSISTED model, not the draft — see
// `gateReasonOf`/`buildBlockReason` — so a model that starts out gate-
// satisfied in Workspace mode must stay clickable through Train even after
// switching to Custom in the draft, then commit-and-train against the NEWLY
// TYPED condition, not an empty pre-set list).
// ─────────────────────────────────────────────────────────────────────────

describe('(6) a Custom running-condition edited live in the Workbench (not pre-set) actually feeds Train', () => {
    it('switching to Custom, adding a condition and typing a value, then Train commits the draft and trains against the typed condition', async () => {
        // Starts out in Workspace mode with the workspace gate already
        // satisfied (currentFg's default `runningConditionNoneConfirmed:
        // true`) — so the Train button is enabled from the start, same as
        // every other model in this file; nothing about Custom mode is
        // persisted yet.
        writeDisk(wsState(currentFg([dashModel({ id: 'i1' })])));
        await mountBuildModel();
        fireEvent.click(screen.getByText('Model settings'));
        fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
        expect(screen.getByTestId('custom-rc-editor')).toBeTruthy();
        // Nothing to seed from (the workspace has no conditions of its own,
        // only "No condition" confirmed), so no seed note and an empty list.
        expect(screen.queryByTestId('pm-seed-note')).toBeNull();

        fireEvent.click(screen.getByText('+ Add condition'));
        fireEvent.change(screen.getByPlaceholderText('val'), { target: { value: '42' } });

        await clickTrain();

        // The draft (mode + the just-typed condition) was committed to disk
        // before training, not silently dropped.
        const saved = diskModel('i1');
        expect(saved.runningConditionMode).toBe('custom');
        expect(saved.customRunningConditionFilters).toHaveLength(1);
        expect(saved.customRunningConditionFilters[0]).toMatchObject({ sensor: 'TAG1', operation: 'greater_than', value1: '42' });

        // And Train actually queried Rust with THAT condition, not an empty
        // filter (which the old, always-satisfied-in-Workspace-mode gate
        // would have silently done if the commit-before-train ordering were
        // wrong).
        const statsCall = h.invokes.find(c => c.cmd === 'compute_sensor_stats');
        expect(statsCall?.args?.filter?.value_filters).toEqual([{ sensor: 'TAG1', operation: 'greater_than', value1: 42, value2: null }]);

        expect(diskFresh('i1')).toBe(true);
        expect(pill()).toBe('Trained');
        expect(markCompleteBtn().disabled).toBe(false);
    });

    it('the collapsed "Model settings" summary reflects the live-edited Custom condition/period counts, not a stale "Custom data" label', async () => {
        writeDisk(wsState(currentFg([dashModel({ id: 'i1' })])));
        await mountBuildModel();
        fireEvent.click(screen.getByText('Model settings'));
        fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
        fireEvent.click(screen.getByText('+ Add condition'));
        fireEvent.click(screen.getByText('No condition — use all rows'));
        fireEvent.click(screen.getByText('Model settings')); // collapse
        expect(screen.getByText(/Custom · no cond · 0 periods/)).toBeTruthy();
    });
});
