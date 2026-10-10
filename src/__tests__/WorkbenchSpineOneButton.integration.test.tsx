import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

/*
 * Workbench redesign, Phase B close-out (QA, 2026-10-10) — SPEC
 * docs/design/handoff/workbench-redesign/README.md §1 "the page spine".
 *
 * The two rules of the spine, followed through REAL flows on ONE in-memory
 * workspace file with the real Dashboard + the real Build Model window, the real
 * `workspaceManager` and the fake Rust health backend:
 *
 *   1. at most ONE filled button on screen, and it follows the state;
 *   2. a model's status is said in words exactly once (the footer: one pill + one
 *      sentence) — everywhere else it is a dot, and the kind-tab dot, the sensor-list
 *      dot and the Dashboard's Failure Groups dot agree at every step.
 *
 * `BuildModelWindow.test.tsx` ("Workbench redesign §1 — the page spine") pins each
 * state on its own with `workspaceManager` mocked; this file walks from one state
 * to the next the way a user does, so a state that is only wrong when it is
 * REACHED (a stale draft, a verdict not yet saved, a broadcast not yet landed)
 * shows up.
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
import { ALL_TIME_TRAIN, ONE_TEST } from './helpers/trainTestFixture';
import {
    WS, bmw, bmwDot, bmwEl, dashDot, diskModel, enterSp, markBtn, markComplete, model, mountWindows, newBackend,
    openDashFgTab, openHealth, openSettings, readDisk, selectSensor, settle, waitForCharts, writeDisk, wsState,
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

// ── what "the spine" looks like from outside ─────────────────────────────

/** Every FILLED button of the Build Model window (a split button's ▾ half belongs
 *  to its main half; a dialog is not the page). */
const filled = () => Array.from(bmwEl().querySelectorAll<HTMLElement>('.rcx-btn--pri, .rcx-btn--danger, .f4-btn-save, .bmw-btn-ok'))
    .filter(b => !b.classList.contains('tq-split-caret') && !b.closest('[role="dialog"]'))
    .map(b => b.getAttribute('data-testid'));
const footer = () => bmw().getByTestId('wb-footer');
const primary = () => footer().getAttribute('data-primary');
const sentence = () => (footer().querySelector('.wbx-reason') as HTMLElement).textContent ?? '';
const footPill = () => bmw().getByTestId('footer-pill').textContent;
const tabDot = (id: string) => bmw().getByTestId(`tab-status-${id}`);
const tabOf = (id: string) => tabDot(id).closest('[role="tab"]') as HTMLElement;

/** The Dashboard dot that goes with a Build Model dot (both come from `modelDotState`
 *  + `modelSetPointFlag`): the Dashboard draws only what is settled — nothing for a
 *  model that must train (again) or is blocked, blue for "trained, set points valid". */
type Dash = 'none' | 'trained' | 'need' | 'bad' | 'complete';

interface Spine {
    /** `data-primary` of the footer. */
    primary: 'none' | 'save' | 'train' | 'next' | 'mark';
    /** Test ids of every filled button in the window. */
    filled: string[];
    pill: 'Incomplete' | 'Trained' | 'Complete';
    sentence: RegExp | string;
    /** Tooltip words of the kind tab's dot. */
    words: string;
    /** Colour of the tab dot AND of the sensor-list dot. */
    dot: 'none' | 'need' | 'bad' | 'complete';
    dash: Dash;
}

/** One step of a journey: the one-filled-button rule and the said-once rule, for model `id`. */
async function expectSpine(step: string, id: string, key: string, kind: string, want: Spine) {
    const at = (what: string) => `[${step}] ${what}`;
    // (1) at most ONE filled button, and it is the one the state asks for
    await waitFor(() => expect(filled(), at('filled buttons')).toEqual(want.filled));
    expect(filled().length, at('at most one filled button')).toBeLessThanOrEqual(1);
    expect(primary(), at('data-primary')).toBe(want.primary);
    // (2) status in words exactly once: ONE pill and ONE sentence, both in the footer
    const pills = bmwEl().querySelectorAll('.model-status-pill');
    expect(pills.length, at('status pills in the whole window')).toBe(1);
    expect(pills[0].closest('[data-testid="wb-footer"]'), at('the pill is the footer\'s')).not.toBeNull();
    expect(footer().querySelectorAll('.wbx-reason').length, at('sentences in the footer')).toBe(1);
    expect(footPill(), at('footer pill')).toBe(want.pill);
    if (typeof want.sentence === 'string') expect(sentence(), at('footer sentence')).toBe(want.sentence);
    else expect(sentence(), at('footer sentence')).toMatch(want.sentence);
    // ...no status pill on a tab or on the set-point card (a dot with a tooltip)
    for (const tab of bmw().getAllByRole('tab')) expect(tab.querySelector('.f4-pill, .model-status-pill'), at('no pill on a kind tab')).toBeNull();
    expect(bmwEl().querySelector('[data-testid="set-points-card"] .f4-pill, [data-testid="set-points-card"] .model-status-pill'), at('no pill on the set-point card')).toBeNull();
    expect(bmwEl().textContent, at('no "Files saved to" banner / "Step 1"')).not.toMatch(/Files saved to|Step 1\b/);
    // (3) the dots agree: kind tab = sensor list (same colour), Dashboard = the same status
    await waitFor(() => expect(tabDot(id).getAttribute('title'), at('tab words')).toBe(want.words));
    expect(tabDot(id).getAttribute('data-dot'), at('tab dot')).toBe(want.dot);
    expect(tabDot(id).textContent, at('the tab dot carries no text')).toBe('');
    expect(tabOf(id).getAttribute('aria-label'), at('the state is part of the tab name')).toMatch(new RegExp(`, ${want.words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    expect(bmwDot(id).colour, at('sensor-list dot')).toBe(want.dot);
    await waitFor(() => expect(dashDot(1, key, kind), at('Dashboard Failure Groups dot')).toBe(want.dash));
}

const EMPTY_IND = { kind: 'individual', lower: null, upper: null, masterLower: null, masterUpper: null };
const STAMP = String.raw`\d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}`;

/** Closes the Running condition modal that opens by itself when nothing is set. */
function closeRcModal() {
    const dlg = bmw().queryByRole('dialog', { name: 'Running condition' });
    if (dlg) fireEvent.click(within(dlg).getByLabelText('Close'));
}

async function trainSensor() {
    const b = bmw().getByTestId('train-sensor') as HTMLButtonElement;
    expect(b.disabled, `Train sensor disabled: ${b.title}`).toBe(false);
    await act(async () => { fireEvent.click(b); });
    await settle(30);
    await settle(300);
}

describe('ONE filled button + status said once, through a whole Individual journey (Dashboard + Build Model, one workspace file)', () => {
    it('condition unset → set → needs training → training → trained → empty set points → valid → Complete → changed after saving → Mark complete again → a settings draft → saved', async () => {
        // The workspace running condition is NOT set (no condition, "use all rows" not chosen).
        writeDisk(wsState({
            runningConditionFilters: [],
            models: [model({ id: 'i1', kind: 'individual', healthSetPoints: EMPTY_IND })],
        }));
        await mountWindows();
        openDashFgTab();
        closeRcModal();
        selectSensor('tag1');
        await settle(50);

        // 1) unset: the card's own button is the one filled button; nothing in the pane is
        expect(bmw().getByTestId('rc-card').getAttribute('data-state')).toBe('unset');
        expect(bmw().getByTestId('rc-card-open').textContent).toBe('Set running condition →');
        await expectSpine('condition unset', 'i1', 'tag1', 'individual', {
            primary: 'none', filled: ['rc-card-open'], pill: 'Incomplete',
            sentence: /running condition/i, words: 'Needs condition', dot: 'bad', dash: 'none',
        });
        expect((bmw().getByTestId('train-sensor') as HTMLButtonElement).disabled).toBe(true);

        // 2) set it ("Use all rows" + Apply): the card becomes ONE line, Train sensor is the button
        fireEvent.click(bmw().getByTestId('rc-card-open'));
        const modal = within(bmw().getByRole('dialog', { name: 'Running condition' }));
        fireEvent.click(modal.getByTestId('rc-mode-none'));
        await act(async () => { fireEvent.click(modal.getByTestId('rc-apply')); });
        await settle(100);
        expect(readDisk().failureGroupState.runningConditionNoneConfirmed).toBe(true);
        const card = bmw().getByTestId('rc-card');
        expect(card.getAttribute('data-state')).toBe('set');
        expect(card.getAttribute('data-details')).toBe('closed');
        expect(card.className).toContain('rcc-line');
        expect(bmw().getByTestId('rc-card-open').textContent).toBe('Edit');
        await expectSpine('needs training', 'i1', 'tag1', 'individual', {
            primary: 'train', filled: ['train-sensor'], pill: 'Incomplete',
            sentence: 'Not trained yet · Train sensor ↑', words: 'Not trained yet', dot: 'none', dash: 'none',
        });
        expect(bmw().getByTestId('train-sensor').textContent).toBe('▶ Train sensor · 1 of 1');
        expect(bmw().getByTestId('next-health-score').className).toBe('rcx-btn'); // a ghost: training comes first

        // 3) a training run in progress: still at most one filled button, and the footer says it
        const g = env.backend!.gate('compute_sensor_stats', a => a.sensor === 'TAG1');
        await act(async () => { fireEvent.click(bmw().getByTestId('train-sensor')); });
        await settle(50);
        expect(g.entered).toBe(true);
        // (Train sensor stays the one filled button: it reads "Training…" and is disabled)
        expect(filled(), 'filled buttons while training').toEqual(['train-sensor']);
        expect(primary()).toBe('train');
        expect(bmw().getByTestId('train-sensor').textContent).toBe(' Training…');
        expect((bmw().getByTestId('train-sensor') as HTMLButtonElement).disabled).toBe(true);
        expect(bmw().getByTestId('train-sensor-why').textContent).toBe('Training this sensor…');
        expect(bmwEl().querySelectorAll('.model-status-pill')).toHaveLength(1);
        expect(footPill()).toBe('Incomplete');
        expect(sentence()).toMatch(/^ ?Training now · about \d+ s$/);
        expect(bmw().getByTestId('results-loading').querySelector('.wbx-msg-t')!.textContent).toMatch(/^Training the Individual model · about \d+ s$/);
        expect((bmw().getByTestId('next-health-score') as HTMLButtonElement).disabled).toBe(true);
        expect(bmw().queryByTestId('save-changes')).toBeNull();
        expect(dashDot(1, 'tag1', 'individual')).toBe('none');
        await act(async () => { g.release(); });
        await settle(50);
        await settle(350);
        await waitForCharts();

        // 4) trained, set points still empty: "Next: Health score →" is the button
        await expectSpine('trained', 'i1', 'tag1', 'individual', {
            primary: 'next', filled: ['next-health-score'], pill: 'Trained',
            sentence: new RegExp(`^Trained ${STAMP} · scored on 1 period · check the charts, then set the health set points$`),
            words: 'Set points needed', dot: 'need', dash: 'need',
        });
        expect(bmw().getByTestId('train-sensor').className).not.toContain('rcx-btn--pri');
        expect(bmw().getByTestId('train-sensor').textContent).toBe('▶ Train sensor · 0 of 1');

        // 5) Health score, set points empty: Mark complete is THE button (disabled, with the reason)
        await act(async () => { fireEvent.click(bmw().getByTestId('next-health-score')); });
        await settle(300);
        await waitFor(() => expect(bmw().getByTestId('set-points-card')).toBeTruthy());
        await expectSpine('health score, empty set points', 'i1', 'tag1', 'individual', {
            primary: 'mark', filled: ['mark-complete'], pill: 'Trained',
            sentence: '2 set points still empty', words: 'Set points needed', dot: 'need', dash: 'need',
        });
        expect(markBtn().disabled).toBe(true);
        expect(bmw().getByTestId('footer-back-to-fit').className).toContain('f4-btn--plain');

        // 6) valid set points
        await enterSp({ 'sp-lower': '10', 'sp-upper': '90' });
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
        await waitFor(() => expect(diskModel('i1').healthVerdict).toBe('valid'));
        await expectSpine('valid set points', 'i1', 'tag1', 'individual', {
            primary: 'mark', filled: ['mark-complete'], pill: 'Trained',
            sentence: 'Set points valid — check the score chart, then Mark complete',
            words: 'Trained', dot: 'need', dash: 'trained',
        });
        expect(markBtn().className).toBe('bmw-btn-ok');

        // 7) Complete: NO filled button; "Mark incomplete" is a text button; the saved files are the sentence
        await markComplete();
        await waitFor(() => expect(bmw().getByTestId('save-ok')).toBeTruthy());
        await expectSpine('complete', 'i1', 'tag1', 'individual', {
            primary: 'none', filled: [], pill: 'Complete',
            sentence: new RegExp(`^Files saved ${STAMP} · .*workspaces/${WS}/output`), words: 'Complete', dot: 'complete', dash: 'complete',
        });
        expect(bmw().getByTestId('mark-incomplete').className).toContain('f4-btn--plain');
        expect(bmw().getByTestId('mark-incomplete').className).not.toMatch(/rcx-btn--pri|bmw-btn-ok/);
        expect(bmw().queryByTestId('mark-complete')).toBeNull();
        expect(bmw().queryByTestId('mark-complete-again')).toBeNull();
        expect(diskModel('i1').status).toBe(true);

        // 8) a set point changed after saving: "Mark complete again" appears and is the one filled button
        await enterSp({ 'sp-upper': '91' });
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
        await expectSpine('files out of date', 'i1', 'tag1', 'individual', {
            primary: 'mark', filled: ['mark-complete-again'], pill: 'Complete',
            sentence: 'Files out of date — set points changed after saving · Mark complete again to update them',
            words: 'Complete', dot: 'complete', dash: 'complete',
        });
        expect(diskModel('i1').status).toBe(true); // a set point never makes it Incomplete
        await waitFor(() => expect((bmw().getByTestId('mark-complete-again') as HTMLButtonElement).disabled).toBe(false));
        await act(async () => { fireEvent.click(bmw().getByTestId('mark-complete-again')); });
        await settle(100);
        await waitFor(() => expect(diskModel('i1').healthExport.setPoints.upper).toBe(91));
        await expectSpine('complete again', 'i1', 'tag1', 'individual', {
            primary: 'none', filled: [], pill: 'Complete',
            sentence: new RegExp(`^Files saved ${STAMP} · `), words: 'Complete', dot: 'complete', dash: 'complete',
        });

        // 9) back on Model fit a Model-settings draft appears: "Save changes" exists only while it does
        fireEvent.click(bmw().getByTestId('footer-back-to-fit'));
        await settle(100);
        await expectSpine('complete, Model fit', 'i1', 'tag1', 'individual', {
            primary: 'none', filled: [], pill: 'Complete',
            sentence: new RegExp(`^Trained ${STAMP} · scored on 1 period$`), words: 'Complete', dot: 'complete', dash: 'complete',
        });
        expect(bmw().queryByTestId('save-changes')).toBeNull();
        openSettings();
        fireEvent.change(bmw().getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Renamed in QA' } });
        await expectSpine('a settings draft', 'i1', 'tag1', 'individual', {
            primary: 'save', filled: ['save-changes'], pill: 'Complete',
            sentence: 'Unsaved changes to the Individual model', words: 'Complete · unsaved changes', dot: 'complete', dash: 'complete',
        });
        await act(async () => { fireEvent.click(bmw().getByTestId('save-changes')); });
        await settle(100);
        await waitFor(() => expect(bmw().queryByTestId('save-changes')).toBeNull());
        expect(diskModel('i1')).toMatchObject({ name: 'Renamed in QA', status: true }); // a name never makes it Incomplete
        await expectSpine('saved', 'i1', 'tag1', 'individual', {
            primary: 'none', filled: [], pill: 'Complete',
            sentence: new RegExp(`^Trained ${STAMP} · scored on 1 period$`), words: 'Complete', dot: 'complete', dash: 'complete',
        });
    });
});

describe('a Custom-mode model while the WORKSPACE running condition is not set', () => {
    const CUSTOM = {
        runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true,
        filterTimePeriods: ALL_TIME_TRAIN, customTestPeriods: ONE_TEST,
    };

    it('the card keeps the one filled button the whole way; the Custom model still trains, opens Health score and is marked Complete with ghost buttons — and its dots agree in both windows', async () => {
        writeDisk(wsState({
            runningConditionFilters: [],
            models: [
                model({ id: 'i1', kind: 'individual', healthSetPoints: EMPTY_IND }),
                model({ id: 'u1', kind: 'individual', targetSensor: 'TAG5', groupNos: [1], healthSetPoints: EMPTY_IND, ...CUSTOM }),
            ],
        }));
        await mountWindows();
        openDashFgTab();
        closeRcModal();

        // The Workspace-mode model is blocked by the missing condition...
        selectSensor('tag1');
        await settle(50);
        await expectSpine('workspace model, condition unset', 'i1', 'tag1', 'individual', {
            primary: 'none', filled: ['rc-card-open'], pill: 'Incomplete',
            sentence: /running condition/i, words: 'Needs condition', dot: 'bad', dash: 'none',
        });

        // ...the Custom one is not: it can train, but the filled button stays the card's
        selectSensor('tag5');
        await settle(50);
        await expectSpine('custom model, not trained', 'u1', 'tag5', 'individual', {
            primary: 'none', filled: ['rc-card-open'], pill: 'Incomplete',
            sentence: 'Not trained yet · Train sensor ↑', words: 'Not trained yet', dot: 'none', dash: 'none',
        });
        const ts = () => bmw().getByTestId('train-sensor') as HTMLButtonElement;
        expect(ts().textContent).toBe('▶ Train sensor · 1 of 1');
        expect(ts().disabled).toBe(false);
        expect(ts().className).not.toContain('rcx-btn--pri'); // a ghost that works

        await trainSensor();
        await waitForCharts();
        expect(diskModel('u1').lastTrainedAt).toBeTruthy();
        expect(diskModel('i1').lastTrainedAt).toBeUndefined(); // the blocked one was not trained
        // its training scope is its OWN (all rows), never the workspace's
        expect(env.backend!.cmds('compute_sensor_stats').filter(c => c.args.sensor === 'TAG5').pop()!.args.filter ?? null).toBeNull();
        await expectSpine('custom model, trained', 'u1', 'tag5', 'individual', {
            primary: 'none', filled: ['rc-card-open'], pill: 'Trained',
            sentence: new RegExp(`^Trained ${STAMP} · scored on 1 period · check the charts, then set the health set points$`),
            words: 'Set points needed', dot: 'need', dash: 'need',
        });
        const next = bmw().getByTestId('next-health-score') as HTMLButtonElement;
        expect(next.disabled).toBe(false);
        expect(next.className).toBe('rcx-btn');

        await openHealth();
        await enterSp({ 'sp-lower': '0', 'sp-upper': '99' });
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
        await waitFor(() => expect(diskModel('u1').healthVerdict).toBe('valid'));
        await expectSpine('custom model, valid set points', 'u1', 'tag5', 'individual', {
            primary: 'none', filled: ['rc-card-open'], pill: 'Trained',
            sentence: 'Set points valid — check the score chart, then Mark complete', words: 'Trained', dot: 'need', dash: 'trained',
        });
        expect(markBtn().className).toBe('rcx-btn'); // a ghost — and it works
        await markComplete();
        await waitFor(() => expect(diskModel('u1').status).toBe(true));
        await expectSpine('custom model, complete', 'u1', 'tag5', 'individual', {
            primary: 'none', filled: ['rc-card-open'], pill: 'Complete',
            sentence: new RegExp(`^Files saved ${STAMP} · `), words: 'Complete', dot: 'complete', dash: 'complete',
        });
        // the workspace model is exactly where it was
        expect(bmwDot('i1').colour).toBe('bad');
        expect(dashDot(1, 'tag1', 'individual')).toBe('none');
        expect(diskModel('i1').status).toBe(false);
    });
});
