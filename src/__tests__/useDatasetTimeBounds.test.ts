import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// Mock the Tauri invoke bridge (same pattern as useChartData.test).
const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (...args: unknown[]) => mockInvoke(...args),
}));

import { useDatasetTimeBounds } from '../hooks/useDatasetTimeBounds';

beforeEach(() => {
    mockInvoke.mockReset();
});

describe('useDatasetTimeBounds', () => {
    it('starts in a loading state with no bounds', () => {
        mockInvoke.mockReturnValue(new Promise(() => {})); // never resolves
        const { result } = renderHook(() => useDatasetTimeBounds());
        expect(result.current).toEqual({ bounds: null, loading: true, error: null });
    });

    it('fetches get_dataset_time_bounds with no args and stores the result', async () => {
        mockInvoke.mockResolvedValue({ min: '2023-05-13T01:00:00', max: '2026-07-31T00:00:00' });
        const { result } = renderHook(() => useDatasetTimeBounds());

        await waitFor(() => expect(result.current.loading).toBe(false));

        expect(mockInvoke).toHaveBeenCalledWith('get_dataset_time_bounds');
        expect(result.current).toEqual({
            bounds: { min: '2023-05-13T01:00:00', max: '2026-07-31T00:00:00' },
            loading: false,
            error: null,
        });
    });

    it('surfaces a null-bounds result (every row unparseable) without treating it as an error', async () => {
        mockInvoke.mockResolvedValue({ min: null, max: null });
        const { result } = renderHook(() => useDatasetTimeBounds());

        await waitFor(() => expect(result.current.loading).toBe(false));

        expect(result.current).toEqual({
            bounds: { min: null, max: null },
            loading: false,
            error: null,
        });
    });

    it('stores the error and clears bounds on invoke failure', async () => {
        mockInvoke.mockRejectedValue(new Error('No data loaded'));
        const { result } = renderHook(() => useDatasetTimeBounds());

        await waitFor(() => expect(result.current.loading).toBe(false));

        expect(result.current.bounds).toBeNull();
        expect(result.current.error).toContain('No data loaded');
    });

    it('ignores a late resolve after unmount', async () => {
        let resolve!: (v: { min: string | null; max: string | null }) => void;
        mockInvoke.mockReturnValue(new Promise(r => { resolve = r; }));
        const { result, unmount } = renderHook(() => useDatasetTimeBounds());
        unmount();
        resolve({ min: '2020-01-01T00:00:00', max: '2020-06-01T00:00:00' });
        await Promise.resolve();
        // Nothing to assert on `result` post-unmount beyond "no throw" — the
        // live-flag guard is what prevents a set-state-after-unmount warning.
        expect(result.current).toBeDefined();
    });
});

// The Build Model window outlives its dataset (it is re-pointed at another workspace while it stays
// open), so it passes a key — workspace + Rust dataset generation. The bounds it holds are a hard
// input of the "no data to train on" guards: the OLD dataset's range must never be read as the new one's.
describe('useDatasetTimeBounds(datasetKey) — bounds belong to ONE dataset', () => {
    const A = { min: '2025-01-01T00:00:00', max: '2025-12-31T23:59:00' };
    const B = { min: '2027-01-01T00:00:00', max: '2027-12-31T23:59:00' };

    it('`null` = the dataset is not known yet: nothing is fetched, the bounds are unknown', async () => {
        const { result } = renderHook(() => useDatasetTimeBounds(null));
        await Promise.resolve();
        expect(mockInvoke).not.toHaveBeenCalled();
        expect(result.current).toEqual({ bounds: null, loading: true, error: null });
    });

    it('fetches once per key: a re-render with the same key asks nothing again', async () => {
        mockInvoke.mockResolvedValue(A);
        const { result, rerender } = renderHook(({ k }: { k: string | null }) => useDatasetTimeBounds(k), { initialProps: { k: 'ws1|1' as string | null } });
        await waitFor(() => expect(result.current.bounds).toEqual(A));
        rerender({ k: 'ws1|1' });
        rerender({ k: 'ws1|1' });
        expect(mockInvoke).toHaveBeenCalledTimes(1);
    });

    it('a new key: the bounds are UNKNOWN in the very render the key changes (never the old dataset\'s), asked again, then the new answer', async () => {
        let resolveB!: (v: unknown) => void;
        mockInvoke.mockResolvedValueOnce(A).mockReturnValueOnce(new Promise(r => { resolveB = r; }));
        const seen: (typeof A | null)[] = [];
        const { result, rerender } = renderHook(({ k }: { k: string }) => {
            const r = useDatasetTimeBounds(k);
            seen.push(r.bounds as typeof A | null);
            return r;
        }, { initialProps: { k: 'ws1|1' } });
        await waitFor(() => expect(result.current.bounds).toEqual(A));
        seen.length = 0;
        rerender({ k: 'ws2|2' });
        // every render since the key changed — the first one included — saw "unknown"
        expect(seen.length).toBeGreaterThan(0);
        expect(seen.every(b => b === null)).toBe(true);
        expect(result.current).toEqual({ bounds: null, loading: true, error: null });
        expect(mockInvoke).toHaveBeenCalledTimes(2);
        resolveB(B);
        await waitFor(() => expect(result.current.bounds).toEqual(B));
        expect(result.current.loading).toBe(false);
    });

    it('a LATE answer of an older key never lands as the new dataset\'s range (sequence guard)', async () => {
        let resolveA!: (v: unknown) => void;
        let resolveB!: (v: unknown) => void;
        mockInvoke.mockReturnValueOnce(new Promise(r => { resolveA = r; })).mockReturnValueOnce(new Promise(r => { resolveB = r; }));
        const { result, rerender } = renderHook(({ k }: { k: string }) => useDatasetTimeBounds(k), { initialProps: { k: 'ws1|1' } });
        rerender({ k: 'ws2|2' });
        resolveA(A); // the old dataset answers late
        await Promise.resolve();
        await Promise.resolve();
        expect(result.current.bounds).toBeNull();
        resolveB(B);
        await waitFor(() => expect(result.current.bounds).toEqual(B));
    });

    it('a failure for the current key: unknown bounds + the error — and the next key asks again', async () => {
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        mockInvoke.mockRejectedValueOnce(new Error('No data loaded')).mockResolvedValueOnce(B);
        const { result, rerender } = renderHook(({ k }: { k: string }) => useDatasetTimeBounds(k), { initialProps: { k: 'ws1|1' } });
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.bounds).toBeNull();
        expect(result.current.error).toContain('No data loaded');
        rerender({ k: 'ws2|2' });
        expect(result.current).toEqual({ bounds: null, loading: true, error: null });
        await waitFor(() => expect(result.current.bounds).toEqual(B));
        err.mockRestore();
    });
});
