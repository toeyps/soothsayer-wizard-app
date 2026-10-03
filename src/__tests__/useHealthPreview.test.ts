import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { mk } from './helpers/failureModelFixture';
import type { FailureGroupStateSlice, FailureModel, HealthSetPoints } from '../types';
import type { HealthPreview } from '../types/health';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (...args: unknown[]) => mockInvoke(...args),
}));

import { useHealthPreview, type UseHealthPreviewOptions } from '../hooks/useHealthPreview';
import { computeTrainFingerprint } from '../utils/trainFingerprint';

const fg: FailureGroupStateSlice = {
    groups: [], models: [],
    runningConditionFilters: [], runningConditionCombine: 'and', runningConditionTimePeriods: [], runningConditionNoneConfirmed: true,
};
const HEADERS = ['T', 'P1'];
const sp = (lower: number | null, upper: number | null): HealthSetPoints => ({ kind: 'individual', lower, upper });

const preview = (tag: string): HealthPreview => ({
    kind: 'individual',
    stats: { kind: 'individual', rows: 3, mean: 1, sd: 1, boundary_1sd: [0, 2], boundary_3sd: [-2, 4], min: 0, max: 2 },
    validation: [], valid: true,
    series: { kind: 'individual', rows: [0], timestamps: [tag], value: [1], in_scope: [true], score: [100], total_points: 1 },
    score_summary: null, histogram: null, fit_scatter: null, cluster_scatter: null,
});

const indModel = (over: Partial<FailureModel> = {}) => mk({ id: 'i1', kind: 'individual', targetSensor: 'T', ...over });
const opts = (over: Partial<UseHealthPreviewOptions> = {}): UseHealthPreviewOptions => ({
    model: indModel(), fg, headers: HEADERS, setPoints: sp(1, 9), ...over,
});

const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(300); });

beforeEach(() => {
    mockInvoke.mockReset();
    vi.useFakeTimers();
});
afterEach(() => {
    vi.useRealTimers();
});

describe('useHealthPreview', () => {
    it('calls compute_health_preview with { request } (single key) after the debounce and returns the data', async () => {
        mockInvoke.mockResolvedValue(preview('a'));
        const { result } = renderHook(() => useHealthPreview(opts()));
        expect(result.current.loading).toBe(true);
        expect(mockInvoke).not.toHaveBeenCalled(); // debounced
        await settle();
        expect(mockInvoke).toHaveBeenCalledTimes(1);
        const [cmd, args] = mockInvoke.mock.calls[0];
        expect(cmd).toBe('compute_health_preview');
        expect(args).toEqual({ request: expect.objectContaining({ kind: 'individual', target: 'T', set_points: { lower: 1, upper: 9 }, max_points: 4000 }) });
        expect((result.current.data?.series as { timestamps: string[] }).timestamps).toEqual(['a']);
        expect(result.current.loading).toBe(false);
        expect(result.current.error).toBeNull();
        expect(result.current.idle).toBeNull();
    });

    it('debounces set-point edits: rapid changes make ONE call, with the last value', async () => {
        mockInvoke.mockResolvedValue(preview('a'));
        const { rerender } = renderHook((o: UseHealthPreviewOptions) => useHealthPreview(o), { initialProps: opts() });
        await settle();
        mockInvoke.mockClear();
        for (const lower of [2, 3, 4]) {
            rerender(opts({ setPoints: sp(lower, 9) }));
            await act(async () => { await vi.advanceTimersByTimeAsync(100); });
        }
        expect(mockInvoke).not.toHaveBeenCalled();
        await settle();
        expect(mockInvoke).toHaveBeenCalledTimes(1);
        expect(mockInvoke.mock.calls[0][1].request.set_points).toEqual({ lower: 4, upper: 9 });
    });

    it('never refetches when only fields that are not part of the request change (name, notes, category, status, a new model object)', async () => {
        mockInvoke.mockResolvedValue(preview('a'));
        const { rerender } = renderHook((o: UseHealthPreviewOptions) => useHealthPreview(o), { initialProps: opts() });
        await settle();
        mockInvoke.mockClear();
        rerender(opts({ model: indModel({ name: 'Renamed', notes: 'x', category: 'performance', status: true }) }));
        rerender(opts({ model: indModel(), headers: [...HEADERS] }));
        await settle();
        expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('refetches when the training scope changes (workspace running condition)', async () => {
        mockInvoke.mockResolvedValue(preview('a'));
        const { rerender } = renderHook((o: UseHealthPreviewOptions) => useHealthPreview(o), { initialProps: opts() });
        await settle();
        mockInvoke.mockClear();
        rerender(opts({ fg: { ...fg, runningConditionCombine: 'or', runningConditionNoneConfirmed: false, runningConditionFilters: [{ id: 'f', sensor: 'P1', operation: 'greater_than', value1: '2', value2: '' }] } }));
        await settle();
        expect(mockInvoke).toHaveBeenCalledTimes(1);
        expect(mockInvoke.mock.calls[0][1].request.filter.value_filters).toHaveLength(1);
    });

    it('refetches on `revision` (e.g. after a re-train re-populated the Rust fit cache), and never sends it', async () => {
        mockInvoke.mockResolvedValue(preview('a'));
        const { rerender } = renderHook((o: UseHealthPreviewOptions) => useHealthPreview(o), { initialProps: opts({ revision: 0 }) });
        await settle();
        rerender(opts({ revision: 1 }));
        await settle();
        expect(mockInvoke).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(mockInvoke.mock.calls[1][1])).not.toContain('revision');
    });

    it('sequence guard: a slow older response can never overwrite a newer one', async () => {
        let resolveFirst!: (v: HealthPreview) => void;
        mockInvoke
            .mockImplementationOnce(() => new Promise<HealthPreview>(res => { resolveFirst = res; }))
            .mockResolvedValueOnce(preview('second'));
        const { result, rerender } = renderHook((o: UseHealthPreviewOptions) => useHealthPreview(o), { initialProps: opts({ setPoints: sp(1, 9) }) });
        await settle(); // first request now in flight
        rerender(opts({ setPoints: sp(2, 9) }));
        await settle(); // second request lands
        expect((result.current.data?.series as { timestamps: string[] }).timestamps).toEqual(['second']);
        await act(async () => { resolveFirst(preview('first')); await Promise.resolve(); });
        expect((result.current.data?.series as { timestamps: string[] }).timestamps).toEqual(['second']);
    });

    it('keeps the previous data on screen while the next request loads', async () => {
        mockInvoke.mockResolvedValueOnce(preview('first'));
        const { result, rerender } = renderHook((o: UseHealthPreviewOptions) => useHealthPreview(o), { initialProps: opts() });
        await settle();
        mockInvoke.mockImplementationOnce(() => new Promise(() => {})); // never resolves
        rerender(opts({ setPoints: sp(5, 9) }));
        await settle();
        expect(result.current.loading).toBe(true);
        expect((result.current.data?.series as { timestamps: string[] }).timestamps).toEqual(['first']);
    });

    it('does not show one model\'s data for another model', async () => {
        mockInvoke.mockResolvedValueOnce(preview('first'));
        const { result, rerender } = renderHook((o: UseHealthPreviewOptions) => useHealthPreview(o), { initialProps: opts() });
        await settle();
        expect(result.current.data).not.toBeNull();
        mockInvoke.mockImplementationOnce(() => new Promise(() => {}));
        rerender(opts({ model: indModel({ id: 'i2', targetSensor: 'P1' }) }));
        expect(result.current.data).toBeNull();
    });

    describe('error code mapping', () => {
        const cases: Array<[string, string]> = [
            ['NOT_FITTED: this Relationship model has no fit in memory', 'NOT_FITTED'],
            ['NO_DATA: no rows in scope', 'NO_DATA'],
            ['STALE_SESSION: the dataset was reloaded', 'STALE_SESSION'],
            ['BAD_REQUEST: target not found: T', 'BAD_REQUEST'],
        ];
        for (const [text, code] of cases) {
            it(code, async () => {
                mockInvoke.mockRejectedValue(text);
                const { result } = renderHook(() => useHealthPreview(opts()));
                await settle();
                expect(result.current.errorCode).toBe(code);
                expect(result.current.error).toBe(text.slice(code.length + 2));
                expect(result.current.data).toBeNull();
                expect(result.current.loading).toBe(false);
            });
        }

        it('NOT_FITTED sets notFitted / needsRetrain; other codes do not', async () => {
            mockInvoke.mockRejectedValue('NOT_FITTED: x');
            const a = renderHook(() => useHealthPreview(opts()));
            await settle();
            expect(a.result.current.notFitted).toBe(true);
            expect(a.result.current.needsRetrain).toBe(true);
            mockInvoke.mockRejectedValue('NO_DATA: x');
            const b = renderHook(() => useHealthPreview(opts()));
            await settle();
            expect(b.result.current.notFitted).toBe(false);
            expect(b.result.current.needsRetrain).toBe(false);
        });

        it('an error with no known prefix keeps its text and has a null code', async () => {
            mockInvoke.mockRejectedValue(new Error('disk exploded'));
            const { result } = renderHook(() => useHealthPreview(opts()));
            await settle();
            expect(result.current.error).toBe('disk exploded');
            expect(result.current.errorCode).toBeNull();
        });

        it('clears the error on the next successful request', async () => {
            mockInvoke.mockRejectedValueOnce('NOT_FITTED: x').mockResolvedValueOnce(preview('ok'));
            const { result, rerender } = renderHook((o: UseHealthPreviewOptions) => useHealthPreview(o), { initialProps: opts() });
            await settle();
            expect(result.current.notFitted).toBe(true);
            rerender(opts({ revision: 1 }));
            await settle();
            expect(result.current.notFitted).toBe(false);
            expect(result.current.error).toBeNull();
            expect(result.current.data).not.toBeNull();
        });
    });

    describe('no request is made when', () => {
        it('enabled is false', async () => {
            const { result } = renderHook(() => useHealthPreview(opts({ enabled: false })));
            await settle();
            expect(mockInvoke).not.toHaveBeenCalled();
            expect(result.current.idle).toBe('disabled');
        });

        it('there is no model', async () => {
            renderHook(() => useHealthPreview(opts({ model: null })));
            await settle();
            expect(mockInvoke).not.toHaveBeenCalled();
        });

        it('the model is stale (trained, inputs changed since) - and keeps the old data on screen', async () => {
            mockInvoke.mockResolvedValue(preview('before'));
            const trained = indModel({ lastTrainedAt: '2026-10-03T00:00:00Z' });
            const fresh = { ...trained, trainedFingerprint: computeTrainFingerprint(trained, fg) };
            const { result, rerender } = renderHook((o: UseHealthPreviewOptions) => useHealthPreview(o), { initialProps: opts({ model: fresh }) });
            await settle();
            expect(result.current.data).not.toBeNull();
            mockInvoke.mockClear();
            rerender(opts({ model: { ...fresh, targetSensor: 'P1' } }));
            await settle();
            expect(mockInvoke).not.toHaveBeenCalled();
            expect(result.current.idle).toBe('stale');
            expect(result.current.loading).toBe(false);
        });

        it('a Complete model that is stale (old data) is idle too', async () => {
            const m = indModel({ status: true, lastTrainedAt: '2026-10-03T00:00:00Z', trainedFingerprint: 'does-not-match' });
            const { result } = renderHook(() => useHealthPreview(opts({ model: m })));
            await settle();
            expect(mockInvoke).not.toHaveBeenCalled();
            expect(result.current.idle).toBe('stale');
        });

        it('a required sensor is missing', async () => {
            const { result } = renderHook(() => useHealthPreview(opts({ model: indModel({ targetSensor: '' }) })));
            await settle();
            expect(mockInvoke).not.toHaveBeenCalled();
            expect(result.current.idle).toBe('inputs');
        });
    });

    it('passes the caller\'s max_points / expected_generation / include_out_of_scope through', async () => {
        mockInvoke.mockResolvedValue(preview('a'));
        renderHook(() => useHealthPreview(opts({ maxPoints: 20000, expectedGeneration: 3, includeOutOfScope: true })));
        await settle();
        expect(mockInvoke.mock.calls[0][1].request).toMatchObject({ max_points: 20000, expected_generation: 3, include_out_of_scope: true });
    });

    it('Relationship requests carry the fingerprint-based cache_key', async () => {
        mockInvoke.mockResolvedValue({ ...preview('a'), kind: 'relationship' });
        const rel = mk({ id: 'r1', kind: 'relationship', targetSensor: 'T', predictorSensors: ['P1'], relStiffness: 100_000 });
        renderHook(() => useHealthPreview(opts({ model: rel, setPoints: { kind: 'relationship', residualAt80Lower: -1, residualAt80Upper: 1, residualAt0Lower: -2, residualAt0Upper: 2 } })));
        await settle();
        expect(mockInvoke.mock.calls[0][1].request.cache_key).toBe(`r1::${computeTrainFingerprint(rel, fg)}`);
    });
});
