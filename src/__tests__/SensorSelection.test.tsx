import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SensorSelection from '../components/dashboard/SensorSelection';
import type { FailureGroup, FailureModel, SensorMetadata } from '../types';

const sensorMetadata: SensorMetadata[] = [
    { tag: 'TAG1', description: 'Pump Pressure', unit: 'bar', component: 'Pump', alarmH: 90 },
    { tag: 'TAG2', description: 'Pump Temp', unit: 'C', component: 'Pump' },
];

const groupA: FailureGroup = { no: 1, name: 'Group A' };
const modelTag1InGroupA: FailureModel = {
    id: 'm1', groupNos: [1], name: '', kind: 'individual', category: null, notes: '', status: false,
    targetSensor: 'TAG1', predictorSensors: [], xSensor: '', ySensor: '',
    individualChecked: true, rcMode: null, scatterXSensor: '', relModelName: '',
    relStiffness: 100_000, clusterModelName: '', numClusters: 3, criteriaSensor: '',
    clusterRanges: [], filterTimeStart: '', filterTimeEnd: '', pmSensorFilters: [],
};

function makeProps(overrides: Partial<React.ComponentProps<typeof SensorSelection>> = {}) {
    return {
        sensors: ['TAG1', 'TAG2', 'TAG3'],
        selectedSensors: [] as string[],
        onSensorChange: vi.fn(),
        sensorMetadata,
        fgGroups: [{ no: 0, name: 'Not in Group' }, groupA],
        fgModels: [modelTag1InGroupA],
        getGroupColor: () => 'blue',
        onToggleSensorGroupKind: vi.fn(),
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

        it('the selected-count badge uses theme-aware colors, not a hardcoded dark navy (regression: it stayed dark-navy in light theme, clashing with the rest of the panel)', () => {
            render(<SensorSelection {...makeProps({ selectedSensors: ['TAG1'] })} />);
            const badge = screen.getByText('1 sensor selected').closest('div') as HTMLElement;
            expect(badge.style.background).toBe('var(--accent-muted)');
            expect(badge.style.border).toContain('var(--accent-color)');
            expect(badge.style.background).not.toMatch(/#[0-9a-f]{3,6}/i);
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

    // 2026-08-31 redesign: a sensor's membership is now per (group, kind)
    // pair, not just per group — a sensor can carry more than one model
    // kind at once (e.g. both Individual and Relationship). Chips and the
    // group menu's toggle controls were updated accordingly.
    describe('failure-group badge chips', () => {
        it('shows a chip for each group the sensor already belongs to', () => {
            render(<SensorSelection {...makeProps()} />);
            expandPump();
            expect(screen.getByText('Group A')).toBeTruthy();
        });

        it('removing via the chip\'s X calls onToggleSensorGroupKind with the model\'s own kind', () => {
            const onToggleSensorGroupKind = vi.fn();
            render(<SensorSelection {...makeProps({ onToggleSensorGroupKind })} />);
            expandPump();
            fireEvent.click(screen.getByTitle('Remove Individual from Group A'));
            expect(onToggleSensorGroupKind).toHaveBeenCalledWith('TAG1', 1, 'individual');
        });

        it('shows one chip per group when a single model\'s groupNos lists several (2026-08-25: real many-to-many, not a duplicate model per group)', () => {
            const groupB: FailureGroup = { no: 2, name: 'Group B' };
            const sharedModel: FailureModel = { ...modelTag1InGroupA, groupNos: [1, 2] };
            render(<SensorSelection {...makeProps({ fgGroups: [{ no: 0, name: 'Not in Group' }, groupA, groupB], fgModels: [sharedModel] })} />);
            expandPump();
            expect(screen.getByText('Group A')).toBeTruthy();
            expect(screen.getByText('Group B')).toBeTruthy();
        });

        it('shows a separate chip per kind when a sensor carries more than one model kind in the same group', () => {
            const relModel: FailureModel = { ...modelTag1InGroupA, id: 'm2', kind: 'relationship' };
            render(<SensorSelection {...makeProps({ fgModels: [modelTag1InGroupA, relModel] })} />);
            expandPump();
            expect(screen.getByTitle('Remove Individual from Group A')).toBeTruthy();
            expect(screen.getByTitle('Remove Relationship from Group A')).toBeTruthy();
        });

        it('each chip carries a colored kind badge (not just a dim letter), reusing the same .model-kind-icon class Build Model\'s own rows use (2026-08-31: reported by the user as hard to tell apart)', () => {
            render(<SensorSelection {...makeProps()} />);
            expandPump();
            const badge = screen.getByText('I', { selector: '.model-kind-icon' });
            expect(badge.className).toContain('model-kind-icon--individual');
        });
    });

    // 2026-09-02 perf: membership moved from a per-row scan of every model
    // into one memoized index keyed by sensor tag. These two cases pin the
    // identification rules the index has to encode, since getting either
    // wrong would silently show a sensor as belonging to nothing.
    describe('membership index', () => {
        it('matches a Clustering model by its xSensor, not targetSensor', () => {
            const clusteringModel: FailureModel = {
                ...modelTag1InGroupA, id: 'm3', kind: 'clustering', targetSensor: '', xSensor: 'TAG1',
            };
            render(<SensorSelection {...makeProps({ fgModels: [clusteringModel] })} />);
            expandPump();
            expect(screen.getByTitle('Remove Clustering from Group A')).toBeTruthy();
        });

        it('matches sensor tags case-insensitively', () => {
            const lowerCaseModel: FailureModel = { ...modelTag1InGroupA, targetSensor: 'tag1' };
            render(<SensorSelection {...makeProps({ fgModels: [lowerCaseModel] })} />);
            expandPump();
            expect(screen.getByTitle('Remove Individual from Group A')).toBeTruthy();
        });

        it('keeps a sensor that belongs to several groups AND several kinds fully resolved', () => {
            const groupB: FailureGroup = { no: 2, name: 'Group B' };
            const models: FailureModel[] = [
                { ...modelTag1InGroupA, groupNos: [1, 2] },
                { ...modelTag1InGroupA, id: 'm2', kind: 'relationship', groupNos: [2] },
            ];
            render(<SensorSelection {...makeProps({ fgGroups: [{ no: 0, name: 'Not in Group' }, groupA, groupB], fgModels: models })} />);
            expandPump();
            expect(screen.getByTitle('Remove Individual from Group A')).toBeTruthy();
            expect(screen.getByTitle('Remove Individual from Group B')).toBeTruthy();
            expect(screen.getByTitle('Remove Relationship from Group B')).toBeTruthy();
            // …but NOT a relationship membership in Group A, which no model has.
            // "Add …" lives on the menu's toggles, so the menu has to be open.
            fireEvent.click(screen.getAllByTitle('Add to failure group')[0]);
            expect(screen.getByTitle('Add Relationship to Group A')).toBeTruthy();
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

        it('each group row offers a per-kind toggle (Individual/Relationship/Clustering) that adds a kind the sensor is not yet a member of', () => {
            const onToggleSensorGroupKind = vi.fn();
            render(<SensorSelection {...makeProps({ onToggleSensorGroupKind })} />);
            expandPump();
            // Open TAG2's menu — TAG2 is not in Group A at all.
            const folderButtons = screen.getAllByTitle('Add to failure group');
            fireEvent.click(folderButtons[1]);
            fireEvent.click(screen.getByTitle('Add Individual to Group A'));
            expect(onToggleSensorGroupKind).toHaveBeenCalledWith('TAG2', 1, 'individual');
        });

        it('a kind the sensor already belongs to in that group shows a Remove control instead of Add; the other kinds still show Add', () => {
            const onToggleSensorGroupKind = vi.fn();
            render(<SensorSelection {...makeProps({ onToggleSensorGroupKind })} />);
            expandPump();
            fireEvent.click(screen.getAllByTitle('Add to failure group')[0]); // TAG1's own menu — already Individual in Group A
            // Two "Remove Individual from Group A" controls exist at once
            // here — the chip's own X (always visible) and the menu's
            // toggle (visible because the menu happens to be open).
            expect(screen.getAllByTitle('Remove Individual from Group A').length).toBeGreaterThan(0);
            expect(screen.queryByTitle('Add Individual to Group A')).toBeNull();
            expect(screen.getByTitle('Add Relationship to Group A')).toBeTruthy();
            expect(screen.getByTitle('Add Clustering to Group A')).toBeTruthy();

            fireEvent.click(screen.getByTitle('Add Relationship to Group A'));
            expect(onToggleSensorGroupKind).toHaveBeenCalledWith('TAG1', 1, 'relationship');
        });

        it('tints the row background for a group the sensor already belongs to (2026-09-02: helps the active group stand out once there are many groups)', () => {
            render(<SensorSelection {...makeProps()} />);
            expandPump();
            fireEvent.click(screen.getAllByTitle('Add to failure group')[0]); // TAG1 — already a member of Group A
            // "Group A" renders twice while the menu is open: the chip above
            // the menu, and the menu's own row — the row is the later one.
            const occurrences = screen.getAllByText('Group A');
            const menuRow = occurrences[occurrences.length - 1].closest('div') as HTMLElement;
            expect(menuRow.style.background).toBe('var(--fg-tint)');
        });

        it('leaves a group the sensor does not belong to untinted', () => {
            const groupB: FailureGroup = { no: 2, name: 'Group B' };
            render(<SensorSelection {...makeProps({ fgGroups: [{ no: 0, name: 'Not in Group' }, groupA, groupB] })} />);
            expandPump();
            fireEvent.click(screen.getAllByTitle('Add to failure group')[0]); // TAG1 — not in Group B
            const row = screen.getByText('Group B').closest('div') as HTMLElement;
            expect(row.style.background).toBe('');
        });

        it('tints the "Not in Group" row too, once the sensor is a member of it', () => {
            const models = [modelTag1InGroupA, { ...modelTag1InGroupA, id: 'm2', groupNos: [0] }];
            render(<SensorSelection {...makeProps({ fgModels: models })} />);
            expandPump();
            fireEvent.click(screen.getAllByTitle('Add to failure group')[0]); // TAG1 — also a member of group 0
            const occurrences = screen.getAllByText('Not in Group');
            const menuRow = occurrences[occurrences.length - 1].closest('div') as HTMLElement;
            expect(menuRow.style.background).toBe('var(--fg-tint)');
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
            render(<SensorSelection {...makeProps({ fgGroups: [{ no: 0, name: 'Not in Group' }] })} />);
            expandPump();
            fireEvent.click(screen.getAllByTitle('Add to failure group')[0]);
            expect(screen.getByText('No failure groups yet')).toBeTruthy();
        });

        describe('"Not in Group" (FG-0) entry', () => {
            it('is always offered in the menu, even with zero real groups', () => {
                render(<SensorSelection {...makeProps({ fgGroups: [{ no: 0, name: 'Not in Group' }] })} />);
                expandPump();
                fireEvent.click(screen.getAllByTitle('Add to failure group')[0]);
                expect(screen.getByText('Not in Group')).toBeTruthy();
            });

            it('clicking "Add Individual to Not in Group" toggles the sensor into group 0 as Individual', () => {
                const onToggleSensorGroupKind = vi.fn();
                render(<SensorSelection {...makeProps({ onToggleSensorGroupKind })} />);
                expandPump();
                fireEvent.click(screen.getAllByTitle('Add to failure group')[1]); // TAG2, not a member of anything
                fireEvent.click(screen.getByTitle('Add Individual to Not in Group'));
                expect(onToggleSensorGroupKind).toHaveBeenCalledWith('TAG2', 0, 'individual');
            });

            it('once a member of one kind, that kind shows Remove (other kinds still show Add); still no rename/delete', () => {
                const onToggleSensorGroupKind = vi.fn();
                const models = [modelTag1InGroupA, { ...modelTag1InGroupA, id: 'm2', groupNos: [0] }];
                render(<SensorSelection {...makeProps({ fgModels: models, onToggleSensorGroupKind })} />);
                expandPump();
                fireEvent.click(screen.getAllByTitle('Add to failure group')[0]); // TAG1, already Individual member of group 0
                expect(screen.queryByTitle('Rename Not in Group')).toBeNull();
                expect(screen.queryByTitle('Delete Not in Group')).toBeNull();
                expect(screen.getByTitle('Add Relationship to Not in Group')).toBeTruthy();
                // Two "Remove Individual from Not in Group" controls exist at
                // once here — the chip's own X (always visible) and the
                // menu's toggle (visible because the menu happens to be open
                // in this test).
                const removeButtons = screen.getAllByTitle('Remove Individual from Not in Group');
                expect(removeButtons.length).toBeGreaterThan(0);
                fireEvent.click(removeButtons[removeButtons.length - 1]);
                expect(onToggleSensorGroupKind).toHaveBeenCalledWith('TAG1', 0, 'individual');
            });

            it('renders a "Not in Group" chip alongside real-group chips once a sensor is a member', () => {
                const models = [modelTag1InGroupA, { ...modelTag1InGroupA, id: 'm2', groupNos: [0] }];
                render(<SensorSelection {...makeProps({ fgModels: models })} />);
                expandPump();
                expect(screen.getByText('Group A')).toBeTruthy();
                expect(screen.getByText('Not in Group')).toBeTruthy();
            });
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

        it('rejects a duplicate group name (case-insensitive), with an inline error, and does not call onCreateGroupForSensor', () => {
            const onCreateGroupForSensor = vi.fn();
            render(<SensorSelection {...makeProps({ onCreateGroupForSensor })} />);
            expandPump();
            fireEvent.click(screen.getAllByTitle('Add to failure group')[0]);
            const input = screen.getByPlaceholderText('New group name');
            fireEvent.change(input, { target: { value: 'group a' } });
            fireEvent.click(screen.getByText('Create'));
            expect(onCreateGroupForSensor).not.toHaveBeenCalled();
            expect(screen.getByText('A failure group named "group a" already exists')).toBeTruthy();
        });
    });
});
