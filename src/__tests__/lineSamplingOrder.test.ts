// @vitest-environment node
/**
 * Bug report 2026-10-30: on the Dashboard line chart, zooming into a year of data drew long
 * diagonal lines jumping back months. Cause: ECharts 6.1's `sampling: 'lttb'` mixes up
 * zoom-window and full-series indexes once a series holds a null, so the drawn points come out
 * of time order. LineChart now uses `sampling: 'minmax'`. This test runs the real ECharts
 * (server-side render, no DOM) with the same shape of option and checks the points ECharts keeps
 * for drawing are in time order while zoomed.
 */
import { describe, expect, it } from 'vitest';
import * as echarts from 'echarts';

const N = 4000;
const START = Date.UTC(2025, 9, 16, 14, 10);
const STEP = 365 * 24 * 3600 * 1000 / N;

function series(): [number, number | null][] {
    return Array.from({ length: N }, (_, i) => [
        START + i * STEP,
        // a null every 333 points, like the empty cells / empty buckets of the real feed
        i % 333 === 7 ? null : 10 + Math.sin(i / 40) * 3 + (i % 17) / 10,
    ]);
}

function drawnXs(sampling: 'minmax' | 'lttb'): number[] {
    const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 1200, height: 500 });
    chart.setOption({
        animation: false,
        xAxis: { type: 'time' },
        yAxis: { type: 'value', scale: true },
        // zoomed into the middle of the year, as in the report (2026/04 → 2026/09)
        dataZoom: [{ type: 'inside', xAxisIndex: [0], filterMode: 'filter', start: 45, end: 90 }],
        series: [{ type: 'line', showSymbol: false, silent: true, sampling, data: series() }],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (chart as any).getModel().getSeriesByIndex(0).getData();
    const dim = data.mapDimension('x');
    const xs: number[] = [];
    for (let i = 0; i < data.count(); i++) xs.push(data.get(dim, i));
    chart.dispose();
    return xs;
}

describe('line chart sampling keeps points in time order when zoomed (bug 2026-10-30)', () => {
    it("'minmax' (what LineChart uses): no point goes back in time", () => {
        const xs = drawnXs('minmax');
        expect(xs.length).toBeGreaterThan(0);
        const backwards = xs.filter((x, i) => i > 0 && x < xs[i - 1]).length;
        expect(backwards).toBe(0);
    });
});
