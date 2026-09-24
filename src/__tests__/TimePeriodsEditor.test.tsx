import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import TimePeriodsEditor, { TimePeriodChips } from '../components/windows/TimePeriodsEditor';

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

describe('TimePeriodChips', () => {
    it('renders date-only chips for whole-day periods, date+time otherwise, and open ends as labels', () => {
        render(<TimePeriodChips periods={[
            { id: 'a', start: '2026-01-01T00:00', end: '2026-01-31T23:59' },
            { id: 'b', start: '2026-03-01T08:00', end: '' },
        ]} />);
        const chips = screen.getAllByTestId('period-chip').map(c => c.textContent);
        expect(chips).toEqual(['2026-01-01 – 2026-01-31', '2026-03-01 08:00 – End of data']);
    });

    it('empty list reads as no limit', () => {
        render(<TimePeriodChips periods={[]} />);
        expect(screen.getByTestId('period-chips-empty').textContent).toMatch(/no limit/);
    });
});
