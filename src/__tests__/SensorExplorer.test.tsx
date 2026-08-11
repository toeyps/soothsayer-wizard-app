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

    it('collapsing "All Components" hides every group and ungrouped sensor', () => {
        render(<SensorExplorer {...makeProps()} />);
        fireEvent.click(screen.getByText('All Components'));
        expect(screen.queryByText('Pump')).toBeNull();
        expect(screen.queryByText('TAG3')).toBeNull();
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

    it('shows the checkbox checked for a selected sensor', () => {
        render(<SensorExplorer {...makeProps({ selectedSensors: ['TAG1'] })} />);
        fireEvent.click(screen.getByText('Pump'));
        const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
        const tag1Row = screen.getByText('Pump Pressure').closest('div')!;
        const checkbox = tag1Row.querySelector('input[type="checkbox"]') as HTMLInputElement;
        expect(checkbox.checked).toBe(true);
        expect(checkboxes.some((c) => !c.checked)).toBe(true); // others unchecked
    });

    it('falls back to the raw tag for a sensor with no metadata', () => {
        render(<SensorExplorer {...makeProps()} />);
        expect(screen.getByText('TAG3')).toBeTruthy();
        expect(screen.queryByText('undefined')).toBeNull();
    });

    it('typing in the search box calls onSearchChange', () => {
        const onSearchChange = vi.fn();
        render(<SensorExplorer {...makeProps({ onSearchChange })} />);
        fireEvent.change(screen.getByPlaceholderText('Search sensors...'), { target: { value: 'pump' } });
        expect(onSearchChange).toHaveBeenCalledWith('pump');
    });

    it('reflects the controlled searchTerm value in the input', () => {
        render(<SensorExplorer {...makeProps({ searchTerm: 'abc' })} />);
        expect((screen.getByPlaceholderText('Search sensors...') as HTMLInputElement).value).toBe('abc');
    });
});
