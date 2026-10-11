// @vitest-environment node
/**
 * Health score on 1-hour averages — the frontend's fake Rust backend
 * (`helpers/fakeHealthRust.ts`) against the SAME fixture the real Rust code is
 * tested with.
 *
 * `src-tauri/tests/fixtures/hourly_score_parity.json` holds one dataset
 * (5-minute rows), one `compute_health_preview` request per kind and the answer
 * expected for it. Rust asserts that answer in
 * `src-tauri/tests/internal/train_test_validation_internal.rs`
 * (`hourly_parity_*`); this file asserts the very same numbers on the fake.
 * Every integration test of the Workbench runs on the fake, so a fake that
 * drifts from Rust would pin behaviour the real app does not have.
 *
 * What the fixture pins on both sides (the points the hourly change turned on):
 *   - one hourly point per clock hour that has a running row (a stopped hour has
 *     none), the mean of the hour's RUNNING rows only, labelled by the hour start;
 *   - a missing score is `null`, never 0;
 *   - Clustering: an hour whose rows are not all in one cluster has no cluster,
 *     no SD distance and no score — and a row with NO criteria value still
 *     enters the hour's mean x / y;
 *   - a scoring period in which no hour has a cluster carries NO
 *     `inside_3sd_ring_pct` key at all (omitted — not `null`, not 0);
 *   - `rows` / `days` stay raw, `hours` / `scored` / `pct_below_80` / `lowest`
 *     are hourly; the exported `validation` block is the same block plus
 *     `scoring_interval_seconds: 3600` and `scoring_aggregation: "mean"`.
 */
import { describe, it, expect } from 'vitest';
import fixture from '../../src-tauri/tests/fixtures/hourly_score_parity.json';
import { createFakeHealthRust, type HealthDataset } from './helpers/fakeHealthRust';

const dataset = fixture.dataset as unknown as HealthDataset;
const rust = () => createFakeHealthRust({ datasets: { five: dataset } });
const preview = (request: unknown) => rust().invoke('compute_health_preview', { request: request as Record<string, unknown> }) as Promise<any>;

/** Every key the fixture lists must be answered with exactly that value (other keys are free). */
function expectListed(actual: Record<string, unknown>, listed: Record<string, unknown>, what: string) {
    for (const [key, value] of Object.entries(listed)) expect(actual[key], `${what}.${key}`).toEqual(value);
}

describe('the fixture itself', () => {
    it('is 120 five-minute rows; stopped rows read 9999 on every sensor (so a leak into a mean cannot hide)', () => {
        expect(dataset.timestamps).toHaveLength(120);
        expect([dataset.timestamps[0], dataset.timestamps[1], dataset.timestamps[119]]).toEqual(['2024-03-01 00:00:00', '2024-03-01 00:05:00', '2024-03-01 09:55:00']);
        const stopped = dataset.columns.RUN.flatMap((r, i) => (r === 0 ? [i] : []));
        expect(stopped).toHaveLength(9 + 12 + 6); // hour 5 (9 rows), hour 6 (all), hour 7 (6 rows)
        for (const tag of ['V', 'X', 'Y', 'T', 'P']) for (const i of stopped) expect(dataset.columns[tag][i], `${tag}[${i}]`).toBe(9999);
        // the one row with no criteria value is a RUNNING row
        const missing = dataset.columns.MODE.flatMap((m, i) => (m === null ? [i] : []));
        expect(missing).toEqual([61]);
        expect(dataset.columns.RUN[61]).toBe(1);
    });
});

describe('Individual — the fake answers the fixture exactly like Rust', () => {
    const { request, expect: want } = fixture.cases.individual;

    it('hourly points, summary and scoring results', async () => {
        const p = await preview(request);
        expect(p.valid).toBe(true);
        expect(p.scoring_interval_secs).toBe(want.scoring_interval_secs);
        // raw rows: never scored, and only running rows of the train / scoring periods
        expect(p.series.score).toBeNull();
        expect(p.series.total_points).toBe(want.series_total_points);
        expectListed(p.hourly, want.hourly, 'hourly');
        expect(p.score_summary).toStrictEqual(want.score_summary);
        expect(p.test_validation).toStrictEqual(want.test_validation);
        // no stopped row reached a mean
        expect(Math.max(...p.hourly.value)).toBeLessThan(100);
    });

    it('the exported INFO file carries the same block, plus how the scores were sampled', async () => {
        const r = rust();
        const res = await r.invoke('export_model_files', { request: { ...request, workspace_id: 'ws' } }) as any;
        expect(res.ok).toBe(true);
        const { validated_at, ...block } = JSON.parse(r.files.get('workspaces/ws/output/V/INDV_INFO_V.json')!).validation;
        expect(typeof validated_at).toBe('string');
        expect(block).toStrictEqual({ tested: true, scoring_interval_seconds: 3600, scoring_aggregation: 'mean', ...want.test_validation });
    });
});

describe('Clustering — the fake answers the fixture exactly like Rust', () => {
    const { request, expect: want } = fixture.cases.clustering;

    it('an hour with rows in two clusters, with a row that has no criteria value, or in no range has no cluster and no score (null, never 0)', async () => {
        const p = await preview(request);
        expect(p.valid).toBe(true);
        expect(p.scoring_interval_secs).toBe(want.scoring_interval_secs);
        expect(p.series.score).toBeNull();
        expect(p.series.total_points).toBe(want.series_total_points);
        expectListed(p.hourly, want.hourly, 'hourly');
        expect(p.hourly.sd_distance.map((d: number | null) => d === null)).toEqual(want.sd_distance_is_null);
        expectListed(p.stats, want.stats, 'stats');
        expect(p.score_summary).toStrictEqual(want.score_summary);
    });

    it('the row with NO criteria value still enters its hour\'s mean x / y (hour 05:00: two rows at 30 / 60 and that row at 42 / 72)', async () => {
        const p = await preview(request);
        const at = p.hourly.timestamps.indexOf('2024-03-01T05:00:00');
        expect([p.hourly.x[at], p.hourly.y[at]]).toEqual([34, 64]); // without the row it would be 30 / 60
        expect([p.hourly.cluster[at], p.hourly.sd_distance[at], p.hourly.score[at]]).toEqual([null, null, null]);
    });

    it('a scoring period in which NO hour has a cluster: `inside_3sd_ring_pct` is omitted — not null, not 0; the next period has it', async () => {
        const p = await preview(request);
        expect(p.test_validation).toStrictEqual(want.test_validation);
        const [s1, s2] = p.test_validation.tests;
        expect(Object.keys(s1)).not.toContain('inside_3sd_ring_pct');
        expect(s1).toMatchObject({ hours: 2, scored: 0, pct_below_80: null, lowest: null, lowest_at: null });
        expect(s2.inside_3sd_ring_pct).toBe(50);
        // and a model kind never carries another kind's metric keys
        for (const t of [s1, s2]) for (const k of ['r2', 'rmse', 'residual_mean', 'residual_sd', 'mean', 'sd', 'within_3sd_pct', 'mean_shift_sd']) expect(Object.keys(t)).not.toContain(k);
    });

    it('the exported INFO file carries the same block (S1 still without the key), plus how the scores were sampled', async () => {
        const r = rust();
        const res = await r.invoke('export_model_files', { request: { ...request, workspace_id: 'ws' } }) as any;
        expect(res.ok).toBe(true);
        const { validated_at, ...block } = JSON.parse(r.files.get('workspaces/ws/output/Y/CLUS_INFO_X_Y.json')!).validation;
        expect(typeof validated_at).toBe('string');
        expect(block).toStrictEqual({ tested: true, scoring_interval_seconds: 3600, scoring_aggregation: 'mean', ...want.test_validation });
        expect(Object.keys(block.tests[0])).not.toContain('inside_3sd_ring_pct');
    });
});
