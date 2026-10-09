import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { SensorPickerMulti, SensorPickerSingle, PICKER_SEARCH_PLACEHOLDER } from '../components/sensor/SensorPicker';
import { SensorMetaProvider } from '../components/sensor/SensorLabel';
import type { SensorMetadata } from '../types';
import { findPickerRow, openPickerSurface, pickerRows, pickerSearch, rowTag } from './helpers/sensorPicker';

// Customer item 3 (SPEC FINAL 2026-10-09 §1, DESIGN_SYSTEM §4 "Sensor picking — ONE picker").

afterEach(() => {
    cleanup();
    document.getElementById('wizard-portal-root')?.remove();
});

const m = (tag: string, description: string, unit: string, component: string): SensorMetadata => ({ tag, description, unit, component });
const META: SensorMetadata[] = [
    m('TT101', 'Bearing temperature DE', 'DEGC', 'Gas turbine'),
    m('TT102', 'Bearing temperature NDE', 'DEGC', 'Gas turbine'),
    m('PT201', 'Discharge pressure', 'BAR', 'Compressor'),
    m('FT301', 'Fuel flow', 'KG/S', ''),
];
const SENSORS = ['TT101', 'TT102', 'PT201', 'FT301'];

function Single(props: Partial<React.ComponentProps<typeof SensorPickerSingle>> & { initial?: string }) {
    const [v, setV] = useState(props.initial ?? '');
    return (
        <SensorMetaProvider metadata={META}>
            <SensorPickerSingle
                sensors={SENSORS}
                value={v}
                ariaLabel="Y sensor"
                {...props}
                onSelect={(t) => { setV(t); props.onSelect?.(t); }}
            />
        </SensorMetaProvider>
    );
}

const trigger = () => screen.getByRole('button', { name: 'Y sensor' });
const groupHeaders = () => [...openPickerSurface().querySelectorAll('.pk-g')].map(g => g.querySelector('.pk-gname')?.textContent);

describe('SensorPickerSingle', () => {
    it('the trigger shows the placeholder when empty, then the Inline label (description then tag) when set', () => {
        render(<Single placeholder="Pick a sensor…" />);
        expect(trigger().textContent).toBe('Pick a sensor…');
        fireEvent.click(trigger());
        fireEvent.click(findPickerRow('PT201'));
        expect(trigger().textContent).toBe('Discharge pressurePT201');
        expect(trigger().querySelector('.sl-fit')).toBeTruthy();
        expect(trigger().getAttribute('title')).toBe('Discharge pressure · PT201 · BAR · Compressor');
    });

    it('opens an anchored popover (a dialog with a combobox search), not a modal', () => {
        render(<Single />);
        fireEvent.click(trigger());
        const pop = openPickerSurface();
        expect(pop.classList.contains('pk-pop')).toBe(true);
        expect(pop.getAttribute('role')).toBe('dialog');
        expect(document.querySelector('.pk-scrim')).toBeNull();
        expect(pop.closest('.sensor-popover')).toBeTruthy(); // AnchoredPopover surface
        expect(pickerSearch().getAttribute('placeholder')).toBe(PICKER_SEARCH_PLACEHOLDER);
        expect(document.activeElement).toBe(pickerSearch());
        expect(trigger().getAttribute('aria-expanded')).toBe('true');
    });

    it('one click picks and closes — no OK button', () => {
        const onSelect = vi.fn();
        render(<Single onSelect={onSelect} />);
        fireEvent.click(trigger());
        expect(openPickerSurface().querySelector('.pk-foot')).toBeNull();
        fireEvent.click(findPickerRow('TT102'));
        expect(onSelect).toHaveBeenCalledWith('TT102');
        expect(document.querySelector('.pk-pop')).toBeNull();
    });

    it('groups by component (alphabetical, "Uncategorized" last) and only opens the group of the current value', () => {
        const many = Array.from({ length: 12 }, (_, i) => `X${i}`);
        const meta = [...META, ...many.map(t => m(t, `Extra ${t}`, '', 'Auxiliaries'))];
        render(
            <SensorMetaProvider metadata={meta}>
                <SensorPickerSingle sensors={[...SENSORS, ...many]} value="PT201" onSelect={() => {}} ariaLabel="Y sensor" />
            </SensorMetaProvider>,
        );
        fireEvent.click(trigger());
        expect(groupHeaders()).toEqual(['Auxiliaries', 'Compressor', 'Gas turbine', 'Uncategorized']);
        // Only Compressor (the current value's group) is open.
        expect(pickerRows().map(rowTag)).toEqual(['PT201']);
        expect(pickerRows()[0].getAttribute('aria-selected')).toBe('true');
        // Clicking a group header opens it.
        const gt = [...openPickerSurface().querySelectorAll<HTMLElement>('.pk-g')].find(g => g.textContent?.includes('Gas turbine'))!;
        fireEvent.click(gt);
        expect(gt.getAttribute('aria-expanded')).toBe('true');
        expect(pickerRows().map(rowTag)).toEqual(['PT201', 'TT101', 'TT102']);
    });

    it('search matches description, tag, unit and component, and opens every matching group', () => {
        render(<Single />);
        fireEvent.click(trigger());
        const q = (v: string) => { fireEvent.change(pickerSearch(), { target: { value: v } }); return pickerRows().map(rowTag); };
        expect(q('nde')).toEqual(['TT102']);          // description
        expect(q('pt2')).toEqual(['PT201']);          // tag
        expect(q('kg/s')).toEqual(['FT301']);         // unit
        expect(q('gas turb')).toEqual(['TT101', 'TT102']); // component
        expect(q('zzz')).toEqual([]);
        expect(openPickerSurface().querySelector('.pk-empty')?.textContent).toContain('No sensor matches “zzz”');
    });

    it('rows are the Inline label + a unit chip, with the full title', () => {
        render(<Single />);
        fireEvent.click(trigger());
        const row = findPickerRow('TT101');
        expect(row.querySelector('.sl-desc')?.textContent).toBe('Bearing temperature DE');
        expect(row.querySelector('.pk-unit')?.textContent).toBe('DEGC');
        expect(row.getAttribute('title')).toBe('Bearing temperature DE · TT101 · DEGC · Gas turbine');
    });

    it('shows the scope line when the list is not "all sensors"', () => {
        render(<Single scope={<>Sensors on the chart · 4</>} />);
        fireEvent.click(trigger());
        expect(openPickerSurface().querySelector('.pk-scope')?.textContent).toBe('Sensors on the chart · 4');
    });

    describe('keyboard', () => {
        it('↓ / Space on the trigger opens into the search box', () => {
            render(<Single />);
            fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
            expect(document.activeElement).toBe(pickerSearch());
            fireEvent.keyDown(pickerSearch(), { key: 'Escape' });
            fireEvent.keyDown(trigger(), { key: ' ' });
            expect(document.querySelector('.pk-pop')).toBeTruthy();
        });

        it('↑↓ move the highlight via aria-activedescendant (every row has an id), → ← open / close a group, Enter picks', () => {
            const onSelect = vi.fn();
            render(<Single onSelect={onSelect} />);
            fireEvent.click(trigger());
            const input = pickerSearch();
            expect(input.getAttribute('role')).toBe('combobox');
            expect(input.getAttribute('aria-activedescendant')).toBeNull();
            fireEvent.keyDown(input, { key: 'ArrowDown' }); // first row: the "Compressor" group
            const firstId = input.getAttribute('aria-activedescendant')!;
            const first = document.getElementById(firstId)!;
            expect(first.classList.contains('pk-g')).toBe(true);
            expect(first.classList.contains('kb')).toBe(true);
            // A short list (≤ 10 sensors) opens every group.
            expect(first.getAttribute('aria-expanded')).toBe('true');
            fireEvent.keyDown(input, { key: 'ArrowLeft' });
            expect(document.getElementById(firstId)!.getAttribute('aria-expanded')).toBe('false');
            fireEvent.keyDown(input, { key: 'ArrowRight' });
            expect(document.getElementById(firstId)!.getAttribute('aria-expanded')).toBe('true');
            fireEvent.keyDown(input, { key: 'ArrowDown' }); // into PT201
            const active = document.getElementById(input.getAttribute('aria-activedescendant')!)!;
            expect(active.getAttribute('role')).toBe('option');
            expect(rowTag(active)).toBe('PT201');
            fireEvent.keyDown(input, { key: 'ArrowUp' });
            expect(input.getAttribute('aria-activedescendant')).toBe(firstId);
            fireEvent.keyDown(input, { key: 'ArrowDown' });
            fireEvent.keyDown(input, { key: 'Enter' });
            expect(onSelect).toHaveBeenCalledWith('PT201');
        });

        it('Enter with nothing highlighted picks the only match', () => {
            const onSelect = vi.fn();
            render(<Single onSelect={onSelect} />);
            fireEvent.click(trigger());
            fireEvent.change(pickerSearch(), { target: { value: 'fuel' } });
            fireEvent.keyDown(pickerSearch(), { key: 'Enter' });
            expect(onSelect).toHaveBeenCalledWith('FT301');
        });

        it('Tab from the search box closes the popover and returns focus to the trigger', async () => {
            render(<Single />);
            fireEvent.click(trigger());
            fireEvent.keyDown(pickerSearch(), { key: 'Tab' });
            expect(document.querySelector('.pk-pop')).toBeNull();
            await waitFor(() => expect(document.activeElement).toBe(trigger()));
        });

        it('an Esc that reaches the document (focus elsewhere) also closes it', () => {
            render(<Single />);
            fireEvent.click(trigger());
            fireEvent.keyDown(document.body, { key: 'Escape' });
            expect(document.querySelector('.pk-pop')).toBeNull();
        });

        it('Esc closes without picking and returns focus to the trigger', async () => {
            const onSelect = vi.fn();
            render(<Single onSelect={onSelect} />);
            fireEvent.click(trigger());
            fireEvent.keyDown(pickerSearch(), { key: 'Escape' });
            expect(document.querySelector('.pk-pop')).toBeNull();
            expect(onSelect).not.toHaveBeenCalled();
            await waitFor(() => expect(document.activeElement).toBe(trigger()));
        });
    });

    it('a mousedown outside the picker closes it', () => {
        render(<><Single /><button type="button">elsewhere</button></>);
        fireEvent.click(trigger());
        fireEvent.mouseDown(screen.getByText('elsewhere'));
        expect(document.querySelector('.pk-pop')).toBeNull();
    });

    it('allowNone adds a "None" row that clears the value; a chosen None reads in --text-secondary (not italic)', () => {
        const onSelect = vi.fn();
        render(<Single allowNone placeholder="None" initial="TT101" onSelect={onSelect} />);
        fireEvent.click(trigger());
        const none = pickerRows().find(r => r.classList.contains('pk-item--none'))!;
        expect(none.textContent).toBe('None');
        expect(none.querySelector('em, i')).toBeNull();
        fireEvent.click(none);
        expect(onSelect).toHaveBeenCalledWith('');
        expect(trigger().querySelector('.pk-ph--none')?.textContent).toBe('None');
    });

    it('without allowNone there is no "None" row', () => {
        render(<Single />);
        fireEvent.click(trigger());
        expect(openPickerSurface().querySelector('.pk-item--none')).toBeNull();
    });

    it('required + empty = dashed amber (`req`); warn = solid amber; compact = the 24 px chart-toolbar form', () => {
        const { rerender } = render(<Single required />);
        expect(trigger().classList.contains('req')).toBe(true);
        rerender(<Single required initial="TT101" warn compact />);
        cleanup();
        render(<Single initial="TT101" warn compact />);
        expect(trigger().classList.contains('req')).toBe(false);
        expect(trigger().classList.contains('warn')).toBe(true);
        expect(trigger().classList.contains('pk-trigger--sm')).toBe(true);
    });

    it('disabled: does not open, keeps showing its value, gives the reason in the tooltip (and as the placeholder when empty)', () => {
        render(<Single disabled disabledReason="Only one predictor" initial="TT101" />);
        expect((trigger() as HTMLButtonElement).disabled).toBe(true);
        expect(trigger().textContent).toBe('Bearing temperature DETT101');
        expect(trigger().getAttribute('title')).toBe('Only one predictor');
        fireEvent.click(trigger());
        expect(document.querySelector('.pk-pop')).toBeNull();
        cleanup();
        render(<Single disabled disabledReason="Colour by… (Scatter only)" />);
        expect(trigger().textContent).toBe('Colour by… (Scatter only)');
    });

    it('closes itself when it becomes disabled while open', () => {
        const { rerender } = render(<Single />);
        fireEvent.click(trigger());
        expect(document.querySelector('.pk-pop')).toBeTruthy();
        rerender(<Single disabled />);
        expect(document.querySelector('.pk-pop')).toBeNull();
    });

    it('focus lands in the search box once the popover is placed — with preventScroll, not autoFocus (a focus-scroll could dismiss it)', () => {
        const focus = vi.spyOn(HTMLElement.prototype, 'focus');
        render(<Single />);
        fireEvent.click(trigger());
        const search = pickerSearch();
        expect(search.hasAttribute('autofocus')).toBe(false);
        expect(document.activeElement).toBe(search);
        const call = focus.mock.calls.find((_c, i) => focus.mock.contexts[i] === search);
        expect(call?.[0]).toEqual({ preventScroll: true });
        // Placed first: the surface already has its clamped position when focus moves in.
        expect((search.closest('.sensor-popover') as HTMLElement).dataset.placement).toBe('below');
        focus.mockRestore();
    });

    it('reserves the list height when it has to open above the trigger (the search box never moves while typing)', () => {
        render(<Single />);
        const t = trigger();
        // A trigger near the bottom of a 768 px viewport: no room below for the 380 px list.
        vi.spyOn(t, 'getBoundingClientRect').mockReturnValue({ top: 700, bottom: 724, left: 10, right: 200, width: 190, height: 24, x: 10, y: 700, toJSON: () => ({}) } as DOMRect);
        fireEvent.click(t);
        const surface = openPickerSurface().closest('.sensor-popover') as HTMLElement;
        expect(surface.dataset.placement).toBe('above');
        expect(surface.style.top).toBe('auto');
        expect(surface.style.bottom).toBe(`${window.innerHeight - 700 + 6}px`);
        expect(surface.style.height).toBe(`${Math.min(380, Math.round(window.innerHeight * 0.7))}px`);
        fireEvent.change(pickerSearch(), { target: { value: 'zzz' } });
        expect(surface.style.bottom).toBe(`${window.innerHeight - 700 + 6}px`);
        expect(surface.style.height).toBe(`${Math.min(380, Math.round(window.innerHeight * 0.7))}px`);
    });

    it('group headers inside the listbox are group rows (not plain buttons) that still say whether they are open', () => {
        render(<Single />);
        fireEvent.click(trigger());
        const g = openPickerSurface().querySelector('.pk-g') as HTMLElement;
        expect(g.getAttribute('role')).toBe('group');
        expect(g.getAttribute('aria-label')).toBe('Compressor, 1 sensor');
        expect(g.getAttribute('aria-expanded')).toBe('true'); // a short list opens fully
        fireEvent.click(g);
        expect((openPickerSurface().querySelector('.pk-g') as HTMLElement).getAttribute('aria-expanded')).toBe('false');
    });

    it('alignRight right-aligns the popover to the trigger (min(420px, 92vw) wide)', () => {
        render(<Single alignRight />);
        fireEvent.click(trigger());
        const surface = openPickerSurface().closest('.sensor-popover') as HTMLElement;
        expect(surface.style.width).toBe(`${Math.min(420, Math.round(window.innerWidth * 0.92))}px`);
    });
});

function Multi(props: Partial<React.ComponentProps<typeof SensorPickerMulti>> & { initial?: string[]; onChange?: (t: string[]) => void }) {
    const [sel, setSel] = useState<string[]>(props.initial ?? []);
    return (
        <SensorMetaProvider metadata={META}>
            <SensorPickerMulti
                sensors={SENSORS}
                selected={sel}
                noun="predictors"
                {...props}
                onConfirm={(t) => { setSel(t); props.onChange?.(t); }}
            />
        </SensorMetaProvider>
    );
}

const addBtn = () => document.querySelector('.pk-add') as HTMLButtonElement;
const okBtn = () => [...openPickerSurface().querySelectorAll<HTMLButtonElement>('.pk-foot button')].find(b => b.textContent?.includes('OK'))!;
const cancelBtn = () => [...openPickerSurface().querySelectorAll<HTMLButtonElement>('.pk-foot button')].find(b => b.textContent === 'Cancel')!;

describe('SensorPickerMulti', () => {
    it('shows the selection as Inline chips with a remove ×, plus a dashed "Add…"', () => {
        const onChange = vi.fn();
        render(<Multi initial={['TT101', 'PT201']} onChange={onChange} />);
        const chips = [...document.querySelectorAll('.pk-chip')];
        expect(chips.map(c => c.querySelector('.sl-tag')?.textContent)).toEqual(['TT101', 'PT201']);
        expect(addBtn().textContent).toBe('Add…');
        fireEvent.click(screen.getByRole('button', { name: 'Remove Bearing temperature DE' }));
        expect(onChange).toHaveBeenCalledWith(['PT201']);
    });

    it('empty: "Add {noun}…"; required + empty = amber', () => {
        render(<Multi required />);
        expect(addBtn().textContent).toBe('Add predictors…');
        expect(addBtn().classList.contains('req')).toBe(true);
    });

    it('opens a 520 px modal with checkboxes; nothing changes until OK', () => {
        const onChange = vi.fn();
        render(<Multi initial={['TT101']} onChange={onChange} scope={<>All sensors except the target · 4</>} />);
        fireEvent.click(addBtn());
        const modal = openPickerSurface();
        expect(modal.classList.contains('pk-modal')).toBe(true);
        expect(modal.getAttribute('aria-modal')).toBe('true');
        expect(screen.getByRole('dialog', { name: 'Select predictors' })).toBe(modal);
        expect(modal.querySelector('.pk-scope')?.textContent).toBe('All sensors except the target · 4');
        expect(modal.querySelector('[role="listbox"]')?.getAttribute('aria-multiselectable')).toBe('true');
        fireEvent.click(findPickerRow('PT201'));
        expect(findPickerRow('PT201').getAttribute('aria-selected')).toBe('true');
        expect(findPickerRow('PT201').querySelector('.pk-cbx')).toBeTruthy();
        expect(onChange).not.toHaveBeenCalled();
        expect(modal.querySelector('.pk-count')?.textContent).toBe('2 selected');
        fireEvent.click(okBtn());
        expect(onChange).toHaveBeenCalledWith(['TT101', 'PT201']);
        expect(document.querySelector('.pk-modal')).toBeNull();
    });

    it('Cancel, Esc and the scrim all discard the pending picks', () => {
        const onChange = vi.fn();
        render(<Multi onChange={onChange} />);
        fireEvent.click(addBtn());
        fireEvent.click(findPickerRow('TT101'));
        fireEvent.click(cancelBtn());
        fireEvent.click(addBtn());
        expect(findPickerRow('TT101').getAttribute('aria-selected')).toBe('false');
        fireEvent.click(findPickerRow('TT101'));
        fireEvent.keyDown(pickerSearch(), { key: 'Escape' });
        expect(document.querySelector('.pk-modal')).toBeNull();
        fireEvent.click(addBtn());
        fireEvent.click(findPickerRow('TT101'));
        fireEvent.mouseDown(document.querySelector('.pk-scrim')!);
        expect(document.querySelector('.pk-modal')).toBeNull();
        expect(onChange).not.toHaveBeenCalled();
    });

    it('Enter toggles the highlighted row; the group count reads "picked / total"', () => {
        render(<Multi initial={['TT101']} />);
        fireEvent.click(addBtn());
        const gt = [...openPickerSurface().querySelectorAll<HTMLElement>('.pk-g')].find(g => g.textContent?.includes('Gas turbine'))!;
        expect(gt.querySelector('.pk-gcount')?.textContent).toBe('1 / 2');
        fireEvent.change(pickerSearch(), { target: { value: 'nde' } });
        fireEvent.keyDown(pickerSearch(), { key: 'Enter' });
        expect(findPickerRow('TT102').getAttribute('aria-selected')).toBe('true');
    });

    it('locked: chips without ×, "Add…" disabled showing the reason', () => {
        render(<Multi initial={['TT101']} lockedReason="Locked — a model uses this sensor" />);
        expect(document.querySelector('.pk-chip-x')).toBeNull();
        expect(addBtn().disabled).toBe(true);
        expect(addBtn().textContent).toBe('Locked — a model uses this sensor');
    });

    it('Tab stays inside the modal', () => {
        render(<Multi />);
        fireEvent.click(addBtn());
        const modal = openPickerSurface();
        const ok = okBtn();
        ok.focus();
        fireEvent.keyDown(modal, { key: 'Tab' });
        expect(document.activeElement).toBe(pickerSearch());
        fireEvent.keyDown(modal, { key: 'Tab', shiftKey: true });
        expect(document.activeElement).toBe(ok);
    });
});

describe('performance guard: a ~130-tag list stays cheap to open', () => {
    it('renders only group headers (plus the current value\'s group) until a search opens more', () => {
        const comps = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
        const tags = Array.from({ length: 130 }, (_, i) => `S${i}`);
        const meta = tags.map((t, i) => m(t, `Sensor ${i}`, 'U', comps[i % comps.length]));
        render(
            <SensorMetaProvider metadata={meta}>
                <SensorPickerSingle sensors={tags} value="S7" onSelect={() => {}} ariaLabel="Y sensor" />
            </SensorMetaProvider>,
        );
        fireEvent.click(trigger());
        expect(openPickerSurface().querySelectorAll('.pk-g').length).toBe(10);
        expect(pickerRows().length).toBe(13); // only group H (S7, S17, … S127)
    });
});
