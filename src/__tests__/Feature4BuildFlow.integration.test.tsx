import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, waitFor, within } from '@testing-library/react';
import contract from '../../src-tauri/tests/fixtures/filter_contract.json';

/*
 * Feature 4 QA (2026-09-24) — cross-zone integration for the Build Model flow.
 *
 * Unlike BuildModelWindow.test.tsx / PredictiveModelBuild.test.tsx (each mocks
 * the other side and `workspaceManager`), everything here is REAL except the
 * Tauri boundary:
 *   - BuildModelWindow renders the real PredictiveModelBuild page;
 *   - the real workspaceManager runs against an in-memory plugin-fs, so every
 *     read/write is an actual JSON round trip through the real write queue and
 *     `migrateFailureGroupState`;
 *   - events go through one shared in-process bus (every emit reaches every
 *     listener, like Tauri's global broadcast), so origin filtering is real.
 * Only charts are stubbed, and invoke() returns canned results while recording
 * the exact (JSON-serialised) args the Rust side would receive.
 */

const h = vi.hoisted(() => ({
    listeners: {} as Record<string, Set<(e: any) => void>>,
    emitted: [] as { event: string; payload: any }[],
    files: new Map<string, string>(),
    writes: [] as string[],
    store: new Map<string, unknown>(),
    invokes: [] as { cmd: string; args: any }[],
    chartQueries: [] as any[],
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
    invoke: (cmd: string, args?: unknown) => {
        h.invokes.push({ cmd, args: JSON.parse(JSON.stringify(args ?? null)) });
        switch (cmd) {
            case 'get_dataset_time_bounds': return Promise.resolve({ min: '2026-01-01T00:00:00', max: '2026-12-31T23:59:00' });
            case 'compute_sensor_stats': return Promise.resolve(STATS);
            case 'preview_relationship_model': return Promise.resolve({
                request: 'r', error: undefined, predicted: [1, 2, 3], residual: [0, 0, 0],
                r2_per_step: [0.9], rmse2_per_step: [0.1], target_raw: [1, 2, 3], predictor_raw: [[1], [2], [3]],
            });
            case 'compute_clustering_preview': return Promise.resolve({
                first_sensor: 'TAG1', second_sensor: 'TAG3', criteria_sensor: null, cluster_count: 1, n_rows: 0, clusters: [],
            });
            default: return Promise.resolve({});
        }
    },
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({ close: vi.fn().mockResolvedValue(undefined), onCloseRequested: vi.fn().mockResolvedValue(() => {}) }),
}));

vi.mock('../hooks/useChartData', () => ({
    useChartData: (q: unknown) => {
        h.chartQueries.push(q ? JSON.parse(JSON.stringify(q)) : null);
        return { view: null, loading: false, error: null };
    },
}));
vi.mock('../components/charts/LineChart', () => ({ default: () => <div data-testid="line-chart-mock" /> }));
vi.mock('../components/charts/ResponsiveECharts', () => ({ default: () => <div data-testid="echarts-mock" /> }));

import BuildModelWindow from '../components/windows/BuildModelWindow';
import { emit } from '@tauri-apps/api/event';
import { updateWorkspaceData } from '../workspaceManager';
import { withFailureGroupState } from '../utils/failureGroupState';
import { getBuildBlockReason } from '../utils/runningCondition';

// ── fixtures ────────────────────────────────────────────────────────────

const WS_FILE = 'workspaces/ws1.json';
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
const LEGACY_KEYS = ['runningConditionTimeStart', 'runningConditionTimeEnd', 'filterTimeStart', 'filterTimeEnd'];
const GATE_REASON = 'Set a running condition first, or choose "No condition — use all rows".';
const COND = { id: 'rc1', sensor: 'TAG2', operation: 'greater_than', value1: '10', value2: '' };

/** A model exactly as a v0.6.0 (pre-Feature-4) workspace stored it. */
function v1Model(o: Record<string, unknown>) {
    return {
        id: 'x', groupNos: [1], name: 'QA model', kind: 'individual', category: null, notes: '', status: false,
        targetSensor: 'TAG1', predictorSensors: [], xSensor: '', ySensor: '',
        individualChecked: true, rcMode: null, scatterXSensor: '', relModelName: '', relStiffness: 100_000,
        clusterModelName: '', numClusters: 3, criteriaSensor: '', clusterRanges: [],
        filterTimeStart: '', filterTimeEnd: '',
        runningConditionMode: 'workspace', customRunningConditionFilters: [], customRunningConditionCombine: 'and',
        ...o,
    };
}

/** A model in the current (Feature 4) shape. */
function model(o: Record<string, unknown>) {
    const { filterTimeStart: _s, filterTimeEnd: _e, ...rest } = v1Model({});
    void _s; void _e;
    return { ...rest, filterTimePeriods: [], customRunningConditionNoneConfirmed: false, category: 'performance', ...o };
}

function wsState(fg: Record<string, unknown>) {
    return {
        id: 'ws1', name: 'QA WS', lastRoute: 'dashboard', dataFilePaths: [], metadataFilePath: null,
        selectedSensors: [], visibleSensors: [], operationConfig: null,
        failureGroupState: { groups: [{ no: 0, name: 'Not in Group' }, { no: 1, name: 'FG-A' }, { no: 2, name: 'FG-B' }], ...fg },
    };
}

/** A current-shape workspace that raises no migration write-back. */
function currentFg(models: unknown[], extra: Record<string, unknown> = {}) {
    return {
        models, runningConditionFilters: [], runningConditionCombine: 'and', runningConditionTimePeriods: [],
        runningConditionNoneConfirmed: false, rcLegacyNotice: null, categoryNormalisationNotice: null, ...extra,
    };
}

const writeDisk = (s: unknown) => h.files.set(WS_FILE, JSON.stringify(s));
const readDisk = () => JSON.parse(h.files.get(WS_FILE)!);
const wsWrites = () => h.writes.filter(p => p === WS_FILE).length;

async function settle(ms = 0) {
    await act(async () => { await new Promise(r => setTimeout(r, ms)); });
}

/** Mount the window; a stand-in for Dashboard answers its data request. */
async function mountBuildModel() {
    render(<BuildModelWindow />);
    await waitFor(() => expect(screen.queryByText('Running Condition Filter')).toBeTruthy());
    await settle(30);
}

/** Another window (Dashboard / PM) writes the slice and broadcasts it. */
async function otherWindowWrites(patch: Record<string, unknown>, origin = 'dashboard') {
    await act(async () => {
        const next = await updateWorkspaceData('ws1', prev => withFailureGroupState(prev, patch as any));
        await emit('failure-group-state-changed', { ...next!.failureGroupState, workspaceId: 'ws1', origin });
    });
    await settle(10);
}

const openFirstRow = () => fireEvent.click(screen.getAllByTestId('sensor-row-label')[0]);
const finishBtn = () => screen.getByText('Finish').closest('button') as HTMLButtonElement;

async function openPmFor(rowIndex = 0) {
    fireEvent.click(screen.getAllByTestId('sensor-row-label')[rowIndex]);
    await act(async () => { fireEvent.click(screen.getByText('Build Model →')); });
    await waitFor(() => expect(screen.getByText('Finish')).toBeTruthy());
    await settle(30);
}

const lastInvoke = (cmd: string, pred: (a: any) => boolean = () => true) =>
    [...h.invokes].reverse().find(c => c.cmd === cmd && pred(c.args));
const lastChartFilter = () => [...h.chartQueries].reverse().find(q => q)?.filter;

beforeEach(() => {
    for (const k of Object.keys(h.listeners)) delete h.listeners[k];
    h.emitted.length = 0;
    h.files.clear();
    h.writes.length = 0;
    h.store.clear();
    h.invokes.length = 0;
    h.chartQueries.length = 0;
    // Dashboard's role in the handshake: answer the data request.
    h.listeners['request-build-model-data'] = new Set([() => { void emit('build-model-data', BUILD_DATA); }]);
});

afterEach(() => {
    cleanup();
});

// ─────────────────────────────────────────────────────────────────────────
// (1) v1 workspace -> migrated at BuildModelWindow hydration
// ─────────────────────────────────────────────────────────────────────────

describe('(1) opening a v1 (pre-Feature-4) workspace', () => {
    const V1 = wsState({
        models: [
            v1Model({ id: 'i1', kind: 'individual', targetSensor: 'TAG1', category: 'performance' }),
            v1Model({ id: 'r1', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG2'], category: 'condition', rcMode: 'relationship', individualChecked: false }),
            // Clustering is keyed by X: joins TAG1's row even though Y is TAG3.
            v1Model({ id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG3', category: null, groupNos: [2], rcMode: 'clustering', individualChecked: false }),
            v1Model({ id: 'i2', kind: 'individual', targetSensor: 'TAG2', category: null, groupNos: [2], runningConditionMode: 'custom', filterTimeStart: '2026-03-01T00:00', filterTimeEnd: '2026-03-31T23:59' }),
        ],
        runningConditionFilters: [],
        runningConditionCombine: 'and',
        runningConditionTimeStart: '2026-01-01T00:00',
        runningConditionTimeEnd: '2026-06-30T23:59',
    });

    it('is normalised, flagged and migrated to one period, written back ONCE with no legacy keys, and reopening changes nothing', async () => {
        writeDisk(V1);
        await mountBuildModel();

        expect(wsWrites()).toBe(1);
        const raw = h.files.get(WS_FILE)!;
        for (const k of LEGACY_KEYS) expect(raw).not.toContain(`"${k}"`);
        const fg = JSON.parse(raw).failureGroupState;

        // Categories: TAG1 (I, R and the X-keyed C) agree on the Individual's value; TAG2 has none anywhere -> untouched.
        const cat = (id: string) => fg.models.find((m: any) => m.id === id).category;
        expect([cat('i1'), cat('r1'), cat('c1'), cat('i2')]).toEqual(['performance', 'performance', 'performance', null]);
        expect(fg.categoryNormalisationNotice.map((c: any) => [c.modelId, c.from, c.to])).toEqual([
            ['r1', 'condition', 'performance'],
            ['c1', null, 'performance'],
        ]);
        // Gate: models exist, nothing configured -> flagged, not silently confirmed.
        expect(fg.rcLegacyNotice).toBe('pending');
        expect(fg.runningConditionNoneConfirmed).toBeUndefined();
        // Periods: the single workspace range -> one period; per-model too; empty pairs -> [].
        expect(fg.runningConditionTimePeriods).toEqual([{ id: 'legacy-1', start: '2026-01-01T00:00', end: '2026-06-30T23:59' }]);
        const periods = (id: string) => fg.models.find((m: any) => m.id === id).filterTimePeriods;
        expect(periods('i2')).toEqual([{ id: 'legacy-1', start: '2026-03-01T00:00', end: '2026-03-31T23:59' }]);
        expect([periods('i1'), periods('r1'), periods('c1')]).toEqual([[], [], []]);
        expect(fg.models.every((m: any) => m.customRunningConditionNoneConfirmed === false)).toBe(true);
        // Everything the migrations don't own survived the spread.
        expect(fg.groups).toHaveLength(3);
        expect(fg.models.find((m: any) => m.id === 'i2').runningConditionMode).toBe('custom');

        // The write was broadcast once, so other windows adopt it.
        const broadcasts = h.emitted.filter(e => e.event === 'failure-group-state-changed');
        expect(broadcasts).toHaveLength(1);
        expect(broadcasts[0].payload.origin).toBe('build-model');
        expect(broadcasts[0].payload.workspaceId).toBe('ws1');

        // What the user sees is the stored result.
        expect(screen.getByTestId('rc-legacy-banner')).toBeTruthy();
        expect(screen.getByTestId('category-normalisation-notice')).toBeTruthy();
        expect(screen.getByTestId('rc-required-pill')).toBeTruthy();
        expect(screen.getAllByLabelText('Period 1 end').map(e => (e as HTMLInputElement).value)).toContain('2026-06-30T23:59');
        openFirstRow();
        expect(screen.getByTestId('build-block-reason').textContent).toBe(GATE_REASON);

        // Reopen (new window mount, same file): nothing to migrate, nothing written.
        cleanup();
        await mountBuildModel();
        expect(wsWrites()).toBe(1);
        expect(h.files.get(WS_FILE)).toBe(raw);
        expect(screen.getByTestId('rc-legacy-banner')).toBeTruthy(); // still pending: the stored flag, not recomputed
    });

    it('the migrated legacy period is exactly what the PM page sends to Rust once the gate is satisfied', async () => {
        writeDisk(V1);
        await mountBuildModel();
        fireEvent.click(screen.getByText('Keep using all data'));
        await settle(30);
        expect(readDisk().failureGroupState.rcLegacyNotice).toBeNull();
        expect(screen.queryByTestId('rc-legacy-banner')).toBeNull();

        await openPmFor(0); // TAG1 row, Individual tab
        expect(finishBtn().disabled).toBe(false);
        const ranges = [{ start: '2026-01-01T00:00', end: '2026-06-30T23:59' }];
        expect(lastChartFilter().timestamp_ranges).toEqual(ranges);
        expect(lastInvoke('compute_sensor_stats')!.args.filter).toEqual({ timestamp_ranges: ranges, value_filters: [], combine: 'and' });
    });
});

// ─────────────────────────────────────────────────────────────────────────
// (2) one gate: Overview Build reason === PM Finish reason
// ─────────────────────────────────────────────────────────────────────────

describe('(2) the Overview "Build Model" gate and the PM "Finish" gate agree', () => {
    const configured = () => wsState(currentFg([model({ id: 'i1' })], { runningConditionNoneConfirmed: true }));

    const cases: [string, Record<string, unknown>][] = [
        ['the workspace condition is cleared', { runningConditionNoneConfirmed: false }],
        ['the only condition is incomplete (no value)', { runningConditionNoneConfirmed: false, runningConditionFilters: [{ ...COND, value1: '' }] }],
        ['the only condition names a sensor not in the dataset', { runningConditionNoneConfirmed: false, runningConditionFilters: [{ ...COND, sensor: 'GONE' }] }],
        ['a workspace period ends before it starts', { runningConditionTimePeriods: [{ id: 'bad', start: '2026-02-01T00:00', end: '2026-01-01T00:00' }] }],
    ];

    for (const [label, patch] of cases) {
        it(`${label}: a broadcast re-blocks Finish, and Overview shows the SAME reason`, async () => {
            writeDisk(configured());
            await mountBuildModel();
            await openPmFor();
            expect(finishBtn().disabled).toBe(false);

            await otherWindowWrites(patch);
            const pmReason = screen.getByTestId('finish-block-reason').textContent;
            expect(pmReason).toBeTruthy();
            expect(finishBtn().disabled).toBe(true);
            expect(finishBtn().title).toBe(pmReason);
            // ... and it is the shared helper's answer for what is on disk.
            const disk = readDisk().failureGroupState;
            expect(pmReason).toBe(getBuildBlockReason(disk.models[0], disk, HEADERS));
            fireEvent.click(finishBtn());
            await settle(30);
            expect(readDisk().failureGroupState.models[0].status).toBe(false);

            fireEvent.click(screen.getByTitle('Back to Build Model overview'));
            await settle(10);
            expect(screen.getByTestId('build-block-reason').textContent).toBe(pmReason);
            expect((screen.getByText('Build Model →') as HTMLButtonElement).title).toBe(pmReason);
        });
    }

    it('a Custom model with its own configured list can Build and Finish while the workspace is unset, and Finish marks it Complete on disk', async () => {
        writeDisk(wsState(currentFg([model({ id: 'i1', runningConditionMode: 'custom', customRunningConditionFilters: [COND] })])));
        await mountBuildModel();
        expect(screen.getByTestId('rc-required-pill')).toBeTruthy(); // workspace itself is unset
        await openPmFor();
        expect(finishBtn().disabled).toBe(false);
        expect(screen.queryByTestId('pm-rc-required-banner')).toBeNull(); // banner is Workspace-mode only

        fireEvent.click(finishBtn());
        await settle(40);
        expect(readDisk().failureGroupState.models[0].status).toBe(true);
        expect(screen.getByText('Build Model — Overview')).toBeTruthy();
    });

    it('a broadcast that empties a Custom model\'s own list re-blocks Finish (workspace None does not rescue Custom)', async () => {
        writeDisk(wsState(currentFg([model({ id: 'i1', runningConditionMode: 'custom', customRunningConditionFilters: [COND] })], { runningConditionNoneConfirmed: true })));
        await mountBuildModel();
        await openPmFor();
        expect(finishBtn().disabled).toBe(false);
        // NB: the PM page hydrates its Custom list ONCE from disk; a later
        // broadcast updates only the parent's copy. Overview must be blocked
        // after the change, and the PM page keeps the list it is editing.
        await otherWindowWrites({ models: [model({ id: 'i1', runningConditionMode: 'custom', customRunningConditionFilters: [] })] });
        fireEvent.click(screen.getByTitle('Back to Build Model overview'));
        await settle(10);
        expect(screen.getByTestId('build-block-reason').textContent).toBe(GATE_REASON);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// (3) what actually reaches Rust: identical ranges/combine on every path
// ─────────────────────────────────────────────────────────────────────────

describe('(3) the PM page sends one filter to chart, stats and every fit path — and it matches the Rust contract fixture', () => {
    const customOr = contract.pm_payloads[0].json!;
    const customModel = (o: Record<string, unknown>) => model({
        runningConditionMode: 'custom',
        customRunningConditionCombine: 'or',
        customRunningConditionFilters: [
            { id: 'c1', sensor: 'TAG2', operation: 'greater_than', value1: '10', value2: '' },
            { id: 'c2', sensor: 'TAG3', operation: 'between', value1: '1', value2: '5' },
        ],
        filterTimePeriods: [
            { id: 'p1', start: '', end: '2026-01-31T23:59' },
            { id: 'p2', start: '2026-03-01T00:00', end: '' },
        ],
        ...o,
    });
    const keysOk = (obj: Record<string, unknown>, allowed: string[]) =>
        expect(Object.keys(obj).filter(k => !allowed.includes(k))).toEqual([]);

    it('Relationship: chart, target stats and the relationship fit all carry the fixture payload exactly', async () => {
        writeDisk(wsState(currentFg([customModel({ id: 'r1', kind: 'relationship', predictorSensors: ['TAG2'], rcMode: 'relationship', individualChecked: false })])));
        await mountBuildModel();
        await openPmFor();

        const stats = lastInvoke('compute_sensor_stats', a => a.sensor === 'TAG1')!.args.filter;
        expect(stats).toEqual(customOr);
        keysOk(stats, contract.preview_filter_fields);
        for (const r of stats.timestamp_ranges) keysOk(r, contract.time_range_fields);
        for (const v of stats.value_filters) keysOk(v, contract.value_filter_fields);

        const chart = lastChartFilter();
        keysOk(chart, contract.data_filter_fields);
        expect(chart).toEqual({ sensors: ['TAG1'], timestamp_start: null, timestamp_end: null, ...customOr });

        await act(async () => {
            const btn = screen.getByText('Relationship Model').closest('.pm-config-block')!.querySelector('button.pm-btn-primary') as HTMLButtonElement;
            fireEvent.click(btn);
        });
        await settle(20);
        expect(lastInvoke('preview_relationship_model')!.args.filter).toEqual(customOr);
    });

    it('Clustering: the clustering preview and the criteria-sensor stats get the same payload as the chart', async () => {
        writeDisk(wsState(currentFg([customModel({
            id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG3', predictorSensors: ['TAG1'],
            scatterXSensor: 'TAG1', criteriaSensor: 'TAG2', rcMode: 'clustering', individualChecked: false,
        })])));
        await mountBuildModel();
        await openPmFor();

        expect(lastInvoke('compute_sensor_stats', a => a.sensor === 'TAG2')!.args.filter).toEqual(customOr);
        await act(async () => {
            const btn = screen.getByText('Clustering Model').closest('.pm-config-block')!.querySelector('button.pm-btn-primary') as HTMLButtonElement;
            fireEvent.click(btn);
        });
        await settle(20);
        expect(lastInvoke('compute_clustering_preview')!.args.filter).toEqual(customOr);
        const chart = lastChartFilter();
        expect({ timestamp_ranges: chart.timestamp_ranges, value_filters: chart.value_filters, combine: chart.combine }).toEqual(customOr);
    });

    it('Workspace mode with "No condition" and no periods sends filter: null (fixture) and an empty-range chart filter (fixture)', async () => {
        writeDisk(wsState(currentFg([model({ id: 'i1' })], { runningConditionNoneConfirmed: true, runningConditionFilters: [COND] })));
        await mountBuildModel();
        await openPmFor();
        expect(lastInvoke('compute_sensor_stats')!.args.filter).toBe(contract.pm_payloads[1].json);
        expect(lastChartFilter()).toEqual(contract.pm_payloads[2].json);
    });

    it('"No condition" drops value conditions but NOT periods, and combine still rides along (periods are AND-ed on the Rust side)', async () => {
        writeDisk(wsState(currentFg([model({ id: 'i1' })], {
            runningConditionNoneConfirmed: true, runningConditionFilters: [COND], runningConditionCombine: 'or',
            runningConditionTimePeriods: [{ id: 'w1', start: '2026-05-01T00:00', end: '2026-05-31T23:59' }],
        })));
        await mountBuildModel();
        await openPmFor();
        const f = lastInvoke('compute_sensor_stats')!.args.filter;
        expect(f).toEqual({ timestamp_ranges: [{ start: '2026-05-01T00:00', end: '2026-05-31T23:59' }], value_filters: [], combine: 'or' });
        expect(lastChartFilter().timestamp_ranges).toEqual(f.timestamp_ranges);
    });

    // FIXED 2026-09-24 (was a known bug). The gate
    // (`isCompleteCondition`) ignores a `between` row whose max is empty, but
    // `dashboardFilterPayload` only drops rows with an empty value1, so the row
    // still goes to Rust as `between(v1, null)` — and Rust's `keeps()` treats
    // `between` with a missing bound as TRUE. Under AND that is harmless; under
    // OR it matches every row, silently disabling every other OR condition.
    it('only the conditions the gate counts as complete are sent to Rust (an incomplete "between" under OR would match every row)', async () => {
        writeDisk(wsState(currentFg([model({ id: 'i1' })], {
            runningConditionCombine: 'or',
            runningConditionFilters: [COND, { id: 'rc2', sensor: 'TAG3', operation: 'between', value1: '1', value2: '' }],
        })));
        await mountBuildModel();
        await openPmFor();
        expect(finishBtn().disabled).toBe(false); // gate: COND alone configures it
        const sent = lastInvoke('compute_sensor_stats')!.args.filter.value_filters;
        expect(sent).toEqual([{ sensor: 'TAG2', operation: 'greater_than', value1: 10, value2: null }]);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// (4) a stale writer re-adding the old time keys is harmless
// ─────────────────────────────────────────────────────────────────────────

describe('(4) old time keys re-added by a stale writer', () => {
    it('are dropped at the next hydration, never override the stored periods, and never reach the wire', async () => {
        const P = { id: 'w1', start: '2026-04-01T00:00', end: '2026-04-30T23:59' };
        const Q = { id: 'q1', start: '2026-08-01T00:00', end: '2026-08-31T23:59' };
        const state = wsState(currentFg([
            { ...model({ id: 'i1' }), filterTimeStart: '2020-01-01T00:00', filterTimeEnd: '2020-12-31T23:59' },
            { ...model({ id: 'i2', targetSensor: 'TAG2', runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true, filterTimePeriods: [Q] }), filterTimeStart: '2019-01-01T00:00', filterTimeEnd: '' },
        ], {
            runningConditionNoneConfirmed: true,
            runningConditionTimePeriods: [P],
            runningConditionTimeStart: '2020-01-01T00:00', runningConditionTimeEnd: '2020-12-31T23:59',
        }));
        writeDisk(state);
        await mountBuildModel();

        expect(wsWrites()).toBe(1);
        const raw = h.files.get(WS_FILE)!;
        for (const k of LEGACY_KEYS) expect(raw).not.toContain(`"${k}"`);
        const fg = JSON.parse(raw).failureGroupState;
        expect(fg.runningConditionTimePeriods).toEqual([P]);
        expect(fg.models.find((m: any) => m.id === 'i2').filterTimePeriods).toEqual([Q]);

        await openPmFor(0); // i1 — Workspace mode
        expect(lastChartFilter().timestamp_ranges).toEqual([{ start: P.start, end: P.end }]);
        expect(JSON.stringify(h.invokes)).not.toContain('2020-');

        // A stale copy landing on disk AFTER this window hydrated (and the PM page
        // reading it directly) still resolves to the periods, not the old pair.
        fireEvent.click(screen.getByTitle('Back to Build Model overview'));
        await settle(10);
        const stale = readDisk();
        stale.failureGroupState.models = stale.failureGroupState.models.map((m: any) => ({ ...m, filterTimeStart: '2019-01-01T00:00', filterTimeEnd: '2019-12-31T23:59' }));
        writeDisk(stale);
        h.invokes.length = 0;
        const rows = screen.getAllByTestId('sensor-row-label');
        fireEvent.click(rows[rows.length - 1]); // TAG2 row
        await act(async () => { fireEvent.click(screen.getAllByText('Build Model →').slice(-1)[0]); });
        await waitFor(() => expect(screen.getByText('Finish')).toBeTruthy());
        await settle(30);
        expect(lastInvoke('compute_sensor_stats')!.args.filter.timestamp_ranges).toEqual([{ start: Q.start, end: Q.end }]);
        expect(JSON.stringify(h.invokes)).not.toContain('2019-');
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Regressions found in the sweep (documented as expected failures)
// ─────────────────────────────────────────────────────────────────────────

describe('PM page edits made right before leaving the page', () => {
    // KNOWN BUG (qa 2026-09-24) — flip to `it` once fixed. The PM page persists
    // config through a 250 ms debounced effect whose cleanup is clearTimeout.
    // Finish/Back call onFinish/onBack synchronously, which unmounts the page
    // and cancels the pending write, so an edit made < 250 ms before (e.g. a
    // period committed by the blur that clicking Finish itself causes) is lost.
    it('a period edited and committed by clicking Finish is saved together with Complete', async () => {
        const P = { id: 'p1', start: '2026-01-01T00:00', end: '2026-01-31T23:59' };
        writeDisk(wsState(currentFg([model({ id: 'i1', runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true, filterTimePeriods: [P] })])));
        await mountBuildModel();
        await openPmFor();

        const end = screen.getByLabelText('Period 1 end');
        fireEvent.change(end, { target: { value: '2026-02-15T12:00' } });
        fireEvent.blur(end); // what mousedown on Finish does
        fireEvent.click(finishBtn());
        await settle(400);

        const m = readDisk().failureGroupState.models[0];
        expect(m.status).toBe(true);
        expect(m.filterTimePeriods).toEqual([{ ...P, end: '2026-02-15T12:00' }]);
    });

    // KNOWN BUG (qa 2026-09-24) — flip to `it` once fixed. Finish is enabled
    // from the PM page's LIVE state, but `markModelComplete` re-checks the gate
    // against the parent's STORED copy, which lags by the same 250 ms debounce.
    // When the edit that satisfied the gate is < 250 ms old, Finish silently
    // returns to the overview without marking Complete (and the edit is lost).
    it('Finish right after re-confirming Custom "No condition" marks the model Complete', async () => {
        writeDisk(wsState(currentFg([model({ id: 'i1', runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true })])));
        await mountBuildModel();
        await openPmFor();
        const box = screen.getByLabelText('No condition — use all rows') as HTMLInputElement;
        fireEvent.click(box); // un-confirm -> blocked
        await settle(400); // persisted + broadcast: the parent now stores "unset"
        expect(finishBtn().disabled).toBe(true);
        fireEvent.click(screen.getByLabelText('No condition — use all rows')); // confirm again
        expect(finishBtn().disabled).toBe(false);
        fireEvent.click(finishBtn());
        await settle(400);

        const m = readDisk().failureGroupState.models[0];
        expect(m.status).toBe(true);
        expect(m.customRunningConditionNoneConfirmed).toBe(true);
    });
});

describe('a brand-new workspace (never opened before Feature 4)', () => {
    // FIXED 2026-09-24. Models are only ever created on the Dashboard, so the
    // Build Model window is always opened for the first time with models
    // present. Dashboard's first-model creation now seeds `rcLegacyNotice: null`
    // (see Feature4CrossWindow's end-to-end test), so `flagLegacyGate` leaves it
    // alone. A workspace WITHOUT the marker is still flagged (real legacy).
    it('does not show the legacy banner once Dashboard has seeded the markers', async () => {
        writeDisk(wsState({ models: [model({ id: 'i1', category: null }), model({ id: 'i2', targetSensor: 'TAG2', category: null })], rcLegacyNotice: null, categoryNormalisationNotice: null, runningConditionTimePeriods: [] }));
        await mountBuildModel();
        expect(screen.queryByTestId('rc-legacy-banner')).toBeNull();
    });

    it('a workspace with models and NO marker (genuinely pre-gate) is still flagged', async () => {
        writeDisk(wsState({ models: [model({ id: 'i1', category: null })], runningConditionTimePeriods: [] }));
        await mountBuildModel();
        expect(screen.getByTestId('rc-legacy-banner')).toBeTruthy();
    });
});

describe('reason text consistency', () => {
    // KNOWN BUG (cosmetic, qa 2026-09-24) — flip to `it` once fixed. For a
    // missing category the Overview footer shows `modelBlockReason`'s text
    // ("...sensor header", no period) while the status pill, `trainModel`,
    // `markModelComplete` and the PM Finish button use `getBuildBlockReason`
    // ("...sensor header."), so the two surfaces disagree on the same model.
    it('Overview Build reason and the shared gate reason are the same string for a model without a category', async () => {
        writeDisk(wsState(currentFg([model({ id: 'i1', category: null })], { runningConditionNoneConfirmed: true })));
        await mountBuildModel();
        openFirstRow();
        const footer = screen.getByTestId('build-block-reason').textContent;
        const pill = within(screen.getByTestId('add-model-form')).getByText('Incomplete') as HTMLButtonElement;
        expect(footer).toBe(pill.title);
    });
});
