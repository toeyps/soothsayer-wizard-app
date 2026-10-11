import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { TimeHighlight, ValueHighlight } from '../types';

const colorPickerCalls: any[] = [];
vi.mock('../components/dashboard/ColorPlatePicker', () => ({
    default: (props: any) => {
        colorPickerCalls.push(props);
        return <button onClick={() => props.onChange('#123456')}>set-color-{props.color}</button>;
    },
}));

import HighlightsPanel from '../components/dashboard/HighlightsPanel';
import { SensorMetaProvider } from '../components/sensor/SensorLabel';
import { findPickerRow, openPickerSurface, pickSingle, rowTag } from './helpers/sensorPicker';

// Colours are picked with the shared ColourPicker (the swatch is
// the button; a palette pick applies immediately). Its own behaviour is in ColourPicker.test.tsx.
const swatch = (name: RegExp | string) => screen.getByRole('button', { name });
const paletteSwatch = (hex: string) => document.querySelector(`.cp-pop .cp-sw[data-colour="${hex}"]`) as HTMLElement;
const colourPopoverOpen = () => document.querySelector('.cp-pop') !== null;

function makeProps(overrides: Partial<React.ComponentProps<typeof HighlightsPanel>> = {}) {
    return {
        timeHighlights: [] as TimeHighlight[],
        onAddTimeHighlight: vi.fn(),
        onToggleTimeHighlight: vi.fn(),
        onRemoveTimeHighlight: vi.fn(),
        onRecolorTimeHighlight: vi.fn(),
        onRenameTimeHighlight: vi.fn(),
        valueHighlight: { sensor: '', ranges: [] } as ValueHighlight,
        valueHighlightSensors: ['TAG1', 'TAG2', 'TAG3'],
        onSetValueHighlightSensor: vi.fn(),
        onAddValueHighlightRange: vi.fn(),
        onToggleValueHighlightRange: vi.fn(),
        onRemoveValueHighlightRange: vi.fn(),
        onRecolorValueHighlightRange: vi.fn(),
        // Default to Scatter so the group applies (no compat banner) --
        // matches every existing test's assumption. The banner tests below
        // override this explicitly.
        chartType: 'scatter' as const,
        ...overrides,
    };
}

beforeEach(() => {
    colorPickerCalls.length = 0;
});

describe('HighlightsPanel', () => {
    describe('By time (highlights)', () => {
        it('shows an empty state with no highlights yet', () => {
            render(<HighlightsPanel {...makeProps()} />);
            expect(screen.getByText(/No highlights yet/)).toBeTruthy();
        });

        it('adds a valid highlight and clears the draft fields', () => {
            const onAddTimeHighlight = vi.fn();
            render(<HighlightsPanel {...makeProps({ onAddTimeHighlight })} />);
            fireEvent.change(screen.getByPlaceholderText('Label (optional)'), { target: { value: 'Startup' } });
            const dtInputs = document.querySelectorAll('input[type="datetime-local"]');
            fireEvent.change(dtInputs[0], { target: { value: '2026-01-01T00:00' } });
            fireEvent.change(dtInputs[1], { target: { value: '2026-01-01T01:00' } });
            fireEvent.click(screen.getByText('+ Add'));
            expect(onAddTimeHighlight).toHaveBeenCalledWith('2026-01-01T00:00', '2026-01-01T01:00', 'Startup');
            expect((screen.getByPlaceholderText('Label (optional)') as HTMLInputElement).value).toBe('');
        });

        it('rejects a missing start or end with an inline error', () => {
            const onAddTimeHighlight = vi.fn();
            render(<HighlightsPanel {...makeProps({ onAddTimeHighlight })} />);
            fireEvent.click(screen.getByText('+ Add'));
            expect(screen.getByText('Pick a start and end')).toBeTruthy();
            expect(onAddTimeHighlight).not.toHaveBeenCalled();
        });

        it('rejects start >= end with an inline error', () => {
            const onAddTimeHighlight = vi.fn();
            render(<HighlightsPanel {...makeProps({ onAddTimeHighlight })} />);
            const dtInputs = document.querySelectorAll('input[type="datetime-local"]');
            fireEvent.change(dtInputs[0], { target: { value: '2026-01-01T02:00' } });
            fireEvent.change(dtInputs[1], { target: { value: '2026-01-01T01:00' } });
            fireEvent.click(screen.getByText('+ Add'));
            expect(screen.getByText('Start must be before end')).toBeTruthy();
            expect(onAddTimeHighlight).not.toHaveBeenCalled();
        });

        it('renders a chip per highlight with checkbox/swatch/label/date-range/delete, wired to their handlers', () => {
            const onToggleTimeHighlight = vi.fn();
            const onRemoveTimeHighlight = vi.fn();
            const timeHighlights: TimeHighlight[] = [
                { id: 'h1', start: '2026-01-01T00:00', end: '2026-01-01T01:00', label: 'Startup', color: '#ff0000', enabled: true },
            ];
            render(<HighlightsPanel {...makeProps({ timeHighlights, onToggleTimeHighlight, onRemoveTimeHighlight })} />);

            expect(screen.getByText('Startup')).toBeTruthy();
            fireEvent.click(screen.getByRole('checkbox'));
            expect(onToggleTimeHighlight).toHaveBeenCalledWith('h1');

            fireEvent.click(screen.getByTitle('Remove'));
            expect(onRemoveTimeHighlight).toHaveBeenCalledWith('h1');
        });

        it('opens the shared ColourPicker from the swatch and calls onRecolorTimeHighlight when a colour is picked', () => {
            const onRecolorTimeHighlight = vi.fn();
            const timeHighlights: TimeHighlight[] = [
                { id: 'h1', start: '2026-01-01T00:00', end: '2026-01-01T01:00', label: 'Startup', color: '#ff0000', enabled: true },
                { id: 'h2', start: '2026-01-02T00:00', end: '2026-01-02T01:00', label: 'Trip', color: '#10b981', enabled: true },
            ];
            render(<HighlightsPanel {...makeProps({ timeHighlights, onRecolorTimeHighlight })} />);

            fireEvent.click(swatch('Highlight colour: Startup'));
            expect(screen.getByRole('dialog', { name: 'Colour for Startup' })).toBeTruthy();
            // The other highlight's colour is marked as in use.
            expect(paletteSwatch('#10b981').querySelector('.cp-used')).toBeTruthy();
            fireEvent.click(paletteSwatch('#8b5cf6'));
            expect(onRecolorTimeHighlight).toHaveBeenCalledWith('h1', '#8b5cf6');
        });

        // Visual refresh: this popover now renders through
        // `AnchoredPopover`/`Portal` (escapes this panel's own scrolling,
        // same reasoning as every other popover in the visual-refresh
        // spec) instead of expanding inline, flexbox-aligned, below the
        // swatch. `AnchoredPopover` is left-aligned to its anchor by
        // default (no `width` prop passed here) — i.e. its `left` lines up
        // with the swatch's own left edge, preserving the original
        // regression fix's intent ("left-aligned, under the swatch", not
        // right-aligned and disconnected from a left-side swatch).
        // `AnchoredPopover.test.tsx` covers the positioning arithmetic
        // itself in detail; this just pins that HighlightsPanel calls it
        // the left-aligned way, not the right-aligned (`width`-bearing) way
        // SensorSelection/Dashboard use for their right-side icon buttons.
        it('opens the ColorPlatePicker left-aligned, under the swatch button that triggers it (regression: it opened right-aligned, disconnected from the left-side swatch)', () => {
            const timeHighlights: TimeHighlight[] = [
                { id: 'h1', start: '2026-01-01T00:00', end: '2026-01-01T01:00', label: 'Startup', color: '#ff0000', enabled: true },
            ];
            render(<HighlightsPanel {...makeProps({ timeHighlights })} />);

            fireEvent.click(swatch('Highlight colour: Startup'));
            const popover = document.querySelector('.cp-pop')!.closest('.sensor-popover') as HTMLElement;
            expect(popover).toBeTruthy();
            // Left-aligned to the (zeroed, in jsdom) anchor rect's own left
            // edge — NOT right-aligned-and-clamped (which `width`-bearing
            // popovers compute as `max(8, right - width)`, e.g. "8px").
            expect(popover.style.left).toBe('0px');
        });

        it('shows the "applies to Line and Scatter, not Pair Plot" scope note', () => {
            render(<HighlightsPanel {...makeProps()} />);
            expect(screen.getByText(/Applies to Line and Scatter/)).toBeTruthy();
        });

        it('clicking Rename turns the label into an editable text field, seeded with the current label', () => {
            const timeHighlights: TimeHighlight[] = [
                { id: 'h1', start: '2026-01-01T00:00', end: '2026-01-01T01:00', label: 'Startup', color: '#ff0000', enabled: true },
            ];
            render(<HighlightsPanel {...makeProps({ timeHighlights })} />);
            expect(screen.queryByDisplayValue('Startup')).toBeNull();

            fireEvent.click(screen.getByTitle('Rename'));
            expect((screen.getByDisplayValue('Startup') as HTMLInputElement)).toBeTruthy();
            expect(screen.queryByText('Startup')).toBeNull(); // static span swapped out, not just overlaid
        });

        it('commits the new label on Enter and calls onRenameTimeHighlight', () => {
            const onRenameTimeHighlight = vi.fn();
            const timeHighlights: TimeHighlight[] = [
                { id: 'h1', start: '2026-01-01T00:00', end: '2026-01-01T01:00', label: 'Startup', color: '#ff0000', enabled: true },
            ];
            render(<HighlightsPanel {...makeProps({ timeHighlights, onRenameTimeHighlight })} />);

            fireEvent.click(screen.getByTitle('Rename'));
            const input = screen.getByDisplayValue('Startup');
            fireEvent.change(input, { target: { value: 'Shutdown' } });
            fireEvent.keyDown(input, { key: 'Enter' });

            expect(onRenameTimeHighlight).toHaveBeenCalledWith('h1', 'Shutdown');
            expect(screen.queryByDisplayValue('Shutdown')).toBeNull(); // edit field closes after commit
        });

        it('commits the new label on blur too, not just Enter', () => {
            const onRenameTimeHighlight = vi.fn();
            const timeHighlights: TimeHighlight[] = [
                { id: 'h1', start: '2026-01-01T00:00', end: '2026-01-01T01:00', label: 'Startup', color: '#ff0000', enabled: true },
            ];
            render(<HighlightsPanel {...makeProps({ timeHighlights, onRenameTimeHighlight })} />);

            fireEvent.click(screen.getByTitle('Rename'));
            fireEvent.change(screen.getByDisplayValue('Startup'), { target: { value: 'Shutdown' } });
            fireEvent.blur(screen.getByDisplayValue('Shutdown'));

            expect(onRenameTimeHighlight).toHaveBeenCalledWith('h1', 'Shutdown');
        });

        it('cancels on Escape without calling onRenameTimeHighlight, reverting to the static label', () => {
            const onRenameTimeHighlight = vi.fn();
            const timeHighlights: TimeHighlight[] = [
                { id: 'h1', start: '2026-01-01T00:00', end: '2026-01-01T01:00', label: 'Startup', color: '#ff0000', enabled: true },
            ];
            render(<HighlightsPanel {...makeProps({ timeHighlights, onRenameTimeHighlight })} />);

            fireEvent.click(screen.getByTitle('Rename'));
            fireEvent.change(screen.getByDisplayValue('Startup'), { target: { value: 'Shutdown' } });
            fireEvent.keyDown(screen.getByDisplayValue('Shutdown'), { key: 'Escape' });

            expect(onRenameTimeHighlight).not.toHaveBeenCalled();
            expect(screen.getByText('Startup')).toBeTruthy(); // reverted, not left blank
        });

        it('rejects an empty/whitespace-only label -- reverts instead of saving a blank name', () => {
            const onRenameTimeHighlight = vi.fn();
            const timeHighlights: TimeHighlight[] = [
                { id: 'h1', start: '2026-01-01T00:00', end: '2026-01-01T01:00', label: 'Startup', color: '#ff0000', enabled: true },
            ];
            render(<HighlightsPanel {...makeProps({ timeHighlights, onRenameTimeHighlight })} />);

            fireEvent.click(screen.getByTitle('Rename'));
            const input = screen.getByDisplayValue('Startup');
            fireEvent.change(input, { target: { value: '   ' } });
            fireEvent.keyDown(input, { key: 'Enter' });

            expect(onRenameTimeHighlight).not.toHaveBeenCalled();
            expect(screen.getByText('Startup')).toBeTruthy();
        });
    });

    describe('no Band / Line colour switch (removed 2026-10-08 per customer request -- time highlights always draw as a band on Line)', () => {
        it.each(['line', 'scatter', 'pair'] as const)('renders no display-mode switch and no "Line colour" option on %s', (chartType) => {
            const { container } = render(<HighlightsPanel {...makeProps({ chartType })} />);
            expect(container.querySelector('.highlights-seg')).toBeNull();
            expect(screen.queryByText('Line colour')).toBeNull();
            expect(screen.queryByRole('button', { name: 'Band' })).toBeNull();
        });

        it('shows no Scatter-only "Not adjustable here" note any more -- there is no setting left for it to refer to', () => {
            render(<HighlightsPanel {...makeProps({ chartType: 'scatter' })} />);
            expect(screen.queryByText(/Not adjustable here/)).toBeNull();
            expect(screen.queryByText(/always renders highlights as a ring/)).toBeNull();
            // ...and the "By time" group stays fully live on Scatter.
            expect((document.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(false);
        });

        it('the scope footer describes the band (no more "recolours itself")', () => {
            render(<HighlightsPanel {...makeProps({ chartType: 'line' })} />);
            expect(screen.queryByText(/recolours itself/)).toBeNull();
            expect(screen.getByText(/Line shows a tinted band over each window; Scatter rings matching points/)).toBeTruthy();
        });
    });

    describe('chart-type-aware compatibility banner + disabling (irrelevant on Pair Plot, so the group is fully disabled via a wrapping <fieldset disabled>, not just dimmed -- the user explicitly rejected "dimmed but still clickable" after seeing it live)', () => {
        it('shows no banner when Scatter is active (applies)', () => {
            render(<HighlightsPanel {...makeProps({ chartType: 'scatter' })} />);
            expect(screen.queryByText(/Not shown on/)).toBeNull();
        });

        it('shows no banner when Line is active (applies)', () => {
            render(<HighlightsPanel {...makeProps({ chartType: 'line' })} />);
            expect(screen.queryByText(/Not shown on/)).toBeNull();
        });

        it('shows a banner when Pair Plot is active (does not apply)', () => {
            render(<HighlightsPanel {...makeProps({ chartType: 'pair' })} />);
            expect(screen.getByText(/Not shown on/).textContent).toContain('Pair Plot');
        });

        // jsdom does not implement the HTML spec's "a form control is
        // disabled if an ancestor <fieldset disabled> exists" cascade --
        // confirmed by reading jsdom's own HTMLFieldSetElement/
        // HTMLInputElement source, which contains no such check. Real
        // browsers (including the WebView2/Chromium this app actually
        // ships on) implement this correctly per spec, so production
        // behaviour is fine -- but a descendant `<input>.disabled` check
        // would read `false` here regardless of whether the component is
        // correct, making it a false-negative-proof, not a real one. These
        // tests instead assert on the `disabled` property of the
        // `<fieldset>` element itself, which jsdom DOES reflect correctly
        // (plain attribute reflection, not cascading) -- that's the actual
        // piece of logic this component is responsible for.
        it('the fieldset is disabled when the chart on screen is Pair Plot', () => {
            render(<HighlightsPanel {...makeProps({ chartType: 'pair' })} />);
            const fieldset = document.querySelector('fieldset');
            expect((fieldset as HTMLFieldSetElement).disabled).toBe(true);
        });

        it('the fieldset is not disabled when Scatter or Line is active', () => {
            const { rerender } = render(<HighlightsPanel {...makeProps({ chartType: 'scatter' })} />);
            expect((document.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(false);

            rerender(<HighlightsPanel {...makeProps({ chartType: 'line' })} />);
            expect((document.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(false);
        });

        it('re-enables the fieldset the instant the chart switches back to an applicable type', () => {
            const { rerender } = render(<HighlightsPanel {...makeProps({ chartType: 'pair' })} />);
            expect((document.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(true);

            rerender(<HighlightsPanel {...makeProps({ chartType: 'line' })} />);
            expect((document.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(false);
        });

        it('closes an already-open colour picker the instant the group becomes inapplicable, instead of leaving a live drag-to-recolour control behind a disabled fieldset', () => {
            const timeHighlights: TimeHighlight[] = [
                { id: 'h1', start: '2026-01-01T00:00', end: '2026-01-01T01:00', label: 'Startup', color: '#ff0000', enabled: true },
            ];
            const { rerender } = render(<HighlightsPanel {...makeProps({ chartType: 'scatter', timeHighlights })} />);
            fireEvent.click(swatch('Highlight colour: Startup'));
            expect(colourPopoverOpen()).toBe(true);

            rerender(<HighlightsPanel {...makeProps({ chartType: 'pair', timeHighlights })} />);
            expect(colourPopoverOpen()).toBe(false);
            expect((swatch('Highlight colour: Startup') as HTMLButtonElement).disabled).toBe(true);
        });

        it('closes an already-open label-rename field the instant the group becomes inapplicable, reverting to the static label', () => {
            const timeHighlights: TimeHighlight[] = [
                { id: 'h1', start: '2026-01-01T00:00', end: '2026-01-01T01:00', label: 'Startup', color: '#ff0000', enabled: true },
            ];
            const { rerender } = render(<HighlightsPanel {...makeProps({ chartType: 'scatter', timeHighlights })} />);
            fireEvent.click(screen.getByTitle('Rename'));
            expect(screen.getByDisplayValue('Startup')).toBeTruthy();

            rerender(<HighlightsPanel {...makeProps({ chartType: 'pair', timeHighlights })} />);
            expect(screen.queryByDisplayValue('Startup')).toBeNull();
        });

        // The "By time" column never becomes disabled on a Line <-> Scatter
        // switch (only Pair Plot disables it), but Scatter inserts/removes
        // its own inline note above the chip list, shifting the swatch's
        // on-screen position. So the open popover / rename draft is cleared
        // on ANY chartType change, not only when the column becomes disabled.
        it('closes an already-open colour picker on a Line -> Scatter switch too, even though the column never becomes disabled', () => {
            const timeHighlights: TimeHighlight[] = [
                { id: 'h1', start: '2026-01-01T00:00', end: '2026-01-01T01:00', label: 'Startup', color: '#ff0000', enabled: true },
            ];
            const { rerender } = render(<HighlightsPanel {...makeProps({ chartType: 'line', timeHighlights })} />);
            fireEvent.click(swatch('Highlight colour: Startup'));
            expect(colourPopoverOpen()).toBe(true);

            rerender(<HighlightsPanel {...makeProps({ chartType: 'scatter', timeHighlights })} />);
            expect(colourPopoverOpen()).toBe(false);
        });

        it('clears an in-progress rename draft on a Line -> Scatter switch too, even though the column never becomes disabled', () => {
            const timeHighlights: TimeHighlight[] = [
                { id: 'h1', start: '2026-01-01T00:00', end: '2026-01-01T01:00', label: 'Startup', color: '#ff0000', enabled: true },
            ];
            const { rerender } = render(<HighlightsPanel {...makeProps({ chartType: 'line', timeHighlights })} />);
            fireEvent.click(screen.getByTitle('Rename'));
            expect(screen.getByDisplayValue('Startup')).toBeTruthy();

            rerender(<HighlightsPanel {...makeProps({ chartType: 'scatter', timeHighlights })} />);
            expect(screen.queryByDisplayValue('Startup')).toBeNull();
        });
    });

    describe('By value (Scatter-only — restored after removal, this time living here instead of a "Colour by…" control on Scatter\'s own toolbar)', () => {
        it('"Colour by…" is the shared single picker, scoped to the sensors on the chart; a pick calls onSetValueHighlightSensor', () => {
            const onSetValueHighlightSensor = vi.fn();
            render(<HighlightsPanel {...makeProps({ onSetValueHighlightSensor })} />);
            const trig = screen.getByRole('button', { name: 'Colour by' });
            expect(trig.textContent).toBe('Colour by…');
            fireEvent.click(trig);
            expect(openPickerSurface().querySelector('.pk-scope')?.textContent).toBe('Sensors on the chart · 3');
            // A "None" row first (no tag), then the sensors.
            expect([...openPickerSurface().querySelectorAll('[role="option"]')].map(rowTag)).toEqual([null, 'TAG1', 'TAG2', 'TAG3']);
            fireEvent.click(findPickerRow('TAG2'));
            expect(onSetValueHighlightSensor).toHaveBeenCalledWith('TAG2');
        });

        it('"Colour by…" can be cleared again: picking None calls onSetValueHighlightSensor with an empty string', () => {
            const onSetValueHighlightSensor = vi.fn();
            render(<HighlightsPanel {...makeProps({ onSetValueHighlightSensor, valueHighlight: { sensor: 'TAG1', ranges: [] } })} />);
            const trig = screen.getByRole('button', { name: 'Colour by' });
            expect(trig.textContent).toBe('TAG1');
            pickSingle(trig, '');
            expect(onSetValueHighlightSensor).toHaveBeenCalledWith('');
        });

        it('with no sensor chosen the trigger keeps the "Colour by…" placeholder and the None row is the current one', () => {
            render(<HighlightsPanel {...makeProps()} />);
            fireEvent.click(screen.getByRole('button', { name: 'Colour by' }));
            const none = openPickerSurface().querySelector('.pk-item--none') as HTMLElement;
            expect(none.getAttribute('aria-selected')).toBe('true');
        });

        it('"Colour by…" is a real disabled state on Line and Pair Plot, with the reason', () => {
            const { rerender } = render(<HighlightsPanel {...makeProps({ chartType: 'line' })} />);
            const trig = () => screen.getByRole('button', { name: 'Colour by' }) as HTMLButtonElement;
            expect(trig().disabled).toBe(true);
            expect(trig().textContent).toBe('Colour by… (Scatter only)');
            rerender(<HighlightsPanel {...makeProps({ chartType: 'pair' })} />);
            expect(trig().textContent).toBe('Colour by… (not on Pair Plot)');
            // A sensor already chosen stays visible while disabled.
            rerender(<HighlightsPanel {...makeProps({ chartType: 'line', valueHighlight: { sensor: 'TAG1', ranges: [] } })} />);
            expect(trig().textContent).toBe('TAG1');
        });

        it('hides the range editor entirely until a sensor is picked', () => {
            render(<HighlightsPanel {...makeProps()} />);
            expect(screen.queryByPlaceholderText('min')).toBeNull();
            expect(screen.queryByText('No ranges yet — a point stays uncoloured until at least one is added below.')).toBeNull();
        });

        it('shows the empty-ranges hint and the add-range form once a sensor is picked', () => {
            render(<HighlightsPanel {...makeProps({ valueHighlight: { sensor: 'TAG1', ranges: [] } })} />);
            expect(screen.getByText('No ranges yet — a point stays uncoloured until at least one is added below.')).toBeTruthy();
            expect(screen.getByPlaceholderText('min')).toBeTruthy();
            expect(screen.getByPlaceholderText('max')).toBeTruthy();
        });

        it('adds a valid range and clears the draft fields', () => {
            const onAddValueHighlightRange = vi.fn();
            render(<HighlightsPanel {...makeProps({ valueHighlight: { sensor: 'TAG1', ranges: [] }, onAddValueHighlightRange })} />);
            fireEvent.change(screen.getByPlaceholderText('min'), { target: { value: '10' } });
            fireEvent.change(screen.getByPlaceholderText('max'), { target: { value: '20' } });
            fireEvent.click(screen.getAllByText('+ Add')[1]); // [0] = By time, [1] = By value
            expect(onAddValueHighlightRange).toHaveBeenCalledWith(10, 20);
            expect((screen.getByPlaceholderText('min') as HTMLInputElement).value).toBe('');
        });

        it('rejects non-numeric input with an inline error', () => {
            const onAddValueHighlightRange = vi.fn();
            render(<HighlightsPanel {...makeProps({ valueHighlight: { sensor: 'TAG1', ranges: [] }, onAddValueHighlightRange })} />);
            fireEvent.click(screen.getAllByText('+ Add')[1]);
            expect(screen.getByText('Enter valid numbers')).toBeTruthy();
            expect(onAddValueHighlightRange).not.toHaveBeenCalled();
        });

        it('rejects min >= max with an inline error', () => {
            const onAddValueHighlightRange = vi.fn();
            render(<HighlightsPanel {...makeProps({ valueHighlight: { sensor: 'TAG1', ranges: [] }, onAddValueHighlightRange })} />);
            fireEvent.change(screen.getByPlaceholderText('min'), { target: { value: '20' } });
            fireEvent.change(screen.getByPlaceholderText('max'), { target: { value: '10' } });
            fireEvent.click(screen.getAllByText('+ Add')[1]);
            expect(screen.getByText('Min must be less than max')).toBeTruthy();
            expect(onAddValueHighlightRange).not.toHaveBeenCalled();
        });

        it('renders a chip per range with checkbox/swatch/min-max/delete, wired to their handlers', () => {
            const onToggleValueHighlightRange = vi.fn();
            const onRemoveValueHighlightRange = vi.fn();
            const valueHighlight: ValueHighlight = {
                sensor: 'TAG1',
                ranges: [{ id: 'r1', min: 10, max: 20, color: '#ff0000', enabled: true }],
            };
            render(<HighlightsPanel {...makeProps({ valueHighlight, onToggleValueHighlightRange, onRemoveValueHighlightRange })} />);

            expect(screen.getByText('10 – 20')).toBeTruthy();
            fireEvent.click(screen.getByRole('checkbox'));
            expect(onToggleValueHighlightRange).toHaveBeenCalledWith('r1');

            fireEvent.click(screen.getByTitle('Remove'));
            expect(onRemoveValueHighlightRange).toHaveBeenCalledWith('r1');
        });

        it('opens the ColorPlatePicker on swatch click and calls onRecolorValueHighlightRange when a colour is picked', () => {
            const onRecolorValueHighlightRange = vi.fn();
            const valueHighlight: ValueHighlight = {
                sensor: 'TAG1',
                ranges: [{ id: 'r1', min: 10, max: 20, color: '#ff0000', enabled: true }],
            };
            render(<HighlightsPanel {...makeProps({ valueHighlight, onRecolorValueHighlightRange })} />);

            fireEvent.click(swatch(/^Range colour: 10 – 20/));
            fireEvent.click(paletteSwatch('#06b6d4'));
            expect(onRecolorValueHighlightRange).toHaveBeenCalledWith('r1', '#06b6d4');
        });

        it('a range chip keeps every decimal the user typed (a small range never reads as 0 – 0)', () => {
            const valueHighlight: ValueHighlight = {
                sensor: 'TAG1',
                ranges: [{ id: 'r1', min: 0.0001, max: 0.0004, color: '#ff0000', enabled: true }],
            };
            render(<HighlightsPanel {...makeProps({ valueHighlight })} />);
            expect(screen.getByText('0.0001 – 0.0004')).toBeTruthy();
            expect(swatch(/^Range colour: 0\.0001 – 0\.0004/)).toBeTruthy();
        });

        it('range chips and the add-range inputs show the unit, with thousands separators on the chip', () => {
            const valueHighlight: ValueHighlight = {
                sensor: 'TAG1',
                ranges: [{ id: 'r1', min: 1500, max: 12345.5, color: '#ff0000', enabled: true }],
            };
            render(
                <SensorMetaProvider metadata={[{ tag: 'TAG1', description: 'Load', unit: 'kW', component: '' }]}>
                    <HighlightsPanel {...makeProps({ valueHighlight })} />
                </SensorMetaProvider>,
            );
            const chip = document.querySelector('.highlights-chip-body--row b') as HTMLElement;
            expect(chip.textContent).toBe('1,500 – 12,345.5 kW');
            expect(chip.querySelector('.hl-unit')?.textContent).toBe(' kW');
            expect([...document.querySelectorAll('.fv-unit')].map(e => e.textContent)).toEqual(['kW', 'kW']);
        });

        it('shows the "applies to Scatter only" scope note', () => {
            render(<HighlightsPanel {...makeProps()} />);
            expect(screen.getByText(/Applies to Scatter only/)).toBeTruthy();
        });

        it('shows no compat banner on Scatter, but shows one (and disables the group) on Line and Pair Plot', () => {
            const { rerender } = render(<HighlightsPanel {...makeProps({ chartType: 'scatter' })} />);
            expect(screen.queryByText(/Only affects/)).toBeNull();

            rerender(<HighlightsPanel {...makeProps({ chartType: 'line' })} />);
            expect(screen.getByText(/Only affects/).textContent).toContain('Scatter');
            const fieldsets = document.querySelectorAll('fieldset');
            expect((fieldsets[1] as HTMLFieldSetElement).disabled).toBe(true); // [0] = By time, [1] = By value

            rerender(<HighlightsPanel {...makeProps({ chartType: 'pair' })} />);
            expect(screen.getByText(/Only affects/).textContent).toContain('Scatter');
        });
    });
});
