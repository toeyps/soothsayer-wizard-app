import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

/*
 * "Just score it" (spec
 * docs/design/handoff/workbench-redesign/README.md §2).
 *
 * ONE journey across every zone it touches, on a workspace saved BEFORE
 * the change: its scoring periods ("test periods" then) still carry `label`,
 * `eventTime` and `fromHighlight`, on the workspace list AND on a Custom-mode
 * model's own list.
 *
 * REAL here: the Dashboard, the Build Model window with its Model fit / Health
 * score pages, `workspaceManager` (write queue, `applyIncompleteRule`,
 * `withFailureGroupState`) over one in-memory workspace file, and the event bus
 * between the two windows. The Tauri boundary is the fake Rust backend
 * (`helpers/fakeHealthRust.ts`), which REJECTS a `test_periods` item that
 * carries anything but `start` / `end` — so a stale caller fails the invoke.
 *
 * What the pieces are tested for on their own, and is therefore only touched
 * here as part of the journey (not re-tested in depth):
 *   - the card / modal showing plain S1, S2 for a legacy list, and Apply writing
 *     id / start / end only: BuildModelWindow.test.tsx ("a workspace saved
 *     before"), against a MOCKED workspaceManager;
 *   - the neutral tiles' wording: ValidationCards.test.tsx;
 *   - the `testsChangedAt` rule: incompleteRule.test.ts / healthPersist.test.ts;
 *   - the wire shape: healthRequest.test.ts / completeModel.test.ts.
 * What only this file sees: all of them together on the real file — a Complete
 * model of an old workspace survives the upgrade, the legacy keys never reach
 * Rust, ONE edited period demotes exactly the models that use that list (and
 * the other window's dot follows), and Mark complete brings it back.
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
    COND, WS, bmw, bmwDot, bmwEl, dashDot, diskModel, markBtn, markComplete, model, mountWindows, newBackend,
    openDashFgTab, openHealth, pill, readDisk, restartApp, selectSensor, settle, waitForCharts, writeDisk, wsFile, wsTrained,
} from './helpers/healthWorkbench';
import { makeTestResult, makeValidation } from './helpers/validationFixture';
import { ALL_TIME_TRAIN } from './helpers/trainTestFixture';

vi.setConfig({ testTimeout: 30_000 });

// ── the old workspace ────────────────────────────────────────────────────
// The plant dataset is 60 hourly rows from 2026-01-01 00:00 (to 2026-01-03 11:00).

/** Workspace scoring periods exactly as a build before saved them. */
const OLD_WS_TESTS = [
    { id: 'old-1', start: '2026-01-01T12:00', end: '2026-01-01T23:00', label: 'normal' },
    { id: 'old-2', start: '2026-01-02T00:00', end: '2026-01-03T00:00', label: 'problem', eventTime: '2026-01-02T18:00', fromHighlight: 'Bearing failure' },
];
/** The Custom model's OWN list, same old shape. */
const OLD_CUSTOM_TESTS = [
    { id: 'c-old-1', start: '2026-01-02T06:00', end: '2026-01-02T20:00', label: 'problem', eventTime: '2026-01-02T12:00', fromHighlight: 'Seal leak' },
];
const CUSTOM_TRAIN = [{ id: 'ct', start: '2026-01-01T00:00', end: '2026-01-02T00:00' }];
const SP_TAG1 = { kind: 'individual', lower: 20, upper: 80, masterLower: 20, masterUpper: 80 };
const SP_TAG3 = { kind: 'individual', lower: 0, upper: 200, masterLower: null, masterUpper: 90 };
/** An export record as an OLD build wrote it: no `scoringIntervalSecs` — its files were scored row by row. */
const exportRecord = (setPoints: unknown) => ({ at: '2026-10-05T08:00:00.000Z', outputDir: env.backend!.outputDir(WS), setPoints });
const EARLIER_SCORING_HINT = 'Saved results use the earlier row-by-row scoring — Mark complete again to update the files';

/** Everything of the removed feature that must never be shown or sent. */
const REMOVED_UI = /Known problem|Bearing failure|Seal leak|From Highlights?|event time|lead time|Test periods?|detected|false alarm/i;
const REMOVED_WIRE = /"label"|event_time|eventTime|fromHighlight|from_highlight|Bearing failure|Seal leak|"normal"|"problem"|lead_days/;

function oldWorkspace() {
    return wsTrained({ runningConditionTestPeriods: OLD_WS_TESTS }, [
        // Workspace mode, Complete: its scoring periods are the workspace list.
        model({ id: 'i1', kind: 'individual', targetSensor: 'TAG1', status: true, healthSetPoints: SP_TAG1, healthVerdict: 'valid', healthExport: exportRecord(SP_TAG1) }),
        // Custom mode, Complete: its own train period and its own (old-shape) scoring period.
        model({
            id: 'c3', kind: 'individual', targetSensor: 'TAG3', groupNos: [2], status: true,
            runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true,
            filterTimePeriods: CUSTOM_TRAIN, customTestPeriods: OLD_CUSTOM_TESTS,
            healthSetPoints: SP_TAG3, healthVerdict: 'valid', healthExport: exportRecord(SP_TAG3),
        }),
    ]);
}

/**
 * The fake backend does not compute `test_validation` (see its header), so the
 * health preview is answered with one built FROM THE REQUEST'S `test_periods` —
 * one result per item sent, echoing its start / end, in the shape
 * `health_validation.rs` returns (facts only). The request has
 * already passed the fake's own "start / end only" check by then.
 */
// `lowest_at` = the START of the hour with the lowest hourly score, as Rust labels an hour.
const FACTS = [
    { pct_below_80: 0, lowest: 91, lowest_at: '2026-01-01T15:00:00' },
    { pct_below_80: 12.5, lowest: 64, lowest_at: '2026-01-02T15:00:00' },
];
function scoringFor(request: any) {
    const sent: { start: string | null; end: string | null }[] = request?.test_periods ?? [];
    const hours = (p: { start: string | null; end: string | null }) => (Date.parse(`${p.end}:00Z`) - Date.parse(`${p.start}:00Z`)) / 3_600_000 + 1;
    return makeValidation({
        train_ranges: [],
        tests: sent.map((p, i) => makeTestResult({
            index: i + 1, start: p.start!, end: p.end!, rows: hours(p), hours: hours(p), scored: hours(p), days: hours(p) / 24,
            within_3sd_pct: 99, mean_shift_sd: 0.1, ...FACTS[i % FACTS.length],
        })),
    });
}
function answerScoring() {
    env.backend!.override('compute_health_preview', a => Array.isArray(a?.request?.test_periods), async (args, real) => {
        const res = await real() as Record<string, unknown>;
        return { ...res, test_validation: scoringFor(args.request) };
    }, false);
}

const previewsFor = (target: string) => env.backend!.cmds('compute_health_preview').filter(c => c.args.request.target === target);
const lastPreviewFor = (target: string) => previewsFor(target).slice(-1)[0].args.request;
const wsWrites = () => env.writes.filter(w => w.path === wsFile()).length;
const onlyStartEnd = (list: unknown[]) => { for (const t of list) expect(Object.keys(t as object).sort()).toEqual(['end', 'start']); };
/** The scoring chips of the running-condition card (they sit under "Details" — the card is one line once set). */
const chips = () => {
    const details = bmw().getByTestId('rc-card-details');
    if (details.getAttribute('aria-expanded') === 'false') fireEvent.click(details);
    return bmw().getAllByTestId('rc-card-test-chip').map(c => c.textContent ?? '');
};
const tile = (n: number) => bmw().getByTestId(`test-result-${n}`);
/** Names in the strip above the last time chart drawn with `series` (the TRAIN shading — a scoring period is not drawn). */
const stripOf = (series: string): string[] => {
    const chart = env.charts.filter(c => ((c.option?.series ?? []) as any[]).some(s => s?.name === series)).pop();
    const scopes = ((chart?.option?.series ?? []) as any[]).find(s => s?.name === '__scopes');
    return ((scopes?.markArea?.data ?? []) as any[]).filter(a => a[0].label.show).map(a => a[0].label.formatter as string);
};

beforeEach(() => {
    resetEnv();
    newBackend();
    answerScoring();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('a workspace saved before "just score it" (scoring periods with label / eventTime / fromHighlight)', () => {
    it('opens Complete, scores with start / end only, one edited period asks for Mark complete again on exactly the models that use that list, and Mark complete brings it back', async () => {
        writeDisk(oldWorkspace());
        const before = { i1: diskModel('i1'), c3: diskModel('c3') };
        await mountWindows();

        // ── 1) It opens: nothing is migrated, nothing is demoted ────────────────
        // Opening is not an edit: whatever a window wrote while hydrating, the lists and the
        // models are what the file held (no migration - the legacy keys are simply not read).
        expect(readDisk().failureGroupState.runningConditionTestPeriods).toEqual(OLD_WS_TESTS);
        expect(diskModel('c3').customTestPeriods).toEqual(OLD_CUSTOM_TESTS);
        expect(diskModel('i1')).toEqual(before.i1);
        expect(diskModel('c3')).toEqual(before.c3);
        expect(bmw().queryByTestId('tests-changed-notice')).toBeNull();

        // Step-1 card: plain S1 / S2, none of the removed words anywhere in the window.
        expect(chips()).toHaveLength(2);
        expect(chips()[0]).toMatch(/^S1 · 1 Jan 2026 12:00 → 1 Jan 2026 23:00$/);
        expect(chips()[1]).toMatch(/^S2 · 2 Jan 2026 → 3 Jan 2026 00:00$/);
        expect(bmwEl().textContent).not.toMatch(REMOVED_UI);

        // Both models are still Complete - in this window and on the Dashboard.
        selectSensor('tag1');
        await waitForCharts();
        expect(pill()).toBe('Complete');
        expect(bmwDot('i1').state).toBe('complete');
        expect(bmwDot('c3').state).toBe('complete');
        openDashFgTab();
        await waitFor(() => expect(dashDot(1, 'tag1', 'individual')).toBe('complete'));
        expect(dashDot(2, 'tag3', 'individual')).toBe('complete');
        // Model fit: the time chart highlights the TRAIN period only (user decision 2026-10-12) — the two old
        // scoring periods have no band and no name on it. Their plain S1 / S2 numbering is on the Step-1 chips
        // (above) and on the "Scoring results" tiles (below); that both reached Rust is checked in 3).
        // (The "Train and scoring periods" table that also listed them was removed 2026-10-11.)
        await waitFor(() => expect(stripOf('Value')).toEqual(['TRAIN']));
        expect(bmw().queryByTestId('train-test-card')).toBeNull();
        expect(bmw().getByTestId('model-fit-individual').textContent).not.toMatch(REMOVED_UI);

        // ── 2) Health score: neutral tiles, nothing judged ──────────────────────
        await openHealth();
        await waitFor(() => expect(tile(2)).toBeTruthy());
        expect(within(bmw().getByTestId('test-results')).getByText('Scoring results')).toBeTruthy();
        expect(bmw().getByTestId('test-results').textContent).toContain('for reading only — never blocks Mark complete');
        expect(bmw().getByTestId('test-result-1-big').textContent).toBe('0.0% of running hours below 80');
        expect(bmw().getByTestId('test-result-1-lowest').textContent).toBe('Lowest 91 (1 h average) on 1 Jan 2026 15:00.');
        // S2 was "Known problem" with an event time: it reads exactly like S1 - two facts, no verdict, no lead time.
        expect(bmw().getByTestId('test-result-2-big').textContent).toBe('12.5% of running hours below 80');
        expect(bmw().getByTestId('test-result-2-lowest').textContent).toBe('Lowest 64 (1 h average) on 2 Jan 2026 15:00.');
        for (const n of [1, 2]) {
            expect(tile(n).className).toBe('vt-tile'); // no green / amber tone class
            expect(tile(n).textContent).not.toMatch(REMOVED_UI);
        }
        expect(bmw().queryByTestId('scored-pill')).toBeNull(); // the "Scored · N" pill is gone (footer sentence instead)
        // Still Complete. Its files were saved before the health score moved to 1-hour averages (the
        // export record has no scoring interval): the footer says so and offers "Mark complete again" —
        // it is NOT demoted, and nothing is written until the user presses the button (checked below:
        // the model on disk is byte-for-byte what the file held).
        expect(bmw().queryByTestId('tests-changed-banner')).toBeNull();
        expect(pill()).toBe('Complete');
        expect(bmw().getByTestId('earlier-scoring').textContent).toBe(EARLIER_SCORING_HINT);
        expect(bmw().getByTestId('mark-complete-again').className).toBe('bmw-btn-ok');
        expect(bmw().getByTestId('wb-footer').getAttribute('data-primary')).toBe('mark');
        expect(bmw().getByTestId('mark-incomplete')).toBeTruthy();
        expect(env.backend!.cmds('export_model_files')).toHaveLength(0);

        // ── 3) What reached Rust: start / end only ──────────────────────────────
        const WIRE = [
            { start: '2026-01-01T12:00', end: '2026-01-01T23:00' },
            { start: '2026-01-02T00:00', end: '2026-01-03T00:00' },
        ];
        expect(previewsFor('TAG1').length).toBeGreaterThan(0);
        for (const c of previewsFor('TAG1')) { expect(c.args.request.test_periods).toEqual(WIRE); onlyStartEnd(c.args.request.test_periods); }

        // The Custom model sends ITS list - also start / end only - and shows one tile.
        selectSensor('tag3', 2);
        await settle(400);
        expect(pill()).toBe('Complete');
        await waitFor(() => expect(previewsFor('TAG3').length).toBeGreaterThan(0));
        expect(lastPreviewFor('TAG3').test_periods).toEqual([{ start: '2026-01-02T06:00', end: '2026-01-02T20:00' }]);
        if (!bmwEl().querySelector('[data-testid="set-points-card"]')) await openHealth();
        await waitFor(() => expect(tile(1).textContent).toContain('2 Jan 2026 06:00 → 2 Jan 2026 20:00'));
        expect(bmw().queryByTestId('test-result-2')).toBeNull();
        expect(bmw().getByTestId('test-results').textContent).not.toMatch(REMOVED_UI);
        // the Custom model was saved by the same old build: the same hint, still Complete
        expect(bmw().getByTestId('earlier-scoring').textContent).toBe(EARLIER_SCORING_HINT);

        // Not one call of the session carried a legacy key or value, and none was refused.
        expect(JSON.stringify(env.backend!.calls.map(c => c.args))).not.toMatch(REMOVED_WIRE);
        expect(env.backend!.calls.filter(c => c.error).map(c => `${c.cmd}: ${c.error}`)).toEqual([]);
        // Looking at an old workspace changed neither model.
        expect(diskModel('i1')).toEqual(before.i1);
        expect(diskModel('c3')).toEqual(before.c3);

        // ── 4) Edit ONE workspace scoring period -> Apply ───────────────────────
        selectSensor('tag1');
        await settle(400);
        const writesBeforeApply = wsWrites();
        fireEvent.click(bmw().getByTestId('rc-card-open'));
        const modal = within(bmw().getByRole('dialog', { name: 'Running condition' }));
        // Merely opening the modal on a legacy list is not an edit.
        expect((modal.getByTestId('rc-apply') as HTMLButtonElement).disabled).toBe(true);
        expect(bmw().getByRole('dialog', { name: 'Running condition' }).textContent).not.toMatch(REMOVED_UI);
        const end = modal.getByLabelText('Scoring period 2 end');
        await act(async () => { fireEvent.change(end, { target: { value: '2026-01-02T20:00' } }); fireEvent.blur(end); });
        expect((modal.getByTestId('rc-apply') as HTMLButtonElement).disabled).toBe(false);
        await act(async () => { fireEvent.click(modal.getByTestId('rc-apply')); });
        await waitFor(() => expect(wsWrites()).toBeGreaterThan(writesBeforeApply));
        await settle(50);

        // The saved list: id / start / end and nothing else - on BOTH periods, the untouched one too.
        const saved = readDisk().failureGroupState;
        expect(saved.runningConditionTestPeriods).toEqual([
            { id: 'old-1', start: '2026-01-01T12:00', end: '2026-01-01T23:00' },
            { id: 'old-2', start: '2026-01-02T00:00', end: '2026-01-02T20:00' },
        ]);
        expect(JSON.stringify(saved.runningConditionTestPeriods)).not.toMatch(REMOVED_WIRE);
        // Train periods and the condition were not part of the edit.
        expect(saved.runningConditionTimePeriods).toEqual(ALL_TIME_TRAIN);
        expect(saved.runningConditionFilters).toEqual([COND]);

        // The Workspace-mode model: Incomplete + stamped, but NOT re-trained and nothing else lost.
        const i1 = diskModel('i1');
        expect(i1.status).toBe(false);
        expect(i1.testsChangedAt).toBeTruthy();
        expect(i1.lastTrainedAt).toBe(before.i1.lastTrainedAt);
        expect(i1.trainedFingerprint).toBe(before.i1.trainedFingerprint);
        expect(i1.healthSetPoints).toEqual(SP_TAG1);
        expect(i1.healthExport).toEqual(before.i1.healthExport);
        expect(i1.healthVerdict).toBe('valid');
        // The Custom model does not use the workspace list: untouched, still Complete.
        expect(diskModel('c3')).toEqual(before.c3);

        // Both windows say so.
        expect(bmw().getByTestId('tests-changed-notice').textContent)
            .toBe('Scoring periods changed — 1 complete model needs Mark complete again. It was re-scored with the same trained model, not re-trained.');
        expect(chips()[1]).toBe('S2 · 2 Jan 2026 → 2 Jan 2026 20:00');
        expect(pill()).not.toBe('Complete');
        expect(bmwDot('i1').state).not.toBe('complete');
        expect(bmwDot('i1').state).not.toBe('stale'); // still trained: no Re-train asked
        expect(bmwDot('c3').state).toBe('complete');
        await waitFor(() => expect(dashDot(1, 'tag1', 'individual')).toBe('trained'));
        expect(dashDot(2, 'tag3', 'individual')).toBe('complete');
        // Train is not asked for: the Health score page stays open to the model.
        expect((bmw().getByTestId('page-health') as HTMLButtonElement).disabled).toBe(false);

        // ── 5) Mark complete again ──────────────────────────────────────────────
        if (!bmwEl().querySelector('[data-testid="set-points-card"]')) await openHealth();
        await waitFor(() => expect(bmw().getByTestId('tests-changed-banner').getAttribute('data-state')).toBe('changed'));
        const NEW_WIRE = [WIRE[0], { start: '2026-01-02T00:00', end: '2026-01-02T20:00' }];
        await waitFor(() => expect(lastPreviewFor('TAG1').test_periods).toEqual(NEW_WIRE));
        await waitFor(() => expect(tile(2).textContent).toContain('2 Jan 2026 → 2 Jan 2026 20:00'));
        // The scoring results never block it.
        const exportsBefore = env.backend!.cmds('export_model_files').length;
        expect(markBtn().textContent).toContain('Mark complete');
        await markComplete();
        await waitFor(() => expect(diskModel('i1').status).toBe(true));
        const done = diskModel('i1');
        expect(done.testsChangedAt).toBeUndefined();
        expect(done.lastTrainedAt).toBe(before.i1.lastTrainedAt); // Mark complete is not a re-train
        expect(done.healthExport.at).not.toBe(before.i1.healthExport.at);
        expect(done.healthExport.setPoints).toEqual(SP_TAG1);
        // The new record says how the saved results were scored: 1-hour averages.
        expect(before.i1.healthExport.scoringIntervalSecs).toBeUndefined();
        expect(done.healthExport.scoringIntervalSecs).toBe(3600);
        // The export described the edited periods, start / end only, and the files exist.
        const exports = env.backend!.cmds('export_model_files').slice(exportsBefore);
        expect(exports).toHaveLength(1);
        expect(exports[0].args.request.test_periods).toEqual(NEW_WIRE);
        onlyStartEnd(exports[0].args.request.test_periods);
        expect(exports[0].error).toBeUndefined();
        expect(env.files.has(`workspaces/${WS}/output/TAG1/INDV_INFO_TAG1.json`)).toBe(true);
        // Everyone agrees it is Complete again.
        await waitFor(() => expect(bmw().getByTestId('save-ok')).toBeTruthy());
        expect(pill()).toBe('Complete');
        expect(bmw().queryByTestId('tests-changed-notice')).toBeNull();
        expect(bmw().queryByTestId('tests-changed-banner')).toBeNull();
        // ...and the "earlier scoring" hint is gone with its button: the files are current now.
        expect(bmw().queryByTestId('earlier-scoring')).toBeNull();
        expect(bmw().queryByTestId('mark-complete-again')).toBeNull();
        await waitFor(() => expect(dashDot(1, 'tag1', 'individual')).toBe('complete'));
        expect(diskModel('c3')).toEqual(before.c3);
        expect(JSON.stringify(env.backend!.calls.map(c => c.args))).not.toMatch(REMOVED_WIRE);

        // ── 6) Close and reopen the app: what was saved is what comes back ──────
        await restartApp();
        expect(chips()).toEqual(['S1 · 1 Jan 2026 12:00 → 1 Jan 2026 23:00', 'S2 · 2 Jan 2026 → 2 Jan 2026 20:00']);
        expect(bmw().queryByTestId('tests-changed-notice')).toBeNull();
        selectSensor('tag1');
        await settle(400);
        expect(pill()).toBe('Complete');
        // after a restart too: the re-saved model has no hint; the one never re-saved still has it
        if (!bmwEl().querySelector('[data-testid="set-points-card"]')) await openHealth();
        await waitFor(() => expect(bmw().getByTestId('save-ok')).toBeTruthy());
        expect(bmw().queryByTestId('earlier-scoring')).toBeNull();
        selectSensor('tag3', 2);
        await settle(400);
        expect(pill()).toBe('Complete');
        if (!bmwEl().querySelector('[data-testid="set-points-card"]')) await openHealth();
        await waitFor(() => expect(bmw().getByTestId('earlier-scoring').textContent).toBe(EARLIER_SCORING_HINT));
        expect(diskModel('c3').healthExport.scoringIntervalSecs).toBeUndefined();
        expect(readDisk().failureGroupState.models.map((m: any) => [m.id, m.status])).toEqual([['i1', true], ['c3', true]]);
        expect(JSON.stringify(readDisk().failureGroupState.runningConditionTestPeriods)).not.toMatch(REMOVED_WIRE);
    });

    it('the Custom model\'s own legacy scoring period: editing it in Model settings + Save asks only THAT model for Mark complete again, and saves id / start / end', async () => {
        writeDisk(oldWorkspace());
        const before = { i1: diskModel('i1'), c3: diskModel('c3') };
        await mountWindows();
        selectSensor('tag3', 2);
        await settle(400);
        expect(pill()).toBe('Complete');

        if (!bmwEl().querySelector('.bmw-sets--open')) fireEvent.click(bmw().getByText('Model settings', { selector: 'b' }));
        const own = within(bmw().getByTestId('custom-test-periods'));
        expect(own.getAllByTestId(/^test-row-\d+$/)).toHaveLength(1);
        expect(bmw().getByTestId('custom-test-periods').textContent).not.toMatch(REMOVED_UI);
        const end = own.getByLabelText('Scoring period 1 end');
        await act(async () => { fireEvent.change(end, { target: { value: '2026-01-02T22:00' } }); fireEvent.blur(end); });
        await act(async () => { fireEvent.click(bmw().getByText('Save changes')); });
        await waitFor(() => expect(diskModel('c3').status).toBe(false));

        const c3 = diskModel('c3');
        expect(c3.customTestPeriods).toEqual([{ id: 'c-old-1', start: '2026-01-02T06:00', end: '2026-01-02T22:00' }]);
        expect(c3.testsChangedAt).toBeTruthy();
        expect(c3.lastTrainedAt).toBe(before.c3.lastTrainedAt);
        expect(c3.trainedFingerprint).toBe(before.c3.trainedFingerprint);
        expect(c3.filterTimePeriods).toEqual(CUSTOM_TRAIN);
        // The workspace list and the Workspace-mode model are someone else's: byte-for-byte as before.
        expect(readDisk().failureGroupState.runningConditionTestPeriods).toEqual(OLD_WS_TESTS);
        expect(diskModel('i1')).toEqual(before.i1);
        openDashFgTab();
        await waitFor(() => expect(dashDot(2, 'tag3', 'individual')).toBe('trained'));
        expect(dashDot(1, 'tag1', 'individual')).toBe('complete');

        // Mark complete again: the request carries the edited period, start / end only.
        await openHealth();
        await waitFor(() => expect(lastPreviewFor('TAG3').test_periods).toEqual([{ start: '2026-01-02T06:00', end: '2026-01-02T22:00' }]));
        await markComplete();
        await waitFor(() => expect(diskModel('c3').status).toBe(true));
        expect(diskModel('c3').testsChangedAt).toBeUndefined();
        const exp = env.backend!.cmds('export_model_files').slice(-1)[0];
        expect(exp.args.request.test_periods).toEqual([{ start: '2026-01-02T06:00', end: '2026-01-02T22:00' }]);
        expect(exp.error).toBeUndefined();
        await waitFor(() => expect(dashDot(2, 'tag3', 'individual')).toBe('complete'));
        expect(JSON.stringify(env.backend!.calls.map(c => c.args))).not.toMatch(REMOVED_WIRE);
        expect(env.backend!.calls.filter(c => c.error).map(c => `${c.cmd}: ${c.error}`)).toEqual([]);
    });
});
