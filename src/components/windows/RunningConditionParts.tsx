import { Fragment } from 'react';
import type { TestPeriod, TimeHighlight, TimePeriod } from '../../types';
import { isCompleteCondition } from '../../utils/runningCondition';
import { removeHighlightOverlap, trainHighlightOverlaps, validatePeriods } from '../../utils/timePeriods';
import { computeCoverage, computeTestCoverage, conditionChipParts, formatPeriodChip, type DataBounds, type RuleInput } from './periodDisplay';

/*
 * Small presentational pieces of the Running Condition UI (approved mockup
 * time-ranges.html): the coverage bar, the "Row is used when ..." rule line and
 * the settings modal's "Train on rows inside ..." sentence. All maths lives in
 * `periodDisplay.ts`.
 */

/** Dataset timeline with one block per period and "N of M days used".
 *  `className` lets a host (the settings modal) restyle the wrapper;
 *  `mini` is the Step-1 card variant: thinner strip, shorter day caption.
 *
 *  With `tests` (the scoring periods -- every Build Model use passes them) the
 *  strip has two lanes: TRAIN periods on the top half, SCORING periods on the
 *  bottom half in the scoring colour, so a scoring period that overlaps train
 *  time stays readable; the caption reads "117 d train · 59 d scoring". A train
 *  period is required then, so an empty train list draws an empty top lane
 *  (not "all data"). */
export function PeriodCoverageBar({ periods, bounds, className, mini = false, tests }: {
    periods: TimePeriod[];
    bounds: DataBounds | null | undefined;
    className?: string;
    mini?: boolean;
    tests?: TestPeriod[];
}) {
    const validation = tests !== undefined;
    const cov = computeCoverage(periods, bounds);
    if (!cov) return null;
    const trainSegs = validation && periods.length === 0 ? [] : cov.segments;
    const testCov = validation ? computeTestCoverage(tests, bounds) : null;
    const days = validation
        ? `${periods.length === 0 ? 0 : cov.usedDays} d train · ${testCov?.usedDays ?? 0} d scoring`
        : cov.unlimited
            ? `all ${cov.totalDays} days`
            : mini ? `${cov.usedDays} / ${cov.totalDays} d` : `${cov.usedDays} of ${cov.totalDays} days used`;
    return (
        <div data-testid="period-coverage" className={[className, mini ? 'f4-cov--mini' : ''].filter(Boolean).join(' ') || undefined}>
            <div
                className={`f4-strip${validation ? ' f4-strip--tt' : ''}`}
                role="img"
                aria-label={validation ? 'Train periods (top lane) and scoring periods (bottom lane) on the dataset timeline' : 'Periods on the dataset timeline'}
            >
                {trainSegs.map((s, i) => (
                    <i
                        key={i}
                        className={s.kind === 'ok' ? undefined : s.kind}
                        title={s.label}
                        style={{ left: `${s.leftPct.toFixed(2)}%`, width: `${s.widthPct.toFixed(2)}%` }}
                    />
                ))}
                {testCov?.segments.map((s, i) => (
                    <i
                        key={`t${i}`}
                        className="te"
                        data-testid="period-coverage-test"
                        title={s.label}
                        style={{ left: `${s.leftPct.toFixed(2)}%`, width: `${s.widthPct.toFixed(2)}%` }}
                    />
                ))}
            </div>
            <div className="f4-strip-ax">
                <span>{cov.axisLeft}</span>
                <span data-testid="period-coverage-days">{days}</span>
                <span>{cov.axisRight}</span>
            </div>
        </div>
    );
}

/**
 * Settings-modal summary sentence (preview column): "Train on rows inside
 * 1 Jan 2026 → 31 Mar 2026 OR 15 Apr 2026 → End AND GEN POWER > 4000 kW".
 * Same inputs and the same rule as `RuleFormula` (periods OR together, then
 * AND the value conditions with the chosen combine), but with readable dates
 * and sensor names instead of P1/P2 labels.
 */
export function RuleSentence({ periods, filters, combine, none, headers, getLabel, getUnit }: RuleInput & {
    headers?: string[] | null;
    getLabel: (tag: string) => string;
    getUnit: (tag: string) => string;
}) {
    const status = validatePeriods(periods);
    const valid = periods.filter((_, i) => !status[i].invalid);
    const conds = filters.filter(f => isCompleteCondition(f, headers));
    // Train/Test validation (rule 1): no train period means nothing to train on —
    // never "any time" any more.
    if (periods.length === 0) {
        return (
            <div data-testid="rule-sentence" className="rcm-sentence">
                <b className="rcm-sentence-miss" data-testid="rule-no-train">No train period</b> — add one; models learn only from the train periods.
            </div>
        );
    }
    return (
        <div data-testid="rule-sentence" className="rcm-sentence">
            Train on rows inside{' '}
            {valid.length === 0 ? <b>any time</b> : valid.map((p, i) => (
                <Fragment key={p.id}>
                    {i > 0 && <span className="f4-op f4-op--or">OR</span>}
                    <b>{formatPeriodChip(p)}</b>
                </Fragment>
            ))}
            <span className="f4-op">AND</span>
            {none ? <><b>every row</b> (no condition)</>
                : conds.length === 0 ? <b className="rcm-sentence-miss">— not set yet</b>
                : conds.map((f, i) => {
                    const c = conditionChipParts(f, getLabel, getUnit);
                    return (
                        <Fragment key={f.id}>
                            {i > 0 && <span className="f4-op">{combine.toUpperCase()}</span>}
                            <b>{c.name} {c.rest}</b>
                        </Fragment>
                    );
                })}
        </div>
    );
}

/**
 * Train periods that overlap an (enabled) Dashboard time highlight (SPEC rule
 * 4): an amber warning per overlap with a "Remove the overlap" action that cuts
 * the highlight's time out of the train periods. Never a block -- the user may
 * keep the overlap.
 */
export function TrainHighlightWarnings({ periods, highlights, onPeriodsChange }: {
    periods: TimePeriod[];
    highlights: TimeHighlight[];
    onPeriodsChange: (next: TimePeriod[]) => void;
}) {
    const overlaps = trainHighlightOverlaps(periods, highlights);
    if (overlaps.length === 0) return null;
    return (
        <>
            {overlaps.map(({ periodIndex, highlight: h }) => (
                <div key={`${periods[periodIndex].id}-${h.id}`} className="tpe-hlwarn" role="status" data-testid="train-hl-warning">
                    <i style={{ background: h.color }} aria-hidden="true" />
                    <span>
                        Train P{periodIndex + 1} overlaps the highlight <b>“{h.label || 'Highlight'}”</b>. If something was wrong at that time, leave it out of the train periods.
                    </span>
                    <button
                        type="button"
                        className="rcx-btn rcx-btn--sm"
                        data-testid="train-hl-split"
                        onClick={() => onPeriodsChange(removeHighlightOverlap(periods, h))}
                    >
                        Remove the overlap
                    </button>
                </div>
            ))}
        </>
    );
}
