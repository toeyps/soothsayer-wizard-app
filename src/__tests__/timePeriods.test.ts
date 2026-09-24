import { describe, it, expect } from 'vitest';
import type { TimePeriod } from '../types';
import {
    validatePeriods, sortPeriods, mergeOverlapping, nextDefaultPeriod,
    isRangeFullyCovered, periodChipLabel, toFilterRanges,
} from '../utils/timePeriods';

const p = (id: string, start: string, end: string): TimePeriod => ({ id, start, end });

describe('validatePeriods', () => {
    it('empty list -> []', () => expect(validatePeriods([])).toEqual([]));
    it('accepts a fully open single period', () => {
        expect(validatePeriods([p('a', '', '')])).toEqual([{ invalid: false, reason: undefined, overlapsPrev: false }]);
    });
    it('open start only on first, open end only on last', () => {
        const s = validatePeriods([p('a', '2025-01-01T00:00', ''), p('b', '', '2025-02-01T00:00')]);
        expect(s[0].invalid).toBe(true);
        expect(s[0].reason).toMatch(/Period 1 needs an end/);
        expect(s[1].invalid).toBe(true);
        expect(s[1].reason).toMatch(/Period 2 needs a start/);
    });
    it('end before start is invalid; equal is fine', () => {
        expect(validatePeriods([p('a', '2025-02-01T00:00', '2025-01-01T00:00')])[0]).toMatchObject({ invalid: true, reason: 'Period 1 ends before it starts.' });
        expect(validatePeriods([p('a', '2025-01-01T00:00', '2025-01-01T00:00')])[0].invalid).toBe(false);
    });
    it('unparseable bound is invalid', () => {
        expect(validatePeriods([p('a', 'garbage', '')])[0].invalid).toBe(true);
        expect(validatePeriods([p('a', '', 'nope')])[0].invalid).toBe(true);
    });
    it('flags overlap with the previous period', () => {
        const s = validatePeriods([p('a', '2025-01-01T00:00', '2025-01-31T23:59'), p('b', '2025-01-15T00:00', '2025-02-15T00:00')]);
        expect(s.map((x) => x.overlapsPrev)).toEqual([false, true]);
    });
    it('adjacent (touching or next-day) periods are not overlaps', () => {
        const touch = validatePeriods([p('a', '2025-01-01T00:00', '2025-01-10T00:00'), p('b', '2025-01-10T00:00', '2025-01-20T00:00')]);
        expect(touch[1].overlapsPrev).toBe(false);
        const nextDay = validatePeriods([p('a', '2025-01-01T00:00', '2025-01-31T23:59'), p('b', '2025-02-01T00:00', '2025-02-28T23:59')]);
        expect(nextDay[1].overlapsPrev).toBe(false);
    });
    it('does not report overlap against an invalid previous period', () => {
        const s = validatePeriods([p('a', '2025-02-01T00:00', '2025-01-01T00:00'), p('b', '2025-01-15T00:00', '2025-03-01T00:00')]);
        expect(s[0].invalid).toBe(true);
        expect(s[1].overlapsPrev).toBe(false);
    });
});

describe('sortPeriods', () => {
    it('sorts by start, open start first, unparseable last, without mutating', () => {
        const list = [p('c', 'bad', ''), p('b', '2025-03-01T00:00', '2025-04-01T00:00'), p('a', '2025-01-01T00:00', '2025-02-01T00:00'), p('o', '', '2024-12-01T00:00')];
        const out = sortPeriods(list);
        expect(out.map((x) => x.id)).toEqual(['o', 'a', 'b', 'c']);
        expect(list[0].id).toBe('c');
    });
    it('is stable and handles []', () => {
        expect(sortPeriods([])).toEqual([]);
        expect(sortPeriods([p('x', '2025-01-01T00:00', ''), p('y', '2025-01-01T00:00', '')]).map((q) => q.id)).toEqual(['x', 'y']);
    });
});

describe('mergeOverlapping', () => {
    it('takes earliest start and latest end, keeps a id', () => {
        expect(mergeOverlapping(p('a', '2025-01-05T00:00', '2025-01-20T00:00'), p('b', '2025-01-01T00:00', '2025-01-10T00:00')))
            .toEqual(p('a', '2025-01-01T00:00', '2025-01-20T00:00'));
    });
    it('an open bound wins', () => {
        expect(mergeOverlapping(p('a', '', '2025-01-20T00:00'), p('b', '2025-01-01T00:00', ''))).toEqual(p('a', '', ''));
    });
    it('contained period collapses to the outer one', () => {
        expect(mergeOverlapping(p('a', '2025-01-01T00:00', '2025-03-01T00:00'), p('b', '2025-02-01T00:00', '2025-02-05T00:00')))
            .toEqual(p('a', '2025-01-01T00:00', '2025-03-01T00:00'));
    });
});

describe('nextDefaultPeriod', () => {
    it('empty list -> one fully open period', () => {
        expect(nextDefaultPeriod([])).toMatchObject({ start: '', end: '' });
    });
    it('starts the day after the last end and runs to month end 23:59', () => {
        const r = nextDefaultPeriod([p('a', '2025-01-01T00:00', '2025-01-10T12:00')]);
        expect(r).toMatchObject({ start: '2025-01-11T00:00', end: '2025-01-31T23:59' });
    });
    it('rolls into the next month/year at month end', () => {
        expect(nextDefaultPeriod([p('a', '2025-01-01T00:00', '2025-01-31T23:59')])).toMatchObject({ start: '2025-02-01T00:00', end: '2025-02-28T23:59' });
        expect(nextDefaultPeriod([p('a', '2024-12-01T00:00', '2024-12-31T23:59')])).toMatchObject({ start: '2025-01-01T00:00', end: '2025-01-31T23:59' });
    });
    it('clamps to dataset max, and returns null once past it', () => {
        expect(nextDefaultPeriod([p('a', '2025-01-01T00:00', '2025-01-10T00:00')], '2025-01-20T08:00')).toMatchObject({ end: '2025-01-20T08:00' });
        expect(nextDefaultPeriod([p('a', '2025-01-01T00:00', '2025-01-31T23:59')], '2025-01-31T23:59')).toBeNull();
    });
    it('null when the last period is open-ended or invalid', () => {
        expect(nextDefaultPeriod([p('a', '2025-01-01T00:00', '')])).toBeNull();
        expect(nextDefaultPeriod([p('a', '2025-01-01T00:00', 'bad')])).toBeNull();
    });
    it('generates unique ids', () => {
        expect(nextDefaultPeriod([])!.id).not.toBe(nextDefaultPeriod([])!.id);
    });
});

describe('isRangeFullyCovered', () => {
    const bounds = { min: '2025-01-01T00:00', max: '2025-03-31T23:59' };
    it('false for empty list or missing bounds', () => {
        expect(isRangeFullyCovered([], bounds)).toBe(false);
        expect(isRangeFullyCovered([p('a', '', '')], null)).toBe(false);
    });
    it('a fully open period covers everything', () => {
        expect(isRangeFullyCovered([p('a', '', '')], bounds)).toBe(true);
    });
    it('contiguous periods (23:59 -> 00:00) cover; a real gap does not', () => {
        const contiguous = [p('a', '2025-01-01T00:00', '2025-01-31T23:59'), p('b', '2025-02-01T00:00', '2025-03-31T23:59')];
        expect(isRangeFullyCovered(contiguous, bounds)).toBe(true);
        const gap = [p('a', '2025-01-01T00:00', '2025-01-31T23:59'), p('b', '2025-02-05T00:00', '2025-03-31T23:59')];
        expect(isRangeFullyCovered(gap, bounds)).toBe(false);
    });
    it('does not cover when the start or end is short; ignores invalid periods; order-independent', () => {
        expect(isRangeFullyCovered([p('a', '2025-01-02T00:00', '')], bounds)).toBe(false);
        expect(isRangeFullyCovered([p('a', '', '2025-03-30T00:00')], bounds)).toBe(false);
        expect(isRangeFullyCovered([p('a', '2025-06-01T00:00', '2025-01-01T00:00')], bounds)).toBe(false);
        const shuffled = [p('b', '2025-02-01T00:00', ''), p('a', '', '2025-01-31T23:59')];
        expect(isRangeFullyCovered(shuffled, bounds)).toBe(true);
    });
    it('overlapping periods still cover', () => {
        expect(isRangeFullyCovered([p('a', '', '2025-02-15T00:00'), p('b', '2025-02-01T00:00', '')], bounds)).toBe(true);
    });
});

describe('periodChipLabel', () => {
    it('shows dates only for whole-day ranges', () => {
        expect(periodChipLabel(p('a', '2025-01-01T00:00', '2025-01-31T23:59'))).toBe('2025-01-01 – 2025-01-31');
    });
    it('shows times when not whole days', () => {
        expect(periodChipLabel(p('a', '2025-01-01T08:30', '2025-01-31T23:59'))).toBe('2025-01-01 08:30 – 2025-01-31 23:59');
    });
    it('names open ends', () => {
        expect(periodChipLabel(p('a', '', ''))).toBe('Start of data – End of data');
        expect(periodChipLabel(p('a', '2025-01-01T00:00', ''))).toBe('2025-01-01 – End of data');
    });
});

describe('toFilterRanges', () => {
    it('maps empty strings to null', () => {
        expect(toFilterRanges([p('a', '', '2025-01-31T00:00'), p('b', '2025-02-01T00:00', '')])).toEqual([
            { start: null, end: '2025-01-31T00:00' },
            { start: '2025-02-01T00:00', end: null },
        ]);
    });
    it('drops invalid periods, [] for empty list', () => {
        expect(toFilterRanges([])).toEqual([]);
        expect(toFilterRanges([p('a', '2025-02-01T00:00', '2025-01-01T00:00'), p('b', '2025-03-01T00:00', '2025-03-05T00:00')]))
            .toEqual([{ start: '2025-03-01T00:00', end: '2025-03-05T00:00' }]);
    });
    it('keeps overlapping periods as-is (Rust merges)', () => {
        expect(toFilterRanges([p('a', '2025-01-01T00:00', '2025-02-01T00:00'), p('b', '2025-01-15T00:00', '2025-03-01T00:00')])).toHaveLength(2);
    });
});
