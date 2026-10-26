import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

/*
 * Spec:
 * docs/design/handoff/workbench-redesign/README.md §5 (running-condition modal),
 * with the real Dashboard + real Build Model window + real
 * `workspaceManager` on one in-memory workspace file, the fake Rust backend
 * with its REAL `count_period_rows`:
 *
 *   1. Apply across windows: the impact line's N is the number of models whose
 *      dot actually changes after Apply — in the Build Model list AND on the
 *      Dashboard's Failure Groups tab; Custom-mode models are untouched; the
 *      retrain notice counts down as models are trained (Train sensor, then
 *      Train all) and goes away; a scoring-only change asks for Mark complete
 *      again and re-trains nothing.
 *   2. Period counts: how many `count_period_rows` calls the window makes, and
 *      that the one-line card always counts what is ON DISK.
 *   3. Date entry against the real counts: a complete date takes effect before
 *      Apply, a half-typed one never reaches the disk.
 *
 * Covered elsewhere and NOT repeated here:
 *   - what the workspace file and both windows look like AFTER a scoring-only
 *     Apply (testsChangedAt, the notice text, Mark complete again, restart):
 *     `ScoringPeriodsLegacyWorkspace.integration.test.tsx`, steps 4–6;
 *   - every wording / state of the modal in one window with mocked storage:
 *     `BuildModelWindow.test.tsx` ("change warnings…", "settings modal: structure…").
 */

const fsHold = vi.hoisted(() => ({ gate: null as null | { path: string; wait: Promise<void>; entered: boolean } }));

vi.mock('@tauri-apps/api/event', async () => (await import('./helpers/healthEnv')).eventModule());
vi.mock('@tauri-apps/plugin-fs', async () => {
    const m = (await import('./helpers/healthEnv')).fsModule();
    return {
        ...m,
        // A workspace save is "write a temp sibling, rename it over the file": the test can
        // hold the rename of ONE workspace file (a slow disk) and release it later.
        rename: async (from: string, to: string) => {
            const g = fsHold.gate;
            if (g && g.path === to) { g.entered = true; await g.wait; }
            return m.rename(from, to);
        },
    };
});
vi.mock('@tauri-apps/plugin-store', async () => (await import('./helpers/healthEnv')).storeModule());
vi.mock('@tauri-apps/api/core', async () => (await import('./helpers/healthEnv')).coreModule());
vi.mock('@tauri-apps/api/window', async () => (await import('./helpers/healthEnv')).windowModule());
vi.mock('../components/charts/ResponsiveECharts', async () => (await import('./helpers/healthEnv')).chartModule());
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
vi.mock('../hooks/useChartData', () => ({ useChartData: () => ({ view: null, loading: false, error: null }) }));
vi.mock('../hooks/useScatterSample', () => ({
    useScatterSample: () => ({ rows: [], headers: [], total: 0, sampled: 0, loading: false, error: null }),
}));
vi.mock('../components/charts/LineChart', () => ({ default: () => <div /> }));

import { env, resetEnv } from './helpers/healthEnv';
import {
    COND, WS, bmw, bmwDot, bmwEl, dash, dashDot, diskModel, model, mountWindows, newBackend, openDashFgTab, openHealth,
    readDisk, selectSensor, sendBuildModelData, settle, typeSp, blurSp, waitForCharts, writeDisk, wsFile, wsTrained,
} from './helpers/healthWorkbench';
import { computeTrainFingerprint } from '../utils/trainFingerprint';

vi.setConfig({ testTimeout: 60_000 });

beforeEach(() => {
    resetEnv();
    newBackend();
    fsHold.gate = null;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// The plant dataset: 60 hourly rows, 2026-01-01 00:00 … 2026-01-03 11:00. TAG2 = the row number,
// so "TAG2 > 10" keeps rows 11..59.
const P1 = { id: 'p1', start: '2026-01-01T00:00', end: '2026-01-02T23:00' }; // rows 0..47 → 37 running
const S1 = { id: 's1', start: '2026-01-03T00:00', end: '2026-01-03T11:00' }; // rows 48..59 → 12 running
const OWN_TRAIN = [{ id: 'ct', start: '2026-01-01T00:00', end: '2026-01-02T00:00' }];
const OWN_TEST = [{ id: 'cs', start: '2026-01-02T06:00', end: '2026-01-02T20:00' }];
const SP1 = { kind: 'individual', lower: 20, upper: 80, masterLower: 20, masterUpper: 80 };
const SP_WIDE = { kind: 'individual', lower: -500, upper: 500, masterLower: null, masterUpper: null };
// (`scoringIntervalSecs`: a record as THIS build writes it — the saved results use 1-hour averages; one without it gets the footer's "earlier row-by-row scoring" hint, covered in BuildModelWindow.test.tsx)
const record = (setPoints: unknown) => ({ at: '2026-10-05T08:00:00.000Z', outputDir: env.backend!.outputDir(WS), setPoints, scoringIntervalSecs: 3600 });

/**
 * FG-A: i1 (Individual TAG1, trained) + r1 (Relation model TAG1 <- TAG3, trained),
 *       i3 (Individual TAG3, COMPLETE).
 * FG-B: i5 (Individual TAG5, COMPLETE, on its OWN running condition),
 *       i4 (Individual TAG4, never trained).
 */
function fiveModels(fg: Record<string, unknown> = {}) {
    return wsTrained({ runningConditionTimePeriods: [P1], runningConditionTestPeriods: [S1], ...fg }, [
        model({ id: 'i1', name: 'Pressure band', targetSensor: 'TAG1', healthSetPoints: SP1, healthVerdict: 'valid' }),
        model({ id: 'r1', name: 'Pressure from flow', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG3'] }),
        model({ id: 'i3', name: 'Flow band', targetSensor: 'TAG3', status: true, healthSetPoints: SP_WIDE, healthVerdict: 'valid', healthExport: record(SP_WIDE) }),
        model({
            id: 'i5', name: 'Temp band', targetSensor: 'TAG5', groupNos: [2], status: true,
            runningConditionMode: 'custom', customRunningConditionFilters: [COND], filterTimePeriods: OWN_TRAIN, customTestPeriods: OWN_TEST,
            healthSetPoints: SP_WIDE, healthVerdict: 'valid', healthExport: record(SP_WIDE),
        }),
        // (the empty set points are what the load-time migration gives a model that has none)
        model({ id: 'i4', name: 'Mode band', targetSensor: 'TAG4', groupNos: [2], healthSetPoints: { kind: 'individual', lower: null, upper: null } }),
    ]);
}
/** `wsTrained` stamps EVERY model; i4 must be a model that was never trained. */
function seed(fg: Record<string, unknown> = {}) {
    const s = fiveModels(fg) as any;
    const m = s.failureGroupState.models.find((x: any) => x.id === 'i4');
    delete m.lastTrainedAt;
    delete m.trainedFingerprint;
    writeDisk(s);
    return s;
}

const MODELS = [
    { id: 'i1', g: 1, key: 'tag1', kind: 'individual' },
    { id: 'r1', g: 1, key: 'tag1', kind: 'relationship' },
    { id: 'i3', g: 1, key: 'tag3', kind: 'individual' },
    { id: 'i5', g: 2, key: 'tag5', kind: 'individual' },
    { id: 'i4', g: 2, key: 'tag4', kind: 'individual' },
] as const;
const listDots = () => Object.fromEntries(MODELS.map(m => [m.id, bmwDot(m.id).state]));
const dashDots = () => Object.fromEntries(MODELS.map(m => [m.id, dashDot(m.g, m.key, m.kind)]));
const changed = (a: Record<string, string>, b: Record<string, string>) => MODELS.map(m => m.id).filter(id => a[id] !== b[id]);

const wsWrites = (id = WS) => env.writes.filter(w => w.path === wsFile(id)).length;
const counts = () => env.backend!.cmds('count_period_rows');
/** Running rows Rust answered for the LAST count (what the card's "nothing to train on" verdict reads). */
const lastCountRows = () => (counts().slice(-1)[0]?.result as { union: { running_rows: number } } | undefined)?.union.running_rows;
/**
 * User decision 2026-10-14: the Build Model window never says how many data rows are used.
 * The card prints NO count whatever `count_period_rows` answered — no "N rows · x%", no
 * "Counting rows…", no "— rows", no share meter.
 */
const expectCardHasNoRowCount = () => {
    const c = bmw().getByTestId('rc-card');
    for (const id of ['rc-card-rows', 'rc-card-pct', 'rc-card-rows-loading', 'rc-card-rows-error']) expect(within(c).queryByTestId(id)).toBeNull();
    expect(c.querySelector('.rcc-meter')).toBeNull();
    expect(c.textContent).not.toMatch(/\d[\d,]*\s*rows?\b|Counting rows|— rows|%/);
};
/** "M" of the caption's "(about M d running time)" — the only thing the settings print of a
 *  count; null while no running time is claimed. The caption has NO rows part. */
const runningTime = (dlg: ReturnType<typeof within>) => {
    expect(dlg.queryByTestId('rc-caption-rows')).toBeNull();
    expect(dlg.getByTestId('rc-caption').textContent).not.toMatch(/rows|%/);
    return dlg.getByTestId('rc-caption-train').textContent!.match(/\(about (.+) d running time\)$/)?.[1] ?? null;
};
const trains = () => env.backend!.calls.filter(c =>
    c.cmd === 'preview_relationship_model' || c.cmd === 'compute_clustering_preview' || c.cmd === 'compute_sensor_stats');
const openRc = () => {
    fireEvent.click(bmw().getByTestId('rc-card-open'));
    return within(bmw().getByRole('dialog', { name: 'Running condition' }));
};
const apply = () => bmw().getByTestId('rc-apply') as HTMLButtonElement;
const impact = () => bmw().getByTestId('rc-impact');
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const freshOnDisk = (mid: string) => {
    const fg = readDisk().failureGroupState;
    const m = fg.models.find((x: any) => x.id === mid);
    return !!m.lastTrainedAt && m.trainedFingerprint === computeTrainFingerprint(m, fg);
};
const stripPhase = () => bmw().queryByTestId('train-run-strip')?.getAttribute('data-phase') ?? null;

// ---------------------------------------------------------------------------
// 1. Apply across windows
// ---------------------------------------------------------------------------

describe('1. Apply across windows: the impact line is what really happens', () => {
    it('a train period changed: "sets 3 models back to Incomplete" = exactly the 3 dots that change in the Build Model list and on the Dashboard; the Custom and the untrained model are untouched; the notice counts down with Train sensor and Train all', async () => {
        seed();
        const before = { i5: diskModel('i5'), i4: diskModel('i4') };
        await mountWindows();
        openDashFgTab();
        selectSensor('tag1');
        await waitForCharts();
        const list0 = listDots();
        const dash0 = dashDots();
        expect(list0).toMatchObject({ i1: 'trained', r1: 'trained', i3: 'complete', i5: 'complete' });
        expect(dash0).toMatchObject({ i3: 'complete', i5: 'complete', i4: 'none' });
        expect(bmw().queryByTestId('rc-retrain-notice')).toBeNull();

        // ── the modal: a train period is shortened ──────────────────────────
        const dlg = openRc();
        expect(apply().disabled).toBe(true);
        type(dlg.getByLabelText('P1 end'), '2026-01-02T12:00'); // typed, no blur
        expect(impact().textContent).toBe('Applying sets 3 models back to Incomplete — they need training again');
        expect(impact().getAttribute('data-tone')).toBe('amber');
        expect(apply().disabled).toBe(false);
        // nothing reached the file or the other window yet
        expect(readDisk().failureGroupState.runningConditionTimePeriods).toEqual([P1]);
        expect(dashDots()).toEqual(dash0);

        const writes = wsWrites();
        await act(async () => { fireEvent.click(apply()); });
        await waitFor(() => expect(wsWrites()).toBeGreaterThan(writes));
        await settle(100);
        expect(readDisk().failureGroupState.runningConditionTimePeriods).toEqual([{ ...P1, end: '2026-01-02T12:00' }]);

        // ── N = the dots that changed, in BOTH windows ──────────────────────
        const list1 = listDots();
        expect(changed(list0, list1).sort()).toEqual(['i1', 'i3', 'r1']);
        await waitFor(() => expect(changed(dash0, dashDots()).sort()).toEqual(['i1', 'i3', 'r1']));
        expect(list1.i5).toBe('complete');
        expect(dashDots().i5).toBe('complete');
        expect(dashDots().i4).toBe('none');
        // on disk: the Complete Workspace-mode model went back to Incomplete in the same write
        expect(diskModel('i3').status).toBe(false);
        for (const id of ['i1', 'r1', 'i3']) expect(freshOnDisk(id), id).toBe(false);
        // the Custom model and the never-trained one: byte-identical
        expect(diskModel('i5')).toEqual(before.i5);
        expect(diskModel('i4')).toEqual(before.i4);

        // ── the notice under the running-condition line ─────────────────────
        const notice = () => bmw().getByTestId('rc-retrain-notice').textContent;
        expect(notice()).toBe('Running condition changed — 3 models need training again. Use Train all, or Train sensor on each one; the amber dots in the list show which.');
        expect(bmw().queryByTestId('tests-changed-notice')).toBeNull();
        // session-only: nothing about it is in the file
        expect(JSON.stringify(readDisk())).not.toMatch(/retrain/i);

        // ── Train sensor on TAG1 (Individual + Relation model) → 1 left ─────
        expect(bmw().getByTestId('train-sensor').textContent).toBe('▶ Train sensor · 2 of 2');
        await act(async () => { fireEvent.click(bmw().getByTestId('train-sensor')); });
        await waitFor(() => expect(stripPhase()).toBe('done'), { timeout: 8000 });
        await settle(50);
        expect(freshOnDisk('i1')).toBe(true);
        expect(freshOnDisk('r1')).toBe(true);
        expect(notice()).toBe('Running condition changed — 1 model needs training again. Use Train all, or Train sensor on it; the amber dot in the list shows which.');

        // ── Train all: the last one (and the never-trained model) → the notice is gone ─
        await act(async () => { fireEvent.click(bmw().getByTestId('train-all')); });
        expect(bmw().getByTestId('train-row-status-i3').textContent).toBe('Ready');
        expect(bmw().getByTestId('train-row-status-i4').textContent).toBe('Ready');
        // the Custom Complete model is up to date: never part of the run
        expect(bmw().getByTestId('train-row-status-i5').textContent).toBe('Skipped — Complete, up to date');
        await act(async () => { fireEvent.click(bmw().getByTestId('train-all-start')); });
        await waitFor(() => expect(bmw().getByTestId('train-all-modal').getAttribute('data-view')).toBe('done'), { timeout: 8000 });
        await settle(50);
        fireEvent.click(bmw().getByTestId('train-all-close'));
        expect(freshOnDisk('i3')).toBe(true);
        expect(bmw().queryByTestId('rc-retrain-notice')).toBeNull();
        // trained again is not Complete again: i3 waits for Mark complete, on both sides
        expect(diskModel('i3').status).toBe(false);
        expect(bmwDot('i3').state).not.toBe('complete');
        await waitFor(() => expect(dashDots().i3).not.toBe('complete'));
        // and the Custom model was never touched by any of it
        expect(diskModel('i5')).toEqual(before.i5);
        expect(dashDots().i5).toBe('complete');
        expect(env.backend!.cmds('compute_sensor_stats').filter(c => c.args.sensor === 'TAG5')).toHaveLength(0);
    });

    it('only a scoring period changed: "1 complete model will need Mark complete again (re-score, no training)" — exactly one dot leaves Complete in each window, no retrain notice, nothing is trained', async () => {
        seed();
        const before = Object.fromEntries(MODELS.map(m => [m.id, diskModel(m.id)]));
        await mountWindows();
        openDashFgTab();
        selectSensor('tag1');
        await waitForCharts();
        const list0 = listDots();
        const dash0 = dashDots();
        const trainsBefore = trains().length;

        const dlg = openRc();
        type(dlg.getByLabelText('Scoring period 1 end'), '2026-01-03T06:00');
        expect(impact().textContent).toBe('1 complete model will need Mark complete again (re-score, no training)');
        expect(bmw().queryByTestId('rc-impact-quiet')).toBeNull();
        const writes = wsWrites();
        await act(async () => { fireEvent.click(apply()); });
        await waitFor(() => expect(wsWrites()).toBeGreaterThan(writes));
        await settle(100);

        // exactly the Complete Workspace-mode model, in both windows
        expect(changed(list0, listDots())).toEqual(['i3']);
        await waitFor(() => expect(changed(dash0, dashDots())).toEqual(['i3']));
        expect(bmw().getByTestId('tests-changed-notice').textContent)
            .toBe('Scoring periods changed — 1 complete model needs Mark complete again. It was re-scored with the same trained model, not re-trained.');
        expect(bmw().queryByTestId('rc-retrain-notice')).toBeNull();
        // no train record moved, on any model
        for (const m of MODELS) {
            expect(diskModel(m.id).lastTrainedAt, m.id).toBe(before[m.id].lastTrainedAt);
            expect(diskModel(m.id).trainedFingerprint, m.id).toBe(before[m.id].trainedFingerprint);
        }
        expect(diskModel('i5')).toEqual(before.i5);
        // Train sensor has nothing to do: every model of the open sensor is still up to date
        expect((bmw().getByTestId('train-sensor') as HTMLButtonElement).textContent).toBe('▶ Train sensor');
        await settle(400);
        expect(trains().slice(trainsBefore).map(c => c.cmd)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// 2. Period counts
// ---------------------------------------------------------------------------

describe('2. count_period_rows: how often it is asked, and that the card counts what is on disk', () => {
    /** The persisted workspace condition as the card must have counted it. */
    const cardCallFor = (periods: { start: string; end: string }[], value1: number | null) =>
        counts().filter(c => JSON.stringify(c.args.periods.map((p: any) => [p.start, p.end])) === JSON.stringify(periods.map(p => [p.start, p.end]))
            && (c.args.filter?.value_filters?.[0]?.value1 ?? null) === value1);

    it('one call for the card; none while the modal is closed; at most two per settled draft; none on the Health score page of a Custom model; the card follows the file after an Apply and after a Dashboard write', async () => {
        seed();
        await mountWindows();
        openDashFgTab();
        selectSensor('tag1');
        await waitForCharts();
        await settle(600);

        // ── the card: ONE call, for the persisted train period + condition ──
        expect(counts()).toHaveLength(1);
        expect(counts()[0].args.periods).toHaveLength(1);
        expect(counts()[0].args.expected_generation).toBe(env.backend!.generation());
        expect(counts()[0].error).toBeUndefined();
        expect((counts()[0].result as any).union.running_rows).toBe(37);
        // …and the card prints none of it ("37 rows · 62%" is gone): it stays the plain green line
        expectCardHasNoRowCount();
        expect(bmw().getByTestId('rc-card').getAttribute('data-norows')).toBeNull();
        expect(bmw().getByTestId('rc-card-use').textContent).toBe('');
        // closed modal: nothing more, however long the window sits there
        await settle(900);
        expect(counts()).toHaveLength(1);

        // ── open: the draft's train + scoring counts (two calls) ────────────
        const dlg = openRc();
        // 37 running rows, one per hour = 1.5 d of running time — days, never "37 of 60 rows (62%) …"
        await waitFor(() => expect(runningTime(dlg)).toBe('1.5'));
        await settle(600);
        expect(counts()).toHaveLength(3);
        expect(dlg.getByTestId('period-running-1').textContent).toMatch(/1\.5 d running/);

        // ── a settled draft: two more, however many keystrokes it took ──────
        const value = dlg.getByLabelText('Running above this value');
        type(value, '2');
        type(value, '20');
        type(value, '200');
        type(value, '20');
        await waitFor(() => expect(runningTime(dlg)).toBe('1.1'), { timeout: 4000 }); // 27 running rows
        await settle(600);
        expect(counts().length).toBeLessThanOrEqual(5);
        expect(counts().length).toBeGreaterThan(3);
        // the card behind is still the PERSISTED condition — and still says nothing about rows
        expectCardHasNoRowCount();

        // ── Apply: the card counts the new on-disk state, once ──────────────
        const n = counts().length;
        await act(async () => { fireEvent.click(apply()); });
        await waitFor(() => expect(readDisk().failureGroupState.runningConditionFilters[0].value1).toBe('20'));
        await waitFor(() => expect(counts().length).toBe(n + 1));
        await waitFor(() => expect(lastCountRows()).toBe(27));
        await settle(600);
        expect(counts().slice(n)).toHaveLength(1);
        expectCardHasNoRowCount();
        expect(cardCallFor([P1], 20)).not.toHaveLength(0);
        expect(counts().slice(n)[0].args.periods).toHaveLength(1); // train only: the card reads no scoring count

        // ── a Custom model: its own counts on Model fit, NONE on Health score ─
        selectSensor('tag5', 2);
        await waitForCharts();
        await settle(600);
        const onFit = counts().length;
        await openHealth();
        await settle(600);
        typeSp('sp-upper', '450');
        blurSp('sp-upper');
        await settle(600);
        expect(counts().slice(onFit).map(c => c.args.periods)).toEqual([]);

        // ── another writer changes the condition; the Dashboard's next write carries it ─
        const { updateWorkspaceData } = await import('../workspaceManager');
        const { withFailureGroupState } = await import('../utils/failureGroupState');
        await act(async () => {
            await updateWorkspaceData(WS, prev => withFailureGroupState(prev, { runningConditionFilters: [{ ...COND, value1: '40' }] as any }));
        });
        const beforeDash = counts().length;
        fireEvent.click(dash().getAllByText('Edit details')[0]);
        fireEvent.change(dash().getByPlaceholderText('What failure mode does this group track?'), { target: { value: 'bearing wear' } });
        await waitFor(() => expect(readDisk().failureGroupState.groups.find((g: any) => g.no === 1).description).toBe('bearing wear'), { timeout: 3000 });
        // the Dashboard's write kept the other writer's condition…
        expect(readDisk().failureGroupState.runningConditionFilters[0].value1).toBe('40');
        // …and the card now counts exactly that (rows 41..47 of P1 = 7), with one call
        await waitFor(() => expect(cardCallFor([P1], 40)).toHaveLength(1), { timeout: 3000 });
        await waitFor(() => expect((cardCallFor([P1], 40)[0].result as any)?.union.running_rows).toBe(7));
        await settle(600);
        expectCardHasNoRowCount();
        expect(counts().slice(beforeDash)).toHaveLength(1);
        expect(cardCallFor([P1], 40)).toHaveLength(1);
        // every call of the whole session was accepted by the strict fake (snake_case keys, generation)
        expect(counts().filter(c => c.error).map(c => c.error)).toEqual([]);
    });

    it('STALE_SESSION (a window left over from another dataset): the quiet "data changed" line, no running time — and Apply is not blocked by it', async () => {
        seed();
        await mountWindows();
        selectSensor('tag1');
        await waitForCharts();
        // the main window loaded another CSV: this window's generation is old
        env.backend!.loadDataset('plant');
        const dlg = openRc();
        await waitFor(() => expect(counts().some(c => /^STALE_SESSION/.test(c.error ?? ''))).toBe(true));
        await waitFor(() => expect(dlg.getByTestId('rc-caption-data-changed').textContent)
            .toBe('The data changed — close this window and open Build Model again'));
        expect(dlg.getByTestId('rc-caption-data-changed').className).toContain('rct-cap-quiet');
        expect(runningTime(dlg)).toBeNull();
        expect(dlg.queryByTestId('rc-no-rows')).toBeNull();
        expect(bmw().queryByTestId('rc-apply-block')).toBeNull();

        // an edit: its count is refused too — no red line, Apply enabled, and it writes
        type(dlg.getByLabelText('Running above this value'), '20');
        await settle(700);
        expect(dlg.queryByTestId('rc-no-rows')).toBeNull();
        expect(bmw().queryByTestId('rc-apply-block')).toBeNull();
        expect(apply().disabled).toBe(false);
        await act(async () => { fireEvent.click(apply()); });
        await waitFor(() => expect(readDisk().failureGroupState.runningConditionFilters[0].value1).toBe('20'));
        // the card: no number and no red "nothing to train on"
        await settle(300);
        expectCardHasNoRowCount();
        expect(bmw().getByTestId('rc-card').getAttribute('data-norows')).toBeNull();
        expect(bmw().queryByTestId('rc-card-no-rows')).toBeNull();
    });

    it('re-pointed at another workspace while an Apply is still being written: ws1 gets its own change, ws2\'s file is untouched, and the window shows and counts ws2 only', async () => {
        seed();
        // ws2: the next project — its own condition (TAG2 > 50) and its own train period
        const P_WS2 = { id: 'q1', start: '2026-01-02T00:00', end: '2026-01-03T11:00' };
        const ws2 = wsTrained(
            { runningConditionTimePeriods: [P_WS2], runningConditionTestPeriods: [], runningConditionFilters: [{ ...COND, id: 'rc2', value1: '50' }] },
            [model({ id: 'j1', name: 'Other project', targetSensor: 'TAG3' })], 'ws2');
        writeDisk(ws2, 'ws2');
        const ws2Bytes = env.files.get(wsFile('ws2'))!;
        await mountWindows({ dashboard: false });
        selectSensor('tag1');
        await waitForCharts();

        const dlg = openRc();
        type(dlg.getByLabelText('Running above this value'), '20');
        // the disk is slow: the write of ws1 is held at its rename
        let release!: () => void;
        fsHold.gate = { path: wsFile('ws1'), wait: new Promise<void>(r => { release = r; }), entered: false };
        const emittedBefore = env.emitted.length;
        await act(async () => { fireEvent.click(apply()); });
        await waitFor(() => expect(fsHold.gate!.entered).toBe(true));

        // the main window moved on to ws2 meanwhile
        await sendBuildModelData('ws2');
        await act(async () => { release(); });
        fsHold.gate = null;
        await settle(700);

        // ws1 got ITS change; ws2's file is byte-identical
        expect(readDisk('ws1').failureGroupState.runningConditionFilters[0].value1).toBe('20');
        expect(env.files.get(wsFile('ws2'))).toBe(ws2Bytes);
        expect(env.writes.filter(w => w.path === wsFile('ws2'))).toHaveLength(0);
        // the window shows ws2: its model list, its condition, its count (rows 51..59 = 9)
        expect(bmw().queryByTestId('sensor-list-row-fg:1-tag1')).toBeNull();
        expect(bmw().getByTestId('sensor-list-row-fg:1-tag3')).toBeTruthy();
        await waitFor(() => {
            const c = counts().slice(-1)[0];
            expect(c.args.periods.map((p: any) => p.start)).toEqual([P_WS2.start]);
            expect((c.result as any)?.union.running_rows).toBe(9);
        });
        expectCardHasNoRowCount();
        expect(bmw().queryByTestId('rc-retrain-notice')).toBeNull();
        expect(bmwEl().querySelector('[role="dialog"]')).toBeNull();
        // ws1's slice was never broadcast from this window after it had moved on
        const late = env.emitted.slice(emittedBefore).filter(e => e.event === 'failure-group-state-changed');
        expect(late.filter(e => e.payload.workspaceId === 'ws1')).toEqual([]);
        // and the last count is ws2's own period + condition
        const last = counts().slice(-1)[0];
        expect(last.args.periods.map((p: any) => p.start)).toEqual([P_WS2.start]);
        expect(last.args.filter.value_filters[0].value1).toBe(50);
    });
});

// ---------------------------------------------------------------------------
// 3. Date entry
// ---------------------------------------------------------------------------

describe('3. typing a date in a period row', () => {
    it('a complete date moves the timeline, the caption (with the running time of Rust\'s new count) and the impact line BEFORE Apply; a half-typed date shows the grey line and is never written; a cleared bound keeps its date through Apply', async () => {
        seed();
        await mountWindows();
        selectSensor('tag1');
        await waitForCharts();
        const dlg = openRc();
        await waitFor(() => expect(runningTime(dlg)).toBe('1.5')); // 37 running rows, one per hour
        const tl0 = dlg.getByTestId('rc-tl-P1').getAttribute('style');
        const train0 = dlg.getByTestId('rc-caption-train').textContent;

        // ── a complete date, no blur ────────────────────────────────────────
        const end = dlg.getByLabelText('P1 end') as HTMLInputElement;
        end.focus();
        type(end, '2026-01-02T00:00'); // rows 0..24 → running 11..24 = 14
        expect(dlg.getByTestId('rc-tl-P1').getAttribute('style')).not.toBe(tl0);
        expect(dlg.getByTestId('rc-caption-train').textContent).not.toBe(train0);
        expect(impact().textContent).toBe('Applying sets 3 models back to Incomplete — they need training again');
        expect(bmw().queryByTestId('rc-pending-date')).toBeNull();
        await waitFor(() => expect(runningTime(dlg)).toBe('0.6'), { timeout: 4000 }); // 14 running rows
        expect(lastCountRows()).toBe(14);
        expect(document.activeElement).toBe(end); // the row never moved under the cursor
        expect(readDisk().failureGroupState.runningConditionTimePeriods).toEqual([P1]);

        // ── half-typed (a datetime-local reports '' while a segment is missing) ──
        type(end, '');
        const pending = bmw().getByTestId('rc-pending-date');
        expect(pending.textContent).toBe('Finish the date in P1 to see what this changes');
        // the draft still holds the last COMPLETE date: its impact line stays, the grey line under it
        expect(impact().firstElementChild!.textContent).toBe('Applying sets 3 models back to Incomplete — they need training again');
        expect(bmw().queryByTestId('rc-apply-block')).toBeNull(); // not "P1 needs an end date"
        await settle(600);
        expect(runningTime(dlg)).toBe('0.6');

        // ── Apply with the field still half-typed: the last complete date is written, never '' ──
        const writes = wsWrites();
        const countsBeforeApply = counts().length;
        await act(async () => { fireEvent.click(apply()); });
        await waitFor(() => expect(wsWrites()).toBeGreaterThan(writes));
        await settle(100);
        expect(readDisk().failureGroupState.runningConditionTimePeriods).toEqual([{ ...P1, end: '2026-01-02T00:00' }]);
        // the card counts what was written (its own call, after the Apply) — and prints none of it
        await waitFor(() => expect(counts().length).toBeGreaterThan(countsBeforeApply));
        await waitFor(() => expect(lastCountRows()).toBe(14));
        expect(counts().slice(-1)[0].args.periods).toEqual([{ start: P1.start, end: '2026-01-02T00:00' }]);
        expectCardHasNoRowCount();

        // ── a SET bound cleared in the field, then Apply (with another edit): the date stays ──
        const again = openRc();
        const start = again.getByLabelText('P1 start') as HTMLInputElement;
        start.focus();
        type(start, '');
        type(again.getByLabelText('Running above this value'), '12');
        const writes2 = wsWrites();
        await act(async () => { fireEvent.click(apply()); });
        await waitFor(() => expect(wsWrites()).toBeGreaterThan(writes2));
        await settle(100);
        const fg = readDisk().failureGroupState;
        expect(fg.runningConditionFilters[0].value1).toBe('12');
        expect(fg.runningConditionTimePeriods).toEqual([{ ...P1, end: '2026-01-02T00:00' }]); // not "Start of data"
        // the card counts what was written: rows 13..24 = 12 (asked of Rust, never printed)
        await waitFor(() => {
            const c = counts().slice(-1)[0];
            expect(c.args.filter.value_filters[0].value1).toBe(12);
            expect((c.result as any)?.union.running_rows).toBe(12);
        });
        expectCardHasNoRowCount();
    });
});
