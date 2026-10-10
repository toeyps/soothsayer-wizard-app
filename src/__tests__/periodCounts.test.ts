import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TestPeriod, TimePeriod } from '../types';
import type { PeriodCount, PeriodCounts } from '../types/periodCounts';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (cmd: string, args?: unknown) => mockInvoke(cmd, args),
}));

import {
    countPeriodRows, countCondition, trainCountPlan, scoringCountPlan,
    periodCalendarDays, unionCalendarDays, percentText, runningDaysText, countFor,
    trainRowModels, scoringRowModels, runningConditionCaption, CAPTION_RECOMMENDED_TEXT, PERIOD_COUNTS_IDLE,
    type PeriodCountsState,
} from '../utils/periodCounts';
import { MAX_COUNT_PERIODS } from '../types/periodCounts';
import { RECOMMENDED_TRAIN_DAYS } from '../utils/trainTestValidation';

const p = (start: string, end: string, id = `${start}|${end}`): TimePeriod => ({ id, start, end });
const t = (start: string, end: string, id = `${start}|${end}`): TestPeriod => ({ id, start, end });

/** The SPEC's own example: 81 d + 36 d of train = 117 d, 59 d of scoring. */
const P1 = p('2026-01-01T00:00', '2026-03-23T00:00');
const P2 = p('2026-05-11T00:00', '2026-06-16T00:00');
const S1 = t('2026-03-23T00:00', '2026-05-21T00:00');
const BOUNDS = { min: '2026-01-01 00:00:00', max: '2026-06-30 23:50:00' };

const one = (start: string | null, end: string | null, index: number, rows: number, running: number, days: number, valid = true): PeriodCount => ({
    index, start, end, valid, invalid_reason: valid ? null : 'ends_before_start', rows_in_period: rows, running_rows: running, running_days: days,
});
const TRAIN_COUNTS: PeriodCounts = {
    total_rows: 25_880, interval_secs: 600,
    periods: [one(P1.start, P1.end, 1, 11_664, 9_965, 69.2), one(P2.start, P2.end, 2, 5_184, 4_426, 30.7)],
    union: { rows_in_period: 16_848, running_rows: 14_391, running_days: 99.9 },
};
const SCORING_COUNTS: PeriodCounts = {
    total_rows: 25_880, interval_secs: 600,
    periods: [one(S1.start, S1.end, 1, 8_496, 7_200, 50)],
    union: { rows_in_period: 8_496, running_rows: 7_200, running_days: 50 },
};
const state = (over: Partial<PeriodCountsState> = {}): PeriodCountsState => ({ status: 'ok', train: TRAIN_COUNTS, scoring: SCORING_COUNTS, error: null, errorCode: null, ...over });

beforeEach(() => { mockInvoke.mockReset(); });

describe('countPeriodRows (the count_period_rows binding)', () => {
    it('sends snake_case keys — periods, filter, expected_generation — and returns the answer', async () => {
        mockInvoke.mockResolvedValue(TRAIN_COUNTS);
        const cond = { value_filters: [{ sensor: 'KW', operation: 'greater_than' as const, value1: 4000, value2: null }], combine: 'and' as const };
        const periods = [{ start: '2026-01-01T00:00', end: null }];
        await expect(countPeriodRows(periods, cond, 7)).resolves.toBe(TRAIN_COUNTS);
        expect(mockInvoke).toHaveBeenCalledTimes(1);
        expect(mockInvoke).toHaveBeenCalledWith('count_period_rows', { periods, filter: cond, expected_generation: 7 });
        expect(Object.keys(mockInvoke.mock.calls[0][1])).toEqual(['periods', 'filter', 'expected_generation']);
    });
    it('no condition and no pinned generation are sent as null', async () => {
        mockInvoke.mockResolvedValue(TRAIN_COUNTS);
        await countPeriodRows([], null);
        expect(mockInvoke).toHaveBeenCalledWith('count_period_rows', { periods: [], filter: null, expected_generation: null });
        await countPeriodRows([], null, undefined);
        expect(mockInvoke.mock.calls[1][1].expected_generation).toBeNull();
    });
    it('a Rust error is rejected as it is (the hook reads its prefix)', async () => {
        mockInvoke.mockRejectedValue('STALE_SESSION: the dataset changed since this window was opened');
        await expect(countPeriodRows([], null, 3)).rejects.toMatch(/^STALE_SESSION:/);
    });
    it('the cap constant matches Rust (64 periods per call)', () => {
        expect(MAX_COUNT_PERIODS).toBe(64);
    });
});

describe('countCondition (the running condition without the time gate)', () => {
    const vf = [{ sensor: 'KW', operation: 'greater_than' as const, value1: 4000, value2: null }];
    it('keeps value_filters + combine and DROPS the time ranges of the training payload', () => {
        const payload = { timestamp_ranges: [{ start: '2026-01-01T00:00', end: null }], value_filters: vf, combine: 'or' as const };
        expect(countCondition(payload)).toEqual({ value_filters: vf, combine: 'or' });
        expect(Object.keys(countCondition(payload)!)).toEqual(['value_filters', 'combine']);
    });
    it('no condition at all is null — a payload that only limits the time, an empty one, or none', () => {
        expect(countCondition({ value_filters: [], combine: 'and' })).toBeNull();
        expect(countCondition(null)).toBeNull();
        expect(countCondition(undefined)).toBeNull();
    });
    it('so an edit of a TRAIN period does not change the condition the SCORING periods are counted with', () => {
        const a = countCondition({ value_filters: vf, combine: 'and' });
        const b = countCondition({ timestamp_ranges: [{ start: '2026-02-01T00:00', end: '2026-02-28T23:59' }], value_filters: vf, combine: 'and' });
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });
});

describe('trainCountPlan / scoringCountPlan (what is sent, and where it came from)', () => {
    it('every valid train period, blank bound -> null, with its 0-based list position', () => {
        const plan = trainCountPlan([p('', '2026-01-31T23:59'), P1, p('2026-07-01T00:00', '')]);
        expect(plan.wire).toEqual([
            { start: null, end: '2026-01-31T23:59' },
            { start: P1.start, end: P1.end },
            { start: '2026-07-01T00:00', end: null },
        ]);
        expect(plan.positions).toEqual([0, 1, 2]);
    });
    it('an invalid train period is NOT sent (it must not be part of the union); the others keep their positions', () => {
        const plan = trainCountPlan([P1, p('2026-05-11T00:00', '2026-05-01T00:00'), P2, p('garbage', '2026-08-01T00:00')]);
        expect(plan.wire).toEqual([{ start: P1.start, end: P1.end }, { start: P2.start, end: P2.end }]);
        expect(plan.positions).toEqual([0, 2]);
        // an open end that is only allowed on the LAST period is invalid in the middle — not sent as "open"
        expect(trainCountPlan([p('2026-01-01T00:00', ''), P2]).positions).toEqual([1]);
        expect(trainCountPlan([])).toEqual({ wire: [], positions: [] });
    });
    it('scoring periods need both ends: one without is not sent; legacy keys never travel', () => {
        const old: TestPeriod = { ...S1, label: 'problem', eventTime: '2026-04-01T00:00', fromHighlight: 'H' };
        const plan = scoringCountPlan([t('2026-02-01T00:00', ''), old]);
        expect(plan.wire).toEqual([{ start: S1.start, end: S1.end }]);
        expect(plan.positions).toEqual([1]);
        expect(Object.keys(plan.wire[0])).toEqual(['start', 'end']);
    });
});

describe('calendar days from the dates', () => {
    it('periodCalendarDays: whole days; open ends run to the dataset bounds; reversed / unknown is null', () => {
        expect(periodCalendarDays(P1)).toBe(81);
        expect(periodCalendarDays(P2)).toBe(36);
        expect(periodCalendarDays(p('', '2026-01-11T00:00'), BOUNDS)).toBe(10);
        expect(periodCalendarDays(p('', '2026-01-11T00:00'))).toBeNull(); // open start, bounds unknown
        expect(periodCalendarDays(p('2026-02-01T00:00', '2026-01-01T00:00'))).toBeNull();
        expect(periodCalendarDays(p('x', '2026-01-01T00:00'))).toBeNull();
    });
    it('unionCalendarDays: overlapping periods are not counted twice', () => {
        expect(unionCalendarDays([P1, P2], [false, false])).toBe(117);
        // 1–11 Jan and 6–16 Jan cover 15 days, not 20
        expect(unionCalendarDays([p('2026-01-01T00:00', '2026-01-11T00:00'), p('2026-01-06T00:00', '2026-01-16T00:00')], [false, false])).toBe(15);
        // order does not matter
        expect(unionCalendarDays([P2, P1], [false, false])).toBe(117);
    });
    it('unionCalendarDays: flagged periods are left out; nothing countable is null', () => {
        expect(unionCalendarDays([P1, P2], [false, true])).toBe(81);
        expect(unionCalendarDays([P1], [true])).toBeNull();
        expect(unionCalendarDays([], [])).toBeNull();
    });
    it('unionCalendarDays: clamped to the dataset; a fully open period is the whole dataset', () => {
        expect(unionCalendarDays([p('2025-06-01T00:00', '2026-01-11T00:00')], [false], BOUNDS)).toBe(10);
        expect(unionCalendarDays([p('', '')], [false], { min: '2026-01-01 00:00:00', max: '2026-01-31 00:00:00' })).toBe(30);
        // a period entirely outside the dataset covers none of it
        expect(unionCalendarDays([p('2024-01-01T00:00', '2024-02-01T00:00')], [false], BOUNDS)).toBeNull();
    });
});

describe('percentText / runningDaysText', () => {
    it('percentText rounds to a whole percent; "<1%" for a tiny share, "0%" for none, em dash when unknown', () => {
        expect(percentText(14_391, 25_880)).toBe('56%');
        expect(percentText(3, 10_000)).toBe('<1%');
        expect(percentText(0, 100)).toBe('0%');
        expect(percentText(null, 100)).toBe('—');
        expect(percentText(5, 0)).toBe('—');
        expect(percentText(100, 100)).toBe('100%');
    });
    it('runningDaysText: whole days from 10 d up, one decimal below (a short dataset never reads "0 d")', () => {
        expect(runningDaysText(99.9)).toBe('100');
        expect(runningDaysText(69.2)).toBe('69');
        expect(runningDaysText(10)).toBe('10');
        expect(runningDaysText(2.5)).toBe('2.5');
        expect(runningDaysText(0.3)).toBe('0.3');
        expect(runningDaysText(3)).toBe('3');
        expect(runningDaysText(0)).toBe('0');
        expect(runningDaysText(Number.NaN)).toBe('0');
    });
});

describe('countFor (a period finds its own count by its bounds)', () => {
    it('matches on start/end text, blank = open; an entry Rust could not count never matches', () => {
        expect(countFor(TRAIN_COUNTS, P2)?.running_rows).toBe(4_426);
        const open: PeriodCounts = { ...TRAIN_COUNTS, periods: [one(null, '2026-01-31T23:59', 1, 10, 5, 0.1), one('2026-02-01T00:00', '2026-01-01T00:00', 2, 0, 0, 0, false)] };
        expect(countFor(open, p('', '2026-01-31T23:59'))?.rows_in_period).toBe(10);
        expect(countFor(open, p('  ', ' 2026-01-31T23:59 '))?.rows_in_period).toBe(10);
        expect(countFor(open, p('2026-02-01T00:00', '2026-01-01T00:00'))).toBeNull();
        expect(countFor(TRAIN_COUNTS, p('2026-01-02T00:00', P1.end))).toBeNull();
        expect(countFor(null, P1)).toBeNull();
    });
});

describe('period rows: "P1 · 81 d · 69 d running"', () => {
    it('train rows: calendar days from the dates, running days from the count', () => {
        const rows = trainRowModels([P1, P2], BOUNDS, state());
        expect(rows.map(r => r.text)).toEqual(['P1 · 81 d · 69 d running', 'P2 · 36 d · 31 d running']);
        expect(rows[0]).toMatchObject({ name: 'P1', number: 1, invalid: false, calendarDays: 81, runningDays: 69.2, runningRows: 9_965, rowsInPeriod: 11_664, daysText: '81 d', runningText: '69 d running', stale: false });
    });
    it('scoring rows the same, named S<n>', () => {
        expect(scoringRowModels([S1], BOUNDS, state()).map(r => r.text)).toEqual(['S1 · 59 d · 50 d running']);
    });
    it('before the count is in: the calendar days alone', () => {
        const rows = trainRowModels([P1], BOUNDS, state({ status: 'loading', train: null, scoring: null }));
        expect(rows[0]).toMatchObject({ text: 'P1 · 81 d', runningText: null, runningDays: null, stale: false });
    });
    it('an invalid period has no numbers at all (its reason line speaks); the others keep theirs', () => {
        const bad = p('2026-05-11T00:00', '2026-05-01T00:00');
        const rows = trainRowModels([P1, bad], BOUNDS, state());
        expect(rows[0].text).toBe('P1 · 81 d · 69 d running');
        expect(rows[1]).toMatchObject({ name: 'P2', invalid: true, calendarDays: null, runningDays: null, daysText: '—', runningText: null, text: 'P2 · —' });
    });
    it('while a new answer is on its way: an unchanged period keeps its numbers (dimmed), an edited one drops to the calendar days', () => {
        const edited = p('2026-01-05T00:00', P1.end);
        const rows = trainRowModels([edited, P2], BOUNDS, state({ status: 'loading' }));
        expect(rows[0]).toMatchObject({ text: 'P1 · 77 d', runningText: null, stale: false });
        expect(rows[1]).toMatchObject({ text: 'P2 · 36 d · 31 d running', stale: true });
    });
    it('a re-ordered or added period still finds its own count (matched by bounds, not by position)', () => {
        const early = p('2025-12-01T00:00', '2025-12-31T00:00');
        const rows = trainRowModels([early, P1, P2], BOUNDS, state());
        expect(rows.map(r => r.text)).toEqual(['P1 · 30 d', 'P2 · 81 d · 69 d running', 'P3 · 36 d · 31 d running']);
    });
    it('an open end uses the dataset bounds for its calendar days', () => {
        const counts: PeriodCounts = { ...TRAIN_COUNTS, periods: [one(null, null, 1, 25_880, 20_000, 138.9)] };
        const rows = trainRowModels([p('', '')], { min: '2026-01-01 00:00:00', max: '2026-06-30 00:00:00' }, state({ train: counts }));
        expect(rows[0].text).toBe('P1 · 180 d · 139 d running');
    });
});

describe('runningConditionCaption (the one line under the timeline)', () => {
    const caption = (over: Partial<Parameters<typeof runningConditionCaption>[0]> = {}) =>
        runningConditionCaption({ trainPeriods: [P1, P2], scoringPeriods: [S1], bounds: BOUNDS, counts: state(), ...over });

    it('the SPEC line: days of train (about N d running time) · days of scoring · rows used of total (%) · ≥ 30 d recommended', () => {
        const c = caption();
        expect(c.trainText).toBe('117 d train (about 100 d running time)');
        expect(c.scoringText).toBe('59 d scoring');
        expect(c.rowsText).toBe('14,391 of 25,880 rows (56%) used for training');
        expect(c.recommendedText).toBe('≥ 30 d recommended');
        expect(c.text).toBe('117 d train (about 100 d running time) · 59 d scoring · 14,391 of 25,880 rows (56%) used for training · ≥ 30 d recommended');
        expect(c).toMatchObject({ noTrain: false, trainCalendarDays: 117, trainRunningDays: 99.9, scoringCalendarDays: 59, belowRecommended: false, warning: null });
        expect(c.rows).toEqual({ kind: 'counted', used: 14_391, total: 25_880, percent: '56%', stale: false });
    });
    it('ONE source for "rows used / total": the TRAIN call union.running_rows of its total_rows — never the per-period sum or the scoring call', () => {
        const overlapping: PeriodCounts = {
            total_rows: 1_000, interval_secs: 600,
            periods: [one(P1.start, P1.end, 1, 600, 300, 2.1), one(P2.start, P2.end, 2, 600, 300, 2.1)],
            union: { rows_in_period: 800, running_rows: 400, running_days: 2.8 }, // rows shared by both periods count once
        };
        const c = caption({ counts: state({ train: overlapping, scoring: { ...SCORING_COUNTS, total_rows: 999_999 } }) });
        expect(c.rows).toMatchObject({ used: 400, total: 1_000, percent: '40%' });
        expect(c.rowsText).toBe('400 of 1,000 rows (40%) used for training');
    });
    it('no train period: "no train period · no scoring time · add a train period to count the rows" (no recommendation)', () => {
        const c = caption({ trainPeriods: [], scoringPeriods: [], counts: state({ train: null, scoring: null }) });
        expect(c.text).toBe('no train period · no scoring time · add a train period to count the rows');
        expect(c).toMatchObject({ noTrain: true, recommendedText: null, trainCalendarDays: null, rows: { kind: 'no-train' } });
        // scoring periods without a train period still say their days
        expect(caption({ trainPeriods: [], counts: state({ train: null }) }).text).toBe('no train period · 59 d scoring · add a train period to count the rows');
    });
    it('no scoring period: "no scoring time"; an invalid scoring period is not counted as scoring time', () => {
        expect(caption({ scoringPeriods: [] }).scoringText).toBe('no scoring time');
        expect(caption({ scoringPeriods: [t('2026-05-11T00:00', '2026-05-01T00:00')] }).scoringText).toBe('no scoring time');
        expect(caption({ scoringPeriods: [S1, t('2026-05-11T00:00', '')] }).scoringText).toBe('59 d scoring');
    });
    it('an invalid train period: no total until it is fixed — and no running time is claimed', () => {
        const c = caption({ trainPeriods: [P1, p('2026-05-11T00:00', '2026-05-01T00:00')] });
        expect(c.rows).toEqual({ kind: 'fix' });
        expect(c.rowsText).toBe('fix the period to count the rows');
        expect(c.trainText).toBe('81 d train');
        expect(c.trainRunningDays).toBeNull();
    });
    it('counting for the first time / failed / not counting', () => {
        expect(caption({ counts: state({ status: 'loading', train: null, scoring: null }) })).toMatchObject({ rows: { kind: 'loading' }, rowsText: 'Counting rows…', trainText: '117 d train' });
        const failed = caption({ counts: state({ status: 'error', train: null, scoring: null, error: 'x' }) });
        expect(failed).toMatchObject({ rows: { kind: 'error' }, rowsText: "Couldn't count the rows right now", trainText: '117 d train' });
        const idle = caption({ counts: PERIOD_COUNTS_IDLE });
        expect(idle).toMatchObject({ rows: { kind: 'idle' }, rowsText: '' });
        expect(idle.text).toBe('117 d train · 59 d scoring · ≥ 30 d recommended');
    });
    it('while a new answer is on its way the previous numbers stay, flagged stale (no flicker)', () => {
        const c = caption({ counts: state({ status: 'loading' }) });
        expect(c.rows).toEqual({ kind: 'counted', used: 14_391, total: 25_880, percent: '56%', stale: true });
        expect(c.text).toBe(caption().text);
    });
    it('below the recommended train running time: amber flag + the existing warning sentence — never a block', () => {
        const few: PeriodCounts = { ...TRAIN_COUNTS, union: { rows_in_period: 3_000, running_rows: 1_728, running_days: 12 } };
        const c = caption({ counts: state({ train: few }) });
        expect(c.belowRecommended).toBe(true);
        expect(c.warning).toMatch(/^Only 12 d of train running time — at least 30 d is recommended/);
        expect(c.recommendedText).toBe(CAPTION_RECOMMENDED_TEXT);
        expect(c.trainText).toBe('117 d train (about 12 d running time)');
        expect(CAPTION_RECOMMENDED_TEXT).toBe(`≥ ${RECOMMENDED_TRAIN_DAYS} d recommended`);
        // exactly at the recommendation is fine
        expect(caption({ counts: state({ train: { ...few, union: { ...few.union, running_days: 30 } } }) }).belowRecommended).toBe(false);
    });
    it('a dataset with no sample interval (fewer than two dated rows): rows are counted, running time is not claimed', () => {
        const noInterval: PeriodCounts = { ...TRAIN_COUNTS, interval_secs: null, union: { rows_in_period: 1, running_rows: 1, running_days: 0 }, total_rows: 1 };
        const c = caption({ counts: state({ train: noInterval }) });
        expect(c.trainText).toBe('117 d train');
        expect(c.rowsText).toBe('1 of 1 rows (100%) used for training');
        expect(c).toMatchObject({ trainRunningDays: null, belowRecommended: false, warning: null });
    });
    it('a dataset whose time range is unknown: an open-ended train period has no calendar days to print', () => {
        const c = caption({ trainPeriods: [p('', '')], bounds: null });
        expect(c.trainCalendarDays).toBeNull();
        expect(c.trainText).toBe('— d train (about 100 d running time)');
    });
});
