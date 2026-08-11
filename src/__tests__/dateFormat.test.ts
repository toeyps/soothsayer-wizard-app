import { describe, it, expect } from 'vitest';
import { formatDate, formatDateTime, formatYearMonth } from '../utils/dateFormat';

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
    });

    describe('formatYearMonth', () => {
        it('formats as YYYY/MM', () => {
            expect(formatYearMonth(new Date(2026, 10, 1))).toBe('2026/11');
        });

        it('zero-pads single-digit month', () => {
            expect(formatYearMonth(new Date(2026, 0, 1))).toBe('2026/01');
        });
    });
});
