import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FilterPanel from '../components/dashboard/FilterPanel';
import type { FilterState } from '../components/dashboard/FilterPanel';
import { findPickerRow, openPickerSurface, pickSingle, rowTag } from './helpers/sensorPicker';

// Customer item 3 (2026-10-09): each condition's sensor is the shared single picker
// (trigger "Filter sensor" + anchored popover), not a native <select>.
const sensorTriggers = () => screen.queryAllByRole('button', { name: 'Filter sensor' });
const sensorValues = () => sensorTriggers().map(t => rowTag(t));

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
        expect(sensorValues()).toEqual(['A']);
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

    it('labels sensors with the Inline label (description then tag) when metadata is available, falling back to the bare tag', () => {
        render(
            <FilterPanel
                filters={emptyFilters}
                onFiltersChange={vi.fn()}
                selectedSensors={['A', 'B']}
                sensorMetadata={[{ tag: 'A', description: 'Pump Pressure', unit: 'bar', component: 'Pump' }]}
            />,
        );
        fireEvent.click(screen.getByText('Add condition').closest('button')!);
        // Trigger = Inline label: description then tag, no brackets.
        expect(sensorTriggers()[0].textContent).toBe('Pump PressureA');
        // The picker is scoped to the sensors on the chart and says so.
        fireEvent.click(sensorTriggers()[0]);
        expect(openPickerSurface().querySelector('.pk-scope')?.textContent).toBe('Sensors on the chart · 2');
        // B has no metadata -> its bare tag.
        expect(findPickerRow('B').textContent).toBe('B');
    });

    it('picking another sensor in the popover changes the condition (one click, no OK)', () => {
        render(<FilterPanel filters={emptyFilters} onFiltersChange={vi.fn()} selectedSensors={['A', 'B']} />);
        fireEvent.click(screen.getByText('Add condition').closest('button')!);
        pickSingle(sensorTriggers()[0], 'B');
        expect(sensorValues()).toEqual(['B']);
        expect(document.querySelector('.pk-pop')).toBeNull();
    });

    it('the value boxes carry the unit of the sensor as a suffix', () => {
        render(
            <FilterPanel
                filters={emptyFilters}
                onFiltersChange={vi.fn()}
                selectedSensors={['A']}
                sensorMetadata={[{ tag: 'A', description: 'Pump Pressure', unit: 'bar', component: 'Pump' }]}
            />,
        );
        fireEvent.click(screen.getByText('Add condition').closest('button')!);
        fireEvent.click(screen.getByTitle('Between'));
        expect([...document.querySelectorAll('.fv-unit')].map(e => e.textContent)).toEqual(['bar', 'bar']);
        expect(document.querySelector('.filter-row-value')?.classList.contains('filter-row-value--unit')).toBe(true);
    });

    describe('a condition whose sensor is no longer on the chart', () => {
        const applied: FilterState = { timestampStart: '', timestampEnd: '', sensorFilters: [{ id: 'f1', sensor: 'GONE', operation: 'greater_than', value1: '5', value2: '' }] };

        it('is kept, with a ⚠ + solid amber picker (never the dashed "required" look) and a note with Show on chart / Remove', () => {
            const onShowSensor = vi.fn();
            render(
                <FilterPanel
                    filters={applied}
                    onFiltersChange={vi.fn()}
                    selectedSensors={['A']}
                    sensorMetadata={[{ tag: 'GONE', description: 'Old flow', unit: 'm3/h', component: '' }]}
                    onShowSensor={onShowSensor}
                />,
            );
            const trig = sensorTriggers()[0];
            expect(rowTag(trig)).toBe('GONE');
            expect(trig.classList.contains('warn')).toBe(true);
            expect(trig.classList.contains('req')).toBe(false);
            expect(screen.getByLabelText('Not on the chart')).toBeTruthy();
            const note = screen.getByRole('status');
            expect(note.textContent).toContain('Old flowGONE is not on the chart. The filter still applies.');
            fireEvent.click(screen.getByRole('button', { name: 'Show on chart' }));
            expect(onShowSensor).toHaveBeenCalledWith('GONE');
            fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
            expect(screen.getByText('No sensor filters applied.')).toBeTruthy();
        });

        it('a sensor on the chart has no note and no warning', () => {
            render(<FilterPanel filters={applied} onFiltersChange={vi.fn()} selectedSensors={['A', 'GONE']} />);
            expect(screen.queryByRole('status')).toBeNull();
            expect(sensorTriggers()[0].classList.contains('warn')).toBe(false);
        });

        it('with a blocked reason (Pair Plot sensor cap) "Show on chart" is disabled and says why instead of silently doing nothing', () => {
            const onShowSensor = vi.fn();
            render(
                <FilterPanel
                    filters={applied}
                    onFiltersChange={vi.fn()}
                    selectedSensors={['A']}
                    onShowSensor={onShowSensor}
                    showSensorBlockedReason="Pair Plot shows at most 4 sensors"
                />,
            );
            const btn = screen.getByRole('button', { name: 'Show on chart' }) as HTMLButtonElement;
            expect(btn.disabled).toBe(true);
            expect(btn.title).toBe('Pair Plot shows at most 4 sensors');
            fireEvent.click(btn);
            expect(onShowSensor).not.toHaveBeenCalled();
            // Remove still works.
            expect((screen.getByRole('button', { name: 'Remove' }) as HTMLButtonElement).disabled).toBe(false);
        });

        it('without onShowSensor only Remove is offered', () => {
            render(<FilterPanel filters={applied} onFiltersChange={vi.fn()} selectedSensors={['A']} />);
            expect(screen.queryByRole('button', { name: 'Show on chart' })).toBeNull();
            expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
        });
    });

    // 2026-10-03: a special sensor was renamed / deleted in the Add Special Sensor
    // window. The Dashboard rewrites the APPLIED filters itself; `sensorChange`
    // carries the same change into the panel's unapplied draft (the Dashboard
    // cannot see it), without throwing away unrelated unapplied typing.
    describe('sensorChange (a special sensor renamed / deleted while the panel is open)', () => {
        const cond = (id: string, sensor: string, value1 = '4') => ({ id, sensor, operation: 'greater_than' as const, value1, value2: '' });
        const selectValues = sensorValues;

        it('a rename re-keys the applied conditions shown in the draft, in step with the Dashboard rewriting `filters`', () => {
            const applied: FilterState = { timestampStart: '', timestampEnd: '', sensorFilters: [cond('f1', 'A'), cond('f2', 'B')] };
            const { rerender } = render(<FilterPanel filters={applied} onFiltersChange={vi.fn()} selectedSensors={['A', 'A2', 'B']} sensorChange={{ id: 0 }} />);
            expect(selectValues()).toEqual(['A', 'B']);
            // Dashboard rewrote its applied filters and bumped sensorChange in one render.
            const renamed: FilterState = { ...applied, sensorFilters: [cond('f1', 'A2'), cond('f2', 'B')] };
            rerender(<FilterPanel filters={renamed} onFiltersChange={vi.fn()} selectedSensors={['A', 'A2', 'B']} sensorChange={{ id: 1, rename: { from: 'A', to: 'A2' } }} />);
            expect(selectValues()).toEqual(['A2', 'B']);
        });

        it('a rename also re-keys an UNAPPLIED draft condition, and keeps what else the user was typing (it is not reset to the applied list)', () => {
            const applied: FilterState = { timestampStart: '', timestampEnd: '', sensorFilters: [cond('f1', 'A')] };
            const { rerender } = render(<FilterPanel filters={applied} onFiltersChange={vi.fn()} selectedSensors={['A', 'A2', 'B']} sensorChange={{ id: 0 }} />);
            // Unapplied: a second condition on A, typed value 77, plus an edit to f1's value.
            fireEvent.click(screen.getByText('Add condition').closest('button')!);
            fireEvent.change(screen.getAllByPlaceholderText('value')[1], { target: { value: '77' } });
            fireEvent.change(screen.getAllByPlaceholderText('value')[0], { target: { value: '5' } });
            expect(selectValues()).toEqual(['A', 'A']);

            const renamed: FilterState = { ...applied, sensorFilters: [cond('f1', 'A2')] };
            rerender(<FilterPanel filters={renamed} onFiltersChange={vi.fn()} selectedSensors={['A', 'A2', 'B']} sensorChange={{ id: 1, rename: { from: 'A', to: 'A2' } }} />);
            expect(selectValues()).toEqual(['A2', 'A2']);
            const values = (screen.getAllByPlaceholderText('value') as HTMLInputElement[]).map(i => i.value);
            expect(values).toEqual(['5', '77']); // unapplied typing survived
        });

        it('a delete removes the conditions of the deleted sensor from the draft (applied and unapplied) and keeps the others', () => {
            const applied: FilterState = { timestampStart: '', timestampEnd: '', sensorFilters: [cond('f1', 'A'), cond('f2', 'B')] };
            const { rerender } = render(<FilterPanel filters={applied} onFiltersChange={vi.fn()} selectedSensors={['A', 'B']} sensorChange={{ id: 0 }} />);
            fireEvent.click(screen.getByText('Add condition').closest('button')!); // unapplied, defaults to A
            expect(selectValues()).toEqual(['A', 'B', 'A']);

            const afterDelete: FilterState = { ...applied, sensorFilters: [cond('f2', 'B')] };
            rerender(<FilterPanel filters={afterDelete} onFiltersChange={vi.fn()} selectedSensors={['B']} sensorChange={{ id: 1, removed: ['a'] }} />);
            expect(selectValues()).toEqual(['B']);
        });

        it('deleting the only condition leaves the empty state', () => {
            const applied: FilterState = { timestampStart: '', timestampEnd: '', sensorFilters: [cond('f1', 'A')] };
            const { rerender } = render(<FilterPanel filters={applied} onFiltersChange={vi.fn()} selectedSensors={['A']} sensorChange={{ id: 0 }} />);
            rerender(<FilterPanel filters={{ ...applied, sensorFilters: [] }} onFiltersChange={vi.fn()} selectedSensors={[]} sensorChange={{ id: 1, removed: ['A'] }} />);
            expect(screen.getByText('No sensor filters applied.')).toBeTruthy();
        });

        it('each change is applied exactly once (a re-render with the same id does not re-apply it to what the user has done since)', () => {
            const applied: FilterState = { timestampStart: '', timestampEnd: '', sensorFilters: [cond('f1', 'A')] };
            const change = { id: 1, rename: { from: 'A', to: 'A2' } };
            const renamed: FilterState = { ...applied, sensorFilters: [cond('f1', 'A2')] };
            const { rerender } = render(<FilterPanel filters={renamed} onFiltersChange={vi.fn()} selectedSensors={['A', 'A2']} sensorChange={{ id: 0 }} />);
            rerender(<FilterPanel filters={renamed} onFiltersChange={vi.fn()} selectedSensors={['A', 'A2']} sensorChange={change} />);
            // The user picks sensor A again for that row ...
            pickSingle(sensorTriggers()[0], 'A');
            expect(selectValues()).toEqual(['A']);
            // ... and an unrelated re-render with the SAME change does not rename it again.
            rerender(<FilterPanel filters={renamed} onFiltersChange={vi.fn()} selectedSensors={['A', 'A2']} sensorChange={change} />);
            expect(selectValues()).toEqual(['A']);
        });

        it('a panel mounted with a non-zero id does not replay an old change', () => {
            const applied: FilterState = { timestampStart: '', timestampEnd: '', sensorFilters: [cond('f1', 'A')] };
            render(<FilterPanel filters={applied} onFiltersChange={vi.fn()} selectedSensors={['A']} sensorChange={{ id: 5, rename: { from: 'A', to: 'ZZ' } }} />);
            expect(selectValues()).toEqual(['A']);
        });
    });
});
