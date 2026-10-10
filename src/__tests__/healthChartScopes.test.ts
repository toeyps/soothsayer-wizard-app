import { describe, it, expect } from 'vitest';
import * as healthCharts from '../components/windows/workbench/healthCharts';
import {
    REF_LABEL_GUTTER,
    SCOPE_LANE,
    SCOPE_STRIP,
    buildResidualOption,
    buildTargetVsPredictedOption,
    buildTimeSeriesOption,
    buildValueOverTimeOption,
    compactScopes,
    scopeIslands,
    scopesOf,
    withScopeGaps,
    type TimeScopes,
} from '../components/windows/workbench/healthCharts';
import { buildIndividualSetPointOption, buildRelationshipSetPointOption, buildScoreOption } from '../components/windows/workbench/healthPageCharts';
import { CHART } from '../components/windows/workbench/chartTheme';
import { makeHealthPreview } from './helpers/healthPreviewFixture';
import { makeTestResult, makeValidation } from './helpers/validationFixture';
import type { IndividualSeries, IndividualStats, RelationshipSeries, RelationshipStats } from '../types/health';

/*
 * The train / scoring time scopes every Workbench time chart draws (SPEC
 * 2026-10-07 "Screens and UI", revised 2026-10-10 by workbench-redesign §2
 * "just score it": a scoring period is only start → end, so there is NO
 * Known-problem hatch and NO EVENT line any more). All through the pure option
 * builders — `TimeSeriesSpec.scopes`, never a module setter.
 *
 * workbench-redesign §3 (2026-10-10): the scopes are NAMED in a thin strip above
 * the plot (train on the upper lane, scoring periods on the lower one, plain
 * coloured text) — there is no pill inside the plot any more — and the
 * reference-line labels sit at the right edge, outside the plot.
 */

const TS = ['2026-01-01 00:00:00', '2026-01-01 01:00:00', '2026-01-01 02:00:00', '2026-01-01 03:00:00', '2026-01-01 04:00:00'];
const ms = (s: string) => new Date(s.replace(' ', 'T')).getTime();
const carrier = (o: any) => o.series.find((s: any) => s.name === '__scopes');
/** The names in the strip above the plot, in band order. */
const stripNames = (o: any): string[] => carrier(o).markArea.data.map((a: any) => a[0].label.formatter);
/** Every label of the scope carrier. */
const stripLabels = (o: any): any[] => carrier(o).markArea.data.map((a: any) => a[0].label);

const SCOPES: TimeScopes = {
    ranges: [
        { kind: 'train', start: '2026-01-01T00:00', end: '2026-01-01T01:00', label: 'TRAIN', short: 'TRAIN' },
        { kind: 'score', start: '2026-01-01T03:00', end: '2026-01-01T04:00', label: 'S1', short: 'S1' },
    ],
};

describe('scopesOf (HealthPreview.test_validation -> chart scopes)', () => {
    it('null without test_validation: the chart is drawn exactly as before', () => {
        expect(scopesOf(null)).toBeNull();
        expect(scopesOf(undefined)).toBeNull();
    });

    it('with the sent S-numbers, a result is named by its ORIGINAL list position (S1 invalid and not sent -> the valid one is "S2")', () => {
        // The user's list is [S1 invalid, S2 valid]: only S2 is sent, Rust answers with wire index 1.
        const v = makeValidation({ tests: [makeTestResult({ index: 1 })] });
        const s = scopesOf(v, [2])!;
        expect(s.ranges.map(r => r.label)).toEqual(['TRAIN', 'S2']);
        expect(s.ranges.map(r => r.short)).toEqual(['TRAIN', 'S2']);
        // [S1 valid, S2 invalid, S3 valid]: wire 1 -> S1, wire 2 -> S3 (looked up by the wire index, not the order)
        const two = scopesOf(makeValidation({ tests: [makeTestResult({ index: 2 }), makeTestResult({ index: 1 })] }), [1, 3])!;
        expect(two.ranges.slice(1).map(r => r.label)).toEqual(['S3', 'S1']);
    });

    it('one train range = "TRAIN"; several = "TRAIN P1" / "P1"; scoring periods are S1, S2 … by POSITION, all of one kind', () => {
        const one = scopesOf(makeValidation({
            tests: [makeTestResult({ index: 7 }), makeTestResult({ index: 9 })],
        }))!;
        expect(one.ranges.map(r => r.label)).toEqual(['TRAIN', 'S1', 'S2']);
        expect(one.ranges.map(r => r.short)).toEqual(['TRAIN', 'S1', 'S2']);
        expect(one.ranges.map(r => r.kind)).toEqual(['train', 'score', 'score']);
        // a scope is ranges (+ compact) only: no event list
        expect(Object.keys(one)).toEqual(['ranges']);
        const many = scopesOf(makeValidation({
            train_ranges: [{ start: '2026-01-01T00:00', end: '2026-01-01T00:30' }, { start: '2026-01-01T01:00', end: null }],
            tests: [],
        }))!;
        expect(many.ranges.map(r => r.label)).toEqual(['TRAIN P1', 'TRAIN P2']);
        expect(many.ranges.map(r => r.short)).toEqual(['P1', 'P2']);
    });

    it('no train range sent (one period open at both ends = the whole time) -> one open TRAIN band, so no row reads as unscored', () => {
        const s = scopesOf(makeValidation({ train_ranges: [] }))!;
        expect(s.ranges[0]).toMatchObject({ kind: 'train', start: null, end: null, label: 'TRAIN' });
    });

    it('a legacy label / event time that still arrives on a result is ignored: plain "S1", no event', () => {
        // An answer shaped like the pre-2026-10-10 backend's (the type no longer has these keys).
        const old = { ...makeTestResult(), label: 'problem', event_time: '2026-01-01T03:30', lead_days: 2, first_below_80: '2026-01-01 03:10:00' };
        const s = scopesOf(makeValidation({ tests: [old] }))!;
        expect(s.ranges[1]).toEqual({ kind: 'score', start: old.start, end: old.end, label: 'S1', short: 'S1' });
        expect(JSON.stringify(s)).not.toMatch(/problem|event|KNOWN|NORMAL/i);
    });

    it('compactScopes keeps the data and only switches to the short names', () => {
        expect(compactScopes(SCOPES)).toEqual({ ...SCOPES, compact: true });
        expect(compactScopes(null)).toBeNull();
    });
});

describe('buildTimeSeriesOption with scopes', () => {
    const spec = { timestamps: TS, lines: [{ name: 'V', values: [1, 2, 3, 4, 5] as (number | null)[], color: '#fff' }] };

    it('no scopes: no carrier series, no strip (the plain grid top), the reference labels at the right edge outside the plot', () => {
        const o: any = buildTimeSeriesOption({ ...spec, hLines: [{ y: 1, color: '#0f0', label: '+1SD' }] });
        expect(carrier(o)).toBeUndefined();
        expect(o.grid.top).toBe(14);
        expect(o.series[0].markLine.data[0].label.position).toBe('end');
        expect(o.grid.right).toBe(REF_LABEL_GUTTER);
    });

    it('train = a faint blue fill without a border; scoring = a faint magenta fill with a dashed outline', () => {
        const o: any = buildTimeSeriesOption({ ...spec, scopes: SCOPES });
        const c = carrier(o);
        expect(c.z).toBe(0);
        expect(c.data).toEqual([]);
        expect(c.tooltip.show).toBe(false);
        const [train, test] = c.markArea.data;
        expect(train[0].xAxis).toBe(ms('2026-01-01 00:00:00'));
        expect(train[1].xAxis).toBe(ms('2026-01-01 01:00:00'));
        expect(train[0].itemStyle).toEqual({ color: CHART.trainFill, borderWidth: 0 });
        expect(test[0].itemStyle).toEqual({ color: CHART.testFill, borderColor: CHART.testOutline, borderType: 'dashed', borderWidth: 1 });
        // inside the plot a scope is ONLY a faint fill: at most a few percent, so the data line stays readable
        const alpha = (rgba: string) => Number(/,\s*([\d.]+)\)$/.exec(rgba)![1]);
        expect(alpha(CHART.trainFill)).toBeLessThanOrEqual(0.06);
        expect(alpha(CHART.testFill)).toBeLessThanOrEqual(0.06);
    });

    // workbench-redesign SPEC §3: "train and scoring ranges are NAMED in a thin strip ABOVE the plot
    // (TRAIN P1 P2, S1 S2). No pills inside the plot."
    it('the scopes are named in a strip ABOVE the plot: train on the upper lane, scoring on the lower lane', () => {
        const o: any = buildTimeSeriesOption({ ...spec, scopes: SCOPES });
        const [train, score] = stripLabels(o);
        expect(train).toMatchObject({ show: true, formatter: 'TRAIN', position: 'top', color: CHART.train, distance: SCOPE_LANE.train });
        expect(score).toMatchObject({ show: true, formatter: 'S1', position: 'top', color: CHART.test, distance: SCOPE_LANE.score });
        // two lanes, so "S1" over a train range never sits on "TRAIN"
        expect(SCOPE_LANE.train - SCOPE_LANE.score).toBeGreaterThanOrEqual(11); // a 9 px text line + air
        // the grid leaves the strip free above the plot, and both lanes fit inside it
        expect(o.grid.top).toBe(10 + SCOPE_STRIP);
        expect(SCOPE_STRIP).toBeGreaterThanOrEqual(SCOPE_LANE.train + 9);
    });

    it('NO pills inside the plot: every scope name is plain coloured text outside it (no background, no padding, no "inside" position)', () => {
        const three: TimeScopes = {
            ranges: [
                { kind: 'train', start: '2026-01-01T00:00', end: '2026-01-01T01:00', label: 'TRAIN P1', short: 'P1' },
                { kind: 'train', start: '2026-01-01T02:00', end: '2026-01-01T03:00', label: 'TRAIN P2', short: 'P2' },
                { kind: 'score', start: '2026-01-01T00:30', end: '2026-01-01T04:00', label: 'S1', short: 'S1' },
            ],
        };
        for (const scopes of [three, compactScopes(three)!]) {
            const o: any = buildTimeSeriesOption({ ...spec, scopes, hLines: [{ y: 1, color: '#0f0', label: '+1SD' }] });
            for (const label of stripLabels(o)) {
                expect(label.position).toBe('top'); // above the plot
                expect(String(label.position)).not.toMatch(/inside/i);
                expect(label.backgroundColor).toBeUndefined(); // text, not a pill
                expect(label.borderRadius).toBeUndefined();
                expect(label.padding).toBe(0);
            }
            // nothing else of the carrier draws a label either
            expect(carrier(o).markPoint).toBeUndefined();
            expect(carrier(o).markLine).toBeUndefined();
            expect(carrier(o).label).toBeUndefined();
        }
        expect(Object.keys(CHART)).not.toContain('scopePillBg');
    });

    it('strip names per scope: one train period = "TRAIN"; several = "TRAIN P1", "TRAIN P2" (short "P1", "P2"); scoring periods = "S1", "S2"', () => {
        const v = makeValidation({
            train_ranges: [{ start: '2026-01-01T00:00', end: '2026-01-01T00:30' }, { start: '2026-01-01T01:00', end: '2026-01-01T02:00' }],
            tests: [makeTestResult({ index: 1, start: '2026-01-01T02:00', end: '2026-01-01T03:00' }), makeTestResult({ index: 2, start: '2026-01-01T03:00', end: '2026-01-01T04:00' })],
        });
        const full: any = buildTimeSeriesOption({ ...spec, scopes: scopesOf(v) });
        expect(stripNames(full)).toEqual(['TRAIN P1', 'TRAIN P2', 'S1', 'S2']);
        // a half-width chart drops the repeated word, never the number
        const half: any = buildTimeSeriesOption({ ...spec, scopes: compactScopes(scopesOf(v)) });
        expect(stripNames(half)).toEqual(['P1', 'P2', 'S1', 'S2']);
        // which lane each name sits on follows its kind, not its position
        expect(stripLabels(full).map((l: any) => l.distance)).toEqual([SCOPE_LANE.train, SCOPE_LANE.train, SCOPE_LANE.score, SCOPE_LANE.score]);
        expect(stripLabels(full).map((l: any) => l.color)).toEqual([CHART.train, CHART.train, CHART.test, CHART.test]);
        // a single train period needs no number
        const one: any = buildTimeSeriesOption({ ...spec, scopes: scopesOf(makeValidation({ tests: [makeTestResult()] })) });
        expect(stripNames(one)).toEqual(['TRAIN', 'S1']);
        // the S-number is the period's place in the user's list, also when an earlier one was not sent
        const second: any = buildTimeSeriesOption({ ...spec, scopes: scopesOf(makeValidation({ tests: [makeTestResult({ index: 1 })] }), [2]) });
        expect(stripNames(second)).toEqual(['TRAIN', 'S2']);
    });

    it('strip names for LEGACY data: an old answer with a Normal / Known-problem label and an event time still reads plain "S1", "S2"', () => {
        const old = (index: number, label: string) => ({ ...makeTestResult({ index }), label, event_time: '2026-01-01T03:30', lead_days: 2 });
        const v = makeValidation({ tests: [old(1, 'problem'), old(2, 'normal')] });
        const o: any = buildTimeSeriesOption({ ...spec, scopes: scopesOf(v) });
        expect(stripNames(o)).toEqual(['TRAIN', 'S1', 'S2']);
        expect(JSON.stringify(carrier(o))).not.toMatch(/KNOWN|NORMAL|PROBLEM|EVENT|T1|T2/);
        // no train range in the answer (a period open at both ends): one TRAIN name over the whole axis
        const open: any = buildTimeSeriesOption({ ...spec, scopes: scopesOf(makeValidation({ train_ranges: [], tests: [] })) });
        expect(stripNames(open)).toEqual(['TRAIN']);
    });

    it('every scoring band is the same plain fill — there is no hatched (Known problem) band any more', () => {
        const two: TimeScopes = { ranges: [SCOPES.ranges[1], { ...SCOPES.ranges[1], start: '2026-01-01T01:30', end: '2026-01-01T02:30', label: 'S2', short: 'S2' }] };
        const areas = carrier(buildTimeSeriesOption({ ...spec, scopes: two })).markArea.data.map((a: any) => a[0]);
        expect(areas).toHaveLength(2);
        for (const a of areas) {
            expect(a.itemStyle).toEqual({ color: CHART.testFill, borderColor: CHART.testOutline, borderWidth: 1, borderType: 'dashed' });
            expect(typeof a.itemStyle.color).toBe('string'); // a colour, never an image pattern
        }
        expect(Object.keys(healthCharts)).not.toContain('PROBLEM_HATCH');
    });

    it('the scope carrier draws bands only: no EVENT line, no EVENT label, nothing red', () => {
        const o: any = buildTimeSeriesOption({ ...spec, scopes: SCOPES });
        const c = carrier(o);
        expect(c.markLine).toBeUndefined();
        expect(c.markPoint).toBeUndefined();
        expect(JSON.stringify(c)).not.toContain('EVENT');
        expect(JSON.stringify(c)).not.toContain(CHART.danger);
    });

    it('open ends run to the edges of the data; compact charts use the short names', () => {
        const o: any = buildTimeSeriesOption({ ...spec, scopes: compactScopes({ ranges: [{ kind: 'train', start: null, end: null, label: 'TRAIN P1', short: 'P1' }] }) });
        const [a, b] = carrier(o).markArea.data[0];
        expect(a.xAxis).toBe(ms(TS[0]));
        expect(b.xAxis).toBe(ms(TS[4]));
        expect(a.label.formatter).toBe('P1');
    });

    it('reference-line labels stay at the right edge OUTSIDE the plot with scopes too (the strip is above the plot, so nothing has to move left)', () => {
        const withScopes: any = buildTimeSeriesOption({ ...spec, scopes: SCOPES, hLines: [{ y: 1, color: '#0f0', label: '+1SD' }] });
        const without: any = buildTimeSeriesOption({ ...spec, hLines: [{ y: 1, color: '#0f0', label: '+1SD' }] });
        expect(withScopes.series[0].markLine.data[0].label.position).toBe('end');
        expect(withScopes.series[0].markLine.data[0].label).toEqual(without.series[0].markLine.data[0].label);
        expect(withScopes.grid.right).toBe(REF_LABEL_GUTTER);
        expect(JSON.stringify(withScopes)).not.toContain('insideStart');
    });

    it('time outside every period is a gap: a null is inserted where the line leaves a scope', () => {
        // points 00:00, 01:00 in TRAIN; 02:00 outside; 03:00, 04:00 in S1
        const o: any = buildTimeSeriesOption({ ...spec, scopes: SCOPES });
        const data = o.series[0].data as [number, number | null][];
        const nullAt = data.filter(p => p[1] === null).map(p => p[0]);
        expect(nullAt).toHaveLength(2); // into 02:00 and out of it again
        expect(data.filter(p => p[1] !== null)).toHaveLength(5); // no value is dropped
    });

    it('a category axis (unparseable timestamps) draws no scopes at all', () => {
        const o: any = buildTimeSeriesOption({ ...spec, timestamps: ['a', 'b', 'c', 'd', 'e'], scopes: SCOPES });
        expect(carrier(o)).toBeUndefined();
        expect(o.grid.top).toBe(14);
    });
});

describe('scopeIslands / withScopeGaps', () => {
    it('merges overlapping train and scoring ranges into one island (a scoring period MAY overlap train)', () => {
        const isl = scopeIslands({
            ranges: [
                { kind: 'train', start: '2026-01-01T00:00', end: '2026-01-01T02:00', label: '', short: '' },
                { kind: 'score', start: '2026-01-01T01:00', end: '2026-01-01T03:00', label: '', short: '' },
                { kind: 'score', start: '2026-01-02T00:00', end: null, label: '', short: '' },
            ],
        });
        expect(isl).toEqual([
            [ms('2026-01-01 00:00:00'), ms('2026-01-01 03:00:00')],
            [ms('2026-01-02 00:00:00'), Infinity],
        ]);
    });

    it('a line inside one island is untouched', () => {
        const pts: [number, number | null][] = [[1, 1], [2, 2], [3, 3]];
        expect(withScopeGaps(pts, [[0, 10]])).toEqual(pts);
    });

    it('jumping between two islands inserts exactly one gap', () => {
        const out = withScopeGaps([[1, 1], [2, 2], [8, 3]], [[0, 3], [7, 9]]);
        expect(out).toEqual([[1, 1], [2, 2], [5, null], [8, 3]]);
    });
});

describe('every Workbench time chart takes the scopes', () => {
    const ind = makeHealthPreview({ kind: 'individual' });
    const rel = makeHealthPreview({ kind: 'relationship' });
    const iSeries = ind.series as IndividualSeries;
    const iStats = ind.stats as IndividualStats;
    const rSeries = rel.series as RelationshipSeries;
    const rStats = rel.stats as RelationshipStats;
    const builders: [string, (s: TimeScopes | null) => any][] = [
        ['value over time', s => buildValueOverTimeOption(iSeries, iStats, 'bar', s)],
        ['target vs predicted', s => buildTargetVsPredictedOption(rSeries, 'bar', s)],
        ['residual over time', s => buildResidualOption(rSeries, rStats.two_rmse, 'bar', s)],
        ['individual set points', s => buildIndividualSetPointOption(iSeries, iStats, null, 'bar', s)],
        ['relationship set points', s => buildRelationshipSetPointOption(rSeries, rStats.two_rmse, null, 'bar', s)],
        ['score', s => buildScoreOption(iSeries.timestamps, [90, 85, null, 70, 60], s)],
    ];
    for (const [name, build] of builders) {
        it(`${name}: no carrier without scopes, the bands with them`, () => {
            expect(carrier(build(null))).toBeUndefined();
            expect(carrier(build(SCOPES)).markArea.data).toHaveLength(2);
        });

        it(`${name}: the strip above the plot names the scopes; nothing is a pill inside it`, () => {
            const o = build(SCOPES);
            expect(stripNames(o)).toEqual(['TRAIN', 'S1']);
            expect(o.grid.top).toBe(10 + SCOPE_STRIP);
            expect(stripLabels(o).every((l: any) => l.position === 'top' && l.backgroundColor === undefined)).toBe(true);
            expect(build(null).grid.top).toBe(14); // no scopes, no strip
        });
    }

    it('Clustering has no time chart on Model fit, so its strip is on the Health score chart only (the score builder takes the scopes)', () => {
        const clu = makeHealthPreview({ kind: 'clustering', n_clusters: 2 });
        const o: any = buildScoreOption(clu.series.timestamps, [100, 90, null, 70, 60], SCOPES);
        expect(stripNames(o)).toEqual(['TRAIN', 'S1']);
    });

    it('the score chart keeps its colouring on series 0 (the carrier comes last)', () => {
        const o: any = buildScoreOption(TS, [90, 85, null, 70, 60], SCOPES);
        expect(o.visualMap.seriesIndex).toBe(0);
        expect(o.series[o.series.length - 1].name).toBe('__scopes');
    });
});
