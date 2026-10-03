/**
 * FailureGroupAssignSheet (2026-10-03) — the full-height "Failure Group
 * Assignment" sheet that replaced the old add-to-failure-group popover.
 * Rendered directly here (the seam with the sensor list — open / switch / step /
 * dismiss / placement — is covered in SensorSelection.test.tsx).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react';
import FailureGroupAssignSheet, { type FailureGroupAssignSheetProps } from '../components/dashboard/FailureGroupAssignSheet';
// @ts-expect-error - @types/node is not installed; vitest runs in Node so this resolves at runtime
import { readFileSync } from 'node:fs';
import type { FailureGroup, FailureModel } from '../types';

afterEach(() => {
    cleanup();
    document.getElementById('wizard-portal-root')?.remove();
    vi.useRealTimers();
});

const NONE: FailureGroup = { no: 0, name: 'Not in Group' };
const groups: FailureGroup[] = [
    NONE,
    { no: 1, name: 'Group A' },
    { no: 2, name: 'Group B' },
    { no: 3, name: 'Group C' },
];

const model = (o: Partial<FailureModel>): FailureModel => ({
    id: 'm', groupNos: [1], name: '', kind: 'individual', category: null, notes: '', status: false,
    targetSensor: 'TAG1', predictorSensors: [], xSensor: '', ySensor: '',
    individualChecked: true, rcMode: null, scatterXSensor: '', relModelName: '',
    relStiffness: 100_000, clusterModelName: '', numClusters: 3, criteriaSensor: '',
    clusterRanges: [], filterTimePeriods: [],
    runningConditionMode: 'workspace', customRunningConditionFilters: [], customRunningConditionCombine: 'and',
    ...o,
});

// TAG1: Individual in A, Relationship in A+B.  TAG2 (another sensor): Individual in C.
const defaultModels: FailureModel[] = [
    model({ id: 'i1', kind: 'individual', groupNos: [1] }),
    model({ id: 'r1', kind: 'relationship', groupNos: [1, 2] }),
    model({ id: 'i2', kind: 'individual', groupNos: [3], targetSensor: 'TAG2' }),
];

function makeProps(overrides: Partial<FailureGroupAssignSheetProps> = {}): FailureGroupAssignSheetProps {
    return {
        tag: 'TAG1',
        sensorLabel: 'Pump Pressure',
        unit: 'bar',
        fgGroups: groups,
        fgModels: defaultModels,
        getGroupColor: () => 'blue',
        onToggleSensorGroupKind: vi.fn(),
        onCreateGroupForSensor: vi.fn(),
        onRenameGroup: vi.fn(),
        onDeleteGroup: vi.fn(),
        canStepPrev: true,
        canStepNext: true,
        onStep: vi.fn(),
        onClose: vi.fn(),
        getHostEl: () => null,
        getRowEl: () => null,
        getListEl: () => null,
        ...overrides,
    };
}

function renderSheet(overrides: Partial<FailureGroupAssignSheetProps> = {}) {
    const props = makeProps(overrides);
    const utils = render(<FailureGroupAssignSheet {...props} />);
    return { props, ...utils };
}

const cell = (kind: string, group: string) => screen.getByRole('button', { name: `${kind} · ${group}` });
const pressed = (kind: string, group: string) => cell(kind, group).getAttribute('aria-pressed') === 'true';
const row = (no: number) => screen.getByTestId(`fg-sheet-row-${no}`);
/** Group names in the order the rows appear (Not in Group excluded). */
const rowOrder = () =>
    Array.from(document.querySelectorAll<HTMLElement>('.fg-sheet-list > .fg-sheet-row .fg-sheet-gname')).map(e => e.textContent);
const sectionLabels = () => Array.from(document.querySelectorAll('.fg-sheet-sec')).map(e => e.textContent);

describe('FailureGroupAssignSheet', () => {
    describe('header', () => {
        it('names the sensor, its tag and unit', () => {
            renderSheet();
            const dialog = screen.getByRole('dialog', { name: 'Failure groups for Pump Pressure' });
            expect(within(dialog).getByText('Pump Pressure')).toBeTruthy();
            expect(within(dialog).getByText('TAG1 · bar')).toBeTruthy();
        });

        it('the ‹ › buttons call onStep(-1)/onStep(1) and honour canStepPrev/canStepNext', () => {
            const { props } = renderSheet({ canStepPrev: false });
            const prev = screen.getByRole('button', { name: 'Previous sensor' }) as HTMLButtonElement;
            const next = screen.getByRole('button', { name: 'Next sensor' }) as HTMLButtonElement;
            expect(prev.disabled).toBe(true);
            fireEvent.click(next);
            expect(props.onStep).toHaveBeenCalledWith(1);
            cleanup();
            const second = renderSheet({ canStepNext: false });
            expect((screen.getByRole('button', { name: 'Next sensor' }) as HTMLButtonElement).disabled).toBe(true);
            fireEvent.click(screen.getByRole('button', { name: 'Previous sensor' }));
            expect(second.props.onStep).toHaveBeenCalledWith(-1);
        });
    });

    describe('the matrix', () => {
        it('has a column per kind and a row per group, with Not in Group present', () => {
            renderSheet();
            for (const g of ['Group A', 'Group B', 'Group C', 'Not in Group']) {
                for (const k of ['Individual', 'Relationship', 'Clustering']) expect(cell(k, g)).toBeTruthy();
            }
        });

        it('an empty cell is an empty (unpressed) box; a member cell is pressed and shows the check', () => {
            renderSheet();
            expect(pressed('Individual', 'Group A')).toBe(true);
            expect(cell('Individual', 'Group A').classList.contains('is-on')).toBe(true);
            expect(cell('Individual', 'Group A').querySelector('svg')).not.toBeNull();
            expect(pressed('Individual', 'Group B')).toBe(false);
            expect(cell('Individual', 'Group B').classList.contains('is-on')).toBe(false);
            // Clustering: this sensor has no clustering model at all.
            expect(pressed('Clustering', 'Group A')).toBe(false);
        });

        it('each kind column carries its own colour class (hover colour for an empty cell, fill for a selected one)', () => {
            renderSheet();
            expect(cell('Individual', 'Group B').classList.contains('fg-sheet-cell--individual')).toBe(true);
            expect(cell('Relationship', 'Group B').classList.contains('fg-sheet-cell--relationship')).toBe(true);
            expect(cell('Clustering', 'Group B').classList.contains('fg-sheet-cell--clustering')).toBe(true);
            const css: string = readFileSync('src/App.css', 'utf-8');
            expect(css).toMatch(/\.fg-sheet-cell--individual\s*\{\s*--cc:\s*var\(--ki\)/);
            expect(css).toMatch(/\.fg-sheet-cell--relationship\s*\{\s*--cc:\s*var\(--kr\)/);
            expect(css).toMatch(/\.fg-sheet-cell--clustering\s*\{\s*--cc:\s*var\(--kc\)/);
            expect(css).toMatch(/\.fg-sheet-cell\.is-on\s*\{[^}]*background:\s*var\(--cc\)/);
        });

        it('column headers show how many groups each kind is in, or "none"', () => {
            renderSheet();
            const header = (kind: string) => document.querySelector(`.fg-sheet-ch[data-kind="${kind}"] small`)!.textContent;
            expect(header('individual')).toBe('1 group');
            expect(header('relationship')).toBe('2 groups');
            expect(header('clustering')).toBe('none');
        });

        it('the column header row is sticky and Not in Group is pinned to the bottom (CSS contract)', () => {
            renderSheet();
            const css: string = readFileSync('src/App.css', 'utf-8');
            expect(css).toMatch(/\.fg-sheet-colh\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0/);
            expect(css).toMatch(/\.fg-sheet-none\s*\{[^}]*position:\s*sticky;[^}]*bottom:\s*0/);
            // …and in the DOM Not in Group sits after every real group, inside the pinned wrapper.
            const pinned = document.querySelector('.fg-sheet-none')!;
            expect(pinned.contains(row(0))).toBe(true);
            expect(pinned.compareDocumentPosition(row(3)) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
        });

        it('clicking a cell calls onToggleSensorGroupKind(tag, groupNo, kind) — for real groups and for Not in Group (0)', () => {
            const { props } = renderSheet();
            fireEvent.click(cell('Clustering', 'Group B'));
            expect(props.onToggleSensorGroupKind).toHaveBeenCalledWith('TAG1', 2, 'clustering');
            fireEvent.click(cell('Individual', 'Not in Group'));
            expect(props.onToggleSensorGroupKind).toHaveBeenCalledWith('TAG1', 0, 'individual');
        });

        it('matches the sensor case-/whitespace-insensitively, like Dashboard\'s own toggle does', () => {
            renderSheet({ fgModels: [model({ id: 'x', targetSensor: ' tag1 ', groupNos: [2] })] });
            expect(pressed('Individual', 'Group B')).toBe(true);
        });

        it('a Clustering model is found by its X sensor', () => {
            renderSheet({ fgModels: [model({ id: 'c', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', groupNos: [3] })] });
            expect(pressed('Clustering', 'Group C')).toBe(true);
        });

        it('the cell that removes a model\'s LAST group says so in its tooltip (the model is deleted — with a 7-second Undo); other removals do not', () => {
            renderSheet();
            // Individual is only in Group A -> removing it deletes the model.
            expect(cell('Individual', 'Group A').title).toMatch(/this deletes the sensor's Individual model/);
            expect(cell('Individual', 'Group A').title).toMatch(/undo for 7 seconds/);
            expect(cell('Individual', 'Group A').getAttribute('data-last')).toBe('true');
            // Relationship is in A and B -> removing one of them is a plain removal.
            expect(cell('Relationship', 'Group A').title).toBe('Remove Relationship from Group A');
            expect(cell('Relationship', 'Group A').getAttribute('data-last')).toBeNull();
            // An empty cell offers to add.
            expect(cell('Individual', 'Group B').title).toBe('Add Individual to Group B');
        });
    });

    describe('"Assigned" bucket and the All | Assigned switch', () => {
        it('puts the groups this sensor is in under "Assigned", the rest under "Other groups"', () => {
            renderSheet();
            expect(sectionLabels()).toEqual(['Assigned', 'Other groups']);
            expect(rowOrder()).toEqual(['Group A', 'Group B', 'Group C']);
            // Group B holds only the Relationship model -> still "assigned".
            expect(row(2).classList.contains('fg-sheet-row--in')).toBe(true);
            expect(row(3).classList.contains('fg-sheet-row--in')).toBe(false);
        });

        it('with nothing assigned the single section is "All groups"', () => {
            renderSheet({ fgModels: [] });
            expect(sectionLabels()).toEqual(['All groups']);
        });

        it('rows do NOT jump when a cell is toggled: the bucket is decided when the sheet opens', () => {
            const props = makeProps();
            const { rerender } = render(<FailureGroupAssignSheet {...props} />);
            expect(rowOrder()).toEqual(['Group A', 'Group B', 'Group C']);
            // The sensor is added to Group C (was "other") and removed from Group A (was "assigned").
            const changed = [
                model({ id: 'i1', kind: 'individual', groupNos: [3] }),
                model({ id: 'r1', kind: 'relationship', groupNos: [2] }),
            ];
            rerender(<FailureGroupAssignSheet {...props} fgModels={changed} />);
            expect(rowOrder()).toEqual(['Group A', 'Group B', 'Group C']); // same order, same sections
            expect(sectionLabels()).toEqual(['Assigned', 'Other groups']);
            // …only the highlight moved with the data: A lost its bar, C gained one.
            expect(row(1).classList.contains('fg-sheet-row--in')).toBe(false);
            expect(row(3).classList.contains('fg-sheet-row--in')).toBe(true);
            expect(pressed('Individual', 'Group C')).toBe(true);
            expect(pressed('Individual', 'Group A')).toBe(false);
        });

        it('the switch shows All N | Assigned N (N = groups the sensor is in right now), and Assigned hides the others', () => {
            renderSheet();
            const all = screen.getByRole('button', { name: /^All/ });
            const assigned = screen.getByRole('button', { name: /^Assigned/ });
            expect(all.textContent).toContain('3');
            expect(assigned.textContent).toContain('2'); // A and B
            fireEvent.click(assigned);
            expect(assigned.getAttribute('aria-pressed')).toBe('true');
            expect(rowOrder()).toEqual(['Group A', 'Group B']); // Group C is hidden
            fireEvent.click(all);
            expect(rowOrder()).toEqual(['Group A', 'Group B', 'Group C']);
        });

        it('in the Assigned view a group assigned AFTER opening shows up, and an unassigned one that was there at open stays put', () => {
            const props = makeProps();
            const { rerender } = render(<FailureGroupAssignSheet {...props} />);
            fireEvent.click(screen.getByRole('button', { name: /^Assigned/ }));
            rerender(<FailureGroupAssignSheet {...props} fgModels={[
                model({ id: 'i1', kind: 'individual', groupNos: [1, 3] }),
                model({ id: 'r1', kind: 'relationship', groupNos: [] }),
            ]} />);
            expect(rowOrder()).toEqual(['Group A', 'Group B', 'Group C']); // B stays (was assigned at open); C joins
        });

        it('Not in Group stays at the bottom in either view', () => {
            renderSheet();
            fireEvent.click(screen.getByRole('button', { name: /^Assigned/ }));
            expect(row(0)).toBeTruthy();
        });
    });

    describe('search', () => {
        it('filters rows by group name (and by FG-number), keeping Not in Group pinned', () => {
            renderSheet();
            fireEvent.change(screen.getByLabelText('Search failure groups'), { target: { value: 'group c' } });
            expect(rowOrder()).toEqual(['Group C']);
            expect(row(0)).toBeTruthy();
            fireEvent.change(screen.getByLabelText('Search failure groups'), { target: { value: 'fg-2' } });
            expect(rowOrder()).toEqual(['Group B']);
        });

        it('says so when nothing matches', () => {
            renderSheet();
            fireEvent.change(screen.getByLabelText('Search failure groups'), { target: { value: 'zzz' } });
            expect(screen.getByText('No groups match “zzz”')).toBeTruthy();
            expect(row(0)).toBeTruthy(); // Not in Group is still there
        });

        it('says "No failure groups yet" when there are no groups at all', () => {
            renderSheet({ fgGroups: [NONE], fgModels: [] });
            expect(screen.getByText('No failure groups yet')).toBeTruthy();
            expect(cell('Individual', 'Not in Group')).toBeTruthy();
        });
    });

    describe('rename (⋯ -> Rename)', () => {
        const openRename = (name = 'Group A') => {
            fireEvent.click(screen.getByRole('button', { name: `Group actions: ${name}` }));
            fireEvent.click(screen.getByRole('button', { name: /Rename/ }));
            return screen.getByLabelText('Group name') as HTMLInputElement;
        };

        it('the ⋯ button replaces the three cells of THAT row with Rename / Delete… and has a Back button', () => {
            renderSheet();
            fireEvent.click(screen.getByRole('button', { name: 'Group actions: Group A' }));
            expect(within(row(1)).getByRole('button', { name: /Rename/ })).toBeTruthy();
            expect(within(row(1)).getByRole('button', { name: /Delete…/ })).toBeTruthy();
            expect(within(row(1)).queryByRole('button', { name: 'Individual · Group A' })).toBeNull();
            // Other rows keep their cells.
            expect(cell('Individual', 'Group B')).toBeTruthy();
            fireEvent.click(within(row(1)).getByRole('button', { name: 'Back' }));
            expect(cell('Individual', 'Group A')).toBeTruthy();
        });

        it('Not in Group has no ⋯ (it can be neither renamed nor deleted)', () => {
            renderSheet();
            expect(within(row(0)).queryByRole('button', { name: /Group actions/ })).toBeNull();
        });

        it('Enter saves the new name through onRenameGroup', () => {
            const { props } = renderSheet();
            const input = openRename();
            expect(input.value).toBe('Group A');
            fireEvent.change(input, { target: { value: 'Renamed' } });
            fireEvent.keyDown(input, { key: 'Enter' });
            expect(props.onRenameGroup).toHaveBeenCalledWith(1, 'Renamed');
            expect(screen.queryByLabelText('Group name')).toBeNull();
        });

        it('the ✓ button saves too', () => {
            const { props } = renderSheet();
            const input = openRename();
            fireEvent.change(input, { target: { value: 'Via button' } });
            fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
            expect(props.onRenameGroup).toHaveBeenCalledWith(1, 'Via button');
        });

        it('Esc cancels the rename WITHOUT closing the sheet; a second Esc closes it', () => {
            const { props } = renderSheet();
            const input = openRename();
            fireEvent.change(input, { target: { value: 'Nope' } });
            fireEvent.keyDown(input, { key: 'Escape' });
            expect(screen.queryByLabelText('Group name')).toBeNull();
            expect(props.onRenameGroup).not.toHaveBeenCalled();
            expect(props.onClose).not.toHaveBeenCalled();
            fireEvent.keyDown(document, { key: 'Escape' });
            expect(props.onClose).toHaveBeenCalledTimes(1);
        });

        it('rejects a duplicate name (case-insensitive) with an inline error and does not call onRenameGroup', () => {
            const { props } = renderSheet();
            const input = openRename();
            fireEvent.change(input, { target: { value: 'group b' } });
            fireEvent.keyDown(input, { key: 'Enter' });
            expect(props.onRenameGroup).not.toHaveBeenCalled();
            expect(screen.getByRole('alert').textContent).toBe('A failure group named "group b" already exists');
            // Still editing; typing clears the error.
            fireEvent.change(input, { target: { value: 'Unique' } });
            expect(screen.queryByRole('alert')).toBeNull();
        });

        it('an unchanged or empty name just ends the edit', () => {
            const { props } = renderSheet();
            let input = openRename();
            fireEvent.keyDown(input, { key: 'Enter' });
            expect(screen.queryByLabelText('Group name')).toBeNull();
            input = openRename();
            fireEvent.change(input, { target: { value: '   ' } });
            fireEvent.keyDown(input, { key: 'Enter' });
            expect(props.onRenameGroup).not.toHaveBeenCalled();
        });
    });

    describe('delete (⋯ -> Delete…) needs an inline confirm that says how many models lose the group', () => {
        const openDelete = (name: string) => {
            fireEvent.click(screen.getByRole('button', { name: `Group actions: ${name}` }));
            fireEvent.click(screen.getByRole('button', { name: /Delete…/ }));
        };

        it('shows the confirm with the workspace-wide model count (plural)', () => {
            const { props } = renderSheet();
            openDelete('Group A'); // i1 + r1 are in Group A
            const confirm = screen.getByRole('alertdialog', { name: 'Delete Group A' });
            expect(confirm.textContent).toContain('Delete Group A for every sensor? 2 models lose this group.');
            expect(props.onDeleteGroup).not.toHaveBeenCalled();
        });

        it('singular, and zero', () => {
            renderSheet();
            openDelete('Group C'); // only TAG2's individual
            expect(screen.getByRole('alertdialog').textContent).toContain('1 model lose this group.');
            fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
            cleanup();
            renderSheet({ fgModels: [] });
            openDelete('Group C');
            expect(screen.getByRole('alertdialog').textContent).toContain('0 models lose this group.');
        });

        it('Delete calls onDeleteGroup(no); once the Dashboard drops the group its row is gone and the Assigned bucket forgets it', () => {
            const props = makeProps();
            const { rerender } = render(<FailureGroupAssignSheet {...props} />);
            openDelete('Group A');
            fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
            expect(props.onDeleteGroup).toHaveBeenCalledWith(1);
            expect(screen.queryByRole('alertdialog')).toBeNull();
            // The Dashboard's deleteGroup strips the group from every model and removes it.
            rerender(<FailureGroupAssignSheet {...props}
                fgGroups={groups.filter(g => g.no !== 1)}
                fgModels={[
                    model({ id: 'i1', kind: 'individual', groupNos: [0] }),
                    model({ id: 'r1', kind: 'relationship', groupNos: [2] }),
                    defaultModels[2],
                ]}
            />);
            expect(rowOrder()).toEqual(['Group B', 'Group C']);
            expect(sectionLabels()).toEqual(['Assigned', 'Other groups']);
            expect(document.querySelectorAll('.fg-sheet-sec + .fg-sheet-row').length).toBe(2);
        });

        it('opening the confirm scrolls its (now taller) row to the centre, so it cannot hide under the pinned Not in Group bar', () => {
            const scrollIntoView = vi.fn();
            const original = Element.prototype.scrollIntoView;
            Element.prototype.scrollIntoView = scrollIntoView;
            try {
                renderSheet();
                openDelete('Group B');
                expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
                expect(scrollIntoView.mock.contexts[0]).toBe(row(2));
            } finally {
                Element.prototype.scrollIntoView = original;
            }
        });

        it('Cancel and Esc dismiss the confirm without deleting (Esc does not close the sheet)', () => {
            const { props } = renderSheet();
            openDelete('Group A');
            fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
            expect(props.onDeleteGroup).not.toHaveBeenCalled();
            expect(screen.queryByRole('alertdialog')).toBeNull();
            openDelete('Group B');
            fireEvent.keyDown(document, { key: 'Escape' });
            expect(screen.queryByRole('alertdialog')).toBeNull();
            expect(props.onClose).not.toHaveBeenCalled();
            expect(props.onDeleteGroup).not.toHaveBeenCalled();
        });

        it('Esc with a row menu open closes the menu first, then the sheet', () => {
            const { props } = renderSheet();
            fireEvent.click(screen.getByRole('button', { name: 'Group actions: Group A' }));
            fireEvent.keyDown(document, { key: 'Escape' });
            expect(screen.queryByRole('button', { name: /Delete…/ })).toBeNull();
            expect(props.onClose).not.toHaveBeenCalled();
            fireEvent.keyDown(document, { key: 'Escape' });
            expect(props.onClose).toHaveBeenCalledTimes(1);
        });
    });

    describe('create a group at the bottom', () => {
        const input = () => screen.getByLabelText('New failure group name') as HTMLInputElement;
        const createBtn = () => screen.getByRole('button', { name: /Create/ }) as HTMLButtonElement;

        it('Create is disabled until something is typed, then calls onCreateGroupForSensor(tag, name)', () => {
            const { props } = renderSheet();
            expect(createBtn().disabled).toBe(true);
            fireEvent.change(input(), { target: { value: '  Seal leak ' } });
            expect(createBtn().disabled).toBe(false);
            fireEvent.click(createBtn());
            expect(props.onCreateGroupForSensor).toHaveBeenCalledWith('TAG1', 'Seal leak');
            expect(input().value).toBe('');
        });

        it('Enter commits too', () => {
            const { props } = renderSheet();
            fireEvent.change(input(), { target: { value: 'Via Enter' } });
            fireEvent.keyDown(input(), { key: 'Enter' });
            expect(props.onCreateGroupForSensor).toHaveBeenCalledWith('TAG1', 'Via Enter');
        });

        it('rejects a duplicate name (case-insensitive) with an inline error', () => {
            const { props } = renderSheet();
            fireEvent.change(input(), { target: { value: 'group a' } });
            fireEvent.click(createBtn());
            expect(props.onCreateGroupForSensor).not.toHaveBeenCalled();
            expect(screen.getByRole('alert').textContent).toBe('A failure group named "group a" already exists');
        });

        it('once the Dashboard adds the group, it appears under Assigned, flashes, is scrolled into view, and the flash ends', () => {
            vi.useFakeTimers();
            const scrollIntoView = vi.fn();
            const original = Element.prototype.scrollIntoView;
            Element.prototype.scrollIntoView = scrollIntoView;
            try {
                const props = makeProps();
                const { rerender } = render(<FailureGroupAssignSheet {...props} />);
                fireEvent.change(input(), { target: { value: 'Seal leak' } });
                fireEvent.click(createBtn());
                // The Dashboard's createGroupForSensor adds the group AND this sensor's Individual model to it.
                const created: FailureGroup = { no: 4, name: 'Seal leak' };
                rerender(<FailureGroupAssignSheet {...props}
                    fgGroups={[...groups, created]}
                    fgModels={[...defaultModels, model({ id: 'i-new', kind: 'individual', groupNos: [1, 4] })].filter(m => m.id !== 'i1')}
                />);
                expect(rowOrder()).toEqual(['Group A', 'Group B', 'Seal leak', 'Group C']); // joined the Assigned bucket (end of it)
                expect(row(4).classList.contains('fg-sheet-row--flash')).toBe(true);
                expect(scrollIntoView).toHaveBeenCalled();
                expect(pressed('Individual', 'Seal leak')).toBe(true); // the auto-assigned Individual model
                act(() => { vi.advanceTimersByTime(1400); });
                expect(row(4).classList.contains('fg-sheet-row--flash')).toBe(false);
            } finally {
                Element.prototype.scrollIntoView = original;
            }
        });

        it('creating resets the search and the Assigned view so the new row is visible', () => {
            renderSheet();
            fireEvent.change(screen.getByLabelText('Search failure groups'), { target: { value: 'zzz' } });
            fireEvent.click(screen.getByRole('button', { name: /^Assigned/ }));
            fireEvent.change(input(), { target: { value: 'Brand new' } });
            fireEvent.click(createBtn());
            expect((screen.getByLabelText('Search failure groups') as HTMLInputElement).value).toBe('');
            expect(screen.getByRole('button', { name: /^All/ }).getAttribute('aria-pressed')).toBe('true');
        });
    });

    describe('closing', () => {
        it('Esc, ✕ and Done call onClose', () => {
            const { props } = renderSheet();
            fireEvent.keyDown(document, { key: 'Escape' });
            fireEvent.click(screen.getByRole('button', { name: 'Close' }));
            fireEvent.click(screen.getByRole('button', { name: 'Done' }));
            expect(props.onClose).toHaveBeenCalledTimes(3);
        });

        it('a mousedown outside the sheet and outside the host panel closes it; inside the host panel does not', () => {
            const host = document.createElement('div');
            const inside = document.createElement('button');
            host.appendChild(inside);
            const outside = document.createElement('div');
            document.body.append(host, outside);
            try {
                const { props } = renderSheet({ getHostEl: () => host });
                fireEvent.mouseDown(inside);
                expect(props.onClose).not.toHaveBeenCalled();
                fireEvent.mouseDown(outside);
                expect(props.onClose).toHaveBeenCalledTimes(1);
            } finally {
                host.remove(); outside.remove();
            }
        });

        it('stops listening once unmounted (no stale handler answering for a closed sheet)', () => {
            const { props, unmount } = renderSheet();
            unmount();
            fireEvent.keyDown(document, { key: 'Escape' });
            fireEvent.mouseDown(document.body);
            expect(props.onClose).not.toHaveBeenCalled();
        });
    });

    describe('switching sensors resets the sheet like opening it fresh', () => {
        it('a new tag recomputes the Assigned bucket and clears search / view / open menus', () => {
            const props = makeProps();
            const { rerender } = render(<FailureGroupAssignSheet {...props} />);
            fireEvent.change(screen.getByLabelText('Search failure groups'), { target: { value: 'group' } });
            fireEvent.click(screen.getByRole('button', { name: /^Assigned/ }));
            fireEvent.click(screen.getByRole('button', { name: 'Group actions: Group A' }));
            rerender(<FailureGroupAssignSheet {...props} tag="TAG2" sensorLabel="Pump Temp" unit="C" />);
            expect(screen.getByText('Pump Temp')).toBeTruthy();
            expect((screen.getByLabelText('Search failure groups') as HTMLInputElement).value).toBe('');
            expect(screen.getByRole('button', { name: /^All/ }).getAttribute('aria-pressed')).toBe('true');
            expect(screen.queryByRole('button', { name: /Delete…/ })).toBeNull();
            // TAG2 is only in Group C -> that is its Assigned bucket.
            expect(sectionLabels()).toEqual(['Assigned', 'Other groups']);
            expect(rowOrder()).toEqual(['Group C', 'Group A', 'Group B']);
            expect(pressed('Individual', 'Group C')).toBe(true);
        });
    });

    describe('does not use the old popover chrome', () => {
        it('is not a .sensor-popover (that class carries a 420px max-height and padding that would clip a full-height sheet)', () => {
            renderSheet();
            expect(document.querySelector('.sensor-popover')).toBeNull();
            expect(screen.getByTestId('fg-sheet').classList.contains('popover-surface')).toBe(true);
        });
    });

    describe('every class it renders is defined in App.css (jsdom never loads the stylesheet)', () => {
        let css = '';
        beforeEach(() => { css = readFileSync('src/App.css', 'utf-8').replace(/\/\*[\s\S]*?\*\//g, ''); });

        it('covers the base state, a row menu, a rename, a delete confirm and a create error', () => {
            renderSheet();
            fireEvent.change(screen.getByLabelText('New failure group name'), { target: { value: 'group a' } });
            fireEvent.click(screen.getByRole('button', { name: /Create/ }));
            fireEvent.click(screen.getByRole('button', { name: 'Group actions: Group B' }));
            fireEvent.click(screen.getByRole('button', { name: /Delete…/ }));
            const classes = new Set<string>();
            document.querySelectorAll('.fg-sheet, .fg-sheet *').forEach(el => el.classList.forEach(c => classes.add(c)));
            const missing = [...classes].filter(c => c.startsWith('fg-sheet') && !new RegExp(`\\.${c}(?![\\w-])`).test(css));
            expect(missing).toEqual([]);
            // Classes shared with the rest of the Dashboard exist too.
            for (const c of ['kind-badge--individual', 'row-action-btn', 'fg-group-dot', 'sensor-row-tag', 'popover-surface']) {
                expect(css).toMatch(new RegExp(`\\.${c}(?![\\w-])`));
            }
        });
    });
});
