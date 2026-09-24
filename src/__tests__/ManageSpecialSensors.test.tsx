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
        availableSensors: ['11PT1214A.PV', '11FT1601.PV', '11FT1602.PV'],
        editingTag: null,
        onEdit: vi.fn(),
        onSaveEdit: vi.fn(),
        savingEdit: false,
        editError: null,
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

    it('spells an operation recipe out instead of showing raw config', () => {
        renderList({ recipes: [totalFlow], formulaRefs: new Map() });
        expect(screen.getByText('sum(11FT1601.PV, 11FT1602.PV)')).toBeTruthy();
    });

    it('deletes an unused sensor on the first click', () => {
        const { props } = renderList();
        const button = deleteButton('special A');
        expect(button.disabled).toBe(false);
        fireEvent.click(button);
        expect(props.onDelete).toHaveBeenCalledWith('special A');
    });

    it('disables deletion of a sensor another special sensor is built on', () => {
        renderList({
            recipes: [specialA, specialB],
            formulaRefs: new Map([['special a', ['11PT1214A.PV']], ['special b', ['special A']]]),
        });
        expect(deleteButton('special A').disabled).toBe(true);
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

    it('opens the editor for the row whose pencil was clicked', () => {
        const { props } = renderList();
        fireEvent.click(screen.getByLabelText('Edit special A'));
        expect(props.onEdit).toHaveBeenCalledWith('special A');
    });

    it('clicking the pencil again closes the editor', () => {
        const { props } = renderList({ editingTag: 'special A' });
        fireEvent.click(screen.getByLabelText('Edit special A'));
        expect(props.onEdit).toHaveBeenCalledWith(null);
    });

    it('shows the editor inline under the row being edited, and only that row', () => {
        renderList({
            recipes: [specialA, totalFlow],
            formulaRefs: new Map([['special a', ['11PT1214A.PV']]]),
            editingTag: 'special A',
        });
        expect(screen.getByLabelText('Formula')).toBeTruthy();
        expect(screen.getAllByText('Save changes')).toHaveLength(1);
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
