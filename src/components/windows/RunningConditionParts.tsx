import type { TestPeriod, TimeHighlight, TimePeriod } from '../../types';
import { removeHighlightOverlap, trainHighlightOverlaps } from '../../utils/timePeriods';
import { computeCoverage, computeTestCoverage, type DataBounds } from './periodDisplay';

/*
 * Small presentational pieces of the Running Condition UI: the coverage bar of
 * the one-line running condition, and the amber train-period / highlight
 * overlap line of the settings. All maths lives in `periodDisplay.ts`.
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
                // ONE amber line under the train rows, the fix inline (no box).
                <div key={`${periods[periodIndex].id}-${h.id}`} className="tpe-hlwarn" role="status" data-testid="train-hl-warning">
                    <span>
                        Train P{periodIndex + 1} overlaps the highlight <b>“{h.label || 'Highlight'}”</b> — if something was wrong at that time, leave it out.
                    </span>
                    <button
                        type="button"
                        className="f4-link"
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
