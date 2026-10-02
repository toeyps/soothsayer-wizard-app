import { useCallback, useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';
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

    // The popover's own rendered element — needed both to tell a scroll
    // that originated INSIDE it apart from a scroll elsewhere (bug: a long
    // list or a horizontally-overflowing input firing its own `scroll`
    // event used to close the popover on itself) and, below, to measure its
    // real on-screen size for the viewport clamp/flip pass.
    const popoverRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!anchorRect) return;
        const handleViewportChange = (event: Event) => {
            // A scroll that happened inside the popover (its own `overflow-
            // y: auto` list, or a text/number input scrolling its content
            // horizontally once it overflows) does not invalidate the
            // anchor position — only a scroll of the page/list BEHIND the
            // popover does, since that's what actually moves the anchor
            // out from under it.
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

    // Viewport clamp/flip pass. The popover is first rendered (below) at
    // its "natural" position — directly under the anchor, right-aligned to
    // it when `width` is given — but that can push it partly or fully off
    // screen (anchor near the bottom/right edge). Its real size isn't known
    // until it has rendered, so this measures the actual element via
    // `getBoundingClientRect()` and nudges its inline `top`/`left` back on
    // screen if needed, flipping above the anchor instead of below when
    // that leaves more of the popover visible.
    //
    // This runs from a CALLBACK ref, not a `useLayoutEffect` keyed on
    // `anchorRect` — `Portal` (see its own doc comment) mounts its children
    // into `#wizard-portal-root` only after ITS OWN `useEffect` runs, one
    // commit after this component's first render/layout-effect pass. A
    // `useLayoutEffect` here would run too early, see `popoverRef.current`
    // as still null, and silently no-op forever (caught by hand: the clamp
    // never actually applied in any test until this was switched to a
    // callback ref). A callback ref fires exactly when the host node is
    // actually inserted into the DOM, whichever commit that turns out to
    // be, so it reliably catches the delayed portal mount.
    const applyClamp = useCallback((el: HTMLDivElement) => {
        if (!anchorRect) return;
        const vh = window.innerHeight;
        const vw = window.innerWidth;
        const rect = el.getBoundingClientRect();
        const popoverHeight = rect.height;
        const popoverWidth = width ?? rect.width;

        const naturalTop = anchorRect.bottom + 6;
        const spaceBelow = vh - anchorRect.bottom - 6;
        const spaceAbove = anchorRect.top - 6;
        let top: number;
        if (popoverHeight > spaceBelow && spaceAbove > spaceBelow) {
            // More room above the anchor than below, and it doesn't fit
            // below as-is — flip to open upward instead.
            top = Math.max(8, anchorRect.top - popoverHeight - 6);
        } else {
            // Keep the natural (below-anchor) placement, but never let the
            // popover's bottom edge run past the viewport.
            top = Math.min(naturalTop, Math.max(8, vh - popoverHeight - 8));
        }

        const naturalLeft = width !== undefined
            ? Math.max(8, anchorRect.right - width)
            : anchorRect.left;
        let left = naturalLeft;
        if (left + popoverWidth > vw - 8) {
            left = Math.max(8, vw - popoverWidth - 8);
        }

        el.style.top = `${top}px`;
        el.style.left = `${left}px`;
    }, [anchorRect, width]);

    // Holds the ResizeObserver set up below for the currently-mounted
    // popover element, so it can be torn down (and not leaked/duplicated)
    // when the node changes or unmounts.
    const resizeObserverRef = useRef<ResizeObserver | null>(null);

    const setPopoverRef = useCallback((node: HTMLDivElement | null) => {
        popoverRef.current = node;
        resizeObserverRef.current?.disconnect();
        resizeObserverRef.current = null;
        if (node) {
            applyClamp(node);
            // The clamp above only runs once, right when the popover is
            // first inserted — content that grows AFTER that (e.g. the
            // add-to-failure-group menu adding a row for a group just
            // created from its own "Create" button, still open) can push
            // the popover's bottom edge off screen with no way to reach it,
            // since `.sensor-popover` only scrolls internally once it hits
            // its own max-height (QA sweep, 2026-10-02). A ResizeObserver on
            // the popover's own element re-runs the SAME `applyClamp` logic
            // whenever its content box actually changes size, so a popover
            // that grows while open gets nudged back on screen exactly the
            // way it was positioned at open time, instead of needing to be
            // closed and reopened to recompute. Guarded for environments
            // (jsdom in tests that don't need it) with no ResizeObserver at
            // all — those simply keep the open-time-only clamp, same as
            // before this fix.
            if (typeof ResizeObserver !== 'undefined') {
                const ro = new ResizeObserver(() => applyClamp(node));
                ro.observe(node);
                resizeObserverRef.current = ro;
            }
        }
    }, [applyClamp]);

    // Belt-and-suspenders re-clamp for the (currently unused) case of
    // `anchorRect`/`width` changing on an ALREADY-mounted instance, without
    // a fresh ref attach — every current caller instead fully unmounts and
    // remounts a fresh AnchoredPopover per anchor (see callers' `key`s), so
    // the callback ref above is what actually fires in practice, but this
    // keeps the clamp correct if that assumption ever changes.
    useLayoutEffect(() => {
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
