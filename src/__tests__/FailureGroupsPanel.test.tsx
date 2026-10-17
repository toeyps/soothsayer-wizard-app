import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import FailureGroupsPanel from '../components/dashboard/FailureGroupsPanel';
import * as fgSummary from '../utils/failureGroupSummary';

// Pass-through spy: lets the memo test count how often the summary is computed.
vi.mock('../utils/failureGroupSummary', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/failureGroupSummary')>();
    return { ...actual, summarizeFailureGroups: vi.fn(actual.summarizeFailureGroups) };
});
import type { FailureGroup, FailureModel, FailureGroupStateSlice, SensorMetadata } from '../types';
import { computeTrainFingerprint } from '../utils/trainFingerprint';
import { snapshotTrainedFormulas } from '../utils/specialSensorSignature';
import { ALL_TIME_TRAIN } from './helpers/trainTestFixture';

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

/** Sensor lines are collapsed by default -- opens them all. */
const expandAll = () => {
    document.querySelectorAll('[aria-expanded="false"]').forEach(b => fireEvent.click(b));
};
/** The per-model labels inside the expanded sensor sub-lists (each sits right before its delete button). */
const modelLabels = () => screen.queryAllByTitle('Delete model').map(b => b.previousElementSibling!.textContent);

describe('FailureGroupsPanel', () => {
    it('shows the "No failure groups yet" landing callout when there are no real groups (customer batch 2026-10, item 5)', () => {
        render(<FailureGroupsPanel {...makeProps({ fgGroups: [notInGroup], fgModels: [] })} />);
        const callout = screen.getByTestId('fg-callout');
        expect(callout.textContent).toContain('No failure groups yet.');
        expect(callout.textContent).toContain('Failure groups come first: create one below, then assign the sensors that show it.');
        // said once — the old bottom "No failure groups yet" line is gone
        expect(screen.getAllByText(/No failure groups yet/)).toHaveLength(1);
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
            expect(screen.getAllByText('Pump Pressure', { selector: '.sl-desc' })).toHaveLength(2);
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

    // The header shows one summary chip — see FailureGroupsPanel.tsx's
    // render for the chip.
    it('shows "N groups · M sensors assigned · x of y models complete" in the header chip (customer batch 2026-10, item 5)', () => {
        const fgModels = [makeModel({ id: 'm1', status: true }), makeModel({ id: 'm2', status: false })];
        const { container } = render(<FailureGroupsPanel {...makeProps({ fgModels })} />);
        const chip = container.querySelector('.fg-summary-chip')!;
        expect(chip.textContent?.replace(/\s+/g, ' ').trim()).toBe('1 group · 1 sensor assigned · 1 of 2 models complete');
        expect([...chip.querySelectorAll('b')].map(b => b.textContent)).toEqual(['1', '1', '1']);
    });

    it('the summary counts each sensor once across groups and kinds, and leaves "Not in Group"-only sensors out', () => {
        const fgModels = [
            makeModel({ id: 'a', groupNos: [1, 2], targetSensor: 'TAG1' }),
            makeModel({ id: 'b', groupNos: [2], kind: 'relationship', targetSensor: 'TAG1' }),
            makeModel({ id: 'c', groupNos: [2], targetSensor: 'TAG2' }),
            makeModel({ id: 'd', groupNos: [0], targetSensor: 'TAG3' }),
        ];
        render(<FailureGroupsPanel {...makeProps({ fgGroups: [notInGroup, groupA, groupB], fgModels })} />);
        expect(screen.getByTestId('fg-summary').textContent?.replace(/\s+/g, ' ').trim())
            .toBe('2 groups · 2 sensors assigned · 0 of 4 models complete');
    });

    it('the summary is memoised: a re-render with the same Failure Group data (e.g. a chart pan) does not recompute it', () => {
        const props = makeProps();
        const spy = vi.mocked(fgSummary.summarizeFailureGroups);
        const { rerender } = render(<FailureGroupsPanel {...props} />);
        const before = spy.mock.calls.length;
        rerender(<FailureGroupsPanel {...props} />);
        rerender(<FailureGroupsPanel {...props} getGroupColor={() => 'amber'} />);
        expect(spy.mock.calls.length).toBe(before);
        rerender(<FailureGroupsPanel {...props} fgModels={[...props.fgModels]} />);
        expect(spy.mock.calls.length).toBe(before + 1);
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
        // The tag is now always appended (see the "shows the
        // model name when one is set" test below), so the visible text is
        // "name (tag)" rather than the bare name.
        const fgModels = [makeModel({ id: 'm1', name: 'Bearing model', status: true }), makeModel({ id: 'm2', name: 'Temp model', status: false })];
        render(<FailureGroupsPanel {...makeProps({ fgModels })} />);
        expect(modelLabels()).toEqual([]); // collapsed: the sensor shows once, not its models
        expandAll();
        expect(modelLabels()).toEqual(['Bearing model (TAG1)', 'Temp model (TAG1)']);
        // The header's status-dot legend has its own
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
        // The collapsed sensor line carries one chip per kind that
        // exists; the badge shell is `.kind-badge`.
        const individualBadge = screen.getByText('I', { selector: '.kind-badge' });
        const relationshipBadge = screen.getByText('R', { selector: '.kind-badge' });
        expect(screen.queryByText('C', { selector: '.kind-badge' })).toBeNull(); // no Clustering model -> no chip
        expect(individualBadge.className).toContain('kind-badge--individual');
        expect(relationshipBadge.className).toContain('kind-badge--relationship');
    });

    // A small status dot at the corner of the I/R/C badge — no dot = never
    // trained, blue = Trained (fingerprint fresh, not Complete), green =
    // Complete. Same status rules as BuildModelWindow.tsx's own dot/pill,
    // so the two views can never disagree.
    describe('status dot on the I/R/C badge', () => {
        // Badge shell is `.kind-badge` now (see "shows a
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
            const runningConditionFg: Partial<FailureGroupStateSlice> = { runningConditionNoneConfirmed: true, runningConditionTimePeriods: ALL_TIME_TRAIN };
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

        it('Train/Test (2026-10-07): the same fresh model with NO train period is gate-blocked -> no blue dot', () => {
            const runningConditionFg: Partial<FailureGroupStateSlice> = { runningConditionNoneConfirmed: true, runningConditionTimePeriods: [] };
            const model = makeModel({ status: false, category: 'performance', runningConditionMode: 'workspace' });
            const trained = { ...model, lastTrainedAt: '2026-09-30T00:00:00.000Z', trainedFingerprint: computeTrainFingerprint(model, { ...runningConditionFg, models: [model] }) };
            render(<FailureGroupsPanel {...makeProps({ fgModels: [trained], runningConditionFg, datasetHeaders: null })} />);
            expect(dotOn(badgeFor('I'))).toBeNull();
        });

        it('shows a green "complete" dot when status is true and there is no train record to be out of date against (a legacy Complete model)', () => {
            render(<FailureGroupsPanel {...makeProps({ fgModels: [makeModel({ status: true })] })} />);
            const dot = dotOn(badgeFor('I'));
            expect(dot).not.toBeNull();
            expect(dot!.className).toContain('f4-kb-dot--complete');
        });

        // The same single definition
        // (`utils/modelStatus.ts`) the Build Model window reads — a Complete
        // model whose inputs no longer match its train record is NOT complete.
        describe('Complete but out of date (inputs changed since it was trained)', () => {
            const rc: Partial<FailureGroupStateSlice> = { runningConditionNoneConfirmed: true, runningConditionTimePeriods: ALL_TIME_TRAIN };
            const complete = (over: Partial<FailureModel> = {}) => {
                const model = makeModel({ status: true, category: 'performance', ...over });
                return { ...model, lastTrainedAt: '2026-09-30T00:00:00.000Z', trainedFingerprint: computeTrainFingerprint(model, { ...rc, models: [model] }) };
            };

            it('a Complete model with a fresh train record keeps its green dot and counts as complete', () => {
                const { container } = render(<FailureGroupsPanel {...makeProps({ fgModels: [complete()], runningConditionFg: rc })} />);
                expect(dotOn(badgeFor('I'))!.className).toContain('f4-kb-dot--complete');
                expect(container.querySelector('.fg-summary-chip')!.textContent?.replace(/\s+/g, ' ').trim()).toMatch(/· 1 of 1 models complete$/);
            });

            it('status:true but the target sensor changed since training -> no green dot, not counted complete (summary chip and group count)', () => {
                const stale = { ...complete(), targetSensor: 'TAG2' };
                const { container } = render(<FailureGroupsPanel {...makeProps({ fgModels: [stale], runningConditionFg: rc })} />);
                expect(dotOn(badgeFor('I'))).toBeNull();
                expect(container.querySelector('.fg-summary-chip')!.textContent?.replace(/\s+/g, ' ').trim()).toMatch(/· 0 of 1 models complete$/);
                expect(screen.getByText('FG-1').closest('.fg-row')!.querySelector('.fg-row-count')!.textContent).toBe('0 / 1');
            });

            // A special sensor the model was trained on changed
            // its formula since -> out of date here too, once the panel is given the recipes.
            it('a special sensor the model was trained on changed its formula -> no green dot (the recipes are passed in)', () => {
                const trainedOn = [{ kind: 'formula' as const, tag: 'TAG1', formula: '$RAW * 2' }];
                const snapshot = snapshotTrainedFormulas(complete(), trainedOn, { ...rc, models: [complete()] });
                const model = { ...complete(), trainedFormulas: snapshot };
                const { rerender } = render(<FailureGroupsPanel {...makeProps({ fgModels: [model], runningConditionFg: rc, specialSensorRecipes: trainedOn })} />);
                expect(dotOn(badgeFor('I'))!.className).toContain('f4-kb-dot--complete');
                rerender(<FailureGroupsPanel {...makeProps({
                    fgModels: [model], runningConditionFg: rc,
                    specialSensorRecipes: [{ kind: 'formula', tag: 'TAG1', formula: '$RAW * 3' }],
                })} />);
                expect(dotOn(badgeFor('I'))).toBeNull();
            });

            it('the WORKSPACE running condition changing makes a Workspace-mode Complete model stale, but not a Custom-mode one', () => {
                const wsMode = complete({ id: 'a', targetSensor: 'TAG1' });
                const customMode = complete({ id: 'b', targetSensor: 'TAG2', runningConditionMode: 'custom', customRunningConditionNoneConfirmed: true });
                const changedRc: Partial<FailureGroupStateSlice> = { runningConditionNoneConfirmed: true, runningConditionTimePeriods: ALL_TIME_TRAIN, runningConditionCombine: 'or' };
                const { container } = render(<FailureGroupsPanel {...makeProps({ fgModels: [wsMode, customMode], runningConditionFg: changedRc })} />);
                expect(container.querySelector('.fg-summary-chip')!.textContent?.replace(/\s+/g, ' ').trim()).toMatch(/· 1 of 2 models complete$/);
            });
        });

        // The Dashboard dot reads the verdict PERSISTED on the model
        // (`healthVerdict`), the same value the Build Model list dot / tab pill read.
        describe('a trained model whose saved set points were judged (persisted healthVerdict)', () => {
            const rc: Partial<FailureGroupStateSlice> = { runningConditionNoneConfirmed: true, runningConditionTimePeriods: ALL_TIME_TRAIN };
            const trainedWith = (over: Partial<FailureModel> = {}) => {
                const model = makeModel({ status: false, category: 'performance', ...over });
                return { ...model, lastTrainedAt: '2026-09-30T00:00:00.000Z', trainedFingerprint: computeTrainFingerprint(model, { ...rc, models: [model] }) };
            };
            const dotClass = (m: FailureModel) => {
                const { unmount } = render(<FailureGroupsPanel {...makeProps({ fgModels: [m], runningConditionFg: rc })} />);
                const cls = dotOn(badgeFor('I'))?.className ?? 'none';
                unmount();
                return cls;
            };

            it('invalid -> the red "bad" dot ("Fix set point")', () => {
                expect(dotClass(trainedWith({ healthVerdict: 'invalid' }))).toContain('f4-kb-dot--bad');
            });
            it('incomplete -> the yellow "need" dot ("Set points needed")', () => {
                expect(dotClass(trainedWith({ healthVerdict: 'incomplete' }))).toContain('f4-kb-dot--need');
            });
            it('valid, or never judged -> the plain "trained" dot', () => {
                expect(dotClass(trainedWith({ healthVerdict: 'valid' }))).toContain('f4-kb-dot--trained');
                expect(dotClass(trainedWith())).toContain('f4-kb-dot--trained');
            });
            it('a verdict never colours a model that is not "trained": Complete stays green, stale / never trained draw nothing', () => {
                expect(dotClass(trainedWith({ status: true, healthVerdict: 'invalid' }))).toContain('f4-kb-dot--complete');
                expect(dotClass({ ...trainedWith({ healthVerdict: 'invalid' }), trainedFingerprint: 'old' })).toBe('none');
                expect(dotClass(makeModel({ category: 'performance', healthVerdict: 'invalid' }))).toBe('none');
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
            // The bare tag only appears as the sensor line's own tag line (SensorLabel), never as a model label.
            expect(screen.queryByText('TAG1', { selector: ':not(.sl-tag)' })).toBeNull();
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

        // The kind is "Relation model" in the whole app; the
        // letter on the badge stays R.
        it('the kind badges say Individual / Relation model / Clustering on hover — on the sensor line and on each model row', () => {
            const fgModels = [
                makeModel({ id: 'i', kind: 'individual' }),
                makeModel({ id: 'r', kind: 'relationship', predictorSensors: ['TAG2'] }),
                makeModel({ id: 'c', kind: 'clustering', targetSensor: '', xSensor: 'TAG1', ySensor: 'TAG2' }),
            ];
            render(<FailureGroupsPanel {...makeProps({ fgModels })} />);
            const titles = () => [...document.querySelectorAll('.kind-badge')].map(b => `${b.textContent?.charAt(0)}=${b.getAttribute('title')}`);
            expect(titles()).toEqual(['I=Individual', 'R=Relation model', 'C=Clustering']);
            // expanded: the per-model rows carry the same names
            fireEvent.click(screen.getByTestId(/^fg-sensor-row-/).querySelector('button')!);
            expect(titles()).toEqual(['I=Individual', 'R=Relation model', 'C=Clustering', 'I=Individual', 'R=Relation model', 'C=Clustering']);
            for (const el of [...document.querySelectorAll('[title]')]) expect(el.getAttribute('title')).not.toMatch(/Relationship/);
            expect(document.body.textContent).not.toMatch(/Relationship/);
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

        it('the sensor line is the stacked SensorLabel (same as the Sensor tab rows): description, unit chip, tag; full name in title (customer item 3)', () => {
            render(<FailureGroupsPanel {...makeProps()} />);
            const row = screen.getByTestId('fg-sensor-row-1:tag1');
            const label = row.querySelector('.fg-srow-btn .sl') as HTMLElement;
            expect(label.querySelector('.sl-desc')?.textContent).toBe('Pump Pressure');
            expect(label.querySelector('.sl-unit')?.textContent).toBe('bar');
            expect(label.querySelector('.sl-tag')?.textContent).toBe('TAG1');
            // The description ellipsises via `.sl-desc` (App.css); the title carries the full name.
            expect(label.getAttribute('title')).toBe('Pump Pressure · TAG1 · bar · Pump');
            expect(row.querySelector('.fg-srow-btn')?.getAttribute('aria-label')).toBe('Pump Pressure · TAG1 · bar · Pump');
        });

        it('search also matches the unit and the component', () => {
            render(<FailureGroupsPanel {...makeProps()} />);
            fireEvent.change(screen.getByPlaceholderText('Search groups or sensors...'), { target: { value: 'bar' } });
            expect(screen.getByTestId('fg-sensor-row-1:tag1')).toBeTruthy();
            fireEvent.change(screen.getByPlaceholderText('Search groups or sensors...'), { target: { value: 'nothing-like-this' } });
            expect(screen.queryByTestId('fg-sensor-row-1:tag1')).toBeNull();
        });

        // Unit badge next to the sensor row's name, matching the Sensor
        // tab's own convention (`.unit-badge`).
        it('shows the sensor\'s unit as a badge next to the row label', () => {
            render(<FailureGroupsPanel {...makeProps()} />);
            expect(screen.getByText('bar', { selector: '.unit-badge' })).toBeTruthy();
        });

        it('shows no unit badge when the sensor has no metadata', () => {
            render(<FailureGroupsPanel {...makeProps({ fgModels: [makeModel({ name: '', targetSensor: 'TAG9' })] })} />);
            expect(screen.queryByText('bar', { selector: '.unit-badge' })).toBeNull();
        });
    });

    // The
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
            expect(screen.getByText('Motor Temperature', { selector: '.sl-desc' })).toBeTruthy();
        });

        it('a group-NAME match keeps every sensor in that group', () => {
            render(<FailureGroupsPanel {...makeProps({ fgGroups: [notInGroup, groupA, groupB], fgModels, sensorMetadata })} />);
            fireEvent.change(screen.getByPlaceholderText('Search groups or sensors...'), { target: { value: 'group a' } });
            expect(screen.getByText('Group A')).toBeTruthy();
            expect(screen.getByText('Pump Pressure', { selector: '.sl-desc' })).toBeTruthy();
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

    it('an empty group says "No sensors yet" with "Assign sensors →"; the always-shown "Not in Group" card still says "No models yet"', () => {
        const onAssignSensors = vi.fn();
        render(<FailureGroupsPanel {...makeProps({ fgModels: [], onAssignSensors })} />);
        expect(screen.getAllByText('No models yet')).toHaveLength(1);
        expect(screen.getByText('No sensors yet')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Assign sensors to Group A' }));
        expect(onAssignSensors).toHaveBeenCalledWith(1);
    });

    it('"Assign sensors →" appears on every empty group only, and not at all without an onAssignSensors handler', () => {
        const fgModels = [makeModel({ groupNos: [1] })];
        const { unmount } = render(<FailureGroupsPanel {...makeProps({ fgGroups: [notInGroup, groupA, groupB], fgModels, onAssignSensors: vi.fn() })} />);
        expect(screen.queryByRole('button', { name: 'Assign sensors to Group A' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Assign sensors to Group B' })).toBeTruthy();
        unmount();
        render(<FailureGroupsPanel {...makeProps({ fgModels: [] })} />);
        expect(screen.queryByText('Assign sensors →')).toBeNull();
    });

    it('the "ready" callout shows while any group is empty, names the Failure groups button (no emoji), and goes once every group has a sensor', () => {
        const { rerender } = render(<FailureGroupsPanel {...makeProps({ fgGroups: [notInGroup, groupA, groupB], fgModels: [makeModel()] })} />);
        const callout = screen.getByTestId('fg-callout');
        expect(callout.textContent).toContain('Your failure groups are ready.');
        expect(callout.textContent).toContain('use the Failure groups button');
        expect(callout.textContent).not.toContain('📁');
        expect(callout.querySelector('svg')).toBeTruthy();
        rerender(<FailureGroupsPanel {...makeProps({ fgGroups: [notInGroup, groupA, groupB], fgModels: [makeModel(), makeModel({ id: 'm2', groupNos: [2] })] })} />);
        expect(screen.queryByTestId('fg-callout')).toBeNull();
    });

    it('"Build Model →" is disabled with the reason as its tooltip while there is no model at all', () => {
        const onOpenBuildModel = vi.fn();
        render(<FailureGroupsPanel {...makeProps({ fgModels: [], onOpenBuildModel })} />);
        const btn = screen.getByText('Build Model →').closest('button') as HTMLButtonElement;
        expect(btn.disabled).toBe(true);
        expect(btn.title).toBe('No models yet — assign sensors to a failure group first');
        fireEvent.click(btn);
        expect(onOpenBuildModel).not.toHaveBeenCalled();
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
        const btn = screen.getByText('Build Model →').closest('button') as HTMLButtonElement;
        expect(btn.disabled).toBe(false);
        expect(btn.title).toBe('');
        fireEvent.click(btn);
        expect(onOpenBuildModel).toHaveBeenCalledTimes(1);
    });

    // The "Edit details" panel edits Name + Description +
    // Recommendation together; Name isn't independently editable from
    // the rest.
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
        // 2026-10-17: deleting a group now deletes the models only in it, with their saved files —
        // an exception to the 2026-08-31 "no confirmations" rule, chosen by the user with this
        // behaviour: the trash asks first and says how many models go.
        it('the trash opens an inline confirm that says how many models are deleted / kept; Delete calls onDeleteGroup, Cancel does not', () => {
            const onDeleteGroup = vi.fn();
            render(<FailureGroupsPanel {...makeProps({ onDeleteGroup })} />);
            fireEvent.click(screen.getByTitle('Delete group'));
            expect(onDeleteGroup).not.toHaveBeenCalled();
            const confirm = screen.getByTestId('fg-delete-confirm');
            expect(confirm.getAttribute('role')).toBe('alertdialog');
            expect(confirm.textContent).toMatch(/^Delete .+\?/);
            fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
            expect(screen.queryByTestId('fg-delete-confirm')).toBeNull();
            expect(onDeleteGroup).not.toHaveBeenCalled();
            fireEvent.click(screen.getByTitle('Delete group'));
            fireEvent.click(within(screen.getByTestId('fg-delete-confirm')).getByRole('button', { name: 'Delete' }));
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

describe('groupDeleteCounts / groupDeleteSentence', () => {
    it('counts the models only in the group (deleted) and those also elsewhere (kept), and says it', async () => {
        const { groupDeleteCounts, groupDeleteSentence } = await import('../utils/modelOutputFiles');
        const models = [{ groupNos: [1] }, { groupNos: [1] }, { groupNos: [1, 2] }, { groupNos: [2] }];
        expect(groupDeleteCounts(models, 1)).toEqual({ deleted: 2, kept: 1 });
        expect(groupDeleteSentence('FG-1', 2, 1)).toBe('Delete FG-1? 2 models used only by this group are deleted with their saved files. 1 model stays in its other groups.');
        expect(groupDeleteSentence('FG-1', 0, 2)).toBe('Delete FG-1? 2 models stay in their other groups.');
    });
});
