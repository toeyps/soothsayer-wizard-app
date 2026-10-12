import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';

/*
 * Spec:
 * docs/design/handoff/workbench-redesign/README.md §4 "NOT_FITTED" and the
 * "Load it again" (a Complete model stays Complete).
 *
 * The Relation-model fit Rust held is gone. Seen across BOTH windows on one
 * in-memory workspace file (real Dashboard, real Build Model window, real
 * `workspaceManager`, the fake Rust health backend with its fit cache):
 *
 *   (a) a COMPLETE model: both pages show the "Fit no longer in memory" board with
 *       "Load it again" (never "Train sensor ↑": that cannot train a Complete
 *       model) -> loaded -> still Complete, NOTHING written to the workspace
 *       file, the Dashboard dot never moved;
 *   (b) `export_model_files` itself answers NOT_FITTED on Mark complete -> the
 *       board, "Load it again" -> Mark complete succeeds;
 *   (c) the Add Sensor window replaces a special sensor while Build Model is open
 *       (Rust drops every cached fit; the Dashboard writes the new recipe and
 *       broadcasts `recipesChanged`): the tab words, the list dot and the Dashboard
 *       dot stay in step the whole way.
 *
 * `HealthScoreDraftsAndRaces` covers a TRAINED (not Complete) model that loses its
 * fit twice; `BuildModelWindow.test.tsx` pins the boards with `workspaceManager`
 * mocked. Neither has the Dashboard next to it nor checks the file.
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

import { emit } from '@tauri-apps/api/event';
import { env, resetEnv } from './helpers/healthEnv';
import { PLANT_META, plantDataset } from './helpers/fakeHealthRust';
import {
    WS, bmw, bmwDot, bmwEl, dashDot, diskModel, enterSp, markBtn, model, mountWindows, newBackend,
    openDashFgTab, openHealth, readDisk, selectKindTab, selectSensor, settle, waitForCharts, writeDisk, wsFile, wsTrained,
} from './helpers/healthWorkbench';

vi.setConfig({ testTimeout: 60_000 });

beforeEach(() => {
    resetEnv();
    newBackend();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const REL_SP = { kind: 'relationship', residualAt80Lower: -5, residualAt80Upper: 5, residualAt0Lower: -10, residualAt0Upper: 10 };
const IND_SP = { kind: 'individual', lower: 20, upper: 80, masterLower: 20, masterUpper: 80 };
/** An export record as THIS build writes it (`scoringIntervalSecs`: the saved results use 1-hour averages).
 *  A record without it gets the footer's "earlier row-by-row scoring" hint — covered in BuildModelWindow.test.tsx. */
const record = (sp: unknown) => ({ at: '2026-10-02T10:00:00.000Z', outputDir: env.backend!.outputDir(WS), setPoints: sp, scoringIntervalSecs: 3600 });
const FIT_GONE_ERROR = 'NOT_FITTED: this Relation model has no fit in memory (not trained yet, or the data changed) - train it first';

const fits = () => env.backend!.cmds('preview_relationship_model').filter(c => c.args.cache_key).length;
/** Every write of the workspace file so far. */
const wsWrites = () => env.writes.filter(w => w.path === wsFile()).length;
const footer = () => bmw().getByTestId('wb-footer');
const sentence = () => (footer().querySelector('.wbx-reason') as HTMLElement).textContent;
const footPill = () => bmw().getByTestId('footer-pill').textContent;
const tabWords = (id: string) => bmw().getByTestId(`tab-status-${id}`).getAttribute('title');
const tabDot = (id: string) => bmw().getByTestId(`tab-status-${id}`).getAttribute('data-dot');
const filled = () => Array.from(bmwEl().querySelectorAll<HTMLElement>('.rcx-btn--pri, .rcx-btn--danger, .f4-btn-save, .bmw-btn-ok'))
    .filter(b => !b.classList.contains('tq-split-caret') && !b.closest('[role="dialog"]'))
    .map(b => b.getAttribute('data-testid'));
const buttonsOf = (el: HTMLElement) => Array.from(el.querySelectorAll('button')).map(b => b.getAttribute('data-testid'));

describe('(a) a COMPLETE Relation model whose fit Rust no longer holds', () => {
    it('both pages: "Fit no longer in memory" + "Load it again" (no Train sensor link) → loaded → still Complete, nothing written to the workspace file, the Dashboard dot never moved', async () => {
        writeDisk(wsTrained({}, [
            model({ id: 'r1', kind: 'relationship', predictorSensors: ['TAG3'], status: true, healthVerdict: 'valid', healthSetPoints: REL_SP, healthExport: record(REL_SP) }),
        ]));
        // Rust has no fit for it however often it is fitted again (it is dropped each time).
        env.backend!.failOn('compute_health_preview', a => a.request?.kind === 'relationship', FIT_GONE_ERROR, false);
        await mountWindows();
        openDashFgTab();
        selectSensor('tag1');

        // Model fit page: the board (after the ONE silent re-fit the window tries by itself)
        await waitFor(() => expect(bmw().getByTestId('results-not-fitted')).toBeTruthy(), { timeout: 5000 });
        await settle(500);
        const tried = fits();
        await settle(500);
        expect(fits(), 'no re-fit loop').toBe(tried);
        const board = () => bmw().getByTestId('results-not-fitted');
        expect(board().querySelector('.wbx-msg-t')!.textContent).toBe('Fit no longer in memory');
        // a Complete model is never trained by Train sensor: the board offers only "Load it again"
        expect(buttonsOf(board())).toEqual(['board-load-fit']);
        expect(bmw().getByTestId('board-load-fit').textContent).toBe('Load it again');
        expect(board().textContent).not.toMatch(/Re-train|Train sensor/);
        // status said once, and it still says Complete
        expect(footPill()).toBe('Complete');
        expect(sentence()).toBe('Fit no longer in memory · load it again');
        expect(buttonsOf(footer().querySelector('.wbx-reason') as HTMLElement)).toEqual(['footer-load-fit']);
        expect(tabWords('r1')).toBe('Complete · Fit no longer in memory');
        // ...and every dot is still the Complete one, in both windows
        expect(tabDot('r1')).toBe('complete');
        expect(bmwDot('r1')).toEqual({ state: 'complete', colour: 'complete' });
        expect(dashDot(1, 'tag1', 'relationship')).toBe('complete');
        // no filled button offers to train a model Train sensor would not train
        expect(filled()).toEqual([]);
        expect(bmw().getByTestId('train-sensor').textContent).toBe('▶ Train sensor');
        expect(diskModel('r1').status).toBe(true);

        // Health score page: the same board, the same sentence
        fireEvent.click(bmw().getByTestId('next-health-score'));
        await waitFor(() => expect(bmw().getByTestId('health-not-fitted')).toBeTruthy());
        const hboard = bmw().getByTestId('health-not-fitted');
        expect(hboard.querySelector('.wbx-msg-t')!.textContent).toBe('Fit no longer in memory');
        expect(buttonsOf(hboard)).toEqual(['health-load-fit']);
        expect(hboard.textContent).toMatch(/Your set points are kept and scored again when it is loaded\.$/);
        expect(bmw().queryByTestId('health-not-fitted-retrain')).toBeNull();
        expect(footPill()).toBe('Complete');
        expect(sentence()).toBe('Fit no longer in memory · load it again');
        expect(bmw().getByTestId('mark-incomplete')).toBeTruthy();
        expect(bmw().queryByTestId('mark-complete')).toBeNull();
        expect(filled()).toEqual([]);

        // "Load it again": ONE fit of the same model; nothing about the model is written
        const before = { file: env.files.get(wsFile()), writes: wsWrites(), fits: fits(), trainedAt: diskModel('r1').lastTrainedAt };
        env.backend!.clearFaults(); // the fit stays in memory this time
        await act(async () => { fireEvent.click(bmw().getByTestId('health-load-fit')); });
        await settle(400);
        await settle(400);
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
        expect(fits()).toBe(before.fits + 1);
        expect(bmw().queryByTestId('health-not-fitted')).toBeNull();
        await settle(400); // any late write (verdict, train stamp) would land by now
        expect(wsWrites(), 'the workspace file was not written').toBe(before.writes);
        expect(env.files.get(wsFile())).toBe(before.file);
        expect(diskModel('r1')).toMatchObject({ status: true, lastTrainedAt: before.trainedAt, healthSetPoints: REL_SP });
        // back to a plain Complete model everywhere
        expect(footPill()).toBe('Complete');
        expect(sentence()).toMatch(/^Files saved \d{4}\/\d{2}\/\d{2} \d{2}:\d{2} · /);
        expect(tabWords('r1')).toBe('Complete');
        expect(tabDot('r1')).toBe('complete');
        expect(bmwDot('r1').colour).toBe('complete');
        expect(dashDot(1, 'tag1', 'relationship')).toBe('complete');
        expect(filled()).toEqual([]);
        // the Model fit page has its charts back too
        fireEvent.click(bmw().getByTestId('footer-back-to-fit'));
        await waitForCharts();
        expect(bmw().queryByTestId('results-not-fitted')).toBeNull();
        expect(bmw().getByTestId('model-fit-relationship')).toBeTruthy();
    });
});

describe('(b) Mark complete answered NOT_FITTED by export_model_files', () => {
    it('nothing is written and the model stays Trained; the board appears; "Load it again" → Mark complete succeeds', async () => {
        writeDisk(wsTrained({}, [model({ id: 'r1', kind: 'relationship', predictorSensors: ['TAG3'], healthSetPoints: REL_SP })]));
        await mountWindows();
        openDashFgTab();
        selectSensor('tag1');
        await waitForCharts();
        await openHealth();
        await waitFor(() => expect(markBtn().disabled).toBe(false));
        await waitFor(() => expect(dashDot(1, 'tag1', 'relationship')).toBe('trained'));

        // The fit is lost once and silently fitted again: the window's one automatic try is used up.
        env.backend!.clearRelCache();
        await enterSp({ 'sp-residual_at_0_upper': '11' });
        await settle(400);
        await settle(400);
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
        await waitFor(() => expect(markBtn().disabled).toBe(false));
        expect(bmw().queryByTestId('health-not-fitted')).toBeNull();

        // Mark complete: the validating preview still answers, but by the time the files are
        // written Rust has dropped the fit — `export_model_files` answers NOT_FITTED.
        env.backend!.override('export_model_files', a => a.request?.kind === 'relationship', () => {
            env.backend!.clearRelCache();
            throw FIT_GONE_ERROR;
        });
        const fitsBefore = fits();
        await act(async () => { fireEvent.click(markBtn()); });
        await settle(400);
        await settle(400);
        expect(env.backend!.cmds('export_model_files').pop()!.error).toMatch(/^NOT_FITTED/);
        expect(diskModel('r1').status).toBe(false);
        expect(diskModel('r1').healthExport).toBeUndefined();
        expect([...env.files.keys()].some(k => k.includes('/output/'))).toBe(false);
        // the page says what happened, and the board with "Load it again" is there
        expect(bmw().getByTestId('save-error-reason').textContent).toBe('The fitted Relation model was no longer in memory, so its files were not written. Mark complete again once it is loaded.');
        await waitFor(() => expect(bmw().getByTestId('health-not-fitted')).toBeTruthy());
        expect(fits(), 'no second silent re-fit of the same fit').toBe(fitsBefore);
        expect(buttonsOf(bmw().getByTestId('health-not-fitted'))).toEqual(['health-load-fit', 'health-go-train-sensor']);
        expect(markBtn().disabled).toBe(true);
        // the reason that blocks Mark complete comes before "Not saved"
        expect(bmw().getByTestId('mark-block-reason').textContent).toBe('Fit no longer in memory · load it again, or re-train with Train sensor ↑');
        expect(footPill()).toBe('Incomplete');
        expect(tabWords('r1')).toBe('Fit no longer in memory');
        expect(tabDot('r1')).toBe('need');
        expect(bmwDot('r1').colour).toBe('need');
        // it counts as "needs training": Train sensor is the one filled button
        expect(filled()).toEqual(['train-sensor']);
        expect(footer().getAttribute('data-primary')).toBe('train');
        // the Dashboard only knows what is on disk: still trained, never Complete
        expect(dashDot(1, 'tag1', 'relationship')).toBe('trained');

        // "Load it again", then Mark complete works
        const trainedAt = diskModel('r1').lastTrainedAt;
        await act(async () => { fireEvent.click(bmw().getByTestId('health-load-fit')); });
        await settle(400);
        await settle(400);
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
        expect(fits()).toBe(fitsBefore + 1);
        expect(diskModel('r1').lastTrainedAt, 'loaded, not re-trained').toBe(trainedAt);
        // Loaded by the user's own "Load it again": nothing is left to fix, so the refusal's
        // red card and the footer's "Not saved · fix it" are gone — the footer is back on the
        // ordinary sentence of a model whose set points are valid.
        expect(bmw().queryByTestId('save-error')).toBeNull();
        expect(bmw().queryByTestId('save-error-reason')).toBeNull();
        expect(sentence()).toBe('Set points valid — check the score chart, then Mark complete');
        expect(footer().textContent).not.toMatch(/Not saved|fix it/);
        expect(footPill()).toBe('Trained');
        expect(tabWords('r1')).toBe('Trained');
        expect(filled()).toEqual(['mark-complete']);
        await waitFor(() => expect(markBtn().disabled).toBe(false));
        await act(async () => { fireEvent.click(markBtn()); });
        await waitFor(() => expect(diskModel('r1').status).toBe(true));
        await waitFor(() => expect(bmw().getByTestId('save-ok')).toBeTruthy());
        expect(diskModel('r1').healthExport.setPoints).toMatchObject({ residualAt0Upper: 11 });
        expect(env.files.has(`workspaces/${WS}/output/TAG1/REL_INFO_TAG3_TAG1.json`)).toBe(true);
        expect(footPill()).toBe('Complete');
        expect(tabWords('r1')).toBe('Complete');
        expect(filled()).toEqual([]);
        await waitFor(() => expect(dashDot(1, 'tag1', 'relationship')).toBe('complete'));
    });
});

describe('(c) a special sensor is replaced from the Add Sensor window while Build Model is open', () => {
    // The dataset has one special sensor (SP1 = TAG3 * 2) that NO model uses.
    const SP_RECIPE = { kind: 'formula', tag: 'SP1', formula: '$TAG3 * 2' };
    const SP_META = { tag: 'SP1', description: 'Flow doubled', unit: 'm3/h', component: 'Pump' };
    function plantWithSpecial() {
        const d = plantDataset();
        return { ...d, headers: [...d.headers, 'SP1'], columns: { ...d.columns, SP1: d.columns.TAG3.map(v => (v === null ? null : v * 2)) } };
    }
    const META = [...PLANT_META, SP_META];

    /** What the Add Sensor window does when the user saves a new formula for SP1:
     *  Rust replaces the column (and drops EVERY cached Relation-model fit), then the
     *  window tells the Dashboard, which writes the recipe and broadcasts `recipesChanged`. */
    async function replaceSpecialSensor(formula: string) {
        env.backend!.clearRelCache();
        const from = env.emitted.length;
        await act(async () => {
            await emit('update-special-sensor', {
                recipe: { ...SP_RECIPE, formula }, metadata: SP_META, recomputed: ['SP1'],
                workspaceId: WS, generation: env.backend!.generation(),
            });
        });
        await settle(500); // the Dashboard's debounced autosave + its broadcast
        await waitFor(() => expect(readDisk().specialSensorRecipes).toEqual([{ ...SP_RECIPE, formula }]));
        // ...and Build Model was told to read the recipes again (never sent in the payload itself)
        await waitFor(() => expect(env.emitted.slice(from).some(e => e.event === 'failure-group-state-changed'
            && e.payload?.workspaceId === WS && e.payload?.origin === 'dashboard' && e.payload?.recipesChanged === true)).toBe(true));
        expect(env.emitted.slice(from).every(e => !('specialSensorRecipes' in (e.payload ?? {})))).toBe(true);
    }

    it('a Complete Relation model and its Complete Individual sibling: the tab words, the list dots and the Dashboard dots stay in step through two replaces and "Load it again"', async () => {
        const dataset = plantWithSpecial();
        newBackend({ plant: dataset });
        const state = wsTrained({}, [
            model({ id: 'i1', kind: 'individual', status: true, healthVerdict: 'valid', healthSetPoints: IND_SP, healthExport: record(IND_SP) }),
            model({ id: 'r1', kind: 'relationship', predictorSensors: ['TAG3'], status: true, healthVerdict: 'valid', healthSetPoints: REL_SP, healthExport: record(REL_SP) }),
        ]);
        writeDisk({ ...state, specialSensorRecipes: [SP_RECIPE] });
        await mountWindows({ headers: dataset.headers, meta: META });
        openDashFgTab();
        selectSensor('tag1');
        selectKindTab('Relation model');
        await waitForCharts();
        const inStep = (words: string, where: string) => {
            expect(tabWords('r1'), `${where}: Relation model tab`).toBe(words);
            expect(tabDot('r1'), `${where}: Relation model tab dot`).toBe('complete');
            expect(bmwDot('r1').colour, `${where}: list dot`).toBe('complete');
            expect(dashDot(1, 'tag1', 'relationship'), `${where}: Dashboard dot`).toBe('complete');
            // the Individual model has no fit to lose
            expect(tabWords('i1'), `${where}: Individual tab`).toBe('Complete');
            expect(bmwDot('i1').colour).toBe('complete');
            expect(dashDot(1, 'tag1', 'individual')).toBe('complete');
            expect([diskModel('i1').status, diskModel('r1').status], `${where}: both still Complete on disk`).toEqual([true, true]);
        };
        inStep('Complete', 'before');

        // 1st replace: every cached fit is dropped. No model uses SP1, so nothing is demoted.
        const fitsBefore = fits();
        await replaceSpecialSensor('$TAG3 * 3');
        inStep('Complete', 'right after the 1st replace');
        // The next time the page asks Rust (the user comes back to the tab) the fit is loaded again silently.
        selectKindTab('Individual');
        await settle(350);
        selectKindTab('Relation model');
        await settle(400);
        await settle(400);
        await waitForCharts();
        expect(fits()).toBe(fitsBefore + 1);
        expect(bmw().queryByTestId('results-not-fitted')).toBeNull();
        inStep('Complete', 'after the silent re-load');

        // 2nd replace: the same fit is lost again — no loop, the board offers "Load it again".
        await replaceSpecialSensor('$TAG3 * 4');
        selectKindTab('Individual');
        await settle(350);
        inStep('Complete', 'right after the 2nd replace (nothing asked Rust yet)');
        selectKindTab('Relation model');
        await waitFor(() => expect(bmw().getByTestId('results-not-fitted')).toBeTruthy(), { timeout: 5000 });
        await settle(400);
        expect(fits()).toBe(fitsBefore + 1);
        inStep('Complete · Fit no longer in memory', 'fit gone');
        expect(footPill()).toBe('Complete');
        expect(sentence()).toBe('Fit no longer in memory · load it again');
        // The mark stays on the Relation model's tab while the user looks at the other tab.
        selectKindTab('Individual');
        await settle(350);
        inStep('Complete · Fit no longer in memory', 'fit gone, other tab open');
        expect(footPill()).toBe('Complete');

        // "Load it again" brings it back; nothing was ever written about the models.
        selectKindTab('Relation model');
        await waitFor(() => expect(bmw().getByTestId('results-not-fitted')).toBeTruthy());
        const file = env.files.get(wsFile());
        await act(async () => { fireEvent.click(bmw().getByTestId('board-load-fit')); });
        await settle(400);
        await settle(400);
        await waitForCharts();
        expect(fits()).toBe(fitsBefore + 2);
        inStep('Complete', 'loaded again');
        await settle(400);
        expect(env.files.get(wsFile())).toBe(file);
    });
});
