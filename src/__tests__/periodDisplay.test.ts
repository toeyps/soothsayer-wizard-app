import { describe, it, expect } from 'vitest';
import {
    buildRuleModel, computeCoverage, conditionSymbol, formatDate, formatPeriod, overlapDays, periodDays, ruleText,
} from '../components/windows/periodDisplay';
import type { WorkspaceSensorFilter } from '../types';

// Dataset of the approved mockup: 1 Jan 2025 00:00 - 31 Mar 2026 23:50 = 455 days.
const B = { min: '2025-01-01 00:00:00', max: '2026-03-31 23:50:00' };
const p = (id: string, start: string, end: string) => ({ id, start, end });
const f = (sensor: string, operation: WorkspaceSensorFilter['operation'], value1: string, value2 = ''): WorkspaceSensorFilter =>
    ({ id: `f-${sensor}`, sensor, operation, value1, value2 });

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

describe('rule line ("Row is used when ...")', () => {
    const P3 = [
        p('a', '2025-01-01T00:00', '2025-02-28T23:59'),
        p('b', '2025-06-01T00:00', '2025-07-31T23:59'),
        p('c', '2025-11-03T06:00', '2025-12-19T18:00'),
    ];
    const C2 = [f('I_MOT_A', 'greater_than', '12'), f('PT_2041', 'greater_than', '2.4')];

    it('the mockup sentence: periods OR-ed, conditions AND-ed', () => {
        expect(ruleText({ periods: P3, filters: C2, combine: 'and', none: false }))
            .toBe('Row is used when ( P1 OR P2 OR P3 ) AND ( I_MOT_A > 12 AND PT_2041 > 2.4 )');
    });

    it('Match OR joins the conditions with OR; periods still use OR', () => {
        expect(ruleText({ periods: P3.slice(0, 2), filters: C2, combine: 'or', none: false }))
            .toBe('Row is used when ( P1 OR P2 ) AND ( I_MOT_A > 12 OR PT_2041 > 2.4 )');
        const m = buildRuleModel({ periods: P3, filters: C2, combine: 'or', none: false });
        expect(m.condOp).toBe('OR');
    });

    it('"No condition" replaces the condition list', () => {
        expect(ruleText({ periods: P3.slice(0, 1), filters: C2, combine: 'and', none: true }))
            .toBe('Row is used when ( P1 ) AND ( no condition (every row) )');
    });

    it('no periods reads "any time"', () => {
        expect(ruleText({ periods: [], filters: C2, combine: 'and', none: false }))
            .toBe('Row is used when ( any time ) AND ( I_MOT_A > 12 AND PT_2041 > 2.4 )');
        expect(ruleText({ periods: [], filters: [], combine: 'and', none: true }))
            .toBe('Row is used when ( any time ) AND ( no condition (every row) )');
    });

    it('incomplete conditions are left out; none complete reads "no condition yet"', () => {
        expect(ruleText({ periods: [], filters: [f('A', 'greater_than', ''), f('B', 'less_than', '5')], combine: 'and', none: false }))
            .toBe('Row is used when ( any time ) AND ( B < 5 )');
        expect(ruleText({ periods: [], filters: [f('A', 'greater_than', '')], combine: 'and', none: false }))
            .toBe('Row is used when ( any time ) AND ( no condition yet )');
    });

    it('between shows its range; invalid periods are dropped but keep their row numbers', () => {
        const bad = p('x', '2025-06-01T00:00', '2025-05-20T23:59');
        expect(ruleText({ periods: [P3[0], bad, P3[2]], filters: [f('T', 'between', '1', '5')], combine: 'and', none: false }))
            .toBe('Row is used when ( P1 OR P3 ) AND ( T between 1–5 )');
    });

    it('condition symbols', () => {
        expect(['greater_than', 'less_than', 'between', 'equals'].map(o => conditionSymbol(o as WorkspaceSensorFilter['operation'])))
            .toEqual(['>', '<', 'between', '=']);
    });
});
