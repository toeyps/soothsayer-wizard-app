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
 * "No data to train on" is stopped at the UI — what the
 * Running-condition rows, the timeline and the one-line card SHOW:
 *   - a period entirely outside the loaded data that is NEW / CHANGED in the
 *     draft: red edge, both date fields red, ONE reason line, a red sliver on
 *     the timeline (Apply / Save changes are blocked);
 *   - one that is exactly as it was SAVED: an amber edge, an amber sentence, an
 *     amber sliver, an amber line on the card — nothing is blocked;
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

    it('a period that is exactly as it was SAVED and lies outside the data only WARNS: amber edge and sentence, no red field, not an alert — until it is changed', () => {
        render(<TimePeriodsEditor periods={[INSIDE, AFTER]} onChange={() => {}} bounds={DATA} savedPeriods={[INSIDE, AFTER]} />);
        const row = screen.getByTestId('period-row-2');
        expect(row.getAttribute('data-invalid')).toBeNull();
        expect(row.getAttribute('data-outside')).toBe('true');
        expect(row.className).toContain('rcm-per--warn');
        expect(row.className).not.toContain('rcm-per--bad');
        const note = screen.getByTestId('period-data-note-2');
        expect(note.textContent).toBe('P2 is outside the data (1 Jan 2025 – 31 Dec 2025) — it is not used');
        expect(note.className).toBe('rcm-permsg rcm-permsg--warn');
        expect(note.getAttribute('role')).toBeNull();
        expect(screen.queryByTestId('period-invalid-2')).toBeNull();
        expect(screen.getByLabelText('P2 start').getAttribute('aria-invalid')).toBeNull();
        expect(screen.getByLabelText('P2 end').getAttribute('aria-invalid')).toBeNull();
        // moved to another place outside the data: now it is what the user picks — invalid
        fireEvent.change(screen.getByLabelText('P2 end'), { target: { value: '2026-04-01T00:00' } });
        expect(screen.getByTestId('period-invalid-2').textContent).toBe('P2 is outside the data (1 Jan 2025 – 31 Dec 2025)');
        expect(screen.getByTestId('period-row-2').getAttribute('data-invalid')).toBe('true');
        // typed back to what was saved: the warning again
        fireEvent.change(screen.getByLabelText('P2 end'), { target: { value: AFTER.end } });
        expect(screen.queryByTestId('period-invalid-2')).toBeNull();
        expect(screen.getByTestId('period-data-note-2')).toBeTruthy();
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

    it('exactly as it was SAVED and outside the data: an amber warning only — "S1 is outside the data — nothing is scored there"', () => {
        render(<TestPeriodsEditor tests={[AFTER]} train={[INSIDE]} onChange={() => {}} bounds={DATA} savedTests={[AFTER]} counts={st('ok', null, counts([pc(AFTER, 0, 0)]))} />);
        const row = screen.getByTestId('test-row-1');
        expect(row.getAttribute('data-invalid')).toBeNull();
        expect(row.getAttribute('data-outside')).toBe('true');
        expect(row.className).toContain('rcm-per--warn');
        expect(screen.getByTestId('test-data-note-1').textContent).toBe('S1 is outside the data — nothing is scored there');
        expect(screen.queryByTestId('test-invalid-1')).toBeNull();
        expect(screen.getByLabelText('Scoring period 1 start').getAttribute('aria-invalid')).toBeNull();
        // one sentence is enough: no second "no running rows in S1" under it
        expect(screen.queryByTestId('test-no-rows-1')).toBeNull();
        // changed: invalid
        fireEvent.change(screen.getByLabelText('Scoring period 1 start'), { target: { value: '2026-02-02T00:00' } });
        expect(screen.getByTestId('test-invalid-1').textContent).toBe('S1 is outside the data (1 Jan 2025 – 31 Dec 2025)');
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

    it('a SAVED period outside the data is an AMBER sliver (a warning), and the rows are counted as usual', () => {
        const before = p('s', '2024-02-01T00:00', '2024-03-01T00:00');
        render(<RunningConditionTimeline periods={[INSIDE, AFTER]} tests={[before]} bounds={DATA} counts={st('ok', counts([pc(INSIDE, 800, 640), pc(AFTER, 0, 0, 2)]))} savedPeriods={[INSIDE, AFTER]} savedTests={[before]} />);
        const p2 = screen.getByTestId('rc-tl-P2');
        expect(p2.getAttribute('data-outside')).toBe('true');
        expect(p2.getAttribute('data-invalid')).toBeNull();
        expect(p2.className).toContain('warn');
        expect(p2.className).not.toContain('bad');
        expect(p2.title).toMatch(/^P2 · .* — outside the data, not used$/);
        expect(screen.getByTestId('rc-tl-S1').title).toMatch(/— outside the data, nothing is scored there$/);
        expect(screen.getByTestId('rc-caption').getAttribute('data-rows')).toBe('counted');
        expect(screen.getByTestId('rc-caption-rows').textContent).toBe('640 of 10,000 rows (6%) used for training');
    });

    it('an OPEN-ENDED period outside the data is the outside sliver too, titled "outside the data" (not "not valid")', () => {
        show([p('o', '', '2024-06-01T00:00')], []);
        const p1 = screen.getByTestId('rc-tl-P1');
        expect(p1.getAttribute('data-outside')).toBe('true');
        expect(p1.title).toMatch(/— outside the data$/);
        expect(parseFloat(p1.style.width)).toBeLessThan(2);
    });

    it('"Use all rows" has no condition to relax: the no-rows line only says "Widen a train period"', () => {
        render(<RunningConditionTimeline periods={[INSIDE]} tests={[]} bounds={DATA} counts={st('ok', counts([pc(INSIDE, 800, 0)]))} usesAllRows />);
        expect(screen.getByTestId('rc-no-rows').textContent).toBe('No rows match — nothing to train on. Widen a train period.');
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

    it('a saved train period outside the data NEXT TO one inside it: the card stays green and "set" — one amber line says it is not used', () => {
        card({ periods: [INSIDE, AFTER] });
        const el = screen.getByTestId('rc-card');
        expect(el.getAttribute('data-state')).toBe('set');
        expect(el.getAttribute('data-norows')).toBeNull();
        expect(el.className).toContain('rcc-card--ok');
        const warn = screen.getByTestId('rc-card-outside');
        expect(warn.textContent).toBe('⚠ P2 is outside the data (1 Jan 2025 – 31 Dec 2025) — it is not used');
        expect(warn.className).toContain('rcc-line-warn');
        expect(warn.getAttribute('role')).toBe('status');
        expect(screen.getByTestId('rc-card-rows').textContent).toBe('11,066'); // the count is still shown
        expect(screen.getByTestId('rc-card-open').textContent).toBe('Edit');
        // unfolded: the chip is amber (never red), the pill stays "Set"
        fireEvent.click(screen.getByTestId('rc-card-details'));
        const chips = screen.getAllByTestId('rc-card-period-chip');
        expect(chips[1].className).toContain('rcc-chip--warn');
        expect(chips[1].className).not.toContain('rcc-chip--bad');
        expect(chips[1].getAttribute('data-outside')).toBe('true');
        expect(chips[0].getAttribute('data-outside')).toBeNull();
        expect(screen.getByTestId('rc-card-pill').textContent).toBe('Set');
        expect(screen.getByTestId('rc-card-outside').textContent).toContain('P2 is outside the data');
    });

    it('NO saved train period inside the data: the red "nothing to train on" card (never "P1 needs fixing" — the user did not just pick it)', () => {
        card({ periods: [AFTER], rows: { status: 'loading', used: null, total: null } });
        const el = screen.getByTestId('rc-card');
        expect(el.getAttribute('data-state')).toBe('set');
        expect(el.getAttribute('data-norows')).toBe('true');
        expect(el.className).toContain('rcc-card--bad');
        expect(screen.queryByTestId('rc-card-title')).toBeNull();
        expect(screen.getByTestId('rc-card-use').textContent).toBe('0 rows — nothing to train on');
        expect(screen.getByTestId('rc-card-no-rows').title).toBe('No train period is inside the data (1 Jan 2025 – 31 Dec 2025) — move a train period inside the data');
        expect(screen.getByTestId('rc-card-outside').textContent).toBe('⚠ P1 is outside the data (1 Jan 2025 – 31 Dec 2025) — it is not used');
        expect(screen.getByTestId('rc-card-open').textContent).toBe('Edit');
    });

    it('the "invalid" state is the plain date rules only: a reversed period — the data range is not part of it', () => {
        card({ state: 'invalid', periods: [p('r', '2025-05-02T00:00', '2025-05-01T00:00')] });
        expect(screen.getByTestId('rc-card-title').textContent).toBe('P1 needs fixing');
        expect(screen.getByTestId('rc-card-reason').textContent).toBe("P1 ends before it starts. Models can't be trained until it's fixed.");
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
        // "Use all rows" (this fixture): there is no condition to relax
        expect(screen.getByTestId('rc-card-no-rows').title).toBe('No rows inside the train periods — widen a train period');
        // the same state in the unfolded card — and never a green "Set" pill on the red card
        fireEvent.click(screen.getByTestId('rc-card-details'));
        expect(screen.getByTestId('rc-card').className).toContain('rcc-card--bad');
        expect(within(screen.getByTestId('rc-card-use')).getByTestId('rc-card-no-rows').textContent).toBe('rows — nothing to train on');
        const pill = screen.getByTestId('rc-card-pill');
        expect(pill.textContent).toBe('Nothing to train on');
        expect(pill.className).toContain('f4-pill--bad');
        expect(pill.className).not.toContain('f4-pill--ok');
    });

    it('with a condition the no-rows tooltip also offers relaxing it', () => {
        card({
            noRows: true, noneConfirmed: false, rows: { status: 'ok', used: 0, total: 52_340 },
            filters: [{ id: 'f', sensor: 'TAG1', operation: 'greater_than', value1: '5', value2: '' }],
        });
        expect(screen.getByTestId('rc-card-no-rows').title).toBe('No rows match the running condition inside the train periods — widen a train period or relax the condition');
    });

    it('with rows the card is the usual green line', () => {
        card();
        expect(screen.getByTestId('rc-card').getAttribute('data-norows')).toBeNull();
        expect(screen.getByTestId('rc-card').className).toContain('rcc-card--ok');
        expect(screen.queryByTestId('rc-card-no-rows')).toBeNull();
        expect(screen.getByTestId('rc-card-rows').textContent).toBe('11,066');
    });

    it('a saved SCORING period outside the data: never "to fix" — one amber line says nothing is scored there, the chip is amber', () => {
        card({ testPeriods: [AFTER] });
        expect(screen.queryByTestId('rc-card-test-bad')).toBeNull();
        expect(screen.getByTestId('rc-card-test').textContent).toBe('Scoring 1 period');
        expect(screen.getByTestId('rc-card-outside').textContent).toBe('⚠ S1 is outside the data — nothing is scored there');
        expect(screen.getByTestId('rc-card').className).toContain('rcc-card--ok');
        fireEvent.click(screen.getByTestId('rc-card-details'));
        const chip = screen.getByTestId('rc-card-test-chip');
        expect(chip.className).toContain('rcc-chip--warn');
        expect(chip.className).not.toContain('rcc-chip--bad');
        expect(chip.title).toBe('S1 is outside the data — nothing is scored there');
    });

    it('with the dataset bounds unknown the card warns about nothing', () => {
        card({ periods: [INSIDE, AFTER], testPeriods: [AFTER], bounds: null });
        expect(screen.queryByTestId('rc-card-outside')).toBeNull();
        expect(screen.getByTestId('rc-card').getAttribute('data-norows')).toBeNull();
    });
});
