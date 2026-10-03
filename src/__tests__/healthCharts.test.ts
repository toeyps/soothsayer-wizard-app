import { describe, it, expect } from 'vitest';
import {
    buildClusterOption,
    buildDistributionOption,
    buildFitScatterOption,
    buildResidualOption,
    buildTargetVsPredictedOption,
    buildTimeSeriesOption,
    buildValueOverTimeOption,
    ellipseSeries,
    estimateRowsOutside3sd,
    individualVLines,
    niceExtent,
    parseTimestamps,
} from '../components/windows/workbench/healthCharts';
import { CHART } from '../components/windows/workbench/chartTheme';
import { makeHealthPreview } from './helpers/healthPreviewFixture';
import type { ClusteringStats, IndividualSeries, IndividualStats, RelationshipSeries, RelationshipStats } from '../types/health';

const ind = () => makeHealthPreview({ kind: 'individual', target: 'T' });
const rel = () => makeHealthPreview({ kind: 'relationship', target: 'T', predictors: ['A', 'B'] });
const clu = (n = 2) => makeHealthPreview({ kind: 'clustering', n_clusters: n });

describe('parseTimestamps', () => {
    it('returns epoch ms for parseable text, in order', () => {
        const ms = parseTimestamps(['2026-01-01 00:00:00', '2026-01-01 01:00:00'])!;
        expect(ms[1] - ms[0]).toBe(3600_000);
    });
    it('is all-or-nothing: one bad (or empty) timestamp -> null, so the chart falls back to a category axis', () => {
        expect(parseTimestamps(['2026-01-01 00:00:00', ''])).toBeNull();
        expect(parseTimestamps(['nope'])).toBeNull();
    });
});

describe('niceExtent', () => {
    it('rounds a range out to 1/2/5 steps', () => {
        expect(niceExtent(62.884400945773835, 80.6762832)).toEqual([60, 85]);
        expect(niceExtent(-4.3, 5.2)).toEqual([-6, 6]);
    });
    it('leaves a degenerate range alone', () => {
        expect(niceExtent(3, 3)).toEqual([3, 3]);
    });
});

describe('buildTimeSeriesOption', () => {
    const spec = {
        timestamps: ['2026-01-01 00:00:00', '2026-01-01 01:00:00', '2026-01-01 02:00:00'],
        lines: [{ name: 'V', values: [1, null, 3] as (number | null)[], color: '#fff' }],
    };

    it('uses a time axis with [ms, value] pairs (a null is a gap) when every timestamp parses', () => {
        const o: any = buildTimeSeriesOption(spec);
        expect(o.xAxis.type).toBe('time');
        expect(o.series[0].data).toHaveLength(3);
        expect(o.series[0].data[0][1]).toBe(1);
        expect(o.series[0].data[1][1]).toBeNull();
    });

    it('falls back to a category axis with the raw text when a timestamp does not parse', () => {
        const o: any = buildTimeSeriesOption({ ...spec, timestamps: ['a', 'b', 'c'] });
        expect(o.xAxis.type).toBe('category');
        expect(o.xAxis.data).toEqual(['a', 'b', 'c']);
        expect(o.series[0].data).toEqual([1, null, 3]);
    });

    it('draws horizontal lines and bands on the FIRST series only, and widens the Y range to include them', () => {
        const o: any = buildTimeSeriesOption({
            ...spec,
            lines: [...spec.lines, { name: 'W', values: [1, 1, 1], color: '#000' }],
            hLines: [{ y: 50, color: '#0f0', label: '+3SD' }, { y: -20, color: '#f00', dashed: true }],
            bands: [{ from: -5, to: 5, color: 'rgba(0,0,0,.1)' }],
        });
        expect(o.series[0].markLine.data.map((d: any) => d.yAxis)).toEqual([50, -20]);
        expect(o.series[0].markLine.data[0].label.formatter).toBe('+3SD');
        expect(o.series[0].markLine.data[1].lineStyle.type).toBe('dashed');
        expect(o.series[0].markArea.data).toHaveLength(1);
        expect(o.series[1].markLine).toBeUndefined();
        expect(o.yAxis.min).toBeLessThanOrEqual(-20);
        expect(o.yAxis.max).toBeGreaterThanOrEqual(50);
    });

    it('survives a series with no finite value at all', () => {
        const o: any = buildTimeSeriesOption({ ...spec, lines: [{ name: 'V', values: [null, null, null], color: '#fff' }] });
        expect(Number.isFinite(o.yAxis.min)).toBe(true);
        expect(Number.isFinite(o.yAxis.max)).toBe(true);
    });
});

describe('Individual charts', () => {
    it('value over time carries the ±1SD (green) and ±3SD (amber) lines at the statistics\' boundaries', () => {
        const p = ind();
        const o: any = buildValueOverTimeOption(p.series as IndividualSeries, p.stats as IndividualStats, '°C');
        const lines = o.series[0].markLine.data;
        expect(lines.map((d: any) => d.yAxis)).toEqual([6, 4, 8, 2]); // +1SD, -1SD, +3SD, -3SD of the fixture
        expect(lines.map((d: any) => d.lineStyle.color)).toEqual([CHART.ok, CHART.ok, CHART.warn, CHART.warn]);
        expect(o.yAxis.name).toBe('°C');
        expect(o.series[0].markArea.data).toHaveLength(2); // the ±3SD and ±1SD zones
    });

    it('Distribution: bars from the histogram counts, the normal curve at the bin centres, vertical ±1SD/±3SD lines', () => {
        const p = ind();
        const o: any = buildDistributionOption(p.histogram!, individualVLines(p.stats as IndividualStats), '°C');
        const bars = o.series[0];
        expect(bars.type).toBe('custom');
        expect(bars.data).toEqual([[0, 2, 10], [2, 4, 150], [4, 6, 700], [6, 8, 130], [8, 10, 10]]);
        const curve = o.series[1];
        expect(curve.type).toBe('line');
        expect(curve.data.map((d: number[]) => d[0])).toEqual([1, 3, 5, 7, 9]); // bin centres
        expect(curve.markLine.data.map((d: any) => d.xAxis)).toEqual([4, 6, 2, 8]);
        expect(o.xAxis.min).toBe(0);
        expect(o.xAxis.max).toBe(10);
        expect(o.yAxis.max).toBeGreaterThan(710); // headroom above the tallest bar / curve
    });

    it('Distribution: the custom bar series draws a rect spanning its bin edges', () => {
        const p = ind();
        const o: any = buildDistributionOption(p.histogram!, [], '');
        const api = {
            value: (i: number) => [0, 2, 10][i],
            coord: ([x, y]: number[]) => [x * 10, 100 - y],
            style: () => ({ fill: 'x' }),
        };
        const r = o.series[0].renderItem({}, api);
        expect(r.type).toBe('rect');
        expect(r.shape).toMatchObject({ x: 0, y: 90, height: 10 });
        expect(r.shape.width).toBeGreaterThan(0);
    });

    it('estimates the rows outside ±3SD from the histogram (whole bins outside count fully, the edge bin in proportion)', () => {
        const stats = { ...(ind().stats as IndividualStats), boundary_3sd: [2, 8] as [number, number] };
        const h = { bin_edges: [0, 1, 2, 3, 8, 9, 10], counts: [5, 5, 5, 100, 5, 5], curve: [], bin_width: 1, n: 125 };
        expect(estimateRowsOutside3sd(h, stats)).toBe(20); // bins [0,1] [1,2] [8,9] [9,10]
        const half = estimateRowsOutside3sd({ bin_edges: [0, 4, 12], counts: [10, 10], curve: [], bin_width: 4, n: 20 }, stats);
        expect(half).toBe(10 * 0.5 + 10 * 0.5); // 2 of [0,4] is outside; 4 of the 8-wide [4,12] bin is outside
        expect(estimateRowsOutside3sd(null, stats)).toBeNull();
    });
});

describe('Relationship charts', () => {
    it('Fit: the Actual and Relation-model series against the chosen predictor, skipping missing predictions', () => {
        const p = rel();
        const fit = { ...p.fit_scatter!, predicted: [10, null, 12, 11, 10] as (number | null)[] };
        const o: any = buildFitScatterOption(fit, '°C');
        expect(o.series.map((s: any) => s.name)).toEqual(['Actual', 'Relation model']);
        expect(o.series[0].data).toHaveLength(5);
        expect(o.series[1].data).toHaveLength(4);
        expect(o.xAxis.name).toBe('A'); // the fixture's first predictor
        expect(o.yAxis.name).toBe('°C');
    });

    it('Target vs predicted: Actual and Predicted lines over time', () => {
        const p = rel();
        const o: any = buildTargetVsPredictedOption(p.series as RelationshipSeries, '°C');
        expect(o.series.map((s: any) => s.name)).toEqual(['Actual', 'Predicted']);
        expect(o.series[0].lineStyle.color).toBe(CHART.actual);
        expect(o.series[1].lineStyle.color).toBe(CHART.predicted);
    });

    it('Residual over time: the ±2RMSE band and zero line, and nothing about set points or a distribution', () => {
        const p = rel();
        const two = (p.stats as RelationshipStats).two_rmse;
        const o: any = buildResidualOption(p.series as RelationshipSeries, two, '°C');
        expect(o.series).toHaveLength(1);
        expect(o.series[0].name).toBe('Residual');
        expect(o.series[0].markLine.data.map((d: any) => d.yAxis)).toEqual([two, -two, 0]);
        expect(o.series[0].markArea.data[0][0].yAxis).toBe(-two);
        expect(JSON.stringify(o)).not.toMatch(/histogram|distribution/i);
        expect(o.yAxis.max).toBeGreaterThanOrEqual(two);
    });
});

describe('Clustering chart', () => {
    it('one point series per cluster (+ "No cluster"), a 1× and a 3× ring per cluster, and a label at every centre', () => {
        const p = clu(2);
        const o: any = buildClusterOption(p.cluster_scatter!, (p.stats as ClusteringStats).clusters, { x: 'X', y: 'Y' });
        const names = o.series.map((s: any) => s.name);
        expect(names).toEqual(expect.arrayContaining(['Cluster 1', 'Cluster 2', 'No cluster']));
        expect(names.filter((n: string) => /1× SD$/.test(n))).toHaveLength(2);
        expect(names.filter((n: string) => /3× SD$/.test(n))).toHaveLength(2);
        const centres = o.series.find((s: any) => s.name === 'Centres');
        expect(centres.data).toEqual([[10, 20], [20, 40]]);
        expect(centres.label.formatter({ dataIndex: 1 })).toBe('Cluster 2');
        expect(o.xAxis.name).toBe('X');
        expect(o.yAxis.name).toBe('Y');
    });

    it('the rings are green (1×, solid) and amber (3×, dashed)', () => {
        const p = clu(1);
        const o: any = buildClusterOption(p.cluster_scatter!, (p.stats as ClusteringStats).clusters, { x: 'X', y: 'Y' });
        expect(o.series.find((s: any) => /1× SD/.test(s.name)).itemStyle.color).toBe(CHART.ok);
        expect(o.series.find((s: any) => /3× SD/.test(s.name)).itemStyle.color).toBe(CHART.warn);
    });

    it('ellipseSeries draws a closed polygon of the cluster\'s SDs, rotated by angle_deg', () => {
        const api = { coord: (pt: number[]) => pt };
        const params = { coordSys: { x: 0, y: 0, width: 100, height: 100 } };
        const flat: any = ellipseSeries({ x_center: 0, y_center: 0, x_sd: 2, y_sd: 1, angle_deg: 0 }, 3, { name: 'r', stroke: '#fff' });
        const pts = flat.renderItem(params, api).shape.points as number[][];
        expect(pts.length).toBeGreaterThanOrEqual(72); // a point every 5 degrees (the polygon closes itself)
        expect(Math.max(...pts.map(p => p[0]))).toBeCloseTo(6, 5); // 3 x x_sd
        expect(Math.max(...pts.map(p => p[1]))).toBeCloseTo(3, 5); // 3 x y_sd
        const turned: any = ellipseSeries({ x_center: 0, y_center: 0, x_sd: 2, y_sd: 1, angle_deg: 90 }, 3, { name: 'r', stroke: '#fff' });
        const pts2 = turned.renderItem(params, api).shape.points as number[][];
        expect(Math.max(...pts2.map(p => p[0]))).toBeCloseTo(3, 5);
        expect(Math.max(...pts2.map(p => p[1]))).toBeCloseTo(6, 5);
    });
});
