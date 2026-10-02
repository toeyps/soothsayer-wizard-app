import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import Portal from './Portal';

/** Viewport-relative rectangle of the element a popover is anchored to —
 *  the shape `Element.getBoundingClientRect()` returns, captured once at
 *  the moment the popover is opened (typically in the trigger button's own
 *  `onClick`, via `e.currentTarget.getBoundingClientRect()`). */
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
    /** Popover's own fixed pixel width. When given, the popover's RIGHT
     *  edge lines up with the anchor's right edge (matches the approved
     *  prototype's own `placePop()`, which right-aligns every popover
     *  except the plain colour swatch). Left-aligned to the anchor's own
     *  left edge when omitted. */
    width?: number;
    children: ReactNode;
    style?: CSSProperties;
}

/**
 * Floating popover rendered through `Portal` so it escapes any scrollable
 * ancestor's `overflow` clipping — this is specifically what the approved
 * visual-refresh spec requires for the color picker, pin-Y-axis, add-to-
 * failure-group, and alarm-setpoints popovers (see docs/PROJECT_HANDOVER.md's
 * 2026-09-30 SPEC FINAL entry: "popover ทุกตัว ... ต้องเรนเดอร์ผ่าน portal
 * ไม่อยู่ในรายการที่ scroll ได้" — the approved prototype's own build hit a
 * real clipping bug from rendering these inline inside a scrolling list).
 *
 * Position is computed ONCE from `anchorRect` (already viewport
 * coordinates, so `position: fixed` lines up directly) rather than
 * re-measured live on every scroll/resize. Instead, the popover closes
 * itself via `onRequestClose` as soon as the page scrolls or resizes —
 * without that it would stay rendered at its original screen position
 * while its anchor button scrolls away underneath it, which would look
 * like a worse bug than the clipping this component exists to fix.
 */
export default function AnchoredPopover({ anchorRect, onRequestClose, width, children, style }: AnchoredPopoverProps) {
    // Ref so the scroll/resize listener below always calls the LATEST
    // onRequestClose without needing it in the effect's own dependency
    // array (callers typically pass an inline arrow function).
    const closeRef = useRef(onRequestClose);
    closeRef.current = onRequestClose;

    useEffect(() => {
        if (!anchorRect) return;
        const handleViewportChange = () => closeRef.current();
        // `capture: true` so this also sees a scroll on any scrollable
        // ancestor (e.g. the sensor list's own overflow-y container), not
        // just a window-level scroll.
        window.addEventListener('scroll', handleViewportChange, true);
        window.addEventListener('resize', handleViewportChange);
        return () => {
            window.removeEventListener('scroll', handleViewportChange, true);
            window.removeEventListener('resize', handleViewportChange);
        };
        // Re-subscribing per anchorRect is harmless (same listener logic
        // every time) and keeps this simple — the important thing is the
        // listener exists for the whole time anchorRect is non-null.
    }, [anchorRect]);

    if (!anchorRect) return null;

    const top = anchorRect.bottom + 6;
    const left = width !== undefined
        ? Math.max(8, anchorRect.right - width)
        : anchorRect.left;

    return (
        <Portal>
            <div
                className="popover-surface sensor-popover"
                style={{
                    position: 'fixed',
                    top,
                    left,
                    width,
                    zIndex: 1000,
                    ...style,
                }}
                // Stops a click inside the popover from bubbling up to
                // whatever row/list it's anchored over (e.g. a sensor row's
                // own onClick toggles selection) — the popover's own
                // contents handle their own clicks.
                onClick={(e) => e.stopPropagation()}
            >
                {children}
            </div>
        </Portal>
    );
}
