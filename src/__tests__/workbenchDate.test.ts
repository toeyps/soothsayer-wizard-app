import { describe, it, expect } from 'vitest';
import { clockText, dateText, formatBound, formatDataStamp, formatStamp, MONTHS_SHORT, parseLocal } from '../utils/workbenchDate';
import * as periodDisplay from '../components/windows/periodDisplay';

/*
 * The Workbench date format ("9 Feb 2026 23:50") moved from
 * `components/windows/periodDisplay.ts` to `utils/workbenchDate.ts`
 * so the pure period helpers can print dates with it.
 * `periodDisplay.test.ts` keeps testing the format through the re-exports;
 * this file covers the move itself and the new sentence helper.
 */
describe('workbenchDate', () => {
    it('periodDisplay re-exports the very same functions (components keep one import path)', () => {
        expect(periodDisplay.formatStamp).toBe(formatStamp);
        expect(periodDisplay.formatDataStamp).toBe(formatDataStamp);
        expect(periodDisplay.parseLocal).toBe(parseLocal);
    });

    it('parseLocal reads datetime-local / CSV text as LOCAL time; date-only is local midnight; blank and garbage are null', () => {
        expect(parseLocal('2026-02-09T23:50')).toBe(new Date(2026, 1, 9, 23, 50).getTime());
        expect(parseLocal('2026-02-09 23:50:00')).toBe(new Date(2026, 1, 9, 23, 50).getTime());
        expect(parseLocal('2026-02-09')).toBe(new Date(2026, 1, 9, 0, 0).getTime());
        expect(parseLocal('  2026-02-09T23:50  ')).toBe(new Date(2026, 1, 9, 23, 50).getTime());
        for (const v of ['', '   ', 'garbage', null, undefined]) expect(parseLocal(v)).toBeNull();
    });

    it('dateText / clockText are the two halves of the one format', () => {
        const ms = new Date(2026, 1, 9, 5, 7).getTime();
        expect(dateText(ms, true)).toBe('9 Feb 2026');
        expect(dateText(ms, false)).toBe('9 Feb');
        expect(clockText(ms)).toBe('05:07');
        expect(formatStamp(ms)).toBe(`${dateText(ms, true)} ${clockText(ms)}`);
        expect(MONTHS_SHORT).toHaveLength(12);
    });

    it('formatStamp: "9 Feb 2026 23:50" — and text that is not a date stays as typed', () => {
        expect(formatStamp('2026-02-09 23:50:00')).toBe('9 Feb 2026 23:50');
        expect(formatStamp('row 12')).toBe('row 12');
        expect(formatStamp(null)).toBe('—');
    });

    it('formatDataStamp prints a CSV stamp from its own wall-clock parts (an offset never shifts it)', () => {
        expect(formatDataStamp('2026-02-09T23:50:00+07:00')).toBe('9 Feb 2026 23:50');
        expect(formatDataStamp('2026-02-09 23:50:30', { seconds: true })).toBe('9 Feb 2026 23:50:30');
        expect(formatDataStamp(null)).toBe('—');
    });

    it('formatBound: a bound on its whole-day edge is the date alone; any other time is date + time', () => {
        // a START at 00:00 and an END at 23:59 are whole-day edges
        expect(formatBound('2026-05-11T00:00', 'start')).toBe('11 May 2026');
        expect(formatBound('2026-05-11T23:59', 'end')).toBe('11 May 2026');
        // ... but not the other way round
        expect(formatBound('2026-05-11T23:59', 'start')).toBe('11 May 2026 23:59');
        expect(formatBound('2026-05-11T00:00', 'end')).toBe('11 May 2026 00:00');
        expect(formatBound('2026-05-11T06:30', 'start')).toBe('11 May 2026 06:30');
        expect(formatBound('2026-05-11', 'start')).toBe('11 May 2026');
    });

    it('formatBound: text that is not a date comes back as typed (trimmed); blank is empty', () => {
        expect(formatBound(' soon ', 'start')).toBe('soon');
        expect(formatBound('', 'end')).toBe('');
        expect(formatBound(null, 'end')).toBe('');
        expect(formatBound(undefined, 'start')).toBe('');
    });
});
