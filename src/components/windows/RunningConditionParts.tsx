import { Fragment } from 'react';
import type { TimePeriod } from '../../types';
import { validatePeriods } from '../../utils/timePeriods';
import { buildRuleModel, computeCoverage, formatPeriod, type DataBounds, type RuleInput } from './periodDisplay';

/*
 * Small presentational pieces of the Running Condition UI (approved mockup
 * time-ranges.html): the coverage bar, the "Row is used when ..." rule line and
 * the collapsed-header period chips. All maths lives in `periodDisplay.ts`.
 */

/** Dataset timeline with one block per period and "N of M days used". */
export function PeriodCoverageBar({ periods, bounds }: { periods: TimePeriod[]; bounds: DataBounds | null | undefined }) {
    const cov = computeCoverage(periods, bounds);
    if (!cov) return null;
    return (
        <div data-testid="period-coverage">
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
                <span data-testid="period-coverage-days">
                    {cov.unlimited ? `all ${cov.totalDays} days` : `${cov.usedDays} of ${cov.totalDays} days used`}
                </span>
                <span>{cov.axisRight}</span>
            </div>
        </div>
    );
}

/** "Row is used when ( P1 OR P2 ) AND ( A > 1 AND B < 2 )" with OR/AND as small chips. */
export function RuleFormula({ compact = false, ...input }: RuleInput & { compact?: boolean }) {
    const m = buildRuleModel(input);
    return (
        <div data-testid="rule-formula" className={`f4-formula${compact ? ' f4-formula--compact' : ''}`}>
            Row is used when{' '}
            ({' '}
            {m.periodLabels.length === 0 ? <b>any time</b> : m.periodLabels.map((l, i) => (
                <Fragment key={l}>
                    {i > 0 && <span className="f4-op f4-op--or">OR</span>}
                    <b>{l}</b>
                </Fragment>
            ))}
            {' '}) <span className="f4-op">AND</span> ({' '}
            {m.condMode === 'none' ? <><b>no condition</b> (every row)</>
                : m.condMode === 'empty' ? <b>no condition yet</b>
                : m.conditions.map((c, i) => (
                    <Fragment key={i}>
                        {i > 0 && <span className="f4-op">{m.condOp}</span>}
                        <b>{c}</b>
                    </Fragment>
                ))}
            {' '})
        </div>
    );
}

/** First `max` valid periods as chips plus "+N more" (collapsed panel header). */
export function PeriodChipsLine({ periods, max = 2 }: { periods: TimePeriod[]; max?: number }) {
    const status = validatePeriods(periods);
    const ok = periods.filter((_, i) => !status[i].invalid);
    if (ok.length === 0) return null;
    return (
        <span className="f4-chips" data-testid="period-chips">
            {ok.slice(0, max).map(p => (
                <span
                    key={p.id}
                    data-testid="period-chip"
                    className={`f4-pchip${!(p.start ?? '').trim() || !(p.end ?? '').trim() ? ' f4-pchip--open' : ''}`}
                    title={formatPeriod(p)}
                >
                    {formatPeriod(p)}
                </span>
            ))}
            {ok.length > max && <span data-testid="period-chips-more" className="f4-pchip f4-pchip--more">+{ok.length - max} more</span>}
        </span>
    );
}
