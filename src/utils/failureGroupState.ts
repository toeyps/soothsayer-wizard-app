import type { WorkspaceState, FailureGroupStateSlice, FailureGroup, FailureModel } from '../types';
import { modelSensorKey } from './modelGrouping';

/**
 * The ONLY way a writer should change `failureGroupState`. Spreads whatever is
 * already there and applies `patch` on top, so a field the writer doesn't know
 * about (the workspace time range, and every field added after this writer was
 * written) is carried through instead of erased — a writer that rebuilds the
 * slice from an explicit field list silently drops every field it does not
 * list. Don't write a
 * `failureGroupState: { groups, models, … }` literal — call this.
 *
 * Lives in `utils/` (pure, no Tauri imports) rather than `workspaceManager.ts`
 * so tests that mock that module don't have to re-provide it.
 */
export function withFailureGroupState(
    prev: WorkspaceState,
    patch: Partial<FailureGroupStateSlice>,
): WorkspaceState {
    const current = prev.failureGroupState;
    return {
        ...prev,
        failureGroupState: {
            groups: current?.groups ?? [],
            models: current?.models ?? [],
            ...current,
            ...patch,
        },
    };
}

/**
 * Undo for "removing a model's last Failure Group deletes the model" (Dashboard's
 * `applyToggle`): puts the ORIGINAL model object back — same id, settings and
 * training fields — into `models`. Pure, so the Dashboard runs it against its
 * mirror (instant UI) and again against what is on DISK inside the write.
 *
 *  - Already there (same id) -> no change, so Undo is idempotent.
 *  - A group the model belonged to was deleted in the meantime -> that group is
 *    dropped from its memberships; if none is left it parks in "Not in Group"
 *    (0) — the same fallback a model gets when it loses its last group in any other way.
 *    (`deleteGroup` itself deletes the models that were only in the deleted group, since 2026-10-17.)
 *  - The user re-added the same kind for the same sensor before undoing (that
 *    made a fresh, blank model with a new id) -> the original takes its place
 *    and the two memberships are merged, so the sensor never ends up with two
 *    models of one kind.
 */
export function restoreDeletedModel(
    groups: FailureGroup[],
    models: FailureModel[],
    original: FailureModel,
): FailureModel[] {
    if (models.some(m => m.id === original.id)) return models;
    const stillExists = (no: number) => no === 0 || groups.some(g => g.no === no);
    const key = modelSensorKey(original);
    const clash = models.find(m => m.kind === original.kind && modelSensorKey(m) === key);
    const merged = [...new Set([...original.groupNos, ...(clash?.groupNos ?? [])])].filter(stillExists);
    const real = merged.filter(no => no !== 0);
    const groupNos = real.length > 0 ? real : [0];
    const restored: FailureModel = { ...original, groupNos };
    return clash ? models.map(m => (m === clash ? restored : m)) : [...models, restored];
}
