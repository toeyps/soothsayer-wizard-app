import { describe, it, expect, afterEach } from 'vitest';
import * as echarts from 'echarts';
import {
    HOVER_AXIS_POINTER,
    buildResidualOption,
    buildTargetVsPredictedOption,
    buildTimeSeriesOption,
    buildValueOverTimeOption,
    hourlyScopes,
    timeHeadingFormatter,
    wallClockMs,
    type TimeScopes,
} from '../components/windows/workbench/healthCharts';
import { buildIndividualSetPointOption, buildRelationshipSetPointOption, buildScoreOption } from '../components/windows/workbench/healthPageCharts';
import { formatDataStamp } from '../components/windows/periodDisplay';
import { makeHealthPreview } from './helpers/healthPreviewFixture';
import type { IndividualSeries, IndividualStats, RelationshipSeries, RelationshipStats } from '../types/health';

/*
 * The heading of the hover tooltip on the Workbench time charts (Model fit and
 * Health score pages).
 *
 * User report 2026-10-12: the tooltip was headed by the DATE alone ("2025-03-14")
 * — it must show the time too, like the Dashboard chart's. Cause: ECharts heads
 * an axis tooltip with the time axis' default pointer label, whose precision
 * follows the axis' tick unit (day ticks → no time). Fix: the X axis carries
 * `axisPointer.label.formatter` (`timeHeadingFormatter`), which prints the
 * hovered row's own date and time in the one Workbench format ("9 Feb 2026 23:50").
 *
 * The first half reads the formatter itself; the second half mounts the REAL
 * options in the installed ECharts and reads the tooltip it builds, so the test
 * fails if ECharts stops taking the heading from that option key.
 */

// No canvas under jsdom: give ECharts a text measure instead of letting it try (and log) one per label.
echarts.setPlatformAPI({ measureText: (text: string) => ({ width: (text ?? '').length * 6 }) });

const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();
const pad = (n: number) => String(n).padStart(2, '0');
/** The heading the chart's tooltip would print for the X value `ms`. */
const heading = (option: any, ms: number): string => option.xAxis.axisPointer.label.formatter({ value: ms });

describe('timeHeadingFormatter: the hovered point\'s own date AND time, in the Workbench format', () => {
    it('a 5-minute row reads date + time — "9 Feb 2026 23:50" — and midnight keeps its "00:00"', () => {
        const ts = ['2026-02-09 23:45:00', '2026-02-09 23:50:00', '2026-02-09 23:55:00', '2026-02-10 00:00:00'];
        const f = timeHeadingFormatter(ts, ts.map(wallClockMs));
        expect(f({ value: local(2026, 2, 9, 23, 50) })).toBe('9 Feb 2026 23:50');
        expect(f({ value: local(2026, 2, 9, 23, 55) })).toBe('9 Feb 2026 23:55');
        expect(f({ value: local(2026, 2, 10) })).toBe('10 Feb 2026 00:00');
        // never the date alone, never ECharts' ISO form
        for (const t of ts) expect(f({ value: wallClockMs(t) })).toMatch(/^\d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}$/);
    });

    it('an hourly point (the Health score page) reads its hour START — "9 Feb 2026 23:00"', () => {
        const ts = ['2026-02-09T22:00:00', '2026-02-09T23:00:00', '2026-02-10T00:00:00']; // Rust's hour labels
        const f = timeHeadingFormatter(ts, ts.map(wallClockMs));
        expect(f({ value: local(2026, 2, 9, 23) })).toBe('9 Feb 2026 23:00');
        expect(f({ value: local(2026, 2, 9, 22) })).toBe('9 Feb 2026 22:00');
    });

    it('a zoned / offset timestamp keeps its OWN wall clock, on a PC in any time zone', () => {
        // three different zones on purpose: whatever zone this PC is in, `new Date(text)` would move at least two of them
        const ts = ['2026-02-09T23:50:00+07:00', '2026-02-09T23:55:00-05:00', '2026-02-10T00:00:00Z'];
        const ms = ts.map(wallClockMs);
        const f = timeHeadingFormatter(ts, ms);
        expect(ms.map(x => f({ value: x }))).toEqual(['9 Feb 2026 23:50', '9 Feb 2026 23:55', '10 Feb 2026 00:00']);
        // it is the read-out's text for the same row (`formatDataStamp`), to the character
        ts.forEach((t, i) => expect(f({ value: ms[i] })).toBe(formatDataStamp(t, { seconds: true })));
        // and through the chart: the X value of each row is headed by that row's own clock
        const o: any = buildTimeSeriesOption({ timestamps: ts, lines: [{ name: 'V', values: [1, 2, 3], color: '#fff' }] });
        expect((o.series[0].data as number[][]).map(p => heading(o, p[0]))).toEqual(['9 Feb 2026 23:50', '9 Feb 2026 23:55', '10 Feb 2026 00:00']);
    });

    it('no seconds unless the data has them: ":SS" only when a row\'s seconds are not zero', () => {
        const ts = ['2026-02-09 23:50:00', '2026-02-09 23:50:07', '2026-02-09 23:50:30.500'];
        const ms = ts.map(wallClockMs);
        const f = timeHeadingFormatter(ts, ms);
        expect(ms.map(x => f({ value: x }))).toEqual(['9 Feb 2026 23:50', '9 Feb 2026 23:50:07', '9 Feb 2026 23:50:30']);
    });

    it('an X value that is no row (the gap the line carries between two periods) is printed from the value itself — the same wall clock', () => {
        const ts = ['2026-02-09 10:00:00', '2026-02-09 12:00:00'];
        const f = timeHeadingFormatter(ts, ts.map(wallClockMs));
        expect(f({ value: local(2026, 2, 9, 11) })).toBe('9 Feb 2026 11:00');
        expect(f({ value: local(2026, 2, 9, 11, 2, 30) })).toBe('9 Feb 2026 11:02:30');
        expect(f({ value: String(local(2026, 2, 9, 12)) })).toBe('9 Feb 2026 12:00'); // a numeric string is the same value
        // nothing to read a time from: the text as it is, never "Invalid Date" / NaN
        expect(f({ value: 'n/a' })).toBe('n/a');
        expect(f({ value: undefined })).toBe('');
        expect(f({})).toBe('');
    });

    it('two rows at the same instant: the first one\'s text heads the tooltip (deterministic)', () => {
        const ts = ['2026-02-09 10:00:00', '2026-02-09T10:00:00+07:00'];
        const f = timeHeadingFormatter(ts, ts.map(wallClockMs));
        expect(f({ value: local(2026, 2, 9, 10) })).toBe('9 Feb 2026 10:00');
    });
});

describe('every Workbench time chart carries the heading on its time X axis — and keeps the rest of its tooltip', () => {
    const ind = makeHealthPreview({ kind: 'individual' });
    const rel = makeHealthPreview({ kind: 'relationship' });
    const iSeries = ind.series as IndividualSeries;
    const iStats = ind.stats as IndividualStats;
    const rSeries = rel.series as RelationshipSeries;
    const rStats = rel.stats as RelationshipStats;
    const iHourly = ind.hourly as IndividualSeries;
    const rHourly = rel.hourly as RelationshipSeries;
    const SCOPES: TimeScopes = {
        ranges: [
            { kind: 'train', start: '2026-01-01T00:00', end: '2026-01-01T01:00', label: 'TRAIN', short: 'TRAIN' },
            { kind: 'score', start: '2026-01-01T03:00', end: '2026-01-01T04:00', label: 'S1', short: 'S1' },
        ],
    };
    // [name, build, on the Health score page (linked cursor)]
    const builders: [string, (s: TimeScopes | null) => any, boolean][] = [
        ['Model fit · value over time (raw rows)', s => buildValueOverTimeOption(iSeries, iStats, 'bar', s), false],
        ['Model fit · target vs predicted (raw rows)', s => buildTargetVsPredictedOption(rSeries, 'bar', s), false],
        ['Model fit · residual over time (raw rows)', s => buildResidualOption(rSeries, rStats.two_rmse, 'bar', s), false],
        ['Health score · individual set points (hourly)', s => buildIndividualSetPointOption(iHourly, iStats, null, 'bar', hourlyScopes(s)), true],
        ['Health score · relationship set points (hourly)', s => buildRelationshipSetPointOption(rHourly, rStats.two_rmse, null, 'bar', hourlyScopes(s)), true],
        ['Health score · score (hourly)', s => buildScoreOption(iHourly.timestamps, [90, 85, null, 70, 60], hourlyScopes(s)), true],
    ];
    for (const [name, build, linked] of builders) {
        it(`${name}: with or without periods, the heading is date + time`, () => {
            for (const scopes of [null, SCOPES]) {
                const o = build(scopes);
                expect(o.xAxis.type).toBe('time');
                expect(typeof o.xAxis.axisPointer.label.formatter).toBe('function');
                // the fixture's rows / hours are 00:00 … 04:00 on 1 Jan 2026
                expect(heading(o, local(2026, 1, 1, 3))).toBe('1 Jan 2026 03:00');
                expect(heading(o, local(2026, 1, 1, 0))).toBe('1 Jan 2026 00:00');
                // every point of every line: a value row is headed by its own time (the gaps a scope inserts shift no index)
                for (const p of o.series[0].data as [number, number | null][]) {
                    expect(heading(o, p[0])).toMatch(/^1 Jan 2026 \d{2}:\d{2}$/);
                }
                // the pointer label itself is not switched on (a tooltip's axis shows none) — only its formatter is set
                expect(o.xAxis.axisPointer).toEqual({ label: { formatter: o.xAxis.axisPointer.label.formatter } });
            }
        });

        it(`${name}: the tooltip keeps its value rows and its behaviour; the hover crosshair is untouched`, () => {
            const o = build(SCOPES);
            expect(o.tooltip).toMatchObject({ trigger: 'axis', confine: true, transitionDuration: 0, hideDelay: 0, enterable: false });
            expect(o.tooltip.formatter).toBeUndefined(); // the rows under the heading are ECharts' own
            expect(typeof o.tooltip.valueFormatter).toBe('function');
            expect(o.tooltip.axisPointer.type).toBe('line');
            expect(o.axisPointer).toEqual(linked ? { ...HOVER_AXIS_POINTER, link: [{ xAxisIndex: 'all' }] } : { ...HOVER_AXIS_POINTER });
        });
    }

    it('the category-axis fallback (timestamps that cannot be parsed) keeps the raw text: no formatter on that axis', () => {
        const o: any = buildTimeSeriesOption({ timestamps: ['a', 'b', 'c'], lines: [{ name: 'V', values: [1, 2, 3], color: '#fff' }] });
        expect(o.xAxis.type).toBe('category');
        expect(o.xAxis.axisPointer).toBeUndefined();
        expect(o.tooltip.formatter).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// The tooltip ECharts really builds
// ---------------------------------------------------------------------------

describe('in the real ECharts: the tooltip box is headed by date + time', () => {
    const mounted: { chart: echarts.ECharts; el: HTMLElement }[] = [];
    afterEach(() => {
        for (const m of mounted.splice(0)) { m.chart.dispose(); m.el.remove(); }
    });

    /** Mounts an option like the app does and returns what the tooltip prints when the pointer is on point `dataIndex` of series 0. */
    function tooltipAt(option: object, dataIndex: number): { heading: string; rows: string[] } {
        const el = document.createElement('div');
        document.body.appendChild(el);
        const chart = echarts.init(el, null, { renderer: 'svg', width: 620, height: 330 });
        mounted.push({ chart, el });
        chart.setOption(option as echarts.EChartsCoreOption);
        chart.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex });
        // the tooltip box is the last child of the chart's container; its leaves are the heading, then name / value pairs
        const box = el.lastElementChild as HTMLElement;
        const leaves = [...box.querySelectorAll('div, span')].filter(n => n.children.length === 0).map(n => n.textContent ?? '').filter(t => t !== '');
        return { heading: leaves[0] ?? '', rows: leaves.slice(1) };
    }

    const value = (i: number) => 40 + (i % 7);
    /** `n` days of rows from 1 Jan 2026, at the given clock times each day. */
    const rowsOver = (n: number, clocks: string[]) => Array.from({ length: n }, (_, d) => new Date(2026, 0, 1 + d))
        .flatMap(d => clocks.map(c => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${c}:00`));
    // Ten months of rows: the axis ticks are months / days, which is when the heading lost its time.
    const months = rowsOver(300, ['06:05', '23:50']);
    // Four weeks of rows, for the charts with periods.
    const days = rowsOver(28, ['00:05', '04:05', '08:05', '12:05', '23:50']).map(t => t.replace('2026-01-', '2026-02-'));

    it('a row of 23:50 on a chart that shows months: "9 Feb 2026 23:50" — and the value row under it is intact', () => {
        const i = months.indexOf('2026-02-09 23:50:00');
        expect(i).toBeGreaterThan(0);
        const tip = tooltipAt(buildTimeSeriesOption({ timestamps: months, lines: [{ name: 'Value', values: months.map((_, k) => value(k)), color: '#4d8cf0' }] }), i);
        expect(tip.heading).toBe('9 Feb 2026 23:50');
        expect(tip.rows).toEqual(['Value', String(value(i))]);
    });

    // The control: ECharts' own heading follows the axis' tick unit, so on a chart that shows months it is the date alone
    // (the user's screenshot: "2025-03-14"). If an ECharts upgrade changes that, this is the test to look at.
    it('why it was needed: without the formatter the same tooltip is headed by the date alone', () => {
        const i = months.indexOf('2026-02-09 23:50:00');
        const o: any = buildTimeSeriesOption({ timestamps: months, lines: [{ name: 'Value', values: months.map((_, k) => value(k)), color: '#4d8cf0' }] });
        const xAxis = { ...o.xAxis };
        delete xAxis.axisPointer;
        const tip = tooltipAt({ ...o, xAxis }, i);
        expect(tip.heading).toBe('2026-02-09');
        expect(tip.rows).toEqual(['Value', String(value(i))]); // the same rows either way: only the heading differs
    });

    it('with train / scoring periods (the line carries gaps): a row of the scoring period is still headed by its own time', () => {
        const scopes: TimeScopes = {
            ranges: [
                { kind: 'train', start: '2026-02-01T00:00', end: '2026-02-05T23:59', label: 'TRAIN', short: 'TRAIN' },
                { kind: 'score', start: '2026-02-08T00:00', end: '2026-02-12T23:59', label: 'S1', short: 'S1' },
            ],
        };
        const o: any = buildTimeSeriesOption({ timestamps: days, lines: [{ name: 'Value', values: days.map((_, k) => value(k)), color: '#4d8cf0' }], scopes });
        const row = days.indexOf('2026-02-09 23:50:00');
        const at = (o.series[0].data as [number, number | null][]).findIndex(p => p[0] === wallClockMs(days[row]));
        expect(at).toBeGreaterThan(row); // gaps were inserted before it: its place on the line is not its row number
        const tip = tooltipAt(o, at);
        expect(tip.heading).toBe('9 Feb 2026 23:50');
        expect(tip.rows).toEqual(['Value', String(value(row))]);
    });

    it('two lines (Target vs predicted): one heading, both value rows', () => {
        const rel = makeHealthPreview({ kind: 'relationship' });
        const series = rel.series as RelationshipSeries;
        const tip = tooltipAt(buildTargetVsPredictedOption(series, 'bar'), 3);
        expect(tip.heading).toBe('1 Jan 2026 03:00');
        expect(tip.rows.filter(t => t === 'Actual' || t === 'Predicted')).toEqual(['Actual', 'Predicted']);
        expect(tip.rows).toHaveLength(4);
    });

    it('the Health score chart: an hourly point is headed by its hour start, the score under it a whole number', () => {
        const hours = Array.from({ length: 24 * 20 }, (_, i) => `2026-02-${pad(1 + Math.floor(i / 24))}T${pad(i % 24)}:00:00`);
        const score = hours.map((_, i) => (i % 9 === 0 ? 84.6 : 100));
        const i = hours.indexOf('2026-02-09T23:00:00');
        expect(score[i]).toBe(100);
        const tip = tooltipAt(buildScoreOption(hours, score), i);
        expect(tip.heading).toBe('9 Feb 2026 23:00');
        expect(tip.rows).toEqual(['Health score', '100']);
        expect(tooltipAt(buildScoreOption(hours, score), 9).rows).toEqual(['Health score', '85']); // 84.6 → the score chart's whole numbers
    });

    it('an offset stamp is not shifted in the box either', () => {
        const ts = Array.from({ length: 30 * 4 }, (_, i) => `2026-03-${pad(1 + Math.floor(i / 4))}T${pad(6 * (i % 4))}:10:00+07:00`);
        const i = ts.indexOf('2026-03-14T18:10:00+07:00');
        const tip = tooltipAt(buildTimeSeriesOption({ timestamps: ts, lines: [{ name: 'Value', values: ts.map((_, k) => k), color: '#4d8cf0' }] }), i);
        expect(tip.heading).toBe('14 Mar 2026 18:10');
    });

    it('the category fallback is headed by the raw text', () => {
        const tip = tooltipAt(buildTimeSeriesOption({ timestamps: ['row a', 'row b', 'row c'], lines: [{ name: 'Value', values: [1, 2, 3], color: '#4d8cf0' }] }), 1);
        expect(tip.heading).toBe('row b');
        expect(tip.rows).toEqual(['Value', '2']);
    });
});
