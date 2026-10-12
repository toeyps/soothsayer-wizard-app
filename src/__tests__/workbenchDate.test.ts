import { describe, it, expect } from 'vitest';
import { formatDate, formatDateTime, formatDateTimeMinutes } from '../utils/dateFormat';
import { clockText, dateText, formatBound, formatDataStamp, formatStamp, parseLocal } from '../utils/workbenchDate';
import * as workbenchDate from '../utils/workbenchDate';
import * as periodDisplay from '../components/windows/periodDisplay';

/*
 * The Workbench's date helpers (`utils/workbenchDate.ts`). They no longer have
 * a format of their own ("9 Feb 2026 23:50" is retired, user decision
 * 2026-10-12): every one prints through `utils/dateFormat.ts`, the one date
 * format of the whole app. `periodDisplay.test.ts` keeps testing the helpers
 * through the re-exports; this file covers the helpers themselves, that they
 * agree with the single source, and that none can print a month name.
 */
const MONTH_NAME = /Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/i;

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

    it('dateText / clockText are the two halves of the one format — and they ARE the single source', () => {
        const ms = new Date(2026, 1, 9, 5, 7).getTime();
        expect(dateText(ms)).toBe('2026/02/09');
        expect(clockText(ms)).toBe('05:07');
        expect(formatStamp(ms)).toBe(`${dateText(ms)} ${clockText(ms)}`);
        expect(dateText(ms)).toBe(formatDate(new Date(ms)));
        expect(formatStamp(ms)).toBe(formatDateTimeMinutes(new Date(ms)));
    });

    it('dateText: a date always carries its year — the old "without the year" argument changes nothing', () => {
        const ms = new Date(2026, 1, 9, 5, 7).getTime();
        expect(dateText(ms, true)).toBe('2026/02/09');
        expect(dateText(ms, false)).toBe('2026/02/09');
    });

    it('formatStamp: "2026/02/09 23:50" (an instant the app recorded: no seconds) — and text that is not a date stays as typed', () => {
        expect(formatStamp('2026-02-09 23:50:00')).toBe('2026/02/09 23:50');
        expect(formatStamp('2026-02-09 23:50:59')).toBe('2026/02/09 23:50');
        expect(formatStamp('row 12')).toBe('row 12');
        expect(formatStamp(null)).toBe('—');
    });

    it('formatDataStamp prints a CSV stamp from its own wall-clock parts, always with seconds (an offset never shifts it)', () => {
        expect(formatDataStamp('2026-02-09T23:50:00+07:00')).toBe('2026/02/09 23:50:00');
        expect(formatDataStamp('2026-02-09 23:50:30')).toBe('2026/02/09 23:50:30');
        expect(formatDataStamp('2026-02-09 23:50:30', { seconds: true })).toBe('2026/02/09 23:50:30');
        expect(formatDataStamp('2026-02-09T23:50:00.000Z')).toBe('2026/02/09 23:50:00');
        expect(formatDataStamp(null)).toBe('—');
    });

    it('formatDataStamp: `seconds: false` is minutes, `dateOnly` the date alone — still from the text itself', () => {
        expect(formatDataStamp('2026-02-09T23:50:30+07:00', { seconds: false })).toBe('2026/02/09 23:50');
        expect(formatDataStamp('2026-02-09T23:50:30+07:00', { dateOnly: true })).toBe('2026/02/09');
        expect(formatDataStamp('2025-12-31T23:59:59Z', { dateOnly: true })).toBe('2025/12/31'); // never the next day
        expect(formatDataStamp('row 12', { dateOnly: true })).toBe('row 12');
    });

    it('formatDataStamp: text in another shape is read as local time, in the same format', () => {
        const local = new Date(2026, 1, 9, 23, 50, 7);
        expect(formatDataStamp('Feb 9, 2026 23:50:07')).toBe(formatDateTime(local));
        expect(formatDataStamp('Feb 9, 2026 23:50:07')).toBe('2026/02/09 23:50:07');
        expect(formatDataStamp('Feb 9, 2026 23:50:07', { dateOnly: true })).toBe('2026/02/09');
    });

    it('formatBound: always date + time — a bound on its whole-day edge too (no shortening)', () => {
        expect(formatBound('2026-05-11T00:00', 'start')).toBe('2026/05/11 00:00');
        expect(formatBound('2026-05-11T23:59', 'end')).toBe('2026/05/11 23:59');
        expect(formatBound('2026-05-11T23:59', 'start')).toBe('2026/05/11 23:59');
        expect(formatBound('2026-05-11T00:00', 'end')).toBe('2026/05/11 00:00');
        expect(formatBound('2026-05-11T06:30', 'start')).toBe('2026/05/11 06:30');
        expect(formatBound('2026-05-11', 'start')).toBe('2026/05/11 00:00');
        // the side no longer changes the text, and may be left out
        expect(formatBound('2026-05-11T06:30')).toBe('2026/05/11 06:30');
    });

    it('formatBound: text that is not a date comes back as typed (trimmed); blank is empty', () => {
        expect(formatBound(' soon ', 'start')).toBe('soon');
        expect(formatBound('', 'end')).toBe('');
        expect(formatBound(null, 'end')).toBe('');
        expect(formatBound(undefined, 'start')).toBe('');
    });

    it('the retired month-name table is gone', () => {
        expect(Object.keys(workbenchDate)).not.toContain('MONTHS_SHORT');
    });

    // (Text that is NOT a date is returned as typed — that is the one way a word can come back.)
    it('no formatter of this file can return a month name — every month, every kind of date', () => {
        for (let m = 1; m <= 12; m++) {
            const mm = String(m).padStart(2, '0');
            const ms = new Date(2025, m - 1, 9, 15, 4, 5).getTime();
            const texts = [
                dateText(ms), dateText(ms, true), dateText(ms, false), clockText(ms),
                formatStamp(ms), formatStamp(`2025-${mm}-09T15:04`), formatStamp(`2025-${mm}-09T15:04:05.000Z`),
                formatBound(`2025-${mm}-09T00:00`, 'start'), formatBound(`2025-${mm}-09T23:59`, 'end'), formatBound(`2025-${mm}-09`),
                formatDataStamp(`2025-${mm}-09 15:04:05`), formatDataStamp(`2025-${mm}-09T15:04:05+07:00`),
                formatDataStamp(`2025-${mm}-09`, { seconds: false }), formatDataStamp(`2025-${mm}-09 15:04`, { dateOnly: true }),
            ];
            for (const t of texts) {
                expect(t).not.toMatch(MONTH_NAME);
                expect(t).toMatch(/^[\d/: ]+$/);
            }
        }
    });
});
