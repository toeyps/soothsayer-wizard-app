// @vitest-environment node
import { describe, it, expect } from 'vitest';
import * as echarts from 'echarts';
import {
    REF_LABEL_GUTTER,
    RING_LABEL_LINE,
    STRIP_PLOT_WIDTH,
    buildClusterOption,
    buildDistributionOption,
    buildResidualOption,
    buildTargetVsPredictedOption,
    buildTimeSeriesOption,
    buildValueOverTimeOption,
    compactScopes,
    individualVLines,
    narrowScopes,
    type TimeScope,
} from '../components/windows/workbench/healthCharts';
import { buildClusterSetPointOption, buildIndividualSetPointOption, buildRelationshipSetPointOption } from '../components/windows/workbench/healthPageCharts';
import { CHART } from '../components/windows/workbench/chartTheme';
import { makeClusterStat, makeHealthPreview } from './helpers/healthPreviewFixture';
import type { ClusteringSeries, IndividualSeries, IndividualStats, RelationshipSeries } from '../types/health';

/*
 * WHERE the labels of the Workbench charts end up (review of commit 0125190).
 *
 * The other chart tests read the option objects. That cannot see two labels
 * printed on top of each other, a tick added at a raw axis end, or a name left
 * behind by a zoom — those only exist once ECharts has laid the chart out. So
 * these tests render the REAL options with the installed ECharts in its
 * server-side SVG mode (no DOM, no canvas: this file runs in the node
 * environment) and read the coordinates of the <text> elements.
 *
 * Text is not measured by a real font here, so a label's size is taken from its
 * font: 9.5 px mono labels are ~11.5 px tall on their chip and ~5.7 px per
 * character wide; the 9 px strip names ~5.4 px per character.
 */

interface Txt { text: string; x: number; y: number; fill: string; anchor: string; rotated: boolean }

const num = (s: string | undefined) => (s === undefined ? 0 : Number(s));

/** Every <text> of an SVG with its anchor position (the transform plus its own x / y). */
function textsOf(svg: string): Txt[] {
    const out: Txt[] = [];
    for (const m of svg.matchAll(/<text([^>]*)>([^<]*)<\/text>/g)) {
        const attrs = m[1];
        const attr = (name: string) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1];
        const tr = attr('transform') ?? '';
        const t = /translate\(([-\d.e]+)[ ,]+([-\d.e]+)\)/.exec(tr);
        const mx = /matrix\(([^)]*)\)/.exec(tr)?.[1].split(/[ ,]+/).map(Number);
        const rotated = !!mx && (mx[1] !== 0 || mx[2] !== 0);
        const tx = t ? Number(t[1]) : mx ? mx[4] : 0;
        const ty = t ? Number(t[2]) : mx ? mx[5] : 0;
        out.push({
            text: m[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'),
            x: tx + (rotated ? 0 : num(attr('x'))),
            y: ty + (rotated ? 0 : num(attr('y'))),
            fill: attr('fill') ?? '',
            anchor: attr('text-anchor') ?? 'start',
            rotated,
        });
    }
    return out;
}

/** Renders an option like the app does (same option object), at a given card size. */
function mount(option: object, width = 620, height = 330) {
    const chart = echarts.init(null as unknown as HTMLElement, null, { renderer: 'svg', ssr: true, width, height });
    chart.setOption(option as echarts.EChartsCoreOption);
    return {
        chart,
        svg: () => chart.renderToSVGString(),
        texts: () => textsOf(chart.renderToSVGString()),
        dispose: () => chart.dispose(),
    };
}
const textsFor = (option: object, width = 620, height = 330): Txt[] => {
    const m = mount(option, width, height);
    try {
        const svg = m.svg();
        expect(svg).not.toMatch(/NaN|Infinity/);
        return textsOf(svg);
    } finally {
        m.dispose();
    }
};

const toNumber = (s: string) => Number(s.replace(/,/g, '').replace('−', '-'));
const isNumber = (s: string) => s.trim() !== '' && Number.isFinite(toNumber(s));
/** Tick labels of the Y value axis: right-aligned against the plot's left edge. */
const yTicks = (ts: Txt[]) => ts.filter(t => t.fill === CHART.textSecondary && t.anchor === 'end' && !t.rotated && isNumber(t.text)).sort((a, b) => b.y - a.y);
/** Tick labels of an X VALUE axis: the row of numbers under the plot. */
const xTicks = (ts: Txt[]) => {
    const row = ts.filter(t => t.fill === CHART.textSecondary && t.anchor === 'middle' && !t.rotated && isNumber(t.text));
    const byY = new Map<number, Txt[]>();
    for (const t of row) byY.set(Math.round(t.y), [...(byY.get(Math.round(t.y)) ?? []), t]);
    const best = [...byY.values()].sort((a, b) => b.length - a.length)[0] ?? [];
    return best.sort((a, b) => a.x - b.x);
};
/** Round, evenly spaced ticks: every value a whole multiple of ONE 1 / 2 / 5 × 10ⁿ step, the
 *  same distance apart in value AND in pixels — no extra tick squeezed in at a raw axis end. */
function expectRoundEvenTicks(ticks: Txt[], axis: 'x' | 'y') {
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    const v = ticks.map(t => toNumber(t.text));
    const step = v[1] - v[0];
    expect(step).toBeGreaterThan(0);
    const mant = step / Math.pow(10, Math.floor(Math.log10(step) + 1e-9));
    expect([1, 2, 5].some(m => Math.abs(mant - m) < 1e-6), `step ${step}`).toBe(true);
    const px = Math.abs(ticks[1][axis] - ticks[0][axis]);
    expect(px).toBeGreaterThan(8);
    for (let i = 1; i < ticks.length; i++) {
        expect(v[i] - v[i - 1], `values ${v.join(', ')}`).toBeCloseTo(step, 9);
        expect(Math.abs(ticks[i][axis] - ticks[i - 1][axis]), `pixels of ${v.join(', ')}`).toBeCloseTo(px, 1);
    }
    for (const x of v) expect(Math.abs(x / step - Math.round(x / step)), `${x} on a ${step} grid`).toBeLessThan(1e-6);
}

const TS5 = ['2026-01-01 00:00:00', '2026-01-01 01:00:00', '2026-01-01 02:00:00', '2026-01-01 03:00:00', '2026-01-01 04:00:00'];

// ---------------------------------------------------------------------------
// MUST-FIX 1 — "Actual" / "Predicted" did not follow their lines through a zoom
// ---------------------------------------------------------------------------

describe('Target vs predicted: no name is drawn on the plot, so none can be left beside the wrong line by a zoom', () => {
    // a long series whose two lines cross: after a zoom each line ends at a different height than before
    const n = 200;
    const timestamps = Array.from({ length: n }, (_, i) => `2026-01-${String(1 + Math.floor(i / 24)).padStart(2, '0')} ${String(i % 24).padStart(2, '0')}:00:00`);
    const series: RelationshipSeries = {
        kind: 'relationship',
        rows: timestamps.map((_, i) => i),
        timestamps,
        actual: timestamps.map((_, i) => 10 + i * 0.05),
        predicted: timestamps.map((_, i) => 20 - i * 0.05),
        residual: timestamps.map(() => 0),
        score: null,
        total_points: n,
    };

    it('before and after a wheel-zoom / drag the chart holds only axis text — never "Actual" or "Predicted"', () => {
        const m = mount(buildTargetVsPredictedOption(series, 'bar'), 420, 250);
        try {
            const names = (ts: Txt[]) => ts.filter(t => /Actual|Predicted/.test(t.text));
            expect(names(m.texts())).toEqual([]);
            // the zoom the user does with the wheel (dataZoom "inside"), then a drag to another window
            m.chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, start: 10, end: 45 });
            expect(names(m.texts())).toEqual([]);
            m.chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, start: 60, end: 95 });
            const after = m.texts();
            expect(names(after)).toEqual([]);
            // both lines are still drawn in their own colours — the card's key (Actual blue, Predicted red) reads them
            const svg = m.svg();
            expect(svg).toContain(CHART.actual);
            expect(svg).toContain(CHART.predicted);
            // every text left is an axis label / the unit: nothing is drawn in a series colour
            expect(after.every(t => t.fill === CHART.textSecondary)).toBe(true);
        } finally {
            m.dispose();
        }
    });

    it('with no name to keep room for, the plot runs to the card\'s right edge (the old 64 px gutter is gone)', () => {
        const ts = textsFor(buildTargetVsPredictedOption(series, 'bar'), 420, 250);
        // nothing is drawn right of the plot except half of the last time-axis label
        expect(Math.max(...ts.map(t => t.x))).toBeLessThanOrEqual(420 - 18 + 0.5);
        expectRoundEvenTicks(yTicks(ts), 'y');
    });
});

// ---------------------------------------------------------------------------
// MUST-FIX 2 — ring-level names printed on each other for a cluster tilted up-right
// ---------------------------------------------------------------------------

describe('Clusters: the ring-level names never print on top of each other', () => {
    const series = makeHealthPreview({ kind: 'clustering', n_clusters: 3 }).series as ClusteringSeries;
    /** The reviewer's case: 3 clusters, x_sd 4, y_sd 0.3, N 5, a 620 px chart. */
    const tilted = (angle_deg: number) => [1, 2, 3].map(i => makeClusterStat(i, { x_center: 10 * i, y_center: 20 + i, x_sd: 4, y_sd: 0.3, angle_deg }));
    const ringNames = (ts: Txt[]) => ts.filter(t => /^\d+(\.\d+)?× (· \d+|SD)$/.test(t.text));
    /** A 9.5 px label on its chip (1 px padding top and bottom). */
    const LABEL_H = 11.5;
    const expectApart = (labels: Txt[]) => {
        for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
            expect(Math.abs(labels[i].y - labels[j].y), `${labels[i].text} / ${labels[j].text}`).toBeGreaterThanOrEqual(LABEL_H);
        }
    };

    it('tilted UP to the right (+2°, positively correlated sensors): "5× · 0" on top, "1× · 100" at the bottom, a text line apart', () => {
        const labels = ringNames(textsFor(buildClusterSetPointOption(series, tilted(2), { kind: 'clustering', outerSd: 5 }, { x: 'X', y: 'Y' })));
        expect(labels.map(l => l.text)).toEqual(['1× · 100', '3× · 80', '5× · 0']);
        const [one, three, n] = labels;
        expectApart(labels);
        // the names keep the order of the ring edges they belong to: the highest edge has the highest name
        expect(n.y).toBeLessThan(three.y);
        expect(three.y).toBeLessThan(one.y);
        // each at least a full stagger step from the next (the stagger adds to the edges' own distance)
        expect(three.y - n.y).toBeGreaterThanOrEqual(RING_LABEL_LINE);
        expect(one.y - three.y).toBeGreaterThanOrEqual(RING_LABEL_LINE);
        // and still at the right edge of its own ring: further right for a larger ring
        expect(one.x).toBeLessThan(three.x);
        expect(three.x).toBeLessThan(n.x);
    });

    it('any tilt, flat, steep, either way — and with N typed anywhere above 3', () => {
        for (const angle of [-80, -30, -2, 0, 2, 15, 45, 80]) {
            for (const outerSd of [3.5, 5, 9]) {
                const labels = ringNames(textsFor(buildClusterSetPointOption(series, tilted(angle), { kind: 'clustering', outerSd }, { x: 'X', y: 'Y' })));
                expect(labels, `angle ${angle}, N ${outerSd}`).toHaveLength(3);
                expectApart(labels);
            }
        }
    });

    it('the Model fit chart (1× SD, 3× SD) follows the same rule', () => {
        const scatter = { x: series.x, y: series.y, cluster: series.cluster, total: series.x.length };
        for (const angle of [-30, -2, 0, 2, 30]) {
            const labels = ringNames(textsFor(buildClusterOption(scatter, tilted(angle), { x: 'X', y: 'Y' })));
            expect(labels.map(l => l.text)).toEqual(['1× SD', '3× SD']);
            expectApart(labels);
        }
        const up = ringNames(textsFor(buildClusterOption(scatter, tilted(2), { x: 'X', y: 'Y' })));
        expect(up[1].y).toBeLessThan(up[0].y); // 3× above 1× for a cluster tilted up to the right
    });

    it('the names stay apart after zooming into the rings', () => {
        const m = mount(buildClusterSetPointOption(series, tilted(2), { kind: 'clustering', outerSd: 5 }, { x: 'X', y: 'Y' }));
        try {
            m.chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, start: 40, end: 100 });
            m.chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 1, start: 10, end: 60 });
            const labels = ringNames(m.texts());
            expect(labels).toHaveLength(3);
            expectApart(labels);
        } finally {
            m.dispose();
        }
    });

    it('both axes of a Clusters chart tick on one round step, from the first tick to the last', () => {
        for (const option of [
            buildClusterSetPointOption(series, tilted(2), { kind: 'clustering', outerSd: 5 }, { x: 'X', y: 'Y' }),
            buildClusterOption({ x: series.x, y: series.y, cluster: series.cluster, total: series.x.length }, tilted(-30), { x: 'X', y: 'Y' }),
        ]) {
            const ts = textsFor(option);
            expectRoundEvenTicks(yTicks(ts), 'y');
            expectRoundEvenTicks(xTicks(ts), 'x');
        }
    });

    // Review item 8.
    it('a degenerate extent — every point at one value, rings of no size — still draws two real axes', () => {
        const dot = makeClusterStat(1, { x_center: 5, y_center: 7, x_sd: 0, y_sd: 0 });
        const ts = textsFor(buildClusterOption({ x: [5, 5, 5], y: [7, 7, 7], cluster: [1, 1, 1], total: 3 }, [dot], { x: 'X', y: 'Y' }));
        const xs = xTicks(ts);
        const ys = yTicks(ts);
        expectRoundEvenTicks(xs, 'x');
        expectRoundEvenTicks(ys, 'y');
        // distinct labels around the value, which sits inside the axis
        expect(new Set(xs.map(t => t.text)).size).toBe(xs.length);
        expect(toNumber(xs[0].text)).toBeLessThan(5);
        expect(toNumber(xs[xs.length - 1].text)).toBeGreaterThan(5);
        expect(toNumber(ys[0].text)).toBeLessThan(7);
        expect(toNumber(ys[ys.length - 1].text)).toBeGreaterThan(7);
        // the cluster is on screen, inside the plot
        const name = ts.find(t => t.text === 'Cluster 1')!;
        expect(name.x).toBeGreaterThan(58);
        expect(name.x).toBeLessThan(620 - 18);
        // and the Health score chart of the same data
        const hs = textsFor(buildClusterSetPointOption({ ...series, x: series.x.map(() => 5), y: series.y.map(() => 7) }, [dot], { kind: 'clustering', outerSd: 5 }, { x: 'X', y: 'Y' }));
        expectRoundEvenTicks(xTicks(hs), 'x');
        expectRoundEvenTicks(yTicks(hs), 'y');
    });
});

// ---------------------------------------------------------------------------
// Item 3 — round ticks, no tick added at a raw axis end
// ---------------------------------------------------------------------------

describe('value axes tick on the step their range was rounded to', () => {
    it('Distribution X (it read 0, 3, 6, 9, 12, 15, 16) and Y', () => {
        const h = { bin_edges: [0.2, 3, 6, 9, 12, 15.7], counts: [3, 400, 942, 87, 5], curve: [5, 380, 942.7, 90, 4], bin_width: 3, n: 1437 };
        const ts = textsFor(buildDistributionOption(h, [], '°C'), 420, 250);
        const xs = xTicks(ts);
        expect(xs.map(t => t.text)).toEqual(['0', '2', '4', '6', '8', '10', '12', '14', '16']);
        expectRoundEvenTicks(xs, 'x');
        const ys = yTicks(ts);
        expect(ys.map(t => t.text)).toEqual(['0', '200', '400', '600', '800', '1,000', '1,200']);
        expectRoundEvenTicks(ys, 'y');
    });

    it('Distribution of the fixture with its ±1SD / ±3SD lines', () => {
        const p = makeHealthPreview({ kind: 'individual' });
        const ts = textsFor(buildDistributionOption(p.histogram!, individualVLines(p.stats as IndividualStats), 'bar'), 420, 250);
        expectRoundEvenTicks(xTicks(ts), 'x');
        expectRoundEvenTicks(yTicks(ts), 'y');
    });

    it('time-series Y axes: sensor value (it read 1, 2, 4, 6, 8, 9), residual (−4, −3, 0, 3 …), fractions, large values', () => {
        const ind = makeHealthPreview({ kind: 'individual' });
        const value = yTicks(textsFor(buildValueOverTimeOption(ind.series as IndividualSeries, ind.stats as IndividualStats, 'bar')));
        expect(value.map(t => t.text)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
        expectRoundEvenTicks(value, 'y');

        const rel = makeHealthPreview({ kind: 'relationship' }).series as RelationshipSeries;
        const wide = { ...rel, residual: [-3.7, 2.2, 3.9, -0.4, 1.1] };
        expectRoundEvenTicks(yTicks(textsFor(buildResidualOption(wide, 0.9, 'bar'))), 'y');
        expectRoundEvenTicks(yTicks(textsFor(buildRelationshipSetPointOption(wide, 0.9, { kind: 'relationship', residualAt80Lower: -5, residualAt80Upper: 5, residualAt0Lower: -9, residualAt0Upper: 9 }, 'bar'))), 'y');

        const line = (values: number[]) => buildTimeSeriesOption({ timestamps: TS5, lines: [{ name: 'V', values, color: '#fff' }] });
        const frac = yTicks(textsFor(line([0.11, 0.32, 0.5, 0.71, 0.6]), 620, 250));
        expect(frac.map(t => t.text)).toEqual(['0', '0.1', '0.2', '0.3', '0.4', '0.5', '0.6', '0.7', '0.8']); // no "0.30000000000000004"
        expectRoundEvenTicks(frac, 'y');
        expectRoundEvenTicks(yTicks(textsFor(line([12480, 13950, 12010, 15020, 14400]), 620, 250)), 'y');
        expectRoundEvenTicks(yTicks(textsFor(line([-0.00031, 0.00042, 0.0001, -0.0002, 0.0003]), 620, 250)), 'y');
    });

    // Review item 7.
    it('an EMPTY Distribution (no bins, no lines) renders: no NaN / Infinity anywhere, a plain 0-based Y axis', () => {
        const empty = { bin_edges: [], counts: [], curve: [], bin_width: 0, n: 0 };
        const m = mount(buildDistributionOption(empty, [], '°C'), 420, 250);
        try {
            const svg = m.svg();
            expect(svg).not.toMatch(/NaN|Infinity/);
            const ts = textsOf(svg);
            const ys = yTicks(ts);
            expect(ys[0].text).toBe('0');
            expectRoundEvenTicks(ys, 'y');
            expect(ts.some(t => t.text === '°C')).toBe(true); // the axis title is still there
        } finally {
            m.dispose();
        }
    });
});

// ---------------------------------------------------------------------------
// Item 11 — the time axis shows the stamp's OWN clock, whatever zone it names
// ---------------------------------------------------------------------------

describe('the time axis of an offset-stamped CSV shows the clock the file wrote', () => {
    const pad = (n: number) => String(n).padStart(2, '0');
    /** 25 hourly rows of one day, 00:00 … 24:00, every stamp ending in `zone`. */
    const day = (zone: string) => Array.from({ length: 25 }, (_, h) => (h < 24 ? `2026-02-09T${pad(h)}:00:00${zone}` : `2026-02-10T00:00:00${zone}`));
    const hourLabels = (zone: string) => {
        const timestamps = day(zone);
        const ts = textsFor(buildTimeSeriesOption({ timestamps, lines: [{ name: 'V', values: timestamps.map((_, i) => i), color: '#fff' }] }), 620, 250);
        return ts.filter(t => /^\d{2}:\d{2}$/.test(t.text)).sort((a, b) => a.x - b.x);
    };

    it('"…+07:00", "…-05:00", "…Z" and no zone at all draw the SAME axis: 06:00 a quarter of the way along, 12:00 in the middle', () => {
        const plotLeft = 58;
        const plotWidth = 620 - 58 - 18;
        const plain = hourLabels('');
        expect(plain.length).toBeGreaterThanOrEqual(3);
        for (const l of plain) {
            const hour = Number(l.text.slice(0, 2)) + Number(l.text.slice(3)) / 60;
            // the label sits where that hour of the FILE's clock is: hour / 24 of the plot
            expect(l.x, `${l.text}`).toBeCloseTo(plotLeft + (hour / 24) * plotWidth, 0);
        }
        // every zone gives the very same labels at the very same places — on a PC in any time zone
        const at = (ls: Txt[]) => ls.map(l => [l.text, Math.round(l.x)]);
        for (const zone of ['+07:00', '-05:00', 'Z', '+0530']) expect(at(hourLabels(zone)), zone).toEqual(at(plain));
    });
});

// ---------------------------------------------------------------------------
// Item 4 — "+1SD" printed on "+3SD" when L / H are far from the data
// ---------------------------------------------------------------------------

describe('Individual: the ±SD names with set points far from the data', () => {
    const p = makeHealthPreview({ kind: 'individual' }); // ±1SD 4..6, ±3SD 2..8
    const series = p.series as IndividualSeries;
    const stats = p.stats as IndividualStats;
    const sdNames = (ts: Txt[]) => ['+3SD', '+1SD', '−1SD', '−3SD'].map(name => {
        const hit = ts.filter(t => t.text === name);
        expect(hit, name).toHaveLength(1); // each name is printed exactly once — none is dropped
        return hit[0];
    });
    /** A 9.5 px line of text. */
    const TEXT_H = 9.5;

    it('master alarm limits L −200 / H 300 (the band is ~3 px tall): the four names are stacked in order, none on another', () => {
        const ts = textsFor(buildIndividualSetPointOption(series, stats, { kind: 'individual', lower: -200, upper: 300 }, 'bar'));
        const [u3, u1, l1, l3] = sdNames(ts);
        // top to bottom, as the lines are
        expect(u3.y).toBeLessThan(u1.y);
        expect(u1.y).toBeLessThan(l1.y);
        expect(l1.y).toBeLessThan(l3.y);
        for (const [a, b] of [[u3, u1], [u1, l1], [l1, l3]]) expect(b.y - a.y).toBeGreaterThanOrEqual(TEXT_H);
        // all four in the gutter right of the plot, left-aligned on one column, each in its own line's colour
        const plotRight = 620 - REF_LABEL_GUTTER;
        for (const t of [u3, u1, l1, l3]) {
            expect(t.x).toBeGreaterThanOrEqual(plotRight);
            expect(t.x).toBe(u3.x);
            expect(t.anchor).toBe('start');
        }
        expect([u3.fill, u1.fill, l1.fill, l3.fill]).toEqual([CHART.warn, CHART.ok, CHART.ok, CHART.warn]);
        // the set points keep their own labels inside the plot, with a real minus sign
        const h = ts.find(t => t.text === 'H 300')!;
        const l = ts.find(t => t.text === 'L −200')!;
        expect(h.x).toBeLessThan(plotRight);
        expect(l.x).toBeLessThan(plotRight);
        expect(h.y).toBeLessThan(u3.y - TEXT_H);
        expect(l.y).toBeGreaterThan(l3.y + TEXT_H);
        expect(ts.some(t => t.text.includes('L -'))).toBe(false);
    });

    it('the stacked names fit inside the canvas even when the band is at the very top or bottom of the range', () => {
        for (const sp of [{ lower: -5000, upper: null }, { lower: null, upper: 5000 }, { lower: -1e6, upper: 1e6 }]) {
            const height = 250;
            const ts = textsFor(buildIndividualSetPointOption(series, stats, { kind: 'individual', ...sp }, 'bar'), 620, height);
            const names = sdNames(ts);
            for (let i = 1; i < names.length; i++) expect(names[i].y - names[i - 1].y).toBeGreaterThanOrEqual(TEXT_H);
            for (const t of names) {
                expect(t.y - TEXT_H / 2).toBeGreaterThanOrEqual(0);
                expect(t.y + TEXT_H / 2).toBeLessThanOrEqual(height);
            }
        }
    });

    it('normal data (no far set points): every name sits at its own line, as before', () => {
        const ts = textsFor(buildValueOverTimeOption(series, stats, 'bar'));
        const [u3, u1, l1, l3] = sdNames(ts);
        const ticks = yTicks(ts);
        const yOf = (v: number) => ticks.find(t => toNumber(t.text) === v)!.y;
        // + names just above their line, − names just below it
        expect(u3.y).toBeLessThan(yOf(8));
        expect(yOf(8) - u3.y).toBeLessThan(TEXT_H);
        expect(u1.y).toBeLessThan(yOf(6));
        expect(yOf(6) - u1.y).toBeLessThan(TEXT_H);
        expect(l1.y).toBeGreaterThan(yOf(4));
        expect(l1.y - yOf(4)).toBeLessThan(TEXT_H);
        expect(l3.y).toBeGreaterThan(yOf(2));
        expect(l3.y - yOf(2)).toBeLessThan(TEXT_H);
    });

    it('in between (the lines a few text heights apart or less): still never two names within one text line', () => {
        for (const far of [12, 20, 30, 45, 60, 90, 150]) {
            for (const height of [250, 330]) {
                const ts = textsFor(buildIndividualSetPointOption(series, stats, { kind: 'individual', lower: -far, upper: far + 10 }, 'bar'), 620, height);
                const names = sdNames(ts);
                for (let i = 1; i < names.length; i++) {
                    expect(names[i].y - names[i - 1].y, `L ${-far} / H ${far + 10} at ${height}px: ${names[i - 1].text} / ${names[i].text}`).toBeGreaterThanOrEqual(TEXT_H);
                }
            }
        }
    });
});

// ---------------------------------------------------------------------------
// Item 5 — "TRAIN P1" … "TRAIN P20" printed on each other
// ---------------------------------------------------------------------------

describe('the scope strip with many periods', () => {
    const pad = (n: number) => String(n).padStart(2, '0');
    const timestamps: string[] = [];
    for (let d = 1; d <= 20; d++) for (const h of [0, 6, 12, 18]) timestamps.push(`2026-01-${pad(d)} ${pad(h)}:00:00`);
    const train: TimeScope[] = Array.from({ length: 20 }, (_, i) => ({ kind: 'train', start: `2026-01-${pad(i + 1)}T00:00`, end: `2026-01-${pad(i + 1)}T18:00`, label: `TRAIN P${i + 1}`, short: `P${i + 1}` }));
    const score: TimeScope[] = Array.from({ length: 12 }, (_, i) => ({ kind: 'score', start: `2026-01-${pad(i + 1)}T06:00`, end: `2026-01-${pad(i + 1)}T12:00`, label: `S${i + 1}`, short: `S${i + 1}` }));
    const option = (ranges: TimeScope[], hint?: 'compact' | 'narrow') => buildTimeSeriesOption({
        timestamps,
        lines: [{ name: 'V', values: timestamps.map((_, i) => i % 7), color: '#fff' }],
        scopes: hint === 'compact' ? compactScopes({ ranges }) : hint === 'narrow' ? narrowScopes({ ranges }) : { ranges },
    });
    /** Width of a 9 px mono name. */
    const nameWidth = (text: string) => text.length * 5.4;
    const lane = (ts: Txt[], colour: string) => ts.filter(t => t.fill === colour).sort((a, b) => a.x - b.x);
    const expectNoOverlap = (names: Txt[]) => {
        for (let i = 1; i < names.length; i++) {
            const prevRight = names[i - 1].x + nameWidth(names[i - 1].text) / 2;
            const left = names[i].x - nameWidth(names[i].text) / 2;
            expect(left, `"${names[i - 1].text}" / "${names[i].text}"`).toBeGreaterThanOrEqual(prevRight);
        }
    };

    it('20 train periods on the narrowest full-width plot: "TRAIN" once, then numbers — no two names touch', () => {
        // grid: 58 px left, 18 px right → a plot exactly STRIP_PLOT_WIDTH.full wide
        const width = STRIP_PLOT_WIDTH.full + 58 + 18;
        const names = lane(textsFor(option(train), width, 250), CHART.train);
        expect(names[0].text).toBe('TRAIN P1');
        expect(names.filter(t => /TRAIN/.test(t.text))).toHaveLength(1);
        expect(names.slice(1).every(t => /^P\d+$/.test(t.text))).toBe(true);
        expect(names.length).toBeGreaterThanOrEqual(10);
        expect(names.length).toBeLessThan(20);
        expectNoOverlap(names);
        // all on ONE lane, above the plot
        expect(new Set(names.map(t => Math.round(t.y))).size).toBe(1);
        expect(names[0].y).toBeLessThan(10 + 26);
    });

    it('the same strip on wider cards (620 px, an expanded 1400 px chart): still no overlap', () => {
        for (const width of [620, 900, 1400]) expectNoOverlap(lane(textsFor(option(train), width, 250), CHART.train));
    });

    it('a half-width chart (compact): numbers only, thinned for its narrower plot', () => {
        const width = STRIP_PLOT_WIDTH.narrow + 58 + 18;
        const names = lane(textsFor(option(train, 'compact'), width, 250), CHART.train);
        expect(names[0].text).toBe('P1');
        expect(names.some(t => /TRAIN/.test(t.text))).toBe(false);
        expect(names.length).toBeGreaterThanOrEqual(5);
        expectNoOverlap(names);
    });

    it('a chart beside a side card (the Health score set-point chart): "TRAIN" once, thinned for the same narrow plot', () => {
        // with the reference-label gutter: 58 px left, 52 px right
        const width = STRIP_PLOT_WIDTH.narrow + 58 + 52;
        const p = makeHealthPreview({ kind: 'individual' });
        const series = { ...(p.series as IndividualSeries), timestamps, rows: timestamps.map((_, i) => i), value: timestamps.map((_, i) => 4 + (i % 3)), score: null };
        const names = lane(textsFor(buildIndividualSetPointOption(series, p.stats as IndividualStats, { kind: 'individual', lower: 1, upper: 9 }, 'bar', narrowScopes({ ranges: train })), width, 330), CHART.train);
        expect(names[0].text).toBe('TRAIN P1');
        expect(names.filter(t => /TRAIN/.test(t.text))).toHaveLength(1);
        expect(names.length).toBeGreaterThanOrEqual(4);
        expectNoOverlap(names);
    });

    it('train and scoring names together: each lane is free of overlaps, and the two lanes are a text line apart', () => {
        const ts = textsFor(option([...train, ...score]), STRIP_PLOT_WIDTH.full + 58 + 18, 250);
        const t = lane(ts, CHART.train);
        const s = lane(ts, CHART.test);
        expect(s[0].text).toBe('S1');
        expectNoOverlap(t);
        expectNoOverlap(s);
        expect(s[0].y - t[0].y).toBeGreaterThanOrEqual(11); // train above, scoring below
    });

    it('a few periods are all named: "TRAIN P1  P2  P3" and "S1  S2"', () => {
        const few: TimeScope[] = [
            { kind: 'train', start: '2026-01-01T00:00', end: '2026-01-05T00:00', label: 'TRAIN P1', short: 'P1' },
            { kind: 'train', start: '2026-01-07T00:00', end: '2026-01-11T00:00', label: 'TRAIN P2', short: 'P2' },
            { kind: 'train', start: '2026-01-13T00:00', end: '2026-01-17T00:00', label: 'TRAIN P3', short: 'P3' },
            { kind: 'score', start: '2026-01-05T00:00', end: '2026-01-07T00:00', label: 'S1', short: 'S1' },
            { kind: 'score', start: '2026-01-17T00:00', end: '2026-01-20T00:00', label: 'S2', short: 'S2' },
        ];
        const ts = textsFor(option(few), 620, 250);
        expect(lane(ts, CHART.train).map(t => t.text)).toEqual(['TRAIN P1', 'P2', 'P3']);
        expect(lane(ts, CHART.test).map(t => t.text)).toEqual(['S1', 'S2']);
    });
});
