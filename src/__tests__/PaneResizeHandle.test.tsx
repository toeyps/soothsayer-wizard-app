import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { PaneResizeHandle, readSavedPaneWidth } from '../components/PaneResizeHandle';

const KEY = 'test.pane';
const HOST_PX = 1000; // 60 % = 600

function Harness({ initial = 300, defaultWidth = 300, onChange }: { initial?: number; defaultWidth?: number; onChange?: (w: number) => void }) {
    const [w, setW] = useState(initial);
    return (
        <div data-testid="host">
            <div id="pane" data-testid="pane" style={{ width: w }} />
            <PaneResizeHandle
                width={w}
                defaultWidth={defaultWidth}
                onChange={v => { setW(v); onChange?.(v); }}
                storageKey={KEY}
                label="Resize sensor list"
                controls="pane"
            />
        </div>
    );
}

const handle = () => screen.getByRole('separator');
const now = () => Number(handle().getAttribute('aria-valuenow'));
const saved = () => localStorage.getItem(KEY);

beforeEach(() => {
    localStorage.clear();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
        () => ({ left: 50, width: HOST_PX, right: 50 + HOST_PX, top: 0, bottom: 500, height: 500, x: 50, y: 0, toJSON: () => ({}) }),
    );
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe('PaneResizeHandle ARIA', () => {
    it('is a focusable vertical separator with its real numbers and the pane it controls', () => {
        render(<Harness />);
        const h = handle();
        expect(h.getAttribute('aria-orientation')).toBe('vertical');
        expect(h.getAttribute('aria-label')).toBe('Resize sensor list');
        expect(h.getAttribute('aria-controls')).toBe('pane');
        expect(h.getAttribute('aria-valuemin')).toBe('260');
        expect(h.getAttribute('aria-valuemax')).toBe('600');
        expect(h.getAttribute('aria-valuenow')).toBe('300');
        expect(h.tabIndex).toBe(0);
        expect(h.style.left).toBe('300px');
    });

    it('a default narrower than 260 px (Special Sensors under 860 px) is the minimum', () => {
        render(<Harness initial={230} defaultWidth={230} />);
        expect(handle().getAttribute('aria-valuemin')).toBe('230');
        expect(now()).toBe(230);
    });
});

describe('PaneResizeHandle keys', () => {
    it('← / → step 20 px, Shift ×3, and every press is saved', () => {
        render(<Harness />);
        fireEvent.keyDown(handle(), { key: 'ArrowRight' });
        expect(now()).toBe(320);
        expect(saved()).toBe('320');
        fireEvent.keyDown(handle(), { key: 'ArrowRight', shiftKey: true });
        expect(now()).toBe(380);
        expect(saved()).toBe('380');
        fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
        expect(now()).toBe(360);
        fireEvent.keyDown(handle(), { key: 'ArrowLeft', shiftKey: true });
        expect(now()).toBe(300);
        expect(saved()).toBe('300');
    });

    it('Home = narrowest, End = widest, and steps clamp to the range', () => {
        render(<Harness />);
        fireEvent.keyDown(handle(), { key: 'End' });
        expect(now()).toBe(600);
        fireEvent.keyDown(handle(), { key: 'ArrowRight' });
        expect(now()).toBe(600);
        fireEvent.keyDown(handle(), { key: 'Home' });
        expect(now()).toBe(260);
        fireEvent.keyDown(handle(), { key: 'ArrowLeft', shiftKey: true });
        expect(now()).toBe(260);
        expect(saved()).toBe('260');
    });

    it('other keys are left alone', () => {
        const onChange = vi.fn();
        render(<Harness onChange={onChange} />);
        fireEvent.keyDown(handle(), { key: 'a' });
        expect(onChange).not.toHaveBeenCalled();
        expect(saved()).toBeNull();
    });
});

describe('PaneResizeHandle mouse', () => {
    it('double-click goes back to the default and saves it', () => {
        render(<Harness initial={500} />);
        fireEvent.doubleClick(handle());
        expect(now()).toBe(300);
        expect(saved()).toBe('300');
    });

    it('drag follows the pointer, clamps, and saves on release (not on every move)', () => {
        render(<Harness />);
        const h = handle();
        fireEvent.pointerDown(h, { button: 0, clientX: 350, pointerId: 1 });
        expect(h.className).toContain('is-drag');
        fireEvent.pointerMove(h, { clientX: 450, pointerId: 1 });
        expect(now()).toBe(400);
        expect(saved()).toBeNull();
        fireEvent.pointerMove(h, { clientX: 5000, pointerId: 1 });
        expect(now()).toBe(600);
        fireEvent.pointerUp(h, { clientX: 5000, pointerId: 1 });
        expect(h.className).not.toContain('is-drag');
        expect(saved()).toBe('600');
    });

    it('a click without a move does not shift the pane, wherever on the handle it lands', () => {
        render(<Harness />);
        const h = handle();
        fireEvent.pointerDown(h, { button: 0, clientX: 354, pointerId: 1 });
        fireEvent.pointerUp(h, { clientX: 354, pointerId: 1 });
        expect(now()).toBe(300);
    });

    it('a cancelled drag keeps and saves where it got to; moves after the release do nothing', () => {
        render(<Harness />);
        const h = handle();
        fireEvent.pointerDown(h, { button: 0, clientX: 350, pointerId: 1 });
        fireEvent.pointerMove(h, { clientX: 400, pointerId: 1 });
        fireEvent.pointerCancel(h, { pointerId: 1 });
        expect(saved()).toBe('350');
        fireEvent.pointerMove(h, { clientX: 500, pointerId: 1 });
        expect(now()).toBe(350);
    });
});

describe('saved width', () => {
    it('reads back what was saved; missing or junk falls back', () => {
        expect(readSavedPaneWidth(KEY, 300)).toBe(300);
        localStorage.setItem(KEY, '420');
        expect(readSavedPaneWidth(KEY, 300)).toBe(420);
        localStorage.setItem(KEY, 'abc');
        expect(readSavedPaneWidth(KEY, 300)).toBe(300);
        localStorage.setItem(KEY, '-5');
        expect(readSavedPaneWidth(KEY, 300)).toBe(300);
    });

    it('survives storage that throws, on read and on write', () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
        expect(readSavedPaneWidth(KEY, 300)).toBe(300);
        render(<Harness />);
        fireEvent.keyDown(handle(), { key: 'ArrowRight' });
        expect(now()).toBe(320);
    });

    it('a saved width over 60 % of the window pulls the pane in, without overwriting what is saved', () => {
        localStorage.setItem(KEY, '900');
        const onChange = vi.fn();
        render(<Harness initial={readSavedPaneWidth(KEY, 300)} onChange={onChange} />);
        act(() => {});
        expect(onChange).toHaveBeenCalledWith(600);
        expect(screen.getByTestId('pane').style.width).toBe('600px');
        expect(saved()).toBe('900');
    });
});
