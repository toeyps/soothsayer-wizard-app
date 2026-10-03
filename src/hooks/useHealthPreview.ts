import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { FailureModel, HealthSetPoints } from '../types';
import type { HealthErrorCode, HealthPreview } from '../types/health';
import { parseHealthError } from '../utils/completeModel';
import { buildHealthPreviewRequest, healthRequestKey } from '../utils/healthRequest';
import { isModelStale } from '../utils/modelStatus';
import type { RunningConditionFg } from '../utils/runningCondition';

/** Debounce (ms) before hitting the backend, so typing a set point does not
 *  fire a full pass per keystroke. */
const DEBOUNCE_MS = 250;

export interface UseHealthPreviewOptions {
    /** The model to preview — pass the DRAFT-merged model when the user has
     *  unsaved edits, exactly like Train. `null`/`undefined` = nothing to show. */
    model: FailureModel | null | undefined;
    /** Workspace slice (supplies the workspace running condition). */
    fg: RunningConditionFg;
    /** Dataset headers. */
    headers: string[] | null;
    /** The set points being edited (the DRAFT, not necessarily persisted). */
    setPoints?: HealthSetPoints | null;
    /** Off = no request (e.g. the Health score page is not open). Default true. */
    enabled?: boolean;
    /** Series cap (Rust default 4000); an expanded chart can ask for more. */
    maxPoints?: number;
    maxScatterPoints?: number;
    /** Relationship: predictor on the Fit scatter's X axis. */
    xPredictor?: string | null;
    /** Individual: also return the rows outside the scope (unscored gaps). */
    includeOutOfScope?: boolean;
    /** Rust session generation (`metadata.generation`) — stale windows get `STALE_SESSION`. */
    expectedGeneration?: number;
    /** Bump to force a refetch of an otherwise identical request (e.g. right
     *  after a Relationship re-train re-populated Rust's fit cache). */
    revision?: number;
    debounceMs?: number;
}

export interface UseHealthPreviewResult {
    /** The latest successful response for THIS model. Kept while the next one
     *  loads (charts never blank out) and while the hook is disabled (a stale
     *  model keeps its old charts, shown "Out of date"). `null` before the first
     *  success, for another model's data, and after an error. */
    data: HealthPreview | null;
    loading: boolean;
    /** Readable message of the last failure, or `null`. */
    error: string | null;
    /** Stable Rust code of the last failure (`NOT_FITTED`, `NO_DATA`, ...), or `null`. */
    errorCode: HealthErrorCode | null;
    /** The Relationship fit is gone from Rust's memory — show "Re-train to recompute". */
    notFitted: boolean;
    /** Same as `notFitted`; the name the train flow uses. */
    needsRetrain: boolean;
    /** Why no request is being made (`null` while active). `'stale'` = the model
     *  was trained but its inputs changed since; `'inputs'` = a required sensor
     *  is missing; `'disabled'` = `enabled` is false / no model. */
    idle: 'stale' | 'inputs' | 'disabled' | null;
    /** The last SUCCESSFUL response for THIS model, kept even after a later
     *  request failed (`data` is `null` then, because it no longer matches the
     *  request that failed). The Health score page draws its page and inputs
     *  from it while an error banner shows, so a one-off failure never makes
     *  the page disappear. `null` before the first success and for another model.
     *  (Optional in the type only so hand-built fixtures need not spell it; the
     *  hook always returns it.) */
    lastData?: HealthPreview | null;
    /** Ask again for the same request (the error banner's Retry button). */
    retry?: () => void;
}

interface State {
    modelId: string | null;
    data: HealthPreview | null;
    lastData: HealthPreview | null;
    loading: boolean;
    error: string | null;
    errorCode: HealthErrorCode | null;
}

const EMPTY: State = { modelId: null, data: null, lastData: null, loading: false, error: null, errorCode: null };

/**
 * `compute_health_preview` for one model: the bounded series / stats / score /
 * validation the Build Model "Model fit" and "Health score" pages draw.
 *
 * - Requests are built by `buildHealthPreviewRequest` (same training scope as
 *   Train) and keyed by their JSON, so the effect only re-runs when the request
 *   itself changes — an unrelated field changing on the model (name, notes,
 *   category, status ...) never refetches.
 * - Debounced and sequence-guarded: a late response of an older request can
 *   never overwrite a newer one (same pattern as `useChartData`).
 * - No request is made for a stale model (trained, inputs changed since), a
 *   model missing a required sensor, or when `enabled` is false.
 * - A failure resolves to `error` + `errorCode`; `NOT_FITTED` (Relationship fit
 *   no longer in memory) additionally sets `notFitted` / `needsRetrain`.
 */
export function useHealthPreview(opts: UseHealthPreviewOptions): UseHealthPreviewResult {
    const { model, fg, headers, enabled = true } = opts;
    const [state, setState] = useState<State>(EMPTY);
    const seqRef = useRef(0);
    // Bumped by `retry`: part of the effect's key, never sent.
    const [retryTick, setRetryTick] = useState(0);
    const retry = useCallback(() => setRetryTick(n => n + 1), []);

    let idle: UseHealthPreviewResult['idle'] = null;
    let request = null as ReturnType<typeof buildHealthPreviewRequest>;
    if (!model || !enabled) {
        idle = 'disabled';
    } else if (isModelStale(model, fg)) {
        idle = 'stale';
    } else {
        request = buildHealthPreviewRequest({
            model,
            fg,
            headers,
            setPoints: opts.setPoints,
            maxPoints: opts.maxPoints,
            maxScatterPoints: opts.maxScatterPoints,
            xPredictor: opts.xPredictor,
            includeOutOfScope: opts.includeOutOfScope,
            expectedGeneration: opts.expectedGeneration,
        });
        if (!request) idle = 'inputs';
    }

    // The request, serialised: the effect's only trigger (callers pass freshly
    // built objects every render). `revision` is part of the key but never sent.
    const requestKey = healthRequestKey(request);
    const key = requestKey === null ? null : `${model?.id}|${opts.revision ?? 0}|${retryTick}|${requestKey}`;
    const requestRef = useRef(request);
    requestRef.current = request;
    const modelId = model?.id ?? null;
    const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;

    useEffect(() => {
        const req = requestRef.current;
        if (key === null || !req) {
            // Idle: drop any in-flight response, keep the last data on screen.
            seqRef.current++;
            setState(s => (s.loading ? { ...s, loading: false } : s));
            return;
        }
        const mySeq = ++seqRef.current;
        setState(s => ({
            modelId,
            // Another model's data must never be shown for this one.
            data: s.modelId === modelId ? s.data : null,
            lastData: s.modelId === modelId ? s.lastData : null,
            loading: true,
            error: null,
            errorCode: null,
        }));
        const timer = setTimeout(() => {
            invoke<HealthPreview>('compute_health_preview', { request: req })
                .then(data => {
                    if (seqRef.current !== mySeq) return; // superseded
                    setState({ modelId, data, lastData: data, loading: false, error: null, errorCode: null });
                })
                .catch(err => {
                    if (seqRef.current !== mySeq) return;
                    const { code, message } = parseHealthError(err);
                    // The old data no longer matches the request that failed (`data` is
                    // null), but the last good answer stays available as `lastData`.
                    setState(s => ({ modelId, data: null, lastData: s.modelId === modelId ? s.lastData : null, loading: false, error: message, errorCode: code }));
                });
        }, debounceMs);
        return () => {
            clearTimeout(timer);
            // Invalidate the in-flight request so its late resolve is ignored.
            // This ref is a monotonic race-guard counter, not a DOM node — the
            // cleanup must see its live value.
            // eslint-disable-next-line react-hooks/exhaustive-deps
            seqRef.current++;
        };
        // `key` carries everything that matters; see above.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);

    const mine = state.modelId === modelId;
    const errorCode = mine ? state.errorCode : null;
    return {
        data: mine ? state.data : null,
        // `loading` also covers the debounce window of a request not yet sent.
        loading: key !== null && (mine ? state.loading : true),
        error: mine ? state.error : null,
        errorCode,
        notFitted: errorCode === 'NOT_FITTED',
        needsRetrain: errorCode === 'NOT_FITTED',
        idle,
        lastData: mine ? state.lastData : null,
        retry,
    };
}
