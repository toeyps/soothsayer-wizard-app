import type { FailureModel } from '../types';
import { effectiveRunningCondition, isCompleteCondition, type RunningConditionFg } from './runningCondition';

/** A repair changes a sensor's values, but the train fingerprint names sensors, not recipes. So each model training on an affected tag gets `status: false` and loses `healthVerdict`, `testsChangedAt` and `trainedFingerprint` (stale: re-train needed); set points and `lastTrainedAt` stay. */

const key = (tag: string) => tag.trim().toLowerCase();

/** Every sensor `model` trains on (as written, may repeat, blanks dropped); shared with `specialSensorSignature.ts`. */
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
    /** Ids of models that must be trained again: they were Complete or had been trained. */
    retrain: string[];
}

/** `models` with every model training on one of `tags` set back to Incomplete and out of date. Pure and idempotent; run it on disk data inside the write. */
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
