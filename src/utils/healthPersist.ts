import { emit } from '@tauri-apps/api/event';
import type { FailureModel, HealthSetPoints, HealthVerdictValue, WorkspaceState } from '../types';
import { updateWorkspaceData } from '../workspaceManager';
import { withFailureGroupState } from './failureGroupState';
import { patchModelHealthSetPoints, sameHealthSetPoints as sameSetPoints } from './healthSetPoints';
import { NOT_TRAINED_BLOCK_REASON } from './modelStatus';
import { effectiveRunningCondition, getBuildBlockReason, markCompleteBlockReason } from './runningCondition';
import { testPeriodsKey } from './timePeriods';
import { computeTrainFingerprint, isModelTrainedFresh } from './trainFingerprint';

/** Writes of the health-score flow: all via `updateWorkspaceData` (read-modify-write against disk) and `withFailureGroupState`, and all broadcast `failure-group-state-changed` with the whole slice, `workspaceId` and `origin`. */

export type FailureGroupOrigin = 'dashboard' | 'build-model';

async function broadcast(state: WorkspaceState | null, workspaceId: string, origin: FailureGroupOrigin): Promise<void> {
    if (!state?.failureGroupState) return;
    // A failed broadcast is not a failed save: the write has already landed.
    try {
        await emit('failure-group-state-changed', { ...state.failureGroupState, workspaceId, origin });
    } catch (e) {
        console.warn('Failed to broadcast failure-group state:', e);
    }
}

/** A copy of `m` without its saved verdict (it no longer describes the model). */
function withoutVerdict(m: FailureModel): FailureModel {
    const { healthVerdict: dropped, ...rest } = m;
    void dropped;
    return rest;
}

/** A copy of `m` without `testsChangedAt` (Mark complete answered it). */
function withoutTestsChanged(m: FailureModel): FailureModel {
    const { testsChangedAt: dropped, ...rest } = m;
    void dropped;
    return rest;
}

/** Save the typed set points onto the model (drops a saved `healthVerdict` that described the old numbers). Different numbers on a Complete model make it Incomplete in the same write, via `applyIncompleteRule`. Never touches `lastTrainedAt`/`trainedFingerprint`. Returns the new state, or null if the project file doesn't exist. */
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
            // The saved verdict described the old numbers; it is recomputed (`commitHealthVerdict`) once the new preview lands. Same numbers keep it.
            models: sameSetPoints(before, setPoints)
                ? patched
                : patched.map(m => (m.id === modelId && m.healthVerdict !== undefined ? withoutVerdict(m) : m)),
        });
    });
    await broadcast(next, workspaceId, origin);
    return next;
}

/** Persist Rust's verdict for a model's saved set points (feeds the Failure Groups dot); changes `healthVerdict` only. No write or broadcast if the model is gone, has this verdict, or isn't trained-and-fresh on disk. Returns the new state or null. */
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
        if (!fg || !target || target.healthVerdict === verdict || !isModelTrainedFresh(target, fg, prev.specialSensorRecipes)) return prev;
        changed = true;
        return withFailureGroupState(prev, {
            models: fg.models.map(m => (m.id === modelId ? { ...m, healthVerdict: verdict } : m)),
        });
    });
    if (!changed) return null;
    await broadcast(next, workspaceId, origin);
    return next;
}

/** How long a window close waits for a running Mark complete (a hung sidecar must not block closing). Mutable so a test can shorten it. */
export const MARK_COMPLETE_CLOSE_WAIT = { ms: 90_000 };

/** Outcome of `persistModelComplete`. */
export interface PersistCompleteResult {
    /** The state after the write (`null` when the project file does not exist). */
    next: WorkspaceState | null;
    /** null = the model is now Complete; otherwise why it was not (gate reason or `NOT_TRAINED_BLOCK_REASON`); nothing changed. */
    reason: string | null;
}

/** What `persistModelComplete` needs to know about the moment the user clicked, to detect changes made DURING the check. */
export interface MarkCompleteRace {
    /** The model's `computeTrainFingerprint` at click time. */
    fingerprint: string;
    /** The model's saved set points at click time (undefined = none); only a later change on disk counts as an edit during the check. */
    setPointsBefore: HealthSetPoints | undefined;
    /** `testPeriodsKey` of the effective scoring periods at click time; edited during the check = the model stays Incomplete (`TESTS_CHANGED_DURING_EXPORT_REASON`). */
    testsKey?: string;
}

export const TESTS_CHANGED_DURING_EXPORT_REASON =
    'the scoring periods changed while it was being checked — mark it complete again.';

export const SET_POINTS_CHANGED_DURING_EXPORT_REASON =
    'the set points changed while it was being checked — mark it complete again.';

export const SETTINGS_CHANGED_DURING_EXPORT_REASON =
    "the model's settings changed while it was being checked — re-train, then mark it complete again.";

/** Mark a model Complete and store the validated set points in ONE write; call only after `checkModelForComplete` returned ok. Writes no files. Gate and fresh-train are re-checked against disk inside the write; it stays Incomplete if `race.fingerprint` no longer matches or set points changed on disk during the check. */
export async function persistModelComplete(
    workspaceId: string,
    modelId: string,
    setPoints: HealthSetPoints,
    headers: string[] | null,
    origin: FailureGroupOrigin = 'build-model',
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
        // At least one valid scoring period.
        if (res.reason === null) res.reason = markCompleteBlockReason(target, fg);
        // A special sensor it was trained on changed its recipe since:
        // not fresh either -- judged against DISK.
        if (res.reason === null && !isModelTrainedFresh(target, fg, prev.specialSensorRecipes)) res.reason = NOT_TRAINED_BLOCK_REASON;
        if (res.reason === null && race
            && (computeTrainFingerprint(target, fg) !== race.fingerprint || target.trainedFingerprint !== race.fingerprint)) {
            res.reason = SETTINGS_CHANGED_DURING_EXPORT_REASON;
        }
        if (res.reason === null && race?.testsKey !== undefined
            && testPeriodsKey(effectiveRunningCondition(target, fg).testPeriods) !== race.testsKey) {
            res.reason = TESTS_CHANGED_DURING_EXPORT_REASON;
        }
        // Set points committed during the check: the newer values on disk were
        // never validated -- keep them, leave the status alone.
        if (res.reason === null && race && target.healthSetPoints
            && !sameSetPoints(target.healthSetPoints, race.setPointsBefore)
            && !sameSetPoints(target.healthSetPoints, setPoints)) {
            res.reason = SET_POINTS_CHANGED_DURING_EXPORT_REASON;
        }
        if (res.reason !== null) return prev;
        return withFailureGroupState(prev, {
            models: (fg?.models ?? []).map(m => {
                if (m.id !== modelId) return m;
                return {
                    // Mark complete answers a "scoring periods changed" stamp.
                    ...withoutTestsChanged(withoutVerdict(m)),
                    status: true,
                    healthSetPoints: setPoints,
                    healthVerdict: 'valid' as const,
                };
            }),
        });
    });
    // No file: nothing was written, so nothing is Complete.
    if (!next) return { next, reason: res.reason ?? 'The project file could not be found.' };
    if (res.reason === null) await broadcast(next, workspaceId, origin);
    return { next, reason: res.reason };
}
