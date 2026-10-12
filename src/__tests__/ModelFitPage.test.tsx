import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';

vi.mock('../components/charts/ResponsiveECharts', () => ({
    default: (props: any) => (
        <div
            data-testid="echarts-mock"
            data-series={(props.option?.series ?? []).map((s: any) => s.name).join('|')}
            data-x-axis-name={props.option?.xAxis?.name ?? ''}
            data-y-axis-name={props.option?.yAxis?.name ?? ''}
            // the names in the strip above the plot (the TRAIN periods — a scoring period is not drawn), in band order
            data-strip={((props.option?.series ?? []).find((s: any) => s.name === '__scopes')?.markArea?.data ?? []).filter((a: any) => a[0].label.show).map((a: any) => a[0].label.formatter).join('|')}
            // every band drawn under the data, by name (a band whose name is left off the strip is still listed)
            data-bands={((props.option?.series ?? []).find((s: any) => s.name === '__scopes')?.markArea?.data ?? []).map((a: any) => a[0].name).join('|')}
            // the first data line of a time chart: how many of its points carry a value, and how many gaps cut it
            data-line-points={((props.option?.series?.[0]?.data ?? []) as any[]).filter(p => Array.isArray(p) && p.length === 2 && p[1] !== null).length}
            data-line-gaps={((props.option?.series?.[0]?.data ?? []) as any[]).filter(p => Array.isArray(p) && p.length === 2 && p[1] === null).length}
            // a data line named ON the plot (an ECharts end label) — there must be none: it does not follow a zoom
            data-end-labels={(props.option?.series ?? []).filter((s: any) => s.endLabel).map((s: any) => s.name).join('|')}
            // the ring levels named on a Clusters chart
            data-ring-labels={((props.option?.series ?? []).find((s: any) => s.name === 'Ring labels')?.data ?? []).map((x: any) => x.label.formatter).join('|')}
        />
    ),
}));
// The Fit chart's X selector is the REAL shared compact single picker;
// its own behaviour is tested in SensorPicker.test.tsx.

import ModelFitPage, { outsideText } from '../components/windows/workbench/ModelFitPage';
import { SensorMetaProvider } from '../components/sensor/SensorLabel';
import { openPickerSurface, pickSingle, pickerRows, rowTag } from './helpers/sensorPicker';
import { makeHealthPreview } from './helpers/healthPreviewFixture';
import { makeTestResult, makeValidation } from './helpers/validationFixture';
import type { UseHealthPreviewResult } from '../hooks/useHealthPreview';
import type { FailureModel } from '../types';

afterEach(() => {
    cleanup();
    document.getElementById('wizard-portal-root')?.remove();
});

// The Build Model window's SensorMetaProvider supplies the labels: description "Label of TAG".
const META = ['T1', 'A', 'B', 'X1', 'Y1', 'LOAD'].map(tag => ({ tag, description: `Label of ${tag}`, unit: '', component: '' }));

const model = (over: Record<string, any> = {}) => ({
    id: 'm1', kind: 'individual', targetSensor: 'T1', predictorSensors: [], xSensor: '', ySensor: '', ...over,
}) as unknown as FailureModel;

const idle: UseHealthPreviewResult = { data: null, loading: false, error: null, errorCode: null, notFitted: false, needsRetrain: false, idle: null };

function page(m: FailureModel, req: Record<string, any>, over: Record<string, any> = {}) {
    const data = makeHealthPreview({ kind: m.kind, ...req });
    const props = {
        model: m, stale: false, preview: { ...idle, data }, unit: '°C', data,
        onXPredictorChange: vi.fn(), onCompare: vi.fn(),
        ...over,
    };
    render(<SensorMetaProvider metadata={META}><ModelFitPage {...props} /></SensorMetaProvider>);
    return props;
}

const chartOf = (id: string) => within(screen.getByTestId(`chart-card-${id}`)).getByTestId('echarts-mock');
/** Text of the legend row under a card's chart, or null when the card has none. */
const legendOf = (id: string) => screen.getByTestId(`chart-card-${id}`).querySelector('.wb2-legend')?.textContent ?? null;
/** One KPI tile, part by part (`unit` is null when the tile prints none). */
const tile = (id: string) => {
    const el = screen.getByTestId(id);
    const value = el.querySelector('.wb3-kpi-v')!;
    const unit = value.querySelector('.wb3-kpi-u')?.textContent ?? null;
    return {
        label: el.querySelector('.wb3-kpi-l')!.textContent,
        value: unit === null ? value.textContent : value.textContent!.slice(0, -unit.length),
        unit,
        sub: el.querySelector('.wb3-kpi-s')?.textContent ?? null,
    };
};
/** The tiles of a strip, left to right: their test ids / their labels. */
const tileIds = (strip: HTMLElement) => [...strip.children].map(c => c.getAttribute('data-testid'));
const tileLabels = (strip: HTMLElement) => [...strip.querySelectorAll('.wb3-kpi-l')].map(l => l.textContent);

describe('ModelFitPage — Individual', () => {
    // The health score is computed on hourly means (`hourly`); this page is the raw / training
    // view and must never read them.
    it('reads the raw series only: it draws the same charts with no `hourly` in the preview at all', () => {
        for (const kind of ['individual', 'relationship', 'clustering'] as const) {
            const m = model(kind === 'individual' ? {} : kind === 'relationship' ? { kind, predictorSensors: ['A'] } : { kind, xSensor: 'T1', ySensor: 'A' });
            const data = { ...makeHealthPreview({ kind, target: 'T1', predictors: ['A'], n_clusters: 1 }), hourly: undefined as never };
            page(m, {}, { data, preview: { ...idle, data } });
            expect(screen.getByTestId(`model-fit-${kind}`).querySelectorAll('[data-testid="echarts-mock"]').length).toBeGreaterThan(0);
            cleanup();
        }
    });

    // Workbench detail pages v2, SPEC §5: the tiles first, then both charts at full width.
    it('has the KPI strip, then the full-width (taller) value chart and the full-width Distribution chart — no statistics card', () => {
        page(model(), { target: 'T1' });
        const board = screen.getByTestId('model-fit-individual');
        expect([...board.children].map(c => c.getAttribute('data-testid'))).toEqual(['fit-kpis', 'chart-card-ts', 'chart-card-dist']);
        // one column; `wb2-board--ind` is also what makes the value chart taller (App.css)
        expect(board.className).toBe('wb2-board wb2-board--ind');
        expect(screen.queryByTestId('fit-side')).toBeNull();
        expect(screen.queryByTestId('stats-card')).toBeNull();
        expect(board.querySelector('table')).toBeNull();
        expect(board.textContent).not.toMatch(/Statistics/);
        expect(screen.getByTestId('chart-card-ts').className).toMatch(/(^| )wb2-full( |$)/);
        expect(screen.getByTestId('chart-card-ts').className).toMatch(/wb2-card--tall/);
        expect(screen.getByTestId('chart-card-dist').className).toMatch(/(^| )wb2-full( |$)/);
        expect(within(screen.getByTestId('chart-card-ts')).getByTestId('echarts-mock').getAttribute('data-series')).toBe('Value');
        expect(within(screen.getByTestId('chart-card-dist')).getByTestId('echarts-mock').getAttribute('data-series')).toBe('Rows|Normal curve');
    });

    it('the strip has exactly three tiles — Mean, SD (with the ±1SD range) and Outside ±3SD (share, estimated rows, the ±3SD range)', () => {
        page(model(), { target: 'T1' });
        const strip = screen.getByTestId('fit-kpis');
        expect(strip.className).toBe('wb3-kpis wb3-kpis--fit');
        expect(tileIds(strip)).toEqual(['stat-mean', 'stat-sd', 'stat-outside3']);
        // the app's ONE formatter for computed values: up to 3 decimals, never padded
        expect(tile('stat-mean')).toEqual({ label: 'Mean', value: '5', unit: '°C', sub: 'learned normal' });
        expect(tile('stat-sd')).toEqual({ label: 'SD', value: '1', unit: '°C', sub: '±1SD 4 – 6' });
        // the fixture's bins: 10 rows in 0–2 and 10 rows in 8–10 lie outside 2 … 8 → 20 of 1,000
        expect(tile('stat-outside3')).toEqual({ label: 'Outside ±3SD', value: '2.00%', unit: null, sub: '≈ 20 rows · ±3SD 2 – 8' });
        // the row count is an estimate from the bins: the tile says so on hover (the old table row's tooltip)
        expect(screen.getByTestId('stat-outside3').getAttribute('title')).toBe('Estimated from the distribution bins');
    });

    it('no "Training rows" tile and no "Trained" tile; the row count is not an item of its own', () => {
        page(model(), { target: 'T1' });
        const strip = screen.getByTestId('fit-kpis');
        expect(screen.queryByTestId('stat-rows')).toBeNull();
        expect(tileLabels(strip)).toEqual(['Mean', 'SD', 'Outside ±3SD']);
        expect(strip.textContent).not.toMatch(/Training rows|Trained|1,000/);
    });

    it('a share outside ±3SD that is not zero never reads "0.00%"; no row outside reads "0.00%"', () => {
        // 1 row outside of 1,000,000: 0.0001%
        const tiny = { ...makeHealthPreview({ kind: 'individual' }) };
        tiny.stats = { ...(tiny.stats as any), rows: 1_000_000 };
        tiny.histogram = { bin_edges: [0, 2, 4, 6, 8, 10], counts: [1, 0, 999_999, 0, 0], curve: [0, 0, 0, 0, 0], bin_width: 2, n: 1_000_000 };
        render(<ModelFitPage model={model()} stale={false} preview={{ ...idle, data: tiny }} unit="" data={tiny} onXPredictorChange={() => {}} onCompare={() => {}} />);
        expect(tile('stat-outside3')).toMatchObject({ value: '< 0.01%', sub: '≈ 1 row · ±3SD 2 – 8' });
        cleanup();
        const none = { ...makeHealthPreview({ kind: 'individual' }) };
        none.histogram = { bin_edges: [0, 2, 4, 6, 8, 10], counts: [0, 0, 1000, 0, 0], curve: [0, 0, 0, 0, 0], bin_width: 2, n: 1000 };
        render(<ModelFitPage model={model()} stale={false} preview={{ ...idle, data: none }} unit="" data={none} onXPredictorChange={() => {}} onCompare={() => {}} />);
        expect(tile('stat-outside3')).toMatchObject({ value: '0.00%', sub: '≈ 0 rows · ±3SD 2 – 8' });
        expect(outsideText(0.004)).toBe('< 0.01%');
        expect(outsideText(0.27)).toBe('0.27%');
        expect(outsideText(0)).toBe('0.00%');
    });

    it('without a unit a tile prints no unit', () => {
        page(model(), { target: 'T1' }, { unit: '' });
        expect(tile('stat-mean')).toMatchObject({ value: '5', unit: null });
        expect(screen.getByTestId('fit-kpis').querySelector('.wb3-kpi-u')).toBeNull();
    });

    it('without a histogram the Distribution card says so instead of drawing, and the Outside ±3SD tile is a dash', () => {
        const data = { ...makeHealthPreview({ kind: 'individual' }), histogram: null };
        render(<ModelFitPage model={model()} stale={false} preview={{ ...idle, data }} unit="" data={data} onXPredictorChange={() => {}} onCompare={() => {}} />);
        expect(within(screen.getByTestId('chart-card-dist')).queryByTestId('echarts-mock')).toBeNull();
        expect(screen.getByText('No distribution for this scope')).toBeTruthy();
        expect(tile('stat-outside3')).toEqual({ label: 'Outside ±3SD', value: '—', unit: null, sub: 'no distribution' });
    });

    it('stale: every chart is "Out of date" (the tiles stay, as the statistics did)', () => {
        page(model(), { target: 'T1' }, { stale: true });
        expect(screen.getAllByTestId('chart-outdated')).toHaveLength(2);
        expect(tileIds(screen.getByTestId('fit-kpis'))).toHaveLength(3);
    });

    // workbench-redesign SPEC §3: no legend row where the lines are labelled on the chart.
    it('the value chart has NO legend row (±1SD / ±3SD are named on the chart); Distribution keeps only "Rows" and "Normal curve"', () => {
        page(model(), { target: 'T1' });
        expect(legendOf('ts')).toBeNull();
        expect(legendOf('dist')).toBe('RowsNormal curve');
        expect(screen.getByTestId('chart-card-dist').textContent).not.toMatch(/±1SD|±3SD/);
        // the card names its lines once, in the subtitle sentence — nowhere else (no "Value" key either)
        const card = screen.getByTestId('chart-card-ts');
        const sub = card.querySelector('.wb2-card-s')!.textContent!;
        expect(card.textContent!.replace(sub, '')).not.toMatch(/±1SD|±3SD|Value/);
    });

    it('the subtitles say what the chart shows: every running row without scoring periods and what the two colours mean; "rows per value" for Distribution', () => {
        page(model(), { target: 'T1' });
        expect(screen.getByTestId('chart-card-ts').querySelector('.wb2-card-s')!.textContent)
            .toBe('°C · running rows · green = within ±1SD (score 100) · amber dashes = ±3SD (score 80)');
        expect(screen.getByTestId('chart-card-dist').querySelector('.wb2-card-s')!.textContent).toBe('°C · rows per value');
    });

    it('tiles never judge: no tile of any kind carries a tone, and the page prints no verdict on the fit', () => {
        for (const kind of ['individual', 'relationship', 'clustering'] as const) {
            const m = model(kind === 'individual' ? {} : kind === 'relationship' ? { kind, predictorSensors: ['A'] } : { kind, xSensor: 'X1', ySensor: 'Y1' });
            // a poor fit on purpose: nothing may turn amber or call it weak
            const base = makeHealthPreview({ kind, target: 'T1', predictors: ['A'], n_clusters: 2, criteria_sensor: 'LOAD' });
            const data = kind === 'relationship' ? { ...base, stats: { ...(base.stats as any), r2: 0.12 } } : base;
            page(m, {}, { data, preview: { ...idle, data } });
            const board = screen.getByTestId(`model-fit-${kind}`);
            const tiles = [...board.querySelectorAll('.wb3-kpi')];
            expect(tiles).toHaveLength(3);
            expect(tiles.map(t => t.className)).toEqual(['wb3-kpi', 'wb3-kpi', 'wb3-kpi']);
            expect(board.querySelector('.wb3-kpis')!.textContent).not.toMatch(/good|fair|weak|poor|strong|excellent|low fit|high fit/i);
            cleanup();
        }
    });
});

describe('ModelFitPage — Relationship', () => {
    const rel = () => model({ kind: 'relationship', targetSensor: 'T1', predictorSensors: ['A', 'B'] });

    it('KPI strip first, then Fit, Target vs predicted and a full-width Residual over time — no residual distribution, no histogram', () => {
        page(rel(), { target: 'T1', predictors: ['A', 'B'] });
        const board = screen.getByTestId('model-fit-relationship');
        expect([...board.children].map(c => c.getAttribute('data-testid'))).toEqual(['rel-stats', 'chart-card-fit', 'chart-card-tvp', 'chart-card-res']);
        expect(screen.getByTestId('chart-card-res').className).toMatch(/wb2-full/);
        expect(screen.queryByTestId('chart-card-dist')).toBeNull();
        expect(screen.queryByText(/Distribution/i)).toBeNull();
        expect(screen.queryByText(/histogram/i)).toBeNull();
    });

    // Workbench detail pages v2, SPEC §5: three tiles; 2RMSE and the residual mean are captions.
    it('the strip has exactly three tiles — R², RMSE (with ±2RMSE) and Residual SD (with the residual mean)', () => {
        page(rel(), { target: 'T1', predictors: ['A', 'B'] });
        const strip = screen.getByTestId('rel-stats');
        expect(strip.className).toBe('wb3-kpis wb3-kpis--fit');
        expect(tileIds(strip)).toEqual(['stat-r2', 'stat-rmse', 'stat-res-sd']);
        expect(tile('stat-r2')).toEqual({ label: 'R²', value: '0.912', unit: null, sub: 'of the training rows' });
        expect(tile('stat-rmse')).toEqual({ label: 'RMSE', value: '0.457', unit: '°C', sub: '±2RMSE 0.913 = the score-100 band' });
        expect(tile('stat-res-sd')).toEqual({ label: 'Residual SD', value: '0.4', unit: '°C', sub: 'mean 0.012' });
    });

    it('no "Training rows" / "Trained" tile; Rows, Predictors, 2RMSE and Residual mean are not items of their own', () => {
        page(rel(), { target: 'T1', predictors: ['A', 'B'] });
        const strip = screen.getByTestId('rel-stats');
        for (const id of ['stat-rows', 'stat-predictors', 'stat-2rmse', 'stat-res-mean']) expect(screen.queryByTestId(id)).toBeNull();
        expect(tileLabels(strip)).toEqual(['R²', 'RMSE', 'Residual SD']);
        // the fixture trained on 321 rows with 2 predictors: neither number is on the strip
        expect(strip.textContent).not.toMatch(/Training rows|Trained|Rows|Predictors|321/);
    });

    it('Fit draws Actual and Relation model; Target vs predicted draws Actual and Predicted; Residual draws one series', () => {
        page(rel(), { target: 'T1', predictors: ['A', 'B'] });
        const series = (id: string) => within(screen.getByTestId(`chart-card-${id}`)).getByTestId('echarts-mock').getAttribute('data-series');
        expect(series('fit')).toBe('Actual|Relation model');
        expect(series('tvp')).toBe('Actual|Predicted');
        expect(series('res')).toBe('Residual');
    });

    it('the X selector lists the fitted predictors, shows the plotted one and reports a change', () => {
        const p = page(rel(), { target: 'T1', predictors: ['A', 'B'], x_predictor: 'B' });
        const trigger = within(screen.getByTestId('fit-x-selector')).getByRole('button', { name: 'X sensor' });
        expect(trigger.classList.contains('pk-trigger--sm')).toBe(true);
        expect(rowTag(trigger)).toBe('B');
        expect(within(screen.getByTestId('chart-card-fit')).getByTestId('echarts-mock').getAttribute('data-x-axis-name')).toBe('B');
        fireEvent.click(trigger);
        expect(openPickerSurface().querySelector('.pk-scope')?.textContent).toBe('Predictors of this model · 2');
        expect(pickerRows().map(rowTag)).toEqual(['A', 'B']);
        fireEvent.click(trigger); // close
        pickSingle(trigger, 'A');
        expect(p.onXPredictorChange).toHaveBeenCalledWith('A');
    });

    it('with ONE predictor the X selector is disabled, still shows its value, and gives the reason in a tooltip', () => {
        page(rel(), { target: 'T1', predictors: ['A'], x_predictor: 'A' });
        const trigger = within(screen.getByTestId('fit-x-selector')).getByRole('button', { name: 'X sensor' }) as HTMLButtonElement;
        expect(trigger.disabled).toBe(true);
        expect(rowTag(trigger)).toBe('A');
        expect(trigger.getAttribute('title')).toBe('Only one predictor — nothing else to plot on X');
    });

    it('the Fit card subtitle names the target with the muted Inline label (no brackets)', () => {
        page(rel(), { target: 'T1', predictors: ['A', 'B'] });
        const sub = within(screen.getByTestId('chart-card-fit')).getByText('predictor vs', { exact: false });
        expect(sub.textContent).toBe('predictor vs Label of T1T1');
        expect(sub.querySelector('.sl--muted')).toBeTruthy();
    });

    it('"Compare predictors" opens the comparison', () => {
        const p = page(rel(), { target: 'T1', predictors: ['A', 'B'] });
        fireEvent.click(screen.getByTestId('compare-predictors'));
        expect(p.onCompare).toHaveBeenCalledTimes(1);
    });

    // These read through the Workbench's own older formatter, which
    // printed a non-zero value below 0.0005 as "0.000" (the app's rule: never show a non-zero as 0).
    it('a tiny non-zero statistic never reads as zero: "0.0002", not "0.000"', () => {
        const base = makeHealthPreview({ kind: 'relationship', target: 'T1', predictors: ['A'] });
        const data = { ...base, stats: { ...(base.stats as any), residual_mean: 0.0002, residual_sd: 0.00004567, rmse: 1234.5678, two_rmse: -0 } };
        render(<ModelFitPage model={rel()} stale={false} preview={{ ...idle, data }} unit="" data={data} onXPredictorChange={() => {}} onCompare={() => {}} />);
        expect(tile('stat-res-sd').sub).toBe('mean 0.0002');
        expect(tile('stat-res-sd').value).toBe('0.0000457'); // 3 significant digits
        expect(tile('stat-rmse').value).toBe('1,234.568'); // not rounded to "1,235"
        expect(tile('stat-rmse').sub).toBe('±2RMSE 0 = the score-100 band'); // a negative zero reads "0"
    });

    it('stale: all three charts are "Out of date"', () => {
        page(rel(), { target: 'T1', predictors: ['A', 'B'] }, { stale: true });
        expect(screen.getAllByTestId('chart-outdated')).toHaveLength(3);
    });

    // "Actual" / "Predicted" drawn at the line ends did not follow
    // their lines through a wheel-zoom or a drag (a name could end up beside the OTHER line), and
    // with the legend gone they were the only key. The card now keeps a fixed two-item colour key.
    it('Target vs predicted keeps a fixed "Actual" / "Predicted" colour key under the chart, and draws NO name on the plot', () => {
        page(rel(), { target: 'T1', predictors: ['A', 'B'] });
        expect(legendOf('tvp')).toBe('ActualPredicted');
        const key = [...screen.getByTestId('chart-card-tvp').querySelectorAll('.wb2-legend .wb2-lg')];
        expect(key.map(k => k.textContent)).toEqual(['Actual', 'Predicted']);
        // each name next to a LINE swatch of its series' colour (blue = actual, red = predicted)
        const swatch = key.map(k => k.querySelector('i')!);
        expect(swatch.map(i => i.className)).toEqual(['', '']); // a line, not the square of a point colour
        expect(swatch.map(i => i.style.borderColor)).toEqual(['rgb(111, 158, 232)', 'rgb(238, 90, 69)']);
        // the chart itself carries the two series and nothing that a zoom could misplace
        expect(chartOf('tvp').getAttribute('data-series')).toBe('Actual|Predicted');
        expect(chartOf('tvp').getAttribute('data-end-labels')).toBe('');
    });

    it('the key survives the expanded copy of the chart (the only place the two lines are named)', () => {
        page(rel(), { target: 'T1', predictors: ['A', 'B'] });
        fireEvent.click(screen.getByTestId('chart-expand-tvp'));
        const overlay = screen.getByTestId('chart-overlay-tvp');
        expect(overlay.querySelector('.wb2-legend')!.textContent).toBe('ActualPredicted');
    });

    it('Residual has no legend row (its ±2RMSE lines are named on the chart); Fit keeps its two point colours', () => {
        page(rel(), { target: 'T1', predictors: ['A', 'B'] });
        expect(legendOf('res')).toBeNull();
        expect(chartOf('res').getAttribute('data-end-labels')).toBe('');
        expect(legendOf('fit')).toBe('ActualRelation model'); // points, not labelled lines
        expect(chartOf('fit').getAttribute('data-end-labels')).toBe('');
    });

    it('never names the algorithm on the page', () => {
        page(rel(), { target: 'T1', predictors: ['A', 'B'] });
        expect(screen.getByTestId('model-fit-relationship').textContent).not.toMatch(/GAM/i);
    });
});

describe('ModelFitPage — Clustering', () => {
    const clu = () => model({ kind: 'clustering', targetSensor: '', xSensor: 'X1', ySensor: 'Y1' });

    // User decision 2026-10-11: the whole right-hand column is gone (the "Clusters" summary card —
    // rows / centre per cluster, "In no range" — and the "Train and scoring periods" card under it).
    it('the cluster scatter with its rings is the board\'s ONLY card and spans its full width, under the KPI strip — no summary card, no side column', () => {
        page(clu(), { n_clusters: 2, criteria_sensor: 'LOAD' });
        const board = screen.getByTestId('model-fit-clustering');
        expect([...board.children].map(c => c.getAttribute('data-testid'))).toEqual(['cl-stats', 'chart-card-cl']);
        expect([...board.querySelectorAll('section')].map(c => c.getAttribute('data-testid'))).toEqual(['chart-card-cl']);
        // full width: the board's two-column grid with the card spanning every column
        // (not the "chart + 350px side column" grid it had while the side column existed)
        expect(board.className).toBe('wb2-board wb2-g2');
        expect(screen.getByTestId('chart-card-cl').className).toMatch(/(^| )wb2-full( |$)/);
        expect(screen.getByTestId('chart-card-cl').className).toMatch(/wb2-card--xtall/);
        const series = within(screen.getByTestId('chart-card-cl')).getByTestId('echarts-mock').getAttribute('data-series')!;
        expect(series).toMatch(/Cluster 1/);
        expect(series).toMatch(/Cluster 2 3× SD/);
        expect(screen.queryByTestId('cluster-summary')).toBeNull();
        expect(screen.queryByTestId('fit-side')).toBeNull();
        expect(screen.queryByTestId('cluster-row-1')).toBeNull();
        expect(board.querySelector('table')).toBeNull();
        // none of the summary card's own words are left on the page: no per-cluster centre, no "In no range" row
        expect(board.textContent).not.toMatch(/centre|In no range/);
    });

    // Workbench detail pages v2, SPEC §5.
    it('the strip has exactly three tiles — Clusters (split by the criteria sensor), In a cluster % and Inside 3× SD %', () => {
        const data = { ...makeHealthPreview({ kind: 'clustering', n_clusters: 2, criteria_sensor: 'LOAD' }), test_validation: makeValidation() };
        page(clu(), {}, { data, preview: { ...idle, data } });
        const strip = screen.getByTestId('cl-stats');
        expect(strip.className).toBe('wb3-kpis wb3-kpis--fit');
        expect(tileIds(strip)).toEqual(['stat-clusters', 'stat-assigned', 'stat-inside3']);
        // "split by" names the criteria sensor with the shared muted Inline label (description, then tag)
        expect(tile('stat-clusters')).toEqual({ label: 'Clusters', value: '2', unit: null, sub: 'split by Label of LOADLOAD' });
        expect(screen.getByTestId('stat-clusters').querySelector('.wb3-kpi-s .sl--muted')).toBeTruthy();
        // the fixture: 95 of 100 rows fall in a criteria range, 5 in none
        expect(tile('stat-assigned')).toEqual({ label: 'In a cluster', value: '95.0%', unit: null, sub: '5 rows outside every criteria range' });
        // the train block of the preview (makeValidation): 98.9% of the training rows inside the 3× SD ring
        expect(tile('stat-inside3')).toEqual({ label: 'Inside 3× SD', value: '98.9%', unit: null, sub: 'of the training rows · score ≥ 80' });
        expect(tileLabels(strip)).not.toContain('Training rows');
        expect(strip.textContent).not.toMatch(/Training rows|Trained/);
    });

    it('one cluster has no criteria sensor: the Clusters tile says so; without the train block "Inside 3× SD" is a dash', () => {
        page(clu(), { n_clusters: 1 });
        expect(tile('stat-clusters')).toEqual({ label: 'Clusters', value: '1', unit: null, sub: 'one cluster · no criteria sensor' });
        // Rust sends `test_validation` only with scoring periods
        expect(tile('stat-inside3')).toMatchObject({ value: '—', sub: 'of the training rows · score ≥ 80' });
    });

    it('a share that is not zero never reads "0.0%" (the shared `shareText`): "< 0.1%"; a single row outside is "1 row"', () => {
        const base = makeHealthPreview({ kind: 'clustering', n_clusters: 2, criteria_sensor: 'LOAD' });
        const data = {
            ...base,
            stats: { ...(base.stats as any), rows: 100_000, assigned_rows: 50, unassigned_rows: 99_950 },
            test_validation: makeValidation({ train: { ...makeValidation().train, inside_3sd_ring_pct: 0.04 } }),
        };
        page(clu(), {}, { data, preview: { ...idle, data } });
        expect(tile('stat-assigned')).toMatchObject({ value: '< 0.1%', sub: '99,950 rows outside every criteria range' });
        expect(tile('stat-inside3').value).toBe('< 0.1%');
        cleanup();
        // nothing at all in a cluster is a real zero; no training row = no share to print
        const zero = { ...base, stats: { ...(base.stats as any), rows: 10, assigned_rows: 0, unassigned_rows: 10 } };
        page(clu(), {}, { data: zero, preview: { ...idle, data: zero } });
        expect(tile('stat-assigned').value).toBe('0.0%');
        cleanup();
        const one = { ...base, stats: { ...(base.stats as any), rows: 0, assigned_rows: 0, unassigned_rows: 1 } };
        page(clu(), {}, { data: one, preview: { ...idle, data: one } });
        expect(tile('stat-assigned')).toMatchObject({ value: '—', sub: '1 row outside every criteria range' });
    });

    // A name drawn on the chart is the ONLY key
    // only on a chart that cannot zoom or pan. The Clusters chart zooms on both axes and a
    // ring's name leaves the view with the ring's edge — so the rings also get a fixed key.
    it('the rings are named on the chart, once per level, AND in a fixed key under it (the chart zooms and pans)', () => {
        page(clu(), { n_clusters: 2 });
        expect(chartOf('cl').getAttribute('data-ring-labels')).toBe('1× SD|3× SD');
        const key = screen.getByTestId('ring-key');
        expect(screen.getByTestId('chart-card-cl').contains(key)).toBe(true);
        expect(key.textContent).toBe('1× SD3× SD');
        const lines = key.querySelectorAll('i');
        expect(lines).toHaveLength(2);
        // 1× solid, 3× dashed — the same line styles as the rings themselves
        expect((lines[0] as HTMLElement).style.borderTopStyle).toBe('solid');
        expect((lines[1] as HTMLElement).style.borderTopStyle).toBe('dashed');
        // (the time charts keep NO key row: they only zoom in time — pinned above with legendOf('ts'))
    });

    it('axis titles are description + unit; the tag is in the subtitle, not on the axis', () => {
        const meta = [
            { tag: 'X1', description: 'GENERATOR ACTIVE POWER', unit: 'MW', component: 'Generator' },
            { tag: 'Y1', description: 'BEARING DE TEMPERATURE', unit: '°C', component: 'Bearing' },
        ];
        const data = makeHealthPreview({ kind: 'clustering', n_clusters: 2 });
        render(
            <SensorMetaProvider metadata={meta}>
                <ModelFitPage model={clu()} stale={false} preview={{ ...idle, data }} unit="" data={data} onXPredictorChange={() => {}} onCompare={() => {}} />
            </SensorMetaProvider>,
        );
        const chart = chartOf('cl');
        expect(chart.getAttribute('data-x-axis-name')).toBe('GENERATOR ACTIVE POWER · MW');
        expect(chart.getAttribute('data-y-axis-name')).toBe('BEARING DE TEMPERATURE · °C');
        expect(chart.getAttribute('data-x-axis-name')).not.toContain('X1');
        // the tags are still on the card — in the subtitle (description then tag, the Inline label)
        const sub = screen.getByTestId('chart-card-cl').querySelector('.wb2-card-s')!.textContent;
        expect(sub).toBe('GENERATOR ACTIVE POWERX1 vs BEARING DE TEMPERATUREY1');
    });

    it('a sensor with no description (or no Tag names at all) falls back to its tag on the axis', () => {
        const data = makeHealthPreview({ kind: 'clustering', n_clusters: 1 });
        render(<ModelFitPage model={clu()} stale={false} preview={{ ...idle, data }} unit="" data={data} onXPredictorChange={() => {}} onCompare={() => {}} />);
        expect(chartOf('cl').getAttribute('data-x-axis-name')).toBe('X1');
        expect(chartOf('cl').getAttribute('data-y-axis-name')).toBe('Y1');
    });

    it('Model fit has no time chart for Clustering: one chart on the page, and it carries no scope strip', () => {
        page(clu(), { n_clusters: 2 });
        expect(screen.getAllByTestId('echarts-mock')).toHaveLength(1);
        expect(chartOf('cl').getAttribute('data-strip')).toBe('');
    });

    it('the card subtitle names both sensors by their labels', () => {
        page(clu(), { n_clusters: 1 });
        expect(screen.getByTestId('chart-card-cl').textContent).toMatch(/Label of X1X1 vs Label of Y1Y1/);
    });
});

describe('ModelFitPage — train and scoring periods ("just score it", 2026-10-10)', () => {
    const withTests = (kind: 'individual' | 'relationship' | 'clustering') => ({
        test_validation: makeValidation({ tests: [makeTestResult(), makeTestResult({ index: 2, start: '2026-01-01T03:00', end: '2026-01-01T04:00' })] }),
        kind,
    });
    const mount = (m: FailureModel, req: Record<string, any>, extra: Record<string, any> = {}) => {
        const base = makeHealthPreview({ kind: m.kind, ...req });
        const data = { ...base, ...extra };
        render(<ModelFitPage model={m} stale={false} preview={{ ...idle, data }} unit="°C" data={data}
            onXPredictorChange={vi.fn()} onCompare={vi.fn()} trainDaysEstimate={extra.estimate} />);
    };

    /** The removed "Train and scoring periods" table (user decision 2026-10-11) left nothing behind. */
    const expectNoTrainTestCard = (boardId: string) => {
        const board = screen.getByTestId(boardId);
        expect(screen.queryByTestId('train-test-card')).toBeNull();
        expect(screen.queryByTestId('train-test-row-train')).toBeNull();
        expect(screen.queryByTestId('train-test-empty')).toBeNull();
        expect(board.querySelector('table.vt-table, .vt-card')).toBeNull();
        expect(board.textContent).not.toMatch(/Train and scoring periods|Scope|Mean shift|Rows within ±3SD|RMSE ÷ train|Rows inside the 3× SD ring/);
        // nothing on the page labels or judges a scoring period
        expect(board.textContent).not.toMatch(/Known problem|T\d Normal|Train vs test|test period|event time|lead time/i);
    };

    it('without scoring periods: no scope bands, no "Train and scoring periods" card', () => {
        page(model(), { target: 'T1' });
        expect(within(screen.getByTestId('chart-card-ts')).getByTestId('echarts-mock').getAttribute('data-series')).toBe('Value');
        expectNoTrainTestCard('model-fit-individual');
    });

    it('Individual: the value chart draws the scopes; NO "Train and scoring periods" card — the board is the KPI strip and the two charts', () => {
        mount(model(), { target: 'T1' }, withTests('individual'));
        expect(within(screen.getByTestId('chart-card-ts')).getByTestId('echarts-mock').getAttribute('data-series')).toBe('Value|__scopes');
        expect([...screen.getByTestId('model-fit-individual').children].map(c => c.getAttribute('data-testid'))).toEqual(['fit-kpis', 'chart-card-ts', 'chart-card-dist']);
        expectNoTrainTestCard('model-fit-individual');
    });

    it('Relationship: both time charts draw the scopes; NO "Train and scoring periods" card — the board ends with Residual over time', () => {
        mount(model({ kind: 'relationship', predictorSensors: ['A'] }), { target: 'T1', predictors: ['A'] }, withTests('relationship'));
        expect(within(screen.getByTestId('chart-card-tvp')).getByTestId('echarts-mock').getAttribute('data-series')).toBe('Actual|Predicted|__scopes');
        expect(within(screen.getByTestId('chart-card-res')).getByTestId('echarts-mock').getAttribute('data-series')).toBe('Residual|__scopes');
        expect([...screen.getByTestId('model-fit-relationship').children].map(c => c.getAttribute('data-testid'))).toEqual(['rel-stats', 'chart-card-fit', 'chart-card-tvp', 'chart-card-res']);
        expectNoTrainTestCard('model-fit-relationship');
    });

    it.each(['individual', 'relationship', 'clustering'] as const)('%s: a model with NO scoring period yet shows no "No scoring period yet" card here (the Running condition line and the Health score page say it)', kind => {
        const m = kind === 'relationship' ? model({ kind, predictorSensors: ['A'] })
            : kind === 'clustering' ? model({ kind, targetSensor: '', xSensor: 'X1', ySensor: 'Y1' })
            : model();
        mount(m, { target: 'T1', predictors: ['A'], n_clusters: 2 }, { test_validation: makeValidation({ tests: [] }) });
        expectNoTrainTestCard(`model-fit-${kind}`);
        expect(screen.getByTestId(`model-fit-${kind}`).textContent).not.toMatch(/No scoring period/);
    });

    it('scoring that failed (test_scoring_failed) shows no notice and no "Try again" on this page — that is the Health score page\'s', () => {
        const validation = [{ code: 'test_scoring_failed', severity: 'warning' as const, field: 'test_periods', message: 'The Relation model engine did not answer.' }];
        mount(model({ kind: 'relationship', predictorSensors: ['A'] }), { target: 'T1', predictors: ['A'] }, { ...withTests('relationship'), validation });
        expect(screen.queryByTestId('test-scoring-failed')).toBeNull();
        expect(screen.queryByTestId('test-scoring-retry')).toBeNull();
        // the charts still draw the train shading (a scoring period is never shaded)
        expect(chartOf('res').getAttribute('data-strip')).toBe('TRAIN');
    });

    // workbench-redesign SPEC §3: the scopes are named in the strip above the plot.
    // User decision 2026-10-12: only the TRAIN period is highlighted — no band, no frame and no "S1" / "S2" for a scoring period.
    it('only the train period is highlighted on a time chart: the strip reads "TRAIN" alone, no scoring band is drawn — and the subtitle still says which rows the chart shows', () => {
        mount(model(), { target: 'T1' }, withTests('individual'));
        expect(chartOf('ts').getAttribute('data-strip')).toBe('TRAIN');
        expect(chartOf('ts').getAttribute('data-bands')).toBe('TRAIN'); // one band under the data: none for S1, none for S2
        // the data did not change, so neither did the subtitle that describes it
        expect(screen.getByTestId('chart-card-ts').querySelector('.wb2-card-s')!.textContent)
            .toBe('°C · rows in the train and scoring periods · green = within ±1SD (score 100) · amber dashes = ±3SD (score 80)');
        expect(chartOf('dist').getAttribute('data-strip')).toBe(''); // not a time chart
        expect(chartOf('dist').getAttribute('data-bands')).toBe('');
    });

    // The fixture: 5 hourly rows 00:00 … 04:00; TRAIN 00:00–01:30, S1 02:00–03:00, S2 03:00–04:00.
    it('the rows of the scoring periods are still drawn, exactly as before: the line is cut once (between TRAIN and S1), never inside or between the scoring periods', () => {
        mount(model(), { target: 'T1' }, withTests('individual'));
        expect(chartOf('ts').getAttribute('data-line-points')).toBe('5'); // 2 train rows + 3 scoring rows
        // one gap, 01:00 → 02:00 (no period covers 01:30–02:00). Cut from the train period alone it would be three:
        // the rows at 02:00, 03:00 and 04:00 would each stand apart.
        expect(chartOf('ts').getAttribute('data-line-gaps')).toBe('1');
        cleanup();
        mount(model({ kind: 'relationship', predictorSensors: ['A'] }), { target: 'T1', predictors: ['A'] }, withTests('relationship'));
        for (const id of ['tvp', 'res']) {
            expect(chartOf(id).getAttribute('data-bands')).toBe('TRAIN');
            expect(chartOf(id).getAttribute('data-line-points')).toBe('5');
            expect(chartOf(id).getAttribute('data-line-gaps')).toBe('1');
        }
    });

    it('several train periods: the full-width chart reads "TRAIN P1" then "P2" (the word once); the half-width one the short "P1", "P2" — the scoring period is on neither', () => {
        const test_validation = makeValidation({
            train_ranges: [{ start: '2026-01-01T00:00', end: '2026-01-01T00:30' }, { start: '2026-01-01T01:00', end: '2026-01-01T01:30' }],
            tests: [makeTestResult()],
        });
        mount(model({ kind: 'relationship', predictorSensors: ['A'] }), { target: 'T1', predictors: ['A'] }, { test_validation });
        expect(chartOf('res').getAttribute('data-strip')).toBe('TRAIN P1|P2');
        expect(chartOf('tvp').getAttribute('data-strip')).toBe('P1|P2');
        expect(chartOf('res').getAttribute('data-bands')).toBe('TRAIN P1|TRAIN P2');
        expect(chartOf('fit').getAttribute('data-strip')).toBe(''); // a scatter has no time axis
        expect(screen.getByTestId('chart-card-tvp').querySelector('.wb2-card-s')!.textContent).toBe('°C · rows in the train and scoring periods');
    });

    it('Clustering (no time chart): with scoring periods the Clusters chart is still the board\'s only, full-width card', () => {
        mount(model({ kind: 'clustering', targetSensor: '', xSensor: 'X1', ySensor: 'Y1' }), { n_clusters: 2 }, withTests('clustering'));
        const board = screen.getByTestId('model-fit-clustering');
        expect([...board.children].map(c => c.getAttribute('data-testid'))).toEqual(['cl-stats', 'chart-card-cl']);
        expect(screen.getByTestId('chart-card-cl').className).toMatch(/(^| )wb2-full( |$)/);
        expect(screen.queryByTestId('cluster-summary')).toBeNull();
        expectNoTrainTestCard('model-fit-clustering');
    });

    // The S-number of a scoring period (its ORIGINAL list position) is shown by the "Scoring results" card on the
    // Health score page (HealthScorePage.test.tsx, BuildModelWindow.test.tsx) — this page prints no scoring name at all.
    it('whatever testNumbers says, the chart strip names no scoring period (neither "S1" nor "S2"); slowScoring shows the hint', () => {
        const data = { ...makeHealthPreview({ kind: 'individual', target: 'T1' }), test_validation: makeValidation({ tests: [makeTestResult({ index: 1 })] }) };
        render(<ModelFitPage model={model()} stale={false} preview={{ ...idle, data }} unit="°C" data={data}
            onXPredictorChange={vi.fn()} onCompare={vi.fn()} testNumbers={[2]} slowScoring />);
        // the user's list is [S1 not sent, S2]
        expect(chartOf('ts').getAttribute('data-strip')).toBe('TRAIN');
        expect(chartOf('ts').getAttribute('data-bands')).toBe('TRAIN');
        expect(screen.getByTestId('model-fit-individual').textContent).not.toMatch(/\bS[12]\b/);
        expect(screen.getByTestId('slow-test-scoring').textContent).toContain('Calculating the health score with the Relation model');
    });

    it('amber "below the recommended train time" note from Rust\'s train days (never a block); the estimate is used only without them', () => {
        mount(model(), { target: 'T1' }, { test_validation: makeValidation({ train: { ...makeValidation().train, days: 8 } }) });
        expect(screen.getByTestId('train-days-warning').textContent).toContain('Only 8 d of train running time');
        cleanup();
        mount(model(), { target: 'T1' }, { estimate: 3 });
        expect(screen.getByTestId('train-days-warning').textContent).toContain('Only 3 d');
        cleanup();
        mount(model(), { target: 'T1' }, { test_validation: makeValidation(), estimate: 3 });
        expect(screen.queryByTestId('train-days-warning')).toBeNull(); // Rust says 40.2 d
    });
});
