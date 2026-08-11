import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import ColorPlatePicker from '../components/dashboard/ColorPlatePicker';

let origGetBoundingClientRect: typeof Element.prototype.getBoundingClientRect;
let origSetPointerCapture: any;

beforeEach(() => {
    origGetBoundingClientRect = Element.prototype.getBoundingClientRect;
    origSetPointerCapture = (Element.prototype as any).setPointerCapture;
    Element.prototype.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON() {} }) as DOMRect;
    (Element.prototype as any).setPointerCapture = vi.fn(); // jsdom doesn't implement this
});

afterEach(() => {
    Element.prototype.getBoundingClientRect = origGetBoundingClientRect;
    (Element.prototype as any).setPointerCapture = origSetPointerCapture;
});

describe('ColorPlatePicker', () => {
    it('clicking the top-left corner of the SV square yields white regardless of hue', () => {
        const onChange = vi.fn();
        const { container } = render(<ColorPlatePicker color="#ff0000" onChange={onChange} />);
        const square = container.querySelectorAll('div')[1]; // squareRef div
        fireEvent.pointerDown(square, { clientX: 0, clientY: 0, pointerId: 1 });
        expect(onChange).toHaveBeenCalledWith('#ffffff');
    });

    it('clicking the bottom-right corner of the SV square yields black regardless of hue', () => {
        const onChange = vi.fn();
        const { container } = render(<ColorPlatePicker color="#ff0000" onChange={onChange} />);
        const square = container.querySelectorAll('div')[1];
        fireEvent.pointerDown(square, { clientX: 100, clientY: 100, pointerId: 1 });
        expect(onChange).toHaveBeenCalledWith('#000000');
    });

    it('clicking mid-square at a known point produces the exact expected hex', () => {
        const onChange = vi.fn();
        const { container } = render(<ColorPlatePicker color="#ff0000" onChange={onChange} />);
        const square = container.querySelectorAll('div')[1];
        fireEvent.pointerDown(square, { clientX: 50, clientY: 25, pointerId: 1 });
        expect(onChange).toHaveBeenCalledWith('#bf6060');
    });

    it('dragging (pointermove with the button held) keeps emitting new colors', () => {
        const onChange = vi.fn();
        const { container } = render(<ColorPlatePicker color="#ff0000" onChange={onChange} />);
        const square = container.querySelectorAll('div')[1];
        fireEvent.pointerMove(square, { clientX: 0, clientY: 0, buttons: 1 });
        expect(onChange).toHaveBeenCalledWith('#ffffff');
    });

    it('does not emit on pointermove when no button is held (hover only)', () => {
        const onChange = vi.fn();
        const { container } = render(<ColorPlatePicker color="#ff0000" onChange={onChange} />);
        const square = container.querySelectorAll('div')[1];
        fireEvent.pointerMove(square, { clientX: 0, clientY: 0, buttons: 0 });
        expect(onChange).not.toHaveBeenCalled();
    });

    it('clicking the hue slider changes hue while preserving current saturation/value', () => {
        const onChange = vi.fn();
        const { container } = render(<ColorPlatePicker color="#ff0000" onChange={onChange} />);
        const hueSlider = container.querySelectorAll('div')[3]; // hueRef div
        fireEvent.pointerDown(hueSlider, { clientX: 100 / 3, clientY: 6, pointerId: 1 }); // x/width = 1/3 -> hue 120
        expect(onChange).toHaveBeenCalledWith('#00ff00');
    });

    it('clicking further along the hue slider selects a different hue', () => {
        const onChange = vi.fn();
        const { container } = render(<ColorPlatePicker color="#ff0000" onChange={onChange} />);
        const hueSlider = container.querySelectorAll('div')[3];
        fireEvent.pointerDown(hueSlider, { clientX: (100 * 2) / 3, clientY: 6, pointerId: 1 }); // 2/3 -> hue 240
        expect(onChange).toHaveBeenCalledWith('#0000ff');
    });

    it('re-derives h/s/v from a genuinely new color prop', () => {
        const onChange = vi.fn();
        const { container, rerender } = render(<ColorPlatePicker color="#ff0000" onChange={onChange} />);
        rerender(<ColorPlatePicker color="#00ff00" onChange={onChange} />);
        // Clicking the SV square's top-left corner now yields white regardless
        // of the (new) hue, same invariant as before — confirms the picker
        // picked up the new color rather than staying pinned to the old hue.
        const square = container.querySelectorAll('div')[1];
        fireEvent.pointerDown(square, { clientX: 0, clientY: 0, pointerId: 1 });
        expect(onChange).toHaveBeenCalledWith('#ffffff');
    });

    it('does not re-derive h/s/v when the parent echoes back the exact color this component just emitted', () => {
        // Regression guard for the hue-360-vs-0 wraparound bug described in
        // the component's own comments: re-deriving on every render would
        // snap the hue thumb back to 0 the instant the parent's state
        // update round-trips the emitted value back down as `color`.
        const onChange = vi.fn();
        const { container, rerender } = render(<ColorPlatePicker color="#ff0000" onChange={onChange} />);
        const hueSlider = container.querySelectorAll('div')[3];
        fireEvent.pointerDown(hueSlider, { clientX: 99.9, clientY: 6, pointerId: 1 }); // hue ~359.6, still red-ish
        const emitted = onChange.mock.calls[onChange.mock.calls.length - 1][0];

        // Parent re-renders with the exact value we just emitted.
        rerender(<ColorPlatePicker color={emitted} onChange={onChange} />);
        onChange.mockClear();

        // A tiny nudge on the hue slider near the same spot should move hue
        // forward from ~359.6, not snap back to 0 first.
        const hueSlider2 = container.querySelectorAll('div')[3];
        fireEvent.pointerDown(hueSlider2, { clientX: 99.9, clientY: 6, pointerId: 1 });
        expect(onChange).toHaveBeenCalledWith(emitted); // same position -> same result, not reset-then-jump
    });
});
