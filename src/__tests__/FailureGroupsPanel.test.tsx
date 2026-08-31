import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FailureGroupsPanel from '../components/dashboard/FailureGroupsPanel';
import type { FailureGroup, FailureModel, SensorMetadata } from '../types';

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

const sensorMetadata: SensorMetadata[] = [
    { tag: 'TAG1', description: 'Pump Pressure', unit: 'bar', component: 'Pump' },
];

function makeProps(overrides: Partial<React.ComponentProps<typeof FailureGroupsPanel>> = {}) {
    return {
        fgGroups: [notInGroup, groupA],
        fgModels: [makeModel()],
        sensors: ['TAG1', 'TAG2', 'TAG3'],
        sensorMetadata,
        getGroupColor: () => 'blue',
        onRenameGroup: vi.fn(),
        onDeleteGroup: vi.fn(),
        onCreateEmptyGroup: vi.fn(),
        onQuickAddModel: vi.fn(),
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

    it('does not render group 0 ("Not in Group") as a card when it has no models', () => {
        render(<FailureGroupsPanel {...makeProps()} />);
        expect(screen.queryByText('Not in Group')).toBeNull();
        expect(screen.getByText('Group A')).toBeTruthy();
    });

    describe('"Not in Group" card (group 0)', () => {
        it('renders once a model has groupNo 0, listed by its display label', () => {
            const fgModels = [makeModel({ id: 'm1' }), makeModel({ id: 'm2', groupNo: 0, name: '', targetSensor: 'TAG1' })];
            render(<FailureGroupsPanel {...makeProps({ fgModels })} />);
            expect(screen.getByText('Not in Group')).toBeTruthy();
            expect(screen.getByText('Pump Pressure (TAG1)')).toBeTruthy();
        });

        it('has no rename/delete controls (it is a permanent, non-editable bucket)', () => {
            const fgModels = [makeModel({ id: 'm1', groupNo: 0 })];
            render(<FailureGroupsPanel {...makeProps({ fgModels, fgGroups: [notInGroup] })} />);
            expect(screen.queryAllByTitle('Rename group')).toHaveLength(0);
            expect(screen.queryAllByTitle('Delete group')).toHaveLength(0);
        });

        it('does not count toward the "groups" stat (it is not a real failure group)', () => {
            const fgModels = [makeModel({ id: 'm1', groupNo: 0 })];
            const { container } = render(<FailureGroupsPanel {...makeProps({ fgModels, fgGroups: [notInGroup] })} />);
            const statBolds = container.querySelectorAll('b');
            expect(Array.from(statBolds).map((b) => b.textContent)).toEqual(['1', '0']);
        });
    });

    it('computes header stats: model count, group count (no completion % anymore — status lives only in Build Model)', () => {
        const fgModels = [makeModel({ id: 'm1', status: true }), makeModel({ id: 'm2', status: false })];
        const { container } = render(<FailureGroupsPanel {...makeProps({ fgModels })} />);
        const statBolds = container.querySelectorAll('b');
        expect(Array.from(statBolds).map((b) => b.textContent)).toEqual(['2', '1']);
    });

    it('lists every model in the group by name, without any Complete/Incomplete status (removed per user request)', () => {
        const fgModels = [makeModel({ id: 'm1', name: 'Bearing model', status: true }), makeModel({ id: 'm2', name: 'Temp model', status: false })];
        render(<FailureGroupsPanel {...makeProps({ fgModels })} />);
        expect(screen.getByText('Bearing model')).toBeTruthy();
        expect(screen.getByText('Temp model')).toBeTruthy();
        expect(screen.queryByText('Complete')).toBeNull();
        expect(screen.queryByText('Incomplete')).toBeNull();
    });

    describe('model display label fallback chain', () => {
        it('shows the model name when one is set', () => {
            render(<FailureGroupsPanel {...makeProps({ fgModels: [makeModel({ name: 'Bearing model', targetSensor: 'TAG1' })] })} />);
            expect(screen.getByText('Bearing model')).toBeTruthy();
            expect(screen.queryByText('Pump Pressure (TAG1)')).toBeNull();
        });

        it('falls back to "description (tag)" for the target sensor when the model has no name', () => {
            render(<FailureGroupsPanel {...makeProps({ fgModels: [makeModel({ name: '', targetSensor: 'TAG1' })] })} />);
            expect(screen.getByText('Pump Pressure (TAG1)')).toBeTruthy();
        });

        it('treats a name identical to its own target tag as unset (legacy-migrated models default name to the tag) and falls back to "description (tag)"', () => {
            render(<FailureGroupsPanel {...makeProps({ fgModels: [makeModel({ name: 'TAG1', targetSensor: 'TAG1' })] })} />);
            expect(screen.getByText('Pump Pressure (TAG1)')).toBeTruthy();
            expect(screen.queryByText('TAG1')).toBeNull();
        });

        it('falls back to the raw sensor tag when no name and no metadata description is available', () => {
            render(<FailureGroupsPanel {...makeProps({ fgModels: [makeModel({ name: '', targetSensor: 'TAG9' })] })} />);
            expect(screen.getByText('TAG9')).toBeTruthy();
        });

        it('uses the Y sensor (not the target) for a clustering model, matching component derivation elsewhere', () => {
            const model = makeModel({ name: '', kind: 'clustering', targetSensor: '', xSensor: 'TAG9', ySensor: 'TAG1' });
            render(<FailureGroupsPanel {...makeProps({ fgModels: [model] })} />);
            expect(screen.getByText('Pump Pressure (TAG1)')).toBeTruthy();
        });

        it('falls back to "Untitled model" for a model with no name and no sensor picked yet', () => {
            render(<FailureGroupsPanel {...makeProps({ fgModels: [makeModel({ name: '', targetSensor: '' })] })} />);
            expect(screen.getByText('Untitled model')).toBeTruthy();
        });
    });

    it('shows "No models yet" for an empty group', () => {
        render(<FailureGroupsPanel {...makeProps({ fgModels: [] })} />);
        expect(screen.getByText('No models yet')).toBeTruthy();
    });

    it('does not show a description preview (reverted per user feedback)', () => {
        render(<FailureGroupsPanel {...makeProps({ fgGroups: [notInGroup, { ...groupA, description: 'Bearing wear' }] })} />);
        expect(screen.queryByText('Bearing wear')).toBeNull();
        expect(screen.queryByText('No description yet')).toBeNull();
    });

    it('shows the FG-{no} id badge', () => {
        render(<FailureGroupsPanel {...makeProps()} />);
        expect(screen.getByText('FG-1')).toBeTruthy();
    });

    it('clicking on a card does nothing (cards are read-only; no click-to-open anymore)', () => {
        const onOpenBuildModel = vi.fn();
        render(<FailureGroupsPanel {...makeProps({ onOpenBuildModel })} />);
        fireEvent.click(screen.getByText('Group A'));
        expect(onOpenBuildModel).not.toHaveBeenCalled();
    });

    it('the bottom "Build Model" button opens the Build Model window', () => {
        const onOpenBuildModel = vi.fn();
        render(<FailureGroupsPanel {...makeProps({ onOpenBuildModel })} />);
        fireEvent.click(screen.getByText('Build Model'));
        expect(onOpenBuildModel).toHaveBeenCalledTimes(1);
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

        it('does not open Build Model Overview when clicking into the rename input', () => {
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

        it('does not open Build Model Overview when clicking delete', () => {
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

    describe('quick-add model (per-card "+ Add model" -> a lightweight modal, not the full Build Model form)', () => {
        it('the modal is closed by default', () => {
            render(<FailureGroupsPanel {...makeProps()} />);
            expect(screen.queryByText('Model name')).toBeNull();
        });

        it('opens the modal for the clicked group, showing its name in the header', () => {
            render(<FailureGroupsPanel {...makeProps({ fgGroups: [notInGroup, groupA, groupB], fgModels: [] })} />);
            const addButtons = screen.getAllByText('Add model');
            fireEvent.click(addButtons[1]); // groupA, groupB in order -> index 1 = Group B
            expect(document.querySelector('.quick-add-model-header')!.textContent).toContain('Group B');
            expect(screen.getByText('Model name')).toBeTruthy();
        });

        it('shows a single "Target sensor" picker for Individual/Relationship, but X/Y pickers for Clustering', () => {
            render(<FailureGroupsPanel {...makeProps({ fgModels: [] })} />);
            fireEvent.click(screen.getByText('Add model'));
            fireEvent.click(screen.getByText('Individual'));
            expect(screen.getByText('Target sensor')).toBeTruthy();
            expect(screen.queryByText('X sensor')).toBeNull();

            fireEvent.click(screen.getByText('Clustering'));
            expect(screen.queryByText('Target sensor')).toBeNull();
            expect(screen.getByText('X sensor')).toBeTruthy();
            expect(screen.getByText('Y sensor')).toBeTruthy();
        });

        it('"Create model" stays disabled until name + kind + the kind-appropriate sensor(s) are filled', () => {
            render(<FailureGroupsPanel {...makeProps({ fgModels: [] })} />);
            fireEvent.click(screen.getByText('Add model'));
            const create = screen.getByText('Create model').closest('button') as HTMLButtonElement;
            expect(create.disabled).toBe(true);

            fireEvent.change(screen.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'New Model' } });
            expect(create.disabled).toBe(true);

            fireEvent.click(screen.getByText('Individual'));
            expect(create.disabled).toBe(true);

            fireEvent.change(screen.getByDisplayValue('Select a sensor…'), { target: { value: 'TAG2' } });
            expect(create.disabled).toBe(false);
        });

        it('requires both X and Y for Clustering before enabling Create', () => {
            render(<FailureGroupsPanel {...makeProps({ fgModels: [] })} />);
            fireEvent.click(screen.getByText('Add model'));
            fireEvent.change(screen.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Cluster Model' } });
            fireEvent.click(screen.getByText('Clustering'));
            const create = screen.getByText('Create model').closest('button') as HTMLButtonElement;
            const [xSelect, ySelect] = screen.getAllByDisplayValue('Select a sensor…');
            fireEvent.change(xSelect, { target: { value: 'TAG1' } });
            expect(create.disabled).toBe(true);
            fireEvent.change(ySelect, { target: { value: 'TAG2' } });
            expect(create.disabled).toBe(false);
        });

        it('calls onQuickAddModel with the group, trimmed name, kind, and target on Create, then closes the modal', () => {
            const onQuickAddModel = vi.fn();
            render(<FailureGroupsPanel {...makeProps({ fgGroups: [notInGroup, groupA], fgModels: [], onQuickAddModel })} />);
            fireEvent.click(screen.getByText('Add model'));
            fireEvent.change(screen.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: '  New Model  ' } });
            fireEvent.click(screen.getByText('Individual'));
            fireEvent.change(screen.getByDisplayValue('Select a sensor…'), { target: { value: 'TAG2' } });
            fireEvent.click(screen.getByText('Create model'));

            expect(onQuickAddModel).toHaveBeenCalledWith(groupA.no, 'New Model', 'individual', 'TAG2', '', '');
            expect(screen.queryByText('Model name')).toBeNull();
        });

        it('calls onQuickAddModel with x/y sensors (and an empty target) for Clustering', () => {
            const onQuickAddModel = vi.fn();
            render(<FailureGroupsPanel {...makeProps({ fgGroups: [notInGroup, groupA], fgModels: [], onQuickAddModel })} />);
            fireEvent.click(screen.getByText('Add model'));
            fireEvent.change(screen.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Cluster Model' } });
            fireEvent.click(screen.getByText('Clustering'));
            const [xSelect, ySelect] = screen.getAllByDisplayValue('Select a sensor…');
            fireEvent.change(xSelect, { target: { value: 'TAG1' } });
            fireEvent.change(ySelect, { target: { value: 'TAG2' } });
            fireEvent.click(screen.getByText('Create model'));

            expect(onQuickAddModel).toHaveBeenCalledWith(groupA.no, 'Cluster Model', 'clustering', '', 'TAG1', 'TAG2');
        });

        it('Cancel closes the modal without calling onQuickAddModel', () => {
            const onQuickAddModel = vi.fn();
            render(<FailureGroupsPanel {...makeProps({ fgModels: [], onQuickAddModel })} />);
            fireEvent.click(screen.getByText('Add model'));
            fireEvent.change(screen.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Discarded' } });
            fireEvent.click(screen.getByText('Cancel'));
            expect(onQuickAddModel).not.toHaveBeenCalled();
            expect(screen.queryByText('Model name')).toBeNull();
        });

        it('Escape closes the modal without calling onQuickAddModel', () => {
            const onQuickAddModel = vi.fn();
            render(<FailureGroupsPanel {...makeProps({ fgModels: [], onQuickAddModel })} />);
            fireEvent.click(screen.getByText('Add model'));
            fireEvent.keyDown(document, { key: 'Escape' });
            expect(onQuickAddModel).not.toHaveBeenCalled();
            expect(screen.queryByText('Model name')).toBeNull();
        });

        it('clicking the backdrop closes the modal; clicking inside the card does not', () => {
            render(<FailureGroupsPanel {...makeProps({ fgModels: [] })} />);
            fireEvent.click(screen.getByText('Add model'));
            fireEvent.click(screen.getByText('Model name')); // inside the card
            expect(screen.getByText('Model name')).toBeTruthy();

            fireEvent.click(document.querySelector('.quick-add-model-backdrop')!);
            expect(screen.queryByText('Model name')).toBeNull();
        });

        it('resets the draft form the next time the modal opens for a different group', () => {
            render(<FailureGroupsPanel {...makeProps({ fgGroups: [notInGroup, groupA, groupB], fgModels: [] })} />);
            const addButtons = screen.getAllByText('Add model');
            fireEvent.click(addButtons[0]);
            fireEvent.change(screen.getByPlaceholderText('e.g. Bearing vibration model'), { target: { value: 'Leftover draft' } });
            fireEvent.click(screen.getByText('Cancel'));

            fireEvent.click(screen.getAllByText('Add model')[1]);
            expect((screen.getByPlaceholderText('e.g. Bearing vibration model') as HTMLInputElement).value).toBe('');
        });
    });
});
