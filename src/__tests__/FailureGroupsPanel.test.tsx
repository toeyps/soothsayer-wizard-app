import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import FailureGroupsPanel from '../components/dashboard/FailureGroupsPanel';
import type { FailureGroup, FailureModel, SensorMetadata } from '../types';

function makeModel(overrides: Partial<FailureModel> = {}): FailureModel {
    return {
        id: 'm1', groupNos: [1], name: 'Model 1', kind: 'individual', category: null,
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
        sensorMetadata,
        getGroupColor: () => 'blue',
        onUpdateGroupDetails: vi.fn(),
        onDeleteGroup: vi.fn(),
        onCreateEmptyGroup: vi.fn(),
        onDeleteModel: vi.fn(),
        onOpenBuildModel: vi.fn(),
        ...overrides,
    };
}

describe('FailureGroupsPanel', () => {
    it('shows the empty state when there are no real groups', () => {
        render(<FailureGroupsPanel {...makeProps({ fgGroups: [notInGroup], fgModels: [] })} />);
        expect(screen.getByText('No failure groups yet')).toBeTruthy();
    });

    it('renders the "Not in Group" card even with no models yet, same as a real group (2026-08-31: it used to hide until it held a model, which meant there was never a way to add the first one)', () => {
        render(<FailureGroupsPanel {...makeProps()} />);
        expect(screen.getByText('Not in Group')).toBeTruthy();
        expect(screen.getByText('Group A')).toBeTruthy();
    });

    it('shows no "Add model" button anywhere in the panel (2026-08-31: removed per explicit user request — "เอาปุ่ม add model ออกเลย ผมบังคับให้ add จากหน้า dashboard เท่านั้น" — model creation is forced through Build Model\'s own window only)', () => {
        render(<FailureGroupsPanel {...makeProps({ fgGroups: [notInGroup, groupA, groupB], fgModels: [] })} />);
        expect(screen.queryByText('Add model')).toBeNull();
        expect(screen.queryByText('Model name')).toBeNull();
    });

    describe('"Not in Group" card (group 0)', () => {
        it('renders once a model has groupNo 0, listed by its display label', () => {
            const fgModels = [makeModel({ id: 'm1' }), makeModel({ id: 'm2', groupNos: [0], name: '', targetSensor: 'TAG1' })];
            render(<FailureGroupsPanel {...makeProps({ fgModels })} />);
            expect(screen.getByText('Not in Group')).toBeTruthy();
            expect(screen.getByText('Pump Pressure (TAG1)')).toBeTruthy();
        });

        it('has no rename/delete controls (it is a permanent, non-editable bucket)', () => {
            const fgModels = [makeModel({ id: 'm1', groupNos: [0] })];
            render(<FailureGroupsPanel {...makeProps({ fgModels, fgGroups: [notInGroup] })} />);
            expect(screen.queryAllByTitle('Rename group')).toHaveLength(0);
            expect(screen.queryAllByTitle('Delete group')).toHaveLength(0);
        });

        it('does not count toward the "groups" stat (it is not a real failure group)', () => {
            const fgModels = [makeModel({ id: 'm1', groupNos: [0] })];
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
        // 2026-08-31: the tag is now always appended (see the "shows the
        // model name when one is set" test below), so the visible text is
        // "name (tag)" rather than the bare name.
        const fgModels = [makeModel({ id: 'm1', name: 'Bearing model', status: true }), makeModel({ id: 'm2', name: 'Temp model', status: false })];
        render(<FailureGroupsPanel {...makeProps({ fgModels })} />);
        expect(screen.getByText('Bearing model (TAG1)')).toBeTruthy();
        expect(screen.getByText('Temp model (TAG1)')).toBeTruthy();
        expect(screen.queryByText('Complete')).toBeNull();
        expect(screen.queryByText('Incomplete')).toBeNull();
    });

    it('a trash icon per model row calls onDeleteModel immediately, with no confirmation dialog (2026-08-31: model deletion now lives entirely on Dashboard, per explicit user request)', () => {
        const onDeleteModel = vi.fn();
        render(<FailureGroupsPanel {...makeProps({ fgModels: [makeModel({ id: 'm1' })], onDeleteModel })} />);
        fireEvent.click(screen.getByTitle('Delete model'));
        expect(onDeleteModel).toHaveBeenCalledWith('m1');
    });

    describe('model display label fallback chain', () => {
        it('shows the model name with its target tag appended (2026-08-31: matches Build Model\'s own overview, which always shows the tag too — the user flagged the FG tab as inconsistent for omitting it)', () => {
            render(<FailureGroupsPanel {...makeProps({ fgModels: [makeModel({ name: 'Bearing model', targetSensor: 'TAG1' })] })} />);
            expect(screen.getByText('Bearing model (TAG1)')).toBeTruthy();
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
        // 2026-08-31: the "Not in Group" card now also always renders, so
        // an empty workspace shows "No models yet" twice (Group A + Not in
        // Group) rather than once.
        render(<FailureGroupsPanel {...makeProps({ fgModels: [] })} />);
        expect(screen.getAllByText('No models yet')).toHaveLength(2);
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

    // 2026-08-31: this "Edit details" panel (Name + Description +
    // Recommendation together) moved here from Build Model window
    // entirely, per explicit user request ("ส่วนของ edit detail ต้องอยู่
    // ที่ dashboard ด้วย") — not duplicated between the two. Name isn't
    // independently editable from the rest, mirroring Build Model's own
    // reasoning: "the name should only be editable together with the rest
    // of the detail, not separate from it".
    describe('editing group details ("Edit details" panel)', () => {
        it('the group name is plain text, not independently clickable-to-rename', () => {
            render(<FailureGroupsPanel {...makeProps()} />);
            fireEvent.click(screen.getByText('Group A'));
            expect(screen.queryByDisplayValue('Group A')).toBeNull();
        });

        it('"Edit details" reveals Name + Description + Recommendation together, seeded from the group', () => {
            render(<FailureGroupsPanel {...makeProps({ fgGroups: [notInGroup, { ...groupA, description: 'Bearing wear', recommendation: 'Replace bearing' }] })} />);
            fireEvent.click(screen.getByText('Edit details'));
            expect(screen.getByDisplayValue('Group A')).toBeTruthy();
            expect(screen.getByDisplayValue('Bearing wear')).toBeTruthy();
            expect(screen.getByDisplayValue('Replace bearing')).toBeTruthy();
        });

        it('debounces a combined save of name/description/recommendation', async () => {
            vi.useFakeTimers();
            const onUpdateGroupDetails = vi.fn();
            render(<FailureGroupsPanel {...makeProps({ onUpdateGroupDetails })} />);
            fireEvent.click(screen.getByText('Edit details'));

            fireEvent.change(screen.getByDisplayValue('Group A'), { target: { value: 'Renamed Group' } });
            fireEvent.change(screen.getByPlaceholderText('What failure mode does this group track?'), { target: { value: 'Bearing wear' } });
            await act(async () => { await vi.advanceTimersByTimeAsync(250); });

            expect(onUpdateGroupDetails).toHaveBeenCalledWith(1, 'Renamed Group', 'Bearing wear', '');
            vi.useRealTimers();
        });

        it('rejects renaming to a name already used by another group, with an inline error', async () => {
            vi.useFakeTimers();
            const onUpdateGroupDetails = vi.fn();
            render(<FailureGroupsPanel {...makeProps({ fgGroups: [notInGroup, groupA, groupB], onUpdateGroupDetails })} />);
            fireEvent.click(screen.getAllByText('Edit details')[0]);

            fireEvent.change(screen.getByDisplayValue('Group A'), { target: { value: 'group b' } });
            await act(async () => { await vi.advanceTimersByTimeAsync(250); });

            expect(onUpdateGroupDetails).not.toHaveBeenCalled();
            expect(screen.getByText('A failure group named "group b" already exists')).toBeTruthy();
            vi.useRealTimers();
        });

        it('allows renaming a group to its own current name unchanged', async () => {
            vi.useFakeTimers();
            const onUpdateGroupDetails = vi.fn();
            render(<FailureGroupsPanel {...makeProps({ onUpdateGroupDetails })} />);
            fireEvent.click(screen.getByText('Edit details'));
            fireEvent.change(screen.getByPlaceholderText('What failure mode does this group track?'), { target: { value: 'x' } });
            await act(async () => { await vi.advanceTimersByTimeAsync(250); });
            expect(onUpdateGroupDetails).toHaveBeenCalledWith(1, 'Group A', 'x', '');
            vi.useRealTimers();
        });

        it('"Hide details" collapses the panel', () => {
            render(<FailureGroupsPanel {...makeProps()} />);
            fireEvent.click(screen.getByText('Edit details'));
            expect(screen.getByPlaceholderText('What failure mode does this group track?')).toBeTruthy();

            fireEvent.click(screen.getByText('Hide details'));
            expect(screen.queryByPlaceholderText('What failure mode does this group track?')).toBeNull();
        });

        it('does not open Build Model Overview when clicking "Edit details"', () => {
            const onOpenBuildModel = vi.fn();
            render(<FailureGroupsPanel {...makeProps({ onOpenBuildModel })} />);
            fireEvent.click(screen.getByText('Edit details'));
            expect(onOpenBuildModel).not.toHaveBeenCalled();
        });
    });

    describe('deleting a group', () => {
        it('calls onDeleteGroup immediately on click, with no confirmation dialog (2026-08-31: no confirmations anywhere in the app, per explicit user request)', () => {
            const onDeleteGroup = vi.fn();
            render(<FailureGroupsPanel {...makeProps({ onDeleteGroup })} />);
            fireEvent.click(screen.getByTitle('Delete group'));
            expect(onDeleteGroup).toHaveBeenCalledWith(1);
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
});
