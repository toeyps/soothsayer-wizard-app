import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { FailureModel, SensorMetadata, SpecialSensorRecipe } from '../types';
import ManageSpecialSensors from '../components/windows/ManageSpecialSensors';

function makeModel(overrides: Partial<FailureModel> = {}): FailureModel {
    return {
        id: 'm1', groupNos: [1], name: 'Boiler efficiency', kind: 'individual', category: null,
        notes: '', status: false,
        targetSensor: '', predictorSensors: [], xSensor: '', ySensor: '',
        individualChecked: true, rcMode: null, scatterXSensor: '', relModelName: '',
        relStiffness: 100_000, clusterModelName: '', numClusters: 3, criteriaSensor: '',
        clusterRanges: [], filterTimePeriods: [],
        runningConditionMode: 'workspace', customRunningConditionFilters: [], customRunningConditionCombine: 'and',
        ...overrides,
    };
}

const specialA: SpecialSensorRecipe = { kind: 'formula', tag: 'special A', formula: '$11PT1214A.PV * 2' };
const specialB: SpecialSensorRecipe = { kind: 'formula', tag: 'special B', formula: '${special A} + 10' };
const totalFlow: SpecialSensorRecipe = {
    kind: 'operation', tag: 'Boiler total flow',
    sourceSensors: ['11FT1601.PV', '11FT1602.PV'],
    operationConfig: { mode: 'multi', multiOp: { type: 'sum' }, customName: 'Boiler total flow' },
};

const metadata: SensorMetadata[] = [
    { tag: 'special A', description: 'Doubled pressure', unit: 'bar', component: 'Pump' },
];

function renderList(overrides: Partial<React.ComponentProps<typeof ManageSpecialSensors>> = {}) {
    const props: React.ComponentProps<typeof ManageSpecialSensors> = {
        recipes: [specialA],
        sensorMetadata: metadata,
        models: [],
        selectedSensors: [],
        formulaRefs: new Map([['special a', ['11PT1214A.PV']]]),
        onDelete: vi.fn(),
        pendingDelete: null,
        onUndo: vi.fn(),
        editingTag: null,
        onEdit: vi.fn(),
        savingEdit: false,
        ...overrides,
    };
    return { ...render(<ManageSpecialSensors {...props} />), props };
}

/** The row's own delete button, found by its accessible label. */
const deleteButton = (tag: string) => screen.getByLabelText(`Delete ${tag}`) as HTMLButtonElement;

describe('ManageSpecialSensors', () => {
    it('tells the user where special sensors come from when there are none', () => {
        renderList({ recipes: [] });
        expect(screen.getByText('No special sensors yet')).toBeTruthy();
    });

    it('shows a formula sensor with its expression and description', () => {
        renderList();
        expect(screen.getByText('special A')).toBeTruthy();
        expect(screen.getByText('$11PT1214A.PV * 2')).toBeTruthy();
        expect(screen.getByText(/Doubled pressure/)).toBeTruthy();
    });

    it('spells an operation recipe out in words (describeSpecialSensor), sources by their description', () => {
        renderList({
            recipes: [totalFlow, {
                kind: 'operation', tag: 'Avg', sourceSensors: ['special A', '11FT1602.PV'],
                operationConfig: { mode: 'multi', multiOp: { type: 'mean', decimals: 2 }, customName: 'Avg' },
            }],
            formulaRefs: new Map(),
        });
        expect(screen.getByTestId('recipe-summary-Boiler total flow').textContent).toBe('Sum of 11FT1601.PV, 11FT1602.PV');
        expect(screen.getByTestId('recipe-summary-Boiler total flow').getAttribute('title')).toBe('sum(11FT1601.PV, 11FT1602.PV)');
        expect(screen.getByTestId('recipe-summary-Avg').textContent)
            .toBe('Average of Doubled pressure, 11FT1602.PV · missing values skipped · rounded to 2 decimals');
        expect(screen.getByTitle('Average block')).toBeTruthy();
    });

    it('deletes an unused sensor on the first click', () => {
        const { props } = renderList();
        const button = deleteButton('special A');
        expect(button.disabled).toBe(false);
        fireEvent.click(button);
        expect(props.onDelete).toHaveBeenCalledWith('special A');
    });

    it('disables deletion of a sensor another special sensor is built on: "Used by <name> — remove it there first"', () => {
        renderList({
            recipes: [specialA, specialB],
            formulaRefs: new Map([['special a', ['11PT1214A.PV']], ['special b', ['special A']]]),
        });
        expect(deleteButton('special A').disabled).toBe(true);
        expect(deleteButton('special A').getAttribute('title')).toBe('Used by special B — remove it there first');
        // The one built on top is the end of the chain — it can go.
        expect(deleteButton('special B').disabled).toBe(false);
    });

    it('names the dependent sensor and what to do about it when expanded', () => {
        renderList({
            recipes: [specialA, specialB],
            formulaRefs: new Map([['special a', ['11PT1214A.PV']], ['special b', ['special A']]]),
        });
        fireEvent.click(screen.getByText('Used by 1 sensor'));
        // Scoped to the expanded panel — "special B" is also its own row.
        const detail = screen.getByText('Built on top of this:').parentElement!;
        expect(detail.textContent).toContain('special B');
        expect(screen.getByText(/Delete those first/)).toBeTruthy();
    });

    it('disables deletion of a sensor a Failure Group model uses, and names the field', () => {
        renderList({ models: [makeModel({ targetSensor: 'special A' })] });
        expect(deleteButton('special A').disabled).toBe(true);
        expect(deleteButton('special A').getAttribute('title')).toBe('Used by 1 model — remove it there first');
        fireEvent.click(screen.getByText('Used by 1 model'));
        const item = screen.getByRole('listitem');
        expect(within(item).getByText(/Boiler efficiency/)).toBeTruthy();
        expect(within(item).getByText(/target sensor/)).toBeTruthy();
    });

    it('counts one model once even when it uses the sensor in two fields', () => {
        renderList({ models: [makeModel({ targetSensor: 'special A', predictorSensors: ['special A'] })] });
        expect(screen.getByText('Used by 1 model')).toBeTruthy();
        fireEvent.click(screen.getByText('Used by 1 model'));
        expect(screen.getAllByRole('listitem')).toHaveLength(2);
    });

    it('marks a plotted sensor but still lets it be deleted', () => {
        renderList({ selectedSensors: ['special A'] });
        expect(screen.getByText('on chart')).toBeTruthy();
        expect(deleteButton('special A').disabled).toBe(false);
    });

    it('holds deletion back until the formula reference lookup has answered', () => {
        renderList({ formulaRefs: null });
        // An empty ref map and a failed lookup look identical from here, so a
        // null map must never read as "nothing depends on this".
        expect(deleteButton('special A').disabled).toBe(true);
    });

    it('offers an undo while a deletion is still in its window', () => {
        const { props } = renderList({ recipes: [], pendingDelete: { tags: ['special A'], label: 'special A' } });
        expect(screen.getByText(/Deleted/)).toBeTruthy();
        fireEvent.click(screen.getByText('Undo'));
        expect(props.onUndo).toHaveBeenCalled();
    });

    it('the pencil opens the sensor in the Formula editor (the window owns it), and marks the row being edited', () => {
        const { props, rerender } = renderList();
        fireEvent.click(screen.getByLabelText('Edit special A'));
        expect(props.onEdit).toHaveBeenCalledWith('special A');
        rerender(<ManageSpecialSensors {...props} editingTag="special A" />);
        // Clicking it again re-opens it (no toggle); no editor is expanded inside the list any more.
        expect(screen.getByLabelText('Edit special A').getAttribute('aria-pressed')).toBe('true');
        fireEvent.click(screen.getByLabelText('Edit special A'));
        expect(props.onEdit).toHaveBeenLastCalledWith('special A');
        expect(screen.queryByLabelText('Formula')).toBeNull();
        expect(screen.queryByText('Save changes')).toBeNull();
    });

    it('the sensor open in the editor cannot be deleted under it: "Close the edit first"; the other rows can', () => {
        const { props } = renderList({
            recipes: [specialA, totalFlow],
            formulaRefs: new Map([['special a', ['11PT1214A.PV']], ['boiler total flow', []]]),
            editingTag: 'SPECIAL A', // matched case-insensitively
        });
        expect(deleteButton('special A').disabled).toBe(true);
        expect(deleteButton('special A').getAttribute('title')).toBe('Close the edit first');
        fireEvent.click(deleteButton('special A'));
        expect(props.onDelete).not.toHaveBeenCalled();
        expect(deleteButton('Boiler total flow').disabled).toBe(false);
    });

    it('while a save is applied the pencils wait', () => {
        renderList({ savingEdit: true });
        expect((screen.getByLabelText('Edit special A') as HTMLButtonElement).disabled).toBe(true);
    });

    it('a sensor that cannot be deleted can still be edited — that is what the downstream recompute is for', () => {
        renderList({
            recipes: [specialA, specialB],
            formulaRefs: new Map([['special a', ['11PT1214A.PV']], ['special b', ['special A']]]),
        });
        expect(deleteButton('special A').disabled).toBe(true);
        expect((screen.getByLabelText('Edit special A') as HTMLButtonElement).disabled).toBe(false);
    });

    it('filters the list by name, description or recipe', () => {
        renderList({
            recipes: [specialA, totalFlow],
            formulaRefs: new Map([['special a', ['11PT1214A.PV']]]),
        });
        fireEvent.change(screen.getByPlaceholderText('Search special sensors'), { target: { value: 'boiler' } });
        expect(screen.queryByText('special A')).toBeNull();
        expect(screen.getByText('Boiler total flow')).toBeTruthy();
    });
});

describe('ManageSpecialSensors -- edit lock (the expanded row)', () => {
    const chain = { recipes: [specialA, specialB], formulaRefs: new Map([['special a', ['11PT1214A.PV']], ['special b', ['special A']]]) };

    it('a sensor a model uses: the expanded row says the name and formula are locked, and why', () => {
        renderList({ models: [makeModel({ targetSensor: 'special A' })] });
        // The Edit button itself stays usable (description / unit / component are editable).
        expect((screen.getByLabelText('Edit special A') as HTMLButtonElement).disabled).toBe(false);
        fireEvent.click(screen.getByText('Used by 1 model'));
        expect(screen.getByTestId('edit-lock-special A').textContent)
            .toContain('Name and formula are locked: Used by 1 model: Boiler efficiency (Individual).');
    });

    it('TRANSITIVE: B is built on A and a model uses B -> A is locked and the message names B', () => {
        renderList({ ...chain, models: [makeModel({ targetSensor: 'special B' })] });
        fireEvent.click(screen.getByText('Used by 1 sensor'));
        expect(screen.getByTestId('edit-lock-special A').textContent)
            .toContain('Built on by "special B", which is used by 1 model: Boiler efficiency (Individual).');
    });
});

// 2026-10-08 (review S1): a sensor whose recipe could not be rebuilt this
// session is flagged on its row with an amber note (its editor -- now the
// Formula editor on the Create tab -- unlocks the formula even under a lock;
// covered in AddSensorWindow.test).
describe('ManageSpecialSensors -- not restored', () => {
    const usesC = makeModel({ id: 'm2', name: 'Pump model', targetSensor: 'special C' });
    const specialC: SpecialSensorRecipe = { kind: 'formula', tag: 'special C', formula: 'round($11PT1214A.PV, 2)' };
    const REASON = 'Formula error: round($11PT1214A.PV, 2) does not round to 2 decimal places.';
    const refs = new Map([['special a', ['11PT1214A.PV']], ['special c', ['11PT1214A.PV']]]);

    it('flags ONLY the not-restored row, with the reason in its tooltip and an amber note under it', () => {
        renderList({ recipes: [specialA, specialC], formulaRefs: refs, unrestored: new Map([['special c', REASON]]) });
        const badge = screen.getByTestId('not-restored-special C');
        expect(badge.textContent).toContain('No data — fix formula');
        expect(badge.getAttribute('title')).toContain(REASON);
        expect(screen.getByTestId('not-restored-note-special C').textContent)
            .toBe(`No data this session. ${REASON.replace(/\.$/, '')}. Edit it to fix the formula.`);
        expect(screen.queryByTestId('not-restored-special A')).toBeNull();
        expect(screen.queryByTestId('not-restored-note-special A')).toBeNull();
    });

    it('a not-restored sensor a model uses: the note says the formula is unlocked for the fix, the name stays locked', () => {
        renderList({ recipes: [specialC], formulaRefs: refs, models: [usesC], unrestored: new Map([['special c', REASON]]) });
        expect(screen.getByTestId('not-restored-note-special C').textContent)
            .toContain('the formula is unlocked for the fix; the name stays locked');
    });

    it('the expanded row says only the NAME is locked for a not-restored sensor, and Delete stays off while a model uses it', () => {
        renderList({ recipes: [specialC], formulaRefs: refs, models: [usesC], unrestored: new Map([['special c', null]]) });
        fireEvent.click(screen.getByText('Used by 1 model'));
        expect(screen.getByTestId('edit-lock-special C').textContent).toMatch(/^Name is locked:/);
        expect(deleteButton('special C').disabled).toBe(true);
    });

    it('unknown (null) flags nothing', () => {
        renderList({ recipes: [specialC], formulaRefs: refs, models: [usesC], unrestored: null });
        expect(screen.queryByTestId('not-restored-special C')).toBeNull();
        expect(screen.queryByTestId('not-restored-note-special C')).toBeNull();
    });
});
