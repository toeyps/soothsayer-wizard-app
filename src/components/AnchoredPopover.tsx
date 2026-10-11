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
    /** The tallest this popover can grow while open (e.g. the sensor picker's list
     *  `max-height`). Used to decide below vs above ONCE at open, and — when it opens above —
     *  reserved as its height, so the content (the picker's search box) never moves while the
     *  user types or opens groups. Omitted → the height measured at open. */
    reserveHeight?: number;
    /** Called once per open, right after the first clamp has positioned the popover — the
     *  place to move focus into it (with `preventScroll`), so a focus-scroll can never fire
     *  before the popover is where it will stay. */
    onPlaced?: (el: HTMLDivElement) => void;
    children: ReactNode;
    style?: CSSProperties;
}

const GAP = 6;
const EDGE = 8;

/** The lowest `top` a popover may take: 8 px from the viewport edge, or 4 px under the main
 *  window's fixed custom titlebar (`.titlebar`, z-index 9999 — it would cover the popover).
 *  Read from the DOM, so windows without a titlebar keep the plain 8 px. */
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

/**
 * The clamp/flip math (pure, so it is unit-tested directly). Below the anchor unless the
 * popover's planned height does not fit there and there is more room above. Above, it is
 * anchored by its BOTTOM edge (6 px over the anchor) so it grows upward from the trigger, with
 * `reserveHeight` (capped to the room above) as a fixed height; a popover with no reserve that is
 * taller than the room above is pinned at `minTop` instead (it then overlaps the anchor rather
 * than sliding under the titlebar or off screen).
 */
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

/**
 * Floating popover rendered through `Portal` so it escapes any scrollable
 * ancestor's `overflow` clipping. Serves the colour picker, pin-Y-axis and
 * alarm-setpoints popovers.
 *
 * Position is computed ONCE from `anchorRect` (already viewport
 * coordinates, so `position: fixed` lines up directly) rather than
 * re-measured live on every scroll/resize. Instead, the popover closes
 * itself via `onRequestClose` as soon as the page scrolls or resizes —
 * without that it would stay rendered at its original screen position
 * while its anchor button scrolls away underneath it.
 */
export default function AnchoredPopover({ anchorRect, onRequestClose, width, reserveHeight, onPlaced, children, style }: AnchoredPopoverProps) {
    const onPlacedRef = useRef(onPlaced);
    onPlacedRef.current = onPlaced;
    // Ref so the scroll/resize listener below always calls the LATEST
    // onRequestClose without needing it in the effect's own dependency
    // array (callers typically pass an inline arrow function).
    const closeRef = useRef(onRequestClose);
    closeRef.current = onRequestClose;

    // The popover's own rendered element — needed both to tell a scroll
    // that originated INSIDE it (a long list or a horizontally-overflowing
    // input firing its own `scroll` event must not close the popover on
    // itself) apart from a scroll elsewhere and, below, to measure its
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
    // The below/above choice made at open; later re-clamps (ResizeObserver) keep it, so a list
    // that shrinks while the user types never makes the popover jump to the other side.
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

    // Holds the ResizeObserver set up below for the currently-mounted
    // popover element, so it can be torn down (and not leaked/duplicated)
    // when the node changes or unmounts.
    const resizeObserverRef = useRef<ResizeObserver | null>(null);

    const setPopoverRef = useCallback((node: HTMLDivElement | null) => {
        popoverRef.current = node;
        placementRef.current = null;
        resizeObserverRef.current?.disconnect();
        resizeObserverRef.current = null;
        if (node) {
            applyClamp(node);
            onPlacedRef.current?.(node);
            // The clamp above only runs once, right when the popover is
            // first inserted — content that grows AFTER that can push the
            // popover's bottom edge off screen with no way to reach it,
            // since `.sensor-popover` only scrolls internally once it hits
            // its own max-height. A ResizeObserver on the popover's own
            // element re-runs the SAME `applyClamp` logic whenever its
            // content box actually changes size. Guarded for environments
            // (jsdom in tests that don't need it) with no ResizeObserver at
            // all — those simply keep the open-time-only clamp.
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
