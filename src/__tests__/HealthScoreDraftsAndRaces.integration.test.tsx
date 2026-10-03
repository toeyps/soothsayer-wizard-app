import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

/*
 * Health score QA sweep (2026-10-04) — set-point drafts (persist / flush / never
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
        { name: 'switches the kind tab', leave: async () => { selectKindTab('Relationship'); await settle(100); } },
        { name: 'goes back to Model fit', leave: async () => { fireEvent.click(bmw().getByTestId('footer-back-to-fit')); await settle(100); } },
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
    it('NOT_FITTED (Relationship fit dropped from Rust memory) -> "Re-train to recompute" on both pages; Re-train recovers', async () => {
        writeDisk(trainedWs());
        await mountWindows();
        selectSensor('tag1');
        selectKindTab('Relationship');
        await waitForCharts();
        await openHealth();
        env.backend!.clearRelCache(); // e.g. a special sensor it used was replaced
        await enterSp({ 'sp-residual_at_0_upper': '11' });
        await waitFor(() => expect(bmw().getByTestId('health-not-fitted')).toBeTruthy());
        expect(markBtn().disabled).toBe(true);
        expect(bmw().getByTestId('mark-block-reason').textContent).toMatch(/Re-train first/);
        // the Model fit page says the same
        fireEvent.click(bmw().getByTestId('footer-back-to-fit'));
        await settle(50);
        expect(bmw().getByTestId('results-not-fitted')).toBeTruthy();
        fireEvent.click(bmw().getByTestId('page-health'));
        await settle(50);
        await act(async () => { fireEvent.click(bmw().getByTestId('health-not-fitted-retrain')); });
        await settle(400);
        await settle(400);
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
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

    // FIXED 2026-10-04 (was `it.fails`): the page and its inputs stay on screen from the hook's `lastData` under an inline
    // error banner with a Retry button (a NOT_FITTED error keeps its own full-page "Re-train" message).
    // UX BUG (LOW–MEDIUM) — any preview failure (even a one-off one) replaces the WHOLE
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

describe('Mark complete: races and failures', () => {
    async function readyI1() {
        writeDisk(trainedWs({ i1: { healthSetPoints: { ...EMPTY_I, lower: 20, upper: 80 } } }));
        await mountWindows();
        await openI1Health();
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
    }

    it('a double click exports ONCE', async () => {
        await readyI1();
        await waitFor(() => expect(markBtn().disabled).toBe(false));
        await act(async () => { fireEvent.click(markBtn()); fireEvent.click(markBtn()); });
        await settle(100);
        expect(env.backend!.cmds('export_model_files')).toHaveLength(1);
        expect(diskModel('i1').status).toBe(true);
    });

    it('export ok:false -> Rust\'s issues in Checks, nothing written, the model stays Incomplete', async () => {
        await readyI1();
        env.backend!.override('export_model_files', () => true, () => ({
            ok: false, files: [], output_dir: env.backend!.outputDir(WS),
            validation: [{ code: 'lower_inside_3sd', severity: 'error', message: 'The lower set point (L = 20) must be below the lower 3σ boundary (25).', field: 'lower' }],
            warnings: [],
        }));
        await markComplete();
        await waitFor(() => expect(bmw().getByTestId('save-error')).toBeTruthy());
        expect(bmw().getAllByTestId('check-line').map(l => l.textContent).join('|')).toMatch(/lower 3σ boundary \(25\)/);
        expect(diskModel('i1').status).toBe(false);
        expect(diskModel('i1').healthExport).toBeUndefined();
        expect([...env.files.keys()].some(k => k.includes('/output/'))).toBe(false);
    });

    it('export rejects (sidecar / disk) -> the error is shown, the model stays Incomplete, Mark complete can be retried', async () => {
        await readyI1();
        env.backend!.failOn('export_model_files', () => true, 'Failed to write INDV_INFO: access denied');
        await markComplete();
        await waitFor(() => expect(bmw().getByTestId('save-error').textContent).toMatch(/access denied/));
        expect(diskModel('i1').status).toBe(false);
        await markComplete();
        await waitFor(() => expect(bmw().getByTestId('save-ok')).toBeTruthy());
        expect(diskModel('i1').status).toBe(true);
    });

    it('the disk changed during the export (another window applied a new running condition) -> files written but NOT Complete, and the user is told', async () => {
        await readyI1();
        const g = env.backend!.gate('export_model_files');
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
        expect(env.files.has(`workspaces/${WS}/output/TAG1/INDV_INFO_TAG1.json`)).toBe(true);
        // the model is now out of date, so the window shows the Model fit page + stale banner
        expect(bmw().getByTestId('stale-banner')).toBeTruthy();
    });

    // FIXED 2026-10-04 (was `it.fails`): the refusal is also shown as a dismissible banner on the Model fit page (`save-notice`).
    // UX BUG (LOW) — when the save is refused because the model went out of date during
    // the export (the usual reason: another window changed the running condition), the
    // "files were written, but the model was not marked complete" message is stored in
    // `saveInfo` but only the Health score page renders it, and that page can no longer be
    // shown for a stale model (`pageOf` falls back to Model fit). The user never learns
    // that their Mark complete was refused or that files were written.
    it('UX BUG: "files were written, but the model was not marked complete" is visible after the disk changed during the export', async () => {
        await readyI1();
        const g = env.backend!.gate('export_model_files');
        await act(async () => { fireEvent.click(markBtn()); });
        await settle(30);
        await act(async () => {
            const next = await updateWorkspaceData(WS, prev => withFailureGroupState(prev, {
                runningConditionFilters: [{ id: 'rc1', sensor: 'TAG2', operation: 'greater_than', value1: '30', value2: '' }],
            }));
            await emit('failure-group-state-changed', { ...next!.failureGroupState, workspaceId: WS, origin: 'other-window' });
        });
        await act(async () => { g.release(); });
        await settle(150);
        expect(bmwEl().textContent).toMatch(/not marked complete/);
    });

    it('switching sensor while saving: the save still lands on the right model', async () => {
        await readyI1();
        const g = env.backend!.gate('export_model_files');
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

    // FIXED 2026-10-04 (was `it.fails`): `persistModelComplete` keeps the newer on-disk set points, records the EXPORTED values in
    // `healthExport` (so "Changed after saving" shows) and still marks the model Complete (decision, see the handover entry).
    // BUG (MEDIUM) — set points typed + committed WHILE the export runs are silently
    // reverted. `runMarkComplete` -> `persistModelComplete(..., res.setPoints)` writes the
    // set points that were EXPORTED (captured at click time) over whatever is on disk by
    // then (BuildModelWindow.tsx:1450, healthPersist.ts `persistModelComplete`), and the
    // newer value's draft was already dropped by its own commit, so the user's edit
    // vanishes from disk and from the screen without any message. A Relationship export
    // takes ~15 s and the page stays editable during it, so this is easy to hit.
    it('BUG: a set point edited and committed while the export runs is kept on disk (not reverted to the exported value)', async () => {
        await readyI1();
        const g = env.backend!.gate('export_model_files');
        await act(async () => { fireEvent.click(markBtn()); });
        await settle(30);
        await enterSp({ 'sp-upper': '85' }); // blur-committed during the export
        expect(diskModel('i1').healthSetPoints.upper).toBe(85);
        await act(async () => { g.release(); });
        await settle(150);
        expect(diskModel('i1').healthSetPoints.upper).toBe(85);
        // the files hold the EXPORTED 80: the page says so and offers Mark complete again
        expect(diskModel('i1').healthExport.setPoints.upper).toBe(80);
        expect(bmw().getByTestId('files-out-of-date')).toBeTruthy();
        expect(bmw().getByTestId('mark-complete-again')).toBeTruthy();
    });

    // FIXED 2026-10-04 (was `it.fails`): the save is refused unless the on-disk model still has the fingerprint that was exported.
    // BUG (MEDIUM) — a model whose settings change AND are re-trained while its export
    // runs ends up Complete with files from the OLD settings. `persistModelComplete`
    // only checks "trained and fresh" against the disk (healthPersist.ts), not that the
    // disk model still has the fingerprint that was exported, so a re-train during the
    // ~15 s Relationship export (the Model fit page and Re-train stay usable) passes.
    it('BUG: a Relationship model re-configured and re-trained during its export does NOT end up Complete with the old files', async () => {
        writeDisk(trainedWs());
        await mountWindows();
        selectSensor('tag1');
        selectKindTab('Relationship');
        await waitForCharts();
        await openHealth();
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
        const g = env.backend!.gate('sidecar:export_model_files');
        await act(async () => { fireEvent.click(markBtn()); });
        await settle(30);
        const exportedKey = env.backend!.cmds('export_model_files')[0].args.request.cache_key;
        // back to Model fit: change stiffness, Save, Re-train — all while the export runs
        fireEvent.click(bmw().getByTestId('footer-back-to-fit'));
        openSettings();
        fireEvent.click(bmw().getByRole('button', { name: 'Strict' }));
        await saveChanges();
        await train();
        expect(pill()).toBe('Trained');
        await act(async () => { g.release(); });
        await settle(150);
        const m = diskModel('r1');
        expect(`r1::${m.trainedFingerprint}`).not.toBe(exportedKey); // the model really changed
        expect(m.status).toBe(false); // the files carry the OLD settings
        expect(bmwEl().textContent).toMatch(/settings changed while its files were being written/);
    });

    // FIXED 2026-10-04 (was `it.fails`): the WHOLE Mark-complete run is registered (`markRunsRef`) and both close paths wait for it.
    // BUG (MEDIUM) — closing the window while "Mark complete" is exporting does not wait:
    // `onCloseRequested` only waits for `pendingSaveRef`, and `runMarkComplete` puts its
    // promise there only for the final persist step (BuildModelWindow.tsx:1449), not for
    // `completeModel`'s export. In the real app the webview is destroyed, so the files are
    // written but `status: true` is never persisted — the model silently stays Incomplete.
    it('BUG: a native close during the export waits for Mark complete to finish', async () => {
        await readyI1();
        const g = env.backend!.gate('export_model_files');
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

    it('a model made stale (not re-trained) during the export is NOT marked Complete', async () => {
        await readyI1();
        const g = env.backend!.gate('export_model_files');
        await act(async () => { fireEvent.click(markBtn()); });
        await settle(30);
        await applyWorkspaceRc(m => { fireEvent.change(m.getByPlaceholderText('value'), { target: { value: '25' } }); });
        await act(async () => { g.release(); });
        await settle(150);
        expect(diskModel('i1').status).toBe(false);
    });

    it('"Changed after saving" + "Mark complete again" rewrites the files and the export record; reverting the value clears the hint', async () => {
        await readyI1();
        await markComplete();
        await waitFor(() => expect(bmw().getByTestId('save-ok')).toBeTruthy());
        const first = diskModel('i1').healthExport;
        expect(first.setPoints).toMatchObject({ lower: 20, upper: 80 });
        await enterSp({ 'sp-upper': '81' });
        expect(bmw().getByTestId('files-out-of-date')).toBeTruthy();
        await enterSp({ 'sp-upper': '80' });
        expect(bmwEl().querySelector('[data-testid="files-out-of-date"]')).toBeNull();
        await enterSp({ 'sp-upper': '82' });
        await act(async () => { fireEvent.click(bmw().getByTestId('mark-complete-again')); });
        await settle(150);
        const second = diskModel('i1').healthExport;
        expect(second.setPoints).toMatchObject({ lower: 20, upper: 82 });
        expect(second.at >= first.at).toBe(true);
        expect(JSON.parse(env.files.get(`workspaces/${WS}/output/TAG1/INDV_INFO_TAG1.json`)!).model_metrics.setpoint_health_score).toEqual([20, 82]);
        expect(bmwEl().querySelector('[data-testid="files-out-of-date"]')).toBeNull();
        expect(diskModel('i1').status).toBe(true);
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
        await waitFor(() => expect(bmw().getByTestId('save-ok')).toBeTruthy());
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
        const g = env.backend!.gate('export_model_files');
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

    // FIXED 2026-10-04 (was `it.fails`): the re-point handler commits pending drafts to the OLD workspace before it switches.
    // BUG (LOW) — re-pointing the window at another workspace drops a set point that was
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

    // FIXED 2026-10-04 (was `it.fails`): `executeTrain` compares `get_session_generation` with the window's generation before and after.
    // BUG (LOW–MEDIUM) — the Build Model window's TRAIN is not bound to the dataset
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
        await waitFor(() => expect(bmw().getByTestId('save-ok')).toBeTruthy());
        env.files.set('workspaces/ws10/output/TAG1/INDV_INFO_TAG1.json', '{}'); // a sibling with a prefix-like id
        expect(env.files.has(`workspaces/${WS}/output/TAG1/INDV_INFO_TAG1.json`)).toBe(true);
        cleanup();
        await deleteWorkspace(WS);
        expect([...env.files.keys()].filter(k => k.startsWith(`workspaces/${WS}/`))).toEqual([]);
        expect(env.files.has('workspaces/ws10/output/TAG1/INDV_INFO_TAG1.json')).toBe(true);
        expect(env.files.has(`workspaces/${WS}.json`)).toBe(false);
    });

    // FIXED 2026-10-04 (was `it.fails`, decision 11): a duplicated workspace's models become Incomplete and drop `healthExport`.
    // DESIGN GAP (LOW, needs a user decision) — `duplicateWorkspace` copies the models
    // with `status: true` and a `healthExport` whose `outputDir` is the ORIGINAL
    // workspace's folder, but does not copy that folder (deliberate per the 3a entry).
    // The copy therefore shows "Complete · files saved to <original's folder>"; once the
    // original is deleted those files are gone and the copy still claims them.
    it('DESIGN GAP: a duplicated workspace does not claim files that live in the ORIGINAL workspace\'s output folder', async () => {
        writeDisk(trainedWs({ i1: { healthSetPoints: { ...EMPTY_I, lower: 20, upper: 80 } } }));
        await mountWindows({ dashboard: false });
        await openI1Health();
        await markComplete();
        await waitFor(() => expect(bmw().getByTestId('save-ok')).toBeTruthy());
        cleanup();
        const copy = await duplicateWorkspace(WS);
        await deleteWorkspace(WS);
        const m = copy!.failureGroupState!.models.find(x => x.id === 'i1')!;
        const claimsOriginal = m.status && m.healthExport?.outputDir?.includes(`/workspaces/${WS}/`);
        expect(claimsOriginal).toBe(false);
        // ... the copy keeps everything else and must be marked complete again
        expect(m.status).toBe(false);
        expect(m.healthExport).toBeUndefined();
        expect(m.healthSetPoints).toMatchObject({ lower: 20, upper: 80 });
        expect(m.lastTrainedAt).toBeTruthy();
        expect(m.trainedFingerprint).toBeTruthy();
    });
});

void readDisk; void openSettings; void screen;
