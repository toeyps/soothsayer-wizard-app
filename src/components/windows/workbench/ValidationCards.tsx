import { Fragment, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import type { HealthIssue, HealthPreview, TestPeriodResult } from '../../../types/health';
import { testIncludesTrainNote, testNumberFor } from '../../../utils/timePeriods';
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
import { fmtNumCol } from './chartTheme';

/*
 * Train periods and scoring periods (SPEC FINAL 2026-10-07,
 * docs/design/handoff/train-test-validation/README.md, as revised by
 * docs/design/handoff/workbench-redesign/README.md §2 — "just score it", user
 * decision 2026-10-09). Read-only pieces built from
 * `HealthPreview.test_validation` (the component and test-id names keep "test",
 * like the wire keys; the words the user reads say "scoring"):
 *
 *   TrainTestCard     Model fit page: the model's numbers on the train rows next
 *                     to each scoring period, per kind.
 *   TestResultsCard   Health score page ("Scoring results"): two neutral facts
 *                     per scoring period — % of running time below 80 and the
 *                     lowest score held for 1 h, with its date.
 *   TrainDaysNotice   amber "below the recommended train running time" note.
 *   TestsChangedBanner  "Scoring periods changed / removed — Mark complete again".
 *
 * For reading only: nothing here blocks Train or Mark complete, and NOTHING IS
 * JUDGED — a scoring period has no Normal / Known problem label, no event time
 * and no lead time, so there is no verdict and no green / amber result colour;
 * the user reads the score chart. Scoring periods are numbered S1, S2 … by
 * their POSITION in the user's full list (the order the editor and the
 * running-condition chips show, invalid periods included): `testNumbers` maps
 * each result's 1-based wire `index` back to it (`testPeriodsWirePlan`).
 *
 * When Rust could not score the periods (warning `test_scoring_failed`), every
 * one is unscored: the cards say so in amber (a failure to compute, not a
 * verdict) instead of showing tiles, and the train numbers stay as they are.
 */

/** "Lowest" is the lowest score HELD for this long (running time) — Rust's
 *  `DROP_SUSTAIN_HOURS`. */
export const DROP_SUSTAIN_HOURS = 1;

/** "3 Feb 2026 14:05" (no seconds) — the ONE Workbench date format, read from the
 *  row's own wall clock (`formatDataStamp`: never shifted to another time zone). */
export function stamp(s: string | null | undefined): string {
    return s == null ? '—' : formatDataStamp(s);
}

const range = (a: string | null, b: string | null) => formatPeriodChip({ id: '', start: a ?? '', end: b ?? '' });
const days1 = (d: number) => `${(Math.round(d * 10) / 10).toFixed(1)} d`;
/** S-number of the result at list position `i` (see the header comment). */
const tNum = (t: TestPeriodResult, i: number, numbers?: readonly number[] | null) => testNumberFor(numbers, t.index, i);
const pct = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? '—' : `${x.toFixed(1)}%`);
/** A signed COLUMN value ("+0.412", "−"-less negatives as the formatter prints them): the
 *  column format (3 decimals, lines up); a non-zero value never reads as 0, so a positive
 *  one always carries its "+". */
const signed = (x: number | null | undefined, unit = '') =>
    x == null || !Number.isFinite(x) ? '—' : `${x > 0 ? '+' : ''}${fmtNumCol(x)}${unit}`;
const hasTrainOverlap = (t: TestPeriodResult) => (t.train_rows ?? 0) > 0;

/** Where a model's scoring periods are edited — Workspace mode vs its own Custom settings. */
export const testPeriodsWhere = (custom: boolean) =>
    custom ? 'Model settings → Training data (Custom)' : 'Running condition → Edit';

function Swatch({ kind }: { kind: 'train' | 'score' }) {
    return <i className={`tpe-sw ${kind === 'train' ? 'tpe-sw--tr' : 'tpe-sw--te'}`} aria-hidden="true" />;
}

function ScopeCell({ kind, text, sub }: { kind: 'train' | 'score'; text: string; sub: string }) {
    return (
        <td className="vt-scopec">
            <div className="vt-scope">
                <Swatch kind={kind} />
                <span><b>{text}</b><small>{sub}</small></span>
            </div>
        </td>
    );
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

/** Amber "The scoring periods could not be scored — try again" (warning
 *  `test_scoring_failed`), or without the retry for `test_scoring_outdated` /
 *  `test_scoring_too_large` (retrying cannot help). For reading only;
 *  `onRetry` asks for the preview again. */
export function TestScoringFailedNotice({ issue, onRetry }: { issue: HealthIssue; onRetry?: () => void }) {
    const retryable = isTestScoringRetryable(issue);
    return (
        <div className="vt-fail" role="status" data-testid="test-scoring-failed">
            <span>
                <b>{retryable ? TEST_SCORING_FAILED_TEXT : TEST_SCORING_OUTDATED_TEXT}</b>
                {issue.message && <small>{issue.message}</small>}
            </span>
            {onRetry && retryable && (
                <button type="button" className="rcx-btn rcx-btn--sm" data-testid="test-scoring-retry" onClick={onRetry}>Try again</button>
            )}
        </div>
    );
}

/** "Scoring these periods with the Relation model — this can take up to ~15 s"
 *  (shown while such a preview is loading; the container decides when). */
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
// Model fit page: Train and scoring periods
// ---------------------------------------------------------------------------

export function TrainTestCard({ data, unit, side = false, custom = false, testNumbers, onRetry }: {
    data: HealthPreview;
    unit: string;
    /** In a side column (Individual / Clustering) instead of a full, capped row. */
    side?: boolean;
    /** The model uses its own (Custom) scoring periods. */
    custom?: boolean;
    /** S-number of each wire entry (`testPeriodsWirePlan(...).numbers`). */
    testNumbers?: readonly number[] | null;
    /** "Try again" when the scoring periods could not be scored. */
    onRetry?: () => void;
}) {
    const v = data.test_validation;
    if (!v) return null;
    const failed = testScoringFailure(data);
    const cls = side ? 'vt-card' : 'vt-card wb2-full vt-card--cap';
    const u = unit ? ` ${unit}` : '';
    const head = (
        <div className="wb2-card-h">
            <b>Train and scoring periods</b>
            <span className="wb2-card-s">the same model over each whole period</span>
        </div>
    );

    if (v.tests.length === 0) {
        return (
            <section className={cls} data-testid="train-test-card">
                {head}
                <div className="vt-none" data-testid="train-test-empty">
                    <b>No scoring period yet.</b> Add one in {testPeriodsWhere(custom)} to see how this model does on time it was not trained on. Needed before Mark complete.
                </div>
            </section>
        );
    }

    const tr = v.train;
    let cols: string[];
    let trainCells: ReactNode;
    let testCells: (t: TestPeriodResult) => ReactNode;
    let note: string;
    if (data.kind === 'relationship') {
        cols = ['R²', 'RMSE', 'Residual mean · SD', 'RMSE ÷ train'];
        trainCells = (
            <>
                <td className="n">{fmtNumCol(tr.r2)}</td>
                <td className="n">{fmtNumCol(tr.rmse)}{u}</td>
                <td className="n">{signed(tr.residual_mean)} · {fmtNumCol(tr.residual_sd)}</td>
                <td className="n vt-dim">1.00</td>
            </>
        );
        // Every scoring period shows the same four numbers — nothing is judged. The numbers
        // of a column share ONE format (3 decimals) so train and scoring rows line up.
        testCells = t => (
            <>
                <td className="n">{fmtNumCol(t.r2)}</td>
                <td className="n">{fmtNumCol(t.rmse)}{u}</td>
                <td className="n">{signed(t.residual_mean)} · {fmtNumCol(t.residual_sd)}</td>
                <td className="n" data-testid="vt-rmse-ratio">{tr.rmse && t.rmse != null ? (t.rmse / tr.rmse).toFixed(2) : '—'}</td>
            </>
        );
        note = 'RMSE ÷ train near 1: the model predicts that period as well as its training rows. Residual mean: how far actual sits from the prediction, on average.';
    } else if (data.kind === 'individual') {
        cols = ['Rows within ±3SD', 'Mean shift'];
        trainCells = <><td className="n">{pct(tr.within_3sd_pct)}</td><td className="n vt-dim">0.000 SD</td></>;
        testCells = t => <><td className="n">{pct(t.within_3sd_pct)}</td><td className="n">{signed(t.mean_shift_sd, ' SD')}</td></>;
        note = 'Mean shift is in train SDs: how far the period moved away from the train rows.';
    } else {
        cols = ['Rows inside the 3× SD ring'];
        trainCells = <td className="n">{pct(tr.inside_3sd_ring_pct)}</td>;
        testCells = t => <td className="n">{pct(t.inside_3sd_ring_pct)}</td>;
        note = "Share of each period's rows inside the 3× SD ring, next to the train rows.";
    }

    return (
        <section className={cls} data-testid="train-test-card">
            {head}
            <table className="vt-table">
                <thead><tr><th>Scope</th>{cols.map(c => <th key={c} className="n">{c}</th>)}</tr></thead>
                <tbody>
                    <tr className="vt-train" data-testid="train-test-row-train">
                        <ScopeCell
                            kind="train"
                            text={v.train_ranges.length > 1 ? `Train · ${v.train_ranges.length} periods` : 'Train'}
                            sub={`${days1(tr.days)} · ${tr.rows.toLocaleString()} rows`}
                        />
                        {trainCells}
                    </tr>
                    {v.tests.map((t, i) => {
                        const n = tNum(t, i, testNumbers);
                        return (
                            <Fragment key={i}>
                                <tr data-testid={`train-test-row-${n}`}>
                                    <ScopeCell kind="score" text={`S${n}`} sub={`${range(t.start, t.end)} · ${days1(t.days)}`} />
                                    {t.rows === 0
                                        ? <td className="n vt-dim" colSpan={cols.length}>No running rows in this period</td>
                                        : failed
                                            ? <td className="n vt-dim" colSpan={cols.length}>Not scored</td>
                                            : testCells(t)}
                                </tr>
                                {hasTrainOverlap(t) && (
                                    <tr className="vt-ovrow" data-testid={`train-test-overlap-${n}`}>
                                        <td colSpan={cols.length + 1}><span className="vt-info">{testIncludesTrainNote(n - 1, t.train_days ?? 0)}.</span></td>
                                    </tr>
                                )}
                            </Fragment>
                        );
                    })}
                </tbody>
            </table>
            {failed && <TestScoringFailedNotice issue={failed} onRetry={onRetry} />}
            <div className="vt-note">{note}</div>
        </section>
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
    /** "Try again" when the scoring periods could not be scored. */
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
                <TestScoringFailedNotice issue={failed} onRetry={onRetry} />
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
                        “Below 80” counts every scored row of the period; “lowest” is the lowest score held for {DROP_SUSTAIN_HOURS} hour of running time. Rows outside the train and scoring periods get no score.
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
                <Swatch kind="score" />
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
    if (t.pct_below_80 === null) return shell('No scored rows', 'No row of this period got a score.', true);
    return shell(
        <><b>{t.pct_below_80.toFixed(1)}%</b> of running time below 80</>,
        t.lowest !== null
            ? `Lowest ${Math.round(t.lowest)} (held ${DROP_SUSTAIN_HOURS} h)${t.lowest_at ? ` on ${stamp(t.lowest_at)}` : ''}.`
            : `No ${DROP_SUSTAIN_HOURS} h stretch of scored running time in this period, so there is no lowest score to show.`,
    );
}
