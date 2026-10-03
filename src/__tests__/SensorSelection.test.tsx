import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import SensorSelection from '../components/dashboard/SensorSelection';
import type { FailureGroup, FailureModel, SensorMetadata } from '../types';

afterEach(() => {
    cleanup();
    // AnchoredPopover (via Portal) appends a shared container straight to
    // document.body that outlives the component tree — see Portal.test.tsx's
    // own identical cleanup for why this matters across tests.
    document.getElementById('wizard-portal-root')?.remove();
});

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
    clusterRanges: [], filterTimePeriods: [],
    runningConditionMode: 'workspace', customRunningConditionFilters: [], customRunningConditionCombine: 'and',
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

    // Visual refresh (2026-10-02): the component header's counter reads
    // "selected / total" (e.g. "2 / 8") once at least one sensor in that
    // component is on the chart — not an "N on chart" label, per the
    // locked SPEC FINAL decision. With nothing selected (the test above)
    // it still reads as a bare total — matching the approved prototype's
    // own counter, which hides the "0 / " prefix.
    it('once a sensor is selected, the component counter reads "selected / total"', () => {
        render(<SensorSelection {...makeProps({ selectedSensors: ['TAG1'] })} />);
        // "1" (selected) bolded, " / 2" (total) — getByText matches the
        // whole element's normalized text content, so look at the
        // `.component-group-count` element itself rather than a bare "1".
        const counts = document.querySelectorAll('.component-group-count');
        const pumpCount = Array.from(counts).find(el => el.textContent === '1 / 2');
        expect(pumpCount).toBeTruthy();
        expect(pumpCount?.querySelector('b')?.textContent).toBe('1');
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

        it('the selected-count badge uses the design-token CSS variables, not hardcoded colors', () => {
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

        // Visual refresh (2026-10-02): this popover now renders through
        // `AnchoredPopover`/`Portal` instead of expanding inline within the
        // scrolling sensor list, so it can't be clipped by the list's own
        // overflow — see docs/PROJECT_HANDOVER.md's 2026-09-30 SPEC FINAL
        // entry ("popover ทุกตัว ... ต้องเรนเดอร์ผ่าน portal").
        it('renders outside the scrolling sensor list (via Portal), not nested inside it', () => {
            const { container } = render(<SensorSelection {...makeProps()} />);
            expandPump();
            fireEvent.click(screen.getByTitle('Alarm setpoints'));
            const listEl = container.querySelector('.sensor-list-widget') as HTMLElement;
            expect(listEl.querySelector('.sensor-popover')).toBeNull();
            const portalRoot = document.getElementById('wizard-portal-root');
            expect(portalRoot?.querySelector('.sensor-popover')).not.toBeNull();
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

    // 2026-09-03 perf: membership moved from a per-row scan of every model
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
            // The chips show only memberships that exist; the sheet's empty
            // Relationship cell for Group A is the "not a member" side of it.
            expect(screen.queryByTitle('Remove Relationship from Group A')).toBeNull();
            fireEvent.click(screen.getAllByTitle('Add to failure group')[0]);
            expect(screen.getByRole('button', { name: 'Relationship · Group A' }).getAttribute('aria-pressed')).toBe('false');
            expect(screen.getByRole('button', { name: 'Relationship · Group B' }).getAttribute('aria-pressed')).toBe('true');
        });
    });

    // Visual refresh (2026-10-02): the unit sits right after the sensor's
    // name as a `.unit-badge` (inline, not right-aligned at the row's far
    // edge) — a locked SPEC FINAL decision.
    it('shows the sensor unit as a .unit-badge right after its name', () => {
        render(<SensorSelection {...makeProps()} />);
        expandPump();
        const badge = screen.getByText('bar'); // TAG1's unit
        expect(badge.className).toContain('unit-badge');
    });

    // 2026-10-03: the old AnchoredPopover "Add to failure group" menu was
    // replaced by a full-height sheet docked to the Sensors panel's left edge
    // (FailureGroupAssignSheet). Its own matrix / rename / delete / create
    // behaviour is covered in FailureGroupAssignSheet.test.tsx; these cover the
    // seam with the sensor list: open, switch, step, and what dismisses it.
    describe('the Failure Group Assignment sheet (opened from a row\'s 📁)', () => {
        const sheet = () => screen.queryByTestId('fg-sheet');
        const folder = () => screen.getAllByTitle('Add to failure group');
        const heading = () => within(sheet()!).getByText(/Pump (Pressure|Temp)|TAG3/, { selector: '.fg-sheet-sensor' }).textContent;

        it('opens via the 📁 button and via right-click, for THAT sensor', () => {
            render(<SensorSelection {...makeProps()} />);
            expandPump();
            fireEvent.click(folder()[0]);
            expect(sheet()).not.toBeNull();
            expect(heading()).toBe('Pump Pressure');
            fireEvent.click(folder()[0]); // toggle closed
            expect(sheet()).toBeNull();

            // Right-click directly on TAG2's own 📁 button.
            fireEvent.contextMenu(folder()[1]);
            expect(heading()).toBe('Pump Temp');
        });

        it('renders outside the scrolling sensor list and outside the panel (via Portal), not nested inside it', () => {
            const { container } = render(<SensorSelection {...makeProps()} />);
            expandPump();
            fireEvent.click(folder()[0]);
            expect(container.contains(sheet())).toBe(false);
            expect(document.getElementById('wizard-portal-root')!.contains(sheet())).toBe(true);
        });

        it('highlights the row being edited (and only that one) and marks its 📁 as on', () => {
            const { container } = render(<SensorSelection {...makeProps()} />);
            expandPump();
            fireEvent.click(folder()[1]); // TAG2
            const targets = container.querySelectorAll('.sensor-list-row--fg-target');
            expect(targets).toHaveLength(1);
            expect(targets[0].textContent).toContain('Pump Temp');
            expect(folder()[1].classList.contains('on')).toBe(true);
            expect(folder()[0].classList.contains('on')).toBe(false);
        });

        it('chips on the highlighted row follow the matrix live (a prop change shows up without reopening)', () => {
            const props = makeProps({ fgModels: [] });
            const { rerender } = render(<SensorSelection {...props} />);
            expandPump();
            fireEvent.click(folder()[0]);
            expect(screen.queryByTitle('Remove Individual from Group A')).toBeNull();
            rerender(<SensorSelection {...props} fgModels={[modelTag1InGroupA]} />);
            expect(screen.getByTitle('Remove Individual from Group A')).toBeTruthy();
            expect(sheet()).not.toBeNull();
        });

        it('clicking ANOTHER sensor\'s 📁 switches the sheet to it (one sheet, no close/reopen)', () => {
            render(<SensorSelection {...makeProps()} />);
            expandPump();
            fireEvent.click(folder()[0]);
            fireEvent.click(folder()[1]);
            expect(screen.getAllByTestId('fg-sheet')).toHaveLength(1);
            expect(heading()).toBe('Pump Temp');
        });

        describe('what does NOT dismiss it', () => {
            it('clicking inside the Sensors panel — the search box, a row, a component header, a checkbox', () => {
                const onSensorChange = vi.fn();
                render(<SensorSelection {...makeProps({ onSensorChange })} />);
                expandPump();
                fireEvent.click(folder()[0]);
                fireEvent.mouseDown(screen.getByPlaceholderText('Search sensors...'));
                fireEvent.mouseDown(screen.getByText('Pump Temp'));
                fireEvent.mouseDown(screen.getByText('Uncategorized'));
                fireEvent.mouseDown(screen.getByRole('checkbox', { name: /Pump Pressure/ }));
                expect(sheet()).not.toBeNull();
            });

            it('clicking inside the sheet itself, or inside an element marked data-fg-sheet-keep (the Undo toast)', () => {
                render(<SensorSelection {...makeProps()} />);
                expandPump();
                fireEvent.click(folder()[0]);
                fireEvent.mouseDown(within(sheet()!).getByText('Failure groups'));
                const keep = document.createElement('div');
                keep.setAttribute('data-fg-sheet-keep', 'true');
                document.body.appendChild(keep);
                fireEvent.mouseDown(keep);
                keep.remove();
                expect(sheet()).not.toBeNull();
            });

            it('scrolling the sensor list (the old popover closed on every scroll; the sheet re-measures its arrow instead)', () => {
                const { container } = render(<SensorSelection {...makeProps()} />);
                expandPump();
                fireEvent.click(folder()[0]);
                fireEvent.scroll(container.querySelector('.sensor-list-widget')!);
                fireEvent(window, new Event('resize'));
                expect(sheet()).not.toBeNull();
            });

            it('a click on a row selects/deselects the sensor as usual and keeps the sheet open', () => {
                const onSensorChange = vi.fn();
                render(<SensorSelection {...makeProps({ onSensorChange })} />);
                expandPump();
                fireEvent.click(folder()[0]);
                fireEvent.click(screen.getByText('Pump Temp'));
                expect(onSensorChange).toHaveBeenCalledWith(['TAG2']);
                expect(sheet()).not.toBeNull();
            });
        });

        describe('what dismisses it', () => {
            it('Esc', () => {
                render(<SensorSelection {...makeProps()} />);
                expandPump();
                fireEvent.click(folder()[0]);
                fireEvent.keyDown(document, { key: 'Escape' });
                expect(sheet()).toBeNull();
            });

            it('a click outside the panel and the sheet — e.g. on the chart', () => {
                const chart = document.createElement('div');
                chart.setAttribute('data-testid', 'fake-chart');
                document.body.appendChild(chart);
                render(<SensorSelection {...makeProps()} />);
                expandPump();
                fireEvent.click(folder()[0]);
                fireEvent.mouseDown(chart);
                expect(sheet()).toBeNull();
                // …and ONE click on the 📁 reopens it (the open state was reset, not left toggled).
                fireEvent.click(folder()[0]);
                expect(sheet()).not.toBeNull();
                chart.remove();
            });

            it('its own ✕ and Done buttons', () => {
                render(<SensorSelection {...makeProps()} />);
                expandPump();
                fireEvent.click(folder()[0]);
                fireEvent.click(within(sheet()!).getByRole('button', { name: 'Close' }));
                expect(sheet()).toBeNull();
                fireEvent.click(folder()[0]);
                fireEvent.click(within(sheet()!).getByRole('button', { name: 'Done' }));
                expect(sheet()).toBeNull();
            });

            it('typing in the sensor search box', () => {
                render(<SensorSelection {...makeProps()} />);
                expandPump();
                fireEvent.click(folder()[0]);
                fireEvent.change(screen.getByPlaceholderText('Search sensors...'), { target: { value: 'Pump' } });
                expect(sheet()).toBeNull();
            });

            it('collapsing the component of the sensor it is open for (its row is gone — nothing to point at)', () => {
                render(<SensorSelection {...makeProps()} />);
                expandPump();
                fireEvent.click(folder()[0]);
                fireEvent.click(screen.getByText('Pump')); // collapse
                expect(sheet()).toBeNull();
                // Re-expanding does not resurrect it.
                fireEvent.click(screen.getByText('Pump'));
                expect(sheet()).toBeNull();
            });

            it('its sensor leaving the list altogether (e.g. a deleted special sensor)', () => {
                const props = makeProps();
                const { rerender } = render(<SensorSelection {...props} />);
                expandPump();
                fireEvent.click(folder()[1]); // TAG2
                rerender(<SensorSelection {...props} sensors={['TAG1', 'TAG3']} />);
                expect(sheet()).toBeNull();
            });

            it('opening the alarm-setpoints popover (one panel at a time) — and vice versa', () => {
                render(<SensorSelection {...makeProps()} />);
                expandPump();
                fireEvent.click(folder()[0]);
                fireEvent.click(screen.getByTitle('Alarm setpoints'));
                expect(sheet()).toBeNull();
                expect(screen.getByText('High (90)')).toBeTruthy();
                fireEvent.click(folder()[0]);
                expect(sheet()).not.toBeNull();
                expect(screen.queryByText('High (90)')).toBeNull();
            });
        });

        describe('‹ › step through EVERY sensor, expanding components on demand', () => {
            // Display order: Pump (TAG1, TAG2), then Uncategorized (TAG3).
            const prev = () => within(sheet()!).getByRole('button', { name: 'Previous sensor' }) as HTMLButtonElement;
            const next = () => within(sheet()!).getByRole('button', { name: 'Next sensor' }) as HTMLButtonElement;

            it('walks forward and back across components and disables the buttons at both ends', () => {
                render(<SensorSelection {...makeProps()} />);
                expandPump();
                fireEvent.click(folder()[0]);
                expect(prev().disabled).toBe(true);
                expect(next().disabled).toBe(false);
                fireEvent.click(next());
                expect(heading()).toBe('Pump Temp');
                expect(prev().disabled).toBe(false);
            });

            it('expands a collapsed component to reach the next sensor, highlights its row, and can walk back', () => {
                const { container } = render(<SensorSelection {...makeProps()} />);
                expandPump();
                fireEvent.click(folder()[1]); // TAG2 — last of Pump, next is in the collapsed "Uncategorized"
                expect(screen.queryByLabelText('TAG3')).toBeNull();
                fireEvent.click(next());
                expect(screen.getByLabelText('TAG3')).toBeTruthy(); // expanded on demand
                expect(heading()).toBe('TAG3');
                expect(sheet()).not.toBeNull(); // the visibility effect did not close it
                const target = container.querySelector('.sensor-list-row--fg-target');
                expect(target?.textContent).toContain('TAG3');
                expect(next().disabled).toBe(true); // last sensor overall
                fireEvent.click(prev());
                expect(heading()).toBe('Pump Temp');
            });

            it('works while the sensor search is filtering the list: clears the search so the target row exists', () => {
                render(<SensorSelection {...makeProps()} />);
                fireEvent.change(screen.getByPlaceholderText('Search sensors...'), { target: { value: 'Pressure' } });
                fireEvent.click(folder()[0]); // TAG1 — the only match
                expect(heading()).toBe('Pump Pressure');
                fireEvent.click(next());
                expect((screen.getByPlaceholderText('Search sensors...') as HTMLInputElement).value).toBe('');
                expect(heading()).toBe('Pump Temp');
                expect(sheet()).not.toBeNull();
            });

            it('scrolls the target row into view once it has rendered', () => {
                const scrollIntoView = vi.fn();
                const original = Element.prototype.scrollIntoView;
                Element.prototype.scrollIntoView = scrollIntoView;
                try {
                    render(<SensorSelection {...makeProps()} />);
                    expandPump();
                    fireEvent.click(folder()[1]);
                    fireEvent.click(next());
                    expect(scrollIntoView).toHaveBeenCalled();
                } finally {
                    Element.prototype.scrollIntoView = original;
                }
            });
        });

        describe('placement is measured from the Sensors panel (jsdom has no layout, so rects are stubbed)', () => {
            const rect = (left: number, top: number, width: number, height: number) =>
                ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} }) as DOMRect;
            const original = Element.prototype.getBoundingClientRect;
            let rectFor: (el: Element) => DOMRect | null = () => null;
            beforeEach(() => {
                Element.prototype.getBoundingClientRect = function (this: Element) { return rectFor(this) ?? original.call(this); };
            });
            afterEach(() => { Element.prototype.getBoundingClientRect = original; });

            const isPanel = (el: Element) => el.classList.contains('sensor-selection-widget');
            const isList = (el: Element) => el.classList.contains('sensor-list-widget');

            it('docks to the panel\'s left edge, full panel height, 560px wide when there is room', () => {
                rectFor = (el) => (isPanel(el) ? rect(900, 40, 350, 700) : null);
                render(<SensorSelection {...makeProps()} />);
                expandPump();
                fireEvent.click(folder()[0]);
                const s = sheet()!;
                expect(s.style.width).toBe('560px');
                expect(s.style.left).toBe('330px'); // 900 - 10px gap - 560px
                expect(s.style.top).toBe('40px');
                expect(s.style.height).toBe('700px');
            });

            it('shrinks on a narrow window (never below 340px) instead of running off the left edge', () => {
                rectFor = (el) => (isPanel(el) ? rect(420, 40, 350, 700) : null);
                render(<SensorSelection {...makeProps()} />);
                expandPump();
                fireEvent.click(folder()[0]);
                expect(sheet()!.style.width).toBe('402px'); // 420 - 10 gap - 8 edge
                expect(sheet()!.style.left).toBe('8px');
                cleanup();
                document.getElementById('wizard-portal-root')?.remove();
                rectFor = (el) => (isPanel(el) ? rect(300, 40, 350, 700) : null);
                render(<SensorSelection {...makeProps()} />);
                expandPump();
                fireEvent.click(folder()[0]);
                expect(sheet()!.style.width).toBe('340px'); // floor
                expect(sheet()!.style.left).toBe('8px');
            });

            it('re-measures when the panel is resized (window resize here; ResizeObserver covers the split.js gutter)', () => {
                let panelLeft = 900;
                rectFor = (el) => (isPanel(el) ? rect(panelLeft, 40, 350, 700) : null);
                render(<SensorSelection {...makeProps()} />);
                expandPump();
                fireEvent.click(folder()[0]);
                expect(sheet()!.style.left).toBe('330px');
                panelLeft = 700;
                fireEvent(window, new Event('resize'));
                expect(sheet()!.style.left).toBe('130px');
            });

            it('the arrow points at the edited row, follows it when the list scrolls, and hides when the row scrolls out of view', () => {
                let rowTop = 200;
                rectFor = (el) => {
                    if (isPanel(el)) return rect(900, 40, 350, 700);
                    if (isList(el)) return rect(900, 120, 350, 600); // 120..720
                    if (el.getAttribute('data-fg-target') === 'true') return rect(900, rowTop, 350, 40);
                    return null;
                };
                const { container } = render(<SensorSelection {...makeProps()} />);
                expandPump();
                fireEvent.click(folder()[0]);
                // row centre 220 -> relative to the sheet's top (40) = 180, minus half the 12px arrow.
                expect(screen.getByTestId('fg-sheet-notch').style.top).toBe('174px');
                rowTop = 300;
                fireEvent.scroll(container.querySelector('.sensor-list-widget')!);
                expect(screen.getByTestId('fg-sheet-notch').style.top).toBe('274px');
                rowTop = 900; // scrolled below the list's visible area
                fireEvent.scroll(container.querySelector('.sensor-list-widget')!);
                expect(screen.queryByTestId('fg-sheet-notch')).toBeNull();
                expect(sheet()).not.toBeNull();
            });
        });
    });
});
