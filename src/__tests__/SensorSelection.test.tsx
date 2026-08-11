import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SensorSelection from '../components/dashboard/SensorSelection';
import type { FailureGroup, FailureSensorRow, SensorMetadata } from '../types';

const sensorMetadata: SensorMetadata[] = [
    { tag: 'TAG1', description: 'Pump Pressure', unit: 'bar', component: 'Pump', alarmH: 90 },
    { tag: 'TAG2', description: 'Pump Temp', unit: 'C', component: 'Pump' },
];

const groupA: FailureGroup = { no: 1, name: 'Group A', isCollapsed: false };
const rowTag1InGroupA: FailureSensorRow = {
    id: 'r1', groupNo: 1, conceptSensor: '', mappedSensorTag: 'TAG1',
    mappedSensorName: '', modelType: '', modelNotes: '', additionalNotes: '', status: false,
};

function makeProps(overrides: Partial<React.ComponentProps<typeof SensorSelection>> = {}) {
    return {
        sensors: ['TAG1', 'TAG2', 'TAG3'],
        selectedSensors: [] as string[],
        onSensorChange: vi.fn(),
        sensorMetadata,
        fgGroups: [{ no: 0, name: 'Not in Group', isCollapsed: false }, groupA],
        fgRows: [rowTag1InGroupA],
        getGroupColor: () => 'blue',
        onToggleSensorGroup: vi.fn(),
        onCreateGroupForSensor: vi.fn(),
        onRenameGroup: vi.fn(),
        onDeleteGroup: vi.fn(),
        alarmLinesEnabled: {} as Record<string, any>,
        onToggleAlarmLine: vi.fn(),
        ...overrides,
    };
}

function expandPump() {
    fireEvent.click(screen.getByText('Pump'));
}

describe('SensorSelection', () => {
    it('groups sensors by component alphabetically, with unmapped sensors under "Uncategorized"', () => {
        render(<SensorSelection {...makeProps()} />);
        const headers = screen.getAllByText(/Pump|Uncategorized/).map((el) => el.textContent);
        expect(headers).toEqual(['Pump', 'Uncategorized']);
    });

    it('shows the sensor count next to each component header', () => {
        render(<SensorSelection {...makeProps()} />);
        expect(screen.getByText('2')).toBeTruthy(); // Pump: TAG1+TAG2
        expect(screen.getByText('1')).toBeTruthy(); // Uncategorized: TAG3
    });

    it('components start collapsed — sensor rows are hidden until the header is clicked', () => {
        render(<SensorSelection {...makeProps()} />);
        expect(screen.queryByText('Pump Pressure')).toBeNull();
        expandPump();
        expect(screen.getByText('Pump Pressure')).toBeTruthy();
    });

    it('shows "No sensors found" when nothing matches', () => {
        render(<SensorSelection {...makeProps({ sensors: [] })} />);
        expect(screen.getByText('No sensors found')).toBeTruthy();
    });

    describe('search', () => {
        it('filters by description text and force-expands matching groups', () => {
            render(<SensorSelection {...makeProps()} />);
            fireEvent.change(screen.getByPlaceholderText('Search sensors...'), { target: { value: 'Pressure' } });
            expect(screen.getByText('Pump Pressure')).toBeTruthy(); // auto-expanded, no click needed
            expect(screen.queryByText('Pump Temp')).toBeNull();
        });

        it('shows a "Clear filter" button while searching, which resets the search', () => {
            render(<SensorSelection {...makeProps()} />);
            fireEvent.change(screen.getByPlaceholderText('Search sensors...'), { target: { value: 'Pressure' } });
            fireEvent.click(screen.getByText('Clear filter'));
            expect((screen.getByPlaceholderText('Search sensors...') as HTMLInputElement).value).toBe('');
            expect(screen.queryByText('Clear filter')).toBeNull();
        });
    });

    describe('selecting sensors', () => {
        it('checking a sensor calls onSensorChange with it appended', () => {
            const onSensorChange = vi.fn();
            render(<SensorSelection {...makeProps({ onSensorChange })} />);
            expandPump();
            fireEvent.click(screen.getByLabelText(/Pump Pressure/));
            expect(onSensorChange).toHaveBeenCalledWith(['TAG1']);
        });

        it('unchecking an already-selected sensor removes it', () => {
            const onSensorChange = vi.fn();
            render(<SensorSelection {...makeProps({ onSensorChange, selectedSensors: ['TAG1'] })} />);
            expandPump();
            fireEvent.click(screen.getByLabelText(/Pump Pressure/));
            expect(onSensorChange).toHaveBeenCalledWith([]);
        });

        it('clicking anywhere on the row also toggles selection, exactly once', () => {
            const onSensorChange = vi.fn();
            render(<SensorSelection {...makeProps({ onSensorChange })} />);
            expandPump();
            fireEvent.click(screen.getByText('Pump Pressure'));
            expect(onSensorChange).toHaveBeenCalledTimes(1);
            expect(onSensorChange).toHaveBeenCalledWith(['TAG1']);
        });

        describe('maxSelectable cap (Pair Plot: at most N sensors)', () => {
            it('blocks selecting a NEW sensor once the cap is reached — the click is a no-op', () => {
                const onSensorChange = vi.fn();
                render(<SensorSelection {...makeProps({
                    onSensorChange, selectedSensors: ['TAG1', 'TAG2'], maxSelectable: 2,
                })} />);
                fireEvent.click(screen.getByText('Uncategorized'));
                fireEvent.click(screen.getByLabelText('TAG3'));
                expect(onSensorChange).not.toHaveBeenCalled();
            });

            it('still allows deselecting an already-selected sensor at the cap', () => {
                const onSensorChange = vi.fn();
                render(<SensorSelection {...makeProps({
                    onSensorChange, selectedSensors: ['TAG1', 'TAG2'], maxSelectable: 2,
                })} />);
                expandPump();
                fireEvent.click(screen.getByLabelText(/Pump Pressure/));
                expect(onSensorChange).toHaveBeenCalledWith(['TAG2']);
            });

            it('disables the checkbox (and dims the row) for unselected sensors once at the cap', () => {
                render(<SensorSelection {...makeProps({
                    selectedSensors: ['TAG1', 'TAG2'], maxSelectable: 2,
                })} />);
                fireEvent.click(screen.getByText('Uncategorized'));
                const checkbox = screen.getByLabelText('TAG3') as HTMLInputElement;
                expect(checkbox.disabled).toBe(true);
            });

            it('does not block selection while under the cap', () => {
                const onSensorChange = vi.fn();
                render(<SensorSelection {...makeProps({
                    onSensorChange, selectedSensors: ['TAG1'], maxSelectable: 2,
                })} />);
                fireEvent.click(screen.getByText('Uncategorized'));
                fireEvent.click(screen.getByLabelText('TAG3'));
                expect(onSensorChange).toHaveBeenCalledWith(['TAG1', 'TAG3']);
            });

            it('has no effect at all when maxSelectable is undefined (Line/Scatter mode)', () => {
                const onSensorChange = vi.fn();
                render(<SensorSelection {...makeProps({
                    onSensorChange, selectedSensors: ['TAG1', 'TAG2'],
                })} />);
                fireEvent.click(screen.getByText('Uncategorized'));
                fireEvent.click(screen.getByLabelText('TAG3'));
                expect(onSensorChange).toHaveBeenCalledWith(['TAG1', 'TAG2', 'TAG3']);
            });
        });

        it('shows a singular/plural selected-count badge', () => {
            const { rerender } = render(<SensorSelection {...makeProps({ selectedSensors: ['TAG1'] })} />);
            expect(screen.getByText('1 sensor selected')).toBeTruthy();
            rerender(<SensorSelection {...makeProps({ selectedSensors: ['TAG1', 'TAG2'] })} />);
            expect(screen.getByText('2 sensors selected')).toBeTruthy();
        });
    });

    describe('alarm setpoints', () => {
        it('only shows the alarm bell for a sensor that has at least one setpoint', () => {
            render(<SensorSelection {...makeProps()} />);
            expandPump();
            expect(screen.getAllByTitle('Alarm setpoints')).toHaveLength(1); // TAG1 only
        });

        it('clicking the bell reveals the configured setpoint levels with values', () => {
            render(<SensorSelection {...makeProps()} />);
            expandPump();
            fireEvent.click(screen.getByTitle('Alarm setpoints'));
            expect(screen.getByText('High (90)')).toBeTruthy();
        });

        it('toggling a level checkbox calls onToggleAlarmLine', () => {
            const onToggleAlarmLine = vi.fn();
            render(<SensorSelection {...makeProps({ onToggleAlarmLine })} />);
            expandPump();
            fireEvent.click(screen.getByTitle('Alarm setpoints'));
            fireEvent.click(screen.getByRole('checkbox', { name: /High \(90\)/ }));
            expect(onToggleAlarmLine).toHaveBeenCalledWith('TAG1', 'H');
        });
    });

    describe('failure-group badge chips', () => {
        it('shows a chip for each group the sensor already belongs to', () => {
            render(<SensorSelection {...makeProps()} />);
            expandPump();
            expect(screen.getByText('Group A')).toBeTruthy();
        });

        it('removing via the chip\'s X calls onToggleSensorGroup', () => {
            const onToggleSensorGroup = vi.fn();
            render(<SensorSelection {...makeProps({ onToggleSensorGroup })} />);
            expandPump();
            fireEvent.click(screen.getByTitle('Remove from Group A'));
            expect(onToggleSensorGroup).toHaveBeenCalledWith('TAG1', 1);
        });
    });

    describe('the group-assignment menu', () => {
        it('opens via the FolderPlus button and via right-click', () => {
            render(<SensorSelection {...makeProps()} />);
            expandPump();
            fireEvent.click(screen.getAllByTitle('Add to failure group')[0]);
            expect(screen.getByPlaceholderText('New group name')).toBeTruthy();

            fireEvent.click(screen.getAllByTitle('Add to failure group')[0]); // toggle closed
            expect(screen.queryByPlaceholderText('New group name')).toBeNull();

            // Right-click directly on TAG2's own FolderPlus button (the
            // context-menu handler lives on the button, not the row).
            fireEvent.contextMenu(screen.getAllByTitle('Add to failure group')[1]);
            expect(screen.getByPlaceholderText('New group name')).toBeTruthy();
        });

        it('lists existing groups with an Add button when the sensor is not yet a member', () => {
            const onToggleSensorGroup = vi.fn();
            render(<SensorSelection {...makeProps({ onToggleSensorGroup })} />);
            expandPump();
            // Open TAG2's menu — TAG2 is not in Group A.
            const folderButtons = screen.getAllByTitle('Add to failure group');
            fireEvent.click(folderButtons[1]);
            fireEvent.click(screen.getByTitle('Add to Group A'));
            expect(onToggleSensorGroup).toHaveBeenCalledWith('TAG2', 1);
        });

        it('does not show an Add button for a group the sensor already belongs to', () => {
            render(<SensorSelection {...makeProps()} />);
            expandPump();
            fireEvent.click(screen.getAllByTitle('Add to failure group')[0]); // TAG1's own menu
            expect(screen.queryByTitle('Add to Group A')).toBeNull();
        });

        it('renaming a group commits via Enter or the check button', () => {
            const onRenameGroup = vi.fn();
            render(<SensorSelection {...makeProps({ onRenameGroup })} />);
            expandPump();
            fireEvent.click(screen.getAllByTitle('Add to failure group')[0]);
            fireEvent.click(screen.getByTitle('Rename Group A'));
            const input = screen.getByDisplayValue('Group A') as HTMLInputElement;
            fireEvent.change(input, { target: { value: 'Renamed' } });
            fireEvent.keyDown(input, { key: 'Enter' });
            expect(onRenameGroup).toHaveBeenCalledWith(1, 'Renamed');
        });

        it('deleting a group calls onDeleteGroup', () => {
            const onDeleteGroup = vi.fn();
            render(<SensorSelection {...makeProps({ onDeleteGroup })} />);
            expandPump();
            fireEvent.click(screen.getAllByTitle('Add to failure group')[0]);
            fireEvent.click(screen.getByTitle('Delete Group A'));
            expect(onDeleteGroup).toHaveBeenCalledWith(1);
        });

        it('shows "No failure groups yet" when there are none besides the sentinel', () => {
            render(<SensorSelection {...makeProps({ fgGroups: [{ no: 0, name: 'Not in Group', isCollapsed: false }] })} />);
            expandPump();
            fireEvent.click(screen.getAllByTitle('Add to failure group')[0]);
            expect(screen.getByText('No failure groups yet')).toBeTruthy();
        });

        it('creating a new group: Create is disabled until typed, then calls onCreateGroupForSensor', () => {
            const onCreateGroupForSensor = vi.fn();
            render(<SensorSelection {...makeProps({ onCreateGroupForSensor })} />);
            expandPump();
            fireEvent.click(screen.getAllByTitle('Add to failure group')[0]);
            const createBtn = screen.getByText('Create') as HTMLButtonElement;
            expect(createBtn.disabled).toBe(true);

            const input = screen.getByPlaceholderText('New group name');
            fireEvent.change(input, { target: { value: 'New Group' } });
            expect(createBtn.disabled).toBe(false);
            fireEvent.click(createBtn);
            expect(onCreateGroupForSensor).toHaveBeenCalledWith('TAG1', 'New Group');
        });

        it('Enter in the new-group input also commits', () => {
            const onCreateGroupForSensor = vi.fn();
            render(<SensorSelection {...makeProps({ onCreateGroupForSensor })} />);
            expandPump();
            fireEvent.click(screen.getAllByTitle('Add to failure group')[0]);
            const input = screen.getByPlaceholderText('New group name');
            fireEvent.change(input, { target: { value: 'Via Enter' } });
            fireEvent.keyDown(input, { key: 'Enter' });
            expect(onCreateGroupForSensor).toHaveBeenCalledWith('TAG1', 'Via Enter');
        });
    });
});
