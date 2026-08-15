import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { TimeHighlight } from '../types';

const colorPickerCalls: any[] = [];
vi.mock('../components/dashboard/ColorPlatePicker', () => ({
    default: (props: any) => {
        colorPickerCalls.push(props);
        return <button onClick={() => props.onChange('#123456')}>set-color-{props.color}</button>;
    },
}));

import HighlightsPanel from '../components/dashboard/HighlightsPanel';

function makeProps(overrides: Partial<React.ComponentProps<typeof HighlightsPanel>> = {}) {
    return {
        timeHighlights: [] as TimeHighlight[],
        onAddTimeHighlight: vi.fn(),
        onToggleTimeHighlight: vi.fn(),
        onRemoveTimeHighlight: vi.fn(),
        onRecolorTimeHighlight: vi.fn(),
        onRenameTimeHighlight: vi.fn(),
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
            expect(screen.getByText('No highlights yet.')).toBeTruthy();
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

        it('opens the ColorPlatePicker on swatch click and calls onRecolorTimeHighlight when a colour is picked', () => {
            const onRecolorTimeHighlight = vi.fn();
            const timeHighlights: TimeHighlight[] = [
                { id: 'h1', start: '2026-01-01T00:00', end: '2026-01-01T01:00', label: 'Startup', color: '#ff0000', enabled: true },
            ];
            render(<HighlightsPanel {...makeProps({ timeHighlights, onRecolorTimeHighlight })} />);

            fireEvent.click(screen.getByTitle('Change colour'));
            expect(colorPickerCalls[0].color).toBe('#ff0000');
            fireEvent.click(screen.getByText('set-color-#ff0000'));
            expect(onRecolorTimeHighlight).toHaveBeenCalledWith('h1', '#123456');
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
            fireEvent.click(screen.getByTitle('Change colour'));
            expect(colorPickerCalls.length).toBeGreaterThan(0);

            rerender(<HighlightsPanel {...makeProps({ chartType: 'pair', timeHighlights })} />);
            expect(screen.queryByText(/^set-color-/)).toBeNull();
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
    });
});
