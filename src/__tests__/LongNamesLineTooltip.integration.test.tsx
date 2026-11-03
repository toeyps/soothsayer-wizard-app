import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import * as echarts from 'echarts';

/*
 * The line tooltip now lives under `body` so the card cannot clip it (long names, rule 4). LineChart's own tests read
 * the option; ECharts' behaviour with that option is what decides whether the box can be left behind on the screen. So
 * here the REAL ECharts runs the option LineChart builds, in jsdom's SVG mode.
 */
const captured: any[] = [];
vi.mock('../components/charts/ResponsiveECharts', () => ({
    default: (props: any) => {
        captured.push(props.option);
        return <div data-testid="echarts" />;
    },
}));

import LineChart from '../components/charts/LineChart';
import type { ColumnarSeries } from '../components/charts/ChartTypes';
import { buildSubModelOption } from '../components/windows/SubModelsModal';
import { buildFitScatterOption } from '../components/windows/workbench/healthCharts';
import { attachAxisNames, getAxisNames } from '../utils/axisName';
import { longName } from './helpers/nameGeometry';

class NoResizeObserver {
    observe() {}
    disconnect() {}
    unobserve() {}
}

const tags = [longName(1, 'avg'), longName(1, 'max'), longName(1, 'min'), longName(2, 'avg')];
const meta = tags.map(tag => ({ tag, description: tag.replace('SegmentNo', 'Segment No'), unit: 'mm/s', component: 'Crosshead' }));
const columnar: ColumnarSeries = {
    timestamps: Array.from({ length: 20 }, (_, i) => `2025-01-01T00:${String(i).padStart(2, '0')}:00`),
    series: tags.map((_, s) => Array.from({ length: 20 }, (_, i) => s * 100 + i + 0.5)),
};

let chart: echarts.ECharts | null = null;
let host: HTMLElement;

function lineOption() {
    render(<LineChart data={[]} columnar={columnar} sensors={tags} headers={tags} sensorMetadata={meta} />);
    return captured[captured.length - 1];
}

function startChart() {
    host = document.createElement('div');
    document.body.appendChild(host);
    chart = echarts.init(host, undefined, { renderer: 'svg', width: 800, height: 400 });
    chart.setOption(lineOption());
    chart.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: 5 });
}

/** Tooltip boxes that are direct children of `body`, i.e. outside every chart card. */
const bodyBoxes = () => [...document.body.children].filter(el => el.querySelector('.tt-head')) as HTMLElement[];

beforeEach(() => {
    captured.length = 0;
    vi.stubGlobal('ResizeObserver', NoResizeObserver);
});

afterEach(() => {
    if (chart && !chart.isDisposed()) chart.dispose();
    chart = null;
    host?.remove();
    vi.unstubAllGlobals();
    cleanup();
});

describe('the line tooltip under `body`, in the real ECharts', () => {
    it('is a child of body, not of the chart, with four different rows and no line for a shared start', () => {
        startChart();
        const [box] = bodyBoxes();
        expect(box).toBeTruthy();
        expect(host.contains(box)).toBe(false);
        const names = [...box.querySelectorAll('.tt-desc')].map(n => n.textContent);
        expect(names).toHaveLength(4);
        expect(new Set(names).size).toBe(4);
        for (const val of box.querySelectorAll('.tt-val')) expect(val.textContent).toContain('mm/s');
    });

    it('hides when the pointer leaves the chart', () => {
        startChart();
        const [box] = bodyBoxes();
        expect(box.style.display).not.toBe('none');
        chart!.getZr().handler.trigger('globalout', { type: 'globalout', event: {} } as any);
        expect(box.style.visibility === 'hidden' || box.style.display === 'none').toBe(true);
    });

    it('leaves nothing behind in body when the chart goes away (a switch to Scatter or Pair Plot, leaving the Dashboard)', () => {
        startChart();
        expect(bodyBoxes()).toHaveLength(1);
        chart!.dispose();
        expect(bodyBoxes()).toHaveLength(0);
    });

    it('a re-render of the same chart reuses its box: no second box piles up in body', () => {
        startChart();
        chart!.setOption(lineOption());
        chart!.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: 7 });
        expect(bodyBoxes()).toHaveLength(1);
    });
});

describe('axis titles: the real option builders, the fitting and the real ECharts together', () => {
    const LONG = longName(1, 'avg').replace('SegmentNo', 'Segment No');
    const info = (tag: string) => ({ tag, description: LONG, unit: 'mm/s' });

    /** Runs `option` the way ResponsiveECharts does, on a chart of this size. */
    function fitted(option: any, width: number, height: number) {
        host = document.createElement('div');
        document.body.appendChild(host);
        chart = echarts.init(host, undefined, { renderer: 'svg', width, height });
        chart.setOption(option, { notMerge: true });
        attachAxisNames(chart, getAxisNames(option)!, option)();
        return chart.getOption() as any;
    }

    it('Compare: a long Y title on a card wraps to two lines with the unit on the last, and the plot moves over only as needed', () => {
        const fit = {
            predictors: ['A'],
            result: {
                request: 'r', r2_per_step: [0.8], rmse2_per_step: [0.4], n_rows: 3, predicted: [0, 1, 2],
                target_raw: [0.1, 1.1, 2.1], predictor_raw: [[0], [1], [2]],
            },
        };
        const out = fitted(buildSubModelOption(fit as any, 'A', 'T', info), 360, 200);
        const lines = String(out.yAxis[0].name).split(String.fromCharCode(10));
        expect(lines).toHaveLength(2);
        expect(lines[1].endsWith('mm/s')).toBe(true);
        expect(lines[1].startsWith('-')).toBe(false);
        expect(out.yAxis[0].nameTruncate?.maxWidth ?? null).toBeNull();
    });

    it('Compare: a tall card keeps one line, as it did', () => {
        const fit = {
            predictors: ['A'],
            result: {
                request: 'r', r2_per_step: [0.8], rmse2_per_step: [0.4], n_rows: 3, predicted: [0, 1, 2],
                target_raw: [0.1, 1.1, 2.1], predictor_raw: [[0], [1], [2]],
            },
        };
        const out = fitted(buildSubModelOption(fit as any, 'A', 'T', tag => ({ tag, description: 'Bearing temperature', unit: 'DEGC' })), 800, 600);
        expect(out.yAxis[0].name).toBe('Bearing temperature · DEGC');
    });

    it('Fit: the X title is the description of the predictor · unit, never its tag, and a long one keeps its end', () => {
        const fitData = { x_sensor: 'A', predictors: ['A'], x: [0, 1, 2], actual: [1, 2, 3], predicted: [1, 2, 3], total: 3 };
        const out = fitted(buildFitScatterOption(fitData, 'mm/s', info('A')), 360, 240);
        const x = String(out.xAxis[0].name);
        expect(x).not.toBe('A');
        expect(x.endsWith('avg · mm/s')).toBe(true);
    });
});
