import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import FailureGroupsPanel from '../components/dashboard/FailureGroupsPanel';
import type { FailureGroup, FailureModel, FailureGroupStateSlice, SensorMetadata } from '../types';
import { computeTrainFingerprint } from '../utils/trainFingerprint';

function makeModel(overrides: Partial<FailureModel> = {}): FailureModel {
    return {
        id: 'm1', groupNos: [1], name: 'Model 1', kind: 'individual', category: null,
        notes: '', status: false,
        targetSensor: 'TAG1', predictorSensors: [], xSensor: '', ySensor: '',
        individualChecked: true, rcMode: null, scatterXSensor: '', relModelName: '',
        relStiffness: 100_000, clusterModelName: '', numClusters: 3, criteriaSensor: '',
        clusterRanges: [], filterTimePeriods: [],
        runningConditionMode: 'workspace', customRunningConditionFilters: [], customRunningConditionCombine: 'and',
        ...overrides,
    };
}

const notInGroup: FailureGroup = { no: 0, name: 'Not in Group' };
const groupA: FailureGroup = { no: 1, name: 'Group A' };
const groupB: FailureGroup = { no: 2, name: 'Group B' };

const sensorMetadata: SensorMetadata[] = [
    { tag: 'TAG1', description: 'Pump Pressure', unit: 'bar', component: 'Pump' },
];

function makeProps(overrides: Partial<React.ComponentProps<typeof FailureGroupsPanel>> = {}) {
    return {
        fgGroups: [notInGroup, groupA],
        fgModels: [makeModel()],
        sensorMetadata,
        runningConditionFg: {},
        datasetHeaders: null,
        getGroupColor: () => 'blue',
        onUpdateGroupDetails: vi.fn(),
        onDeleteGroup: vi.fn(),
        onCreateEmptyGroup: vi.fn(),
        onDeleteModel: vi.fn(),
        onOpenBuildModel: vi.fn(),
        ...overrides,
    };
}

/** Sensor lines are collapsed by default (Feature 4-A) -- opens them all. */
const expandAll = () => {
    document.querySelectorAll('[aria-expanded="false"]').forEach(b => fireEvent.click(b));
};
/** The per-model labels inside the expanded sensor sub-lists (each sits right before its delete button). */
const modelLabels = () => screen.queryAllByTitle('Delete model').map(b => b.previousElementSibling!.textContent);

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
            // one sensor line in Group A and one in Not in Group -- same sensor, listed per group
            expect(screen.getAllByText('Pump Pressure (TAG1)')).toHaveLength(2);
            expect(screen.getByTestId('fg-sensor-row-0:tag1')).toBeTruthy();
        });

        it('has no rename/delete controls (it is a permanent, non-editable bucket)', () => {
            const fgModels = [makeModel({ id: 'm1', groupNos: [0] })];
            render(<FailureGroupsPanel {...makeProps({ fgModels, fgGroups: [notInGroup] })} />);
            expect(screen.queryAllByTitle('Rename group')).toHaveLength(0);
            expect(screen.queryAllByTitle('Delete group')).toHaveLength(0);
        });

        it('does not get an FG-n badge or edit/delete controls counted as a real group — only its own "done / total" row count shows', () => {
            const fgModels = [makeModel({ id: 'm1', groupNos: [0] })];
            render(<FailureGroupsPanel {...makeProps({ fgModels, fgGroups: [notInGroup] })} />);
            expect(screen.queryByText(/^FG-0$/)).toBeNull();
        });
    });

    // 2026-10-02 (Visual refresh Phase 2): the header's old "sensors /
    // models / groups" 3-stat line was replaced by a single "N of M models
    // complete" summary chip, matching the approved prototype's `.selchip`
    // (SPEC FINAL 2026-09-30's locked "search -> summary chip -> group
    // rows" structure) — see FailureGroupsPanel.tsx's render for the chip.
    it('shows a "N of M models complete" summary chip in the header (no completion % anymore — status lives only in Build Model)', () => {
        const fgModels = [makeModel({ id: 'm1', status: true }), makeModel({ id: 'm2', status: false })];
        const { container } = render(<FailureGroupsPanel {...makeProps({ fgModels })} />);
        const chip = container.querySelector('.fg-summary-chip')!;
        expect(chip.textContent?.replace(/\s+/g, ' ').trim()).toBe('1 of 2 models complete');
        expect(chip.querySelector('b')!.textContent).toBe('1');
    });

    it('each group row shows its own "done / total" models-complete count', () => {
        const fgModels = [
            makeModel({ id: 'm1', groupNos: [1], status: true }),
            makeModel({ id: 'm2', groupNos: [1], targetSensor: 'TAG2', status: false }),
        ];
        render(<FailureGroupsPanel {...makeProps({ fgModels })} />);
        const countEl = screen.getByText('FG-1').closest('.fg-row')!.querySelector('.fg-row-count')!;
        expect(countEl.textContent).toBe('1 / 2');
    });

    it('lists every model in the group by name, without any Complete/Incomplete status (removed per user request)', () => {
        // 2026-08-31: the tag is now always appended (see the "shows the
        // model name when one is set" test below), so the visible text is
        // "name (tag)" rather than the bare name.
        const fgModels = [makeModel({ id: 'm1', name: 'Bearing model', status: true }), makeModel({ id: 'm2', name: 'Temp model', status: false })];
        render(<FailureGroupsPanel {...makeProps({ fgModels })} />);
        expect(modelLabels()).toEqual([]); // collapsed: the sensor shows once, not its models
        expandAll();
        expect(modelLabels()).toEqual(['Bearing model (TAG1)', 'Temp model (TAG1)']);
        // 2026-10-02 reskin: the header's status-dot legend has its own
        // static "Complete" label now (unrelated to any per-model text),
        // so this only checks no ADDITIONAL "Complete" text shows up next
        // to a model row — the legend's one instance is expected.
        expect(screen.queryAllByText('Complete')).toHaveLength(1);
        expect(screen.queryByText('Incomplete')).toBeNull();
    });

    it('shows a colored kind badge per model row, so two models of the same sensor in different kinds are told apart at a glance (2026-08-31: reported by the user — this panel showed no kind indicator at all)', () => {
        const fgModels = [
            makeModel({ id: 'm1', kind: 'individual' }),
            makeModel({ id: 'm2', kind: 'relationship', predictorSensors: ['TAG2'] }),
        ];
        render(<FailureGroupsPanel {...makeProps({ fgModels })} />);
        // The collapsed sensor line already carries one chip per kind that
        // exists. 2026-10-02 reskin: badge shell is `.kind-badge` (the
        // Phase 0 class built for this tab) instead of `.model-kind-icon`.
        const individualBadge = screen.getByText('I', { selector: '.kind-badge' });
        const relationshipBadge = screen.getByText('R', { selector: '.kind-badge' });
        expect(screen.queryByText('C', { selector: '.kind-badge' })).toBeNull(); // no Clustering model -> no chip
        expect(individualBadge.className).toContain('kind-badge--individual');
        expect(relationshipBadge.className).toContain('kind-badge--relationship');
    });

    // Phase C of the Build Model Workbench redesign (2026-09-30, SPEC FINAL):
    // a small status dot at the corner of the I/R/C badge — no dot = never
    // trained, blue = Trained (fingerprint fresh, not Complete), green =
    // Complete. Reuses the exact same `isModelTrainedFresh` +
    // `getBuildBlockReason` combination BuildModelWindow.tsx's own dot/pill
    // use, so the two views can never disagree.
    describe('status dot on the I/R/C badge', () => {
        // 2026-10-02 reskin: badge shell is `.kind-badge` now (see "shows a
        // colored kind badge" above) — the dot itself deliberately KEPT its
        // `.f4-kb-dot` class (see FailureGroupsPanel.tsx's renderSensorRow
        // doc comment: a cross-window integration test outside this pass's
        // zone asserts that exact class name).
        const badgeFor = (letter: string) => screen.getByText(letter, { selector: '.kind-badge' });
        const dotOn = (badge: HTMLElement) => badge.querySelector('.f4-kb-dot');

        it('shows no dot when the model has never been trained', () => {
            render(<FailureGroupsPanel {...makeProps({ fgModels: [makeModel({ status: false })] })} />);
            expect(dotOn(badgeFor('I'))).toBeNull();
        });

        it('shows a blue "trained" dot when the model has a fresh trained fingerprint, is not Complete, and is not gate-blocked', () => {
            const runningConditionFg: Partial<FailureGroupStateSlice> = { runningConditionNoneConfirmed: true };
            const model = makeModel({ status: false, category: 'performance', runningConditionMode: 'workspace' });
            const fg = { ...runningConditionFg, models: [model] };
            const trained = {
                ...model,
                lastTrainedAt: '2026-09-30T00:00:00.000Z',
                trainedFingerprint: computeTrainFingerprint(model, fg),
            };
            render(<FailureGroupsPanel {...makeProps({ fgModels: [trained], runningConditionFg, datasetHeaders: null })} />);
            const dot = dotOn(badgeFor('I'));
            expect(dot).not.toBeNull();
            expect(dot!.className).toContain('f4-kb-dot--trained');
        });

        it('shows a green "complete" dot when status is true and there is no train record to be out of date against (a legacy Complete model)', () => {
            render(<FailureGroupsPanel {...makeProps({ fgModels: [makeModel({ status: true })] })} />);
            const dot = dotOn(badgeFor('I'));
            expect(dot).not.toBeNull();
            expect(dot!.className).toContain('f4-kb-dot--complete');
        });

        // 🆕 2026-10-03 (health score phase 3a): the same single definition
        // (`utils/modelStatus.ts`) the Build Model window reads — a Complete
        // model whose inputs no longer match its train record is NOT complete.
        describe('Complete but out of date (inputs changed since it was trained)', () => {
            const rc: Partial<FailureGroupStateSlice> = { runningConditionNoneConfirmed: true };
            const complete = (over: Partial<FailureModel> = {}) => {
                const model = makeModel({ status: true, category: 'performance', ...over });
                return { ...model, lastTrainedAt: '2026-09-30T00:00:00.000Z', trainedFingerprint: computeTrainFingerprint(model, { ...rc, models: [model] }) };
            };

            it('a Complete model with a fresh train record keeps its green dot and counts as complete', () => {
                const { container } = render(<FailureGroupsPanel {...makeProps({ fgModels: [complete()], runningConditionFg: rc })} />);
                expect(dotOn(badgeFor('I'))!.className).toContain('f4-kb-dot--complete');
                expect(container.querySelector('.fg-summary-chip')!.textContent?.replace(/\s+/g, ' ').trim()).toBe('1 of 1 models complete');
            });

            it('status:true but the target sensor changed since training -> no green dot, not counted complete (summary chip and group count)', () => {
                const stale = { ...complete(), targetSensor: 'TAG2' };
                const { container } = render(<FailureGroupsPanel {...makeProps({ fgModels: [stale], runningConditionFg: rc })} />);
                expect(dotOn(badgeFor('I'))).toBeNull();
                expect(container.querySelector('.fg-summary-chip')!.textContent?.replace(/\s+/g, ' ').trim()).toBe('0 of 1 models complete');
                expect(screen.getByText('FG-1').closest('.fg-row')!.querySelector('.fg-row-count')!.textContent).toBe('0 / 1');
            });

            it('the WORKSPACE running condition changing makes a Workspace-mode Complete model stale, but not a Custom-mode one', () => {
                const wsMode = complete({ id: 'a', targetSensor: 'TAG1' });
                const customMode = complete({ id: 'b', targetSensor: 'TAG2', runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true });
                const changedRc: Partial<FailureGroupStateSlice> = { runningConditionNoneConfirmed: true, runningConditionCombine: 'or' };
                const { container } = render(<FailureGroupsPanel {...makeProps({ fgModels: [wsMode, customMode], runningConditionFg: changedRc })} />);
                expect(container.querySelector('.fg-summary-chip')!.textContent?.replace(/\s+/g, ' ').trim()).toBe('1 of 2 models complete');
            });
        });

        it('does NOT show the blue dot for a fingerprint-fresh model that is blocked by an unrelated gate reason (running-condition sensor missing from the dataset) — mirrors BuildModelWindow.tsx\'s Phase B gate-consistency fix', () => {
            const runningConditionFg: Partial<FailureGroupStateSlice> = {
                runningConditionFilters: [{ id: 'c1', sensor: 'TEMP1', operation: 'greater_than', value1: '10', value2: '' }],
                runningConditionCombine: 'and',
            };
            const model = makeModel({ status: false, category: 'performance', runningConditionMode: 'workspace' });
            // computeTrainFingerprint doesn't check header presence (it only
            // cares whether a condition row is filled in), so this fingerprint
            // is genuinely "fresh" by the fingerprint-equality definition even
            // though the sensor is about to be reported missing below.
            const fg = { ...runningConditionFg, models: [model] };
            const trained = {
                ...model,
                lastTrainedAt: '2026-09-30T00:00:00.000Z',
                trainedFingerprint: computeTrainFingerprint(model, fg),
            };
            // TEMP1 (the running-condition sensor) is absent from the dataset headers.
            render(<FailureGroupsPanel {...makeProps({ fgModels: [trained], runningConditionFg, datasetHeaders: ['OTHER_SENSOR'] })} />);
            expect(dotOn(badgeFor('I'))).toBeNull();
        });
    });

    it('a trash icon per model row calls onDeleteModel immediately, with no confirmation dialog (2026-08-31: model deletion now lives entirely on Dashboard, per explicit user request)', () => {
        const onDeleteModel = vi.fn();
        render(<FailureGroupsPanel {...makeProps({ fgModels: [makeModel({ id: 'm1' })], onDeleteModel })} />);
        expect(screen.queryByTitle('Delete model')).toBeNull(); // per-model delete lives inside the expanded sensor line
        expandAll();
        fireEvent.click(screen.getByTitle('Delete model'));
        expect(onDeleteModel).toHaveBeenCalledWith('m1');
    });

    describe('model display label fallback chain', () => {
        it('shows the model name with its target tag appended (2026-08-31: matches Build Model\'s own overview, which always shows the tag too — the user flagged the FG tab as inconsistent for omitting it)', () => {
            render(<FailureGroupsPanel {...makeProps({ fgModels: [makeModel({ name: 'Bearing model', targetSensor: 'TAG1' })] })} />);
            expandAll();
            expect(modelLabels()).toEqual(['Bearing model (TAG1)']);
        });

        it('falls back to "description (tag)" for the target sensor when the model has no name', () => {
            render(<FailureGroupsPanel {...makeProps({ fgModels: [makeModel({ name: '', targetSensor: 'TAG1' })] })} />);
            expandAll();
            expect(modelLabels()).toEqual(['Pump Pressure (TAG1)']);
        });

        it('treats a name identical to its own target tag as unset (legacy-migrated models default name to the tag) and falls back to "description (tag)"', () => {
            render(<FailureGroupsPanel {...makeProps({ fgModels: [makeModel({ name: 'TAG1', targetSensor: 'TAG1' })] })} />);
            expandAll();
            expect(modelLabels()).toEqual(['Pump Pressure (TAG1)']);
            expect(screen.queryByText('TAG1')).toBeNull();
        });

        it('falls back to the raw sensor tag when no name and no metadata description is available', () => {
            render(<FailureGroupsPanel {...makeProps({ fgModels: [makeModel({ name: '', targetSensor: 'TAG9' })] })} />);
            expandAll();
            expect(modelLabels()).toEqual(['TAG9']);
        });

        it('uses the Y sensor (not the target) for a clustering model, matching component derivation elsewhere', () => {
            const model = makeModel({ name: '', kind: 'clustering', targetSensor: '', xSensor: 'TAG9', ySensor: 'TAG1' });
            render(<FailureGroupsPanel {...makeProps({ fgModels: [model] })} />);
            expandAll();
            expect(modelLabels()).toEqual(['Pump Pressure (TAG1)']); // model row labelled by Y; the sensor LINE is X (TAG9)
            expect(screen.getByTestId('fg-sensor-row-1:tag9')).toBeTruthy();
        });

        it('falls back to the X sensor\'s "description (tag)" for a fresh clustering model whose Y is still unset (2026-09-01 fix — the row used to show the bare name with no tag at all here, unlike Individual/Relationship, reported by the user: "i/r เหมือนกัน แต่ c ไม่เหมือนกัน")', () => {
            const model = makeModel({ name: '', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: '' });
            render(<FailureGroupsPanel {...makeProps({ fgModels: [model] })} />);
            expandAll();
            expect(modelLabels()).toEqual(['Pump Pressure (TAG1)']);
        });

        it('falls back to "Untitled model" for a model with no name and no sensor picked yet', () => {
            render(<FailureGroupsPanel {...makeProps({ fgModels: [makeModel({ name: '', targetSensor: '' })] })} />);
            expandAll();
            expect(modelLabels()).toEqual(['Untitled model']);
        });
    });

    describe('one collapsible line per sensor (Feature 4-A, 2026-09-24)', () => {
        it('Individual + Relationship + Clustering of the same sensor are ONE line with a mini chip per existing kind', () => {
            const fgModels = [
                makeModel({ id: 'i', kind: 'individual' }),
                makeModel({ id: 'r', kind: 'relationship', predictorSensors: ['TAG2'] }),
                makeModel({ id: 'c', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2' }), // keyed by X
            ];
            render(<FailureGroupsPanel {...makeProps({ fgModels })} />);
            expect(screen.getAllByTestId(/^fg-sensor-row-/)).toHaveLength(1);
            expect(screen.getByText('I', { selector: '.kind-badge' })).toBeTruthy();
            expect(screen.getByText('R', { selector: '.kind-badge' })).toBeTruthy();
            expect(screen.getByText('C', { selector: '.kind-badge' })).toBeTruthy();
        });

        it('different sensors are different lines; a sensor in two groups appears in each', () => {
            const fgModels = [
                makeModel({ id: 'a', targetSensor: 'TAG1', groupNos: [1, 2] }),
                makeModel({ id: 'b', targetSensor: 'TAG2', groupNos: [1] }),
            ];
            render(<FailureGroupsPanel {...makeProps({ fgGroups: [notInGroup, groupA, groupB], fgModels })} />);
            expect(screen.getByTestId('fg-sensor-row-1:tag1')).toBeTruthy();
            expect(screen.getByTestId('fg-sensor-row-1:tag2')).toBeTruthy();
            expect(screen.getByTestId('fg-sensor-row-2:tag1')).toBeTruthy();
        });

        it('deleting one model of a sensor removes only that model, leaving its siblings', () => {
            const onDeleteModel = vi.fn();
            const fgModels = [makeModel({ id: 'i', kind: 'individual' }), makeModel({ id: 'r', kind: 'relationship', predictorSensors: ['TAG2'] })];
            render(<FailureGroupsPanel {...makeProps({ fgModels, onDeleteModel })} />);
            expandAll();
            fireEvent.click(screen.getAllByTitle('Delete model')[1]);
            expect(onDeleteModel).toHaveBeenCalledTimes(1);
            expect(onDeleteModel).toHaveBeenCalledWith('r');
        });

        it('has NO category control (category is set on the Build Model sensor header)', () => {
            render(<FailureGroupsPanel {...makeProps({ fgModels: [makeModel({ category: 'performance' })] })} />);
            expandAll();
            expect(screen.queryByText('Performance')).toBeNull();
            expect(screen.queryByText('Condition')).toBeNull();
        });

        it('a long sensor label is a single-line ellipsis', () => {
            render(<FailureGroupsPanel {...makeProps()} />);
            const line = screen.getByText('Pump Pressure (TAG1)');
            expect(line.style.whiteSpace).toBe('nowrap');
            expect(line.style.textOverflow).toBe('ellipsis');
        });

        // 2026-10-02 (Visual refresh Phase 2): unit badge next to the
        // sensor row's name, matching the Sensor tab's own convention
        // (`.unit-badge`, SPEC FINAL 2026-09-30: "ป้ายหน่วยอยู่ติดท้ายชื่อ
        // sensor").
        it('shows the sensor\'s unit as a badge next to the row label', () => {
            render(<FailureGroupsPanel {...makeProps()} />);
            expect(screen.getByText('bar', { selector: '.unit-badge' })).toBeTruthy();
        });

        it('shows no unit badge when the sensor has no metadata', () => {
            render(<FailureGroupsPanel {...makeProps({ fgModels: [makeModel({ name: '', targetSensor: 'TAG9' })] })} />);
            expect(screen.queryByText('bar', { selector: '.unit-badge' })).toBeNull();
        });
    });

    // 2026-10-02 (Visual refresh Phase 2, SPEC FINAL 2026-09-30): the
    // locked structural rule for this tab opens with a search box, same as
    // the Sensor tab's own ("tab Failure Groups ใช้โครงเดียวกับ tab
    // Sensors ... ค้นหา -> ชิปสรุป -> แถวกลุ่ม..."). Display/filter only.
    describe('search box', () => {
        const fgModels = [
            makeModel({ id: 'm1', groupNos: [1], targetSensor: 'TAG1' }),
            makeModel({ id: 'm2', groupNos: [2], targetSensor: 'TAG2', name: '' }),
        ];
        const sensorMetadata: SensorMetadata[] = [
            { tag: 'TAG1', description: 'Pump Pressure', unit: 'bar', component: 'Pump' },
            { tag: 'TAG2', description: 'Motor Temperature', unit: 'C', component: 'Motor' },
        ];

        it('a sensor-text match keeps only that sensor\'s group, hiding the other', () => {
            render(<FailureGroupsPanel {...makeProps({ fgGroups: [notInGroup, groupA, groupB], fgModels, sensorMetadata })} />);
            fireEvent.change(screen.getByPlaceholderText('Search groups or sensors...'), { target: { value: 'motor' } });
            expect(screen.queryByText('Group A')).toBeNull();
            expect(screen.getByText('Group B')).toBeTruthy();
            expect(screen.getByText('Motor Temperature (TAG2)')).toBeTruthy();
        });

        it('a group-NAME match keeps every sensor in that group', () => {
            render(<FailureGroupsPanel {...makeProps({ fgGroups: [notInGroup, groupA, groupB], fgModels, sensorMetadata })} />);
            fireEvent.change(screen.getByPlaceholderText('Search groups or sensors...'), { target: { value: 'group a' } });
            expect(screen.getByText('Group A')).toBeTruthy();
            expect(screen.getByText('Pump Pressure (TAG1)')).toBeTruthy();
            expect(screen.queryByText('Group B')).toBeNull();
        });

        it('clearing the search restores every group and sensor', () => {
            render(<FailureGroupsPanel {...makeProps({ fgGroups: [notInGroup, groupA, groupB], fgModels, sensorMetadata })} />);
            const input = screen.getByPlaceholderText('Search groups or sensors...');
            fireEvent.change(input, { target: { value: 'motor' } });
            fireEvent.change(input, { target: { value: '' } });
            expect(screen.getByText('Group A')).toBeTruthy();
            expect(screen.getByText('Group B')).toBeTruthy();
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

    it('the bottom "Build Model →" button opens the Build Model window (2026-10-02 reskin: label gained a trailing arrow, matching the approved prototype)', () => {
        const onOpenBuildModel = vi.fn();
        render(<FailureGroupsPanel {...makeProps({ onOpenBuildModel })} />);
        fireEvent.click(screen.getByText('Build Model →'));
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
