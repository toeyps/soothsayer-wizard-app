import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

/*
 * "No data to train on" guards, rules R1–R5 of 88f15cc (QA close-out,
 * The commit that was NOT code-reviewed again). Real Dashboard +
 * real Build Model window + real `workspaceManager` on in-memory workspace
 * files, the fake Rust backend with its real `get_dataset_time_bounds`,
 * `count_period_rows` and train commands.
 *
 *   R1  the data's range belongs to the dataset ON SCREEN — a window re-pointed
 *       at another project judges nothing until that project's range has landed;
 *   R2  a period that is NEW / CHANGED in a draft and lies outside the data
 *       blocks Apply / Save changes ("Fix P1 before applying / saving");
 *   R3  a period exactly as it was SAVED only warns (amber) — an unrelated
 *       Apply and a Custom model's rename + Save still work;
 *   R4  Train is blocked, with the named reason, only when NO train period is
 *       inside the data or the settled count is zero — and a train the window
 *       could not foresee is answered in the app's own words;
 *   R5  nothing that READS a model is touched: a trained and a Complete model
 *       keep their charts, Health score page, Mark incomplete / Mark complete
 *       again, dots and words — and the workspace file is not written.
 *
 * In one window with mocked storage these rules are covered by
 * `BuildModelWindow.test.tsx` ("Guards against no data to train on") and
 * `RunningConditionDataGuards.test.tsx`; this file is the two-window,
 * real-file, real-count version.
 */

vi.mock('@tauri-apps/api/event', async () => (await import('./helpers/healthEnv')).eventModule());
vi.mock('@tauri-apps/plugin-fs', async () => (await import('./helpers/healthEnv')).fsModule());
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
import { plantDataset, type HealthDataset } from './helpers/fakeHealthRust';
import {
    COND, WS, bmw, bmwDot, bmwEl, dashDot, diskModel, enterSp, markBtn, model, mountWindows, newBackend, openDashFgTab, openHealth,
    openSettings, pill, readDisk, saveChanges, selectSensor, sendBuildModelData, settle, waitForCharts, writeDisk, wsFile, wsTrained,
} from './helpers/healthWorkbench';
import { computeTrainFingerprint } from '../utils/trainFingerprint';

vi.setConfig({ testTimeout: 60_000 });

/** The plant (60 hourly rows from 1 Jan, 00:00 … 3 Jan, 11:00) recorded in another year. */
const plantOf = (year: number): HealthDataset => {
    const d = plantDataset();
    return { ...d, timestamps: d.timestamps.map(t => t.replace(/^2026-/, `${year}-`)) };
};

beforeEach(() => {
    resetEnv();
    newBackend();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const P_IN = { id: 'p1', start: '2026-01-01T00:00', end: '2026-01-02T23:00' };  // inside the 2026 plant
const P_OUT = { id: 'p2', start: '2027-03-01T00:00', end: '2027-03-10T00:00' }; // entirely after it
const S_IN = { id: 's1', start: '2026-01-03T00:00', end: '2026-01-03T11:00' };
const S_OUT = { id: 's2', start: '2024-01-01T00:00', end: '2024-01-31T23:59' };
const RANGE_26 = '2026/01/01 00:00 – 2026/01/03 11:00';
const SP1 = { kind: 'individual', lower: 20, upper: 80, masterLower: 20, masterUpper: 80 };
const SP_WIDE = { kind: 'individual', lower: -500, upper: 500, masterLower: null, masterUpper: null };
const EMPTY_SP = { kind: 'individual', lower: null, upper: null };
// (`scoringIntervalSecs`: a record as THIS build writes it — the saved results use 1-hour averages; one without it gets the footer's "earlier row-by-row scoring" hint, covered in BuildModelWindow.test.tsx)
const record = (setPoints: unknown) => ({ at: '2026-10-05T08:00:00.000Z', outputDir: env.backend!.outputDir(WS), setPoints, scoringIntervalSecs: 3600 });

const wsWrites = (id = WS) => env.writes.filter(w => w.path === wsFile(id)).length;
const fgBytes = (id = WS) => JSON.stringify(readDisk(id).failureGroupState);
const modelsBytes = (id = WS) => JSON.stringify(readDisk(id).failureGroupState.models);
const card = () => bmw().getByTestId('rc-card');
/** Running rows Rust answered for the LAST `count_period_rows` (the card's verdict reads it). */
const lastCountRows = () => (env.backend!.cmds('count_period_rows').slice(-1)[0]?.result as { union: { running_rows: number } } | undefined)?.union.running_rows;
/** User decision 2026-10-14: the card never says how many data rows are used — no "N rows · x%",
 *  no "Counting rows…", no "— rows", no share meter; only its two warnings stay, in words. */
const expectCardHasNoRowCount = () => {
    for (const id of ['rc-card-rows', 'rc-card-pct', 'rc-card-rows-loading', 'rc-card-rows-error']) expect(within(card()).queryByTestId(id)).toBeNull();
    expect(card().querySelector('.rcc-meter')).toBeNull();
    expect(card().textContent).not.toMatch(/\d[\d,]*\s*rows?\b|Counting rows|— rows|%/);
};
const openRc = () => {
    fireEvent.click(bmw().getByTestId('rc-card-open'));
    return within(bmw().getByRole('dialog', { name: 'Running condition' }));
};
const apply = () => bmw().getByTestId('rc-apply') as HTMLButtonElement;
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const trainBtn = () => bmw().getByTestId('train-sensor') as HTMLButtonElement;
const trainWhy = () => bmw().getByTestId('train-sensor-why').textContent;
const footReason = () => bmw().queryByTestId('build-block-reason')?.textContent ?? null;
/** A kind tab's status words: the dot's tooltip — and the SAME string shown on the tab beside the dot (v2 §2). */
const tabWords = (id: string) => {
    const title = bmw().getByTestId(`tab-status-${id}`).getAttribute('title');
    expect(bmw().getByTestId(`tab-words-${id}`).textContent).toBe(title);
    return title;
};
const trains = () => env.backend!.calls.filter(c =>
    c.cmd === 'preview_relationship_model' || c.cmd === 'compute_clustering_preview' || c.cmd === 'compute_sensor_stats');
const freshOnDisk = (mid: string, id = WS) => {
    const fg = readDisk(id).failureGroupState;
    const m = fg.models.find((x: any) => x.id === mid);
    return !!m.lastTrainedAt && m.trainedFingerprint === computeTrainFingerprint(m, fg);
};
const never = (state: any, ids: string[]) => {
    for (const m of state.failureGroupState.models) if (ids.includes(m.id)) { delete m.lastTrainedAt; delete m.trainedFingerprint; }
    return state;
};
const bmwBroadcasts = () => env.emitted.filter(e => e.event === 'failure-group-state-changed' && e.payload?.origin === 'build-model');

// ---------------------------------------------------------------------------
// R1 — the bounds belong to the dataset on screen
// ---------------------------------------------------------------------------

describe('R1 — a Build Model window re-pointed from a 2025 project to a 2027 one', () => {
    it('nothing is judged while the 2027 range is on its way (never against 2025); once it lands the 2027 period is inside, the leftover 2025 period warns, and Train works', async () => {
        newBackend({ d25: plantOf(2025), d27: plantOf(2027) }, 'd25');
        const P25 = { id: 'a', start: '2025-01-01T00:00', end: '2025-01-02T23:00' };
        const P27 = { id: 'b', start: '2027-01-01T00:00', end: '2027-01-02T23:00' };
        writeDisk(never(wsTrained({ runningConditionTimePeriods: [P25], runningConditionTestPeriods: [] },
            [model({ id: 'i1', name: 'Old project', targetSensor: 'TAG1', healthSetPoints: EMPTY_SP })]), ['i1']));
        // the next project: one train period copied over from 2025, one in its own data
        writeDisk(never(wsTrained({ runningConditionTimePeriods: [P25, P27], runningConditionTestPeriods: [] },
            [model({ id: 'j1', name: 'New project', targetSensor: 'TAG3', healthSetPoints: EMPTY_SP })], 'ws2'), ['j1']), 'ws2');

        await mountWindows({ dashboard: false });
        selectSensor('tag1');
        await settle(400);
        // on the 2025 data: the 2025 period is inside — nothing to say
        expect(card().getAttribute('data-norows')).toBeNull();
        expect(bmw().queryByTestId('rc-card-outside')).toBeNull();
        expect(trainBtn().disabled).toBe(false);
        expect(env.backend!.cmds('get_dataset_time_bounds')).toHaveLength(1);

        // ── the main window loads the 2027 CSV and re-points this window at ws2 ──
        env.backend!.loadDataset('d27');
        const hold = env.backend!.gate('get_dataset_time_bounds');
        await sendBuildModelData('ws2');
        await waitFor(() => expect(hold.entered).toBe(true));
        await settle(400);
        expect(bmw().getByTestId('sensor-list-row-fg:1-tag3')).toBeTruthy();
        // the new range is not known yet: NOTHING is judged — against 2025 the 2027 period
        // would be "outside the data" and the 2025 one would look fine
        expect(card().getAttribute('data-norows')).toBeNull();
        expect(bmw().queryByTestId('rc-card-outside')).toBeNull();
        expect(footReason()).toBeNull();
        expect(trainBtn().disabled).toBe(false);
        expect(tabWords('j1')).not.toMatch(/inside the data|No rows/);
        const dlg = openRc();
        expect(dlg.getByTestId('rc-timeline-nobounds')).toBeTruthy();
        for (const n of [1, 2]) {
            expect(dlg.queryByTestId(`period-data-note-${n}`)).toBeNull();
            expect(dlg.queryByTestId(`period-invalid-${n}`)).toBeNull();
            expect(dlg.getByTestId(`period-row-${n}`).getAttribute('data-outside')).toBeNull();
        }
        fireEvent.click(bmw().getByTestId('rc-cancel'));

        // ── the 2027 range lands ────────────────────────────────────────────
        await act(async () => { hold.release(); });
        await waitFor(() => expect(bmw().getByTestId('rc-card-outside').textContent)
            .toBe('⚠ P1 is outside the data (2027/01/01 00:00 – 2027/01/03 11:00) — it is not used'));
        // asked again exactly once for the new dataset
        expect(env.backend!.cmds('get_dataset_time_bounds')).toHaveLength(2);
        // one period is inside the data: nothing is blocked, the card is not red
        expect(card().getAttribute('data-norows')).toBeNull();
        expect(card().getAttribute('data-state')).toBe('set');
        expect(trainBtn().disabled).toBe(false);
        const dlg2 = openRc();
        expect(dlg2.getByTestId('period-row-1').getAttribute('data-outside')).toBe('true');
        expect(dlg2.queryByTestId('period-invalid-1')).toBeNull();
        expect(dlg2.getByTestId('period-row-2').getAttribute('data-outside')).toBeNull();
        expect(dlg2.queryByTestId('period-data-note-2')).toBeNull();
        expect(bmw().queryByTestId('rc-apply-block')).toBeNull();
        fireEvent.click(bmw().getByTestId('rc-cancel'));

        // ── and it trains, on the 2027 rows of ws2 only ─────────────────────
        await act(async () => { fireEvent.click(trainBtn()); });
        await waitFor(() => expect(freshOnDisk('j1', 'ws2')).toBe(true), { timeout: 8000 });
        const stats = env.backend!.cmds('compute_sensor_stats').filter(c => c.args.sensor === 'TAG3').slice(-1)[0];
        expect(stats.error).toBeUndefined();
        expect((stats.result as any).count).toBe(37); // rows 11..47 of the 2027 plant (TAG2 > 10 inside P27)
        // the old project was not touched by any of it
        expect(diskModel('i1').lastTrainedAt).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// R2 + R3 — draft vs. saved
// ---------------------------------------------------------------------------

describe('R2 / R3 — a period outside the data: SAVED = a warning, NEW or CHANGED = a block', () => {
    /** Workspace: [inside, saved-outside] train + [inside, saved-outside] scoring.
     *  i1 = Individual TAG1 (Workspace mode, trained). c5 = Individual TAG5 on its OWN
     *  lists — again [inside, saved-outside]. */
    const OWN_IN = { id: 'o1', start: '2026-01-01T00:00', end: '2026-01-02T12:00' };
    const OWN_OUT = { id: 'o2', start: '2027-05-01T00:00', end: '2027-05-05T00:00' };
    const start = () => wsTrained({ runningConditionTimePeriods: [P_IN, P_OUT], runningConditionTestPeriods: [S_OUT, S_IN] }, [
        model({ id: 'i1', name: 'Pressure band', targetSensor: 'TAG1', healthSetPoints: SP1, healthVerdict: 'valid' }),
        model({
            id: 'c5', name: 'Temp band', targetSensor: 'TAG5', groupNos: [2], runningConditionMode: 'custom',
            customRunningConditionNoneConfirmed: true, filterTimePeriods: [OWN_IN, OWN_OUT], customTestPeriods: [S_OUT],
            healthSetPoints: SP_WIDE, healthVerdict: 'valid',
        }),
    ]);

    it('SAVED outside the data: the card and the rows warn in amber, nothing is red or blocked — an unrelated Apply writes, and the Custom model is renamed and saved', async () => {
        writeDisk(start());
        const before = { i1: diskModel('i1'), c5: diskModel('c5') };
        await mountWindows();
        openDashFgTab();
        selectSensor('tag1');
        await waitForCharts();

        // ── the card: green, "set", counted — plus ONE amber line ────────────
        expect(card().getAttribute('data-state')).toBe('set');
        expect(card().getAttribute('data-norows')).toBeNull();
        expect(card().className).toContain('rcc-card--ok');
        expect(bmw().getByTestId('rc-card-outside').textContent)
            .toBe(`⚠ P2 is outside the data (${RANGE_26}) — it is not used · S1 is outside the data — nothing is scored there`);
        expect(bmw().queryByTestId('rc-card-test-bad')).toBeNull(); // never "to fix"
        // counted (37 running rows in P1; the outside period holds none) — and none of it printed
        await waitFor(() => expect(lastCountRows()).toBe(37));
        expectCardHasNoRowCount();
        expect(card().getAttribute('data-norows')).toBeNull();
        // the trained model is simply trained: pill, dots, Train sensor
        expect(pill()).toBe('Trained');
        expect(bmwDot('i1').state).toBe('trained');
        expect(dashDot(1, 'tag1', 'individual')).toBe('trained');
        expect(footReason()).toBeNull();

        // ── the modal: amber rows, Apply only waits for an edit ──────────────
        const dlg = openRc();
        expect(dlg.getByTestId('period-row-2').getAttribute('data-outside')).toBe('true');
        expect(dlg.getByTestId('period-row-2').getAttribute('data-invalid')).toBeNull();
        expect(dlg.getByTestId('period-data-note-2').textContent).toBe(`P2 is outside the data (${RANGE_26}) — it is not used`);
        expect(dlg.getByTestId('test-data-note-1').textContent).toBe('S1 is outside the data — nothing is scored there');
        expect(dlg.queryByTestId('period-invalid-2')).toBeNull();
        expect(dlg.queryByTestId('test-invalid-1')).toBeNull();
        expect(bmw().queryByTestId('rc-fix-period-pill')).toBeNull();
        expect(bmw().queryByTestId('rc-apply-block')).toBeNull();
        expect(apply().disabled).toBe(true); // clean, not blocked

        // an UNRELATED edit applies, and both saved periods are still there afterwards
        type(dlg.getByPlaceholderText('value'), '12');
        expect(bmw().queryByTestId('rc-apply-block')).toBeNull();
        expect(apply().disabled).toBe(false);
        const writes = wsWrites();
        await act(async () => { fireEvent.click(apply()); });
        await waitFor(() => expect(wsWrites()).toBeGreaterThan(writes));
        await settle(100);
        const fg = readDisk().failureGroupState;
        expect(fg.runningConditionFilters[0].value1).toBe('12');
        expect(fg.runningConditionTimePeriods).toEqual([P_IN, P_OUT]);
        expect(fg.runningConditionTestPeriods).toEqual([S_OUT, S_IN]);

        // ── the Custom model: its own saved period outside the data only warns; rename + Save works ──
        selectSensor('tag5', 2);
        await waitForCharts();
        expect(pill()).toBe('Trained');
        openSettings();
        const own = within(bmw().getByTestId('custom-rc-panel'));
        expect(own.getByTestId('period-data-note-2').textContent).toBe(`P2 is outside the data (${RANGE_26}) — it is not used`);
        expect(own.queryByTestId('period-invalid-2')).toBeNull();
        fireEvent.change(bmw().getByDisplayValue('Temp band'), { target: { value: 'Temp band (winter)' } });
        const save = bmw().getByTestId('save-changes') as HTMLButtonElement;
        expect(save.disabled).toBe(false);
        expect(footReason()).toBeNull();
        await saveChanges();
        await waitFor(() => expect(diskModel('c5').name).toBe('Temp band (winter)'));
        // a rename is not a re-train: the train record and the lists are what they were
        expect(diskModel('c5')).toEqual({ ...before.c5, name: 'Temp band (winter)' });
        expect(pill()).toBe('Trained');
    });

    it('NEW or CHANGED outside the data: red row with the data range, "Fix P1 before applying" / "Fix P1 before saving" — and a click writes nothing', async () => {
        writeDisk(start());
        await mountWindows();
        selectSensor('tag1');
        await waitForCharts();
        const bytes = fgBytes();

        // ── the workspace modal: P1 moved to 2025 ────────────────────────────
        const dlg = openRc();
        type(dlg.getByLabelText('P1 start'), '2025-06-01T00:00');
        type(dlg.getByLabelText('P1 end'), '2025-06-10T00:00');
        expect(dlg.getByTestId('period-invalid-1').textContent).toBe(`P1 is outside the data (${RANGE_26})`);
        expect(dlg.getByTestId('period-row-1').getAttribute('data-invalid')).toBe('true');
        expect(dlg.getByLabelText('P1 start').getAttribute('aria-invalid')).toBe('true');
        expect(dlg.getByLabelText('P1 end').getAttribute('aria-invalid')).toBe('true');
        // the SAVED outside period next to it is still only a warning
        expect(dlg.getByTestId('period-row-2').getAttribute('data-invalid')).toBeNull();
        expect(bmw().getByTestId('rc-apply-block').textContent).toBe('Fix P1 before applying');
        expect(bmw().queryByTestId('rc-impact')).toBeNull();
        expect(apply().disabled).toBe(true);
        await act(async () => { fireEvent.click(apply()); });
        await settle(200);
        expect(fgBytes()).toBe(bytes);
        expect(bmw().getByRole('dialog', { name: 'Running condition' })).toBeTruthy();

        // a NEW scoring period outside the data blocks the same way (the saved S1 does not)
        type(dlg.getByLabelText('P1 start'), P_IN.start);
        type(dlg.getByLabelText('P1 end'), P_IN.end);
        expect(bmw().queryByTestId('rc-apply-block')).toBeNull();
        type(dlg.getByLabelText('Scoring period 2 start'), '2028-01-01T00:00');
        type(dlg.getByLabelText('Scoring period 2 end'), '2028-01-05T00:00');
        expect(dlg.getByTestId('test-invalid-2').textContent).toBe(`S2 is outside the data (${RANGE_26})`);
        expect(bmw().getByTestId('rc-apply-block').textContent).toBe('Fix S2 before applying');
        fireEvent.click(bmw().getByTestId('rc-cancel'));
        expect(fgBytes()).toBe(bytes);

        // ── the Custom model's own list: P1 moved to 2025 → Save changes is blocked ──
        selectSensor('tag5', 2);
        await waitForCharts();
        openSettings();
        const own = within(bmw().getByTestId('custom-rc-panel'));
        type(own.getByLabelText('P1 start'), '2025-06-01T00:00');
        type(own.getByLabelText('P1 end'), '2025-06-10T00:00');
        expect(own.getByTestId('period-invalid-1').textContent).toBe(`P1 is outside the data (${RANGE_26})`);
        const save = bmw().getByTestId('save-changes') as HTMLButtonElement;
        expect(save.disabled).toBe(true);
        expect(footReason()).toBe('Fix P1 before saving');
        // Train (which saves first) is blocked by the same thing
        expect(trainBtn().disabled).toBe(true);
        const trainsBefore = trains().length;
        await act(async () => { fireEvent.click(save); });
        await settle(200);
        expect(fgBytes()).toBe(bytes);
        expect(trains()).toHaveLength(trainsBefore);
    });
});

// ---------------------------------------------------------------------------
// R4 — Train is blocked only when there is truly nothing to train on
// ---------------------------------------------------------------------------

describe('R4 — "nothing to train on" blocks Train, with the named reason', () => {
    const NO_DATA_REASON = `No train period is inside the data (${RANGE_26}) — nothing to train on. Move a train period inside the data (Running condition → Edit).`;
    const NO_ROWS_REASON = 'No rows match — nothing to train on. Widen a train period or relax the condition (Running condition → Edit).';

    /** TAG1: i1 Individual (Workspace mode) + r1 Relation model TAG1 <- TAG3 on its OWN lists
     *  (inside the data, all rows). TAG4: i4 Individual (Workspace mode). None was ever trained. */
    const untrained = (fg: Record<string, unknown>, r1: Record<string, unknown> = {}) => never(wsTrained(fg, [
        model({ id: 'i1', name: 'Pressure band', targetSensor: 'TAG1', healthSetPoints: EMPTY_SP }),
        model({
            id: 'r1', name: 'Pressure from flow', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG3'],
            runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true, filterTimePeriods: [P_IN], customTestPeriods: [S_IN], ...r1,
        }),
        model({ id: 'i4', name: 'Mode band', targetSensor: 'TAG4', groupNos: [2], healthSetPoints: EMPTY_SP }),
    ]), ['i1', 'r1', 'i4']);

    /** Everything that offers Train says `short` for the Workspace-mode models; the Custom one is free. */
    async function expectTrainBlocked(reason: string, short: string) {
        expect(card().getAttribute('data-norows')).toBe('true');
        expect(bmw().getByTestId('rc-card-use').textContent).toBe('Nothing to train on'); // the warning in words — no "0 rows"
        expect(bmw().getByTestId('rc-card-no-rows').getAttribute('role')).toBe('alert');
        expectCardHasNoRowCount();
        expect(bmw().getByTestId('rc-card-open').textContent).toBe('Edit'); // not "Fix period": nobody just picked it

        // ── TAG4: its only model is blocked ──────────────────────────────────
        selectSensor('tag4', 2);
        await settle(300);
        // the model's own page: the footer and the board, once each
        expect(footReason()).toBe(reason);
        expect(within(bmw().getByTestId('results-incomplete')).getByText(reason)).toBeTruthy();
        expect(tabWords('i4')).toBe(short);
        expect(bmwDot('i4').state).toBe('blocked');
        // Train sensor: a disabled ghost, the named reason as its tooltip; no menu to open
        expect(trainBtn().disabled).toBe(true);
        expect(trainBtn().textContent).toBe('▶ Train sensor');
        expect(trainBtn().title).toBe(`Can't train: Individual — ${short}`);
        expect(trainWhy()).toBe("Can't train · see below");
        expect((bmw().getByTestId('train-sensor-menu-toggle') as HTMLButtonElement).disabled).toBe(true);

        // ── TAG1: the Workspace-mode Individual is blocked, the Custom Relation model is not ──
        selectSensor('tag1');
        await settle(300);
        expect(trainBtn().disabled).toBe(false);
        expect(trainBtn().textContent).toBe('▶ Train sensor · 1 of 2');
        expect(trainWhy()).toBe("Trains the Relation model · Individual can't train, skipped");
        fireEvent.click(bmw().getByTestId('train-sensor-menu-toggle'));
        const blockedRow = bmw().getByTestId('train-menu-only-individual') as HTMLButtonElement;
        expect(blockedRow.disabled).toBe(true);
        expect(blockedRow.querySelector('small')!.textContent).toBe(short);
        expect((bmw().getByTestId('train-menu-only-relationship') as HTMLButtonElement).disabled).toBe(false);
        fireEvent.keyDown(window, { key: 'Escape' });

        // ── Train all: amber "Skipped" + the reason + Fix → for both; the Custom model is Ready ──
        await act(async () => { fireEvent.click(bmw().getByTestId('train-all')); });
        for (const id of ['i1', 'i4']) {
            expect(bmw().getByTestId(`train-row-status-${id}`).textContent, id).toBe('Skipped');
            expect(bmw().getByTestId(`train-row-note-${id}`).textContent, id).toBe(short);
            expect(bmw().getByTestId(`train-fix-${id}`), id).toBeTruthy();
        }
        expect(bmw().getByTestId('train-row-status-r1').textContent).toBe('Ready');
    }

    it('NO train period inside the data: Train sensor, its ▾ menu row and the Train-all preflight all say "No train period inside the data"; the Custom model on its own period still trains — and the block wrote nothing', async () => {
        writeDisk(untrained({ runningConditionTimePeriods: [P_OUT], runningConditionTestPeriods: [S_IN] }));
        await mountWindows();
        openDashFgTab();
        await settle(500);
        const bytes = modelsBytes();
        await expectTrainBlocked(NO_DATA_REASON, 'No train period inside the data');

        // the run trains the ONE model that has data, and only that one
        await act(async () => { fireEvent.click(bmw().getByTestId('train-all-start')); });
        await waitFor(() => expect(bmw().getByTestId('train-all-modal').getAttribute('data-view')).toBe('done'), { timeout: 8000 });
        await settle(50);
        expect(bmw().getByTestId('train-row-status-r1').textContent).toBe('✓ Trained · set points needed');
        expect(freshOnDisk('r1')).toBe(true);
        expect(env.backend!.cmds('compute_sensor_stats').filter(c => ['TAG1', 'TAG4'].includes(c.args.sensor))).toHaveLength(0);
        // the blocked models are byte-identical on disk; the Dashboard shows no dot for them
        const after = readDisk().failureGroupState.models;
        expect(JSON.stringify(after.filter((m: any) => m.id !== 'r1'))).toBe(JSON.stringify(JSON.parse(bytes).filter((m: any) => m.id !== 'r1')));
        expect(dashDot(1, 'tag1', 'individual')).toBe('none');
        expect(dashDot(2, 'tag4', 'individual')).toBe('none');
        await waitFor(() => expect(dashDot(1, 'tag1', 'relationship')).not.toBe('none'));
    });

    it('the settled count is ZERO rows (a condition no row passes): the same places say "No rows to train on" — and one train period outside the data NEXT TO one inside it blocks nothing', async () => {
        writeDisk(untrained({
            runningConditionTimePeriods: [P_IN], runningConditionTestPeriods: [S_IN],
            runningConditionFilters: [{ ...COND, value1: '1000' }],
        }));
        await mountWindows();
        await waitFor(() => expect(card().getAttribute('data-norows')).toBe('true'));
        // it is Rust's own count that said so, for the persisted condition
        const count = env.backend!.cmds('count_period_rows').slice(-1)[0];
        expect((count.result as any).union).toMatchObject({ rows_in_period: 48, running_rows: 0 });
        await expectTrainBlocked(NO_ROWS_REASON, 'No rows to train on');
        fireEvent.click(bmw().getByTestId('train-fix-i1'));
        // Fix → is the Running-condition settings; relaxing the condition there lifts the block
        const dlg = within(bmw().getByRole('dialog', { name: 'Running condition' }));
        await waitFor(() => expect(dlg.getByTestId('rc-no-rows').textContent).toBe('No rows match — nothing to train on. Widen a train period or relax the condition.'));
        type(dlg.getByPlaceholderText('value'), '10');
        await waitFor(() => expect(dlg.queryByTestId('rc-no-rows')).toBeNull(), { timeout: 4000 });
        await act(async () => { fireEvent.click(apply()); });
        await waitFor(() => expect(readDisk().failureGroupState.runningConditionFilters[0].value1).toBe('10'));
        await waitFor(() => expect(card().getAttribute('data-norows')).toBeNull());
        selectSensor('tag4', 2);
        await settle(300);
        await waitFor(() => expect(trainBtn().disabled).toBe(false));
        expect(footReason()).toBeNull();
        expect(trainBtn().textContent).toBe('▶ Train sensor · 1 of 1');

        // ── [inside, outside]: a warning, never a block ──────────────────────
        const dlg2 = openRc();
        fireEvent.click(dlg2.getByTestId('period-add'));
        type(dlg2.getByLabelText('P2 start'), P_OUT.start);
        type(dlg2.getByLabelText('P2 end'), P_OUT.end);
        // NEW in this draft and outside the data: this one IS a block (R2)…
        expect(bmw().getByTestId('rc-apply-block').textContent).toBe('Fix P2 before applying');
        fireEvent.click(bmw().getByTestId('rc-cancel'));
        // …but the same list SAVED (another build wrote it / the data file changed) only warns
        const { updateWorkspaceData } = await import('../workspaceManager');
        const { withFailureGroupState } = await import('../utils/failureGroupState');
        const { emit } = await import('@tauri-apps/api/event');
        await act(async () => {
            const next = await updateWorkspaceData(WS, prev => withFailureGroupState(prev, { runningConditionTimePeriods: [P_IN, P_OUT] as any }));
            await emit('failure-group-state-changed', { ...next!.failureGroupState, workspaceId: WS, origin: 'dashboard' });
        });
        await waitFor(() => expect(bmw().getByTestId('rc-card-outside').textContent).toBe(`⚠ P2 is outside the data (${RANGE_26}) — it is not used`));
        expect(card().getAttribute('data-norows')).toBeNull();
        expect(trainBtn().disabled).toBe(false);
        expect(footReason()).toBeNull();
        await act(async () => { fireEvent.click(trainBtn()); });
        await waitFor(() => expect(freshOnDisk('i4')).toBe(true), { timeout: 8000 });
        // trained on the rows of the period that IS inside the data (TAG2 > 10 in P1 = 37 rows)
        expect((env.backend!.cmds('compute_sensor_stats').filter(c => c.args.sensor === 'TAG4').slice(-1)[0].result as any).count).toBe(37);
    });

    it('at RUN time: a Custom model the window never counted has no rows — the engine\'s "no rows" answer is shown as "No rows to train on …" (queue row, board), never the raw sentence; nothing is written for it', async () => {
        // The OWN condition of r1 and c5 keeps no row (TAG2 > 1000). Neither is the open model, so
        // their rows were never counted: the preflight says Ready and Rust is the one that finds out.
        const OWN_COND = { id: 'oc', sensor: 'TAG2', operation: 'greater_than', value1: '1000', value2: '' };
        const own = { customRunningConditionNoneConfirmed: false, customRunningConditionFilters: [OWN_COND] };
        const s = untrained({ runningConditionTimePeriods: [P_IN], runningConditionTestPeriods: [S_IN] }, own) as any;
        s.failureGroupState.models.push(model({
            id: 'c5', name: 'Temp band', targetSensor: 'TAG5', groupNos: [2], healthSetPoints: EMPTY_SP,
            runningConditionMode: 'custom', filterTimePeriods: [P_IN], customTestPeriods: [S_IN], ...own,
        }));
        writeDisk(s);
        await mountWindows();
        openDashFgTab();
        selectSensor('tag4', 2);
        await settle(500);
        const before = { r1: JSON.stringify(diskModel('r1')), c5: JSON.stringify(diskModel('c5')) };

        await act(async () => { fireEvent.click(bmw().getByTestId('train-all')); });
        expect(bmw().getByTestId('train-row-status-c5').textContent).toBe('Ready');
        expect(bmw().getByTestId('train-row-status-r1').textContent).toBe('Ready');
        await act(async () => { fireEvent.click(bmw().getByTestId('train-all-start')); });
        await waitFor(() => expect(bmw().getByTestId('train-all-modal').getAttribute('data-view')).toBe('done'), { timeout: 10000 });
        await settle(50);

        // what Rust really answered (each kind words it its own way)…
        const raw = [
            env.backend!.cmds('compute_sensor_stats').filter(c => c.args.sensor === 'TAG5').slice(-1)[0].error,
            env.backend!.cmds('preview_relationship_model').filter(c => c.args.target === 'TAG1').slice(-1)[0].error,
        ];
        expect(raw).toEqual(["No valid numeric values for sensor 'TAG5'", 'No rows remain after dropping nulls.']);
        // …and what the user reads: one sentence, with where to fix it
        const SAID = 'No rows to train on — no row inside the train periods passes the running condition with values for this model. Widen a train period or relax the condition in Model settings → Training data (Custom).';
        for (const id of ['c5', 'r1']) {
            expect(bmw().getByTestId(`train-row-status-${id}`).textContent, id).toBe('✕ Failed');
            expect(bmw().getByTestId(`train-row-${id}`).textContent, id).toContain(SAID);
            expect(bmw().getByTestId(`train-row-${id}`).textContent, id).not.toMatch(/No valid numeric values|dropping nulls/);
        }
        expect(bmw().getByTestId('train-row-status-i1').textContent).toBe('✓ Trained · set points needed');
        fireEvent.click(bmw().getByTestId('train-all-close'));

        // the model's own page: now that it is the open model its own rows ARE counted, and the
        // page says the same thing in the guard's words (one item to fix, in its Model settings)
        selectSensor('tag5', 2);
        await waitFor(() => expect(bmw().getByTestId('results-incomplete').textContent)
            .toBe('1 item to fix before trainingOwn running condition: no rows to train on. Fix it in Model settings'), { timeout: 4000 });
        expect(bmw().getByTestId('build-block-reason').textContent).toBe('Own running condition: no rows to train on. Fix it in Model settings');
        expect(tabWords('c5')).toBe('Training failed'); // it did fail in this run — the board above says what to fix
        expect(trainBtn().disabled).toBe(true);
        expect(bmwEl().textContent).not.toMatch(/No valid numeric values|dropping nulls/);
        // nothing was written for the two that failed; no dot on the Dashboard
        expect(JSON.stringify(diskModel('c5'))).toBe(before.c5);
        expect(JSON.stringify(diskModel('r1'))).toBe(before.r1);
        expect(dashDot(2, 'tag5', 'individual')).toBe('none');
        expect(dashDot(1, 'tag1', 'relationship')).toBe('none');
    });
});

// ---------------------------------------------------------------------------
// R5 — the read paths
// ---------------------------------------------------------------------------

describe('R5 — the guards never touch what READS a model', () => {
    it('[inside, outside] train periods: a trained and a Complete model keep charts, Health score, dots and words; opening both writes nothing to the models; "Mark complete again" and "Mark incomplete" work', async () => {
        writeDisk(wsTrained({ runningConditionTimePeriods: [P_IN, P_OUT], runningConditionTestPeriods: [S_IN] }, [
            model({ id: 'i1', name: 'Pressure band', targetSensor: 'TAG1', healthSetPoints: SP1, healthVerdict: 'valid' }),
            model({ id: 'i3', name: 'Flow band', targetSensor: 'TAG3', status: true, healthSetPoints: SP_WIDE, healthVerdict: 'valid', healthExport: record(SP_WIDE) }),
        ]));
        const bytes = modelsBytes();
        await mountWindows();
        openDashFgTab();
        expect(dashDot(1, 'tag1', 'individual')).toBe('trained');
        expect(dashDot(1, 'tag3', 'individual')).toBe('complete');

        // ── the trained model ────────────────────────────────────────────────
        selectSensor('tag1');
        await waitForCharts();
        expect(pill()).toBe('Trained');
        expect(tabWords('i1')).toBe('Trained');
        expect(bmwDot('i1').state).toBe('trained');
        expect(footReason()).toBeNull();
        expect(bmw().getByTestId('page-tab-health').getAttribute('aria-disabled')).toBeNull();
        expect(bmw().queryByTestId('page-tab-health-why')).toBeNull();
        await openHealth();
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
        expect(markBtn().disabled).toBe(false);

        // ── the Complete model ───────────────────────────────────────────────
        selectSensor('tag3');
        await settle(400);
        fireEvent.click(bmw().getByTestId('page-tab-model')); // make sure its Model fit page is the one open (tab ① is always there)
        await waitForCharts();
        expect(pill()).toBe('Complete');
        expect(tabWords('i3')).toBe('Complete');
        expect(bmwDot('i3').state).toBe('complete');
        expect(footReason()).toBeNull();
        await openHealth();
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
        expect((bmw().getByTestId('mark-incomplete') as HTMLButtonElement).disabled).toBe(false);
        await settle(400);

        // ── looking at both changed NOTHING: status, train record, verdict, export record ──
        expect(modelsBytes()).toBe(bytes);
        expect(bmwBroadcasts()).toEqual([]);
        expect(dashDot(1, 'tag1', 'individual')).toBe('trained');
        expect(dashDot(1, 'tag3', 'individual')).toBe('complete');
        expect(env.backend!.calls.filter(c => c.error).map(c => `${c.cmd}: ${c.error}`)).toEqual([]);

        // ── "Mark complete again" after a set-point change, then "Mark incomplete" ──
        await enterSp({ 'sp-upper': '400' });
        const again = await waitFor(() => bmw().getByTestId('mark-complete-again') as HTMLButtonElement);
        await waitFor(() => expect(again.disabled).toBe(false));
        const exportsBefore = env.backend!.cmds('export_model_files').length;
        await act(async () => { fireEvent.click(bmw().getByTestId('mark-complete-again')); });
        await waitFor(() => expect(env.backend!.cmds('export_model_files').length).toBe(exportsBefore + 1));
        await waitFor(() => expect(diskModel('i3').healthExport.setPoints.upper).toBe(400));
        expect(diskModel('i3').status).toBe(true);
        expect(env.backend!.cmds('export_model_files').slice(-1)[0].error).toBeUndefined();
        await waitFor(() => expect(dashDot(1, 'tag3', 'individual')).toBe('complete'));
        await act(async () => { fireEvent.click(bmw().getByTestId('mark-incomplete')); });
        await waitFor(() => expect(diskModel('i3').status).toBe(false));
        await waitFor(() => expect(dashDot(1, 'tag3', 'individual')).toBe('trained'));
        // its train record was never part of it
        expect(diskModel('i3').trainedFingerprint).toBe(JSON.parse(bytes).find((m: any) => m.id === 'i3').trainedFingerprint);
    });

    const P25 = { id: 'p1', start: '2025-01-01T00:00', end: '2025-01-02T23:00' };
    const S25 = { id: 's1', start: '2025-01-03T00:00', end: '2025-01-03T11:00' };
    const NO_DATA_TITLE = 'No data for this model in the loaded file';
    /** The one board of a model that has results but no row in the loaded file. */
    const noDataBoard = () => {
        const b = bmw().getByTestId('results-no-data');
        return {
            title: b.querySelector('.wbx-msg-t')!.textContent,
            text: b.querySelector('.wbx-msg-s')!.textContent,
            detail: b.querySelector('.wbx-msg-d')!.textContent,
        };
    };
    /** A workspace saved on the 2025 data (i1 trained, i3 Complete, i4 never trained) — and the
     *  CSV loaded today is 2027: every saved train period lies outside the data. */
    function seedOtherYear() {
        newBackend({ d27: plantOf(2027) });
        writeDisk(never(wsTrained({ runningConditionTimePeriods: [P25], runningConditionTestPeriods: [S25] }, [
            model({ id: 'i1', name: 'Pressure band', targetSensor: 'TAG1', healthSetPoints: SP1, healthVerdict: 'valid' }),
            model({ id: 'i3', name: 'Flow band', targetSensor: 'TAG3', status: true, healthSetPoints: SP_WIDE, healthVerdict: 'valid', healthExport: record(SP_WIDE) }),
            model({ id: 'i4', name: 'Mode band', targetSensor: 'TAG4', healthSetPoints: EMPTY_SP }),
        ]), ['i4']));
    }

    it('a workspace reopened on a dataset of ANOTHER time range (every train period outside): nothing is written, Complete stays Complete in both windows, Train is blocked with the reason — and Edit repairs it', async () => {
        seedOtherYear();
        const bytes = fgBytes();
        await mountWindows();
        openDashFgTab();
        selectSensor('tag4');
        await settle(600);
        const RANGE_27 = '2027/01/01 00:00 – 2027/01/03 11:00';
        const REASON = `No train period is inside the data (${RANGE_27}) — nothing to train on. Move a train period inside the data (Running condition → Edit).`;

        // ── the card says it; the never-trained model cannot train ───────────
        expect(card().getAttribute('data-norows')).toBe('true');
        expect(card().getAttribute('data-state')).toBe('set');
        expect(bmw().getByTestId('rc-card-use').textContent).toBe('Nothing to train on');
        expectCardHasNoRowCount();
        expect(bmw().getByTestId('rc-card-outside').textContent)
            .toBe(`⚠ P1 is outside the data (${RANGE_27}) — it is not used · S1 is outside the data — nothing is scored there`);
        expect(footReason()).toBe(REASON);
        expect(trainBtn().disabled).toBe(true);
        expect(trainWhy()).toBe("Can't train · see below");
        expect(bmwDot('i4').state).toBe('blocked');

        // ── the Complete model stays Complete, here and on the Dashboard ──────
        expect(bmwDot('i3').state).toBe('complete');
        expect(dashDot(1, 'tag3', 'individual')).toBe('complete');
        selectSensor('tag3');
        // its data is not in this file: ONE board says exactly that — not "Couldn't load
        // the model · Load it again", which could never work
        await waitFor(() => expect(bmw().getByTestId('results-no-data')).toBeTruthy(), { timeout: 4000 });
        await settle(400);
        expect(noDataBoard()).toEqual({
            title: NO_DATA_TITLE,
            text: `None of its train periods is inside the data (${RANGE_27}). Fix it in Running condition ↑ to see its charts.`,
            detail: 'Complete · nothing about the model changed',
        });
        expect(bmw().queryByTestId('results-load-failed')).toBeNull();
        expect(pill()).toBe('Complete');
        expect(tabWords('i3')).toBe('Complete · no data in the loaded file');
        expect(bmwDot('i3').state).toBe('complete');
        expect(bmw().getByTestId('footer-no-data').textContent).toBe('Complete · no rows for it in the loaded file — fix the running condition to see its charts');
        expect(bmwEl().textContent).not.toMatch(/No valid numeric values|dropping nulls|Couldn't load|Load it again|Training failed/);
        // training it AGAIN is what is blocked, said where Train is offered
        expect(trainBtn().disabled).toBe(true);
        expect(trainWhy()).toBe("Can't train · No train period inside the data");
        // its Health score page is open (not a shut tab): the same board, Mark incomplete reachable
        expect(bmw().getByTestId('page-tab-health').getAttribute('aria-disabled')).toBeNull();
        // a Complete model: no "set points needed" cue on tab ②
        expect(bmw().queryByTestId('page-tab-health-dot')).toBeNull();
        fireEvent.click(bmw().getByTestId('page-tab-health'));
        await settle(400);
        expect(noDataBoard().title).toBe(NO_DATA_TITLE);
        expect(bmw().queryByTestId('set-points-card')).toBeNull();
        expect(pill()).toBe('Complete');
        expect((bmw().getByTestId('mark-incomplete') as HTMLButtonElement).disabled).toBe(false);
        fireEvent.click(bmw().getByTestId('page-tab-model'));

        // ── the trained model: still trained on disk, on the Dashboard AND here — never "Training failed" ──
        expect(dashDot(1, 'tag1', 'individual')).toBe('trained');
        selectSensor('tag1');
        await settle(600);
        expect(noDataBoard()).toEqual({
            title: NO_DATA_TITLE,
            text: `None of its train periods is inside the data (${RANGE_27}). Fix it in Running condition ↑ to see its charts.`,
            detail: 'Trained · nothing about the model changed',
        });
        expect(bmw().queryByTestId('results-error')).toBeNull();
        expect(pill()).toBe('Trained');
        expect(tabWords('i1')).toMatch(/^(Trained|Set points needed) · no data in the loaded file$/);
        expect(bmwDot('i1').state).toBe('trained');
        expect(bmwEl().textContent).not.toMatch(/No valid numeric values|dropping nulls|Couldn't load|Training failed/);
        expect(trainBtn().disabled).toBe(true);
        expect(trainWhy()).toBe("Can't train · No train period inside the data");
        // Mark complete could only fail (the export needs the data): disabled, with that reason
        fireEvent.click(bmw().getByTestId('page-tab-health'));
        await settle(400);
        expect(noDataBoard().title).toBe(NO_DATA_TITLE);
        expect(markBtn().disabled).toBe(true);
        expect(markBtn().title).toBe('No data for this model in the loaded file — fix the running condition (Running condition → Edit) first');
        fireEvent.click(bmw().getByTestId('page-tab-model'));
        expect(dashDot(1, 'tag1', 'individual')).toBe('trained');

        // ── opening changed nothing on disk, nothing was broadcast, and the engine was never asked
        //    for a model that has no row in this file (no silent load, no preview, no export) ──
        expect(fgBytes()).toBe(bytes);
        expect(bmwBroadcasts()).toEqual([]);
        expect(env.backend!.calls.filter(c => c.error).map(c => `${c.cmd}: ${c.error}`)).toEqual([]);
        expect(trains()).toEqual([]);
        expect(env.backend!.cmds('compute_health_preview')).toHaveLength(0);
        expect(env.backend!.cmds('export_model_files')).toHaveLength(0);

        // ── repair through Edit: the saved row only warns, moving it into the data applies ──
        const dlg = openRc();
        expect(dlg.getByTestId('period-data-note-1').textContent).toBe(`P1 is outside the data (${RANGE_27}) — it is not used`);
        expect(dlg.queryByTestId('period-invalid-1')).toBeNull();
        expect(bmw().queryByTestId('rc-apply-block')).toBeNull();
        expect(fgBytes()).toBe(bytes); // still nothing written: opening the settings is not an edit
        type(dlg.getByLabelText('P1 end'), '2027-01-02T23:00');
        // half-moved (starts in 2025, ends in 2027): partly inside — allowed, with its quiet note
        expect(dlg.queryByTestId('period-invalid-1')).toBeNull();
        type(dlg.getByLabelText('P1 start'), '2027-01-01T00:00');
        expect(dlg.queryByTestId('period-data-note-1')).toBeNull();
        expect(bmw().getByTestId('rc-impact').textContent).toBe('Applying sets 2 models back to Incomplete — they need training again');
        expect(apply().disabled).toBe(false);
        await act(async () => { fireEvent.click(apply()); });
        await waitFor(() => expect(readDisk().failureGroupState.runningConditionTimePeriods).toEqual([{ ...P25, start: '2027-01-01T00:00', end: '2027-01-02T23:00' }]));
        await waitFor(() => expect(card().getAttribute('data-norows')).toBeNull());
        await waitFor(() => expect(lastCountRows()).toBe(37));
        expect(bmw().queryByTestId('rc-card-no-rows')).toBeNull();
        expectCardHasNoRowCount();
        // the saved scoring period is still outside the data: one amber line, not a block
        expect(bmw().getByTestId('rc-card-outside').textContent).toBe('⚠ S1 is outside the data — nothing is scored there');

        // ── and now Train works for the model that could not ─────────────────
        selectSensor('tag4');
        await settle(300);
        expect(footReason()).toBeNull();
        expect(trainBtn().disabled).toBe(false);
        await act(async () => { fireEvent.click(trainBtn()); });
        await waitFor(() => expect(freshOnDisk('i4')).toBe(true), { timeout: 8000 });
        await waitFor(() => expect(dashDot(1, 'tag4', 'individual')).not.toBe('none'));
    });

    // -----------------------------------------------------------------------
    // A board never offers a link to a control that is disabled. The state is
    // described truthfully — ONE "No data for this model in the loaded file"
    // board whose only link is the place where it is fixed.
    //
    // Scenario (both): a workspace whose saved train periods all lie outside
    // the loaded data (saved on a 2025 CSV, opened with a 2027 CSV) holding a
    // model that already has results. Open Build Model and select that model.
    // -----------------------------------------------------------------------
    /** Every link of `board` leads somewhere: none is disabled, and none points at Train. */
    const expectOnlyTheRcLink = (board: HTMLElement) => {
        const links = within(board).getAllByRole('button') as HTMLButtonElement[];
        expect(links.map(b => b.textContent)).toEqual(['Running condition ↑']);
        expect(links[0].disabled).toBe(false);
        for (const id of ['board-train-menu', 'board-train-sensor', 'board-load-again', 'board-load-fit']) {
            expect(within(board).queryByTestId(id), id).toBeNull();
        }
        // …and it works: the Running-condition settings open
        fireEvent.click(links[0]);
        expect(bmw().getByRole('dialog', { name: 'Running condition' })).toBeTruthy();
        fireEvent.click(bmw().getByTestId('rc-cancel'));
    };

    it('a COMPLETE model with no data in the loaded file: no "Couldn\'t load…" board and no link to the disabled Train sensor ▾ menu — the "No data…" board\'s ONE link opens the Running-condition settings', async () => {
        seedOtherYear();
        await mountWindows();
        selectSensor('tag3');
        const board = await waitFor(() => bmw().getByTestId('results-no-data'), { timeout: 4000 });
        await settle(300);
        // the menu cannot be opened: no train period is inside the data
        expect((bmw().getByTestId('train-sensor-menu-toggle') as HTMLButtonElement).disabled).toBe(true);
        expect(bmw().queryByTestId('results-load-failed')).toBeNull();
        expect(bmw().queryByTestId('footer-load-again')).toBeNull();
        expect(pill()).toBe('Complete');
        expectOnlyTheRcLink(board);
    });

    it('a TRAINED model with no data in the loaded file: never "Training failed … Train sensor ↑" (Train sensor is disabled) — it stays "Trained" and the "No data…" board\'s ONE link opens the Running-condition settings', async () => {
        seedOtherYear();
        await mountWindows();
        selectSensor('tag1');
        const board = await waitFor(() => bmw().getByTestId('results-no-data'), { timeout: 4000 });
        await settle(300);
        expect(trainBtn().disabled).toBe(true); // nothing to train on
        expect(bmw().queryByTestId('results-error')).toBeNull();
        expect(bmw().queryByTestId('footer-train-sensor')).toBeNull();
        expect(pill()).toBe('Trained');
        expect(bmwDot('i1').state).toBe('trained');
        expectOnlyTheRcLink(board);
    });
});
