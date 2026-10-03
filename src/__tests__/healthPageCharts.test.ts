import { describe, it, expect } from 'vitest';
import {
    HEALTH_SYNC_GROUP,
    buildClusterSetPointOption,
    buildIndividualSetPointOption,
    buildRelationshipSetPointOption,
    buildScoreOption,
    ringBox,
    scoreColor,
} from '../components/windows/workbench/healthPageCharts';
import type { ClusteringSeries, IndividualSeries, IndividualStats, RelationshipSeries } from '../types/health';
import { makeClusterStat, makeHealthPreview } from './helpers/healthPreviewFixture';

/** `markLine` entries of the first series: [{ y, label, dashed, color }]. */
const lines = (opt: any) =>
    (opt.series[0].markLine?.data ?? []).map((d: any) => ({ y: d.yAxis, label: d.label?.formatter, dashed: d.lineStyle.type === 'dashed', color: d.lineStyle.color }));

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

    it('adds the L and H set-point lines (dashed, red) as soon as they are typed - and only the typed one', () => {
        const onlyH = lines(ind({ kind: 'individual', lower: null, upper: 12 }));
        expect(onlyH.at(-1)).toMatchObject({ y: 12, label: 'H', dashed: true });
        expect(onlyH.some((l: any) => l.label === 'L')).toBe(false);
        const both = lines(ind({ kind: 'individual', lower: 1, upper: 12 }));
        expect(both.filter((l: any) => l.label === 'L' || l.label === 'H').map((l: any) => l.y)).toEqual([12, 1]);
    });

    it('keeps a set point far outside the data on screen (the Y range includes every line)', () => {
        const opt = ind({ kind: 'individual', lower: -40, upper: 99 }) as any;
        expect(opt.yAxis.min).toBeLessThanOrEqual(-40);
        expect(opt.yAxis.max).toBeGreaterThanOrEqual(99);
    });

    it('is connected for the shared hover cursor', () => {
        expect((ind(null) as any).axisPointer.link).toEqual([{ xAxisIndex: 'all' }]);
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
        expect(l.slice(3).map((x: any) => [x.y, x.label, x.dashed])).toEqual([[1.5, '80', true], [-1.5, '80', true], [3, '0', true], [-3, '0', true]]);
        const some = lines(rel({ ...empty, residualAt80Upper: 1.5 }));
        expect(some).toHaveLength(4);
        expect(some[3]).toMatchObject({ y: 1.5, label: '80' });
    });

    it('draws a value typed on the "wrong" side where it was typed (Rust is the one that rejects it)', () => {
        expect(lines(rel({ ...empty, residualAt80Lower: 1.5 })).at(-1)).toMatchObject({ y: 1.5 });
    });
});

describe('buildClusterSetPointOption (points + 1x, 3x and N x rings of EVERY cluster)', () => {
    const cl = (sp: any, hover: number | null = null) => buildClusterSetPointOption(cluSeries, clusters, sp, { x: 'X', y: 'Y' }, hover) as any;
    const ringNames = (opt: any) => opt.series.filter((s: any) => s.type === 'custom').map((s: any) => s.name);

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
    });
});

describe('buildScoreOption (0-100 over time)', () => {
    const TS = ['2026-01-01 00:00:00', '2026-01-01 01:00:00', '2026-01-01 02:00:00', '2026-01-01 03:00:00'];
    const opt = buildScoreOption(TS, [100, 85, null, 20]) as any;

    it('is fixed to 0..100 with a dashed line at 80', () => {
        expect(opt.yAxis.min).toBe(0);
        expect(opt.yAxis.max).toBe(100);
        expect(lines(opt)).toEqual([expect.objectContaining({ y: 80, dashed: true })]);
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

    it('is connected to the set-point chart for the shared hover cursor', () => {
        expect(opt.axisPointer.link).toEqual([{ xAxisIndex: 'all' }]);
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
