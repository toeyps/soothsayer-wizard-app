import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';

/*
 * Spec:
 * docs/design/handoff/workbench-redesign/README.md §1, §3, §4, and the user's
 * "at most 5 clusters" rule. Real Dashboard + real Build Model
 * window + real `workspaceManager` on one in-memory workspace file, the fake
 * Rust health backend:
 *
 *   - the health score fails to load: Mark complete is disabled with the footer
 *     reason, the input being typed in stays mounted and is saved on blur, Retry
 *     recovers; STALE_SESSION has its own reason and no Retry;
 *   - a save error and the way out of it (edit a set point -> both the red card
 *     and "Not saved" go -> Mark complete -> "Files saved <date>");
 *   - at most 5 clusters, and a 7-cluster model saved by an older build;
 *   - drafts with the new spine (the header page switch; a Model-settings draft
 *     on a tab that is not open);
 *   - CSV timestamps that carry `Z` / an offset keep their own wall clock (the raw
 *     rows on Model fit, and the clock HOUR the health score is averaged over).
 *
 * Covered elsewhere and NOT repeated here: a set point typed without blur is
 * saved exactly once on a sensor switch / kind-tab switch / "← Model fit" /
 * the Close button / a native close, and on Enter (`HealthScoreDraftsAndRaces`,
 * "a set point typed WITHOUT blur is persisted (exactly once) when the user leaves").
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
import { plantDataset } from './helpers/fakeHealthRust';
import {
    WS, blurSp, bmw, bmwDot, bmwEl, chartsWithSeries, dashDot, diskModel, enterSp, markBtn, markComplete, model, mountWindows, newBackend,
    openDashFgTab, openHealth, openSettings, readDisk, saveChanges, selectKindTab, selectSensor, settle, typeSp, waitForCharts, writeDisk, wsFile, wsTrained,
} from './helpers/healthWorkbench';
import { makeTestResult, makeValidation } from './helpers/validationFixture';
import { CHART, CLUSTER_COLORS, fmtNum } from '../components/windows/workbench/chartTheme';

vi.setConfig({ testTimeout: 60_000 });

beforeEach(() => {
    resetEnv();
    newBackend();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const IND_SP = { kind: 'individual', lower: 20, upper: 80, masterLower: 20, masterUpper: 80 };
const REL_SP = { kind: 'relationship', residualAt80Lower: -5, residualAt80Upper: 5, residualAt0Lower: -10, residualAt0Upper: 10 };
const STAMP = String.raw`\d{4}/\d{2}/\d{2} \d{2}:\d{2}`;

const wsWrites = () => env.writes.filter(w => w.path === wsFile()).length;
/** The models' slice of the workspace file, as text. */
const fgOnDisk = () => JSON.stringify(readDisk().failureGroupState);
const footer = () => bmw().getByTestId('wb-footer');
const sentence = () => (footer().querySelector('.wbx-reason') as HTMLElement).textContent;
const footPill = () => bmw().getByTestId('footer-pill').textContent;
const tabWords = (id: string) => bmw().getByTestId(`tab-status-${id}`).getAttribute('title');
const tabLabel = (name: RegExp) => bmw().getByRole('tab', { name }).getAttribute('aria-label');
const input = (id: string) => bmw().getByTestId(id) as HTMLInputElement;

/** i1 = Individual on TAG1, trained and fresh, valid set points (master 20 / 80). */
async function readyIndividual(over: Record<string, unknown> = {}) {
    writeDisk(wsTrained({}, [model({ id: 'i1', kind: 'individual', healthVerdict: 'valid', healthSetPoints: IND_SP, ...over })]));
    await mountWindows();
    openDashFgTab();
    selectSensor('tag1');
    await waitForCharts();
    await openHealth();
    await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
    await waitFor(() => expect(markBtn().disabled).toBe(false));
}

// ---------------------------------------------------------------------------
// The health score failed to load
// ---------------------------------------------------------------------------

describe('the health score failed to load (SPEC §4 "Preview failed")', () => {
    it('Mark complete is disabled with the footer reason; a set point typed under the red card keeps its input mounted and is saved on blur; Retry recovers and Mark complete then writes what was typed', async () => {
        await readyIndividual();
        expect(dashDot(1, 'tag1', 'individual')).toBe('trained');

        // Rust fails every request from now on.
        env.backend!.failOn('compute_health_preview', () => true, 'Failed to read column: transient I/O error.', false);
        await enterSp({ 'sp-upper': '85' });
        await waitFor(() => expect(bmw().getByTestId('health-error')).toBeTruthy());
        expect(bmw().getByTestId('health-error').textContent).toBe("Couldn't load the health score. Failed to read column: transient I/O error · the score and Checks are not available until it loadsRetry");
        expect(bmw().getByTestId('checks-unavailable').textContent).toBe('Not available until the health score loads.');
        expect(bmw().getByTestId('score-locked').textContent).toMatch(/Score not available/);
        // Mark complete: disabled, and the footer (the one status sentence) says why
        expect(markBtn().disabled).toBe(true);
        expect(markBtn().title).toBe('The health score did not load · Retry above, then Mark complete');
        expect(bmw().getByTestId('mark-block-reason').textContent).toBe('The health score did not load · Retry above, then Mark complete');
        expect(footer().querySelectorAll('.wbx-reason')).toHaveLength(1);
        expect(footPill()).toBe('Trained');
        // the value typed before the failure was saved all the same
        expect(diskModel('i1').healthSetPoints.upper).toBe(85);

        // Typing under the red card: the SAME input element stays (never replaced by a board)
        const el = input('sp-lower');
        el.focus();
        typeSp('sp-lower', '1');
        typeSp('sp-lower', '15'); // no blur yet
        expect(diskModel('i1').healthSetPoints.lower).toBe(20);
        // the debounced request for what is typed goes out, and fails again
        await waitFor(() => expect(env.backend!.cmds('compute_health_preview').pop()!.args.request.set_points).toEqual({ lower: 15, upper: 85 }));
        await settle(50);
        await waitFor(() => expect(bmw().getByTestId('health-error')).toBeTruthy());
        expect(input('sp-lower'), 'the input being typed in was not remounted').toBe(el);
        expect(document.activeElement, 'and it kept the focus').toBe(el);
        expect(el.value).toBe('15');
        expect(input('sp-upper').value).toBe('85');
        blurSp('sp-lower');
        await settle(100);
        expect(diskModel('i1').healthSetPoints).toMatchObject({ lower: 15, upper: 85 });
        expect(diskModel('i1').status).toBe(false);
        // nothing is judged while it failed: no stale "valid" tick, no Complete anywhere
        expect(bmw().queryByTestId('check-valid')).toBeNull();
        expect(tabWords('i1')).toBe('Trained');
        expect(dashDot(1, 'tag1', 'individual')).toBe('trained');

        // Retry (Rust answers again): the page is back for what is on screen
        env.backend!.clearFaults();
        fireEvent.click(bmw().getByTestId('health-retry'));
        await waitFor(() => expect(bmw().queryByTestId('health-error')).toBeNull());
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
        expect(input('sp-lower')).toBe(el);
        await waitFor(() => expect(sentence()).toBe('Set points valid — check the score chart, then Mark complete'));
        await markComplete();
        await waitFor(() => expect(diskModel('i1').status).toBe(true));
        expect(diskModel('i1').healthExport.setPoints).toMatchObject({ lower: 15, upper: 85 });
        expect(JSON.parse(env.files.get(`workspaces/${WS}/output/TAG1/INDV_INFO_TAG1.json`)!).model_metrics.setpoint_health_score).toEqual([15, 85]);
        await waitFor(() => expect(dashDot(1, 'tag1', 'individual')).toBe('complete'));
    });

    it('STALE_SESSION (the dataset was replaced under the window): its own reason in the footer, NO Retry on the card, the typed value stays and is saved', async () => {
        await readyIndividual();
        env.backend!.loadDataset('plant'); // a new Rust session: this window's generation is old
        const el = input('sp-upper');
        typeSp('sp-upper', '85');
        await settle(350);
        await waitFor(() => expect(bmw().getByTestId('health-error')).toBeTruthy());
        expect(env.backend!.cmds('compute_health_preview').pop()!.error).toMatch(/^STALE_SESSION/);
        expect(bmw().getByTestId('health-error-reason').textContent).toMatch(/dataset changed/);
        expect(bmw().queryByTestId('health-retry')).toBeNull();
        const why = bmw().getByTestId('mark-block-reason').textContent!;
        expect(why).toBe('The data in this window is out of date. Close it and open Build Model again from the Dashboard.');
        expect(why).not.toMatch(/Retry/);
        expect(markBtn().disabled).toBe(true);
        expect(markBtn().title).toBe(why);
        // the input was not replaced, and what was typed is saved on blur
        expect(input('sp-upper')).toBe(el);
        expect(el.value).toBe('85');
        blurSp('sp-upper');
        await settle(100);
        expect(diskModel('i1').healthSetPoints.upper).toBe(85);
        expect(diskModel('i1').status).toBe(false);
        expect(env.backend!.cmds('export_model_files')).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Save error, then the way out
// ---------------------------------------------------------------------------

describe('a save error and the recovery (SPEC §4 "Save error")', () => {
    it('Mark complete fails writing → red card with the file + "Not saved…" → a set point is edited → both go and the footer shows the real state → Mark complete succeeds → "Files saved <date>" in the one date format', async () => {
        await readyIndividual();
        const why = `Couldn't write ${env.backend!.outputDir(WS)}/TAG1/INDV_INFO_TAG1.json — the file is open in another program.`;
        env.backend!.failOn('export_model_files', () => true, why);
        await act(async () => { fireEvent.click(markBtn()); });
        await waitFor(() => expect(bmw().getByTestId('save-error')).toBeTruthy());
        // the red card carries the file; the footer says what to do
        expect(bmw().getByTestId('save-error').className).toContain('hs-save--bad');
        expect(bmw().getByTestId('save-error-reason').textContent).toBe(why);
        expect(sentence()).toBe('Not saved · fix it, then Mark complete again');
        expect((footer().querySelector('.wbx-reason') as HTMLElement).getAttribute('data-tone')).toBe('bad');
        expect(footPill()).toBe('Trained');
        expect(diskModel('i1').status).toBe(false);
        expect(diskModel('i1').healthExport).toBeUndefined();
        expect([...env.files.keys()].some(k => k.includes('/output/'))).toBe(false);
        expect(dashDot(1, 'tag1', 'individual')).toBe('trained');
        expect(bmwDot('i1').colour).toBe('need');
        // the one filled button is still Mark complete, and it can be pressed again
        expect(markBtn().disabled).toBe(false);
        expect(markBtn().className).toBe('bmw-btn-ok');

        // the user edits a set point: that attempt no longer describes the page
        typeSp('sp-upper', '8');
        expect(bmw().queryByTestId('save-error')).toBeNull();
        typeSp('sp-upper', '85');
        blurSp('sp-upper');
        await settle(350);
        await waitFor(() => expect(sentence()).toBe('Set points valid — check the score chart, then Mark complete'));
        expect(footer().textContent).not.toMatch(/Not saved/);
        expect(bmw().queryByTestId('save-error')).toBeNull();

        // Mark complete succeeds (the fault was a one-off)
        await markComplete();
        await waitFor(() => expect(bmw().getByTestId('save-ok')).toBeTruthy());
        expect(bmw().getByTestId('save-ok').textContent).toMatch(new RegExp(`^Files saved ${STAMP} · .*workspaces/${WS}/output$`));
        // ONE date format: the stamp is the mono "2026/02/09 23:50" of the moment it was saved (local time, no seconds)
        const at = new Date(diskModel('i1').healthExport.at);
        const pad = (n: number) => String(n).padStart(2, '0');
        expect(bmw().getByTestId('save-ok').querySelector('.wbx-dt')!.textContent)
            .toBe(`${at.getFullYear()}/${pad(at.getMonth() + 1)}/${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`);
        expect(bmw().getByTestId('footer-saved-path').getAttribute('title')).toBe(env.backend!.outputDir(WS));
        expect(bmw().getByTestId('save-ok').closest('[data-testid="wb-footer"]')).not.toBeNull();
        expect(bmwEl().textContent).not.toMatch(/Files saved to/);
        expect(footPill()).toBe('Complete');
        expect(diskModel('i1')).toMatchObject({ status: true, healthSetPoints: { lower: 20, upper: 85 } });
        expect(env.files.has(`workspaces/${WS}/output/TAG1/INDV_INFO_TAG1.json`)).toBe(true);
        await waitFor(() => expect(dashDot(1, 'tag1', 'individual')).toBe('complete'));
    });
});

// ---------------------------------------------------------------------------
// At most 5 clusters
// ---------------------------------------------------------------------------

describe('at most 5 clusters (user decision 2026-10-10)', () => {
    const CLU_SP = { kind: 'clustering', outerSd: 5 };
    const record = (sp: unknown) => ({ at: '2026-10-02T10:00:00.000Z', outputDir: env.backend!.outputDir(WS), setPoints: sp });
    const more = () => bmw().getByRole('button', { name: 'More clusters' }) as HTMLButtonElement;
    const fewer = () => bmw().getByRole('button', { name: 'Fewer clusters' }) as HTMLButtonElement;
    const count = () => fewer().nextElementSibling!.textContent;
    const ranges = (bounds: number[]) => bounds.slice(0, -1).map((min, i) => ({ min, max: bounds[i + 1] }));
    const clustering = (o: Record<string, unknown>) => model({ id: 'c1', kind: 'clustering', xSensor: 'TAG3', ySensor: 'TAG5', criteriaSensor: 'TAG4', ...o });

    it('the stepper stops at 5: "+" is disabled there with the reason, the count saved is 5', async () => {
        newBackend({ plant: plantDataset(140) });
        writeDisk(wsTrained({}, [clustering({ numClusters: 4, clusterRanges: ranges([0, 25, 50, 75, 100]), healthSetPoints: CLU_SP })]));
        await mountWindows();
        selectSensor('tag3');
        await waitForCharts();
        openSettings();
        expect(count()).toBe('4');
        expect(more().disabled).toBe(false);
        fireEvent.click(more());
        await settle(100);
        expect(count()).toBe('5');
        expect(more().disabled).toBe(true);
        expect(more().title).toBe('At most 5 clusters');
        fireEvent.click(more()); // a disabled button: nothing
        expect(count()).toBe('5');
        expect(fewer().disabled).toBe(false);
        await saveChanges();
        await waitFor(() => expect(diskModel('c1').numClusters).toBe(5));
        expect(diskModel('c1').clusterRanges).toHaveLength(5);
    });

    it('a 7-cluster Complete model saved by an older build opens unchanged (still Complete, no draft, nothing written), draws all 7 clusters in cluster colours; "+" is disabled, "−" works and Save then makes it Incomplete', async () => {
        newBackend({ plant: plantDataset(140) });
        const seven = ranges([0, 15, 30, 45, 60, 75, 90, 100]);
        writeDisk(wsTrained({}, [clustering({ numClusters: 7, clusterRanges: seven, status: true, healthVerdict: 'valid', healthSetPoints: CLU_SP, healthExport: record(CLU_SP) })]));
        const seeded = { fingerprint: diskModel('c1').trainedFingerprint, trainedAt: diskModel('c1').lastTrainedAt, fg: fgOnDisk() };
        await mountWindows();
        openDashFgTab();
        selectSensor('tag3');
        await waitForCharts();
        await settle(500);

        // opens exactly as saved: Complete, nothing clamped, no draft, the file untouched
        // (the Dashboard autosaves its own view state on open — the models' slice is byte-identical)
        expect(fgOnDisk(), 'opening it changed nothing about the models').toBe(seeded.fg);
        expect(diskModel('c1')).toMatchObject({ status: true, numClusters: 7, clusterRanges: seven, trainedFingerprint: seeded.fingerprint, lastTrainedAt: seeded.trainedAt });
        expect(footPill()).toBe('Complete');
        expect(tabWords('c1')).toBe('Complete');
        expect(bmwDot('c1')).toEqual({ state: 'complete', colour: 'complete' });
        expect(dashDot(1, 'tag3', 'clustering')).toBe('complete');
        expect(bmw().queryByTestId('save-changes')).toBeNull();
        expect(footer().textContent).not.toMatch(/Unsaved/);
        expect(bmw().queryByTestId('stale-banner')).toBeNull();
        // Rust was asked for 7 clusters with the 7 saved ranges
        const req = env.backend!.cmds('compute_health_preview').filter(c => c.args.request.kind === 'clustering').pop()!;
        expect(req.error).toBeUndefined();
        expect(req.args.request.n_clusters).toBe(7);
        expect(req.args.request.cluster_ranges).toHaveLength(7);

        // Model fit: a point series per cluster — all 7 — in blues / violets only, on the ONE
        // full-width chart (the "Clusters" summary card with a row per cluster was removed 2026-10-11)
        expect([...bmw().getByTestId('model-fit-clustering').children].filter(c => c.tagName === 'SECTION').map(c => c.getAttribute('data-testid'))).toEqual(['chart-card-cl']);
        expect(bmw().queryByTestId('cluster-summary')).toBeNull();
        const fitChart = chartsWithSeries('Cluster 7').pop()!;
        const pointColours = (fitChart.option.series as any[]).filter(s => /^Cluster \d$/.test(s.name)).map(s => s.itemStyle.color as string);
        expect(pointColours).toHaveLength(7);
        expect(new Set(pointColours).size, 'seven different colours').toBe(7);
        for (const c of pointColours) {
            expect(CLUSTER_COLORS as readonly string[]).toContain(c);
            expect([CHART.ok, CHART.warn, CHART.danger, CHART.test] as string[]).not.toContain(c);
        }
        for (let k = 1; k <= 7; k++) {
            expect(chartsWithSeries(`Cluster ${k} 1× SD`).length, `1× ring of cluster ${k}`).toBeGreaterThan(0);
            expect(chartsWithSeries(`Cluster ${k} 3× SD`).length, `3× ring of cluster ${k}`).toBeGreaterThan(0);
        }

        // Health score: the user's N ring for every one of the 7 clusters; still valid, still Complete
        await openHealth();
        await waitFor(() => expect(bmw().getByTestId('check-valid')).toBeTruthy());
        for (let k = 1; k <= 7; k++) expect(chartsWithSeries(`Cluster ${k} 5× SD`).length, `5× ring of cluster ${k}`).toBeGreaterThan(0);
        expect(bmw().getByTestId('mark-incomplete')).toBeTruthy();
        // an older build's export record has no scoring interval: the footer offers "Mark complete
        // again" for the 1-hour averages — an offer only, the model stays Complete and untouched
        expect(bmw().getByTestId('earlier-scoring').textContent).toBe('Saved results use the earlier row-by-row scoring — Mark complete again to update the files');
        expect(bmw().getByTestId('mark-complete-again')).toBeTruthy();
        expect(footPill()).toBe('Complete');
        expect(fgOnDisk(), 'both pages were opened: still nothing changed').toBe(seeded.fg);

        // Model settings: 7 is shown as it is; it only cannot be raised
        fireEvent.click(bmw().getByTestId('footer-back-to-fit'));
        await settle(100);
        openSettings();
        expect(count()).toBe('7');
        expect(more().disabled).toBe(true);
        expect(more().title).toBe('At most 5 clusters');
        expect(fewer().disabled).toBe(false);
        expect(bmw().queryByTestId('save-changes')).toBeNull(); // looking is not editing
        expect(diskModel('c1').status).toBe(true);

        // "−" works: a draft (nothing saved yet, still Complete on disk)...
        fireEvent.click(fewer());
        await settle(150);
        expect(count()).toBe('6');
        expect(more().disabled).toBe(true); // 6 is still above the cap
        expect(bmw().getByTestId('save-changes')).toBeTruthy();
        expect(diskModel('c1')).toMatchObject({ status: true, numClusters: 7 });
        expect(dashDot(1, 'tag3', 'clustering')).toBe('complete');
        // ...and Save makes it Incomplete in the same write (the cluster count is a training input)
        await saveChanges();
        await waitFor(() => expect(diskModel('c1').numClusters).toBe(6));
        const saved = diskModel('c1');
        expect(saved.status).toBe(false);
        expect(saved.clusterRanges).toHaveLength(6);
        expect(saved).toMatchObject({ healthSetPoints: CLU_SP, lastTrainedAt: seeded.trainedAt, trainedFingerprint: seeded.fingerprint });
        expect(footPill()).toBe('Incomplete');
        expect(bmw().getByTestId('stale-banner')).toBeTruthy();
        expect(bmwDot('c1').state).toBe('stale');
        await waitFor(() => expect(dashDot(1, 'tag3', 'clustering')).toBe('none'));
    });
});

// ---------------------------------------------------------------------------
// Drafts with the new spine
// ---------------------------------------------------------------------------

describe('drafts and the new page spine', () => {
    it('a set point typed WITHOUT blur is saved (once) when the page is left through the HEADER page switch', async () => {
        await readyIndividual();
        await settle(400);
        const before = wsWrites();
        typeSp('sp-lower', '1');
        typeSp('sp-lower', '12'); // still typing
        expect(diskModel('i1').healthSetPoints.lower).toBe(20);
        fireEvent.click(bmw().getByTestId('footer-back-to-fit'));
        await settle(100);
        expect(diskModel('i1').healthSetPoints.lower).toBe(12);
        const lowers = env.writes.filter(w => w.path === wsFile()).slice(before)
            .map(w => JSON.parse(w.content).failureGroupState.models[0].healthSetPoints.lower);
        expect(lowers.filter((v, i) => i === 0 || lowers[i - 1] !== v), 'one change of the value on disk').toEqual([12]);
        // and it is what the page shows when the user comes back
        fireEvent.click(bmw().getByTestId('next-health-score'));
        await settle(350);
        expect(input('sp-lower').value).toBe('12');
    });

    it('an unsaved Model-settings draft on a tab that is NOT open: "unsaved changes" in that tab\'s tooltip and name, nothing on disk, and the draft is still there after a tab switch and a sensor switch', async () => {
        writeDisk(wsTrained({}, [
            model({ id: 'i1', kind: 'individual', name: 'Pressure I', healthVerdict: 'valid', healthSetPoints: IND_SP }),
            model({ id: 'r1', kind: 'relationship', name: 'Pressure R', predictorSensors: ['TAG3'], healthVerdict: 'valid', healthSetPoints: REL_SP }),
            model({ id: 'i3', kind: 'individual', name: 'Flow I', targetSensor: 'TAG3', healthSetPoints: { kind: 'individual', lower: 0, upper: 200, masterLower: null, masterUpper: 90 } }),
        ]));
        await mountWindows();
        openDashFgTab();
        selectSensor('tag1');
        await waitForCharts();
        await waitFor(() => expect(tabLabel(/^Individual/)).toBe('Individual, Trained'));
        const writes = wsWrites();

        // a draft on the Individual model (its tab is open): said in the footer, once
        openSettings();
        const nameBox = () => bmw().getByPlaceholderText('e.g. Bearing vibration model') as HTMLInputElement;
        fireEvent.change(nameBox(), { target: { value: 'Pressure I (edited)' } });
        expect(sentence()).toBe('Unsaved changes to the Individual model');
        expect(tabLabel(/^Individual/)).toBe('Individual, Trained · unsaved changes');
        expect(bmw().getByTestId('save-changes')).toBeTruthy();

        // the Relation model's tab is opened: this tab has no draft — the other tab's tooltip carries it
        selectKindTab('Relation model');
        await waitForCharts();
        expect(footer().textContent).not.toMatch(/Unsaved/);
        expect(bmw().queryByTestId('save-changes')).toBeNull();
        expect(tabLabel(/^Individual/)).toBe('Individual, Trained · unsaved changes');
        expect(bmw().getByRole('tab', { name: /^Individual/ }).getAttribute('title')).toBe('Individual · Trained · unsaved changes');
        expect(tabWords('i1')).toBe('Trained · unsaved changes');
        expect(tabLabel(/^Relation model/)).not.toMatch(/unsaved/);
        // the dot itself is the same colour as the list's and the Dashboard still shows what is saved
        expect(bmw().getByTestId('tab-status-i1').getAttribute('data-dot')).toBe(bmwDot('i1').colour);
        expect(dashDot(1, 'tag1', 'individual')).toBe('trained');

        // another sensor, and back
        selectSensor('tag3');
        await settle(300);
        selectSensor('tag1');
        await settle(300);
        expect(tabLabel(/^Individual/)).toBe('Individual, Trained · unsaved changes');
        expect(diskModel('i1').name, 'a draft is never written by leaving').toBe('Pressure I');
        expect(wsWrites()).toBe(writes);

        // coming back to its tab: the draft is still there, exactly as typed
        selectKindTab('Individual');
        await settle(100);
        openSettings();
        expect(nameBox().value).toBe('Pressure I (edited)');
        expect(sentence()).toBe('Unsaved changes to the Individual model');
        expect(footer().getAttribute('data-primary')).toBe('save');
        await saveChanges();
        await waitFor(() => expect(diskModel('i1').name).toBe('Pressure I (edited)'));
        await waitFor(() => expect(tabLabel(/^Individual/)).toBe('Individual, Trained'));
        expect(bmw().queryByTestId('save-changes')).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Timestamps keep their own wall clock
// ---------------------------------------------------------------------------

describe('a CSV stamp with "Z" / an offset shows its OWN wall clock everywhere (never shifted by the PC\'s time zone)', () => {
    // 60 rows, 10 s apart from 22:55:00 on 2026/02/09 (so they straddle 23:00: rows 0-29 are in the
    // 22:00 hour, rows 30-59 in the 23:00 hour), written the way three different loggers would:
    // UTC ("Z"), Bangkok ("+07:00") and New York ("-05:00").
    const ZONES = ['Z', '+07:00', '-05:00'];
    const clock = (i: number) => {
        const s = 22 * 3600 + 55 * 60 + i * 10;
        const p = (n: number) => String(n).padStart(2, '0');
        return { h: Math.floor(s / 3600), m: Math.floor(s / 60) % 60, s: s % 60, text: `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}` };
    };
    function zonedDataset() {
        const d = plantDataset(60);
        return { ...d, timestamps: d.timestamps.map((_, i) => `2026-02-09T${clock(i).text}${ZONES[i % 3]}`) };
    }

    // The health score is computed on 1-hour averages: the Model fit page still shows every raw row
    // at its own clock (seconds included), while the Health score page has ONE point per clock hour,
    // placed at — and read out as — the START of the rows' own wall-clock hour.
    it('Model fit plots every raw row at its own clock (10 s apart); the Health score page reads the rows\' own clock HOUR — lowest-score time, scoring tile and hover read-out say 22:00 / 23:00 on 2026/02/09; the footer\'s own stamps are the app\'s local time in the same format', async () => {
        const data = zonedDataset();
        newBackend({ plant: data });
        // Rust also returns the scoring period's facts: its lowest hourly score, with that hour's start.
        const validation = makeValidation({
            train_ranges: [{ start: '2026-02-09T22:55', end: '2026-02-09T22:59' }],
            tests: [makeTestResult({ start: '2026-02-09T23:00', end: '2026-02-09T23:04', lowest: 61, lowest_at: '2026-02-09T23:00:00' })],
        });
        env.backend!.override('compute_health_preview', () => true, async (_a, real) => ({ ...(await real() as object), test_validation: validation }), false);
        const band = env.backend!.individualBand('TAG1');
        const sp = { kind: 'individual', lower: Math.floor(band.l3 * 10 - 5) / 10, upper: Math.ceil(band.u3 * 10 + 5) / 10, masterLower: 20, masterUpper: 80 };
        writeDisk(wsTrained({ runningConditionFilters: [], runningConditionNoneConfirmed: true }, [
            model({ id: 'i1', kind: 'individual', healthVerdict: 'valid', healthSetPoints: sp }),
        ]));
        await mountWindows();
        selectSensor('tag1');
        await waitForCharts();

        // footer: an instant the APP recorded (UTC on disk) shown in local time, the one format
        const trained = new Date(diskModel('i1').lastTrainedAt);
        const pad = (n: number) => String(n).padStart(2, '0');
        const local = (d: Date) => `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        expect(footer().querySelector('.wbx-dt')!.textContent).toBe(local(trained));
        expect(sentence()).toMatch(new RegExp(`^Trained ${STAMP} · scored on 1 period · `));
        expect(footer().textContent).not.toMatch(/\d{4}-\d{2}-\d{2}|T\d\d:|Z\b|\+07:00|\b(AM|PM)\b/);

        // Model fit (RAW rows): every point of the time chart sits at its row's own clock
        const timeChart = env.charts.filter(c => c.option?.xAxis?.type === 'time').pop()!;
        expect(timeChart, 'a time-axis chart was drawn').toBeTruthy();
        // (the chart adds a `null` point where the line leaves a train / scoring period: not a row)
        const points = ((timeChart.option.series as any[]).find(s => s.name === 'Value')!.data as [number, number | null][]).filter(p => p[1] !== null);
        expect(points).toHaveLength(60);
        points.forEach(([ms], i) => {
            const d = new Date(ms);
            expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()], `row ${i} (${data.timestamps[i]})`)
                .toEqual([2026, 1, 9, clock(i).h, clock(i).m, clock(i).s]);
        });
        // ...so the three loggers' rows are in file order, 10 s apart (no 7 h / 5 h jumps)
        for (let i = 1; i < points.length; i++) expect(points[i][0] - points[i - 1][0], `gap before row ${i}`).toBe(10_000);

        // Health score (1-hour averages)
        await openHealth();
        await waitFor(() => expect(bmw().getByTestId('score-summary')).toBeTruthy());
        const answer = env.backend!.lastOk('compute_health_preview') as {
            hourly: { timestamps: string[]; rows: number[]; value: number[]; score: (number | null)[] };
            series: { score: null };
            score_summary: { min_score: { timestamp: string; row: number } };
        };
        // the 600 s of data are TWO hourly points, at the rows' own clock hours on 2026/02/09 — a "+07:00" row
        // moved to UTC would be 15:00, a "-05:00" row 03:00 / 04:00 on the 10th
        expect(answer.hourly.timestamps).toEqual(['2026-02-09T22:00:00', '2026-02-09T23:00:00']);
        expect(answer.series.score).toBeNull(); // the raw rows are never scored
        // each hour's first row was written inside that hour by its own clock, whatever zone its logger used
        answer.hourly.rows.forEach((row, h) => expect(data.timestamps[row].slice(0, 13), `first row of hour ${h}`).toBe(answer.hourly.timestamps[h].slice(0, 13)));

        // the score chart has exactly those two points, at the hour starts (local wall clock)
        const score = env.charts.filter(ch => ((ch.option?.series ?? []) as any[]).some(s => s?.name === 'Health score') && ch.props?.onEvents?.updateAxisPointer).pop()!;
        expect(score, 'the score chart listens to the axis pointer').toBeTruthy();
        // (as on Model fit, the chart adds a `null` point where the line leaves a train / scoring period)
        const scorePoints = ((score.option.series as any[]).find(s => s.name === 'Health score')!.data as [number, number | null][]).filter(p => p[1] !== null);
        expect(answer.hourly.score.every(v => v !== null), 'both hours are scored').toBe(true);
        expect(scorePoints.map(p => p[0])).toEqual([new Date(2026, 1, 9, 22, 0, 0).getTime(), new Date(2026, 1, 9, 23, 0, 0).getTime()]);

        // the hour with the lowest score: its START — a data row's time, with seconds, read from the row's own clock
        const low = answer.score_summary.min_score;
        expect(answer.hourly.timestamps).toContain(low.timestamp);
        expect(low.timestamp.slice(11, 19)).toMatch(/^2[23]:00:00$/);
        expect(bmw().getByTestId('score-lowest-at').textContent).toBe(`2026/02/09 ${low.timestamp.slice(11, 19)}`);
        expect(bmw().getByTestId('score-lowest-at').className).toContain('wbx-dt');
        expect(bmw().getByTestId('score-summary').textContent).toMatch(/of scored hours · 1-hour averages of the running rows$/);
        // the scoring period's tile: the hour start as it is, and the period's own bounds
        expect(bmw().getByTestId('test-result-1-lowest').textContent).toBe('Lowest 61 (1 h average) on 2026/02/09 23:00:00.');
        expect(bmw().getByTestId('test-result-1').textContent).toContain('2026/02/09 23:00 → 2026/02/09 23:04');

        // the hover read-out: the hour START (a data row's time: "…22:00:00", never the raw text) and that hour's 1 h average
        const hover = async (h: number, m: number, s: number) => {
            const at = new Date(2026, 1, 9, h, m, s).getTime();
            await act(async () => { score.props.onEvents.updateAxisPointer({ axesInfo: [{ axisDim: 'x', value: at }] }); });
            return bmw().getByTestId('hs-readout').textContent!;
        };
        const line = (h: number) => new RegExp(`^2026/02/09 ${answer.hourly.timestamps[h].slice(11, 19)} · 1 h avg ${fmtNum(answer.hourly.value[h]).replace('.', '\\.')} bar · score \\d+$`);
        expect(await hover(22, 0, 0)).toMatch(line(0));
        expect(await hover(22, 20, 10)).toMatch(line(0));   // nearer to the 22:00 point
        expect(await hover(22, 55, 10)).toMatch(line(1));   // row 1's own time ("+07:00"): the nearest POINT is 23:00
        expect(await hover(23, 4, 50)).toMatch(line(1));    // the last row ("-05:00")
        for (const [h, m, s] of [[22, 0, 0], [22, 55, 10], [23, 4, 50]]) {
            const text = await hover(h, m, s);
            // the hour start with its ":00:00" — never a row's own 22:55:10, the raw text or a zone
            expect(text).toMatch(/^2026\/02\/09 2[23]:00:00 · /);
            expect(text).not.toMatch(/\d\d:\d\d:[1-5]\d|· value |T\d\d:|\+07:00|-05:00|Z\b/);
        }
        await act(async () => { score.props.onEvents.globalout(); });
        expect(bmw().getByTestId('hs-readout').textContent).toBe('');
    });
});
