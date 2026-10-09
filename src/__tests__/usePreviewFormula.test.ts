import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (...args: unknown[]) => mockInvoke(...args),
}));

import {
    __resetPreviewFormulaModule, getKnownFormulaFunctions, previewInputKey, resolveFormulaVerdict, usePreviewFormula,
    PREVIEW_DEBOUNCE_MS, type UsePreviewFormulaOptions,
} from '../hooks/usePreviewFormula';
import type { FormulaPreviewResult } from '../types/formula';

const okReply = (over: Partial<FormulaPreviewResult> = {}): FormulaPreviewResult => ({
    ok: true, issues: [], stats: { min: 1, max: 3, mean: 2, rows: 3, missing: 0 },
    timestamps: ['t1', 't2'], values: [1, 3], period: ['t1', 't3'],
    functions: ['abs', 'sqrt'], limits: { max_len: 4096, max_depth: 64 }, converted_formula: null,
    ...over,
});
const refused = (code: string, range?: [number, number]): FormulaPreviewResult => okReply({
    ok: false, issues: [{ code, message: `bad: ${code}`, ...(range ? { range } : {}) }], stats: null, timestamps: [], values: [], period: null,
});

function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

const flush = async (ms = PREVIEW_DEBOUNCE_MS) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => {
    __resetPreviewFormulaModule();
    mockInvoke.mockReset();
    vi.useFakeTimers();
});
afterEach(() => {
    vi.useRealTimers();
});

describe('usePreviewFormula', () => {
    it('debounces ~220 ms, then calls preview_formula with camelCase keys, maxPoints 600, replace, a requestId and expectedGeneration', async () => {
        mockInvoke.mockResolvedValue(okReply());
        const { result } = renderHook(() => usePreviewFormula({ input: { formula: '$A + 1' }, generation: 7, replace: true }));
        expect(result.current.loading).toBe(true);
        await flush(PREVIEW_DEBOUNCE_MS - 1);
        expect(mockInvoke).not.toHaveBeenCalled();
        await flush(1);
        expect(mockInvoke).toHaveBeenCalledTimes(1);
        const [cmd, args] = mockInvoke.mock.calls[0];
        expect(cmd).toBe('preview_formula');
        expect(args).toEqual({ formula: '$A + 1', aggregate: undefined, maxPoints: 600, replace: true, requestId: 1, expectedGeneration: 7 });
        expect(Object.keys(args).some(k => k.includes('_'))).toBe(false);
        expect(result.current).toMatchObject({
            ok: true, issues: [], stats: { rows: 3 }, values: [1, 3], timestamps: ['t1', 't2'], period: ['t1', 't3'],
            functions: ['abs', 'sqrt'], limits: { max_len: 4096, max_depth: 64 }, converted_formula: null,
            loading: false, isCurrent: true, stale: false, error: null,
        });
        expect(getKnownFormulaFunctions()).toEqual(['abs', 'sqrt']);
    });

    it('sends an aggregate block (decimals included) and no formula', async () => {
        mockInvoke.mockResolvedValue(okReply());
        renderHook(() => usePreviewFormula({ input: { aggregate: { type: 'mean', sources: ['A', 'B'], decimals: 2 } } }));
        await flush();
        expect(mockInvoke.mock.calls[0][1]).toMatchObject({ formula: undefined, aggregate: { type: 'mean', sources: ['A', 'B'], decimals: 2 }, maxPoints: 600, replace: false });
        expect('expectedGeneration' in mockInvoke.mock.calls[0][1]).toBe(false);
    });

    it('requestIds increase monotonically; a reply for an older input is dropped', async () => {
        const first = deferred<FormulaPreviewResult>();
        mockInvoke.mockReturnValueOnce(first.promise).mockResolvedValueOnce(refused('op_no_right', [3, 4]));
        const { result, rerender } = renderHook((p: UsePreviewFormulaOptions) => usePreviewFormula(p), { initialProps: { input: { formula: '$A' } } });
        await flush();
        rerender({ input: { formula: '$A +' } });
        expect(result.current.isCurrent).toBe(false);
        await flush();
        expect(mockInvoke.mock.calls.map(c => c[1].requestId)).toEqual([1, 2]);
        expect(result.current).toMatchObject({ ok: false, issues: [{ code: 'op_no_right', range: [3, 4] }], isCurrent: true });
        await act(async () => { first.resolve(okReply()); await Promise.resolve(); });
        expect(result.current.ok).toBe(false); // the old "ok" never lands
    });

    it('re-renders with the same input do no new work', async () => {
        mockInvoke.mockResolvedValue(okReply());
        const { rerender } = renderHook((p: UsePreviewFormulaOptions) => usePreviewFormula(p), { initialProps: { input: { formula: '$A' } } });
        await flush();
        rerender({ input: { formula: '$A' } });
        rerender({ input: { formula: '$A' } });
        await flush(1000);
        expect(mockInvoke).toHaveBeenCalledTimes(1);
    });

    it('CANCELLED: re-issued (fresh id) only while it is still the latest this window sent', async () => {
        mockInvoke
            .mockRejectedValueOnce('CANCELLED: a newer formula preview replaced this one')
            .mockResolvedValueOnce(okReply());
        const { result } = renderHook(() => usePreviewFormula({ input: { formula: '$A' } }));
        await flush();
        await act(async () => { await Promise.resolve(); });
        expect(mockInvoke.mock.calls.map(c => c[1].requestId)).toEqual([1, 2]);
        expect(result.current.ok).toBe(true);
    });

    it('CANCELLED for a request that is no longer the latest sent (another editor took over) is dropped, not retried', async () => {
        const a = deferred<FormulaPreviewResult>();
        mockInvoke.mockReturnValueOnce(a.promise).mockResolvedValueOnce(okReply());
        const one = renderHook(() => usePreviewFormula({ input: { formula: '$A' } }));
        await flush();
        const two = renderHook(() => usePreviewFormula({ input: { formula: '$B' } }));
        await flush();
        await act(async () => { a.reject('CANCELLED: a newer formula preview replaced this one'); await Promise.resolve(); });
        expect(mockInvoke).toHaveBeenCalledTimes(2);
        expect(one.result.current).toMatchObject({ ok: null, loading: false });
        expect(two.result.current.ok).toBe(true);
    });

    it('gives up re-issuing after two tries (no ping-pong)', async () => {
        mockInvoke.mockRejectedValue('CANCELLED: x');
        const { result } = renderHook(() => usePreviewFormula({ input: { formula: '$A' } }));
        await flush();
        for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
        expect(mockInvoke).toHaveBeenCalledTimes(3);
        expect(result.current.loading).toBe(false);
    });

    it('STALE_SESSION is "no information" with a stale flag; another rejection is an error, never a formula issue', async () => {
        mockInvoke.mockRejectedValueOnce('STALE_SESSION: the dataset changed').mockRejectedValueOnce('No data loaded');
        const { result, rerender } = renderHook((p: UsePreviewFormulaOptions) => usePreviewFormula(p), { initialProps: { input: { formula: '$A' }, generation: 3 } as UsePreviewFormulaOptions });
        await flush();
        expect(result.current).toMatchObject({ ok: null, stale: true, error: null, issues: [], loading: false });
        rerender({ input: { formula: '$A + 1' }, generation: 3 });
        await flush();
        expect(result.current).toMatchObject({ ok: null, stale: false, error: 'No data loaded' });
    });

    it('a reply that is not a preview (a mock, an old backend) is no information', async () => {
        mockInvoke.mockResolvedValue(undefined);
        const { result } = renderHook(() => usePreviewFormula({ input: { formula: '$A' } }));
        await flush();
        expect(result.current).toMatchObject({ ok: null, loading: false, stale: false, error: null });
    });

    it('no input / a blank formula calls nothing and clears the answer; the function list stays known', async () => {
        mockInvoke.mockResolvedValue(okReply());
        const { result, rerender } = renderHook((p: UsePreviewFormulaOptions) => usePreviewFormula(p), { initialProps: { input: { formula: '$A' } } as UsePreviewFormulaOptions });
        await flush();
        rerender({ input: { formula: '   ' } });
        await flush();
        rerender({ input: null });
        await flush();
        expect(mockInvoke).toHaveBeenCalledTimes(1);
        expect(result.current).toMatchObject({ ok: null, loading: false, functions: ['abs', 'sqrt'] });
        // A newly mounted editor gets the list at once.
        const other = renderHook(() => usePreviewFormula({ input: null }));
        expect(other.result.current.functions).toEqual(['abs', 'sqrt']);
    });

    it('a reply arriving after unmount is ignored', async () => {
        const d = deferred<FormulaPreviewResult>();
        mockInvoke.mockReturnValueOnce(d.promise);
        const { unmount } = renderHook(() => usePreviewFormula({ input: { formula: '$A' } }));
        await flush();
        unmount();
        await act(async () => { d.resolve(okReply()); await Promise.resolve(); });
    });
});

describe('previewInputKey', () => {
    it('differs for every option that changes the answer', () => {
        const k = previewInputKey({ formula: '$A' });
        expect(previewInputKey({ formula: '$A' }, true)).not.toBe(k);
        expect(previewInputKey({ formula: '$A' }, false, 2)).not.toBe(k);
        expect(previewInputKey({ formula: '$A' }, false, undefined, 100)).not.toBe(k);
        expect(previewInputKey({ aggregate: { type: 'mean', sources: ['A'] } })).not.toBe(previewInputKey({ aggregate: { type: 'mean', sources: ['A'], decimals: 1 } }));
        expect(previewInputKey({ formula: '  ' })).toBeNull();
        expect(previewInputKey(null)).toBeNull();
    });
});

describe('resolveFormulaVerdict: Rust has the last word', () => {
    const cheap = { code: 'missing_operator', message: 'two values', range: [0, 5] as [number, number] };
    it('a current Rust answer wins in both directions', () => {
        expect(resolveFormulaVerdict(cheap, { isCurrent: true, ok: true, issues: [] })).toEqual({ issue: null, source: 'rust', valid: true });
        const r = { code: 'unknown_function', message: 'nope' };
        expect(resolveFormulaVerdict(null, { isCurrent: true, ok: false, issues: [r] })).toEqual({ issue: r, source: 'rust', valid: false });
    });
    it('until Rust answers the current text, the front-end issue (or nothing known)', () => {
        expect(resolveFormulaVerdict(cheap, { isCurrent: false, ok: true, issues: [] })).toEqual({ issue: cheap, source: 'check', valid: false });
        expect(resolveFormulaVerdict(null, { isCurrent: false, ok: null, issues: [] })).toEqual({ issue: null, source: null, valid: null });
        expect(resolveFormulaVerdict(null, { isCurrent: true, ok: null, issues: [] })).toEqual({ issue: null, source: null, valid: null });
    });
});
