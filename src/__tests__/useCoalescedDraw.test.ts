import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useCoalescedDraw } from '../hooks/useCoalescedDraw';

function deferred<T = void>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

describe('useCoalescedDraw', () => {
    it('draws immediately when idle', async () => {
        const { result } = renderHook(() => useCoalescedDraw());
        const draw = vi.fn().mockResolvedValue(undefined);
        const sc = { draw };
        result.current.requestDraw(sc, { data: 1 });
        await waitFor(() => expect(draw).toHaveBeenCalledWith({ data: 1 }));
    });

    it('queues a call issued while busy and drops intermediate calls, keeping only the latest', async () => {
        const { result } = renderHook(() => useCoalescedDraw());
        const d1 = deferred();
        const draw = vi.fn()
            .mockReturnValueOnce(d1.promise)   // first draw stays pending
            .mockResolvedValue(undefined);      // the flushed queued draw resolves immediately
        const sc = { draw };

        result.current.requestDraw(sc, { data: 1 });
        await waitFor(() => expect(draw).toHaveBeenCalledTimes(1));

        // Two more requests arrive while busy — only the last should survive.
        result.current.requestDraw(sc, { data: 2 });
        result.current.requestDraw(sc, { data: 3 });
        expect(draw).toHaveBeenCalledTimes(1); // still just the first, in-flight call

        d1.resolve();
        await waitFor(() => expect(draw).toHaveBeenCalledTimes(2));
        expect(draw).toHaveBeenLastCalledWith({ data: 3 });
    });

    it('does not wedge the queue when a draw call rejects', async () => {
        const { result } = renderHook(() => useCoalescedDraw());
        const draw = vi.fn()
            .mockRejectedValueOnce(new Error('gl context lost'))
            .mockResolvedValue(undefined);
        const sc = { draw };

        result.current.requestDraw(sc, { data: 1 });
        await waitFor(() => expect(draw).toHaveBeenCalledTimes(1));

        result.current.requestDraw(sc, { data: 2 });
        await waitFor(() => expect(draw).toHaveBeenCalledTimes(2));
        expect(draw).toHaveBeenLastCalledWith({ data: 2 });
    });

    it('resetDraw clears busy/pending state so a fresh requestDraw fires immediately', async () => {
        const { result } = renderHook(() => useCoalescedDraw());
        const stuck = deferred();
        const draw = vi.fn()
            .mockReturnValueOnce(stuck.promise) // never resolves — simulates a torn-down instance
            .mockResolvedValue(undefined);
        const sc = { draw };

        result.current.requestDraw(sc, { data: 1 });
        await waitFor(() => expect(draw).toHaveBeenCalledTimes(1));

        result.current.requestDraw(sc, { data: 2 }); // parks as pending, first never settles
        result.current.resetDraw();

        result.current.requestDraw(sc, { data: 3 });
        await waitFor(() => expect(draw).toHaveBeenCalledTimes(2));
        expect(draw).toHaveBeenLastCalledWith({ data: 3 });
    });
});
