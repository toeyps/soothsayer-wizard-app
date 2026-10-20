import type { FailureModel } from '../types';
import type { HealthIssue, HealthPreview } from '../types/health';
import { isModelStale } from './modelStatus';
import { effectiveRunningCondition, type RunningConditionFg } from './runningCondition';

/*
 * Train periods and scoring periods — the pure read-side helpers the UI shows:
 * the "scoring periods changed" banners, the minimum-training-data warning and
 * the "The health score could not be calculated — try again" notice.
 *
 * Specs: docs/design/handoff/train-test-validation/README.md, as
 * revised by docs/design/handoff/workbench-redesign/README.md §2 ("just score
 * it"): a scoring period is only start → end
 * — no Normal / Known problem label, no event time, no lead time and no
 * verdict, so there is nothing here that judges a result. The identifiers keep
 * their "test" names (`testsChangedAt` is a storage key); only the words the
 * user reads say "scoring period".
 */

/**
 * Recommended minimum of TRAIN running time, in days.
 *
 * There is NO hard block on the number of days (a hard minimum would stop a
 * user training when they only have a little data). Only the technical errors
 * Rust returns (e.g. `NO_DATA` — no row left to fit) stop a Train. Below this
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
 *  — before a preview exists — `countedTrainRunningDays`: Rust's
 *  `count_period_rows` figure the Running-condition caption prints). Never a
 *  block. */
export function trainDaysWarning(trainDays: number | null | undefined): string | null {
    if (!isBelowRecommendedTrainDays(trainDays)) return null;
    const d = Math.max(0, Math.round(trainDays as number));
    return `Only ${d} d of train running time — at least ${RECOMMENDED_TRAIN_DAYS} d is recommended for a reliable model. You can still train.`;
}

/** Per-model banner state on the Health score page. */
export type TestsChangedState = 'changed' | 'removed';

/**
 * Does this model need "Mark complete" again because ONLY its scoring periods
 * changed while it was Complete (`applyIncompleteRule` set `testsChangedAt`)?
 * `'removed'` when its effective list is now empty, `'changed'` otherwise,
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

/**
 * The notice under the running-condition line, in two parts so the UI can set
 * the headline in bold: `headline` (no full stop) and `rest` (one sentence).
 *   "Scoring periods changed — 3 complete models need Mark complete again" +
 *   "They were re-scored with the same trained model, not re-trained."
 * When every one of them lost ALL its scoring periods nothing was re-scored:
 *   "Scoring periods removed — 1 complete model needs a scoring period and Mark
 *   complete again" + "It was not re-trained."
 */
export function testsChangedNoticeParts(n: TestsChangedNotice): { headline: string; rest: string } {
    const one = n.count === 1;
    const models = `${n.count} complete model${one ? '' : 's'}`;
    const need = one ? 'needs' : 'need';
    const they = one ? 'It was' : 'They were';
    return n.allRemoved
        ? { headline: `Scoring periods removed — ${models} ${need} a scoring period and Mark complete again`, rest: `${they} not re-trained.` }
        : { headline: `Scoring periods changed — ${models} ${need} Mark complete again`, rest: `${they} re-scored with the same trained model, not re-trained.` };
}

/** The whole notice as one string (workbench redesign §5 "After Apply"):
 *  "Scoring periods changed — N complete models need Mark complete again. They
 *  were re-scored with the same trained model, not re-trained." */
export function testsChangedNoticeText(n: TestsChangedNotice): string {
    const { headline, rest } = testsChangedNoticeParts(n);
    return `${headline}. ${rest}`;
}

/** Stable code of the WARNING issue `compute_health_preview` adds when the
 *  Relation model engine could not predict the points to score (it did not
 *  answer, or is too old).
 *
 *  Since the health score is computed on 1-hour averages, the Relation model
 *  is predicted from each hour's MEAN predictors — for the TRAINING hours too,
 *  not only for the scoring periods. So this warning now means the WHOLE health
 *  score of the model is missing (every hourly score is `null`, every scoring
 *  period comes back unscored), and it can arrive with NO scoring period at
 *  all. The model fit itself (statistics, Model fit page) is not affected. The
 *  codes keep their `test_scoring_*` names (nothing on the wire is renamed). */
export const TEST_SCORING_FAILED_CODE = 'test_scoring_failed';

/** Same, but the Relation model engine bundled with this build is too old to
 *  score them. Retrying cannot help — only updating the app does —
 *  so this one gets no "Try again". */
export const TEST_SCORING_OUTDATED_CODE = 'test_scoring_outdated';

/** Same, but the scoring periods have too many rows to score in memory:
 *  retrying the same periods fails the same way, so
 *  no "Try again" either — the user has to shorten or remove one (Rust's
 *  message says so). */
export const TEST_SCORING_TOO_LARGE_CODE = 'test_scoring_too_large';

/** Every warning code that means "the health score could not be calculated". */
export const TEST_SCORING_ISSUE_CODES: readonly string[] = [TEST_SCORING_FAILED_CODE, TEST_SCORING_OUTDATED_CODE, TEST_SCORING_TOO_LARGE_CODE];

/** Headline shown for `test_scoring_failed` (amber, for reading only — never a
 *  block): in the scoring-results card, or in the score card's place when the
 *  model has no scoring period to carry it. Rust's own `message` is shown under
 *  it (it says why, e.g. the engine did not answer). */
export const TEST_SCORING_FAILED_TEXT = 'The health score could not be calculated — try again';

/** Headline when no retry is offered (`test_scoring_outdated`,
 *  `test_scoring_too_large`); Rust's message underneath says what to do. */
export const TEST_SCORING_OUTDATED_TEXT = 'The health score could not be calculated';

/** The "could not be calculated" warning of a preview (`test_scoring_failed`,
 *  `test_scoring_outdated` or `test_scoring_too_large`), or null. Check it even
 *  when the preview has no `test_validation`: the warning can come without any
 *  scoring period (see `TEST_SCORING_FAILED_CODE`). */
export function testScoringFailure(data: Pick<HealthPreview, 'validation'> | null | undefined): HealthIssue | null {
    return data?.validation?.find(i => TEST_SCORING_ISSUE_CODES.includes(i.code)) ?? null;
}

/** Whether "Try again" can help for this "not scored" warning — only for an
 *  engine that did not answer; never for an outdated engine or too many rows. */
export function isTestScoringRetryable(issue: Pick<HealthIssue, 'code'>): boolean {
    return issue.code === TEST_SCORING_FAILED_CODE;
}

/** Shown while a Relation-model preview that has to ask the engine is still
 *  loading (it predicts the hours to score — slow the first time). */
export const SLOW_TEST_SCORING_TEXT = 'Calculating the health score with the Relation model — this can take up to ~15 s.';
