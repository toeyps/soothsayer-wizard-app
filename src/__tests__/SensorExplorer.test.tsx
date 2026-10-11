import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SensorExplorer from '../components/windows/SensorExplorer';
import type { SensorMetadata } from '../types';

const sensorMetadata: SensorMetadata[] = [
    { tag: 'TAG1', description: 'Pump Pressure', unit: 'bar', component: 'Pump' },
    { tag: 'TAG2', description: 'Pump Temp', unit: 'C', component: 'Pump' },
];

function makeProps(overrides: Partial<React.ComponentProps<typeof SensorExplorer>> = {}) {
    return {
        sensors: ['TAG1', 'TAG2', 'TAG3'],
        sensorMetadata,
        selectedSensors: [] as string[],
        onToggleSensor: vi.fn(),
        searchTerm: '',
        onSearchChange: vi.fn(),
        ...overrides,
    };
}

describe('SensorExplorer', () => {
    it('groups mapped sensors by component and lists unmapped sensors separately', () => {
        render(<SensorExplorer {...makeProps()} />);
        expect(screen.getByText('Pump')).toBeTruthy();
        expect(screen.getByText('2')).toBeTruthy(); // Pump group count
        // TAG3 has no metadata -> rendered directly under root, shown by its raw tag.
        expect(screen.getByText('TAG3')).toBeTruthy();
    });

    it('component groups start collapsed until clicked open', () => {
        render(<SensorExplorer {...makeProps()} />);
        expect(screen.queryByText('Pump Pressure')).toBeNull();
        fireEvent.click(screen.getByText('Pump'));
        expect(screen.getByText('Pump Pressure')).toBeTruthy();
        expect(screen.getByText('Pump Temp')).toBeTruthy();
    });

    it('re-clicking an opened component group collapses it again, without affecting ungrouped sensors', () => {
        render(<SensorExplorer {...makeProps()} />);
        fireEvent.click(screen.getByText('Pump')); // open
        fireEvent.click(screen.getByText('Pump')); // close
        expect(screen.queryByText('Pump Pressure')).toBeNull();
        expect(screen.getByText('TAG3')).toBeTruthy(); // ungrouped sensor unaffected
    });

    it('clicking a sensor row calls onToggleSensor with its tag', () => {
        const onToggleSensor = vi.fn();
        render(<SensorExplorer {...makeProps({ onToggleSensor })} />);
        fireEvent.click(screen.getByText('Pump'));
        fireEvent.click(screen.getByText('Pump Pressure'));
        expect(onToggleSensor).toHaveBeenCalledWith('TAG1');
    });

    // A click PICKS the row for Quick build — a "Picked" pill
    // (was "Added" while rows were sources), a + icon otherwise; the group header counts picks.
    it('shows a "Picked" pill for a picked sensor and a + icon for one that is not; the group counts the picks', () => {
        render(<SensorExplorer {...makeProps({ selectedSensors: ['TAG1'] })} />);
        fireEvent.click(screen.getByText('Pump'));
        const tag1Row = screen.getByText('Pump Pressure').closest('.special-sensor-row')!;
        expect(tag1Row.querySelector('.special-sensor-added-pill')?.textContent).toContain('Picked');
        expect(tag1Row.classList.contains('is-picked')).toBe(true);
        expect(tag1Row.querySelector('.special-sensor-add-icon')).toBeNull();

        const tag2Row = screen.getByText('Pump Temp').closest('.special-sensor-row')!;
        expect(tag2Row.querySelector('.special-sensor-added-pill')).toBeNull();
        expect(tag2Row.querySelector('.special-sensor-add-icon')).toBeTruthy();
        expect(screen.getByText('Pump').parentElement!.textContent).toContain('1 / 2');
    });

    it('the `$` button inserts the sensor at the caret instead of picking the row', () => {
        const onToggleSensor = vi.fn();
        const onInsertSensor = vi.fn();
        render(<SensorExplorer {...makeProps({ onToggleSensor, onInsertSensor })} />);
        fireEvent.click(screen.getByLabelText('Insert TAG3 in the formula'));
        expect(onInsertSensor).toHaveBeenCalledWith('TAG3');
        expect(onToggleSensor).not.toHaveBeenCalled();
    });

    it('without an insert handler there is no `$` button', () => {
        render(<SensorExplorer {...makeProps()} />);
        expect(screen.queryByLabelText('Insert TAG3 in the formula')).toBeNull();
    });

    it('falls back to the raw tag for a sensor with no metadata', () => {
        render(<SensorExplorer {...makeProps()} />);
        expect(screen.getByText('TAG3')).toBeTruthy();
        expect(screen.queryByText('undefined')).toBeNull();
    });

    // Explorer rows are the stacked SensorLabel.
    it('rows are the stacked SensorLabel (description + unit chip, tag on line 2); a tag with no description stands alone', () => {
        render(<SensorExplorer {...makeProps()} />);
        fireEvent.click(screen.getByText('Pump'));
        const label = screen.getByText('Pump Pressure').closest('.sl') as HTMLElement;
        expect(label.querySelector('.sl-unit')?.textContent).toBe('bar');
        expect(label.querySelector('.sl-tag')?.textContent).toBe('TAG1');
        expect(label.getAttribute('title')).toBe('Pump Pressure · TAG1 · bar · Pump');
        const bare = screen.getByText('TAG3').closest('.sl') as HTMLElement;
        expect(bare.textContent).toBe('TAG3');
        expect(screen.getByPlaceholderText('Search description, tag, unit or component…')).toBeTruthy();
    });

    it('typing in the search box calls onSearchChange', () => {
        const onSearchChange = vi.fn();
        render(<SensorExplorer {...makeProps({ onSearchChange })} />);
        fireEvent.change(screen.getByPlaceholderText('Search description, tag, unit or component…'), { target: { value: 'pump' } });
        expect(onSearchChange).toHaveBeenCalledWith('pump');
    });

    it('reflects the controlled searchTerm value in the input', () => {
        render(<SensorExplorer {...makeProps({ searchTerm: 'abc' })} />);
        expect((screen.getByPlaceholderText('Search description, tag, unit or component…') as HTMLInputElement).value).toBe('abc');
    });
});
