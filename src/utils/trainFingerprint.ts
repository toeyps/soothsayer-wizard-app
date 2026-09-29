import type { FailureModel, TimePeriod, WorkspaceSensorFilter } from '../types';
import { effectiveRunningCondition, type RunningConditionFg } from './runningCondition';

/** Only the parts of a filter row that actually change what training rows get
 *  selected — `id` is a React key, not an input to the computation. */
function filterFingerprint(f: WorkspaceSensorFilter) {
    return { sensor: f.sensor, operation: f.operation, value1: f.value1, value2: f.value2 };
}

/** Same idea for a training period — `id` doesn't affect the query. */
function periodFingerprint(p: TimePeriod) {
    return { start: p.start, end: p.end };
}

/**
 * A stable string capturing every input that would change the result of the
 * Build Model Workbench Phase B "Train" preview
 * (`compute_sensor_stats` / `preview_relationship_model` /
 * `compute_clustering_preview` — see `docs/PROJECT_HANDOVER.md`'s 2026-09-29
 * SPEC FINAL entry). Compare a model's persisted `trainedFingerprint` against
 * a fresh call of this function to decide staleness:
 *
 *   const stale = model.trainedFingerprint !== computeTrainFingerprint(model, fg);
 *
 * Included: the model's kind-specific fit inputs (target/predictor sensors,
 * X/Y/criteria sensors, cluster ranges, cluster count, Relation stiffness) and
 * its EFFECTIVE running condition (`effectiveRunningCondition` — already
 * resolves 'workspace' vs 'custom', so a workspace-mode model goes stale when
 * the *workspace* default changes, and a custom-mode model goes stale when its
 * *own* override changes, without this function needing to know which).
 *
 * Deliberately excluded because they don't change the fit: model/cluster name,
 * notes, category, status, groupNos, id. `predictorSensors` is sorted so
 * reordering the same set of predictors isn't treated as a change; filter/period
 * `id`s are stripped for the same reason (see the two helpers above).
 */
export function computeTrainFingerprint(model: FailureModel, fg: RunningConditionFg): string {
    const eff = effectiveRunningCondition(model, fg);
    const payload = {
        kind: model.kind,
        targetSensor: model.targetSensor,
        predictorSensors: [...model.predictorSensors].sort(),
        xSensor: model.xSensor,
        ySensor: model.ySensor,
        criteriaSensor: model.criteriaSensor,
        clusterRanges: model.clusterRanges,
        numClusters: model.numClusters,
        relStiffness: model.relStiffness,
        runningConditionMode: eff.mode,
        combine: eff.combine,
        noneConfirmed: eff.noneConfirmed,
        filters: eff.filters.map(filterFingerprint),
        periods: eff.periods.map(periodFingerprint),
    };
    return JSON.stringify(payload);
}
