import type { FailureModel, SpecialSensorRecipe, TimePeriod, WorkspaceSensorFilter } from '../types';
import { effectiveRunningCondition, isCompleteCondition, type RunningConditionFg } from './runningCondition';
import { trainedFormulasChanged } from './specialSensorSignature';

/** Only the parts of a filter row that change which rows are selected; `id` is a React key. */
function filterFingerprint(f: WorkspaceSensorFilter) {
    return { sensor: f.sensor, operation: f.operation, value1: f.value1, value2: f.value2 };
}

/** Same idea for a training period — `id` doesn't affect the query. */
function periodFingerprint(p: TimePeriod) {
    return { start: p.start, end: p.end };
}

/** Stable string of every input that changes a Train result; compare with `model.trainedFingerprint` for staleness. Includes the EFFECTIVE running condition; excludes name, notes, category, status, groupNos, id. Predictors are sorted; `clusterRanges` is dropped with no criteria sensor, `targetSensor` for clustering, and incomplete condition rows (not sent to Rust either). */
export function computeTrainFingerprint(model: FailureModel, fg: RunningConditionFg): string {
    const eff = effectiveRunningCondition(model, fg);
    const hasCriteria = !!(model.criteriaSensor && model.criteriaSensor.trim());
    const payload = {
        kind: model.kind,
        targetSensor: model.kind === 'clustering' ? undefined : model.targetSensor,
        predictorSensors: [...model.predictorSensors].sort(),
        xSensor: model.xSensor,
        ySensor: model.ySensor,
        criteriaSensor: model.criteriaSensor,
        clusterRanges: hasCriteria ? model.clusterRanges : undefined,
        numClusters: model.numClusters,
        relStiffness: model.relStiffness,
        runningConditionMode: eff.mode,
        combine: eff.combine,
        // Key kept as `noneConfirmed` so fingerprints saved before 'Use all data' still match; on all data the condition picks no rows.
        noneConfirmed: eff.allData,
        filters: eff.allData ? [] : eff.filters.filter(f => isCompleteCondition(f)).map(filterFingerprint),
        periods: eff.periods.map(periodFingerprint),
    };
    return JSON.stringify(payload);
}

/** Pure 'trained and fresh' check: `lastTrainedAt` set, fingerprint matches and no used recipe changed; ignores `status` and drafts. */
export function isModelTrainedFresh(
    model: FailureModel,
    fg: RunningConditionFg,
    /** Special-sensor recipes: when given, a changed recipe of a sensor the model trained on also makes it not fresh. */
    recipes?: SpecialSensorRecipe[] | null,
): boolean {
    return !!model.lastTrainedAt && model.trainedFingerprint === computeTrainFingerprint(model, fg)
        && !(recipes && trainedFormulasChanged(model, recipes));
}
