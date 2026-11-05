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
    /** The model to preview; pass the draft-merged model when there are unsaved edits, as Train does. */
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
    /** Bump to refetch an otherwise identical request (e.g. after a Relationship re-train). */
    revision?: number;
    debounceMs?: number;
    /** Counts the requests Rust is working on, superseded ones too: they still hold the engine. */
    inFlightRef?: { current: number };
}

export interface UseHealthPreviewResult {
    /** Latest successful response for this model, kept while the next loads or while disabled; null before first success, for another model, and after an error. */
    data: HealthPreview | null;
    loading: boolean;
    /** Readable message of the last failure, or `null`. */
    error: string | null;
    /** Stable Rust code of the last failure (`NOT_FITTED`, `NO_DATA`, ...), or `null`. */
    errorCode: HealthErrorCode | null;
    /** Relation-model fit gone from Rust memory: pages show the 'Fit no longer in memory' board. */
    notFitted: boolean;
    /** Same as `notFitted`; the name the train flow uses. */
    needsRetrain: boolean;
    /** Why no request is made: 'stale' (inputs changed since training), 'inputs' (required sensor missing), 'disabled'; null while active. */
    idle: 'stale' | 'inputs' | 'disabled' | null;
    /** Last successful response for this model, kept after a later failure so the page doesn't vanish under an error banner. */
    lastData?: HealthPreview | null;
    /** Ask again for the same request (the error banner's Retry button). */
    retry?: () => void;
    /** Re-ask and clear Rust's remembered scoring failure; sent as `retry_test_scoring` on ONE request. */
    retryTestScoring?: () => void;
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

/** `compute_health_preview` for one model with the same training scope as Train. Keyed by request JSON, debounced and sequence-guarded; no request for stale, input-missing or disabled models. */
export function useHealthPreview(opts: UseHealthPreviewOptions): UseHealthPreviewResult {
    const { model, fg, headers, enabled = true } = opts;
    const [state, setState] = useState<State>(EMPTY);
    const seqRef = useRef(0);
    // Bumped by `retry`: part of the effect's key, never sent.
    const [retryTick, setRetryTick] = useState(0);
    const retry = useCallback(() => setRetryTick(n => n + 1), []);
    // Which request the user asked to retry (model id + fit cache key); sent once and only for that same model and fit.
    const retryScoringRef = useRef<{ modelId: string | null; cacheKey: string | null } | null>(null);
    // Live mirrors for the stable `retryTestScoring` callback (assigned below).
    const keyRef = useRef<string | null>(null);
    const modelIdRef = useRef<string | null>(null);

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

    // The serialised request is the effect's only trigger; `revision` is in the key but never sent.
    const requestKey = healthRequestKey(request);
    const key = requestKey === null ? null : `${model?.id}|${opts.revision ?? 0}|${retryTick}|${requestKey}`;
    const requestRef = useRef(request);
    requestRef.current = request;
    const modelId = model?.id ?? null;
    keyRef.current = key;
    modelIdRef.current = modelId;
    const retryTestScoring = useCallback(() => {
        // Idle (nothing would be sent): leave no pending retry for the next request.
        if (keyRef.current === null) return;
        retryScoringRef.current = { modelId: modelIdRef.current, cacheKey: requestRef.current?.cache_key ?? null };
        setRetryTick(n => n + 1);
    }, []);
    const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;

    useEffect(() => {
        const req = requestRef.current;
        if (key === null || !req) {
            // Idle: drop the in-flight response, keep the last data on screen, forget a pending scoring retry.
            retryScoringRef.current = null;
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
            const pending = retryScoringRef.current;
            retryScoringRef.current = null;
            const retryScoring = !!pending && pending.modelId === modelId && pending.cacheKey === (req.cache_key ?? null);
            const sent = retryScoring ? { ...req, retry_test_scoring: true } : req;
            const inFlight = opts.inFlightRef;
            if (inFlight) inFlight.current++;
            invoke<HealthPreview>('compute_health_preview', { request: sent })
                .finally(() => { if (inFlight) inFlight.current--; })
                .then(data => {
                    if (seqRef.current !== mySeq) return; // superseded
                    setState({ modelId, data, lastData: data, loading: false, error: null, errorCode: null });
                })
                .catch(err => {
                    if (seqRef.current !== mySeq) return;
                    const { code, message } = parseHealthError(err);
                    // `data` no longer matches the failed request, but the last good answer stays in `lastData`.
                    setState(s => ({ modelId, data: null, lastData: s.modelId === modelId ? s.lastData : null, loading: false, error: message, errorCode: code }));
                });
        }, debounceMs);
        return () => {
            clearTimeout(timer);
            // Invalidate the in-flight request so its late resolve is ignored; the ref is a counter, so cleanup must read its live value.
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
        retryTestScoring,
    };
}
