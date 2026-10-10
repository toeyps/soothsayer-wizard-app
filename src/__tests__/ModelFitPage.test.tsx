import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';

vi.mock('../components/charts/ResponsiveECharts', () => ({
    default: (props: any) => (
        <div
            data-testid="echarts-mock"
            data-series={(props.option?.series ?? []).map((s: any) => s.name).join('|')}
            data-x-axis-name={props.option?.xAxis?.name ?? ''}
            data-y-axis-name={props.option?.yAxis?.name ?? ''}
            // the names in the strip above the plot (train / scoring scopes), in band order
            data-strip={((props.option?.series ?? []).find((s: any) => s.name === '__scopes')?.markArea?.data ?? []).map((a: any) => a[0].label.formatter).join('|')}
            // lines that name themselves at their right end
            data-end-labels={(props.option?.series ?? []).filter((s: any) => s.endLabel?.show).map((s: any) => s.endLabel.formatter).join('|')}
            // the ring levels named on a Clusters chart
            data-ring-labels={((props.option?.series ?? []).find((s: any) => s.name === 'Ring labels')?.data ?? []).map((x: any) => x.label.formatter).join('|')}
        />
    ),
}));
// The Fit chart's X selector is the REAL shared compact single picker (customer item 3,
// 2026-10-09); its own behaviour is tested in SensorPicker.test.tsx.

import ModelFitPage from '../components/windows/workbench/ModelFitPage';
import { SensorMetaProvider } from '../components/sensor/SensorLabel';
import { CLUSTER_COLORS } from '../components/windows/workbench/chartTheme';
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
        sensorLabel: (t: string) => `Label of ${t}`, getDesc: (t: string) => t,
        onXPredictorChange: vi.fn(), onCompare: vi.fn(),
        ...over,
    };
    render(<SensorMetaProvider metadata={META}><ModelFitPage {...props} /></SensorMetaProvider>);
    return props;
}

const chartOf = (id: string) => within(screen.getByTestId(`chart-card-${id}`)).getByTestId('echarts-mock');
/** Text of the legend row under a card's chart, or null when the card has none. */
const legendOf = (id: string) => screen.getByTestId(`chart-card-${id}`).querySelector('.wb2-legend')?.textContent ?? null;

describe('ModelFitPage — Individual', () => {
    it('has the full-width value chart, the Distribution chart and the statistics card, in that order', () => {
        page(model(), { target: 'T1' });
        const board = screen.getByTestId('model-fit-individual');
        expect([...board.children].map(c => c.getAttribute('data-testid'))).toEqual(['chart-card-ts', 'chart-card-dist', 'fit-side']);
        // the side column stacks the statistics (and, with scoring periods, the "Train and scoring periods" card)
        expect([...screen.getByTestId('fit-side').children].map(c => c.getAttribute('data-testid'))).toEqual(['stats-card']);
        expect(screen.getByTestId('chart-card-ts').className).toMatch(/wb2-full/);
        expect(screen.getByTestId('chart-card-ts').className).toMatch(/wb2-card--tall/);
        expect(within(screen.getByTestId('chart-card-ts')).getByTestId('echarts-mock').getAttribute('data-series')).toBe('Value');
        expect(within(screen.getByTestId('chart-card-dist')).getByTestId('echarts-mock').getAttribute('data-series')).toBe('Rows|Normal curve');
    });

    it('the statistics card lists rows, mean, SD, ±1SD, ±3SD and the estimated rows outside ±3SD', () => {
        page(model(), { target: 'T1' });
        const t = screen.getByTestId('stats-card').textContent!;
        expect(t).toMatch(/Rows1,000/);
        expect(t).toMatch(/Mean5\.00 °C/);
        expect(t).toMatch(/SD1\.00 °C/);
        expect(t).toMatch(/±1SD4\.00 – 6\.00/);
        expect(t).toMatch(/±3SD2\.00 – 8\.00/);
        expect(screen.getByTestId('stat-outside3').textContent).toMatch(/^≈ \d+ \(\d+\.\d{2}%\)$/);
    });

    it('without a histogram the Distribution card says so instead of drawing', () => {
        const data = { ...makeHealthPreview({ kind: 'individual' }), histogram: null };
        render(<ModelFitPage model={model()} stale={false} preview={{ ...idle, data }} unit="" data={data} sensorLabel={t => t} getDesc={t => t} onXPredictorChange={() => {}} onCompare={() => {}} />);
        expect(within(screen.getByTestId('chart-card-dist')).queryByTestId('echarts-mock')).toBeNull();
        expect(screen.getByText('No distribution for this scope')).toBeTruthy();
        expect(screen.getByTestId('stat-outside3').textContent).toBe('—');
    });

    it('stale: every chart is "Out of date"', () => {
        page(model(), { target: 'T1' }, { stale: true });
        expect(screen.getAllByTestId('chart-outdated')).toHaveLength(2);
    });

    // workbench-redesign SPEC §3: no legend row where the lines are labelled on the chart.
    it('the value chart has NO legend row (±1SD / ±3SD are named on the chart); Distribution keeps only "Rows" and "Normal curve"', () => {
        page(model(), { target: 'T1' });
        expect(legendOf('ts')).toBeNull();
        expect(legendOf('dist')).toBe('RowsNormal curve');
        expect(screen.getByTestId('chart-card-dist').textContent).not.toMatch(/±1SD|±3SD/);
        expect(screen.getByTestId('chart-card-ts').textContent).not.toMatch(/±1SD|±3SD|Value/);
    });

    it('the subtitles say what the chart shows: every running row without scoring periods, "rows per value" for Distribution', () => {
        page(model(), { target: 'T1' });
        expect(screen.getByTestId('chart-card-ts').querySelector('.wb2-card-s')!.textContent).toBe('°C · running rows');
        expect(screen.getByTestId('chart-card-dist').querySelector('.wb2-card-s')!.textContent).toBe('°C · rows per value');
    });
});

describe('ModelFitPage — Relationship', () => {
    const rel = () => model({ kind: 'relationship', targetSensor: 'T1', predictorSensors: ['A', 'B'] });

    it('stats strip first, then Fit, Target vs predicted and a full-width Residual over time — no residual distribution, no histogram', () => {
        page(rel(), { target: 'T1', predictors: ['A', 'B'] });
        const board = screen.getByTestId('model-fit-relationship');
        expect([...board.children].map(c => c.getAttribute('data-testid'))).toEqual(['rel-stats', 'chart-card-fit', 'chart-card-tvp', 'chart-card-res']);
        expect(screen.getByTestId('chart-card-res').className).toMatch(/wb2-full/);
        expect(screen.queryByTestId('chart-card-dist')).toBeNull();
        expect(screen.queryByText(/Distribution/i)).toBeNull();
        expect(screen.queryByText(/histogram/i)).toBeNull();
    });

    it('the strip has R², RMSE, 2RMSE, residual mean/SD, rows and the predictor count', () => {
        page(rel(), { target: 'T1', predictors: ['A', 'B'] });
        const txt = (id: string) => screen.getByTestId(id).textContent;
        expect(txt('stat-r2')).toBe('R²0.912');
        expect(txt('stat-rmse')).toBe('RMSE0.457 °C');
        expect(txt('stat-2rmse')).toBe('2RMSE0.913');
        expect(txt('stat-res-mean')).toBe('Residual mean0.012');
        expect(txt('stat-res-sd')).toBe('Residual SD0.400');
        expect(txt('stat-rows')).toBe('Rows321');
        expect(txt('stat-predictors')).toBe('Predictors2');
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

    it('stale: all three charts are "Out of date"', () => {
        page(rel(), { target: 'T1', predictors: ['A', 'B'] }, { stale: true });
        expect(screen.getAllByTestId('chart-outdated')).toHaveLength(3);
    });

    // workbench-redesign SPEC §3: "No legend rows where the lines are labelled (Target vs predicted:
    // "Actual" / "Predicted" at the line ends)."
    it('Target vs predicted names "Actual" / "Predicted" at the line ends and has no legend row; Residual has none either; Fit keeps its two point colours', () => {
        page(rel(), { target: 'T1', predictors: ['A', 'B'] });
        expect(chartOf('tvp').getAttribute('data-end-labels')).toBe('Actual|Predicted');
        expect(legendOf('tvp')).toBeNull();
        expect(legendOf('res')).toBeNull();
        expect(chartOf('res').getAttribute('data-end-labels')).toBe(''); // one line: its ±2RMSE lines are named instead
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

    it('the cluster scatter with its rings and a summary card with every cluster\'s rows and centre', () => {
        page(clu(), { n_clusters: 2, criteria_sensor: 'LOAD' });
        const board = screen.getByTestId('model-fit-clustering');
        expect([...board.children].map(c => c.getAttribute('data-testid'))).toEqual(['chart-card-cl', 'fit-side']);
        expect([...screen.getByTestId('fit-side').children].map(c => c.getAttribute('data-testid'))).toEqual(['cluster-summary']);
        const series = within(screen.getByTestId('chart-card-cl')).getByTestId('echarts-mock').getAttribute('data-series')!;
        expect(series).toMatch(/Cluster 1/);
        expect(series).toMatch(/Cluster 2 3× SD/);
        const summary = screen.getByTestId('cluster-summary');
        expect(summary.textContent).toMatch(/split by Label of LOADLOAD/);
        // the ranges are what the user typed: printed as typed ("0 – 50"), never padded ("0.000 – 50.00")
        expect(within(summary).getByTestId('cluster-row-1').textContent).toBe('Cluster 1 · 0 – 5041 rows');
        expect(within(summary).getByTestId('cluster-row-2').textContent).toBe('Cluster 2 · 50 – 10042 rows');
        // the centre is computed: the read-out formatter
        expect(summary.textContent).toMatch(/x 10\.00 · y 20\.00/);
    });

    // ---- workbench-redesign SPEC §3 "Clustering" ----

    it('a typed range keeps every decimal and is never rounded; an open end reads "…"', () => {
        const base = makeHealthPreview({ kind: 'clustering', n_clusters: 2 });
        const stats = base.stats as any;
        const data = {
            ...base,
            stats: { ...stats, clusters: [{ ...stats.clusters[0], range: { min: null, max: 33.6 } }, { ...stats.clusters[1], range: { min: 33.6, max: 4.61234 } }] },
        };
        render(<ModelFitPage model={clu()} stale={false} preview={{ ...idle, data }} unit="" data={data} sensorLabel={t => t} getDesc={t => t} onXPredictorChange={() => {}} onCompare={() => {}} />);
        expect(screen.getByTestId('cluster-row-1').textContent).toBe('Cluster 1 · … – 33.641 rows');
        expect(screen.getByTestId('cluster-row-2').textContent).toBe('Cluster 2 · 33.6 – 4.6123442 rows');
    });

    it('the rings are named on the chart, once per level, so the card has NO legend row', () => {
        page(clu(), { n_clusters: 2 });
        expect(chartOf('cl').getAttribute('data-ring-labels')).toBe('1× SD|3× SD');
        expect(legendOf('cl')).toBeNull();
    });

    it('axis titles are description + unit; the tag is in the subtitle, not on the axis', () => {
        const meta = [
            { tag: 'X1', description: 'GENERATOR ACTIVE POWER', unit: 'MW', component: 'Generator' },
            { tag: 'Y1', description: 'BEARING DE TEMPERATURE', unit: '°C', component: 'Bearing' },
        ];
        const data = makeHealthPreview({ kind: 'clustering', n_clusters: 2 });
        render(
            <SensorMetaProvider metadata={meta}>
                <ModelFitPage model={clu()} stale={false} preview={{ ...idle, data }} unit="" data={data} sensorLabel={t => t} getDesc={t => t} onXPredictorChange={() => {}} onCompare={() => {}} />
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
        render(<ModelFitPage model={clu()} stale={false} preview={{ ...idle, data }} unit="" data={data} sensorLabel={t => t} getDesc={t => t} onXPredictorChange={() => {}} onCompare={() => {}} />);
        expect(chartOf('cl').getAttribute('data-x-axis-name')).toBe('X1');
        expect(chartOf('cl').getAttribute('data-y-axis-name')).toBe('Y1');
    });

    it('the summary dots use the cluster palette (never the green / amber / red of the rings)', () => {
        page(clu(), { n_clusters: 2 });
        const dot = (n: number) => (screen.getByTestId(`cluster-row-${n}`).querySelector('.wb2-dot') as HTMLElement).style.background;
        const rgb = (hex: string) => `rgb(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
        expect(dot(1)).toBe(rgb(CLUSTER_COLORS[0]));
        expect(dot(2)).toBe(rgb(CLUSTER_COLORS[1]));
    });

    it('Model fit has no time chart for Clustering: one chart on the page, and it carries no scope strip', () => {
        page(clu(), { n_clusters: 2 });
        expect(screen.getAllByTestId('echarts-mock')).toHaveLength(1);
        expect(chartOf('cl').getAttribute('data-strip')).toBe('');
    });

    it('rows that fall in no cluster range are listed', () => {
        page(clu(), { n_clusters: 2 });
        expect(screen.getByTestId('cluster-summary').textContent).toMatch(/In no range5 rows/);
    });

    it('the card subtitle names both sensors by their labels', () => {
        page(clu(), { n_clusters: 1 });
        expect(screen.getByTestId('chart-card-cl').textContent).toMatch(/Label of X1X1 vs Label of Y1Y1/);
    });
});

describe('ModelFitPage — train and scoring periods ("just score it", 2026-10-10)', () => {
    const withTests = (kind: 'individual' | 'relationship' | 'clustering') => ({
        test_validation: makeValidation({ tests: [makeTestResult(), makeTestResult({ index: 2 })] }),
        kind,
    });
    const mount = (m: FailureModel, req: Record<string, any>, extra: Record<string, any> = {}) => {
        const base = makeHealthPreview({ kind: m.kind, ...req });
        const data = { ...base, ...extra };
        render(<ModelFitPage model={m} stale={false} preview={{ ...idle, data }} unit="°C" data={data}
            sensorLabel={t => t} getDesc={t => t} onXPredictorChange={vi.fn()} onCompare={vi.fn()} trainDaysEstimate={extra.estimate} />);
    };

    it('without scoring periods: no scope bands, no "Train and scoring periods" card', () => {
        page(model(), { target: 'T1' });
        expect(within(screen.getByTestId('chart-card-ts')).getByTestId('echarts-mock').getAttribute('data-series')).toBe('Value');
        expect(screen.queryByTestId('train-test-card')).toBeNull();
    });

    it('Individual: the value chart draws the scopes; the "Train and scoring periods" card sits under the statistics', () => {
        mount(model(), { target: 'T1' }, withTests('individual'));
        expect(within(screen.getByTestId('chart-card-ts')).getByTestId('echarts-mock').getAttribute('data-series')).toBe('Value|__scopes');
        expect([...screen.getByTestId('fit-side').children].map(c => c.getAttribute('data-testid'))).toEqual(['stats-card', 'train-test-card']);
        const card = screen.getByTestId('train-test-card');
        expect(card.querySelector('.wb2-card-h b')!.textContent).toBe('Train and scoring periods');
        expect([...card.querySelectorAll('.vt-scope b')].map(b => b.textContent)).toEqual(['Train', 'S1', 'S2']);
        // nothing on the page labels or judges a scoring period
        expect(screen.getByTestId('model-fit-individual').textContent).not.toMatch(/Known problem|T\d Normal|Train vs test|test period|event time|lead time/i);
    });

    it('Relationship: both time charts draw the scopes; the card is a capped full-width row', () => {
        mount(model({ kind: 'relationship', predictorSensors: ['A'] }), { target: 'T1', predictors: ['A'] }, withTests('relationship'));
        expect(within(screen.getByTestId('chart-card-tvp')).getByTestId('echarts-mock').getAttribute('data-series')).toBe('Actual|Predicted|__scopes');
        expect(within(screen.getByTestId('chart-card-res')).getByTestId('echarts-mock').getAttribute('data-series')).toBe('Residual|__scopes');
        expect(screen.getByTestId('train-test-card').className).toContain('vt-card--cap');
    });

    // workbench-redesign SPEC §3: the scopes are named in the strip above the plot.
    it('the strip names the scopes on every time chart: "TRAIN", "S1", "S2" — and the subtitle says the chart shows only those rows', () => {
        mount(model(), { target: 'T1' }, withTests('individual'));
        expect(chartOf('ts').getAttribute('data-strip')).toBe('TRAIN|S1|S2');
        expect(screen.getByTestId('chart-card-ts').querySelector('.wb2-card-s')!.textContent).toBe('°C · rows in the train and scoring periods');
        expect(chartOf('dist').getAttribute('data-strip')).toBe(''); // not a time chart
    });

    it('several train periods: the full-width chart reads "TRAIN P1", "TRAIN P2"; the half-width one the short "P1", "P2"', () => {
        const test_validation = makeValidation({
            train_ranges: [{ start: '2026-01-01T00:00', end: '2026-01-01T00:30' }, { start: '2026-01-01T01:00', end: '2026-01-01T01:30' }],
            tests: [makeTestResult()],
        });
        mount(model({ kind: 'relationship', predictorSensors: ['A'] }), { target: 'T1', predictors: ['A'] }, { test_validation });
        expect(chartOf('res').getAttribute('data-strip')).toBe('TRAIN P1|TRAIN P2|S1');
        expect(chartOf('tvp').getAttribute('data-strip')).toBe('P1|P2|S1');
        expect(chartOf('fit').getAttribute('data-strip')).toBe(''); // a scatter has no time axis
        expect(screen.getByTestId('chart-card-tvp').querySelector('.wb2-card-s')!.textContent).toBe('°C · rows in the train and scoring periods');
    });

    it('Clustering (no time chart): the card stacks under the cluster summary', () => {
        mount(model({ kind: 'clustering', targetSensor: '', xSensor: 'X1', ySensor: 'Y1' }), { n_clusters: 2 }, withTests('clustering'));
        expect([...screen.getByTestId('fit-side').children].map(c => c.getAttribute('data-testid'))).toEqual(['cluster-summary', 'train-test-card']);
    });

    it('testNumbers name the scoring-period row by the ORIGINAL list position; slowScoring shows the hint', () => {
        const data = { ...makeHealthPreview({ kind: 'individual', target: 'T1' }), test_validation: makeValidation({ tests: [makeTestResult({ index: 1 })] }) };
        render(<ModelFitPage model={model()} stale={false} preview={{ ...idle, data }} unit="°C" data={data}
            sensorLabel={t => t} getDesc={t => t} onXPredictorChange={vi.fn()} onCompare={vi.fn()} testNumbers={[2]} slowScoring />);
        expect(screen.getByTestId('train-test-row-2').querySelector('.vt-scope b')!.textContent).toBe('S2');
        expect(screen.queryByTestId('train-test-row-1')).toBeNull();
        expect(within(screen.getByTestId('chart-card-ts')).getByTestId('echarts-mock')).toBeTruthy();
        expect(screen.getByTestId('slow-test-scoring').textContent).toContain('Scoring these periods with the Relation model');
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
