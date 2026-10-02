import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import AnchoredPopover from '../components/AnchoredPopover';

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
