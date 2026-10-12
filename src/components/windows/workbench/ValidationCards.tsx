import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import type { HealthIssue, HealthPreview, TestPeriodResult } from '../../../types/health';
import { scoringIssueMessage, testIncludesTrainNote, testNumberFor } from '../../../utils/timePeriods';
import {
    SLOW_TEST_SCORING_TEXT,
    TEST_SCORING_FAILED_TEXT,
    TEST_SCORING_OUTDATED_TEXT,
    isTestScoringRetryable,
    testScoringFailure,
    testsChangedBannerText,
    trainDaysWarning,
    type TestsChangedState,
} from '../../../utils/trainTestValidation';
import { formatDataStamp, formatPeriodChip } from '../periodDisplay';

/*
 * Train periods and scoring periods (specs:
 * docs/design/handoff/train-test-validation/README.md, as revised by
 * docs/design/handoff/workbench-redesign/README.md §2 — "just score it").
 * Read-only pieces built from
 * `HealthPreview.test_validation` (the component and test-id names keep "test",
 * like the wire keys; the words the user reads say "scoring"):
 *
 *   TestResultsCard   Health score page ("Scoring results"): two neutral facts
 *                     per scoring period — % of its scored hours below 80 and
 *                     its lowest hourly score, with that hour's start.
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
 * When Rust could not calculate the score (warning `test_scoring_failed` — the
 * Relation model's engine did not answer), every period is unscored: the Scoring
 * results card says so in amber (a failure to compute, not a verdict) instead of
 * showing tiles. The same warning can come with NO scoring period (the training
 * hours need the engine too): the Health score page then shows
 * `TestScoringFailedNotice` in the score card's place.
 */

/** "2026/02/03 14:05:00" — a data row's time in the app's one date format, read
 *  from the row's own wall clock (`formatDataStamp`: never shifted to another
 *  time zone). */
export function stamp(s: string | null | undefined): string {
    return s == null ? '—' : formatDataStamp(s);
}

const range = (a: string | null, b: string | null) => formatPeriodChip({ id: '', start: a ?? '', end: b ?? '' });
const days1 = (d: number) => `${(Math.round(d * 10) / 10).toFixed(1)} d`;
/** S-number of the result at list position `i` (see the header comment). */
const tNum = (t: TestPeriodResult, i: number, numbers?: readonly number[] | null) => testNumberFor(numbers, t.index, i);
const hasTrainOverlap = (t: TestPeriodResult) => (t.train_rows ?? 0) > 0;

/** Where a model's scoring periods are edited — Workspace mode vs its own Custom settings. */
export const testPeriodsWhere = (custom: boolean) =>
    custom ? 'Model settings → Training data (Custom)' : 'Running condition → Edit';

/** The scoring-period colour swatch of a result tile. */
function ScoreSwatch() {
    return <i className="tpe-sw tpe-sw--te" aria-hidden="true" />;
}

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

// ---------------------------------------------------------------------------
// Health score page: Scoring results
// ---------------------------------------------------------------------------

export function TestResultsCard({ data, scoreReady, unavailable = false, custom = false, testNumbers, onRetry }: {
    data: HealthPreview;
    /** The score exists (set points valid). Until then the card is one quiet
     *  line — "Scored once the set points are valid" — and no tiles. */
    scoreReady: boolean;
    /** The health score failed to load (the page shows the last answer): the
     *  quiet line says so instead of pointing at the set points. */
    unavailable?: boolean;
    custom?: boolean;
    /** S-number of each wire entry (`testPeriodsWirePlan(...).numbers`). */
    testNumbers?: readonly number[] | null;
    /** "Try again" when the health score could not be calculated. */
    onRetry?: () => void;
}) {
    const v = data.test_validation;
    if (!v) return null;
    const failed = testScoringFailure(data);
    return (
        <section className="hs-card hs-full" data-testid="test-results">
            <div className="wb2-card-h">
                <b>Scoring results</b>
                <span className="wb2-card-s">for reading only — never blocks Mark complete</span>
            </div>
            {v.tests.length === 0 ? (
                <div className="vt-none" data-testid="test-results-empty">
                    <b>No scoring period.</b> Add one in {testPeriodsWhere(custom)} — Mark complete needs at least one.
                </div>
            ) : failed ? (
                <TestScoringFailedNotice issue={failed} onRetry={onRetry} testNumbers={testNumbers} />
            ) : !scoreReady ? (
                <div className="vt-quiet" data-testid="test-results-pending">
                    {unavailable ? 'Not available until the health score loads' : 'Scored once the set points are valid'}
                </div>
            ) : (
                <>
                    <div className="vt-tiles">
                        {v.tests.map((t, i) => <ResultTile key={i} t={t} n={tNum(t, i, testNumbers)} />)}
                    </div>
                    <div className="vt-note">
                        Scores use 1-hour averages of the running rows. “Below 80” counts the scored hours of the period; “lowest” is its lowest hourly score. Hours outside the train and scoring periods, or with no running row, get no score.
                    </div>
                </>
            )}
        </section>
    );
}

/** One scoring period's two facts. Neutral on purpose: no tone, no verdict. */
function ResultTile({ t, n }: { t: TestPeriodResult; n: number }) {
    const shell = (big: ReactNode, det: ReactNode, dim = false) => (
        <div className="vt-tile" data-testid={`test-result-${n}`}>
            <div className="vt-th">
                <ScoreSwatch />
                <b>S{n}</b>
                <span>{range(t.start, t.end)} · {days1(t.days)} running time</span>
            </div>
            {hasTrainOverlap(t) && (
                <div className="vt-info" data-testid={`test-result-overlap-${n}`}>{testIncludesTrainNote(n - 1, t.train_days ?? 0)}.</div>
            )}
            <div className={`vt-big${dim ? ' vt-big--dim' : ''}`} data-testid={`test-result-${n}-big`}>{big}</div>
            <div className="vt-det" data-testid={`test-result-${n}-lowest`}>{det}</div>
        </div>
    );

    if (t.rows === 0) return shell('No running rows', 'The running condition removes every row of this period.', true);
    if (t.pct_below_80 === null) return shell('No scored hours', 'No hour of this period got a score.', true);
    return shell(
        <><b>{t.pct_below_80.toFixed(1)}%</b> of running hours below 80</>,
        // Every scored hour is a 1-hour average, so a period with a scored hour always
        // has a lowest one (there is no "held for 1 h" window any more).
        t.lowest !== null ? `Lowest ${Math.round(t.lowest)} (1 h average)${t.lowest_at ? ` on ${stamp(t.lowest_at)}` : ''}.` : null,
    );
}
