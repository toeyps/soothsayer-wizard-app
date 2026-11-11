import type { FailureGroupStateSlice, FailureModel, WorkspaceState } from '../types';
import { STIFFNESS_LEGACY_DEFAULT, snapStiffness } from '../components/reports/pmReportTypes';
import { withFailureGroupState } from './failureGroupState';
import { effectiveRunningCondition } from './runningCondition';
import { testPeriodsKey } from './timePeriods';
import { computeTrainFingerprint } from './trainFingerprint';
import { migratePeriods } from './workspaceMigrations';
import { demoteModelsForRecipeChange, stampTrainedFormulas } from './specialSensorSignature';
import { sameHealthSetPoints } from './healthSetPoints';

/** A training-input change (periods, running condition incl. the workspace's for Workspace-mode models, predictors, Y/X/criteria sensors, clusters/ranges, stiffness) sets a Complete model to `status: false` in the same write; set points, `lastTrainedAt` and `trainedFingerprint` are kept, `healthVerdict` is dropped. Pure `(prev, next) => next`, run inside a write against disk state; idempotent. Set-point and scoring-only changes take other roads: see `applyIncompleteRule`. */

/** Fingerprint to detect changes between writes: `computeTrainFingerprint` with draft defaults applied, so materialising defaults is not a change. Never stored. */
function changeFingerprint(model: FailureModel, fg: Partial<FailureGroupStateSlice>): string {
    // Hand-written / very old records may lack list fields; the fingerprint
    // needs them to be arrays.
    let m: FailureModel = Array.isArray(model.predictorSensors) ? model : { ...model, predictorSensors: [] };
    if (model.kind === 'relationship') {
        const lambda = snapStiffness(typeof model.relStiffness === 'number' ? model.relStiffness : STIFFNESS_LEGACY_DEFAULT);
        if (lambda !== model.relStiffness) m = { ...m, relStiffness: lambda };
    } else if (model.kind === 'clustering') {
        if (model.numClusters === undefined || model.numClusters === null) m = { ...m, numClusters: 3 };
    }
    return computeTrainFingerprint(m, fg);
}

/** Slice with legacy time ranges turned into periods, so the one-time migration write isn't read as an edit. */
function normalizedSlice(state: WorkspaceState): FailureGroupStateSlice | undefined {
    return migratePeriods(state).failureGroupState;
}

/** Slice shape the comparisons read; missing running-condition fields read as defaults. */
type RuleSlice = Partial<FailureGroupStateSlice> & { models: FailureModel[] };

/** Ids of models in `nextFg` whose `changeFingerprint` differs from `prevFg`; models on one side only are ignored. Slice-level so callers that predict a write run the same rule. */
export function changedTrainInputIds(prevFg: RuleSlice, nextFg: RuleSlice): string[] {
    const before = new Map(prevFg.models.map(m => [m.id, m]));
    const changed: string[] = [];
    for (const m of nextFg.models) {
        const old = before.get(m.id);
        if (!old) continue;
        if (changeFingerprint(old, prevFg) !== changeFingerprint(m, nextFg)) changed.push(m.id);
    }
    return changed;
}

/** Ids of models whose effective scoring periods (`testPeriodsKey`) differ; slice-level like `changedTrainInputIds`. */
export function changedScoringPeriodIds(prevFg: RuleSlice, nextFg: RuleSlice): string[] {
    const before = new Map(prevFg.models.map(m => [m.id, m]));
    const changed: string[] = [];
    for (const m of nextFg.models) {
        const old = before.get(m.id);
        if (!old) continue;
        const a = testPeriodsKey(effectiveRunningCondition(old, prevFg).testPeriods);
        const b = testPeriodsKey(effectiveRunningCondition(m, nextFg).testPeriods);
        if (a !== b) changed.push(m.id);
    }
    return changed;
}

/** Ids of models Complete on both sides whose set points differ (master snapshots ignored); a write that completes a model is not included. */
export function modelsWithChangedSetPoints(prev: WorkspaceState, next: WorkspaceState): string[] {
    const prevFg = prev.failureGroupState;
    const nextFg = next.failureGroupState;
    if (!prevFg || !nextFg || !Array.isArray(prevFg.models) || !Array.isArray(nextFg.models)) return [];
    const before = new Map(prevFg.models.map(m => [m.id, m]));
    const changed: string[] = [];
    for (const m of nextFg.models) {
        const old = before.get(m.id);
        if (!old || !old.status || !m.status) continue;
        if (!sameHealthSetPoints(old.healthSetPoints, m.healthSetPoints)) changed.push(m.id);
    }
    return changed;
}

/** Ids of models in `next` whose training inputs differ from `prev`; one-sided models are ignored. */
export function modelsWithChangedInputs(prev: WorkspaceState, next: WorkspaceState): string[] {
    const prevFg = normalizedSlice(prev);
    const nextFg = normalizedSlice(next);
    if (!prevFg || !nextFg) return [];
    return changedTrainInputIds(prevFg, nextFg);
}

/** Ids of models whose effective SCORING periods differ (only start/end count); one-sided models are ignored. */
export function modelsWithChangedTests(prev: WorkspaceState, next: WorkspaceState): string[] {
    const prevFg = prev.failureGroupState;
    const nextFg = next.failureGroupState;
    if (!prevFg || !nextFg || !Array.isArray(prevFg.models) || !Array.isArray(nextFg.models)) return [];
    return changedScoringPeriodIds(prevFg, nextFg);
}

export interface IncompleteRuleOptions {
    /** ISO time written to `testsChangedAt` (tests pass a fixed value). */
    now?: string;
}

/** Returns `next` with every Complete model whose inputs changed set to `status: false` (same reference if none); idempotent. Roads: training input -> Incomplete + stale, drops `testsChangedAt`; scoring-only -> Incomplete + `testsChangedAt`, stays trained; set points only (Complete before and after) -> Incomplete, stays trained; special-sensor recipe change -> Incomplete and stale. */
export function applyIncompleteRule(prev: WorkspaceState, prevNext: WorkspaceState, opts: IncompleteRuleOptions = {}): WorkspaceState {
    const next = applyRecipeRule(prev, stampTrainedFormulas(prev, prevNext));
    const fg = next.failureGroupState;
    // A model carrying only a saved verdict or `testsChangedAt` also needs the pass: a training-input change drops them.
    if (!fg || !Array.isArray(fg.models) || !fg.models.some(m => m.status || m.healthVerdict !== undefined || m.testsChangedAt !== undefined)) return next;
    let changed: Set<string>;
    let testsChanged: Set<string>;
    let setPointsChanged: Set<string>;
    try {
        changed = new Set(modelsWithChangedInputs(prev, next));
        const anyComplete = fg.models.some(m => m.status);
        testsChanged = anyComplete ? new Set(modelsWithChangedTests(prev, next)) : new Set();
        setPointsChanged = anyComplete ? new Set(modelsWithChangedSetPoints(prev, next)) : new Set();
    } catch (e) {
        // A malformed record must never make a workspace write fail: this rule is
        // a guard on top of the write, not part of it.
        console.warn('applyIncompleteRule: could not compare model inputs, leaving statuses alone:', e);
        return next;
    }
    if (changed.size === 0 && testsChanged.size === 0 && setPointsChanged.size === 0) return next;
    let demoted = false;
    let stamp: string | undefined;
    const models = fg.models.map(m => {
        if (changed.has(m.id)) {
            if (!m.status && m.healthVerdict === undefined && m.testsChangedAt === undefined) return m;
            demoted = true;
            // The train rule wins over a tests-only change: the model needs a re-train, so drop `testsChangedAt`.
            const { healthVerdict: dropped, testsChangedAt: droppedStamp, ...rest } = m;
            void dropped;
            void droppedStamp;
            return m.status ? { ...rest, status: false } : rest;
        }
        if (testsChanged.has(m.id) && m.status) {
            demoted = true;
            stamp ??= opts.now ?? new Date().toISOString();
            return { ...m, status: false, testsChangedAt: stamp };
        }
        if (setPointsChanged.has(m.id) && m.status) {
            demoted = true;
            return { ...m, status: false };
        }
        return m;
    });
    return demoted ? withFailureGroupState(next, { models }) : next;
}

/** Do two recipe lists differ in content (a rebuilt identical list is not a change)? Missing = empty. */
export function recipesDiffer(
    a: WorkspaceState['specialSensorRecipes'],
    b: WorkspaceState['specialSensorRecipes'],
): boolean {
    if (a === b) return false;
    return JSON.stringify(a ?? []) !== JSON.stringify(b ?? []);
}

/** Step 2 of `applyIncompleteRule` (see there). Returns `next` itself when
 *  nothing is demoted. Never makes a write fail. */
export function applyRecipeRule(prev: WorkspaceState, next: WorkspaceState): WorkspaceState {
    const fg = next.failureGroupState;
    if (!fg || !Array.isArray(fg.models)) return next;
    const anyTrained = fg.models.some(m => m.status || m.trainedFingerprint !== undefined || m.healthVerdict !== undefined || m.testsChangedAt !== undefined);
    if (!anyTrained) return next;
    const recipesChanged = recipesDiffer(prev.specialSensorRecipes, next.specialSensorRecipes);
    if (!recipesChanged && !fg.models.some(m => m.trainedFormulas)) return next;
    try {
        const { models } = demoteModelsForRecipeChange(fg.models, fg, prev.specialSensorRecipes, next.specialSensorRecipes);
        return models === fg.models ? next : withFailureGroupState(next, { models });
    } catch (e) {
        console.warn('applyIncompleteRule: could not compare special-sensor recipes, leaving statuses alone:', e);
        return next;
    }
}
