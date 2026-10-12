import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';

/*
 * Train copy + page
 * states, the app-wide "Relation model" wording and the
 * engine messages Rust sends. Real Dashboard + real
 * Build Model window + real `workspaceManager` on one in-memory workspace
 * file, the fake Rust backend.
 *
 *   A. Train copy / page states that depend on what is on DISK or on the other
 *      window: the ▾ menu rows, the stale banner with no dead link, closing
 *      during a run, "Load it again" for a Complete model, a legacy Complete
 *      model whose ▾ train failed.
 *   B. Wording: a workspace saved with "X (Relationship)" names; a whole
 *      journey in which neither window ever says "Relationship", "sidecar",
 *      "Python" or the algorithm's name.
 *   C. The engine fails with the sentences Rust sends today: every place
 *      shows that fixed sentence and nothing else.
 *
 * Covered elsewhere and NOT repeated here:
 *   - a Custom-mode model trains, opens Health score and is marked Complete
 *     while the WORKSPACE running condition is unset:
 *     `WorkbenchSpineOneButton.integration.test.tsx` ("a Custom-mode model while…");
 *   - a Complete Relation model whose fit Rust dropped (NOT_FITTED) + "Load it
 *     again": `WorkbenchFitLostCrossWindow.integration.test.tsx` (a) / (c);
 *   - every menu label / state line / board per kind in one window with mocked
 *     storage: `BuildModelWindow.test.tsx`, `TrainQueueParts.test.tsx`;
 *   - the source scan for forbidden words: `UserFacingWording.test.ts`.
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

import { env, nativeClose, resetEnv } from './helpers/healthEnv';
import {
    COND, WS, bmw, bmwDot, bmwEl, dash, dashDot, diskModel, enterSp, markBtn, markComplete, model, mountWindows, newBackend,
    openDashFgTab, openDashSensorTab, openHealth, openSettings, pickInModal, pill, readDisk, restartApp, selectKindTab, selectSensor,
    settle, waitForCharts, writeDisk, wsFile, wsState, wsTrained,
} from './helpers/healthWorkbench';
import { computeTrainFingerprint } from '../utils/trainFingerprint';

vi.setConfig({ testTimeout: 90_000 });

beforeEach(() => {
    resetEnv();
    newBackend();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const P_IN = { id: 'p1', start: '2026-01-01T00:00', end: '2026-01-02T23:00' };
const P_OUT = { id: 'p9', start: '2027-03-01T00:00', end: '2027-03-10T00:00' };
const S_IN = { id: 's1', start: '2026-01-03T00:00', end: '2026-01-03T11:00' };
const SP1 = { kind: 'individual', lower: 20, upper: 80, masterLower: 20, masterUpper: 80 };
const SP_WIDE = { kind: 'individual', lower: -500, upper: 500, masterLower: null, masterUpper: null };
const EMPTY_SP = { kind: 'individual', lower: null, upper: null };
const REL_SP = { kind: 'relationship', residualAt80Lower: -5, residualAt80Upper: 5, residualAt0Lower: -10, residualAt0Upper: 10 };
// (`scoringIntervalSecs`: a record as THIS build writes it — the saved results use 1-hour averages; one without it gets the footer's "earlier row-by-row scoring" hint, covered in BuildModelWindow.test.tsx)
const record = (setPoints: unknown) => ({ at: '2026-10-05T08:00:00.000Z', outputDir: env.backend!.outputDir(WS), setPoints, scoringIntervalSecs: 3600 });
const FG = { runningConditionTimePeriods: [P_IN], runningConditionTestPeriods: [S_IN] };

const wsWrites = () => env.writes.filter(w => w.path === wsFile()).length;
const modelsBytes = () => JSON.stringify(readDisk().failureGroupState.models);
const bmwBroadcasts = () => env.emitted.filter(e => e.event === 'failure-group-state-changed' && e.payload?.origin === 'build-model');
const trainBtn = () => bmw().getByTestId('train-sensor') as HTMLButtonElement;
const trainWhy = () => bmw().getByTestId('train-sensor-why').textContent;
/** A kind tab's status words: the dot's tooltip — and the SAME string shown on the tab beside the dot (v2 §2). */
const tabWords = (id: string) => {
    const title = bmw().getByTestId(`tab-status-${id}`).getAttribute('title');
    expect(bmw().getByTestId(`tab-words-${id}`).textContent).toBe(title);
    return title;
};
/** The notice line (null when there is nothing to fix or wait for: no line at all). */
const footer = () => bmw().queryByTestId('wb-notice');
const sentence = () => footer()?.querySelector('.wbx-reason')?.textContent ?? null;
const stripPhase = () => bmw().queryByTestId('train-run-strip')?.getAttribute('data-phase') ?? null;
const freshOnDisk = (mid: string) => {
    const fg = readDisk().failureGroupState;
    const m = fg.models.find((x: any) => x.id === mid);
    return !!m.lastTrainedAt && m.trainedFingerprint === computeTrainFingerprint(m, fg);
};
const never = (state: any, ids: string[]) => {
    for (const m of state.failureGroupState.models) if (ids.includes(m.id)) { delete m.lastTrainedAt; delete m.trainedFingerprint; }
    return state;
};
const openMenu = () => {
    const t = bmw().getByTestId('train-sensor-menu-toggle');
    if (t.getAttribute('aria-expanded') !== 'true') fireEvent.click(t);
};
const closeMenu = () => fireEvent.keyDown(window, { key: 'Escape' });
/** Label + state line of every row of the open ▾ menu, by its key. */
const menuRows = () => Object.fromEntries(
    [...bmwEl().querySelectorAll<HTMLElement>('[data-testid^="train-menu-"]')].map(el => [
        el.getAttribute('data-testid')!.replace('train-menu-', ''),
        `${el.firstChild!.textContent} | ${el.querySelector('small')?.textContent ?? ''}`,
    ]),
);
/** Another window (or an older build) writes the workspace file and tells everyone. */
async function otherWriter(patch: Record<string, unknown>) {
    const { updateWorkspaceData } = await import('../workspaceManager');
    const { withFailureGroupState } = await import('../utils/failureGroupState');
    const { emit } = await import('@tauri-apps/api/event');
    await act(async () => {
        const next = await updateWorkspaceData(WS, prev => withFailureGroupState(prev, patch as any));
        await emit('failure-group-state-changed', { ...next!.failureGroupState, workspaceId: WS, origin: 'dashboard' });
    });
    await settle(50);
}

// What Rust sends when the Relation model engine fails.
const ENGINE_FIT_FAILED = 'The Relation model engine could not fit this model. The details are in the error log.';
const ENGINE_NO_OUTPUT = 'The Relation model engine stopped without returning a result. The details are in the error log.';
const ENGINE_NO_START = 'The Relation model engine could not start: it is missing from this installation or is damaged. Please reinstall or update the app. Detail: program not found';
const ENGINE_OUTDATED = 'SIDECAR_OUTDATED: The Relation model engine in this build is out of date - please reinstall or update the app.';

// ---------------------------------------------------------------------------
// The words a user must never read
// ---------------------------------------------------------------------------

const FORBIDDEN = /relationship|sidecar|python|linear\s*gam|\bgam\b|pygam|nuitka|stderr|traceback/i;
/** Everything a user can read or hear in the document: text, tooltips, labels, placeholders, field values. */
function readable(): string {
    const parts: string[] = [document.body.textContent ?? ''];
    document.body.querySelectorAll('*').forEach(el => {
        for (const a of ['title', 'aria-label', 'placeholder', 'alt']) {
            const v = el.getAttribute(a);
            if (v) parts.push(v);
        }
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) parts.push(el.value);
    });
    return parts.join('\n');
}
function expectCleanWords(step: string) {
    const hit = readable().split('\n').filter(line => FORBIDDEN.test(line)).map(l => l.slice(0, 200));
    expect(hit, `a forbidden word is readable — ${step}`).toEqual([]);
}

// ---------------------------------------------------------------------------
// A. Train copy / page states
// ---------------------------------------------------------------------------

describe('A. Train sensor ▾ and the page states, on the real workspace file', () => {
    it('the ▾ menu follows the train records on disk: one row for a single-model sensor; "Re-train all 2 models" only once EVERY model was trained — and still after the app is restarted', async () => {
        writeDisk(never(wsTrained(FG, [
            model({ id: 'i1', name: 'Pressure band', targetSensor: 'TAG1', healthSetPoints: SP1, healthVerdict: 'valid' }),
            model({ id: 'r1', name: 'Pressure from flow', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG3'] }),
            model({ id: 'i4', name: 'Mode band', targetSensor: 'TAG4', groupNos: [2], healthSetPoints: EMPTY_SP }),
        ]), ['r1', 'i4']));
        await mountWindows();
        openDashFgTab();

        // ── a sensor with ONE model: one row, named after the model — never "Train all 1 model" ──
        selectSensor('tag4', 2);
        await settle(300);
        openMenu();
        expect(menuRows()).toEqual({ 'only-individual': 'Train the Individual model | Not trained yet · ≈ 1 s' });
        closeMenu();

        // ── Individual trained, Relation model never: the all-row is still "Train all" ──
        selectSensor('tag1');
        await waitForCharts();
        expect(trainBtn().textContent).toBe('▶ Train sensor · 1 of 2');
        expect(trainWhy()).toBe('Trains the Relation model · Individual up to date, skipped');
        openMenu();
        expect(menuRows()).toEqual({
            'retrain-all': 'Train all 2 models | Includes the 1 up to date',
            'only-individual': 'Re-train Individual only | Up to date · trains anyway',
            'only-relationship': 'Relation model only | Not trained yet · ≈ 15 s',
        });
        closeMenu();
        expect(dashDot(1, 'tag1', 'relationship')).toBe('none');

        // ── Train sensor trains the one that needs it; the record lands on disk and on the Dashboard ──
        await act(async () => { fireEvent.click(trainBtn()); });
        await waitFor(() => expect(stripPhase()).toBe('done'), { timeout: 8000 });
        await settle(50);
        expect(freshOnDisk('r1')).toBe(true);
        expect(env.backend!.cmds('preview_relationship_model').filter(c => c.args.cache_key)).toHaveLength(1);
        await waitFor(() => expect(dashDot(1, 'tag1', 'relationship')).not.toBe('none'));
        expect(trainBtn().textContent).toBe('▶ Train sensor');
        openMenu();
        const all = () => menuRows();
        expect(Object.keys(all()).sort()).toEqual(['only-individual', 'only-relationship', 'retrain-all']);
        expect(all()['retrain-all']).toMatch(/^Re-train all 2 models \| /);
        expect(all()['only-individual']).toBe('Re-train Individual only | Up to date · trains anyway');
        expect(all()['only-relationship']).toBe('Re-train Relation model only | Up to date · trains anyway');
        closeMenu();

        // ── restart: the labels come from the file, not from this session ───
        await restartApp();
        selectSensor('tag1');
        await waitForCharts();
        openMenu();
        expect(menuRows()['retrain-all']).toMatch(/^Re-train all 2 models \| /);
        expect(menuRows()['only-relationship']).toMatch(/^Re-train Relation model only \| /);
        closeMenu();
        selectSensor('tag4', 2);
        await settle(300);
        openMenu();
        expect(Object.keys(menuRows())).toEqual(['only-individual']);
        expect(menuRows()['only-individual']).toBe('Train the Individual model | Not trained yet · ≈ 1 s');
    });

    it('the stale banner never offers a dead link: "Train sensor ↑" when it would train it; the named reason when nothing can train it; "when the training run finishes" while a run is active', async () => {
        writeDisk(wsTrained(FG, [
            model({ id: 'i1', name: 'Pressure band', targetSensor: 'TAG1', healthSetPoints: SP1, healthVerdict: 'valid' }),
            model({ id: 'i4', name: 'Mode band', targetSensor: 'TAG4', groupNos: [2], healthSetPoints: SP_WIDE, healthVerdict: 'valid' }),
        ]));
        await mountWindows();
        openDashFgTab();
        selectSensor('tag1');
        await waitForCharts();
        expect(bmw().queryByTestId('stale-banner')).toBeNull();
        const banner = () => bmw().getByTestId('stale-banner');

        // ── another window changes the condition: stale, and Train sensor WOULD train it ──
        await otherWriter({ runningConditionFilters: [{ ...COND, value1: '20' }] });
        await waitFor(() => expect(banner().getAttribute('data-state')).toBe('stale'));
        expect(banner().textContent).toBe('Settings or running condition changed — this model is Incomplete again. Train it again with Train sensor ↑ to update the charts. Your set points are kept.');
        expect(banner().querySelector('.rcx-btn')).toBeNull(); // no button of its own
        fireEvent.click(bmw().getByTestId('stale-go-train'));
        expect(document.activeElement).toBe(trainBtn());
        expect(trainBtn().disabled).toBe(false);

        // ── now nothing can train it (no train period inside the data): the reason, no link ──
        await otherWriter({ runningConditionTimePeriods: [P_OUT] });
        await waitFor(() => expect(banner().getAttribute('data-state')).toBe('blocked'));
        expect(bmw().queryByTestId('stale-go-train')).toBeNull();
        expect(bmw().getByTestId('stale-cant-train').textContent)
            .toBe("It can't be trained yet: No train period is inside the data (2026/01/01 00:00 – 2026/01/03 11:00) — nothing to train on. Move a train period inside the data (Running condition → Edit). ");
        expect(banner().textContent).toMatch(/Your set points are kept\.$/);
        expect(trainBtn().disabled).toBe(true);
        // the set points really are kept, and the train record was not touched by the block
        expect(diskModel('i1').healthSetPoints).toEqual(SP1);
        expect(diskModel('i1').lastTrainedAt).toBe('2026-10-01T10:00:00.000Z');

        // ── the period is back inside the data; a run is active on ANOTHER sensor ──
        await otherWriter({ runningConditionTimePeriods: [P_IN] });
        await waitFor(() => expect(banner().getAttribute('data-state')).toBe('stale'));
        const hold = env.backend!.gate('compute_sensor_stats', a => a?.sensor === 'TAG4');
        selectSensor('tag4', 2);
        await settle(300);
        await act(async () => { fireEvent.click(trainBtn()); });
        await waitFor(() => expect(hold.entered).toBe(true));
        selectSensor('tag1');
        await settle(300);
        expect(banner().getAttribute('data-state')).toBe('blocked');
        expect(bmw().getByTestId('stale-cant-train').textContent).toBe('Train it again when the training run finishes. ');
        expect(bmw().queryByTestId('stale-go-train')).toBeNull();
        await act(async () => { hold.release(); });
        await waitFor(() => expect(stripPhase()).toBe('done'), { timeout: 8000 });
        // the run is over: the link is back, and it trains
        await waitFor(() => expect(bmw().getByTestId('stale-go-train')).toBeTruthy());
        await act(async () => { fireEvent.click(trainBtn()); });
        await waitFor(() => expect(freshOnDisk('i1')).toBe(true), { timeout: 8000 });
        await waitFor(() => expect(bmw().queryByTestId('stale-banner')).toBeNull());
        await waitFor(() => expect(dashDot(1, 'tag1', 'individual')).toBe('trained'));
    });

    it('closing the window during a run asks first: focus is on "Keep training", Esc keeps training, the run finishes and the window was never closed', async () => {
        writeDisk(never(wsTrained(FG, [
            model({ id: 'i1', name: 'Pressure band', targetSensor: 'TAG1', healthSetPoints: EMPTY_SP }),
            model({ id: 'i4', name: 'Mode band', targetSensor: 'TAG4', groupNos: [2], healthSetPoints: EMPTY_SP }),
        ]), ['i1', 'i4']));
        await mountWindows();
        selectSensor('tag1');
        await settle(300);
        const hold = env.backend!.gate('compute_sensor_stats', a => a?.sensor === 'TAG1');
        await act(async () => { fireEvent.click(bmw().getByTestId('train-all')); });
        await act(async () => { fireEvent.click(bmw().getByTestId('train-all-start')); });
        await waitFor(() => expect(hold.entered).toBe(true));
        fireEvent.click(bmw().getByTestId('train-all-close'));

        // the OS close button: held back, the dialog asks
        let prevented = false;
        await act(async () => { prevented = await nativeClose(); });
        expect(prevented).toBe(true);
        const dialog = await waitFor(() => screen.getByTestId('close-run-dialog'));
        expect(document.activeElement).toBe(screen.getByTestId('close-run-keep'));
        // Tab stays inside the dialog
        const buttons = [...dialog.querySelectorAll('button')];
        buttons[buttons.length - 1].focus();
        fireEvent.keyDown(buttons[buttons.length - 1], { key: 'Tab' });
        expect(dialog.contains(document.activeElement)).toBe(true);

        // Esc = Keep training
        fireEvent.keyDown(window, { key: 'Escape' });
        await waitFor(() => expect(screen.queryByTestId('close-run-dialog')).toBeNull());
        expect(env.windowClose).toBe(0);
        expect(stripPhase()).toBe('running');

        await act(async () => { hold.release(); });
        await waitFor(() => expect(stripPhase()).toBe('done'), { timeout: 8000 });
        expect(freshOnDisk('i1')).toBe(true);
        expect(freshOnDisk('i4')).toBe(true);
        expect(env.windowClose).toBe(0);
        // with no run active the same close goes straight through
        await act(async () => { prevented = await nativeClose(); });
        expect(screen.queryByTestId('close-run-dialog')).toBeNull();
    });

    it('a COMPLETE model whose silent load failed: "Couldn\'t load…" with "Load it again" — it loads, stays Complete, the Dashboard dot never moves, and nothing is written or broadcast', async () => {
        writeDisk(wsTrained(FG, [
            model({ id: 'i1', name: 'Pressure band', targetSensor: 'TAG1', healthSetPoints: SP1, healthVerdict: 'valid' }),
            model({ id: 'i3', name: 'Flow band', targetSensor: 'TAG3', status: true, healthSetPoints: SP_WIDE, healthVerdict: 'valid', healthExport: record(SP_WIDE) }),
        ]));
        const bytes = modelsBytes();
        // the disk under the CSV hiccups whenever TAG3 is read
        env.backend!.failOn('compute_sensor_stats', a => a?.sensor === 'TAG3', 'Failed to read column: transient I/O error.', false);
        await mountWindows();
        openDashFgTab();
        expect(dashDot(1, 'tag3', 'individual')).toBe('complete');
        await settle(500); // the Dashboard's own autosave of "the Failure Groups tab is open" has landed
        const writes = wsWrites();
        selectSensor('tag3');
        const board = await waitFor(() => bmw().getByTestId('results-load-failed'), { timeout: 4000 });
        expect(bmw().queryByTestId('results-error')).toBeNull(); // not "Training failed"
        expect(board.querySelector('.wbx-msg-t')!.textContent).toBe("Couldn't load the Individual model");
        expect(board.querySelector('.wbx-msg-d')!.textContent).toBe('Failed to read column: transient I/O error.');
        expect(board.textContent).not.toContain('Train sensor ↑'); // it would not train an up-to-date Complete model
        expect(pill()).toBe('Complete');
        expect(sentence()).toBe("Couldn't load the model · load it again");
        expect(tabWords('i3')).toBe("Complete · Couldn't load the model");
        expect(bmw().getByTestId('page-tab-health').getAttribute('aria-disabled')).toBe('true');
        expect(bmw().getByTestId('page-tab-health-why').textContent).toBe('Load the model again first');
        expect(bmw().queryByTestId('next-health-score')).toBeNull(); // no disabled copy of it
        // the other window knows nothing of it: still green
        expect(dashDot(1, 'tag3', 'individual')).toBe('complete');
        expect(bmwDot('i3').state).toBe('complete');

        // "Load it again" while the disk still fails: back on the same board
        const calls = () => env.backend!.cmds('compute_sensor_stats').filter(c => c.args.sensor === 'TAG3').length;
        let n = calls();
        await act(async () => { fireEvent.click(bmw().getByTestId('board-load-again')); });
        await waitFor(() => expect(calls()).toBe(n + 1));
        await waitFor(() => expect(bmw().getByTestId('results-load-failed')).toBeTruthy());

        // …and once it reads again: the charts, the Health score page, still Complete
        env.backend!.clearFaults();
        n = calls();
        await act(async () => { fireEvent.click(bmw().getByTestId('board-load-again')); });
        await waitFor(() => expect(calls()).toBe(n + 1));
        await waitForCharts();
        expect(bmw().queryByTestId('results-load-failed')).toBeNull();
        expect(pill()).toBe('Complete');
        expect(tabWords('i3')).toBe('Complete');
        expect(bmw().queryByTestId('train-run-strip')).toBeNull(); // not a training run
        await openHealth();
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
        expect((bmw().getByTestId('mark-incomplete') as HTMLButtonElement).disabled).toBe(false);
        await settle(300);

        // nothing about the model changed anywhere
        expect(modelsBytes()).toBe(bytes);
        expect(wsWrites()).toBe(writes);
        expect(bmwBroadcasts()).toEqual([]);
        expect(dashDot(1, 'tag3', 'individual')).toBe('complete');
    });

    it('a Complete model with NO train record (marked complete by an old build) whose ▾ train failed: "Training failed" on its board with the ▾ menu as the way out — still Complete on disk; the next try trains it and it then waits for Mark complete', async () => {
        // saved before train records existed: Complete, no lastTrainedAt / trainedFingerprint
        writeDisk(wsState({
            ...FG,
            models: [model({ id: 'i3', name: 'Flow band', targetSensor: 'TAG3', status: true, healthSetPoints: SP_WIDE, healthVerdict: 'valid', healthExport: record(SP_WIDE) })],
        }));
        await mountWindows();
        openDashFgTab();
        selectSensor('tag3');
        await settle(500);
        const bytes = modelsBytes();
        const dot0 = dashDot(1, 'tag3', 'individual');
        const board = () => bmw().getByTestId('results-placeholder');
        expect(board().querySelector('.wbx-msg-t')!.textContent).toBe('Marked complete');
        expect(board().querySelector('.wbx-msg-s')!.textContent)
            .toBe('To see its charts, train it from the Train sensor ▾ menu (“Train the Individual model”). It then needs Mark complete again.');
        expect(pill()).toBe('Complete');
        // nothing was trained by opening it
        expect(env.backend!.cmds('compute_sensor_stats').filter(c => c.args.sensor === 'TAG3')).toHaveLength(0);

        // ── the ▾ row trains it — and the engine fails ──────────────────────
        env.backend!.failOn('compute_sensor_stats', a => a?.sensor === 'TAG3', 'Failed to read column: transient I/O error.');
        fireEvent.click(within(board()).getByTestId('board-train-menu'));
        const row = bmw().getByTestId('train-menu-only-individual') as HTMLButtonElement;
        expect(row.disabled).toBe(false);
        await act(async () => { fireEvent.click(row); });
        await waitFor(() => expect(bmw().getByTestId('board-train-error')).toBeTruthy(), { timeout: 8000 });
        expect(bmw().getByTestId('board-train-error').textContent).toBe('Training failed: Failed to read column: transient I/O error.');
        expect(board().querySelector('.wbx-msg-s')!.textContent)
            .toBe('Training it did not work, so it still has no charts. Fix the problem, then train it again from the Train sensor ▾ menu (“Train the Individual model”). It then needs Mark complete again.');
        expect(board().className).toContain('wbx-msg--bad');
        expect(tabWords('i3')).toBe('Complete · Training failed');
        expect(board().textContent).not.toContain('Load it again'); // there is nothing to load again
        // a failed train changes nothing: still Complete, on disk and on the Dashboard
        expect(pill()).toBe('Complete');
        expect(modelsBytes()).toBe(bytes);
        expect(dashDot(1, 'tag3', 'individual')).toBe(dot0);

        // ── the way out works: the same menu row, now it trains ─────────────
        fireEvent.click(within(board()).getByTestId('board-train-menu'));
        await act(async () => { fireEvent.click(bmw().getByTestId('train-menu-only-individual')); });
        await waitFor(() => expect(freshOnDisk('i3')).toBe(true), { timeout: 8000 });
        await waitForCharts();
        expect(bmw().queryByTestId('board-train-error')).toBeNull();
        // trained now, and (as the board said) it needs Mark complete again
        expect(diskModel('i3').status).toBe(false);
        expect(pill()).not.toBe('Complete');
        await waitFor(() => expect(dashDot(1, 'tag3', 'individual')).toBe('trained'));
        expect(diskModel('i3').healthSetPoints).toEqual(SP_WIDE);
    });
});

// ---------------------------------------------------------------------------
// B. Wording
// ---------------------------------------------------------------------------

describe('B. "Relation model" everywhere — and a workspace that still holds the old word in its model names', () => {
    it('saved names "X (Relationship)": both windows open with the same names, statuses and train records (nothing is rewritten); Mark complete again exports under the saved name; a suggested name says "(Relation model)"', async () => {
        writeDisk(wsTrained(FG, [
            model({ id: 'i1', name: 'Pump Pressure', targetSensor: 'TAG1', healthSetPoints: SP1, healthVerdict: 'valid' }),
            model({
                id: 'r1', name: 'Pump Pressure (Relationship)', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG3'],
                status: true, healthSetPoints: REL_SP, healthVerdict: 'valid', healthExport: record(REL_SP), customTestPeriods: [],
            }),
        ]));
        const bytes = modelsBytes();
        await mountWindows();
        openDashFgTab();
        selectSensor('tag1');
        selectKindTab('Relation model');
        await waitForCharts();

        // ── opened: the same model, the same state, in both windows ─────────
        expect(pill()).toBe('Complete');
        expect(bmwDot('r1').state).toBe('complete');
        expect(dashDot(1, 'tag1', 'relationship')).toBe('complete');
        expect(dashDot(1, 'tag1', 'individual')).toBe('trained');
        // the kind is called "Relation model" by the app; the user's own name is shown as they saved it
        expect(bmw().getAllByRole('tab').map(t => t.textContent).join(' | ')).toMatch(/Relation model/);
        openSettings();
        expect((bmw().getByDisplayValue('Pump Pressure (Relationship)') as HTMLInputElement).value).toBe('Pump Pressure (Relationship)');
        // the only place either window says the old word is that saved name
        const lines = readable().split('\n').filter(l => /relationship/i.test(l));
        expect(lines.length).toBeGreaterThan(0);
        for (const l of lines) expect(l.replace(/Pump Pressure \(Relationship\)/g, ''), l.slice(0, 160)).not.toMatch(/relationship/i);
        await settle(400);
        expect(modelsBytes()).toBe(bytes); // names, statuses, fingerprints, verdicts: byte-identical

        // ── a suggested name for THIS model says "(Relation model)" ─────────
        const name = bmw().getByDisplayValue('Pump Pressure (Relationship)');
        fireEvent.change(name, { target: { value: 'Pump Pressure' } }); // the Individual model's name
        expect(bmw().getByTestId('duplicate-name-warning').textContent).toContain("Same name as this sensor's Individual model");
        expect(bmw().getByTestId('use-suggested-name').textContent).toBe("Use 'Pump Pressure (Relation model)'");
        // …the user keeps the old one instead: back to the saved name, nothing to save
        fireEvent.change(bmw().getByDisplayValue('Pump Pressure'), { target: { value: 'Pump Pressure (Relationship)' } });
        expect(bmw().queryByTestId('duplicate-name-warning')).toBeNull();
        // saving that (unchanged) draft rewrites nothing: not the name, not the Complete status
        await act(async () => { fireEvent.click(bmw().getByTestId('save-changes')); });
        await settle(200);
        expect(modelsBytes()).toBe(bytes);
        expect(pill()).toBe('Complete');

        // ── Mark complete again (a set point changed): the files are exported under the SAVED name ──
        await openHealth();
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
        await enterSp({ 'sp-residual_at_0_upper': '12' });
        const again = await waitFor(() => bmw().getByTestId('mark-complete-again') as HTMLButtonElement);
        await waitFor(() => expect(again.disabled).toBe(false));
        await act(async () => { fireEvent.click(bmw().getByTestId('mark-complete-again')); });
        await waitFor(() => expect(diskModel('r1').healthExport.setPoints.residualAt0Upper).toBe(12), { timeout: 8000 });
        const exp = env.backend!.cmds('export_model_files').slice(-1)[0];
        expect(exp.error).toBeUndefined();
        expect(exp.args.request.model_name).toBe('Pump Pressure (Relationship)');
        expect(exp.args.request.kind).toBe('relationship'); // the VALUE on the wire is unchanged
        expect(diskModel('r1')).toMatchObject({ name: 'Pump Pressure (Relationship)', kind: 'relationship', status: true });
        expect(diskModel('r1').trainedFingerprint).toBe(JSON.parse(bytes).find((m: any) => m.id === 'r1').trainedFingerprint);
        await waitFor(() => expect(dashDot(1, 'tag1', 'relationship')).toBe('complete'));
    });

    it('a second Relation model of the same sensor next to the legacy "X (Relationship)": the suggestion skips BOTH spellings — "X (Relation model) 2"', async () => {
        // An old workspace can hold one Relation model per failure group for the same sensor.
        writeDisk(wsTrained(FG, [
            model({ id: 'i1', name: 'Pump Pressure', targetSensor: 'TAG1', healthSetPoints: SP1, healthVerdict: 'valid' }),
            model({ id: 'r1', name: 'Pump Pressure (Relationship)', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG3'], groupNos: [1], healthSetPoints: REL_SP }),
            model({ id: 'r2', name: 'Pump Pressure B', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG5'], groupNos: [2], healthSetPoints: REL_SP }),
        ]));
        const bytes = modelsBytes();
        await mountWindows();
        selectSensor('tag1', 2);
        await settle(300);
        const tab = bmw().getAllByRole('tab').find(t => t.getAttribute('aria-selected') !== 'true' && bmw().queryByTestId('tab-status-r2') && t.contains(bmw().getByTestId('tab-status-r2')));
        if (tab) fireEvent.click(tab);
        await settle(300);
        openSettings();
        fireEvent.change(bmw().getByDisplayValue('Pump Pressure B'), { target: { value: 'Pump Pressure' } });
        expect(bmw().getByTestId('use-suggested-name').textContent).toBe("Use 'Pump Pressure (Relation model) 2'");
        await act(async () => { fireEvent.click(bmw().getByTestId('use-suggested-name')); });
        await act(async () => { fireEvent.click(bmw().getByTestId('save-changes')); });
        await waitFor(() => expect(diskModel('r2').name).toBe('Pump Pressure (Relation model) 2'));
        // the legacy twin was not renamed by it
        expect(diskModel('r1')).toEqual(JSON.parse(bytes).find((m: any) => m.id === 'r1'));
    });

    it('a whole journey — Dashboard sheet → Failure Groups tab → Build Model → settings → Train (the engine fails, then works) → Compare predictors → Health score → Mark complete (fails, then works): neither window ever says "Relationship", "sidecar", "Python" or the algorithm\'s name', async () => {
        writeDisk(wsState({ ...FG, models: [] }));
        await mountWindows();
        expectCleanWords('both windows, empty workspace');

        // ── Dashboard: the sensor's failure-group sheet ─────────────────────
        openDashSensorTab();
        fireEvent.change(dash().getByPlaceholderText('Search description, tag, unit or component…'), { target: { value: 'TAG1' } });
        await settle();
        const sensorRow = (screen.getByTestId('dashboard-window').querySelector('#sensor-TAG1') as HTMLElement).closest('.sensor-list-row') as HTMLElement;
        fireEvent.click(within(sensorRow).getByTitle('Add to failure group'));
        const sheet = within(await screen.findByTestId('fg-sheet'));
        expectCleanWords('the failure-group sheet');
        await act(async () => { fireEvent.click(sheet.getByRole('button', { name: 'Relation model · FG-A' })); });
        await settle(400);
        expectCleanWords('the sheet after the model was created');
        if (screen.queryByTestId('fg-sheet')) fireEvent.click(within(sensorRow).getByTitle('Add to failure group'));
        fireEvent.change(dash().getByPlaceholderText('Search description, tag, unit or component…'), { target: { value: '' } });
        const id = readDisk().failureGroupState.models[0].id;
        expect(readDisk().failureGroupState.models[0].kind).toBe('relationship'); // the saved VALUE is unchanged
        openDashFgTab();
        await settle(100);
        expectCleanWords('the Failure Groups tab');

        // ── Build Model: the new model, its settings ────────────────────────
        await waitFor(() => expect(bmw().getByTestId('sensor-list-row-fg:1-tag1')).toBeTruthy());
        selectSensor('tag1');
        await act(async () => { fireEvent.click(bmw().getByRole('button', { name: /Performance/i })); });
        await settle(50);
        expectCleanWords('Build Model, model not set up yet');
        openSettings();
        fireEvent.click(bmwEl().querySelector('button.pk-add') as HTMLElement);
        expectCleanWords('the predictor picker');
        await pickInModal('predictors', ['TAG3', 'TAG5']);
        await act(async () => { fireEvent.click(bmw().getByTestId('save-changes')); });
        await settle(100);
        expectCleanWords('settings saved');
        openMenu();
        expectCleanWords('the Train sensor ▾ menu');
        closeMenu();
        await act(async () => { fireEvent.click(bmw().getByTestId('train-all')); });
        expectCleanWords('the Train all preflight');
        fireEvent.click(bmw().getByTestId('train-all-close'));

        // ── Train: the engine build is out of date (Rust's coded answer), then it fails to fit ──
        env.backend!.failOn('preview_relationship_model', a => !!a?.cache_key, ENGINE_OUTDATED);
        await act(async () => { fireEvent.click(trainBtn()); });
        await waitFor(() => expect(bmw().getByTestId('results-error')).toBeTruthy(), { timeout: 8000 });
        expect(bmw().getByTestId('results-error').querySelector('.wbx-msg-d')!.textContent)
            .toBe('The Relation model engine in this build is out of date — reinstall or update the app, then try again.');
        expectCleanWords('train failed: engine out of date');
        fireEvent.click(bmw().getByTestId('train-run-details'));
        expectCleanWords('run details of the failed train');
        fireEvent.click(bmw().getByTestId('train-all-close'));
        env.backend!.failOn('preview_relationship_model', a => !!a?.cache_key, ENGINE_FIT_FAILED);
        await act(async () => { fireEvent.click(trainBtn()); });
        await waitFor(() => expect(bmw().getByTestId('results-error').querySelector('.wbx-msg-d')!.textContent).toBe(ENGINE_FIT_FAILED), { timeout: 8000 });
        expectCleanWords('train failed: could not fit');
        await settle(100);
        expect(dashDot(1, 'tag1', 'relationship')).toBe('none');
        expectCleanWords('Dashboard after the failed trains');

        // ── it trains ───────────────────────────────────────────────────────
        await act(async () => { fireEvent.click(trainBtn()); });
        await waitFor(() => expect(freshOnDisk(id)).toBe(true), { timeout: 8000 });
        await waitForCharts();
        expectCleanWords('Model fit page, trained');
        for (const c of env.charts) {
            const text = JSON.stringify([c.option?.title, c.option?.legend, (c.option?.series ?? []).map((s: any) => s?.name), c.option?.xAxis?.name, c.option?.yAxis?.name]);
            expect(text, 'a chart label').not.toMatch(FORBIDDEN);
        }

        // ── Compare predictors: one sub-model fit dies ──────────────────────
        env.backend!.failOn('preview_relationship_model', a => !a?.cache_key, ENGINE_NO_OUTPUT);
        await act(async () => { fireEvent.click(bmw().getByTestId('compare-predictors')); });
        const sub = await waitFor(() => screen.getByTestId('sub-models-modal'));
        await waitFor(() => expect(sub.querySelector('.pm-preview-error')).toBeTruthy(), { timeout: 8000 });
        expect(sub.querySelector('.pm-preview-error')!.textContent).toBe(ENGINE_NO_OUTPUT);
        expectCleanWords('Compare predictors, failed');
        fireEvent.keyDown(window, { key: 'Escape' });
        if (screen.queryByTestId('sub-models-modal')) fireEvent.click(within(screen.getByTestId('sub-models-modal')).getAllByRole('button')[0]);

        // ── Health score → Mark complete (the engine cannot start), then it works ──
        await openHealth();
        expectCleanWords('Health score page, empty set points');
        const w = env.backend!.lastOk('compute_health_preview').stats.two_rmse as number;
        await enterSp({ 'sp-residual_at_80_lower': String(-w * 1.5), 'sp-residual_at_80_upper': String(w * 2), 'sp-residual_at_0_lower': String(-w * 4), 'sp-residual_at_0_upper': String(w * 4) });
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
        expectCleanWords('Health score page, valid set points');
        env.backend!.failOn('export_model_files', () => true, ENGINE_NO_START);
        await act(async () => { fireEvent.click(markBtn()); });
        await waitFor(() => expect(bmw().getByTestId('save-error')).toBeTruthy(), { timeout: 8000 });
        expect(bmw().getByTestId('save-error-reason').textContent).toBe(ENGINE_NO_START);
        expectCleanWords('Mark complete failed');
        fireEvent.click(bmw().getByTestId('page-tab-model'));
        await settle(200);
        expectCleanWords('Model fit page after the failed Mark complete');
        await openHealth();
        await markComplete();
        await waitFor(() => expect(diskModel(id).status).toBe(true), { timeout: 8000 });
        await waitFor(() => expect(bmw().getByTestId('save-ok')).toBeTruthy());
        expectCleanWords('Complete');
        await waitFor(() => expect(dashDot(1, 'tag1', 'relationship')).toBe('complete'));
        expectCleanWords('Dashboard, Complete');
        // the running-condition settings, for good measure
        fireEvent.click(bmw().getByTestId('rc-card-open'));
        expectCleanWords('the Running condition settings');
        // the scan is not vacuous: it reads what the windows show
        expect(readable()).toMatch(/Relation model/);
        expect(readable()).toMatch(/Pump Pressure/);
    });
});

// ---------------------------------------------------------------------------
// C. The engine fails
// ---------------------------------------------------------------------------

describe('C. the Relation model engine fails: only Rust\'s fixed sentence is shown, wherever it surfaces', () => {
    const rel = (o: Record<string, unknown> = {}) => model({ id: 'r1', name: 'Pressure from flow', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG3', 'TAG5'], ...o });

    it('Train all: the queue row, the run strip\'s details, the model\'s board and notice line, the tab words, the list — and nothing on disk or on the Dashboard changes', async () => {
        writeDisk(never(wsTrained(FG, [rel(), model({ id: 'i4', name: 'Mode band', targetSensor: 'TAG4', groupNos: [2], healthSetPoints: EMPTY_SP })]), ['r1', 'i4']));
        await mountWindows();
        openDashFgTab();
        selectSensor('tag1');
        await settle(300);
        const before = JSON.stringify(diskModel('r1'));
        env.backend!.failOn('preview_relationship_model', a => !!a?.cache_key, ENGINE_FIT_FAILED);
        await act(async () => { fireEvent.click(bmw().getByTestId('train-all')); });
        await act(async () => { fireEvent.click(bmw().getByTestId('train-all-start')); });
        await waitFor(() => expect(bmw().getByTestId('train-all-modal').getAttribute('data-view')).toBe('done'), { timeout: 8000 });
        await settle(50);

        // the queue row: "✕ Failed" + the sentence, with Retry
        expect(bmw().getByTestId('train-row-status-r1').textContent).toBe('✕ Failed');
        const rowText = bmw().getByTestId('train-row-r1').textContent!;
        expect(rowText).toContain(ENGINE_FIT_FAILED);
        expect(rowText.split(ENGINE_FIT_FAILED)).toHaveLength(2); // said once
        expect(bmw().getByTestId('train-retry-r1')).toBeTruthy();
        expect(bmw().getByTestId('train-row-status-i4').textContent).toBe('✓ Trained · set points needed'); // the run went on
        fireEvent.click(bmw().getByTestId('train-all-close'));
        expect(bmw().getByTestId('train-run-text').textContent).toBe('Done · 1 trained · 1 failed');

        // the model's page
        const board = bmw().getByTestId('results-error');
        expect(board.querySelector('.wbx-msg-t')!.textContent).toBe('Training failed');
        expect(board.querySelector('.wbx-msg-d')!.textContent).toBe(ENGINE_FIT_FAILED);
        expect(sentence()).toBe('Training failed · fix the problem, then Train sensor ↑');
        expect(tabWords('r1')).toBe('Training failed');
        expect(bmwEl().textContent).not.toMatch(/Error:|invoke|undefined|\[object/);
        // nothing was saved for it; the other window shows no dot
        expect(JSON.stringify(diskModel('r1'))).toBe(before);
        expect(dashDot(1, 'tag1', 'relationship')).toBe('none');
        await waitFor(() => expect(dashDot(2, 'tag4', 'individual')).not.toBe('none'));

        // Retry from the details (the engine answers again): trained
        fireEvent.click(bmw().getByTestId('train-run-details'));
        await act(async () => { fireEvent.click(bmw().getByTestId('train-retry-r1')); });
        await waitFor(() => expect(freshOnDisk('r1')).toBe(true), { timeout: 8000 });
        await waitFor(() => expect(dashDot(1, 'tag1', 'relationship')).not.toBe('none'));
    });

    it('Compare predictors (the Sub-models comparison): the modal shows the sentence alone, the trained model behind it is untouched; run again works', async () => {
        writeDisk(wsTrained(FG, [rel({ healthSetPoints: REL_SP })]));
        await mountWindows();
        selectSensor('tag1');
        await waitForCharts();
        const bytes = modelsBytes();
        env.backend!.failOn('preview_relationship_model', a => !a?.cache_key, ENGINE_NO_OUTPUT);
        await act(async () => { fireEvent.click(bmw().getByTestId('compare-predictors')); });
        const sub = await waitFor(() => screen.getByTestId('sub-models-modal'));
        await waitFor(() => expect(sub.querySelector('.pm-preview-error')).toBeTruthy(), { timeout: 8000 });
        expect(sub.querySelector('.pm-preview-error')!.textContent).toBe(ENGINE_NO_OUTPUT);
        expect(within(sub).queryAllByTestId('sub-model-card')).toHaveLength(0);
        expect(sub.textContent).not.toMatch(FORBIDDEN);
        // the model itself: still trained, charts still there, nothing written
        expect(pill()).toBe('Trained');
        expect(bmw().getByTestId('results-chart')).toBeTruthy();
        expect(modelsBytes()).toBe(bytes);
    });

    it('Mark complete: the red card carries the sentence, nothing is written and the model stays Trained in both windows; the next Mark complete saves', async () => {
        writeDisk(wsTrained(FG, [rel({ healthSetPoints: REL_SP, healthVerdict: 'valid' })]));
        await mountWindows();
        openDashFgTab();
        selectSensor('tag1');
        await waitForCharts();
        await openHealth();
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
        await waitFor(() => expect(markBtn().disabled).toBe(false));
        const dot0 = dashDot(1, 'tag1', 'relationship');

        for (const said of [ENGINE_NO_START, ENGINE_NO_OUTPUT, ENGINE_FIT_FAILED]) {
            env.backend!.failOn('export_model_files', () => true, said);
            await act(async () => { fireEvent.click(markBtn()); });
            await waitFor(() => expect(bmw().getByTestId('save-error-reason').textContent).toBe(said), { timeout: 8000 });
            expect(sentence()).toBe('Not saved · fix it, then Mark complete again');
            expect(diskModel('r1').status).toBe(false);
            expect(diskModel('r1').healthExport).toBeUndefined();
            expect([...env.files.keys()].some(k => k.includes('/output/'))).toBe(false);
            expect(dashDot(1, 'tag1', 'relationship')).toBe(dot0);
            expect(bmwEl().textContent).not.toMatch(FORBIDDEN);
        }
        // Rust's coded "engine out of date" answer is worded by the app — the code is never shown
        env.backend!.failOn('export_model_files', () => true, ENGINE_OUTDATED);
        await act(async () => { fireEvent.click(markBtn()); });
        await waitFor(() => expect(bmw().getByTestId('save-error-reason').textContent)
            .toBe('The Relation model engine in this build is out of date — reinstall or update the app, then try again.'), { timeout: 8000 });
        expect(bmwEl().textContent).not.toMatch(FORBIDDEN);

        await markComplete();
        await waitFor(() => expect(diskModel('r1').status).toBe(true), { timeout: 8000 });
        await waitFor(() => expect(dashDot(1, 'tag1', 'relationship')).toBe('complete'));
        expect(bmw().queryByTestId('save-error')).toBeNull();
    });
});
