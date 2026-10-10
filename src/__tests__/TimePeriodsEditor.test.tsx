import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import TimePeriodsEditor from '../components/windows/TimePeriodsEditor';
import type { PeriodCountsState } from '../utils/periodCounts';
import type { PeriodCount, PeriodCounts } from '../types/periodCounts';

afterEach(cleanup);

const bounds = { min: '2026-01-01 00:00:00', max: '2026-03-15 12:00:00' };

const A = { id: 'a', start: '2026-01-01T00:00', end: '2026-01-31T23:59' };
const B = { id: 'b', start: '2026-02-15T00:00', end: '2026-03-10T23:59' };

/** One counted period, as `count_period_rows` answers it. */
const counted = (index: number, p: { start: string; end: string }, runningDays: number): PeriodCount => ({
    index, start: p.start || null, end: p.end || null, valid: true, invalid_reason: null,
    rows_in_period: 1000, running_rows: 800, running_days: runningDays,
});
const answer = (periods: PeriodCount[]): PeriodCounts => ({
    total_rows: 25_880, interval_secs: 300, periods,
    union: { rows_in_period: 2000, running_rows: 1600, running_days: periods.reduce((s, p) => s + p.running_days, 0) },
});
const state = (status: PeriodCountsState['status'], train: PeriodCounts | null): PeriodCountsState =>
    ({ status, train, scoring: null, error: status === 'error' ? 'boom' : null, errorCode: null });

describe('TimePeriodsEditor — adding and committing', () => {
    it('empty list: asks for a train period; Add seeds the first period from the data start to that month end', () => {
        const onChange = vi.fn();
        render(<TimePeriodsEditor periods={[]} onChange={onChange} bounds={bounds} />);
        expect(screen.getByTestId('periods-empty')).toBeTruthy();
        fireEvent.click(screen.getByTestId('period-add'));
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange.mock.calls[0][0][0]).toMatchObject({ start: '2026-01-01T00:00', end: '2026-01-31T23:59' });
    });

    it('Add is disabled once the periods cover the whole dataset, with a reason', () => {
        render(<TimePeriodsEditor
            periods={[{ id: 'a', start: '2025-12-01T00:00', end: '2026-03-31T23:59' }]}
            onChange={vi.fn()}
            bounds={bounds}
        />);
        const add = screen.getByTestId('period-add') as HTMLButtonElement;
        expect(add.disabled).toBe(true);
        expect(add.title).toMatch(/cover the whole dataset/);
    });

    it('Add is disabled while the last period has an open end (nothing sensible to append)', () => {
        render(<TimePeriodsEditor periods={[{ id: 'a', start: '2026-01-01T00:00', end: '' }]} onChange={vi.fn()} bounds={null} />);
        expect((screen.getByTestId('period-add') as HTMLButtonElement).disabled).toBe(true);
    });

    it('Add clamps the new period to the dataset end', () => {
        const onChange = vi.fn();
        render(<TimePeriodsEditor periods={[{ id: 'a', start: '2026-01-01T00:00', end: '2026-02-28T23:59' }]} onChange={onChange} bounds={bounds} />);
        fireEvent.click(screen.getByTestId('period-add'));
        expect(onChange.mock.calls[0][0][1]).toMatchObject({ start: '2026-03-01T00:00', end: '2026-03-15T12:00' });
    });

    it('typing only edits the local draft; Enter commits (sorted)', () => {
        const onChange = vi.fn();
        render(<TimePeriodsEditor
            periods={[{ id: 'b', start: '2026-03-01T00:00', end: '2026-03-31T23:59' }, { id: 'a', start: '2026-01-01T00:00', end: '2026-01-31T23:59' }]}
            onChange={onChange}
        />);
        const start = screen.getByLabelText('P1 start');
        fireEvent.change(start, { target: { value: '2026-03-02T00:00' } });
        expect(onChange).not.toHaveBeenCalled();
        fireEvent.keyDown(start, { key: 'Enter' });
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange.mock.calls[0][0].map((p: { id: string }) => p.id)).toEqual(['a', 'b']);
    });

    it('blur without any edit does not call onChange', () => {
        const onChange = vi.fn();
        render(<TimePeriodsEditor periods={[A]} onChange={onChange} />);
        fireEvent.blur(screen.getByLabelText('P1 end'));
        expect(onChange).not.toHaveBeenCalled();
    });

    it('an unfinished (blank) draft value does not swap the input for the open-ended box mid-typing', () => {
        render(<TimePeriodsEditor periods={[A]} onChange={vi.fn()} bounds={bounds} />);
        fireEvent.change(screen.getByLabelText('P1 start'), { target: { value: '' } });
        // still the input — the box only appears once the COMMITTED value is blank
        expect(screen.getByLabelText('P1 start')).toBeTruthy();
        expect(screen.queryByTestId('period-open-start')).toBeNull();
    });
});

describe('TimePeriodsEditor — one quiet line per period (workbench redesign §5)', () => {
    it('a row is "P1 · start → end · days · bin"; nothing says "Period 1" (not even the accessible names)', () => {
        render(<TimePeriodsEditor periods={[A]} onChange={vi.fn()} bounds={bounds} />);
        const row = screen.getByTestId('period-row-1');
        expect(row.className).toBe('rcm-per');
        expect(row.querySelector('.rcm-pn')!.textContent).toBe('P1');
        expect(row.querySelector('.rcm-arrow')!.textContent).toBe('→');
        // 1 Jan 00:00 -> 31 Jan 23:59, rounded; no count yet -> calendar days only
        expect(screen.getByTestId('period-days-1').textContent).toBe('31 d');
        expect(screen.queryByTestId('period-running-1')).toBeNull();
        expect(screen.getByLabelText('Remove P1').className).toContain('rcm-ib');
        expect(screen.getByLabelText('P1 start')).toBeTruthy();
        expect(screen.getByLabelText('P1 end')).toBeTruthy();
        expect(screen.getAllByLabelText('Open date picker')).toHaveLength(2); // one calendar button per field
        expect(document.body.innerHTML).not.toMatch(/Period 1/i);
    });

    it('no coverage strip and no "new period starts after" hint in the list any more (the timeline hero is above it)', () => {
        render(<TimePeriodsEditor periods={[A]} onChange={vi.fn()} bounds={bounds} />);
        expect(screen.queryByTestId('period-coverage')).toBeNull();
        expect(document.querySelector('.f4-strip')).toBeNull();
        expect(screen.getByTestId('time-periods-editor').textContent).not.toMatch(/starts after the last one/);
    });

    it('with a count: "81 d · 69 d running" style — each row finds its own number by its bounds', () => {
        render(<TimePeriodsEditor
            periods={[A, B]}
            onChange={vi.fn()}
            bounds={bounds}
            counts={state('ok', answer([counted(0, A, 26.4), counted(1, B, 7.25)]))}
        />);
        expect(screen.getByTestId('period-days-1').textContent).toBe('31 d · 26 d running');
        expect(screen.getByTestId('period-days-2').textContent).toBe('24 d · 7.3 d running');
        expect(screen.getByTestId('period-running-1').getAttribute('data-stale')).toBeNull();
    });

    it('while a new count is on its way the previous numbers stay, dimmed — no flicker to a blank', () => {
        render(<TimePeriodsEditor periods={[A]} onChange={vi.fn()} bounds={bounds} counts={state('loading', answer([counted(0, A, 26.4)]))} />);
        const running = screen.getByTestId('period-running-1');
        expect(running.textContent).toBe(' · 26 d running');
        expect(running.getAttribute('data-stale')).toBe('true');
        expect(running.className).toContain('rct-stale');
    });

    it('a failed count shows the calendar days only — never an error in the row', () => {
        render(<TimePeriodsEditor periods={[A]} onChange={vi.fn()} bounds={bounds} counts={state('error', null)} />);
        expect(screen.getByTestId('period-days-1').textContent).toBe('31 d');
    });

    it('a period being typed loses its running days until the new count lands (the count is for the old dates)', () => {
        render(<TimePeriodsEditor periods={[A]} onChange={vi.fn()} bounds={bounds} counts={state('ok', answer([counted(0, A, 26.4)]))} />);
        fireEvent.change(screen.getByLabelText('P1 end'), { target: { value: '2026-01-20T23:59' } });
        expect(screen.getByTestId('period-days-1').textContent).toBe('20 d');
    });

    it('deleting a row reports the list without it', () => {
        const onChange = vi.fn();
        render(<TimePeriodsEditor periods={[A, B]} onChange={onChange} bounds={bounds} />);
        fireEvent.click(screen.getByLabelText('Remove P1'));
        expect(onChange.mock.calls[0][0]).toEqual([B]);
    });

    it('empty state: one amber line "No train period yet — add at least one" (no box, never "the whole dataset") and the Add button', () => {
        render(<TimePeriodsEditor periods={[]} onChange={vi.fn()} bounds={bounds} />);
        const line = screen.getByTestId('periods-empty');
        expect(line.className).toBe('rcx-line rcx-line--warn');
        expect(line.textContent).toBe('No train period yet — add at least one');
        const add = screen.getByTestId('period-add');
        expect(add.className).toContain('rcm-add');
        expect(add.textContent).toBe('Add train period');
    });

    it('open ends read "Start of data" / "End of data" with Set date; Set date fills the dataset bound', () => {
        const onChange = vi.fn();
        render(<TimePeriodsEditor periods={[{ id: 'a', start: '', end: '' }]} onChange={onChange} bounds={bounds} />);
        expect(screen.getByTestId('period-open-start').textContent).toContain('Start of data');
        expect(screen.getByTestId('period-open-end').textContent).toContain('End of data');
        expect(screen.getByTestId('period-days-1').textContent).toBe('74 d'); // the whole dataset
        fireEvent.click(screen.getByLabelText('Set end date'));
        expect(onChange.mock.calls[0][0]).toEqual([{ id: 'a', start: '', end: '2026-03-15T12:00' }]);
    });

    it('the × on the first start / last end switches it back to open-ended', () => {
        const onChange = vi.fn();
        render(<TimePeriodsEditor periods={[A, B]} onChange={onChange} bounds={bounds} />);
        // only the first period's start and the last period's end can be open
        expect(screen.getAllByTestId('period-open-toggle-start')).toHaveLength(1);
        expect(screen.getAllByTestId('period-open-toggle-end')).toHaveLength(1);
        fireEvent.click(screen.getByTestId('period-open-toggle-end'));
        expect(onChange.mock.calls[0][0][1]).toEqual({ ...B, end: '' });
    });

    it('Add is disabled once everything is covered', () => {
        render(<TimePeriodsEditor periods={[{ id: 'a', start: '', end: '' }]} onChange={vi.fn()} bounds={bounds} />);
        expect((screen.getByTestId('period-add') as HTMLButtonElement).disabled).toBe(true);
    });
});

describe('TimePeriodsEditor — invalid and overlapping periods', () => {
    it('end before start: thin red edge on the row, the END field red, "—" for the days and ONE reason line that names P2', () => {
        render(<TimePeriodsEditor
            periods={[A, { id: 'b', start: '2026-05-11T00:00', end: '2026-05-01T00:00' }]}
            onChange={vi.fn()}
            bounds={bounds}
        />);
        const row = screen.getByTestId('period-row-2');
        expect(row.className).toContain('rcm-per--bad');
        expect(row.getAttribute('data-invalid')).toBe('true');
        expect(screen.getByTestId('period-days-2').textContent).toBe('—');
        const end = screen.getByLabelText('P2 end');
        expect(end.closest('.f4-dtw')!.className).toContain('f4-dtw--bad');
        expect(end.getAttribute('aria-invalid')).toBe('true');
        expect(screen.getByLabelText('P2 start').closest('.f4-dtw')!.className).not.toContain('f4-dtw--bad');
        const reason = screen.getByTestId('period-invalid-2');
        expect(reason.getAttribute('role')).toBe('alert');
        expect(reason.textContent).toBe('P2 ends before it starts — pick an end after 11 May 2026');
        // the valid row is untouched
        expect(screen.getByTestId('period-row-1').className).toBe('rcm-per');
        expect(screen.queryByTestId('period-invalid-1')).toBeNull();
    });

    it('an open end on a period that is not the last: the reason says what it needs, the open END box is the red one', () => {
        render(<TimePeriodsEditor
            periods={[{ id: 'a', start: '2026-01-01T00:00', end: '' }, B]}
            onChange={vi.fn()}
            bounds={bounds}
        />);
        expect(screen.getByTestId('period-invalid-1').textContent).toBe('P1 needs an end date');
        expect(screen.getByTestId('period-open-end').className).toContain('f4-openb--bad');
        expect(screen.getByTestId('period-invalid-1').textContent).not.toMatch(/Period/);
    });

    it('overlap: one quiet line under the LATER row with "Merge into one" inline — not a frame, not a block', () => {
        const onChange = vi.fn();
        const C = { id: 'c', start: '2026-01-20T00:00', end: '2026-02-10T23:59' };
        render(<TimePeriodsEditor periods={[A, C]} onChange={onChange} bounds={bounds} />);
        const note = screen.getByTestId('period-overlap-2');
        expect(note.className).toBe('rcm-permsg');
        expect(note.textContent).toBe('P2 overlaps P1 by 12 d — rows in both are used once.Merge into one');
        expect(screen.getByTestId('period-row-2').className).toBe('rcm-per'); // no coloured frame
        expect(screen.queryByTestId('period-overlap-1')).toBeNull();
        fireEvent.click(screen.getByTestId('period-merge-2'));
        expect(onChange.mock.calls[0][0]).toEqual([{ id: 'a', start: A.start, end: C.end }]);
    });

    it('touching periods (23:59 -> next 00:00) are not an overlap', () => {
        render(<TimePeriodsEditor
            periods={[A, { id: 'b', start: '2026-02-01T00:00', end: '2026-02-28T23:59' }]}
            onChange={vi.fn()}
        />);
        expect(screen.queryByTestId('period-overlap-2')).toBeNull();
    });
});
