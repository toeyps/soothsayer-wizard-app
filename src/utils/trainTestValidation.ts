import type { FailureModel } from '../types';
import type { HealthIssue, HealthPreview } from '../types/health';
import { isModelStale } from './modelStatus';
import { effectiveRunningCondition, type RunningConditionFg } from './runningCondition';

/* Read-side helpers for train/scoring periods. Identifiers keep 'test' names (`testsChangedAt` is a storage key); the user reads 'scoring period'. */

/** Recommended minimum TRAIN running days; below it the UI shows an amber warning, never a block. Change it only here. */
export const RECOMMENDED_TRAIN_DAYS = 30;

/** True when a known train running time is below the recommendation; unknown is never below. */
export function isBelowRecommendedTrainDays(trainDays: number | null | undefined): boolean {
    return typeof trainDays === 'number' && Number.isFinite(trainDays) && trainDays < RECOMMENDED_TRAIN_DAYS;
}

/** Amber warning text, or null when enough/unknown. Pass the running days of the train rows. Never a block. */
export function trainDaysWarning(trainDays: number | null | undefined): string | null {
    if (!isBelowRecommendedTrainDays(trainDays)) return null;
    const d = Math.max(0, Math.round(trainDays as number));
    return `Only ${d} d of train running time — at least ${RECOMMENDED_TRAIN_DAYS} d is recommended for a reliable model. You can still train.`;
}

/** Per-model banner state on the Health score page. */
export type TestsChangedState = 'changed' | 'removed';

/** Does this model need 'Mark complete' again because only its scoring periods changed (`testsChangedAt`)? 'removed' when none are left, 'changed' otherwise, null when nothing to say. */
export function testsChangedState(model: FailureModel, fg: RunningConditionFg): TestsChangedState | null {
    if (!model.testsChangedAt || model.status) return null;
    // A stale model needs a re-train first; the write side drops the stamp too, this covers pending drafts and older data.
    if (isModelStale(model, fg)) return null;
    return effectiveRunningCondition(model, fg).testPeriods.length === 0 ? 'removed' : 'changed';
}

/** Health score page banner text for `testsChangedState`. */
export function testsChangedBannerText(state: TestsChangedState): string {
    return state === 'removed'
        ? 'Scoring periods removed — add at least one scoring period, then Mark complete again. The model was not re-trained.'
        : 'Scoring periods changed — re-scored with the same trained model. Mark complete again to confirm the new results.';
}

/** Workspace-wide summary for the notice under the running-condition line. */
export interface TestsChangedNotice {
    /** Models that were Complete and need Mark complete again. */
    count: number;
    /** Every one of them now has NO scoring period. */
    allRemoved: boolean;
}

/** `null` when no model needs Mark complete again because of a scoring-period change. */
export function testsChangedNotice(models: FailureModel[], fg: RunningConditionFg): TestsChangedNotice | null {
    let count = 0;
    let removed = 0;
    for (const m of models) {
        const st = testsChangedState(m, fg);
        if (!st) continue;
        count += 1;
        if (st === 'removed') removed += 1;
    }
    return count === 0 ? null : { count, allRemoved: removed === count };
}

/** Notice under the running-condition line: bold `headline` (no full stop) plus a one-sentence `rest`; the text differs when every model lost all its scoring periods. */
export function testsChangedNoticeParts(n: TestsChangedNotice): { headline: string; rest: string } {
    const one = n.count === 1;
    const models = `${n.count} complete model${one ? '' : 's'}`;
    const need = one ? 'needs' : 'need';
    const they = one ? 'It was' : 'They were';
    return n.allRemoved
        ? { headline: `Scoring periods removed — ${models} ${need} a scoring period and Mark complete again`, rest: `${they} not re-trained.` }
        : { headline: `Scoring periods changed — ${models} ${need} Mark complete again`, rest: `${they} re-scored with the same trained model, not re-trained.` };
}

/** Code of the WARNING when the Relation model engine couldn't predict the points to score. Scores use 1-hour means, so the WHOLE health score is missing, even with no scoring period; the model fit is unaffected. */
export const TEST_SCORING_FAILED_CODE = 'test_scoring_failed';

/** Same, but the bundled engine is too old to score; retrying can't help, so no 'Try again'. */
export const TEST_SCORING_OUTDATED_CODE = 'test_scoring_outdated';

/** Same, but the scoring periods have too many rows for memory; retrying fails the same way, so no 'Try again'. */
export const TEST_SCORING_TOO_LARGE_CODE = 'test_scoring_too_large';

/** Every warning code that means "the health score could not be calculated". */
export const TEST_SCORING_ISSUE_CODES: readonly string[] = [TEST_SCORING_FAILED_CODE, TEST_SCORING_OUTDATED_CODE, TEST_SCORING_TOO_LARGE_CODE];

/** Amber headline for `test_scoring_failed` (never a block); Rust's `message` goes under it. */
export const TEST_SCORING_FAILED_TEXT = 'The health score could not be calculated — try again';

/** Headline when no retry is offered (`test_scoring_outdated`,
 *  `test_scoring_too_large`); Rust's message underneath says what to do. */
export const TEST_SCORING_OUTDATED_TEXT = 'The health score could not be calculated';

/** The 'could not be calculated' warning of a preview, or null; it can come even with no scoring period. */
export function testScoringFailure(data: Pick<HealthPreview, 'validation'> | null | undefined): HealthIssue | null {
    return data?.validation?.find(i => TEST_SCORING_ISSUE_CODES.includes(i.code)) ?? null;
}

/** 'Try again' helps only when the engine did not answer. */
export function isTestScoringRetryable(issue: Pick<HealthIssue, 'code'>): boolean {
    return issue.code === TEST_SCORING_FAILED_CODE;
}

/** Shown while a Relation-model preview waits on the engine (slow the first time). */
export const SLOW_TEST_SCORING_TEXT = 'Calculating the health score with the Relation model — this can take up to ~15 s.';
