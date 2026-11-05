import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup, waitFor, within } from '@testing-library/react';
import contract from '../../src-tauri/tests/fixtures/filter_contract.json';

/* Cross-zone Build Model flow: real workspaceManager over in-memory plugin-fs and a shared event bus. Only the Tauri boundary and charts are stubbed; invoke args are recorded. */

const h = vi.hoisted(() => ({
    listeners: {} as Record<string, Set<(e: any) => void>>,
    emitted: [] as { event: string; payload: any }[],
    files: new Map<string, string>(),
    writes: [] as string[],
    store: new Map<string, unknown>(),
    invokes: [] as { cmd: string; args: any }[],
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
    // Workspace saves go to a temp file, then rename; record the write when it lands.
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

const STATS = { mean: 5, sd: 1, min: 0, max: 10, count: 100, lower1: 4, upper1: 6, lower3: 2, upper3: 8 };
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (cmd: string, args?: unknown) => {
        h.invokes.push({ cmd, args: JSON.parse(JSON.stringify(args ?? null)) });
        switch (cmd) {
            case 'get_dataset_time_bounds': return Promise.resolve({ min: '2026-01-01T00:00:00', max: '2026-12-31T23:59:00' });
            case 'compute_health_preview': return Promise.resolve(makeSetPointAwarePreview((args as any)?.request));
            case 'compute_sensor_stats': return Promise.resolve(STATS);
            case 'preview_relationship_model': return Promise.resolve({
                request: 'r', error: undefined, n_rows: 3, predicted: [1, 2, 3],
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

vi.mock('../components/charts/ResponsiveECharts', () => ({ default: () => <div data-testid="echarts-mock" /> }));

import BuildModelWindow from '../components/windows/BuildModelWindow';
import { makeSetPointAwarePreview } from './helpers/healthPreviewFixture';
import { markCompleteFromHealthPage } from './helpers/healthPage';
import { emit } from '@tauri-apps/api/event';
import { updateWorkspaceData } from '../workspaceManager';
import { withFailureGroupState } from '../utils/failureGroupState';
import { getBuildBlockReason, NO_RUNNING_CONDITION_REASON } from '../utils/runningCondition';
import { preflightReason, TRAIN_NEEDS_RUNNING_CONDITION } from '../utils/trainQueue';
// A train period is required to Train, a scoring period to Mark complete.
import { ALL_TIME_TRAIN, ONE_TEST, rcOn } from './helpers/trainTestFixture';


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
const GATE_REASON = NO_RUNNING_CONDITION_REASON;
const COND = { ...rcOn('TAG2', '10'), id: 'rc1' };

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

/** Set points the `makeSetPointAwarePreview` fixture accepts (Individual 3SD band 2..8): Mark complete needs them. */
const VALID_SP = { kind: 'individual', lower: 1, upper: 9, masterLower: 1, masterUpper: 9 };

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
        models, runningConditionFilters: [], runningConditionCombine: 'and', runningConditionTimePeriods: ALL_TIME_TRAIN, runningConditionTestPeriods: ONE_TEST,
        runningConditionNoneConfirmed: false, rcLegacyNotice: null, categoryNormalisationNotice: null, ...extra,
    };
}

const writeDisk = (s: unknown) => h.files.set(WS_FILE, JSON.stringify(s));
const readDisk = () => JSON.parse(h.files.get(WS_FILE)!);
const wsWrites = () => h.writes.filter(p => p === WS_FILE).length;

async function settle(ms = 0) {
    await act(async () => { await new Promise(r => setTimeout(r, ms)); });
}

/** Mount the window; a stand-in for Dashboard answers its data request.
 *  Waits for the Workbench's running-condition card. */
async function mountBuildModel() {
    render(<BuildModelWindow />);
    await waitFor(() => expect(screen.getByTestId('rc-card')).toBeTruthy());
    await settle(30);
}

/** The "Edit…" modal wrapping RunningConditionPanel (auto-opens at hydration
 *  when the workspace running condition is unset). */
const rcModal = () => screen.queryByRole('dialog', { name: 'Running condition' });
/** Close the modal as a user must; its backdrop covers the window. No-op if closed. */
function closeRcModal() {
    const d = rcModal();
    if (d) fireEvent.click(within(d).getByLabelText('Close'));
    expect(rcModal()).toBeNull();
}

/** Another window (Dashboard) writes the slice and broadcasts it. */
async function otherWindowWrites(patch: Record<string, unknown>, origin = 'dashboard') {
    await act(async () => {
        const next = await updateWorkspaceData('ws1', prev => withFailureGroupState(prev, patch as any));
        await emit('failure-group-state-changed', { ...next!.failureGroupState, workspaceId: 'ws1', origin });
    });
    await settle(10);
}

/** Select a sensor in the Workbench's left list (the detail pane then shows
 *  its first model tab — Individual when it has one). */
const selectSensorRow = (rowIndex = 0) => fireEvent.click(screen.getAllByTestId('sensor-row-label')[rowIndex]);
const openFirstRow = () => { closeRcModal(); selectSensorRow(0); };
/** The detail header's Train sensor button. */
const trainBtn = () => screen.getByTestId('train-sensor') as HTMLButtonElement;
/** Train button title when blocked: the 'set the running condition' reason while Step 1 is unset, else the model's reason. */
const blockedTitle = (reason: string) => screen.getByTestId('rc-card').getAttribute('data-state') === 'unset'
    ? TRAIN_NEEDS_RUNNING_CONDITION
    : `Can't train: Individual — ${preflightReason(reason).text}`;

/* Identify Train's `compute_sensor_stats` call: mark before the click, wait for the first matching call after it; never 'the newest call' or a fixed sleep. Where another call could match, the trained target isn't `HEADERS[0]` and the predicate names it. */
const firstSince = (mark: number, cmd: string, pred: (a: any) => boolean = () => true) =>
    h.invokes.slice(mark).find(c => c.cmd === cmd && pred(c.args));

/** Press the (already selected) sensor's Train button; returns the mark taken just before the click. */
async function clickTrain(): Promise<number> {
    const mark = h.invokes.length;
    await act(async () => { fireEvent.click(trainBtn()); });
    return mark;
}

/** Select a row and press Train; returns the invoke mark taken before the click (pass to `trainCall`). */
async function trainRow(rowIndex = 0): Promise<number> {
    closeRcModal();
    selectSensorRow(rowIndex);
    return clickTrain();
}

/** The first `cmd` call Train made after `mark` (waits for it - no fixed sleep). */
async function trainCall(mark: number, cmd: string, pred: (a: any) => boolean = () => true) {
    await waitFor(() => expect(firstSince(mark, cmd, pred)).toBeTruthy());
    return firstSince(mark, cmd, pred)!;
}

/** Wait for `lastTrainedAt` on disk: the run really finished, so no write lands in the next test. */
async function trained(modelId: string) {
    await waitFor(() => expect(readDisk().failureGroupState.models.find((m: any) => m.id === modelId).lastTrainedAt).toBeTruthy());
    await settle(0);
}

const lastInvoke = (cmd: string, pred: (a: any) => boolean = () => true) =>
    [...h.invokes].reverse().find(c => c.cmd === cmd && pred(c.args));

beforeEach(() => {
    for (const k of Object.keys(h.listeners)) delete h.listeners[k];
    h.emitted.length = 0;
    h.files.clear();
    h.writes.length = 0;
    h.store.clear();
    h.invokes.length = 0;
    // Dashboard's role in the handshake: answer the data request.
    h.listeners['request-build-model-data'] = new Set([() => { void emit('build-model-data', BUILD_DATA); }]);
});

afterEach(() => {
    cleanup();
});


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

    it('is normalised and migrated to one period, written back ONCE with no legacy keys, and reopening changes nothing', async () => {
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
        // Never-set running condition: nothing to convert, no notice, not silently confirmed.
        expect(fg.runningConditionConversion).toBeNull();
        expect(fg.rcLegacyNotice).toBeUndefined();
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

        // What the user sees is the stored result (no running-condition notice:
        // there was no old condition to convert).
        expect(screen.queryByTestId('rc-conversion-notice')).toBeNull();
        expect(screen.getByTestId('category-normalisation-notice')).toBeTruthy();
        // The unset workspace auto-opens the Running condition modal; the bar says Required.
        expect(screen.getByTestId('rc-card').getAttribute('data-state')).toBe('unset');
        expect(rcModal()).toBeTruthy();
        expect(screen.getByTestId('rc-required-pill')).toBeTruthy();
        expect(screen.getAllByLabelText('P1 end').map(e => (e as HTMLInputElement).value)).toContain('2026/06/30 23:59');
        openFirstRow();
        expect(screen.getByTestId('build-block-reason').textContent).toBe(GATE_REASON);

        // Reopen (new window mount, same file): nothing to migrate, nothing written.
        cleanup();
        await mountBuildModel();
        expect(wsWrites()).toBe(1);
        expect(h.files.get(WS_FILE)).toBe(raw);
        expect(screen.getByTestId('rc-card').getAttribute('data-state')).toBe('unset'); // still Not set, and still auto-opened
        expect(rcModal()).toBeTruthy();
    });

    it('the migrated legacy period is exactly what Train sends to Rust once the gate is satisfied', async () => {
        writeDisk(V1);
        await mountBuildModel();
        closeRcModal(); // auto-opened (unset workspace)
        // The one condition is set ("Machine is running when TAG2 is above 10").
        await otherWindowWrites({ runningConditionFilters: [COND] });
        closeRcModal();
        selectSensorRow(0); // TAG1 row, Individual tab
        expect(trainBtn().disabled).toBe(false);
        // Step-1 row count was asked before this mark; the first TAG1 stats call after it is Train's.
        const mark = await clickTrain();
        const ranges = [{ start: '2026-01-01T00:00', end: '2026-06-30T23:59' }];
        expect((await trainCall(mark, 'compute_sensor_stats', a => a.sensor === 'TAG1')).args.filter).toEqual({ timestamp_ranges: ranges, value_filters: [{ sensor: 'TAG2', operation: 'greater_than', value1: 10, value2: null }], combine: 'and' });
        await trained('i1');
    });
});


describe('(2) the Workbench notice-line reason and the Train button agree with the shared gate helper', () => {
    const configured = () => wsState(currentFg([model({ id: 'i1' })], { runningConditionFilters: [COND] }));

    const cases: [string, Record<string, unknown>][] = [
        ['the workspace condition is cleared', { runningConditionFilters: [] }],
        ['the only condition is incomplete (no value)', { runningConditionFilters: [{ ...COND, value1: '' }] }],
        ['the only condition names a sensor not in the dataset', { runningConditionFilters: [{ ...COND, sensor: 'GONE' }] }],
        ['a workspace period ends before it starts', { runningConditionTimePeriods: [{ id: 'bad', start: '2026-02-01T00:00', end: '2026-01-01T00:00' }] }],
    ];

    for (const [label, patch] of cases) {
        it(`${label}: a broadcast re-blocks Train, and the notice line shows the SAME reason`, async () => {
            writeDisk(configured());
            await mountBuildModel();
            closeRcModal();
            selectSensorRow(0);
            expect(trainBtn().disabled).toBe(false);

            await otherWindowWrites(patch);
            closeRcModal(); // an unset workspace re-opens the settings modal
            const reason = screen.getByTestId('build-block-reason').textContent;
            expect(reason).toBeTruthy();
            expect(trainBtn().disabled).toBe(true);
            expect(trainBtn().title).toBe(blockedTitle(reason!));
            // ... and it is the shared helper's answer for what is on disk.
            const disk = readDisk().failureGroupState;
            expect(reason).toBe(getBuildBlockReason(disk.models[0], disk, HEADERS));
            // Mark complete is not on this page at all (it lives on the Health score page, locked here).
            expect(screen.queryByText('✓ Mark complete')).toBeNull();
            expect(screen.getByTestId('page-tab-health').getAttribute('aria-disabled')).toBe('true');
            fireEvent.click(trainBtn());
            await settle(30);
            expect(readDisk().failureGroupState.models[0].status).toBe(false);
            expect(readDisk().failureGroupState.models[0].lastTrainedAt).toBeFalsy(); // a blocked Train never stamps the model
        });
    }

    it('a Custom model with its own configured list can Train and be marked Complete (through the Health score page) while the workspace is unset', async () => {
        writeDisk(wsState(currentFg([model({ id: 'i1', runningConditionMode: 'custom', customRunningConditionFilters: [COND], filterTimePeriods: ALL_TIME_TRAIN, customTestPeriods: ONE_TEST, healthSetPoints: VALID_SP })])));
        await mountBuildModel();
        // workspace itself is unset: the bar says Required, and the auto-opened modal's panel too
        expect(screen.getByTestId('rc-card').getAttribute('data-state')).toBe('unset');
        expect(screen.getByTestId('rc-required-pill')).toBeTruthy();
        await trainRow(0);
        await trained('i1');

        await markCompleteFromHealthPage('individual');
        expect(readDisk().failureGroupState.models[0].status).toBe(true);
    });

    it('a broadcast that empties a Custom model\'s own list re-blocks Train (a set workspace condition does not rescue Custom)', async () => {
        writeDisk(wsState(currentFg([model({ id: 'i1', runningConditionMode: 'custom', customRunningConditionFilters: [COND], filterTimePeriods: ALL_TIME_TRAIN })], { runningConditionFilters: [COND] })));
        await mountBuildModel();
        closeRcModal();
        selectSensorRow(0);
        expect(trainBtn().disabled).toBe(false);
        await otherWindowWrites({ models: [model({ id: 'i1', runningConditionMode: 'custom', customRunningConditionFilters: [], filterTimePeriods: ALL_TIME_TRAIN })] });
        expect(screen.getByTestId('build-block-reason').textContent).toBe('Pick the sensor and the value under “When the machine is running” above'); // its OWN condition, and Model settings opened by itself: the reason says where to fix it
        expect(trainBtn().disabled).toBe(true);
    });
});


describe('(3) Train sends one filter to stats and every fit path - and it matches the Rust contract fixture', () => {
    // Contract fixture's Custom payload with a model's one condition (its first value filter, TAG2 > 10); the rest is the fixture's.
    const fixture = contract.pm_payloads[0].json!;
    const customOne = { ...fixture, value_filters: [fixture.value_filters[0]], combine: 'and' };
    const customModel = (o: Record<string, unknown>) => model({
        runningConditionMode: 'custom',
        customRunningConditionCombine: 'and',
        customRunningConditionFilters: [{ ...COND, id: 'c1' }],
        filterTimePeriods: [
            { id: 'p1', start: '', end: '2026-01-31T23:59' },
            { id: 'p2', start: '2026-03-01T00:00', end: '' },
        ],
        ...o,
    });
    const keysOk = (obj: Record<string, unknown>, allowed: string[]) =>
        expect(Object.keys(obj).filter(k => !allowed.includes(k))).toEqual([]);

    it('Relationship: the relationship fit (and the health preview that follows it) carry the fixture payload exactly', async () => {
        writeDisk(wsState(currentFg([customModel({ id: 'r1', kind: 'relationship', predictorSensors: ['TAG2'], rcMode: 'relationship', individualChecked: false })])));
        await mountBuildModel();
        const mark = await trainRow(0);

        const fit = (await trainCall(mark, 'preview_relationship_model')).args.filter;
        expect(fit).toEqual(customOne);
        keysOk(fit, contract.preview_filter_fields);
        for (const r of fit.timestamp_ranges) keysOk(r, contract.time_range_fields);
        for (const v of fit.value_filters) keysOk(v, contract.value_filter_fields);

        await waitFor(() => expect(lastInvoke('compute_health_preview')).toBeTruthy());
        expect(lastInvoke('compute_health_preview')!.args.request.filter).toEqual(customOne);
        await trained('r1');
    });

    it('Individual: the stats call gets the fixture payload; Clustering: the clustering preview and the criteria-sensor stats get the same one', async () => {
        // Target TAG2, not HEADERS[0]: the Custom model's debounced row count (always TAG1) can't be mistaken for Train's call.
        writeDisk(wsState(currentFg([customModel({ id: 'i1', targetSensor: 'TAG2' })])));
        await mountBuildModel();
        const markI = await trainRow(0);
        const stats = (await trainCall(markI, 'compute_sensor_stats', a => a.sensor === 'TAG2')).args.filter;
        expect(stats).toEqual(customOne);
        keysOk(stats, contract.preview_filter_fields);
        await trained('i1');
        // Train asked for the target's stats exactly once (the row count never asks for TAG2).
        expect(h.invokes.filter(c => c.cmd === 'compute_sensor_stats' && c.args.sensor === 'TAG2')).toHaveLength(1);
        cleanup();

        h.invokes.length = 0;
        writeDisk(wsState(currentFg([customModel({
            id: 'c1', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG3', predictorSensors: ['TAG1'],
            scatterXSensor: 'TAG1', criteriaSensor: 'TAG2', rcMode: 'clustering', individualChecked: false,
        })])));
        await mountBuildModel();
        const markC = await trainRow(0);
        expect((await trainCall(markC, 'compute_clustering_preview')).args.filter).toEqual(customOne);
        await trained('c1');
        // The criteria sensor (TAG2, not the row count's TAG1) is only ever asked with the model's own scope.
        const criteria = h.invokes.filter(c => c.cmd === 'compute_sensor_stats' && c.args.sensor === 'TAG2');
        expect(criteria.length).toBeGreaterThan(0);
        for (const c of criteria) expect(c.args.filter).toEqual(customOne);
    });

    it('Workspace mode: the one condition and the train period both reach Rust ("Use all rows" is gone, so the filter is never null)', async () => {
        writeDisk(wsState(currentFg([model({ id: 'i1' })], {
            runningConditionFilters: [COND],
            runningConditionTimePeriods: [{ id: 'w1', start: '2026-05-01T00:00', end: '2026-05-31T23:59' }],
        })));
        await mountBuildModel();
        const mark = await trainRow(0);
        const f = (await trainCall(mark, 'compute_sensor_stats', a => a.sensor === 'TAG1')).args.filter;
        expect(f).toEqual({
            timestamp_ranges: [{ start: '2026-05-01T00:00', end: '2026-05-31T23:59' }],
            value_filters: [{ sensor: 'TAG2', operation: 'greater_than', value1: 10, value2: null }],
            combine: 'and',
        });
        keysOk(f, contract.preview_filter_fields);
        await trained('i1');
    });

    // A `between` row with an empty max is not sent to Rust: under OR it would match every row and disable the other conditions.
    it('only the conditions the gate counts as complete are sent to Rust (an incomplete "between" under OR would match every row)', async () => {
        writeDisk(wsState(currentFg([model({ id: 'i1' })], {
            runningConditionCombine: 'or',
            runningConditionFilters: [COND, { id: 'rc2', sensor: 'TAG3', operation: 'between', value1: '1', value2: '' }],
        })));
        await mountBuildModel();
        closeRcModal();
        selectSensorRow(0);
        expect(trainBtn().disabled).toBe(false); // gate: COND alone configures it
        const mark = await clickTrain();
        const sent = (await trainCall(mark, 'compute_sensor_stats', a => a.sensor === 'TAG1')).args.filter.value_filters;
        expect(sent).toEqual([{ sensor: 'TAG2', operation: 'greater_than', value1: 10, value2: null }]);
        await trained('i1');
    });
});


describe('(4) old time keys re-added by a stale writer', () => {
    it('are dropped at the next hydration, never override the stored periods, and never reach the wire', async () => {
        const P = { id: 'w1', start: '2026-04-01T00:00', end: '2026-04-30T23:59' };
        const Q = { id: 'q1', start: '2026-08-01T00:00', end: '2026-08-31T23:59' };
        const state = wsState(currentFg([
            { ...model({ id: 'i1' }), filterTimeStart: '2020-01-01T00:00', filterTimeEnd: '2020-12-31T23:59' },
            { ...model({ id: 'i2', targetSensor: 'TAG2', runningConditionMode: 'custom', customRunningConditionFilters: [COND], filterTimePeriods: [Q] }), filterTimeStart: '2019-01-01T00:00', filterTimeEnd: '' },
        ], {
            runningConditionFilters: [COND],
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

        const markW = await trainRow(0); // i1 - Workspace mode
        expect((await trainCall(markW, 'compute_sensor_stats', a => a.sensor === 'TAG1')).args.filter.timestamp_ranges).toEqual([{ start: P.start, end: P.end }]);
        await trained('i1');
        expect(JSON.stringify(h.invokes)).not.toContain('2020-');

        // A stale copy puts the old keys back on every model; after reopening, hydration drops them and the periods still win.
        cleanup();
        const stale = readDisk();
        stale.failureGroupState.models = stale.failureGroupState.models.map((m: any) => ({ ...m, filterTimeStart: '2019-01-01T00:00', filterTimeEnd: '2019-12-31T23:59' }));
        writeDisk(stale);
        h.invokes.length = 0;
        await mountBuildModel();
        const rows = screen.getAllByTestId('sensor-row-label');
        selectSensorRow(rows.length - 1); // TAG2 row
        expect(screen.getByRole('heading', { level: 3 }).querySelector('.sl-desc')?.textContent).toBe('Pump Temp'); // detail pane is TAG2's
        // i2 is Custom on TAG2: its debounced row count asks TAG1, so name the target; only Train asks TAG2.
        const markQ = await clickTrain();
        expect((await trainCall(markQ, 'compute_sensor_stats', a => a.sensor === 'TAG2')).args.filter.timestamp_ranges).toEqual([{ start: Q.start, end: Q.end }]);
        await trained('i2');
        expect(JSON.stringify(h.invokes)).not.toContain('2019-');
    });
});


describe('a brand-new workspace (never opened before Feature 4)', () => {
    // A never-set running condition is not an old project to convert: no notice, the card says Not set, the modal auto-opens.
    it('a workspace with models and nothing set: Not set + the modal auto-opens, no conversion notice, nothing written', async () => {
        writeDisk(wsState({ models: [model({ id: 'i1', category: null }), model({ id: 'i2', targetSensor: 'TAG2', category: null })], categoryNormalisationNotice: null, runningConditionTimePeriods: [] }));
        await mountBuildModel();
        expect(screen.getByTestId('rc-card').getAttribute('data-state')).toBe('unset');
        expect(screen.getByTestId('rc-card-pill').textContent).toBe('Not set');
        expect(rcModal()).toBeTruthy();
        expect(screen.queryByTestId('rc-conversion-notice')).toBeNull();
        expect(wsWrites()).toBe(0);
    });
});

describe('reason text consistency', () => {
    // Missing category: the footer and the Mark complete title must show the same gate reason string.
    it('Overview Build reason and the shared gate reason are the same string for a model without a category', async () => {
        writeDisk(wsState(currentFg([model({ id: 'i1', category: null })], { runningConditionFilters: [COND] })));
        await mountBuildModel();
        openFirstRow();
        const footer = screen.getByTestId('build-block-reason').textContent;
        // Mark complete isn't on this page and Health score stays locked; Train sensor carries the footer's reason.
        expect(screen.queryByText('✓ Mark complete')).toBeNull();
        expect(screen.getByTestId('page-tab-health').getAttribute('aria-disabled')).toBe('true');
        const train = trainBtn();
        expect(train.disabled).toBe(true);
        // Same reason, in the preflight wording ("above" reads wrong there).
        expect(train.title).toBe(blockedTitle(footer!));
        // The results area lists the same single blocker, not "Not trained yet".
        expect(within(screen.getByTestId('results-incomplete')).getByText('Pick a category')).toBeTruthy();
        expect(screen.queryByText('Not trained yet')).toBeNull();
        const disk = readDisk().failureGroupState;
        expect(footer).toBe(getBuildBlockReason(disk.models[0], disk, HEADERS));
    });
});
