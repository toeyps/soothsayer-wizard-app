import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock the Tauri invoke bridge (same pattern as useScatterSample.test).
const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (...args: unknown[]) => mockInvoke(...args),
}));

import { useChartData } from '../hooks/useChartData';
import type { ChartDataQuery } from '../hooks/useChartData';

const baseQuery: ChartDataQuery = {
    filter: {
        sensors: ['A', 'B'],
        timestamp_start: null,
        timestamp_end: null,
        value_filters: [],
    },
    sampling: 'raw',
    operation: null,
    maxPoints: 4000,
};

const viewResult = {
    headers: ['A', 'B'],
    timestamps: ['2020-01-01T00:00:00', '2020-01-01T00:01:00'],
    series: [[1, 2], [10, 20]],
    total_rows: 2_000_000,
    ts_min: '2020-01-01T00:00:00',
    ts_max: '2020-06-01T00:00:00',
};

beforeEach(() => {
    mockInvoke.mockReset();
    vi.useFakeTimers();
});
afterEach(() => {
    vi.useRealTimers();
});

describe('useChartData', () => {
    it('does not fetch when the query is null', async () => {
        renderHook(() => useChartData(null));
        await act(async () => { await vi.runAllTimersAsync(); });
        expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('does not fetch when no sensors are selected', async () => {
        renderHook(() => useChartData({
            ...baseQuery,
            filter: { ...baseQuery.filter, sensors: [] },
        }));
        await act(async () => { await vi.runAllTimersAsync(); });
        expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('invokes get_chart_data with snake_case max_points and stores the view', async () => {
        mockInvoke.mockResolvedValue(viewResult);
        const { result } = renderHook(() => useChartData(baseQuery));
        await act(async () => { await vi.runAllTimersAsync(); });

        // Locks the IPC key casing — Tauri matches the Rust param
        // `max_points` verbatim, so a camelCase key would break at runtime.
        expect(mockInvoke).toHaveBeenCalledWith('get_chart_data', {
            filter: baseQuery.filter,
            sampling: 'raw',
            operation: null,
            max_points: 4000,
        });
        expect(result.current.view?.timestamps).toHaveLength(2);
        expect(result.current.view?.total_rows).toBe(2_000_000);
        expect(result.current.loading).toBe(false);
        expect(result.current.error).toBeNull();
    });

    it('refetches when only `revision` changes, and never sends it to the backend', async () => {
        // The data behind an unchanged query can change underneath it: editing
        // a special sensor's recipe recomputes its column in the Rust session
        // under the same name. Nothing in the query moves, so this is the only
        // thing that tells the chart to go and look again.
        mockInvoke.mockResolvedValue(viewResult);
        const { rerender } = renderHook(
            ({ q }: { q: ChartDataQuery }) => useChartData(q),
            { initialProps: { q: { ...baseQuery, revision: 0 } } },
        );
        await act(async () => { await vi.runAllTimersAsync(); });
        expect(mockInvoke).toHaveBeenCalledTimes(1);
        expect(Object.keys(mockInvoke.mock.calls[0][1])).not.toContain('revision');

        rerender({ q: { ...baseQuery, revision: 1 } });
        await act(async () => { await vi.runAllTimersAsync(); });
        expect(mockInvoke).toHaveBeenCalledTimes(2);

        // ...and an unchanged revision still does not refetch.
        rerender({ q: { ...baseQuery, revision: 1 } });
        await act(async () => { await vi.runAllTimersAsync(); });
        expect(mockInvoke).toHaveBeenCalledTimes(2);
    });

    it('clears the view when the query becomes null (sensors deselected)', async () => {
        mockInvoke.mockResolvedValue(viewResult);
        const { result, rerender } = renderHook(
            ({ q }: { q: ChartDataQuery | null }) => useChartData(q),
            { initialProps: { q: baseQuery as ChartDataQuery | null } },
        );
        await act(async () => { await vi.runAllTimersAsync(); });
        expect(result.current.view).not.toBeNull();

        rerender({ q: null });
        await act(async () => { await vi.runAllTimersAsync(); });
        expect(result.current.view).toBeNull();
        expect(mockInvoke).toHaveBeenCalledTimes(1);
    });

    it('debounces rapid query edits into a single backend call (the latest)', async () => {
        mockInvoke.mockResolvedValue(viewResult);
        const { rerender } = renderHook(
            ({ q }) => useChartData(q),
            { initialProps: { q: baseQuery } },
        );
        rerender({ q: { ...baseQuery, sampling: 'avg' as const } });
        rerender({ q: { ...baseQuery, sampling: 'max' as const } });
        await act(async () => { await vi.runAllTimersAsync(); });

        expect(mockInvoke).toHaveBeenCalledTimes(1);
        expect(mockInvoke).toHaveBeenLastCalledWith('get_chart_data', expect.objectContaining({
            sampling: 'max',
        }));
    });

    it('surfaces an error when the backend rejects', async () => {
        mockInvoke.mockRejectedValue('chart boom');
        const { result } = renderHook(() => useChartData(baseQuery));
        await act(async () => { await vi.runAllTimersAsync(); });
        expect(result.current.error).toContain('chart boom');
        expect(result.current.loading).toBe(false);
    });
});
