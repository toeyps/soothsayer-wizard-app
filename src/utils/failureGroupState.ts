import type { WorkspaceState, FailureGroupStateSlice, FailureGroup, FailureModel } from '../types';
import { modelSensorKey } from './modelGrouping';

/** The ONLY way a writer changes `failureGroupState`: spreads the existing slice and applies `patch`, so fields the writer doesn't know are carried, not erased. Never write a `failureGroupState: { groups, models, … }` literal. */
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

/** Undo for 'removing a model's last Failure Group deletes the model': puts the ORIGINAL model back. Pure; run on the mirror and on DISK inside the write. Same id present = no change; deleted groups are dropped from its memberships (none left = 0); a same-kind clash is replaced by the original with memberships merged. */
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
