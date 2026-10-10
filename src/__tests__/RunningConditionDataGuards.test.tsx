import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';

// `periodCounts.ts` binds the Rust command; nothing here calls it.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import TimePeriodsEditor from '../components/windows/TimePeriodsEditor';
import TestPeriodsEditor from '../components/windows/TestPeriodsEditor';
import RunningConditionTimeline from '../components/windows/RunningConditionTimeline';
import { RunningConditionCard, type RcCardRows } from '../components/windows/RunningConditionCard';
import { SensorMetaProvider } from '../components/sensor/SensorLabel';
import { PERIOD_COUNTS_IDLE, type PeriodCountsState } from '../utils/periodCounts';
import type { PeriodCount, PeriodCounts } from '../types/periodCounts';
import type { TestPeriod, TimePeriod } from '../types';

afterEach(cleanup);

/*
 * "No data to train on" is stopped at the UI (user request 2026-10-10) — what the
 * Running-condition rows, the timeline and the one-line card SHOW:
 *   - a period entirely outside the loaded data: red edge, both date fields red,
 *     ONE reason line, a red sliver on the timeline;
 *   - a period partly outside: a quiet amber note, nothing red;
 *   - a settled count of zero running rows: one red line under the caption (all
 *     train periods), or an amber note on the one row that has none.
 * The pure rules are in periodDataGuards.test.ts; Apply / Save / Train are in
 * BuildModelWindow.test.tsx.
 */

// The user's example: the data covers 2025-01 … 2025-12.
const DATA = { min: '2025-01-01 00:00:00', max: '2025-12-31 23:59:00' };
const p = (id: string, start: string, end: string): TimePeriod => ({ id, start, end });
const INSIDE = p('in', '2025-03-01T00:00', '2025-04-30T23:59');
const AFTER = p('after', '2026-02-01T00:00', '2026-03-01T00:00');
const PARTLY = p('part', '2025-11-01T00:00', '2026-02-28T23:59');

const pc = (period: { start: string; end: string }, rows: number, running: number, index = 1): PeriodCount =>
    ({ index, start: period.start || null, end: period.end || null, valid: true, invalid_reason: null, rows_in_period: rows, running_rows: running, running_days: running / 288 });
const counts = (periods: PeriodCount[], total = 10_000): PeriodCounts => ({
    total_rows: total, interval_secs: 300, periods,
    union: {
        rows_in_period: periods.reduce((s, c) => s + c.rows_in_period, 0),
        running_rows: periods.reduce((s, c) => s + c.running_rows, 0),
        running_days: periods.reduce((s, c) => s + c.running_days, 0),
    },
});
const st = (status: PeriodCountsState['status'], train: PeriodCounts | null, scoring: PeriodCounts | null = null): PeriodCountsState =>
    ({ status, train, scoring, error: null, errorCode: null });

describe('Train period rows against the loaded data', () => {
    it('a period entirely outside the data: red edge, BOTH date fields red, one reason line with the data range — and no day count', () => {
        render(<TimePeriodsEditor periods={[INSIDE, AFTER]} onChange={() => {}} bounds={DATA} />);
        const row = screen.getByTestId('period-row-2');
        expect(row.getAttribute('data-invalid')).toBe('true');
        expect(row.className).toContain('rcm-per--bad');
        expect(screen.getByTestId('period-invalid-2').textContent).toBe('P2 is outside the data (1 Jan 2025 – 31 Dec 2025)');
        expect(screen.getByTestId('period-invalid-2').getAttribute('role')).toBe('alert');
        expect(screen.getByLabelText('P2 start').getAttribute('aria-invalid')).toBe('true');
        expect(screen.getByLabelText('P2 end').getAttribute('aria-invalid')).toBe('true');
        expect(screen.getByTestId('period-days-2').textContent).toBe('—');
        // the period inside the data is untouched
        expect(screen.getByTestId('period-row-1').getAttribute('data-invalid')).toBeNull();
        expect(screen.queryByTestId('period-invalid-1')).toBeNull();
        expect(screen.queryByTestId('period-data-note-1')).toBeNull();
    });

    it('typing a date beyond the data flags the row AT ONCE (on change, before blur) and hands the period up as typed', () => {
        const onChange = vi.fn();
        render(<TimePeriodsEditor periods={[INSIDE]} onChange={onChange} bounds={DATA} />);
        expect(screen.queryByTestId('period-invalid-1')).toBeNull();
        fireEvent.change(screen.getByLabelText('P1 start'), { target: { value: '2026-05-01T00:00' } });
        // the parent gets the complete date (it is what the guard judges); here the props are
        // not updated, so the editor judges its own typed value
        expect(onChange).toHaveBeenCalledWith([{ ...INSIDE, start: '2026-05-01T00:00' }]);
        // a reversed period first (its own reason) ...
        expect(screen.getByTestId('period-invalid-1').textContent).toMatch(/^P1 ends before it starts/);
        // ... and once the end is typed too, it is a period outside the data
        fireEvent.change(screen.getByLabelText('P1 end'), { target: { value: '2026-06-01T00:00' } });
        expect(screen.getByTestId('period-invalid-1').textContent).toBe('P1 is outside the data (1 Jan 2025 – 31 Dec 2025)');
    });

    it('a period PARTLY outside: one quiet amber note, nothing red, the days stay', () => {
        render(<TimePeriodsEditor periods={[PARTLY]} onChange={() => {}} bounds={DATA} />);
        const note = screen.getByTestId('period-data-note-1');
        expect(note.textContent).toBe('Only the part inside the data is used (data ends 31 Dec 2025)');
        expect(note.className).toBe('rcm-permsg rcm-permsg--warn');
        expect(note.getAttribute('role')).toBeNull(); // quiet: not an alert
        expect(screen.getByTestId('period-row-1').getAttribute('data-invalid')).toBeNull();
        expect(screen.queryByTestId('period-invalid-1')).toBeNull();
        expect(screen.getByLabelText('P1 end').getAttribute('aria-invalid')).toBeNull();
        expect(screen.getByTestId('period-days-1').textContent).not.toBe('—');
    });

    it('with the dataset bounds unknown nothing is flagged', () => {
        render(<TimePeriodsEditor periods={[AFTER]} onChange={() => {}} bounds={null} />);
        expect(screen.getByTestId('period-row-1').getAttribute('data-invalid')).toBeNull();
        expect(screen.queryByTestId('period-invalid-1')).toBeNull();
        expect(screen.queryByTestId('period-data-note-1')).toBeNull();
    });

    it('ONE train period with no running rows while another has some: an amber note on that row only; none while the count is on its way', () => {
        const other = p('b', '2025-06-01T00:00', '2025-06-30T23:59');
        const answer = counts([pc(INSIDE, 800, 640), pc(other, 800, 0, 2)]);
        const { rerender } = render(<TimePeriodsEditor periods={[INSIDE, other]} onChange={() => {}} bounds={DATA} counts={st('ok', answer)} />);
        expect(screen.getByTestId('period-no-rows-2').textContent).toBe('no running rows in P2');
        expect(screen.getByTestId('period-no-rows-2').className).toBe('rcm-permsg rcm-permsg--warn');
        expect(screen.queryByTestId('period-no-rows-1')).toBeNull();
        expect(screen.getByTestId('period-row-2').getAttribute('data-invalid')).toBeNull(); // a note, not a fault
        rerender(<TimePeriodsEditor periods={[INSIDE, other]} onChange={() => {}} bounds={DATA} counts={st('loading', answer)} />);
        expect(screen.queryByTestId('period-no-rows-2')).toBeNull();
    });

    it('when NO train period has rows the rows carry no note (the one red line under the timeline says it)', () => {
        const answer = counts([pc(INSIDE, 800, 0)]);
        render(<TimePeriodsEditor periods={[INSIDE]} onChange={() => {}} bounds={DATA} counts={st('ok', answer)} />);
        expect(screen.queryByTestId('period-no-rows-1')).toBeNull();
    });
});

describe('Scoring period rows against the loaded data', () => {
    const tests = (list: TestPeriod[], c: PeriodCountsState = PERIOD_COUNTS_IDLE) =>
        render(<TestPeriodsEditor tests={list} train={[INSIDE]} onChange={() => {}} bounds={DATA} counts={c} />);

    it('entirely outside: red row, both fields red, "S1 is outside the data (…)"', () => {
        tests([AFTER]);
        expect(screen.getByTestId('test-row-1').getAttribute('data-invalid')).toBe('true');
        expect(screen.getByTestId('test-invalid-1').textContent).toBe('S1 is outside the data (1 Jan 2025 – 31 Dec 2025)');
        expect(screen.getByLabelText('Scoring period 1 start').getAttribute('aria-invalid')).toBe('true');
        expect(screen.getByLabelText('Scoring period 1 end').getAttribute('aria-invalid')).toBe('true');
        expect(screen.queryByTestId('test-data-note-1')).toBeNull();
    });

    it('partly outside: the quiet amber note; a scoring period with no running rows: an amber note too — neither is a fault', () => {
        const before = p('s', '2024-12-01T00:00', '2025-01-15T00:00');
        tests([before], st('ok', null, counts([pc(before, 300, 0)])));
        expect(screen.getByTestId('test-data-note-1').textContent).toBe('Only the part inside the data is used (data starts 1 Jan 2025)');
        expect(screen.getByTestId('test-no-rows-1').textContent).toBe('no running rows in S1');
        expect(screen.getByTestId('test-no-rows-1').className).toBe('rcm-permsg rcm-permsg--warn');
        expect(screen.getByTestId('test-row-1').getAttribute('data-invalid')).toBeNull();
        expect(screen.queryByTestId('test-invalid-1')).toBeNull();
    });
});

describe('The timeline hero', () => {
    const show = (periods: TimePeriod[], tests: TestPeriod[], c: PeriodCountsState = PERIOD_COUNTS_IDLE, configured = true) =>
        render(<RunningConditionTimeline periods={periods} tests={tests} bounds={DATA} counts={c} configured={configured} />);

    it('a period outside the data is drawn RED, as a sliver on the edge it lies beyond', () => {
        show([INSIDE, AFTER], [p('s', '2024-02-01T00:00', '2024-03-01T00:00')]);
        const p2 = screen.getByTestId('rc-tl-P2');
        expect(p2.getAttribute('data-invalid')).toBe('true');
        expect(p2.getAttribute('data-outside')).toBe('true');
        expect(p2.className).toContain('bad');
        expect(p2.title).toMatch(/^P2 · .* — outside the data$/);
        expect(parseFloat(p2.style.left) + parseFloat(p2.style.width)).toBeCloseTo(100, 1); // right edge
        const s1 = screen.getByTestId('rc-tl-S1');
        expect(s1.getAttribute('data-outside')).toBe('true');
        expect(parseFloat(s1.style.left)).toBe(0); // left edge
        expect(screen.getByTestId('rc-tl-P1').getAttribute('data-invalid')).toBeNull();
        // no total while a train period needs fixing
        expect(screen.getByTestId('rc-caption').getAttribute('data-rows')).toBe('fix');
    });

    it('a SETTLED count of zero rows: one red line under the caption; never while loading, failed, or without a condition', () => {
        const zero = counts([pc(INSIDE, 800, 0)]);
        const { rerender } = show([INSIDE], [], st('ok', zero));
        const line = screen.getByTestId('rc-no-rows');
        expect(line.textContent).toBe('No rows match — nothing to train on. Widen a train period or relax the condition.');
        expect(line.getAttribute('role')).toBe('alert');
        expect(line.className).toBe('rct-norows');
        expect(screen.getByTestId('rc-caption-rows').textContent).toBe('0 of 10,000 rows (0%) used for training');

        const again = (c: PeriodCountsState, configured = true) =>
            rerender(<RunningConditionTimeline periods={[INSIDE]} tests={[]} bounds={DATA} counts={c} configured={configured} />);
        again(st('loading', zero));
        expect(screen.queryByTestId('rc-no-rows')).toBeNull();
        again({ status: 'error', train: null, scoring: null, error: 'failed', errorCode: null });
        expect(screen.queryByTestId('rc-no-rows')).toBeNull();
        again(st('ok', zero), false); // "Only when running" without a complete condition: nothing is counted for it
        expect(screen.queryByTestId('rc-no-rows')).toBeNull();
        again(st('ok', counts([pc(INSIDE, 800, 3)])));
        expect(screen.queryByTestId('rc-no-rows')).toBeNull();
    });
});

describe('The one-line running-condition card (the PERSISTED condition)', () => {
    const OK: RcCardRows = { status: 'ok', used: 11_066, total: 52_340 };
    const card = (over: Partial<React.ComponentProps<typeof RunningConditionCard>> = {}) => render(
        <SensorMetaProvider metadata={[]}>
            <RunningConditionCard
                state="set" periods={[INSIDE]} filters={[]} combine="and" noneConfirmed headers={null}
                getDesc={() => ''} getUnit={() => ''} rows={OK} bounds={DATA} onOpen={() => {}}
                {...over}
            />
        </SensorMetaProvider>,
    );

    it('a saved train period entirely outside the data: "P1 needs fixing" with that reason, the chip red, "Fix period"', () => {
        card({ state: 'invalid', periods: [AFTER] });
        expect(screen.getByTestId('rc-card').getAttribute('data-state')).toBe('invalid');
        expect(screen.getByTestId('rc-card-title').textContent).toBe('P1 needs fixing');
        expect(screen.getByTestId('rc-card-reason').textContent).toBe("P1 is outside the data (1 Jan 2025 – 31 Dec 2025). Models can't be trained until it's fixed.");
        expect(screen.getByTestId('rc-card-period-chip').className).toContain('rcc-chip--bad');
        expect(screen.getByTestId('rc-card-open').textContent).toBe('Fix period');
    });

    it('zero running rows: the line turns red — "!" instead of the tick, "0 rows — nothing to train on" — and Edit stays', () => {
        card({ noRows: true, rows: { status: 'ok', used: 0, total: 52_340 } });
        const el = screen.getByTestId('rc-card');
        expect(el.getAttribute('data-state')).toBe('set');
        expect(el.getAttribute('data-norows')).toBe('true');
        expect(el.className).toContain('rcc-card--bad');
        expect(el.className).not.toContain('rcc-card--ok');
        expect(screen.getByTestId('rc-card-tick').textContent).toBe('!');
        expect(screen.getByTestId('rc-card-tick').getAttribute('aria-label')).toBe('Nothing to train on');
        expect(screen.getByTestId('rc-card-use').textContent).toBe('0 rows — nothing to train on');
        expect(screen.getByTestId('rc-card-no-rows').className).toBe('rcc-line-bad');
        expect(screen.getByTestId('rc-card-no-rows').getAttribute('role')).toBe('alert');
        expect(screen.queryByTestId('rc-card-pct')).toBeNull();
        expect(screen.getByTestId('rc-card-open').textContent).toBe('Edit');
        // the same state in the unfolded card
        fireEvent.click(screen.getByTestId('rc-card-details'));
        expect(screen.getByTestId('rc-card').className).toContain('rcc-card--bad');
        expect(within(screen.getByTestId('rc-card-use')).getByTestId('rc-card-no-rows').textContent).toBe('rows — nothing to train on');
    });

    it('with rows the card is the usual green line', () => {
        card();
        expect(screen.getByTestId('rc-card').getAttribute('data-norows')).toBeNull();
        expect(screen.getByTestId('rc-card').className).toContain('rcc-card--ok');
        expect(screen.queryByTestId('rc-card-no-rows')).toBeNull();
        expect(screen.getByTestId('rc-card-rows').textContent).toBe('11,066');
    });

    it('a saved SCORING period outside the data is shown as before (nothing enforces a data rule on it there)', () => {
        card({ testPeriods: [AFTER] });
        expect(screen.queryByTestId('rc-card-test-bad')).toBeNull();
        expect(screen.getByTestId('rc-card-test').textContent).toBe('Scoring 1 period');
    });
});
