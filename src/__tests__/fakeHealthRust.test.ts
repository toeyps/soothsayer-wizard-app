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
import {
    createFakeHealthRust, fileResidual, fmtTyped, groupHours, hourLabel, plantDataset, scoreClusterDistance, scoreIndividual, scoreRelationship,
    sdDistance, sharedPerHour, SCORING_AGGREGATION, SCORING_INTERVAL_SECS, STALE_SESSION_ERROR,
    validateClustering, validateIndividual, validateRelationship, type HealthDataset,
} from './helpers/fakeHealthRust';

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
            '80 low must be negative (residual = actual − predicted); got 2.',
            '0 low must be negative (residual = actual − predicted); got 0.',
        ]);
        expect(msg(sign, 'must_be_positive')).toBe('80 high must be positive (residual = actual − predicted); got -2.');
        const band = validateRelationship(1.23456, { residual_at_80_lower: -0.5, residual_at_80_upper: 1.23456, residual_at_0_lower: -3, residual_at_0_upper: 3 });
        expect(msg(band, 'point80_inside_band')).toBe('80 low (-0.5) must be further from zero than the ±2RMSE band edge (1.235).');
        expect(msg(band, 'point80_equals_band')).toBe('80 high (1.23456) sits exactly on the ±2RMSE band edge (1.235), so the 100 and the 80 point would coincide. Move it further from zero.');
        const order = validateRelationship(1, { residual_at_80_lower: -2, residual_at_80_upper: 4.61234, residual_at_0_lower: -2, residual_at_0_upper: 4.5 });
        expect(msg(order, 'point0_equals_point80')).toBe('0 low (-2) equals 80 low, so the score would drop from 80 to 0 instantly. Move 0 low further from zero.');
        expect(msg(order, 'point0_inside_point80')).toBe('0 high (4.5) must be further from zero than 80 high (4.61234).');
        for (const i of [...sign, ...band, ...order]) expect(i.message).not.toMatch(/\d\.\d*0\b|-2\.0/); // nothing padded
        // The sentences name a point the way the score ruler does (2026-10-14) — never "lower 80-point".
        const empty = validateRelationship(1, {});
        expect(empty.filter(i => i.code === 'required').map(i => i.message)).toEqual([
            'Enter 80 low (the residual where the score is 80 on the low side, negative).',
            'Enter 80 high (the residual where the score is 80 on the high side, positive).',
            'Enter 0 low (the residual where the score reaches 0 on the low side, negative).',
            'Enter 0 high (the residual where the score reaches 0 on the high side, positive).',
        ]);
        for (const i of [...sign, ...band, ...order, ...empty]) expect(i.message).not.toMatch(/-point|lower|upper/);
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

// ---------------------------------------------------------------------------
// Health score on 1-hour averages (health_hourly.rs / build_hourly)
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;
const MIN = 60_000;
/** 2024-03-01T00:00:00Z — hour 0 of every dataset below. */
const T0 = Date.UTC(2024, 2, 1, 0, 0, 0);
const H0 = T0 / HOUR;
/** CSV timestamp text of the row `i` five-minute steps after T0. */
const stamp5 = (i: number) => new Date(T0 + i * 5 * MIN).toISOString().slice(0, 19).replace('T', ' ');
const hourStart = (h: number) => hourLabel(H0 + h);

describe('fakeHealthRust — groupHours mirrors health_hourly.rs (the one hourly rule)', () => {
    const ts = (n: number, startMin: number, stepMin: number) => Array.from({ length: n }, (_, i) => T0 + (startMin + i * stepMin) * MIN);
    const all = (n: number) => Array.from({ length: n }, (_, i) => i);

    it('5-minute rows give one point per clock hour: the mean of its 12 rows, labelled with the hour start', () => {
        const g = groupHours(ts(36, 0, 5), all(36));
        expect(g.len).toBe(3);
        expect(g.counts).toEqual([12, 12, 12]);
        expect(g.firstRows).toEqual([0, 12, 24]);
        // mean of 0..11, 12..23, 24..35
        expect(g.mean(i => i)).toEqual([5.5, 17.5, 29.5]);
        expect([g.hourOf(11), g.hourOf(12)]).toEqual([0, 1]);
        expect([g.label(0), g.label(1), g.label(2)]).toEqual(['2024-03-01T00:00:00', '2024-03-01T01:00:00', '2024-03-01T02:00:00']);
    });

    it('the label is the START of the clock hour, whatever minute the rows sit on (10:25 and 10:59 share an hour, 11:00 starts the next)', () => {
        const base = Date.UTC(2024, 0, 1, 10, 25, 0);
        const g = groupHours([base, base + 34 * MIN, base + 35 * MIN], [0, 1, 2]);
        expect(g.len).toBe(2);
        expect([g.label(0), g.label(1)]).toEqual(['2024-01-01T10:00:00', '2024-01-01T11:00:00']);
        expect(hourLabel(Math.floor(base / HOUR))).toBe('2024-01-01T10:00:00');
        expect(SCORING_INTERVAL_SECS).toBe(3600);
        expect(SCORING_AGGREGATION).toBe('mean');
    });

    it('a partly-running hour averages only its running rows; an hour with no running row has NO point', () => {
        // hour 0: 3 of 12 rows running; hour 1: none; hour 2: all.
        const running = (i: number) => [2, 5, 7].includes(i) || i >= 24;
        const g = groupHours(ts(36, 0, 5), all(36), running);
        expect(g.len).toBe(2);
        expect(g.counts).toEqual([3, 12]);
        expect(g.firstRows).toEqual([2, 24]);
        // a stopped row's value (9999) is never averaged
        expect(g.mean(i => (running(i) ? 10 : 9999))).toEqual([10, 10]);
        expect([g.hourOf(0), g.hourOf(13)]).toEqual([null, null]);
        expect(g.label(1)).toBe(hourStart(2)); // the stopped hour 1 is simply absent
    });

    it('a universe that is a subset of the dataset uses the DATASET rows\' timestamps; a one-row hour is that row', () => {
        const g = groupHours(ts(36, 0, 5), [3, 4, 30]);
        expect(g.firstRows).toEqual([3, 30]);
        expect(g.counts).toEqual([2, 1]);
        expect(g.mean(i => [1, 3, 8][i])).toEqual([2, 8]);
    });

    it('row order does not matter: unsorted timestamps group by hour and come out in time order', () => {
        // file order: hour 2, hour 0, hour 1, hour 0, hour 2
        const t = [2 * HOUR + 5 * MIN, 50 * MIN, HOUR, 10 * MIN, 2 * HOUR + 59 * MIN].map(x => T0 + x);
        const v = [20, 1, 5, 3, 40];
        const g = groupHours(t, all(5));
        expect([g.label(0), g.label(1), g.label(2)]).toEqual([hourStart(0), hourStart(1), hourStart(2)]);
        expect(g.counts).toEqual([2, 1, 2]);
        expect(g.firstRows).toEqual([1, 2, 0]); // the LOWEST dataset row of the hour
        expect(g.mean(i => v[i])).toEqual([2, 5, 30]);
        // the same rows in time order give the very same points
        const order = all(5).sort((a, b) => t[a] - t[b]);
        const sorted = groupHours(order.map(i => t[i]), all(5));
        expect(sorted.mean(i => v[order[i]])).toEqual(g.mean(i => v[i]));
    });

    it('a row without a timestamp belongs to no hour; a missing input is skipped and an hour with none is NaN', () => {
        const t: (number | null)[] = ts(6, 0, 20);
        t[1] = null;
        t[4] = null;
        const g = groupHours(t, all(6));
        expect(g.counts).toEqual([2, 2]);
        expect([g.hourOf(1), g.hourOf(4)]).toEqual([null, null]);
        expect(g.mean(i => [1, 1000, 3, 5, 1000, 7][i])).toEqual([2, 6]);
        expect(groupHours([null, null], [0, 1]).len).toBe(0);
        expect(groupHours([], []).mean(() => 1)).toEqual([]);
        const m = groupHours(ts(6, 0, 20), all(6)).mean(i => [NaN, 4, 6, NaN, NaN, NaN][i]);
        expect(m[0]).toBe(5);
        expect(m[1]).toBeNaN();
    });

    it('data already at 1 h (or coarser) keeps one point per row - nothing is interpolated', () => {
        const v = [3, 1, 4, 1, 5];
        const one = groupHours(ts(5, 0, 60), all(5));
        expect(one.counts).toEqual([1, 1, 1, 1, 1]);
        expect(one.mean(i => v[i])).toEqual(v);
        const two = groupHours(ts(4, 30, 120), all(4));
        expect([0, 1, 2, 3].map(h => two.label(h))).toEqual([hourStart(0), hourStart(2), hourStart(4), hourStart(6)]);
    });

    it('sharedPerHour: the value EVERY row of the hour carries, else null (two values, or a row with none mixed in)', () => {
        // 20-minute rows: 3 per hour, 6 hours.
        const g = groupHours(ts(18, 0, 20), all(18));
        const perRow: (number | null)[] = [
            0, 0, 0,          // hour 0: all the same
            0, 2, 0,          // hour 1: two different values
            null, 1, 1,       // hour 2: a row with none FIRST
            1, 1, null,       // hour 3: a row with none LAST
            null, null, null, // hour 4: no row has one
            2, 0, 2,          // hour 5: split 2 / 0 / 2 — never the "middle" value 1
        ];
        expect(sharedPerHour(g, perRow)).toEqual([0, null, null, null, null, null]);
        // a one-row hour is that row; a row with no timestamp is in no hour, so it cannot unscore one
        const t: (number | null)[] = ts(4, 0, 30);
        t[1] = null;
        const one = groupHours(t, all(4));
        expect(one.counts).toEqual([1, 2]);
        expect(sharedPerHour(one, [3, null, 5, 5])).toEqual([3, 5]);
        expect(sharedPerHour(groupHours([], []), [])).toEqual([]);
    });

    it('flags and period membership need ONE row of the hour (a boundary hour is both); timestamps before 1970 floor', () => {
        // 20-minute rows, 3 hours. Training = rows 0..3, a period = rows 4..6.
        const g = groupHours(ts(9, 0, 20), all(9));
        expect(g.any(i => i <= 3)).toEqual([true, true, false]);
        expect(g.members([4, 5, 6])).toEqual([1, 2]);
        expect(g.members([8, 0, 8])).toEqual([0, 2]);
        expect(g.members([])).toEqual([]);
        const early = groupHours([-30 * MIN, 30 * MIN], [0, 1]);
        expect([early.label(0), early.label(1)]).toEqual(['1969-12-31T23:00:00', '1970-01-01T00:00:00']);
    });
});

describe('fakeHealthRust — compute_health_preview scores 1-hour averages', () => {
    const RUN_COND = [{ sensor: 'RUN', operation: 'greater_than', value1: 0.5, value2: null }];
    const scope = (start: string, end: string) => ({ timestamp_ranges: [{ start, end }], value_filters: RUN_COND, combine: 'and' });
    const preview = (rust: ReturnType<typeof createFakeHealthRust>, request: Record<string, unknown>) =>
        rust.invoke('compute_health_preview', { request }) as Promise<any>;

    // ---- Individual: 7 hours of 5-minute rows ----
    //   hours 0-2  running, V = 50..61 within the hour (mean 55.5)
    //   hour  3    only its first 6 rows running (V 50..55, mean 52.5); the stopped rows read 9999
    //   hour  4    running, V alternates 25.5 / 85.5 (every ROW is far out, the MEAN is 55.5)
    //   hour  5    only its first 3 rows running (V = 70); the stopped rows read 9999
    //   hour  6    stopped for the whole hour
    const hourOfRow = (i: number) => Math.floor(i / 12);
    const running = (i: number) => {
        const h = hourOfRow(i);
        if (h <= 2 || h === 4) return true;
        if (h === 3) return i % 12 < 6;
        if (h === 5) return i % 12 < 3;
        return false;
    };
    const valueOf = (i: number) => {
        if (!running(i)) return 9999;
        const h = hourOfRow(i);
        if (h <= 3) return 50 + (i % 12);
        if (h === 4) return i % 2 ? 85.5 : 25.5;
        return 70;
    };
    const individualData = (order: number[] = Array.from({ length: 84 }, (_, i) => i)): HealthDataset => ({
        headers: ['timestamp', 'V', 'RUN'],
        timestamps: order.map(stamp5),
        columns: { V: order.map(valueOf), RUN: order.map(i => (running(i) ? 1 : 0)) },
    });
    const TRAIN = scope('2024-03-01T00:00', '2024-03-01T03:59');
    const S1 = [{ start: '2024-03-01T04:00', end: '2024-03-01T06:59' }];
    const IND_REQ = { kind: 'individual', target: 'V', filter: TRAIN, set_points: { lower: 20, upper: 90 }, test_periods: S1 };

    it('Individual: `hourly` holds the hour means and their scores; `series` stays the raw rows with score null', async () => {
        const rust = createFakeHealthRust({ datasets: { d: individualData() } });
        const p = await preview(rust, IND_REQ);
        expect(p.valid).toBe(true);
        expect(p.scoring_interval_secs).toBe(3600);

        // RAW rows: 42 training rows + 12 (hour 4) + 3 (hour 5) scoring rows. Never a score.
        expect(p.series.total_points).toBe(57);
        expect(p.series.score).toBeNull();
        expect(p.series.timestamps[0]).toBe('2024-03-01 00:00:00'); // CSV text
        expect(p.series.value.every((v: number) => v !== 9999)).toBe(true);

        // HOURLY points: one per clock hour that has a running row - the stopped hour 6 has none.
        expect(p.hourly.kind).toBe('individual');
        expect(p.hourly.total_points).toBe(6);
        expect(p.hourly.timestamps).toEqual([0, 1, 2, 3, 4, 5].map(hourStart));
        expect(p.hourly.timestamps[5]).toBe('2024-03-01T05:00:00');
        expect(p.hourly.rows).toEqual([0, 12, 24, 36, 48, 60]); // the hour's first dataset row
        // 12-row means; the partly-running hours 3 and 5 average ONLY their running rows.
        expect(p.hourly.value).toEqual([55.5, 55.5, 55.5, 52.5, 55.5, 70]);
        expect(p.hourly.in_scope).toEqual([true, true, true, true, true, true]);

        // The score of the MEAN, not the mean of row scores: in hour 4 every single row is far
        // outside the 3σ band, the hour's mean is dead centre -> 100.
        const band = rust.individualBand('V', TRAIN);
        expect(scoreIndividual(band, 20, 90, 85.5)!).toBeLessThan(40);
        expect(scoreIndividual(band, 20, 90, 25.5)!).toBeLessThan(40);
        const s70 = scoreIndividual(band, 20, 90, 70)!;
        expect(s70).toBeGreaterThan(40);
        expect(s70).toBeLessThan(80);
        expect(p.hourly.score).toEqual([100, 100, 100, 100, 100, s70]);

        // Statistics still come from the RAW training rows (42 of them).
        expect(p.stats.rows).toBe(42);
        expect(p.histogram.n).toBe(42);
    });

    it('Individual: `score_summary` counts the TRAINING HOURS (share_basis "hour_count"), minimum located by hour start', async () => {
        const rust = createFakeHealthRust({ datasets: { d: individualData() } });
        const p = await preview(rust, IND_REQ);
        expect(p.score_summary).toEqual({
            scored: 4, unscored: 0, total_rows: 4, // hours 0-3; the scoring hours 4-5 are not in it
            min_score: { score: 100, row: 0, timestamp: '2024-03-01T00:00:00' },
            pct_below_80: 0, share_80_100: 100, share_40_80: 0, share_0_40: 0,
            share_basis: 'hour_count',
        });
        // invalid set points: no score anywhere, the hourly points are still there
        const bad = await preview(rust, { ...IND_REQ, set_points: { lower: null, upper: 90 } });
        expect(bad.valid).toBe(false);
        expect(bad.hourly.score).toBeNull();
        expect(bad.hourly.value).toEqual(p.hourly.value);
        expect(bad.score_summary).toBeNull();
        expect(bad.test_validation.tests[0]).toMatchObject({ rows: 15, hours: 2, scored: 0, pct_below_80: null, lowest: null, lowest_at: null });
    });

    it('Individual: `test_validation` keeps raw rows / running days and adds hours; scored, % below 80 and lowest are hourly', async () => {
        const rust = createFakeHealthRust({ datasets: { d: individualData() } });
        const p = await preview(rust, IND_REQ);
        const band = rust.individualBand('V', TRAIN);
        const s70 = scoreIndividual(band, 20, 90, 70)!;
        const v = p.test_validation;
        // train block: RAW rows and RAW running time (42 rows x 5 min = 0.146 d -> 0.1), plus the hours
        expect(v.train).toMatchObject({ rows: 42, days: 0.1, hours: 4, mean: band.mean, sd: band.sd, within_3sd_pct: 100 });
        expect(v.train_ranges).toEqual([{ start: '2024-03-01T00:00', end: '2024-03-01T03:59' }]);
        expect(v.tests).toHaveLength(1);
        const t = v.tests[0];
        expect(t).toMatchObject({
            index: 1, start: '2024-03-01T04:00', end: '2024-03-01T06:59',
            rows: 15, days: 0.1,            // RAW: 12 + 3 running rows (the stopped hour 6 has none)
            train_rows: 0, train_days: 0,
            hours: 2, train_hours: 0,       // HOURS: hour 4 and hour 5
            scored: 2,                      // hours, not the 15 rows
            pct_below_80: 50,               // 1 of the 2 scored hours (row by row it would be 100 %)
            lowest: Math.round(s70),
            lowest_at: '2024-03-01T05:00:00', // the START of that hour
        });
        // period metrics are over the HOURLY points: 55.5 is inside the 3σ band, 70 is not
        expect(t.within_3sd_pct).toBe(50);
        expect(t.mean_shift_sd).toBe(Math.round(((62.75 - band.mean) / band.sd) * 100) / 100);
    });

    it('a scoring-period edge inside an hour: that hour is ONE point averaging both sides, and it is a training hour', async () => {
        const rust = createFakeHealthRust({ datasets: { d: individualData() } });
        // train 00:00-01:29, scoring 01:30-02:59 -> hour 1 holds 6 training rows and 6 scoring rows
        const p = await preview(rust, { ...IND_REQ, filter: scope('2024-03-01T00:00', '2024-03-01T01:29'), test_periods: [{ start: '2024-03-01T01:30', end: '2024-03-01T02:59' }] });
        expect(p.series.total_points).toBe(36);
        expect(p.stats.rows).toBe(18); // the model: raw training rows only
        expect(p.hourly.timestamps).toEqual([0, 1, 2].map(hourStart));
        expect(p.hourly.value).toEqual([55.5, 55.5, 55.5]); // hour 1 = all 12 rows, not the 6 of either side
        expect(p.score_summary).toMatchObject({ total_rows: 2, scored: 2, share_basis: 'hour_count' });
        expect(p.test_validation.train).toMatchObject({ rows: 18, hours: 2 });
        expect(p.test_validation.tests[0]).toMatchObject({ rows: 18, train_rows: 0, hours: 2, train_hours: 1, scored: 2, pct_below_80: 0, lowest: 100, lowest_at: hourStart(1) });
    });

    it('the hourly points do not depend on the row order of the file', async () => {
        const reversed = Array.from({ length: 84 }, (_, i) => 83 - i);
        const a = await preview(createFakeHealthRust({ datasets: { d: individualData() } }), IND_REQ);
        const b = await preview(createFakeHealthRust({ datasets: { d: individualData(reversed) } }), IND_REQ);
        expect(b.hourly.timestamps).toEqual(a.hourly.timestamps);
        expect(b.hourly.value).toEqual(a.hourly.value);
        expect(b.hourly.score).toEqual(a.hourly.score);
        expect(b.test_validation.tests).toEqual(a.test_validation.tests);
        // `rows` = the lowest DATASET row of the hour: hour 0 sits at the end of the reversed file
        expect(b.hourly.rows[0]).toBe(72);
    });

    it('no scoring period: every hourly point is a training hour, no test_validation; an invalid period only adds an issue', async () => {
        const rust = createFakeHealthRust({ datasets: { d: individualData() } });
        const p = await preview(rust, { ...IND_REQ, test_periods: undefined });
        expect(p.hourly.timestamps).toEqual([0, 1, 2, 3].map(hourStart));
        expect(p.series.total_points).toBe(42);
        expect(p.score_summary).toMatchObject({ scored: 4, total_rows: 4 });
        expect(p.test_validation).toBeNull();
        const bad = await preview(rust, { ...IND_REQ, test_periods: [{ start: '2024-03-01T06:00', end: '2024-03-01T04:00' }] });
        expect(bad.valid).toBe(true); // a scoring-period issue is never part of `valid`
        expect(bad.validation).toEqual([{ code: 'test_ends_before_start', severity: 'error', field: 'test_period_1_end', message: 'Scoring period S1 ends before it starts.' }]);
        expect(bad.test_validation.tests[0]).toMatchObject({ index: 1, rows: 0, hours: 0, train_hours: 0, scored: 0, pct_below_80: null, lowest: null });
    });

    it('a stamp with a UTC offset keeps its OWN wall clock for the hour; a "Z" stamp is not a time Rust parses, so that row is in no hour', async () => {
        // 20-minute rows across midnight, written by three loggers (+07:00, -05:00, Z).
        const d: HealthDataset = {
            headers: ['timestamp', 'V'],
            timestamps: [
                '2026-02-09T23:00:00+07:00', '2026-02-09T23:20:00-05:00', '2026-02-09T23:40:00Z',
                '2026-02-10 00:00:00+07:00', '2026-02-10T00:20:00Z', '2026-02-10T00:40:00.500-05:00',
            ],
            columns: { V: [1, 3, 1000, 5, 1000, 7] },
        };
        const p = await preview(createFakeHealthRust({ datasets: { d } }), { kind: 'individual', target: 'V', filter: null });
        expect(p.series.total_points).toBe(6); // no time filter: every row is a raw row
        expect(p.hourly.timestamps).toEqual(['2026-02-09T23:00:00', '2026-02-10T00:00:00']); // never shifted by the offset
        expect(p.hourly.rows).toEqual([0, 3]);
        expect(p.hourly.value).toEqual([2, 6]); // the two "Z" rows (1000) are in no hour
        expect(p.hourly.total_points).toBe(2);
    });

    it('data already at 1 h: one hourly point per row, same values - only the timestamp text differs (hour start)', async () => {
        const rust = createFakeHealthRust({ datasets: { plant: plantDataset() } });
        const band = rust.individualBand('TAG1');
        const p = await preview(rust, { kind: 'individual', target: 'TAG1', filter: null, set_points: { lower: band.l3 - 50, upper: band.u3 + 50 } });
        expect(p.hourly.total_points).toBe(60);
        expect(p.hourly.total_points).toBe(p.series.total_points);
        expect(p.hourly.value).toEqual(p.series.value);
        expect(p.hourly.rows).toEqual(p.series.rows);
        expect([p.series.timestamps[5], p.hourly.timestamps[5]]).toEqual(['2026-01-01 05:00:00', '2026-01-01T05:00:00']);
        expect(p.series.score).toBeNull();
        expect(p.hourly.score).toHaveLength(60);
        expect(p.score_summary).toMatchObject({ scored: 60, total_rows: 60, share_basis: 'hour_count' });
    });

    // ---- Clustering: 6 hours of 5-minute rows, two clusters split by MODE ----
    //   hours 0-1  MODE 10 -> cluster 1 around (10, 20)
    //   hours 2-3  MODE 90 -> cluster 2 around (30, 60)
    //   hour  4    half its rows in each mode (every ROW sits on a cluster centre)
    //   hour  5    MODE 200: in no criteria range
    const wobX = (i: number) => (((i * 7) % 5) - 2) * 0.5;
    const wobY = (i: number) => (((i * 3) % 7) - 3) * 0.5;
    const modeOf = (i: number) => {
        const h = hourOfRow(i);
        if (h <= 1) return 10;
        if (h <= 3) return 90;
        if (h === 4) return i % 12 < 6 ? 10 : 90;
        return 200;
    };
    const clusterData = (): HealthDataset => {
        const idx = Array.from({ length: 72 }, (_, i) => i);
        const centre = (i: number) => (modeOf(i) === 10 ? [10, 20] : [30, 60]);
        return {
            headers: ['timestamp', 'X', 'Y', 'MODE'],
            timestamps: idx.map(stamp5),
            columns: {
                X: idx.map(i => centre(i)[0] + (hourOfRow(i) <= 3 ? wobX(i) : 0)),
                Y: idx.map(i => centre(i)[1] + (hourOfRow(i) <= 3 ? wobY(i) : 0)),
                MODE: idx.map(modeOf),
            },
        };
    };
    const CLU_REQ = {
        kind: 'clustering', first_sensor: 'X', second_sensor: 'Y', n_clusters: 2, criteria_sensor: 'MODE',
        cluster_ranges: [{ min: 0, max: 50 }, { min: 50, max: 100 }],
        filter: { timestamp_ranges: [{ start: '2024-03-01T00:00', end: '2024-03-01T03:59' }], value_filters: [], combine: 'and' },
        set_points: { outer_sd: 6 },
        test_periods: [{ start: '2024-03-01T04:00', end: '2024-03-01T05:59' }],
    };

    it('Clustering: the hour\'s cluster is the one EVERY row of the hour shares; an hour split between two clusters has no score (never 0)', async () => {
        const rust = createFakeHealthRust({ datasets: { d: clusterData() } });
        const p = await preview(rust, CLU_REQ);
        expect(p.valid).toBe(true);
        expect(p.scoring_interval_secs).toBe(3600);
        // RAW rows: each row keeps its OWN cluster, never a score.
        expect(p.series.total_points).toBe(72);
        expect(p.series.score).toBeNull();
        expect(p.series.cluster.slice(48, 60)).toEqual([1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2]);
        expect(p.stats).toMatchObject({ rows: 48, assigned_rows: 48, unassigned_rows: 0 }); // raw training rows
        // "Inside 3× SD" is in the stats: the train block's share with scoring periods ...
        expect((p.stats as any).inside_3sd_ring_pct).toBe(p.test_validation.train.inside_3sd_ring_pct);
        expect((p.stats as any).inside_3sd_ring_pct).toBe(100);
        // ... and still there WITHOUT any (the Model fit tile used to read "—" then)
        const noPeriods = await preview(rust, { ...CLU_REQ, test_periods: [] });
        expect(noPeriods.test_validation).toBeNull();
        expect((noPeriods.stats as any).inside_3sd_ring_pct).toBe(100);
        expect(p.cluster_scatter.total).toBe(48);

        // HOURLY: hour 4 has rows in BOTH clusters -> no cluster (its mean MODE, 50, lies in
        // cluster 2's range [50, 100), which is what it used to be judged against); hour 5
        // (MODE 200) has no row in any range.
        expect(p.hourly.total_points).toBe(6); // both are still hourly points
        expect(p.hourly.timestamps).toEqual([0, 1, 2, 3, 4, 5].map(hourStart));
        expect(p.hourly.rows).toEqual([0, 12, 24, 36, 48, 60]);
        expect(p.hourly.cluster).toEqual([1, 1, 2, 2, null, null]);
        expect([p.hourly.x[4], p.hourly.y[4]]).toEqual([20, 40]); // still the mean of its rows: midway between the two centres
        // Row by row hour 4 is perfect (every row sits on its own cluster's centre). Scored
        // against cluster 2 its hourly point would be far outside -> 0: a healthy machine
        // would read as failed. It is NOT scored: null, never 0.
        expect(p.hourly.score.slice(0, 4)).toEqual([100, 100, 100, 100]);
        expect(p.hourly.score[4]).toBeNull();
        expect(p.hourly.score[5]).toBeNull();
        expect(p.hourly.sd_distance[4]).toBeNull();
        expect(p.hourly.sd_distance[5]).toBeNull();
        expect(p.score_summary).toMatchObject({ scored: 4, unscored: 0, total_rows: 4, share_basis: 'hour_count', min_score: { score: 100, row: 0, timestamp: hourStart(0) } });

        const v = p.test_validation;
        expect(v.train).toMatchObject({ rows: 48, hours: 4, inside_3sd_ring_pct: 100 });
        expect(v.tests[0]).toMatchObject({
            rows: 24, hours: 2, train_rows: 0, train_hours: 0, // both hours still count
            scored: 0,                 // neither hour has a score
            pct_below_80: null, lowest: null, lowest_at: null,
        });
        // the ring share is over the hourly points that HAVE a cluster: none here, so no value at all
        expect(v.tests[0]).not.toHaveProperty('inside_3sd_ring_pct');
    });

    // ---- Clustering, three criteria ranges: A [0, 30) · B [30, 60) · C [60, 90) ----
    // B's centre (20, 40) is exactly midway between A's (10, 20) and C's (30, 60), and B's
    // range holds the mean of an A-row and a C-row criteria value (10 and 75 -> 42.5): an
    // hour split A / C, judged by its MEAN criteria value, would land in B and score 100
    // against a cluster the machine was never in.
    //   hours 0-1  MODE 10 -> A        hours 2-3  MODE 45 -> B        hours 4-5  MODE 75 -> C
    //   hour  6    TRAINING hour split A / C (each row wobbles around its own centre)
    //   hour  7    split A / C, every row exactly on its own centre
    //   hour  8    every row in C, far from C's centre
    //   hour  9    C, but one row's criteria value is MISSING (that row's X is 42, not 30)
    //   hour 10    C, but one row's criteria value (200) is outside every range
    //   hour 11    every row in B, on B's centre
    const A = [10, 20], B = [20, 40], C = [30, 60];
    const mixMode = (i: number): number | null => {
        const h = hourOfRow(i);
        const k = i % 12;
        if (h <= 1) return 10;
        if (h <= 3) return 45;
        if (h <= 5) return 75;
        if (h <= 7) return k < 6 ? 10 : 75;
        if (h === 8) return 75;
        if (h === 9) return k === 4 ? null : 75;
        if (h === 10) return k === 4 ? 200 : 75;
        return 45;
    };
    const mixData = (): HealthDataset => {
        const idx = Array.from({ length: 144 }, (_, i) => i);
        const centre = (i: number) => (mixMode(i) === 10 ? A : mixMode(i) === 45 ? B : C);
        const dx = (i: number) => {
            const h = hourOfRow(i);
            if (h <= 6) return wobX(i);
            if (h === 8) return 20;
            return h === 9 && i % 12 === 4 ? 12 : 0;
        };
        const dy = (i: number) => (hourOfRow(i) <= 6 ? wobY(i) : hourOfRow(i) === 8 ? 20 : 0);
        return {
            headers: ['timestamp', 'X', 'Y', 'MODE'],
            timestamps: idx.map(stamp5),
            columns: { X: idx.map(i => centre(i)[0] + dx(i)), Y: idx.map(i => centre(i)[1] + dy(i)), MODE: idx.map(mixMode) },
        };
    };
    const MIX_REQ = {
        kind: 'clustering', first_sensor: 'X', second_sensor: 'Y', n_clusters: 3, criteria_sensor: 'MODE',
        cluster_ranges: [{ min: 0, max: 30 }, { min: 30, max: 60 }, { min: 60, max: 90 }],
        filter: { timestamp_ranges: [{ start: '2024-03-01T00:00', end: '2024-03-01T06:59' }], value_filters: [], combine: 'and' },
        set_points: { outer_sd: 6 },
        test_periods: [{ start: '2024-03-01T07:00', end: '2024-03-01T11:59' }],
    };

    it('Clustering, three ranges: an hour split A / C is NOT scored against B; a row with a missing or out-of-range criteria value unscores its hour', async () => {
        const rust = createFakeHealthRust({ datasets: { d: mixData() } });
        const p = await preview(rust, MIX_REQ);
        expect(p.valid).toBe(true);
        const h = p.hourly;
        expect(h.total_points).toBe(12); // every hour is still an hourly point
        expect(h.timestamps).toEqual(Array.from({ length: 12 }, (_, i) => hourStart(i)));

        // RAW rows keep their OWN cluster: the split hours are two clusters row by row, the
        // row with no usable criteria value is in none.
        expect(p.series.cluster.slice(84, 96)).toEqual([1, 1, 1, 1, 1, 1, 3, 3, 3, 3, 3, 3]);
        expect([p.series.cluster[9 * 12 + 4], p.series.cluster[10 * 12 + 4]]).toEqual([null, null]);
        expect(p.series.cluster[9 * 12 + 5]).toBe(3);
        expect(p.stats).toMatchObject({ rows: 84, assigned_rows: 84, unassigned_rows: 0 }); // every training ROW has a cluster

        expect(h.cluster).toEqual([1, 1, 2, 2, 3, 3, null, null, 3, null, null, 2]);

        // hour 7 — split A / C: mean point (20, 40) is B's centre and mean MODE 42.5 is B's range.
        expect([h.x[7], h.y[7]]).toEqual(B);
        expect(h.cluster[7]).toBeNull();     // not 2
        expect(h.sd_distance[7]).toBeNull();
        expect(h.score[7]).toBeNull();       // not 100, and not 0

        // hour 9 — one row with no criteria value among rows of C: that row still enters the
        // means (x = (11 x 30 + 42) / 12), but the hour has no cluster.
        expect([h.x[9], h.y[9]]).toEqual([31, 60]);
        expect([h.cluster[9], h.sd_distance[9], h.score[9]]).toEqual([null, null, null]);
        // hour 10 — one row whose criteria value is outside every range among rows of C.
        expect([h.x[10], h.y[10]]).toEqual(C);
        expect([h.cluster[10], h.sd_distance[10], h.score[10]]).toEqual([null, null, null]);

        // Every row in ONE cluster -> scored exactly as before: (mean x, mean y) against it.
        const geomC = p.stats.clusters[2];
        expect([h.x[8], h.y[8]]).toEqual([50, 80]);
        expect(h.sd_distance[8]).toBe(sdDistance(geomC, 50, 80));
        expect(h.score[8]).toBe(scoreClusterDistance(h.sd_distance[8], 6));
        expect(h.score[8]).toBe(0); // far outside C: a real 0, unlike the unscored hours
        expect(h.score[11]).toBe(100);
        expect(h.sd_distance[11]).toBe(sdDistance(p.stats.clusters[1], B[0], B[1]));
        expect(h.score.slice(0, 6)).toEqual([100, 100, 100, 100, 100, 100]);

        // The TRAINING hour 6 is split too: counted, unscored, and it does not drag the minimum to 0.
        expect(h.score[6]).toBeNull();
        expect(p.score_summary).toMatchObject({
            scored: 6, unscored: 1, total_rows: 7, share_basis: 'hour_count', pct_below_80: 0,
            min_score: { score: 100, row: 0, timestamp: hourStart(0) },
        });

        const v = p.test_validation;
        expect(v.train).toMatchObject({ rows: 84, hours: 7, inside_3sd_ring_pct: 100 }); // the raw rows, each against its own cluster
        expect(v.tests[0]).toMatchObject({
            rows: 60, hours: 5, train_rows: 0, train_hours: 0, // all five hours count
            scored: 2,                  // hours 8 and 11 only
            pct_below_80: 50, lowest: 0, lowest_at: hourStart(8),
            inside_3sd_ring_pct: 50,    // over the two hours that have a cluster
        });

    });

    it('Clustering with no criteria sensor (one cluster): every hour has that cluster and a score, whatever the rows are', async () => {
        const rust = createFakeHealthRust({ datasets: { d: mixData() } });
        const p = await preview(rust, { ...MIX_REQ, n_clusters: 1, criteria_sensor: undefined, cluster_ranges: undefined });
        expect(p.valid).toBe(true);
        expect(p.hourly.total_points).toBe(12);
        expect(p.hourly.cluster).toEqual(new Array(12).fill(1));
        expect(p.hourly.score.every((s: number | null) => typeof s === 'number')).toBe(true);
        expect(p.hourly.sd_distance.every((d: number | null) => typeof d === 'number')).toBe(true);
        expect(p.score_summary).toMatchObject({ scored: 7, unscored: 0, total_rows: 7 });
        expect(p.test_validation.tests[0]).toMatchObject({ hours: 5, scored: 5 });
    });

    // ---- Relation model: T = 2·P + 1 (+ a small wobble), 6 hours of 5-minute rows ----
    //   hours 0-3  training
    //   hour  4    scoring: T reads 5 higher than the model expects
    //   hour  5    scoring: only its first 3 rows running (P = 100, T = 206); the stopped rows read 9999
    const relRunning = (i: number) => hourOfRow(i) <= 4 || i % 12 < 3;
    const pOf = (i: number) => (!relRunning(i) ? 9999 : hourOfRow(i) === 5 ? 100 : i % 12);
    const tOf = (i: number) => {
        if (!relRunning(i)) return 9999;
        const h = hourOfRow(i);
        if (h === 5) return 206;
        return 2 * (i % 12) + 1 + (i % 2 ? 0.5 : -0.5) + (h === 4 ? 5 : 0);
    };
    const relData = (): HealthDataset => {
        const idx = Array.from({ length: 72 }, (_, i) => i);
        return { headers: ['timestamp', 'T', 'P', 'RUN'], timestamps: idx.map(stamp5), columns: { T: idx.map(tOf), P: idx.map(pOf), RUN: idx.map(i => (relRunning(i) ? 1 : 0)) } };
    };
    const REL_SP = { residual_at_80_lower: -3, residual_at_80_upper: 3, residual_at_0_lower: -6, residual_at_0_upper: 6 };
    const REL_S = [{ start: '2024-03-01T04:00', end: '2024-03-01T05:59' }];
    const trainRel = async (rust: ReturnType<typeof createFakeHealthRust>) =>
        rust.invoke('preview_relationship_model', { predictors: ['P'], target: 'T', lambda: 1, filter: TRAIN, cache_key: 'r1::fp', max_points: 4000 }) as Promise<any>;

    it('Relation model: the hourly point is (mean target, the model\'s answer for the hour\'s MEAN predictors); raw rows are the training rows only', async () => {
        const rust = createFakeHealthRust({ datasets: { d: relData() } });
        const trained = await trainRel(rust);
        // The Train answer already carries hourly points (training hours), with no scoring period.
        expect(trained.health_preview.hourly.total_points).toBe(4);
        expect(trained.health_preview.series.score).toBeNull();
        expect(trained.health_preview.scoring_interval_secs).toBe(3600);

        const p = await preview(rust, { kind: 'relationship', target: 'T', predictors: ['P'], cache_key: 'r1::fp', filter: TRAIN, set_points: REL_SP, test_periods: REL_S });
        expect(p.valid).toBe(true);
        // RAW: the fit's 48 training rows, no per-row prediction for the scoring periods, no score.
        expect(p.series.total_points).toBe(48);
        expect(Math.max(...p.series.rows)).toBe(47);
        expect(p.series.score).toBeNull();
        expect(p.fit_scatter.total).toBe(48);
        expect(p.stats.rows).toBe(48);

        // HOURLY: 4 training hours + 2 scoring hours.
        const h = p.hourly;
        expect(h.kind).toBe('relationship');
        expect(h.total_points).toBe(6);
        expect(h.timestamps).toEqual([0, 1, 2, 3, 4, 5].map(hourStart));
        expect(h.rows).toEqual([0, 12, 24, 36, 48, 60]);
        // mean target: the wobble cancels over 12 rows -> 2 x 5.5 + 1 = 12 (hour 4: + 5); hour 5: 206
        expect(h.actual).toEqual([12, 12, 12, 12, 17, 206]);
        // the prediction is the model's answer at the hour's mean predictor: equal hours predict equally,
        // and hour 5 is predicted at P = 100 (its 3 running rows), not at the stopped rows' 9999
        expect(h.predicted[1]).toBe(h.predicted[0]);
        expect(h.predicted[4]).toBe(h.predicted[0]);
        expect(h.predicted[0]).toBeCloseTo(12, 6);
        expect(h.predicted[5]).toBeGreaterThan(195);
        expect(h.predicted[5]).toBeLessThan(215);
        // residual exactly as the file stores it, from those two numbers
        h.actual.forEach((a: number, i: number) => expect(h.residual[i]).toBe(fileResidual(a, h.predicted[i])));
        expect(h.residual[0]).toBe(0);
        expect(h.residual[4]).toBe(5);
        // scores: the training hours sit inside the 2RMSE band; hour 4 is 5 off -> between the 80 and the 0 point
        expect(h.score.slice(0, 4)).toEqual([100, 100, 100, 100]);
        expect(h.score[4]).toBe(scoreRelationship(p.stats.two_rmse, REL_SP, 5));
        expect(h.score[4]).toBeCloseTo(80 / 3, 6);
        expect(p.score_summary).toMatchObject({ scored: 4, unscored: 0, total_rows: 4, share_basis: 'hour_count', min_score: { score: 100, row: 0, timestamp: hourStart(0) } });

        const t = p.test_validation.tests[0];
        expect(p.test_validation.train).toMatchObject({ rows: 48, hours: 4 });
        expect(t).toMatchObject({ rows: 15, hours: 2, train_rows: 0, train_hours: 0, scored: 2, lowest_at: expect.stringMatching(/^2024-03-01T0[45]:00:00$/) });
        expect(t.lowest).toBe(Math.round(Math.min(h.score[4], h.score[5])));
        expect(t.pct_below_80).toBe(h.score[5] < 80 ? 100 : 50);
        expect(Object.keys(t)).toEqual(expect.arrayContaining(['r2', 'rmse', 'residual_mean', 'residual_sd']));
    });

    it('Relation model with NO scoring period still answers hourly scores for the training hours', async () => {
        const rust = createFakeHealthRust({ datasets: { d: relData() } });
        await trainRel(rust);
        const p = await preview(rust, { kind: 'relationship', target: 'T', predictors: ['P'], cache_key: 'r1::fp', filter: TRAIN, set_points: REL_SP });
        expect(p.hourly.total_points).toBe(4);
        expect(p.hourly.score).toEqual([100, 100, 100, 100]);
        expect(p.series.score).toBeNull();
        expect(p.test_validation).toBeNull();
    });
});
