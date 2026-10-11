import { describe, it, expect } from 'vitest';
import type { FailureGroupStateSlice, TestPeriod, TimeHighlight, TimePeriod } from '../types';
import {
    validateTestPeriods, testPeriodsError, toTestPeriodsWire, testPeriodsKey,
    periodsOverlap, testTrainOverlaps, trainOverlapDays, testIncludesTrainNote,
    trainHighlightOverlaps, removeRangeFromPeriods, removeHighlightOverlap, validatePeriods,
    testPeriodsWirePlan, testNumberFor, toScoringPeriod, toScoringPeriods,
    scoringIssueTarget, scoringIssueMessage,
} from '../utils/timePeriods';
import * as timePeriods from '../utils/timePeriods';
import {
    RECOMMENDED_TRAIN_DAYS, isBelowRecommendedTrainDays, trainDaysWarning,
    testsChangedState, testsChangedBannerText, testsChangedNotice, testsChangedNoticeText, testsChangedNoticeParts,
    testScoringFailure, TEST_SCORING_FAILED_CODE, TEST_SCORING_OUTDATED_CODE, TEST_SCORING_TOO_LARGE_CODE, isTestScoringRetryable,
    TEST_SCORING_FAILED_TEXT, TEST_SCORING_OUTDATED_TEXT, SLOW_TEST_SCORING_TEXT,
} from '../utils/trainTestValidation';
import * as trainTestValidation from '../utils/trainTestValidation';
import { mk } from './helpers/failureModelFixture';
import { LEGACY_TESTS } from './helpers/trainTestFixture';
import { computeTrainFingerprint } from '../utils/trainFingerprint';

/** A scoring period: start → end only. */
const tp = (over: Partial<TestPeriod> = {}): TestPeriod => ({ id: 't', start: '2026-01-01T00:00', end: '2026-01-31T23:59', ...over });
const per = (start: string, end: string, id = 'p'): TimePeriod => ({ id, start, end });
const hl = (start: string, end: string, over: Partial<TimeHighlight> = {}): TimeHighlight => ({ id: 'h', start, end, label: 'Overhaul', color: '#f00', enabled: true, ...over });

describe('a scoring period is only start → end (SPEC workbench-redesign §2)', () => {
    it('the event-time helper is gone, and no export of either module is about labels, events, lead time or verdicts', () => {
        expect(timePeriods).not.toHaveProperty('eventTimeError');
        const names = [...Object.keys(timePeriods), ...Object.keys(trainTestValidation)];
        expect(names.filter(n => /event|label|lead|verdict|normal|problem|fromHighlight/i.test(n))).toEqual([]);
    });
    it('toScoringPeriod keeps id / start / end and DROPS the legacy keys of an old workspace', () => {
        const old: TestPeriod = { id: 'o', start: '2024-03-01T00:00', end: '2024-03-31T23:59', label: 'problem', eventTime: '2024-03-20T08:00', fromHighlight: 'Bearing' };
        const out = toScoringPeriod(old);
        expect(out).toEqual({ id: 'o', start: '2024-03-01T00:00', end: '2024-03-31T23:59' });
        expect(Object.keys(out).sort()).toEqual(['end', 'id', 'start']);
        expect(old.label).toBe('problem'); // pure: the input is not touched
        // the usual edit: change one bound of an old period -> what is written has no legacy key
        expect(Object.keys(toScoringPeriod({ ...old, end: '2024-04-02T00:00' })).sort()).toEqual(['end', 'id', 'start']);
        expect(toScoringPeriods(LEGACY_TESTS).every(t => Object.keys(t).length === 3)).toBe(true);
        expect(toScoringPeriods(LEGACY_TESTS).map(t => t.id)).toEqual(['old-1', 'old-2']);
        expect(toScoringPeriods(undefined)).toEqual([]);
        // dropping them is NOT a change of the list
        expect(testPeriodsKey(toScoringPeriods(LEGACY_TESTS))).toBe(testPeriodsKey(LEGACY_TESTS));
    });
});

describe('validateTestPeriods / testPeriodsError', () => {
    it('both ends are required (a scoring period is a closed range); the text names it S<n>', () => {
        const st = validateTestPeriods([tp({ start: '' }), tp({ end: '' }), tp()]);
        expect(st.map(s => s.reason)).toEqual(['S1 needs a start date.', 'S2 needs an end date.', undefined]);
    });
    it('unparseable / reversed dates are invalid; overlapping scoring periods are fine', () => {
        const st = validateTestPeriods([
            tp({ start: 'x' }), tp({ end: 'y' }), tp({ start: '2026-02-01T00:00', end: '2026-01-01T00:00' }),
            tp({ start: '2026-01-10T00:00', end: '2026-01-20T00:00' }),
        ]);
        expect(st.map(s => s.invalid)).toEqual([true, true, true, false]);
        expect(st.map(s => s.reason)).toEqual(['S1 has an invalid start date.', 'S2 has an invalid end date.', 'S3 ends before it starts.', undefined]);
    });
    it('a status is only { invalid, reason } — there is no event-time check any more', () => {
        expect(validateTestPeriods([tp()])).toEqual([{ invalid: false, reason: undefined }]);
        // an invalid one also says what is wrong (`fault`) and carries its row line — still nothing about an event
        expect(Object.keys(validateTestPeriods([tp({ end: '' })])[0]).sort()).toEqual(['fault', 'invalid', 'reason', 'rowReason']);
    });
    it('a legacy label / event time never makes an old period invalid (even an event time outside it, or garbage)', () => {
        const old = [
            tp({ label: 'problem', eventTime: '2030-01-01T00:00' }),
            tp({ label: 'problem', eventTime: 'not a date' }),
            tp({ label: 'normal', eventTime: 'garbage', fromHighlight: 'H' }),
        ];
        expect(validateTestPeriods(old).map(s => s.invalid)).toEqual([false, false, false]);
        expect(testPeriodsError(old)).toBeNull();
        expect(testPeriodsError(LEGACY_TESTS)).toBeNull();
    });
    it('testPeriodsError gives the first problem, in list order', () => {
        expect(testPeriodsError([tp(), tp({ end: '' }), tp({ start: '' })])).toBe('S2 needs an end date.');
        expect(testPeriodsError([tp()])).toBeNull();
        expect(testPeriodsError([])).toBeNull();
    });
});

describe('toTestPeriodsWire / testPeriodsKey', () => {
    it('the wire is start / end ONLY — a legacy label / event time is never sent; invalid periods are dropped', () => {
        const wire = toTestPeriodsWire([
            tp({ label: 'problem', eventTime: '2026-01-10T00:00', fromHighlight: 'H' }),
            tp({ start: '2026-02-01T00:00', end: '2026-02-10T00:00', label: 'normal' }),
            tp({ end: '' }),
        ]);
        expect(wire).toEqual([
            { start: '2026-01-01T00:00', end: '2026-01-31T23:59' },
            { start: '2026-02-01T00:00', end: '2026-02-10T00:00' },
        ]);
        for (const w of wire) expect(Object.keys(w).sort()).toEqual(['end', 'start']);
        expect(JSON.stringify(wire)).not.toMatch(/label|event_time|eventTime|fromHighlight|normal|problem/);
        expect(toTestPeriodsWire(LEGACY_TESTS)).toEqual([
            { start: '2024-01-01T00:00', end: '2024-01-31T23:59' },
            { start: '2024-03-01T00:00', end: '2024-03-31T23:59' },
        ]);
    });
    it('review fix 2026-10-07: testPeriodsWirePlan keeps the ORIGINAL S-number of every period it sends', () => {
        // [S1 invalid, S2 valid] -> only S2 is sent, and it is S2
        const plan = testPeriodsWirePlan([tp({ end: '' }), tp()]);
        expect(plan.wire).toEqual([{ start: '2026-01-01T00:00', end: '2026-01-31T23:59' }]);
        expect(plan.numbers).toEqual([2]);
        expect(toTestPeriodsWire([tp({ end: '' }), tp()])).toEqual(plan.wire);
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

    // Rust numbers a scoring period by its position in the list it RECEIVED; invalid periods are
    // dropped before sending, so the number has to be mapped back to the list the user sees.
    it('scoringIssueTarget maps test_period_<n>_start/_end back to the S-number of the full list', () => {
        // [S1 invalid, S2, S3 invalid, S4] -> sent as [S2, S4]
        const list = [tp({ end: '' }), tp(), tp({ start: 'x' }), tp({ start: '2026-03-01T00:00', end: '2026-03-31T23:59' })];
        const { numbers } = testPeriodsWirePlan(list);
        expect(numbers).toEqual([2, 4]);
        expect(scoringIssueTarget('test_period_1_end', numbers)).toEqual({ wireIndex: 1, number: 2, side: 'end' });
        expect(scoringIssueTarget('test_period_2_start', numbers)).toEqual({ wireIndex: 2, number: 4, side: 'start' });
        // nothing was dropped / no mapping at hand: the wire position is the number
        expect(scoringIssueTarget('test_period_3_end', [1, 2, 3])).toEqual({ wireIndex: 3, number: 3, side: 'end' });
        expect(scoringIssueTarget('test_period_2_start')).toEqual({ wireIndex: 2, number: 2, side: 'start' });
        expect(scoringIssueTarget('test_period_5_end', numbers)?.number).toBe(5); // not covered by the mapping
    });
    it('scoringIssueTarget is null for every other field', () => {
        for (const field of ['lower', 'test_periods', 'test_period_0_end', 'test_period_x_end', 'test_period_1_middle', 'cluster_1', '', null, undefined]) {
            expect(scoringIssueTarget(field as string)).toBeNull();
        }
    });
    it('scoringIssueMessage rewrites the S-number inside Rust own message; other issues are untouched', () => {
        const numbers = [2, 4];
        expect(scoringIssueMessage({ field: 'test_period_1_end', message: 'Scoring period S1 ends before it starts.' }, numbers)).toBe('Scoring period S2 ends before it starts.');
        expect(scoringIssueMessage({ field: 'test_period_2_start', message: "Scoring period S2: the start time '31/12/2026' is not a valid date and time." }, numbers))
            .toBe("Scoring period S4: the start time '31/12/2026' is not a valid date and time.");
        // only the whole token "S1" is rewritten — "S12" elsewhere in the text is left alone
        expect(scoringIssueMessage({ field: 'test_period_1_end', message: 'Scoring period S1 ends before it starts (S12 is fine).' }, [3])).toBe('Scoring period S3 ends before it starts (S12 is fine).');
        expect(scoringIssueMessage({ field: 'test_period_1_end', message: 'Scoring period S1 ends before it starts.' }, [1, 2])).toBe('Scoring period S1 ends before it starts.');
        expect(scoringIssueMessage({ field: 'lower', message: 'L must be below S1.' }, numbers)).toBe('L must be below S1.');
    });

    it('key = start / end in list order; the id and every legacy key are ignored', () => {
        expect(testPeriodsKey([tp()])).toBe(testPeriodsKey([tp({ id: 'x' })]));
        expect(testPeriodsKey(undefined)).toBe(testPeriodsKey([]));
        // what used to count (the label, a Known problem's event time) no longer does:
        expect(testPeriodsKey([tp()])).toBe(testPeriodsKey([tp({ label: 'problem' })]));
        expect(testPeriodsKey([tp({ label: 'normal' })])).toBe(testPeriodsKey([tp({ label: 'problem', eventTime: '2026-01-02T00:00', fromHighlight: 'H' })]));
        // what does count:
        expect(testPeriodsKey([tp()])).not.toBe(testPeriodsKey([tp({ start: '2026-01-02T00:00' })]));
        expect(testPeriodsKey([tp()])).not.toBe(testPeriodsKey([tp({ end: '2026-02-01T00:00' })]));
        expect(testPeriodsKey([tp()])).not.toBe(testPeriodsKey([tp(), tp()]));
        expect(testPeriodsKey([tp()])).not.toBe(testPeriodsKey([]));
        const a = tp({ id: 'a' });
        const b = tp({ id: 'b', start: '2026-03-01T00:00', end: '2026-03-31T23:59' });
        expect(testPeriodsKey([a, b])).not.toBe(testPeriodsKey([b, a])); // S1/S2 swapped = different results order
        expect(testPeriodsKey([tp()])).not.toMatch(/label|eventTime/);
    });
});

describe('scoring-vs-train overlap (a quiet note, never a block)', () => {
    const train = [per('2026-01-01T00:00', '2026-01-11T00:00', 'a'), per('2026-01-06T00:00', '2026-01-16T00:00', 'b'), per('2026-03-01T00:00', '2026-03-31T00:00', 'c')];
    it('periodsOverlap: inclusive bounds, open ends unbounded, invalid never overlaps', () => {
        expect(periodsOverlap(per('2026-01-01T00:00', '2026-01-02T00:00'), per('2026-01-02T00:00', '2026-01-03T00:00'))).toBe(true);
        expect(periodsOverlap(per('2026-01-01T00:00', '2026-01-02T00:00'), per('2026-01-02T00:01', '2026-01-03T00:00'))).toBe(false);
        expect(periodsOverlap(per('', ''), per('2030-01-01T00:00', '2030-01-02T00:00'))).toBe(true);
        expect(periodsOverlap(per('x', ''), per('', ''))).toBe(false);
    });
    it('testTrainOverlaps lists the 1-based train periods each scoring period overlaps', () => {
        expect(testTrainOverlaps(train, [tp(), tp({ start: '2026-02-01T00:00', end: '2026-02-10T00:00' })])).toEqual([[1, 2], []]);
    });
    it('trainOverlapDays merges overlapping train periods (no double count) and clips open ends to the bounds', () => {
        // Train covers Jan 1 – Jan 16 inside a scoring period of Jan 1 – Jan 31 -> 15 days.
        expect(trainOverlapDays(train, tp())).toBe(15);
        expect(trainOverlapDays(train, tp({ start: '2026-02-01T00:00', end: '2026-02-10T00:00' }))).toBe(0);
        expect(trainOverlapDays([per('', '')], tp({ start: '2026-01-01T00:00', end: '2026-01-11T00:00' }))).toBe(10);
        expect(trainOverlapDays([per('', '')], tp(), { min: '2026-01-21T00:00', max: '2027-01-01T00:00' })).toBe(11);
        expect(trainOverlapDays(train, tp({ end: '' }))).toBe(0);
    });
    it('the note text names the period S<n>; the days stay raw running time, the results are per HOUR', () => {
        // Health score on 1-hour averages: a result is an hourly point, so the note says
        // "hours the model was trained on" (it said "rows" while every row was scored).
        expect(testIncludesTrainNote(0, 12)).toBe('S1 includes 12 d of train running time — results include hours the model was trained on');
        expect(testIncludesTrainNote(2, 15)).toMatch(/^S3 includes 15 d of train running time/);
        expect(testIncludesTrainNote(0, 12)).not.toMatch(/rows/);
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

describe('"scoring periods changed" banners (SPEC rule 8)', () => {
    const fg = (over: Partial<FailureGroupStateSlice> = {}): FailureGroupStateSlice => ({ groups: [], models: [], runningConditionTestPeriods: [tp()], ...over });
    const stamped = (over = {}) => mk({ id: 'a', status: false, testsChangedAt: '2026-10-07T00:00:00Z', ...over });

    it('per model: changed / removed / nothing', () => {
        expect(testsChangedState(stamped(), fg())).toBe('changed');
        expect(testsChangedState(stamped(), fg({ runningConditionTestPeriods: [] }))).toBe('removed');
        expect(testsChangedState(stamped({ runningConditionMode: 'custom', customTestPeriods: [] }), fg())).toBe('removed');
        expect(testsChangedState(stamped({ status: true }), fg())).toBeNull();
        expect(testsChangedState(mk({ id: 'b' }), fg())).toBeNull();
        expect(testsChangedBannerText('changed')).toBe('Scoring periods changed — re-scored with the same trained model. Mark complete again to save the new results.');
        expect(testsChangedBannerText('removed')).toBe('Scoring periods removed — add at least one scoring period, then Mark complete again. The model was not re-trained.');
    });

    it('an old workspace (periods still carrying label / event time) reads exactly like a new one', () => {
        expect(testsChangedState(stamped(), fg({ runningConditionTestPeriods: LEGACY_TESTS }))).toBe('changed');
        expect(testsChangedState(mk({ id: 'c', status: true }), fg({ runningConditionTestPeriods: LEGACY_TESTS }))).toBeNull();
        expect(testsChangedNotice([mk({ id: 'c', status: true })], fg({ runningConditionTestPeriods: LEGACY_TESTS }))).toBeNull();
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
        // Workbench redesign §5 "After Apply": the reworded notice says they were re-scored, not re-trained.
        expect(testsChangedNoticeText(n!)).toBe('Scoring periods changed — 2 complete models need Mark complete again. They were re-scored with the same trained model, not re-trained.');
        expect(testsChangedNoticeText({ count: 1, allRemoved: false })).toBe('Scoring periods changed — 1 complete model needs Mark complete again. It was re-scored with the same trained model, not re-trained.');
        const r = testsChangedNotice([stamped()], fg({ runningConditionTestPeriods: [] }));
        expect(r).toEqual({ count: 1, allRemoved: true });
        // every scoring period removed: nothing was re-scored, so the notice does not claim it
        expect(testsChangedNoticeText(r!)).toBe('Scoring periods removed — 1 complete model needs a scoring period and Mark complete again. It was not re-trained.');
        expect(testsChangedNoticeText({ count: 3, allRemoved: true })).toBe('Scoring periods removed — 3 complete models need a scoring period and Mark complete again. They were not re-trained.');
    });
    it('the notice in two parts (bold headline + one sentence); the text is exactly "headline. rest"', () => {
        expect(testsChangedNoticeParts({ count: 3, allRemoved: false })).toEqual({
            headline: 'Scoring periods changed — 3 complete models need Mark complete again',
            rest: 'They were re-scored with the same trained model, not re-trained.',
        });
        for (const n of [{ count: 1, allRemoved: false }, { count: 4, allRemoved: true }]) {
            const parts = testsChangedNoticeParts(n);
            expect(testsChangedNoticeText(n)).toBe(`${parts.headline}. ${parts.rest}`);
            expect(parts.headline).not.toMatch(/\.$/);
        }
    });
});

describe('the health score could not be calculated (warning test_scoring_failed, review fix 2026-10-07)', () => {
    it('the headlines say the HEALTH SCORE could not be calculated - the Relation model is predicted per hour, training hours included', () => {
        // Since the score is computed on 1-hour averages a failed engine run hides the whole
        // score of a Relation model, not only its scoring periods (and can happen with none).
        expect(TEST_SCORING_FAILED_TEXT).toBe('The health score could not be calculated — try again');
        expect(TEST_SCORING_OUTDATED_TEXT).toBe('The health score could not be calculated');
        expect(TEST_SCORING_FAILED_TEXT).toBe(`${TEST_SCORING_OUTDATED_TEXT} — try again`);
        for (const t of [TEST_SCORING_FAILED_TEXT, TEST_SCORING_OUTDATED_TEXT]) expect(t).not.toMatch(/scoring periods|could not be scored/i);
        // The engine run covers the training hours too, so the hint no longer says "these periods".
        expect(SLOW_TEST_SCORING_TEXT).toBe('Calculating the health score with the Relation model — this can take up to ~15 s.');
        expect(SLOW_TEST_SCORING_TEXT).not.toMatch(/these periods/i);
        for (const t of [TEST_SCORING_FAILED_TEXT, TEST_SCORING_OUTDATED_TEXT, SLOW_TEST_SCORING_TEXT]) expect(t).not.toMatch(/test period|LinearGAM/i);
    });

    it('the warning is found on a preview that has NO scoring period too (no test_validation to carry it)', () => {
        const issue = { code: TEST_SCORING_FAILED_CODE, severity: 'warning' as const, field: 'test_periods', message: 'The health score could not be calculated…' };
        const preview = { validation: [issue], test_validation: null };
        expect(testScoringFailure(preview)).toBe(issue);
        expect(isTestScoringRetryable(issue)).toBe(true);
    });

    it('finds the warning among the preview issues, null otherwise', () => {
        const issue = { code: TEST_SCORING_FAILED_CODE, severity: 'warning' as const, field: 'test_periods', message: 'x' };
        expect(testScoringFailure({ validation: [{ code: 'required', severity: 'error', field: 'lower', message: '' }, issue] })).toBe(issue);
        expect(testScoringFailure({ validation: [] })).toBeNull();
        expect(testScoringFailure(null)).toBeNull();
    });

    it('also finds test_scoring_outdated; only test_scoring_failed is retryable', () => {
        const outdated = { code: TEST_SCORING_OUTDATED_CODE, severity: 'warning' as const, field: 'test_periods', message: 'x' };
        expect(testScoringFailure({ validation: [outdated] })).toBe(outdated);
        expect(isTestScoringRetryable(outdated)).toBe(false);
        expect(isTestScoringRetryable({ code: TEST_SCORING_FAILED_CODE })).toBe(true);
        const tooLarge = { code: TEST_SCORING_TOO_LARGE_CODE, severity: 'warning' as const, field: 'test_periods', message: 'x' };
        expect(testScoringFailure({ validation: [tooLarge] })).toBe(tooLarge);
        expect(isTestScoringRetryable(tooLarge)).toBe(false);
    });
});
