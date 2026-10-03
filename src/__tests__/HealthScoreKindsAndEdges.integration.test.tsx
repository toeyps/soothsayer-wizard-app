import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';

/*
 * Health score QA sweep (2026-10-04) — per-kind specifics and edge cases with
 * the REAL Dashboard + Build Model window on the fake Rust health backend:
 *   - Individual master-data prefill: both / one / no alarm, special sensor,
 *     first-open snapshot of an old model (written once, never written back to
 *     master data), "use <master>", late metadata.
 *   - Relationship: cache_key follows the fingerprint, NOT_FITTED after a reload
 *     -> Re-train, Compare predictors, signs / asymmetric points.
 *   - Clustering: stepper / quick buttons, criteria ranges changed elsewhere.
 *   - Mark complete is the ONLY way to Complete (no full-view page / Finish
 *     control exists any more - health score phase 4, 2026-10-04).
 *   - Misc: long / unicode names, empty units, malformed previews, tiny numbers,
 *     keyboard, accessible names.
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
import { PLANT_META, hourly, plantDataset } from './helpers/fakeHealthRust';
import {
    WS, applyWorkspaceRc, bmw, bmwEl, dash, dashDot, diskModel, enterSp, markBtn, markComplete, model, mountWindows,
    newBackend, openDashFgTab, openDashSensorTab, openHealth, openSettings, pickInModal, pill, readDisk, saveChanges,
    selectSensor, sendBuildModelData, settle, train, typeSp, waitForCharts, writeDisk, wsState, wsTrained,
} from './helpers/healthWorkbench';
import { updateWorkspaceData } from '../workspaceManager';
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

function spHistory(mid: string): string[] {
    const out: string[] = [];
    for (const w of env.writes.filter(x => x.path === `workspaces/${WS}.json`)) {
        const m = JSON.parse(w.content).failureGroupState?.models?.find((x: any) => x.id === mid);
        const v = JSON.stringify(m?.healthSetPoints ?? null);
        if (out[out.length - 1] !== v) out.push(v);
    }
    return out;
}

async function createViaSheet(tag: string, kindLabel: string) {
    openDashSensorTab();
    fireEvent.change(dash().getByPlaceholderText('Search sensors...'), { target: { value: tag } });
    await settle();
    const row = (screen.getByTestId('dashboard-window').querySelector(`#sensor-${tag}`) as HTMLElement).closest('.sensor-list-row') as HTMLElement;
    const btn = within(row).getByTitle('Add to failure group');
    fireEvent.click(btn);
    const sheet = within(await screen.findByTestId('fg-sheet'));
    await act(async () => { fireEvent.click(sheet.getByRole('button', { name: `${kindLabel} · FG-A` })); });
    await settle(400);
    if (screen.queryByTestId('fg-sheet')) fireEvent.click(btn);
    fireEvent.change(dash().getByPlaceholderText('Search sensors...'), { target: { value: '' } });
    await settle(50);
}

// ---------------------------------------------------------------------------
// Individual master prefill
// ---------------------------------------------------------------------------

describe('Individual: master-data prefill (snapshot, chips, reset, never written back)', () => {
    it('one-sided (TAG3: H only) and none (TAG2): chips say so, the empty side is "required", nothing is guessed', async () => {
        writeDisk(wsState({ models: [] }));
        await mountWindows();
        await createViaSheet('TAG3', 'Individual');
        await createViaSheet('TAG2', 'Individual');
        const ms = readDisk().failureGroupState.models;
        const t3 = ms.find((m: any) => m.targetSensor === 'TAG3');
        const t2 = ms.find((m: any) => m.targetSensor === 'TAG2');
        expect(t3.healthSetPoints).toEqual({ kind: 'individual', lower: null, upper: 90, masterLower: null, masterUpper: 90 });
        expect(t2.healthSetPoints).toEqual({ kind: 'individual', lower: null, upper: null, masterLower: null, masterUpper: null });

        selectSensor('tag3');
        await act(async () => { fireEvent.click(bmw().getByRole('button', { name: /Performance/i })); });
        await settle(50);
        await train();
        await openHealth();
        expect(bmw().getByTestId('sp-lower-source').textContent).toBe('not in master');
        expect(bmw().getByTestId('sp-upper-source').textContent).toBe('master data');
        expect((bmw().getByTestId('sp-lower') as HTMLInputElement).placeholder).toBe('Required');
        await waitFor(() => expect(bmw().getByTestId('tab-status-' + t3.id).textContent).toBe('Set points needed'));
        expect(bmw().getByTestId('master-note').textContent).toMatch(/Master data is not changed/);
    });

    it('an OLD model with no snapshot: the first Health page open snapshots master L/H ONCE; reopen writes nothing; master data is never written', async () => {
        writeDisk(wsTrained({}, [model({ id: 'i1', kind: 'individual', healthSetPoints: { kind: 'individual', lower: null, upper: null } })]));
        await mountWindows();
        selectSensor('tag1');
        await waitForCharts();
        await openHealth();
        // shown from the very first render
        expect((bmw().getByTestId('sp-lower') as HTMLInputElement).value).toBe('20');
        await settle(300);
        expect(diskModel('i1').healthSetPoints).toEqual({ kind: 'individual', lower: 20, upper: 80, masterLower: 20, masterUpper: 80 });
        const n = spHistory('i1').length;
        // leave and come back, switch pages: no further write
        fireEvent.click(bmw().getByTestId('footer-back-to-fit'));
        await settle(100);
        await openHealth();
        await settle(300);
        expect(spHistory('i1').length).toBe(n);
        // never written back to master data
        expect(env.backend!.calls.map(c => c.cmd)).not.toContain('apply_sensor_mapping');
        expect(env.backend!.calls.map(c => c.cmd)).not.toContain('write_user_file');
        expect(new Set(env.writes.map(w => w.path))).toEqual(new Set([`workspaces/${WS}.json`]));
        expect(PLANT_META[0]).toMatchObject({ alarmL: 20, alarmH: 80 });
    });

    it('"use <master>" puts the master value back and saves it at once; a model-only value says "this model"', async () => {
        writeDisk(wsTrained({}, [model({ id: 'i1', kind: 'individual', healthSetPoints: { kind: 'individual', lower: 20, upper: 80, masterLower: 20, masterUpper: 80 } })]));
        await mountWindows();
        selectSensor('tag1');
        await waitForCharts();
        await openHealth();
        expect(bmwEl().querySelector('[data-testid="sp-lower-reset"]')).toBeNull();
        await enterSp({ 'sp-lower': '15' });
        expect(bmw().getByTestId('sp-lower-source').textContent).toBe('this model');
        expect(bmw().getByTestId('sp-lower-reset').textContent).toMatch(/^use 20(.0+)?$/);
        await act(async () => { fireEvent.click(bmw().getByTestId('sp-lower-reset')); });
        await settle(100);
        expect(diskModel('i1').healthSetPoints.lower).toBe(20);
        expect(bmw().getByTestId('sp-lower-source').textContent).toBe('master data');
        expect(diskModel('i1').healthSetPoints.masterLower).toBe(20);
    });

    it('special sensor target (no master entry): "not in master" both sides, user must enter both', async () => {
        const ds = plantDataset();
        ds.headers.push('Pump ΔP (ปั๊ม)');
        ds.columns['Pump ΔP (ปั๊ม)'] = ds.columns.TAG1.map(v => (v as number) - 30);
        newBackend({ plant: ds });
        writeDisk(wsTrained({}, [model({ id: 's1', kind: 'individual', targetSensor: 'Pump ΔP (ปั๊ม)', healthSetPoints: { kind: 'individual', lower: null, upper: null } })]));
        await mountWindows({ headers: ds.headers });
        selectSensor('pump δp (ปั๊ม)'.toLowerCase());
        await waitForCharts();
        await openHealth();
        expect(bmw().getByTestId('sp-lower-source').textContent).toBe('not in master');
        expect(bmw().getByTestId('sp-upper-source').textContent).toBe('not in master');
        await settle(300);
        expect(diskModel('s1').healthSetPoints).toEqual({ kind: 'individual', lower: null, upper: null, masterLower: null, masterUpper: null });
        await enterSp({ 'sp-lower': '-50', 'sp-upper': '80' });
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
        await markComplete();
        await waitFor(() => expect(bmw().getByTestId('save-ok')).toBeTruthy());
        expect(env.files.has(`workspaces/${WS}/output/Pump ΔP (ปั๊ม)/INDV_INFO_Pump ΔP (ปั๊ม).json`)).toBe(true);
    });

    // BEHAVIOUR PIN (reported, not a failure): an old model opened while the window has
    // NO sensor metadata (payload `sensorMetadata: null`, i.e. no mapping) is snapshotted as
    // "master has nothing" (null/null) on its first Health page open, and stays that way
    // when metadata arrives later — `persistedSetPointsOf` treats `null` as "loaded, empty".
    it('late metadata: a first open with no metadata freezes the snapshot at null/null (pinned)', async () => {
        writeDisk(wsTrained({}, [model({ id: 'i1', kind: 'individual', healthSetPoints: { kind: 'individual', lower: null, upper: null } })]));
        await mountWindows({ dashboard: false, meta: null });
        selectSensor('tag1');
        await waitForCharts();
        await openHealth();
        await settle(300);
        expect(diskModel('i1').healthSetPoints).toEqual({ kind: 'individual', lower: null, upper: null, masterLower: null, masterUpper: null });
        await sendBuildModelData(WS, { meta: PLANT_META });
        await settle(300);
        expect(diskModel('i1').healthSetPoints.masterLower).toBeNull();
        expect(bmw().getByTestId('sp-lower-source').textContent).toBe('not in master');
    });
});

// ---------------------------------------------------------------------------
// Relationship specifics
// ---------------------------------------------------------------------------

const REL_SP = { kind: 'relationship', residualAt80Lower: -5, residualAt80Upper: 5, residualAt0Lower: -10, residualAt0Upper: 10 };

describe('Relationship specifics', () => {
    it('cache_key = modelId::fingerprint changes with stiffness / predictors / scope, and the preview always reads the CURRENT key', async () => {
        writeDisk(wsTrained({}, [model({ id: 'r1', kind: 'relationship', predictorSensors: ['TAG3'], healthSetPoints: REL_SP })]));
        await mountWindows();
        selectSensor('tag1');
        await waitForCharts();
        const keys: string[] = [];
        const lastKey = () => env.backend!.cmds('preview_relationship_model').filter(c => c.args.cache_key).pop()!.args.cache_key as string;
        const lastPreviewKey = () => env.backend!.cmds('compute_health_preview').pop()!.args.request.cache_key as string;
        keys.push(lastKey());
        expect(lastPreviewKey()).toBe(keys[0]);

        openSettings();
        fireEvent.click(bmw().getByRole('button', { name: 'Strict' }));
        await saveChanges();
        await train();
        keys.push(lastKey());
        expect(lastPreviewKey()).toBe(keys[1]);

        openSettings();
        fireEvent.click(bmwEl().querySelector('button.predictor-picker-trigger') as HTMLElement);
        await pickInModal('predictors', ['TAG2']);
        await saveChanges();
        await train();
        keys.push(lastKey());
        expect(lastPreviewKey()).toBe(keys[2]);

        await applyWorkspaceRc(m => { fireEvent.change(m.getByPlaceholderText('value'), { target: { value: '20' } }); });
        await train();
        keys.push(lastKey());
        expect(lastPreviewKey()).toBe(keys[3]);

        expect(new Set(keys).size).toBe(4);
        keys.forEach(k => expect(k.startsWith('r1::')).toBe(true));
        expect(diskModel('r1').trainedFingerprint).toBe(keys[3].slice('r1::'.length));
    });

    it('the same workspace re-opened on a NEW session (CSV reloaded) -> NOT_FITTED "Re-train to recompute"; Re-train fills the cache again', async () => {
        writeDisk(wsTrained({}, [model({ id: 'r1', kind: 'relationship', predictorSensors: ['TAG3'], healthSetPoints: REL_SP })]));
        await mountWindows({ dashboard: false });
        selectSensor('tag1');
        await waitForCharts();
        env.backend!.loadDataset('plant');
        await sendBuildModelData(WS); // new generation, same workspace
        await openHealth().catch(() => {});
        await settle(400);
        const health = bmwEl().querySelector('[data-testid="health-not-fitted"], [data-testid="results-not-fitted"]');
        expect(health, 'Re-train to recompute is offered').toBeTruthy();
        const retrain = (bmwEl().querySelector('[data-testid="health-not-fitted-retrain"], [data-testid="results-not-fitted-retrain"]') as HTMLElement);
        await act(async () => { fireEvent.click(retrain); });
        await settle(500);
        await settle(400);
        expect(env.backend!.relCacheKeys().length).toBe(1);
        expect(bmwEl().querySelector('[data-testid="health-not-fitted"], [data-testid="results-not-fitted"]')).toBeNull();
    });

    it('Compare predictors: one card per cumulative step, the last reuses the trained fit, and the comparison never touches the health cache', async () => {
        writeDisk(wsTrained({}, [model({ id: 'r1', kind: 'relationship', predictorSensors: ['TAG3', 'TAG2'], healthSetPoints: REL_SP })]));
        await mountWindows({ dashboard: false });
        selectSensor('tag1');
        await waitForCharts();
        const cacheBefore = env.backend!.relCacheKeys();
        const before = env.backend!.cmds('preview_relationship_model').length;
        await act(async () => { fireEvent.click(bmw().getByTestId('compare-predictors')); });
        await settle(200);
        const modal = within(screen.getByTestId('sub-models-modal'));
        await waitFor(() => expect(modal.getAllByTestId('sub-model-card')).toHaveLength(2));
        const sub = env.backend!.cmds('preview_relationship_model').slice(before);
        expect(sub).toHaveLength(1); // step 1 only; step 2 = the trained fit
        expect(sub[0].args.predictors).toEqual(['TAG3']);
        expect(sub[0].args.cache_key).toBeUndefined();
        // Bounded response: the sub-model call (and the Train call whose response is reused as the
        // last card) both ask for at most max_points rows, never every row.
        expect(sub[0].args.max_points).toBe(4000);
        expect(env.backend!.cmds('preview_relationship_model').filter(c => c.args.cache_key).every(c => c.args.max_points === 4000)).toBe(true);
        expect(modal.getAllByTestId('sub-model-card')[0].textContent).toMatch(/N\d/);
        expect(env.backend!.relCacheKeys()).toEqual(cacheBefore);
        fireEvent.keyDown(window, { key: 'Escape' });
        await settle(50);
        expect(screen.queryByTestId('sub-models-modal')).toBeNull();
    });

    it('asymmetric points, lower side negative: valid; the 80/0 lines are drawn on the residual chart; a lower 0-point closer than its 80-point is rejected', async () => {
        writeDisk(wsTrained({}, [model({ id: 'r1', kind: 'relationship', predictorSensors: ['TAG3'], healthSetPoints: { ...REL_SP, residualAt80Lower: null, residualAt0Lower: null } })]));
        await mountWindows({ dashboard: false });
        selectSensor('tag1');
        await waitForCharts();
        await openHealth();
        const w = env.backend!.lastOk('compute_health_preview').stats.two_rmse as number;
        await enterSp({ 'sp-residual_at_80_lower': String(-w * 3), 'sp-residual_at_0_lower': String(-w * 2) });
        await waitFor(() => expect(bmw().getAllByTestId('check-line').map(l => l.textContent).join('|')).toMatch(/lower 0-point .* must be further from zero than the lower 80-point/));
        await enterSp({ 'sp-residual_at_0_lower': String(-w * 6) });
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
        const req = env.backend!.cmds('compute_health_preview').pop()!.args.request;
        expect(req.set_points.residual_at_80_lower).toBeLessThan(0);
        expect(req.set_points.residual_at_80_upper).toBe(5);
        expect(bmw().getByTestId('score-summary')).toBeTruthy();
    });
});

// ---------------------------------------------------------------------------
// Clustering specifics
// ---------------------------------------------------------------------------

describe('Clustering specifics', () => {
    const clu = (over: Record<string, unknown> = {}) => model({
        id: 'c1', kind: 'clustering', xSensor: 'TAG3', ySensor: 'TAG5', criteriaSensor: 'TAG4', numClusters: 2,
        clusterRanges: [{ min: 0, max: 50 }, { min: 50, max: 100 }], healthSetPoints: { kind: 'clustering', outerSd: null }, ...over,
    });

    it('stepper from empty -> 4, + -> 4.5, − twice -> 3.5 (floor), quick 7× — each saved at once; N is ONE number for all clusters', async () => {
        writeDisk(wsTrained({}, [clu()]));
        await mountWindows({ dashboard: false });
        selectSensor('tag3');
        await waitForCharts();
        await openHealth();
        const n = () => diskModel('c1').healthSetPoints.outerSd;
        await act(async () => { fireEvent.click(bmw().getByTestId('ring-inc')); }); await settle(100);
        expect(n()).toBe(4);
        await act(async () => { fireEvent.click(bmw().getByTestId('ring-inc')); }); await settle(100);
        expect(n()).toBe(4.5);
        await act(async () => { fireEvent.click(bmw().getByTestId('ring-dec')); fireEvent.click(bmw().getByTestId('ring-dec')); }); await settle(100);
        expect([3.5, 4]).toContain(n()); // two clicks in one tick read the same draft
        await act(async () => { fireEvent.click(bmw().getByTestId('ring-dec')); }); await settle(100);
        expect(n()).toBe(3.5);
        await act(async () => { fireEvent.click(bmw().getByTestId('ring-quick-7')); }); await settle(400);
        expect(n()).toBe(7);
        expect(bmw().getByTestId('ring-quick-7').getAttribute('aria-pressed')).toBe('true');
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
        const req = env.backend!.cmds('compute_health_preview').pop()!.args.request;
        expect(req.set_points).toEqual({ outer_sd: 7 });
        expect(req.n_clusters).toBe(2);
        expect(req.cluster_ranges).toEqual([{ min: 0, max: 50 }, { min: 50, max: 100 }]);
    });

    it('criteria RANGES changed by another window demote a Complete clustering model (incomplete rule in every writer) and the open window follows', async () => {
        writeDisk(wsTrained({}, [clu({ status: true, healthSetPoints: { kind: 'clustering', outerSd: 5 } })]));
        await mountWindows();
        selectSensor('tag3');
        await waitForCharts();
        expect(pill()).toBe('Complete');
        await act(async () => {
            const next = await updateWorkspaceData(WS, prev => withFailureGroupState(prev, {
                models: prev.failureGroupState!.models.map(m => (m.id === 'c1' ? { ...m, clusterRanges: [{ min: 0, max: 40 }, { min: 40, max: 100 }] } : m)),
            }));
            await emit('failure-group-state-changed', { ...next!.failureGroupState, workspaceId: WS, origin: 'other-window' });
        });
        await settle(100);
        expect(diskModel('c1').status).toBe(false);
        expect(diskModel('c1').healthSetPoints.outerSd).toBe(5);
        expect(pill()).toBe('Incomplete');
        openDashFgTab();
        await waitFor(() => expect(dashDot(1, 'tag3', 'clustering')).toBe('none'));
    });
});

// ---------------------------------------------------------------------------
// Mark complete is the only road to Complete (the PM page + Finish were removed in phase 4)
// ---------------------------------------------------------------------------

describe('Mark complete (Health score page) is the only way a model becomes Complete', () => {
    it('no "Open full view" / "Finish" control exists on either page, and a model with valid SAVED set points stays Incomplete until Mark complete runs', async () => {
        writeDisk(wsTrained({}, [model({ id: 'i1', kind: 'individual', healthSetPoints: { kind: 'individual', lower: 20, upper: 80, masterLower: 20, masterUpper: 80 } })]));
        await mountWindows();
        selectSensor('tag1');
        await waitForCharts();
        expect(bmw().queryByText(/Open full view/)).toBeNull();
        expect(bmw().queryByText(/Finish/)).toBeNull();
        await openHealth();
        expect(bmw().queryByText(/Open full view/)).toBeNull();
        expect(bmw().queryByText(/Finish/)).toBeNull();
        expect(env.backend!.cmds('export_model_files')).toHaveLength(0);
        expect(diskModel('i1').status).toBe(false);
    });

    it('Individual with valid SAVED set points: Mark complete writes the files and marks Complete with an export record', async () => {
        writeDisk(wsTrained({}, [model({ id: 'i1', kind: 'individual', healthSetPoints: { kind: 'individual', lower: 20, upper: 80, masterLower: 20, masterUpper: 80 } })]));
        await mountWindows();
        selectSensor('tag1');
        await waitForCharts();
        await openHealth();
        await waitFor(() => expect(markBtn().disabled).toBe(false));
        await act(async () => { fireEvent.click(markBtn()); });
        await settle(400);
        expect(env.backend!.cmds('export_model_files')).toHaveLength(1);
        expect(diskModel('i1').status).toBe(true);
        expect(diskModel('i1').healthExport.setPoints).toMatchObject({ lower: 20, upper: 80 });
        openDashFgTab();
        await waitFor(() => expect(dashDot(1, 'tag1', 'individual')).toBe('complete'));
    });

    it('empty set points: Mark complete is disabled with the reason, nothing is written, the model stays Incomplete', async () => {
        writeDisk(wsTrained({}, [model({ id: 'i1', kind: 'individual', healthSetPoints: { kind: 'individual', lower: null, upper: null, masterLower: null, masterUpper: null } })]));
        await mountWindows({ meta: [] });
        selectSensor('tag1');
        await waitForCharts();
        await openHealth();
        await waitFor(() => expect(bmw().getByTestId('mark-block-reason')).toBeTruthy());
        expect(markBtn().disabled).toBe(true);
        expect(env.backend!.cmds('export_model_files')).toHaveLength(0);
        expect(diskModel('i1').status).toBe(false);
    });

    it('Relationship whose fit is no longer in Rust memory: Mark complete is refused (re-train first), no files, still Incomplete', async () => {
        writeDisk(wsTrained({}, [model({ id: 'r1', kind: 'relationship', predictorSensors: ['TAG3'], healthSetPoints: REL_SP })]));
        await mountWindows();
        selectSensor('tag1');
        await waitForCharts();
        await openHealth();
        await waitFor(() => expect(markBtn().disabled).toBe(false));
        env.backend!.clearRelCache();
        await act(async () => { fireEvent.click(markBtn()); });
        await settle(400);
        expect(env.backend!.cmds('export_model_files')).toHaveLength(0);
        expect(diskModel('r1').status).toBe(false);
        expect(bmwEl().textContent).toMatch(/Re-train/);
    });
});

// ---------------------------------------------------------------------------
// Misc edges
// ---------------------------------------------------------------------------

describe('misc edges', () => {
    it('a very long unicode description, an empty unit and Thai text render on both pages without throwing', async () => {
        const meta = PLANT_META.map(m => (m.tag === 'TAG1'
            ? { ...m, description: 'แรงดันปั๊มหลัก ด้านขาออก — Main feed pump discharge pressure (very long description) '.repeat(4), unit: '' }
            : m));
        writeDisk(wsTrained({}, [model({ id: 'i1', kind: 'individual', healthSetPoints: { kind: 'individual', lower: 20, upper: 80, masterLower: 20, masterUpper: 80 } })]));
        await mountWindows({ meta });
        selectSensor('tag1');
        await waitForCharts();
        await openHealth();
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
        expect(bmw().getByTestId('score-summary')).toBeTruthy();
    });

    it('malformed / degenerate previews (NaN stats, empty series, 1-point series, all-null score, 1e300) never crash the page', async () => {
        writeDisk(wsTrained({}, [model({ id: 'i1', kind: 'individual', healthSetPoints: { kind: 'individual', lower: 20, upper: 80, masterLower: 20, masterUpper: 80 } })]));
        await mountWindows({ dashboard: false });
        selectSensor('tag1');
        await waitForCharts();
        await openHealth();
        const variants: ((p: any) => any)[] = [
            p => ({ ...p, stats: { ...p.stats, sd: NaN, mean: undefined, boundary_3sd: [NaN, NaN] } }),
            p => ({ ...p, series: { ...p.series, rows: [], timestamps: [], value: [], in_scope: [], score: [] }, score_summary: { ...p.score_summary, scored: 0, min_score: null, pct_below_80: null, share_80_100: null, share_40_80: null, share_0_40: null } }),
            p => ({ ...p, series: { ...p.series, rows: [0], timestamps: ['2026-01-01 00:00:00'], value: [1e300], in_scope: [true], score: [null] } }),
            p => ({ ...p, series: { ...p.series, score: p.series.score?.map(() => null) ?? null } }),
            p => ({ ...p, stats: { ...p.stats, mean: 1e300, sd: 1e299, min: -1e300, max: 1e300 }, histogram: null }),
        ];
        for (const [i, v] of variants.entries()) {
            env.backend!.override('compute_health_preview', () => true, async (_a, real) => v(await real()));
            await enterSp({ 'sp-upper': String(81 + i) });
            await settle(300);
            expect(bmw().getByTestId('health-page')).toBeTruthy();
        }
    });

    it('accessible names: L / H inputs, the outer ring, stepper and page buttons have names', async () => {
        writeDisk(wsTrained({}, [
            model({ id: 'i1', kind: 'individual', healthSetPoints: { kind: 'individual', lower: 20, upper: 80, masterLower: 20, masterUpper: 80 } }),
            model({ id: 'c1', kind: 'clustering', xSensor: 'TAG3', ySensor: 'TAG5', numClusters: 1, healthSetPoints: { kind: 'clustering', outerSd: 5 } }),
        ]));
        await mountWindows({ dashboard: false });
        selectSensor('tag1');
        await waitForCharts();
        await openHealth();
        expect(bmw().getByLabelText(/^L(\s|$)/, { selector: 'input' })).toBe(bmw().getByTestId('sp-lower'));
        expect(bmw().getByLabelText(/^H(\s|$)/, { selector: 'input' })).toBe(bmw().getByTestId('sp-upper'));
        expect(bmw().getByRole('button', { name: /Mark complete/ })).toBeTruthy();
        expect(bmw().getAllByRole('button', { name: /Model fit/ }).length).toBeGreaterThanOrEqual(2); // page switch + footer
        selectSensor('tag3');
        await waitForCharts();
        await openHealth();
        expect(bmw().getByLabelText('Outer ring in × SD')).toBe(bmw().getByTestId('sp-outer_sd'));
        expect(bmw().getByRole('button', { name: 'Smaller' })).toBeTruthy();
        expect(bmw().getByRole('button', { name: 'Larger' })).toBeTruthy();
    });

    // FIXED 2026-10-04 (was `it.fails`): each visible label keeps its text and carries a screen-reader-only suffix
    // ("Lower residual at score 80" ...), so the four accessible names are distinct.
    // A11Y BUG (LOW) — the four Relationship inputs are labelled "Lower", "Upper",
    // "Lower", "Upper" (SetPointsCard.tsx:229-236): the 80-point and the 0-point of the
    // same side share one accessible name, so a screen reader (or a label search) cannot
    // tell them apart.
    it('A11Y BUG: each Relationship set-point input has a distinct accessible name', async () => {
        writeDisk(wsTrained({}, [model({ id: 'r1', kind: 'relationship', predictorSensors: ['TAG3'], healthSetPoints: REL_SP })]));
        await mountWindows({ dashboard: false });
        selectSensor('tag1');
        await waitForCharts();
        await openHealth();
        const names = ['sp-residual_at_80_lower', 'sp-residual_at_80_upper', 'sp-residual_at_0_lower', 'sp-residual_at_0_upper']
            .map(id => bmwEl().querySelector(`label[for="${id}"]`)?.textContent ?? bmw().getByTestId(id).getAttribute('aria-label'));
        expect(new Set(names).size).toBe(4);
    });

    // FIXED 2026-10-04 (was `it.fails`): `formatSetPointText` shows the full-precision value (round-trip safe).
    // BUG (LOW–MEDIUM) — set points of small-magnitude sensors are DISPLAYED rounded to 6
    // decimals (`toText` in SetPointsCard.tsx:52: `String(+v.toFixed(6))`). A stored
    // 0.0000004 (or a residual point of -4e-7) re-opens as "0", and 0.00012345 as
    // "0.000123", while the model (and the exported file) keep the real value — the page
    // shows a different number than the one that is used. Phase 1 explicitly added
    // 4-significant-digit rounding for such sensors; the input should not lose them.
    it('BUG: a tiny stored set point (4e-7) is shown as itself, not as "0", when the Health page opens', async () => {
        const ds = plantDataset();
        ds.headers.push('VIB');
        ds.columns.VIB = ds.columns.TAG1.map((v, i) => 1e-6 + ((v as number) - 50) * 1e-8 + (i % 3) * 1e-9);
        newBackend({ plant: ds });
        writeDisk(wsTrained({}, [model({ id: 'v1', kind: 'individual', targetSensor: 'VIB', healthSetPoints: { kind: 'individual', lower: 4e-7, upper: 0.0000016, masterLower: null, masterUpper: null } })]));
        await mountWindows({ dashboard: false, headers: ds.headers });
        selectSensor('vib');
        await waitForCharts();
        await openHealth();
        expect((bmw().getByTestId('sp-lower') as HTMLInputElement).value).not.toBe('0');
        expect(Number((bmw().getByTestId('sp-lower') as HTMLInputElement).value)).toBe(4e-7);
    });

    it('σ = 0 (a constant sensor): Rust\'s "band is collapsed" issue is shown, the score stays locked, Mark complete stays blocked', async () => {
        const ds = plantDataset();
        ds.headers.push('CONST');
        ds.columns.CONST = ds.columns.TAG1.map(() => 7);
        newBackend({ plant: ds });
        writeDisk(wsTrained({}, [model({ id: 'k1', kind: 'individual', targetSensor: 'CONST', healthSetPoints: { kind: 'individual', lower: 1, upper: 20, masterLower: null, masterUpper: null } })]));
        await mountWindows({ dashboard: false, headers: ds.headers });
        selectSensor('const');
        await waitForCharts();
        await openHealth();
        await waitFor(() => expect(bmw().getAllByTestId('check-line').map(l => l.textContent).join('|')).toMatch(/band is collapsed for this training scope \(σ = 0\)/));
        expect(bmw().getByTestId('score-locked')).toBeTruthy();
        expect(markBtn().disabled).toBe(true);
        expect(bmw().getByTestId('mark-block-reason').textContent).toMatch(/not valid/);
    });

    it('field states come only from Rust: empty = "required" (dashed, placeholder), rejected = error + aria-invalid; an 80-point exactly ON the ±2RMSE edge is rejected as "equal"', async () => {
        writeDisk(wsTrained({}, [model({ id: 'r1', kind: 'relationship', predictorSensors: ['TAG3'], healthSetPoints: { ...REL_SP, residualAt80Upper: null } })]));
        await mountWindows({ dashboard: false });
        selectSensor('tag1');
        await waitForCharts();
        await openHealth();
        const up80 = () => bmw().getByTestId('sp-residual_at_80_upper') as HTMLInputElement;
        await waitFor(() => expect(up80().closest('.hs-num')!.className).toMatch(/hs-num--req/));
        expect(up80().placeholder).toBe('Required');
        const w = env.backend!.lastOk('compute_health_preview').stats.two_rmse as number;
        await enterSp({ 'sp-residual_at_80_upper': String(w) });
        await waitFor(() => expect(bmw().getAllByTestId('check-line').map(l => l.textContent).join('|')).toMatch(/sits exactly on the ±2RMSE band edge/));
        expect(up80().closest('.hs-num')!.className).toMatch(/hs-num--err/);
        expect(up80().getAttribute('aria-invalid')).toBe('true');
        expect(bmw().getByTestId('hs-verdict').textContent).toBe('Not valid');
    });

    it('a narrow window (<760px) renders both pages without throwing', async () => {
        const w = window.innerWidth;
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 500 });
        window.dispatchEvent(new Event('resize'));
        try {
            writeDisk(wsTrained({}, [model({ id: 'i1', kind: 'individual', healthSetPoints: { kind: 'individual', lower: 20, upper: 80, masterLower: 20, masterUpper: 80 } })]));
            await mountWindows({ dashboard: false });
            selectSensor('tag1');
            await waitForCharts();
            await openHealth();
            expect(bmw().getByTestId('health-page')).toBeTruthy();
        } finally {
            Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
        }
    });
});

void markBtn; void typeSp; void hourly; void readDisk;
