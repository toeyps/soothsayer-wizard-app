import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { SensorMetadata, SpecialSensorRecipe } from '../types';
import SpecialSensorEditor from '../components/windows/SpecialSensorEditor';

const formulaRecipe: SpecialSensorRecipe = { kind: 'formula', tag: 'special A', formula: '$TAG1 * 2' };
const operationRecipe: SpecialSensorRecipe = {
    kind: 'operation',
    tag: 'Total flow',
    sourceSensors: ['TAG1', 'TAG2'],
    operationConfig: { mode: 'multi', multiOp: { type: 'sum' }, customName: 'Total flow' },
};
const singleRecipe: SpecialSensorRecipe = {
    kind: 'operation',
    tag: 'Shifted',
    sourceSensors: ['TAG1'],
    operationConfig: { mode: 'single', singleOp: { type: 'add', value: 10 }, customName: 'Shifted' },
};

const metadata: SensorMetadata = { tag: 'special A', description: 'Doubled', unit: 'bar', component: 'Pump' };

function renderEditor(overrides: Partial<React.ComponentProps<typeof SpecialSensorEditor>> = {}) {
    const props: React.ComponentProps<typeof SpecialSensorEditor> = {
        recipe: formulaRecipe,
        metadata,
        availableSensors: ['TAG1', 'TAG2', 'TAG3'],
        onCancel: vi.fn(),
        onSave: vi.fn(),
        saving: false,
        error: null,
        ...overrides,
    };
    return { ...render(<SpecialSensorEditor {...props} />), props };
}

const save = () => screen.getByText('Save changes') as HTMLButtonElement;

describe('SpecialSensorEditor', () => {
    it('opens with the sensor’s current values, not blank fields', () => {
        renderEditor();
        expect((screen.getByLabelText('Formula') as HTMLTextAreaElement).value).toBe('$TAG1 * 2');
        expect((screen.getByLabelText('Description') as HTMLInputElement).value).toBe('Doubled');
        expect((screen.getByLabelText('Unit') as HTMLInputElement).value).toBe('bar');
    });

    it('shows the name as fixed and says why', () => {
        renderEditor();
        expect(screen.getByText('special A')).toBeTruthy();
        expect(screen.getByText(/Renaming isn’t supported/)).toBeTruthy();
        // No editable name field to type a new tag into.
        expect(screen.queryByLabelText('Name')).toBeNull();
    });

    it('saves the edited formula and metadata under the original tag', () => {
        const { props } = renderEditor();
        fireEvent.change(screen.getByLabelText('Formula'), { target: { value: '$TAG1 * 3' } });
        fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'kPa' } });
        fireEvent.click(save());
        expect(props.onSave).toHaveBeenCalledWith({
            recipe: { kind: 'formula', tag: 'special A', formula: '$TAG1 * 3' },
            metadata: { tag: 'special A', description: 'Doubled', unit: 'kPa', component: 'Pump' },
        });
    });

    it('will not save an empty formula', () => {
        renderEditor();
        fireEvent.change(screen.getByLabelText('Formula'), { target: { value: '   ' } });
        expect(save().disabled).toBe(true);
    });

    it('falls back to Uncategorized when the component is cleared', () => {
        const { props } = renderEditor();
        fireEvent.change(screen.getByLabelText('Component'), { target: { value: '' } });
        fireEvent.click(save());
        expect((props.onSave as ReturnType<typeof vi.fn>).mock.calls[0][0].metadata.component).toBe('Uncategorized');
    });

    it('edits an operation’s source sensors', () => {
        const { props } = renderEditor({ recipe: operationRecipe, metadata: undefined });
        fireEvent.click(screen.getByLabelText('Remove TAG2'));
        fireEvent.change(screen.getByLabelText('Add a source sensor'), { target: { value: 'TAG3' } });
        fireEvent.click(save());
        const saved = (props.onSave as ReturnType<typeof vi.fn>).mock.calls[0][0].recipe;
        expect(saved.sourceSensors).toEqual(['TAG1', 'TAG3']);
    });

    it('does not offer the sensor itself as one of its own inputs', () => {
        renderEditor({
            recipe: operationRecipe,
            availableSensors: ['TAG1', 'TAG2', 'TAG3', 'Total flow'],
        });
        const options = Array.from(screen.getByLabelText('Add a source sensor').querySelectorAll('option'))
            .map(o => o.textContent);
        expect(options).not.toContain('Total flow');
        // Already-picked sensors are not offered twice either.
        expect(options).not.toContain('TAG1');
        expect(options).toContain('TAG3');
    });

    it('needs at least two sensors for a multi-sensor operation', () => {
        renderEditor({ recipe: operationRecipe });
        fireEvent.click(screen.getByLabelText('Remove TAG2'));
        expect(save().disabled).toBe(true);
        expect(screen.getByText('Pick at least two sensors to combine.')).toBeTruthy();
    });

    it('needs exactly one sensor for a single-sensor operation', () => {
        renderEditor({ recipe: singleRecipe });
        expect(save().disabled).toBe(false);
        fireEvent.change(screen.getByLabelText('Add a source sensor'), { target: { value: 'TAG2' } });
        expect(save().disabled).toBe(true);
        expect(screen.getByText('Pick exactly one sensor for this operation.')).toBeTruthy();
    });

    it('edits a single operation’s type and value, and keeps the name', () => {
        const { props } = renderEditor({ recipe: singleRecipe });
        fireEvent.change(screen.getByLabelText('Operation'), { target: { value: 'multiply' } });
        fireEvent.change(screen.getByLabelText('Value'), { target: { value: '3' } });
        fireEvent.click(save());
        const saved = (props.onSave as ReturnType<typeof vi.fn>).mock.calls[0][0].recipe;
        expect(saved.operationConfig.singleOp).toEqual({ type: 'multiply', value: 3 });
        expect(saved.operationConfig.customName).toBe('Shifted');
    });

    it('hides the value field for an operation that does not take one', () => {
        renderEditor({ recipe: singleRecipe });
        expect(screen.getByLabelText('Value')).toBeTruthy();
        fireEvent.change(screen.getByLabelText('Operation'), { target: { value: 'sqrt' } });
        expect(screen.queryByLabelText('Value')).toBeNull();
    });

    it('offers only the operations a recipe can actually store', () => {
        // temp_spread / abs_diff / efficiency_pct exist in the registry but are
        // built as formulas, so they never arrive here as operation recipes.
        renderEditor({ recipe: operationRecipe });
        const options = Array.from(screen.getByLabelText('Operation').querySelectorAll('option'))
            .map(o => (o as HTMLOptionElement).value);
        expect(options).toEqual(['sum', 'mean', 'median']);
    });

    it('freezes the form and says so while the caller is recomputing', () => {
        renderEditor({ saving: true });
        expect(screen.getByText('Recomputing…')).toBeTruthy();
        expect(save().disabled).toBe(true);
    });

    it('shows why the caller refused the last attempt', () => {
        renderEditor({ error: '"special A" can’t be built from special B — that would make it depend on itself.' });
        expect(screen.getByRole('alert').textContent).toContain('depend on itself');
    });

    it('cancel leaves without saving', () => {
        const { props } = renderEditor();
        fireEvent.change(screen.getByLabelText('Formula'), { target: { value: 'nonsense' } });
        fireEvent.click(screen.getByText('Cancel'));
        expect(props.onCancel).toHaveBeenCalled();
        expect(props.onSave).not.toHaveBeenCalled();
    });
});
