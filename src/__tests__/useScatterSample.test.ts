import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock the Tauri invoke bridge (same pattern as useDataUpload.test).
const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (...args: unknown[]) => mockInvoke(...args),
}));

import { useScatterSample } from '../hooks/useScatterSample';
import type { ScatterSampleFilter } from '../hooks/useScatterSample';

const filter: ScatterSampleFilter = {
    sensors: ['A', 'B'],
    timestamp_start: null,
    timestamp_end: null,
    value_filters: [],
};

const sampleResult = {
    headers: ['A', 'B'],
    rows: [{ timestamp: null, values: [1, 2] }],
    total: 1000,
    sampled: 1,
};

beforeEach(() => {
    mockInvoke.mockReset();
    vi.useFakeTimers();
});
afterEach(() => {
    vi.useRealTimers();
});

describe('useScatterSample', () => {
    it('does not fetch while disabled (no scatter/pair chart on screen)', async () => {
        renderHook(() => useScatterSample(filter, 200_000, false));
        await act(async () => { await vi.runAllTimersAsync(); });
        expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('does not fetch when the filter is null', async () => {
        renderHook(() => useScatterSample(null, 200_000, true));
        await act(async () => { await vi.runAllTimersAsync(); });
        expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('does not fetch when no sensors are selected', async () => {
        renderHook(() => useScatterSample({ ...filter, sensors: [] }, 200_000, true));
        await act(async () => { await vi.runAllTimersAsync(); });
        expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('invokes get_scatter_sample with snake_case max_points and stores the sample', async () => {
        mockInvoke.mockResolvedValue(sampleResult);
        const { result } = renderHook(() => useScatterSample(filter, 200_000, true));
        await act(async () => { await vi.runAllTimersAsync(); });

        // Locks the IPC key casing — Tauri matches the Rust param `max_points`
        // verbatim, so a camelCase key here would silently break at runtime.
        expect(mockInvoke).toHaveBeenCalledWith('get_scatter_sample', {
            filter,
            max_points: 200_000,
        });
        expect(result.current.rows).toHaveLength(1);
        expect(result.current.total).toBe(1000);
        expect(result.current.sampled).toBe(1);
        expect(result.current.loading).toBe(false);
        expect(result.current.error).toBeNull();
    });

    it('surfaces an error when the backend rejects', async () => {
        mockInvoke.mockRejectedValue('sampling boom');
        const { result } = renderHook(() => useScatterSample(filter, 200_000, true));
        await act(async () => { await vi.runAllTimersAsync(); });
        expect(result.current.error).toContain('sampling boom');
        expect(result.current.loading).toBe(false);
    });

    it('debounces rapid input into a single backend call (the latest config)', async () => {
        mockInvoke.mockResolvedValue(sampleResult);
        const { rerender } = renderHook(
            ({ mp }) => useScatterSample(filter, mp, true),
            { initialProps: { mp: 100 } },
        );
        // Change before the debounce window elapses — earlier timers are cleared.
        rerender({ mp: 200 });
        rerender({ mp: 300 });
        await act(async () => { await vi.runAllTimersAsync(); });

        expect(mockInvoke).toHaveBeenCalledTimes(1);
        expect(mockInvoke).toHaveBeenLastCalledWith('get_scatter_sample', {
            filter,
            max_points: 300,
        });
    });
});
