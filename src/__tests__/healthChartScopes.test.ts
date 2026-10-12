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
    scopeStripNames,
    scopesOf,
    STRIP_PLOT_WIDTH,
    withScopeGaps,
    type StripBand,
    type TimeScopes,
} from '../components/windows/workbench/healthCharts';
import { buildIndividualSetPointOption, buildRelationshipSetPointOption, buildScoreOption } from '../components/windows/workbench/healthPageCharts';
import { CHART } from '../components/windows/workbench/chartTheme';
import { makeHealthPreview } from './helpers/healthPreviewFixture';
import { makeTestResult, makeValidation } from './helpers/validationFixture';
import type { IndividualSeries, IndividualStats, RelationshipSeries, RelationshipStats } from '../types/health';

/*
 * The train / scoring time scopes every Workbench time chart draws
 * (workbench-redesign §2
 * "just score it": a scoring period is only start → end, so there is NO
 * Known-problem hatch and NO EVENT line). All through the pure option
 * builders — `TimeSeriesSpec.scopes`, never a module setter.
 *
 * workbench-redesign §3: the scopes are NAMED in a thin strip above
 * the plot (plain coloured text) — there is no pill inside the plot — and the
 * reference-line labels sit at the right edge, outside the plot.
 *
 * User decision 2026-10-12: ONLY THE TRAIN PERIODS are drawn (band + name). A
 * scoring period has no band, no dashed frame and no "S1" name on any chart —
 * but its rows stay on the line: the line is still cut from ALL ranges
 * (`scopeIslands`), and `scopesOf` still returns the scoring ranges with their
 * S-numbers (the "Scoring results" card is where the numbers are shown).
 */

const TS = ['2026-01-01 00:00:00', '2026-01-01 01:00:00', '2026-01-01 02:00:00', '2026-01-01 03:00:00', '2026-01-01 04:00:00'];
const ms = (s: string) => new Date(s.replace(' ', 'T')).getTime();
const carrier = (o: any) => o.series.find((s: any) => s.name === '__scopes');
/** The names PRINTED in the strip above the plot, in band order (a name left out to avoid a collision is not listed). */
const stripNames = (o: any): string[] => carrier(o).markArea.data.filter((a: any) => a[0].label.show).map((a: any) => a[0].label.formatter);
/** Every label of the scope carrier. */
const stripLabels = (o: any): any[] => carrier(o).markArea.data.map((a: any) => a[0].label);
/** The points of the first data line that carry a value, as [ms, value]. */
const linePoints = (o: any): [number, number][] => (o.series[0].data as [number, number | null][]).filter((p): p is [number, number] => p[1] !== null);
/** Everything a scoring band was drawn with: its two magenta colours and an "S1"-style name. */
const expectNoScoringBand = (o: any) => {
    const text = JSON.stringify(o);
    expect(text).not.toContain(CHART.test);
    expect(text).not.toContain(CHART.testFill);
    expect(text).not.toContain(CHART.testOutline);
    for (const a of carrier(o).markArea.data) {
        expect(a[0].name).not.toMatch(/^S\d/);
        expect(a[0].label.formatter).not.toMatch(/^S\d/);
        expect(a[0].itemStyle.borderType).toBeUndefined(); // no dashed frame
    }
};

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
        // An answer that still carries the legacy keys (the type does not have them).
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

    it('ONLY the train period is a band: a faint blue fill without a border. The scoring period has no band, no frame, no name', () => {
        const o: any = buildTimeSeriesOption({ ...spec, scopes: SCOPES });
        const c = carrier(o);
        expect(c.z).toBe(0);
        expect(c.data).toEqual([]);
        expect(c.tooltip.show).toBe(false);
        expect(c.markArea.data).toHaveLength(1); // TRAIN — nothing for S1
        const [train] = c.markArea.data;
        expect(train[0].name).toBe('TRAIN');
        expect(train[0].xAxis).toBe(ms('2026-01-01 00:00:00'));
        expect(train[1].xAxis).toBe(ms('2026-01-01 01:00:00'));
        expect(train[0].itemStyle).toEqual({ color: CHART.trainFill, borderWidth: 0 });
        expectNoScoringBand(o);
        // inside the plot a scope is ONLY a faint fill: at most a few percent, so the data line stays readable
        const alpha = (rgba: string) => Number(/,\s*([\d.]+)\)$/.exec(rgba)![1]);
        expect(alpha(CHART.trainFill)).toBeLessThanOrEqual(0.06);
    });

    // The data drawn must not change: the scoring period's rows are on the line exactly as before.
    it('the scoring period is not drawn, but its ROWS are: the line is cut from all ranges, never from the train ones alone', () => {
        // points 00:00, 01:00 in TRAIN; 02:00 outside; 03:00, 04:00 in S1
        const o: any = buildTimeSeriesOption({ ...spec, scopes: SCOPES });
        expect(linePoints(o)).toEqual(TS.map((t, i) => [ms(t), i + 1])); // every value, the scoring rows included
        const data = o.series[0].data as [number, number | null][];
        const at = (t: string) => data.findIndex(p => p[0] === ms(t));
        // 03:00 → 04:00 (both inside S1) are neighbours on the line: no gap between them
        expect(at('2026-01-01 04:00:00') - at('2026-01-01 03:00:00')).toBe(1);
        expect(data.filter(p => p[1] === null)).toHaveLength(2); // only around 02:00, which is in no period
        // what "cut from the train ranges alone" would look like: the two scoring rows torn apart
        const trainOnly: any = buildTimeSeriesOption({ ...spec, scopes: { ranges: [SCOPES.ranges[0]] } });
        expect((trainOnly.series[0].data as [number, number | null][]).filter(p => p[1] === null)).toHaveLength(3);
        // and the band drawn is the same in both: TRAIN alone
        expect(carrier(o).markArea.data).toEqual(carrier(trainOnly).markArea.data);
    });

    // workbench-redesign SPEC §3: "train and scoring ranges are NAMED in a thin strip ABOVE the plot
    // (TRAIN P1 P2, S1 S2). No pills inside the plot."
    it('the train period is named in a strip ABOVE the plot, on the upper lane; no scoring name is printed and the strip keeps its height', () => {
        const o: any = buildTimeSeriesOption({ ...spec, scopes: SCOPES });
        const labels = stripLabels(o);
        expect(labels).toHaveLength(1);
        expect(labels[0]).toMatchObject({ show: true, formatter: 'TRAIN', position: 'top', color: CHART.train, distance: SCOPE_LANE.train });
        expect(stripNames(o)).toEqual(['TRAIN']);
        // nothing sits on the lane the scoring names used
        expect(labels.some((l: any) => l.distance === SCOPE_LANE.score)).toBe(false);
        // the layout is NOT collapsed: the grid still leaves the whole strip free above the plot
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
            expect(stripLabels(o)).toHaveLength(2); // the two train periods; S1 has no label at all
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

    // SPEC §3 writes the strip as `TRAIN P1 P2` — the word once.
    it('strip names: one train period = "TRAIN"; several = "TRAIN P1" then "P2", "P3" (the word ONCE); a scoring period is never named', () => {
        const v = makeValidation({
            train_ranges: [{ start: '2026-01-01T00:00', end: '2026-01-01T00:30' }, { start: '2026-01-01T01:00', end: '2026-01-01T02:00' }],
            tests: [makeTestResult({ index: 1, start: '2026-01-01T02:00', end: '2026-01-01T03:00' }), makeTestResult({ index: 2, start: '2026-01-01T03:00', end: '2026-01-01T04:00' })],
        });
        // the scoring periods are still IN the scopes, numbered (they decide where the line runs) ...
        expect(scopesOf(v)!.ranges.map(r => r.label)).toEqual(['TRAIN P1', 'TRAIN P2', 'S1', 'S2']);
        // ... and none of them is on the strip
        const full: any = buildTimeSeriesOption({ ...spec, scopes: scopesOf(v) });
        expect(stripNames(full)).toEqual(['TRAIN P1', 'P2']);
        expect(stripNames(full).filter(n => /TRAIN/.test(n))).toHaveLength(1);
        // a half-width chart drops the word, never the number
        const half: any = buildTimeSeriesOption({ ...spec, scopes: compactScopes(scopesOf(v)) });
        expect(stripNames(half)).toEqual(['P1', 'P2']);
        // every name is a train name, on the train lane
        expect(stripLabels(full).map((l: any) => l.distance)).toEqual([SCOPE_LANE.train, SCOPE_LANE.train]);
        expect(stripLabels(full).map((l: any) => l.color)).toEqual([CHART.train, CHART.train]);
        for (const o of [full, half]) expectNoScoringBand(o);
        // a single train period needs no number — and the strip holds just that one name
        const one: any = buildTimeSeriesOption({ ...spec, scopes: scopesOf(makeValidation({ tests: [makeTestResult()] })) });
        expect(stripNames(one)).toEqual(['TRAIN']);
        expect(one.grid.top).toBe(10 + SCOPE_STRIP); // the strip row is kept for the one name
        // whatever S-number the period has (here S2: an earlier one was not sent), the strip does not print it
        const numbered = scopesOf(makeValidation({ tests: [makeTestResult({ index: 1 })] }), [2])!;
        expect(numbered.ranges.map(r => r.label)).toEqual(['TRAIN', 'S2']);
        expect(stripNames(buildTimeSeriesOption({ ...spec, scopes: numbered }))).toEqual(['TRAIN']);
    });

    it('LEGACY data: an old answer with a Normal / Known-problem label and an event time is still plain "S1", "S2" in the scopes — and draws nothing', () => {
        // two periods at different times (two names over the SAME range would print on each other, so one is left out)
        const old = (index: number, label: string) => ({ ...makeTestResult({ index, start: `2026-01-01T0${index}:00`, end: `2026-01-01T0${index}:30` }), label, event_time: '2026-01-01T03:30', lead_days: 2 });
        const v = makeValidation({ tests: [old(1, 'problem'), old(2, 'normal')] });
        expect(scopesOf(v)!.ranges.map(r => r.label)).toEqual(['TRAIN', 'S1', 'S2']); // plain numbers in the scopes
        const o: any = buildTimeSeriesOption({ ...spec, scopes: scopesOf(v) });
        expect(stripNames(o)).toEqual(['TRAIN']); // and no scoring name on the strip
        expect(JSON.stringify(carrier(o))).not.toMatch(/KNOWN|NORMAL|PROBLEM|EVENT|T1|T2|S1|S2/);
        // no train range in the answer (a period open at both ends): one TRAIN name over the whole axis
        const open: any = buildTimeSeriesOption({ ...spec, scopes: scopesOf(makeValidation({ train_ranges: [], tests: [] })) });
        expect(stripNames(open)).toEqual(['TRAIN']);
    });

    it('scoring periods alone draw NO band at all (no fill, no hatch, no frame) — their rows are still the line', () => {
        const two: TimeScopes = { ranges: [SCOPES.ranges[1], { ...SCOPES.ranges[1], start: '2026-01-01T01:30', end: '2026-01-01T02:30', label: 'S2', short: 'S2' }] };
        const o: any = buildTimeSeriesOption({ ...spec, scopes: two });
        expect(carrier(o).markArea.data).toEqual([]);
        expect(stripNames(o)).toEqual([]);
        expectNoScoringBand(o);
        // S2 holds 02:00, S1 holds 03:00 and 04:00: those rows are drawn — as is every other value of the series
        expect(linePoints(o)).toEqual(TS.map((t, i) => [ms(t), i + 1]));
        expect(o.grid.top).toBe(10 + SCOPE_STRIP); // the plot does not move when a chart has no train band in view
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

    describe('scopeStripNames: the word TRAIN once, and names that never print on each other', () => {
        const band = (kind: 'train' | 'score', n: number, a: number, b: number): StripBand =>
            ({ kind, label: kind === 'train' ? `TRAIN P${n}` : `S${n}`, short: kind === 'train' ? `P${n}` : `S${n}`, a, b });
        /** [left, right] px of a printed name on the plot width the rule assumes (5.6 px per character). */
        const box = (text: string, b: StripBand, width: number, xMin: number, xMax: number) => {
            const c = (((b.a + b.b) / 2 - xMin) / (xMax - xMin)) * width;
            return [c - (text.length * 5.6) / 2, c + (text.length * 5.6) / 2];
        };
        const apart = (bands: StripBand[], names: (string | null)[], width: number, xMin: number, xMax: number) => {
            for (const kind of ['train', 'score'] as const) {
                const shown = bands.map((b, i) => ({ b, t: names[i] })).filter(x => x.b.kind === kind && x.t !== null)
                    .map(x => box(x.t!, x.b, width, xMin, xMax)).sort((p, q) => p[0] - q[0]);
                for (let i = 1; i < shown.length; i++) expect(shown[i][0]).toBeGreaterThanOrEqual(shown[i - 1][1]);
            }
        };

        it('a few periods: every name is printed — "TRAIN P1", "P2", "P3"', () => {
            const bands = [band('train', 1, 0, 30), band('train', 2, 35, 65), band('train', 3, 70, 100)];
            expect(scopeStripNames(bands, 0, 100)).toEqual(['TRAIN P1', 'P2', 'P3']);
            expect(scopeStripNames(bands, 0, 100, { short: true })).toEqual(['P1', 'P2', 'P3']); // half-width: numbers only
            // the only train period keeps its plain name
            expect(scopeStripNames([{ kind: 'train', label: 'TRAIN', short: 'TRAIN', a: 0, b: 100 }], 0, 100)).toEqual(['TRAIN']);
            expect(scopeStripNames([{ kind: 'train', label: 'TRAIN', short: 'TRAIN', a: 0, b: 100 }], 0, 100, { short: true })).toEqual(['TRAIN']);
        });

        it('the word goes to the LEFT-MOST train band that is drawn, whatever its number', () => {
            // P1 lies outside the data and is not drawn: the strip still says TRAIN once
            expect(scopeStripNames([band('train', 2, 0, 40), band('train', 3, 60, 100)], 0, 100)).toEqual(['TRAIN P2', 'P3']);
            // listed out of time order
            expect(scopeStripNames([band('train', 1, 60, 100), band('train', 2, 0, 40)], 0, 100)).toEqual(['P1', 'TRAIN P2']);
        });

        it('20 periods: no two printed names touch (some are left out), deterministically, and "TRAIN P1" is always there', () => {
            const bands = Array.from({ length: 20 }, (_, i) => band('train', i + 1, i * 5, i * 5 + 4));
            for (const [short, plotWidth] of [[false, STRIP_PLOT_WIDTH.full], [true, STRIP_PLOT_WIDTH.narrow], [false, STRIP_PLOT_WIDTH.narrow]] as const) {
                const names = scopeStripNames(bands, 0, 100, { short, plotWidth });
                apart(bands, names, plotWidth, 0, 100);
                expect(names[0]).toBe(short ? 'P1' : 'TRAIN P1');
                const shown = names.filter(n => n !== null);
                expect(shown.length).toBeLessThan(20); // 20 names do not fit
                expect(shown.length).toBeGreaterThanOrEqual(plotWidth === STRIP_PLOT_WIDTH.full ? 10 : 5); // but as many as do are printed
                expect(names.filter(n => n !== null && /TRAIN/.test(n))).toHaveLength(short ? 0 : 1);
                expect(scopeStripNames(bands, 0, 100, { short, plotWidth })).toEqual(names); // the same answer every time
            }
            // a narrower plot never prints MORE names than a wider one
            const count = (plotWidth: number) => scopeStripNames(bands, 0, 100, { plotWidth }).filter(n => n !== null).length;
            expect(count(STRIP_PLOT_WIDTH.narrow)).toBeLessThan(count(STRIP_PLOT_WIDTH.full));
            expect(count(5000)).toBe(20); // with room for all of them, all are printed
            // every band is still DRAWN: only a name is left out
            const ts = Array.from({ length: 101 }, (_, i) => `2026-01-01 ${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00`);
            const at = (i: number) => `2026-01-01T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`;
            const ranges = Array.from({ length: 20 }, (_, i) => ({ kind: 'train' as const, start: at(i * 5), end: at(i * 5 + 4), label: `TRAIN P${i + 1}`, short: `P${i + 1}` }));
            const o: any = buildTimeSeriesOption({ timestamps: ts, lines: [{ name: 'V', values: ts.map((_, i) => i), color: '#fff' }], scopes: { ranges } });
            expect(carrier(o).markArea.data).toHaveLength(20);
            expect(stripNames(o).length).toBeLessThan(20);
            expect(stripNames(o)[0]).toBe('TRAIN P1');
        });

        it('uneven periods: a short one squeezed between two long ones gives way, the long ones keep their names', () => {
            const bands = [band('train', 1, 0, 45), band('train', 2, 46, 47), band('train', 3, 48, 49), band('train', 4, 50, 100)];
            const names = scopeStripNames(bands, 0, 100);
            expect(names[0]).toBe('TRAIN P1');
            expect(names[3]).toBe('P4');
            expect(names.slice(1, 3).filter(n => n !== null).length).toBeLessThanOrEqual(1);
            apart(bands, names, STRIP_PLOT_WIDTH.full, 0, 100);
        });

        it('train and scoring names are on separate lanes: one never hides the other', () => {
            const bands = [band('train', 1, 0, 100), band('score', 1, 40, 60), band('score', 2, 41, 59), band('score', 3, 80, 100)];
            const names = scopeStripNames(bands, 0, 100);
            expect(names[0]).toBe('TRAIN P1'); // right above S1, on the other lane
            expect(names[1]).toBe('S1');
            expect(names[2]).toBeNull(); // S2 sits on S1: left out
            expect(names[3]).toBe('S3');
        });

        it('a single instant (no time span to place names on) prints the first name only', () => {
            expect(scopeStripNames([band('train', 1, 5, 5), band('train', 2, 5, 5)], 5, 5)).toEqual(['TRAIN P1', null]);
            expect(scopeStripNames([], 0, 1)).toEqual([]);
        });
    });

    it('which plot width the names are spaced for: a full-width card, or the narrow one for a half-width chart', () => {
        const ts = Array.from({ length: 101 }, (_, i) => `2026-01-01 ${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00`);
        const at = (i: number) => `2026-01-01T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`;
        const ranges = Array.from({ length: 20 }, (_, i) => ({ kind: 'train' as const, start: at(i * 5), end: at(i * 5 + 4), label: `TRAIN P${i + 1}`, short: `P${i + 1}` }));
        const build = (scopes: TimeScopes | null) => buildTimeSeriesOption({ timestamps: ts, lines: [{ name: 'V', values: ts.map((_, i) => i), color: '#fff' }], scopes });
        const full = stripNames(build({ ranges }));
        const compact = stripNames(build(compactScopes({ ranges })));
        expect(compactScopes({ ranges })).toEqual({ ranges, compact: true });
        expect(compactScopes(null)).toBeNull();
        // across the board: the word TRAIN once, then numbers
        expect(full[0]).toBe('TRAIN P1');
        // half-width: numbers only, spaced for the narrow plot — fewer names than across the board
        expect(compact[0]).toBe('P1');
        expect(compact.some(n => /TRAIN/.test(n))).toBe(false);
        expect(compact.length).toBeLessThan(full.length);
        // few periods on a full-width card: every one is named
        const few = { ranges: ranges.slice(0, 3).map((r, i) => ({ ...r, start: at(i * 30), end: at(i * 30 + 25) })) };
        expect(stripNames(build(few))).toEqual(['TRAIN P1', 'P2', 'P3']);
        // (there is no "chart beside a side card" spacing any more: the Health score page's charts
        // are one full-width card since "Workbench detail pages v2")
        expect(Object.keys(few)).toEqual(['ranges']);
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

    it('time outside every period (train OR scoring) is a gap: a null is inserted where the line leaves a scope', () => {
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
        it(`${name}: no carrier without scopes; with them the TRAIN band only — the scoring period is not drawn`, () => {
            expect(carrier(build(null))).toBeUndefined();
            const o = build(SCOPES);
            expect(carrier(o).markArea.data).toHaveLength(1);
            expect(carrier(o).markArea.data[0][0].name).toBe('TRAIN');
            expectNoScoringBand(o);
        });

        it(`${name}: the rows of the scoring period are still on the line (03:00 and 04:00, joined)`, () => {
            const o = build(SCOPES);
            const plain = build(null);
            // every value the chart has without scopes, it has with them
            expect(linePoints(o)).toEqual(linePoints(plain));
            const data = o.series[0].data as [number, number | null][];
            const at = (t: string) => data.findIndex(p => p[0] === ms(t));
            expect(at('2026-01-01 03:00:00')).toBeGreaterThanOrEqual(0);
            expect(at('2026-01-01 04:00:00') - at('2026-01-01 03:00:00')).toBe(1); // no gap inside S1
        });

        it(`${name}: the strip above the plot names the train period; nothing is a pill inside it`, () => {
            const o = build(SCOPES);
            expect(stripNames(o)).toEqual(['TRAIN']);
            expect(o.grid.top).toBe(10 + SCOPE_STRIP);
            expect(stripLabels(o).every((l: any) => l.position === 'top' && l.backgroundColor === undefined)).toBe(true);
            expect(build(null).grid.top).toBe(14); // no scopes, no strip
        });
    }

    it('Clustering has no time chart on Model fit, so its strip is on the Health score chart only (the score builder takes the scopes)', () => {
        const clu = makeHealthPreview({ kind: 'clustering', n_clusters: 2 });
        const o: any = buildScoreOption(clu.series.timestamps, [100, 90, null, 70, 60], SCOPES);
        expect(stripNames(o)).toEqual(['TRAIN']);
    });

    it('the score chart keeps its colouring on series 0 (the carrier comes last)', () => {
        const o: any = buildScoreOption(TS, [90, 85, null, 70, 60], SCOPES);
        expect(o.visualMap.seriesIndex).toBe(0);
        expect(o.series[o.series.length - 1].name).toBe('__scopes');
    });
});
