import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { noticeEl, noticeSentence, openTabStatus, openTabWords, primaryAction } from './helpers/workbenchStatus';

/*
 * Spec: docs/design/handoff/workbench-detail-v2/README.md ("Workbench detail pages v2").
 *
 * The v2 shell was built in six separate passes — KPI tiles on Model fit (phase 1), the
 * score ruler (2), the Health score KPI tiles (3a), the stacked chart card (3b), the status
 * words on the kind tabs + the page-tab row (4a), the header state buttons + the notice line
 * (4b). Each pass has its own tests for its own piece:
 *   - `ScoreRuler.test.tsx` / `HealthScorePage.test.tsx`: the ruler marker, the tiles, the
 *     stack card — the PAGE alone, fed a hand-made preview;
 *   - `BuildModelWindow.test.tsx`: tab words, page tabs, state buttons, notice tone — the
 *     WINDOW alone, with `workspaceManager` mocked;
 *   - `WorkbenchSpineOneButton.integration.test.tsx`: the one-filled-button rule through an
 *     Individual journey that only ever types VALID set points.
 *
 * What none of them follows is ONE user action — typing a set point Rust rejects — through
 * EVERY piece at the same moment, for each model kind, with the real Dashboard + the real
 * Build Model window, the real `workspaceManager` and the fake Rust (which validates like
 * `health_score.rs`). SPEC §6 "Wrong values must warn" lists the pieces that must ALL show:
 *
 *     the red tick + input, a red marker on the band labelled as typed, the Checks sentence,
 *     the kind-tab words ("Fix set point"), the red notice line, Mark complete disabled with
 *     the reason under the button — and (§6 KPI strip / lock text) no score anywhere.
 *
 * This file walks, per kind:
 *
 *   not trained (page tab 2 closed with its reason, no "Next") → Train → the Model fit tiles +
 *   tab words → page tab 2 opens → empty set points (amber everywhere) → a REJECTED set point
 *   (red everywhere, as above) → fixed (everything clears, the score appears) → Mark complete
 *   → "Complete" on the tab, "Files saved …" as the notice, no filled button, "Mark
 *   incomplete" as a text button.
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
    WS, applyWorkspaceRc, bmw, bmwDot, bmwEl, dashDot, diskModel, enterSp, markBtn, markComplete, model, mountWindows, newBackend,
    openDashFgTab, openHealth, selectSensor, settle, train, waitForCharts, writeDisk, wsState, wsTrained,
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

// ── reading the v2 shell from outside ───────────────────────────────────────────────────

const q = <T extends HTMLElement = HTMLElement>(sel: string) => bmwEl().querySelector<T>(sel);
const qa = (sel: string) => Array.from(bmwEl().querySelectorAll<HTMLElement>(sel));
const tid = (id: string) => `[data-testid="${id}"]`;

/** The open kind tab's status words element (`data-tone`: plain / need / bad / complete). */
const words = (id: string) => bmw().getByTestId(`tab-words-${id}`);
const tabDot = (id: string) => bmw().getByTestId(`tab-status-${id}`).getAttribute('data-dot');
const healthTab = () => bmw().getByTestId('page-tab-health');
const modelTab = () => bmw().getByTestId('page-tab-model');
/** The reason line under the disabled state button, or null. */
const why = () => q(tid('state-why'));
/** Every filled button of the window (a split button's ▾ half belongs to its main half). */
const filled = () => qa('.rcx-btn--pri, .rcx-btn--danger, .f4-btn-save, .bmw-btn-ok')
    .filter(b => !b.classList.contains('tq-split-caret') && !b.closest('[role="dialog"]'))
    .map(b => b.getAttribute('data-testid'));
const tick = (key: string) => q(`${tid('ruler-tick')}[data-tick="${key}"]`)!;
const markers = () => qa(tid('ruler-marker'));
const kpis = () => bmw().getByTestId('score-summary');
/** The value a tile prints (its first text node: "—" or the number). */
const tileValue = (id: string) => bmw().getByTestId(id).querySelector('.wb3-kpi-v')!.textContent;
const checks = () => qa(tid('check-line')).map(l => l.textContent).join(' | ');
const lastPreview = () => env.backend!.lastOk('compute_health_preview');

/** Nothing of the removed shell is anywhere in the window (SPEC §1, §3, §4, §6). */
function expectNoOldShell(step: string) {
    const gone = [
        'wb-footer', 'footer-pill', 'footer-back-to-fit', 'page-switch',          // footer bar, pill, "← Model fit", header switch
        'stats-card', 'stat-rows', 'stat-2rmse', 'stat-predictors',               // Statistics card / stat row
        'hs-ladder', 'test-results',                                              // set-point table, Scoring results
        'chart-expand-score', 'chart-overlay-score',                              // the two separate chart cards
    ];
    for (const id of gone) expect(q(tid(id)), `[${step}] ${id} must not exist`).toBeNull();
    expect(q('.model-status-pill, .f4-foot'), `[${step}] no status pill / footer bar`).toBeNull();
    expect(q('.bmw-detail')!.textContent, `[${step}] no train date / "scored on N periods"`).not.toMatch(/scored on \d+ period|Trained \d{4}\//);
    expect(qa(tid('wb-notice')).length, `[${step}] at most one notice line`).toBeLessThanOrEqual(1);
    expect(filled().length, `[${step}] at most one filled button`).toBeLessThanOrEqual(1);
}

interface Kind {
    /** Model id on disk, the sensor-list key, and the kind as the Dashboard dot names it. */
    id: string; key: string; kind: 'individual' | 'relationship' | 'clustering';
    seed: Record<string, unknown>;
    /** The Model fit tiles, in order. */
    fitStrip: string; fitTiles: string[]; fitBoard: string;
    /** How many set points start empty. */
    empty: number;
    /** The ruler's user ticks (their `data-tick` = Rust's field). */
    userTicks: string[];
    /** Title of the ONE chart card of the Health score page. */
    stackTitle: string;
    /** Type every set point valid EXCEPT one that Rust rejects; returns that field + what the marker must say. */
    typeWrong: () => Promise<{ field: string; input: string; marker: RegExp; check: RegExp }>;
    /** Correct the rejected one. */
    fix: () => Promise<void>;
    /** A file Mark complete must have written. */
    file: string;
}

const KINDS: Kind[] = [
    {
        id: 'i1', key: 'tag1', kind: 'individual',
        seed: { id: 'i1', kind: 'individual', healthSetPoints: { kind: 'individual', lower: null, upper: null, masterLower: null, masterUpper: null } },
        fitStrip: 'fit-kpis', fitTiles: ['stat-mean', 'stat-sd', 'stat-outside3'], fitBoard: 'model-fit-individual',
        empty: 2, userTicks: ['lower', 'upper'], stackTitle: 'Sensor value and health score',
        typeWrong: async () => {
            const [l3, u3] = lastPreview().stats.boundary_3sd as [number, number];
            // H is fine; L sits INSIDE the ±3SD band (above its lower edge): rejected.
            await enterSp({ 'sp-upper': String(Math.ceil(u3) + 20), 'sp-lower': String(l3 + 0.5) });
            return { field: 'lower', input: 'sp-lower', marker: /^L = /, check: /must be below the lower 3σ boundary/ };
        },
        fix: async () => {
            const [l3] = lastPreview().stats.boundary_3sd as [number, number];
            await enterSp({ 'sp-lower': String(Math.floor(l3) - 20) });
        },
        file: `workspaces/${WS}/output/TAG1/INDV_INFO_TAG1.json`,
    },
    {
        id: 'r1', key: 'tag1', kind: 'relationship',
        seed: {
            id: 'r1', kind: 'relationship', predictorSensors: ['TAG3'],
            healthSetPoints: { kind: 'relationship', residualAt80Lower: null, residualAt80Upper: null, residualAt0Lower: null, residualAt0Upper: null },
        },
        fitStrip: 'rel-stats', fitTiles: ['stat-r2', 'stat-rmse', 'stat-res-sd'], fitBoard: 'model-fit-relationship',
        empty: 4, userTicks: ['residual_at_0_lower', 'residual_at_80_lower', 'residual_at_80_upper', 'residual_at_0_upper'],
        stackTitle: 'Residual and health score',
        typeWrong: async () => {
            const w = lastPreview().stats.two_rmse as number;
            // three valid points; "80 high" has the WRONG SIGN (negative on the high side): rejected.
            await enterSp({
                'sp-residual_at_0_lower': String(-w * 4), 'sp-residual_at_80_lower': String(-w * 1.5),
                'sp-residual_at_0_upper': String(w * 4), 'sp-residual_at_80_upper': String(-w * 2),
            });
            return { field: 'residual_at_80_upper', input: 'sp-residual_at_80_upper', marker: /^80 high = −/, check: /upper 80-point must be positive/ };
        },
        fix: async () => {
            const w = lastPreview().stats.two_rmse as number;
            await enterSp({ 'sp-residual_at_80_upper': String(w * 2) });
        },
        file: `workspaces/${WS}/output/TAG1/REL_INFO_TAG3_TAG1.json`,
    },
    {
        id: 'c1', key: 'tag3', kind: 'clustering',
        seed: {
            id: 'c1', kind: 'clustering', xSensor: 'TAG3', ySensor: 'TAG5', criteriaSensor: 'TAG4', numClusters: 2,
            clusterRanges: [{ min: 0, max: 50 }, { min: 50, max: 100 }], healthSetPoints: { kind: 'clustering', outerSd: null },
        },
        fitStrip: 'cl-stats', fitTiles: ['stat-clusters', 'stat-assigned', 'stat-inside3'], fitBoard: 'model-fit-clustering',
        empty: 1, userTicks: ['outer_sd'], stackTitle: 'Clusters and health score',
        typeWrong: async () => {
            // the outer ring must be MORE than 3× SD: 2.5 is rejected.
            await enterSp({ 'sp-outer_sd': '2.5' });
            return { field: 'outer_sd', input: 'sp-outer_sd', marker: /^N = 2\.5×$/, check: /must be more than 3× SD/ };
        },
        fix: async () => { await enterSp({ 'sp-outer_sd': '5' }); },
        file: `workspaces/${WS}/output/TAG5/CLUS_INFO_TAG3_TAG5.json`,
    },
];

describe('Workbench detail v2 — one model of each kind through the whole new shell (Dashboard + Build Model, one workspace file)', () => {
    it.each(KINDS)('$kind: not trained → Train → tab 2 opens → empty → a REJECTED set point warns everywhere at once → fixed → Mark complete', async (k) => {
        writeDisk(wsState({ models: [model(k.seed)] }));
        await mountWindows();
        openDashFgTab();
        selectSensor(k.key);
        await settle(50);

        // ── 1) not trained: the tab says so in words; page tab 2 is closed WITH its reason ──────────
        expect(words(k.id).textContent).toBe('Not trained yet');
        expect(words(k.id).getAttribute('data-tone')).toBe('plain');
        expect(openTabStatus(bmwEl())).toBe('Incomplete');
        expect(healthTab().getAttribute('aria-disabled')).toBe('true');
        expect((healthTab() as HTMLButtonElement).disabled, 'a closed tab 2 stays focusable (aria-disabled, never disabled)').toBe(false);
        expect(bmw().getByTestId('page-tab-health-why').textContent).toBe('Train the model first');
        expect(modelTab().getAttribute('aria-current')).toBe('page');
        // pressing the closed tab does nothing
        fireEvent.click(healthTab());
        await settle(50);
        expect(modelTab().getAttribute('aria-current')).toBe('page');
        expect(q(tid('set-points-card'))).toBeNull();
        // "Next: Health score →" has no disabled copy; Train sensor is the one filled button; nothing to fix or wait for
        expect(q(tid('next-health-score'))).toBeNull();
        expect(primaryAction(bmwEl())).toBe('train');
        expect(filled()).toEqual(['train-sensor']);
        expect(noticeEl(bmwEl())).toBeNull();
        // a chart-less state has no KPI strip
        expect(q(tid(k.fitStrip))).toBeNull();
        expectNoOldShell('not trained');

        // ── 2) Train → Model fit: the three tiles of this kind above the charts; the tab words change ──
        await train();
        await waitForCharts();
        await waitFor(() => expect(bmw().getByTestId(k.fitBoard)).toBeTruthy());
        expect([...bmw().getByTestId(k.fitStrip).children].map(c => c.getAttribute('data-testid'))).toEqual(k.fitTiles);
        // the strip is the FIRST thing of the board (above every chart card)
        expect(bmw().getByTestId(k.fitBoard).firstElementChild).toBe(bmw().getByTestId(k.fitStrip));
        // tiles never judge: no tone class on a Model fit tile
        for (const t of k.fitTiles) expect(bmw().getByTestId(t).className, t).toBe('wb3-kpi');
        await waitFor(() => expect(words(k.id).textContent).toBe('Set points needed'));
        expect(words(k.id).getAttribute('data-tone')).toBe('need');
        expect(tabDot(k.id)).toBe('need');
        expect(openTabStatus(bmwEl())).toBe('Trained');
        // page tab 2 is open now: no reason, its caption is back; "Next" exists and is THE filled button
        expect(healthTab().getAttribute('aria-disabled')).toBeNull();
        expect(q(tid('page-tab-health-why'))).toBeNull();
        expect(healthTab().textContent).toContain('set points · score · mark complete');
        expect(primaryAction(bmwEl())).toBe('next');
        expect(filled()).toEqual(['next-health-score']);
        expect(noticeEl(bmwEl()), 'trained and up to date: no notice line').toBeNull();
        expect(diskModel(k.id).status).toBe(false);
        expectNoOldShell('trained');

        // ── 3) page tab 2 → Health score: tiles, ruler + Checks, ONE chart card; empty = AMBER everywhere ──
        fireEvent.click(healthTab());
        await settle(300);
        await waitFor(() => expect(bmw().getByTestId('set-points-card')).toBeTruthy());
        expect(healthTab().getAttribute('aria-current')).toBe('page');
        expect(modelTab().getAttribute('aria-current')).toBeNull();
        // the page's order: tiles → the ruler card (Checks inside) → the stacked chart card
        const board = bmw().getByTestId('health-page');
        const order = [...board.children].map(c => c.getAttribute('data-testid')).filter(Boolean);
        expect(order[0]).toBe('score-summary');
        expect(order.indexOf('set-points-card')).toBeLessThan(order.indexOf('chart-card-stack'));
        expect(order.filter(t => /^chart-card-/.test(t!)), 'ONE chart card on the page').toEqual(['chart-card-stack']);
        expect(bmw().getByTestId('set-points-card').contains(bmw().getByTestId('score-ruler'))).toBe(true);
        expect(bmw().getByTestId('set-points-card').contains(bmw().getByTestId('checks-card'))).toBe(true);
        expect(bmw().getByTestId('score-ruler').getAttribute('data-kind')).toBe(k.kind);
        expect(bmw().getByTestId('chart-card-stack').querySelector('.wb2-card-h b')!.textContent).toBe(k.stackTitle);
        expect(bmw().getByTestId('chart-card-stack').contains(bmw().getByTestId(`chart-card-set-${k.kind}`))).toBe(true);
        expect(qa(tid('chart-expand-stack')), 'ONE Expand for both charts').toHaveLength(1);
        // Model settings belong to page 1
        expect(q('.bmw-sets')).toBeNull();
        // empty: every user tick "required", no marker, tiles locked, score area says SET (not fix)
        await waitFor(() => expect(noticeSentence(bmwEl())).toBe(`${k.empty} set point${k.empty > 1 ? 's' : ''} still empty`));
        for (const t of k.userTicks) expect(tick(t).getAttribute('data-state'), `tick ${t}`).toBe('required');
        expect(markers()).toHaveLength(0);
        expect(noticeEl(bmwEl())!.getAttribute('data-tone'), 'an EMPTY set point is a warning (amber)').toBe('warn');
        expect(why()!.textContent).toBe(noticeSentence(bmwEl()));
        expect(why()!.className).toContain('tq-why--warn');
        expect(markBtn().disabled).toBe(true);
        expect(markBtn().closest('.wb3-act')!.contains(why()), 'the reason sits under ITS button').toBe(true);
        expect(markBtn().closest(tid('detail-controls')), 'Mark complete is a header button').not.toBeNull();
        expect(primaryAction(bmwEl())).toBe('mark');
        expect(kpis().getAttribute('data-state')).toBe('locked');
        expect(tileValue('kpi-lowest')).toBe('—');
        expect(tileValue('kpi-below80')).toBe('—');
        expect(bmw().getByTestId('score-locked').getAttribute('data-lock')).toBe('empty');
        expect(bmw().getByTestId('score-locked').textContent).toBe('Set every point on the ruler above — the score appears here');
        expect(q(tid('chart-card-score')), 'no score chart while locked').toBeNull();
        expect(words(k.id).textContent).toBe('Set points needed');
        expectNoOldShell('empty set points');

        // ── 4) a set point Rust REJECTS: red on the ruler, in the Checks, on the tab, in the notice,
        //       under the button — and no score anywhere (SPEC §6 "Wrong values must warn") ──────────
        const wrong = await k.typeWrong();
        await waitFor(() => expect(checks()).toMatch(wrong.check));
        // (a) the ruler: that tick is an error, every other user tick is fine, ONE marker, labelled as typed
        expect(tick(wrong.field).getAttribute('data-state')).toBe('error');
        expect(tick(wrong.field).className).toContain('wb3-ruler-tick--bad');
        for (const t of k.userTicks.filter(t => t !== wrong.field)) expect(tick(t).getAttribute('data-state'), `tick ${t} is valid`).toBeNull();
        expect(markers()).toHaveLength(1);
        expect(markers()[0].getAttribute('data-point')).toBe(wrong.field);
        expect(markers()[0].textContent).toMatch(wrong.marker);
        expect(bmw().getByTestId('ruler-band').contains(markers()[0]), 'the marker label is above the band, its stem on it').toBe(false);
        expect(bmw().getByTestId('score-ruler').contains(markers()[0])).toBe(true);
        // (b) the input: invalid, and described by the Checks (which say why, in words)
        const input = bmw().getByTestId(wrong.input);
        expect(input.getAttribute('aria-invalid')).toBe('true');
        const described = document.getElementById(input.getAttribute('aria-describedby')!)!;
        expect(described.contains(bmw().getByTestId('checks-card'))).toBe(true);
        expect(qa(tid('check-line')).filter(l => l.getAttribute('data-tone') === 'bad')).toHaveLength(1);
        expect(bmw().getByTestId('hs-verdict').getAttribute('data-verdict')).toBe('bad');
        // (c) the kind tab: red dot + "Fix set point" in red
        await waitFor(() => expect(words(k.id).textContent).toBe('Fix set point'));
        expect(words(k.id).getAttribute('data-tone')).toBe('bad');
        expect(tabDot(k.id)).toBe('bad');
        expect(openTabWords(bmwEl())).toBe('Fix set point');
        expect(openTabStatus(bmwEl()), 'still a trained model').toBe('Trained');
        // (d) the notice line: RED (a rejected set point is an error), one sentence
        expect(noticeSentence(bmwEl())).toBe('1 set point not valid — fix before marking complete');
        expect(noticeEl(bmwEl())!.getAttribute('data-tone')).toBe('bad');
        expect(noticeEl(bmwEl())!.getAttribute('role')).toBe('status');
        expect(noticeEl(bmwEl())!.className).toContain('wb3-notice--bad');
        expect(bmw().getByTestId('mark-block-reason').closest(tid('wb-notice'))).not.toBeNull();
        // (e) Mark complete: disabled, the same reason under it, in red — and it is still the ONE filled button
        expect(markBtn().disabled).toBe(true);
        expect(why()!.textContent).toBe('1 set point not valid — fix before marking complete');
        expect(why()!.className).toContain('tq-why--danger');
        expect(markBtn().title).toBe(why()!.textContent);
        expect(filled()).toEqual(['mark-complete']);
        // (f) no score anywhere: tiles "—", the lower half of the card says FIX, no score chart
        expect(kpis().getAttribute('data-state')).toBe('locked');
        expect(tileValue('kpi-lowest')).toBe('—');
        expect(q(tid('score-lowest'))).toBeNull();
        expect(bmw().getByTestId('score-locked').getAttribute('data-lock')).toBe('bad');
        expect(bmw().getByTestId('score-locked').textContent).toBe('Fix the set point on the ruler above — the score appears here');
        expect(q(tid('chart-card-score'))).toBeNull();
        // (g) the verdict is saved with the model: the sensor list and the Dashboard show the same red
        await waitFor(() => expect(diskModel(k.id).healthVerdict).toBe('invalid'));
        expect(bmwDot(k.id).colour).toBe('bad');
        await waitFor(() => expect(dashDot(1, k.key, k.kind)).toBe('bad'));
        expect(diskModel(k.id).status).toBe(false);
        expectNoOldShell('a rejected set point');

        // ── 5) fixed: everything clears at once and the score appears ───────────────────────────
        await k.fix();
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
        expect(markers()).toHaveLength(0);
        for (const t of k.userTicks) expect(tick(t).getAttribute('data-state'), `tick ${t}`).toBeNull();
        expect(bmw().getByTestId(wrong.input).getAttribute('aria-invalid')).toBeNull();
        expect(bmw().getByTestId('hs-verdict').getAttribute('data-verdict')).toBe('valid');
        await waitFor(() => expect(words(k.id).textContent).toBe('Trained'));
        expect(words(k.id).getAttribute('data-tone'), 'a plain "Trained" asks for nothing: neutral').toBe('plain');
        expect(tabDot(k.id)).toBe('need');
        expect(noticeEl(bmwEl()), 'valid set points waiting for Mark complete: no notice line').toBeNull();
        expect(why()).toBeNull();
        await waitFor(() => expect(markBtn().disabled).toBe(false));
        expect(filled()).toEqual(['mark-complete']);
        // the score: tiles ready (the lowest score is a whole number in its band colour), the score chart under the set-point chart
        expect(kpis().getAttribute('data-state')).toBe('ready');
        const lowest = Number(bmw().getByTestId('score-lowest').textContent);
        expect(Number.isInteger(lowest)).toBe(true);
        expect(bmw().getByTestId('kpi-lowest').className).toBe(`wb3-kpi wb3-kpi--${lowest >= 80 ? 'ok' : lowest >= 40 ? 'warn' : 'bad'}`);
        expect(bmw().getByTestId('kpi-below80').className, 'only a SCORE is coloured').toBe('wb3-kpi');
        expect(q(tid('score-locked'))).toBeNull();
        const stack = bmw().getByTestId('chart-stack');
        expect([...stack.children].map(c => c.getAttribute('data-testid'))).toEqual([`chart-card-set-${k.kind}`, 'chart-card-score']);
        await waitFor(() => expect(diskModel(k.id).healthVerdict).toBe('valid'));
        await waitFor(() => expect(dashDot(1, k.key, k.kind)).toBe('trained'));
        expectNoOldShell('valid set points');

        // ── 6) Mark complete: "Complete" on the tab, "Files saved …" as the notice, no filled button ──
        await markComplete();
        await waitFor(() => expect(bmw().getByTestId('save-ok')).toBeTruthy(), { timeout: 8000 });
        expect(env.files.has(k.file), `${k.file} written`).toBe(true);
        expect(diskModel(k.id).status).toBe(true);
        await waitFor(() => expect(words(k.id).textContent).toBe('Complete'));
        expect(words(k.id).getAttribute('data-tone')).toBe('complete');
        expect(tabDot(k.id)).toBe('complete');
        expect(openTabStatus(bmwEl())).toBe('Complete');
        expect(noticeEl(bmwEl())!.getAttribute('data-tone')).toBe('ok');
        expect(noticeSentence(bmwEl())).toMatch(new RegExp(String.raw`^Files saved \d{4}/\d{2}/\d{2} \d{2}:\d{2} · .*workspaces/${WS}/output`));
        expect(primaryAction(bmwEl())).toBe('none');
        expect(filled(), 'a Complete, up-to-date model has no filled button').toEqual([]);
        expect(q(tid('mark-complete'))).toBeNull();
        expect(q(tid('mark-complete-again'))).toBeNull();
        const undo = bmw().getByTestId('mark-incomplete');
        expect(undo.textContent).toBe('Mark incomplete');
        expect(undo.className, '"Mark incomplete" is a text button').toContain('f4-btn--plain');
        expect(undo.closest(tid('detail-controls')), 'in the header').not.toBeNull();
        expect(why()).toBeNull();
        // the score stays on screen, and both windows agree
        expect(kpis().getAttribute('data-state')).toBe('ready');
        expect(bmwDot(k.id).colour).toBe('complete');
        await waitFor(() => expect(dashDot(1, k.key, k.kind)).toBe('complete'));
        expectNoOldShell('complete');

        // ── 7) back on page 1 (page tab 1 — there is no "← Model fit"): nothing to say, nothing filled ──
        await act(async () => { fireEvent.click(modelTab()); });
        await settle(100);
        expect(modelTab().getAttribute('aria-current')).toBe('page');
        expect(noticeEl(bmwEl()), 'a Complete model on Model fit: no notice line').toBeNull();
        expect(filled()).toEqual([]);
        expect(healthTab().getAttribute('aria-disabled')).toBeNull();
        expect(bmw().getByTestId(k.fitStrip)).toBeTruthy();
        expect(words(k.id).textContent).toBe('Complete');
        expectNoOldShell('complete, Model fit');
    });
});

describe('Workbench detail v2 — the Health score page is never shown for a model that must train again (page tab 2 closes under the user)', () => {
    it('on Health score, the workspace running condition changes: the pane falls back to Model fit with tab 2 closed ("Re-train first"); after re-training it is back on Health score with the set points kept', async () => {
        writeDisk(wsTrained({}, [model({ id: 'i1', kind: 'individual', healthSetPoints: { kind: 'individual', lower: 20, upper: 80, masterLower: 20, masterUpper: 80 } })]));
        await mountWindows({ dashboard: false });
        selectSensor('tag1');
        await waitForCharts();
        await openHealth();
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
        expect(healthTab().getAttribute('aria-current')).toBe('page');
        expect(kpis().getAttribute('data-state')).toBe('ready');
        expect(words('i1').textContent).toBe('Trained');
        expect(noticeEl(bmwEl())).toBeNull();

        // another setting of the training scope: every model of the workspace must train again
        await applyWorkspaceRc(m => { fireEvent.change(m.getByPlaceholderText('value'), { target: { value: '30' } }); });
        await settle(100);

        // the page under the user is Model fit now — tab 1 is the open one, tab 2 is closed with its reason
        expect(modelTab().getAttribute('aria-current')).toBe('page');
        expect(healthTab().getAttribute('aria-current')).toBeNull();
        expect(healthTab().getAttribute('aria-disabled')).toBe('true');
        expect(bmw().getByTestId('page-tab-health-why').textContent).toBe('Re-train first');
        expect(q(tid('health-page')), 'no Health score page for a stale model').toBeNull();
        expect(q(tid('set-points-card'))).toBeNull();
        expect(q(tid('score-summary'))).toBeNull();
        // said once in each place: the tab, the banner, the notice line; Train sensor is the one filled button
        expect(words('i1').textContent).toBe('Re-train needed');
        expect(words('i1').getAttribute('data-tone')).toBe('need');
        expect(openTabStatus(bmwEl())).toBe('Incomplete');
        expect(bmw().getByTestId('stale-banner')).toBeTruthy();
        expect(noticeEl(bmwEl())!.getAttribute('data-tone')).toBe('warn');
        expect(noticeSentence(bmwEl())).toBe('Settings or running condition changed · train again with Train sensor ↑');
        expect(q(tid('next-health-score')), 'no disabled copy of Next').toBeNull();
        expect(q(tid('mark-complete')), 'Mark complete belongs to the Health score page').toBeNull();
        expect(filled()).toEqual(['train-sensor']);
        expect(primaryAction(bmwEl())).toBe('train');
        // the Model fit charts are still there, under "Out of date" (the tiles stay)
        expect(qa(tid('chart-outdated')).length).toBeGreaterThan(0);
        expect(bmw().getByTestId('fit-kpis')).toBeTruthy();
        // nothing of the set points was lost by the fallback
        expect(diskModel('i1').healthSetPoints).toMatchObject({ lower: 20, upper: 80 });
        expectNoOldShell('stale on Health score');

        // train again: the model's own page choice (Health score) comes back by itself, set points intact
        await train();
        await settle(300);
        await waitFor(() => expect(bmw().getByTestId('set-points-card')).toBeTruthy());
        expect(healthTab().getAttribute('aria-current')).toBe('page');
        expect(healthTab().getAttribute('aria-disabled')).toBeNull();
        expect((bmw().getByTestId('sp-lower') as HTMLInputElement).value).toBe('20');
        expect((bmw().getByTestId('sp-upper') as HTMLInputElement).value).toBe('80');
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
        expect(words('i1').textContent).toBe('Trained');
        expect(q(tid('stale-banner'))).toBeNull();
        expect(qa(tid('chart-outdated'))).toHaveLength(0);
        expect(noticeEl(bmwEl())).toBeNull();
        expect(filled()).toEqual(['mark-complete']);
        expectNoOldShell('re-trained');
    });
});
