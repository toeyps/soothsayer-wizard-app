import { describe, it, expect } from 'vitest';
import {
    formatAxisTick, formatClock, formatDate, formatDateTime, formatDateTimeMinutes, formatRowTime, formatWallClock, formatYearMonth,
    readWallClock, wallClockOf,
} from '../utils/dateFormat';

/*
 * THE date format of the whole app (user decision 2026-10-12): every date a user
 * reads is built here — numerals only, zero-padded, 24-hour clock, never a month
 * name and never the PC's locale.
 */
const MONTH_NAME = /Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/i;

describe('dateFormat', () => {
    describe('formatDate', () => {
        it('formats as YYYY/MM/DD', () => {
            expect(formatDate(new Date(2026, 2, 15))).toBe('2026/03/15');
        });

        it('zero-pads single-digit month and day', () => {
            expect(formatDate(new Date(2026, 0, 5))).toBe('2026/01/05');
        });
    });

    describe('formatDateTime', () => {
        it('formats as YYYY/MM/DD HH:mm:ss, 24-hour', () => {
            expect(formatDateTime(new Date(2026, 7, 9, 23, 5, 7))).toBe('2026/08/09 23:05:07');
        });

        it('zero-pads midnight correctly', () => {
            expect(formatDateTime(new Date(2026, 0, 1, 0, 0, 0))).toBe('2026/01/01 00:00:00');
        });

        it('always prints the seconds, also when they are zero', () => {
            expect(formatDateTime(new Date(2025, 2, 14, 21, 25, 0))).toBe('2025/03/14 21:25:00');
        });
    });

    describe('formatDateTimeMinutes', () => {
        it('formats as YYYY/MM/DD HH:mm — 24-hour, no seconds', () => {
            expect(formatDateTimeMinutes(new Date(2026, 9, 11, 17, 30, 45))).toBe('2026/10/11 17:30');
        });

        it('zero-pads every part; an afternoon hour is never 12-hour', () => {
            expect(formatDateTimeMinutes(new Date(2025, 0, 1, 0, 5))).toBe('2025/01/01 00:05');
            expect(formatDateTimeMinutes(new Date(2025, 2, 31, 23, 59))).toBe('2025/03/31 23:59');
            expect(formatDateTimeMinutes(new Date(2025, 2, 31, 13, 0))).not.toMatch(/AM|PM|,/);
        });
    });

    describe('formatYearMonth', () => {
        it('formats as YYYY/MM', () => {
            expect(formatYearMonth(new Date(2026, 10, 1))).toBe('2026/11');
        });

        it('zero-pads single-digit month', () => {
            expect(formatYearMonth(new Date(2026, 0, 1))).toBe('2026/01');
        });
    });

    describe('formatClock', () => {
        it('formats as HH:mm, 24-hour, zero-padded', () => {
            expect(formatClock(new Date(2026, 0, 1, 5, 7))).toBe('05:07');
            expect(formatClock(new Date(2026, 0, 1, 22, 41, 59))).toBe('22:41');
        });
    });

    describe('formatWallClock / wallClockOf', () => {
        const w = { year: 2025, month: 3, day: 4, hour: 9, minute: 5, second: 7 };

        it('one set of fields, three precisions', () => {
            expect(formatWallClock(w, 'date')).toBe('2025/03/04');
            expect(formatWallClock(w, 'minutes')).toBe('2025/03/04 09:05');
            expect(formatWallClock(w, 'seconds')).toBe('2025/03/04 09:05:07');
            expect(formatWallClock(w)).toBe('2025/03/04 09:05:07'); // seconds is the default
        });

        it('wallClockOf reads a Date in the PC time zone (month 1–12)', () => {
            expect(wallClockOf(new Date(2025, 11, 31, 23, 59, 58))).toEqual({ year: 2025, month: 12, day: 31, hour: 23, minute: 59, second: 58 });
        });

        it('the Date formatters are the same text as formatWallClock of that Date', () => {
            const d = new Date(2025, 2, 14, 21, 25, 9);
            expect(formatDate(d)).toBe(formatWallClock(wallClockOf(d), 'date'));
            expect(formatDateTimeMinutes(d)).toBe(formatWallClock(wallClockOf(d), 'minutes'));
            expect(formatDateTime(d)).toBe(formatWallClock(wallClockOf(d), 'seconds'));
        });
    });

    describe('readWallClock / formatRowTime (a data row keeps its OWN clock)', () => {
        it('reads the digits written in the text: "-" or "/", "T" or a space, with or without seconds', () => {
            expect(readWallClock('2026-02-09 23:50:07')).toEqual({ year: 2026, month: 2, day: 9, hour: 23, minute: 50, second: 7 });
            expect(readWallClock('2026/2/9 5:07')).toEqual({ year: 2026, month: 2, day: 9, hour: 5, minute: 7, second: 0 });
            expect(readWallClock(' 2026-02-09T23:50 ')).toEqual({ year: 2026, month: 2, day: 9, hour: 23, minute: 50, second: 0 });
            expect(readWallClock('2026-02-09')).toEqual({ year: 2026, month: 2, day: 9, hour: 0, minute: 0, second: 0 });
        });

        it('an offset or "Z" is IGNORED — the row is never moved to another time zone', () => {
            // each of these would read another hour (or another day) on some PC if it went through `new Date`
            expect(formatRowTime('2026-02-09T23:50:00+07:00')).toBe('2026/02/09 23:50:00');
            expect(formatRowTime('2026-02-09T23:50:00-0800')).toBe('2026/02/09 23:50:00');
            expect(formatRowTime('2026-02-09T23:50:00.000Z')).toBe('2026/02/09 23:50:00');
            expect(formatRowTime('2026-12-31T23:59:59+14:00')).toBe('2026/12/31 23:59:59');
            expect(formatRowTime('2026-01-01T00:00:00Z')).toBe('2026/01/01 00:00:00');
        });

        it('seconds by default; minutes or the date alone on request; a fraction of a second is dropped', () => {
            expect(formatRowTime('2026-02-09 23:50:07.250')).toBe('2026/02/09 23:50:07');
            expect(formatRowTime('2026-02-09 23:50:07', 'minutes')).toBe('2026/02/09 23:50');
            expect(formatRowTime('2026-02-09 23:50:07', 'date')).toBe('2026/02/09');
        });

        it('text in any other shape is null (the caller decides what to show)', () => {
            for (const t of ['', 'row 12', 'Feb 9, 2026 23:50', '09/02/2026 23:50', '2026-13-01 00:00', '2026-00-01']) {
                expect(readWallClock(t)).toBeNull();
                expect(formatRowTime(t)).toBeNull();
            }
        });
    });

    describe('formatAxisTick (a chart time-axis tick)', () => {
        const at = (...a: [number, number, number, number?, number?, number?, number?]) => new Date(...a).getTime();

        it('a midnight tick is the date alone', () => {
            expect(formatAxisTick(at(2025, 2, 14))).toBe('2025/03/14');
            expect(formatAxisTick(at(2025, 0, 1))).toBe('2025/01/01');
        });

        it('a tick that is not a midnight also shows its time, so ticks on one day never read the same', () => {
            expect(formatAxisTick(at(2025, 2, 14, 6, 0))).toBe('2025/03/14 06:00');
            expect(formatAxisTick(at(2025, 2, 14, 12, 30))).toBe('2025/03/14 12:30');
            const oneDay = [0, 4, 8, 12, 16, 20].map(h => formatAxisTick(at(2025, 2, 14, h)));
            expect(new Set(oneDay).size).toBe(oneDay.length);
            expect(oneDay[0]).toBe('2025/03/14');
        });

        it('finer than a minute / a second: seconds, then milliseconds', () => {
            expect(formatAxisTick(at(2025, 2, 14, 6, 0, 30))).toBe('2025/03/14 06:00:30');
            expect(formatAxisTick(at(2025, 2, 14, 6, 0, 30, 250))).toBe('2025/03/14 06:00:30.250');
            expect(formatAxisTick(at(2025, 2, 14, 0, 0, 0, 5))).toBe('2025/03/14 00:00:00.005');
        });

        it('a value that is no time is an empty label', () => {
            expect(formatAxisTick(Number.NaN)).toBe('');
        });
    });

    it('no formatter can print a month name, a comma or AM/PM — for every month of the year', () => {
        for (let m = 0; m < 12; m++) {
            const d = new Date(2025, m, 9, 15, 4, 5);
            const texts = [
                formatDate(d), formatDateTime(d), formatDateTimeMinutes(d), formatYearMonth(d), formatClock(d),
                formatAxisTick(d.getTime()), formatAxisTick(new Date(2025, m, 9).getTime()),
                formatRowTime(`2025-${String(m + 1).padStart(2, '0')}-09 15:04:05`) ?? '',
            ];
            for (const t of texts) {
                expect(t).not.toMatch(MONTH_NAME);
                expect(t).not.toMatch(/AM|PM|,/);
                expect(t).toMatch(/^[\d/: .]+$/);
            }
        }
    });
});
