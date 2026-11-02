import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';

export interface WindowedLinesOptions<T> {
    listRef: RefObject<HTMLElement | null>;
    /** Every line of the list, rendered or not. */
    lines: readonly T[];
    keyOf: (line: T) => string;
    /** A line's height until it has been rendered. Keep it stable: a new function rebuilds the offsets. */
    estimate: (line: T) => number;
    /** False: a plain list. Nothing is measured and the whole range is "in view". */
    windowed: boolean;
    /** Rendered above and below the view, in px. */
    overscanPx: number;
    /** The view's height until the list has one. */
    fallbackHeightPx: number;
    /** While this stays the same object, the first line in view keeps its place on screen when a line above it
     *  changes height. A new one starts over (a new search). */
    anchorList: unknown;
}

export interface WindowedLines {
    view: { top: number; height: number };
    /** Goes up each time a measured height changes. */
    measureTick: number;
    /** `offsets[i]` is the top of line `i`; `offsets[lines.length]` is the height of the whole list. */
    offsets: number[];
    windowStart: number;
    windowEnd: number;
    /** The first line reaching past `px`. */
    lineAt: (px: number) => number;
    /** The list's `onScroll`. */
    readView: () => void;
    /** The `ref` of a rendered line. */
    lineRef: (key: string) => (el: HTMLElement | null) => void;
}

/**
 * Long lists (DESIGN_SYSTEM §4 rule 6): only the lines in view are rendered, absolutely placed. Heights are estimated
 * until a line has been rendered, then measured, and re-measured when a line changes height with no commit at all
 * (the web font arriving, a width change). Dragging the scrollbar lands among lines not measured yet, so wheeling up
 * from there measures lines above the view: the anchor keeps what the user is looking at from jumping.
 */
export function useWindowedLines<T>({
    listRef, lines, keyOf, estimate, windowed, overscanPx, fallbackHeightPx, anchorList,
}: WindowedLinesOptions<T>): WindowedLines {
    const [view, setView] = useState({ top: 0, height: fallbackHeightPx });
    const heights = useRef(new Map<string, number>());
    const [measureTick, setMeasureTick] = useState(0);

    const offsets = useMemo(() => {
        const off = new Array<number>(lines.length + 1);
        off[0] = 0;
        for (let i = 0; i < lines.length; i++) off[i + 1] = off[i] + (heights.current.get(keyOf(lines[i])) ?? estimate(lines[i]));
        return off;
    }, [lines, keyOf, estimate, measureTick]);

    const lineAt = (px: number): number => {
        let a = 0;
        let b = lines.length;
        while (a < b) {
            const m = (a + b) >> 1;
            if (offsets[m + 1] <= px) a = m + 1; else b = m;
        }
        return a;
    };

    let windowStart = 0;
    let windowEnd = lines.length;
    if (windowed) {
        windowStart = lineAt(view.top - overscanPx);
        windowEnd = windowStart;
        while (windowEnd < lines.length && offsets[windowEnd] < view.top + view.height + overscanPx) windowEnd++;
    }

    const readView = useCallback(() => {
        const el = listRef.current;
        if (!el) return;
        const next = { top: el.scrollTop, height: el.clientHeight || fallbackHeightPx };
        setView(v => (Math.abs(v.top - next.top) < 6 && v.height === next.height ? v : next));
    }, [listRef, fallbackHeightPx]);
    // A list that starts hidden has no height yet, and growing it fires no scroll event.
    useEffect(() => {
        readView();
        const el = listRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(readView);
        ro.observe(el);
        return () => ro.disconnect();
    }, [listRef, readView]);

    const lineEls = useRef(new Map<string, HTMLElement>());
    const lineRef = useCallback((key: string) => (el: HTMLElement | null) => {
        if (el) lineEls.current.set(key, el); else lineEls.current.delete(key);
    }, []);
    const measureLines = useCallback(() => {
        let changed = false;
        for (const [key, el] of lineEls.current) {
            // The used height in CSS px: a rect is scaled by the page's zoom, offsetHeight is rounded.
            const h = parseFloat(getComputedStyle(el).height);
            if (h > 0 && Math.abs((heights.current.get(key) ?? -1) - h) > 0.1) {
                heights.current.set(key, h);
                changed = true;
            }
        }
        if (changed) setMeasureTick(t => t + 1);
    }, []);
    // After every commit, and when a line changes height with no commit at all.
    const lineObserver = useRef<{ ro: ResizeObserver; watched: Set<HTMLElement> } | null>(null);
    useLayoutEffect(() => {
        if (!windowed) return;
        measureLines();
        if (typeof ResizeObserver === 'undefined') return;
        if (!lineObserver.current) lineObserver.current = { ro: new ResizeObserver(measureLines), watched: new Set() };
        const { ro, watched } = lineObserver.current;
        const now = new Set(lineEls.current.values());
        for (const el of watched) if (!now.has(el)) { ro.unobserve(el); watched.delete(el); }
        for (const el of now) if (!watched.has(el)) { ro.observe(el); watched.add(el); }
    });
    useEffect(() => () => {
        lineObserver.current?.ro.disconnect();
        lineObserver.current = null;
    }, []);

    const anchor = useRef<{ list: unknown; key: string; offset: number } | null>(null);
    useLayoutEffect(() => {
        const el = listRef.current;
        if (!el || !windowed) { anchor.current = null; return; }
        const a = anchor.current;
        if (a && a.list === anchorList && el.scrollTop > 0) {
            const i = lines.findIndex(l => keyOf(l) === a.key);
            if (i >= 0 && Math.abs(offsets[i] - a.offset) >= 1) el.scrollTop += offsets[i] - a.offset;
        }
        const top = lineAt(el.scrollTop);
        anchor.current = lines[top] ? { list: anchorList, key: keyOf(lines[top]), offset: offsets[top] } : null;
    });

    return { view, measureTick, offsets, windowStart, windowEnd, lineAt, readView, lineRef };
}
