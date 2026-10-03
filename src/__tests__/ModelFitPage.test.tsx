import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';

vi.mock('../components/charts/ResponsiveECharts', () => ({
    default: (props: any) => (
        <div
            data-testid="echarts-mock"
            data-series={(props.option?.series ?? []).map((s: any) => s.name).join('|')}
            data-x-axis-name={props.option?.xAxis?.name ?? ''}
        />
    ),
}));
// The real search dropdown lives in the (huge) PM page and has its own tests there.
vi.mock('../components/windows/PredictiveModelBuild', () => ({
    SensorAutocomplete: (props: any) => (
        <select aria-label={props.placeholder} value={props.value} onChange={e => props.onSelect(e.target.value)}>
            {props.sensors.map((s: string) => <option key={s} value={s}>{s}</option>)}
        </select>
    ),
}));

import ModelFitPage from '../components/windows/workbench/ModelFitPage';
import { makeHealthPreview } from './helpers/healthPreviewFixture';
import type { UseHealthPreviewResult } from '../hooks/useHealthPreview';
import type { FailureModel } from '../types';

afterEach(cleanup);

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
    render(<ModelFitPage {...props} />);
    return props;
}

describe('ModelFitPage — Individual', () => {
    it('has the full-width value chart, the Distribution chart and the statistics card, in that order', () => {
        page(model(), { target: 'T1' });
        const board = screen.getByTestId('model-fit-individual');
        expect([...board.children].map(c => c.getAttribute('data-testid'))).toEqual(['chart-card-ts', 'chart-card-dist', 'stats-card']);
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
        const select = within(screen.getByTestId('fit-x-selector')).getByLabelText('Select X-axis sensor...') as HTMLSelectElement;
        expect([...select.options].map(o => o.value)).toEqual(['A', 'B']);
        expect(select.value).toBe('B');
        expect(within(screen.getByTestId('chart-card-fit')).getByTestId('echarts-mock').getAttribute('data-x-axis-name')).toBe('B');
        fireEvent.change(select, { target: { value: 'A' } });
        expect(p.onXPredictorChange).toHaveBeenCalledWith('A');
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
});

describe('ModelFitPage — Clustering', () => {
    const clu = () => model({ kind: 'clustering', targetSensor: '', xSensor: 'X1', ySensor: 'Y1' });

    it('the cluster scatter with its rings and a summary card with every cluster\'s rows and centre', () => {
        page(clu(), { n_clusters: 2, criteria_sensor: 'LOAD' });
        const board = screen.getByTestId('model-fit-clustering');
        expect([...board.children].map(c => c.getAttribute('data-testid'))).toEqual(['chart-card-cl', 'cluster-summary']);
        const series = within(screen.getByTestId('chart-card-cl')).getByTestId('echarts-mock').getAttribute('data-series')!;
        expect(series).toMatch(/Cluster 1/);
        expect(series).toMatch(/Cluster 2 3× SD/);
        const summary = screen.getByTestId('cluster-summary');
        expect(summary.textContent).toMatch(/split by Label of LOAD/);
        expect(within(summary).getByTestId('cluster-row-1').textContent).toMatch(/Cluster 1 · 0\.000 – 50\.0041 rows/);
        expect(within(summary).getByTestId('cluster-row-2').textContent).toMatch(/Cluster 2 · 50\.00 – 100\.042 rows/);
        expect(summary.textContent).toMatch(/x 10\.00 · y 20\.00/);
    });

    it('rows that fall in no cluster range are listed', () => {
        page(clu(), { n_clusters: 2 });
        expect(screen.getByTestId('cluster-summary').textContent).toMatch(/In no range5 rows/);
    });

    it('the card subtitle names both sensors by their labels', () => {
        page(clu(), { n_clusters: 1 });
        expect(screen.getByTestId('chart-card-cl').textContent).toMatch(/Label of X1 vs Label of Y1/);
    });
});
