import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FilterPanel from '../components/dashboard/FilterPanel';
import type { FilterState } from '../components/dashboard/FilterPanel';

const emptyFilters: FilterState = { timestampStart: '', timestampEnd: '', sensorFilters: [] };

describe('FilterPanel', () => {
    it('shows an empty-state message with no sensor filters', () => {
        render(<FilterPanel filters={emptyFilters} onFiltersChange={vi.fn()} selectedSensors={['A']} />);
        expect(screen.getByText('No sensor filters applied.')).toBeTruthy();
    });

    it('disables Add condition when no sensors are selected', () => {
        render(<FilterPanel filters={emptyFilters} onFiltersChange={vi.fn()} selectedSensors={[]} />);
        const addBtn = screen.getByText('Add condition').closest('button') as HTMLButtonElement;
        expect(addBtn.disabled).toBe(true);
    });

    it('Add condition appends a filter row defaulting to the first selected sensor and "greater_than"', () => {
        render(<FilterPanel filters={emptyFilters} onFiltersChange={vi.fn()} selectedSensors={['A', 'B']} />);
        fireEvent.click(screen.getByText('Add condition').closest('button')!);

        expect(screen.queryByText('No sensor filters applied.')).toBeNull();
        const sensorSelect = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
        expect(sensorSelect.value).toBe('A');
        // Operator is now a 4-button segmented control, not a <select> --
        // "greater_than" (">") is the default, shown as the only `.is-on`
        // button in the segment.
        const greaterThanBtn = screen.getByTitle('Greater than');
        expect(greaterThanBtn.className).toContain('is-on');
    });

    it('shows a second value input only for the "between" operation', () => {
        render(<FilterPanel filters={emptyFilters} onFiltersChange={vi.fn()} selectedSensors={['A']} />);
        fireEvent.click(screen.getByText('Add condition').closest('button')!);
        expect(screen.getAllByPlaceholderText('value')).toHaveLength(1);
        expect(screen.queryByPlaceholderText('max')).toBeNull();

        fireEvent.click(screen.getByTitle('Between'));
        expect(screen.getByPlaceholderText('min')).toBeTruthy();
        expect(screen.getByPlaceholderText('max')).toBeTruthy();
    });

    it('editing value1/value2 updates the draft row', () => {
        render(<FilterPanel filters={emptyFilters} onFiltersChange={vi.fn()} selectedSensors={['A']} />);
        fireEvent.click(screen.getByText('Add condition').closest('button')!);
        const valInput = screen.getByPlaceholderText('value') as HTMLInputElement;
        fireEvent.change(valInput, { target: { value: '42' } });
        expect(valInput.value).toBe('42');
    });

    it('removes a filter row via its remove button', () => {
        render(<FilterPanel filters={emptyFilters} onFiltersChange={vi.fn()} selectedSensors={['A']} />);
        fireEvent.click(screen.getByText('Add condition').closest('button')!);
        expect(screen.queryByText('No sensor filters applied.')).toBeNull();

        fireEvent.click(screen.getByTitle('Remove filter'));
        expect(screen.getByText('No sensor filters applied.')).toBeTruthy();
    });

    it('Apply filter is disabled until the draft differs from the applied filters, then calls onFiltersChange', () => {
        const onFiltersChange = vi.fn();
        render(<FilterPanel filters={emptyFilters} onFiltersChange={onFiltersChange} selectedSensors={['A']} />);
        const applyBtn = screen.getByText('Apply filter').closest('button') as HTMLButtonElement;
        expect(applyBtn.disabled).toBe(true);

        fireEvent.click(screen.getByText('Add condition').closest('button')!);
        expect(applyBtn.disabled).toBe(false);

        fireEvent.click(applyBtn);
        expect(onFiltersChange).toHaveBeenCalledTimes(1);
        expect(onFiltersChange.mock.calls[0][0].sensorFilters).toHaveLength(1);
    });

    it('hides Clear when there are no filters, shows it once one is added', () => {
        render(<FilterPanel filters={emptyFilters} onFiltersChange={vi.fn()} selectedSensors={['A']} />);
        expect(screen.queryByText('Clear')).toBeNull();
        fireEvent.click(screen.getByText('Add condition').closest('button')!);
        expect(screen.getByText('Clear')).toBeTruthy();
    });

    it('Clear resets the draft to empty and immediately calls onFiltersChange', () => {
        const onFiltersChange = vi.fn();
        render(<FilterPanel filters={emptyFilters} onFiltersChange={onFiltersChange} selectedSensors={['A']} />);
        fireEvent.click(screen.getByText('Add condition').closest('button')!);
        fireEvent.click(screen.getByText('Clear'));

        expect(screen.getByText('No sensor filters applied.')).toBeTruthy();
        expect(onFiltersChange).toHaveBeenCalledWith(emptyFilters);
    });

    it('shows a "changes not applied yet" hint while dirty', () => {
        render(<FilterPanel filters={emptyFilters} onFiltersChange={vi.fn()} selectedSensors={['A']} />);
        expect(screen.queryByText('Changes not applied yet')).toBeNull();
        fireEvent.click(screen.getByText('Add condition').closest('button')!);
        expect(screen.getByText('Changes not applied yet')).toBeTruthy();
    });

    it('re-syncs the local draft when the parent provides genuinely different sensorFilters externally (e.g. a workspace reload)', () => {
        const { rerender } = render(
            <FilterPanel filters={emptyFilters} onFiltersChange={vi.fn()} selectedSensors={['A']} />,
        );
        fireEvent.click(screen.getByText('Add condition').closest('button')!);
        expect(screen.queryByText('No sensor filters applied.')).toBeNull();

        // Parent's sensorFilters actually changed content (not just a new
        // object with the same values) — this panel must adopt it, discarding
        // the local unapplied "Add condition" row.
        rerender(
            <FilterPanel
                filters={{
                    timestampStart: '', timestampEnd: '',
                    sensorFilters: [{ id: 'ext-1', sensor: 'A', operation: 'less_than', value1: '5', value2: '' }],
                }}
                onFiltersChange={vi.fn()}
                selectedSensors={['A']}
            />,
        );
        expect(screen.queryByText('No sensor filters applied.')).toBeNull();
        expect(screen.getByTitle('Less than').className).toContain('is-on');
        expect((screen.getByPlaceholderText('value') as HTMLInputElement).value).toBe('5');
    });

    // Regression (QA sweep, 2026-10-02): the local draft used to be
    // re-derived from `filters` whenever `filters` differed from the
    // CURRENT DRAFT -- so a re-render that supplied an unrelated piece of
    // `filters` (e.g. the time period, changed by the Dashboard timebar's
    // Reset period / Apply relative range / Start-End edits, which live in
    // this same FilterState) looked just like an external reset and
    // silently discarded whatever sensorFilters condition the user was
    // mid-typing. The fix only re-syncs the piece of the draft that
    // actually changed upstream (see the `lastSyncedFilters` comment in
    // FilterPanel.tsx) -- this test pins the "unrelated change, same
    // sensorFilters content" half of that fix directly.
    it('an unrelated re-render whose sensorFilters content is unchanged does not touch the in-progress draft', () => {
        const { rerender } = render(
            <FilterPanel filters={emptyFilters} onFiltersChange={vi.fn()} selectedSensors={['A']} />,
        );
        fireEvent.click(screen.getByText('Add condition').closest('button')!);
        expect(screen.queryByText('No sensor filters applied.')).toBeNull();

        // A fresh `timestampStart` (as if the timebar reset the period) but
        // the same (empty) sensorFilters content as before.
        rerender(
            <FilterPanel
                filters={{ timestampStart: '2026-01-01T00:00', timestampEnd: '', sensorFilters: [] }}
                onFiltersChange={vi.fn()}
                selectedSensors={['A']}
            />,
        );
        expect(screen.queryByText('No sensor filters applied.')).toBeNull();
    });

    // Regression (QA sweep, 2026-10-02): switching away from "between" hid
    // the max-value input but kept its draft value, so Apply still sent a
    // stale `value2` for an operator that no longer shows or uses it, and
    // switching back to "between" resurrected the old max.
    it('switching away from "between" clears the now-hidden max value from the draft', () => {
        render(<FilterPanel filters={emptyFilters} onFiltersChange={vi.fn()} selectedSensors={['A']} />);
        fireEvent.click(screen.getByText('Add condition').closest('button')!);
        fireEvent.click(screen.getByTitle('Between'));
        fireEvent.change(screen.getByPlaceholderText('min'), { target: { value: '10' } });
        fireEvent.change(screen.getByPlaceholderText('max'), { target: { value: '50' } });

        fireEvent.click(screen.getByTitle('Greater than'));
        expect(screen.queryByPlaceholderText('max')).toBeNull();

        fireEvent.click(screen.getByTitle('Between'));
        expect((screen.getByPlaceholderText('max') as HTMLInputElement).value).toBe('');
    });

    it('labels sensors with "description (tag)" when metadata is available, falling back to the bare tag', () => {
        render(
            <FilterPanel
                filters={emptyFilters}
                onFiltersChange={vi.fn()}
                selectedSensors={['A', 'B']}
                sensorMetadata={[{ tag: 'A', description: 'Pump Pressure', unit: 'bar', component: 'Pump' }]}
            />,
        );
        fireEvent.click(screen.getByText('Add condition').closest('button')!);
        expect(screen.getByText('Pump Pressure (A)')).toBeTruthy();
        expect(screen.getByText('B')).toBeTruthy(); // no metadata -> bare tag
    });
});
