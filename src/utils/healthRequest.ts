import type { FailureModel, HealthSetPoints } from '../types';
import type {
    HealthClusterRange,
    HealthPreviewRequest,
    HealthSetPointsWire,
    TestPeriodWire,
} from '../types/health';
import { STIFFNESS_DEFAULT } from '../components/reports/pmReportTypes';
import { effectiveRunningCondition, type RunningConditionFg } from './runningCondition';
import { toTestPeriodsWire } from './timePeriods';
import { computeTrainFingerprint } from './trainFingerprint';
import { trainingScopeFilter } from './trainingScope';

/** Pure builders for `compute_health_preview`. Pass the draft-merged model when there are unsaved edits, like Train; nothing reads `model.healthSetPoints` unless the caller passes it in. */

/** Default cap on a series' points; the same Train asks `preview_relationship_model` for, so both have the same resolution. */
export const HEALTH_DEFAULT_MAX_POINTS = 4000;

/** Model camelCase set points -> snake_case for Rust (own kind only); missing or wrong kind gives `{}`, so Rust reports every field `required`. */
export function healthSetPointsToWire(
    kind: FailureModel['kind'],
    sp: HealthSetPoints | null | undefined,
): HealthSetPointsWire {
    if (!sp || sp.kind !== kind) return {};
    switch (sp.kind) {
        case 'individual':
            return { lower: sp.lower, upper: sp.upper };
        case 'relationship':
            return {
                residual_at_80_lower: sp.residualAt80Lower,
                residual_at_80_upper: sp.residualAt80Upper,
                residual_at_0_lower: sp.residualAt0Lower,
                residual_at_0_upper: sp.residualAt0Upper,
            };
        case 'clustering':
            return { outer_sd: sp.outerSd };
    }
}

/** Rust cache key of a Relationship fit; includes the train fingerprint because Rust ignores `filter` for Relationship, so a key shared across scopes would serve stale data. */
export function relationshipCacheKey(model: FailureModel, fg: RunningConditionFg): string {
    return `${model.id}::${computeTrainFingerprint(model, fg)}`;
}

/** λ sent to `preview_relationship_model`: `relStiffness`, falling back to the Standard preset when missing or non-finite. */
export function relationshipLambda(model: FailureModel): number {
    return typeof model.relStiffness === 'number' && Number.isFinite(model.relStiffness)
        ? model.relStiffness
        : STIFFNESS_DEFAULT;
}

const nonEmpty = (v: string | null | undefined): v is string => typeof v === 'string' && v.trim() !== '';

/** Clustering sensors / ranges exactly as the Workbench's Train sends them to
 *  `compute_clustering_preview`. */
function clusteringFields(model: FailureModel) {
    const nClusters = model.numClusters ?? 3;
    const criteria = nonEmpty(model.criteriaSensor) ? model.criteriaSensor : null;
    const ranges: HealthClusterRange[] | null = criteria
        ? (model.clusterRanges ?? []).slice(0, nClusters).map(r => ({ min: r.min, max: r.max }))
        : null;
    return {
        first_sensor: model.xSensor,
        second_sensor: model.ySensor,
        n_clusters: nClusters,
        criteria_sensor: criteria,
        cluster_ranges: ranges,
    };
}

/** Why a model can't be previewed/exported yet (a required sensor is missing), or null; mirrors Rust's `BAD_REQUEST`. */
export function healthInputsMissing(model: FailureModel): string | null {
    if (model.kind === 'individual') return nonEmpty(model.targetSensor) ? null : 'Pick the target sensor.';
    if (model.kind === 'relationship') {
        if (!nonEmpty(model.targetSensor)) return 'Pick the target sensor.';
        return (model.predictorSensors ?? []).length > 0 ? null : 'Add at least 1 predictor.';
    }
    if (!nonEmpty(model.xSensor)) return 'Pick the X sensor.';
    if (!nonEmpty(model.ySensor)) return 'Pick the Y sensor.';
    // Rust: `criteria_sensor is required when n_clusters > 1`.
    return (model.numClusters ?? 3) > 1 && !nonEmpty(model.criteriaSensor) ? CLUSTERS_NEED_CRITERIA : null;
}

/** Clustering with 2+ clusters needs a criteria sensor (Rust rejects `n_clusters > 1` without one); one message for every check. */
export const CLUSTERS_NEED_CRITERIA = 'Pick a criteria sensor for 2+ clusters (or set Clusters to 1)';

/** The model's effective scoring periods (workspace list or its own `customTestPeriods`) as the `test_periods` wire list, or `undefined` if none; invalid ones are dropped. Not in the train fingerprint: changing them re-scores the cached fit. */
export function testPeriodsWireFor(model: FailureModel, fg: RunningConditionFg): TestPeriodWire[] | undefined {
    const wire = toTestPeriodsWire(effectiveRunningCondition(model, fg).testPeriods);
    return wire.length > 0 ? wire : undefined;
}

export interface HealthRequestOptions {
    /** The model to preview/export (draft-merged when previewing unsaved edits). */
    model: FailureModel;
    /** The workspace slice — supplies the workspace running condition. */
    fg: RunningConditionFg;
    /** Dataset headers (conditions on sensors not in the dataset are dropped, as in Train). */
    headers: string[] | null;
    /** The set points being edited (draft). Omit/null = nothing entered. */
    setPoints?: HealthSetPoints | null;
    /** Rust session generation (`metadata.generation`); stale windows get `STALE_SESSION`. */
    expectedGeneration?: number;
}

export interface HealthPreviewRequestOptions extends HealthRequestOptions {
    maxPoints?: number;
    maxScatterPoints?: number;
    /** Relationship: predictor on the Fit scatter's X axis. */
    xPredictor?: string | null;
    /** Individual: also return the rows outside the scope (unscored). */
    includeOutOfScope?: boolean;
}

/** Builds the `compute_health_preview` request, or `null` if a required sensor is missing. Unset optional fields are omitted so `JSON.stringify(request)` is a stable key. */
export function buildHealthPreviewRequest(opts: HealthPreviewRequestOptions): HealthPreviewRequest | null {
    const { model, fg, headers } = opts;
    if (healthInputsMissing(model) !== null) return null;
    const req: HealthPreviewRequest = {
        kind: model.kind,
        filter: trainingScopeFilter(model, fg, headers),
        set_points: healthSetPointsToWire(model.kind, opts.setPoints),
        max_points: opts.maxPoints ?? HEALTH_DEFAULT_MAX_POINTS,
    };
    if (model.kind === 'individual') {
        req.target = model.targetSensor;
        if (opts.includeOutOfScope) req.include_out_of_scope = true;
    } else if (model.kind === 'relationship') {
        req.target = model.targetSensor;
        req.predictors = [...model.predictorSensors];
        req.cache_key = relationshipCacheKey(model, fg);
        if (opts.xPredictor) req.x_predictor = opts.xPredictor;
    } else {
        Object.assign(req, clusteringFields(model));
    }
    const tests = testPeriodsWireFor(model, fg);
    if (tests) req.test_periods = tests;
    if (opts.maxScatterPoints !== undefined) req.max_scatter_points = opts.maxScatterPoints;
    if (opts.expectedGeneration !== undefined) req.expected_generation = opts.expectedGeneration;
    return req;
}

/** A stable string for a request — equal iff the call would be identical. */
export function healthRequestKey(req: HealthPreviewRequest | null): string | null {
    return req ? JSON.stringify(req) : null;
}
