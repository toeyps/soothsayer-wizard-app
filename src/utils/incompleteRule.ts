import type { FailureGroupStateSlice, FailureModel, WorkspaceState } from '../types';
import { STIFFNESS_DEFAULT, snapStiffness } from '../components/reports/pmReportTypes';
import { withFailureGroupState } from './failureGroupState';
import { computeTrainFingerprint } from './trainFingerprint';
import { migratePeriods } from './workspaceMigrations';

/**
 * "Incomplete immediately" (health score SPEC FINAL, 2026-10-03).
 *
 * Changing ANY input that decides what a model is trained on —
 *   training period(s), the running condition in every part (Workspace/Custom
 *   switch, conditions, AND/OR, the "no condition" choice, periods — and for a
 *   Workspace-mode model that includes the WORKSPACE running condition),
 *   predictor sensors, the Y / X / criteria sensors, the number of clusters /
 *   criteria ranges, stiffness —
 * sets a Complete model back to Incomplete (`status: false`) IMMEDIATELY, in
 * the same write, without waiting for anything to be re-checked. It keeps its
 * set points, `lastTrainedAt` and `trainedFingerprint`; the mismatch with the
 * current inputs is what then shows it as out of date with a Re-train.
 *
 * What does NOT trigger it: set points, name, notes, category, status, group
 * membership, `scatterXSensor` — none of them is in `computeTrainFingerprint`.
 *
 * This is a pure `(prev, next) => next` step meant to run INSIDE a workspace
 * write (the updater passed to `updateWorkspaceData`), against the state the
 * write read from disk (`prev`) and the state it is about to save (`next`):
 * `updateWorkspaceData` applies it to every write, and the Build Model window's
 * own writers apply it too (idempotent — a second pass sees no change).
 */

/**
 * The inputs fingerprint used to DETECT a change between two writes. It is
 * `computeTrainFingerprint` run on a model with the defaults a draft would fill
 * in already applied (a missing stiffness / cluster count / default ranges),
 * so a write that merely materialises those defaults — e.g. saving a new model
 * name from the Workbench, whose draft re-derives them — is not mistaken for a
 * real change. The persisted `trainedFingerprint` is never produced from this.
 */
function changeFingerprint(model: FailureModel, fg: Partial<FailureGroupStateSlice>): string {
    // Hand-written / very old records may lack list fields; the fingerprint
    // needs them to be arrays.
    let m: FailureModel = Array.isArray(model.predictorSensors) ? model : { ...model, predictorSensors: [] };
    if (model.kind === 'relationship') {
        const lambda = snapStiffness(typeof model.relStiffness === 'number' ? model.relStiffness : STIFFNESS_DEFAULT);
        if (lambda !== model.relStiffness) m = { ...m, relStiffness: lambda };
    } else if (model.kind === 'clustering') {
        if (model.numClusters === undefined || model.numClusters === null) m = { ...m, numClusters: 3 };
    }
    return computeTrainFingerprint(m, fg);
}

/** The slice as `computeTrainFingerprint` should see it: legacy single time
 *  ranges already turned into periods (the same step the Workbench runs on
 *  open), so the one-time migration write is not read as an edit. */
function normalizedSlice(state: WorkspaceState): FailureGroupStateSlice | undefined {
    return migratePeriods(state).failureGroupState;
}

/** Ids of the models in `next` whose training inputs differ from `prev`
 *  (models that only exist on one side are ignored — nothing to compare). */
export function modelsWithChangedInputs(prev: WorkspaceState, next: WorkspaceState): string[] {
    const prevFg = normalizedSlice(prev);
    const nextFg = normalizedSlice(next);
    if (!prevFg || !nextFg) return [];
    const before = new Map(prevFg.models.map(m => [m.id, m]));
    const changed: string[] = [];
    for (const m of nextFg.models) {
        const old = before.get(m.id);
        if (!old) continue;
        if (changeFingerprint(old, prevFg) !== changeFingerprint(m, nextFg)) changed.push(m.id);
    }
    return changed;
}

/**
 * `next`, with every Complete model whose training inputs changed between
 * `prev` and `next` set back to `status: false`. Returns `next` itself (same
 * reference) when nothing needs demoting, so callers can cheaply tell.
 */
export function applyIncompleteRule(prev: WorkspaceState, next: WorkspaceState): WorkspaceState {
    const fg = next.failureGroupState;
    if (!fg || !Array.isArray(fg.models) || !fg.models.some(m => m.status)) return next;
    let changed: Set<string>;
    try {
        changed = new Set(modelsWithChangedInputs(prev, next));
    } catch (e) {
        // A malformed record must never make a workspace write fail: this rule is
        // a guard on top of the write, not part of it.
        console.warn('applyIncompleteRule: could not compare model inputs, leaving statuses alone:', e);
        return next;
    }
    if (changed.size === 0) return next;
    let demoted = false;
    const models = fg.models.map(m => {
        if (!m.status || !changed.has(m.id)) return m;
        demoted = true;
        return { ...m, status: false };
    });
    return demoted ? withFailureGroupState(next, { models }) : next;
}
