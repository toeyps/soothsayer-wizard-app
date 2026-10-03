import { invoke } from '@tauri-apps/api/core';
import type { HealthSetPoints } from '../types';
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

/**
 * "Mark complete" orchestration for the health-score flow (phase 3a, 2026-10-03).
 * Pure async (no React, no workspace writes): check the set points, write the
 * model's files, and tell the caller what to persist.
 *
 *   1. `compute_health_preview` with the set points the user typed — if the
 *      preview is not valid, STOP: return the issues, export nothing.
 *   2. `export_model_files` (re-validates against freshly computed statistics
 *      and writes all-or-nothing into the app-managed output folder).
 *   3. `ok: true` -> the caller persists `status: true` + the validated set
 *      points (`persistModelComplete` in `healthPersist.ts` does exactly that
 *      against what is on disk). Anything else leaves the model Incomplete.
 */

const ERROR_CODES: readonly HealthErrorCode[] = ['NOT_FITTED', 'NO_DATA', 'BAD_REQUEST', 'STALE_SESSION', 'VALIDATION'];

/** Split a Rust error (`"CODE: message"`, rejected as a plain string) into its
 *  stable code and the readable rest. `code` is `null` for an error with no
 *  known prefix (sidecar crash, disk error, ...). */
export function parseHealthError(err: unknown): { code: HealthErrorCode | null; message: string } {
    const text = err instanceof Error ? err.message : String(err ?? '');
    const m = /^([A-Z_]+):\s*([\s\S]*)$/.exec(text);
    if (m && (ERROR_CODES as readonly string[]).includes(m[1])) {
        return { code: m[1] as HealthErrorCode, message: m[2] || text };
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
    return {
        ok: true,
        setPoints: opts.setPoints,
        files: result.files,
        outputDir: result.output_dir,
        warnings: result.warnings,
    };
}

/** `{app_data}/workspaces/{workspaceId}/output` — the folder Mark complete
 *  writes into (created if missing, so the UI can reveal it right away). */
export function getModelOutputDir(workspaceId: string): Promise<string> {
    // snake_case key: this command carries `rename_all = "snake_case"`.
    return invoke<string>('get_model_output_dir', { workspace_id: workspaceId });
}
