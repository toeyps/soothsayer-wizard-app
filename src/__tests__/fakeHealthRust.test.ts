// @vitest-environment node
/**
 * The TypeScript mirror of Rust's set-point validation messages
 * (`helpers/fakeHealthRust.ts`) must print numbers the way Rust does, or every
 * integration test built on it pins text the real app never shows.
 *
 * Rust (`health_score.rs`, commit a3c854d): a set point the USER typed is echoed
 * exactly (`fmt_typed`: the shortest text that reads back as the same number —
 * "-2", never "-2.000"; "4.61234", never "4.612"; "-0" as "0"); only values Rust
 * COMPUTED (SD, 2RMSE, band edges) keep the INFO-file rounding (`fmt_num`).
 * The vectors below are the ones of Rust's own
 * `fmt_typed_is_the_shortest_exact_text` test.
 */
import { describe, it, expect } from 'vitest';
import { createFakeHealthRust, fmtTyped, STALE_SESSION_ERROR, validateClustering, validateIndividual, validateRelationship, type HealthDataset } from './helpers/fakeHealthRust';

const BAND = { mean: 5, sd: 1, l1: 4, u1: 6, l3: 2.00049, u3: 8.00051 };
const msg = (issues: { code: string; message: string }[], code: string) => issues.find(i => i.code === code)?.message;

describe('fakeHealthRust — fmtTyped mirrors Rust\'s fmt_typed', () => {
    it.each([
        [-2, '-2'],
        [4.6, '4.6'],
        [0.05, '0.05'],
        [4.61234, '4.61234'],
        [0.000123456, '0.000123456'],
        [1234.56789, '1234.56789'],
        [150, '150'],
        [0, '0'],
        [-0, '0'],
        [1e-7, '0.0000001'],
        [2.5e6, '2500000'],
    ])('%s -> "%s", and it reads back as the same number', (x, text) => {
        expect(fmtTyped(x)).toBe(text);
        expect(Number(fmtTyped(x))).toBe(x + 0);
    });

    it('never an exponent (Rust\'s `{}` has none), for very small and very large values alike', () => {
        expect(fmtTyped(1.5e-9)).toBe('0.0000000015');
        expect(fmtTyped(-4e-7)).toBe('-0.0000004');
        expect(fmtTyped(2.5e21)).toBe('2500000000000000000000');
        expect(fmtTyped(-1.2345e22)).toBe('-12345000000000000000000');
        for (const x of [1.5e-9, -4e-7, 2.5e21, -1.2345e22, 123456789.125]) {
            expect(fmtTyped(x)).not.toMatch(/e/i);
            expect(Number(fmtTyped(x))).toBe(x);
        }
    });
});

describe('fakeHealthRust — messages echo a typed set point exactly; computed values stay rounded', () => {
    it('Individual: L / H as typed, the 3σ boundary rounded', () => {
        const ordering = msg(validateIndividual(BAND, { lower: 9.25, upper: -2 }), 'ordering');
        expect(ordering).toBe('The lower set point (L = 9.25) must be below the upper set point (H = -2).');
        const inside = validateIndividual(BAND, { lower: 4.61234, upper: 4.75 });
        // typed 4.61234 stays (it used to come back as "4.612"); the band edge keeps its rounding
        expect(msg(inside, 'lower_inside_3sd')).toBe('The lower set point (L = 4.61234) must be below the lower 3σ boundary (2).');
        expect(msg(inside, 'upper_inside_3sd')).toBe('The upper set point (H = 4.75) must be above the upper 3σ boundary (8.001).');
        expect(msg(validateIndividual(BAND, { lower: -0, upper: 9 }), 'lower_inside_3sd')).toBeUndefined(); // -0 is below 2
        const equal = validateIndividual({ ...BAND, l3: 2, u3: 8 }, { lower: 2, upper: 8 });
        expect(msg(equal, 'lower_equals_3sd')).toMatch(/^The lower set point \(L = 2\) equals the lower 3σ boundary.* Set L below 2\.$/);
        expect(msg(equal, 'upper_equals_3sd')).toMatch(/^The upper set point \(H = 8\) equals the upper 3σ boundary.* Set H above 8\.$/);
    });

    it('Relation model: the user reported "-2.000" — a typed residual point is "-2"; 2RMSE keeps its rounding', () => {
        const sign = validateRelationship(1.23456, { residual_at_80_lower: 2, residual_at_80_upper: -2, residual_at_0_lower: -0, residual_at_0_upper: 0.05 });
        expect(sign.filter(i => i.code === 'must_be_negative').map(i => i.message)).toEqual([
            'The lower 80-point must be negative (residual = actual − predicted); got 2.',
            'The lower 0-point must be negative (residual = actual − predicted); got 0.',
        ]);
        expect(msg(sign, 'must_be_positive')).toBe('The upper 80-point must be positive (residual = actual − predicted); got -2.');
        const band = validateRelationship(1.23456, { residual_at_80_lower: -0.5, residual_at_80_upper: 1.23456, residual_at_0_lower: -3, residual_at_0_upper: 3 });
        expect(msg(band, 'point80_inside_band')).toBe('The lower 80-point (-0.5) must be further from zero than the ±2RMSE band edge (1.235).');
        expect(msg(band, 'point80_equals_band')).toBe('The upper 80-point (1.23456) sits exactly on the ±2RMSE band edge (1.235), so the 100 and the 80 point would coincide. Move it further from zero.');
        const order = validateRelationship(1, { residual_at_80_lower: -2, residual_at_80_upper: 4.61234, residual_at_0_lower: -2, residual_at_0_upper: 4.5 });
        expect(msg(order, 'point0_equals_point80')).toBe('The lower 0-point (-2) equals the lower 80-point, so the score would drop from 80 to 0 instantly. Move the 0-point further from zero.');
        expect(msg(order, 'point0_inside_point80')).toBe('The upper 0-point (4.5) must be further from zero than the upper 80-point (4.61234).');
        for (const i of [...sign, ...band, ...order]) expect(i.message).not.toMatch(/\d\.\d*0\b|-2\.0/); // nothing padded
    });

    it('Clustering: N as typed', () => {
        const c = [{ cluster_id: 1, x_center: 0, y_center: 0, x_sd: 1, y_sd: 1, angle_deg: 0 }];
        expect(msg(validateClustering(c, { outer_sd: 2.5 }), 'outer_sd_not_above_3')).toBe('The outer ring (2.5× SD) must be more than 3× SD (the 80 point).');
        expect(msg(validateClustering(c, { outer_sd: 2 }), 'outer_sd_not_above_3')).toBe('The outer ring (2× SD) must be more than 3× SD (the 80 point).');
        expect(msg(validateClustering(c, { outer_sd: 2.99999 }), 'outer_sd_not_above_3')).toBe('The outer ring (2.99999× SD) must be more than 3× SD (the 80 point).');
    });
});

/*
 * `count_period_rows` — the Running-condition modal's per-period counts. The
 * vectors are the ones of Rust's own tests in `src-tauri/src/period_counts.rs`
 * (4 days of 10-minute rows; RUN = 1 during 06:00-17:50, LOAD = the row number),
 * so a component test built on this fake sees the numbers the real app shows.
 */
describe('fakeHealthRust — count_period_rows mirrors period_counts.rs', () => {
    const ROWS_PER_DAY = 144;
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = (i: number) => {
        const day = Math.floor(i / ROWS_PER_DAY);
        const of = i % ROWS_PER_DAY;
        return `2024-01-${pad(day + 1)}T${pad(Math.floor(of / 6))}:${pad((of % 6) * 10)}:00`;
    };
    const dataset = (days = 4): HealthDataset => {
        const n = days * ROWS_PER_DAY;
        const hour = (i: number) => Math.floor((i % ROWS_PER_DAY) / 6);
        return {
            headers: ['timestamp', 'RUN', 'LOAD'],
            timestamps: Array.from({ length: n }, (_, i) => stamp(i)),
            columns: { RUN: Array.from({ length: n }, (_, i) => (hour(i) >= 6 && hour(i) < 18 ? 1 : 0)), LOAD: Array.from({ length: n }, (_, i) => i) },
        };
    };
    const RUNNING = { value_filters: [{ sensor: 'RUN', operation: 'greater_than', value1: 0.5, value2: null }], combine: 'and' };
    const per = (start: string | null, end: string | null) => ({ start, end });
    const fake = (d: HealthDataset = dataset()) => createFakeHealthRust({ datasets: { d } });
    const count = (rust: ReturnType<typeof fake>, periods: unknown[], filter: unknown = RUNNING, expected_generation: number | null = null) =>
        rust.invoke('count_period_rows', { periods, filter, expected_generation }) as Promise<any>;
    const nums = (c: any) => c.periods.map((p: any) => [p.rows_in_period, p.running_rows, p.running_days]);

    it('a period with and without a running condition (bounds inclusive)', async () => {
        const rust = fake();
        const day1 = [per('2024-01-01T00:00', '2024-01-01T23:50')];
        const all = await count(rust, day1, null);
        expect(nums(all)).toEqual([[144, 144, 1]]); // no condition: every row in the period is running
        expect([all.total_rows, all.interval_secs]).toEqual([576, 600]);
        const c = await count(rust, day1);
        expect(nums(c)).toEqual([[144, 72, 0.5]]);
        expect(c.periods[0]).toMatchObject({ index: 1, start: '2024-01-01T00:00', end: '2024-01-01T23:50', valid: true, invalid_reason: null });
        expect(c.union).toEqual({ rows_in_period: 144, running_rows: 72, running_days: 0.5 });
    });

    it('overlapping periods each count their rows; the union counts a row once', async () => {
        const c = await count(fake(), [
            per('2024-01-01T00:00', '2024-01-02T23:50'), // days 1-2
            per('2024-01-02T00:00', '2024-01-03T23:50'), // days 2-3 (day 2 shared)
            per('2024-01-02T06:00', '2024-01-02T11:50'), // inside both, all running
        ]);
        expect(nums(c)).toEqual([[288, 144, 1], [288, 144, 1], [36, 36, 0.3]]);
        expect(c.union).toEqual({ rows_in_period: 432, running_rows: 216, running_days: 1.5 }); // not 288 + 288 + 36
        expect(c.periods.map((p: any) => p.index)).toEqual([1, 2, 3]);
    });

    it('open bounds (null or blank) reach the end of the data', async () => {
        const c = await count(fake(), [per(null, '2024-01-02T23:50'), per('2024-01-04T00:00', '  '), per('', null)]);
        expect(nums(c)).toEqual([[288, 144, 1], [144, 72, 0.5], [576, 288, 2]]);
        expect(c.periods.every((p: any) => p.valid)).toBe(true);
        expect([c.periods[1].start, c.periods[1].end]).toEqual(['2024-01-04T00:00', null]); // blank is echoed as open
        expect(c.union.rows_in_period).toBe(576);
    });

    it('an invalid period counts zero with a flag, keeps its position and never fails the call', async () => {
        const c = await count(fake(), [
            per('2024-01-03T00:00', '2024-01-01T00:00'),
            per('2024-01-01T00:00', '2024-01-01T23:50'),
            per('not a date', '2024-01-01T23:50'),
            per('2024-01-01T00:00', '31/12/2024'),
            per('nope', 'nope either'), // both bad: the start is reported
        ]);
        expect(c.periods.map((p: any) => [p.valid, p.invalid_reason])).toEqual([
            [false, 'ends_before_start'], [true, null], [false, 'start_unparseable'], [false, 'end_unparseable'], [false, 'start_unparseable'],
        ]);
        expect(nums(c)).toEqual([[0, 0, 0], [144, 72, 0.5], [0, 0, 0], [0, 0, 0], [0, 0, 0]]);
        expect(c.periods[1].index).toBe(2);
        expect(c.union.rows_in_period).toBe(144); // invalid periods are not part of the union
        const one = await count(fake(), [per('2024-01-01T06:00', '2024-01-01T06:00')]); // start == end: one instant, valid
        expect(nums(one)).toEqual([[1, 1, 0]]);
    });

    it('AND needs every condition, OR needs one', async () => {
        const day1 = [per('2024-01-01T00:00', '2024-01-01T23:50')];
        const conds = [{ sensor: 'RUN', operation: 'greater_than', value1: 0.5, value2: null }, { sensor: 'LOAD', operation: 'less_than', value1: 60, value2: null }];
        expect(nums(await count(fake(), day1, { value_filters: conds, combine: 'and' }))).toEqual([[144, 24, 0.2]]);
        const or = await count(fake(), day1, { value_filters: conds, combine: 'or' });
        expect(nums(or)).toEqual([[144, 108, 0.8]]);
        expect(or.union.running_rows).toBe(108);
    });

    it('the filter own time fields are ignored (the training payload can be passed as is)', async () => {
        const rust = fake();
        const day3 = [per('2024-01-03T00:00', '2024-01-03T23:50')];
        const plain = await count(rust, day3);
        const train = { ...RUNNING, timestamp_ranges: [{ start: '2024-01-01T00:00', end: '2024-01-01T23:50' }, { start: 'junk', end: null }] };
        expect(await count(rust, day3, train)).toEqual(plain);
        expect(nums(plain)).toEqual([[144, 72, 0.5]]);
    });

    it('a condition on a sensor the dataset does not have is skipped: every row counts as running', async () => {
        const ghost = { value_filters: [{ sensor: 'GONE', operation: 'greater_than', value1: 0.5, value2: null }], combine: 'and' };
        expect(nums(await count(fake(dataset(1)), [per(null, null)], ghost))).toEqual([[144, 144, 1]]);
    });

    it('a missing sensor value is not running; no periods and a one-row dataset are zeroes, not errors', async () => {
        const d = dataset(1);
        d.columns.RUN = d.columns.RUN.map((_, i) => (i < 10 ? null : 1));
        expect(nums(await count(fake(d), [per(null, null)]))).toEqual([[144, 134, 0.9]]);
        const none = await count(fake(), []);
        expect([none.periods, none.total_rows, none.union.rows_in_period]).toEqual([[], 576, 0]);
        const single: HealthDataset = { headers: ['timestamp', 'RUN'], timestamps: [stamp(0)], columns: { RUN: [1] } };
        const c = await count(fake(single), [per(null, null)], null);
        expect(c.interval_secs).toBeNull(); // one dated row: rows cannot become days
        expect(nums(c)).toEqual([[1, 1, 0]]);
    });

    it('STALE_SESSION for another generation (checked before the request), BAD_REQUEST above 64 periods, and Tauri key casing', async () => {
        const rust = fake();
        const day = [per('2024-01-01T00:00', null)];
        await expect(count(rust, day, null, rust.generation())).resolves.toMatchObject({ total_rows: 576 });
        await expect(count(rust, day, null, rust.generation() + 1)).rejects.toBe(STALE_SESSION_ERROR);
        const many = (n: number) => Array.from({ length: n }, () => per('2024-01-01T00:00', '2024-01-01T23:50'));
        await expect(count(rust, many(65), null, rust.generation() + 1)).rejects.toBe(STALE_SESSION_ERROR);
        await expect(count(rust, many(65))).rejects.toMatch(/^BAD_REQUEST: too many periods \(65\); at most 64/);
        const cap = await count(rust, many(64));
        expect(cap.periods).toHaveLength(64);
        expect([cap.union.rows_in_period, cap.union.running_rows]).toEqual([144, 72]);
        // camelCase key = what a caller without snake_case would send: rejected like real Tauri would
        await expect(rust.invoke('count_period_rows', { periods: day, filter: null, expectedGeneration: 1 })).rejects.toMatch(/unexpected key 'expectedGeneration'/);
        await expect(rust.invoke('count_period_rows', { filter: null })).rejects.toMatch(/missing required key periods/);
    });
});
