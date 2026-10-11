// @vitest-environment node
/**
 * The canned `compute_health_preview` answers UI tests are built on
 * (`helpers/healthPreviewFixture.ts`, `helpers/validationFixture.ts`) must have
 * the shape Rust sends since the health score is computed on 1-hour averages:
 * the RAW rows in `series` never carry a score, the HOURLY points in `hourly`
 * do, and a scoring-period result mixes raw rows / running days with hours.
 * A fixture that still scored `series` would let a component that reads the
 * wrong series pass its tests.
 */
import { describe, it, expect } from 'vitest';
import { HOURLY_TS, makeHealthPreview, makeSetPointAwarePreview, SCORING_INTERVAL_SECS } from './helpers/healthPreviewFixture';
import { makeTestResult, makeValidation } from './helpers/validationFixture';
import type { HealthPreview, HealthPreviewRequest } from '../types/health';

const VALID: Record<string, HealthPreviewRequest> = {
    individual: { kind: 'individual', target: 'TAG1', set_points: { lower: 1, upper: 9 } },
    relationship: {
        kind: 'relationship', target: 'TAG1', predictors: ['TAG2'],
        set_points: { residual_at_80_lower: -2, residual_at_80_upper: 2, residual_at_0_lower: -4, residual_at_0_upper: 4 },
    },
    clustering: { kind: 'clustering', first_sensor: 'TAG1', second_sensor: 'TAG2', n_clusters: 2, set_points: { outer_sd: 5 } },
};
const KINDS = ['individual', 'relationship', 'clustering'] as const;
/** The value array a chart draws for the kind. */
const primary = (s: HealthPreview['series']): number[] => (s.kind === 'individual' ? s.value : s.kind === 'relationship' ? s.actual : s.x);

describe('healthPreviewFixture — the hourly contract', () => {
    it.each(KINDS)('%s: `hourly` has the same per-kind shape as `series`, hour-start timestamps, and the interval is 3600', kind => {
        const p = makeHealthPreview({ kind });
        expect(p.series.kind).toBe(kind);
        expect(p.hourly.kind).toBe(kind);
        expect(Object.keys(p.hourly).sort()).toEqual(Object.keys(p.series).sort());
        expect(p.hourly.timestamps).toEqual(HOURLY_TS);
        // Rust's hour label: the START of a clock hour, `YYYY-MM-DDTHH:00:00`.
        for (const t of p.hourly.timestamps) expect(t).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00$/);
        // the raw rows keep the CSV timestamp text
        for (const t of p.series.timestamps) expect(t).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
        expect(p.hourly.total_points).toBe(p.hourly.timestamps.length);
        expect(p.scoring_interval_secs).toBe(3600);
        expect(SCORING_INTERVAL_SECS).toBe(3600);
    });

    it.each(KINDS)('%s: before the set points are valid neither series has a score', kind => {
        const p = makeHealthPreview({ kind });
        expect(p.valid).toBe(false);
        expect(p.series.score).toBeNull();
        expect(p.hourly.score).toBeNull();
        expect(p.score_summary).toBeNull();
    });

    it.each(KINDS)('%s: valid set points score the HOURLY points only — `series.score` stays null', kind => {
        const p = makeSetPointAwarePreview(VALID[kind]);
        expect(p.valid).toBe(true);
        expect(p.series.score).toBeNull();
        expect(p.hourly.score).toEqual([100, 90, 80, 60, 30]);
        expect(p.hourly.score).toHaveLength(p.hourly.timestamps.length);
        // the summary counts hours and points at an hour start
        expect(p.score_summary).toMatchObject({
            scored: 5, unscored: 0, total_rows: 5, pct_below_80: 40,
            share_basis: 'hour_count',
            min_score: { score: 30, row: 4, timestamp: HOURLY_TS[4] },
        });
    });

    it.each(KINDS)('%s: invalid set points leave `hourly.score` null too', kind => {
        const p = makeSetPointAwarePreview({ ...VALID[kind], set_points: {} });
        expect(p.valid).toBe(false);
        expect(p.validation.every(i => i.code === 'required')).toBe(true);
        expect(p.hourly.score).toBeNull();
        expect(p.series.score).toBeNull();
        expect(p.score_summary).toBeNull();
    });

    it.each(KINDS)('%s: the hourly values are not the raw values, so a test can tell which series was drawn', kind => {
        const p = makeHealthPreview({ kind });
        expect(primary(p.hourly)).toHaveLength(5);
        expect(primary(p.hourly)).not.toEqual(primary(p.series));
    });

    it('Relation model: the hourly residual is the hour\'s actual − predicted; Clustering: an hour in no cluster stays null', () => {
        const rel = makeHealthPreview({ kind: 'relationship' }).hourly;
        if (rel.kind !== 'relationship') throw new Error('kind');
        rel.actual.forEach((a, i) => expect(rel.residual[i]).toBeCloseTo(a - (rel.predicted[i] as number), 9));
        const clu = makeHealthPreview({ kind: 'clustering' }).hourly;
        if (clu.kind !== 'clustering') throw new Error('kind');
        expect(clu.cluster).toEqual([1, 1, 2, 2, null]);
    });

    it('`over` still wins, for the new fields too', () => {
        const hourly = { ...makeHealthPreview({ kind: 'individual' }).hourly, total_points: 99 };
        expect(makeHealthPreview({ kind: 'individual' }, { hourly }).hourly.total_points).toBe(99);
        expect(makeSetPointAwarePreview(VALID.individual, { scoring_interval_secs: 900 }).scoring_interval_secs).toBe(900);
    });
});

describe('validationFixture — raw rows beside hours', () => {
    it('a scoring-period result carries both units, and the default numbers keep them apart', () => {
        const t = makeTestResult();
        // RAW rows / running time
        expect(t).toMatchObject({ rows: 3600, days: 12.5, train_rows: 0, train_days: 0 });
        // HOURS
        expect(t).toMatchObject({ hours: 300, train_hours: 0, scored: 300, pct_below_80: 1.2, lowest: 84 });
        expect(t.hours).not.toBe(t.rows);
        expect(t.scored).toBeLessThanOrEqual(t.hours);
        // `lowest_at` is the START of an hour, in Rust's hour-label form
        expect(t.lowest_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00$/);
    });

    it('the train block keeps raw rows / days and adds the training hours', () => {
        const v = makeValidation();
        expect(v.train).toMatchObject({ rows: 11578, days: 40.2, hours: 965 });
        expect(v.train.hours).not.toBe(v.train.rows);
        expect(v.tests).toHaveLength(1);
    });

    it('`over` overrides any field', () => {
        expect(makeTestResult({ hours: 7, train_hours: 2, scored: 5 })).toMatchObject({ hours: 7, train_hours: 2, scored: 5, rows: 3600 });
        expect(makeValidation({ tests: [] }).tests).toEqual([]);
    });
});
