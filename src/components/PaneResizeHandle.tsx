import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * The ONE resize handle for a list pane next to long sensor names (DESIGN_SYSTEM §4 rule 7).
 * Drag; ← / → one step (Shift ×3); Home = narrowest, End = widest; double-click = the default width.
 * Range: 260 px (or the default, when that is narrower) to 60 % of the host. The width is saved per viewer
 * after every action; a browser with no storage just does not remember it.
 *
 * The parent owns the width and must be `position: relative`, with the pane starting at its left edge:
 *   const [w, setW] = useState(() => readSavedPaneWidth(KEY, 300));
 *   <div style={{ position: 'relative' }}>
 *     <div id="list" style={{ width: w }} />
 *     <PaneResizeHandle width={w} defaultWidth={300} onChange={setW} storageKey={KEY} label="Resize sensor list" controls="list" />
 *   </div>
 */
export const PANE_MIN_PX = 260;
export const PANE_MAX_RATIO = 0.6;
export const PANE_STEP_PX = 20;

/** The saved width, or `fallback` when there is none (or no readable storage). */
export function readSavedPaneWidth(storageKey: string, fallback: number): number {
    try {
        const raw = localStorage.getItem(storageKey);
        const saved = raw === null ? NaN : Number(raw);
        return Number.isFinite(saved) && saved > 0 ? saved : fallback;
    } catch {
        return fallback;
    }
}

function saveWidth(storageKey: string, width: number) {
    try {
        localStorage.setItem(storageKey, String(width));
    } catch {
        // Private window or blocked storage: the width just is not remembered.
    }
}

export interface PaneResizeHandleProps {
    /** The pane's current width in px. */
    width: number;
    /** The starting width; a double-click goes back to it. */
    defaultWidth: number;
    onChange: (width: number) => void;
    /** Where this viewer's width is saved (`localStorage`). */
    storageKey: string;
    /** What it resizes, for screen readers ("Resize sensor list"). */
    label: string;
    /** The id of the pane (`aria-controls`). */
    controls: string;
    testid?: string;
    className?: string;
}

export function PaneResizeHandle({ width, defaultWidth, onChange, storageKey, label, controls, testid, className = '' }: PaneResizeHandleProps) {
    const ref = useRef<HTMLDivElement>(null);
    const [host, setHost] = useState(0);
    const drag = useRef<{ grab: number; last: number } | null>(null);
    const [dragging, setDragging] = useState(false);

    useLayoutEffect(() => {
        const el = ref.current?.parentElement;
        if (!el) return;
        const read = () => setHost(el.getBoundingClientRect().width);
        read();
        if (typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(read);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const min = Math.min(PANE_MIN_PX, defaultWidth);
    const max = Math.max(min, Math.round((host || window.innerWidth) * PANE_MAX_RATIO));
    const clamp = (w: number) => Math.round(Math.max(min, Math.min(max, w)));
    const now = clamp(width);

    // The window got narrower (or a saved width no longer fits): the pane follows. The saved width stays, and the
    // pane grows back toward the width it was pulled in from as the window widens, until the user picks a new one.
    const pulledFrom = useRef<number | null>(null);
    useEffect(() => {
        if (host <= 0) return;
        if (width !== now) {
            if (width > now) pulledFrom.current ??= width;
            onChange(now);
            return;
        }
        const from = pulledFrom.current;
        if (from === null) return;
        const back = Math.min(from, max);
        if (back !== now) onChange(back);
        if (from <= max) pulledFrom.current = null;
    }, [host, width, now, max, onChange]);

    const commit = (w: number) => {
        pulledFrom.current = null;
        const v = clamp(w);
        onChange(v);
        saveWidth(storageKey, v);
    };
    const fromPointer = (clientX: number) => {
        const left = ref.current?.parentElement?.getBoundingClientRect().left ?? 0;
        return clientX - left - (drag.current?.grab ?? 0);
    };
    const endDrag = () => {
        if (!drag.current) return;
        const { last } = drag.current;
        drag.current = null;
        setDragging(false);
        commit(last);
    };

    return (
        <div
            ref={ref}
            className={`pane-resize${dragging ? ' is-drag' : ''}${className ? ` ${className}` : ''}`}
            style={{ left: now }}
            role="separator"
            aria-orientation="vertical"
            aria-label={label}
            aria-controls={controls}
            aria-valuemin={min}
            aria-valuemax={max}
            aria-valuenow={now}
            tabIndex={0}
            title="Drag to resize · ← → to step · double-click to reset"
            data-testid={testid}
            onPointerDown={e => {
                if (e.button !== 0) return;
                e.currentTarget.setPointerCapture?.(e.pointerId);
                const left = e.currentTarget.parentElement?.getBoundingClientRect().left ?? 0;
                pulledFrom.current = null;
                // Where the handle was grabbed, so a click without a move does not shift the pane.
                drag.current = { grab: e.clientX - left - now, last: now };
                setDragging(true);
            }}
            onPointerMove={e => {
                if (!drag.current) return;
                const v = clamp(fromPointer(e.clientX));
                drag.current.last = v;
                onChange(v);
            }}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={() => commit(defaultWidth)}
            onKeyDown={e => {
                const step = e.shiftKey ? PANE_STEP_PX * 3 : PANE_STEP_PX;
                let w: number | null = null;
                if (e.key === 'ArrowLeft') w = now - step;
                else if (e.key === 'ArrowRight') w = now + step;
                else if (e.key === 'Home') w = min;
                else if (e.key === 'End') w = max;
                if (w === null) return;
                e.preventDefault();
                commit(w);
            }}
        />
    );
}
