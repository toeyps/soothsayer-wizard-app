import { describe, it, expect } from 'vitest';
import type { FailureGroupStateSlice, TestPeriod, TimeHighlight, TimePeriod } from '../types';
import {
    eventTimeError, validateTestPeriods, testPeriodsError, toTestPeriodsWire, testPeriodsKey,
    periodsOverlap, testTrainOverlaps, trainOverlapDays, testIncludesTrainNote,
    trainHighlightOverlaps, removeRangeFromPeriods, removeHighlightOverlap, validatePeriods,
    testPeriodsWirePlan, testNumberFor,
} from '../utils/timePeriods';
import {
    RECOMMENDED_TRAIN_DAYS, isBelowRecommendedTrainDays, trainDaysWarning,
    testsChangedState, testsChangedBannerText, testsChangedNotice, testsChangedNoticeText,
    testScoringFailure, TEST_SCORING_FAILED_CODE,
} from '../utils/trainTestValidation';
import { mk } from './helpers/failureModelFixture';
import { computeTrainFingerprint } from '../utils/trainFingerprint';

const tp = (over: Partial<TestPeriod> = {}): TestPeriod => ({ id: 't', start: '2026-01-01T00:00', end: '2026-01-31T23:59', label: 'normal', ...over });
const per = (start: string, end: string, id = 'p'): TimePeriod => ({ id, start, end });
const hl = (start: string, end: string, over: Partial<TimeHighlight> = {}): TimeHighlight => ({ id: 'h', start, end, label: 'Overhaul', color: '#f00', enabled: true, ...over });

describe('event time (SPEC rule 5)', () => {
    it('optional, and ignored on a Normal period', () => {
        expect(eventTimeError(tp({ label: 'problem' }))).toBeNull();
        expect(eventTimeError(tp({ label: 'problem', eventTime: '  ' }))).toBeNull();
        expect(eventTimeError(tp({ label: 'normal', eventTime: 'garbage' }))).toBeNull();
    });
    it('must parse and lie inside its own period (bounds inclusive)', () => {
        expect(eventTimeError(tp({ label: 'problem', eventTime: '2026-01-15T10:00' }))).toBeNull();
        expect(eventTimeError(tp({ label: 'problem', eventTime: '2026-01-01T00:00' }))).toBeNull();
        expect(eventTimeError(tp({ label: 'problem', eventTime: '2026-01-31T23:59' }))).toBeNull();
        expect(eventTimeError(tp({ label: 'problem', eventTime: '2025-12-31T23:59' }), 2)).toBe('The event time must be inside T2.');
        expect(eventTimeError(tp({ label: 'problem', eventTime: '2026-02-01T00:00' }))).toBe('The event time must be inside T1.');
        expect(eventTimeError(tp({ label: 'problem', eventTime: 'not a date' }), 3)).toBe('T3 has an invalid event time.');
    });
});

describe('validateTestPeriods / testPeriodsError', () => {
    it('both ends are required (decision: a test period is a closed range)', () => {
        const st = validateTestPeriods([tp({ start: '' }), tp({ end: '' }), tp()]);
        expect(st.map(s => s.reason)).toEqual(['T1 needs a start date.', 'T2 needs an end date.', undefined]);
    });
    it('unparseable / reversed dates are invalid; overlapping test periods are fine', () => {
        const st = validateTestPeriods([
            tp({ start: 'x' }), tp({ end: 'y' }), tp({ start: '2026-02-01T00:00', end: '2026-01-01T00:00' }),
            tp({ start: '2026-01-10T00:00', end: '2026-01-20T00:00' }),
        ]);
        expect(st.map(s => s.invalid)).toEqual([true, true, true, false]);
        expect(st[2].reason).toBe('T3 ends before it starts.');
    });
    it('reports the event time separately; testPeriodsError gives the first problem', () => {
        const list = [tp(), tp({ label: 'problem', eventTime: '2027-01-01T00:00' })];
        expect(validateTestPeriods(list)[1]).toMatchObject({ invalid: false, eventInvalid: true, eventReason: 'The event time must be inside T2.' });
        expect(testPeriodsError(list)).toBe('The event time must be inside T2.');
        expect(testPeriodsError([tp()])).toBeNull();
        expect(testPeriodsError([])).toBeNull();
    });
});

describe('toTestPeriodsWire / testPeriodsKey', () => {
    it('snake_case wire, invalid periods dropped, event_time only for a valid Known problem', () => {
        expect(toTestPeriodsWire([
            tp({ label: 'problem', eventTime: '2026-01-10T00:00', fromHighlight: 'H' }),
            tp({ label: 'normal', eventTime: '2026-01-10T00:00' }),
            tp({ label: 'problem', eventTime: '2030-01-01T00:00' }),
            tp({ end: '' }),
        ])).toEqual([
            { start: '2026-01-01T00:00', end: '2026-01-31T23:59', label: 'problem', event_time: '2026-01-10T00:00' },
            { start: '2026-01-01T00:00', end: '2026-01-31T23:59', label: 'normal', event_time: null },
            { start: '2026-01-01T00:00', end: '2026-01-31T23:59', label: 'problem', event_time: null },
        ]);
    });
    it('review fix 2026-10-07: testPeriodsWirePlan keeps the ORIGINAL T-number of every period it sends', () => {
        // [T1 invalid, T2 valid] -> only T2 is sent, and it is T2
        const plan = testPeriodsWirePlan([tp({ end: '' }), tp({ label: 'problem' })]);
        expect(plan.wire).toEqual([{ start: '2026-01-01T00:00', end: '2026-01-31T23:59', label: 'problem', event_time: null }]);
        expect(plan.numbers).toEqual([2]);
        expect(toTestPeriodsWire([tp({ end: '' }), tp({ label: 'problem' })])).toEqual(plan.wire);
        expect(testPeriodsWirePlan([tp(), tp({ start: 'x' }), tp()]).numbers).toEqual([1, 3]);
        expect(testPeriodsWirePlan([]).numbers).toEqual([]);
    });

    it('review fix 2026-10-07: testNumberFor looks up by the 1-based wire index, then the position, else position + 1', () => {
        expect(testNumberFor([2], 1, 0)).toBe(2);
        expect(testNumberFor([1, 3], 2, 0)).toBe(3);   // by wire index, whatever order the results come in
        expect(testNumberFor([1, 3], 9, 1)).toBe(3);   // unknown wire index -> by position
        expect(testNumberFor(null, 7, 0)).toBe(1);     // no mapping -> position
        expect(testNumberFor(undefined, undefined, 2)).toBe(3);
    });

    it('key ignores id / fromHighlight / a Normal event time, sees everything else', () => {
        expect(testPeriodsKey([tp()])).toBe(testPeriodsKey([tp({ id: 'x', fromHighlight: 'H', eventTime: '2026-01-02T00:00' })]));
        expect(testPeriodsKey(undefined)).toBe(testPeriodsKey([]));
        expect(testPeriodsKey([tp()])).not.toBe(testPeriodsKey([tp({ label: 'problem' })]));
        expect(testPeriodsKey([tp({ label: 'problem' })])).not.toBe(testPeriodsKey([tp({ label: 'problem', eventTime: '2026-01-02T00:00' })]));
    });
});

describe('test-vs-train overlap (SPEC rule 3 — a neutral note, never a block)', () => {
    const train = [per('2026-01-01T00:00', '2026-01-11T00:00', 'a'), per('2026-01-06T00:00', '2026-01-16T00:00', 'b'), per('2026-03-01T00:00', '2026-03-31T00:00', 'c')];
    it('periodsOverlap: inclusive bounds, open ends unbounded, invalid never overlaps', () => {
        expect(periodsOverlap(per('2026-01-01T00:00', '2026-01-02T00:00'), per('2026-01-02T00:00', '2026-01-03T00:00'))).toBe(true);
        expect(periodsOverlap(per('2026-01-01T00:00', '2026-01-02T00:00'), per('2026-01-02T00:01', '2026-01-03T00:00'))).toBe(false);
        expect(periodsOverlap(per('', ''), per('2030-01-01T00:00', '2030-01-02T00:00'))).toBe(true);
        expect(periodsOverlap(per('x', ''), per('', ''))).toBe(false);
    });
    it('testTrainOverlaps lists the 1-based train periods each test overlaps', () => {
        expect(testTrainOverlaps(train, [tp(), tp({ start: '2026-02-01T00:00', end: '2026-02-10T00:00' })])).toEqual([[1, 2], []]);
    });
    it('trainOverlapDays merges overlapping train periods (no double count) and clips open ends to the bounds', () => {
        // Train covers Jan 1 – Jan 16 inside a test of Jan 1 – Jan 31 -> 15 days.
        expect(trainOverlapDays(train, tp())).toBe(15);
        expect(trainOverlapDays(train, tp({ start: '2026-02-01T00:00', end: '2026-02-10T00:00' }))).toBe(0);
        expect(trainOverlapDays([per('', '')], tp({ start: '2026-01-01T00:00', end: '2026-01-11T00:00' }))).toBe(10);
        expect(trainOverlapDays([per('', '')], tp(), { min: '2026-01-21T00:00', max: '2027-01-01T00:00' })).toBe(11);
        expect(trainOverlapDays(train, tp({ end: '' }))).toBe(0);
    });
    it('the note text', () => {
        expect(testIncludesTrainNote(0, 12)).toBe('T1 includes 12 d of train running time — results include rows the model was trained on');
    });
});

describe('train-vs-highlight overlap and "Remove the overlap" (SPEC rule 4)', () => {
    const train = [per('2026-01-01T00:00', '2026-01-31T23:59', 'a'), per('2026-03-01T00:00', '2026-03-31T23:59', 'b')];
    it('finds enabled, parseable highlights overlapping each train period (reversed highlight read in order)', () => {
        const hs = [
            hl('2026-01-10T00:00', '2026-01-12T00:00', { id: 'h1' }),
            hl('2026-03-05T00:00', '2026-03-01T00:00', { id: 'h2' }), // reversed
            hl('2026-01-10T00:00', '2026-01-12T00:00', { id: 'off', enabled: false }),
            hl('2026-02-01T00:00', '2026-02-10T00:00', { id: 'gap' }),
            hl('bad', '2026-01-12T00:00', { id: 'bad' }),
        ];
        expect(trainHighlightOverlaps(train, hs).map(o => [o.periodIndex, o.highlight.id])).toEqual([[0, 'h1'], [1, 'h2']]);
    });
    it('splits a period around the range: before ends a minute before, after starts a minute after; first keeps the id', () => {
        const out = removeRangeFromPeriods(train, { start: '2026-01-10T00:00', end: '2026-01-12T06:00' });
        expect(out.map(p => [p.start, p.end])).toEqual([
            ['2026-01-01T00:00', '2026-01-09T23:59'],
            ['2026-01-12T06:01', '2026-01-31T23:59'],
            ['2026-03-01T00:00', '2026-03-31T23:59'],
        ]);
        expect(out[0].id).toBe('a');
        expect(out[1].id).not.toBe('a');
        expect(out[2]).toBe(train[1]);
        // The result no longer overlaps and is a valid, non-overlapping list.
        expect(out.some(p => periodsOverlap(p, { start: '2026-01-10T00:00', end: '2026-01-12T06:00' }))).toBe(false);
        expect(validatePeriods(out).some(s => s.invalid || s.overlapsPrev)).toBe(false);
    });
    it('seconds in the range still leave no overlap (minute resolution)', () => {
        const out = removeRangeFromPeriods([per('2026-01-01T00:00', '2026-01-31T00:00', 'a')], { start: '2026-01-10T00:00:30', end: '2026-01-12T00:00:30' });
        expect(out.map(p => [p.start, p.end])).toEqual([['2026-01-01T00:00', '2026-01-10T00:00'], ['2026-01-12T00:01', '2026-01-31T00:00']]);
    });
    it('trims one side, removes a period fully inside, keeps open ends open', () => {
        expect(removeRangeFromPeriods([per('2026-01-01T00:00', '2026-01-31T00:00')], { start: '2025-12-01T00:00', end: '2026-01-10T00:00' }).map(p => [p.start, p.end]))
            .toEqual([['2026-01-10T00:01', '2026-01-31T00:00']]);
        expect(removeRangeFromPeriods([per('2026-01-05T00:00', '2026-01-06T00:00')], { start: '2026-01-01T00:00', end: '2026-01-31T00:00' })).toEqual([]);
        expect(removeRangeFromPeriods([per('', '', 'o')], { start: '2026-01-10T00:00', end: '2026-01-12T00:00' }).map(p => [p.start, p.end]))
            .toEqual([['', '2026-01-09T23:59'], ['2026-01-12T00:01', '']]);
    });
    it('removeHighlightOverlap uses the highlight range; an unparseable highlight is a no-op', () => {
        expect(removeHighlightOverlap(train, hl('2026-03-31T00:00', '2026-03-10T00:00')).map(p => p.end)).toEqual(['2026-01-31T23:59', '2026-03-09T23:59', '2026-03-31T23:59']);
        expect(removeHighlightOverlap(train, hl('bad', 'worse'))).toBe(train);
    });
});

describe('minimum training data (SPEC rule 12 — warning only, no hard block)', () => {
    it('one constant, 30 days', () => {
        expect(RECOMMENDED_TRAIN_DAYS).toBe(30);
    });
    it('amber warning below it, nothing at/above it or when unknown', () => {
        expect(isBelowRecommendedTrainDays(29.9)).toBe(true);
        expect(isBelowRecommendedTrainDays(30)).toBe(false);
        expect(isBelowRecommendedTrainDays(null)).toBe(false);
        expect(isBelowRecommendedTrainDays(undefined)).toBe(false);
        expect(isBelowRecommendedTrainDays(Number.NaN)).toBe(false);
        expect(trainDaysWarning(12)).toMatch(/Only 12 d of train running time .* at least 30 d is recommended/);
        expect(trainDaysWarning(12)).toMatch(/You can still train/);
        expect(trainDaysWarning(0)).toMatch(/Only 0 d/);
        expect(trainDaysWarning(45)).toBeNull();
        expect(trainDaysWarning(null)).toBeNull();
    });
});

describe('"test periods changed" banners (SPEC rule 8)', () => {
    const fg = (over: Partial<FailureGroupStateSlice> = {}): FailureGroupStateSlice => ({ groups: [], models: [], runningConditionTestPeriods: [tp()], ...over });
    const stamped = (over = {}) => mk({ id: 'a', status: false, testsChangedAt: '2026-10-07T00:00:00Z', ...over });

    it('per model: changed / removed / nothing', () => {
        expect(testsChangedState(stamped(), fg())).toBe('changed');
        expect(testsChangedState(stamped(), fg({ runningConditionTestPeriods: [] }))).toBe('removed');
        expect(testsChangedState(stamped({ runningConditionMode: 'custom', customTestPeriods: [] }), fg())).toBe('removed');
        expect(testsChangedState(stamped({ status: true }), fg())).toBeNull();
        expect(testsChangedState(mk({ id: 'b' }), fg())).toBeNull();
        expect(testsChangedBannerText('changed')).toMatch(/^Test periods changed/);
        expect(testsChangedBannerText('removed')).toMatch(/^Test periods removed/);
    });

    it('review fix 2026-10-07: nothing to say for a STALE model (training inputs changed since it was trained — re-train first)', () => {
        const base = stamped({ kind: 'individual', targetSensor: 'T', category: 'condition' });
        const fresh = { ...base, lastTrainedAt: '2026-10-01T00:00:00Z', trainedFingerprint: computeTrainFingerprint(base, fg()) };
        expect(testsChangedState(fresh, fg())).toBe('changed');
        // a train period changed since: stale -> no "Mark complete again" banner / notice
        const changedTrain = fg({ runningConditionTimePeriods: [per('2025-01-01T00:00', '2025-06-30T23:59')] });
        expect(testsChangedState(fresh, changedTrain)).toBeNull();
        expect(testsChangedNotice([fresh], changedTrain)).toBeNull();
    });

    it('workspace notice: count + all removed, and its text', () => {
        expect(testsChangedNotice([mk({ id: 'x' })], fg())).toBeNull();
        const n = testsChangedNotice([stamped({ id: 'a' }), stamped({ id: 'b' }), mk({ id: 'c' })], fg());
        expect(n).toEqual({ count: 2, allRemoved: false });
        expect(testsChangedNoticeText(n!)).toBe('Test periods changed — 2 complete models need Mark complete again');
        expect(testsChangedNoticeText({ count: 1, allRemoved: false })).toBe('Test periods changed — 1 complete model needs Mark complete again');
        const r = testsChangedNotice([stamped()], fg({ runningConditionTestPeriods: [] }));
        expect(r).toEqual({ count: 1, allRemoved: true });
        expect(testsChangedNoticeText(r!)).toMatch(/^Test periods removed — 1 complete model needs/);
    });
});

describe('test periods could not be scored (warning test_scoring_failed, review fix 2026-10-07)', () => {
    it('finds the warning among the preview issues, null otherwise', () => {
        const issue = { code: TEST_SCORING_FAILED_CODE, severity: 'warning' as const, field: 'test_periods', message: 'x' };
        expect(testScoringFailure({ validation: [{ code: 'required', severity: 'error', field: 'lower', message: '' }, issue] })).toBe(issue);
        expect(testScoringFailure({ validation: [] })).toBeNull();
        expect(testScoringFailure(null)).toBeNull();
    });
});
