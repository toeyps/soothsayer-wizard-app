import { Fragment } from 'react';
import type { TimePeriod } from '../../types';
import { isCompleteCondition } from '../../utils/runningCondition';
import { validatePeriods } from '../../utils/timePeriods';
import { computeCoverage, conditionChipParts, formatPeriodChip, type DataBounds, type RuleInput } from './periodDisplay';

/*
 * Small presentational pieces of the Running Condition UI (approved mockup
 * time-ranges.html): the coverage bar, the "Row is used when ..." rule line and
 * the settings modal's "Train on rows inside ..." sentence. All maths lives in
 * `periodDisplay.ts`.
 */

/** Dataset timeline with one block per period and "N of M days used".
 *  `className` lets a host (the settings modal) restyle the wrapper;
 *  `mini` is the Step-1 card variant: thinner strip, shorter day caption. */
export function PeriodCoverageBar({ periods, bounds, className, mini = false }: {
    periods: TimePeriod[];
    bounds: DataBounds | null | undefined;
    className?: string;
    mini?: boolean;
}) {
    const cov = computeCoverage(periods, bounds);
    if (!cov) return null;
    const days = cov.unlimited
        ? `all ${cov.totalDays} days`
        : mini ? `${cov.usedDays} / ${cov.totalDays} d` : `${cov.usedDays} of ${cov.totalDays} days used`;
    return (
        <div data-testid="period-coverage" className={[className, mini ? 'f4-cov--mini' : ''].filter(Boolean).join(' ') || undefined}>
            <div className="f4-strip" role="img" aria-label="Periods on the dataset timeline">
                {cov.segments.map((s, i) => (
                    <i
                        key={i}
                        className={s.kind === 'ok' ? undefined : s.kind}
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
