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

const sensorMetadata: SensorMetadata[] = [
    { tag: 'special A', description: 'Doubled', unit: 'bar', component: 'Pump' },
];

function renderEditor(overrides: Partial<React.ComponentProps<typeof SpecialSensorEditor>> = {}) {
    const props: React.ComponentProps<typeof SpecialSensorEditor> = {
        recipe: formulaRecipe,
        sensorMetadata,
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
// `ValueInput` (shared with `SensorTooling`) renders a bare <label> next to
// the <input> with no htmlFor/aria-label linking them -- same as
// `SensorTooling.test.tsx` itself has to work around -- so grab the input
// via its label's sibling rather than `getByLabelText`.
const valueInput = () => screen.getByText('Value').closest('div')!.querySelector('input') as HTMLInputElement;

describe('SpecialSensorEditor', () => {
    describe('formula-kind recipes — edited as raw text', () => {
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

        it('cancel leaves without saving', () => {
            const { props } = renderEditor();
            fireEvent.change(screen.getByLabelText('Formula'), { target: { value: 'nonsense' } });
            fireEvent.click(screen.getByText('Cancel'));
            expect(props.onCancel).toHaveBeenCalled();
            expect(props.onSave).not.toHaveBeenCalled();
        });
    });

    // Operation-kind recipes are edited with the SAME button UI Create uses
    // (`ButtonBuilder`, reused directly) rather than a separate, narrower
    // dropdown — these tests exercise that shared component through the
    // editor, seeded from an existing config, mirroring
    // `SensorTooling.test.tsx`'s own coverage of the same component.
    describe('operation-kind recipes — the same button UI as Create, seeded from the existing config', () => {
        it('opens a multi-sensor recipe with its sensors and the matching shortcut already selected', () => {
            renderEditor({ recipe: operationRecipe, sensorMetadata: [] });
            // Each appears twice -- once as this component's own Source
            // Sensors chip, once again inside `ButtonBuilder`'s "Combine
            // with operators" chips.
            expect(screen.getAllByText('TAG1').length).toBeGreaterThan(0);
            expect(screen.getAllByText('TAG2').length).toBeGreaterThan(0);
            // "Sum all" seeded as active -- distinguishable from the other
            // shortcuts by its accent styling, same convention `SensorTooling`
            // itself uses (no separate "selected" text).
            const sumAll = screen.getByText('Sum all') as HTMLButtonElement;
            expect(sumAll.style.color).toBe('var(--accent-color)');
        });

        it('opens a single-sensor recipe with its sensor, operation and value already filled in', () => {
            renderEditor({ recipe: singleRecipe, sensorMetadata: [] });
            expect(screen.getByText('TAG1')).toBeTruthy();
            const addBtn = screen.getByText('Add') as HTMLButtonElement;
            expect(addBtn.style.color).toBe('var(--accent-color)');
            expect(valueInput().value).toBe('10');
        });

        it('switches from the single-sensor form to the combine form as a second source sensor is added, and back', () => {
            renderEditor({ recipe: singleRecipe, availableSensors: ['TAG1', 'TAG2'], sensorMetadata: [] });
            expect(screen.getByText('Value')).toBeTruthy(); // single-sensor UI, "Add" seeded

            fireEvent.change(screen.getByLabelText('Add a source sensor'), { target: { value: 'TAG2' } });
            expect(screen.getByText('Combine with operators')).toBeTruthy(); // now the multi-sensor UI
            expect(screen.queryByText('Value')).toBeNull(); // the single-op form is gone, not just hidden-empty

            // Removing it again goes back to the single-sensor FORM -- but,
            // same as picking a different set of sensors in Create, the
            // previously-picked operation does not silently carry over (it
            // was picked for a different input set), so nothing is selected
            // yet -- just the single-sensor button groups themselves.
            fireEvent.click(screen.getByLabelText('Remove TAG2'));
            expect(screen.getByText('Combine with a number')).toBeTruthy();
            expect(screen.queryByText('Value')).toBeNull();
        });

        it('removing every source sensor shows a hint instead of a broken picker', () => {
            renderEditor({ recipe: singleRecipe, sensorMetadata: [] });
            fireEvent.click(screen.getByLabelText('Remove TAG1'));
            expect(screen.getByText('Pick at least one sensor above to configure a calculation.')).toBeTruthy();
            expect(save().disabled).toBe(true);
        });

        it('editing a legacy multi-op (Sum all) and saving keeps it an operation recipe', () => {
            const { props } = renderEditor({ recipe: operationRecipe, sensorMetadata: [] });
            fireEvent.click(screen.getByText('Average all'));
            fireEvent.click(save());
            const saved = (props.onSave as ReturnType<typeof vi.fn>).mock.calls[0][0].recipe;
            expect(saved).toEqual({
                kind: 'operation',
                tag: 'Total flow',
                sourceSensors: ['TAG1', 'TAG2'],
                operationConfig: { mode: 'multi', multiOp: { type: 'mean' }, customName: 'Total flow' },
            });
        });

        it('editing a single op (Multiply) and its value, saves it with the name kept', () => {
            const { props } = renderEditor({ recipe: singleRecipe, sensorMetadata: [] });
            fireEvent.click(screen.getByText('Multiply'));
            fireEvent.change(valueInput(), { target: { value: '3' } });
            fireEvent.click(save());
            const saved = (props.onSave as ReturnType<typeof vi.fn>).mock.calls[0][0].recipe;
            expect(saved.operationConfig.singleOp).toEqual({ type: 'multiply', value: 3 });
            expect(saved.operationConfig.customName).toBe('Shifted');
        });

        it('picking a transform op hides the Value field (it takes no argument)', () => {
            renderEditor({ recipe: singleRecipe, sensorMetadata: [] });
            expect(screen.getByText('Value')).toBeTruthy();
            fireEvent.click(screen.getByText('Square root'));
            expect(screen.queryByText('Value')).toBeNull();
        });

        // The core of what this whole change is for: a formula-backed
        // shortcut, unavailable through the old plain dropdown, now saves as
        // a `formula`-kind recipe -- the recipe's kind follows what was
        // actually built, exactly like creating a new sensor this way would.
        it('picking a formula-backed shortcut (Absolute difference) saves as a formula recipe, not an operation', () => {
            const { props } = renderEditor({ recipe: operationRecipe, sensorMetadata: [] });
            fireEvent.click(screen.getByText('Absolute difference'));
            fireEvent.click(save());
            const saved = (props.onSave as ReturnType<typeof vi.fn>).mock.calls[0][0].recipe;
            expect(saved).toEqual({ kind: 'formula', tag: 'Total flow', formula: 'abs($TAG1 - $TAG2)' });
        });

        // Same for just leaving the default "+" chain active instead of
        // picking any shortcut at all -- previously impossible to save
        // through the plain dropdown (it always required sum/mean/median).
        it('leaving the operator chain active (no shortcut picked) saves as a formula recipe built from the chain', () => {
            const { props } = renderEditor({ recipe: operationRecipe, sensorMetadata: [] });
            fireEvent.click(screen.getByText('Sum all')); // toggle the seeded shortcut back off
            fireEvent.click(save());
            const saved = (props.onSave as ReturnType<typeof vi.fn>).mock.calls[0][0].recipe;
            expect(saved).toEqual({ kind: 'formula', tag: 'Total flow', formula: '$TAG1 + $TAG2' });
        });

        it('does not offer the sensor itself, or an already-picked sensor, as an input to add', () => {
            renderEditor({
                recipe: operationRecipe,
                availableSensors: ['TAG1', 'TAG2', 'TAG3', 'Total flow'],
                sensorMetadata: [],
            });
            const options = Array.from(screen.getByLabelText('Add a source sensor').querySelectorAll('option'))
                .map(o => o.textContent);
            expect(options).not.toContain('Total flow');
            expect(options).not.toContain('TAG1');
            expect(options).toContain('TAG3');
        });

        it('shows source sensors by their description when metadata is available', () => {
            renderEditor({
                recipe: operationRecipe,
                sensorMetadata: [{ tag: 'TAG1', description: 'Boiler Pressure', unit: 'bar', component: 'Boiler' }],
            });
            // Appears twice by design -- once in this component's own Source
            // Sensors chips, once in `ButtonBuilder`'s "Combine with
            // operators" chips (both call the same `getSensorName`).
            expect(screen.getAllByText('Boiler Pressure').length).toBeGreaterThan(0);
            expect(screen.getAllByText('TAG2').length).toBeGreaterThan(0); // no metadata for TAG2 -- falls back to the raw tag
        });

        it('Compare one against the rest (Efficiency %) lets a source-sensor chip be clicked to mark the starting value', () => {
            const threeSource: SpecialSensorRecipe = {
                kind: 'operation', tag: 'Eff', sourceSensors: ['TAG1', 'TAG2'],
                operationConfig: { mode: 'multi', multiOp: { type: 'sum' }, customName: 'Eff' },
            };
            renderEditor({ recipe: threeSource, sensorMetadata: [] });
            fireEvent.click(screen.getByText(/Efficiency %/));
            expect(screen.getByText('Click a sensor above to mark it as the input.')).toBeTruthy();

            // "TAG2" appears twice -- this component's own (clickable)
            // Source Sensors chip, and again in `ButtonBuilder`'s
            // "Combine with operators" chips (not clickable for this). The
            // Source Sensors section renders first in the DOM.
            const tag2Chip = screen.getAllByText('TAG2')[0].closest('span')!;
            fireEvent.click(tag2Chip);
            fireEvent.click(save());
            expect(screen.queryByRole('alert')).toBeNull(); // sanity: no error path taken
        });

        it('freezes the form and says so while the caller is recomputing', () => {
            renderEditor({ recipe: operationRecipe, sensorMetadata: [], saving: true });
            expect(screen.getByText('Recomputing…')).toBeTruthy();
            expect(save().disabled).toBe(true);
        });
    });

    it('shows why the caller refused the last attempt', () => {
        renderEditor({ error: '"special A" can’t be built from special B — that would make it depend on itself.' });
        expect(screen.getByRole('alert').textContent).toContain('depend on itself');
    });
});
