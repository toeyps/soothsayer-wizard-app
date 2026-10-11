import type { FailureGroupStateSlice, FailureModel, WorkspaceState } from '../types';
import { STIFFNESS_DEFAULT, snapStiffness } from '../components/reports/pmReportTypes';
import { withFailureGroupState } from './failureGroupState';
import { effectiveRunningCondition } from './runningCondition';
import { testPeriodsKey } from './timePeriods';
import { computeTrainFingerprint } from './trainFingerprint';
import { migratePeriods } from './workspaceMigrations';
import { demoteModelsForRecipeChange, stampTrainedFormulas } from './specialSensorSignature';

/**
 * "Incomplete immediately".
 *
 * Changing ANY input that decides what a model is trained on —
 *   training period(s), the running condition in every part (Workspace/Custom
 *   switch, conditions, AND/OR, the "no condition" choice, periods — and for a
 *   Workspace-mode model that includes the WORKSPACE running condition),
 *   predictor sensors, the Y / X / criteria sensors, the number of clusters /
 *   criteria ranges, stiffness —
 * sets a Complete model back to Incomplete (`status: false`) IMMEDIATELY, in
 * the same write, without waiting for anything to be re-checked. It keeps its
 * set points, `lastTrainedAt` and `trainedFingerprint`; the mismatch with the
 * current inputs is what then shows it as out of date with a Re-train.
 *
 * The same change also drops a saved `healthVerdict` (it described the old fit).
 *
 * What does NOT trigger it: set points, name, notes, category, status, group
 * membership, `scatterXSensor` — none of them is in `computeTrainFingerprint`.
 * SCORING periods are not in it either; a
 * change of ONLY them takes the second road described on `applyIncompleteRule`
 * (Complete -> Incomplete + `testsChangedAt`, but still trained).
 *
 * This is a pure `(prev, next) => next` step meant to run INSIDE a workspace
 * write (the updater passed to `updateWorkspaceData`), against the state the
 * write read from disk (`prev`) and the state it is about to save (`next`):
 * `updateWorkspaceData` applies it to every write, and the Build Model window's
 * own writers apply it too (idempotent — a second pass sees no change).
 */

/**
 * The inputs fingerprint used to DETECT a change between two writes. It is
 * `computeTrainFingerprint` run on a model with the defaults a draft would fill
 * in already applied (a missing stiffness / cluster count / default ranges),
 * so a write that merely materialises those defaults — e.g. saving a new model
 * name from the Workbench, whose draft re-derives them — is not mistaken for a
 * real change. The persisted `trainedFingerprint` is never produced from this.
 */
function changeFingerprint(model: FailureModel, fg: Partial<FailureGroupStateSlice>): string {
    // Hand-written / very old records may lack list fields; the fingerprint
    // needs them to be arrays.
    let m: FailureModel = Array.isArray(model.predictorSensors) ? model : { ...model, predictorSensors: [] };
    if (model.kind === 'relationship') {
        const lambda = snapStiffness(typeof model.relStiffness === 'number' ? model.relStiffness : STIFFNESS_DEFAULT);
        if (lambda !== model.relStiffness) m = { ...m, relStiffness: lambda };
    } else if (model.kind === 'clustering') {
        if (model.numClusters === undefined || model.numClusters === null) m = { ...m, numClusters: 3 };
    }
    return computeTrainFingerprint(m, fg);
}

/** The slice as `computeTrainFingerprint` should see it: legacy single time
 *  ranges already turned into periods (the same step the Workbench runs on
 *  open), so the one-time migration write is not read as an edit. */
function normalizedSlice(state: WorkspaceState): FailureGroupStateSlice | undefined {
    return migratePeriods(state).failureGroupState;
}

/** The slice shape the two comparisons below read: the models plus whatever
 *  running-condition fields are there (a missing one reads as its default). */
type RuleSlice = Partial<FailureGroupStateSlice> & { models: FailureModel[] };

/**
 * THE comparison behind "training inputs changed": ids of the models in
 * `nextFg` whose `changeFingerprint` differs from the same model in `prevFg`
 * (models that only exist on one side are ignored — nothing to compare).
 * Slice-level so that a caller that only PREDICTS a write — the
 * Running-condition settings' "Applying sets N models back to Incomplete"
 * line (`runningConditionImpact`) — runs the very rule the write will run,
 * not a copy of it.
 */
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

/**
 * THE comparison behind "scoring periods changed": ids of the models in
 * `nextFg` whose EFFECTIVE scoring periods (`testPeriodsKey` — start / end in
 * list order, nothing else) differ from the same model in `prevFg`. Slice-level
 * for the same reason as `changedTrainInputIds`.
 */
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

/** Ids of the models in `next` whose training inputs differ from `prev`
 *  (models that only exist on one side are ignored — nothing to compare). */
export function modelsWithChangedInputs(prev: WorkspaceState, next: WorkspaceState): string[] {
    const prevFg = normalizedSlice(prev);
    const nextFg = normalizedSlice(next);
    if (!prevFg || !nextFg) return [];
    return changedTrainInputIds(prevFg, nextFg);
}

/**
 * Ids of the models in `next` whose EFFECTIVE SCORING periods differ from
 * `prev` (workspace list for a Workspace-mode model, `customTestPeriods` for a
 * Custom one). Only each period's start / end counts (`testPeriodsKey`): ids
 * and the legacy `label` / `eventTime` / `fromHighlight` keys of an old
 * workspace file are ignored, so a period that merely loses those
 * keys in a write is not a change. Models only on one side are ignored.
 */
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

/**
 * `next`, with every Complete model whose training inputs changed between
 * `prev` and `next` set back to `status: false`. Returns `next` itself (same
 * reference) when nothing needs demoting, so callers can cheaply tell.
 *
 * Train periods vs scoring periods:
 *  - a TRAINING-input change (incl. train periods): Incomplete, and the
 *    fingerprint mismatch asks for a re-train; it also
 *    drops any `testsChangedAt` stamp (the train rule wins — the model needs a
 *    re-train, not just Mark complete again);
 *  - a change of ONLY the model's effective SCORING periods (a start or an
 *    end, a period added or removed) keeps it trained (they are not in
 *    `computeTrainFingerprint`, so it stays fresh) but a Complete model goes
 *    back to `status: false` and gets `testsChangedAt` in the SAME write — the
 *    scoring results in its saved files no longer match. Its
 *    `healthVerdict` is kept (the set points still describe the same fit).
 *    Not-Complete models are left alone (nothing to mark again).
 * Idempotent: a second pass finds no Complete model to demote.
 *
 * Special-sensor recipes (editing a special sensor's formula makes the models
 * trained on it stale).
 * Two steps run first, in the same write:
 *  1. `stampTrainedFormulas`: a model whose train record this write changes
 *     (a Train) gets `trainedFormulas` -- the signatures of the special
 *     sensors it trains on, from the recipes on disk in this write;
 *  2. `applyRecipeRule`: a model that trains on a special sensor whose recipe
 *     (or the recipe of anything it is built on) differs between `prev` and
 *     `next`, or whose `trainedFormulas` no longer match `next`'s recipes, goes
 *     back to Incomplete AND out of date (`demoteModelsForRecipeChange`: like
 *     a repair -- the fingerprint cannot see a recipe, so it is dropped).
 * A model with no `trainedFormulas` snapshot is only affected
 * by a real recipe change in a write -- never by the upgrade itself.
 */
export function applyIncompleteRule(prev: WorkspaceState, prevNext: WorkspaceState, opts: IncompleteRuleOptions = {}): WorkspaceState {
    const next = applyRecipeRule(prev, stampTrainedFormulas(prev, prevNext));
    const fg = next.failureGroupState;
    // A model also needs the pass when it only carries a saved set-point verdict:
    // that verdict describes the OLD fit and is dropped with the change
    // even though a not-yet-Complete model has no status to demote.
    // Same for a leftover `testsChangedAt` stamp: a training-input change drops it.
    if (!fg || !Array.isArray(fg.models) || !fg.models.some(m => m.status || m.healthVerdict !== undefined || m.testsChangedAt !== undefined)) return next;
    let changed: Set<string>;
    let testsChanged: Set<string>;
    try {
        changed = new Set(modelsWithChangedInputs(prev, next));
        testsChanged = fg.models.some(m => m.status) ? new Set(modelsWithChangedTests(prev, next)) : new Set();
    } catch (e) {
        // A malformed record must never make a workspace write fail: this rule is
        // a guard on top of the write, not part of it.
        console.warn('applyIncompleteRule: could not compare model inputs, leaving statuses alone:', e);
        return next;
    }
    if (changed.size === 0 && testsChanged.size === 0) return next;
    let demoted = false;
    let stamp: string | undefined;
    const models = fg.models.map(m => {
        if (changed.has(m.id)) {
            if (!m.status && m.healthVerdict === undefined && m.testsChangedAt === undefined) return m;
            demoted = true;
            // The train rule wins over a "tests only" change: the model now needs a
            // re-train, so a `testsChangedAt` stamp (from this write or an earlier one)
            // is dropped — the "Mark complete again" banners must not outlive it.
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
        return m;
    });
    return demoted ? withFailureGroupState(next, { models }) : next;
}

/** Do two recipe lists differ in CONTENT? (A write that re-built the same list
 *  is a new array, not a change.) Missing lists read as empty. */
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
