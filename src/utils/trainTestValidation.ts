import type { FailureModel } from '../types';
import type { HealthIssue, HealthPreview } from '../types/health';
import { isModelStale } from './modelStatus';
import { effectiveRunningCondition, type RunningConditionFg } from './runningCondition';

/*
 * Train/Test model validation (SPEC FINAL 2026-10-07,
 * docs/design/handoff/train-test-validation/README.md) — the pure read-side
 * helpers the UI shows: the "test periods changed" banners (rule 8) and the
 * minimum-training-data warning (rule 12).
 */

/**
 * Recommended minimum of TRAIN running time, in days (SPEC rule 12).
 *
 * DECISION (2026-10-07, made with the user's worry in mind that a hard minimum
 * would stop them training when they only have a little data): there is NO
 * hard block on the number of days — the SPEC's "[MIN DAYS] blocks Train"
 * level is deliberately not built. Only the technical errors Rust already
 * returns (e.g. `NO_DATA` — no row left to fit) stop a Train. Below this
 * recommendation the UI shows an AMBER warning only. Change the number here;
 * nothing else hard-codes it.
 */
export const RECOMMENDED_TRAIN_DAYS = 30;

/** True when a known train running time is below `RECOMMENDED_TRAIN_DAYS`.
 *  `null`/`undefined`/non-finite (not computed yet) is never "below". */
export function isBelowRecommendedTrainDays(trainDays: number | null | undefined): boolean {
    return typeof trainDays === 'number' && Number.isFinite(trainDays) && trainDays < RECOMMENDED_TRAIN_DAYS;
}

/** The amber warning text, or null when there is enough (or unknown) train time.
 *  Pass the RUNNING days of the train rows (`test_validation.train.days`, or
 *  the row-count preview's figure). Never a block. */
export function trainDaysWarning(trainDays: number | null | undefined): string | null {
    if (!isBelowRecommendedTrainDays(trainDays)) return null;
    const d = Math.max(0, Math.round(trainDays as number));
    return `Only ${d} d of train running time — at least ${RECOMMENDED_TRAIN_DAYS} d is recommended for a reliable model. You can still train.`;
}

/** Per-model banner state on the Health score page (SPEC rule 8). */
export type TestsChangedState = 'changed' | 'removed';

/**
 * Does this model need "Mark complete" again because ONLY its test periods
 * changed while it was Complete (`applyIncompleteRule` set `testsChangedAt`)?
 * `'removed'` when its effective test list is now empty, `'changed'` otherwise,
 * `null` when there is nothing to say (no stamp, or it is Complete again).
 */
export function testsChangedState(model: FailureModel, fg: RunningConditionFg): TestsChangedState | null {
    if (!model.testsChangedAt || model.status) return null;
    // A model whose TRAINING inputs changed since (stale) needs a re-train first;
    // "Mark complete again" would be the wrong advice (the train rule wins). The
    // write side drops the stamp too (`applyIncompleteRule`); this covers a
    // pending draft and data written before that rule.
    if (isModelStale(model, fg)) return null;
    return effectiveRunningCondition(model, fg).testPeriods.length === 0 ? 'removed' : 'changed';
}

/** Health score page banner text for `testsChangedState`. */
export function testsChangedBannerText(state: TestsChangedState): string {
    return state === 'removed'
        ? 'Test periods removed — add at least one test period, then Mark complete again. The model was not re-trained.'
        : 'Test periods changed — the results were re-scored with the same trained model. Mark complete again to save them.';
}

/** Workspace-wide summary for the notice under the Step-1 card. */
export interface TestsChangedNotice {
    /** Models that were Complete and need Mark complete again. */
    count: number;
    /** Every one of them now has NO test period. */
    allRemoved: boolean;
}

/** `null` when no model needs Mark complete again because of a test change. */
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

/** The Step-1 notice text: "Test periods changed — N complete model(s) need
 *  Mark complete again" (or "Test periods removed — …" when every one of them
 *  lost all its test periods). */
export function testsChangedNoticeText(n: TestsChangedNotice): string {
    const models = `${n.count} complete model${n.count === 1 ? '' : 's'}`;
    const need = n.count === 1 ? 'needs' : 'need';
    return n.allRemoved
        ? `Test periods removed — ${models} ${need} a test period and Mark complete again`
        : `Test periods changed — ${models} ${need} Mark complete again`;
}

/** Stable code of the WARNING issue `compute_health_preview` adds when the test
 *  periods could not be scored (e.g. the Relation model engine did not answer,
 *  or is too old). The train results are still valid; every test then comes
 *  back unscored. */
export const TEST_SCORING_FAILED_CODE = 'test_scoring_failed';

/** Same, but the Relation model engine bundled with this build is too old to
 *  score test periods (2026-10-07). Retrying cannot help — only updating the
 *  app does — so this one gets no "Try again". */
export const TEST_SCORING_OUTDATED_CODE = 'test_scoring_outdated';

/** Both warning codes that mean "the test periods were not scored". */
export const TEST_SCORING_ISSUE_CODES: readonly string[] = [TEST_SCORING_FAILED_CODE, TEST_SCORING_OUTDATED_CODE];

/** Headline the test tiles / "Train vs test" card show for `test_scoring_failed`
 *  (amber, information only — never a block). Rust's own `message` is shown under
 *  it (it says why, e.g. too many rows to score in memory). */
export const TEST_SCORING_FAILED_TEXT = "Couldn't score the test periods — try again";

/** Headline for `test_scoring_outdated` (no retry offered). */
export const TEST_SCORING_OUTDATED_TEXT = "Couldn't score the test periods";

/** The test-scoring warning of a preview (`test_scoring_failed` or
 *  `test_scoring_outdated`), or null. */
export function testScoringFailure(data: Pick<HealthPreview, 'validation'> | null | undefined): HealthIssue | null {
    return data?.validation?.find(i => TEST_SCORING_ISSUE_CODES.includes(i.code)) ?? null;
}

/** Whether "Try again" can help for this test-scoring warning. */
export function isTestScoringRetryable(issue: Pick<HealthIssue, 'code'>): boolean {
    return issue.code === TEST_SCORING_FAILED_CODE;
}

/** Shown while a Relation-model preview that scores test periods is still
 *  loading (the sidecar predicts the test rows — slow the first time). */
export const SLOW_TEST_SCORING_TEXT = 'Scoring test periods with the Relation model — this can take up to ~15 s.';
