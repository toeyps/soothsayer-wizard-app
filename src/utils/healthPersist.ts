import { emit } from '@tauri-apps/api/event';
import type { FailureModel, HealthExportRecord, HealthSetPoints, WorkspaceState } from '../types';
import { updateWorkspaceData } from '../workspaceManager';
import { withFailureGroupState } from './failureGroupState';
import { patchModelHealthSetPoints } from './healthSetPoints';
import { NOT_TRAINED_BLOCK_REASON } from './modelStatus';
import { getBuildBlockReason } from './runningCondition';
import { isModelTrainedFresh } from './trainFingerprint';

/**
 * The two writes of the health-score flow (phase 3a, 2026-10-03). Both go
 * through `updateWorkspaceData` (read-modify-write against what is ON DISK, so
 * a stale in-memory mirror can never revert another window's change) and
 * `withFailureGroupState` (never a hand-built slice), and both broadcast
 * `failure-group-state-changed` — carrying the WHOLE slice, with `workspaceId`
 * and `origin` — so the Dashboard's Failure Groups dots update.
 *
 * The caller (a window) applies the returned state to its own copy; the
 * broadcast is skipped by receivers that sent it (`origin`).
 */

export type FailureGroupOrigin = 'dashboard' | 'build-model' | 'predictive-model';

async function broadcast(state: WorkspaceState | null, workspaceId: string, origin: FailureGroupOrigin): Promise<void> {
    if (!state?.failureGroupState) return;
    await emit('failure-group-state-changed', { ...state.failureGroupState, workspaceId, origin });
}

/**
 * Save the set points the user typed onto the model — on every explicit Save /
 * blur. Changes `healthSetPoints` ONLY: not `status`, not `lastTrainedAt` /
 * `trainedFingerprint`, and (since set points are not part of the train
 * fingerprint) it never makes a model stale. Returns the new workspace state,
 * or `null` when the workspace could not be read.
 */
export async function commitSetPoints(
    workspaceId: string,
    modelId: string,
    setPoints: HealthSetPoints,
    origin: FailureGroupOrigin = 'build-model',
): Promise<WorkspaceState | null> {
    const next = await updateWorkspaceData(workspaceId, prev =>
        withFailureGroupState(prev, {
            models: patchModelHealthSetPoints(prev.failureGroupState?.models ?? [], modelId, setPoints),
        }),
    );
    await broadcast(next, workspaceId, origin);
    return next;
}

/** Outcome of `persistModelComplete`. */
export interface PersistCompleteResult {
    /** The state after the write (`null` when the workspace could not be read). */
    next: WorkspaceState | null;
    /** `null` = the model is now Complete. Otherwise why it was NOT marked
     *  (the gate's reason, or `NOT_TRAINED_BLOCK_REASON`); nothing changed. */
    reason: string | null;
}

/**
 * Mark a model Complete and store the validated set points, in ONE write — call
 * it only after `completeModel` returned `ok: true`. The gate and the
 * "Trained and still fresh" requirement are re-checked against the model as it
 * is on disk INSIDE the write (the user may have changed something in another
 * window since): a model that is no longer fresh stays Incomplete and `reason`
 * says why — its files were written, but it is not reported complete.
 */
export async function persistModelComplete(
    workspaceId: string,
    modelId: string,
    setPoints: HealthSetPoints,
    headers: string[] | null,
    origin: FailureGroupOrigin = 'build-model',
    exportRecord?: HealthExportRecord,
): Promise<PersistCompleteResult> {
    const res: { reason: string | null } = { reason: null };
    const next = await updateWorkspaceData(workspaceId, prev => {
        const fg = prev.failureGroupState;
        const target: FailureModel | undefined = fg?.models?.find(m => m.id === modelId);
        if (!target) {
            res.reason = 'This model no longer exists.';
            return prev;
        }
        res.reason = getBuildBlockReason(target, fg, headers);
        if (res.reason === null && !isModelTrainedFresh(target, fg)) res.reason = NOT_TRAINED_BLOCK_REASON;
        if (res.reason !== null) return prev;
        return withFailureGroupState(prev, {
            models: (fg?.models ?? []).map(m => (m.id === modelId ? { ...m, status: true, healthSetPoints: setPoints, ...(exportRecord ? { healthExport: exportRecord } : {}) } : m)),
        });
    });
    if (res.reason === null) await broadcast(next, workspaceId, origin);
    return { next, reason: res.reason };
}
