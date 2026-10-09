import type { FailureModel } from '../types';
import { effectiveRunningCondition, isCompleteCondition, type RunningConditionFg } from './runningCondition';

/**
 * What a successful REPAIR of a special sensor does to the models (2026-10-08).
 *
 * A special sensor that could not be restored on reopen (Rust now refuses its
 * recipe) can have its formula fixed even when a model uses it -- otherwise it
 * was a dead end. But the fix gives it (and everything built on it) NEW values,
 * and a model's train fingerprint (`computeTrainFingerprint`) only names the
 * sensors, not their recipes: a Complete model trained on the old values would
 * still read as Complete and fresh.
 *
 * So, in the SAME write, every model that trains on one of the affected tags is
 * handled like `applyIncompleteRule` handles a training-input change:
 *   - `status: false` (Complete -> Incomplete),
 *   - the saved `healthVerdict` and any `testsChangedAt` stamp are dropped
 *     (they describe the old fit),
 *   - set points, `lastTrainedAt` and the export record are KEPT,
 * plus one thing `applyIncompleteRule` gets for free from a changed input and
 * this case cannot: `trainedFingerprint` is removed. With `lastTrainedAt` still
 * set, `isModelStale` (modelStatus.ts, the status truth) then reads the model
 * as "was trained, out of date" and Mark complete's trained-and-fresh check
 * requires a re-train -- the minimal change that makes the existing status
 * machinery see it; no new field. A re-train writes a fresh fingerprint.
 *
 * "Trains on" = the fields that decide what a model is trained on (the same
 * ones `computeTrainFingerprint` uses): target, predictors, X / Y / criteria
 * sensors, and the conditions of its EFFECTIVE running condition (the workspace
 * one for a Workspace-mode model, its own for a Custom one). `scatterXSensor`
 * is display-only and does not count.
 */

const key = (tag: string) => tag.trim().toLowerCase();

/** Every sensor name `model` trains on (the "trains on" fields above, as
 *  written -- may repeat; blanks dropped). Shared with
 *  `specialSensorSignature.ts` so the two can never disagree on the list. */
export function trainingSensorsOf(model: FailureModel, fg: RunningConditionFg): string[] {
    const named = [
        model.targetSensor,
        ...(Array.isArray(model.predictorSensors) ? model.predictorSensors : []),
        model.xSensor,
        model.ySensor,
        model.criteriaSensor,
        ...effectiveRunningCondition(model, fg).filters.filter(f => isCompleteCondition(f)).map(f => f.sensor),
    ];
    return named.filter((s): s is string => typeof s === 'string' && s.trim() !== '');
}

/** Does `model` train on any of `tags` (compared trimmed, case-insensitively)? */
export function modelTrainsOnSensors(model: FailureModel, fg: RunningConditionFg, tags: Iterable<string>): boolean {
    const wanted = new Set([...tags].map(key));
    if (wanted.size === 0) return false;
    return trainingSensorsOf(model, fg).some(s => wanted.has(key(s)));
}

export interface SensorRepairDemotion {
    /** The models after the demotion (same array reference when nothing changed). */
    models: FailureModel[];
    /** Ids of the models that must be trained again: they were Complete or had
     *  been trained (the user-facing "N model(s) set back to Incomplete"). */
    retrain: string[];
}

/**
 * `models` with every model that trains on one of `tags` set back to
 * Incomplete and out of date (see the module note). Pure; run it on what is on
 * DISK inside the write (`persistFailureGroupStateFrom`). Idempotent.
 */
export function demoteModelsTrainedOnSensors(
    models: FailureModel[],
    fg: RunningConditionFg,
    tags: string[],
): SensorRepairDemotion {
    if (!Array.isArray(models) || tags.length === 0) return { models, retrain: [] };
    const retrain: string[] = [];
    let changed = false;
    const next = models.map(m => {
        if (!modelTrainsOnSensors(m, fg, tags)) return m;
        if (m.status || m.lastTrainedAt) retrain.push(m.id);
        const needsWrite = m.status
            || m.trainedFingerprint !== undefined
            || m.healthVerdict !== undefined
            || m.testsChangedAt !== undefined;
        if (!needsWrite) return m;
        changed = true;
        const { trainedFingerprint: _fp, healthVerdict: _verdict, testsChangedAt: _stamp, ...rest } = m;
        void _fp;
        void _verdict;
        void _stamp;
        return { ...rest, status: false };
    });
    return { models: changed ? next : models, retrain };
}
