import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
    TrainCandidate,
    TrainOutcome,
    TrainQueueItem,
    TrainRun,
    TrainRunSource,
    TrainRunSummary,
    TrainStopReason,
} from '../types/trainQueue';
import { estimateTimeLeftMs, isStaleTrainError, planTrainRun, queuePosition, summarizeTrainRun } from '../utils/trainQueue';

/**
 * The Build Model Workbench's train queue (customer batch 2026-10, items 8 + 9:
 * "Train sensor" / "Train all").
 *
 * - Runs models STRICTLY one at a time, in the order given (one shared Rust
 *   session, one Python sidecar — never in parallel). Even after `reset()` a
 *   new run waits for a train call that is still in flight to settle before it
 *   starts its first model.
 * - Trains through the injected `train(modelId)` (the window's `executeTrain`
 *   wrapper); it is read through a ref, so every model gets the closure of the
 *   latest render. Between two models the loop yields one task, so React
 *   commits the previous model's state before the next one starts.
 * - Skips are decided BEFORE the run (`TrainCandidate.plan`, see
 *   `classifyTrainPlan`); `train()` may still answer `{ ok: false, skip }`
 *   when a model can no longer train at its turn.
 * - Cancel (`stopAfterCurrent`) never interrupts a train call — the existing
 *   train cannot be cancelled; the run stops after the current model.
 * - A STALE_SESSION answer (`stale: true`, or an error text starting with
 *   `STALE_SESSION`) stops the run at once and sets `stale` until `reset()`.
 * - `scopeKey` (the workspace id): when it changes, the run is dropped
 *   (`reset()`); results of a train still in flight are ignored. The same
 *   happens on unmount — no state update after unmount, and the hook owns no
 *   timer that outlives a yield.
 *
 * State is one `run` object (plus `stale` / `lastTrained`), updated about three
 * times per model; everything else is derived with `useMemo`.
 */

export interface UseTrainQueueOptions {
    /** Train ONE model. Must not throw for an ordinary failure (a rejection is
     *  handled as a failure with the error's text anyway). */
    train: (modelId: string) => Promise<TrainOutcome>;
    /** Workspace id (or anything that identifies the data this window shows).
     *  A change drops the run, like `reset()`. */
    scopeKey?: string | null;
    /** Called once per run when it ends (done / stopped / stale), with the
     *  final run and its summary. Not called for a run dropped by `reset()`. */
    onFinished?: (run: TrainRun, summary: TrainRunSummary) => void;
    /** Clock for durations (tests). Defaults to `Date.now`. */
    now?: () => number;
}

export interface StartTrainRunOptions {
    /** Queue `upToDate` models too (Re-train all, Train only…, Train all's checkbox). */
    includeUpToDate?: boolean;
    source?: TrainRunSource;
}

export interface UseTrainQueueResult {
    /** The current or last run; null before the first run and after `dismiss()` / `reset()`. */
    run: TrainRun | null;
    /** Derived from `run` (memoised); null when there is no run. */
    summary: TrainRunSummary | null;
    isRunning: boolean;
    /** Same as `isRunning`, but read from the hook's own run ref at call time —
     *  for handlers that run outside a render (the window's close handlers),
     *  where `isRunning` of the last render can lag behind the run. */
    isRunningNow: () => boolean;
    /** A train returned STALE_SESSION: both Train buttons stay disabled until `reset()`. */
    stale: boolean;
    /** No run is active and the data is not stale. */
    canStart: boolean;
    /** Time left (ms) — average finished duration × models still to go; null until one finished. */
    timeLeftMs: number | null;
    /** Models trained by the last finished run (for the Health score banner and
     *  the "Set points needed" filter); kept after `dismiss()`, cleared by the next
     *  `start()` and by `reset()`. */
    lastTrained: { ids: string[]; finishedAt: number } | null;
    /** Queue the models (`planTrainRun` decides queued vs skipped) and start.
     *  Returns false (and does nothing) when a run is active, the data is stale,
     *  or nothing would be queued. */
    start: (candidates: readonly TrainCandidate[], options?: StartTrainRunOptions) => boolean;
    /** Take a QUEUED model out of the run (its status is unchanged). False when
     *  it is not queued (running, finished, or not in the run). */
    removeFromRun: (modelId: string) => boolean;
    /** Stop after the current model ('cancel' = Cancel, 'close' = the close
     *  dialog's "Stop after this model and close"). No-op unless running. */
    stopAfterCurrent: (reason?: TrainStopReason) => void;
    /** Resolves with the final summary when the active run ends (at once with
     *  the last summary, or null, when nothing is running). Resolves with null
     *  if the run is dropped by `reset()` / a scope change / unmount. */
    whenIdle: () => Promise<TrainRunSummary | null>;
    /** Hide a finished run (the strip's Dismiss). No-op while running. */
    dismiss: () => void;
    /** Drop everything (re-pointed at another workspace): the active run is
     *  abandoned, `stale` and `lastTrained` are cleared. */
    reset: () => void;
    /** The run's item for this model (any state), else undefined. */
    itemOf: (modelId: string) => TrainQueueItem | undefined;
    /** Queued or running in the active run — its settings are locked. */
    isLocked: (modelId: string) => boolean;
    /** 1-based place among the models still waiting (1 = next), 0 when not queued. */
    queuePositionOf: (modelId: string) => number;
}

export function useTrainQueue(options: UseTrainQueueOptions): UseTrainQueueResult {
    const { scopeKey = null } = options;
    const [run, setRunState] = useState<TrainRun | null>(null);
    const [stale, setStale] = useState(false);
    const [lastTrained, setLastTrained] = useState<{ ids: string[]; finishedAt: number } | null>(null);

    /** Source of truth for the loop (state is its mirror for rendering). */
    const runRef = useRef<TrainRun | null>(null);
    const staleRef = useRef(false);
    /** Bumped by reset / scope change / unmount: a loop whose token is old stops. */
    const tokenRef = useRef(0);
    const runIdRef = useRef(0);
    const mountedRef = useRef(true);
    /** The train call currently in flight (even of an abandoned run). */
    const inFlightRef = useRef<Promise<unknown> | null>(null);
    const idleWaitersRef = useRef<((s: TrainRunSummary | null) => void)[]>([]);
    /** The pending between-models yield (cleared by `drop`, so no timer outlives the run). */
    const yieldRef = useRef<{ timer: ReturnType<typeof setTimeout>; resolve: () => void } | null>(null);

    /** A task boundary (a 0 ms timer) between two models. It gives React a
     *  chance to commit the previous model's state, and so refresh the `train`
     *  ref, before the next model starts — usually, not guaranteed (React's
     *  scheduler normally runs first, but nothing orders the two). `train` is
     *  read through `latest`, so it is always the last COMMITTED closure. */
    const yieldToReact = useCallback(() => new Promise<void>(resolve => {
        const timer = setTimeout(() => { yieldRef.current = null; resolve(); }, 0);
        yieldRef.current = { timer, resolve };
    }), []);

    const latest = useRef(options);
    useLayoutEffect(() => { latest.current = options; });

    const commit = useCallback((next: TrainRun | null) => {
        runRef.current = next;
        if (mountedRef.current) setRunState(next);
    }, []);
    const update = useCallback((fn: (r: TrainRun) => TrainRun) => {
        if (runRef.current) commit(fn(runRef.current));
    }, [commit]);

    const settleWaiters = useCallback((value: TrainRunSummary | null) => {
        const waiters = idleWaitersRef.current;
        idleWaitersRef.current = [];
        for (const w of waiters) w(value);
    }, []);

    const drop = useCallback(() => {
        tokenRef.current++;
        const y = yieldRef.current;
        if (y) {
            yieldRef.current = null;
            clearTimeout(y.timer);
            y.resolve(); // the loop wakes up, sees the new token and stops
        }
        settleWaiters(null);
    }, [settleWaiters]);

    const reset = useCallback(() => {
        drop();
        staleRef.current = false;
        commit(null);
        if (mountedRef.current) {
            setStale(false);
            setLastTrained(null);
        }
    }, [commit, drop]);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            drop();
        };
    }, [drop]);

    // Re-pointed at another workspace: nothing of the old run applies any more.
    const scopeRef = useRef(scopeKey);
    useEffect(() => {
        if (scopeRef.current === scopeKey) return;
        scopeRef.current = scopeKey;
        reset();
    }, [scopeKey, reset]);

    const finish = useCallback((token: number, phase: TrainRun['phase'], staleError?: string) => {
        if (token !== tokenRef.current) return;
        const now = (latest.current.now ?? Date.now)();
        update(r => ({
            ...r,
            phase,
            currentId: null,
            ...(staleError !== undefined ? { staleError } : {}),
            finishedAt: now,
            items: r.items.map(it => (it.state === 'queued' || it.state === 'running') ? { ...it, state: 'notStarted' } : it),
        }));
        const final = runRef.current as TrainRun;
        const summary = summarizeTrainRun(final);
        if (phase === 'stale') {
            staleRef.current = true;
            if (mountedRef.current) setStale(true);
        }
        if (mountedRef.current) setLastTrained({ ids: summary.trainedIds, finishedAt: now });
        settleWaiters(summary);
        latest.current.onFinished?.(final, summary);
    }, [update, settleWaiters]);

    const loop = useCallback(async (token: number) => {
        // Strictly one at a time: a call left over from a dropped run finishes first.
        if (inFlightRef.current) {
            await inFlightRef.current.catch(() => undefined);
            if (token !== tokenRef.current) return;
        }
        for (;;) {
            if (token !== tokenRef.current) return;
            const r = runRef.current;
            if (!r) return;
            const next = r.items.find(it => it.state === 'queued');
            if (!next) {
                finish(token, 'done');
                return;
            }
            if (r.stopRequested) {
                finish(token, 'stopped');
                return;
            }
            const clock = latest.current.now ?? Date.now;
            const startedAt = clock();
            update(x => ({
                ...x,
                currentId: next.id,
                items: x.items.map(it => it.id === next.id ? { ...it, state: 'running' } : it),
            }));
            let outcome: TrainOutcome;
            const call = (async () => latest.current.train(next.id))();
            inFlightRef.current = call;
            try {
                outcome = await call;
            } catch (e) {
                outcome = { ok: false, error: e instanceof Error ? e.message : String(e) };
            } finally {
                if (inFlightRef.current === call) inFlightRef.current = null;
            }
            if (token !== tokenRef.current) return; // reset / re-pointed / unmounted meanwhile
            const durationMs = Math.max(0, clock() - startedAt);

            if ('abandoned' in outcome) {
                // The window moved to another workspace mid-train: drop the run silently.
                reset();
                return;
            }
            if (!outcome.ok && 'error' in outcome && (outcome.stale || isStaleTrainError(outcome.error))) {
                const error = outcome.error;
                update(x => ({
                    ...x,
                    items: x.items.map(it => it.id === next.id ? { ...it, state: 'notStarted' } : it),
                }));
                finish(token, 'stale', error);
                return;
            }
            update(x => ({
                ...x,
                currentId: null,
                items: x.items.map(it => {
                    if (it.id !== next.id) return it;
                    if (outcome.ok) return { ...it, state: 'trained', durationMs };
                    if ('skip' in outcome) return { ...it, state: 'skipped', skip: { kind: 'missing', reason: outcome.skip, atTurn: true } };
                    return { ...it, state: 'failed', error: (outcome as { error: string }).error, durationMs };
                }),
            }));
            // A failed model never stops the queue. Give React one task to commit.
            await yieldToReact();
        }
    }, [finish, reset, update, yieldToReact]);

    const start = useCallback((candidates: readonly TrainCandidate[], opts: StartTrainRunOptions = {}): boolean => {
        if (runRef.current?.phase === 'running' || staleRef.current) return false;
        const items = planTrainRun(candidates, !!opts.includeUpToDate);
        if (!items.some(it => it.state === 'queued')) return false;
        const token = ++tokenRef.current;
        const runId = ++runIdRef.current;
        commit({
            runId,
            source: opts.source ?? 'sensor',
            phase: 'running',
            items,
            currentId: null,
            stopRequested: null,
            startedAt: (latest.current.now ?? Date.now)(),
        });
        if (mountedRef.current) setLastTrained(null);
        void loop(token);
        return true;
    }, [commit, loop]);

    const removeFromRun = useCallback((modelId: string): boolean => {
        const r = runRef.current;
        if (!r || r.phase !== 'running') return false;
        if (!r.items.some(it => it.id === modelId && it.state === 'queued')) return false;
        update(x => ({ ...x, items: x.items.map(it => it.id === modelId && it.state === 'queued' ? { ...it, state: 'removed' } : it) }));
        return true;
    }, [update]);

    const stopAfterCurrent = useCallback((reason: TrainStopReason = 'cancel') => {
        const r = runRef.current;
        if (!r || r.phase !== 'running') return;
        // 'close' wins over an earlier 'cancel' (the strip then says "Closing…").
        if (r.stopRequested === reason || r.stopRequested === 'close') return;
        update(x => ({ ...x, stopRequested: reason }));
    }, [update]);

    const whenIdle = useCallback((): Promise<TrainRunSummary | null> => {
        const r = runRef.current;
        if (!r || r.phase !== 'running') return Promise.resolve(r ? summarizeTrainRun(r) : null);
        return new Promise(resolve => { idleWaitersRef.current.push(resolve); });
    }, []);

    const dismiss = useCallback(() => {
        if (runRef.current?.phase === 'running') return;
        commit(null);
    }, [commit]);

    const summary = useMemo(() => (run ? summarizeTrainRun(run) : null), [run]);
    const timeLeftMs = useMemo(() => estimateTimeLeftMs(run), [run]);
    const byId = useMemo(() => new Map((run?.items ?? []).map(it => [it.id, it])), [run]);
    const isRunning = run?.phase === 'running';

    const itemOf = useCallback((id: string) => byId.get(id), [byId]);
    const isLocked = useCallback((id: string) => {
        if (!isRunning) return false;
        const st = byId.get(id)?.state;
        return st === 'queued' || st === 'running';
    }, [byId, isRunning]);
    const queuePositionOf = useCallback((id: string) => queuePosition(run, id), [run]);
    const isRunningNow = useCallback(() => runRef.current?.phase === 'running', []);

    return {
        run,
        summary,
        isRunning,
        isRunningNow,
        stale,
        canStart: !isRunning && !stale,
        timeLeftMs,
        lastTrained,
        start,
        removeFromRun,
        stopAfterCurrent,
        whenIdle,
        dismiss,
        reset,
        itemOf,
        isLocked,
        queuePositionOf,
    };
}
