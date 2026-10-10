import { describe, it, expect, vi } from 'vitest';
import {
    REF_LABEL_GUTTER,
    REF_LABEL_MIN_GAP,
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
    stackedEdgeLabels,
    wallClockMs,
    type HLine,
} from '../components/windows/workbench/healthCharts';
import { CHART, CLUSTER_COLORS, fmtClusterBound, fmtNum } from '../components/windows/workbench/chartTheme';
import { fmtNum as fmtNumApp } from '../components/sensor/sensorInfo';
import { formatDataStamp } from '../components/windows/periodDisplay';
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
    it('rounds a range out to 1/2/5 steps and returns that step as the third value', () => {
        expect(niceExtent(62.884400945773835, 80.6762832)).toEqual([60, 85, 5]);
        expect(niceExtent(-4.3, 5.2)).toEqual([-6, 6, 2]);
    });
    it('both ends are whole multiples of the step, with no float noise (0.1 × 3 is 0.3, not 0.30000000000000004)', () => {
        expect(niceExtent(0.31, 0.74)).toEqual([0.3, 0.8, 0.1]);
        expect(niceExtent(-0.04, 0.26)).toEqual([-0.05, 0.3, 0.05]);
        for (const [lo, hi] of [[0.31, 0.74], [36.1987, 41.0443], [-1234.5, 99.9], [1e-7, 9e-7]]) {
            const [min, max, step] = niceExtent(lo, hi);
            expect(min).toBeLessThanOrEqual(lo);
            expect(max).toBeGreaterThanOrEqual(hi);
            const n = (max - min) / step!;
            expect(Math.abs(n - Math.round(n))).toBeLessThan(1e-9); // a whole number of steps: every tick is on the grid
            expect(Math.round(n)).toBeGreaterThanOrEqual(3);
            expect(Math.round(n)).toBeLessThanOrEqual(10);
        }
        expect(Object.is(niceExtent(-0.4, 0.4)[0], -0)).toBe(false);
    });
    it('leaves a degenerate range alone, with NO step (the axis then scales itself)', () => {
        expect(niceExtent(3, 3)).toEqual([3, 3]);
        expect(niceExtent(3, 3)[2]).toBeUndefined();
        expect(niceExtent(0, NaN)[2]).toBeUndefined();
    });
});

// Review of 0125190, item 11: the chart's time axis used `new Date(text)`, so a CSV whose stamps
// carry an offset ("…+07:00", "Z") was drawn shifted on a PC in another time zone — while the
// read-outs beside it (`formatDataStamp`) showed the stamp's own clock.
describe('wallClockMs / parseTimestamps: a stamp sits at its OWN wall-clock time', () => {
    const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0) => new Date(y, mo - 1, d, h, mi, s, ms).getTime();

    it('reads the usual CSV shapes as local wall-clock time', () => {
        expect(wallClockMs('2026-02-09 23:50:00')).toBe(local(2026, 2, 9, 23, 50));
        expect(wallClockMs('2026-02-09T23:50:07')).toBe(local(2026, 2, 9, 23, 50, 7));
        expect(wallClockMs('2026-02-09 23:50')).toBe(local(2026, 2, 9, 23, 50));
        expect(wallClockMs('2026/2/9 7:05')).toBe(local(2026, 2, 9, 7, 5));
        expect(wallClockMs('  2026-02-09 23:50:00  ')).toBe(local(2026, 2, 9, 23, 50));
        expect(wallClockMs('2026-02-09 23:50:07.250')).toBe(local(2026, 2, 9, 23, 50, 7, 250));
        expect(wallClockMs('2026-02-09 23:50:07,5')).toBe(local(2026, 2, 9, 23, 50, 7, 500));
        expect(wallClockMs('2026-02-09 23:50:07.123456')).toBe(local(2026, 2, 9, 23, 50, 7, 123));
        // a date alone is that day's LOCAL midnight (`new Date('2026-02-09')` would be UTC midnight)
        expect(wallClockMs('2026-02-09')).toBe(local(2026, 2, 9));
    });

    it('an explicit zone is IGNORED: the same clock time whatever offset the file wrote, on any PC', () => {
        const want = local(2026, 2, 9, 23, 50);
        for (const zone of ['Z', 'z', '+07:00', '+0700', '+07', '-05:00', ' +07:00', '+00:00', '+14:00']) {
            expect(wallClockMs(`2026-02-09T23:50:00${zone}`), zone).toBe(want);
        }
        expect(wallClockMs('2026-02-09 23:50Z')).toBe(want);
        expect(wallClockMs('2026-02-09T23:50:00.000+07:00')).toBe(want);
        // `new Date` is what moves it: these two instants are 12 hours apart, the clock time is the same
        expect(new Date('2026-02-09T23:50:00+07:00').getTime()).not.toBe(new Date('2026-02-09T23:50:00-05:00').getTime());
        expect(wallClockMs('2026-02-09T23:50:00+07:00')).toBe(wallClockMs('2026-02-09T23:50:00-05:00'));
    });

    it('agrees with formatDataStamp — the axis and the read-out next to it show the same time', () => {
        const stamps = [
            '2026-02-09 23:50:00', '2026-02-09T23:50:00+07:00', '2026-02-09T00:05:00Z', '2026-12-31 23:59:59', '2024-02-29 12:00:00',
            '2026/1/5 6:07', '2026-02-09', '2026-02-09T23:50:00.5-08:00',
        ];
        const pad = (n: number) => String(n).padStart(2, '0');
        const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        for (const s of stamps) {
            const d = new Date(wallClockMs(s));
            // the axis draws the LOCAL fields of the ms value: they must be the stamp's own clock
            expect(`${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`, s).toBe(formatDataStamp(s));
        }
    });

    it('anything else is NaN (the caller falls back to Date, then to a category axis)', () => {
        for (const s of ['', 'nope', '09/02/2026 23:50', '2026-13-01 00:00', '2026-02-09 25:00', '2026-02-09 23:61', '2026-02-09T', '2026-02-09 23:50:00 PM', '2026-02-09 23:50:00+7', '20260209', '2026-02-09 23:50:0']) {
            expect(Number.isNaN(wallClockMs(s)), s).toBe(true);
        }
    });

    it('a whole year of rows is exactly what Date gives for the same local fields', () => {
        const pad = (n: number) => String(n).padStart(2, '0');
        let bad = 0;
        for (let day = 0; day < 366; day++) {
            const base = new Date(2026, 0, 1 + day);
            for (const [h, mi] of [[0, 0], [1, 30], [2, 30], [3, 0], [12, 0], [23, 59]]) {
                const s = `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())} ${pad(h)}:${pad(mi)}:00`;
                if (wallClockMs(s) !== new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, mi).getTime()) bad++;
            }
        }
        expect(bad).toBe(0);
    });

    it('the PC offset is looked up once per DAY, not once per row (reading a series is not slower than before)', () => {
        const spy = vi.spyOn(Date.prototype, 'getTimezoneOffset');
        try {
            const day = Array.from({ length: 1440 }, (_, m) => `2033-05-17 ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`);
            expect(parseTimestamps(day)).toHaveLength(1440);
            expect(spy.mock.calls.length).toBeLessThanOrEqual(2); // the day's start and end
        } finally {
            spy.mockRestore();
        }
    });

    it('on a day the PC clock changes (DST) the stamp is still what Date gives for those fields', () => {
        // Pretend the day starts at UTC+1 and ends at UTC+2: the per-day shortcut must step aside.
        const spy = vi.spyOn(Date.prototype, 'getTimezoneOffset').mockImplementation(function (this: Date) {
            return this.getHours() < 12 ? -60 : -120;
        });
        try {
            expect(wallClockMs('2031-03-30 01:30:00')).toBe(new Date(2031, 2, 30, 1, 30).getTime());
            expect(wallClockMs('2031-03-30 18:00:00')).toBe(new Date(2031, 2, 30, 18, 0).getTime());
        } finally {
            spy.mockRestore();
        }
        // and the next ordinary day is back on the shortcut, still exact
        expect(wallClockMs('2031-03-31 18:00:00')).toBe(new Date(2031, 2, 31, 18, 0).getTime());
    });

    it('parseTimestamps: offset stamps keep their own clock and their spacing; another shape still goes through Date', () => {
        // three different zones on purpose: whatever zone this PC is in, `new Date` would move at least two of them
        const ms = parseTimestamps(['2026-02-09T22:00:00+07:00', '2026-02-09T23:00:00-05:00', '2026-02-10T00:00:00Z'])!;
        expect(ms).toEqual([local(2026, 2, 9, 22), local(2026, 2, 9, 23), local(2026, 2, 10, 0)]);
        expect(ms[1] - ms[0]).toBe(3600_000); // the rows stay an hour apart on the axis, as their clocks say
        // a date-only stamp and a full one of the same day are on the same LOCAL day (not UTC midnight)
        expect(parseTimestamps(['2026-02-09', '2026-02-09 12:00:00'])).toEqual([local(2026, 2, 9), local(2026, 2, 9, 12)]);
        const other = parseTimestamps(['Feb 9, 2026 23:50:00'])!;
        expect(other[0]).toBe(new Date('Feb 9, 2026 23:50:00').getTime());
        // the chart's X data is those values
        const o: any = buildTimeSeriesOption({ timestamps: ['2026-02-09T22:00:00+07:00', '2026-02-09T23:00:00+07:00'], lines: [{ name: 'V', values: [1, 2], color: '#fff' }] });
        expect(o.xAxis.type).toBe('time');
        expect(o.series[0].data.map((d: number[]) => d[0])).toEqual([local(2026, 2, 9, 22), local(2026, 2, 9, 23)]);
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

    // Review of 0125190, must-fix 1: ECharts places a line's end label only while it animates the
    // line in, so after a zoom the name stayed behind and could sit beside the OTHER line. A data
    // line is therefore never named on the plot.
    it('a data line is NEVER named on the plot: no end label on any series, and no gutter kept for one', () => {
        const o: any = buildTimeSeriesOption({
            ...spec,
            lines: [spec.lines[0], { name: 'W', values: [1, 1, 1], color: '#abc' }],
        });
        for (const s of o.series) {
            expect(s.endLabel).toBeUndefined();
            expect(s.label).toBeUndefined();
            expect(s.labelLayout).toBeUndefined();
        }
        expect(o.grid.right).toBe(18);
        expect(JSON.stringify(o)).not.toContain('endLabel');
    });

    // Review item 3: the range is rounded to a 1/2/5 step — the axis must STEP by it too.
    it('the Y axis steps by the step its range was rounded to; a fixed yRange leaves the step to the caller', () => {
        const o: any = buildTimeSeriesOption({ ...spec, lines: [{ name: 'V', values: [1.2, 5.1, 8.7], color: '#fff' }] });
        expect([o.yAxis.min, o.yAxis.max, o.yAxis.interval]).toEqual([0, 10, 2]);
        expect((o.yAxis.max - o.yAxis.min) % o.yAxis.interval).toBe(0);
        const fixed: any = buildTimeSeriesOption({ ...spec, yRange: [0, 100] });
        expect(fixed.yAxis.interval).toBeUndefined();
    });

    // Review item 4: with L / H far from the data the whole ±3SD band is a few pixels tall and
    // "+1SD" printed on "+3SD" (both sit just above their line).
    describe('reference labels that would print on each other share ONE stacked label', () => {
        const sd = (u1: number, l1: number, u3: number, l3: number): HLine[] => [
            { y: u1, color: '#0f0', label: '+1SD', edge: 'above' },
            { y: l1, color: '#0f0', label: '−1SD', edge: 'below' },
            { y: u3, color: '#fa0', label: '+3SD', dashed: true, edge: 'above' },
            { y: l3, color: '#fa0', label: '−3SD', dashed: true, edge: 'below' },
        ];

        it('stackedEdgeLabels: lines far apart keep their own label (nothing is merged)', () => {
            expect(stackedEdgeLabels(sd(6, 4, 8, 2), 0.5).size).toBe(0);
            // exactly the minimum apart is enough
            expect(stackedEdgeLabels(sd(6, 4, 8, 2), 2).size).toBe(0);
            expect(stackedEdgeLabels([], 1).size).toBe(0);
            expect(stackedEdgeLabels(sd(6, 4, 8, 2), 0).size).toBe(0);
        });

        it('stackedEdgeLabels: a close same-side pair is carried by the OUTER line, listed top to bottom; the inner line carries nothing', () => {
            const lines = sd(6, 4, 8, 2);
            const m = stackedEdgeLabels(lines, 2.5);
            // above the lines: the +3SD line (the higher one) carries "+3SD" over "+1SD"
            expect(m.get(2)!.map(h => h.label)).toEqual(['+3SD', '+1SD']);
            expect(m.get(0)).toBeNull();
            // below the lines: the −3SD line (the lower one) carries "−1SD" over "−3SD"
            expect(m.get(3)!.map(h => h.label)).toEqual(['−1SD', '−3SD']);
            expect(m.get(1)).toBeNull();
            // +1SD and −1SD are on OPPOSITE sides of their lines: they are never merged with each other
            expect(stackedEdgeLabels([lines[0], lines[1]], 100).size).toBe(0);
        });

        it('stackedEdgeLabels: only outside labels of a +/− side take part (set points, unlabelled and centred lines are left alone)', () => {
            const m = stackedEdgeLabels([
                { y: 5, color: '#f00', label: 'H 5', inside: 'top' },
                { y: 5.1, color: '#0f0', label: '+1SD', edge: 'above' },
                { y: 5.2, color: '#888' },
                { y: 5.3, color: '#fa0', label: '80' },
                { y: NaN, color: '#fa0', label: '+3SD', edge: 'above' },
            ], 10);
            expect(m.size).toBe(0);
        });

        it('normal data (the fixture): four separate labels, as before', () => {
            const p = ind();
            const o: any = buildValueOverTimeOption(p.series as IndividualSeries, p.stats as IndividualStats, '°C');
            expect(o.series[0].markLine.data.map((d: any) => [d.label.show, d.label.formatter])).toEqual([[true, '+1SD'], [true, '−1SD'], [true, '+3SD'], [true, '−3SD']]);
            expect(o.series[0].markLine.data.every((d: any) => d.label.rich === undefined)).toBe(true);
        });

        it('a Y range 100× wider than the ±3SD band: "+3SD / +1SD" and "−1SD / −3SD" each become one two-line label in the lines\' own colours', () => {
            const o: any = buildTimeSeriesOption({
                ...spec,
                hLines: [...sd(6, 4, 8, 2), { y: 300, color: '#f00', label: 'H 300', inside: 'top' }, { y: -200, color: '#f00', label: 'L −200', inside: 'bottom' }],
            });
            const [u1, l1, u3, l3, h, l] = o.series[0].markLine.data;
            expect((8 - 6) / (o.yAxis.max - o.yAxis.min)).toBeLessThan(REF_LABEL_MIN_GAP); // the case this is for
            expect(u1.label).toEqual({ show: false });
            expect(l1.label).toEqual({ show: false });
            expect(u3.label).toMatchObject({ show: true, position: 'end', verticalAlign: 'bottom', formatter: '{l0|+3SD}\n{l1|+1SD}' });
            expect(u3.label.rich).toMatchObject({ l0: { color: '#fa0' }, l1: { color: '#0f0' } });
            expect(l3.label).toMatchObject({ show: true, position: 'end', verticalAlign: 'top', formatter: '{l0|−1SD}\n{l1|−3SD}' });
            expect(l3.label.rich).toMatchObject({ l0: { color: '#0f0' }, l1: { color: '#fa0' } });
            // the lines themselves are all still drawn, and the set points keep their own labels
            expect(o.series[0].markLine.data.map((d: any) => d.yAxis)).toEqual([6, 4, 8, 2, 300, -200]);
            expect([h.label.formatter, l.label.formatter]).toEqual(['H 300', 'L −200']);
            expect(o.grid.right).toBe(REF_LABEL_GUTTER); // stacked, not side by side: the gutter does not grow
        });
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
        expect(JSON.stringify(o)).not.toContain('rgba(229, 169, 61, 0.07)'); // the amber ±3SD fill that is gone
        expect(Object.keys(CHART)).not.toContain('warnFill');
        expect(Object.keys(CHART)).not.toContain('dangerFill');
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
        // review item 3: each axis STEPS by the step it was rounded to, so no tick is added at a raw end
        expect([o.xAxis.interval, o.yAxis.interval, wide.xAxis.interval]).toEqual([1, 200, 2]);
        for (const a of [o.xAxis, o.yAxis, wide.xAxis]) expect((a.max - a.min) % a.interval).toBe(0);
    });

    // Review item 7: `Math.min()` of nothing is Infinity — the X axis was `min: Infinity, max: -Infinity`.
    it('Distribution with nothing finite to measure: the X axis is left to ECharts, never ±Infinity / NaN', () => {
        const empty = { bin_edges: [], counts: [], curve: [], bin_width: 0, n: 0 };
        const o: any = buildDistributionOption(empty, [], '°C');
        expect('min' in o.xAxis).toBe(false);
        expect('max' in o.xAxis).toBe(false);
        expect('interval' in o.xAxis).toBe(false);
        expect(o.xAxis.axisLabel.formatter(0.1 * 3)).toBe('0.3'); // still the app's tick formatter
        expect([o.yAxis.min, o.yAxis.max, o.yAxis.interval]).toEqual([0, 1.2, 0.2]);
        expect(JSON.stringify(o)).not.toMatch(/Infinity|NaN/);
        expect(o.series[0].data).toEqual([]);
        // NaN bins / lines are not measured either
        const nan: any = buildDistributionOption({ bin_edges: [NaN, NaN], counts: [NaN], curve: [NaN], bin_width: NaN, n: 0 }, [{ x: NaN, color: '#fff' }], '');
        expect('min' in nan.xAxis).toBe(false);
        expect(Number.isFinite(nan.yAxis.max)).toBe(true);
        // one finite reference line alone has no width to round: left to ECharts as well
        const one: any = buildDistributionOption(empty, [{ x: 5, color: '#fff' }], '');
        expect('min' in one.xAxis).toBe(false);
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

    // Review of 0125190, must-fix 1 (replaces "Actual / Predicted at the line ends"): the names are
    // the card's own colour key (ModelFitPage); the chart draws no name that a zoom could misplace.
    it('Target vs predicted: the two lines carry NO name on the plot (the card keeps the Actual / Predicted colour key)', () => {
        const p = rel();
        const o: any = buildTargetVsPredictedOption(p.series as RelationshipSeries, '°C');
        expect(o.series.map((s: any) => s.endLabel)).toEqual([undefined, undefined]);
        expect(o.series.map((s: any) => s.labelLayout)).toEqual([undefined, undefined]);
        expect(o.grid.right).toBe(18); // no gutter: the plot uses the width
        expect(o.legend).toEqual({ show: false }); // the key is the card's, not an ECharts legend
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

    it('the level names of a FLAT cluster are staggered one text line apart, in level order (first level up, last level down)', () => {
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

    // Review of 0125190, must-fix 2: with a fixed "first up, last down" the names of a cluster tilted
    // up to the right (positively correlated sensors — the usual shape) were pushed INTO each other:
    // there the 1× edge is the LOWEST point and the N× edge the highest.
    it('the stagger FOLLOWS THE DATA: the name whose ring edge is highest goes up, the lowest down — for a tilt either way', () => {
        const lv = [1, 3, 5].map((sigma, i) => ({ sigma, text: `L${i}`, color: '#fff' }));
        const of = (angle_deg: number) => ringLabelSeries([makeClusterStat(1, { x_center: 10, y_center: 20, x_sd: 4, y_sd: 0.3, angle_deg })], lv).data;
        // tilted UP to the right: the edge rises with the level …
        const up = of(2);
        expect(up[0].value[1]).toBeLessThan(up[1].value[1]);
        expect(up[1].value[1]).toBeLessThan(up[2].value[1]);
        // … so the 1× name goes DOWN (+) and the N× name UP (−): away from each other
        expect(up.map(d => d.label.offset)).toEqual([[0, RING_LABEL_LINE], [0, 0], [0, -RING_LABEL_LINE]]);
        // tilted DOWN to the right: the mirror image
        const down = of(-2);
        expect(down[0].value[1]).toBeGreaterThan(down[2].value[1]);
        expect(down.map(d => d.label.offset)).toEqual([[0, -RING_LABEL_LINE], [0, 0], [0, RING_LABEL_LINE]]);
        // the rule in one line: a higher edge (larger y) never gets a lower place (a larger offset)
        for (const data of [up, down, of(45), of(-80), of(0)]) {
            for (const a of data) for (const b of data) {
                if (a.value[1] > b.value[1]) expect(a.label.offset[1]).toBeLessThan(b.label.offset[1]);
            }
            expect(new Set(data.map(d => d.label.offset[1])).size).toBe(data.length); // never two names on one line
        }
        // two levels (Model fit: 1×, 3×) follow the same rule
        const two = ringLabelSeries([makeClusterStat(1, { x_sd: 4, y_sd: 0.3, angle_deg: 30 })], lv.slice(0, 2)).data;
        expect(two.map(d => d.label.offset)).toEqual([[0, RING_LABEL_LINE / 2], [0, -RING_LABEL_LINE / 2]]);
    });

    it('levels whose furthest ring belongs to DIFFERENT clusters are ordered by their own heights too (not by level number)', () => {
        // 1×: the narrow cluster on the right, high up · 3×: the wide cluster on the left, low down
        const wide = makeClusterStat(1, { x_center: 0, y_center: 0, x_sd: 10, y_sd: 1 });
        const narrow = makeClusterStat(2, { x_center: 15, y_center: 50, x_sd: 1, y_sd: 1 });
        const s = ringLabelSeries([wide, narrow], [{ sigma: 1, text: 'a', color: '#fff' }, { sigma: 3, text: 'b', color: '#fff' }]);
        expect(s.data.map(d => d.value)).toEqual([[16, 50], [30, 0]]);
        expect(s.data.map(d => d.label.offset[1])).toEqual([-RING_LABEL_LINE / 2, RING_LABEL_LINE / 2]); // "a" is higher: up
        // a level with no ring to measure is left out and does not leave a hole in the stagger
        const broken = ringLabelSeries([makeClusterStat(1, { angle_deg: 20 })], [{ sigma: 1, text: 'a', color: '#fff' }, { sigma: NaN, text: 'x', color: '#fff' }, { sigma: 3, text: 'b', color: '#fff' }]);
        expect(broken.data.map(d => d.name)).toEqual(['a', 'b']);
        expect(broken.data.map(d => d.label.offset[1])).toEqual([RING_LABEL_LINE / 2, -RING_LABEL_LINE / 2]);
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
        // review item 3: both axes step by the step they were rounded to
        expect(o.xAxis.interval).toBeGreaterThan(0);
        expect((o.xAxis.max - o.xAxis.min) % o.xAxis.interval).toBe(0);
        expect((o.yAxis.max - o.yAxis.min) % o.yAxis.interval).toBe(0);
        const ex = clusterExtent(scatter.x, scatter.y, [big], [1, 3]);
        expect([o.xAxis.min, o.xAxis.max, o.xAxis.interval]).toEqual(ex.x);
        expect([o.yAxis.min, o.yAxis.max, o.yAxis.interval]).toEqual(ex.y);
    });

    // Review item 8: everything at ONE value (a constant sensor, rings of no size) gave min === max.
    it('a degenerate extent (every point at one value, rings of no size) opens around the value — never min === max', () => {
        const dot = makeClusterStat(1, { x_center: 5, y_center: 7, x_sd: 0, y_sd: 0 });
        const ex = clusterExtent([5, 5], [7, 7], [dot], [1, 3]);
        for (const [min, max, step] of [ex.x, ex.y]) {
            expect(max).toBeGreaterThan(min);
            expect(step).toBeGreaterThan(0);
        }
        expect(ex.x[0]).toBeLessThan(5);
        expect(ex.x[1]).toBeGreaterThan(5);
        expect(ex.y[0]).toBeLessThan(7);
        expect(ex.y[1]).toBeGreaterThan(7);
        // 5 % of the value on each side (like the time charts) …
        expect(ex.x[1] - ex.x[0]).toBeLessThan(2);
        // … and ±1 when the value is 0
        const zero = clusterExtent([0], [0], [], [1, 3]);
        expect(zero.x[0]).toBeLessThanOrEqual(-1);
        expect(zero.x[1]).toBeGreaterThanOrEqual(1);
        expect(zero.y[0]).toBeLessThanOrEqual(-1);
        // only ONE axis flat (a constant Y sensor): X keeps its real range
        const flatY = clusterExtent([1, 9], [3, 3], [], [1, 3]);
        expect(flatY.x[0]).toBeLessThanOrEqual(1);
        expect(flatY.x[1]).toBeGreaterThanOrEqual(9);
        expect(flatY.y[1]).toBeGreaterThan(flatY.y[0]);
        // the chart gets real axes
        const o: any = buildClusterOption({ x: [5, 5], y: [7, 7], cluster: [1, 1], total: 2 }, [dot], { x: 'X', y: 'Y' });
        expect(o.xAxis.max).toBeGreaterThan(o.xAxis.min);
        expect(o.yAxis.max).toBeGreaterThan(o.yAxis.min);
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
        // review item 9: a negative zero (dragging a boundary down to 0) reads "0", never "-0"
        expect(fmtClusterBound(-0)).toBe('0');
        expect(fmtClusterBound(-0.5)).toBe('-0.5'); // a real negative keeps its sign
    });

    // Review item 10: chartTheme held a second, older `fmtNum` that printed a non-zero value below
    // 0.0005 as "0.000" — against the app's number rule (a non-zero value never shows as 0).
    it('the Workbench number formatter IS the app\'s fmtNum (plus "—" for no value and "0" for a negative zero)', () => {
        for (const v of [0, 1, 4.5, 12.5, 150.25, 1234.5678, 0.4567, 0.9123, 0.0002, -0.00004, 1e-9, 12345678901, -3.14159]) {
            expect(fmtNum(v), String(v)).toBe(fmtNumApp(v));
        }
        expect(fmtNum(0.0002)).toBe('0.0002'); // was "0.000"
        expect(fmtNum(-0.00004)).toBe('-0.00004'); // was "0.000"
        expect(fmtNum(12.5)).toBe('12.5'); // was the padded "12.50"
        expect(fmtNum(1234.5678)).toBe('1,234.568'); // was the rounded "1,235"
        expect(fmtNum(-0)).toBe('0');
        expect(fmtNum(null)).toBe('—');
        expect(fmtNum(undefined)).toBe('—');
        expect(fmtNum(NaN)).toBe('—');
        // the chart tooltips read through it too
        const o: any = buildTimeSeriesOption({ timestamps: ['2026-01-01 00:00:00'], lines: [{ name: 'V', values: [1], color: '#fff' }] });
        expect(o.tooltip.valueFormatter(0.0002)).toBe('0.0002');
        expect(o.tooltip.valueFormatter(null)).toBe('');
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
