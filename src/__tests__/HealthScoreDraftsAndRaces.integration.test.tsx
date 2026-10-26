import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

/*
 * Health score — set-point drafts (persist / flush / never
 * lost / never overwritten), the preview hook's debounce and race guards seen
 * through the REAL page, every error path, and the "Mark complete" races and
 * failures (double click, close while saving, switch while saving, a slow
 * Relationship export, ok:false, rejects, the disk changing meanwhile, edits
 * made while saving, a workspace switch while saving), plus multi-workspace
 * isolation of the new state and the delete / duplicate behaviour of the
 * output folder.
 *
 * Real Dashboard + real Build Model window, one workspace file, one event bus,
 * the fake Rust health backend (`helpers/fakeHealthRust.ts`).
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
import { plantDataset } from './helpers/fakeHealthRust';
import {
    WS, applyWorkspaceRc, bmw, bmwEl, blurSp, diskModel, enterSp, markBtn, markComplete, model, mountWindows,
    newBackend, openDashSensorTab, openHealth, openSettings, pill, readDisk, saveChanges, selectKindTab, selectSensor,
    sendBuildModelData, settle, train, typeSp, waitForCharts, writeDisk, wsTrained,
} from './helpers/healthWorkbench';
import { deleteWorkspace, duplicateWorkspace, updateWorkspaceData } from '../workspaceManager';
import { withFailureGroupState } from '../utils/failureGroupState';
import { emit } from '@tauri-apps/api/event';

vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
    resetEnv();
    newBackend();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const EMPTY_I = { kind: 'individual', lower: null, upper: null, masterLower: 20, masterUpper: 80 };
const REL_SP = { kind: 'relationship', residualAt80Lower: -5, residualAt80Upper: 5, residualAt0Lower: -10, residualAt0Upper: 10 };

/** i1 (Individual TAG1, set points cleared by the user), r1 (Relationship TAG1<-TAG3), c1 (Clustering TAG3/TAG5) — all trained & fresh. */
function trainedWs(over: Record<string, Record<string, unknown>> = {}, id = WS) {
    return wsTrained({}, [
        model({ id: 'i1', kind: 'individual', healthSetPoints: EMPTY_I, ...over.i1 }),
        model({ id: 'r1', kind: 'relationship', predictorSensors: ['TAG3'], healthSetPoints: REL_SP, ...over.r1 }),
        model({
            id: 'c1', kind: 'clustering', xSensor: 'TAG3', ySensor: 'TAG5', criteriaSensor: 'TAG4', numClusters: 2,
            clusterRanges: [{ min: 0, max: 50 }, { min: 50, max: 100 }], healthSetPoints: { kind: 'clustering', outerSd: null }, ...over.c1,
        }),
    ], id);
}

/** Every distinct value a model's set points took in the workspace FILE, in write order. */
function spHistory(mid: string, id = WS): string[] {
    const out: string[] = [];
    for (const w of env.writes.filter(x => x.path === `workspaces/${id}.json`)) {
        const m = JSON.parse(w.content).failureGroupState?.models?.find((x: any) => x.id === mid);
        const v = JSON.stringify(m?.healthSetPoints ?? null);
        if (out[out.length - 1] !== v) out.push(v);
    }
    return out;
}
const lowerOnDisk = (mid = 'i1') => diskModel(mid).healthSetPoints.lower;

async function openI1Health() {
    selectSensor('tag1');
    await waitForCharts();
    await openHealth();
}

// ---------------------------------------------------------------------------
// Drafts: typed without blur must be persisted exactly once, never lost
// ---------------------------------------------------------------------------

describe('a set point typed WITHOUT blur is persisted (exactly once) when the user leaves', () => {
    const leaves: { name: string; leave: () => Promise<void> }[] = [
        { name: 'switches to another sensor', leave: async () => { selectSensor('tag3'); await settle(100); } },
        { name: 'switches the kind tab', leave: async () => { selectKindTab('Relation model'); await settle(100); } },
        { name: 'goes back to Model fit', leave: async () => { fireEvent.click(bmw().getByTestId('page-tab-model')); await settle(100); } },
        { name: 'clicks the window Close button', leave: async () => { await act(async () => { fireEvent.click(bmw().getByTitle('Close')); }); await settle(100); } },
        {
            name: 'closes the window natively (onCloseRequested)',
            leave: async () => {
                let prevented = false;
                await act(async () => { prevented = await nativeClose(); });
                expect(prevented, 'the native close waits for the write').toBe(true);
                await settle(100);
            },
        },
    ];
    for (const l of leaves) {
        it(l.name, async () => {
            writeDisk(trainedWs());
            await mountWindows();
            await openI1Health();
            const before = spHistory('i1').length;
            typeSp('sp-lower', '1');
            typeSp('sp-lower', '12'); // still typing, no blur
            expect(lowerOnDisk()).toBeNull();
            await l.leave();
            expect(lowerOnDisk()).toBe(12);
            expect(spHistory('i1').length - before, 'one write for the typed value').toBe(1);
        });
    }

    it('a broadcast from another window mid-typing neither overwrites the input nor the later write; a Dashboard autosave does not lose it', async () => {
        writeDisk(trainedWs());
        await mountWindows();
        await openI1Health();
        typeSp('sp-upper', '9');
        typeSp('sp-upper', '91');
        // Another window writes something unrelated (notes) and broadcasts the whole slice.
        await act(async () => {
            const next = await updateWorkspaceData(WS, prev => withFailureGroupState(prev, {
                models: prev.failureGroupState!.models.map(m => (m.id === 'i1' ? { ...m, notes: 'n' } : m)),
            }));
            await emit('failure-group-state-changed', { ...next!.failureGroupState, workspaceId: WS, origin: 'dashboard' });
        });
        await settle(50);
        expect((bmw().getByTestId('sp-upper') as HTMLInputElement).value).toBe('91');
        // A Dashboard autosave (unrelated Dashboard change) in the middle.
        openDashSensorTab();
        await settle(400);
        blurSp('sp-upper');
        await settle(100);
        expect(diskModel('i1').healthSetPoints.upper).toBe(91);
        expect(diskModel('i1').notes).toBe('n');
        // ... and a later Dashboard autosave keeps it.
        openDashSensorTab();
        await settle(400);
        expect(diskModel('i1').healthSetPoints.upper).toBe(91);
    });

    it('Enter commits like blur; an unchanged value is not written again', async () => {
        writeDisk(trainedWs());
        await mountWindows();
        await openI1Health();
        typeSp('sp-lower', '11');
        fireEvent.keyDown(bmw().getByTestId('sp-lower'), { key: 'Enter' });
        await settle(100);
        expect(lowerOnDisk()).toBe(11);
        // The saved verdict of the NEW numbers is persisted once their preview lands (~250 ms
        // debounce): let that one legitimate write finish before taking the baseline.
        await settle(600);
        const n = env.writes.length;
        blurSp('sp-lower');
        fireEvent.keyDown(bmw().getByTestId('sp-lower'), { key: 'Enter' });
        await settle(100);
        expect(env.writes.length, 'no write without a new value').toBe(n);
    });
});

// ---------------------------------------------------------------------------
// The preview hook through the real page: debounce, ordering, model switch
// ---------------------------------------------------------------------------

describe('compute_health_preview traffic', () => {
    it('rapid typing (12 keystrokes) sends at most 2 requests, and the page ends on the LAST value', async () => {
        writeDisk(trainedWs());
        await mountWindows();
        await openI1Health();
        const before = env.backend!.cmds('compute_health_preview').length;
        const text = '10.123456789';
        for (let i = 1; i <= text.length; i++) typeSp('sp-lower', text.slice(0, i));
        typeSp('sp-upper', '90');
        await settle(400);
        const reqs = env.backend!.cmds('compute_health_preview').slice(before);
        expect(reqs.length).toBeLessThanOrEqual(2);
        expect(reqs[reqs.length - 1].args.request.set_points).toEqual({ lower: 10.123456789, upper: 90 });
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
    });

    it('an OLDER response that arrives last is ignored (out of order)', async () => {
        writeDisk(trainedWs());
        await mountWindows();
        await openI1Health();
        const g = env.backend!.gate('compute_health_preview', a => a.request?.set_points?.lower === 49);
        await enterSp({ 'sp-upper': '90' });
        typeSp('sp-lower', '49'); // invalid (inside 3SD) -> held
        await settle(300);
        expect(g.entered).toBe(true);
        typeSp('sp-lower', '10'); // valid -> answered at once
        await settle(350);
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
        await act(async () => { g.release(); });
        await settle(50);
        expect(bmw().getByTestId('check-valid')).toBeTruthy();
        expect(bmwEl().querySelector('[data-testid="score-locked"]')).toBeNull();
    });

    it('a preview in flight while the user switches to another model never shows on that model; loading keeps the previous charts', async () => {
        writeDisk(trainedWs({ c1: { healthSetPoints: { kind: 'clustering', outerSd: 5 } } }));
        await mountWindows();
        await openI1Health();
        const g = env.backend!.gate('compute_health_preview', a => a.request?.kind === 'individual' && a.request?.set_points?.lower === 49);
        typeSp('sp-lower', '49');
        await settle(300);
        expect(g.entered).toBe(true);
        // loading: the previous answer stays on screen
        expect(bmw().getByTestId('set-points-card')).toBeTruthy();
        // switch to the clustering sensor and its Health page
        selectSensor('tag3');
        await waitForCharts();
        await openHealth();
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
        await act(async () => { g.release(); });
        await settle(100);
        // still the clustering page, still its own (valid) answer
        expect(bmw().getByTestId('sp-outer_sd')).toBeTruthy();
        expect(bmw().getByTestId('check-valid')).toBeTruthy();
    });
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

describe('errors from Rust', () => {
    // A NOT_FITTED fit (e.g. evicted from Rust's fit cache during a long Train all) is
    // re-fitted automatically ONCE per model + fingerprint; losing the same fit again shows the board
    // (workbench-redesign §4: no Re-train button in the pane; the model counts as "needs training") with
    // "Load it again" — the same silent re-fit, asked for by the user — next to "Train sensor ↑".
    it('NOT_FITTED (Relationship fit dropped from Rust memory): re-fitted once automatically; a second loss -> "Fit no longer in memory" on both pages; "Load it again" recovers without re-training (nothing written)', async () => {
        writeDisk(trainedWs());
        await mountWindows();
        selectSensor('tag1');
        selectKindTab('Relation model');
        await waitForCharts();
        await openHealth();
        const fits = () => env.backend!.cmds('preview_relationship_model').filter(c => c.args.cache_key).length;
        const before = fits();
        env.backend!.clearRelCache(); // e.g. evicted, or a special sensor it used was replaced
        await enterSp({ 'sp-residual_at_0_upper': '11' });
        await settle(400);
        await settle(400);
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
        expect(fits()).toBe(before + 1); // the automatic re-fit (nothing persisted, status untouched)
        expect(bmw().queryByTestId('health-not-fitted')).toBeNull();
        // The same fit lost again: no automatic loop — the user is offered Re-train.
        env.backend!.clearRelCache();
        await enterSp({ 'sp-residual_at_0_upper': '12' });
        await waitFor(() => expect(bmw().getByTestId('health-not-fitted')).toBeTruthy());
        await settle(400);
        expect(fits()).toBe(before + 1);
        expect(markBtn().disabled).toBe(true);
        expect(bmw().getByTestId('mark-block-reason').textContent).toBe('Fit no longer in memory · load it again, or re-train with Train sensor ↑');
        expect(bmw().queryByTestId('health-not-fitted-retrain')).toBeNull();
        const trainSensor = () => bmw().getByTestId('train-sensor') as HTMLButtonElement;
        // it counts as "needs training": Train sensor is the one filled button, and the link leads to it
        expect(bmw().getByTestId('wb-actions').getAttribute('data-primary')).toBe('train');
        expect(trainSensor().className).toContain('rcx-btn--pri');
        fireEvent.click(bmw().getByTestId('health-go-train-sensor'));
        expect(document.activeElement).toBe(trainSensor());
        // the Model fit page says the same
        fireEvent.click(bmw().getByTestId('page-tab-model'));
        await settle(50);
        expect(bmw().getByTestId('results-not-fitted').textContent).toMatch(/^Fit no longer in memory/);
        expect(bmw().queryByTestId('results-not-fitted-retrain')).toBeNull();
        expect(bmw().getByTestId('footer-status').textContent).toBe('Fit no longer in memory · load it again, or re-train with Train sensor ↑');
        fireEvent.click(bmw().getByTestId('page-tab-health'));
        await settle(50);
        // "Load it again": ONE more fit of the same model, and the page is back — the model on disk
        // is exactly what it was (not re-trained: same train time and fingerprint, status untouched).
        const onDisk = { ...diskModel('r1') };
        await act(async () => { fireEvent.click(bmw().getByTestId('health-load-fit')); });
        await settle(400);
        await settle(400);
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
        expect(fits()).toBe(before + 2);
        expect(bmw().queryByTestId('health-not-fitted')).toBeNull();
        expect(diskModel('r1')).toMatchObject({ status: onDisk.status, lastTrainedAt: onDisk.lastTrainedAt, trainedFingerprint: onDisk.trainedFingerprint });
        expect(markBtn().disabled).toBe(false);
    });

    it('a dataset reload (new session) -> STALE_SESSION is shown, never another dataset\'s numbers', async () => {
        writeDisk(trainedWs());
        await mountWindows();
        await openI1Health();
        env.backend!.loadDataset('plant');
        await enterSp({ 'sp-lower': '5' });
        await waitFor(() => expect(bmw().getByTestId('health-error').textContent).toMatch(/dataset changed/));
        const last = env.backend!.cmds('compute_health_preview').pop()!;
        expect(last.error).toMatch(/^STALE_SESSION/);
    });

    it('BAD_REQUEST is shown as "Couldn\'t load the health score", Mark complete stays blocked, the typed value is saved', async () => {
        writeDisk(trainedWs());
        await mountWindows();
        await openI1Health();
        env.backend!.failOn('compute_health_preview', () => true, 'BAD_REQUEST: Sensor not found: TAG1');
        await enterSp({ 'sp-lower': '6' });
        await waitFor(() => expect(bmw().getByTestId('health-error').textContent).toMatch(/Sensor not found: TAG1/));
        expect((bmw().getByTestId('mark-complete') as HTMLButtonElement).disabled).toBe(true);
        expect(diskModel('i1').healthSetPoints.lower).toBe(6);
    });

    // The page and its inputs stay on screen from the hook's `lastData` under an inline
    // error banner with a Retry button (a NOT_FITTED error keeps its own full-page "Re-train" message).
    // Guards against: any preview failure (even a one-off one) replaces the WHOLE
    // Health score page with "Couldn't load the health score" (HealthScorePage.tsx:51-71:
    // `useHealthPreview` sets `data: null` on an error). The set-point inputs and Checks
    // disappear and there is no Retry: the request only re-runs when its key changes,
    // which the user can no longer do from this page (they must leave the page or the
    // model and come back).
    it('UX BUG: after a one-off preview failure the user can retry from the Health score page (inputs or a Retry button stay)', async () => {
        writeDisk(trainedWs());
        await mountWindows();
        await openI1Health();
        env.backend!.failOn('compute_health_preview', () => true, 'Failed to read column: transient I/O error');
        await enterSp({ 'sp-lower': '6' });
        await waitFor(() => expect(bmw().getByTestId('health-error')).toBeTruthy());
        const retry = bmw().queryByRole('button', { name: /retry|try again/i });
        expect(retry !== null || bmw().queryByTestId('sp-lower') !== null).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Mark complete races and failures
// ---------------------------------------------------------------------------

describe('Mark complete: races and failures (it only CHECKS the set points — Export results writes the files)', () => {
    /** Mark complete's own check: the tiny `compute_health_preview` (`checkModelForComplete`). */
    const isCheck = (a: any) => a?.request?.max_points === 8;
    const checks = () => env.backend!.cmds('compute_health_preview').filter(c => isCheck(c.args));
    async function readyI1() {
        writeDisk(trainedWs({ i1: { healthSetPoints: { ...EMPTY_I, lower: 20, upper: 80 } } }));
        await mountWindows();
        await openI1Health();
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
    }

    it('a double click checks ONCE; no file is ever written', async () => {
        await readyI1();
        await waitFor(() => expect(markBtn().disabled).toBe(false));
        await act(async () => { fireEvent.click(markBtn()); fireEvent.click(markBtn()); });
        await settle(100);
        expect(checks()).toHaveLength(1);
        expect(env.backend!.cmds('export_model_files')).toHaveLength(0);
        expect(diskModel('i1').status).toBe(true);
        expect([...env.files.keys()].some(k => k.includes('/output/'))).toBe(false);
    });

    it('the check says not valid -> Rust\'s issues in Checks, nothing written, the model stays Incomplete', async () => {
        await readyI1();
        env.backend!.override('compute_health_preview', isCheck, async (_a, real) => ({
            ...(await real() as any),
            valid: false,
            validation: [{ code: 'lower_inside_3sd', severity: 'error', message: 'The lower set point (L = 20) must be below the lower 3σ boundary (25).', field: 'lower' }],
        }));
        await markComplete();
        await waitFor(() => expect(bmw().getByTestId('save-error')).toBeTruthy());
        expect(bmw().getAllByTestId('check-line').map(l => l.textContent).join('|')).toMatch(/lower 3σ boundary \(25\)/);
        expect(diskModel('i1').status).toBe(false);
        expect(diskModel('i1').healthExport).toBeUndefined();
        expect([...env.files.keys()].some(k => k.includes('/output/'))).toBe(false);
    });

    it('the check rejects -> the error is shown, the model stays Incomplete, Mark complete can be retried', async () => {
        await readyI1();
        env.backend!.failOn('compute_health_preview', isCheck, 'Failed to read column TAG1: access denied');
        await markComplete();
        await waitFor(() => expect(bmw().getByTestId('save-error').textContent).toMatch(/access denied/));
        expect(diskModel('i1').status).toBe(false);
        await markComplete();
        await waitFor(() => expect(bmw().getByTestId('mark-incomplete')).toBeTruthy());
        expect(diskModel('i1').status).toBe(true);
    });

    it('the disk changed during the check (another window applied a new running condition) -> NOT Complete, and the user is told', async () => {
        await readyI1();
        const g = env.backend!.gate('compute_health_preview', isCheck);
        await act(async () => { fireEvent.click(markBtn()); });
        await settle(30);
        // Another window changes the workspace condition meanwhile.
        await act(async () => {
            const next = await updateWorkspaceData(WS, prev => withFailureGroupState(prev, {
                runningConditionFilters: [{ id: 'rc1', sensor: 'TAG2', operation: 'greater_than', value1: '30', value2: '' }],
            }));
            await emit('failure-group-state-changed', { ...next!.failureGroupState, workspaceId: WS, origin: 'other-window' });
        });
        await act(async () => { g.release(); });
        await settle(150);
        expect(diskModel('i1').status).toBe(false);
        expect([...env.files.keys()].some(k => k.includes('/output/'))).toBe(false);
        // the model is now out of date, so the window shows the Model fit page + stale banner
        expect(bmw().getByTestId('stale-banner')).toBeTruthy();
        // ...and the refusal is visible there too (the Health score page can no longer be shown)
        expect(bmwEl().textContent).toMatch(/not marked complete/);
    });

    it('switching sensor while checking: the save still lands on the right model', async () => {
        await readyI1();
        const g = env.backend!.gate('compute_health_preview', isCheck);
        await act(async () => { fireEvent.click(markBtn()); });
        await settle(30);
        selectSensor('tag3');
        await settle(50);
        await act(async () => { g.release(); });
        await settle(100);
        expect(diskModel('i1').status).toBe(true);
        expect(diskModel('c1').status).toBe(false);
        selectSensor('tag1');
        await settle(100);
        expect(pill()).toBe('Complete');
    });

    // `persistModelComplete` keeps the newer on-disk set points when they were committed while
    // the check ran, and does NOT mark the model Complete (those numbers were never validated).
    // Guards against: set points typed + committed WHILE Mark complete runs being silently
    // reverted to the values that were checked, or marked Complete unvalidated.
    it('a set point edited and committed while the check runs is kept on disk and the model stays Incomplete', async () => {
        await readyI1();
        const g = env.backend!.gate('compute_health_preview', isCheck);
        await act(async () => { fireEvent.click(markBtn()); });
        await settle(30);
        await enterSp({ 'sp-upper': '85' }); // blur-committed during the check
        expect(diskModel('i1').healthSetPoints.upper).toBe(85);
        await act(async () => { g.release(); });
        await settle(150);
        expect(diskModel('i1').healthSetPoints.upper).toBe(85);
        expect(diskModel('i1').status).toBe(false);
        expect(bmwEl().textContent).toContain('the set points changed while it was being checked');
        expect(bmwEl().querySelector('[data-testid="files-out-of-date"]')).toBeNull();
        expect(bmwEl().querySelector('[data-testid="mark-complete-again"]')).toBeNull();
    });

    // The save is refused unless the on-disk model still has the fingerprint that was checked,
    // and a model whose Mark complete is running cannot be trained meanwhile.
    it('a Relationship model re-configured during its check does NOT end up Complete, and cannot be re-trained until the check ends', async () => {
        writeDisk(trainedWs());
        await mountWindows();
        selectSensor('tag1');
        selectKindTab('Relation model');
        await waitForCharts();
        await openHealth();
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
        const g = env.backend!.gate('compute_health_preview', isCheck);
        await act(async () => { fireEvent.click(markBtn()); });
        await settle(30);
        const checkedKey = checks()[0].args.request.cache_key;
        // back to Model fit: change stiffness, Save — all while the check runs
        fireEvent.click(bmw().getByTestId('page-tab-model'));
        openSettings();
        fireEvent.click(bmw().getByRole('button', { name: 'Strict' }));
        await saveChanges();
        // Train is refused while Mark complete runs.
        fireEvent.click(bmw().getByTestId('train-sensor-menu-toggle'));
        const only = bmw().getByTestId('train-menu-only-relationship') as HTMLButtonElement;
        expect(only.disabled).toBe(true);
        expect(only.querySelector('small')!.textContent).toBe('It is being checked for Mark complete');
        await act(async () => { g.release(); });
        await settle(150);
        const m = diskModel('r1');
        expect(`r1::${m.trainedFingerprint}`).toBe(checkedKey); // not re-trained meanwhile
        expect(m.relStiffness).toBe(1_000_000); // the Strict edit was saved (the model really changed)
        expect(m.status).toBe(false);
        expect(bmwEl().textContent).toMatch(/not marked complete/);
    });

    // The WHOLE Mark-complete run is registered and both close paths wait for it.
    it('a native close during the check waits for Mark complete to finish', async () => {
        await readyI1();
        const g = env.backend!.gate('compute_health_preview', isCheck);
        await act(async () => { fireEvent.click(markBtn()); });
        await settle(30);
        let prevented = false;
        const closing = act(async () => { prevented = await nativeClose(); });
        await settle(30);
        g.release();
        await closing;
        expect(prevented).toBe(true);
        // ... and the save landed before the window was allowed to close
        expect(diskModel('i1').status).toBe(true);
        expect(env.windowClose).toBe(1);
    });

    it('a model made stale (not re-trained) during the check is NOT marked Complete', async () => {
        await readyI1();
        const g = env.backend!.gate('compute_health_preview', isCheck);
        await act(async () => { fireEvent.click(markBtn()); });
        await settle(30);
        await applyWorkspaceRc(m => { fireEvent.change(m.getByLabelText('Running above this value'), { target: { value: '25' } }); });
        await act(async () => { g.release(); });
        await settle(150);
        expect(diskModel('i1').status).toBe(false);
    });

    it('a set-point change on a Complete model makes it Incomplete; Mark complete then checks the new points and marks it Complete again (no files)', async () => {
        await readyI1();
        await markComplete();
        await waitFor(() => expect(bmw().getByTestId('mark-incomplete')).toBeTruthy());
        expect(diskModel('i1').healthSetPoints).toMatchObject({ lower: 20, upper: 80 });
        // a set-point change makes the model Incomplete in the same write (export round
        // 2026-10-20): no "changed after saving" hint, the plain Mark complete is back
        await enterSp({ 'sp-upper': '82' });
        expect(diskModel('i1').status).toBe(false);
        expect(bmwEl().querySelector('[data-testid="files-out-of-date"]')).toBeNull();
        expect(bmwEl().querySelector('[data-testid="mark-complete-again"]')).toBeNull();
        await waitFor(() => expect(markBtn().disabled).toBe(false));
        await act(async () => { fireEvent.click(markBtn()); });
        await settle(150);
        expect(checks().slice(-1)[0].args.request.set_points).toMatchObject({ lower: 20, upper: 82 });
        expect(diskModel('i1').status).toBe(true);
        expect(diskModel('i1').healthSetPoints).toMatchObject({ lower: 20, upper: 82 });
        expect(diskModel('i1').healthExport).toBeUndefined();
        expect(env.backend!.cmds('export_model_files')).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Workspaces: isolation of the new state, delete / duplicate
// ---------------------------------------------------------------------------

describe('multi-workspace isolation of the health state', () => {
    it('A -> B re-point: A\'s set points / export state never show in B (same model ids, e.g. a duplicated workspace)', async () => {
        writeDisk(trainedWs({ i1: { healthSetPoints: { ...EMPTY_I, lower: 20, upper: 80 } } }));
        writeDisk(trainedWs({ i1: { healthSetPoints: { ...EMPTY_I, lower: 1, upper: 99 } } }, 'ws2'), 'ws2');
        await mountWindows({ dashboard: false });
        await openI1Health();
        await markComplete();
        await waitFor(() => expect(bmw().getByTestId('mark-incomplete')).toBeTruthy());
        await sendBuildModelData('ws2');
        await settle(200);
        selectSensor('tag1');
        await waitForCharts();
        await openHealth();
        expect((bmw().getByTestId('sp-lower') as HTMLInputElement).value).toBe('1');
        expect(bmwEl().querySelector('[data-testid="save-ok"]')).toBeNull();
        expect(pill()).toBe('Trained');
        expect(JSON.parse(env.files.get('workspaces/ws2.json')!).failureGroupState.models[0].status).toBe(false);
    });

    it('a Mark complete of A that finishes after the window moved to B writes nothing into B', async () => {
        writeDisk(trainedWs({ i1: { healthSetPoints: { ...EMPTY_I, lower: 20, upper: 80 } } }));
        writeDisk(trainedWs({ i1: { healthSetPoints: { ...EMPTY_I, lower: 1, upper: 99 } } }, 'ws2'), 'ws2');
        await mountWindows({ dashboard: false });
        await openI1Health();
        await waitFor(() => expect(markBtn().disabled).toBe(false));
        const g = env.backend!.gate('compute_health_preview', (a: any) => a?.request?.max_points === 8);
        await act(async () => { fireEvent.click(markBtn()); });
        await settle(30);
        const ws2Before = env.files.get('workspaces/ws2.json');
        await sendBuildModelData('ws2');
        await act(async () => { g.release(); });
        await settle(200);
        // Nothing of A's run reaches B. (B's own model may legitimately get its OWN freshly computed
        // saved verdict - `healthVerdict` - once its preview lands, and a write re-orders the slice's
        // keys, so compare the parsed content without that one field.)
        const parsed = (json: string | undefined) => {
            const o = JSON.parse(json!);
            for (const m of o.failureGroupState.models) delete m.healthVerdict;
            return o;
        };
        expect(parsed(env.files.get('workspaces/ws2.json'))).toEqual(parsed(ws2Before));
        expect(diskModel('i1', 'ws2').healthExport).toBeUndefined();
        expect(diskModel('i1', 'ws2').status).toBe(false);
        expect([...env.files.keys()].some(k => k.startsWith('workspaces/ws2/'))).toBe(false);
    });

    // The re-point handler commits pending drafts to the OLD workspace before it switches.
    // Guards against: re-pointing the window at another workspace drops a set point that was
    // typed but not yet blurred: the `build-model-data` listener resets `spDrafts` to `{}`
    // (BuildModelWindow.tsx:708) without committing it to the OLD workspace first. (The
    // Dashboard normally closes this window when it leaves a workspace, which flushes;
    // a re-point only happens when the window survived.)
    it('BUG: a set point typed (no blur) in A is saved to A when the window is re-pointed at B', async () => {
        writeDisk(trainedWs());
        writeDisk(trainedWs({}, 'ws2'), 'ws2');
        await mountWindows({ dashboard: false });
        await openI1Health();
        typeSp('sp-lower', '13');
        await sendBuildModelData('ws2');
        await settle(200);
        expect(JSON.parse(env.files.get('workspaces/ws2.json')!).failureGroupState.models[0].healthSetPoints.lower).toBeNull(); // never B
        expect(lowerOnDisk()).toBe(13);
    });

    // `executeTrain` compares `get_session_generation` with the window's generation before and after.
    // Guards against: the Build Model window's TRAIN is not bound to the dataset
    // session: `compute_sensor_stats` / `preview_relationship_model` /
    // `compute_clustering_preview` carry no expected generation (none of them accept one),
    // so a window that outlived its dataset (another CSV loaded meanwhile) trains on the
    // OTHER dataset and stamps the model `lastTrainedAt` / `trainedFingerprint` in ITS
    // workspace — the model then reads "Trained" with numbers from the wrong data, while
    // `compute_health_preview` right after answers STALE_SESSION.
    it('BUG: Train in a window whose dataset was replaced does not stamp the model as trained', async () => {
        const other = plantDataset(30);
        newBackend({ plant: plantDataset(), other });
        const s = trainedWs();
        delete (s.failureGroupState as any).models[0].lastTrainedAt;
        delete (s.failureGroupState as any).models[0].trainedFingerprint;
        writeDisk(s);
        await mountWindows({ dashboard: false });
        selectSensor('tag1');
        await settle(100);
        env.backend!.loadDataset('other'); // another workspace's CSV was loaded in the main window
        await train();
        expect(diskModel('i1').lastTrainedAt).toBeUndefined();
        expect(diskModel('i1').trainedFingerprint).toBeUndefined();
        await waitFor(() => expect(bmwEl().textContent).toMatch(/dataset changed since this window was opened/i));
        expect(pill()).not.toBe('Trained');
    });

    it('deleteWorkspace removes the workspace output folder (and only it)', async () => {
        writeDisk(trainedWs({ i1: { healthSetPoints: { ...EMPTY_I, lower: 20, upper: 80 } } }));
        await mountWindows({ dashboard: false });
        await openI1Health();
        await markComplete();
        await waitFor(() => expect(bmw().getByTestId('mark-incomplete')).toBeTruthy());
        // files an older build's Mark complete left behind (Mark complete writes none any more)
        env.files.set(`workspaces/${WS}/output/TAG1/INDV_INFO_TAG1.json`, '{}');
        env.files.set('workspaces/ws10/output/TAG1/INDV_INFO_TAG1.json', '{}'); // a sibling with a prefix-like id
        expect(env.files.has(`workspaces/${WS}/output/TAG1/INDV_INFO_TAG1.json`)).toBe(true);
        cleanup();
        await deleteWorkspace(WS);
        expect([...env.files.keys()].filter(k => k.startsWith(`workspaces/${WS}/`))).toEqual([]);
        expect(env.files.has('workspaces/ws10/output/TAG1/INDV_INFO_TAG1.json')).toBe(true);
        expect(env.files.has(`workspaces/${WS}.json`)).toBe(false);
    });

    // A duplicated workspace's models become Incomplete and drop `healthExport`.
    // Guards against: `duplicateWorkspace` copies the models
    // with `status: true` and a `healthExport` whose `outputDir` is the ORIGINAL
    // workspace's folder, but does not copy that folder (deliberately).
    // The copy therefore shows "Complete · files saved to <original's folder>"; once the
    // original is deleted those files are gone and the copy still claims them.
    it('a duplicated workspace keeps the model Complete (user decision 2026-10-20) but does not claim files in the ORIGINAL workspace output folder', async () => {
        writeDisk(trainedWs({ i1: { healthSetPoints: { ...EMPTY_I, lower: 20, upper: 80 } } }));
        await mountWindows({ dashboard: false });
        await openI1Health();
        await markComplete();
        await waitFor(() => expect(bmw().getByTestId('mark-incomplete')).toBeTruthy());
        cleanup();
        const copy = await duplicateWorkspace(WS);
        await deleteWorkspace(WS);
        const m = copy!.failureGroupState!.models.find(x => x.id === 'i1')!;
        const claimsOriginal = !!(m.status && m.healthExport?.outputDir?.includes(`/workspaces/${WS}/`));
        expect(claimsOriginal).toBe(false);
        // ... the copy keeps its status and everything else, without the original's export record
        expect(m.status).toBe(true);
        expect(m.healthExport).toBeUndefined();
        expect(m.healthSetPoints).toMatchObject({ lower: 20, upper: 80 });
        expect(m.lastTrainedAt).toBeTruthy();
        expect(m.trainedFingerprint).toBeTruthy();
    });
});

void readDisk; void openSettings; void screen;
