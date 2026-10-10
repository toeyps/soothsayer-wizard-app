import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import RunningConditionTimeline, { monthTicks, timelineBlocks } from '../components/windows/RunningConditionTimeline';
import { PERIOD_COUNTS_IDLE, type PeriodCountsState } from '../utils/periodCounts';
import type { PeriodCounts } from '../types/periodCounts';
import type { TestPeriod, TimePeriod } from '../types';

afterEach(cleanup);

/*
 * The timeline hero of the Running-condition settings (workbench redesign SPEC
 * §5): month axis, Train lane (P1 P2), Score lane (S1 S2, dashed), invalid =
 * red, and the ONE caption under it.
 */

// 1 Jan 2026 00:00 → 1 May 2026 00:00 = 120 days, so percentages are easy to read.
const bounds = { min: '2026-01-01 00:00:00', max: '2026-05-01 00:00:00' };
const p = (id: string, start: string, end: string): TimePeriod => ({ id, start, end });
const P1 = p('a', '2026-01-01T00:00', '2026-01-31T00:00'); // 30 d
const P2 = p('b', '2026-03-02T00:00', '2026-04-01T00:00'); // 30 d
const S1: TestPeriod = { id: 's', start: '2026-04-01T00:00', end: '2026-04-16T00:00' }; // 15 d

const train = (running_rows: number, running_days: number, total_rows = 25_880): PeriodCounts => ({
    total_rows, interval_secs: 300, periods: [],
    union: { rows_in_period: running_rows + 100, running_rows, running_days },
});
const st = (status: PeriodCountsState['status'], t: PeriodCounts | null, errorCode: PeriodCountsState['errorCode'] = null): PeriodCountsState =>
    ({ status, train: t, scoring: null, error: status === 'error' ? 'failed' : null, errorCode });

const show = (periods: TimePeriod[], tests: TestPeriod[], counts: PeriodCountsState = PERIOD_COUNTS_IDLE, b: typeof bounds | null = bounds) =>
    render(<RunningConditionTimeline periods={periods} tests={tests} bounds={b} counts={counts} />);
const left = (id: string) => parseFloat(screen.getByTestId(id).style.left);
const width = (id: string) => parseFloat(screen.getByTestId(id).style.width);

describe('monthTicks', () => {
    it('one tick per month start inside the range; January carries the year', () => {
        const t0 = new Date(2025, 10, 15).getTime();
        const t1 = new Date(2026, 2, 15).getTime();
        expect(monthTicks(t0, t1).map(t => t.label)).toEqual(['Dec', 'Jan 2026', 'Feb', 'Mar']);
        const ticks = monthTicks(t0, t1);
        expect(ticks[0].pct).toBeGreaterThan(0);
        expect(ticks[ticks.length - 1].pct).toBeLessThanOrEqual(100);
    });

    it('a range that starts on a month start gets a tick at 0 %', () => {
        const ticks = monthTicks(new Date(2026, 0, 1).getTime(), new Date(2026, 4, 1).getTime());
        expect(ticks.map(t => t.label)).toEqual(['Jan 2026', 'Feb', 'Mar', 'Apr', 'May']);
        expect(ticks[0].pct).toBe(0);
        expect(ticks[4].pct).toBe(100);
    });

    it('a long dataset is thinned to at most ~14 labels; an empty range gives none', () => {
        const ticks = monthTicks(new Date(2020, 0, 1).getTime(), new Date(2026, 0, 1).getTime());
        expect(ticks.length).toBeLessThanOrEqual(15);
        expect(ticks.length).toBeGreaterThan(5);
        expect(monthTicks(5, 5)).toEqual([]);
    });
});

describe('timelineBlocks', () => {
    it('positions a period in percent of the dataset range and names it by its list number', () => {
        const [a, b] = timelineBlocks([P1, P2], [false, false], bounds, 'P');
        expect(a).toMatchObject({ name: 'P1', leftPct: 0, invalid: false, openStart: false, openEnd: false });
        expect(a!.widthPct).toBeCloseTo(25, 5); // 30 of 120 days
        expect(b!.name).toBe('P2');
        expect(b!.leftPct).toBeCloseTo(50, 5);
        expect(b!.label).toMatch(/^P2 · /);
    });

    it('an open end runs to the edge of the data; a period outside the data, or with an unreadable date, has no block', () => {
        const [open, outside, junk] = timelineBlocks(
            [p('a', '', ''), p('b', '2027-01-01T00:00', '2027-02-01T00:00'), p('c', 'not a date', '2026-02-01T00:00')],
            [false, false, true], bounds, 'S',
        );
        expect(open).toMatchObject({ name: 'S1', leftPct: 0, widthPct: 100, openStart: true, openEnd: true });
        expect(outside).toBeNull();
        expect(junk).toBeNull();
    });

    it('a reversed period is drawn over the time between its two dates, flagged invalid; no bounds = no blocks', () => {
        const [rev] = timelineBlocks([p('a', '2026-03-02T00:00', '2026-01-31T00:00')], [true], bounds, 'P');
        expect(rev!.invalid).toBe(true);
        expect(rev!.leftPct).toBeCloseTo(25, 5);
        expect(rev!.widthPct).toBeCloseTo(25, 5);
        expect(timelineBlocks([P1], [false], null, 'P')).toEqual([null]);
    });
});

describe('RunningConditionTimeline — lanes', () => {
    it('a month axis, a Train lane with P1 P2 and a Score lane with S1 — plain DOM, no canvas', () => {
        show([P1, P2], [S1]);
        const tl = screen.getByTestId('rc-timeline');
        expect(tl.querySelector('canvas, svg')).toBeNull();
        expect([...tl.querySelectorAll('.rct-axis span')].map(s => s.textContent)).toEqual(['Jan 2026', 'Feb', 'Mar', 'Apr', 'May']);
        const trainLane = screen.getByTestId('rc-timeline-train');
        expect(trainLane.className).toContain('rct-lane--tr');
        expect(trainLane.querySelector('.rct-ln')!.textContent).toBe('Train');
        expect([...trainLane.querySelectorAll('.rct-blk')].map(b => b.textContent)).toEqual(['P1', 'P2']);
        const scoreLane = screen.getByTestId('rc-timeline-score');
        expect(scoreLane.className).toContain('rct-lane--sc');
        expect(scoreLane.querySelector('.rct-ln')!.textContent).toBe('Score');
        expect([...scoreLane.querySelectorAll('.rct-blk')].map(b => b.textContent)).toEqual(['S1']);
        expect(left('rc-tl-P2')).toBeCloseTo(50, 1);
        expect(width('rc-tl-P2')).toBeCloseTo(25, 1);
        expect(left('rc-tl-S1')).toBeCloseTo(75, 1);
        expect(screen.getByTestId('rc-tl-P1').getAttribute('data-invalid')).toBeNull();
    });

    it('an invalid period is red (and says so in its tooltip); the valid ones are not', () => {
        show([P1, p('b', '2026-04-01T00:00', '2026-03-02T00:00')], [{ id: 's', start: '2026-04-16T00:00', end: '2026-04-01T00:00' }]);
        const bad = screen.getByTestId('rc-tl-P2');
        expect(bad.className).toContain('bad');
        expect(bad.getAttribute('data-invalid')).toBe('true');
        expect(bad.title).toMatch(/not valid$/);
        expect(screen.getByTestId('rc-tl-P1').className).not.toContain('bad');
        expect(screen.getByTestId('rc-tl-S1').className).toContain('bad');
    });

    it('open-ended periods reach the edges of the dataset (square corners on the open side)', () => {
        show([p('a', '', '2026-01-31T00:00'), p('b', '2026-03-02T00:00', '')], []);
        const first = screen.getByTestId('rc-tl-P1');
        expect(left('rc-tl-P1')).toBe(0);
        expect(first.className).toContain('rct-blk--os');
        expect(first.className).not.toContain('rct-blk--oe');
        const last = screen.getByTestId('rc-tl-P2');
        expect(left('rc-tl-P2') + width('rc-tl-P2')).toBeCloseTo(100, 1);
        expect(last.className).toContain('rct-blk--oe');
    });

    it('a sliver of a period keeps a visible block but drops its name (the tooltip still has it)', () => {
        show([p('a', '2026-01-01T00:00', '2026-01-02T00:00')], []);
        const blk = screen.getByTestId('rc-tl-P1');
        expect(blk.textContent).toBe('');
        expect(blk.title).toMatch(/^P1 · /);
        expect(width('rc-tl-P1')).toBeGreaterThanOrEqual(0.6);
    });

    it('no train period: the Train lane says so; the Score lane stays quiet', () => {
        show([], []);
        expect(screen.getByTestId('rc-timeline-train').textContent).toBe('Trainno train period yet');
        expect(screen.getByTestId('rc-timeline-score').textContent).toBe('Score');
    });

    it('unknown dataset range: one quiet line instead of the lanes, the caption still shows', () => {
        show([P1], [], PERIOD_COUNTS_IDLE, null);
        expect(screen.getByTestId('rc-timeline-nobounds').textContent).toBe("The dataset's time range is not known yet.");
        expect(screen.queryByTestId('rc-timeline-train')).toBeNull();
        expect(screen.getByTestId('rc-caption')).toBeTruthy();
    });
});

describe('RunningConditionTimeline — the one caption', () => {
    const cap = () => screen.getByTestId('rc-caption');

    it('no train period: "no train period · no scoring time · add a train period to count the rows", no recommendation', () => {
        show([], []);
        expect(cap().getAttribute('data-rows')).toBe('no-train');
        expect(screen.getByTestId('rc-caption-train').textContent).toBe('no train period');
        expect(screen.getByTestId('rc-caption-scoring').textContent).toBe('no scoring time');
        expect(screen.getByTestId('rc-caption-rows').textContent).toBe('add a train period to count the rows');
        expect(screen.queryByTestId('rc-min-data')).toBeNull();
    });

    // Review of a4acd7a, item 6.
    it('the running condition is not configured: "set the condition to count the rows" instead of a count of every row; no running time, no amber', () => {
        render(<RunningConditionTimeline periods={[P1, P2]} tests={[S1]} bounds={bounds} counts={st('ok', train(17_280, 60))} configured={false} />);
        expect(cap().getAttribute('data-rows')).toBe('no-condition');
        expect(screen.getByTestId('rc-caption-rows').textContent).toBe('set the condition to count the rows');
        expect(screen.getByTestId('rc-caption-train').textContent).toBe('60 d train');
        expect(cap().className).not.toContain('rct-cap--warn');
        expect(cap().textContent).not.toMatch(/%|of 25,880/);
    });

    it('first count on its way: calendar days at once, "Counting rows…" for the rows', () => {
        show([P1, P2], [S1], st('loading', null));
        expect(cap().getAttribute('data-rows')).toBe('loading');
        expect(screen.getByTestId('rc-caption-train').textContent).toBe('60 d train');
        expect(screen.getByTestId('rc-caption-scoring').textContent).toBe('15 d scoring');
        expect(screen.getByTestId('rc-caption-rows').textContent).toBe('Counting rows…');
        expect(screen.getByTestId('rc-min-data').textContent).toBe('≥ 30 d recommended');
    });

    it('counted: "60 d train (about 50 d running time) · 15 d scoring · 14,391 of 25,880 rows (56%) used for training · ≥ 30 d recommended"', () => {
        show([P1, P2], [S1], st('ok', train(14_391, 49.97)));
        expect(cap().getAttribute('data-rows')).toBe('counted');
        expect(cap().textContent).toBe('60 d train (about 50 d running time)15 d scoring14,391 of 25,880 rows (56%) used for training≥ 30 d recommended');
        const rows = screen.getByTestId('rc-caption-rows');
        expect(rows.querySelector('b')!.textContent).toBe('14,391');
        expect(rows.getAttribute('data-stale')).toBeNull();
        expect(cap().className).not.toContain('rct-cap--warn');
        expect(screen.getByTestId('rc-min-data').getAttribute('data-below')).toBeNull();
    });

    it('a new count on its way keeps the previous numbers, dimmed (no flicker back to "Counting rows…")', () => {
        show([P1, P2], [S1], st('loading', train(14_391, 49.97)));
        const rows = screen.getByTestId('rc-caption-rows');
        expect(rows.textContent).toBe('14,391 of 25,880 rows (56%) used for training');
        expect(rows.getAttribute('data-stale')).toBe('true');
        expect(rows.className).toContain('rct-stale');
    });

    it('below 30 d of train running time: the recommendation turns amber (the sentence is its tooltip) — it never blocks', () => {
        show([P1], [], st('ok', train(3_456, 12)));
        expect(screen.getByTestId('rc-caption-train').textContent).toBe('30 d train (about 12 d running time)');
        expect(cap().className).toContain('rct-cap--warn');
        const min = screen.getByTestId('rc-min-data');
        expect(min.textContent).toBe('≥ 30 d recommended');
        expect(min.getAttribute('data-below')).toBe('true');
        expect(min.title).toMatch(/^Only 12 d of train running time/);
    });

    it('a failed count: one quiet line instead of numbers', () => {
        show([P1], [S1], st('error', null));
        expect(cap().getAttribute('data-rows')).toBe('error');
        const rows = screen.getByTestId('rc-caption-rows');
        expect(rows.textContent).toBe("Couldn't count the rows right now");
        expect(rows.className).toContain('rct-cap-quiet');
        expect(screen.getByTestId('rc-caption-train').textContent).toBe('30 d train');
        expect(cap().textContent).not.toMatch(/\d of \d/);
    });

    it('the dataset changed under the window (STALE_SESSION): says to reopen, still no numbers', () => {
        show([P1], [], st('error', null, 'STALE_SESSION'));
        expect(screen.getByTestId('rc-caption-rows').textContent).toBe('The data changed — close this window and open Build Model again to count the rows');
    });

    it('an invalid train period: no total until it is fixed', () => {
        show([P1, p('b', '2026-04-01T00:00', '2026-03-02T00:00')], [], st('ok', train(14_391, 49.97)));
        expect(cap().getAttribute('data-rows')).toBe('fix');
        expect(screen.getByTestId('rc-caption-rows').textContent).toBe('fix the period to count the rows');
        expect(screen.getByTestId('rc-caption-train').textContent).toBe('30 d train'); // the valid one only
    });

    it('nothing is being counted (hook disabled): the calendar parts only', () => {
        show([P1], [S1]);
        expect(cap().getAttribute('data-rows')).toBe('idle');
        expect(screen.queryByTestId('rc-caption-rows')).toBeNull();
        expect(cap().textContent).toBe('30 d train15 d scoring≥ 30 d recommended');
    });
});
