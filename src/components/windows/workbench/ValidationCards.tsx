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

/*
 * Train periods and scoring periods (specs:
 * docs/design/handoff/train-test-validation/README.md, as revised by
 * docs/design/handoff/workbench-redesign/README.md §2 — "just score it").
 * Read-only pieces built from
 * `HealthPreview.test_validation` (the component and test-id names keep "test",
 * like the wire keys; the words the user reads say "scoring"):
 *
 *   TrainDaysNotice   amber "below the recommended train running time" note.
 *   TestsChangedBanner  "Scoring periods changed / removed — Mark complete again".
 *   SlowScoringNotice / TestScoringFailedNotice  loading hint / "could not be calculated".
 *
 * UNITS: the health score is computed on 1-hour averages of the running rows, so
 * `scored`, `pct_below_80`, `lowest` and `lowest_at` of a result are per HOUR;
 * `rows` and `days` ("d running time") stay raw.
 *
 * The Model fit page shows NONE of the per-period numbers (user decision
 * 2026-10-11: its "Train and scoring periods" table — `TrainTestCard` — was
 * removed as information the user does not need; do not add it back). That page
 * keeps only the train / scoring shading on its time charts and the two notices.
 *
 * For reading only: nothing here blocks Train or Mark complete, and NOTHING IS
 * JUDGED — a scoring period has no Normal / Known problem label, no event time
 * and no lead time, so there is no verdict and no green / amber result colour;
 * the user reads the score chart. Scoring periods are numbered S1, S2 … by
 * their POSITION in the user's full list (the order the editor and the
 * running-condition chips show, invalid periods included): `testNumbers` maps
 * each result's 1-based wire `index` back to it (`testPeriodsWirePlan`).
 *
 * The Health score page's "Scoring results" card (`TestResultsCard`: one tile per
 * scoring period — % of its scored hours below 80 and its lowest hourly score) was
 * REMOVED on 2026-10-12 (user decision: not used; do not add it back). The numbers
 * are still computed by Rust (`test_validation.tests`) and written to the exported
 * model files.
 *
 * When Rust could not calculate the score (warning `test_scoring_failed` — the
 * Relation model's engine did not answer), the Health score page shows
 * `TestScoringFailedNotice` in the score chart's place (the lower half of the chart card).
 */

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

/** Amber "The health score could not be calculated — try again" (warning
 *  `test_scoring_failed`), or without the retry for `test_scoring_outdated` /
 *  `test_scoring_too_large` (retrying cannot help). For reading only;
 *  `onRetry` asks for the preview again. */
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

/** "Calculating the health score with the Relation model — this can take up to
 *  ~15 s" (shown while such a preview is loading; the container decides when). */
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
