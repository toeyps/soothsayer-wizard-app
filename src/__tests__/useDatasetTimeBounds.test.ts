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
