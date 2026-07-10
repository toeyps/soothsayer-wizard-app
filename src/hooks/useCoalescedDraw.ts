import { useCallback, useRef } from 'react';

/**
 * Serialize regl-scatterplot `.draw()` calls.
 *
 * The library ignores a `draw()` issued while the previous one is still in
 * flight and warns: "Ignoring draw call as the previous draw call has not yet
 * finished." That is not just console noise — the ignored call's data/colors
 * are silently dropped, so a cell can keep rendering stale state. This
 * happens in normal operation: PairPlotCell's data effect and clusters effect
 * both draw in the same commit on mount, and any rapid data/cluster update
 * can land while a draw is pending.
 *
 * `requestDraw(sc, args)` draws immediately when idle; while busy it parks
 * `args` as the ONE pending draw (newer requests overwrite older ones — only
 * the latest state matters) and flushes it when the in-flight draw settles.
 *
 * `resetDraw()` must be called when the instance is destroyed: a draw
 * interrupted by `destroy()` may never settle, which would otherwise leave
 * the queue stuck busy forever.
 */
export function useCoalescedDraw(): {
    requestDraw: (sc: any, args: any) => void;
    resetDraw: () => void;
} {
    const busyRef = useRef(false);
    const pendingRef = useRef<{ sc: any; args: any } | null>(null);

    const requestDraw = useCallback(function request(sc: any, args: any) {
        if (busyRef.current) {
            pendingRef.current = { sc, args };
            return;
        }
        busyRef.current = true;
        Promise.resolve()
            .then(() => sc.draw(args))
            // A rejected draw (e.g. instance torn down mid-flight) must not
            // wedge the queue; real render failures surface via the
            // webglcontextlost overlay, not here.
            .catch(() => { /* swallowed on purpose */ })
            .then(() => {
                busyRef.current = false;
                const next = pendingRef.current;
                pendingRef.current = null;
                if (next) request(next.sc, next.args);
            });
    }, []);

    const resetDraw = useCallback(() => {
        busyRef.current = false;
        pendingRef.current = null;
    }, []);

    return { requestDraw, resetDraw };
}
