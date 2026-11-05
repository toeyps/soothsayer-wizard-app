import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { RelationshipPreviewResult } from '../../types/commands';
import { debugLog } from '../../utils/debugLog';
import { TRAIN_STALE_MESSAGE } from '../../utils/trainQueue';
import { HEALTH_DEFAULT_MAX_POINTS } from '../../utils/healthRequest';

/* Sub-model fits for Relationship 'Compare predictors': SEQUENTIAL `preview_relationship_model` calls on cumulative predictor subsets (the sidecar is single-process). No `cache_key`, so the Rust fit cache the health score reads is untouched; `max_points` bounds each response. */

/** Runs engine calls one at a time, in the order asked. */
export type EngineQueue = <T>(fn: () => Promise<T>) => Promise<T>;

export function createEngineQueue(): EngineQueue {
    let tail: Promise<unknown> = Promise.resolve();
    return <T,>(fn: () => Promise<T>): Promise<T> => {
        const run = tail.then(fn);
        tail = run.catch(() => undefined);
        return run;
    };
}

export interface SubModelFit {
    /** Cumulative predictor subset (length 1..N). */
    predictors: string[];
    /** Sidecar response for THIS subset. */
    result: RelationshipPreviewResult;
}

export interface SubModelFitsOptions {
    targetSensor: string;
    /** The model's full predictor list, in fit order. */
    predictors: string[];
    /** LinearGAM `lambda` (the model's stiffness). */
    lambda: number;
    /** The training-scope `filter` argument (`null` = no filter). */
    filter: unknown;
    /** The scope is unusable (invalid period, missing condition...) — never fit. */
    blocked?: boolean;
    /** Fit of the FULL predictor list when up to date, reused for the last step; null if none or out of date. */
    reusable: RelationshipPreviewResult | null;
    /** Anything that makes every cached sub-fit moot (target, stiffness, training scope); a predictor-list change shows as `stale` instead. */
    resetKey: string;
    /** The caller's engine queue, so these calls also wait for its other engine calls. */
    serialize?: EngineQueue;
}

export interface SubModelFitsState {
    subModels: SubModelFit[] | null;
    loading: boolean;
    error: string | null;
    progress: { current: number; total: number };
    /** The cached fits no longer line up with the current predictor list. */
    stale: boolean;
    /** Fit every cumulative step now (resolves when done; never throws). */
    run: () => Promise<void>;
}

export function useSubModelFits(opts: SubModelFitsOptions): SubModelFitsState {
    const { targetSensor, predictors, lambda, filter, blocked = false, reusable, resetKey, serialize } = opts;
    const [ownQueue] = useState(createEngineQueue);
    const enqueue = serialize ?? ownQueue;
    const [subModels, setSubModels] = useState<SubModelFit[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [progress, setProgress] = useState({ current: 0, total: 0 });
    // Generation counter: only the latest run commits, and an older run stops asking the engine.
    const genRef = useRef(0);

    const stale = useMemo(() => {
        if (!subModels) return false;
        if (subModels.length !== predictors.length) return true;
        const last = subModels[subModels.length - 1].predictors;
        if (last.length !== predictors.length) return true;
        for (let i = 0; i < last.length; i++) if (last[i] !== predictors[i]) return true;
        return false;
    }, [subModels, predictors]);

    // Same cache-invalidation contract as the main fit: a different (target,
    // lambda, scope) triple makes prior sub-fits moot.
    useEffect(() => {
        genRef.current++; // drop any run still in flight for the old triple
        setSubModels(null);
        setError(null);
        setLoading(false);
    }, [resetKey]);

    const run = useCallback(async () => {
        if (!targetSensor || predictors.length === 0 || blocked) return;
        const subsetPredictors = [...predictors];
        const total = subsetPredictors.length;
        const myGen = ++genRef.current;
        setLoading(true);
        setError(null);
        setProgress({ current: 0, total });
        const results: SubModelFit[] = [];
        try {
            for (let i = 1; i <= total; i++) {
                if (myGen !== genRef.current) return;
                const subset = subsetPredictors.slice(0, i);
                if (i === total && reusable) {
                    // The full-predictor fit already exists — reuse it verbatim so
                    // the last card matches the main chart.
                    results.push({ predictors: subset, result: reusable });
                    setProgress({ current: i, total });
                    continue;
                }
                const r = await enqueue(async () => (myGen !== genRef.current ? null : invoke<RelationshipPreviewResult>('preview_relationship_model', {
                    predictors: subset,
                    target: targetSensor,
                    lambda,
                    filter,
                    // Bounded response: a strided sample (extremes kept) of at most this many rows, real count in `n_rows`.
                    max_points: HEALTH_DEFAULT_MAX_POINTS,
                })));
                if (!r) return;
                if (r.error) throw new Error(r.error);
                results.push({ predictors: subset, result: r });
                setProgress({ current: i, total });
            }
            if (myGen === genRef.current) {
                setSubModels(results);
                debugLog('Sub-model fits complete:', results.map(r => ({
                    predictors: r.predictors,
                    rows: r.result.n_rows,
                    r2: r.result.r2_per_step[r.result.r2_per_step.length - 1],
                })));
            } else {
                debugLog(`[sub-models] Discarding stale result (gen ${myGen} vs current ${genRef.current})`);
            }
        } catch (e) {
            if (myGen === genRef.current) {
                const text = e instanceof Error ? e.message : String(e);
                setError(text.startsWith('STALE_SESSION') ? TRAIN_STALE_MESSAGE : text);
                console.error('runSubModelFits failed:', e);
            }
        } finally {
            // Only the latest run flips `loading` off — an older call's finally
            // would otherwise clear a still-running newer call's flag.
            if (myGen === genRef.current) setLoading(false);
        }
    }, [targetSensor, predictors, lambda, filter, blocked, reusable, enqueue]);

    return { subModels, loading, error, progress, stale, run };
}
