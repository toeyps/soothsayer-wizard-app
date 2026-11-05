import { Loader2 } from 'lucide-react';
import type { HealthIssue } from '../../../types/health';
import { scoringIssueMessage } from '../../../utils/timePeriods';
import {
    SLOW_TEST_SCORING_TEXT,
    TEST_SCORING_FAILED_TEXT,
    TEST_SCORING_OUTDATED_TEXT,
    isTestScoringRetryable,
    testsChangedBannerText,
    trainDaysWarning,
    type TestsChangedState,
} from '../../../utils/trainTestValidation';

/* Read-only pieces from `HealthPreview.test_validation`; 'test' names match wire keys, UI says 'scoring'. Nothing blocks Train/Mark complete. */

/** Amber note when the train running time is below the recommendation (rule 12). Never a block. */
export function TrainDaysNotice({ days }: { days: number | null | undefined }) {
    const text = trainDaysWarning(days);
    if (!text) return null;
    return (
        <div className="rcm-warn wb2-full" role="status" data-testid="train-days-warning">
            {text}
        </div>
    );
}

/** Amber 'could not be calculated' notice; the retry is offered only when retrying can help (`isTestScoringRetryable`). */
export function TestScoringFailedNotice({ issue, onRetry, testNumbers }: { issue: HealthIssue; onRetry?: () => void; testNumbers?: readonly number[] | null }) {
    const retryable = isTestScoringRetryable(issue);
    return (
        <div className="vt-fail" role="status" data-testid="test-scoring-failed">
            <span>
                <b>{retryable ? TEST_SCORING_FAILED_TEXT : TEST_SCORING_OUTDATED_TEXT}</b>
                {issue.message && <small>{scoringIssueMessage(issue, testNumbers)}</small>}
            </span>
            {onRetry && retryable && (
                <button type="button" className="rcx-btn rcx-btn--sm" data-testid="test-scoring-retry" onClick={onRetry}>Try again</button>
            )}
        </div>
    );
}

/** Hint that the Relation-model score can take ~15 s; shown while loading. */
export function SlowScoringNotice({ show }: { show: boolean | undefined }) {
    if (!show) return null;
    return (
        <div className="hs-save wb2-full" role="status" data-testid="slow-test-scoring">
            <Loader2 size={14} className="pm-spin" aria-hidden="true" />
            <span>{SLOW_TEST_SCORING_TEXT}</span>
        </div>
    );
}

/** Health score page banner: only the scoring periods changed since Mark complete. */
export function TestsChangedBanner({ state }: { state: TestsChangedState | null | undefined }) {
    if (!state) return null;
    return (
        <div className="wb2-stale hs-full" role="status" data-testid="tests-changed-banner" data-state={state}>
            <span>{testsChangedBannerText(state)}</span>
        </div>
    );
}
