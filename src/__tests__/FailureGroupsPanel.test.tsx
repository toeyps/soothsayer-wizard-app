import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FailureGroupsPanel from '../components/dashboard/FailureGroupsPanel';
import type { FailureGroup, FailureModel } from '../types';

function makeModel(overrides: Partial<FailureModel> = {}): FailureModel {
    return {
        id: 'm1', groupNo: 1, name: 'Model 1', kind: 'individual', category: null,
        notes: '', status: false,
        targetSensor: 'TAG1', predictorSensors: [], xSensor: '', ySensor: '',
        individualChecked: true, rcMode: null, scatterXSensor: '', relModelName: '',
        relStiffness: 100_000, clusterModelName: '', numClusters: 3, criteriaSensor: '',
        clusterRanges: [], filterTimeStart: '', filterTimeEnd: '', pmSensorFilters: [],
        ...overrides,
    };
}

const notInGroup: FailureGroup = { no: 0, name: 'Not in Group', isCollapsed: false };
const groupA: FailureGroup = { no: 1, name: 'Group A', isCollapsed: false };
const groupB: FailureGroup = { no: 2, name: 'Group B', isCollapsed: false };

function makeProps(overrides: Partial<React.ComponentProps<typeof FailureGroupsPanel>> = {}) {
    return {
        fgGroups: [notInGroup, groupA],
        fgModels: [makeModel()],
        getGroupColor: () => 'blue',
        onRenameGroup: vi.fn(),
        onDeleteGroup: vi.fn(),
        onCreateEmptyGroup: vi.fn(),
        onOpenBuildModel: vi.fn(),
        ...overrides,
    };
}

let confirmSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
    confirmSpy.mockRestore();
});

describe('FailureGroupsPanel', () => {
    it('shows the empty state when there are no real groups', () => {
        render(<FailureGroupsPanel {...makeProps({ fgGroups: [notInGroup], fgModels: [] })} />);
        expect(screen.getByText('No failure groups yet')).toBeTruthy();
    });

    it('never renders group 0 ("Not in Group") as a card', () => {
        render(<FailureGroupsPanel {...makeProps()} />);
        expect(screen.queryByText('Not in Group')).toBeNull();
        expect(screen.getByText('Group A')).toBeTruthy();
    });

    it('computes header stats: model count, group count, completion %', () => {
        const fgModels = [makeModel({ id: 'm1', status: true }), makeModel({ id: 'm2', status: false })];
        const { container } = render(<FailureGroupsPanel {...makeProps({ fgModels })} />);
        const statBolds = container.querySelectorAll('b');
        expect(Array.from(statBolds).map((b) => b.textContent)).toEqual(['2', '1', '50%']);
    });

    it('shows a per-group model count and completion summary', () => {
        const fgModels = [makeModel({ id: 'm1', status: true }), makeModel({ id: 'm2', status: false })];
        render(<FailureGroupsPanel {...makeProps({ fgModels })} />);
        expect(screen.getByText('2 models · 1/2 complete')).toBeTruthy();
    });

    it('shows an italic placeholder when a group has no description', () => {
        render(<FailureGroupsPanel {...makeProps()} />);
        expect(screen.getByText('No description yet')).toBeTruthy();
    });

    it('shows the description preview when set', () => {
        render(<FailureGroupsPanel {...makeProps({ fgGroups: [notInGroup, { ...groupA, description: 'Bearing wear' }] })} />);
        expect(screen.getByText('Bearing wear')).toBeTruthy();
        expect(screen.queryByText('No description yet')).toBeNull();
    });

    it('shows the FG-{no} id badge', () => {
        render(<FailureGroupsPanel {...makeProps()} />);
        expect(screen.getByText('FG-1')).toBeTruthy();
    });

    it('clicking anywhere on the card opens Build Model for that group', () => {
        const onOpenBuildModel = vi.fn();
        render(<FailureGroupsPanel {...makeProps({ onOpenBuildModel })} />);
        fireEvent.click(screen.getByText('Group A'));
        expect(onOpenBuildModel).toHaveBeenCalledWith(1);
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

        it('does not open Build Model when clicking into the rename input', () => {
            const onOpenBuildModel = vi.fn();
            render(<FailureGroupsPanel {...makeProps({ onOpenBuildModel })} />);
            fireEvent.click(screen.getByTitle('Rename group'));
            expect(onOpenBuildModel).not.toHaveBeenCalled();
        });

        it('rejects renaming to a name already used by another group (case-insensitive), with an inline error', () => {
            const onRenameGroup = vi.fn();
            render(<FailureGroupsPanel {...makeProps({ fgGroups: [notInGroup, groupA, groupB], onRenameGroup })} />);
            fireEvent.click(screen.getAllByTitle('Rename group')[0]);
            const input = screen.getByDisplayValue('Group A') as HTMLInputElement;
            fireEvent.change(input, { target: { value: 'group b' } });
            fireEvent.keyDown(input, { key: 'Enter' });
            expect(onRenameGroup).not.toHaveBeenCalled();
            expect(screen.getByText('A failure group named "group b" already exists')).toBeTruthy();
        });

        it('allows renaming a group to its own current name unchanged', () => {
            const onRenameGroup = vi.fn();
            render(<FailureGroupsPanel {...makeProps({ fgGroups: [notInGroup, groupA, groupB], onRenameGroup })} />);
            fireEvent.click(screen.getAllByTitle('Rename group')[0]);
            const input = screen.getByDisplayValue('Group A') as HTMLInputElement;
            fireEvent.keyDown(input, { key: 'Enter' });
            expect(onRenameGroup).toHaveBeenCalledWith(1, 'Group A');
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

        it('does not open Build Model when clicking delete', () => {
            const onOpenBuildModel = vi.fn();
            render(<FailureGroupsPanel {...makeProps({ onOpenBuildModel })} />);
            fireEvent.click(screen.getByTitle('Delete group'));
            expect(onOpenBuildModel).not.toHaveBeenCalled();
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

        it('rejects a duplicate name (case-insensitive) with an inline error and keeps the form open', () => {
            const onCreateEmptyGroup = vi.fn();
            render(<FailureGroupsPanel {...makeProps({ fgGroups: [notInGroup, groupA], onCreateEmptyGroup })} />);
            fireEvent.click(screen.getByText('Add failure group'));
            const input = screen.getByPlaceholderText('New group name');
            fireEvent.change(input, { target: { value: 'group a' } });
            fireEvent.click(screen.getByText('Create'));
            expect(onCreateEmptyGroup).not.toHaveBeenCalled();
            expect(screen.getByText('A failure group named "group a" already exists')).toBeTruthy();
            expect(screen.getByPlaceholderText('New group name')).toBeTruthy();
        });
    });
});
