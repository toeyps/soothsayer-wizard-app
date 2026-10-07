import { Fragment, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import type { HealthIssue, HealthPreview, TestPeriodResult } from '../../../types/health';
import { testIncludesTrainNote, testNumberFor } from '../../../utils/timePeriods';
import {
    SLOW_TEST_SCORING_TEXT,
    TEST_SCORING_FAILED_TEXT,
    testScoringFailure,
    testsChangedBannerText,
    trainDaysWarning,
    type TestsChangedState,
} from '../../../utils/trainTestValidation';
import { formatDate, formatPeriodChip, parseLocal } from '../periodDisplay';
import { fmtNum } from './chartTheme';

/*
 * Train/Test model validation (SPEC FINAL 2026-10-07,
 * docs/design/handoff/train-test-validation/README.md — "Metrics" and rule 10).
 * Read-only pieces built from `HealthPreview.test_validation`:
 *
 *   TrainTestCard     Model fit page: the model's numbers on the train rows vs
 *                     each test period, per kind.
 *   TestResultsCard   Health score page: what the score did in each test period
 *                     (false alarms / detection + lead time).
 *   TestedPill        "Tested · N", in the Workbench footer only.
 *   TrainDaysNotice   amber "below the recommended train running time" note.
 *   TestsChangedBanner  "Test periods changed / removed — Mark complete again".
 *
 * Information only: nothing here blocks Train or Mark complete, and the result
 * colours are green or amber — never red (rule 10). Test periods are numbered
 * T1, T2 … by their POSITION in the user's full list (the order the editor and
 * the Step-1 chips show, invalid periods included): `testNumbers` maps each
 * result's 1-based wire `index` back to it (`testPeriodsWirePlan`).
 *
 * When Rust could not score the test periods (warning `test_scoring_failed`),
 * every test is unscored: the cards say so in amber instead of showing tiles
 * that would read "Not scored yet", and the train numbers stay as they are.
 */

/** Normal test period: amber at or above this % of running time below 80 (rule 10). */
export const NORMAL_AMBER_PCT = 5;
/** A drop below 80 counts when it lasts this long (running time) — Rust's rule 11 constant. */
export const DROP_SUSTAIN_HOURS = 1;

/** "3 Feb 2026 14:05" (no seconds) — the Step-1 chips' date style plus the time. */
export function stamp(s: string | null | undefined): string {
    const ms = parseLocal(s);
    if (ms === null) return s ?? '—';
    const d = new Date(ms);
    return `${formatDate(s)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const range = (a: string | null, b: string | null) => formatPeriodChip({ id: '', start: a ?? '', end: b ?? '' });
const days1 = (d: number) => `${(Math.round(d * 10) / 10).toFixed(1)} d`;
const testName = (t: TestPeriodResult, n: number) => `T${n} ${t.label === 'problem' ? 'Known problem' : 'Normal'}`;
/** T-number of the result at list position `i` (see the header comment). */
const tNum = (t: TestPeriodResult, i: number, numbers?: readonly number[] | null) => testNumberFor(numbers, t.index, i);
const pct = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? '—' : `${x.toFixed(1)}%`);
const signed = (x: number | null | undefined, unit = '') =>
    x == null || !Number.isFinite(x) ? '—' : `${x > 0 && fmtNum(x) !== '0.000' ? '+' : ''}${fmtNum(x)}${unit}`;
const hasTrainOverlap = (t: TestPeriodResult) => (t.train_rows ?? 0) > 0;

/** Where a model's test periods are edited — Workspace mode vs its own Custom settings. */
export const testPeriodsWhere = (custom: boolean) =>
    custom ? 'Model settings → Training data (Custom)' : 'Running condition → Edit';

export function TestedPill({ n }: { n: number }) {
    return (
        <span className="f4-pill f4-pill--grey" data-testid="tested-pill" title="Test periods scored — information only">
            Tested · {n}
        </span>
    );
}

function Swatch({ kind }: { kind: 'train' | 'normal' | 'problem' }) {
    return <i className={`tpe-sw ${kind === 'train' ? 'tpe-sw--tr' : kind === 'problem' ? 'tpe-sw--pb' : 'tpe-sw--te'}`} aria-hidden="true" />;
}

function ScopeCell({ kind, text, sub }: { kind: 'train' | 'normal' | 'problem'; text: string; sub: string }) {
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

/** Amber "Couldn't score the test periods — try again" (warning
 *  `test_scoring_failed`). Information only; `onRetry` asks for the preview again. */
export function TestScoringFailedNotice({ issue, onRetry }: { issue: HealthIssue; onRetry?: () => void }) {
    return (
        <div className="vt-fail" role="status" data-testid="test-scoring-failed">
            <span>
                <b>{TEST_SCORING_FAILED_TEXT}</b>
                {issue.message && <small>{issue.message}</small>}
            </span>
            {onRetry && (
                <button type="button" className="rcx-btn rcx-btn--sm" data-testid="test-scoring-retry" onClick={onRetry}>Try again</button>
            )}
        </div>
    );
}

/** "Scoring test periods with the Relation model — this can take up to ~15 s"
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

/** Health score page banner (rule 8): only the test periods changed since Mark complete. */
export function TestsChangedBanner({ state }: { state: TestsChangedState | null | undefined }) {
    if (!state) return null;
    return (
        <div className="wb2-stale hs-full" role="status" data-testid="tests-changed-banner" data-state={state}>
            <span>{testsChangedBannerText(state)}</span>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Model fit page: Train vs test
// ---------------------------------------------------------------------------

export function TrainTestCard({ data, unit, side = false, custom = false, testNumbers, onRetry }: {
    data: HealthPreview;
    unit: string;
    /** In a side column (Individual / Clustering) instead of a full, capped row. */
    side?: boolean;
    /** The model uses its own (Custom) test periods. */
    custom?: boolean;
    /** T-number of each wire entry (`testPeriodsWirePlan(...).numbers`). */
    testNumbers?: readonly number[] | null;
    /** "Try again" when the test periods could not be scored. */
    onRetry?: () => void;
}) {
    const v = data.test_validation;
    if (!v) return null;
    const failed = testScoringFailure(data);
    const cls = side ? 'vt-card' : 'vt-card wb2-full vt-card--cap';
    const u = unit ? ` ${unit}` : '';
    const head = (
        <div className="wb2-card-h">
            <b>Train vs test</b>
            <span className="wb2-card-s">the same model, scored over each whole test period</span>
        </div>
    );

    if (v.tests.length === 0) {
        return (
            <section className={cls} data-testid="train-test-card">
                {head}
                <div className="vt-none" data-testid="train-test-empty">
                    <b>No test period yet.</b> Add one in {testPeriodsWhere(custom)} (a Normal period and, if you have one, a Known problem) to see how this model does on data it never trained on. Needed before Mark complete.
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
        cols = ['R²', 'RMSE', 'Residual mean · SD', 'RMSE test / train'];
        trainCells = (
            <>
                <td className="n">{fmtNum(tr.r2)}</td>
                <td className="n">{fmtNum(tr.rmse)}{u}</td>
                <td className="n">{signed(tr.residual_mean)} · {fmtNum(tr.residual_sd)}</td>
                <td className="n vt-dim">1.00</td>
            </>
        );
        // Known problem: the fit is expected to break, so only the residual shift means something.
        testCells = t => t.label === 'problem' ? (
            <>
                <td className="n vt-dim">—</td>
                <td className="n vt-dim">—</td>
                <td className="n" title="Residual shift: mean of actual − predicted" data-testid="vt-shift">shift {signed(t.residual_mean, u)}</td>
                <td className="n" title="Residual shift ÷ train RMSE" data-testid="vt-shift-ratio">
                    {tr.rmse && t.residual_mean != null ? `${(Math.abs(t.residual_mean) / tr.rmse).toFixed(1)}× train RMSE` : '—'}
                </td>
            </>
        ) : (
            <>
                <td className="n">{fmtNum(t.r2)}</td>
                <td className="n">{fmtNum(t.rmse)}{u}</td>
                <td className="n">{signed(t.residual_mean)} · {fmtNum(t.residual_sd)}</td>
                <td className="n" data-testid="vt-rmse-ratio">{tr.rmse && t.rmse != null ? (t.rmse / tr.rmse).toFixed(2) : '—'}</td>
            </>
        );
        note = 'Normal periods: a ratio near 1 means the model predicts that normal data as well as its training data. Known problem: the residual shift is how far actual moved away from the prediction, on average.';
    } else if (data.kind === 'individual') {
        cols = ['Rows within ±3SD', 'Mean shift'];
        trainCells = <><td className="n">{pct(tr.within_3sd_pct)}</td><td className="n vt-dim">0 SD</td></>;
        testCells = t => <><td className="n">{pct(t.within_3sd_pct)}</td><td className="n">{signed(t.mean_shift_sd, ' SD')}</td></>;
        note = 'Mean shift is in train SDs. Normal periods should stay close to the train rows; a Known problem should move away from them.';
    } else {
        cols = ['Rows inside the 3× SD ring'];
        trainCells = <td className="n">{pct(tr.inside_3sd_ring_pct)}</td>;
        testCells = t => <td className="n">{pct(t.inside_3sd_ring_pct)}</td>;
        note = 'Normal periods should stay inside the ring like the train rows; a Known problem should fall outside it.';
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
                                    <ScopeCell kind={t.label} text={testName(t, n)} sub={`${range(t.start, t.end)} · ${days1(t.days)}`} />
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
// Health score page: Test results
// ---------------------------------------------------------------------------

export type ResultTone = 'ok' | 'warn' | 'none';

/** The tone of one test-result tile (rule 10 — green / amber only, never red). */
export function resultTone(t: TestPeriodResult, scoreReady: boolean): ResultTone {
    if (t.rows === 0 || !scoreReady || t.pct_below_80 === null) return 'none';
    if (t.label === 'normal') return t.pct_below_80 >= NORMAL_AMBER_PCT ? 'warn' : 'ok';
    if (t.first_below_80 === null) return 'warn';
    return t.lead_days === null || t.lead_days >= 0 ? 'ok' : 'warn';
}

export function TestResultsCard({ data, scoreReady, custom = false, testNumbers, onRetry }: {
    data: HealthPreview;
    /** The score exists (set points valid): otherwise every tile reads "Not scored yet". */
    scoreReady: boolean;
    custom?: boolean;
    /** T-number of each wire entry (`testPeriodsWirePlan(...).numbers`). */
    testNumbers?: readonly number[] | null;
    /** "Try again" when the test periods could not be scored. */
    onRetry?: () => void;
}) {
    const v = data.test_validation;
    if (!v) return null;
    const failed = testScoringFailure(data);
    return (
        <section className="hs-card hs-full" data-testid="test-results">
            <div className="wb2-card-h">
                <b>Test results</b>
                <span className="wb2-card-s">information only — never blocks Mark complete</span>
            </div>
            {v.tests.length === 0 ? (
                <div className="vt-none" data-testid="test-results-empty">
                    <b>No test period.</b> Add one in {testPeriodsWhere(custom)} — Mark complete needs at least one.
                </div>
            ) : failed ? (
                <TestScoringFailedNotice issue={failed} onRetry={onRetry} />
            ) : (
                <>
                    <div className="vt-tiles">
                        {v.tests.map((t, i) => <ResultTile key={i} t={t} n={tNum(t, i, testNumbers)} scoreReady={scoreReady} />)}
                    </div>
                    <div className="vt-note">
                        A drop counts when the score stays below 80 for at least {DROP_SUSTAIN_HOURS} hour of running time; “lowest” is the lowest score held for {DROP_SUSTAIN_HOURS} hour. Rows outside the train and test periods get no score.
                    </div>
                </>
            )}
        </section>
    );
}

function ResultTile({ t, n, scoreReady }: { t: TestPeriodResult; n: number; scoreReady: boolean }) {
    const tone = resultTone(t, scoreReady);
    const cls = `vt-tile${tone === 'none' ? '' : ` vt-tile--${tone}`}`;
    const title = (
        <div className="vt-th">
            <Swatch kind={t.label} />
            <b>{testName(t, n)}</b>
            <span>{range(t.start, t.end)} · {days1(t.days)} running time</span>
        </div>
    );
    const overlap = hasTrainOverlap(t)
        ? <div className="vt-info" data-testid={`test-result-overlap-${n}`}>{testIncludesTrainNote(n - 1, t.train_days ?? 0)}.</div>
        : null;
    const lowest = t.lowest !== null ? ` Lowest ${Math.round(t.lowest)} (held ${DROP_SUSTAIN_HOURS} h)${t.lowest_at ? ` on ${stamp(t.lowest_at)}` : ''}.` : '';
    const shell = (big: ReactNode, det: ReactNode) => (
        <div className={cls} data-testid={`test-result-${n}`} data-tone={tone}>
            {title}
            {overlap}
            <div className={`vt-big${tone === 'none' ? ' vt-big--dim' : ''}`} data-testid={`test-result-${n}-big`}>{big}</div>
            <div className="vt-det">{det}</div>
        </div>
    );

    if (t.rows === 0) return shell('No running rows', 'The running condition removes every row of this period.');
    if (!scoreReady || t.pct_below_80 === null) return shell('Not scored yet', 'Set valid points above to score this period.');
    if (t.label === 'normal') {
        return shell(
            <><b>{t.pct_below_80.toFixed(1)}%</b> of running time below 80</>,
            <>
                {tone === 'warn'
                    ? 'Many false alarms for a normal period. Check that this time really was normal, or widen the set points.'
                    : 'Few false alarms — the score stays high on normal data.'}
                {lowest}
            </>,
        );
    }
    if (t.first_below_80 === null) {
        return shell(
            <b>Not detected</b>,
            `The score did not stay below 80 in this period.${lowest} This model does not show this problem — another model may.`,
        );
    }
    if (t.lead_days === null) {
        return shell(
            <><b>Detected</b> · fell below 80 on {stamp(t.first_below_80)}</>,
            `Add the event time to this test period to see the lead time.${lowest}`,
        );
    }
    if (t.lead_days >= 0) {
        return shell(
            <><b>{t.lead_days.toFixed(1)} days</b> before the event</>,
            `Fell below 80 on ${stamp(t.first_below_80)} · event ${stamp(t.event_time)}.${lowest}`,
        );
    }
    return shell(
        <>Detected only <b>{Math.abs(t.lead_days).toFixed(1)} days after</b> the event</>,
        `Fell below 80 only on ${stamp(t.first_below_80)}, after the event (${stamp(t.event_time)}).${lowest}`,
    );
}
