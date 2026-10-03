import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (cmd: string, args?: unknown) => mockInvoke(cmd, args),
}));

import { useRowCountPreview, formatPercent, type RowCountOptions } from '../components/windows/useRowCountPreview';

const stats = (count: number) => ({ mean: 0, sd: 0, min: 0, max: 0, count, lower1: 0, upper1: 0, lower3: 0, upper3: 0 });
const F1 = { timestamp_ranges: [{ start: '2026-01-01T00:00', end: null }], value_filters: [], combine: 'and' };
const F2 = { timestamp_ranges: [], value_filters: [{ sensor: 'A', operation: 'greater_than', value1: 5, value2: null }], combine: 'and' };

function setup(over: Partial<RowCountOptions> = {}) {
    const cache = { current: new Map<string, number>() };
    const initial: RowCountOptions = { enabled: true, workspaceId: 'ws1', sensor: 'TAG1', filter: F1, cache, ...over };
    const hook = renderHook((props: RowCountOptions) => useRowCountPreview(props), { initialProps: initial });
    return { ...hook, cache, initial };
}

/** Resolves `compute_sensor_stats` from a map keyed by JSON(filter) (null -> total). */
function answer(map: Record<string, number>) {
    mockInvoke.mockImplementation(async (_cmd: string, args: any) => stats(map[JSON.stringify(args.filter ?? null)] ?? 0));
}

beforeEach(() => { mockInvoke.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe('useRowCountPreview', () => {
    it('queries compute_sensor_stats (snake_case args) twice for a real filter: the filter itself and the unfiltered total', async () => {
        answer({ [JSON.stringify(F1)]: 25, null: 100 });
        const { result } = setup();
        await waitFor(() => expect(result.current.status).toBe('ok'));
        expect(result.current).toEqual({ status: 'ok', used: 25, total: 100 });
        expect(mockInvoke).toHaveBeenCalledTimes(2);
        expect(mockInvoke).toHaveBeenCalledWith('compute_sensor_stats', { sensor: 'TAG1', filter: F1 });
        expect(mockInvoke).toHaveBeenCalledWith('compute_sensor_stats', { sensor: 'TAG1', filter: null });
    });

    it('no filter at all: ONE query, used === total', async () => {
        answer({ null: 80 });
        const { result } = setup({ filter: null });
        await waitFor(() => expect(result.current.status).toBe('ok'));
        expect(result.current).toEqual({ status: 'ok', used: 80, total: 80 });
        expect(mockInvoke).toHaveBeenCalledTimes(1);
    });

    it('disabled / no workspace / no sensor: idle and nothing is queried', async () => {
        for (const over of [{ enabled: false }, { workspaceId: null }, { sensor: null }] as Partial<RowCountOptions>[]) {
            const { result, unmount } = setup(over);
            await act(async () => { await Promise.resolve(); });
            expect(result.current).toEqual({ status: 'idle', used: null, total: null });
            unmount();
        }
        expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('a filter that keeps NO rows (Rust returns an error, not count 0) is shown as 0 used, not as a failure', async () => {
        mockInvoke.mockImplementation(async (_c: string, args: any) => {
            if (args.filter) throw new Error("No valid numeric values for sensor 'TAG1'");
            return stats(100);
        });
        const { result } = setup();
        await waitFor(() => expect(result.current.status).toBe('ok'));
        expect(result.current).toEqual({ status: 'ok', used: 0, total: 100 });
    });

    it('any other failure -> status "error" with no numbers (and the UI keeps working)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        mockInvoke.mockRejectedValue(new Error('No data loaded'));
        const { result } = setup();
        await waitFor(() => expect(result.current.status).toBe('error'));
        expect(result.current).toEqual({ status: 'error', used: null, total: null });
        warn.mockRestore();
    });

    it('a result without a numeric count (unexpected shape) counts as an error rather than showing NaN', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        mockInvoke.mockResolvedValue({});
        const { result } = setup();
        await waitFor(() => expect(result.current.status).toBe('error'));
        warn.mockRestore();
    });

    it('a slow, superseded query never overwrites a newer one (stale response ignored)', async () => {
        const resolvers: Record<string, (v: unknown) => void> = {};
        mockInvoke.mockImplementation((_c: string, args: any) => new Promise(res => {
            // the filter-specific query is held; the unfiltered total answers at once
            if (args.filter) resolvers[JSON.stringify(args.filter)] = res; else res(stats(1000));
        }));
        const { result, rerender, initial } = setup({ filter: F1 });
        await waitFor(() => expect(Object.keys(resolvers)).toHaveLength(1));
        rerender({ ...initial, filter: F2 });
        await waitFor(() => expect(Object.keys(resolvers)).toHaveLength(2));

        // the NEWER (F2) answers first, then the OLD (F1) one finally lands
        await act(async () => { resolvers[JSON.stringify(F2)](stats(7)); });
        await waitFor(() => expect(result.current).toEqual({ status: 'ok', used: 7, total: 1000 }));
        await act(async () => { resolvers[JSON.stringify(F1)](stats(999)); });
        expect(result.current).toEqual({ status: 'ok', used: 7, total: 1000 }); // F1's late 999 is dropped
    });

    it('while a new query is in flight it reports "loading" and keeps the previous numbers', async () => {
        answer({ [JSON.stringify(F1)]: 25, null: 100 });
        const { result, rerender, initial } = setup();
        await waitFor(() => expect(result.current.status).toBe('ok'));
        mockInvoke.mockImplementation(() => new Promise(() => {})); // never answers
        rerender({ ...initial, filter: F2 });
        await waitFor(() => expect(result.current.status).toBe('loading'));
        expect(result.current.used).toBe(25);
        expect(result.current.total).toBe(100);
    });

    it('cache: an unchanged filter (even as a new object) costs no new query, and the unfiltered total is shared across filters', async () => {
        answer({ [JSON.stringify(F1)]: 25, [JSON.stringify(F2)]: 40, null: 100 });
        const { result, rerender, initial } = setup();
        await waitFor(() => expect(result.current.status).toBe('ok'));
        expect(mockInvoke).toHaveBeenCalledTimes(2);

        rerender({ ...initial, filter: JSON.parse(JSON.stringify(F1)) }); // same content, new object
        await act(async () => { await Promise.resolve(); });
        expect(mockInvoke).toHaveBeenCalledTimes(2);
        expect(result.current).toEqual({ status: 'ok', used: 25, total: 100 });

        rerender({ ...initial, filter: F2 }); // only the filtered count is new; the total is already cached
        await waitFor(() => expect(result.current).toEqual({ status: 'ok', used: 40, total: 100 }));
        expect(mockInvoke).toHaveBeenCalledTimes(3);

        rerender({ ...initial, filter: F1 }); // back to a known one: instant
        await act(async () => { await Promise.resolve(); });
        expect(mockInvoke).toHaveBeenCalledTimes(3);
        expect(result.current).toEqual({ status: 'ok', used: 25, total: 100 });
    });

    it('two hook instances sharing one cache reuse each other\'s results (opening an unedited modal costs no query)', async () => {
        answer({ [JSON.stringify(F1)]: 25, null: 100 });
        const cache = { current: new Map<string, number>() };
        const a = setup({ cache });
        await waitFor(() => expect(a.result.current.status).toBe('ok'));
        const calls = mockInvoke.mock.calls.length;
        const b = setup({ cache, debounceMs: 300 });
        await act(async () => { await Promise.resolve(); });
        expect(b.result.current).toEqual({ status: 'ok', used: 25, total: 100 });
        expect(mockInvoke).toHaveBeenCalledTimes(calls);
    });

    it('a different workspace or reference sensor is a different cache entry', async () => {
        answer({ null: 50 });
        const { rerender, initial, result } = setup({ filter: null });
        await waitFor(() => expect(result.current.status).toBe('ok'));
        rerender({ ...initial, filter: null, workspaceId: 'ws2' });
        await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(2));
        rerender({ ...initial, filter: null, workspaceId: 'ws2', sensor: 'TAG2' });
        await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(3));
    });

    it('debounce: nothing is queried until the filter has been stable for debounceMs; a newer change restarts the wait', async () => {
        vi.useFakeTimers();
        answer({ [JSON.stringify(F1)]: 25, [JSON.stringify(F2)]: 40, null: 100 });
        const { result, rerender, initial } = setup({ debounceMs: 300 });
        await act(async () => { await vi.advanceTimersByTimeAsync(299); });
        expect(mockInvoke).not.toHaveBeenCalled();
        expect(result.current.status).toBe('loading');

        rerender({ ...initial, debounceMs: 300, filter: F2 }); // a keystroke later: the wait restarts
        await act(async () => { await vi.advanceTimersByTimeAsync(299); });
        expect(mockInvoke).not.toHaveBeenCalled();

        await act(async () => { await vi.advanceTimersByTimeAsync(2); });
        expect(mockInvoke).toHaveBeenCalledTimes(2); // ONE query round (F2 + total), never F1's
        expect(mockInvoke.mock.calls.map(c => (c[1] as any).filter)).toEqual([F2, null]);
        expect(result.current).toEqual({ status: 'ok', used: 40, total: 100 });
    });

    it('unmounting mid-query is safe (no state update after unmount)', async () => {
        let release!: (v: unknown) => void;
        mockInvoke.mockImplementation(() => new Promise(res => { release = res; }));
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { unmount } = setup({ filter: null });
        await waitFor(() => expect(mockInvoke).toHaveBeenCalled());
        unmount();
        await act(async () => { release(stats(5)); });
        expect(err).not.toHaveBeenCalled();
        err.mockRestore();
    });
});

describe('formatPercent', () => {
    it('rounds to a whole percent, "<1%" for a tiny share, "0%" for none, em dash when unknown', () => {
        expect(formatPercent(25, 100)).toBe('25%');
        expect(formatPercent(1, 3)).toBe('33%');
        expect(formatPercent(3, 10_000)).toBe('<1%');
        expect(formatPercent(0, 100)).toBe('0%');
        expect(formatPercent(null, 100)).toBe('—');
        expect(formatPercent(5, null)).toBe('—');
        expect(formatPercent(5, 0)).toBe('—');
    });
});
