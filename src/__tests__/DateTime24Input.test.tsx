import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DateTime24Input } from '../components/windows/DateTime24Input';
import { isPickerSurfaceOpen } from '../components/sensor/SensorPicker';
import { clampDateTime, formatDateTime24, monthCells, parseDateTime24 } from '../utils/dateTime24';

describe('dateTime24', () => {
    it('shows a stored value as YYYY/MM/DD HH:mm, 24-hour', () => {
        expect(formatDateTime24('2026-07-30T14:28')).toBe('2026/07/30 14:28');
        expect(formatDateTime24('2026-07-30T14:28:52')).toBe('2026/07/30 14:28:52');
        expect(formatDateTime24('')).toBe('');
    });

    it('reads what is typed, with / or - and a space or T', () => {
        expect(parseDateTime24('2026/07/30 14:28')).toBe('2026-07-30T14:28');
        expect(parseDateTime24('2026-7-3T8:05')).toBe('2026-07-03T08:05');
        expect(parseDateTime24('2026/07/30 23:59:59')).toBe('2026-07-30T23:59:59');
    });

    it('is empty while the text is not a complete real date and time', () => {
        for (const text of ['', '2026/07/30', '2026/07/30 14:2', '2026/07/30 24:00', '2026/07/30 02:28 PM', '2025/02/29 00:00', '2026/13/01 00:00']) {
            expect(parseDateTime24(text)).toBe('');
        }
        expect(parseDateTime24('2024/02/29 00:00')).toBe('2024-02-29T00:00');
    });

    it('keeps a value inside its limits', () => {
        expect(clampDateTime('2026-01-01T00:00', '2026-02-01T08:00')).toBe('2026-02-01T08:00');
        expect(clampDateTime('2026-03-01T00:00', undefined, '2026-02-01T08:00')).toBe('2026-02-01T08:00');
        expect(clampDateTime('2026-01-15T00:00', '2026-01-01T00:00', '2026-02-01T00:00')).toBe('2026-01-15T00:00');
    });

    it('a month is six weeks from a Sunday', () => {
        const cells = monthCells(2026, 1);
        expect(cells).toHaveLength(42);
        expect(cells[0]).toBe('2026-02-01');
        expect(monthCells(2026, 6)[0]).toBe('2026-06-28');
    });
});

function Field({ initial = '2026-07-30T14:28', onChange = vi.fn(), onCommit = vi.fn(), min, max }: {
    initial?: string; onChange?: (v: string) => void; onCommit?: () => void; min?: string; max?: string;
}) {
    const [value, setValue] = useState(initial);
    return (
        <div className="f4-dtw">
            <DateTime24Input ariaLabel="P1 start" value={value} min={min} max={max} onCommit={onCommit} onChange={v => { setValue(v); onChange(v); }} />
        </div>
    );
}
const field = () => screen.getByLabelText('P1 start') as HTMLInputElement;
const openPicker = () => fireEvent.click(screen.getByLabelText('Open date picker'));

describe('DateTime24Input', () => {
    it('shows 24-hour text, never a native datetime field', () => {
        render(<Field />);
        expect(field().type).toBe('text');
        expect(field().value).toBe('2026/07/30 14:28');
    });

    it('typing reports the value when complete, and empty while not, keeping the text', () => {
        const onChange = vi.fn();
        render(<Field onChange={onChange} />);
        fireEvent.change(field(), { target: { value: '2026/07/30 1' } });
        expect(onChange).toHaveBeenLastCalledWith('');
        expect(field().value).toBe('2026/07/30 1');
        fireEvent.change(field(), { target: { value: '2026/07/30 15:45' } });
        expect(onChange).toHaveBeenLastCalledWith('2026-07-30T15:45');
    });

    it('blur and Enter commit', () => {
        const onCommit = vi.fn();
        render(<Field onCommit={onCommit} />);
        fireEvent.keyDown(field(), { key: 'Enter' });
        fireEvent.blur(field());
        expect(onCommit).toHaveBeenCalledTimes(2);
    });

    it('the calendar opens on the value\'s month with its time in 24-hour', () => {
        render(<Field />);
        openPicker();
        expect(screen.getByTestId('dt24-month').textContent).toBe('July 2026');
        expect((screen.getByLabelText('Hour, 00 to 23') as HTMLInputElement).value).toBe('14');
        expect((screen.getByLabelText('Minute, 00 to 59') as HTMLInputElement).value).toBe('28');
        expect(screen.getByLabelText('2026-07-30').getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByText('24-hour')).toBeTruthy();
    });

    it('picking a day keeps the time; an hour past 12 stays as typed', () => {
        const onChange = vi.fn();
        render(<Field onChange={onChange} />);
        openPicker();
        fireEvent.click(screen.getByLabelText('2026-07-15'));
        expect(onChange).toHaveBeenLastCalledWith('2026-07-15T14:28');
        fireEvent.change(screen.getByLabelText('Hour, 00 to 23'), { target: { value: '23' } });
        expect(onChange).toHaveBeenLastCalledWith('2026-07-15T23:28');
        expect(field().value).toBe('2026/07/15 23:28');
    });

    it('an hour over 23 or a minute over 59 is not applied, and settles on blur', () => {
        const onChange = vi.fn();
        render(<Field onChange={onChange} />);
        openPicker();
        const hour = screen.getByLabelText('Hour, 00 to 23') as HTMLInputElement;
        fireEvent.change(hour, { target: { value: '24' } });
        expect(onChange).not.toHaveBeenCalled();
        fireEvent.blur(hour);
        expect(hour.value).toBe('00');
    });

    it('days outside the data cannot be picked, and a time past a limit is held at it', () => {
        const onChange = vi.fn();
        render(<Field initial="2026-07-15T10:00" onChange={onChange} min="2026-07-10T08:00" max="2026-07-20T12:00" />);
        openPicker();
        expect((screen.getByLabelText('2026-07-09') as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByLabelText('2026-07-21') as HTMLButtonElement).disabled).toBe(true);
        fireEvent.change(screen.getByLabelText('Hour, 00 to 23'), { target: { value: '23' } });
        fireEvent.click(screen.getByLabelText('2026-07-20'));
        expect(onChange).toHaveBeenLastCalledWith('2026-07-20T12:00');
    });

    it('the month and year buttons move the calendar', () => {
        render(<Field />);
        openPicker();
        fireEvent.click(screen.getByLabelText('Next month'));
        expect(screen.getByTestId('dt24-month').textContent).toBe('August 2026');
        fireEvent.click(screen.getByLabelText('Previous year'));
        expect(screen.getByTestId('dt24-month').textContent).toBe('August 2025');
    });

    it('Esc, a click outside and Done close it and commit; an owner modal sees it open first', () => {
        const onCommit = vi.fn();
        render(<Field onCommit={onCommit} />);
        openPicker();
        expect(isPickerSurfaceOpen()).toBe(true);
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByTestId('dt24-pop')).toBeNull();
        expect(isPickerSurfaceOpen()).toBe(false);
        openPicker();
        fireEvent.mouseDown(document.body);
        expect(screen.queryByTestId('dt24-pop')).toBeNull();
        openPicker();
        fireEvent.click(screen.getByText('Done'));
        expect(screen.queryByTestId('dt24-pop')).toBeNull();
        expect(onCommit).toHaveBeenCalledTimes(3);
    });

    it('a value changed from outside replaces the text', () => {
        const { rerender } = render(<DateTime24Input ariaLabel="P1 start" value="2026-07-30T14:28" onChange={vi.fn()} onCommit={vi.fn()} />);
        rerender(<DateTime24Input ariaLabel="P1 start" value="2026-01-02T03:04" onChange={vi.fn()} onCommit={vi.fn()} />);
        expect(field().value).toBe('2026/01/02 03:04');
    });
});
