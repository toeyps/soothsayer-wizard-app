import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { StiffnessField, STEP_HINT } from '../components/windows/workbench/StiffnessField';
import { STIFFNESS_OPTIONS } from '../components/reports/pmReportTypes';

afterEach(cleanup);

describe('StiffnessField (Relation model, select with curves)', () => {
    it('shows the current step, its n/7 and its one-line hint', () => {
        render(<StiffnessField value={100} onChange={() => {}} />);
        expect(screen.getByTestId('stiffness-select').textContent).toBe('Standard4/7');
        expect(screen.getByText(STEP_HINT[3])).toBeTruthy();
    });

    it('opens a list of all seven steps, loosest first, ✓ on the current one and "· default" on Standard; a click picks and closes', () => {
        const onChange = vi.fn();
        render(<StiffnessField value={10_000} onChange={onChange} />);
        fireEvent.click(screen.getByTestId('stiffness-select'));
        const opts = screen.getAllByRole('option');
        expect(opts.map(o => o.textContent)).toEqual(STIFFNESS_OPTIONS.map(o => o.label === 'Standard' ? 'Standard · default' : o.label));
        expect(opts[5].getAttribute('aria-selected')).toBe('true');
        expect(screen.getByText('Follows the data')).toBeTruthy();
        fireEvent.mouseDown(screen.getByRole('option', { name: /^Very loose/ }));
        expect(onChange).toHaveBeenCalledWith(0.1);
        expect(screen.queryByRole('listbox')).toBeNull();
    });

    it('← → change the step while closed and stop at the ends', () => {
        const onChange = vi.fn();
        const { rerender } = render(<StiffnessField value={100} onChange={onChange} />);
        const btn = screen.getByTestId('stiffness-select');
        fireEvent.keyDown(btn, { key: 'ArrowRight' });
        expect(onChange).toHaveBeenLastCalledWith(1_000);
        fireEvent.keyDown(btn, { key: 'ArrowLeft' });
        expect(onChange).toHaveBeenLastCalledWith(10);
        onChange.mockClear();
        rerender(<StiffnessField value={100_000} onChange={onChange} />);
        fireEvent.keyDown(btn, { key: 'ArrowRight' });
        expect(onChange).not.toHaveBeenCalled();
    });

    it('Enter opens; ↓ then Enter picks; Esc closes without a change; a click outside closes', () => {
        const onChange = vi.fn();
        render(<StiffnessField value={100} onChange={onChange} />);
        const btn = screen.getByTestId('stiffness-select');
        fireEvent.keyDown(btn, { key: 'Enter' });
        expect(screen.getByRole('listbox')).toBeTruthy();
        fireEvent.keyDown(btn, { key: 'ArrowDown' });
        fireEvent.keyDown(btn, { key: 'Enter' });
        expect(onChange).toHaveBeenCalledWith(1_000);
        expect(screen.queryByRole('listbox')).toBeNull();

        onChange.mockClear();
        fireEvent.keyDown(btn, { key: 'Enter' });
        fireEvent.keyDown(btn, { key: 'Escape' });
        expect(screen.queryByRole('listbox')).toBeNull();
        fireEvent.click(btn);
        fireEvent.mouseDown(document.body);
        expect(screen.queryByRole('listbox')).toBeNull();
        expect(onChange).not.toHaveBeenCalled();
    });
});
