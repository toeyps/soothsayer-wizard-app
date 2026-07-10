import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock the Tauri invoke bridge (same pattern as useScatterSample.test).
const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (...args: unknown[]) => mockInvoke(...args),
}));

import { useChartData } from '../hooks/useChartData';
import type { ChartDataQuery } from '../hooks/useChartData';
import { useTablePage } from '../hooks/useTablePage';
import type { TablePageQuery } from '../hooks/useTablePage';

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

const pageResult = {
    headers: ['A', 'B'],
    rows: [{ timestamp: '2020-01-01T00:00:00', values: [1, 10] }],
    total_rows: 2_000_000,
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

describe('useTablePage', () => {
    const tableQuery: TablePageQuery = {
        filter: baseQuery.filter,
        sampling: 'raw',
        operation: null,
        page: 0,
        pageSize: 50,
    };

    it('invokes get_table_page with snake_case page_size', async () => {
        mockInvoke.mockResolvedValue(pageResult);
        const { result } = renderHook(() => useTablePage(tableQuery));
        await act(async () => { await vi.runAllTimersAsync(); });

        expect(mockInvoke).toHaveBeenCalledWith('get_table_page', {
            filter: tableQuery.filter,
            sampling: 'raw',
            operation: null,
            page: 0,
            page_size: 50,
        });
        expect(result.current.page?.rows).toHaveLength(1);
        expect(result.current.page?.total_rows).toBe(2_000_000);
    });

    it('refetches when the page index changes and keeps the previous rows while loading', async () => {
        mockInvoke.mockResolvedValue(pageResult);
        const { result, rerender } = renderHook(
            ({ q }) => useTablePage(q),
            { initialProps: { q: tableQuery } },
        );
        await act(async () => { await vi.runAllTimersAsync(); });
        expect(result.current.page).not.toBeNull();

        // Page flip: old rows stay visible (no flicker) while loading.
        mockInvoke.mockReturnValue(new Promise(() => { /* never resolves */ }));
        rerender({ q: { ...tableQuery, page: 3 } });
        await act(async () => { await vi.advanceTimersByTimeAsync(500); });

        expect(mockInvoke).toHaveBeenLastCalledWith('get_table_page', expect.objectContaining({
            page: 3,
        }));
        expect(result.current.loading).toBe(true);
        expect(result.current.page?.rows).toHaveLength(1);
    });

    it('does not fetch when the query is null', async () => {
        renderHook(() => useTablePage(null));
        await act(async () => { await vi.runAllTimersAsync(); });
        expect(mockInvoke).not.toHaveBeenCalled();
    });
});
