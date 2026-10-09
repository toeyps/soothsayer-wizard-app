import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import AnchoredPopover, { computePopoverPlacement, popoverMinTop } from '../components/AnchoredPopover';

afterEach(() => {
    cleanup();
    // Same reasoning as Portal.test.tsx's own cleanup — the shared portal
    // container outlives the component tree.
    document.getElementById('wizard-portal-root')?.remove();
});

const rect = { top: 100, bottom: 120, left: 50, right: 70 };

describe('AnchoredPopover', () => {
    it('renders nothing when anchorRect is null', () => {
        render(
            <AnchoredPopover anchorRect={null} onRequestClose={vi.fn()}>
                <div data-testid="content">hi</div>
            </AnchoredPopover>,
        );
        expect(document.querySelector('[data-testid="content"]')).toBeNull();
        expect(document.getElementById('wizard-portal-root')).toBeNull();
    });

    it('renders its children through Portal when anchorRect is given', () => {
        render(
            <AnchoredPopover anchorRect={rect} onRequestClose={vi.fn()}>
                <div data-testid="content">hi</div>
            </AnchoredPopover>,
        );
        const portalRoot = document.getElementById('wizard-portal-root');
        expect(portalRoot).not.toBeNull();
        expect(portalRoot?.querySelector('[data-testid="content"]')?.textContent).toBe('hi');
    });

    it('positions itself below and left-aligned to the anchor when no width is given', () => {
        render(
            <AnchoredPopover anchorRect={rect} onRequestClose={vi.fn()}>
                <div>hi</div>
            </AnchoredPopover>,
        );
        const popover = document.querySelector('.sensor-popover') as HTMLElement;
        expect(popover.style.top).toBe('126px'); // bottom (120) + 6
        expect(popover.style.left).toBe('50px'); // anchor's own left
    });

    it('right-aligns to the anchor when a width is given, matching the approved prototype\'s own placePop()', () => {
        render(
            <AnchoredPopover anchorRect={rect} onRequestClose={vi.fn()} width={200}>
                <div>hi</div>
            </AnchoredPopover>,
        );
        const popover = document.querySelector('.sensor-popover') as HTMLElement;
        // right (70) - width (200) would be negative; clamped to the 8px minimum.
        expect(popover.style.left).toBe('8px');
        expect(popover.style.width).toBe('200px');
    });

    it('does not clamp when right-aligning fits on screen without going negative', () => {
        render(
            <AnchoredPopover anchorRect={{ top: 100, bottom: 120, left: 300, right: 400 }} onRequestClose={vi.fn()} width={150}>
                <div>hi</div>
            </AnchoredPopover>,
        );
        const popover = document.querySelector('.sensor-popover') as HTMLElement;
        expect(popover.style.left).toBe('250px'); // 400 - 150
    });

    it('stops a click inside the popover from bubbling to an ancestor handler', () => {
        const outerClick = vi.fn();
        render(
            <div onClick={outerClick}>
                <AnchoredPopover anchorRect={rect} onRequestClose={vi.fn()}>
                    <button data-testid="inner-btn">click me</button>
                </AnchoredPopover>
            </div>,
        );
        fireEvent.click(document.querySelector('[data-testid="inner-btn"]')!);
        expect(outerClick).not.toHaveBeenCalled();
    });

    it('closes itself when the window scrolls (anchor position was only captured once, not tracked live)', () => {
        const onRequestClose = vi.fn();
        render(
            <AnchoredPopover anchorRect={rect} onRequestClose={onRequestClose}>
                <div>hi</div>
            </AnchoredPopover>,
        );
        expect(onRequestClose).not.toHaveBeenCalled();
        fireEvent.scroll(window);
        expect(onRequestClose).toHaveBeenCalledTimes(1);
    });

    it('closes itself when the window resizes', () => {
        const onRequestClose = vi.fn();
        render(
            <AnchoredPopover anchorRect={rect} onRequestClose={onRequestClose}>
                <div>hi</div>
            </AnchoredPopover>,
        );
        fireEvent.resize(window);
        expect(onRequestClose).toHaveBeenCalledTimes(1);
    });

    it('does not install a scroll/resize listener once closed (anchorRect null)', () => {
        const onRequestClose = vi.fn();
        const { rerender } = render(
            <AnchoredPopover anchorRect={rect} onRequestClose={onRequestClose}>
                <div>hi</div>
            </AnchoredPopover>,
        );
        rerender(
            <AnchoredPopover anchorRect={null} onRequestClose={onRequestClose}>
                <div>hi</div>
            </AnchoredPopover>,
        );
        fireEvent.scroll(window);
        expect(onRequestClose).not.toHaveBeenCalled();
    });
});

describe('computePopoverPlacement (clamp / flip math)', () => {
    const base = { width: 200, vw: 1000, vh: 800, minTop: 8 };
    const anchor = (top: number) => ({ top, bottom: top + 24, left: 100, right: 300 });

    it('opens below the anchor when it fits', () => {
        expect(computePopoverPlacement({ ...base, anchor: anchor(100), height: 300 }))
            .toEqual({ placement: 'below', top: 130, bottom: null, left: 100, height: null });
    });

    it('never puts its top under the titlebar: clamped to minTop (titlebar bottom + 4), not just 8', () => {
        // Below, but taller than the room below and no better above → slides up, stopping at minTop.
        const p = computePopoverPlacement({ ...base, minTop: 36, anchor: anchor(40), height: 900 });
        expect(p.placement).toBe('below');
        expect(p.top).toBe(36);
        // Above with no reserve, taller than the room above → pinned at minTop.
        const q = computePopoverPlacement({ ...base, minTop: 36, anchor: anchor(700), height: 760 });
        expect(q).toMatchObject({ placement: 'above', top: 36, bottom: null });
    });

    it('flipped upward it is anchored by its BOTTOM edge (6 px over the anchor), so it grows upward', () => {
        const p = computePopoverPlacement({ ...base, anchor: anchor(700), height: 300 });
        expect(p).toEqual({ placement: 'above', top: null, bottom: 800 - 700 + 6, left: 100, height: null });
    });

    it('decides on the reserved height, and reserves it (capped to the room above, under the titlebar)', () => {
        // Fits below at its current 100 px, but the list can grow to 380 → opens above with 380 reserved.
        const p = computePopoverPlacement({ ...base, anchor: anchor(600), height: 100, reserveHeight: 380 });
        expect(p).toMatchObject({ placement: 'above', bottom: 206, height: 380 });
        // Not enough room above for the whole reserve: capped to anchor.top - 6 - minTop.
        const q = computePopoverPlacement({ ...base, minTop: 36, anchor: anchor(300), vh: 400, height: 100, reserveHeight: 380 });
        expect(q).toMatchObject({ placement: 'above', height: 300 - 6 - 36 });
    });

    it('keeps the placement chosen at open on later re-clamps (no flip-flop while the list shrinks)', () => {
        const p = computePopoverPlacement({ ...base, anchor: anchor(700), height: 40, placement: 'above' });
        expect(p.placement).toBe('above');
        expect(p.bottom).toBe(106);
    });

    it('right-aligns with a width, and keeps 8 px off the right edge', () => {
        expect(computePopoverPlacement({ ...base, anchor: anchor(100), height: 50, alignWidth: 150 }).left).toBe(150);
        expect(computePopoverPlacement({ ...base, anchor: { top: 100, bottom: 124, left: 900, right: 990 }, height: 50 }).left).toBe(1000 - 200 - 8);
    });
});

describe('popoverMinTop', () => {
    it('is 8 px without a titlebar, and 4 px under the main window fixed titlebar when there is one', () => {
        expect(popoverMinTop()).toBe(8);
        const tb = document.createElement('div');
        tb.className = 'titlebar';
        tb.getBoundingClientRect = () => ({ top: 0, bottom: 32, left: 0, right: 1000, width: 1000, height: 32, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
        document.body.appendChild(tb);
        expect(popoverMinTop()).toBe(36);
        tb.remove();
    });

    it('a popover flipped near the top of the main window stays below the titlebar', () => {
        const tb = document.createElement('div');
        tb.className = 'titlebar';
        tb.getBoundingClientRect = () => ({ top: 0, bottom: 32, left: 0, right: 1000, width: 1000, height: 32, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
        document.body.appendChild(tb);
        const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            if (this.classList.contains('titlebar')) return { top: 0, bottom: 32 } as DOMRect;
            return { top: 0, bottom: 2000, left: 0, right: 200, width: 200, height: 2000, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
        });
        render(
            <AnchoredPopover anchorRect={{ top: 40, bottom: 60, left: 10, right: 30 }} onRequestClose={vi.fn()}>
                <div>tall</div>
            </AnchoredPopover>,
        );
        const popover = document.querySelector('.sensor-popover') as HTMLElement;
        expect(parseFloat(popover.style.top)).toBe(36);
        spy.mockRestore();
        tb.remove();
    });
});

