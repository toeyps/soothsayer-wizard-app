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

    it('disables Add when no sensors are selected', () => {
        render(<FilterPanel filters={emptyFilters} onFiltersChange={vi.fn()} selectedSensors={[]} />);
        const addBtn = screen.getByText('Add').closest('button') as HTMLButtonElement;
        expect(addBtn.disabled).toBe(true);
    });

    it('Add appends a filter row defaulting to the first selected sensor and "greater_than"', () => {
        render(<FilterPanel filters={emptyFilters} onFiltersChange={vi.fn()} selectedSensors={['A', 'B']} />);
        fireEvent.click(screen.getByText('Add').closest('button')!);

        expect(screen.getByText('Sensor Filters (1)')).toBeTruthy();
        const sensorSelect = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
        expect(sensorSelect.value).toBe('A');
        const opSelect = screen.getAllByRole('combobox')[1] as HTMLSelectElement;
        expect(opSelect.value).toBe('greater_than');
    });

    it('shows a second value input only for the "between" operation', () => {
        render(<FilterPanel filters={emptyFilters} onFiltersChange={vi.fn()} selectedSensors={['A']} />);
        fireEvent.click(screen.getByText('Add').closest('button')!);
        expect(screen.getAllByPlaceholderText('val')).toHaveLength(1);
        expect(screen.queryByPlaceholderText('max')).toBeNull();

        const opSelect = screen.getAllByRole('combobox')[1] as HTMLSelectElement;
        fireEvent.change(opSelect, { target: { value: 'between' } });
        expect(screen.getByPlaceholderText('max')).toBeTruthy();
    });

    it('editing value1/value2 updates the draft row', () => {
        render(<FilterPanel filters={emptyFilters} onFiltersChange={vi.fn()} selectedSensors={['A']} />);
        fireEvent.click(screen.getByText('Add').closest('button')!);
        const valInput = screen.getByPlaceholderText('val') as HTMLInputElement;
        fireEvent.change(valInput, { target: { value: '42' } });
        expect(valInput.value).toBe('42');
    });

    it('removes a filter row via its remove button', () => {
        render(<FilterPanel filters={emptyFilters} onFiltersChange={vi.fn()} selectedSensors={['A']} />);
        fireEvent.click(screen.getByText('Add').closest('button')!);
        expect(screen.getByText('Sensor Filters (1)')).toBeTruthy();

        fireEvent.click(screen.getByTitle('Remove filter'));
        expect(screen.getByText('Sensor Filters (0)')).toBeTruthy();
        expect(screen.getByText('No sensor filters applied.')).toBeTruthy();
    });

    it('Apply is disabled until the draft differs from the applied filters, then calls onFiltersChange', () => {
        const onFiltersChange = vi.fn();
        render(<FilterPanel filters={emptyFilters} onFiltersChange={onFiltersChange} selectedSensors={['A']} />);
        const applyBtn = screen.getByText('Apply Filter').closest('button') as HTMLButtonElement;
        expect(applyBtn.disabled).toBe(true);

        fireEvent.click(screen.getByText('Add').closest('button')!);
        expect(applyBtn.disabled).toBe(false);

        fireEvent.click(applyBtn);
        expect(onFiltersChange).toHaveBeenCalledTimes(1);
        expect(onFiltersChange.mock.calls[0][0].sensorFilters).toHaveLength(1);
    });

    it('hides Clear when there are no filters, shows it once one is added', () => {
        render(<FilterPanel filters={emptyFilters} onFiltersChange={vi.fn()} selectedSensors={['A']} />);
        expect(screen.queryByText('Clear')).toBeNull();
        fireEvent.click(screen.getByText('Add').closest('button')!);
        expect(screen.getByText('Clear')).toBeTruthy();
    });

    it('Clear resets the draft to empty and immediately calls onFiltersChange', () => {
        const onFiltersChange = vi.fn();
        render(<FilterPanel filters={emptyFilters} onFiltersChange={onFiltersChange} selectedSensors={['A']} />);
        fireEvent.click(screen.getByText('Add').closest('button')!);
        fireEvent.click(screen.getByText('Clear'));

        expect(screen.getByText('No sensor filters applied.')).toBeTruthy();
        expect(onFiltersChange).toHaveBeenCalledWith(emptyFilters);
    });

    it('re-syncs the local draft when the parent resets `filters` externally', () => {
        const { rerender } = render(
            <FilterPanel filters={emptyFilters} onFiltersChange={vi.fn()} selectedSensors={['A']} />,
        );
        fireEvent.click(screen.getByText('Add').closest('button')!);
        expect(screen.getByText('Sensor Filters (1)')).toBeTruthy();

        // Parent resets filters back to empty (e.g. workspace reload) — a
        // fresh object so the effect's `[filters]` dependency actually fires.
        rerender(
            <FilterPanel
                filters={{ timestampStart: '', timestampEnd: '', sensorFilters: [] }}
                onFiltersChange={vi.fn()}
                selectedSensors={['A']}
            />,
        );
        expect(screen.getByText('Sensor Filters (0)')).toBeTruthy();
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
        fireEvent.click(screen.getByText('Add').closest('button')!);
        expect(screen.getByText('Pump Pressure (A)')).toBeTruthy();
        expect(screen.getByText('B')).toBeTruthy(); // no metadata -> bare tag
    });
});
