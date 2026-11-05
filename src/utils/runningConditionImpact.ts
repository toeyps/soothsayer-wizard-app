import type { FailureModel, TestPeriod, TimePeriod, WorkspaceSensorFilter } from '../types';
import { changedScoringPeriodIds, changedTrainInputIds } from './incompleteRule';
import { isModelComplete, type StatusRecipes } from './modelStatus';
import type { RunningConditionFg } from './runningCondition';
import { testPeriodsKey } from './timePeriods';
import { isModelTrainedFresh } from './trainFingerprint';

/* Impact line before Apply and notice after it; affected models come from `changedTrainInputIds`/`changedScoringPeriodIds`. */

/** The workspace running condition as the settings modal edits it (the
 *  window's `RcDraft`). */
export interface RunningConditionDraft {
    filters: WorkspaceSensorFilter[];
    combine: 'and' | 'or';
    /** TRAIN periods. */
    periods: TimePeriod[];
    allData: boolean;
    /** SCORING periods. */
    testPeriods: TestPeriod[];
}

/** `fg` as it would be after applying `draft`, for predictions only; the write goes through `withFailureGroupState`. */
function withDraft(fg: NonNullable<RunningConditionFg>, draft: RunningConditionDraft): NonNullable<RunningConditionFg> {
    return {
        ...fg,
        runningConditionFilters: draft.filters,
        runningConditionCombine: draft.combine,
        runningConditionTimePeriods: draft.periods,
        runningConditionAllData: draft.allData,
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
    /** Workspace-mode models trained (or Complete) that would need training again; kept at Apply for the after-Apply notice. */
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

/** Effect of applying `draft` on Workspace-mode models: train change = retrain; scoring-only = Mark complete again; else grey. Custom models are never counted; pure; show only while the draft is dirty. */
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
            // Trained and fresh, or Complete (an old Complete model without a fingerprint still goes Incomplete).
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

/** Models an Apply sent back to training that are still untrained; deleted or since-trained ones drop out. Session-only. */
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

/** After-Apply notice in two parts so the UI can bold the headline. */
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

