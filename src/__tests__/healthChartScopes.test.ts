import { describe, it, expect } from 'vitest';
import {
    PROBLEM_HATCH,
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
 * Train/Test validation (2026-10-07): the time scopes every Workbench time chart
 * draws (SPEC "Screens and UI"; DESIGN_SYSTEM §4 "Train / Test periods"). All
 * through the pure option builders — `TimeSeriesSpec.scopes`, never a module
 * setter.
 */

const TS = ['2026-01-01 00:00:00', '2026-01-01 01:00:00', '2026-01-01 02:00:00', '2026-01-01 03:00:00', '2026-01-01 04:00:00'];
const ms = (s: string) => new Date(s.replace(' ', 'T')).getTime();
const carrier = (o: any) => o.series.find((s: any) => s.name === '__scopes');

const SCOPES: TimeScopes = {
    ranges: [
        { kind: 'train', start: '2026-01-01T00:00', end: '2026-01-01T01:00', label: 'TRAIN', short: 'TRAIN' },
        { kind: 'normal', start: '2026-01-01T03:00', end: '2026-01-01T04:00', label: 'T1 NORMAL', short: 'T1 NORMAL' },
    ],
    events: [],
};

describe('scopesOf (HealthPreview.test_validation -> chart scopes)', () => {
    it('null without test_validation: the chart is drawn exactly as before', () => {
        expect(scopesOf(null)).toBeNull();
        expect(scopesOf(undefined)).toBeNull();
    });

    it('review fix 2026-10-07: with the sent T-numbers, a result is named by its ORIGINAL list position (T1 invalid and not sent -> the valid one is "T2")', () => {
        // The user's list is [T1 invalid, T2 valid]: only T2 is sent, Rust answers with wire index 1.
        const v = makeValidation({ tests: [makeTestResult({ index: 1 })] });
        const s = scopesOf(v, [2])!;
        expect(s.ranges.map(r => r.label)).toEqual(['TRAIN', 'T2 NORMAL']);
        expect(s.ranges.map(r => r.short)).toEqual(['TRAIN', 'T2 NORMAL']);
        // [T1 valid, T2 invalid, T3 valid]: wire 1 -> T1, wire 2 -> T3 (looked up by the wire index, not the order)
        const two = scopesOf(makeValidation({ tests: [makeTestResult({ index: 2, label: 'problem' }), makeTestResult({ index: 1 })] }), [1, 3])!;
        expect(two.ranges.slice(1).map(r => r.label)).toEqual(['T3 KNOWN PROBLEM', 'T1 NORMAL']);
    });

    it('one train range = "TRAIN"; several = "TRAIN P1" / "P1"; tests are T1, T2 … by POSITION with their label', () => {
        const one = scopesOf(makeValidation({
            tests: [makeTestResult({ index: 7 }), makeTestResult({ index: 9, label: 'problem', event_time: '2026-01-01T03:30' })],
        }))!;
        expect(one.ranges.map(r => r.label)).toEqual(['TRAIN', 'T1 NORMAL', 'T2 KNOWN PROBLEM']);
        expect(one.ranges.map(r => r.short)).toEqual(['TRAIN', 'T1 NORMAL', 'T2 PROBLEM']);
        expect(one.ranges.map(r => r.kind)).toEqual(['train', 'normal', 'problem']);
        expect(one.events).toEqual(['2026-01-01T03:30']);
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

    it('a Normal test with an event time draws no event line', () => {
        expect(scopesOf(makeValidation({ tests: [makeTestResult({ label: 'normal', event_time: '2026-01-01T03:30' })] }))!.events).toEqual([]);
    });

    it('compactScopes keeps the data and only switches to the short pills', () => {
        expect(compactScopes(SCOPES)).toEqual({ ...SCOPES, compact: true });
        expect(compactScopes(null)).toBeNull();
    });
});

describe('buildTimeSeriesOption with scopes', () => {
    const spec = { timestamps: TS, lines: [{ name: 'V', values: [1, 2, 3, 4, 5] as (number | null)[], color: '#fff' }] };

    it('no scopes: no carrier series, the old grid and the reference labels on the right', () => {
        const o: any = buildTimeSeriesOption({ ...spec, hLines: [{ y: 1, color: '#0f0', label: '+1SD' }] });
        expect(carrier(o)).toBeUndefined();
        expect(o.grid.top).toBe(14);
        expect(o.series[0].markLine.data[0].label.position).toBe('insideEndTop');
    });

    it('train = blue fill without a border; test = magenta fill with a dashed outline; pills on two lanes', () => {
        const o: any = buildTimeSeriesOption({ ...spec, scopes: SCOPES });
        const c = carrier(o);
        expect(c.z).toBe(0);
        expect(c.data).toEqual([]);
        expect(c.tooltip.show).toBe(false);
        const [train, test] = c.markArea.data;
        expect(train[0].xAxis).toBe(ms('2026-01-01 00:00:00'));
        expect(train[1].xAxis).toBe(ms('2026-01-01 01:00:00'));
        expect(train[0].itemStyle).toEqual({ color: CHART.trainFill, borderWidth: 0 });
        expect(train[0].label).toMatchObject({ show: true, formatter: 'TRAIN', position: 'top', color: CHART.train });
        expect(test[0].itemStyle).toMatchObject({ color: CHART.testFill, borderColor: CHART.test, borderType: 'dashed', borderWidth: 1 });
        expect(test[0].label).toMatchObject({ formatter: 'T1 NORMAL', position: 'insideTop', color: CHART.test });
        // room above the plot for the train pills
        expect(o.grid.top).toBeGreaterThan(14);
    });

    it('a Known problem band is hatched (an image pattern), not a plain fill', () => {
        const o: any = buildTimeSeriesOption({ ...spec, scopes: { ranges: [{ ...SCOPES.ranges[1], kind: 'problem', label: 'T1 KNOWN PROBLEM' }], events: [] } });
        const area = carrier(o).markArea.data[0][0];
        expect(area.itemStyle.color).toBe(PROBLEM_HATCH);
        expect(PROBLEM_HATCH.image.startsWith('data:image/svg+xml')).toBe(true);
        expect(area.itemStyle.borderType).toBe('dashed');
    });

    it('the event is a red dashed vertical line with an "EVENT" label; an event outside the data is not drawn', () => {
        const o: any = buildTimeSeriesOption({ ...spec, scopes: { ...SCOPES, events: ['2026-01-01T03:30', '2027-05-01T00:00'] } });
        const c = carrier(o);
        expect(c.markLine.data).toHaveLength(1);
        expect(c.markLine.data[0].xAxis).toBe(ms('2026-01-01 03:30:00'));
        expect(c.markLine.data[0].lineStyle).toMatchObject({ color: CHART.danger, type: 'dashed' });
        expect(c.markPoint.data[0].label).toMatchObject({ show: true, formatter: 'EVENT', color: CHART.danger });
    });

    it('open ends run to the edges of the data; compact charts use the short pills', () => {
        const o: any = buildTimeSeriesOption({ ...spec, scopes: compactScopes({ ranges: [{ kind: 'train', start: null, end: null, label: 'TRAIN P1', short: 'P1' }], events: [] }) });
        const [a, b] = carrier(o).markArea.data[0];
        expect(a.xAxis).toBe(ms(TS[0]));
        expect(b.xAxis).toBe(ms(TS[4]));
        expect(a.label.formatter).toBe('P1');
    });

    it('reference-line labels move to the LEFT end while scopes show (the pills own the top right)', () => {
        const o: any = buildTimeSeriesOption({ ...spec, scopes: SCOPES, hLines: [{ y: 1, color: '#0f0', label: '+1SD' }] });
        expect(o.series[0].markLine.data[0].label.position).toBe('insideStartTop');
    });

    it('time outside every period is a gap: a null is inserted where the line leaves a scope', () => {
        // points 00:00, 01:00 in TRAIN; 02:00 outside; 03:00, 04:00 in T1
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
    it('merges overlapping train and test ranges into one island (a test MAY overlap train)', () => {
        const isl = scopeIslands({
            ranges: [
                { kind: 'train', start: '2026-01-01T00:00', end: '2026-01-01T02:00', label: '', short: '' },
                { kind: 'normal', start: '2026-01-01T01:00', end: '2026-01-01T03:00', label: '', short: '' },
                { kind: 'problem', start: '2026-01-02T00:00', end: null, label: '', short: '' },
            ],
            events: [],
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
    }

    it('the score chart keeps its colouring on series 0 (the carrier comes last)', () => {
        const o: any = buildScoreOption(TS, [90, 85, null, 70, 60], SCOPES);
        expect(o.visualMap.seriesIndex).toBe(0);
        expect(o.series[o.series.length - 1].name).toBe('__scopes');
    });
});
