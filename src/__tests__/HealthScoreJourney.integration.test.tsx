import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';

/*
 * Health score QA sweep (2026-10-04) — the FULL user journey per model kind,
 * with the REAL Dashboard and the REAL Build Model window (and its real Model
 * fit / Health score pages, SetPointsCard, ChecksCard) on ONE in-memory
 * workspace file, ONE event bus, and a fake Rust backend that implements the
 * real health contract (`helpers/fakeHealthRust.ts`): validation codes and
 * messages, scores, generation guard, the Relationship fit cache, the export.
 *
 * Dashboard (FG sheet creates the model) -> Build Model -> Running condition
 * Apply -> settings -> Train -> Model fit -> Health score -> set points ->
 * Checks / score chart -> Mark complete -> files -> Dashboard dot green ->
 * Mark incomplete -> reopen -> "close and reopen the app" (re-hydrate from disk).
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
import {
    WS, bmw, bmwDot, bmwEl, chartsWithSeries, dash, dashDot, diskModel, enterSp,
    markBtn, markComplete, mountWindows, newBackend, openDashFgTab, openDashSensorTab, openHealth, openSettings,
    pickInModal, pill, readDisk, restartApp, selectSensor, settle, train, writeDisk, wsState,
} from './helpers/healthWorkbench';

vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
    resetEnv();
    newBackend();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** Dashboard Sensor tab -> 📁 of `tag` -> the FG sheet's `<kind> · FG-A` cell. */
async function createViaSheet(tag: string, kindLabel: 'Individual' | 'Relationship' | 'Clustering') {
    openDashSensorTab();
    fireEvent.change(dash().getByPlaceholderText('Search sensors...'), { target: { value: tag } });
    await settle();
    const row = (screen.getByTestId('dashboard-window').querySelector(`#sensor-${tag}`) as HTMLElement).closest('.sensor-list-row') as HTMLElement;
    const btn = within(row).getByTitle('Add to failure group');
    fireEvent.click(btn);
    const sheet = within(await screen.findByTestId('fg-sheet'));
    await act(async () => { fireEvent.click(sheet.getByRole('button', { name: `${kindLabel} · FG-A` })); });
    await settle(400);
    // close the sheet, clear the search
    if (screen.queryByTestId('fg-sheet')) fireEvent.click(btn);
    fireEvent.change(dash().getByPlaceholderText('Search sensors...'), { target: { value: '' } });
    await settle(50);
}

describe('Individual: the whole journey', () => {
    it('FG sheet -> Train -> Model fit -> Health score -> Mark complete -> dot green -> Mark incomplete -> reopen -> re-hydrate', async () => {
        writeDisk(wsState({ models: [] }));
        await mountWindows();

        // 1) Dashboard creates the model through the FG sheet: master L/H snapshot seeded.
        await createViaSheet('TAG1', 'Individual');
        const created = readDisk().failureGroupState.models;
        expect(created).toHaveLength(1);
        const id = created[0].id;
        expect(created[0].healthSetPoints).toEqual({ kind: 'individual', lower: 20, upper: 80, masterLower: 20, masterUpper: 80 });

        // 2) Build Model sees it (broadcast): pick category, train.
        await waitFor(() => expect(bmw().getByTestId('sensor-list-row-fg:1-tag1')).toBeTruthy());
        selectSensor('tag1');
        await act(async () => { fireEvent.click(bmw().getByRole('button', { name: /Performance/i })); });
        await settle(50);
        await train();
        expect(pill()).toBe('Trained');
        expect(env.backend!.cmds('compute_sensor_stats').some(c => c.args.sensor === 'TAG1' && c.args.filter?.value_filters?.[0]?.sensor === 'TAG2')).toBe(true);

        // 3) Model fit page (Individual): value-over-time + distribution + stats card; no residual chart.
        await waitFor(() => expect(bmw().getByTestId('model-fit-individual')).toBeTruthy());
        expect(bmw().getByTestId('stats-card')).toBeTruthy();
        expect(bmw().getByTestId('stat-rows').textContent).toBe('49');
        expect(bmwEl().querySelector('[data-testid="model-fit-relationship"]')).toBeNull();

        // 4) Health score page: master prefill is valid -> score unlocked, Checks green.
        await openHealth();
        expect((bmw().getByTestId('sp-lower') as HTMLInputElement).value).toBe('20');
        expect((bmw().getByTestId('sp-upper') as HTMLInputElement).value).toBe('80');
        expect(bmw().getByTestId('sp-lower-source').textContent).toBe('master data');
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
        expect(bmwEl().querySelector('[data-testid="score-locked"]')).toBeNull();
        expect(bmw().getByTestId('score-summary').textContent).toMatch(/Lowest/);

        // invalid: L inside the 3SD band -> Rust's message in Checks, score locked.
        const band = env.backend!.individualBand('TAG1', { timestamp_ranges: [], value_filters: [{ sensor: 'TAG2', operation: 'greater_than', value1: 10, value2: null }], combine: 'and' });
        await enterSp({ 'sp-lower': String(band.l3 + 0.5) });
        await waitFor(() => expect(bmw().getAllByTestId('check-line').map(l => l.textContent).join('|')).toMatch(/must be below the lower 3σ boundary/));
        expect(bmw().getByTestId('score-locked')).toBeTruthy();
        expect(markBtn().disabled).toBe(true);
        expect(bmw().getByTestId('sp-lower-source').textContent).toBe('this model');

        // equal to the 3SD boundary -> its own message
        await enterSp({ 'sp-lower': String(band.l3) });
        await waitFor(() => expect(bmw().getAllByTestId('check-line').map(l => l.textContent).join('|')).toMatch(/equals the lower 3σ boundary/));

        // empty -> "required" (amber), Mark complete says "still empty"
        await enterSp({ 'sp-lower': '' });
        await waitFor(() => expect(bmw().getByTestId('mark-block-reason').textContent).toMatch(/1 set point still empty/));

        // back to master via "use 20"
        await act(async () => { fireEvent.click(bmw().getByTestId('sp-lower-reset')); });
        await settle(350);
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());

        // 5) Mark complete -> files written, path shown, status Complete on disk.
        await markComplete();
        await waitFor(() => expect(bmw().getByTestId('save-ok')).toBeTruthy());
        expect(bmw().getByTestId('save-ok').textContent).toContain(`workspaces/${WS}/output`);
        expect(env.files.has(`workspaces/${WS}/output/TAG1/INDV_INFO_TAG1.json`)).toBe(true);
        const info = JSON.parse(env.files.get(`workspaces/${WS}/output/TAG1/INDV_INFO_TAG1.json`)!);
        expect(info.model_metrics.setpoint_health_score).toEqual([20, 80]);
        let m = diskModel(id);
        expect(m.status).toBe(true);
        expect(m.healthExport.setPoints).toMatchObject({ lower: 20, upper: 80 });
        expect(m.healthExport.outputDir).toBe(env.backend!.outputDir(WS));
        expect(pill()).toBe('Complete');

        // Dashboard dot green; Build Model dot green.
        openDashFgTab();
        await waitFor(() => expect(dashDot(1, 'tag1', 'individual')).toBe('complete'));
        expect(bmwDot(id).state).toBe('complete');

        // 6) Mark incomplete keeps set points + export record.
        await act(async () => { fireEvent.click(bmw().getByTestId('mark-incomplete')); });
        await settle(50);
        m = diskModel(id);
        expect(m.status).toBe(false);
        expect(m.healthSetPoints).toMatchObject({ lower: 20, upper: 80 });
        expect(m.healthExport).toBeTruthy();
        await waitFor(() => expect(dashDot(1, 'tag1', 'individual')).toBe('trained'));

        // Mark complete again, then "close and reopen the app": both windows re-hydrate from disk.
        await markComplete();
        await waitFor(() => expect(diskModel(id).status).toBe(true));
        await restartApp();
        selectSensor('tag1');
        await settle(400);
        expect(pill()).toBe('Complete');
        openDashFgTab();
        expect(dashDot(1, 'tag1', 'individual')).toBe('complete');
        await openHealth();
        expect((bmw().getByTestId('sp-lower') as HTMLInputElement).value).toBe('20');
        // The export record survives the restart: the page says where the files are.
        expect(bmw().getByTestId('save-ok').textContent).toContain(`workspaces/${WS}/output`);
        expect(bmw().getByTestId('mark-incomplete')).toBeTruthy();
    });
});

describe('Relationship: the whole journey', () => {
    it('FG sheet -> predictors -> Train (cache_key) -> Model fit -> 4 set points -> Mark complete (sidecar) -> restart re-fills the cache', async () => {
        writeDisk(wsState({ models: [] }));
        await mountWindows();
        await createViaSheet('TAG1', 'Relationship');
        const id = readDisk().failureGroupState.models[0].id;
        expect(readDisk().failureGroupState.models[0].healthSetPoints).toEqual({
            kind: 'relationship', residualAt80Lower: null, residualAt80Upper: null, residualAt0Lower: null, residualAt0Upper: null,
        });
        await waitFor(() => expect(bmw().getByTestId('sensor-list-row-fg:1-tag1')).toBeTruthy());
        selectSensor('tag1');
        await act(async () => { fireEvent.click(bmw().getByRole('button', { name: /Performance/i })); });
        await settle(50);
        openSettings();
        fireEvent.click(bmwEl().querySelector('button.predictor-picker-trigger') as HTMLElement);
        await pickInModal('predictors', ['TAG3']);
        await train();
        expect(pill()).toBe('Trained');

        // Train asked Rust to cache the fit under modelId::fingerprint; the health preview reads that key.
        const pr = env.backend!.cmds('preview_relationship_model').pop()!;
        expect(pr.args.cache_key).toBe(`${id}::${diskModel(id).trainedFingerprint}`);
        expect(pr.args.max_points).toBe(4000);
        const hp = env.backend!.cmds('compute_health_preview').filter(c => c.args.request.kind === 'relationship').pop()!;
        expect(hp.args.request.cache_key).toBe(pr.args.cache_key);
        expect(hp.error).toBeUndefined();

        // Model fit: stats strip, Fit scatter (+ X selector + Compare predictors), residual over time; NO residual distribution.
        await waitFor(() => expect(bmw().getByTestId('model-fit-relationship')).toBeTruthy());
        expect(bmw().getByTestId('rel-stats')).toBeTruthy();
        expect(bmw().getByTestId('fit-x-selector')).toBeTruthy();
        expect(bmw().getByTestId('compare-predictors')).toBeTruthy();
        const names = env.charts.flatMap(c => ((c.option?.series ?? []) as any[]).map(x => String(x?.name ?? '')));
        expect(names.some(n => /residual/i.test(n))).toBe(true);
        expect(names.some(n => /distribution|histogram/i.test(n))).toBe(false);

        // Health score: 4 empty points collapse into ONE Checks line.
        await openHealth();
        await waitFor(() => expect(bmw().getAllByTestId('check-line').map(l => l.textContent).join('|')).toMatch(/Enter 4 empty points: lower 80, upper 80, lower 0, upper 0/));
        expect(bmw().getAllByTestId('check-line')).toHaveLength(1);
        expect(bmw().getByTestId('score-locked')).toBeTruthy();

        const w = env.backend!.lastOk('compute_health_preview').stats.two_rmse as number;
        // signs: a positive LOWER point is rejected with Rust's message
        await enterSp({ 'sp-residual_at_80_lower': String(w * 2), 'sp-residual_at_80_upper': String(w * 2), 'sp-residual_at_0_lower': String(-w * 4), 'sp-residual_at_0_upper': String(w * 4) });
        await waitFor(() => expect(bmw().getAllByTestId('check-line').map(l => l.textContent).join('|')).toMatch(/lower 80-point must be negative/));
        // inside the ±2RMSE band
        await enterSp({ 'sp-residual_at_80_lower': String(-w / 2) });
        await waitFor(() => expect(bmw().getAllByTestId('check-line').map(l => l.textContent).join('|')).toMatch(/further from zero than the ±2RMSE band edge/));
        // asymmetric valid points
        await enterSp({ 'sp-residual_at_80_lower': String(-w * 1.5) });
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
        expect(bmwEl().querySelector('[data-testid="score-locked"]')).toBeNull();

        // Mark complete: the export re-runs the sidecar; held -> progress + disabled.
        const gate = env.backend!.gate('sidecar:export_model_files');
        await act(async () => { fireEvent.click(markBtn()); });
        await settle(30);
        expect(bmw().getByTestId('save-running').textContent).toMatch(/about 15 seconds/);
        expect(markBtn().disabled).toBe(true);
        expect(markBtn().textContent).toBe('Saving…');
        gate.release();
        await settle(50);
        await waitFor(() => expect(bmw().getByTestId('save-ok')).toBeTruthy());
        expect(bmw().getByTestId('save-ok').textContent).toMatch(/Saved 3 files/);
        const exp = env.backend!.cmds('export_model_files').pop()!;
        expect(exp.args.request.cache_key).toBe(pr.args.cache_key);
        expect(exp.args.request.lambda).toBe(100_000);
        expect(diskModel(id).status).toBe(true);
        expect([...env.files.keys()].filter(k => k.startsWith(`workspaces/${WS}/output/TAG1/REL_`)).sort()).toEqual([
            `workspaces/${WS}/output/TAG1/REL_DATASET_TAG3_TAG1.csv`,
            `workspaces/${WS}/output/TAG1/REL_INFO_TAG3_TAG1.json`,
            `workspaces/${WS}/output/TAG1/REL_MODEL_TAG3_TAG1.pkl`,
        ]);
        openDashFgTab();
        await waitFor(() => expect(dashDot(1, 'tag1', 'relationship')).toBe('complete'));

        // Restart: a new Rust session has no fit; opening the Complete model re-fits in the background
        // (persistMeta:false — nothing written, still Complete) and the Health page works again.
        await restartApp();
        selectSensor('tag1');
        await settle(400);
        await settle(400);
        expect(pill()).toBe('Complete');
        expect(env.backend!.relCacheKeys()).toContain(pr.args.cache_key);
        await openHealth();
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
        expect(diskModel(id).status).toBe(true);
    });
});

describe('Clustering: the whole journey', () => {
    it('FG sheet (X) -> Y + criteria + 2 clusters -> Train -> Model fit -> N rings for every cluster -> Mark complete -> CLUS_INFO with N for every cluster', async () => {
        writeDisk(wsState({ models: [] }));
        await mountWindows();
        await createViaSheet('TAG3', 'Clustering');
        const id = readDisk().failureGroupState.models[0].id;
        expect(readDisk().failureGroupState.models[0].healthSetPoints).toEqual({ kind: 'clustering', outerSd: null });
        await waitFor(() => expect(bmw().getByTestId('sensor-list-row-fg:1-tag3')).toBeTruthy());
        selectSensor('tag3');
        await act(async () => { fireEvent.click(bmw().getByRole('button', { name: /Performance/i })); });
        await settle(50);
        openSettings();
        fireEvent.click(bmwEl().querySelectorAll('button.sensor-picker-trigger-single')[0]);
        await pickInModal('Y sensor', ['TAG5'], true);
        openSettings(); // the section collapses by itself once nothing is missing
        fireEvent.click(bmwEl().querySelectorAll('button.sensor-picker-trigger-single')[1]);
        await pickInModal('criteria sensor', ['TAG4'], true);
        await settle(100);
        openSettings();
        fireEvent.click(bmw().getByRole('button', { name: 'Fewer clusters' }));
        await settle(100);
        await train();
        expect(pill()).toBe('Trained');
        const m0 = diskModel(id);
        expect(m0.numClusters).toBe(2);
        expect(m0.clusterRanges).toHaveLength(2);

        await waitFor(() => expect(bmw().getByTestId('model-fit-clustering')).toBeTruthy());
        expect(bmw().getByTestId('cluster-row-1')).toBeTruthy();
        expect(bmw().getByTestId('cluster-row-2')).toBeTruthy();

        await openHealth();
        // N = 3 -> "can't equal 3× SD"; 2.5 -> "must be more than 3× SD"
        await enterSp({ 'sp-outer_sd': '3' });
        await waitFor(() => expect(bmw().getAllByTestId('check-line').map(l => l.textContent).join('|')).toMatch(/can't equal 3× SD/));
        await enterSp({ 'sp-outer_sd': '2.5' });
        await waitFor(() => expect(bmw().getAllByTestId('check-line').map(l => l.textContent).join('|')).toMatch(/must be more than 3× SD/));
        // stepper: − never goes below 3.5, and is saved at once
        await act(async () => { fireEvent.click(bmw().getByTestId('ring-dec')); });
        await settle(350);
        expect((bmw().getByTestId('sp-outer_sd') as HTMLInputElement).value).toBe('3.5');
        expect(diskModel(id).healthSetPoints.outerSd).toBe(3.5);
        // quick button 5× -> valid; rings for EVERY cluster
        await act(async () => { fireEvent.click(bmw().getByTestId('ring-quick-5')); });
        await settle(350);
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
        expect(chartsWithSeries('Cluster 1 5× SD').length).toBeGreaterThan(0);
        expect(chartsWithSeries('Cluster 2 5× SD').length).toBeGreaterThan(0);
        expect(chartsWithSeries('Cluster 2 1× SD').length).toBeGreaterThan(0);
        expect(chartsWithSeries('Cluster 2 3× SD').length).toBeGreaterThan(0);

        await markComplete();
        await waitFor(() => expect(bmw().getByTestId('save-ok')).toBeTruthy());
        const info = JSON.parse(env.files.get(`workspaces/${WS}/output/TAG5/CLUS_INFO_TAG3_TAG5.json`)!);
        expect(Object.keys(info.cluster_info)).toEqual(['1', '2']);
        expect(info.cluster_info['1'].boundary_sd_health_score).toBe(5);
        expect(info.cluster_info['2'].boundary_sd_health_score).toBe(5);
        expect(diskModel(id).status).toBe(true);
        expect(diskModel(id).healthSetPoints).toEqual({ kind: 'clustering', outerSd: 5 });
        openDashFgTab();
        await waitFor(() => expect(dashDot(1, 'tag3', 'clustering')).toBe('complete'));
    });
});
