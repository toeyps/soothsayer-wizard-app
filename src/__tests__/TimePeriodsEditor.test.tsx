import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import TimePeriodsEditor, { PeriodReadOnlyList } from '../components/windows/TimePeriodsEditor';

afterEach(cleanup);

const bounds = { min: '2026-01-01 00:00:00', max: '2026-03-15 12:00:00' };

describe('TimePeriodsEditor', () => {
    it('empty list: shows "no time limit"; Add seeds the first period from the data start to that month end', () => {
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
        const start = screen.getByLabelText('Period 1 start');
        fireEvent.change(start, { target: { value: '2026-03-02T00:00' } });
        expect(onChange).not.toHaveBeenCalled();
        fireEvent.keyDown(start, { key: 'Enter' });
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange.mock.calls[0][0].map((p: { id: string }) => p.id)).toEqual(['a', 'b']);
    });

    it('blur without any edit does not call onChange', () => {
        const onChange = vi.fn();
        render(<TimePeriodsEditor periods={[{ id: 'a', start: '2026-01-01T00:00', end: '2026-01-31T23:59' }]} onChange={onChange} />);
        fireEvent.blur(screen.getByLabelText('Period 1 end'));
        expect(onChange).not.toHaveBeenCalled();
    });

    it('touching periods (23:59 -> next 00:00) are not an overlap', () => {
        render(<TimePeriodsEditor
            periods={[{ id: 'a', start: '2026-01-01T00:00', end: '2026-01-31T23:59' }, { id: 'b', start: '2026-02-01T00:00', end: '2026-02-28T23:59' }]}
            onChange={vi.fn()}
        />);
        expect(screen.queryByTestId('period-overlap-2')).toBeNull();
    });
});

describe('TimePeriodsEditor - approved-mockup structure (wide rows)', () => {
    const A = { id: 'a', start: '2026-01-01T00:00', end: '2026-01-31T23:59' };
    const B = { id: 'b', start: '2026-02-15T00:00', end: '2026-03-10T23:59' };

    it('each row is a bordered card: index, start, arrow, end, duration in days, remove', () => {
        render(<TimePeriodsEditor periods={[A]} onChange={vi.fn()} bounds={bounds} />);
        const row = screen.getByTestId('period-row-1');
        expect(row.className).toContain('f4-prow');
        expect(row.querySelector('.f4-pnum')!.textContent).toBe('1');
        expect(row.querySelector('.f4-arrow')!.textContent).toBe('→');
        expect(row.querySelector('.f4-dur')!.textContent).toBe('31 d'); // 1 Jan 00:00 -> 31 Jan 23:59, rounded
        expect(screen.getByLabelText('Remove period 1')).toBeTruthy();
        expect(screen.getByLabelText('Period 1 start')).toBeTruthy();
        expect(screen.getAllByLabelText('Open date picker')).toHaveLength(2); // one calendar button per field
    });

    it('draws the coverage bar above the rows with "N of M days used"', () => {
        render(<TimePeriodsEditor periods={[A]} onChange={vi.fn()} bounds={bounds} />);
        expect(screen.getByTestId('period-coverage')).toBeTruthy();
        expect(screen.getByTestId('period-coverage-days').textContent).toBe('31 of 74 days used');
    });

    it('no coverage bar while the dataset bounds are unknown', () => {
        render(<TimePeriodsEditor periods={[A]} onChange={vi.fn()} bounds={null} />);
        expect(screen.queryByTestId('period-coverage')).toBeNull();
    });

    it('empty state is the dashed "No limit" box with the dataset day count', () => {
        render(<TimePeriodsEditor periods={[]} onChange={vi.fn()} bounds={bounds} />);
        const box = screen.getByTestId('periods-empty');
        expect(box.className).toContain('f4-empty');
        expect(box.textContent).toMatch(/No limit — the full dataset \((74 days)\) is used\./);
    });

    it('the first period start / last period end show a "⟵" / "⟶" toggle that makes that side open-ended', () => {
        const onChange = vi.fn();
        render(<TimePeriodsEditor periods={[A, B]} onChange={onChange} bounds={bounds} />);
        expect(screen.getAllByTestId('period-open-toggle-start')).toHaveLength(1); // first row only
        expect(screen.getAllByTestId('period-open-toggle-end')).toHaveLength(1); // last row only
        fireEvent.click(screen.getByTestId('period-open-toggle-start'));
        expect(onChange.mock.calls[0][0][0]).toMatchObject({ id: 'a', start: '' });
    });

    it('an open side renders the dashed "Start of data" box with a "Set date" button that commits the dataset bound', () => {
        const onChange = vi.fn();
        render(<TimePeriodsEditor periods={[{ ...A, start: '' }]} onChange={onChange} bounds={bounds} />);
        expect(screen.getByTestId('period-open-start').textContent).toContain('Start of data');
        expect(screen.getByTestId('period-open-start').className).toContain('f4-openb');
        fireEvent.click(screen.getByLabelText('Set start date'));
        expect(onChange.mock.calls[0][0][0]).toMatchObject({ id: 'a', start: '2026-01-01T00:00' });
    });

    it('an unfinished (blank) draft value does not swap the input for the open-ended box mid-typing', () => {
        render(<TimePeriodsEditor periods={[A]} onChange={vi.fn()} bounds={bounds} />);
        const start = screen.getByLabelText('Period 1 start');
        fireEvent.change(start, { target: { value: '' } }); // datetime-local reports '' while a date is half-typed
        expect(screen.getByLabelText('Period 1 start')).toBeTruthy();
        expect(screen.queryByTestId('period-open-start')).toBeNull();
    });

    it('overlap is a warning on the LATER row with the overlap length and a Merge button; the strip block is hatched', () => {
        const onChange = vi.fn();
        render(<TimePeriodsEditor periods={[A, { id: 'c', start: '2026-01-20T00:00', end: '2026-02-10T00:00' }]} onChange={onChange} bounds={bounds} />);
        const row = screen.getByTestId('period-row-2');
        expect(row.className).toContain('f4-prow--ovl');
        expect(screen.getByTestId('period-overlap-2').textContent).toBe('Overlaps period 1 by 12 d — rows in both are used once.Merge into one');
        expect(document.querySelectorAll('.f4-strip i.ovl')).toHaveLength(1);
        fireEvent.click(screen.getByTestId('period-merge-2'));
        expect(onChange.mock.calls[0][0]).toEqual([{ id: 'a', start: A.start, end: '2026-02-10T00:00' }]);
    });

    it('an end before its start is a red row with the mockup message, "—" duration, red end field and a red strip block', () => {
        render(<TimePeriodsEditor periods={[{ id: 'x', start: '2026-02-01T00:00', end: '2026-01-05T00:00' }]} onChange={vi.fn()} bounds={bounds} />);
        const row = screen.getByTestId('period-row-1');
        expect(row.className).toContain('f4-prow--bad');
        expect(row.querySelector('.f4-dur')!.textContent).toBe('—');
        expect(screen.getByTestId('period-invalid-1').textContent).toBe('End is before start — pick an end after 1 Feb 2026. This period is ignored and building is blocked until fixed.');
        expect(row.querySelector('.f4-dtw--bad')).not.toBeNull();
        expect(document.querySelectorAll('.f4-strip i.bad')).toHaveLength(1);
    });

    it('Add is disabled with the "Periods already cover all data" note once everything is covered', () => {
        render(<TimePeriodsEditor periods={[{ id: 'a', start: '2025-12-01T00:00', end: '2026-03-31T23:59' }]} onChange={vi.fn()} bounds={bounds} />);
        expect((screen.getByTestId('period-add') as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByText('Periods already cover all data')).toBeTruthy();
    });

    it('the hint next to Add says where the new period starts', () => {
        render(<TimePeriodsEditor periods={[A]} onChange={vi.fn()} bounds={bounds} />);
        expect(screen.getByText('new period starts after the last one')).toBeTruthy();
    });
});

describe('TimePeriodsEditor - compact (300 px sidebar) rows', () => {
    const A = { id: 'a', start: '2026-01-01T00:00', end: '2026-01-31T23:59' };
    const B = { id: 'b', start: '2026-02-15T00:00', end: '2026-03-10T23:59' };

    it('rows start collapsed: label + day count, no inputs; the header expands ONE row at a time', () => {
        render(<TimePeriodsEditor compact periods={[A, B]} onChange={vi.fn()} bounds={bounds} />);
        expect(screen.queryByLabelText('Period 1 start')).toBeNull();
        expect(screen.getByTestId('period-row-1').textContent).toContain('1 Jan – 31 Jan 2026');
        expect(screen.getByTestId('period-row-1').querySelector('.f4-count')!.textContent).toBe('31 d');
        fireEvent.click(screen.getByTestId('period-toggle-1'));
        expect(screen.getByLabelText('Period 1 start')).toBeTruthy();
        expect(screen.getByText('From')).toBeTruthy();
        expect(screen.getByText('To')).toBeTruthy();
        fireEvent.click(screen.getByTestId('period-toggle-2'));
        expect(screen.queryByLabelText('Period 1 start')).toBeNull(); // accordion
        expect(screen.getByLabelText('Period 2 start')).toBeTruthy();
    });

    it('Done collapses, Remove period deletes the row', () => {
        const onChange = vi.fn();
        render(<TimePeriodsEditor compact periods={[A]} onChange={onChange} bounds={bounds} />);
        fireEvent.click(screen.getByTestId('period-toggle-1'));
        fireEvent.click(screen.getByText('Done'));
        expect(screen.queryByLabelText('Period 1 start')).toBeNull();
        fireEvent.click(screen.getByTestId('period-toggle-1'));
        fireEvent.click(screen.getByText('Remove period'));
        expect(onChange.mock.calls[0][0]).toEqual([]);
    });

    it('a newly added period opens expanded', () => {
        const onChange = vi.fn();
        const { rerender } = render(<TimePeriodsEditor compact periods={[A]} onChange={onChange} bounds={bounds} />);
        fireEvent.click(screen.getByTestId('period-add'));
        const next = onChange.mock.calls[0][0];
        rerender(<TimePeriodsEditor compact periods={next} onChange={onChange} bounds={bounds} />);
        expect(screen.getByLabelText('Period 2 start')).toBeTruthy();
    });

    it('an invalid row is labelled "Invalid period" and carries the red row + message', () => {
        render(<TimePeriodsEditor compact periods={[{ id: 'x', start: '2026-02-01T00:00', end: '2026-01-05T00:00' }]} onChange={vi.fn()} bounds={bounds} />);
        expect(screen.getByTestId('period-row-1').className).toContain('f4-crow--bad');
        expect(screen.getByTestId('period-row-1').textContent).toContain('Invalid period');
        expect(screen.getByTestId('period-invalid-1').className).toContain('f4-cmsg--bad');
    });

    it('overlap shows the compact amber message with Merge', () => {
        render(<TimePeriodsEditor compact periods={[A, { id: 'c', start: '2026-01-20T00:00', end: '2026-02-10T00:00' }]} onChange={vi.fn()} bounds={bounds} />);
        expect(screen.getByTestId('period-row-2').className).toContain('f4-crow--ovl');
        expect(screen.getByTestId('period-merge-2')).toBeTruthy();
    });
});

describe('PeriodReadOnlyList (Build page, Workspace mode)', () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => ({
        id: `p${i}`, start: `2026-01-${String(i * 2 + 1).padStart(2, '0')}T00:00`, end: `2026-01-${String(i * 2 + 2).padStart(2, '0')}T23:59`,
    }));

    it('renders a dot + label + day count per period, and a coverage bar', () => {
        render(<PeriodReadOnlyList periods={mk(2)} bounds={bounds} />);
        const lines = screen.getAllByTestId('period-chip');
        expect(lines).toHaveLength(2);
        expect(lines[0].textContent).toContain('1 Jan – 2 Jan 2026');
        expect(lines[0].querySelector('.f4-roline-d')!.textContent).toBe('2 d');
        expect(screen.getByTestId('period-coverage')).toBeTruthy();
    });

    it('shows the first 3 and a "+N more" link that expands to all and back', () => {
        render(<PeriodReadOnlyList periods={mk(5)} bounds={bounds} />);
        expect(screen.getAllByTestId('period-chip')).toHaveLength(3);
        fireEvent.click(screen.getByText('+2 more'));
        expect(screen.getAllByTestId('period-chip')).toHaveLength(5);
        fireEvent.click(screen.getByText('Show fewer'));
        expect(screen.getAllByTestId('period-chip')).toHaveLength(3);
    });

    it('invalid periods are not listed; an empty list reads as no limit', () => {
        const { rerender } = render(<PeriodReadOnlyList periods={[{ id: 'x', start: '2026-02-01T00:00', end: '2026-01-05T00:00' }]} bounds={bounds} />);
        expect(screen.getByTestId('period-chips-empty').textContent).toMatch(/No limit set — full dataset/);
        rerender(<PeriodReadOnlyList periods={[]} bounds={bounds} />);
        expect(screen.getByTestId('period-chips-empty')).toBeTruthy();
    });
});
