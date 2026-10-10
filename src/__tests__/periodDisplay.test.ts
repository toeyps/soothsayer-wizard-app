import { describe, it, expect } from 'vitest';
import {
    computeCoverage, computeTestCoverage, conditionChipParts, conditionSymbol, formatDate, formatPeriod, formatDataStamp, formatPeriodChip, formatStamp, isCompleteDateInput, overlapDays, periodDays, settleDateInput,
} from '../components/windows/periodDisplay';
import type { TestPeriod, WorkspaceSensorFilter } from '../types';

// Dataset of the approved mockup: 1 Jan 2025 00:00 - 31 Mar 2026 23:50 = 455 days.
const B = { min: '2025-01-01 00:00:00', max: '2026-03-31 23:50:00' };
const p = (id: string, start: string, end: string) => ({ id, start, end });
const f = (sensor: string, operation: WorkspaceSensorFilter['operation'], value1: string, value2 = ''): WorkspaceSensorFilter =>
    ({ id: `f-${sensor}`, sensor, operation, value1, value2 });

// What the period editors commit while a date is being typed (review of a4acd7a, items 2 + 3).
describe('isCompleteDateInput / settleDateInput (typing a date in a period row)', () => {
    it('a complete datetime-local value is complete (seconds allowed)', () => {
        expect(isCompleteDateInput('2026-02-09T23:50')).toBe(true);
        expect(isCompleteDateInput('2026-02-09T23:50:30')).toBe(true);
        expect(isCompleteDateInput(' 2026-02-09T23:50 ')).toBe(true);
    });
    it('"" (what the field reports while a segment is missing), null and text that is not a date-time are not', () => {
        expect(isCompleteDateInput('')).toBe(false);
        expect(isCompleteDateInput('   ')).toBe(false);
        expect(isCompleteDateInput(null)).toBe(false);
        expect(isCompleteDateInput(undefined)).toBe(false);
        expect(isCompleteDateInput('2026-02-09')).toBe(false); // a date without its time
        expect(isCompleteDateInput('nope')).toBe(false);
        expect(isCompleteDateInput('2026-13-45T99:99')).toBe(false); // the right shape, not a date
    });
    it('a year still being typed (the field reports 0002, 0020, 0202 on the way to 2026) is not complete', () => {
        for (const v of ['0002-02-09T23:50', '0020-02-09T23:50', '0202-02-09T23:50']) expect(isCompleteDateInput(v)).toBe(false);
        expect(isCompleteDateInput('1000-01-01T00:00')).toBe(true);
        expect(isCompleteDateInput('2026-02-09T23:50')).toBe(true);
    });

    it('settleDateInput: a bound that was SET is never emptied by typing — the committed date comes back', () => {
        expect(settleDateInput('', '2026-01-01T00:00')).toBe('2026-01-01T00:00');
        expect(settleDateInput('   ', '2026-01-01T00:00')).toBe('2026-01-01T00:00');
        expect(settleDateInput('not a date', '2026-01-01T00:00')).toBe('2026-01-01T00:00');
    });
    it('settleDateInput: a readable typed date is kept (also one that was still pending on change), and nothing changes when nothing was typed', () => {
        expect(settleDateInput('2026-03-01T00:00', '2026-01-01T00:00')).toBe('2026-03-01T00:00');
        expect(settleDateInput('0202-03-01T00:00', '2026-01-01T00:00')).toBe('0202-03-01T00:00');
        expect(settleDateInput('2026-01-01T00:00', '2026-01-01T00:00')).toBe('2026-01-01T00:00');
        expect(settleDateInput('nope', 'nope')).toBe('nope'); // an unreadable date already on disk is not "fixed" by a blur
    });
    it('settleDateInput: a bound that was already blank stays as typed (there is no date to put back)', () => {
        expect(settleDateInput('', '')).toBe('');
        expect(settleDateInput('', null)).toBe('');
        expect(settleDateInput('', undefined)).toBe('');
    });
});

describe('formatPeriod (chip / row label)', () => {
    it('whole days in one year: year once, at the end', () => {
        expect(formatPeriod(p('a', '2025-01-01T00:00', '2025-02-28T23:59'))).toBe('1 Jan – 28 Feb 2025');
    });
    it('whole days across years: year on both sides', () => {
        expect(formatPeriod(p('a', '2025-11-01T00:00', '2026-01-15T23:59'))).toBe('1 Nov 2025 – 15 Jan 2026');
    });
    it('a side that is not a whole day shows date + time on both sides', () => {
        expect(formatPeriod(p('a', '2025-11-03T06:00', '2025-12-19T18:00'))).toBe('3 Nov 2025 06:00 – 19 Dec 2025 18:00');
    });
    it('open ends read "Start of data" / "end of data"; both open reads "All data"', () => {
        expect(formatPeriod(p('a', '', '2025-02-28T23:59'))).toBe('Start of data – 28 Feb 2025');
        expect(formatPeriod(p('a', '2025-11-01T00:00', ''))).toBe('1 Nov 2025 – end of data');
        expect(formatPeriod(p('a', '', ''))).toBe('All data');
    });
    // Workbench redesign §1: ONE date-and-time format in the Workbench.
    it('formatStamp is "9 Feb 2026 23:50": day, short month, year, 24-hour time, no seconds — for CSV text, datetime-local, ISO and epoch ms', () => {
        expect(formatStamp('2026-02-09 23:50:00')).toBe('9 Feb 2026 23:50');
        expect(formatStamp('2026-02-09T23:50')).toBe('9 Feb 2026 23:50');
        expect(formatStamp('2026-10-08T14:22:31')).toBe('8 Oct 2026 14:22');
        expect(formatStamp('2026-01-01')).toBe('1 Jan 2026 00:00');
        expect(formatStamp(new Date(2026, 1, 9, 5, 7).getTime())).toBe('9 Feb 2026 05:07');
        // a UTC instant is shown in local time, in the same shape
        expect(formatStamp('2026-10-04T01:00:00.000Z')).toMatch(/^[34] Oct 2026 \d{2}:\d{2}$/);
        // never a locale form
        expect(formatStamp('2026-10-08T14:22:31')).not.toMatch(/PM|AM|,/);
    });

    // A CSV row's time is DATA: printed from its own wall-clock parts, never through a Date.
    it('formatDataStamp: the same "9 Feb 2026 23:50" shape, from the text itself — an offset or Z never shifts it', () => {
        expect(formatDataStamp('2026-02-09 23:50:00')).toBe('9 Feb 2026 23:50');
        expect(formatDataStamp('2026-02-09T23:50')).toBe('9 Feb 2026 23:50');
        expect(formatDataStamp('2026-02-09')).toBe('9 Feb 2026 00:00');
        expect(formatDataStamp('2026/2/9 5:07')).toBe('9 Feb 2026 05:07');
        expect(formatDataStamp(' 2026-02-09 23:50:00 ')).toBe('9 Feb 2026 23:50');
        // would read 16:50 / the next day on a PC in another zone if it went through `new Date`
        expect(formatDataStamp('2026-02-09T23:50:00+07:00')).toBe('9 Feb 2026 23:50');
        expect(formatDataStamp('2026-02-09T23:50:00-0800')).toBe('9 Feb 2026 23:50');
        expect(formatDataStamp('2026-02-09T23:50:00.000Z')).toBe('9 Feb 2026 23:50');
        expect(formatDataStamp('2026-12-31T23:59:59+14:00')).toBe('31 Dec 2026 23:59');
    });

    it('formatDataStamp shows seconds only when asked AND they are not zero', () => {
        expect(formatDataStamp('2026-02-09 23:50:07')).toBe('9 Feb 2026 23:50');
        expect(formatDataStamp('2026-02-09 23:50:07', { seconds: true })).toBe('9 Feb 2026 23:50:07');
        expect(formatDataStamp('2026-02-09 23:50:07.250', { seconds: true })).toBe('9 Feb 2026 23:50:07');
        expect(formatDataStamp('2026-02-09 23:50:00', { seconds: true })).toBe('9 Feb 2026 23:50');
        expect(formatDataStamp('2026-02-09T23:50:07+07:00', { seconds: true })).toBe('9 Feb 2026 23:50:07');
        expect(formatDataStamp('2026-02-09T23:50', { seconds: true })).toBe('9 Feb 2026 23:50');
    });

    it('formatDataStamp: text in another shape is read as local time; text that is not a date stays; "—" for nothing', () => {
        expect(formatDataStamp('Feb 9, 2026 23:50:07')).toBe('9 Feb 2026 23:50');
        expect(formatDataStamp('Feb 9, 2026 23:50:07', { seconds: true })).toBe('9 Feb 2026 23:50:07');
        expect(formatDataStamp('2026-13-40 00:00')).toBe('2026-13-40 00:00'); // not a real month: as it is
        expect(formatDataStamp('row 12')).toBe('row 12');
        expect(formatDataStamp('')).toBe('');
        expect(formatDataStamp(null)).toBe('—');
        expect(formatDataStamp(undefined)).toBe('—');
    });

    it('formatStamp leaves text that is not a date as it is, and "—" for nothing', () => {
        expect(formatStamp('row 12')).toBe('row 12');
        expect(formatStamp('')).toBe('');
        expect(formatStamp(null)).toBe('—');
        expect(formatStamp(undefined)).toBe('—');
        expect(formatStamp(Number.NaN)).toBe('—');
    });

    it('formatDate is a single bound with year', () => {
        expect(formatDate('2025-06-01T00:00')).toBe('1 Jun 2025');
    });
});

describe('periodDays / overlapDays', () => {
    it('rounds the span to whole days (00:00 -> 23:59 of the last day counts that day)', () => {
        expect(periodDays(p('a', '2025-01-01T00:00', '2025-02-28T23:59'), B)).toBe(59);
    });
    it('open ends resolve to the dataset bounds; null when they are unknown or the period is reversed', () => {
        expect(periodDays(p('a', '', '2025-01-11T00:00'), B)).toBe(10);
        expect(periodDays(p('a', '', '2025-01-11T00:00'), null)).toBeNull();
        expect(periodDays(p('a', '2025-02-01T00:00', '2025-01-01T00:00'), B)).toBeNull();
    });
    it('overlap is measured against the previous period, minimum 1 day', () => {
        expect(overlapDays(p('a', '2026-01-01T00:00', '2026-01-31T23:59'), p('b', '2026-01-20T00:00', '2026-02-10T00:00'), B)).toBe(12);
        expect(overlapDays(p('a', '2026-01-01T00:00', '2026-01-31T23:59'), p('b', '2026-01-31T12:00', '2026-02-10T00:00'), B)).toBe(1);
    });
});

describe('computeCoverage', () => {
    it('is null while the dataset bounds are unknown', () => {
        expect(computeCoverage([p('a', '2025-01-01T00:00', '2025-02-01T00:00')], null)).toBeNull();
        expect(computeCoverage([], { min: null, max: null })).toBeNull();
    });

    it('the approved mockup example: 3 periods are "166 of 455 days used", axis Jan 2025 - Mar 2026', () => {
        const c = computeCoverage([
            p('a', '2025-01-01T00:00', '2025-02-28T23:59'),
            p('b', '2025-06-01T00:00', '2025-07-31T23:59'),
            p('c', '2025-11-03T06:00', '2025-12-19T18:00'),
        ], B)!;
        expect(c.totalDays).toBe(455);
        expect(c.usedDays).toBe(166);
        expect(c.unlimited).toBe(false);
        expect(c.axisLeft).toBe('Jan 2025');
        expect(c.axisRight).toBe('Mar 2026');
        expect(c.segments).toHaveLength(3);
        expect(c.segments.every(s => s.kind === 'ok')).toBe(true);
        // First block starts at the very left and is 59/455 wide.
        expect(c.segments[0].leftPct).toBeCloseTo(0, 5);
        expect(c.segments[0].widthPct).toBeCloseTo((59 / 455) * 100, 0);
    });

    it('overlapping periods count their union once and the later block is flagged "ovl"', () => {
        const c = computeCoverage([p('a', '2025-01-01T00:00', '2025-02-28T23:59'), p('b', '2025-02-15T00:00', '2025-03-31T23:59')], B)!;
        expect(c.usedDays).toBe(90); // 1 Jan -> 31 Mar, NOT 59 + 45
        expect(c.segments.map(s => s.kind)).toEqual(['ok', 'ovl']);
    });

    it('touching periods add up (no double count, no gap)', () => {
        const c = computeCoverage([p('a', '2025-01-01T00:00', '2025-01-31T23:59'), p('b', '2025-02-01T00:00', '2025-02-28T23:59')], B)!;
        expect(c.usedDays).toBe(59);
    });

    it('a reversed period is drawn red but NOT counted', () => {
        const c = computeCoverage([p('a', '2025-01-01T00:00', '2025-01-31T23:59'), p('b', '2025-06-01T00:00', '2025-05-20T23:59')], B)!;
        expect(c.usedDays).toBe(31);
        expect(c.segments.map(s => s.kind)).toEqual(['ok', 'bad']);
    });

    it('open ends run to the dataset edge; periods beyond the dataset are clamped', () => {
        const open = computeCoverage([p('a', '', '2025-01-11T00:00'), p('b', '2026-03-21T00:00', '')], B)!;
        expect(open.usedDays).toBe(21); // 10 d at the start + 10.99 d at the end (21 Mar -> 31 Mar 23:50), rounded once
        const wide = computeCoverage([p('a', '2024-01-01T00:00', '2030-01-01T00:00')], B)!;
        expect(wide.usedDays).toBe(455);
        expect(wide.segments[0].leftPct).toBe(0);
        expect(wide.segments[0].widthPct).toBeLessThanOrEqual(100);
    });

    it('no periods means everything is used: unlimited, one full-width block', () => {
        const c = computeCoverage([], B)!;
        expect(c.unlimited).toBe(true);
        expect(c.usedDays).toBe(c.totalDays);
        expect(c.segments).toEqual([expect.objectContaining({ leftPct: 0, widthPct: 100 })]);
    });
});

describe('computeTestCoverage (scoring periods on the timeline — "just score it", 2026-10-10)', () => {
    it('one segment per scoring period, named S1, S2 … by list position; overlapping days are counted once', () => {
        const c = computeTestCoverage([p('a', '2025-01-01T00:00', '2025-01-31T00:00'), p('b', '2025-01-21T00:00', '2025-02-10T00:00')], B)!;
        expect(c.segments.map(s => s.label)).toEqual([
            'S1 · 1 Jan 2025 00:00 – 31 Jan 2025 00:00',
            'S2 · 21 Jan 2025 00:00 – 10 Feb 2025 00:00',
        ]);
        expect(c.usedDays).toBe(40); // 1 Jan -> 10 Feb, the 10 shared days once
        expect(c.segments[0].leftPct).toBe(0);
    });

    it('a segment is geometry and a label only — a legacy label / event time changes nothing', () => {
        const plain = computeTestCoverage([p('a', '2025-03-01T00:00', '2025-03-11T00:00')], B)!;
        const old: TestPeriod = { ...p('a', '2025-03-01T00:00', '2025-03-11T00:00'), label: 'problem', eventTime: '2025-03-05T00:00', fromHighlight: 'Trip' };
        const legacy = computeTestCoverage([old], B)!;
        expect(legacy).toEqual(plain);
        expect(Object.keys(plain.segments[0]).sort()).toEqual(['label', 'leftPct', 'widthPct']);
        expect(plain.segments[0].label).not.toMatch(/Known problem|Normal/);
    });

    it('an unparseable or reversed period draws nothing but keeps its number for the others; unknown bounds = null', () => {
        const c = computeTestCoverage([p('bad', '2025-02-10T00:00', '2025-02-01T00:00'), p('ok', '2025-03-01T00:00', '2025-03-11T00:00')], B)!;
        expect(c.segments.map(s => s.label)).toEqual(['S2 · 1 Mar 2025 00:00 – 11 Mar 2025 00:00']);
        expect(c.usedDays).toBe(10);
        expect(computeTestCoverage([p('a', '2025-03-01T00:00', '2025-03-11T00:00')], null)).toBeNull();
    });
});

describe('condition symbols', () => {
    it('maps each operator to its symbol', () => {
        expect(['greater_than', 'less_than', 'between', 'equals'].map(o => conditionSymbol(o as WorkspaceSensorFilter['operation'])))
            .toEqual(['>', '<', 'between', '=']);
    });
});

describe('formatPeriodChip (Step-1 card / summary sentence)', () => {
    it('whole days: "1 Jan 2026 → 31 Mar 2026" - the year on BOTH sides, even inside one year', () => {
        expect(formatPeriodChip(p('a', '2026-01-01T00:00', '2026-03-31T23:59'))).toBe('1 Jan 2026 → 31 Mar 2026');
    });
    it('open ends read Start / End; both open reads "Whole dataset"', () => {
        expect(formatPeriodChip(p('a', '', '2026-03-31T23:59'))).toBe('Start → 31 Mar 2026');
        expect(formatPeriodChip(p('a', '2026-04-15T00:00', ''))).toBe('15 Apr 2026 → End');
        expect(formatPeriodChip(p('a', '', ''))).toBe('Whole dataset');
    });
    it('a side that is not a day boundary (start 00:00 / end 23:59) also shows its time', () => {
        expect(formatPeriodChip(p('a', '2025-11-03T06:00', '2025-12-19T18:00'))).toBe('3 Nov 2025 06:00 → 19 Dec 2025 18:00');
        expect(formatPeriodChip(p('a', '2025-11-03T00:00', '2025-12-19T18:00'))).toBe('3 Nov 2025 → 19 Dec 2025 18:00');
    });
    it('date-only text counts as local midnight; unparseable text is shown as typed', () => {
        expect(formatPeriodChip(p('a', '2026-01-01', '2026-02-01T23:59'))).toBe('1 Jan 2026 → 1 Feb 2026');
        expect(formatPeriodChip(p('a', 'garbage', '2026-02-01T23:59'))).toBe('garbage → 1 Feb 2026');
    });
});

describe('conditionChipParts (Step-1 card / summary sentence)', () => {
    const desc = (t: string) => ({ POWER: 'GENERATOR ACTIVE POWER' } as Record<string, string>)[t] ?? '';
    const unit = (t: string) => ({ POWER: 'kW' } as Record<string, string>)[t] ?? '';

    it('name (description) and "> 4000 kW": symbol, value, unit', () => {
        expect(conditionChipParts(f('POWER', 'greater_than', '4000'), desc, unit)).toEqual({ name: 'GENERATOR ACTIVE POWER', rest: '> 4,000 kW' });
        expect(conditionChipParts(f('POWER', 'less_than', '12'), desc, unit).rest).toBe('< 12 kW');
        expect(conditionChipParts(f('POWER', 'equals', '3'), desc, unit).rest).toBe('= 3 kW');
    });
    it('between shows both bounds with one unit', () => {
        expect(conditionChipParts(f('POWER', 'between', '1', '5'), desc, unit).rest).toBe('between 1–5 kW');
    });
    it('a typed threshold keeps every decimal the user typed (separators only, never rounded to 0)', () => {
        expect(conditionChipParts(f('POWER', 'greater_than', '0.0005'), desc, unit).rest).toBe('> 0.0005 kW');
        expect(conditionChipParts(f('POWER', 'between', '0.0001', '0.0004'), desc, unit).rest).toBe('between 0.0001–0.0004 kW');
        expect(conditionChipParts(f('POWER', 'less_than', '12345.6789'), desc, unit).rest).toBe('< 12,345.6789 kW');
    });
    it('no description falls back to the tag; no unit leaves it out; label/unit callbacks are optional', () => {
        expect(conditionChipParts(f('X_TAG', 'greater_than', '1'), desc, unit)).toEqual({ name: 'X_TAG', rest: '> 1' });
        expect(conditionChipParts(f('POWER', 'greater_than', '1'))).toEqual({ name: 'POWER', rest: '> 1' });
    });
});
