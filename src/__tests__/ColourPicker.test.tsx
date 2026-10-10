import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useState } from 'react';
import ColourPicker, { COLOUR_PALETTE, HEX_ERROR, parseHexColour } from '../components/sensor/ColourPicker';
import { LINE_CHART_COLORS } from '../components/charts/LineChart';
// @ts-expect-error - @types/node is not installed; vitest runs in Node so this resolves at runtime
import { readFileSync } from 'node:fs';

// Customer item 4 (SPEC FINAL 2026-10-09 §1, DESIGN_SYSTEM §4 "Colour picking — ONE picker").

afterEach(() => {
    cleanup();
    document.getElementById('wizard-portal-root')?.remove();
});

function Harness(props: { initial?: string; used?: string[]; onChange?: (h: string) => void; disabled?: boolean }) {
    const [c, setC] = useState(props.initial ?? '#3b82f6');
    return (
        <>
            <ColourPicker
                color={c}
                used={props.used}
                label="Bearing temperature"
                title="Line colour"
                disabled={props.disabled}
                onChange={(h) => { setC(h); props.onChange?.(h); }}
            />
            <button type="button">outside</button>
        </>
    );
}

const swatchBtn = () => screen.getByRole('button', { name: 'Line colour: Bearing temperature' });
const pop = () => document.querySelector('.cp-pop') as HTMLElement;
const sw = (hex: string) => pop().querySelector(`.cp-sw[title^="${hex}"]`) as HTMLButtonElement;

describe('parseHexColour (hex field input formats)', () => {
    it('accepts 6 hex digits with or without #, any case, surrounding spaces; returns lower case', () => {
        expect(parseHexColour('#3B82F6')).toBe('#3b82f6');
        expect(parseHexColour('3b82f6')).toBe('#3b82f6');
        expect(parseHexColour('  #a1B2c3 ')).toBe('#a1b2c3');
    });
    it('rejects anything else (3 digits, 8 digits, non-hex, empty)', () => {
        for (const bad of ['#abc', '#3b82f6ff', '#3b82fg', '', '#', 'rgb(1,2,3)']) expect(parseHexColour(bad)).toBeNull();
    });
});

describe('ColourPicker', () => {
    it('the 16 px swatch inside a 24 px hit area IS the button — no pipette icon', () => {
        render(<Harness />);
        const b = swatchBtn();
        expect(b.classList.contains('cp-hit')).toBe(true);
        expect((b.querySelector('.cp-swatch') as HTMLElement).style.background).toBe('rgb(59, 130, 246)');
        expect(b.querySelector('svg')).toBeNull();
        expect(b.getAttribute('aria-haspopup')).toBe('dialog');
    });

    it('opens a popover with the 12 palette swatches in the §4 order, the current one ringed and checked', () => {
        render(<Harness initial="#10b981" />);
        fireEvent.click(swatchBtn());
        const swatches = [...pop().querySelectorAll('.cp-sw')].map(s => s.getAttribute('title')!.slice(0, 7));
        expect(swatches).toEqual([...COLOUR_PALETTE]);
        expect(COLOUR_PALETTE.length).toBe(12);
        expect(sw('#10b981').classList.contains('sel')).toBe(true);
        expect(sw('#10b981').getAttribute('aria-checked')).toBe('true');
        expect(sw('#10b981').querySelector('.cp-chk')).toBeTruthy();
        expect(document.activeElement).toBe(sw('#10b981'));
        expect(screen.getByRole('dialog', { name: 'Colour for Bearing temperature' })).toBe(pop());
        expect(pop().querySelector('.cp-head-hex')?.textContent).toBe('#10b981');
    });

    it('the palette is the same 12 colours as the line chart defaults (so the ring and dots always match)', () => {
        expect([...COLOUR_PALETTE].sort()).toEqual([...LINE_CHART_COLORS].sort());
    });

    it('marks colours another item on the chart already uses with a dot (+ a legend), never on the current one', () => {
        render(<Harness initial="#3b82f6" used={['#F43F5E', '#3b82f6', '#123456']} />);
        fireEvent.click(swatchBtn());
        expect(sw('#f43f5e').querySelector('.cp-used')).toBeTruthy();
        expect(sw('#f43f5e').title).toBe('#f43f5e · in use on this chart');
        expect(sw('#3b82f6').querySelector('.cp-used')).toBeNull();
        expect(pop().querySelector('.cp-legend')?.textContent).toBe('In use on this chart');
    });

    it('no colour in use → no legend', () => {
        render(<Harness />);
        fireEvent.click(swatchBtn());
        expect(pop().querySelector('.cp-legend')).toBeNull();
    });

    it('a pick applies immediately and the popover stays open', () => {
        const onChange = vi.fn();
        render(<Harness onChange={onChange} />);
        fireEvent.click(swatchBtn());
        fireEvent.click(sw('#8b5cf6'));
        expect(onChange).toHaveBeenCalledWith('#8b5cf6');
        expect(pop()).toBeTruthy();
        expect(sw('#8b5cf6').classList.contains('sel')).toBe(true);
    });

    it('arrow keys move across the 6 × 2 grid', () => {
        render(<Harness />);
        fireEvent.click(swatchBtn());
        fireEvent.keyDown(sw('#3b82f6'), { key: 'ArrowRight' });
        expect(document.activeElement).toBe(sw('#10b981'));
        fireEvent.keyDown(sw('#10b981'), { key: 'ArrowDown' });
        expect(document.activeElement).toBe(sw(COLOUR_PALETTE[7]));
        fireEvent.keyDown(sw(COLOUR_PALETTE[7]), { key: 'ArrowUp' });
        expect(document.activeElement).toBe(sw('#10b981'));
        fireEvent.keyDown(sw('#10b981'), { key: 'ArrowLeft' });
        expect(document.activeElement).toBe(sw('#3b82f6'));
    });

    it('Esc closes and returns focus to the swatch button', async () => {
        render(<Harness />);
        fireEvent.click(swatchBtn());
        fireEvent.keyDown(sw('#3b82f6'), { key: 'Escape' });
        expect(pop()).toBeNull();
        await waitFor(() => expect(document.activeElement).toBe(swatchBtn()));
    });

    it('a mousedown outside closes it; a click on the button toggles it', () => {
        render(<Harness />);
        fireEvent.click(swatchBtn());
        fireEvent.mouseDown(screen.getByText('outside'));
        expect(pop()).toBeNull();
        fireEvent.click(swatchBtn());
        expect(pop()).toBeTruthy();
        fireEvent.click(swatchBtn());
        expect(pop()).toBeNull();
    });

    it('Tab past the last control closes the popover', () => {
        render(<Harness />);
        fireEvent.click(swatchBtn());
        const custom = screen.getByRole('button', { name: 'Custom colour' });
        custom.focus();
        fireEvent.keyDown(custom, { key: 'Tab' });
        expect(pop()).toBeNull();
    });

    it('Shift+Tab from the first control (the palette) closes the popover too, back to the swatch button', async () => {
        render(<Harness />);
        fireEvent.click(swatchBtn());
        expect(document.activeElement).toBe(sw('#3b82f6'));
        fireEvent.keyDown(sw('#3b82f6'), { key: 'Tab', shiftKey: true });
        expect(pop()).toBeNull();
        await waitFor(() => expect(document.activeElement).toBe(swatchBtn()));
    });

    it('Shift+Tab from a later control stays inside (normal tabbing)', () => {
        render(<Harness />);
        fireEvent.click(swatchBtn());
        const custom = screen.getByRole('button', { name: 'Custom colour' });
        custom.focus();
        fireEvent.keyDown(custom, { key: 'Tab', shiftKey: true });
        expect(pop()).not.toBeNull();
    });

    it('focus moves to the current swatch once placed, with preventScroll (no autoFocus)', () => {
        const focus = vi.spyOn(HTMLElement.prototype, 'focus');
        render(<Harness initial="#10b981" />);
        fireEvent.click(swatchBtn());
        expect(sw('#10b981').hasAttribute('autofocus')).toBe(false);
        expect(document.activeElement).toBe(sw('#10b981'));
        const i = focus.mock.contexts.findIndex(c => c === sw('#10b981'));
        expect(focus.mock.calls[i]?.[0]).toEqual({ preventScroll: true });
        focus.mockRestore();
    });

    describe('Custom colour', () => {
        it('the hex field is not rewritten while the user is typing in it; it is tidied on blur', () => {
            const onChange = vi.fn();
            render(<Harness onChange={onChange} />);
            fireEvent.click(swatchBtn());
            fireEvent.click(screen.getByRole('button', { name: 'Custom colour' }));
            const input = screen.getByLabelText('Hex colour') as HTMLInputElement;
            input.focus();
            fireEvent.change(input, { target: { value: 'ABCDEF' } });
            expect(onChange).toHaveBeenLastCalledWith('#abcdef');
            expect(input.value).toBe('ABCDEF'); // not reformatted under the cursor
            fireEvent.blur(input);
            expect(input.value).toBe('#abcdef');
        });

        it('a palette pick still updates the hex field (it is not focused then)', () => {
            render(<Harness />);
            fireEvent.click(swatchBtn());
            fireEvent.click(screen.getByRole('button', { name: 'Custom colour' }));
            fireEvent.click(sw('#f43f5e'));
            expect((screen.getByLabelText('Hex colour') as HTMLInputElement).value).toBe('#f43f5e');
        });

        it('opens by itself when the current colour is not a palette colour, with the HSV plate and a hex field', () => {
            render(<Harness initial="#123456" />);
            fireEvent.click(swatchBtn());
            expect(screen.getByRole('button', { name: 'Custom colour' }).getAttribute('aria-expanded')).toBe('true');
            expect((screen.getByLabelText('Hex colour') as HTMLInputElement).value).toBe('#123456');
            expect(pop().querySelector('.cp-sw.sel')).toBeNull();
        });

        it('a valid hex (with or without #) applies immediately, lower-cased', () => {
            const onChange = vi.fn();
            render(<Harness onChange={onChange} />);
            fireEvent.click(swatchBtn());
            fireEvent.click(screen.getByRole('button', { name: 'Custom colour' }));
            fireEvent.change(screen.getByLabelText('Hex colour'), { target: { value: 'ABCDEF' } });
            expect(onChange).toHaveBeenLastCalledWith('#abcdef');
        });

        it('an invalid hex shows the fix message and changes nothing', () => {
            const onChange = vi.fn();
            render(<Harness onChange={onChange} />);
            fireEvent.click(swatchBtn());
            fireEvent.click(screen.getByRole('button', { name: 'Custom colour' }));
            const input = screen.getByLabelText('Hex colour') as HTMLInputElement;
            fireEvent.change(input, { target: { value: '#abc' } });
            expect(onChange).not.toHaveBeenCalled();
            expect(input.classList.contains('bad')).toBe(true);
            expect(input.getAttribute('aria-invalid')).toBe('true');
            expect(screen.getByRole('alert').textContent).toBe(HEX_ERROR);
            expect(HEX_ERROR).toBe('Use 6 hex digits, like #3b82f6.');
        });
    });

    it('disabled: no popover; disabling while open closes it', () => {
        const { rerender } = render(<Harness />);
        fireEvent.click(swatchBtn());
        expect(pop()).toBeTruthy();
        rerender(<Harness disabled />);
        expect(pop()).toBeNull();
        fireEvent.click(swatchBtn());
        expect(pop()).toBeNull();
    });

    it('never renders a native <input type="color">', () => {
        render(<Harness initial="#123456" />);
        fireEvent.click(swatchBtn());
        expect(document.querySelector('input[type="color"]')).toBeNull();
    });

    // Real-app bug (2026-10-11): with a long sensor name the popover's implicit `auto` grid column
    // grew to the heading's full nowrap width (372 px inside a 228 px popover), the swatch grid
    // stretched across it and the swatches came out twice their size, spilling out of the surface.
    // jsdom has no layout, so this pins the CSS rule that keeps the column at the popover's width.
    it('a long heading cannot widen the popover content: the column is minmax(0, 1fr) and the label ellipsises (CSS contract)', () => {
        const css: string = readFileSync('src/App.css', 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
        expect(css).toMatch(/\.cp-pop\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
        expect(css).toMatch(/\.cp-head-label\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis/);
    });
});
