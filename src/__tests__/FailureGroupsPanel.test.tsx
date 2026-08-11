import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FailureGroupsPanel from '../components/dashboard/FailureGroupsPanel';
import type { FailureGroup, FailureSensorRow } from '../types';

function makeRow(overrides: Partial<FailureSensorRow> = {}): FailureSensorRow {
    return {
        id: 'r1', groupNo: 1, conceptSensor: '', mappedSensorTag: 'TAG1',
        mappedSensorName: '', modelType: '', modelNotes: '', additionalNotes: '',
        status: false,
        ...overrides,
    };
}

const notInGroup: FailureGroup = { no: 0, name: 'Not in Group', isCollapsed: false };
const groupA: FailureGroup = { no: 1, name: 'Group A', isCollapsed: false };

function makeProps(overrides: Partial<React.ComponentProps<typeof FailureGroupsPanel>> = {}) {
    return {
        allSensors: ['TAG1', 'TAG2'],
        sensorMetadata: [{ tag: 'TAG2', description: 'Desc Two', unit: 'C', component: 'X' }],
        fgGroups: [notInGroup, groupA],
        fgRows: [makeRow()],
        getGroupColor: () => 'blue',
        onToggleGroupCollapse: vi.fn(),
        onRenameGroup: vi.fn(),
        onDeleteGroup: vi.fn(),
        onCreateEmptyGroup: vi.fn(),
        onAddBlankRow: vi.fn(() => 'new-row-id'),
        onUpdateRow: vi.fn(),
        onRemoveRow: vi.fn(),
        onBuildModel: vi.fn(),
        ...overrides,
    };
}

let confirmSpy: ReturnType<typeof vi.spyOn>;
let alertSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
});

afterEach(() => {
    confirmSpy.mockRestore();
    alertSpy.mockRestore();
});

describe('FailureGroupsPanel', () => {
    it('shows the empty state when there are no real groups', () => {
        render(<FailureGroupsPanel {...makeProps({ fgGroups: [notInGroup], fgRows: [] })} />);
        expect(screen.getByText('No failure groups yet')).toBeTruthy();
    });

    it('never renders group 0 ("Not in Group") as a card', () => {
        render(<FailureGroupsPanel {...makeProps()} />);
        expect(screen.queryByText('Not in Group')).toBeNull();
        expect(screen.getByText('Group A')).toBeTruthy();
    });

    it('computes header stats: sensor count, group count, completion %', () => {
        const rows = [makeRow({ id: 'r1', status: true }), makeRow({ id: 'r2', status: false })];
        const { container } = render(<FailureGroupsPanel {...makeProps({ fgRows: rows })} />);
        const statBolds = container.querySelectorAll('b');
        expect(Array.from(statBolds).map((b) => b.textContent)).toEqual(['2', '1', '50%']);
    });

    it('clicking the group header toggles collapse via the callback', () => {
        const onToggleGroupCollapse = vi.fn();
        render(<FailureGroupsPanel {...makeProps({ onToggleGroupCollapse })} />);
        fireEvent.click(screen.getByText('Group A'));
        expect(onToggleGroupCollapse).toHaveBeenCalledWith(1);
    });

    it('hides a group’s rows when it is collapsed', () => {
        render(<FailureGroupsPanel {...makeProps({ fgGroups: [notInGroup, { ...groupA, isCollapsed: true }] })} />);
        expect(screen.queryByText('TAG1')).toBeNull();
    });

    it('shows "No sensors yet" for an expanded empty group', () => {
        render(<FailureGroupsPanel {...makeProps({ fgRows: [] })} />);
        expect(screen.getByText('No sensors yet')).toBeTruthy();
    });

    describe('renaming a group', () => {
        it('opens a prefilled input and commits on Enter', () => {
            const onRenameGroup = vi.fn();
            render(<FailureGroupsPanel {...makeProps({ onRenameGroup })} />);
            fireEvent.click(screen.getByTitle('Rename group'));
            const input = screen.getByDisplayValue('Group A') as HTMLInputElement;
            fireEvent.change(input, { target: { value: 'Renamed' } });
            fireEvent.keyDown(input, { key: 'Enter' });
            expect(onRenameGroup).toHaveBeenCalledWith(1, 'Renamed');
        });

        it('commits on blur too', () => {
            const onRenameGroup = vi.fn();
            render(<FailureGroupsPanel {...makeProps({ onRenameGroup })} />);
            fireEvent.click(screen.getByTitle('Rename group'));
            const input = screen.getByDisplayValue('Group A') as HTMLInputElement;
            fireEvent.change(input, { target: { value: 'Blurred Name' } });
            fireEvent.blur(input);
            expect(onRenameGroup).toHaveBeenCalledWith(1, 'Blurred Name');
        });
    });

    describe('deleting a group', () => {
        it('calls onDeleteGroup only after the user confirms', () => {
            const onDeleteGroup = vi.fn();
            render(<FailureGroupsPanel {...makeProps({ onDeleteGroup })} />);
            fireEvent.click(screen.getByTitle('Delete group'));
            expect(confirmSpy).toHaveBeenCalled();
            expect(onDeleteGroup).toHaveBeenCalledWith(1);
        });

        it('does not call onDeleteGroup when the user cancels the confirm', () => {
            confirmSpy.mockReturnValue(false);
            const onDeleteGroup = vi.fn();
            render(<FailureGroupsPanel {...makeProps({ onDeleteGroup })} />);
            fireEvent.click(screen.getByTitle('Delete group'));
            expect(onDeleteGroup).not.toHaveBeenCalled();
        });
    });

    it('"Add sensor" creates a blank row and auto-expands it into the tag picker', () => {
        const onAddBlankRow = vi.fn(() => 'new-row-id');
        const rows = [makeRow({ id: 'new-row-id', mappedSensorTag: '' })];
        render(<FailureGroupsPanel {...makeProps({ fgRows: rows, onAddBlankRow })} />);
        fireEvent.click(screen.getByTitle('Add sensor'));
        expect(onAddBlankRow).toHaveBeenCalledWith(1);
        expect(screen.getByPlaceholderText('Search sensor…')).toBeTruthy();
    });

    describe('row expand/collapse', () => {
        it('expanding a row with a tag shows the inspector fields', () => {
            render(<FailureGroupsPanel {...makeProps()} />);
            fireEvent.click(screen.getByText('TAG1'));
            expect(screen.getByPlaceholderText('e.g. crankcase vibration')).toBeTruthy();
        });

        it('clicking the same row again collapses it', () => {
            render(<FailureGroupsPanel {...makeProps()} />);
            fireEvent.click(screen.getByText('TAG1'));
            expect(screen.getByPlaceholderText('e.g. crankcase vibration')).toBeTruthy();
            fireEvent.click(screen.getByText('TAG1'));
            expect(screen.queryByPlaceholderText('e.g. crankcase vibration')).toBeNull();
        });

        it('the status pill toggles status without expanding the row (stops propagation)', () => {
            const onUpdateRow = vi.fn();
            render(<FailureGroupsPanel {...makeProps({ onUpdateRow })} />);
            fireEvent.click(screen.getByText('Incomplete'));
            expect(onUpdateRow).toHaveBeenCalledWith('r1', 'status', true);
            expect(screen.queryByPlaceholderText('e.g. crankcase vibration')).toBeNull();
        });
    });

    describe('blank-row tag picker', () => {
        const blankRows = [makeRow({ id: 'r1', mappedSensorTag: '' })];

        it('lists all sensors with descriptions when metadata is available', () => {
            render(<FailureGroupsPanel {...makeProps({ fgRows: blankRows })} />);
            fireEvent.click(screen.getByText('— no tag —'));
            expect(screen.getByText('TAG2')).toBeTruthy();
            expect(screen.getByText('Desc Two')).toBeTruthy();
        });

        it('filters options by tag or description text', () => {
            render(<FailureGroupsPanel {...makeProps({ fgRows: blankRows })} />);
            fireEvent.click(screen.getByText('— no tag —'));
            fireEvent.change(screen.getByPlaceholderText('Search sensor…'), { target: { value: 'Two' } });
            expect(screen.queryByText('TAG1')).toBeNull();
            expect(screen.getByText('TAG2')).toBeTruthy();
        });

        it('shows "No sensors found" when the filter matches nothing', () => {
            render(<FailureGroupsPanel {...makeProps({ fgRows: blankRows })} />);
            fireEvent.click(screen.getByText('— no tag —'));
            fireEvent.change(screen.getByPlaceholderText('Search sensor…'), { target: { value: 'zzz' } });
            expect(screen.getByText('No sensors found')).toBeTruthy();
        });

        it('selecting a tag assigns it via onUpdateRow', () => {
            const onUpdateRow = vi.fn();
            render(<FailureGroupsPanel {...makeProps({ fgRows: blankRows, onUpdateRow })} />);
            fireEvent.click(screen.getByText('— no tag —'));
            fireEvent.click(screen.getByText('TAG2'));
            expect(onUpdateRow).toHaveBeenCalledWith('r1', 'mappedSensorTag', 'TAG2');
        });

        it('rejects a tag already used elsewhere in the same group, with an alert', () => {
            const onUpdateRow = vi.fn();
            const rows = [makeRow({ id: 'r1', mappedSensorTag: '' }), makeRow({ id: 'r2', mappedSensorTag: 'TAG2' })];
            const { container } = render(<FailureGroupsPanel {...makeProps({ fgRows: rows, onUpdateRow })} />);
            fireEvent.click(screen.getByText('— no tag —'));
            const option = Array.from(container.querySelectorAll('button.text-btn')).find(
                (b) => b.textContent?.startsWith('TAG2'),
            )!;
            fireEvent.click(option);
            expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('TAG2'));
            expect(onUpdateRow).not.toHaveBeenCalled();
        });

        it('Cancel removes the blank row', () => {
            const onRemoveRow = vi.fn();
            render(<FailureGroupsPanel {...makeProps({ fgRows: blankRows, onRemoveRow })} />);
            fireEvent.click(screen.getByText('— no tag —'));
            fireEvent.click(screen.getByText('Cancel — remove this row'));
            expect(onRemoveRow).toHaveBeenCalledWith('r1');
        });
    });

    describe('filled-row inspector', () => {
        it('editing Concept sensor / Model type / Model notes calls onUpdateRow per field', () => {
            const onUpdateRow = vi.fn();
            render(<FailureGroupsPanel {...makeProps({ onUpdateRow })} />);
            fireEvent.click(screen.getByText('TAG1'));

            fireEvent.change(screen.getByPlaceholderText('e.g. crankcase vibration'), { target: { value: 'Vibration' } });
            expect(onUpdateRow).toHaveBeenCalledWith('r1', 'conceptSensor', 'Vibration');

            fireEvent.change(screen.getByPlaceholderText('e.g. I + R'), { target: { value: 'ARIMA' } });
            expect(onUpdateRow).toHaveBeenCalledWith('r1', 'modelType', 'ARIMA');

            fireEvent.change(screen.getByPlaceholderText('Notes about training, features, thresholds…'), { target: { value: 'note' } });
            expect(onUpdateRow).toHaveBeenCalledWith('r1', 'modelNotes', 'note');
        });

        it('the Complete checkbox toggles status', () => {
            const onUpdateRow = vi.fn();
            render(<FailureGroupsPanel {...makeProps({ onUpdateRow })} />);
            fireEvent.click(screen.getByText('TAG1'));
            fireEvent.click(screen.getByRole('checkbox'));
            expect(onUpdateRow).toHaveBeenCalledWith('r1', 'status', true);
        });

        it('Remove calls onRemoveRow', () => {
            const onRemoveRow = vi.fn();
            render(<FailureGroupsPanel {...makeProps({ onRemoveRow })} />);
            fireEvent.click(screen.getByText('TAG1'));
            fireEvent.click(screen.getByText('Remove'));
            expect(onRemoveRow).toHaveBeenCalledWith('r1');
        });

        it('Build model calls onBuildModel with the full row', () => {
            const onBuildModel = vi.fn();
            const row = makeRow();
            render(<FailureGroupsPanel {...makeProps({ fgRows: [row], onBuildModel })} />);
            fireEvent.click(screen.getByText('TAG1'));
            fireEvent.click(screen.getByText('Build model'));
            expect(onBuildModel).toHaveBeenCalledWith(row);
        });
    });

    describe('creating a new group', () => {
        it('Create is disabled until a name is entered, then calls onCreateEmptyGroup', () => {
            const onCreateEmptyGroup = vi.fn();
            render(<FailureGroupsPanel {...makeProps({ onCreateEmptyGroup })} />);
            fireEvent.click(screen.getByText('Add failure group'));
            const createBtn = screen.getByText('Create') as HTMLButtonElement;
            expect(createBtn.disabled).toBe(true);

            fireEvent.change(screen.getByPlaceholderText('New group name'), { target: { value: 'Motors' } });
            expect(createBtn.disabled).toBe(false);
            fireEvent.click(createBtn);
            expect(onCreateEmptyGroup).toHaveBeenCalledWith('Motors');
        });

        it('Enter also commits the new group and closes the form', () => {
            const onCreateEmptyGroup = vi.fn();
            render(<FailureGroupsPanel {...makeProps({ onCreateEmptyGroup })} />);
            fireEvent.click(screen.getByText('Add failure group'));
            const input = screen.getByPlaceholderText('New group name');
            fireEvent.change(input, { target: { value: 'Pumps' } });
            fireEvent.keyDown(input, { key: 'Enter' });
            expect(onCreateEmptyGroup).toHaveBeenCalledWith('Pumps');
            expect(screen.queryByPlaceholderText('New group name')).toBeNull();
        });

        it('Escape cancels without creating', () => {
            const onCreateEmptyGroup = vi.fn();
            render(<FailureGroupsPanel {...makeProps({ onCreateEmptyGroup })} />);
            fireEvent.click(screen.getByText('Add failure group'));
            const input = screen.getByPlaceholderText('New group name');
            fireEvent.change(input, { target: { value: 'Discarded' } });
            fireEvent.keyDown(input, { key: 'Escape' });
            expect(onCreateEmptyGroup).not.toHaveBeenCalled();
            expect(screen.queryByPlaceholderText('New group name')).toBeNull();
        });
    });
});
