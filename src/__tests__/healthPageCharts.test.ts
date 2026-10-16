import { describe, it, expect } from 'vitest';
import {
    HEALTH_SYNC_GROUP,
    buildClusterSetPointOption,
    buildIndividualSetPointOption,
    buildRelationshipSetPointOption,
    buildScoreOption,
    scoreColor,
    signedTypedText,
    typedText,
} from '../components/windows/workbench/healthPageCharts';
import { CHART, CLUSTER_COLORS, fmtScoreAxisValue } from '../components/windows/workbench/chartTheme';
import * as healthPageCharts from '../components/windows/workbench/healthPageCharts';
import { REF_LABEL_GUTTER, RING_LABEL_LINE, ringBox } from '../components/windows/workbench/healthCharts';
import type { ClusteringSeries, IndividualSeries, IndividualStats, RelationshipSeries } from '../types/health';
import { makeClusterStat, makeHealthPreview } from './helpers/healthPreviewFixture';

/** `markLine` entries of the first series: [{ y, label, dashed, color, width, at }]. */
const lines = (opt: any) =>
    (opt.series[0].markLine?.data ?? []).map((d: any) => ({
        y: d.yAxis, label: d.label?.formatter, dashed: d.lineStyle.type === 'dashed', color: d.lineStyle.color,
        width: d.lineStyle.width, at: d.label?.position,
    }));
/** Fill bands of the first series: [from, to, colour]. */
const fills = (opt: any) => (opt.series[0].markArea?.data ?? []).map((b: any) => [b[0].yAxis, b[1].yAxis, b[0].itemStyle.color]);

const indPreview = makeHealthPreview({ kind: 'individual' });
const indSeries = indPreview.series as IndividualSeries;
const indStats = indPreview.stats as IndividualStats; // 1SD 4..6, 3SD 2..8
const relPreview = makeHealthPreview({ kind: 'relationship' });
const relSeries = relPreview.series as RelationshipSeries;
const cluPreview = makeHealthPreview({ kind: 'clustering', n_clusters: 2 });
const cluSeries = cluPreview.series as ClusteringSeries;
const clusters = (cluPreview.stats as any).clusters;

describe('buildIndividualSetPointOption (raw value over time, no histogram)', () => {
    const ind = (sp: any) => buildIndividualSetPointOption(indSeries, indStats, sp, 'bar');

    it('draws the raw sensor values, ±1SD, ±3SD and NOTHING else when L / H are not entered', () => {
        const opt = ind({ kind: 'individual', lower: null, upper: null });
        expect(opt.series).toHaveLength(1);
        expect(lines(opt).map((l: any) => l.label)).toEqual(['+1SD', '−1SD', '+3SD', '−3SD']);
    });

    it('adds the L and H set-point lines (solid, red) as soon as they are typed - and only the typed one', () => {
        const onlyH = lines(ind({ kind: 'individual', lower: null, upper: 12 }));
        expect(onlyH.at(-1)).toMatchObject({ y: 12, label: 'H 12', dashed: false, color: CHART.danger });
        expect(onlyH.some((l: any) => /^L /.test(l.label))).toBe(false);
        const both = lines(ind({ kind: 'individual', lower: 1, upper: 12 }));
        expect(both.filter((l: any) => /^[LH] /.test(l.label)).map((l: any) => [l.label, l.y])).toEqual([['H 12', 12], ['L 1', 1]]);
    });

    // workbench-redesign SPEC §3: "The user's set points are the strongest lines and carry their
    // value as typed: H 4.6, L 2.2 … Never pad or round a typed value."
    it('L / H carry their value AS TYPED: never padded ("4.6", not "4.60") and never rounded ("4.61234" stays)', () => {
        // (`?.`: with set points far from the data an inner ±SD line has no label of its own — its neighbour carries it)
        const label = (sp: any, side: 'H' | 'L') => lines(ind({ kind: 'individual', ...sp })).find((l: any) => l.label?.startsWith(`${side} `)).label;
        // the user typed "4.6" / "4.60": the stored number is 4.6 and the chart must not pad it back out
        expect(label({ lower: 2.2, upper: 4.6 }, 'H')).toBe('H 4.6');
        expect(label({ lower: 2.2, upper: 4.6 }, 'L')).toBe('L 2.2');
        expect(label({ lower: 2.2, upper: Number('4.60') }, 'H')).toBe('H 4.6');
        // every typed decimal survives — the old 3-decimal read-out formatter would say "4.612"
        expect(label({ lower: 1, upper: 4.61234 }, 'H')).toBe('H 4.61234');
        expect(label({ lower: 0.0005, upper: 9 }, 'L')).toBe('L 0.0005');
        expect(label({ lower: 0.0000004, upper: 9 }, 'L')).toBe('L 0.0000004');
        // whole numbers stay whole ("85", not "85.00"); thousands are grouped; a negative keeps its sign
        expect(label({ lower: 40, upper: 85 }, 'H')).toBe('H 85');
        expect(label({ lower: -12.5, upper: 12500.25 }, 'H')).toBe('H 12,500.25');
        expect(label({ lower: -12.5, upper: 12500.25 }, 'L')).toBe('L −12.5');
        expect(typedText(4.6)).toBe('4.6');
        expect(typedText(100)).toBe('100');
    });

    // "L -200" (ASCII hyphen) sat next to "−1SD" and "0 · −9" (a real
    // minus sign); and a negative zero printed "-0".
    it('a negative set point carries a real minus sign (U+2212) like every other chart label; a negative zero reads "0"', () => {
        const label = (sp: any, side: 'H' | 'L') => lines(ind({ kind: 'individual', ...sp })).find((l: any) => l.label?.startsWith(`${side} `)).label;
        expect(label({ lower: -200, upper: 300 }, 'L')).toBe('L \u2212200');
        expect(label({ lower: -200, upper: -0.0005 }, 'H')).toBe('H \u22120.0005');
        expect(label({ lower: -12500.25, upper: 9 }, 'L')).toBe('L \u221212,500.25'); // the sign, then the grouped digits
        expect(typedText(-200)).toBe('\u2212200');
        expect(typedText(-200)).not.toContain('-'); // no ASCII hyphen-minus
        expect(typedText(-4.61234)).toBe('\u22124.61234'); // still every typed decimal
        expect(typedText(200)).toBe('200');
        // negative zero: what an input holding "-0" (or a 0 reached by stepping down) stores
        expect(typedText(-0)).toBe('0');
        expect(typedText(0)).toBe('0');
        expect(label({ lower: -0, upper: 9 }, 'L')).toBe('L 0');
        expect(signedTypedText(-0)).toBe('0');
        expect(signedTypedText(-200)).toBe('\u2212200'); // one sign, not two
        // the same sign as the reference labels beside it
        expect('−1SD'.charCodeAt(0)).toBe(0x2212);
        expect(typedText(-1).charCodeAt(0)).toBe(0x2212);
    });

    it('the set points are the STRONGEST lines: thicker than every reference line, labelled inside the plot (H above its line, L below)', () => {
        const all = lines(ind({ kind: 'individual', lower: 1, upper: 12 }));
        const refs = all.slice(0, 4);
        const [h, l] = all.slice(4);
        for (const r of refs) {
            expect(h.width).toBeGreaterThan(r.width);
            expect(r.at).toBe('end'); // ±1SD / ±3SD: outside the plot, on its right edge
        }
        expect(l.width).toBe(h.width);
        expect(h.at).toBe('insideEndTop');
        expect(l.at).toBe('insideEndBottom');
        expect((ind({ kind: 'individual', lower: 1, upper: 12 }) as any).grid.right).toBe(REF_LABEL_GUTTER);
    });

    it('only the score-100 band (±1SD) is filled; ±3SD is a dashed line, with or without set points', () => {
        for (const sp of [null, { kind: 'individual', lower: null, upper: null }, { kind: 'individual', lower: 1, upper: 12 }]) {
            const opt = ind(sp);
            expect(fills(opt)).toEqual([[4, 6, CHART.okFill]]);
            const sd = lines(opt).slice(0, 4);
            expect(sd.map((l: any) => [l.label, l.dashed])).toEqual([['+1SD', false], ['−1SD', false], ['+3SD', true], ['−3SD', true]]);
            // the amber ±3SD fill and the red L / H fill that are gone
            expect(JSON.stringify(opt)).not.toContain('rgba(229, 169, 61, 0.07)');
            expect(JSON.stringify(opt)).not.toContain('rgba(238, 90, 69, 0.12)');
        }
    });

    it('keeps a set point far outside the data on screen (the Y range includes every line)', () => {
        const opt = ind({ kind: 'individual', lower: -40, upper: 99 }) as any;
        expect(opt.yAxis.min).toBeLessThanOrEqual(-40);
        expect(opt.yAxis.max).toBeGreaterThanOrEqual(99);
    });

    it('is connected for the shared hover cursor, which keeps its own layer and no hover emphasis', () => {
        expect((ind(null) as any).axisPointer.link).toEqual([{ xAxisIndex: 'all' }]);
        // The link must not replace the hover settings of the time chart it is spread over:
        // without them every mousemove re-strokes the lines of BOTH connected charts.
        expect((ind(null) as any).axisPointer).toEqual({ zlevel: 1, triggerEmphasis: false, link: [{ xAxisIndex: 'all' }] });
        expect(HEALTH_SYNC_GROUP).toBeTruthy();
    });
});

describe('buildRelationshipSetPointOption (residual over time ONLY)', () => {
    const rel = (sp: any) => buildRelationshipSetPointOption(relSeries, 0.9, sp, 'bar');
    const empty = { kind: 'relationship', residualAt80Lower: null, residualAt80Upper: null, residualAt0Lower: null, residualAt0Upper: null };

    it('plots the residual (not the raw values) with ±2RMSE and a zero line; no 80 / 0 lines until entered', () => {
        const opt = rel(empty) as any;
        expect(opt.series).toHaveLength(1);
        expect(opt.series[0].data.map((d: any) => d[1])).toEqual(relSeries.residual);
        expect(lines(opt).map((l: any) => l.y)).toEqual([0.9, -0.9, 0]);
    });

    it('draws all four set-point lines (lower and upper, 80 warn / 0 danger) once entered, each only when it is a number', () => {
        const l = lines(rel({ ...empty, residualAt80Lower: -1.5, residualAt80Upper: 1.5, residualAt0Lower: -3, residualAt0Upper: 3 }));
        expect(l.slice(3).map((x: any) => [x.y, x.label, x.dashed, x.color])).toEqual([
            [1.5, '80 · +1.5', false, CHART.warn],
            [-1.5, '80 · −1.5', false, CHART.warn],
            [3, '0 · +3', false, CHART.danger],
            [-3, '0 · −3', false, CHART.danger],
        ]);
        const some = lines(rel({ ...empty, residualAt80Upper: 1.5 }));
        expect(some).toHaveLength(4);
        expect(some[3]).toMatchObject({ y: 1.5, label: '80 · +1.5' });
    });

    it('each point carries its score and its value AS TYPED, signed: "80 · +5", never "80 · +5.00" or a rounded value', () => {
        const label = (key: string, v: number) => lines(rel({ ...empty, [key]: v })).at(-1).label;
        expect(label('residualAt80Upper', 5)).toBe('80 · +5');
        expect(label('residualAt80Upper', Number('5.00'))).toBe('80 · +5');
        expect(label('residualAt80Lower', -2.5)).toBe('80 · −2.5');
        expect(label('residualAt0Upper', 12.25)).toBe('0 · +12.25');
        expect(label('residualAt0Lower', -9.61234)).toBe('0 · −9.61234'); // every typed decimal
        expect(label('residualAt0Upper', 1250.5)).toBe('0 · +1,250.5');
        expect(label('residualAt80Upper', 0)).toBe('80 · 0'); // zero has no sign
        expect(signedTypedText(0.0005)).toBe('+0.0005');
        expect(signedTypedText(-0.0005)).toBe('−0.0005'); // a real minus sign, like the −2RMSE label
    });

    it('the four points are the strongest lines (labelled inside: upper side above its line, lower side below); ±2RMSE is thin and named outside', () => {
        const l = lines(rel({ ...empty, residualAt80Lower: -1.5, residualAt80Upper: 1.5, residualAt0Lower: -3, residualAt0Upper: 3 }));
        const [up2, lo2, zero, u80, l80, u0, l0] = l;
        expect([up2.label, up2.at, lo2.label, lo2.at]).toEqual(['+2RMSE', 'end', '−2RMSE', 'end']);
        expect(zero.label).toBeUndefined();
        for (const p of [u80, l80, u0, l0]) expect(p.width).toBeGreaterThan(up2.width);
        expect([u80.at, l80.at, u0.at, l0.at]).toEqual(['insideEndTop', 'insideEndBottom', 'insideEndTop', 'insideEndBottom']);
    });

    it('only the score-100 band (±2RMSE) is filled, whatever points are entered', () => {
        for (const sp of [empty, { ...empty, residualAt80Lower: -1.5, residualAt80Upper: 1.5, residualAt0Lower: -3, residualAt0Upper: 3 }]) {
            expect(fills(rel(sp))).toEqual([[-0.9, 0.9, CHART.okFill]]);
        }
    });

    it('draws a value typed on the "wrong" side where it was typed (Rust is the one that rejects it)', () => {
        expect(lines(rel({ ...empty, residualAt80Lower: 1.5 })).at(-1)).toMatchObject({ y: 1.5, label: '80 · +1.5', at: 'insideEndBottom' });
    });
});

describe('buildClusterSetPointOption (points + 1x, 3x and N x rings of EVERY cluster)', () => {
    const cl = (sp: any, hover: number | null = null) => buildClusterSetPointOption(cluSeries, clusters, sp, { x: 'X', y: 'Y' }, hover) as any;
    const ringNames = (opt: any) => opt.series.filter((s: any) => s.type === 'custom').map((s: any) => s.name);

    it('its nice-extent axis bounds never print float noise: both value axes format their labels (2026-10-09)', () => {
        const opt = cl({ kind: 'clustering', outerSd: null });
        expect(opt.xAxis.axisLabel.formatter(0.1 * 3)).toBe('0.3');
        expect(opt.yAxis.axisLabel.formatter(1713.8000000000002)).toBe('1,713.8');
    });

    it('without N: two rings (1x, 3x) per cluster', () => {
        expect(ringNames(cl({ kind: 'clustering', outerSd: null }))).toEqual([
            'Cluster 1 1× SD', 'Cluster 1 3× SD', 'Cluster 2 1× SD', 'Cluster 2 3× SD',
        ]);
    });

    it('with N: a third ring per cluster, the SAME number for every cluster', () => {
        const names = ringNames(cl({ kind: 'clustering', outerSd: 5 }));
        expect(names).toEqual([
            'Cluster 1 1× SD', 'Cluster 1 3× SD', 'Cluster 1 5× SD',
            'Cluster 2 1× SD', 'Cluster 2 3× SD', 'Cluster 2 5× SD',
        ]);
    });

    // ---- workbench-redesign SPEC §3 "Clustering" ----

    it('the user\'s N ring is SOLID red (the strongest ring); 1× stays solid green, 3× dashed amber', () => {
        const opt = cl({ kind: 'clustering', outerSd: 5 });
        const api = { coord: (pt: number[]) => pt };
        const params = { coordSys: { x: 0, y: 0, width: 100, height: 100 } };
        const style = (name: string) => opt.series.find((s: any) => s.name === name).renderItem(params, api).style;
        for (const id of [1, 2]) {
            const n = style(`Cluster ${id} 5× SD`);
            expect(n.stroke).toBe(CHART.danger);
            expect(n.lineDash).toEqual([0, 0]); // solid
            expect(n.fill).toBe('none'); // a ring is a line, never a filled band
            const one = style(`Cluster ${id} 1× SD`);
            const three = style(`Cluster ${id} 3× SD`);
            expect([one.stroke, one.lineDash]).toEqual([CHART.ok, [0, 0]]);
            expect([three.stroke, three.lineDash]).toEqual([CHART.warn, [6, 4]]);
            expect(n.lineWidth).toBeGreaterThan(one.lineWidth);
            expect(n.lineWidth).toBeGreaterThan(three.lineWidth);
        }
    });

    it('rings are labelled ONCE per level — "1× · 100", "3× · 80", "N× · 0" — at the edge of the ring that reaches furthest right', () => {
        const labelsOf = (opt: any) => opt.series.filter((s: any) => s.name === 'Ring labels');
        const noN = labelsOf(cl({ kind: 'clustering', outerSd: null }));
        expect(noN).toHaveLength(1);
        expect(noN[0].data.map((d: any) => d.label.formatter)).toEqual(['1× · 100', '3× · 80']); // no N yet: no third label
        const withN = labelsOf(cl({ kind: 'clustering', outerSd: 5 }));
        expect(withN).toHaveLength(1);
        const data = withN[0].data;
        // 2 clusters × 3 rings = 6 rings, but 3 labels: one per level
        expect(data.map((d: any) => d.label.formatter)).toEqual(['1× · 100', '3× · 80', '5× · 0']);
        expect(data.map((d: any) => d.label.color)).toEqual([CHART.ok, CHART.warn, CHART.danger]);
        // cluster 2 (centre 20 / 40, x_sd 2, no rotation) reaches furthest right at every level
        expect(data.map((d: any) => d.value)).toEqual([[22, 40], [26, 40], [30, 40]]);
        expect(withN[0].label.position).toBe('right');
        // a label series is text only: it adds no hoverable point and is not the "Points" series the hover reads
        expect(withN[0].silent).toBe(true);
        expect(cl({ kind: 'clustering', outerSd: 5 }).series[0].name).toBe('Points');
    });

    it('the N label prints N as typed: "4.5× · 0", "4.25× · 0" — never "4.50×" and never rounded', () => {
        const nLabel = (n: number) => cl({ kind: 'clustering', outerSd: n }).series.find((s: any) => s.name === 'Ring labels').data.at(-1).label.formatter;
        expect(nLabel(4)).toBe('4× · 0');
        expect(nLabel(4.5)).toBe('4.5× · 0');
        expect(nLabel(4.25)).toBe('4.25× · 0');
        expect(nLabel(3.61234)).toBe('3.61234× · 0');
    });

    // On this chart with all three levels.
    it('the three level names move APART for a cluster tilted up to the right: "N× · 0" up, "1× · 100" down (never into each other)', () => {
        const tilted = [1, 2, 3].map(i => makeClusterStat(i, { x_center: 10 * i, y_center: 20 + i, x_sd: 4, y_sd: 0.3, angle_deg: 2 }));
        const opt = buildClusterSetPointOption(cluSeries, tilted, { kind: 'clustering', outerSd: 5 }, { x: 'X', y: 'Y' }) as any;
        const data = opt.series.find((s: any) => s.name === 'Ring labels').data;
        expect(data.map((d: any) => d.label.formatter)).toEqual(['1× · 100', '3× · 80', '5× · 0']);
        // the ring edges rise with the level …
        expect(data[0].value[1]).toBeLessThan(data[1].value[1]);
        expect(data[1].value[1]).toBeLessThan(data[2].value[1]);
        // … and the stagger pushes the same way: screen Y grows downwards
        expect(data.map((d: any) => d.label.offset)).toEqual([[0, RING_LABEL_LINE], [0, 0], [0, -RING_LABEL_LINE]]);
    });

    it('cluster colours stay out of green / amber / red, so a point coloured by its cluster is never read as a score', () => {
        const opt = cl({ kind: 'clustering', outerSd: null });
        const color = opt.series[0].itemStyle.color as (p: any) => string;
        const scoreColours = [100, 60, 10].map(s => scoreColor(s, 0.9));
        for (let id = 1; id <= CLUSTER_COLORS.length + 2; id++) {
            const c = color({ data: [1, 1, null, id] });
            expect(CLUSTER_COLORS as readonly string[]).toContain(c);
            expect([CHART.ok, CHART.warn, CHART.danger, ...scoreColours] as string[]).not.toContain(c);
        }
        // the centre names use the cluster's own colour
        const centres = opt.series.find((s: any) => s.name === 'Centres');
        expect(centres.data.map((d: any) => d.label.color)).toEqual([CLUSTER_COLORS[0], CLUSTER_COLORS[1]]);
        expect(centres.label.formatter({ dataIndex: 0 })).toBe('Cluster 1');
    });

    it('no stray x = 0 / y = 0 line across the points: both axis lines stay on the plot\'s edge', () => {
        const c = makeClusterStat(1, { x_center: 0, y_center: 0 });
        const series = { ...cluSeries, x: [-1, 1, 0, 0, 0], y: [-1, 1, 0, 0, 0] };
        const opt = buildClusterSetPointOption(series, [c], { kind: 'clustering', outerSd: 5 }, { x: 'X', y: 'Y' }) as any;
        expect(opt.xAxis.min).toBeLessThan(0);
        expect(opt.xAxis.max).toBeGreaterThan(0);
        expect(opt.xAxis.axisLine.onZero).toBe(false);
        expect(opt.yAxis.axisLine.onZero).toBe(false);
    });

    it('the axis titles are what the page passes (description + unit); the axes end on round ticks', () => {
        const opt = buildClusterSetPointOption(cluSeries, clusters, { kind: 'clustering', outerSd: 5 }, { x: 'GENERATOR ACTIVE POWER · MW', y: 'BEARING TEMP · °C' }) as any;
        expect(opt.xAxis.name).toBe('GENERATOR ACTIVE POWER · MW');
        expect(opt.yAxis.name).toBe('BEARING TEMP · °C');
        for (const v of [opt.xAxis.min, opt.xAxis.max, opt.yAxis.min, opt.yAxis.max]) expect(Number.isInteger(v)).toBe(true);
    });

    it('N is drawn wherever it is typed (also <= 3: Rust rejects it, the chart just shows it); an unparseable / non-positive N adds nothing', () => {
        expect(ringNames(cl({ kind: 'clustering', outerSd: 2 }))).toHaveLength(6);
        expect(ringNames(cl({ kind: 'clustering', outerSd: 0 }))).toHaveLength(4);
    });

    it('the axes always contain the outer rings, even when the data is much smaller', () => {
        const small = cl({ kind: 'clustering', outerSd: 4 });
        const big = cl({ kind: 'clustering', outerSd: 40 });
        expect(big.xAxis.max - big.xAxis.min).toBeGreaterThan(small.xAxis.max - small.xAxis.min);
        const box = ringBox(clusters[1], 40);
        expect(big.xAxis.max).toBeGreaterThanOrEqual(box.x[1]);
        expect(big.xAxis.min).toBeLessThanOrEqual(box.x[0]);
        expect(big.yAxis.max).toBeGreaterThanOrEqual(box.y[1]);
    });

    it('the axes include EVERY ring of EVERY cluster — 1×, 3× and N× — on all four sides', () => {
        for (const n of [null, 2, 4, 7.5, 40]) {
            const opt = cl({ kind: 'clustering', outerSd: n });
            for (const c of clusters) {
                for (const sigma of n === null ? [1, 3] : [1, 3, n]) {
                    const box = ringBox(c, sigma);
                    expect(opt.xAxis.min).toBeLessThanOrEqual(box.x[0]);
                    expect(opt.xAxis.max).toBeGreaterThanOrEqual(box.x[1]);
                    expect(opt.yAxis.min).toBeLessThanOrEqual(box.y[0]);
                    expect(opt.yAxis.max).toBeGreaterThanOrEqual(box.y[1]);
                }
            }
        }
        // a tilted cluster: the box of the ROTATED ring is what counts
        const tilted = makeClusterStat(1, { x_center: 0, y_center: 0, x_sd: 10, y_sd: 1, angle_deg: 60 });
        const opt = buildClusterSetPointOption({ ...cluSeries, x: [0, 0, 0, 0, 0], y: [0, 0, 0, 0, 0] }, [tilted], { kind: 'clustering', outerSd: 6 }, { x: 'X', y: 'Y' }) as any;
        const box = ringBox(tilted, 6);
        expect(box.y[1]).toBeGreaterThan(50); // the long axis points mostly up
        expect(opt.yAxis.max).toBeGreaterThanOrEqual(box.y[1]);
        expect(opt.yAxis.min).toBeLessThanOrEqual(box.y[0]);
        expect(opt.xAxis.max).toBeGreaterThanOrEqual(box.x[1]);
        // and the label of the furthest ring has room right of it
        expect(opt.xAxis.max - box.x[1]).toBeGreaterThanOrEqual((box.x[1] - box.x[0]) * 0.1);
    });

    it('points are one entry per series row [x, y, score, cluster] - so a hovered point is exactly one score row', () => {
        const opt = cl({ kind: 'clustering', outerSd: 5 });
        const pts = opt.series[0];
        expect(pts.name).toBe('Points');
        expect(pts.data).toHaveLength(cluSeries.x.length);
        expect(pts.data[0]).toEqual([cluSeries.x[0], cluSeries.y[0], null, 1]);
    });

    it('colours a point by its score once the set points are valid, by its cluster before', () => {
        const color = cl({ kind: 'clustering', outerSd: 5 }).series[0].itemStyle.color as (p: any) => string;
        expect(color({ data: [1, 1, 95, 1] })).toBe(scoreColor(95, 0.9));
        expect(color({ data: [1, 1, 20, 1] })).toBe(scoreColor(20, 0.9));
        expect(color({ data: [1, 1, null, 2] })).not.toBe(scoreColor(95, 0.9));
    });

    it('a hover index adds one highlight marker at that row; none otherwise', () => {
        expect(cl({ kind: 'clustering', outerSd: 5 }).series.some((s: any) => s.name === 'Hover')).toBe(false);
        const h = cl({ kind: 'clustering', outerSd: 5 }, 2).series.find((s: any) => s.name === 'Hover');
        expect(h.data).toEqual([[cluSeries.x[2], cluSeries.y[2]]]);
        expect(cl({ kind: 'clustering', outerSd: 5 }, 999).series.some((s: any) => s.name === 'Hover')).toBe(false);
    });

    it('ringBox: a rotated ellipse\'s bounding box', () => {
        const c = makeClusterStat(1, { x_center: 10, y_center: 20, x_sd: 2, y_sd: 1, angle_deg: 0 });
        expect(ringBox(c, 3)).toEqual({ x: [4, 16], y: [17, 23] });
        const turned = ringBox({ ...c, angle_deg: 90 }, 3);
        expect(turned.x[0]).toBeCloseTo(7);
        expect(turned.y[1]).toBeCloseTo(26);
        // one implementation, in healthCharts: this module has no ring maths (or re-export) of its own
        expect(Object.keys(healthPageCharts)).not.toContain('ringBox');
    });
});

describe('buildScoreOption (0-100 over time)', () => {
    const TS = ['2026-01-01 00:00:00', '2026-01-01 01:00:00', '2026-01-01 02:00:00', '2026-01-01 03:00:00'];
    const opt = buildScoreOption(TS, [100, 85, null, 20]) as any;

    it('is fixed to 0..100 with a dashed line at 80, named "80" at the right edge outside the plot', () => {
        expect(opt.yAxis.min).toBe(0);
        expect(opt.yAxis.max).toBe(100);
        expect(lines(opt)).toEqual([expect.objectContaining({ y: 80, dashed: true, label: '80', at: 'end' })]);
        expect(opt.grid.right).toBe(REF_LABEL_GUTTER);
    });

    it('the hover tooltip prints the score as a whole number too ("85", never "85.00")', () => {
        const f = opt.tooltip.valueFormatter;
        expect(f(85)).toBe('85');
        expect(f(84.6)).toBe('85');
        expect(f(100)).toBe('100');
        expect(f(0)).toBe('0');
        expect(f(null)).toBe(''); // a gap
        expect(opt.tooltip.trigger).toBe('axis'); // still the shared-cursor tooltip
        // the SET-POINT chart's tooltip is a sensor value: it keeps its decimals (the app's fmtNum)
        const sp = buildIndividualSetPointOption(indSeries, indStats, null, 'bar') as any;
        expect(sp.tooltip.valueFormatter(84.6)).toBe('84.6');
        expect(sp.tooltip.valueFormatter(0.0002)).toBe('0.0002'); // a non-zero value never reads as 0
        expect(f(84.6)).toBe('85'); // the score, for comparison
    });

    it('the score axis prints whole numbers (0, 20 … 100), never "0.000" / "20.00"; the look of the labels is kept', () => {
        const f = opt.yAxis.axisLabel.formatter;
        expect(f).toBe(fmtScoreAxisValue);
        expect(opt.yAxis.interval).toBe(20);
        expect(f(20.4)).toBe('20'); // never a decimal, even off a tick
        expect([0, 20, 40, 60, 80, 100].map(f)).toEqual(['0', '20', '40', '60', '80', '100']);
        expect(f(20.000000000000004)).toBe('20'); // float noise on a tick
        expect(f(-0)).toBe('0');
        expect(f(NaN)).toBe('');
        expect(opt.yAxis.axisLabel.color).toBe(CHART.textSecondary);
        expect(opt.yAxis.axisLabel.fontSize).toBe(10);
    });

    it('only the SCORE axis is whole-number: a set-point (sensor value) axis keeps its decimals', () => {
        const sp = buildIndividualSetPointOption(indSeries, indStats, null, 'bar') as any; // 3SD band 2..8
        expect(sp.yAxis.axisLabel.formatter(4.5)).toBe('4.5');
        const rel = buildRelationshipSetPointOption(relSeries, 0.9, null, 'bar') as any;
        expect(rel.yAxis.axisLabel.formatter).not.toBe(opt.yAxis.axisLabel.formatter);
    });

    it('a row without a score is a GAP (null), never 0', () => {
        const values = opt.series[0].data.map((d: any) => d[1]);
        expect(values).toEqual([100, 85, null, 20]);
    });

    it('colours the line by score band: 80-100 green, 40-80 amber, below 40 red', () => {
        const pieces = opt.visualMap.pieces;
        expect(pieces.map((p: any) => [p.gte ?? null, p.lt ?? null])).toEqual([[80, null], [40, 80], [null, 40]]);
        expect(new Set(pieces.map((p: any) => p.color)).size).toBe(3);
        expect(opt.visualMap.show).toBe(false);
    });

    it('is connected to the set-point chart for the shared hover cursor, on its own layer with no hover emphasis', () => {
        expect(opt.axisPointer).toEqual({ zlevel: 1, triggerEmphasis: false, link: [{ xAxisIndex: 'all' }] });
    });
});

describe('scoreColor', () => {
    it('green from 80, amber 40-80, red below 40, neutral for no score', () => {
        expect(scoreColor(100)).toContain('16, 185, 129');
        expect(scoreColor(80)).toContain('16, 185, 129');
        expect(scoreColor(79.9)).toContain('229, 169, 61');
        expect(scoreColor(40)).toContain('229, 169, 61');
        expect(scoreColor(39)).toContain('238, 90, 69');
        expect(scoreColor(null)).toContain('180, 190, 210');
        expect(scoreColor(NaN)).toContain('180, 190, 210');
    });
});

// The ONE chart card of the Health score page ("Workbench detail pages v2"): a time chart
// with the score chart right under it, on one time axis.
describe('asStackUpper / asStackLower — the two halves of the stacked card', () => {
    const { asStackUpper, asStackLower, buildIndividualSetPointOption, buildRelationshipSetPointOption, buildScoreOption, STACK_INNER_GAP } = healthPageCharts;
    const p = makeHealthPreview({ kind: 'individual' });
    const hourly = p.hourly as IndividualSeries;
    const scopes = { ranges: [
        { kind: 'train' as const, start: '2026-01-01T00:00', end: '2026-01-01T01:30', label: 'TRAIN P1', short: 'P1' },
        { kind: 'train' as const, start: '2026-01-01T03:00', end: '2026-01-01T04:00', label: 'TRAIN P2', short: 'P2' },
    ] };
    const upperOf = (s: typeof scopes | null = scopes) => buildIndividualSetPointOption(hourly, p.stats as IndividualStats, { kind: 'individual', lower: 1, upper: 9 }, 'bar', s);
    const lowerOf = (s: typeof scopes | null = scopes) => buildScoreOption(hourly.timestamps, [100, 90, 80, 60, 30], s);
    const strip = (o: { series: Record<string, unknown>[] }) => (o.series.find(x => x.name === '__scopes') as any)?.markArea.data as any[][] | undefined;

    it('upper: the X labels and ticks are left out and the plot runs down to the divider — the axis itself is untouched', () => {
        const base = upperOf();
        const up = asStackUpper(base);
        expect(up.xAxis.axisLabel).toMatchObject({ show: false });
        expect((up.xAxis as any).axisTick).toEqual({ show: false });
        expect(up.grid).toEqual({ ...base.grid, bottom: STACK_INNER_GAP });
        expect(STACK_INNER_GAP).toBe(8);
        // the same axis: type, the tooltip heading, every other label setting
        expect(up.xAxis.type).toBe('time');
        expect((up.xAxis as any).axisPointer).toBe((base.xAxis as any).axisPointer);
        const { show: _s, ...restLabel } = up.xAxis.axisLabel as Record<string, unknown>;
        const { show: _b, ...baseLabel } = (base.xAxis as any).axisLabel as Record<string, unknown>;
        expect(restLabel).toEqual(baseLabel);
        // nothing else changes: series (the strip with its NAMES), Y axis, zoom, tooltip, the cursor link
        expect(up.series).toBe(base.series);
        expect(strip(up)!.map(a => a[0].label.show)).toEqual([true, true]);
        expect(up.yAxis).toBe(base.yAxis);
        expect(up.dataZoom).toBe(base.dataZoom);
        expect(up.tooltip).toBe(base.tooltip);
        expect(up.axisPointer).toBe(base.axisPointer);
        // the input is not mutated
        expect((base.xAxis as any).axisLabel.show).not.toBe(false);
        expect(base.grid.bottom).toBe(28);
    });

    it('lower: the period names are hidden (the upper chart prints them once), the bands stay, the plot starts under the divider', () => {
        const base = lowerOf();
        const low = asStackLower(base);
        expect(low.grid).toEqual({ ...base.grid, top: STACK_INNER_GAP });
        expect(base.grid.top).toBeGreaterThan(STACK_INNER_GAP); // it had room for the strip
        expect(strip(low)!.map(a => a[0].label.show)).toEqual([false, false]);
        // the bands themselves: same places, same fill, same names (for the tests and the tooltip)
        expect(strip(low)!.map(a => [a[0].name, a[0].xAxis, a[1].xAxis, a[0].itemStyle])).toEqual(strip(base)!.map(a => [a[0].name, a[0].xAxis, a[1].xAxis, a[0].itemStyle]));
        // the score series is untouched; so are the axes (it keeps its own X labels), zoom and the score colours
        expect(low.series[0]).toBe(base.series[0]);
        expect(low.xAxis).toBe(base.xAxis);
        expect(low.yAxis).toBe(base.yAxis);
        expect(low.visualMap).toBe(base.visualMap);
        expect(low.dataZoom).toBe(base.dataZoom);
        // the input is not mutated
        expect(strip(base)!.map(a => a[0].label.show)).toEqual([true, true]);
    });

    it('without scopes there is no strip to hide: only the margin changes', () => {
        const base = lowerOf(null);
        const low = asStackLower(base);
        expect(strip(low)).toBeUndefined();
        expect(low.series).toEqual(base.series);
        expect(low.grid.top).toBe(STACK_INNER_GAP);
    });

    it('the pair lines up: the same left / right plot margins and the same time values, for Individual and the Relation model', () => {
        const rel = makeHealthPreview({ kind: 'relationship' });
        const relUpper = buildRelationshipSetPointOption(rel.hourly as RelationshipSeries, 0.9134, { kind: 'relationship', residualAt80Lower: -1.5, residualAt80Upper: 1.5, residualAt0Lower: -3, residualAt0Upper: 3 }, 'bar', scopes);
        const low = asStackLower(lowerOf());
        for (const up of [asStackUpper(upperOf()), asStackUpper(relUpper)]) {
            expect([up.grid.left, up.grid.right]).toEqual([low.grid.left, low.grid.right]);
            expect(up.grid.right).toBe(REF_LABEL_GUTTER);
            const xs = (o: { series: Record<string, unknown>[] }) => (o.series[0].data as [number, number | null][]).map(d => d[0]);
            expect(xs(up)).toEqual(xs(low));
        }
    });
});

// User decision 2026-10-16: the set-point charts follow the zoom window on Y without losing a
// set point. The spec must survive every copy these builders make (`keepFollowY`).
describe('the Health score set-point charts keep the follow-Y spec', () => {
    it('Individual: the set points L / H are reference lines of the spec; the stacked upper chart keeps it', async () => {
        const { getFollowY } = await import('../components/charts/followYAxis');
        const opt = buildIndividualSetPointOption(indSeries, indStats, { kind: 'individual', lower: -30, upper: 39 } as any, 'bar');
        const s = getFollowY(opt)!;
        expect([s.refLo, s.refHi]).toEqual([-30, 39]);
        expect(getFollowY(healthPageCharts.asStackUpper(opt as any))).toBe(s);
    });

    it('Relation model: the ±2RMSE band and the typed 80 / 0 points are in it', async () => {
        const { getFollowY } = await import('../components/charts/followYAxis');
        const opt = buildRelationshipSetPointOption(relSeries, 2, { kind: 'relationship', residualAt80Upper: 5, residualAt0Upper: 9, residualAt80Lower: -5, residualAt0Lower: -12 } as any, 'bar');
        const s = getFollowY(opt)!;
        expect([s.refLo, s.refHi]).toEqual([-12, 9]);
    });
});
