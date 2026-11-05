import { useCallback, useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import Portal from './Portal';

/** Viewport rectangle of the anchor, captured when the popover opens (getBoundingClientRect). */
export interface PopoverAnchorRect {
    top: number;
    bottom: number;
    left: number;
    right: number;
}

interface AnchoredPopoverProps {
    /** `null` renders nothing — same "closed" state as not rendering the
     *  popover at all. */
    anchorRect: PopoverAnchorRect | null;
    /** Called when the popover should close itself because the page
     *  scrolled out from under its anchor — see the scroll note below. */
    onRequestClose: () => void;
    /** Fixed width; the right edge aligns to the anchor's right edge. Omitted = left-aligned. */
    width?: number;
    /** Tallest it can grow: decides below/above at open and is reserved as height when above. Omitted = height measured at open. */
    reserveHeight?: number;
    /** Called once per open after the first clamp; move focus here with `preventScroll`. */
    onPlaced?: (el: HTMLDivElement) => void;
    children: ReactNode;
    style?: CSSProperties;
}

const GAP = 6;
const EDGE = 8;

/** Lowest `top`: 8px from the viewport edge or 4px under the fixed titlebar (z-index 9999). */
export function popoverMinTop(): number {
    const tb = typeof document !== 'undefined' ? document.querySelector('.titlebar') : null;
    const bottom = tb ? tb.getBoundingClientRect().bottom : 0;
    return Math.max(EDGE, bottom > 0 ? bottom + 4 : 0);
}

export interface PopoverPlacementInput {
    anchor: PopoverAnchorRect;
    /** Measured popover size. */
    height: number;
    width: number;
    /** The `width` prop (right-aligns to the anchor when given). */
    alignWidth?: number;
    vw: number;
    vh: number;
    minTop: number;
    reserveHeight?: number;
    /** A placement already chosen at open — kept on later re-clamps so the popover never flips
     *  between below and above while open. */
    placement?: 'below' | 'above';
}

export interface PopoverPlacement {
    placement: 'below' | 'above';
    /** Exactly one of `top` / `bottom` is set (`bottom` = distance from the viewport bottom). */
    top: number | null;
    bottom: number | null;
    left: number;
    /** A fixed height (reserved when opening above), or null for auto. */
    height: number | null;
}

/** Clamp/flip: below unless it won't fit and above has more room; above is bottom-anchored with `reserveHeight`, else at `minTop`. */
export function computePopoverPlacement(i: PopoverPlacementInput): PopoverPlacement {
    const { anchor, height, vw, vh, minTop, reserveHeight } = i;
    const popoverWidth = i.alignWidth ?? i.width;
    let left = i.alignWidth !== undefined ? Math.max(EDGE, anchor.right - i.alignWidth) : anchor.left;
    if (left + popoverWidth > vw - EDGE) left = Math.max(EDGE, vw - popoverWidth - EDGE);

    const spaceBelow = vh - anchor.bottom - GAP;
    const spaceAbove = anchor.top - GAP - minTop;
    const plan = Math.max(height, reserveHeight ?? 0);
    const placement = i.placement ?? (plan > spaceBelow && spaceAbove > spaceBelow ? 'above' : 'below');

    if (placement === 'above') {
        const bottom = vh - anchor.top + GAP;
        if (reserveHeight !== undefined) {
            return { placement, top: null, bottom, left, height: Math.max(0, Math.min(plan, spaceAbove)) };
        }
        if (height <= spaceAbove) return { placement, top: null, bottom, left, height: null };
        return { placement, top: minTop, bottom: null, left, height: null };
    }
    // Below: keep the natural placement, but never let the bottom edge run past the viewport
    // (nor the top edge under the titlebar).
    const top = Math.min(anchor.bottom + GAP, Math.max(minTop, vh - height - EDGE));
    return { placement, top, bottom: null, left, height: null };
}

/** Rendered through `Portal` to escape scroll clipping; closes via `onRequestClose` on page scroll or resize. */
export default function AnchoredPopover({ anchorRect, onRequestClose, width, reserveHeight, onPlaced, children, style }: AnchoredPopoverProps) {
    const onPlacedRef = useRef(onPlaced);
    onPlacedRef.current = onPlaced;
    // Ref so the listener calls the latest `onRequestClose` without making it an effect dependency.
    const closeRef = useRef(onRequestClose);
    closeRef.current = onRequestClose;

    // Own element: to ignore scrolls inside it and to measure it for the clamp.
    const popoverRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!anchorRect) return;
        const handleViewportChange = (event: Event) => {
            // A scroll inside the popover does not move the anchor; only a scroll behind it does.
            if (
                event.type === 'scroll' &&
                popoverRef.current &&
                event.target instanceof Node &&
                popoverRef.current.contains(event.target)
            ) {
                return;
            }
            closeRef.current();
        };
        // `capture: true` so scrolls on any scrollable ancestor are seen.
        window.addEventListener('scroll', handleViewportChange, true);
        window.addEventListener('resize', handleViewportChange);
        return () => {
            window.removeEventListener('scroll', handleViewportChange, true);
            window.removeEventListener('resize', handleViewportChange);
        };
    }, [anchorRect]);

    // Clamp/flip runs from a callback ref: Portal mounts children one commit later, so a layout effect sees a null ref.
    // The below/above choice made at open is kept on re-clamp so the popover never jumps sides.
    const placementRef = useRef<'below' | 'above' | null>(null);
    const applyClamp = useCallback((el: HTMLDivElement) => {
        if (!anchorRect) return;
        const rect = el.getBoundingClientRect();
        const p = computePopoverPlacement({
            anchor: anchorRect,
            height: rect.height,
            width: rect.width,
            alignWidth: width,
            vw: window.innerWidth,
            vh: window.innerHeight,
            minTop: popoverMinTop(),
            reserveHeight,
            placement: placementRef.current ?? undefined,
        });
        placementRef.current = p.placement;
        el.style.top = p.top !== null ? `${p.top}px` : 'auto';
        el.style.bottom = p.bottom !== null ? `${p.bottom}px` : '';
        if (p.height !== null) el.style.height = `${p.height}px`;
        el.style.left = `${p.left}px`;
        el.dataset.placement = p.placement;
    }, [anchorRect, width, reserveHeight]);

    // Holds the ResizeObserver for the mounted element so it is torn down on change or unmount.
    const resizeObserverRef = useRef<ResizeObserver | null>(null);

    const setPopoverRef = useCallback((node: HTMLDivElement | null) => {
        popoverRef.current = node;
        placementRef.current = null;
        resizeObserverRef.current?.disconnect();
        resizeObserverRef.current = null;
        if (node) {
            applyClamp(node);
            onPlacedRef.current?.(node);
            // Re-clamp when content grows after open (the clamp otherwise runs once). Skipped where ResizeObserver is missing (jsdom).
            if (typeof ResizeObserver !== 'undefined') {
                const ro = new ResizeObserver(() => applyClamp(node));
                ro.observe(node);
                resizeObserverRef.current = ro;
            }
        }
    }, [applyClamp]);

    // Re-clamp if anchorRect/width change on a mounted instance; current callers remount per anchor.
    useLayoutEffect(() => {
        placementRef.current = null;
        if (popoverRef.current) applyClamp(popoverRef.current);
    }, [applyClamp]);

    if (!anchorRect) return null;

    const top = anchorRect.bottom + 6;
    const left = width !== undefined
        ? Math.max(8, anchorRect.right - width)
        : anchorRect.left;

    return (
        <Portal>
            <div
                ref={setPopoverRef}
                className="popover-surface sensor-popover"
                style={{
                    position: 'fixed',
                    top,
                    left,
                    width,
                    zIndex: 1000,
                    ...style,
                }}
                // Stop clicks inside from reaching the anchored row's onClick.
                onClick={(e) => e.stopPropagation()}
            >
                {children}
            </div>
        </Portal>
    );
}
