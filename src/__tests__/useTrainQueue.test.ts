import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { StrictMode, createElement, type ReactNode } from 'react';
import { useTrainQueue, type UseTrainQueueOptions } from '../hooks/useTrainQueue';
import type { TrainCandidate, TrainOutcome } from '../types/trainQueue';
import type { ModelKind } from '../types';

/** A controllable fake `train`: every call waits until the test settles it. */
function fakeTrainer() {
    const pending = new Map<string, { resolve: (o: TrainOutcome) => void; reject: (e: unknown) => void }>();
    const calls: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const train = vi.fn((id: string) => {
        calls.push(id);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<TrainOutcome>((resolve, reject) => {
            pending.set(id, {
                resolve: o => { inFlight--; pending.delete(id); resolve(o); },
                reject: e => { inFlight--; pending.delete(id); reject(e); },
            });
        });
    });
    return {
        train,
        calls,
        get maxInFlight() { return maxInFlight; },
        isPending: (id: string) => pending.has(id),
        resolveRaw: (id: string, o: TrainOutcome) => pending.get(id)?.resolve(o),
        settle: async (id: string, o: TrainOutcome = { ok: true }) => {
            const p = pending.get(id);
            if (!p) throw new Error(`${id} is not training`);
            await act(async () => { p.resolve(o); await vi.advanceTimersByTimeAsync(1); });
        },
        fail: async (id: string, e: unknown) => {
            const p = pending.get(id);
            if (!p) throw new Error(`${id} is not training`);
            await act(async () => { p.reject(e); await vi.advanceTimersByTimeAsync(1); });
        },
    };
}

const ready = (id: string, kind: ModelKind = 'individual'): TrainCandidate => ({ id, kind, plan: { kind: 'ready' } });
const upToDate = (id: string, complete = false): TrainCandidate => ({
    id, kind: 'individual', plan: { kind: 'upToDate', reason: complete ? 'Complete, up to date' : 'up to date', complete },
});
const missing = (id: string): TrainCandidate => ({ id, kind: 'clustering', plan: { kind: 'missing', reason: 'no Y sensor', fix: 'settings' } });

let clock = 0;
const now = () => clock;

function setup(extra: Partial<UseTrainQueueOptions> = {}, scopeKey: string | null = 'ws-1') {
    const t = fakeTrainer();
    const hook = renderHook(
        (props: { scopeKey: string | null; options: Partial<UseTrainQueueOptions> }) =>
            useTrainQueue({ train: t.train, now, ...props.options, scopeKey: props.scopeKey }),
        { initialProps: { scopeKey, options: extra } },
    );
    const start = (cands: TrainCandidate[], opts?: Parameters<typeof hook.result.current.start>[1]) => {
        let started = false;
        act(() => { started = hook.result.current.start(cands, opts); });
        return started;
    };
    const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(1); });
    return { t, hook, start, flush };
}

beforeEach(() => {
    vi.useFakeTimers();
    clock = 0;
});
afterEach(() => {
    vi.useRealTimers();
});

describe('useTrainQueue — order and one at a time', () => {
    it('trains the queued models strictly one at a time, in the given order', async () => {
        const { t, hook, start, flush } = setup();
        expect(start([ready('a'), ready('b', 'relationship'), ready('c', 'clustering')])).toBe(true);
        await flush();
        expect(t.calls).toEqual(['a']);
        expect(hook.result.current.isRunning).toBe(true);
        expect(hook.result.current.run?.currentId).toBe('a');
        expect(hook.result.current.itemOf('a')?.state).toBe('running');
        expect(hook.result.current.summary?.text).toBe('Training 1 of 3');

        await t.settle('a');
        expect(t.calls).toEqual(['a', 'b']);
        expect(hook.result.current.summary?.text).toBe('Training 2 of 3');
        await t.settle('b');
        await t.settle('c');
        expect(t.calls).toEqual(['a', 'b', 'c']);
        expect(t.maxInFlight).toBe(1);
        expect(hook.result.current.isRunning).toBe(false);
        expect(hook.result.current.run?.phase).toBe('done');
        expect(hook.result.current.summary).toMatchObject({ text: 'Done · 3 trained', tone: 'success' });
    });

    it('skips are decided before the run: up to date (grey) and missing settings (amber) are never trained', async () => {
        const { t, hook, start, flush } = setup();
        start([upToDate('u'), ready('a'), missing('m')]);
        await flush();
        expect(hook.result.current.itemOf('u')).toMatchObject({ state: 'skipped', skip: { kind: 'upToDate', reason: 'up to date' } });
        expect(hook.result.current.itemOf('m')).toMatchObject({ state: 'skipped', skip: { kind: 'missing', reason: 'no Y sensor' } });
        await t.settle('a');
        expect(t.calls).toEqual(['a']);
        expect(hook.result.current.summary?.text).toBe('Done · 1 trained · 2 skipped');
    });

    it('includeUpToDate (Re-train all / Train only… / the Train all checkbox) queues up-to-date models', async () => {
        const { t, start, flush } = setup();
        start([upToDate('u', true), ready('a'), missing('m')], { includeUpToDate: true, source: 'sensor-all' });
        await flush();
        await t.settle('u');
        await t.settle('a');
        expect(t.calls).toEqual(['u', 'a']);
    });

    it('refuses to start when nothing would be queued, or while a run is active', async () => {
        const { t, hook, start, flush } = setup();
        expect(start([upToDate('u'), missing('m')])).toBe(false);
        expect(hook.result.current.run).toBeNull();
        expect(start([ready('a')])).toBe(true);
        await flush();
        expect(start([ready('b')])).toBe(false);
        expect(hook.result.current.canStart).toBe(false);
        await t.settle('a');
        expect(t.calls).toEqual(['a']);
        expect(hook.result.current.canStart).toBe(true);
    });
});

describe('useTrainQueue — failures', () => {
    it('a failed model does not stop the queue; partial failure is amber', async () => {
        const { t, hook, start, flush } = setup();
        start([ready('a'), ready('b')]);
        await flush();
        await t.settle('a', { ok: false, error: 'NO_DATA: No rows in the training scope.' });
        expect(hook.result.current.itemOf('a')).toMatchObject({ state: 'failed', error: 'NO_DATA: No rows in the training scope.' });
        await t.settle('b');
        expect(hook.result.current.summary).toMatchObject({ text: 'Done · 1 trained · 1 failed', tone: 'warning', outcome: 'partial' });
    });

    it('red only when nothing trained', async () => {
        const { t, hook, start, flush } = setup();
        start([ready('a')]);
        await flush();
        await t.settle('a', { ok: false, error: 'boom' });
        expect(hook.result.current.summary).toMatchObject({ tone: 'danger', outcome: 'failed' });
    });

    it('a rejected train counts as a failure with its text', async () => {
        const { t, hook, start, flush } = setup();
        start([ready('a'), ready('b')]);
        await flush();
        await t.fail('a', new Error('The Relation model engine stopped without returning a result.'));
        expect(hook.result.current.itemOf('a')).toMatchObject({ state: 'failed', error: 'The Relation model engine stopped without returning a result.' });
        expect(t.calls).toEqual(['a', 'b']);
    });

    it('{ ok: false, skip } at its turn → skipped (amber), counted in "i of n"', async () => {
        const { t, hook, start, flush } = setup();
        start([ready('a'), ready('b')]);
        await flush();
        await t.settle('a', { ok: false, skip: 'no running condition' });
        expect(hook.result.current.itemOf('a')).toMatchObject({ state: 'skipped', skip: { kind: 'missing', reason: 'no running condition', atTurn: true } });
        expect(hook.result.current.summary?.text).toBe('Training 2 of 2');
        await t.settle('b');
        expect(hook.result.current.summary?.text).toBe('Done · 1 trained · 1 skipped');
    });
});

describe('useTrainQueue — Remove from run / Cancel', () => {
    it('removes a queued model (never trained); a running one cannot be removed', async () => {
        const { t, hook, start, flush } = setup();
        start([ready('a'), ready('b'), ready('c')]);
        await flush();
        expect(hook.result.current.isLocked('b')).toBe(true);
        expect(hook.result.current.queuePositionOf('b')).toBe(1);
        expect(hook.result.current.queuePositionOf('c')).toBe(2);
        let ok = false;
        act(() => { ok = hook.result.current.removeFromRun('b'); });
        expect(ok).toBe(true);
        expect(hook.result.current.itemOf('b')?.state).toBe('removed');
        expect(hook.result.current.isLocked('b')).toBe(false);
        expect(hook.result.current.queuePositionOf('c')).toBe(1);
        expect(hook.result.current.summary?.text).toBe('Training 1 of 2');
        act(() => { ok = hook.result.current.removeFromRun('a'); });
        expect(ok).toBe(false);
        await t.settle('a');
        await t.settle('c');
        expect(t.calls).toEqual(['a', 'c']);
        expect(hook.result.current.summary?.text).toBe('Done · 2 trained · 1 removed');
    });

    it('Cancel stops after the current model; the rest are "not started"', async () => {
        const { t, hook, start, flush } = setup();
        start([ready('a'), ready('b'), ready('c')]);
        await flush();
        act(() => hook.result.current.stopAfterCurrent());
        expect(hook.result.current.run?.stopRequested).toBe('cancel');
        expect(t.isPending('a')).toBe(true); // never interrupted
        await t.settle('a');
        expect(t.calls).toEqual(['a']);
        expect(hook.result.current.run?.phase).toBe('stopped');
        expect(hook.result.current.summary).toMatchObject({ text: 'Stopped · 1 trained · 2 not started', notStartedIds: ['b', 'c'] });
    });

    it("'close' wins over an earlier 'cancel'", async () => {
        const { hook, start, flush } = setup();
        start([ready('a'), ready('b')]);
        await flush();
        act(() => hook.result.current.stopAfterCurrent('cancel'));
        act(() => hook.result.current.stopAfterCurrent('close'));
        act(() => hook.result.current.stopAfterCurrent('cancel'));
        expect(hook.result.current.run?.stopRequested).toBe('close');
    });

    it('a stop asked during the last model ends as done (nothing left not started)', async () => {
        const { t, hook, start, flush } = setup();
        start([ready('a')]);
        await flush();
        act(() => hook.result.current.stopAfterCurrent());
        await t.settle('a');
        expect(hook.result.current.run?.phase).toBe('done');
    });
});

describe('useTrainQueue — STALE_SESSION', () => {
    it.each([
        ['an error text starting with STALE_SESSION', { ok: false, error: 'STALE_SESSION: the dataset changed' } as TrainOutcome],
        ['stale: true', { ok: false, error: 'The dataset changed since this window was opened', stale: true } as TrainOutcome],
    ])('%s stops the run at once and sets `stale`', async (_label, outcome) => {
        const { t, hook, start, flush } = setup();
        start([ready('a'), ready('b'), ready('c')]);
        await flush();
        await t.settle('a');
        await t.settle('b', outcome);
        expect(t.calls).toEqual(['a', 'b']);
        expect(hook.result.current.stale).toBe(true);
        expect(hook.result.current.canStart).toBe(false);
        expect(hook.result.current.run).toMatchObject({ phase: 'stale', staleError: (outcome as { error: string }).error });
        expect(hook.result.current.itemOf('b')?.state).toBe('notStarted');
        expect(hook.result.current.summary).toMatchObject({ text: 'Stopped · 1 trained · 2 not started', tone: 'danger' });
        // Both Train buttons stay disabled until the window is reset.
        expect(start([ready('d')])).toBe(false);
        act(() => hook.result.current.reset());
        expect(hook.result.current.stale).toBe(false);
        expect(start([ready('d')])).toBe(true);
    });
});

describe('useTrainQueue — time left', () => {
    it('null until one model finished, then the per-kind average × models still to go', async () => {
        const { t, hook, start, flush } = setup();
        start([ready('a'), ready('b'), ready('c')]);
        await flush();
        expect(hook.result.current.timeLeftMs).toBeNull();
        clock += 2000;
        await t.settle('a');
        expect(hook.result.current.run?.items[0].durationMs).toBe(2000);
        expect(hook.result.current.timeLeftMs).toBe(4000); // b running + c queued
        clock += 4000;
        await t.settle('b');
        expect(hook.result.current.timeLeftMs).toBe(3000);
        await t.settle('c');
        expect(hook.result.current.timeLeftMs).toBeNull();
    });
});

describe('useTrainQueue — the close dialog API', () => {
    it('whenIdle resolves with the final summary; at once when idle', async () => {
        const { t, hook, start, flush } = setup();
        await expect(hook.result.current.whenIdle()).resolves.toBeNull();
        start([ready('a'), ready('b')]);
        await flush();
        let resolved: unknown = 'pending';
        void hook.result.current.whenIdle().then(s => { resolved = s; });
        act(() => hook.result.current.stopAfterCurrent('close'));
        await t.settle('a');
        expect(resolved).toMatchObject({ outcome: 'stopped', text: 'Stopped · 1 trained · 1 not started' });
        await expect(hook.result.current.whenIdle()).resolves.toMatchObject({ outcome: 'stopped' });
    });

    it('isRunningNow reads the run ref at call time (a stale render\'s handler still sees the run end)', async () => {
        const { t, hook, start, flush } = setup();
        const fromFirstRender = hook.result.current.isRunningNow;
        expect(fromFirstRender()).toBe(false);
        start([ready('a')]);
        // Before React re-renders, `isRunning` of the captured result is still false; the ref is not.
        expect(fromFirstRender()).toBe(true);
        await flush();
        await t.settle('a');
        expect(fromFirstRender()).toBe(false);
        expect(hook.result.current.isRunningNow).toBe(fromFirstRender); // stable
    });

    it('onFinished is called once per run with the latest callback', async () => {
        const first = vi.fn();
        const second = vi.fn();
        const { t, hook, start, flush } = setup({ onFinished: first });
        start([ready('a')]);
        await flush();
        hook.rerender({ scopeKey: 'ws-1', options: { onFinished: second } });
        await t.settle('a');
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);
        expect(second.mock.calls[0][1]).toMatchObject({ text: 'Done · 1 trained' });
    });

    it('lastTrained lists the models trained by the run, survives dismiss, clears on the next start', async () => {
        const { t, hook, start, flush } = setup();
        start([ready('a'), ready('b')]);
        await flush();
        await t.settle('a');
        await t.settle('b', { ok: false, error: 'x' });
        expect(hook.result.current.lastTrained?.ids).toEqual(['a']);
        act(() => hook.result.current.dismiss());
        expect(hook.result.current.run).toBeNull();
        expect(hook.result.current.lastTrained?.ids).toEqual(['a']);
        start([ready('c')]);
        expect(hook.result.current.lastTrained).toBeNull();
    });

    it('dismiss does nothing while running', async () => {
        const { hook, start, flush } = setup();
        start([ready('a')]);
        await flush();
        act(() => hook.result.current.dismiss());
        expect(hook.result.current.isRunning).toBe(true);
    });
});

describe('useTrainQueue — re-pointed, abandoned, unmounted', () => {
    it('a scope change drops the run; the in-flight result is ignored; a new run waits for that call first', async () => {
        const { t, hook, start, flush } = setup();
        start([ready('a'), ready('b')]);
        await flush();
        let idle: unknown = 'pending';
        void hook.result.current.whenIdle().then(s => { idle = s; });
        hook.rerender({ scopeKey: 'ws-2', options: {} });
        await flush();
        expect(hook.result.current.run).toBeNull();
        expect(idle).toBeNull();

        // New workspace, new run — but 'a' (old workspace) is still in the sidecar.
        start([ready('x')]);
        await flush();
        expect(t.calls).toEqual(['a']);
        await t.settle('a'); // old result: ignored
        expect(t.calls).toEqual(['a', 'x']);
        expect(hook.result.current.itemOf('a')).toBeUndefined();
        await t.settle('x');
        expect(hook.result.current.summary?.text).toBe('Done · 1 trained');
        expect(t.maxInFlight).toBe(1);
    });

    it('the same scope on re-render keeps the run', async () => {
        const { hook, start, flush } = setup();
        start([ready('a')]);
        await flush();
        hook.rerender({ scopeKey: 'ws-1', options: {} });
        expect(hook.result.current.isRunning).toBe(true);
    });

    it('{ ok: false, abandoned } drops the run silently', async () => {
        const onFinished = vi.fn();
        const { t, hook, start, flush } = setup({ onFinished });
        start([ready('a'), ready('b')]);
        await flush();
        await t.settle('a', { ok: false, abandoned: true });
        expect(hook.result.current.run).toBeNull();
        expect(t.calls).toEqual(['a']);
        expect(onFinished).not.toHaveBeenCalled();
    });

    it('unmount mid-run: no further trains, no state updates, no timers left', async () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const onFinished = vi.fn();
        const { t, hook, start, flush } = setup({ onFinished });
        start([ready('a'), ready('b')]);
        await flush();
        hook.unmount();
        await t.settle('a');
        await flush();
        expect(t.calls).toEqual(['a']);
        expect(onFinished).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        expect(errors).not.toHaveBeenCalled();
        errors.mockRestore();
    });

    it('reset between two models clears the pending yield', async () => {
        const { t, hook, start, flush } = setup();
        start([ready('a'), ready('b')]);
        await flush();
        // Settle 'a' WITHOUT advancing timers: the loop now waits on its between-models yield.
        await act(async () => {
            t.resolveRaw('a', { ok: true });
            for (let i = 0; i < 10; i++) await Promise.resolve();
        });
        expect(vi.getTimerCount()).toBe(1);
        act(() => hook.result.current.reset());
        expect(vi.getTimerCount()).toBe(0);
        await flush();
        expect(hook.result.current.run).toBeNull();
        expect(t.calls).toEqual(['a']);
    });

    it('works under StrictMode (effects mounted twice)', async () => {
        const t = fakeTrainer();
        const hook = renderHook(() => useTrainQueue({ train: t.train, scopeKey: 'ws-1', now }), {
            wrapper: ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children),
        });
        act(() => { hook.result.current.start([ready('a'), ready('b')]); });
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        await t.settle('a');
        await t.settle('b');
        expect(hook.result.current.summary?.text).toBe('Done · 2 trained');
    });
});
