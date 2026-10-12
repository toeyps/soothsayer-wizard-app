import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

/*
 * Health score on 1-hour averages — Train → Health score → Mark complete on
 * 5-MINUTE data, for each model kind, across every zone it touches.
 *
 * REAL here: the Dashboard, the Build Model window with its Model fit / Health
 * score pages, the `useHealthPreview` hook, `workspaceManager` over one
 * in-memory workspace file. The Tauri boundary is the fake Rust backend
 * (`helpers/fakeHealthRust.ts`).
 *
 * The dataset and the expected numbers are the SHARED fixture
 * `src-tauri/tests/fixtures/hourly_score_parity.json`: the real Rust code is
 * asserted against it in `src-tauri/tests/internal/train_test_validation_internal.rs`
 * (`hourly_parity_*`) and the fake in `HealthHourlyRustParity.test.ts`. So for
 * Individual and Clustering this file proves the chain end to end: the request
 * the UI really builds IS the request of the fixture, and what the page shows /
 * the file that Mark complete writes are the numbers Rust is pinned to.
 * (The Relation model needs the engine: its numbers come from the fake's
 * least-squares stand-in — what is pinned here is what the frontend ASKS and
 * what it does with the answer.)
 *
 * What the pieces are tested for on their own, and is only touched here:
 *   - wording of the page / tiles / read-out: HealthScorePage.test.tsx,
 *     ValidationCards.test.tsx, healthChecks.test.ts;
 *   - the footer hint of a model completed before the change:
 *     BuildModelWindow.test.tsx + ScoringPeriodsLegacyWorkspace.integration.test.tsx
 *     (hint shown → Mark complete again → gone → survives a restart);
 *   - which hours the Relation model's ENGINE is asked for when a scoring period
 *     is added / removed: Rust, `only_hours_without_a_stored_prediction_are_planned_…`
 *     and `removing_a_scoring_period_plans_nothing_…`.
 * What only this file sees: one point per clock hour on the Health score page
 * while the Model fit page keeps every raw row; a partly-running hour and a
 * stopped hour through the real UI; the exported `validation` block read back
 * from the file after a real Mark complete; a scoring-period edit after Train
 * never re-trains the Relation model; "Try again" reaching Rust as
 * `retry_test_scoring` exactly once.
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

import fixture from '../../src-tauri/tests/fixtures/hourly_score_parity.json';
import { env, resetEnv, type ChartRecord } from './helpers/healthEnv';
import { createFakeHealthRust, type HealthDataset } from './helpers/fakeHealthRust';
import { hourlyScopes, scopesOf } from '../components/windows/workbench/healthCharts';
import { buildScoreOption } from '../components/windows/workbench/healthPageCharts';
import { fmtNum } from '../components/windows/workbench/chartTheme';
import {
    WS, bmw, bmwEl, diskModel, markComplete, model, mountWindows, newBackend, openHealth, pill, readDisk, restartApp,
    selectSensor, settle, train, waitForCharts, writeDisk, wsState,
} from './helpers/healthWorkbench';

vi.setConfig({ testTimeout: 60_000 });

// ── the plant: 120 rows, 5 minutes apart, from 2024/03/01 00:00 (see the fixture's `_about`) ──
const DATA = fixture.dataset as unknown as HealthDataset;
const HEADERS = DATA.headers;
const META = [
    { tag: 'V', description: 'Discharge pressure', unit: 'bar', component: 'Pump' },
    { tag: 'RUN', description: 'Running', unit: '', component: 'Pump' },
    { tag: 'X', description: 'Flow', unit: 'm3/h', component: 'Pump' },
    { tag: 'Y', description: 'Temp', unit: 'C', component: 'Pump' },
    { tag: 'MODE', description: 'Mode', unit: '', component: 'Pump' },
    { tag: 'T', description: 'Power', unit: 'kW', component: 'Motor' },
    { tag: 'P', description: 'Speed', unit: 'rpm', component: 'Motor' },
];
const OPTS = { headers: HEADERS, meta: META };

const RUNNING = { id: 'rc1', sensor: 'RUN', operation: 'greater_than', value1: '0.5', value2: '' };
const TRAIN = [{ id: 'tr', start: '2024-03-01T00:00', end: '2024-03-01T03:59' }];
const S_WHOLE = [{ id: 's1', start: '2024-03-01T04:00', end: '2024-03-01T09:59' }];
const S_TWO = [{ id: 's1', start: '2024-03-01T04:00', end: '2024-03-01T05:59' }, { id: 's2', start: '2024-03-01T06:00', end: '2024-03-01T09:59' }];
const wire = (list: { start: string; end: string }[]) => list.map(({ start, end }) => ({ start, end }));

const workspace = (tests: unknown[], models: Record<string, unknown>[]) => wsState({
    runningConditionFilters: [RUNNING], runningConditionTimePeriods: TRAIN, runningConditionTestPeriods: tests, models,
});

const IND = () => model({ id: 'i1', kind: 'individual', targetSensor: 'V', healthSetPoints: { kind: 'individual', lower: 20, upper: 69, masterLower: null, masterUpper: null } });
const REL = () => model({
    id: 'r1', kind: 'relationship', targetSensor: 'T', predictorSensors: ['P'],
    healthSetPoints: { kind: 'relationship', residualAt80Lower: -3, residualAt80Upper: 3, residualAt0Lower: -6, residualAt0Upper: 6 },
});
const CLU = () => model({
    id: 'c1', kind: 'clustering', xSensor: 'X', ySensor: 'Y', criteriaSensor: 'MODE', numClusters: 2,
    clusterRanges: [{ min: 0, max: 50 }, { min: 50, max: 100 }], healthSetPoints: { kind: 'clustering', outerSd: 6 },
});

// ── reading what was drawn ──
/** Local wall-clock ms of `h:m` on 2024/03/01 (the charts place a row at its own clock). */
const at = (h: number, m = 0) => new Date(2024, 2, 1, h, m, 0).getTime();
/** The hours that have a running row: hour 6 is stopped from start to end. */
const HOURS = [0, 1, 2, 3, 4, 5, 7, 8, 9];
const seriesOf = (c: ChartRecord, name: string) => ((c.option?.series ?? []) as any[]).find(s => s?.name === name);
/** The points of a line (the chart adds a `null` where the line leaves a period: not a point). */
const pointsOf = (c: ChartRecord, name: string) => ((seriesOf(c, name)?.data ?? []) as [number, number | null][]).filter(p => p[1] !== null);
/** The last chart drawn since `from` that has a series `name` (`linked` = it reports the hover: a Health score page chart). */
function lastChart(name: string, from = 0, linked?: boolean): ChartRecord {
    const c = env.charts.slice(from).filter(x => seriesOf(x, name) && (linked === undefined || !!x.props?.onEvents?.updateAxisPointer === linked)).pop();
    expect(c, `a chart with the series "${name}"`).toBeTruthy();
    return c!;
}
const lastPreview = (kind: string) => env.backend!.cmds('compute_health_preview').filter(c => c.args.request.kind === kind && c.result !== undefined).pop()!;
const trainsOfRelation = () => env.backend!.cmds('preview_relationship_model').filter(c => c.args.cache_key);
const infoFile = (rel: string) => JSON.parse(env.files.get(`workspaces/${WS}/output/${rel}`)!);
const text = (id: string) => bmw().getByTestId(id).textContent;
/** The period names printed in the strip above a time chart (the TRAIN shading — a scoring period is not drawn). */
const stripOf = (c: ChartRecord): string[] =>
    ((seriesOf(c, '__scopes')?.markArea?.data ?? []) as any[]).filter(x => x[0].label.show).map(x => x[0].label.formatter as string);
/** The heading of a time chart's hover tooltip for the X value `ms` (the X axis' pointer-label formatter). */
const tipHeading = (c: ChartRecord, ms: number): string => (c.option as any).xAxis.axisPointer.label.formatter({ value: ms });
const hoverTime = async (chart: ChartRecord, ms: number) => {
    await act(async () => { chart.props.onEvents.updateAxisPointer({ axesInfo: [{ axisDim: 'x', value: ms }] }); });
    return text('hs-readout')!;
};
/** The exported `validation` block the fixture implies (what Rust is asserted to write for the same request). */
const exportedBlock = (want: { test_validation: object }) => ({ tested: true, scoring_interval_seconds: 3600, scoring_aggregation: 'mean', ...want.test_validation });

beforeEach(() => {
    resetEnv();
    newBackend({ five: DATA });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Individual on 5-minute data', () => {
    it('Model fit keeps every raw row; the Health score page has ONE point per clock hour (a partly-running hour averages its running rows, a stopped hour has no point); Mark complete writes the hourly block into the INFO file and the record carries the interval', async () => {
        const { request, expect: want } = fixture.cases.individual;
        writeDisk(workspace(S_WHOLE, [IND()]));
        await mountWindows(OPTS);
        selectSensor('v');
        await train();
        expect(pill()).toBe('Trained');
        await waitForCharts();

        // ── Model fit: RAW rows, 5 minutes apart — nothing here is averaged ──
        // (the page prints no row count any more — its tiles are Mean · SD · Outside ±3SD — so the raw statistics
        // are read from the answer the page was drawn from, and the Mean tile is that answer's mean)
        const fitStats = (lastPreview('individual').result as any).stats;
        expect(fitStats.rows).toBe(48); // the 4 training hours x 12 rows
        expect(bmw().getByTestId('stat-mean').querySelector('.wb3-kpi-v')!.firstChild!.textContent).toBe(fmtNum(fitStats.mean));
        expect(bmw().queryByTestId('stat-rows')).toBeNull();
        const raw = pointsOf(lastChart('Value', 0, false), 'Value');
        expect(raw).toHaveLength(want.series_total_points); // 48 train rows + the 45 running rows of the scoring period
        expect(raw[1][0] - raw[0][0]).toBe(5 * 60_000);
        expect(raw.map(p => p[0])).toContain(at(4, 35));
        expect(Math.max(...raw.map(p => p[1] as number))).toBe(85.5); // a single row's value, never the hour mean
        expect(raw.every(p => p[1] !== 9999), 'no stopped row is drawn').toBe(true);
        expect(env.charts.some(c => seriesOf(c, 'Health score')), 'no score chart on Model fit').toBe(false);
        // only the TRAIN period is shaded and named (user decision 2026-10-12): the scoring period has no band and
        // no "S1" — its 45 rows are on the line all the same (counted above)
        expect(stripOf(lastChart('Value', 0, false))).toEqual(['TRAIN']);
        // the tooltip of a raw 5-minute row is headed by that row's date AND time (it read "2024-03-01" alone)
        expect(tipHeading(lastChart('Value', 0, false), at(4, 35))).toBe('2024/03/01 04:35:00');
        expect(tipHeading(lastChart('Value', 0, false), at(0, 5))).toBe('2024/03/01 00:05:00');

        // ── Health score: 1-hour averages ──
        const from = env.charts.length;
        await openHealth();
        await waitFor(() => expect(bmw().getByTestId('score-summary')).toBeTruthy());
        // the request the UI built IS the fixture's request (the one Rust is pinned to)
        const sent = lastPreview('individual');
        expect(sent.args.request).toMatchObject(request);
        expect((sent.result as any).scoring_interval_secs).toBe(3600);
        expect((sent.result as any).series.score).toBeNull();

        const setChart = lastChart('Value', from, true);
        const values = pointsOf(setChart, 'Value');
        expect(values.map(p => p[0])).toEqual(HOURS.map(h => at(h))); // hour starts; 06:00 (stopped) is not there
        expect(values.map(p => p[1])).toEqual(want.hourly.value);    // 05:00 = its 3 running rows, 07:00 = its 6
        const scoreChart = lastChart('Health score', from, true);
        const scores = pointsOf(scoreChart, 'Health score');
        expect(scores.map(p => p[0])).toEqual(HOURS.map(h => at(h)));  // the SAME index set as the chart above
        expect(scores.map(p => p[1])).toEqual(want.hourly.score);
        expect(text('chart-card-set-individual')).toContain('bar · 1 h average');
        expect(text('score-summary')).toBe('Lowest 100 on 2024/03/01 00:00:00 · below 80 for 0.0% of scored hours · 1-hour averages of the running rows');
        expect(bmw().getByTestId('score-shares').textContent).toContain('Share of scored hours');

        // the read-out: the hour START and that hour's average — never a row's own minute
        expect(await hoverTime(scoreChart, at(5, 10))).toBe('2024/03/01 05:00:00 · 1 h avg 70 bar · score 0');
        expect(await hoverTime(scoreChart, at(4, 20))).toBe('2024/03/01 04:00:00 · 1 h avg 55.5 bar · score 100'); // every row of that hour is far out; its mean is not
        expect(await hoverTime(setChart, at(7, 25))).toBe('2024/03/01 07:00:00 · 1 h avg 52.5 bar · score 100');
        for (const ms of [at(5, 50), at(6, 10), at(6, 55)]) expect(await hoverTime(scoreChart, ms)).not.toContain('06:00'); // the stopped hour is not a point

        // (No per-period tiles: the "Scoring results" card was removed 2026-10-12. The chart's subtitle and
        // the hover read-outs above are the page's numbers; the per-period block is checked in the file below.)
        expect(bmw().queryByTestId('test-results')).toBeNull();

        // ── Mark complete: the file and the record ──
        await markComplete();
        await waitFor(() => expect(bmw().getByTestId('save-ok')).toBeTruthy());
        const info = infoFile('V/INDV_INFO_V.json');
        const { validated_at, ...block } = info.validation;
        expect(typeof validated_at).toBe('string');
        expect(block).toStrictEqual(exportedBlock(want));
        // the model part of the file is the RAW training fit (48 rows): mean 55.5, the user's set points
        expect(info.model_metrics.mean).toBe(55.5);
        expect(info.model_metrics.setpoint_health_score).toEqual([20, 69]);
        expect(env.backend!.cmds('export_model_files').slice(-1)[0].args.request).toMatchObject({ ...request, workspace_id: WS });

        const saved = diskModel('i1');
        expect(saved.status).toBe(true);
        expect(saved.healthExport.scoringIntervalSecs).toBe(3600);
        expect(pill()).toBe('Complete');
        expect(bmw().queryByTestId('earlier-scoring')).toBeNull();
        expect(bmw().queryByTestId('mark-complete-again')).toBeNull();

        // ── close and reopen: still Complete, the record kept its interval, no "earlier scoring" hint ──
        await restartApp(OPTS);
        selectSensor('v');
        await settle(400);
        expect(pill()).toBe('Complete');
        await openHealth();
        await waitFor(() => expect(bmw().getByTestId('save-ok')).toBeTruthy());
        expect(bmw().queryByTestId('earlier-scoring')).toBeNull();
        expect(diskModel('i1').healthExport.scoringIntervalSecs).toBe(3600);
        expect(readDisk().failureGroupState.runningConditionTestPeriods).toEqual(S_WHOLE);
    });
});

describe('Clustering (2 clusters) on 5-minute data', () => {
    it('an hour in which the machine changed cluster — or a row has no criteria value, or is in no range — is a point with NO score: the read-out says "no score", "Lowest" never lands on it, a period with no cluster hour reads "No scored hours"; the INFO file carries the same block', async () => {
        const { request, expect: want } = fixture.cases.clustering;
        writeDisk(workspace(S_TWO, [CLU()]));
        await mountWindows(OPTS);
        selectSensor('x');
        await train();
        expect(pill()).toBe('Trained');
        await waitFor(() => expect(bmw().getByTestId('model-fit-clustering')).toBeTruthy());

        const from = env.charts.length;
        await openHealth();
        await waitFor(() => expect(bmw().getByTestId('score-summary')).toBeTruthy());
        const sent = lastPreview('clustering');
        expect(sent.args.request).toMatchObject(request);
        const answer = sent.result as any;
        expect(answer.series.total_points).toBe(want.series_total_points); // the raw rows are all still there for Model fit
        expect(answer.cluster_scatter.total).toBe(48);
        expect(answer.series.score).toBeNull();

        // the Clusters chart: one (mean x, mean y) per hour — [x, y, score, cluster]
        const clusters = lastChart('Points', from);
        const points = seriesOf(clusters, 'Points').data as (number | null)[][];
        expect(points).toHaveLength(HOURS.length);
        expect(points.map(p => [p[0], p[1]])).toEqual(want.hourly.x.map((x, i) => [x, want.hourly.y[i]]));
        expect(points.map(p => p[2])).toEqual(want.hourly.score);   // null for 04:00, 05:00, 07:00 — never 0
        expect(points.map(p => p[3])).toEqual(want.hourly.cluster);
        expect(points[5].slice(0, 2)).toEqual([34, 64]);             // the row with no criteria value still moved the hour's mean
        expect(text('chart-card-set-clustering')).toContain('1 h averages · coloured by score');

        // the score chart: a gap at the three unscored hours (they are not drawn as 0)
        const scoreChart = lastChart('Health score', from, true);
        const scores = pointsOf(scoreChart, 'Health score');
        expect(scores.map(p => p[0])).toEqual([0, 1, 2, 3, 8, 9].map(h => at(h)));
        expect(scores.map(p => p[1])).toEqual([100, 100, 100, 100, 100, 0]);

        // the read-out of a point
        const hoverPoint = async (i: number) => {
            await act(async () => { clusters.props.onEvents.mouseover({ seriesName: 'Points', dataIndex: i }); });
            return text('hs-readout');
        };
        expect(await hoverPoint(4)).toBe('2024/03/01 04:00:00 · no score'); // changed cluster inside the hour
        expect(await hoverPoint(5)).toBe('2024/03/01 05:00:00 · no score'); // a row with no criteria value
        expect(await hoverPoint(6)).toBe('2024/03/01 07:00:00 · no score'); // in no criteria range
        expect(await hoverPoint(7)).toBe('2024/03/01 08:00:00 · score 100');
        expect(await hoverPoint(8)).toBe('2024/03/01 09:00:00 · score 0');
        expect(bmwEl().textContent).not.toMatch(/not running/i);

        expect(text('score-summary')).toBe('Lowest 100 on 2024/03/01 00:00:00 · below 80 for 0.0% of scored hours · 1-hour averages of the running rows');

        // Mark complete is not blocked by unscored hours
        await markComplete();
        await waitFor(() => expect(bmw().getByTestId('save-ok')).toBeTruthy());
        const info = infoFile('Y/CLUS_INFO_X_Y.json');
        const { validated_at, ...block } = info.validation;
        expect(typeof validated_at).toBe('string');
        expect(block).toStrictEqual(exportedBlock(want));
        expect(Object.keys(block.tests[0])).not.toContain('inside_3sd_ring_pct'); // omitted, not null / 0
        expect(block.tests[1]).toMatchObject({ hours: 3, scored: 2, inside_3sd_ring_pct: 50 });
        expect(Object.keys(info.cluster_info)).toEqual(['1', '2']);
        expect(diskModel('c1').status).toBe(true);
        expect(diskModel('c1').healthExport.scoringIntervalSecs).toBe(3600);
        expect(bmw().queryByTestId('earlier-scoring')).toBeNull();
    });
});

describe('Relation model on 5-minute data', () => {
    const hourlyOf = (c: { result?: unknown }) => (c.result as any).hourly as { timestamps: string[]; residual: (number | null)[]; score: (number | null)[]; total_points: number };

    it('Train asks for the scoring periods once; Model fit stops at the training rows; the Health score page is hourly; removing / adding a scoring period afterwards never trains again; Mark complete writes the hourly block', async () => {
        writeDisk(workspace(S_TWO, [REL()]));
        await mountWindows(OPTS);
        selectSensor('t');
        await train();
        expect(pill()).toBe('Trained');
        await waitFor(() => expect(bmw().getByTestId('model-fit-relationship')).toBeTruthy());

        // ── Train: ONE engine run, and it was told the scoring periods (so their hours are predicted in that run) ──
        expect(trainsOfRelation()).toHaveLength(1);
        const trainCall = trainsOfRelation()[0];
        expect(trainCall.args.test_periods).toEqual(wire(S_TWO));
        const key = trainCall.args.cache_key as string;
        expect(key).toBe(`r1::${diskModel('r1').trainedFingerprint}`);

        // ── Model fit: raw TRAINING rows only — the time charts stop where training stops ──
        for (const name of ['Actual', 'Predicted', 'Residual']) {
            const pts = pointsOf(lastChart(name, 0, false), name);
            expect(pts, name).toHaveLength(48);
            expect(pts[1][0] - pts[0][0], name).toBe(5 * 60_000);
            expect(Math.max(...pts.map(p => p[0])), name).toBe(at(3, 55));
        }
        expect(env.charts.some(c => seriesOf(c, 'Health score'))).toBe(false);
        // ...so the scoring periods (both AFTER the training rows) have no line and no band on this page
        expect(stripOf(lastChart('Residual', 0, false))).toEqual(['TRAIN']);

        // ── Health score: hourly ──
        const from = env.charts.length;
        await openHealth();
        await waitFor(() => expect(bmw().getByTestId('score-summary')).toBeTruthy());
        // here too only the TRAIN period is shaded and named; the scoring periods' hours are on the line (below)
        expect(stripOf(lastChart('Health score', from, true))).toEqual(['TRAIN']);
        // an hourly point's tooltip is headed by its hour START, date and time
        expect(tipHeading(lastChart('Health score', from, true), at(4))).toBe('2024/03/01 04:00:00');
        expect(tipHeading(lastChart('Residual', from, true), at(7))).toBe('2024/03/01 07:00:00');
        let sent = lastPreview('relationship');
        expect(sent.args.request).toMatchObject({ kind: 'relationship', target: 'T', predictors: ['P'], cache_key: key, test_periods: wire(S_TWO) });
        expect((sent.result as any).series.total_points).toBe(48);
        expect(hourlyOf(sent).timestamps).toEqual(HOURS.map(h => `2024-03-01T${String(h).padStart(2, '0')}:00:00`));

        const residualChart = lastChart('Residual', from, true);
        const residuals = pointsOf(residualChart, 'Residual');
        expect(residuals.map(p => p[0])).toEqual(HOURS.map(h => at(h)));
        expect(residuals.map(p => p[1])).toEqual(hourlyOf(sent).residual);
        expect(residuals[4][1]).toBeCloseTo(5, 0);   // 04:00 reads ~5 above the model
        expect(residuals[6][1]).toBeCloseTo(-8, 0);  // 07:00 (6 running rows) reads ~8 below
        const scoreChart = lastChart('Health score', from, true);
        const scores = pointsOf(scoreChart, 'Health score');
        expect(scores.map(p => p[0])).toEqual(HOURS.map(h => at(h)));
        expect(scores.map(p => Math.round(p[1] as number))).toEqual([100, 100, 100, 100, 27, 100, 0, 100, 100]);
        expect(text('chart-card-set-relationship')).toContain('actual − predicted (kW) · 1 h average');
        expect(await hoverTime(scoreChart, at(4, 5))).toMatch(/^2024\/03\/01 04:00:00 · residual 5(\.\d+)? kW · score 27$/);

        // ── remove S2: nothing is trained, the same fit is scored again ──
        const fingerprint = diskModel('r1').trainedFingerprint;
        fireEvent.click(bmw().getByTestId('rc-card-open'));
        let modal = within(bmw().getByRole('dialog', { name: 'Running condition' }));
        await act(async () => { fireEvent.click(modal.getByLabelText('Remove scoring period 2')); });
        await act(async () => { fireEvent.click(modal.getByTestId('rc-apply')); });
        await waitFor(() => expect(readDisk().failureGroupState.runningConditionTestPeriods).toHaveLength(1));
        await waitFor(() => expect(lastPreview('relationship').args.request.test_periods).toEqual(wire(S_TWO.slice(0, 1))));
        await settle(400);
        sent = lastPreview('relationship');
        expect(sent.args.request.cache_key).toBe(key);
        expect(hourlyOf(sent).total_points).toBe(6); // hours 00:00–05:00; nothing after S1 is scored any more
        expect(trainsOfRelation()).toHaveLength(1);
        expect(diskModel('r1').trainedFingerprint).toBe(fingerprint);
        expect(pill()).toBe('Trained');
        await waitFor(() => expect(bmw().getByTestId('score-summary')).toBeTruthy());

        // ── add a period (08:00 → 09:59): again no training ──
        fireEvent.click(bmw().getByTestId('rc-card-open'));
        modal = within(bmw().getByRole('dialog', { name: 'Running condition' }));
        await act(async () => { fireEvent.click(modal.getByTestId('test-add')); });
        for (const [label, value] of [['Scoring period 2 start', '2024-03-01T08:00'], ['Scoring period 2 end', '2024-03-01T09:59']] as const) {
            const input = modal.getByLabelText(label);
            await act(async () => { fireEvent.change(input, { target: { value } }); fireEvent.blur(input); });
        }
        await act(async () => { fireEvent.click(modal.getByTestId('rc-apply')); });
        const added = [...wire(S_TWO.slice(0, 1)), { start: '2024-03-01T08:00', end: '2024-03-01T09:59' }];
        await waitFor(() => expect(lastPreview('relationship').args.request.test_periods).toEqual(added));
        await settle(400);
        sent = lastPreview('relationship');
        expect(sent.args.request.cache_key).toBe(key);
        expect(hourlyOf(sent).timestamps.slice(-2)).toEqual(['2024-03-01T08:00:00', '2024-03-01T09:00:00']);
        expect(hourlyOf(sent).total_points).toBe(8);
        expect(trainsOfRelation()).toHaveLength(1);
        expect(diskModel('r1').trainedFingerprint).toBe(fingerprint);
        expect(pill()).toBe('Trained');
        await waitFor(() => expect(bmw().getByTestId('score-summary')).toBeTruthy());
        // no request of the session asked Rust to RETRY a failed prediction: nothing had failed
        expect(env.backend!.cmds('compute_health_preview').some(c => c.args.request.retry_test_scoring)).toBe(false);
        expect(env.backend!.calls.filter(c => c.error).map(c => `${c.cmd}: ${c.error}`)).toEqual([]);

        // ── Mark complete ──
        if (!bmwEl().querySelector('[data-testid="set-points-card"]')) await openHealth();
        await markComplete();
        await waitFor(() => expect(bmw().getByTestId('save-ok')).toBeTruthy());
        const exported = env.backend!.cmds('export_model_files').slice(-1)[0];
        expect(exported.args.request).toMatchObject({ kind: 'relationship', cache_key: key, test_periods: added });
        const info = infoFile('T/REL_INFO_P_T.json');
        const preview = (lastPreview('relationship').result as any).test_validation;
        expect(Object.keys(info.validation).sort()).toEqual(['scoring_aggregation', 'scoring_interval_seconds', 'tested', 'tests', 'train', 'train_ranges', 'validated_at']);
        expect(info.validation).toMatchObject({ tested: true, scoring_interval_seconds: 3600, scoring_aggregation: 'mean' });
        expect(info.validation.tests).toEqual(preview.tests);     // hourly: what the page showed
        expect(info.validation.tests.map((t: any) => [t.rows, t.hours, t.scored])).toEqual([[15, 2, 2], [24, 2, 2]]);
        expect(info.validation.train).toMatchObject({ rows: 48, hours: 4 }); // the train block stays the raw fit
        expect(Object.keys(info.validation.train)).toEqual(expect.arrayContaining(['r2', 'rmse', 'residual_mean', 'residual_sd']));
        expect(diskModel('r1').status).toBe(true);
        expect(diskModel('r1').healthExport.scoringIntervalSecs).toBe(3600);
        expect(bmw().queryByTestId('earlier-scoring')).toBeNull();
    });

    it('with NO scoring period the health score is still calculated; when the engine does not answer, the "Health score" card says so with "Try again" — which reaches Rust as retry_test_scoring on exactly one request', async () => {
        const FAILED = 'The health score could not be calculated because the Relation model engine did not answer. The model fit is not affected - try again, or train the model again.';
        writeDisk(workspace([], [REL()]));
        await mountWindows(OPTS);
        // Rust's answer while the engine has not answered: the fit is fine (`valid`), every hourly
        // score is null, the summary is empty, one WARNING — and no `test_validation` (no period).
        env.backend!.override('compute_health_preview', a => a?.request?.kind === 'relationship' && !a.request.retry_test_scoring, async (_a, real) => {
            const res = await real() as any;
            const n = res.hourly.total_points as number;
            return {
                ...res,
                validation: [...res.validation, { code: 'test_scoring_failed', severity: 'warning', field: 'test_periods', message: FAILED }],
                hourly: { ...res.hourly, predicted: res.hourly.predicted.map(() => null), residual: res.hourly.residual.map(() => null), score: res.hourly.score ? res.hourly.score.map(() => null) : null },
                score_summary: res.score_summary ? { scored: 0, unscored: n, total_rows: n, min_score: null, pct_below_80: null, share_80_100: null, share_40_80: null, share_0_40: null, share_basis: 'hour_count' } : null,
            };
        }, false);
        selectSensor('t');
        await train();
        expect(pill()).toBe('Trained');
        // Train sent no scoring period — and the model is trained all the same
        expect(trainsOfRelation()).toHaveLength(1);
        expect(trainsOfRelation()[0].args.test_periods ?? null).toBeNull();

        const from = env.charts.length;
        await openHealth();
        const failed = await waitFor(() => bmw().getByTestId('score-failed'));
        expect(failed.textContent).toContain('The health score could not be calculated — try again');
        expect(failed.textContent).toContain('the Relation model engine did not answer');
        expect(bmwEl().textContent).not.toMatch(/LinearGAM|sidecar/i);
        expect(bmw().queryByTestId('score-locked')).toBeNull();
        expect(bmw().queryByTestId('test-results')).toBeNull();
        expect(env.charts.slice(from).some(c => seriesOf(c, 'Health score'))).toBe(false);
        expect(lastPreview('relationship').args.request.test_periods ?? null).toBeNull();
        expect(env.backend!.cmds('compute_health_preview').some(c => c.args.request.retry_test_scoring)).toBe(false);

        // Try again
        await act(async () => { fireEvent.click(within(failed).getByTestId('test-scoring-retry')); });
        await waitFor(() => expect(bmw().queryByTestId('score-failed')).toBeNull());
        await waitFor(() => expect(bmw().getByTestId('score-summary')).toBeTruthy());
        const retried = env.backend!.cmds('compute_health_preview').filter(c => c.args.request.retry_test_scoring === true);
        expect(retried).toHaveLength(1);
        expect(retried[0].args.request).toMatchObject({ kind: 'relationship', cache_key: trainsOfRelation()[0].args.cache_key });
        // the health score of the TRAINING hours, with no scoring period at all
        const scores = pointsOf(lastChart('Health score', from, true), 'Health score');
        expect(scores.map(p => p[0])).toEqual([0, 1, 2, 3].map(h => at(h)));
        expect(scores.map(p => p[1])).toEqual([100, 100, 100, 100]);
        expect(text('score-summary')).toBe('Lowest 100 on 2024/03/01 00:00:00 · below 80 for 0.0% of scored hours · 1-hour averages of the running rows');
        // a later request (a set point edit) does not keep asking for a retry
        const lower = bmw().getByTestId('sp-residual_at_0_lower');
        await act(async () => { fireEvent.change(lower, { target: { value: '-7' } }); fireEvent.blur(lower); });
        await settle(400);
        expect(env.backend!.cmds('compute_health_preview').filter(c => c.args.request.retry_test_scoring === true)).toHaveLength(1);
        expect(trainsOfRelation()).toHaveLength(1);
    });
});

describe('a scoring period that starts INSIDE an hour (04:30)', () => {
    const request = { ...fixture.cases.individual.request, test_periods: [{ start: '2024-03-01T04:30', end: '2024-03-01T09:59' }] };
    const ask = () => createFakeHealthRust({ datasets: { five: DATA } }).invoke('compute_health_preview', { request }) as Promise<any>;

    it('that hour is still ONE point, labelled with the hour START (04:00 — half an hour before the period), averaging only the rows inside the period', async () => {
        const p = await ask();
        expect(p.hourly.timestamps[4]).toBe('2024-03-01T04:00:00');
        expect(p.hourly.rows[4]).toBe(54);       // its first row inside the period: 04:30
        expect(p.hourly.value[4]).toBe(55.5);    // rows 04:30 … 04:55 only
        expect(p.test_validation.tests[0]).toMatchObject({ start: '2024-03-01T04:30', rows: 39, hours: 5, scored: 5 });
        // rows 04:00 … 04:25 are in neither period: not raw rows of this model either
        expect(p.series.total_points).toBe(48 + 39);
    });

    // A period that starts inside an hour (04:30): its first hourly point sits at the hour start
    // (04:00), before the period's own start. The Health score page reads its periods from the hour
    // start (`hourlyScopes`), so that point is inside the scoring period and on the line — with the raw
    // range it stood alone between two cuts of a symbol-less line and was not drawn at all. (The
    // scoring period itself is not shaded; its range still decides where the line runs.)
    it('the score of that hour is visible on the score chart (not a lone point of a symbol-less line)', async () => {
        const p = await ask();
        const option = buildScoreOption(p.hourly.timestamps, p.hourly.score, hourlyScopes(scopesOf(p.test_validation))) as any;
        const line = (option.series as any[]).find(s => s.name === 'Health score');
        const data = line.data as [number, number | null][];
        const i = data.findIndex(d => d[0] === at(4));
        expect(i).toBeGreaterThan(0);
        expect(data[i][1]).toBe(100);
        const alone = data[i - 1][1] === null && data[i + 1][1] === null;
        const drawsLonePoints = line.showSymbol !== false && line.symbol !== 'none';
        expect(alone && !drawsLonePoints).toBe(false);
    });
});
