import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { RelationshipPreviewResult } from '../../types/commands';
import { debugLog } from '../../utils/debugLog';
import { HEALTH_DEFAULT_MAX_POINTS } from '../../utils/healthRequest';

/*
 * Sub-model fits for a Relationship model ("Compare predictors" / "Sub-models").
 *
 * Extracted from the (since deleted) PredictiveModelBuild.tsx page in health
 * score phase 3b-1, 2026-10-04; the Build Model Workbench's Model fit page is
 * now its only caller. Behaviour is the old page's own, unchanged:
 *
 *   predictors = [p1, p2, p3] -> three SEQUENTIAL `preview_relationship_model`
 *   calls for the cumulative subsets [p1], [p1,p2], [p1,p2,p3]. Each full
 *   payload is kept so the modal can draw a per-step scatter beside the step's
 *   R^2 / 2*RMSE. Sequential on purpose: the sidecar is a single-process pool,
 *   so parallel calls would only queue, and serial gives cheap progress.
 *
 * These calls pass NO `cache_key`, so they never touch the Rust fit cache the
 * health score reads (only the main Train fit is cached). They DO pass
 * `max_points`: each response carries only a bounded sample of rows for the
 * scatter, and the true row count in `n_rows` (the "N" on each card). The reused
 * Train response (`reusable`) is bounded the same way.
 *
 * Lives next to the components (like `useRowCountPreview.ts`), not in
 * `src/hooks/`: it is presentation plumbing for this one modal.
 */

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
    /** The fit of the FULL predictor list when the caller already has an
     *  up-to-date one: the last step reuses it instead of fitting twice. Pass
     *  `null` when there is none or it is out of date. */
    reusable: RelationshipPreviewResult | null;
    /** Anything that makes every cached sub-fit moot when it changes (target,
     *  stiffness, training scope). A predictor-list change is NOT part of it:
     *  that is surfaced as `stale` instead, so the user chooses when to pay for
     *  the extra sidecar calls. */
    resetKey: string;
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
    const { targetSensor, predictors, lambda, filter, blocked = false, reusable, resetKey } = opts;
    const [subModels, setSubModels] = useState<SubModelFit[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [progress, setProgress] = useState({ current: 0, total: 0 });
    // Generation counter: each `run` claims one and only commits while it is
    // still current, so a late-finishing older call can never overwrite a
    // newer one (two overlapping runs are possible when a background run is
    // still going and the user re-clicks during it).
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
                const subset = subsetPredictors.slice(0, i);
                if (i === total && reusable) {
                    // The full-predictor fit already exists — reuse it verbatim so
                    // the last card matches the main chart.
                    results.push({ predictors: subset, result: reusable });
                    setProgress({ current: i, total });
                    continue;
                }
                const r = await invoke<RelationshipPreviewResult>('preview_relationship_model', {
                    predictors: subset,
                    target: targetSensor,
                    lambda,
                    filter,
                    // Bounded response: an aligned strided sample (extremes kept) of
                    // at most this many rows + the real count in `n_rows` — never
                    // every row of a 150k-row dataset.
                    max_points: HEALTH_DEFAULT_MAX_POINTS,
                });
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
                setError(e instanceof Error ? e.message : String(e));
                console.error('runSubModelFits failed:', e);
            }
        } finally {
            // Only the latest run flips `loading` off — an older call's finally
            // would otherwise clear a still-running newer call's flag.
            if (myGen === genRef.current) setLoading(false);
        }
    }, [targetSensor, predictors, lambda, filter, blocked, reusable]);

    return { subModels, loading, error, progress, stale, run };
}
