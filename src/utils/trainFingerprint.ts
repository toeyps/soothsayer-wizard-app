import type { FailureModel, TimePeriod, WorkspaceSensorFilter } from '../types';
import { effectiveRunningCondition, isCompleteCondition, type RunningConditionFg } from './runningCondition';

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
 *
 * Two kind-specific exclusions (QA fix, 2026-09-29 — see the "Train never
 * sticks" / "opening full view makes a trained model stale" bugs in
 * `docs/PROJECT_HANDOVER.md`'s matching entry): `clusterRanges` is dropped
 * entirely whenever there is no criteria sensor (a range list is meaningless
 * without one, so its exact shape — `[]`, 3 auto-divided defaults, whatever
 * the PM page's own hydration happens to normalise it to on open — must
 * never make an unrelated model go stale), and `targetSensor` is dropped for
 * clustering specifically (that kind already fingerprints `ySensor`/`xSensor`
 * /`criteriaSensor`; `targetSensor` there is a derived alias, not its own
 * input, and the PM page's hydration writes `targetSensor = ySensor` on
 * every open).
 *
 * Running-condition rows are also filtered to COMPLETE ones only
 * (`isCompleteCondition`, the same filter `buildPreviewFilterPayload` /
 * the PM page's `dashboardFilterPayload` already apply before sending
 * anything to Rust) — an incomplete row (no sensor yet, or a value not
 * filled in) isn't sent to Rust either, so it must not make every model
 * that follows the workspace condition go stale the instant someone adds a
 * blank row to it.
 */
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
        noneConfirmed: eff.noneConfirmed,
        filters: eff.filters.filter(f => isCompleteCondition(f)).map(filterFingerprint),
        periods: eff.periods.map(periodFingerprint),
    };
    return JSON.stringify(payload);
}

/**
 * Pure "is this exact model+fg pair Trained-and-fresh" check — just the
 * fingerprint equality Phase B's Train writes (`lastTrainedAt` set AND
 * `trainedFingerprint` still matching a fresh `computeTrainFingerprint`
 * call), no `status`/draft awareness of its own.
 *
 * Moved here from `BuildModelWindow.tsx` (2026-09-30, Phase C of the Build
 * Model Workbench redesign — see `docs/PROJECT_HANDOVER.md`'s SPEC FINAL
 * entry) so it has exactly one definition, shared by every reader instead of
 * being redefined per file: `BuildModelWindow.tsx`'s own `isModelTrainedFresh`
 * (component-level, folds in the live draft via `effectiveModelFor` + the
 * `status` check) and `persistModelComplete` (Mark complete, checked directly
 * against the model/fg read fresh off disk inside that write) both import this
 * as `trainedFreshFor`; `FailureGroupsPanel.tsx`
 * (Dashboard's Sensor panel → Failure Groups tab) imports it directly to
 * color the status dot on each sensor row's I/R/C badge. None of these
 * callers duplicate the equality check itself any more.
 *
 * A caller that also needs to match the app's "Trained" pill/dot exactly
 * (not just fingerprint-fresh) must additionally check `!model.status` and
 * `getBuildBlockReason(model, fg, headers) === null` — this function alone
 * only answers the fingerprint-equality question, the same narrow scope it
 * had as `trainedFreshFor`.
 */
export function isModelTrainedFresh(model: FailureModel, fg: RunningConditionFg): boolean {
    return !!model.lastTrainedAt && model.trainedFingerprint === computeTrainFingerprint(model, fg);
}
