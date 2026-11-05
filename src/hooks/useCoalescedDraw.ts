import { useCallback, useRef } from 'react';

/** Serializes regl-scatterplot `.draw()`: the library drops a draw issued while one is in flight. `requestDraw` draws when idle, else keeps the latest args as the one pending draw. Call `resetDraw()` on destroy. */
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
            // A rejected draw (instance torn down) must not wedge the queue; real failures show via the webglcontextlost overlay.
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
