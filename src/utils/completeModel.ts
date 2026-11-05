import { invoke } from '@tauri-apps/api/core';
import type { HealthSetPoints } from '../types';
import type { HealthErrorCode, HealthIssue, HealthPreview } from '../types/health';
import { buildHealthPreviewRequest, type HealthRequestOptions } from './healthRequest';
import { markCompleteBlockReason } from './runningCondition';

/** Mark-complete check and the shared Rust error parser; no workspace writes, no files. On `ok: true` the caller persists via `persistModelComplete`. */

const ERROR_CODES: readonly HealthErrorCode[] = ['NOT_FITTED', 'NO_DATA', 'BAD_REQUEST', 'STALE_SESSION', 'VALIDATION', 'SIDECAR_OUTDATED'];

/** User-facing text for codes whose wording the UI owns (the Rust text after the
 *  prefix is used for every other code). */
export const HEALTH_ERROR_TEXT: Partial<Record<HealthErrorCode, string>> = {
    // Rust's text says 'train it first', but nothing needs re-training: the same fit is loaded back.
    NOT_FITTED: 'Fit no longer in memory — load it again.',
    SIDECAR_OUTDATED: 'The Relation model engine in this build is out of date — reinstall or update the app, then try again.',
};

/** Splits a Rust error (`"CODE: message"`) into its stable code and message; `code` is `null` without a known prefix. */
export function parseHealthError(err: unknown): { code: HealthErrorCode | null; message: string } {
    const text = err instanceof Error ? err.message : String(err ?? '');
    const m = /^([A-Z_]+):\s*([\s\S]*)$/.exec(text);
    if (m && (ERROR_CODES as readonly string[]).includes(m[1])) {
        const code = m[1] as HealthErrorCode;
        return { code, message: HEALTH_ERROR_TEXT[code] ?? (m[2] || text) };
    }
    return { code: null, message: text };
}

/** Outcome of `checkModelForComplete`. */
export type CheckModelResult =
    | {
        ok: true;
        /** The set points that were validated — persist THESE. */
        setPoints: HealthSetPoints;
        /** Sampling interval in seconds of the validating preview (`3600` = 1-hour averages); absent if unusable. */
        scoringIntervalSecs?: number;
    }
    | {
        ok: false;
        /** `'validation'`: set points rejected (see `issues`); `'error'`: hard failure, `code` set for a known Rust prefix; `'inputs'`: no valid scoring period, or a required sensor is missing. */
        reason: 'validation' | 'error' | 'inputs';
        issues: HealthIssue[];
        code: HealthErrorCode | null;
        error: string | null;
    };

/** The failure half of `CheckModelResult`. */
export type CheckModelFailure = Extract<CheckModelResult, { ok: false }>;

const fail = (
    reason: CheckModelFailure['reason'],
    over: Partial<{ issues: HealthIssue[]; code: HealthErrorCode | null; error: string | null }> = {},
): CheckModelFailure => ({ ok: false, reason, issues: [], code: null, error: null, ...over });

/** Validates the set points for Mark complete: a valid scoring period, then `compute_health_preview`. Never throws, writes no files. The model must be the DRAFT-merged, currently-trained one. */
export async function checkModelForComplete(opts: HealthRequestOptions & { setPoints: HealthSetPoints }): Promise<CheckModelResult> {
    const noTest = markCompleteBlockReason(opts.model, opts.fg);
    if (noTest !== null) return fail('inputs', { error: noTest });
    // Validation only needs the statistics + issues; keep the series tiny.
    const previewReq = buildHealthPreviewRequest({ ...opts, maxPoints: 8, maxScatterPoints: 1 });
    if (!previewReq) return fail('inputs', { error: 'A required sensor is missing for this model.' });
    let preview: HealthPreview;
    try {
        preview = await invoke<HealthPreview>('compute_health_preview', { request: previewReq });
    } catch (e) {
        const { code, message } = parseHealthError(e);
        return fail('error', { code, error: message });
    }
    if (!preview.valid) return fail('validation', { issues: preview.validation });
    const interval = scoringIntervalOf(preview);
    return { ok: true, setPoints: opts.setPoints, ...(interval !== undefined ? { scoringIntervalSecs: interval } : {}) };
}

/** The preview's `scoring_interval_secs` when it is a usable number (finite,
 *  above 0), otherwise `undefined`. */
function scoringIntervalOf(preview: Pick<HealthPreview, 'scoring_interval_secs'>): number | undefined {
    const v: unknown = preview.scoring_interval_secs;
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}
