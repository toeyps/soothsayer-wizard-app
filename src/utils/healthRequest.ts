import type { FailureModel, HealthSetPoints } from '../types';
import type {
    HealthClusterRange,
    HealthPreviewRequest,
    HealthSetPointsWire,
    ModelFilesRequest,
} from '../types/health';
import { STIFFNESS_DEFAULT } from '../components/reports/pmReportTypes';
import type { RunningConditionFg } from './runningCondition';
import { computeTrainFingerprint } from './trainFingerprint';
import { trainingScopeFilter } from './trainingScope';

/**
 * Pure builders for the health-score commands (`compute_health_preview`,
 * `export_model_files`) — phase 3a, 2026-10-03.
 *
 * They take the model the UI is currently looking at (pass the DRAFT-merged
 * model when there are unsaved edits, exactly like Train does), the workspace
 * slice (for the Workspace/Custom running condition), the dataset headers and
 * the set points the user is editing (a draft; nothing here reads
 * `model.healthSetPoints` unless the caller passes that same value in).
 */

/** Default cap on a series' points — same figure the Workbench's Train asks
 *  `preview_relationship_model` for, so Train's bounded `health_preview` and a
 *  later `compute_health_preview` have the same resolution. */
export const HEALTH_DEFAULT_MAX_POINTS = 4000;

/** Convert the model's camelCase set points into the snake_case object Rust
 *  reads. Only the keys of the model's own kind are filled; a missing /
 *  wrong-kind value gives `{}` (Rust then reports every field as `required`). */
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

/** The key a Relationship fit is cached under in Rust. It contains the model's
 *  train fingerprint (target, predictors, stiffness, the effective training
 *  scope ...), so ANY change that would change the fit changes the key — Rust
 *  deliberately ignores `filter` for Relationship, so reusing one key across
 *  different scopes would silently serve stale data. */
export function relationshipCacheKey(model: FailureModel, fg: RunningConditionFg): string {
    return `${model.id}::${computeTrainFingerprint(model, fg)}`;
}

/** λ for LinearGAM, as the Workbench sends it to `preview_relationship_model`
 *  (`relStiffness` itself; only a missing/non-finite value falls back to the
 *  Standard preset). */
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

/** Why a model cannot be previewed/exported yet (a required sensor is missing),
 *  or null. Mirrors what Rust would reject with `BAD_REQUEST`, so the UI never
 *  fires a call that cannot succeed. */
export function healthInputsMissing(model: FailureModel): string | null {
    if (model.kind === 'individual') return nonEmpty(model.targetSensor) ? null : 'Pick the target sensor.';
    if (model.kind === 'relationship') {
        if (!nonEmpty(model.targetSensor)) return 'Pick the target sensor.';
        return (model.predictorSensors ?? []).length > 0 ? null : 'Add at least 1 predictor.';
    }
    if (!nonEmpty(model.xSensor)) return 'Pick the X sensor.';
    return nonEmpty(model.ySensor) ? null : 'Pick the Y sensor.';
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

/**
 * Build the `compute_health_preview` request for one model, or `null` when a
 * required sensor is missing. Optional fields that are not set are omitted
 * (not `undefined`-valued keys), so `JSON.stringify(request)` is a stable key.
 */
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
    if (opts.maxScatterPoints !== undefined) req.max_scatter_points = opts.maxScatterPoints;
    if (opts.expectedGeneration !== undefined) req.expected_generation = opts.expectedGeneration;
    return req;
}

/** A stable string for a request — equal iff the call would be identical. */
export function healthRequestKey(req: HealthPreviewRequest | null): string | null {
    return req ? JSON.stringify(req) : null;
}

export interface ModelFilesRequestOptions extends HealthRequestOptions {
    workspaceId: string;
}

/**
 * Build the `export_model_files` request ("Mark complete"): `model_name` is the
 * model's own name; Relationship carries its `lambda` and the SAME `cache_key`
 * the preview used. `null` when a required sensor is missing.
 */
export function buildModelFilesRequest(opts: ModelFilesRequestOptions): ModelFilesRequest | null {
    const { model, fg, headers } = opts;
    if (healthInputsMissing(model) !== null) return null;
    const req: ModelFilesRequest = {
        kind: model.kind,
        workspace_id: opts.workspaceId,
        model_name: model.name,
        filter: trainingScopeFilter(model, fg, headers),
        set_points: healthSetPointsToWire(model.kind, opts.setPoints),
    };
    if (model.kind === 'individual') {
        req.target = model.targetSensor;
    } else if (model.kind === 'relationship') {
        req.target = model.targetSensor;
        req.predictors = [...model.predictorSensors];
        req.lambda = relationshipLambda(model);
        req.cache_key = relationshipCacheKey(model, fg);
    } else {
        Object.assign(req, clusteringFields(model));
    }
    if (opts.expectedGeneration !== undefined) req.expected_generation = opts.expectedGeneration;
    return req;
}
