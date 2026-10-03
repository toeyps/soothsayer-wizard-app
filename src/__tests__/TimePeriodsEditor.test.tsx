import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import TimePeriodsEditor from '../components/windows/TimePeriodsEditor';

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

describe('TimePeriodsEditor - wide period cards (Running condition modal, mockup 1pp59aydphzaDu2R1SvKGh)', () => {
    const A = { id: 'a', start: '2026-01-01T00:00', end: '2026-01-31T23:59' };
    const B = { id: 'b', start: '2026-02-15T00:00', end: '2026-03-10T23:59' };

    it('each period is a card: "P1", start, arrow, end, duration in days, delete', () => {
        render(<TimePeriodsEditor periods={[A]} onChange={vi.fn()} bounds={bounds} />);
        const row = screen.getByTestId('period-row-1');
        expect(row.className).toContain('rcm-per');
        expect(row.querySelector('.rcm-pn')!.textContent).toBe('P1');
        expect(row.querySelector('.rcm-arrow')!.textContent).toBe('→');
        expect(row.querySelector('.rcm-dur')!.textContent).toBe('31 d'); // 1 Jan 00:00 -> 31 Jan 23:59, rounded
        expect(screen.getByLabelText('Remove period 1').className).toContain('rcm-ib');
        expect(screen.getByLabelText('Period 1 start')).toBeTruthy();
        expect(screen.getAllByLabelText('Open date picker')).toHaveLength(2); // one calendar button per field
    });

    it('deleting a card reports the list without it', () => {
        const onChange = vi.fn();
        render(<TimePeriodsEditor periods={[A, B]} onChange={onChange} bounds={bounds} />);
        fireEvent.click(screen.getByLabelText('Remove period 1'));
        expect(onChange.mock.calls[0][0]).toEqual([B]);
    });

    it('the modal keeps the coverage strip above the cards (restored — it was removed by mistake on 2026-10-03)', () => {
        render(<TimePeriodsEditor periods={[A]} onChange={vi.fn()} bounds={bounds} />);
        const cov = screen.getByTestId('period-coverage');
        expect(cov.className).toContain('rcm-cov');
        expect(document.querySelector('.f4-strip')).not.toBeNull();
        expect(cov.compareDocumentPosition(screen.getByTestId('period-row-1')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(screen.getByTestId('period-coverage-days').textContent).toMatch(/ of 74 days used$/);
    });

    it('no strip without dataset bounds, nor with an empty list', () => {
        render(<TimePeriodsEditor periods={[A]} onChange={vi.fn()} bounds={null} />);
        expect(screen.queryByTestId('period-coverage')).toBeNull();
        cleanup();
        render(<TimePeriodsEditor periods={[]} onChange={vi.fn()} bounds={bounds} />);
        expect(screen.queryByTestId('period-coverage')).toBeNull();
    });

    it('empty state: "No period — the whole dataset (N days) is used." plus the dashed "Add period" button', () => {
        render(<TimePeriodsEditor periods={[]} onChange={vi.fn()} bounds={bounds} />);
        const box = screen.getByTestId('periods-empty');
        expect(box.className).toContain('rcm-none');
        expect(box.textContent).toBe('No period — the whole dataset (74 days) is used.');
        const add = screen.getByTestId('period-add');
        expect(add.className).toContain('rcm-add');
        expect(add.textContent).toBe('Add period');
    });

    it('the first period start / last period end have an x that makes that side open-ended', () => {
        const onChange = vi.fn();
        render(<TimePeriodsEditor periods={[A, B]} onChange={onChange} bounds={bounds} />);
        expect(screen.getAllByTestId('period-open-toggle-start')).toHaveLength(1); // first row only
        expect(screen.getAllByTestId('period-open-toggle-end')).toHaveLength(1); // last row only
        expect(screen.getByTestId('period-open-toggle-start').textContent).toBe(''); // an x icon, not the compact arrow glyph
        fireEvent.click(screen.getByTestId('period-open-toggle-start'));
        expect(onChange.mock.calls[0][0][0]).toMatchObject({ id: 'a', start: '' });
        fireEvent.click(screen.getByTestId('period-open-toggle-end'));
        expect(onChange.mock.calls[1][0][1]).toMatchObject({ id: 'b', end: '' });
    });

    it('an open side reads "Start of data" / "End of data" with a "Set date" button that commits the dataset bound', () => {
        const onChange = vi.fn();
        render(<TimePeriodsEditor periods={[{ ...A, start: '' }]} onChange={onChange} bounds={bounds} />);
        expect(screen.getByTestId('period-open-start').textContent).toContain('Start of data');
        expect(screen.getByTestId('period-open-start').textContent).not.toContain('⟵');
        expect(screen.getByTestId('period-open-start').className).toContain('f4-openb');
        fireEvent.click(screen.getByLabelText('Set start date'));
        expect(onChange.mock.calls[0][0][0]).toMatchObject({ id: 'a', start: '2026-01-01T00:00' });
    });

    it('an open END reads "End of data" and Set date commits the dataset end', () => {
        const onChange = vi.fn();
        render(<TimePeriodsEditor periods={[{ ...A, end: '' }]} onChange={onChange} bounds={bounds} />);
        expect(screen.getByTestId('period-open-end').textContent).toContain('End of data');
        fireEvent.click(screen.getByLabelText('Set end date'));
        expect(onChange.mock.calls[0][0][0]).toMatchObject({ id: 'a', end: '2026-03-15T12:00' });
    });

    it('an unfinished (blank) draft value does not swap the input for the open-ended box mid-typing', () => {
        render(<TimePeriodsEditor periods={[A]} onChange={vi.fn()} bounds={bounds} />);
        const start = screen.getByLabelText('Period 1 start');
        fireEvent.change(start, { target: { value: '' } }); // datetime-local reports '' while a date is half-typed
        expect(screen.getByLabelText('Period 1 start')).toBeTruthy();
        expect(screen.queryByTestId('period-open-start')).toBeNull();
    });

    it('overlap: yellow frame on the LATER card with "Overlaps P1 by N d" and a "Merge into one" button', () => {
        const onChange = vi.fn();
        render(<TimePeriodsEditor periods={[A, { id: 'c', start: '2026-01-20T00:00', end: '2026-02-10T00:00' }]} onChange={onChange} bounds={bounds} />);
        const row = screen.getByTestId('period-row-2');
        expect(row.className).toContain('rcm-per--ovl');
        expect(screen.getByTestId('period-row-1').className).not.toContain('rcm-per--ovl');
        expect(screen.getByTestId('period-overlap-2').textContent).toBe('Overlaps P1 by 12 d — rows in both are used once.Merge into one');
        fireEvent.click(screen.getByTestId('period-merge-2'));
        expect(onChange.mock.calls[0][0]).toEqual([{ id: 'a', start: A.start, end: '2026-02-10T00:00' }]);
    });

    it('invalid (end before start): red frame, "—" duration, red end field and the reason', () => {
        render(<TimePeriodsEditor periods={[{ id: 'x', start: '2026-02-01T00:00', end: '2026-01-05T00:00' }]} onChange={vi.fn()} bounds={bounds} />);
        const row = screen.getByTestId('period-row-1');
        expect(row.className).toContain('rcm-per--bad');
        expect(row.querySelector('.rcm-dur')!.textContent).toBe('—');
        expect(screen.getByTestId('period-invalid-1').textContent).toBe('End is before start — pick an end after 1 Feb 2026. This period is ignored and building is blocked until fixed.');
        expect(screen.getByTestId('period-invalid-1').className).toContain('rcm-permsg--bad');
        expect(row.querySelector('.f4-dtw--bad')).not.toBeNull();
    });

    it('a blank bound where none is allowed (open end on a NON-last period) is invalid with the validatePeriods reason', () => {
        render(<TimePeriodsEditor periods={[{ id: 'a', start: '2026-01-01T00:00', end: '' }, B]} onChange={vi.fn()} bounds={bounds} />);
        expect(screen.getByTestId('period-invalid-1').textContent).toContain('Period 1 needs an end date.');
        expect(screen.getByTestId('period-row-1').className).toContain('rcm-per--bad');
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
