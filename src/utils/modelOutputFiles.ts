import { invoke } from '@tauri-apps/api/core';
import type { FailureModel } from '../types';
import { modelSensorKey } from './modelGrouping';
import { reportError } from '../errorReporter';

/**
 * A deleted model's files leave the workspace's output folder with it (user decision
 * 2026-10-17): Mark complete wrote them to `workspaces/{id}/output/…`, and nothing else
 * removed them, so the folder kept files of models that no longer existed.
 *
 * Only for a model that is really GONE: when `remaining` still holds a model of the same
 * kind for the same sensor (an Undo put it back, or another window re-created it), its
 * files are that model's and are left alone. A model that goes back to Incomplete keeps its
 * files until it is Marked complete again (also a user decision) — that path never calls this.
 *
 * Identity, matching the export's file names: Individual / Relation model = the target
 * sensor; Clustering = its first (X) sensor (`modelSensorKey`). Best effort: a failure is
 * reported, never thrown — the model is already deleted.
 */
export async function removeModelOutputFiles(
    workspaceId: string | undefined,
    model: Pick<FailureModel, 'kind' | 'targetSensor' | 'xSensor'>,
    remaining: readonly Pick<FailureModel, 'kind' | 'targetSensor' | 'xSensor'>[],
): Promise<number> {
    if (!workspaceId) return 0;
    const key = modelSensorKey(model);
    if (!key) return 0;
    if (remaining.some(m => m.kind === model.kind && modelSensorKey(m) === key)) return 0;
    const sensor = (model.kind === 'clustering' ? model.xSensor : model.targetSensor) ?? '';
    if (!sensor) return 0;
    try {
        return await invoke<number>('remove_model_files', { workspace_id: workspaceId, kind: model.kind, sensor });
    } catch (e) {
        reportError('remove_model_files', e, `${model.kind} ${sensor}`);
        return 0;
    }
}

/** The models a Failure Group deletes with it: those that belong to that group ONLY. A model
 *  that is also in another group just loses this one. */
export function modelsOnlyIn<T extends Pick<FailureModel, 'groupNos'>>(models: readonly T[], groupNo: number): T[] {
    return models.filter(m => m.groupNos.length > 0 && m.groupNos.every(n => n === groupNo));
}

/** What deleting a group does to its models: those only in it are deleted (with their files),
 *  those also in another group just lose it. */
export function groupDeleteCounts(models: readonly { groupNos: number[] }[], groupNo: number): { deleted: number; kept: number } {
    const inGroup = models.filter(m => m.groupNos.includes(groupNo));
    const deleted = modelsOnlyIn(inGroup, groupNo).length;
    return { deleted, kept: inGroup.length - deleted };
}

/** "Delete FG-1? 2 models used only by this group are deleted with their saved files · 1 model stays in its other groups." */
export function groupDeleteSentence(name: string, deleted: number, kept: number): string {
    const n = (k: number) => `${k} model${k === 1 ? '' : 's'}`;
    const parts = [`Delete ${name}?`];
    if (deleted > 0) parts.push(`${n(deleted)} used only by this group ${deleted === 1 ? 'is' : 'are'} deleted with ${deleted === 1 ? 'its' : 'their'} saved files.`);
    if (kept > 0) parts.push(`${n(kept)} ${kept === 1 ? 'stays' : 'stay'} in ${kept === 1 ? 'its' : 'their'} other groups.`);
    if (deleted === 0 && kept === 0) parts.push('It has no models.');
    return parts.join(' ');
}
