import type { FailureModel, TestPeriod, TimePeriod, WorkspaceSensorFilter } from '../types';
import { changedScoringPeriodIds, changedTrainInputIds } from './incompleteRule';
import { isModelComplete, type StatusRecipes } from './modelStatus';
import type { RunningConditionFg } from './runningCondition';
import { testPeriodsKey } from './timePeriods';
import { isModelTrainedFresh } from './trainFingerprint';

/*
 * "Change warnings" of the Running-condition settings (spec:
 * docs/design/handoff/workbench-redesign/README.md §5):
 *
 *   BEFORE Apply — an impact line next to the Apply button says what applying
 *   the draft does to the models that follow the workspace running condition.
 *   It never blocks Apply.
 *
 *   AFTER Apply — a notice under the running-condition line while models the
 *   Apply sent back to training are still not trained again (session-only; the
 *   amber dots in the list are what persists).
 *
 * Nothing here decides WHICH models a change affects on its own: the two
 * comparisons are `changedTrainInputIds` / `changedScoringPeriodIds`, the same
 * functions `applyIncompleteRule` runs inside the write. This file only turns
 * their answer into counts and sentences.
 */

/** The workspace running condition as the settings modal edits it (the
 *  window's `RcDraft`). */
export interface RunningConditionDraft {
    filters: WorkspaceSensorFilter[];
    combine: 'and' | 'or';
    /** TRAIN periods. */
    periods: TimePeriod[];
    noneConfirmed: boolean;
    /** SCORING periods. */
    testPeriods: TestPeriod[];
}

/** The persisted workspace running condition of `fg`, in draft shape (missing
 *  fields read as their defaults). */
export function runningConditionDraftOf(fg: RunningConditionFg): RunningConditionDraft {
    return {
        filters: fg?.runningConditionFilters ?? [],
        combine: fg?.runningConditionCombine ?? 'and',
        periods: fg?.runningConditionTimePeriods ?? [],
        noneConfirmed: fg?.runningConditionNoneConfirmed ?? false,
        testPeriods: fg?.runningConditionTestPeriods ?? [],
    };
}

/** `fg` as it would be after applying `draft`: everything else in the slice is
 *  carried over untouched (models, groups, and any field added later). For
 *  predictions only — the write itself goes through `withFailureGroupState`. */
function withDraft(fg: NonNullable<RunningConditionFg>, draft: RunningConditionDraft): NonNullable<RunningConditionFg> {
    return {
        ...fg,
        runningConditionFilters: draft.filters,
        runningConditionCombine: draft.combine,
        runningConditionTimePeriods: draft.periods,
        runningConditionNoneConfirmed: draft.noneConfirmed,
        runningConditionTestPeriods: draft.testPeriods,
    };
}

export interface RunningConditionImpact {
    /** `amber` when at least one model is affected, `grey` when none is. */
    tone: 'amber' | 'grey';
    /** The impact line. */
    text: string;
    /** A second, quiet line under it, or null. */
    quiet: string | null;
    /** Workspace-mode models that are trained (or Complete) today and would
     *  need training again. Keep these at Apply time for the after-Apply notice
     *  (`modelsStillNeedingTraining`). */
    retrainIds: string[];
    /** Complete Workspace-mode models that stay trained but would need Mark
     *  complete again (only their scoring periods change). */
    remarkIds: string[];
    /** The draft changes what at least one Workspace-mode model trains on. */
    trainChanged: boolean;
    /** The draft's scoring periods differ from the persisted ones (start / end
     *  in list order — ids and legacy keys do not count). */
    scoringChanged: boolean;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "No trained or complete model is affected by this change" — the grey line. */
export const NO_IMPACT_TEXT = 'No trained or complete model is affected by this change';
/** The quiet second line when both the training side and the scoring periods changed. */
export const SCORED_WHEN_TRAINED_TEXT = 'The new scoring periods are scored when they are trained again';

/** "Applying sets N models back to Incomplete — they need training again". */
export function retrainImpactText(n: number): string {
    return `Applying sets ${count(n, 'model', 'models')} back to Incomplete — ${n === 1 ? 'it needs' : 'they need'} training again`;
}

/** "N complete models will need Mark complete again (re-score, no training)". */
export function remarkImpactText(n: number): string {
    return `${count(n, 'complete model', 'complete models')} will need Mark complete again (re-score, no training)`;
}

/**
 * What applying `draft` over the persisted failure-group state `fg` does to
 * the models:
 *
 *   - the train periods or the condition changed  → amber "Applying sets N
 *     models back to Incomplete — they need training again"; N = Workspace-mode
 *     models that are trained and fresh (or Complete) today and whose train
 *     fingerprint changes;
 *   - only the scoring periods changed            → amber "N complete models
 *     will need Mark complete again (re-score, no training)";
 *   - both changed                                → the train line, plus the
 *     quiet line "The new scoring periods are scored when they are trained again";
 *   - nothing affected (N = 0, with or without a change) → grey "No trained or
 *     complete model is affected by this change".
 *
 * Custom-mode models are never counted: they do not read the workspace
 * running condition. `recipes` (the workspace's special-sensor recipes) makes
 * "trained and fresh" agree with the status dots; pass them when at hand.
 *
 * Pure. Show the line only while the draft is dirty — for an unchanged draft
 * this returns the grey line, which would be noise.
 */
export function runningConditionImpact(
    fg: RunningConditionFg,
    draft: RunningConditionDraft,
    opts: { recipes?: StatusRecipes } = {},
): RunningConditionImpact {
    const scoringChanged = testPeriodsKey(draft.testPeriods) !== testPeriodsKey(fg?.runningConditionTestPeriods);
    const models: FailureModel[] = Array.isArray(fg?.models) ? fg.models : [];
    const none: RunningConditionImpact = {
        tone: 'grey', text: NO_IMPACT_TEXT, quiet: null, retrainIds: [], remarkIds: [], trainChanged: false, scoringChanged,
    };
    if (!fg || models.length === 0) return none;

    const prev = { ...fg, models };
    const next = { ...withDraft(fg, draft), models };
    let trainIds: Set<string>;
    let scoreIds: Set<string>;
    try {
        trainIds = new Set(changedTrainInputIds(prev, next));
        scoreIds = new Set(changedScoringPeriodIds(prev, next));
    } catch (e) {
        // A malformed model record must not break the modal's footer.
        console.warn('runningConditionImpact: could not compare the draft with the saved models:', e);
        return none;
    }

    const retrainIds: string[] = [];
    const remarkIds: string[] = [];
    for (const m of models) {
        if (m.runningConditionMode === 'custom') continue;
        if (trainIds.has(m.id)) {
            // Trained and fresh today, or Complete (a model marked complete before
            // train records existed has no fingerprint, but it goes back to
            // Incomplete all the same and has to be trained to get out of it).
            if (isModelTrainedFresh(m, fg, opts.recipes) || isModelComplete(m, fg, opts.recipes)) retrainIds.push(m.id);
        } else if (scoreIds.has(m.id) && isModelComplete(m, fg, opts.recipes)) {
            remarkIds.push(m.id);
        }
    }
    const trainChanged = models.some(m => m.runningConditionMode !== 'custom' && trainIds.has(m.id));
    const base = { retrainIds, remarkIds, trainChanged, scoringChanged };
    if (retrainIds.length > 0) {
        return { ...base, tone: 'amber', text: retrainImpactText(retrainIds.length), quiet: scoringChanged ? SCORED_WHEN_TRAINED_TEXT : null };
    }
    if (remarkIds.length > 0) {
        return { ...base, tone: 'amber', text: remarkImpactText(remarkIds.length), quiet: null };
    }
    return { ...base, tone: 'grey', text: NO_IMPACT_TEXT, quiet: null };
}

/**
 * Of the models an Apply sent back to training (`impact.retrainIds`, kept by
 * the window at Apply time), those that are STILL not trained again — the
 * after-Apply notice shows while this is not empty and counts it. A model
 * that was deleted, or trained since, drops out. Session-only by decision
 * (the amber dots in the list are what persists).
 */
export function modelsStillNeedingTraining(
    ids: readonly string[],
    models: readonly FailureModel[],
    fg: RunningConditionFg,
    recipes?: StatusRecipes,
): string[] {
    const byId = new Map(models.map(m => [m.id, m]));
    return ids.filter(id => {
        const m = byId.get(id);
        return !!m && !isModelTrainedFresh(m, fg, recipes);
    });
}

/**
 * The after-Apply notice, in two parts so the UI can set the headline in bold:
 *   "Running condition changed — 3 models need training again" +
 *   "Use Train all, or Train sensor on each one; the amber dots in the list show which."
 */
export function retrainNoticeParts(n: number): { headline: string; rest: string } {
    return n === 1
        ? {
            headline: 'Running condition changed — 1 model needs training again',
            rest: 'Use Train all, or Train sensor on it; the amber dot in the list shows which.',
        }
        : {
            headline: `Running condition changed — ${n} models need training again`,
            rest: 'Use Train all, or Train sensor on each one; the amber dots in the list show which.',
        };
}

/** `retrainNoticeParts` as one string: "Running condition changed — N models
 *  need training again. Use Train all, or Train sensor on each one; the amber
 *  dots in the list show which." */
export function retrainNoticeText(n: number): string {
    const { headline, rest } = retrainNoticeParts(n);
    return `${headline}. ${rest}`;
}
