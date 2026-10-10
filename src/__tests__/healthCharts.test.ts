import { describe, it, expect } from 'vitest';
import {
    END_LABEL_GUTTER,
    REF_LABEL_GUTTER,
    buildClusterOption,
    buildDistributionOption,
    buildFitScatterOption,
    buildResidualOption,
    buildTargetVsPredictedOption,
    buildTimeSeriesOption,
    buildValueOverTimeOption,
    clusterExtent,
    ellipseSeries,
    estimateRowsOutside3sd,
    individualVLines,
    niceExtent,
    parseTimestamps,
    ringBox,
    RING_LABEL_LINE,
    ringLabelSeries,
    ringRightPoint,
    sensorAxisTitle,
} from '../components/windows/workbench/healthCharts';
import { CHART, CLUSTER_COLORS, fmtClusterBound } from '../components/windows/workbench/chartTheme';
import { makeClusterStat, makeHealthPreview } from './helpers/healthPreviewFixture';
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

    // workbench-redesign SPEC §3: a reference line is thin and named OUTSIDE the plot, on its
    // right edge (the grid keeps a gutter for the text); one of the user's set points is the
    // strongest line and carries its label INSIDE the plot at the right end.
    it('reference-line labels sit at the right edge OUTSIDE the plot; a set point is labelled inside, above or below its line', () => {
        const o: any = buildTimeSeriesOption({
            ...spec,
            hLines: [
                { y: 5, color: '#0f0', label: '+1SD' },
                { y: 9, color: '#f00', label: 'H 9', width: 1.5, inside: 'top' },
                { y: 1, color: '#f00', label: 'L 1', width: 1.5, inside: 'bottom' },
                { y: 0, color: '#888' }, // no label: a plain line
            ],
        });
        const [ref, h, l, zero] = o.series[0].markLine.data;
        expect(ref.label).toMatchObject({ show: true, formatter: '+1SD', position: 'end', fontWeight: 'normal' });
        expect(ref.lineStyle.width).toBe(1);
        expect(h.label).toMatchObject({ show: true, formatter: 'H 9', position: 'insideEndTop', fontWeight: 600 });
        expect(l.label).toMatchObject({ show: true, formatter: 'L 1', position: 'insideEndBottom', fontWeight: 600 });
        // the user's lines are the strongest
        expect(h.lineStyle.width).toBeGreaterThan(ref.lineStyle.width);
        expect(l.lineStyle.width).toBe(h.lineStyle.width);
        expect(zero.label).toEqual({ show: false });
        // every label is at the END of its line — none on the left, none floating at the top
        for (const m of [ref, h, l]) expect(m.label.position).toMatch(/^(end|insideEnd(Top|Bottom))$/);
        expect(o.grid.right).toBe(REF_LABEL_GUTTER);
        expect(o.legend).toEqual({ show: false });
    });

    it('a +/− pair of reference lines keeps its two outside labels apart: the + label sits above its line end, the − label below', () => {
        const o: any = buildTimeSeriesOption({
            ...spec,
            // 0.001 apart on an axis 200 wide: the two lines are on the same pixel row
            hLines: [{ y: 0.0005, color: '#0f0', label: '+2RMSE', edge: 'above' }, { y: -0.0005, color: '#0f0', label: '−2RMSE', edge: 'below' }, { y: 100, color: '#888', label: '80' }, { y: -100, color: '#888' }],
        });
        const [plus, minus, plain] = o.series[0].markLine.data;
        expect(plus.label).toMatchObject({ position: 'end', verticalAlign: 'bottom' }); // text above the line
        expect(minus.label).toMatchObject({ position: 'end', verticalAlign: 'top' }); // text below the line
        expect(plain.label).toMatchObject({ position: 'end', verticalAlign: 'middle' }); // a single line: centred on it
    });

    it('the right gutter exists only when something is labelled there', () => {
        const none: any = buildTimeSeriesOption(spec);
        expect(none.grid.right).toBe(18);
        // set-point labels sit inside the plot: they need no gutter
        const inside: any = buildTimeSeriesOption({ ...spec, hLines: [{ y: 9, color: '#f00', label: 'H 9', inside: 'top' }] });
        expect(inside.grid.right).toBe(18);
        const unlabelled: any = buildTimeSeriesOption({ ...spec, hLines: [{ y: 0, color: '#888' }] });
        expect(unlabelled.grid.right).toBe(18);
    });

    it('a line with `endLabel` names itself at its right end; one without has no end label', () => {
        const o: any = buildTimeSeriesOption({
            ...spec,
            lines: [{ ...spec.lines[0], endLabel: 'Actual' }, { name: 'W', values: [1, 1, 1], color: '#abc' }],
        });
        expect(o.series[0].endLabel).toMatchObject({ show: true, formatter: 'Actual', color: '#fff' });
        expect(o.series[0].labelLayout).toEqual({ moveOverlap: 'shiftY' });
        expect(o.series[1].endLabel).toBeUndefined();
        expect(o.grid.right).toBe(END_LABEL_GUTTER);
        expect(END_LABEL_GUTTER).toBeGreaterThan(REF_LABEL_GUTTER); // "Predicted" is longer than "+2RMSE"
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
    });

    // workbench-redesign SPEC §3: "Only the 100 band is filled; ±3SD is a dashed line."
    it('value over time: ONLY the score-100 band (±1SD) is filled; ±3SD is a dashed line with no fill', () => {
        const p = ind();
        const o: any = buildValueOverTimeOption(p.series as IndividualSeries, p.stats as IndividualStats, '°C');
        const bands = o.series[0].markArea.data;
        expect(bands).toHaveLength(1);
        expect(bands[0][0]).toEqual({ yAxis: 4, itemStyle: { color: CHART.okFill } });
        expect(bands[0][1]).toEqual({ yAxis: 6 });
        expect(JSON.stringify(o)).not.toContain(CHART.warnFill);
        const lines = o.series[0].markLine.data;
        expect(lines.map((d: any) => d.lineStyle.type)).toEqual(['solid', 'solid', 'dashed', 'dashed']);
        // the four reference lines are named at the right edge, outside the plot — so the card needs no legend
        expect(lines.map((d: any) => [d.label.formatter, d.label.position])).toEqual([['+1SD', 'end'], ['−1SD', 'end'], ['+3SD', 'end'], ['−3SD', 'end']]);
        expect(lines.map((d: any) => d.label.verticalAlign)).toEqual(['bottom', 'top', 'bottom', 'top']); // + above, − below its line
        expect(o.grid.right).toBe(REF_LABEL_GUTTER);
        // the Y range still holds the ±3SD lines although they carry no band any more
        expect(o.yAxis.min).toBeLessThanOrEqual(2);
        expect(o.yAxis.max).toBeGreaterThanOrEqual(8);
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

    // workbench-redesign SPEC §3: "Axes use round ticks on both axes, with no raw extremes (Distribution x/y)."
    it('Distribution: both axes end on round ticks — never a raw bin edge or count — and the X axis holds every reference line', () => {
        const h = { bin_edges: [36.1987, 37.4, 38.6, 39.8, 41.0443], counts: [3, 400, 942, 87], curve: [5, 380, 942.7, 90], bin_width: 1.2, n: 1432 };
        const o: any = buildDistributionOption(h, [], '°C');
        expect([o.xAxis.min, o.xAxis.max]).toEqual([36, 42]); // 36.1987 … 41.0443 rounded out to the 1-step ticks
        expect(o.xAxis.min).toBeLessThanOrEqual(h.bin_edges[0]);
        expect(o.xAxis.max).toBeGreaterThanOrEqual(h.bin_edges[4]);
        expect([o.yAxis.min, o.yAxis.max]).toEqual([0, 1200]); // 942.7 × 1.1 rounded up
        // the bars themselves are untouched: still drawn at their real bin edges
        expect(o.series[0].data[0]).toEqual([36.1987, 37.4, 3]);
        // a ±3SD line beyond the outermost bin is still on the axis
        const wide: any = buildDistributionOption(h, [{ x: 33.31, color: CHART.warn, label: '−3SD' }, { x: 44.07, color: CHART.warn, label: '+3SD' }], '°C');
        expect(wide.xAxis.min).toBeLessThanOrEqual(33.31);
        expect(wide.xAxis.max).toBeGreaterThanOrEqual(44.07);
        expect([wide.xAxis.min, wide.xAxis.max]).toEqual([32, 46]);
        for (const v of [o.xAxis.min, o.xAxis.max, wide.xAxis.min, wide.xAxis.max]) expect(Number.isInteger(v)).toBe(true);
    });

    // 🆕 2026-10-09 (real-app report): the Distribution chart's top y label read
    // "1,713.8000000000002" — the axis max was the raw max × 1.1, printed unformatted.
    it('Distribution: the y max is a nice round count and every value-axis label goes through the app formatter', () => {
        const p = ind();
        const h = { ...p.histogram!, counts: [10, 150, 1558, 130, 10] }; // 1558 × 1.1 = 1713.8000000000002
        const o: any = buildDistributionOption(h, [], '°C');
        expect(o.yAxis.max).toBe(1800); // 1713.8 rounded up to the 200-step nice tick
        expect(o.yAxis.axisLabel.formatter(1713.8000000000002)).toBe('1,713.8');
        expect(o.xAxis.axisLabel.formatter(0.30000000000000004)).toBe('0.3');
        expect(o.yAxis.axisLabel.color).toBe(CHART.textSecondary); // the formatter keeps the look
    });

    it('a narrow axis keeps neighbouring tick labels distinct (never a fixed 3-decimal cap)', () => {
        const lines = [{ name: 'V', values: [1, 2], color: '#fff' }];
        const timestamps = ['2026-01-01 00:00:00', '2026-01-01 01:00:00'];
        const narrow: any = buildTimeSeriesOption({ timestamps, lines, yRange: [100, 100.001] });
        const f = narrow.yAxis.axisLabel.formatter;
        expect(f(100.0002)).toBe('100.0002');
        expect(f(100.0004)).toBe('100.0004');
        expect(f(100)).toBe('100');
        const tiny: any = buildTimeSeriesOption({ timestamps, lines, yRange: [0.001, 0.002] });
        expect(tiny.yAxis.axisLabel.formatter(0.0012)).toBe('0.0012');
        expect(tiny.yAxis.axisLabel.formatter(0.0014)).toBe('0.0014');
        expect(tiny.yAxis.axisLabel.formatter(0.1 * 0.003 + 0.0009)).toBe('0.0012'); // noise trimmed
        // a long bin edge on a wide axis reads short; a near-zero tick is "0", never "-0"
        const wide: any = buildTimeSeriesOption({ timestamps, lines, yRange: [0, 50] });
        expect(wide.yAxis.axisLabel.formatter(12.345678912)).toBe('12.3');
        expect(wide.yAxis.axisLabel.formatter(-1e-17)).toBe('0');
    });

    it('every VALUE axis of the workbench charts formats its labels; time / category axes never get a number formatter', () => {
        const noisy = 0.1 * 3; // 0.30000000000000004
        const ts: any = buildTimeSeriesOption({ timestamps: ['2026-01-01 00:00:00', '2026-01-01 01:00:00'], lines: [{ name: 'V', values: [1, 2], color: '#fff' }] });
        expect(ts.yAxis.axisLabel.formatter(noisy)).toBe('0.3');
        expect(ts.xAxis.axisLabel?.formatter).toBeUndefined();
        const cat: any = buildTimeSeriesOption({ timestamps: ['a', 'b'], lines: [{ name: 'V', values: [1, 2], color: '#fff' }] });
        expect(cat.xAxis.axisLabel.formatter).toBeUndefined();
        const fit: any = buildFitScatterOption(rel().fit_scatter!, '°C');
        expect(fit.xAxis.axisLabel.formatter(noisy)).toBe('0.3');
        expect(fit.yAxis.axisLabel.formatter(noisy)).toBe('0.3');
        const c = clu();
        const cl: any = buildClusterOption(c.cluster_scatter!, (c.stats as ClusteringStats).clusters, { x: 'X', y: 'Y' });
        expect(cl.xAxis.axisLabel.formatter(noisy)).toBe('0.3');
        expect(cl.yAxis.axisLabel.formatter(noisy)).toBe('0.3');
        expect(cl.xAxis.axisLabel.color).toBe(CHART.textSecondary); // the look of the labels is kept
        expect(cl.yAxis.axisLabel.fontSize).toBe(10);
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

    // workbench-redesign SPEC §3: "No legend rows where the lines are labelled (Target vs predicted:
    // "Actual" / "Predicted" at the line ends)."
    it('Target vs predicted: each line is named at its own right end, in its own colour (no legend needed)', () => {
        const p = rel();
        const o: any = buildTargetVsPredictedOption(p.series as RelationshipSeries, '°C');
        expect(o.series.map((s: any) => [s.endLabel.show, s.endLabel.formatter, s.endLabel.color])).toEqual([
            [true, 'Actual', CHART.actual],
            [true, 'Predicted', CHART.predicted],
        ]);
        expect(o.grid.right).toBe(END_LABEL_GUTTER); // room outside the plot for the names
        expect(o.legend).toEqual({ show: false });
        // the data itself is exactly what it was: nothing added for the labels
        expect(o.series[0].data.map((d: any) => d[1])).toEqual((p.series as RelationshipSeries).actual);
        expect(o.series[1].data.map((d: any) => d[1])).toEqual((p.series as RelationshipSeries).predicted);
    });

    it('Fit: the axis lines stay on the plot\'s edge (no stray line through zero when the data straddles it)', () => {
        const o: any = buildFitScatterOption(rel().fit_scatter!, '°C');
        expect(o.xAxis.axisLine.onZero).toBe(false);
        expect(o.yAxis.axisLine.onZero).toBe(false);
        expect(o.xAxis.axisLine.lineStyle.color).toBe(CHART.gridLine);
    });

    it('Residual over time: the ±2RMSE band and zero line, and nothing about set points or a distribution', () => {
        const p = rel();
        const two = (p.stats as RelationshipStats).two_rmse;
        const o: any = buildResidualOption(p.series as RelationshipSeries, two, '°C');
        expect(o.series).toHaveLength(1);
        expect(o.series[0].name).toBe('Residual');
        expect(o.series[0].markLine.data.map((d: any) => d.yAxis)).toEqual([two, -two, 0]);
        expect(o.series[0].markArea.data).toHaveLength(1); // the ±2RMSE band = score 100: the only fill
        expect(o.series[0].markArea.data[0][0].yAxis).toBe(-two);
        expect(o.series[0].markArea.data[0][0].itemStyle.color).toBe(CHART.okFill);
        // "+2RMSE" / "−2RMSE" at the right edge outside the plot; the zero line has no label
        expect(o.series[0].markLine.data.map((d: any) => d.label.position ?? null)).toEqual(['end', 'end', null]);
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
        expect(centres.data.map((d: any) => d.value)).toEqual([[10, 20], [20, 40]]);
        expect(centres.label.formatter({ dataIndex: 1 })).toBe('Cluster 2');
        // each centre is named in its own cluster's colour
        expect(centres.data.map((d: any) => d.label.color)).toEqual([CLUSTER_COLORS[0], CLUSTER_COLORS[1]]);
        expect(o.xAxis.name).toBe('X');
        expect(o.yAxis.name).toBe('Y');
    });

    // ---- workbench-redesign SPEC §3 "Clustering" ----

    it('each ring LEVEL is named once — not once per cluster — at the edge of the ring that reaches furthest right', () => {
        const p = clu(2);
        const clusters = (p.stats as ClusteringStats).clusters; // centres x 10 / 20, x_sd 2, no rotation
        const o: any = buildClusterOption(p.cluster_scatter!, clusters, { x: 'X', y: 'Y' });
        const labels = o.series.filter((s: any) => s.name === 'Ring labels');
        expect(labels).toHaveLength(1);
        const data = labels[0].data;
        expect(data.map((d: any) => d.label.formatter)).toEqual(['1× SD', '3× SD']); // two levels, two labels (4 rings)
        expect(data.map((d: any) => d.label.color)).toEqual([CHART.ok, CHART.warn]);
        // cluster 2 reaches furthest right: 20 + 1×2 and 20 + 3×2, at its centre height
        expect(data.map((d: any) => d.value)).toEqual([[22, 40], [26, 40]]);
        expect(labels[0].label).toMatchObject({ show: true, position: 'right' });
        expect(labels[0].symbolSize).toBe(0); // text only, no extra dot
        expect(labels[0].silent).toBe(true);
        expect(labels[0].tooltip).toEqual({ show: false });
    });

    it('the level names can never print on top of each other: they are staggered one text line apart (first level up, last level down)', () => {
        // one flat cluster: every ring reaches furthest right at the SAME height, a hair apart on a wide axis
        const c = makeClusterStat(1, { x_center: 0, y_center: 0, x_sd: 0.001, y_sd: 0.001, angle_deg: 0 });
        const lv = (n: number) => Array.from({ length: n }, (_, i) => ({ sigma: i + 1, text: `L${i}`, color: '#fff' }));
        const offsets = (n: number) => ringLabelSeries([c], lv(n)).data.map(x => x.label.offset);
        expect(offsets(2)).toEqual([[0, -RING_LABEL_LINE / 2], [0, RING_LABEL_LINE / 2]]); // Model fit: 1×, 3×
        expect(offsets(3)).toEqual([[0, -RING_LABEL_LINE], [0, 0], [0, RING_LABEL_LINE]]); // Health score: 1×, 3×, N×
        expect(offsets(1)).toEqual([[0, 0]]);
        expect(RING_LABEL_LINE).toBeGreaterThanOrEqual(12); // a 9.5 px line of text on its chip
        // only vertically: every name still starts right at its own ring's edge
        for (const o of offsets(3)) expect(o[0]).toBe(0);
    });

    it('ringRightPoint follows the rotation; ringLabelSeries picks the furthest ring per level and skips a broken cluster', () => {
        const flat = makeClusterStat(1, { x_center: 10, y_center: 20, x_sd: 2, y_sd: 1, angle_deg: 0 });
        expect(ringRightPoint(flat, 3)).toEqual([16, 20]);
        const turned = ringRightPoint({ ...flat, angle_deg: 90 }, 3); // the major axis now points up
        expect(turned[0]).toBeCloseTo(13); // 10 + 3 × y_sd
        expect(turned[1]).toBeCloseTo(20);
        // 45°: the right-most point is to the right of AND above the centre, on the bounding box's edge
        const tilted = ringRightPoint({ ...flat, angle_deg: 45 }, 1);
        expect(tilted[0]).toBeCloseTo(ringBox({ ...flat, angle_deg: 45 }, 1).x[1]);
        expect(tilted[1]).toBeGreaterThan(20);
        // a wide cluster on the left can reach further right than a narrow one on the right
        const wide = makeClusterStat(1, { x_center: 0, x_sd: 10 });
        const narrow = makeClusterStat(2, { x_center: 15, x_sd: 1 });
        const s = ringLabelSeries([wide, narrow], [{ sigma: 1, text: 'a', color: '#fff' }, { sigma: 3, text: 'b', color: '#fff' }]);
        expect(s.data.map(x => x.value[0])).toEqual([16, 30]); // 1×: narrow (16 > 10) · 3×: wide (30 > 18)
        const broken = makeClusterStat(3, { x_sd: NaN });
        expect(ringLabelSeries([broken], [{ sigma: 1, text: 'a', color: '#fff' }]).data).toEqual([]);
        expect(ringLabelSeries([], [{ sigma: 1, text: 'a', color: '#fff' }]).data).toEqual([]);
    });

    it('cluster point colours never use green, amber or red (those mean score 100 / 80 / 0 on these charts)', () => {
        const hue = (hex: string) => {
            const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
            const max = Math.max(r, g, b);
            const min = Math.min(r, g, b);
            const dlt = max - min;
            const h = max === r ? ((g - b) / dlt) % 6 : max === g ? (b - r) / dlt + 2 : (r - g) / dlt + 4;
            return (h * 60 + 360) % 360;
        };
        expect(CLUSTER_COLORS.length).toBeGreaterThanOrEqual(8);
        expect(new Set(CLUSTER_COLORS).size).toBe(CLUSTER_COLORS.length);
        for (const c of CLUSTER_COLORS) {
            expect(c).toMatch(/^#[0-9a-f]{6}$/);
            // only cyan → blue → violet: red is ~0/360, amber ~40, green ~120-160
            expect(hue(c)).toBeGreaterThanOrEqual(190);
            expect(hue(c)).toBeLessThanOrEqual(280);
            expect([CHART.ok, CHART.warn, CHART.danger] as string[]).not.toContain(c);
        }
        // the hue check itself recognises the three score colours
        expect(hue(CHART.ok)).toBeLessThan(190);
        expect(hue(CHART.warn)).toBeLessThan(190);
        expect(hue(CHART.danger)).toBeLessThan(190);
        // and the chart really draws from this palette
        const p = clu(2);
        const o: any = buildClusterOption(p.cluster_scatter!, (p.stats as ClusteringStats).clusters, { x: 'X', y: 'Y' });
        expect(o.series.find((s: any) => s.name === 'Cluster 1').itemStyle.color).toBe(CLUSTER_COLORS[0]);
        expect(o.series.find((s: any) => s.name === 'Cluster 2').itemStyle.color).toBe(CLUSTER_COLORS[1]);
    });

    it('the axes include every ring (a 3× ring outside the points is never cut) and end on round ticks, with room right for the ring labels', () => {
        const big = makeClusterStat(1, { x_center: 50, y_center: 50, x_sd: 20, y_sd: 10, angle_deg: 30 });
        const scatter = { x: [49, 50, 51], y: [49, 50, 51], cluster: [1, 1, 1], total: 3 }; // points huddle at the centre
        const o: any = buildClusterOption(scatter, [big], { x: 'X', y: 'Y' });
        const box = ringBox(big, 3);
        expect(o.xAxis.min).toBeLessThanOrEqual(box.x[0]);
        expect(o.xAxis.max).toBeGreaterThanOrEqual(box.x[1]);
        expect(o.yAxis.min).toBeLessThanOrEqual(box.y[0]);
        expect(o.yAxis.max).toBeGreaterThanOrEqual(box.y[1]);
        // at least a tenth of the rings' width stays free right of the furthest ring: the ring labels are drawn there
        expect(o.xAxis.max - box.x[1]).toBeGreaterThanOrEqual((box.x[1] - box.x[0]) * 0.1);
        for (const v of [o.xAxis.min, o.xAxis.max, o.yAxis.min, o.yAxis.max]) expect(Math.abs(v % 10)).toBe(0); // 1/2/5 × 10ⁿ steps
        // the fixed extent replaces auto-scaling
        expect(o.xAxis.scale).toBeUndefined();
        // points far outside the rings widen the axes too
        const far = clusterExtent([400], [-300], [big], [1, 3]);
        expect(far.x[1]).toBeGreaterThanOrEqual(400);
        expect(far.y[0]).toBeLessThanOrEqual(-300);
        // nothing to measure: a harmless default instead of ±Infinity
        expect(clusterExtent([], [], [], [1, 3])).toEqual({ x: [0, 1], y: [0, 1] });
    });

    it('no stray x = 0 / y = 0 line: both axis lines stay on the plot\'s edge even when the data straddles zero', () => {
        const c = makeClusterStat(1, { x_center: 0, y_center: 0 });
        const o: any = buildClusterOption({ x: [-1, 1], y: [-1, 1], cluster: [1, 1], total: 2 }, [c], { x: 'X', y: 'Y' });
        expect(o.xAxis.min).toBeLessThan(0);
        expect(o.xAxis.max).toBeGreaterThan(0);
        expect(o.xAxis.axisLine).toEqual({ lineStyle: { color: CHART.gridLine }, onZero: false });
        expect(o.yAxis.axisLine).toEqual({ lineStyle: { color: CHART.gridLine }, onZero: false });
    });

    it('axis titles are description + unit (the tag only when there is no description)', () => {
        expect(sensorAxisTitle({ tag: '11JI1001.PV', description: 'GENERATOR ACTIVE POWER', unit: 'MW' })).toBe('GENERATOR ACTIVE POWER · MW');
        expect(sensorAxisTitle({ tag: '11JI1001.PV', description: 'GENERATOR ACTIVE POWER' })).toBe('GENERATOR ACTIVE POWER');
        expect(sensorAxisTitle({ tag: '11JI1001.PV', unit: 'MW' })).toBe('11JI1001.PV · MW');
        expect(sensorAxisTitle({ tag: '11JI1001.PV' })).toBe('11JI1001.PV');
        // and the chart prints exactly what it is given
        const p = clu(1);
        const o: any = buildClusterOption(p.cluster_scatter!, (p.stats as ClusteringStats).clusters, { x: 'GENERATOR ACTIVE POWER · MW', y: 'BEARING TEMP · °C' });
        expect(o.xAxis.name).toBe('GENERATOR ACTIVE POWER · MW');
        expect(o.yAxis.name).toBe('BEARING TEMP · °C');
    });

    it('a cluster range boundary prints as typed: never padded, never rounded; only auto-divide float noise is shortened', () => {
        expect(fmtClusterBound(50)).toBe('50'); // not "50.00"
        expect(fmtClusterBound(0)).toBe('0'); // not "0.000"
        expect(fmtClusterBound(33.6)).toBe('33.6');
        expect(fmtClusterBound(4.61234)).toBe('4.61234'); // not "4.612"
        expect(fmtClusterBound(0.0005)).toBe('0.0005');
        expect(fmtClusterBound(12500.5)).toBe('12,500.5');
        expect(fmtClusterBound(100 / 3)).toBe('33.333'); // 33.333333333333336 is nobody's typing
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
