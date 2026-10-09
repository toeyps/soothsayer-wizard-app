import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// The formula box is checked with `validate_formula` (debounced) once edited.
const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (cmd: string, args?: unknown) => mockInvoke(cmd, args),
}));
beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue({ valid: true, error: null, referenced_sensors: [] });
});
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
// Description/Unit/Component are required before Save enables -- tests that
// exercise the operation-building UI itself (not this validation) render
// with `sensorMetadata: []` (so these three start blank) and need this
// called first, same as a real user filling in the master-data fields.
const fillRequiredFields = () => {
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'A description' } });
    fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'kPa' } });
    // Component is a select restricted to existing components (see
    // `ComponentSelect`) -- "Uncategorized" is the one option guaranteed to
    // exist even when this test renders with `sensorMetadata: []`.
    fireEvent.change(screen.getByLabelText('Component'), { target: { value: 'Uncategorized' } });
};

describe('SpecialSensorEditor', () => {
    describe('formula-kind recipes — edited as raw text', () => {
        it('opens with the sensor’s current values, not blank fields', () => {
            renderEditor();
            expect((screen.getByLabelText('Formula') as HTMLTextAreaElement).value).toBe('$TAG1 * 2');
            expect((screen.getByLabelText('Description') as HTMLInputElement).value).toBe('Doubled');
            expect((screen.getByLabelText('Unit') as HTMLInputElement).value).toBe('bar');
        });

        it('opens the Name field editable, seeded with the current tag', () => {
            renderEditor();
            expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('special A');
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

        it('requires a component -- clearing it disables Save instead of silently falling back', () => {
            const { props } = renderEditor();
            fireEvent.change(screen.getByLabelText('Component'), { target: { value: '' } });
            expect(save().disabled).toBe(true);
            expect(screen.getByText(/Fill in a component/)).toBeTruthy();
            fireEvent.click(save());
            expect(props.onSave).not.toHaveBeenCalled();
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
            // shortcuts by its accent card styling (visual refresh Phase 5,
            // 2026-10-02: `.special-sensor-op-card.is-on`, replacing the old
            // inline accent `style.color`), same convention `SensorTooling`
            // itself uses (no separate "selected" text).
            const sumAll = screen.getByText('Sum all').closest('button') as HTMLButtonElement;
            expect(sumAll.className).toContain('is-on');
        });

        it('opens a single-sensor recipe with its sensor, operation and value already filled in', () => {
            renderEditor({ recipe: singleRecipe, sensorMetadata: [] });
            expect(screen.getByText('TAG1')).toBeTruthy();
            const addBtn = screen.getByText('Add').closest('button') as HTMLButtonElement;
            expect(addBtn.className).toContain('is-on');
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
            fillRequiredFields();
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
            fillRequiredFields();
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
            fillRequiredFields();
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
            fillRequiredFields();
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
            const { props } = renderEditor({ recipe: threeSource, sensorMetadata: [] });
            fireEvent.click(screen.getByText(/Efficiency %/));
            expect(screen.getByText('Click a sensor above to mark it as the input.')).toBeTruthy();

            // "TAG2" appears twice -- this component's own (clickable)
            // Source Sensors chip, and again in `ButtonBuilder`'s
            // "Combine with operators" chips (not clickable for this). The
            // Source Sensors section renders first in the DOM.
            const tag2Chip = screen.getAllByText('TAG2')[0].closest('span')!;
            fireEvent.click(tag2Chip);
            fillRequiredFields();
            fireEvent.click(save());
            expect(screen.queryByRole('alert')).toBeNull(); // sanity: no error path taken
            expect(props.onSave).toHaveBeenCalled();
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

    // The Name field used to be a fixed, disabled display -- it's now a real
    // input. This component only collects the new name and flags that a
    // rename happened (`renamedFrom`); the actual cascade across every other
    // recipe / dashboard state slice / model is `AddSensorWindow`'s job (see
    // `AddSensorWindow.test.tsx`).
    describe('renaming', () => {
        it('leaves renamedFrom unset when the name is untouched', () => {
            const { props } = renderEditor();
            fireEvent.click(save());
            expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({ renamedFrom: undefined }));
        });

        it('typing a new, unused name and saving reports the rename', () => {
            const { props } = renderEditor();
            fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'special A2' } });
            fireEvent.click(save());
            expect(props.onSave).toHaveBeenCalledWith({
                recipe: { kind: 'formula', tag: 'special A2', formula: '$TAG1 * 2' },
                metadata: { tag: 'special A2', description: 'Doubled', unit: 'bar', component: 'Pump' },
                renamedFrom: 'special A',
            });
        });

        it('does not flag a rename just because the surrounding text was trimmed', () => {
            const { props } = renderEditor();
            fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  special A  ' } });
            fireEvent.click(save());
            expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({ renamedFrom: undefined }));
        });

        it('blocks an empty name', () => {
            renderEditor();
            fireEvent.change(screen.getByLabelText('Name'), { target: { value: '   ' } });
            expect(screen.getByText('Name is required')).toBeTruthy();
            expect(save().disabled).toBe(true);
        });

        it('blocks renaming to a tag already in use by another sensor', () => {
            const { props } = renderEditor({ availableSensors: ['TAG1', 'TAG2', 'Total flow'] });
            fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Total flow' } });
            expect(screen.getByText(/already in use by another sensor/)).toBeTruthy();
            expect(save().disabled).toBe(true);
            fireEvent.click(save());
            expect(props.onSave).not.toHaveBeenCalled();
        });

        it('the collision check is case-insensitive, same as every other tag match in the app', () => {
            renderEditor({ availableSensors: ['TAG1', 'total flow'] });
            fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'TOTAL FLOW' } });
            expect(screen.getByText(/already in use by another sensor/)).toBeTruthy();
        });

        it('blocks a name containing "}" -- a formula has no way to refer to it', () => {
            const { props } = renderEditor();
            fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'bad}name' } });
            expect(screen.getByRole('alert').textContent).toMatch(/can't contain "}"/);
            expect(save().disabled).toBe(true);
            fireEvent.click(save());
            expect(props.onSave).not.toHaveBeenCalled();
        });

        it('blocks renaming to the name the time column goes by', () => {
            renderEditor();
            fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Timestamp' } });
            expect(screen.getByRole('alert').textContent).toMatch(/reserved/);
            expect(save().disabled).toBe(true);
        });

        it('a case-only rename is allowed (the backend overwrites that same column in place)', () => {
            const { props } = renderEditor({ availableSensors: ['TAG1', 'special A'] });
            fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'SPECIAL A' } });
            expect(save().disabled).toBe(false);
            fireEvent.click(save());
            expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({ renamedFrom: 'special A' }));
        });

        it('does not treat the sensor’s own unchanged name as a collision, even when it is in availableSensors', () => {
            renderEditor({ availableSensors: ['TAG1', 'special A'] });
            // Name field starts equal to `recipe.tag` and is never touched.
            expect(screen.queryByText(/already in use by another sensor/)).toBeNull();
            expect(save().disabled).toBe(false);
        });
    });

    // Name + Description + Unit + Component are all required before Save
    // enables -- mirrors the same rule Create enforces (see
    // `AddSensorWindow.test.tsx`), so a sensor can't leave this form
    // half-described either. The Component-specific case (clearing it) is
    // covered inline above; this covers the rest.
    describe('required fields', () => {
        it('lists every currently-missing field in the hint, and updates as they are filled', () => {
            renderEditor({ recipe: operationRecipe, sensorMetadata: [] });
            expect(screen.getByText('Fill in a description, a unit, a component before saving.')).toBeTruthy();
            expect(save().disabled).toBe(true);

            fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Combined flow' } });
            expect(screen.getByText('Fill in a unit, a component before saving.')).toBeTruthy();

            fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'm3/h' } });
            fireEvent.change(screen.getByLabelText('Component'), { target: { value: 'Uncategorized' } });
            expect(screen.queryByText(/Fill in/)).toBeNull();
            expect(save().disabled).toBe(false);
        });
    });

    // Edit lock (2026-10-03): used by a model / the Running condition.
    describe('locked (lockMessage set)', () => {
        const lockMessage = 'Used by 1 model: Pump model (Individual). Remove it from those models first, then you can edit it.';

        it('shows the banner with the reason and leaves Name and Formula read-only (the stored values, not local edits)', () => {
            renderEditor({ lockMessage });
            const banner = screen.getByTestId('edit-lock-banner');
            expect(banner.textContent).toContain('Name and formula are locked.');
            expect(banner.textContent).toContain(lockMessage);
            expect(banner.textContent).toContain('You can still change the description, unit and component.');
            const name = screen.getByLabelText('Name') as HTMLInputElement;
            expect(name.readOnly).toBe(true);
            expect(name.value).toBe('special A');
            const formula = screen.getByLabelText('Formula') as HTMLTextAreaElement;
            expect(formula.readOnly).toBe(true);
            expect(formula.value).toBe('$TAG1 * 2');
            expect((screen.getByLabelText('Description') as HTMLInputElement).readOnly).toBe(false);
            expect(screen.queryByText(/can't be renamed/)).toBeNull();
        });

        it('an operation sensor shows its calculation read-only, with no source picker', () => {
            renderEditor({ recipe: operationRecipe, sensorMetadata: [], lockMessage });
            const calc = screen.getByLabelText('Calculation') as HTMLTextAreaElement;
            expect(calc.readOnly).toBe(true);
            expect(calc.value).toBe('sum(TAG1, TAG2)');
            expect(screen.queryByLabelText('Add a source sensor')).toBeNull();
            expect(screen.queryByLabelText('Remove TAG1')).toBeNull();
        });

        it('Save sends the STORED recipe back unchanged, with only the descriptive fields changed and no renamedFrom', () => {
            const { props } = renderEditor({ lockMessage });
            fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Doubled pressure' } });
            fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'kPa' } });
            expect(save().disabled).toBe(false);
            fireEvent.click(save());
            expect(props.onSave).toHaveBeenCalledTimes(1);
            const arg = (props.onSave as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(arg.recipe).toBe(formulaRecipe);
            expect(arg.renamedFrom).toBeUndefined();
            expect(arg.metadata).toMatchObject({ tag: 'special A', description: 'Doubled pressure', unit: 'kPa', component: 'Pump' });
        });

        it('for an operation sensor the stored operation (not a rebuilt one) is what Save sends', () => {
            const { props } = renderEditor({ recipe: operationRecipe, sensorMetadata: [], lockMessage });
            fillRequiredFields();
            fireEvent.click(save());
            expect((props.onSave as ReturnType<typeof vi.fn>).mock.calls[0][0].recipe).toBe(operationRecipe);
        });

        it('still needs description / unit / component, but never asks for a name', () => {
            renderEditor({ sensorMetadata: [], lockMessage });
            expect(screen.getByText('Fill in a description, a unit, a component before saving.')).toBeTruthy();
            expect(save().disabled).toBe(true);
        });

        it('without lockMessage the editor is the normal editable one', () => {
            renderEditor({ lockMessage: null });
            expect(screen.queryByTestId('edit-lock-banner')).toBeNull();
            expect((screen.getByLabelText('Name') as HTMLInputElement).readOnly).toBe(false);
            expect((screen.getByLabelText('Formula') as HTMLTextAreaElement).readOnly).toBe(false);
        });
    });

    // 2026-10-08 (review S1): a sensor whose recipe Rust now refuses could not
    // be rebuilt on reopen. Under a lock that was a dead end -- formula frozen,
    // Save re-sent the refused recipe. Now the values unlock; the name does not.
    describe('not restored (restore set)', () => {
        const lockMessage = 'Used by 1 model: Pump model (Individual). Remove it from those models first, then you can edit it.';
        const REASON = 'Formula error: round($TAG1, 2) does not round to 2 decimal places. Write round($TAG1 * 100) / 100 instead.';
        const broken: SpecialSensorRecipe = { kind: 'formula', tag: 'special A', formula: 'round($TAG1, 2)' };

        it('LOCKED + not restored: the amber note quotes the reason, the formula is editable, the Name stays read-only, no lock banner', () => {
            renderEditor({ recipe: broken, lockMessage, restore: { reason: REASON } });
            const note = screen.getByTestId('restore-note');
            expect(note.textContent).toContain(
                `This sensor could not be restored: ${REASON.replace(/\.$/, '')}. Fix the formula to restore it. Models that use it are set back to Incomplete and must be trained again.`,
            );
            expect(note.textContent).toContain('Its name stays locked while it is in use.');
            expect(screen.queryByTestId('edit-lock-banner')).toBeNull();
            expect((screen.getByLabelText('Name') as HTMLInputElement).readOnly).toBe(true);
            expect((screen.getByLabelText('Formula') as HTMLTextAreaElement).readOnly).toBe(false);
        });

        it('a fixed formula is saved under the SAME name, with no renamedFrom', () => {
            const { props } = renderEditor({ recipe: broken, lockMessage, restore: { reason: REASON } });
            fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'renamed' } }); // read-only: ignored
            fireEvent.change(screen.getByLabelText('Formula'), { target: { value: 'round($TAG1 * 100) / 100' } });
            fireEvent.click(save());
            const arg = (props.onSave as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(arg.recipe).toEqual({ kind: 'formula', tag: 'special A', formula: 'round($TAG1 * 100) / 100' });
            expect(arg.renamedFrom).toBeUndefined();
            expect(arg.metadata.tag).toBe('special A');
        });

        it('a description-only save sends the stored formula text unchanged (the caller then skips the recompute)', () => {
            const { props } = renderEditor({ recipe: broken, lockMessage, restore: { reason: REASON } });
            fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Rounded' } });
            fireEvent.click(save());
            const arg = (props.onSave as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(arg.recipe).toEqual(broken);
            expect(arg.metadata.description).toBe('Rounded');
        });

        it('NOT locked + not restored: the note has no models sentence and the Name stays editable', () => {
            renderEditor({ recipe: broken, restore: { reason: null } });
            const note = screen.getByTestId('restore-note');
            expect(note.textContent).toContain('This sensor could not be restored: its calculation could not be run on this dataset. Fix the formula to restore it.');
            expect(note.textContent).not.toMatch(/trained again/);
            expect((screen.getByLabelText('Name') as HTMLInputElement).readOnly).toBe(false);
        });

        it('an operation sensor that was not restored gets its source picker back and a matching note', () => {
            renderEditor({ recipe: operationRecipe, sensorMetadata: [], lockMessage, restore: { reason: 'Sensor not found: TAG2' } });
            expect(screen.getByTestId('restore-note').textContent).toContain('Sensor not found: TAG2. Fix its calculation or sources to restore it.');
            expect(screen.getByLabelText('Add a source sensor')).toBeTruthy();
            expect(screen.getByLabelText('Remove TAG2')).toBeTruthy();
        });

        // MUST-FIX 1c (2026-10-08 review): `restore` can disappear while the
        // form is open (the session check briefly can't answer, or re-ran).
        // It used to flip the editor to the locked view, and Save then sent
        // the STORED broken recipe -- silently dropping the typed fix.
        it('restore going away mid-edit keeps the typed formula editable, and Save sends the TYPED formula (never the stored one)', () => {
            const { props, rerender } = renderEditor({ recipe: broken, lockMessage, restore: { reason: REASON } });
            fireEvent.change(screen.getByLabelText('Formula'), { target: { value: 'round($TAG1 * 100) / 100' } });
            rerender(<SpecialSensorEditor {...props} restore={null} />);
            const formula = screen.getByLabelText('Formula') as HTMLTextAreaElement;
            expect(formula.readOnly).toBe(false);
            expect(formula.value).toBe('round($TAG1 * 100) / 100');
            expect(screen.queryByTestId('edit-lock-banner')).toBeNull();
            expect(screen.getByTestId('restore-note')).toBeTruthy(); // latched for the session
            fireEvent.click(save());
            expect((props.onSave as ReturnType<typeof vi.fn>).mock.calls[0][0].recipe)
                .toEqual({ kind: 'formula', tag: 'special A', formula: 'round($TAG1 * 100) / 100' });
        });

        it('restore going away before anything was typed also stays unlocked for the session (the caller re-checks)', () => {
            const { props, rerender } = renderEditor({ recipe: broken, lockMessage, restore: { reason: REASON } });
            rerender(<SpecialSensorEditor {...props} restore={null} />);
            expect((screen.getByLabelText('Formula') as HTMLTextAreaElement).readOnly).toBe(false);
        });

        it('a lock that arrives AFTER the calculation was edited keeps the typed values under a warning and sends them (no silent metadata-only save)', () => {
            const { props, rerender } = renderEditor({ lockMessage: null });
            fireEvent.change(screen.getByLabelText('Formula'), { target: { value: '$TAG1 * 5' } });
            rerender(<SpecialSensorEditor {...props} lockMessage={lockMessage} />);
            expect(screen.getByTestId('edit-lock-late').textContent).toContain('This sensor is now locked.');
            expect(screen.queryByTestId('edit-lock-banner')).toBeNull();
            const formula = screen.getByLabelText('Formula') as HTMLTextAreaElement;
            expect(formula.value).toBe('$TAG1 * 5');
            fireEvent.click(save());
            expect((props.onSave as ReturnType<typeof vi.fn>).mock.calls[0][0].recipe)
                .toEqual({ kind: 'formula', tag: 'special A', formula: '$TAG1 * 5' });
        });

        // SHOULD-FIX 3: the caller's "nothing but the description changed"
        // shortcut compares recipes; an engine that rebuilds an operation
        // config differently from what is stored made a unit-only save of a
        // not-restored operation sensor recompute (and fail) anyway.
        it('an untouched OPERATION calculation sends the STORED recipe object, even when the engine would rebuild it differently', () => {
            const legacy: SpecialSensorRecipe = {
                kind: 'operation',
                tag: 'Shifted',
                sourceSensors: ['GONE'],
                // `multiOp` is leftover junk next to the single op: the engine
                // never produces it, so a rebuild would not be equivalent.
                operationConfig: { mode: 'single', singleOp: { type: 'add', value: 10 }, multiOp: { type: 'sum' }, customName: 'Shifted' },
            };
            const { props } = renderEditor({ recipe: legacy, sensorMetadata: [], lockMessage, restore: { reason: 'Sensor not found: GONE' } });
            fillRequiredFields();
            fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'kPa' } });
            fireEvent.click(save());
            const arg = (props.onSave as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(arg.recipe).toEqual(legacy);
            expect(arg.metadata.unit).toBe('kPa');
        });

        it('LOCKED + healthy (no restore) is unchanged: banner, read-only formula, no note', () => {
            renderEditor({ lockMessage, restore: null });
            expect(screen.getByTestId('edit-lock-banner')).toBeTruthy();
            expect(screen.queryByTestId('restore-note')).toBeNull();
            expect((screen.getByLabelText('Formula') as HTMLTextAreaElement).readOnly).toBe(true);
        });
    });

    // 2026-10-08: the editor never validated; a bad formula could be saved and
    // the failure only surfaced (if at all) after the recompute.
    describe('formula validation (validate_formula)', () => {
        it('shows the check’s error in red under the formula and disables Save until the formula is fixed', async () => {
            vi.useFakeTimers();
            try {
                mockInvoke.mockImplementation(async (_cmd: string, args: any) => (
                    args.formula.includes('foo(')
                        ? { valid: false, error: "Formula error: unknown function 'foo'. Available functions: abs, sqrt, pow, exp, ln, log (base 10), log10, round, min, max, ceil, floor, sin, cos, tan, pi(), e().", referenced_sensors: ['TAG1'] }
                        : { valid: true, error: null, referenced_sensors: ['TAG1'] }
                ));
                renderEditor();
                fireEvent.change(screen.getByLabelText('Formula'), { target: { value: 'foo($TAG1)' } });
                expect(save().disabled).toBe(false); // not checked yet: Save is not blocked on a pending check
                await act(async () => { await vi.advanceTimersByTimeAsync(400); });

                expect(mockInvoke).toHaveBeenCalledWith('validate_formula', { formula: 'foo($TAG1)' });
                expect(screen.getByTestId('formula-error').textContent).toBe("Formula error: unknown function 'foo'. Available functions: abs, sqrt, pow, exp, ln, log (base 10), log10, round, min, max, ceil, floor, sin, cos, tan, pi(), e().");
                expect(screen.getByLabelText('Formula').getAttribute('aria-invalid')).toBe('true');
                expect(save().disabled).toBe(true);

                fireEvent.change(screen.getByLabelText('Formula'), { target: { value: 'abs($TAG1)' } });
                expect(screen.queryByTestId('formula-error')).toBeNull(); // the old text's verdict doesn't stick
                await act(async () => { await vi.advanceTimersByTimeAsync(400); });
                expect(screen.queryByTestId('formula-error')).toBeNull();
                expect(save().disabled).toBe(false);
            } finally {
                vi.useRealTimers();
            }
        });

        // 2026-10-08: the live check is pinned to the window's dataset, and a
        // STALE_SESSION answer is "no information" -- never a red formula error.
        it('sends expectedGeneration when the window has one; a STALE_SESSION reply shows no formula error and does not block Save', async () => {
            vi.useFakeTimers();
            try {
                mockInvoke.mockImplementation(async () => { throw 'STALE_SESSION: the dataset changed since this window was opened'; });
                renderEditor({ generation: 7 });
                fireEvent.change(screen.getByLabelText('Formula'), { target: { value: '$TAG1 * 3' } });
                await act(async () => { await vi.advanceTimersByTimeAsync(400); });
                expect(mockInvoke).toHaveBeenCalledWith('validate_formula', { formula: '$TAG1 * 3', expectedGeneration: 7 });
                expect(screen.queryByTestId('formula-error')).toBeNull();
                expect(save().disabled).toBe(false);
            } finally {
                vi.useRealTimers();
            }
        });

        it('without a generation the check is sent exactly as before (no expectedGeneration key)', async () => {
            vi.useFakeTimers();
            try {
                renderEditor();
                fireEvent.change(screen.getByLabelText('Formula'), { target: { value: '$TAG1 * 3' } });
                await act(async () => { await vi.advanceTimersByTimeAsync(400); });
                expect(mockInvoke).toHaveBeenCalledWith('validate_formula', { formula: '$TAG1 * 3' });
            } finally {
                vi.useRealTimers();
            }
        });

        it('does not validate the stored formula just by opening the editor', async () => {
            vi.useFakeTimers();
            try {
                renderEditor();
                await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
                expect(mockInvoke).not.toHaveBeenCalled();
            } finally {
                vi.useRealTimers();
            }
        });
    });

    // 2026-10-08: any source change used to clear the picked operation, so
    // e.g. an "Average all" with one more source was saved as `$A + $B + $C`.
    describe('changing the sources keeps an operation that still applies', () => {
        const fill = () => fillRequiredFields();
        it('Sum all stays Sum all when a source is added', () => {
            const { props } = renderEditor({ recipe: operationRecipe, sensorMetadata: [] });
            fireEvent.change(screen.getByLabelText('Add a source sensor'), { target: { value: 'TAG3' } });
            fill();
            fireEvent.click(save());
            expect((props.onSave as any).mock.calls[0][0].recipe).toEqual({
                kind: 'operation', tag: 'Total flow', sourceSensors: ['TAG1', 'TAG2', 'TAG3'],
                operationConfig: { mode: 'multi', multiOp: { type: 'sum' }, customName: 'Total flow' },
            });
        });

        it('Average all of three stays an average when one source is removed', () => {
            const avg3: SpecialSensorRecipe = {
                kind: 'operation', tag: 'Avg', sourceSensors: ['TAG1', 'TAG2', 'TAG3'],
                operationConfig: { mode: 'multi', multiOp: { type: 'mean' }, customName: 'Avg' },
            };
            const { props } = renderEditor({ recipe: avg3, sensorMetadata: [] });
            fireEvent.click(screen.getByLabelText('Remove TAG2'));
            fill();
            fireEvent.click(save());
            expect((props.onSave as any).mock.calls[0][0].recipe).toEqual({
                kind: 'operation', tag: 'Avg', sourceSensors: ['TAG1', 'TAG3'],
                operationConfig: { mode: 'multi', multiOp: { type: 'mean' }, customName: 'Avg' },
            });
        });

        // (A direct one-for-one swap keeps a single-sensor op -- see
        // `sourceChangeEffect` and SensorTooling.test.tsx. This form can only
        // remove then add, which passes through "no source" = start over.)
        it('removing the only source then adding another starts the single-sensor form fresh, and the new pick is saved', () => {
            const { props } = renderEditor({ recipe: singleRecipe, availableSensors: ['TAG1', 'TAG2'], sensorMetadata: [] });
            fireEvent.click(screen.getByLabelText('Remove TAG1')); // none left: the hint replaces the builder
            fireEvent.change(screen.getByLabelText('Add a source sensor'), { target: { value: 'TAG2' } });
            expect(screen.queryByText('Value')).toBeNull();
            fireEvent.click(screen.getByText('Add'));
            fireEvent.change(valueInput(), { target: { value: '7' } });
            fill();
            fireEvent.click(save());
            expect((props.onSave as any).mock.calls[0][0].recipe).toMatchObject({
                sourceSensors: ['TAG2'],
                operationConfig: { mode: 'single', singleOp: { type: 'add', value: 7 } },
            });
        });
    });
});
