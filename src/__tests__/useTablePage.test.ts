import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (...args: unknown[]) => mockInvoke(...args),
}));

import { useTablePage } from '../hooks/useTablePage';
import type { TablePageQuery } from '../hooks/useTablePage';

const query: TablePageQuery = {
    filter: { sensors: ['A', 'B'], timestamp_start: null, timestamp_end: null, value_filters: [] } as any,
    sampling: 'raw' as any,
    operation: null,
    page: 0,
    pageSize: 50,
};

const pageResult = { rows: [{ timestamp: '2026-01-01', values: [1, 2] }], total_rows: 1 };

beforeEach(() => {
    mockInvoke.mockReset();
    vi.useFakeTimers();
});
afterEach(() => {
    vi.useRealTimers();
});

describe('useTablePage', () => {
    it('returns null/idle state and does not fetch when query is null', async () => {
        const { result } = renderHook(() => useTablePage(null));
        await act(async () => { await vi.runAllTimersAsync(); });
        expect(mockInvoke).not.toHaveBeenCalled();
        expect(result.current).toEqual({ page: null, loading: false, error: null });
    });

    it('does not fetch when the filter has no sensors', async () => {
        renderHook(() => useTablePage({ ...query, filter: { ...query.filter, sensors: [] } }));
        await act(async () => { await vi.runAllTimersAsync(); });
        expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('debounces then invokes get_table_page with snake_case page_size', async () => {
        mockInvoke.mockResolvedValue(pageResult);
        const { result } = renderHook(() => useTablePage(query));
        await act(async () => { await vi.runAllTimersAsync(); });

        expect(mockInvoke).toHaveBeenCalledWith('get_table_page', {
            filter: query.filter,
            sampling: query.sampling,
            operation: query.operation,
            page: query.page,
            page_size: query.pageSize,
        });
        expect(result.current.page).toEqual(pageResult);
        expect(result.current.loading).toBe(false);
        expect(result.current.error).toBeNull();
    });

    it('surfaces an error when the backend rejects', async () => {
        mockInvoke.mockRejectedValue('table boom');
        const { result } = renderHook(() => useTablePage(query));
        await act(async () => { await vi.runAllTimersAsync(); });
        expect(result.current.error).toContain('table boom');
        expect(result.current.loading).toBe(false);
    });

    it('ignores a stale response when a newer query supersedes it before it resolves', async () => {
        let resolveFirst!: (v: unknown) => void;
        mockInvoke.mockImplementationOnce(() => new Promise((res) => { resolveFirst = res; }));

        const { result, rerender } = renderHook(
            ({ q }) => useTablePage(q),
            { initialProps: { q: query } },
        );
        await act(async () => { await vi.runAllTimersAsync(); }); // fires first debounce -> pending invoke

        const secondQuery = { ...query, page: 1 };
        mockInvoke.mockResolvedValueOnce({ ...pageResult, total_rows: 999 });
        rerender({ q: secondQuery });
        await act(async () => { await vi.runAllTimersAsync(); }); // fires second debounce -> resolves

        // Now resolve the stale first call — it must be ignored.
        await act(async () => {
            resolveFirst(pageResult);
            await Promise.resolve();
        });

        expect(result.current.page).toEqual({ ...pageResult, total_rows: 999 });
    });

    it('clears the pending debounce timer when query changes before it fires', async () => {
        mockInvoke.mockResolvedValue(pageResult);
        const { rerender } = renderHook(
            ({ q }) => useTablePage(q),
            { initialProps: { q: query } },
        );
        rerender({ q: { ...query, page: 1 } });
        await act(async () => { await vi.runAllTimersAsync(); });
        // Only the latest query's debounce should have actually fired.
        expect(mockInvoke).toHaveBeenCalledTimes(1);
    });
});
