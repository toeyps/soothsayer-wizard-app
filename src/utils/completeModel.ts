import { invoke } from '@tauri-apps/api/core';
import type { HealthExportRecord, HealthSetPoints } from '../types';
import type {
    HealthErrorCode,
    HealthIssue,
    HealthPreview,
    HealthPreviewRequest,
    ModelFilesRequest,
    ModelFilesResult,
    WrittenFile,
} from '../types/health';
import { buildHealthPreviewRequest, buildModelFilesRequest, type HealthRequestOptions } from './healthRequest';
import { markCompleteBlockReason } from './runningCondition';

/**
 * "Mark complete" orchestration for the health-score flow.
 * Pure async (no React, no workspace writes): check the set points, write the
 * model's files, and tell the caller what to persist.
 *
 *   0. At least one valid scoring period (`markCompleteBlockReason`), else `inputs`.
 *   1. `compute_health_preview` with the set points the user typed — if the
 *      preview is not valid, STOP: return the issues, export nothing.
 *   2. `export_model_files` (re-validates against freshly computed statistics
 *      and writes all-or-nothing into the app-managed output folder).
 *   3. `ok: true` -> the caller persists `status: true` + the validated set
 *      points (`persistModelComplete` in `healthPersist.ts` does exactly that
 *      against what is on disk). Anything else leaves the model Incomplete.
 *      The export record it stores comes from `healthExportRecord(result)`,
 *      which carries the scoring interval the validating preview reported
 *      (`scoring_interval_secs`, 3600 = 1-hour averages).
 */

const ERROR_CODES: readonly HealthErrorCode[] = ['NOT_FITTED', 'NO_DATA', 'BAD_REQUEST', 'STALE_SESSION', 'VALIDATION', 'SIDECAR_OUTDATED'];

/** User-facing text for codes whose wording the UI owns (the Rust text after the
 *  prefix is used for every other code). */
export const HEALTH_ERROR_TEXT: Partial<Record<HealthErrorCode, string>> = {
    // Rust's own text says "this Relation model … train it first". The Workbench's
    // words for a fit Rust no longer holds are "Fit no longer in memory · load it again":
    // nothing has to be trained again, the same fit is loaded back.
    NOT_FITTED: 'Fit no longer in memory — load it again.',
    SIDECAR_OUTDATED: 'The Relation model engine in this build is out of date — reinstall or update the app, then try again.',
};

/** Split a Rust error (`"CODE: message"`, rejected as a plain string) into its
 *  stable code and the readable rest. `code` is `null` for an error with no
 *  known prefix (sidecar crash, disk error, ...). */
export function parseHealthError(err: unknown): { code: HealthErrorCode | null; message: string } {
    const text = err instanceof Error ? err.message : String(err ?? '');
    const m = /^([A-Z_]+):\s*([\s\S]*)$/.exec(text);
    if (m && (ERROR_CODES as readonly string[]).includes(m[1])) {
        const code = m[1] as HealthErrorCode;
        return { code, message: HEALTH_ERROR_TEXT[code] ?? (m[2] || text) };
    }
    return { code: null, message: text };
}

/** Outcome of `completeModel`. */
export type CompleteModelResult =
    | {
        ok: true;
        /** The set points that were validated and exported — persist THESE. */
        setPoints: HealthSetPoints;
        files: WrittenFile[];
        outputDir: string;
        warnings: string[];
        /** The health score's sampling interval (seconds) of the preview that
         *  validated these set points — `3600` = 1-hour averages of the running
         *  rows. Store it as `healthExport.scoringIntervalSecs`
         *  (`healthExportRecord` builds the record). Absent only when Rust did
         *  not report a usable one (never from this build's backend): the
         *  record is then written without it, never with a guessed number. */
        scoringIntervalSecs?: number;
    }
    | {
        ok: false;
        /** `'validation'`: the set points are not acceptable (`issues` says why,
         *  nothing was written). `'error'`: a hard failure (not fitted, no data,
         *  sidecar, disk) — `code` is set when Rust gave a known prefix. */
        reason: 'validation' | 'error' | 'inputs';
        issues: HealthIssue[];
        code: HealthErrorCode | null;
        error: string | null;
    };

const fail = (
    reason: 'validation' | 'error' | 'inputs',
    over: Partial<{ issues: HealthIssue[]; code: HealthErrorCode | null; error: string | null }> = {},
): CompleteModelResult => ({ ok: false, reason, issues: [], code: null, error: null, ...over });

export interface CompleteModelOptions extends HealthRequestOptions {
    workspaceId: string;
    /** The set points to validate and export (the user's draft). Required here
     *  — "Mark complete" with nothing entered is refused as `required` issues. */
    setPoints: HealthSetPoints;
}

/**
 * Validate, then export. Never throws: every failure is a typed result.
 * The model passed in must be the DRAFT-merged, currently-trained one (the
 * Workbench only enables Mark complete for a fresh-trained model).
 */
export async function completeModel(opts: CompleteModelOptions): Promise<CompleteModelResult> {
    // No export without a valid scoring period — the files' `validation` block
    // always describes at least one scored period.
    const noTest = markCompleteBlockReason(opts.model, opts.fg);
    if (noTest !== null) return fail('inputs', { error: noTest });
    const previewReq: HealthPreviewRequest | null = buildHealthPreviewRequest({
        ...opts,
        // Validation only needs the statistics + issues; keep the series tiny.
        maxPoints: 8,
        maxScatterPoints: 1,
    });
    const filesReq: ModelFilesRequest | null = buildModelFilesRequest(opts);
    if (!previewReq || !filesReq) {
        return fail('inputs', { error: 'A required sensor is missing for this model.' });
    }

    let preview: HealthPreview;
    try {
        preview = await invoke<HealthPreview>('compute_health_preview', { request: previewReq });
    } catch (e) {
        const { code, message } = parseHealthError(e);
        return fail('error', { code, error: message });
    }
    if (!preview.valid) {
        return fail('validation', { issues: preview.validation });
    }

    let result: ModelFilesResult;
    try {
        result = await invoke<ModelFilesResult>('export_model_files', { request: filesReq });
    } catch (e) {
        const { code, message } = parseHealthError(e);
        return fail('error', { code, error: message });
    }
    if (!result.ok) {
        // Rust re-validated against statistics computed in the export call and
        // refused; nothing was written.
        return fail('validation', { issues: result.validation });
    }
    const interval = scoringIntervalOf(preview);
    return {
        ok: true,
        setPoints: opts.setPoints,
        files: result.files,
        outputDir: result.output_dir,
        warnings: result.warnings,
        ...(interval !== undefined ? { scoringIntervalSecs: interval } : {}),
    };
}

/** The preview's `scoring_interval_secs` when it is a usable number (finite,
 *  above 0), otherwise `undefined`. */
function scoringIntervalOf(preview: Pick<HealthPreview, 'scoring_interval_secs'>): number | undefined {
    const v: unknown = preview.scoring_interval_secs;
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

/**
 * The `FailureModel.healthExport` record of a successful `completeModel` run —
 * when, where, with which set points and with which scoring interval the files
 * were written. THE one place that record is built: pass the result straight to
 * `persistModelComplete(…, record, race)`. A hand-built `{ at, outputDir,
 * setPoints }` would drop `scoringIntervalSecs`, and the model would then read
 * as "saved with the earlier scoring" for ever (`savedResultsUseEarlierScoring`).
 * `at` defaults to now (ISO).
 */
export function healthExportRecord(
    res: Extract<CompleteModelResult, { ok: true }>,
    at: string = new Date().toISOString(),
): HealthExportRecord {
    return {
        at,
        outputDir: res.outputDir,
        setPoints: res.setPoints,
        ...(res.scoringIntervalSecs !== undefined ? { scoringIntervalSecs: res.scoringIntervalSecs } : {}),
    };
}

/** `{app_data}/workspaces/{workspaceId}/output` — the folder Mark complete
 *  writes into (created if missing, so the UI can reveal it right away). */
export function getModelOutputDir(workspaceId: string): Promise<string> {
    // snake_case key: this command carries `rename_all = "snake_case"`.
    return invoke<string>('get_model_output_dir', { workspace_id: workspaceId });
}
