import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SensorAutocomplete, SensorPickerModal } from '../components/windows/SensorPickers';

// Moved here (2026-10-04, health score phase 4) from PredictiveModelBuild.test.tsx
// when the Predictive Model page was deleted: these two components were its
// shared exports, and the page-level tests were the only place their real
// search / grouping / single-vs-multi behaviour was exercised. They are now
// tested DIRECTLY against the real implementations (BuildModelWindow.test.tsx,
// ModelFitPage.test.tsx and RunningConditionPanel.test.tsx mock them out).

const SEARCH_PLACEHOLDER = 'Search sensor tag or description...';

describe('SensorAutocomplete', () => {
    // 2026-09-18: optional component-grouping, added for BuildModelWindow's
    // predictor picker (per explicit user request: "แสดงผลเป็น by component
    // ได้ไหม ... สามารถ search ได้ด้วย").
    const sensors = ['TAG1', 'TAG2', 'TAG3'];
    const descriptions: Record<string, string> = { TAG1: 'Pump Pressure', TAG2: 'Pump Temp' }; // TAG3: no description
    const components: Record<string, string> = { TAG1: 'Pump', TAG2: 'Pump' }; // TAG3: no component
    const getDesc = (tag: string) => descriptions[tag] ?? '';
    const getComponent = (tag: string) => components[tag] ?? '';

    afterEach(cleanup);

    it('stays a flat list when getComponent is omitted (default/backward-compatible behavior for every other caller)', () => {
        render(
            <SensorAutocomplete sensors={sensors} getDesc={getDesc} value="" onSelect={() => {}} placeholder="Search…" />
        );
        // A non-empty query both opens the dropdown and is needed to trigger
        // React's onChange at all here -- firing `change` with the same
        // value the input already holds (`''`) is a silent no-op.
        fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'TAG' } });
        expect(document.querySelectorAll('.sensor-autocomplete-group-header').length).toBe(0);
        expect(screen.getByText('TAG1')).toBeTruthy();
    });

    it('groups options under a component header, alphabetically, with an "Uncategorized" fallback for sensors with no component', () => {
        render(
            <SensorAutocomplete sensors={sensors} getDesc={getDesc} getComponent={getComponent} value="" onSelect={() => {}} placeholder="Search…" />
        );
        fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'TAG' } });
        const headers = Array.from(document.querySelectorAll('.sensor-autocomplete-group-header')).map(el => el.textContent);
        expect(headers).toEqual(['Pump', 'Uncategorized']);
    });

    it('search still narrows the grouped list, not just the flat one', () => {
        render(
            <SensorAutocomplete sensors={sensors} getDesc={getDesc} getComponent={getComponent} value="" onSelect={() => {}} placeholder="Search…" />
        );
        fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'Pump Temp' } });
        expect(screen.getByText('TAG2')).toBeTruthy(); // matched by its description "Pump Temp"
        expect(screen.getByText('Pump Temp')).toBeTruthy();
        expect(screen.queryByText('TAG3')).toBeNull();
        // Only the matching sensor's own component group renders.
        const headers = Array.from(document.querySelectorAll('.sensor-autocomplete-group-header')).map(el => el.textContent);
        expect(headers).toEqual(['Pump']);
    });

    it('clicking a grouped item still selects it and closes the dropdown', () => {
        const onSelect = vi.fn();
        render(
            <SensorAutocomplete sensors={sensors} getDesc={getDesc} getComponent={getComponent} value="" onSelect={onSelect} placeholder="Search…" clearOnSelect />
        );
        fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'TAG3' } });
        fireEvent.click(screen.getByText('TAG3')); // Uncategorized group, bare tag (no description)
        expect(onSelect).toHaveBeenCalledWith('TAG3');
        expect(screen.queryByText('Uncategorized')).toBeNull(); // dropdown closed
    });
});

describe('SensorPickerModal', () => {
    const sensors = ['PRED1', 'PRED2', 'OTHER1'];
    const descriptions: Record<string, string> = { PRED1: 'Predictor One', PRED2: 'Predictor Two' }; // OTHER1: no description
    const components: Record<string, string> = { PRED1: 'Motor', PRED2: 'Motor', OTHER1: 'Pump' };
    const getDesc = (tag: string) => descriptions[tag] ?? '';
    const getComponent = (tag: string) => components[tag] ?? '';

    afterEach(cleanup);

    describe('multi-select (default)', () => {
        const renderMulti = (props: Partial<React.ComponentProps<typeof SensorPickerModal>> = {}) => {
            const onConfirm = vi.fn();
            render(
                <SensorPickerModal
                    sensors={sensors}
                    getDesc={getDesc}
                    getComponent={getComponent}
                    noun="predictor sensors"
                    selected={[]}
                    onConfirm={onConfirm}
                    {...props}
                />,
            );
            return { onConfirm };
        };

        it('shows an "Add {noun}…" trigger (or the triggerText override) and opens a dialog on click', () => {
            renderMulti();
            expect(screen.queryByRole('dialog')).toBeNull();
            fireEvent.click(screen.getByText('Add predictor sensors…'));
            expect(screen.getByRole('dialog', { name: 'Select predictor sensors' })).toBeTruthy();
        });

        it('triggerText replaces the default trigger label', () => {
            renderMulti({ triggerText: '3 selected. Edit predictors...' });
            expect(screen.getByText('3 selected. Edit predictors...')).toBeTruthy();
            expect(screen.queryByText('Add predictor sensors…')).toBeNull();
        });

        it('groups sensors by component (alphabetical) and starts every group collapsed until searched', () => {
            renderMulti();
            fireEvent.click(screen.getByText('Add predictor sensors…'));
            const names = Array.from(document.querySelectorAll('.predictor-picker-group-name')).map(el => el.textContent);
            expect(names).toEqual(['Motor', 'Pump']);
            expect(screen.queryByText('PRED1')).toBeNull(); // collapsed - member hidden

            fireEvent.click(screen.getByText('Motor'));
            expect(screen.getByText('PRED1')).toBeTruthy(); // expanded - member visible

            // A non-empty search forces every matching group open.
            fireEvent.change(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), { target: { value: 'OTHER' } });
            expect(screen.getByText('OTHER1')).toBeTruthy();
            expect(screen.queryByText('PRED1')).toBeNull();
        });

        it('search matches the tag and the description', () => {
            renderMulti();
            fireEvent.click(screen.getByText('Add predictor sensors…'));
            fireEvent.change(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), { target: { value: 'predictor two' } });
            expect(screen.getByText('PRED2')).toBeTruthy();
            expect(screen.queryByText('PRED1')).toBeNull();
        });

        it('shows "No sensors found" when nothing matches', () => {
            renderMulti();
            fireEvent.click(screen.getByText('Add predictor sensors…'));
            fireEvent.change(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), { target: { value: 'zzz-none' } });
            expect(screen.getByText('No sensors found')).toBeTruthy();
        });

        it('checks several sensors, then OK commits the whole selection once', () => {
            const { onConfirm } = renderMulti();
            fireEvent.click(screen.getByText('Add predictor sensors…'));
            fireEvent.change(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), { target: { value: 'PRED' } });
            fireEvent.click(screen.getByText('PRED1'));
            fireEvent.click(screen.getByText('PRED2'));
            expect(screen.getByText('2 selected')).toBeTruthy();
            expect(onConfirm).not.toHaveBeenCalled(); // staged only

            fireEvent.click(screen.getByText('OK'));
            expect(onConfirm).toHaveBeenCalledTimes(1);
            expect(onConfirm).toHaveBeenCalledWith(['PRED1', 'PRED2']);
            expect(screen.queryByRole('dialog')).toBeNull();
        });

        it('Cancel discards a pending change', () => {
            const { onConfirm } = renderMulti();
            fireEvent.click(screen.getByText('Add predictor sensors…'));
            fireEvent.change(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), { target: { value: 'PRED1' } });
            fireEvent.click(screen.getByText('PRED1'));
            fireEvent.click(screen.getByText('Cancel'));
            expect(onConfirm).not.toHaveBeenCalled();
            expect(screen.queryByRole('dialog')).toBeNull();
        });

        it('Escape and a backdrop click also close without committing', () => {
            const { onConfirm } = renderMulti();
            fireEvent.click(screen.getByText('Add predictor sensors…'));
            fireEvent.change(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), { target: { value: 'PRED1' } });
            fireEvent.click(screen.getByText('PRED1'));
            fireEvent.keyDown(window, { key: 'Escape' });
            expect(screen.queryByRole('dialog')).toBeNull();

            fireEvent.click(screen.getByText('Add predictor sensors…'));
            fireEvent.click(document.querySelector('.predictor-picker-backdrop') as HTMLElement);
            expect(screen.queryByRole('dialog')).toBeNull();
            expect(onConfirm).not.toHaveBeenCalled();
        });

        it('reopening starts from the last CONFIRMED selection, not a cancelled attempt', () => {
            renderMulti({ selected: ['PRED1'] });
            fireEvent.click(screen.getByText('Add predictor sensors…'));
            expect(screen.getByText('1 selected')).toBeTruthy();
            fireEvent.change(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), { target: { value: 'PRED2' } });
            fireEvent.click(screen.getByText('PRED2'));
            expect(screen.getByText('2 selected')).toBeTruthy();
            fireEvent.click(screen.getByText('Cancel'));

            fireEvent.click(screen.getByText('Add predictor sensors…'));
            expect(screen.getByText('1 selected')).toBeTruthy();
        });

        it('a group header shows "checked/total" once something inside it is checked', () => {
            renderMulti({ selected: ['PRED1'] });
            fireEvent.click(screen.getByText('Add predictor sensors…'));
            const motorHeader = screen.getByText('Motor').closest('button') as HTMLElement;
            expect(motorHeader.querySelector('.pm-count-pill')?.textContent).toBe('1/2');
        });

        it('never offers an excluded sensor (e.g. the model\'s own target)', () => {
            renderMulti({ excluded: ['PRED1'] });
            fireEvent.click(screen.getByText('Add predictor sensors…'));
            fireEvent.change(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), { target: { value: 'PRED' } });
            expect(screen.queryByText('PRED1')).toBeNull();
            expect(screen.getByText('PRED2')).toBeTruthy();
        });

        it('a disabled trigger does not open the popup', () => {
            renderMulti({ disabled: true });
            const trigger = screen.getByText('Add predictor sensors…').closest('button') as HTMLButtonElement;
            expect(trigger.disabled).toBe(true);
            fireEvent.click(trigger);
            expect(screen.queryByRole('dialog')).toBeNull();
        });

        it('renders one flat, unlabeled group when getComponent is omitted', () => {
            renderMulti({ getComponent: undefined });
            fireEvent.click(screen.getByText('Add predictor sensors…'));
            expect(document.querySelectorAll('.predictor-picker-group-header').length).toBe(0);
            expect(screen.getByText('PRED1')).toBeTruthy(); // visible without expanding anything
            expect(screen.getByText('OTHER1')).toBeTruthy();
        });
    });

    describe('single-select (single)', () => {
        const renderSingle = (props: Partial<React.ComponentProps<typeof SensorPickerModal>> = {}) => {
            const onSelect = vi.fn();
            render(
                <SensorPickerModal
                    single
                    sensors={sensors}
                    getDesc={getDesc}
                    getComponent={getComponent}
                    noun="X sensor"
                    value=""
                    onSelect={onSelect}
                    {...props}
                />,
            );
            return { onSelect };
        };

        it('the trigger shows the placeholder (default "Pick {noun}...") when empty, then the "desc (TAG)" label when set', () => {
            const { unmount } = render(
                <SensorPickerModal single sensors={sensors} getDesc={getDesc} noun="X sensor" value="" onSelect={() => {}} />,
            );
            expect(screen.getByText('Pick X sensor...')).toBeTruthy();
            unmount();

            render(<SensorPickerModal single sensors={sensors} getDesc={getDesc} noun="X sensor" value="PRED1" onSelect={() => {}} />);
            expect(screen.getByText('Predictor One (PRED1)')).toBeTruthy();
        });

        it('placeholder overrides the empty-state text', () => {
            renderSingle({ placeholder: 'No predictors selected' });
            expect(screen.getByText('No predictors selected')).toBeTruthy();
        });

        it('mutedTag renders the tag in its own muted element, same text content', () => {
            renderSingle({ value: 'PRED1', mutedTag: true });
            const label = document.querySelector('.sensor-picker-trigger-label') as HTMLElement;
            expect(label.textContent).toBe('Predictor One (PRED1)');
            expect(label.querySelector('.sensor-picker-tag')?.textContent).toBe('(PRED1)');
        });

        it("the trigger's icon uses its own class, not .sensor-autocomplete-icon (regression 2026-09-22: that class is position:absolute, meant to overlay a real <input> inside .sensor-autocomplete-input-wrap -- this button has no such wrapper, so the icon escaped to whatever ancestor WAS positioned)", () => {
            renderSingle();
            const trigger = screen.getByText('Pick X sensor...').closest('button') as HTMLButtonElement;
            expect(trigger.querySelector('.sensor-picker-trigger-icon')).toBeTruthy();
            expect(trigger.querySelector('.sensor-autocomplete-icon')).toBeNull();
        });

        it("the trigger's label carries the truncation class (regression 2026-09-23: a long description wrapped onto a second line in a narrow row)", () => {
            renderSingle({ value: 'PRED1' });
            const trigger = screen.getByText(/PRED1/).closest('button') as HTMLButtonElement;
            expect((trigger.querySelector('span') as HTMLElement).className).toContain('sensor-picker-trigger-label');
        });

        it('picking a row selects it and closes IMMEDIATELY - no OK / Cancel footer at all', () => {
            const { onSelect } = renderSingle();
            fireEvent.click(screen.getByText('Pick X sensor...'));
            expect(screen.queryByText('OK')).toBeNull();
            expect(screen.queryByText('Cancel')).toBeNull();

            fireEvent.change(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), { target: { value: 'PRED2' } });
            fireEvent.click(screen.getByText('PRED2'));
            expect(onSelect).toHaveBeenCalledWith('PRED2');
            expect(screen.queryByRole('dialog')).toBeNull();
        });

        it('allowNone adds a "None" row that clears the selection', () => {
            const { onSelect } = renderSingle({ value: 'PRED1', allowNone: true });
            fireEvent.click(screen.getByText('Predictor One (PRED1)'));
            fireEvent.click(screen.getByText('None'));
            expect(onSelect).toHaveBeenCalledWith('');
            expect(screen.queryByRole('dialog')).toBeNull();
        });

        it('without allowNone there is no "None" row', () => {
            renderSingle();
            fireEvent.click(screen.getByText('Pick X sensor...'));
            expect(screen.queryByText('None')).toBeNull();
        });

        it('marks the current value\'s row as checked', () => {
            renderSingle({ value: 'PRED1' });
            fireEvent.click(screen.getByText('Predictor One (PRED1)'));
            fireEvent.change(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), { target: { value: 'PRED' } });
            const row = screen.getByText('PRED1').closest('button') as HTMLElement;
            expect(row.className).toContain('checked');
            expect((screen.getByText('PRED2').closest('button') as HTMLElement).className).not.toContain('checked');
        });

        it('Escape closes without selecting', () => {
            const { onSelect } = renderSingle();
            fireEvent.click(screen.getByText('Pick X sensor...'));
            fireEvent.keyDown(window, { key: 'Escape' });
            expect(screen.queryByRole('dialog')).toBeNull();
            expect(onSelect).not.toHaveBeenCalled();
        });

        it('a disabled trigger (e.g. no predictors yet) does not open', () => {
            renderSingle({ disabled: true, placeholder: 'No predictors selected' });
            const trigger = screen.getByText('No predictors selected').closest('button') as HTMLButtonElement;
            expect(trigger.disabled).toBe(true);
            fireEvent.click(trigger);
            expect(screen.queryByRole('dialog')).toBeNull();
        });

        it('invalid marks the trigger as required-and-empty (presentation only)', () => {
            renderSingle({ invalid: true });
            expect((screen.getByText('Pick X sensor...').closest('button') as HTMLElement).className).toContain('sensor-picker-trigger--req');
        });
    });
});
