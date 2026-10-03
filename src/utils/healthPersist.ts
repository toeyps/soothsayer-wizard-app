import { emit } from '@tauri-apps/api/event';
import type { FailureModel, HealthExportRecord, HealthSetPoints, HealthVerdictValue, WorkspaceState } from '../types';
import { sameSetPoints } from '../components/windows/workbench/healthChecks';
import { updateWorkspaceData } from '../workspaceManager';
import { withFailureGroupState } from './failureGroupState';
import { patchModelHealthSetPoints } from './healthSetPoints';
import { NOT_TRAINED_BLOCK_REASON } from './modelStatus';
import { getBuildBlockReason } from './runningCondition';
import { computeTrainFingerprint, isModelTrainedFresh } from './trainFingerprint';

/**
 * The writes of the health-score flow (phase 3a, 2026-10-03; QA fixes
 * 2026-10-04). All go through `updateWorkspaceData` (read-modify-write against
 * what is ON DISK, so a stale in-memory mirror can never revert another
 * window's change) and `withFailureGroupState` (never a hand-built slice), and
 * all broadcast `failure-group-state-changed` — carrying the WHOLE slice, with
 * `workspaceId` and `origin` — so the Dashboard's Failure Groups dots update.
 *
 * The caller (a window) applies the returned state to its own copy; the
 * broadcast is skipped by receivers that sent it (`origin`).
 */

export type FailureGroupOrigin = 'dashboard' | 'build-model';

async function broadcast(state: WorkspaceState | null, workspaceId: string, origin: FailureGroupOrigin): Promise<void> {
    if (!state?.failureGroupState) return;
    await emit('failure-group-state-changed', { ...state.failureGroupState, workspaceId, origin });
}

/** A copy of `m` without its saved verdict (it no longer describes the model). */
function withoutVerdict(m: FailureModel): FailureModel {
    const { healthVerdict: dropped, ...rest } = m;
    void dropped;
    return rest;
}

/**
 * Save the set points the user typed onto the model — on every explicit Save /
 * blur. Changes `healthSetPoints` ONLY (plus dropping a saved `healthVerdict`
 * that described the OLD numbers): not `status`, not `lastTrainedAt` /
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
    const next = await updateWorkspaceData(workspaceId, prev => {
        const models = prev.failureGroupState?.models ?? [];
        const before = models.find(m => m.id === modelId)?.healthSetPoints;
        const patched = patchModelHealthSetPoints(models, modelId, setPoints);
        return withFailureGroupState(prev, {
            // The saved verdict described the OLD numbers; it is recomputed (and written
            // again by `commitHealthVerdict`) once the preview of the new ones lands.
            // The same numbers (only a snapshot/bookkeeping change) keep it.
            models: sameSetPoints(before, setPoints)
                ? patched
                : patched.map(m => (m.id === modelId && m.healthVerdict !== undefined ? withoutVerdict(m) : m)),
        });
    });
    await broadcast(next, workspaceId, origin);
    return next;
}

/**
 * Persist the validation verdict Rust gave for a model's SAVED set points so the
 * Dashboard's Failure Groups dot can show "Fix set point" / "Set points needed"
 * like the Build Model list (QA fix, 2026-10-04). Changes `healthVerdict` ONLY.
 * Writes nothing (and does not broadcast) when the model is gone, already has
 * this verdict, or is not trained-and-fresh on disk any more (a verdict of an
 * old fit must not stick to a new one). Returns the new workspace state when
 * something was written, otherwise `null`.
 */
export async function commitHealthVerdict(
    workspaceId: string,
    modelId: string,
    verdict: HealthVerdictValue,
    origin: FailureGroupOrigin = 'build-model',
): Promise<WorkspaceState | null> {
    let changed = false;
    const next = await updateWorkspaceData(workspaceId, prev => {
        const fg = prev.failureGroupState;
        const target = fg?.models?.find(m => m.id === modelId);
        if (!fg || !target || target.healthVerdict === verdict || !isModelTrainedFresh(target, fg)) return prev;
        changed = true;
        return withFailureGroupState(prev, {
            models: fg.models.map(m => (m.id === modelId ? { ...m, healthVerdict: verdict } : m)),
        });
    });
    if (!changed) return null;
    await broadcast(next, workspaceId, origin);
    return next;
}

/** How long a window close waits for a running "Mark complete" (export + save)
 *  before it stays open and tells the user (a Relationship export is ~15 s; a
 *  hung sidecar must not make the window impossible to close). A mutable object
 *  so a test can shorten it. */
export const MARK_COMPLETE_CLOSE_WAIT = { ms: 90_000 };

/** Outcome of `persistModelComplete`. */
export interface PersistCompleteResult {
    /** The state after the write (`null` when the workspace could not be read). */
    next: WorkspaceState | null;
    /** `null` = the model is now Complete. Otherwise why it was NOT marked
     *  (the gate's reason, or `NOT_TRAINED_BLOCK_REASON`); nothing changed. */
    reason: string | null;
}

/** What `persistModelComplete` needs to know about the moment the user clicked, to
 *  detect changes made DURING the export. */
export interface MarkCompleteRace {
    /** The model's `computeTrainFingerprint` at click time. */
    fingerprint: string;
    /** The model's SAVED set points at click time (`undefined` = none saved). The
     *  exported set points may differ from these (typed but not committed): only a
     *  change of what is on disk AFTER the click counts as an edit during the export. */
    setPointsBefore: HealthSetPoints | undefined;
}

export const SETTINGS_CHANGED_DURING_EXPORT_REASON =
    "the model's settings changed while its files were being written — re-train, then mark it complete again.";

/**
 * Mark a model Complete and store the validated set points, in ONE write — call
 * it only after `completeModel` returned `ok: true`. The gate and the
 * "Trained and still fresh" requirement are re-checked against the model as it
 * is on disk INSIDE the write (the user may have changed something in another
 * window since): a model that is no longer fresh stays Incomplete and `reason`
 * says why — its files were written, but it is not reported complete.
 *
 * Two more races of the (up to ~15 s) export are closed here (QA fix, 2026-10-04):
 *  - `race.fingerprint` (the model's `computeTrainFingerprint` at click time):
 *    the model on disk must STILL have it, both as its current fingerprint and as
 *    its `trainedFingerprint`. A model that was re-configured AND re-trained during
 *    the export is "fresh" against its NEW settings but the files carry the OLD
 *    ones — it stays Incomplete (`SETTINGS_CHANGED_DURING_EXPORT_REASON`).
 *  - Set points edited and committed while the export ran (what is on disk now
 *    differs from `race.setPointsBefore`, the saved values at click time): the files
 *    hold the EXPORTED values, so `healthExport` records those; the newer values on
 *    disk are KEPT (never reverted to the exported ones) and the model is still marked
 *    Complete — the files exist and match the model that was trained — while the
 *    Health page's existing "Changed after saving / Mark complete again" hint
 *    tells the user the files are out of date. The saved verdict is only written
 *    ('valid') for the numbers that were actually validated.
 */
export async function persistModelComplete(
    workspaceId: string,
    modelId: string,
    setPoints: HealthSetPoints,
    headers: string[] | null,
    origin: FailureGroupOrigin = 'build-model',
    exportRecord?: HealthExportRecord,
    race?: MarkCompleteRace,
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
        if (res.reason === null && race
            && (computeTrainFingerprint(target, fg) !== race.fingerprint || target.trainedFingerprint !== race.fingerprint)) {
            res.reason = SETTINGS_CHANGED_DURING_EXPORT_REASON;
        }
        if (res.reason !== null) return prev;
        // Set points committed during the export keep their newer values.
        const keepDisk = !!race && !!target.healthSetPoints
            && !sameSetPoints(target.healthSetPoints, race.setPointsBefore)
            && !sameSetPoints(target.healthSetPoints, setPoints);
        return withFailureGroupState(prev, {
            models: (fg?.models ?? []).map(m => {
                if (m.id !== modelId) return m;
                return {
                    ...withoutVerdict(m),
                    status: true,
                    healthSetPoints: keepDisk ? target.healthSetPoints : setPoints,
                    ...(keepDisk ? {} : { healthVerdict: 'valid' as const }),
                    ...(exportRecord ? { healthExport: exportRecord } : {}),
                };
            }),
        });
    });
    if (res.reason === null) await broadcast(next, workspaceId, origin);
    return { next, reason: res.reason };
}
