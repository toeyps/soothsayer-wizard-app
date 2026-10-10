import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/*
 * Train sensor / Train all queue (customer batch 2026-10, items 8 + 9) — QA
 * sweep across the windows (2026-10-09).
 *
 * The queue's rules are unit-tested in useTrainQueue.test.ts / trainQueue.test.ts,
 * its parts in TrainQueueParts.test.tsx and its wiring into the Build Model
 * window in BuildModelWindow.test.tsx (with workspaceManager MOCKED and no
 * Dashboard). What only shows up with the pieces combined is tested here: the
 * REAL Dashboard and the REAL Build Model window side by side on one event bus,
 * the REAL workspaceManager over an in-memory plugin-fs (so "what is on disk"
 * is the actual file), and the fake Rust backend of the health-score tests
 * (`helpers/fakeHealthRust.ts`) behind `invoke`.
 *
 *  (a) Back to Import while Train all runs: the Dashboard's unmount
 *      (`workspace-closing` + its close of the window) closes the Build Model
 *      window WITHOUT the "Training is still running" dialog, nothing more is
 *      trained or written for that workspace, and the next project gets a
 *      clean window — both when the window really closes and when it outlives
 *      the close (the close IPC is best effort) and is re-pointed.
 *  (b) Train all over models of two failure groups, one failing and one
 *      skipped for a missing setting: strictly sequential, the final strip, the
 *      file per model, the "Set points needed" chip, the Health score banner,
 *      and the Dashboard's Failure Groups dots after the broadcast.
 *
 * The two windows are rendered as two separate React roots, so the Dashboard
 * can be unmounted (Back to Import) and the Build Model window "destroyed" on
 * their own.
 */

const wv = vi.hoisted(() => ({
    /** What `WebviewWindow.getByLabel('build-model')` returns to the Dashboard. */
    handle: null as null | { close: () => Promise<void>; setFocus: () => Promise<void> },
}));

vi.mock('@tauri-apps/api/event', async () => (await import('./helpers/healthEnv')).eventModule());
vi.mock('@tauri-apps/plugin-fs', async () => (await import('./helpers/healthEnv')).fsModule());
vi.mock('@tauri-apps/plugin-store', async () => (await import('./helpers/healthEnv')).storeModule());
vi.mock('@tauri-apps/api/core', async () => (await import('./helpers/healthEnv')).coreModule());
vi.mock('@tauri-apps/api/window', async () => (await import('./helpers/healthEnv')).windowModule());
vi.mock('../components/charts/ResponsiveECharts', async () => (await import('./helpers/healthEnv')).chartModule());
vi.mock('@tauri-apps/api/webviewWindow', () => ({
    WebviewWindow: class {
        static getByLabel = async (label: string) => (label === 'build-model' ? wv.handle : null);
        once = () => {};
    },
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
import { PLANT_META } from './helpers/fakeHealthRust';
import {
    HEADERS, bmw, bmwDot, dash, dashDot, model, newBackend, openDashFgTab, readDisk, settle, wsFile, wsState, writeDisk,
} from './helpers/healthWorkbench';
import Dashboard from '../components/dashboard/Dashboard';
import BuildModelWindow from '../components/windows/BuildModelWindow';
import { computeTrainFingerprint } from '../utils/trainFingerprint';
import { migrateHealthSetPoints } from '../utils/workspaceMigrations';

vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
    resetEnv();
    newBackend();
    wv.handle = null;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function mountDashboard(id: string) {
    const ui = render(
        <div data-testid="dashboard-window">
            <Dashboard
                metadata={{ headers: HEADERS, total_rows: 60, generation: env.backend!.generation() } as any}
                sensorMetadata={PLANT_META as any}
                onBack={vi.fn()}
                initialState={readDisk(id)}
            />
        </div>,
    );
    await settle(50);
    return ui;
}

/** The Build Model window, in its own root (asks the Dashboard for its data, like the real one). */
async function mountBuildModel() {
    const ui = render(<div data-testid="build-model-window"><BuildModelWindow /></div>);
    await waitFor(() => expect(bmw().getByTestId('rc-card')).toBeTruthy());
    await settle(350);
    return ui;
}

const bmwEl = () => screen.getByTestId('build-model-window');
const strip = () => bmw().getByTestId('train-run-strip');
const diskModelOf = (id: string, mid: string) => readDisk(id).failureGroupState.models.find((m: any) => m.id === mid);
/** Trained by THIS window and still fresh against what is on disk. */
const freshOnDisk = (id: string, mid: string) => {
    const fg = readDisk(id).failureGroupState;
    const m = fg.models.find((x: any) => x.id === mid);
    return !!m.lastTrainedAt && m.trainedFingerprint === computeTrainFingerprint(m, fg);
};
const fileWrites = (id: string) => env.writes.filter(w => w.path === wsFile(id)).length;

async function startTrainAll() {
    await act(async () => { fireEvent.click(bmw().getByTestId('train-all')); });
    expect(bmw().getByTestId('train-all-modal').getAttribute('data-view')).toBe('preflight');
    await act(async () => { fireEvent.click(bmw().getByTestId('train-all-start')); });
}

/** Records every TRAIN call (the three per-kind train commands; the Step-1 row
 *  count asks `compute_sensor_stats` for TAG1 and is not a train): start/end
 *  order and the most that were ever in flight at once. Every train takes a
 *  little while, so an overlap would be visible. `fail` answers a call with an
 *  error instead. */
function recordTrains(o: { individualTargets: string[]; fail?: (cmd: string, args: any) => string | null }) {
    const log: string[] = [];
    const rec = { inFlight: 0, maxInFlight: 0, log };
    const wrap = (cmd: string, pred: (a: any) => boolean, label: (a: any) => string) => {
        env.backend!.override(cmd, pred, async (args, real) => {
            const name = label(args);
            rec.inFlight++;
            rec.maxInFlight = Math.max(rec.maxInFlight, rec.inFlight);
            log.push(`start ${name}`);
            try {
                await new Promise(r => setTimeout(r, 15));
                const err = o.fail?.(cmd, args) ?? null;
                if (err) throw err;
                return await real();
            } finally {
                rec.inFlight--;
                log.push(`end ${name}`);
            }
        }, false);
    };
    wrap('compute_sensor_stats', a => o.individualTargets.includes(a?.sensor), a => `I:${a.sensor}`);
    wrap('preview_relationship_model', () => true, a => `R:${a.target}`);
    wrap('compute_clustering_preview', () => true, a => `C:${a.first_sensor}`);
    return rec;
}

// ---------------------------------------------------------------------------
// (a) Back to Import / Dashboard unmount during a Train all run
// ---------------------------------------------------------------------------

describe('(a) the Dashboard goes away (Back to Import) while Train all runs', () => {
    /** ws1: three Individual models in FG-A, never trained. */
    const ws1 = () => wsState({
        models: [
            model({ id: 'i3', targetSensor: 'TAG3' }),
            model({ id: 'i4', targetSensor: 'TAG4' }),
            model({ id: 'i5', targetSensor: 'TAG5' }),
        ],
    }, 'ws1', 'Project one');
    /** ws2: the next project — one Individual model. */
    const ws2 = () => wsState({ models: [model({ id: 'w3', targetSensor: 'TAG3' })] }, 'ws2', 'Project two');

    /** Train all on ws1 until the SECOND model (i4) is in training (held). */
    async function runUntilSecondModelHeld() {
        writeDisk(ws1(), 'ws1');
        writeDisk(ws2(), 'ws2');
        const gate = env.backend!.gate('compute_sensor_stats', a => a?.sensor === 'TAG4');
        const dashUi = await mountDashboard('ws1');
        const bmwUi = await mountBuildModel();
        expect(bmw().getByTestId('train-all-counts').textContent).toBe("3 ready0 up to date0 can't train");
        await startTrainAll();
        await waitFor(() => expect(gate.entered).toBe(true));
        await settle(20);
        expect(bmw().getByTestId('train-run-text').textContent).toBe('Training 2 of 3');
        expect(freshOnDisk('ws1', 'i3')).toBe(true);
        expect(diskModelOf('ws1', 'i4').lastTrainedAt).toBeUndefined();
        // The run details modal is hidden, as a user would have it while working.
        fireEvent.click(bmw().getByTestId('train-all-close'));
        return { gate, dashUi, bmwUi };
    }

    /** Every write of the ws1 file from index `from` on, parsed. */
    const ws1WritesFrom = (from: number) => env.writes.filter(w => w.path === wsFile('ws1')).slice(from).map(w => JSON.parse(w.content));

    it('the window really closes: no "Training is still running" dialog, the Dashboard\'s own close is not held, nothing more is trained or changed in ws1, and the next project gets a clean window', async () => {
        const { dashUi, bmwUi } = await runUntilSecondModelHeld();

        // The Dashboard's close of the Build Model window fires the window's own close
        // handler (`onCloseRequested`), exactly like Tauri does.
        const closes: { prevented: boolean }[] = [];
        let destroyed = false;
        wv.handle = {
            setFocus: async () => {},
            close: async () => {
                const prevented = await nativeClose();
                closes.push({ prevented });
                if (!prevented) destroyed = true;
            },
        };
        const ws1Before = readDisk('ws1');
        const writesBefore = fileWrites('ws1');

        // Back to Import: App unmounts the Dashboard.
        await act(async () => { dashUi.unmount(); });
        await settle(50);

        expect(env.emitted.filter(e => e.event === 'workspace-closing').map(e => e.payload.workspaceId)).toEqual(['ws1']);
        expect(within(bmwEl()).queryByRole('alertdialog')).toBeNull();
        expect(bmw().queryByTestId('close-run-dialog')).toBeNull();
        // The window closed itself on `workspace-closing` (it was held by the run) …
        expect(env.windowClose).toBe(1);
        // … and the Dashboard's close that follows went through without being held.
        expect(closes).toEqual([{ prevented: false }]);
        expect(destroyed).toBe(true);
        // The run is gone from the window (dropped, not finished).
        expect(bmw().queryByTestId('train-run-strip')).toBeNull();
        // Nothing in ws1 changed with the close. (The Dashboard's own last autosave may
        // re-write the file on unmount; it must carry exactly what was there.)
        for (const w of ws1WritesFrom(writesBefore)) expect(w).toEqual(ws1Before);
        expect(readDisk('ws1')).toEqual(ws1Before);

        // The webview is destroyed (its JS dies with it — the held train never comes back).
        await act(async () => { bmwUi.unmount(); });
        await settle(100);
        expect(env.backend!.cmds('compute_sensor_stats').filter(c => c.args.sensor === 'TAG5')).toHaveLength(0);
        expect(readDisk('ws1')).toEqual(ws1Before);
        expect(diskModelOf('ws1', 'i5').lastTrainedAt).toBeUndefined();
        expect(diskModelOf('ws1', 'i4').lastTrainedAt).toBeUndefined();
        expect(freshOnDisk('ws1', 'i3')).toBe(true); // trained before the close: kept

        // The next project: a new Dashboard, a new Build Model window.
        wv.handle = null;
        await mountDashboard('ws2');
        await mountBuildModel();
        expect(bmw().queryByTestId('train-run-strip')).toBeNull();
        expect(bmw().queryByRole('alertdialog')).toBeNull();
        expect(bmw().queryByTestId('settings-locked')).toBeNull();
        expect(bmw().queryByTestId('chip-set-points-needed')).toBeNull();
        expect(bmw().getAllByTestId('sensor-row-label')).toHaveLength(1);
        expect(bmw().getByTestId('train-all-counts').textContent).toBe("1 ready0 up to date0 can't train");
        expect((bmw().getByTestId('train-all') as HTMLButtonElement).disabled).toBe(false);
        expect((bmw().getByTestId('train-sensor') as HTMLButtonElement).disabled).toBe(false);

        // It trains ws2 — and only ws2.
        const ws1AfterClose = env.files.get(wsFile('ws1'));
        await act(async () => { fireEvent.click(bmw().getByTestId('train-sensor')); });
        await waitFor(() => expect(strip().getAttribute('data-phase')).toBe('done'));
        expect(freshOnDisk('ws2', 'w3')).toBe(true);
        expect(env.files.get(wsFile('ws1'))).toBe(ws1AfterClose);
    });

    /** The close of the window is LOST (the Dashboard's `getByLabel` finds nothing), so
     *  the window outlives its project; the train that was in flight then comes back.
     *  Then the next project's Dashboard re-points the surviving window via "Build Model". */
    async function survivingWindowRepointedAtWs2() {
        const { gate, dashUi } = await runUntilSecondModelHeld();
        await act(async () => { dashUi.unmount(); });
        await settle(50);
        expect(env.windowClose).toBe(1); // the window asked to close itself, without the dialog
        expect(bmw().queryByRole('alertdialog')).toBeNull();
        expect(bmw().queryByTestId('train-run-strip')).toBeNull();

        await act(async () => { gate.release(); });
        await settle(150);
        // The queue did not move on to the next model.
        expect(env.backend!.cmds('compute_sensor_stats').filter(c => c.args.sensor === 'TAG5')).toHaveLength(0);
        expect(diskModelOf('ws1', 'i5').lastTrainedAt).toBeUndefined();
        expect(bmw().queryByTestId('train-run-strip')).toBeNull();
        const ws1Settled = env.files.get(wsFile('ws1'));

        wv.handle = { setFocus: async () => {}, close: async () => {} };
        await mountDashboard('ws2');
        openDashFgTab();
        await act(async () => { fireEvent.click(dash().getByRole('button', { name: /Build Model/ })); });
        await settle(350);
        return { ws1Settled };
    }

    it('the window outlives the close (close lost): the in-flight train never starts the next model, and once re-pointed at the next project the window is clean and trains only that project', async () => {
        const { ws1Settled } = await survivingWindowRepointedAtWs2();
        // A train in flight is never cut off: with the window still alive, the model that
        // was training when the project closed lands its record in ITS workspace (a true
        // fit on ws1's data — same generation), not Complete. The run itself is gone.
        expect(freshOnDisk('ws1', 'i4')).toBe(true);
        expect(diskModelOf('ws1', 'i4').status).toBe(false);

        expect(bmw().getAllByTestId('sensor-row-label')).toHaveLength(1);
        expect(bmw().queryByTestId('train-run-strip')).toBeNull();
        expect(bmw().queryByRole('alertdialog')).toBeNull();
        expect(bmw().queryByTestId('chip-set-points-needed')).toBeNull();
        expect(bmw().getByTestId('train-all-counts').textContent).toBe("1 ready0 up to date0 can't train");
        expect((bmw().getByTestId('train-all') as HTMLButtonElement).disabled).toBe(false);

        await act(async () => { fireEvent.click(bmw().getByTestId('train-sensor')); });
        await waitFor(() => expect(strip().getAttribute('data-phase')).toBe('done'));
        expect(bmw().getByTestId('train-run-text').textContent).toBe('Done · 1 trained');
        expect(freshOnDisk('ws2', 'w3')).toBe(true);
        expect(env.files.get(wsFile('ws1'))).toBe(ws1Settled);
    });

    // Regression (found in the 2026-10-09 QA sweep): `workspace-closing` sets
    // `closeBypassRef`, and the re-point branch (`switched`) must clear it again.
    // Otherwise a window that outlived its project's close (best-effort IPC, or a
    // hung Mark complete held it open) and was re-pointed at the next project
    // closes in the middle of that project's run without the dialog.
    it('after a lost close + re-point, closing during the NEW project\'s run still asks first', async () => {
        await survivingWindowRepointedAtWs2();
        const held = env.backend!.gate('compute_sensor_stats', a => a?.sensor === 'TAG3');
        await act(async () => { fireEvent.click(bmw().getByTestId('train-sensor')); });
        await waitFor(() => expect(held.entered).toBe(true));
        await act(async () => { fireEvent.click(bmw().getByTitle('Close')); });
        expect(env.windowClose).toBe(1); // actual: 2 — closed mid-run without asking
        expect(bmw().getByRole('alertdialog').textContent).toContain('Training is still running');
    });
});

// ---------------------------------------------------------------------------
// (b) Train all over two failure groups, one failure, one skip
// ---------------------------------------------------------------------------

describe('(b) Train all over two failure groups with one failure and one skip', () => {
    /** FG-A: i3 (Individual TAG3) + r1 (Relation TAG1 <- TAG3, FAILS).
     *  FG-B: i5 (Individual TAG5) + r5 (Relation TAG5, NO predictor → skipped)
     *        + c5 (Clustering X TAG5 / Y TAG3, criteria TAG4). */
    const start = () => wsState({
        models: [
            model({ id: 'i3', targetSensor: 'TAG3', groupNos: [1] }),
            model({ id: 'r1', kind: 'relationship', targetSensor: 'TAG1', predictorSensors: ['TAG3'], groupNos: [1] }),
            model({ id: 'i5', targetSensor: 'TAG5', groupNos: [2] }),
            model({ id: 'r5', kind: 'relationship', targetSensor: 'TAG5', predictorSensors: [], groupNos: [2] }),
            model({
                id: 'c5', kind: 'clustering', xSensor: 'TAG5', ySensor: 'TAG3', criteriaSensor: 'TAG4', numClusters: 2,
                clusterRanges: [{ min: 0, max: 50 }, { min: 50, max: 100 }], groupNos: [2],
            }),
        ],
    });

    it('trains strictly one at a time; amber "Done · 3 trained · 1 failed · 1 skipped"; the file, the chip, the Health score banner and the Dashboard dots all agree', async () => {
        writeDisk(start());
        // What the app itself reads for each model (load-time migration adds empty set points).
        const before = migrateHealthSetPoints(readDisk()).failureGroupState!.models as any[];
        const rec = recordTrains({
            individualTargets: ['TAG3', 'TAG5'],
            fail: (cmd, a) => (cmd === 'preview_relationship_model' && a.target === 'TAG1' ? 'Relation model failed: not enough rows after filtering' : null),
        });
        await mountDashboard('ws1');
        await mountBuildModel();
        openDashFgTab();
        for (const [g, key, kind] of [[1, 'tag3', 'individual'], [1, 'tag1', 'relationship'], [2, 'tag5', 'individual'], [2, 'tag5', 'relationship'], [2, 'tag5', 'clustering']] as const) {
            expect(dashDot(g, key, kind)).toBe('none');
        }
        expect(bmw().getByTestId('train-all-counts').textContent).toBe("4 ready0 up to date1 can't train");

        // Preflight: grouped by failure group, the missing setting called out with Fix →.
        await act(async () => { fireEvent.click(bmw().getByTestId('train-all')); });
        const g1 = within(bmw().getByTestId('train-group-1'));
        const g2 = within(bmw().getByTestId('train-group-2'));
        expect(g1.getByTestId('train-row-status-i3').textContent).toBe('Ready');
        expect(g1.getByTestId('train-row-status-r1').textContent).toBe('Ready');
        // amber "Skipped" + Fix →, the long reason (the missing setting, by name) on its own line
        expect(g2.getByTestId('train-row-status-r5').textContent).toBe('Skipped');
        expect(g2.getByTestId('train-row-note-r5').textContent).toBe('Add at least 1 predictor');
        expect(g2.getByTestId('train-fix-r5')).toBeTruthy();
        // zero counts are hidden: nothing is up to date here, so that count is not printed
        expect(bmw().getByTestId('train-all-summary').textContent).toBe("4 will train· ≈ 19 s· 1 can't train — fix, then run again");
        expect(bmw().getByTestId('train-all-foot').textContent).toBe("Trains 4 models; the 1 that can't train stays as it is");
        await act(async () => { fireEvent.click(bmw().getByTestId('train-all-start')); });
        await waitFor(() => expect(bmw().getByTestId('train-all-modal').getAttribute('data-view')).toBe('done'), { timeout: 5000 });
        await settle(50);

        // Strictly sequential, in run order (by sensor, I → R → C), never two at once.
        expect(rec.maxInFlight).toBe(1);
        expect(rec.log).toEqual([
            'start I:TAG3', 'end I:TAG3',
            'start R:TAG1', 'end R:TAG1',
            'start I:TAG5', 'end I:TAG5',
            'start C:TAG5', 'end C:TAG5',
        ]);
        expect(env.backend!.cmds('preview_relationship_model').filter(c => c.args.target === 'TAG5')).toHaveLength(0);

        // Run details: per model.
        expect(bmw().getByTestId('train-row-status-i3').textContent).toBe('✓ Trained · set points needed');
        expect(bmw().getByTestId('train-row-status-r1').textContent).toBe('✕ Failed');
        expect(bmw().getByTestId('train-row-r1').textContent).toContain('Relation model failed: not enough rows after filtering');
        expect(bmw().getByTestId('train-retry-r1')).toBeTruthy();
        expect(bmw().getByTestId('train-row-status-i5').textContent).toBe('✓ Trained · set points needed');
        expect(bmw().getByTestId('train-row-status-r5').textContent).toBe('Skipped');
        expect(bmw().getByTestId('train-row-note-r5').textContent).toBe('Add at least 1 predictor');
        expect(bmw().getByTestId('train-row-status-r5').className).toContain('tq-st--cant');
        expect(bmw().getByTestId('train-row-status-c5').textContent).toBe('✓ Trained · set points needed');
        fireEvent.click(bmw().getByTestId('train-all-close'));

        // The strip: partial failure = amber, never red.
        expect(strip().getAttribute('data-phase')).toBe('done');
        expect(strip().getAttribute('data-tone')).toBe('warning');
        expect(bmw().getByTestId('train-run-text').textContent).toBe('Done · 3 trained · 1 failed · 1 skipped');

        // On disk: trained ones carry a fresh record and are NOT Complete; failed / skipped untouched.
        const fgAfter = readDisk().failureGroupState;
        for (const id of ['i3', 'i5', 'c5']) {
            const m = fgAfter.models.find((x: any) => x.id === id);
            expect(m.lastTrainedAt, id).toBeTruthy();
            expect(m.trainedFingerprint, id).toBe(computeTrainFingerprint(m, fgAfter));
            expect(m.status, id).toBe(false);
        }
        for (const id of ['r1', 'r5']) {
            expect(fgAfter.models.find((x: any) => x.id === id), id).toEqual(before.find((x: any) => x.id === id));
        }
        // The rest of the slice survived every write of the run.
        expect(fgAfter.groups).toEqual(start().failureGroupState!.groups);
        expect(fgAfter.runningConditionFilters).toEqual(start().failureGroupState!.runningConditionFilters);
        expect(fgAfter.runningConditionTestPeriods).toEqual(start().failureGroupState!.runningConditionTestPeriods);

        // Dashboard (separate window, via the broadcast): trained → a dot, failed / skipped → none.
        await waitFor(() => expect(dashDot(1, 'tag3', 'individual')).not.toBe('none'));
        expect(['trained', 'need']).toContain(dashDot(1, 'tag3', 'individual'));
        expect(dashDot(1, 'tag1', 'relationship')).toBe('none');
        expect(['trained', 'need']).toContain(dashDot(2, 'tag5', 'individual'));
        expect(dashDot(2, 'tag5', 'relationship')).toBe('none');
        expect(['trained', 'need']).toContain(dashDot(2, 'tag5', 'clustering'));
        // … and the Build Model list says the same.
        for (const id of ['i3', 'i5', 'c5']) expect(bmwDot(id).state, id).toBe('trained');
        for (const id of ['r1', 'r5']) expect(['trained', 'complete'], id).not.toContain(bmwDot(id).state);

        // "Set points needed" chip: the two sensors with a trained, not-Complete model.
        const chip = bmw().getByTestId('chip-set-points-needed');
        expect(chip.textContent).toBe('Set points needed 2');
        fireEvent.click(chip);
        expect(bmw().getAllByTestId('sensor-row-label')).toHaveLength(2);
        expect(bmw().queryByTestId('sensor-list-row-fg:1-tag1')).toBeNull();

        // Health score page of a trained model: the run banner, and "Next needing set points".
        fireEvent.click(bmw().getByTestId('sensor-list-row-fg:1-tag3'));
        await settle(50);
        const healthBtn = bmw().getByTestId('page-health') as HTMLButtonElement;
        expect(healthBtn.disabled).toBe(false);
        fireEvent.click(healthBtn);
        await waitFor(() => expect(bmw().getByTestId('run-setpoints-banner')).toBeTruthy());
        // ONE line: "Trained in the run 22:41 · 3 need set points · this is 1 of 3"
        expect(bmw().getByTestId('run-setpoints-line').textContent).toMatch(/^Trained in the run \d{2}:\d{2} · 3 need set points · this is 1 of 3$/);
        fireEvent.click(bmw().getByTestId('next-needing-set-points'));
        await settle(50);
        expect(bmw().getByTestId('run-setpoints-banner').textContent).toContain('this is 2 of 3');
        expect(bmwEl().querySelector('[role="tab"][aria-selected="true"]')?.textContent).toMatch(/Individual/);
        expect(bmw().getByRole('heading', { level: 3 }).textContent).toContain('Temp');

        // The failed model: its failure shows in the footer and the Health score stays locked.
        fireEvent.click(bmw().getByRole('button', { name: /^All \d+$/ }));
        fireEvent.click(bmw().getByTestId('sensor-list-row-fg:1-tag1'));
        await settle(50);
        expect(bmw().getByTestId('footer-status').textContent).toContain('Training failed');
        const next = bmw().getByTestId('next-health-score') as HTMLButtonElement;
        expect(next.disabled).toBe(true);
        expect(next.title).toBe('Train the model first');
        expect((bmw().getByTestId('page-health') as HTMLButtonElement).disabled).toBe(true);
    });
});
