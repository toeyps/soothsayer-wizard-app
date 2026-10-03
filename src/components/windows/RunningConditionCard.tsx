import { Fragment } from 'react';
import { Check } from 'lucide-react';
import type { TimePeriod, WorkspaceSensorFilter } from '../../types';
import { isCompleteCondition } from '../../utils/runningCondition';
import { validatePeriods } from '../../utils/timePeriods';
import { conditionChipParts, formatPeriodChip, type DataBounds } from './periodDisplay';
import { PeriodCoverageBar } from './RunningConditionParts';
import { formatPercent, type RowCountPreview } from './useRowCountPreview';

/*
 * Build Model window: the "Step 1 · Running condition" header step bar and the
 * Step-1 card that replaced the old one-line `.bmw-rcbar` (approved mockup
 * WKZxQbvJZLQiMLvMDEFoqq, 2026-10-03). Presentation only — the persisted state,
 * the build gate and the settings modal all stay in BuildModelWindow.
 */

/** unset = nothing configured yet · invalid = configured but a period is broken · set = good to go. */
export type RcStepState = 'set' | 'unset' | 'invalid';

type StepLook = 'done' | 'now' | 'next' | 'lock';

const STEPS = ['Running condition', 'Model settings', 'Train & complete'] as const;

/** `1 Running condition → 2 Model settings → 3 Train & complete`. Done = green
 *  tick, current = blue, locked = faded. Not interactive. */
export function RunningConditionStepBar({ state }: { state: RcStepState }) {
    const looks: StepLook[] = state === 'set' ? ['done', 'now', 'next'] : ['now', 'lock', 'lock'];
    return (
        <ol className="rcs-steps" data-testid="rc-steps" aria-label="Build steps">
            {STEPS.map((label, i) => (
                <Fragment key={label}>
                    {i > 0 && <li className="rcs-line" aria-hidden="true" />}
                    <li className={`rcs-step rcs-step--${looks[i]}`} data-testid={`rc-step-${i + 1}`} data-look={looks[i]} aria-current={looks[i] === 'now' ? 'step' : undefined}>
                        <span className="rcs-sn">{looks[i] === 'done' ? <Check size={11} strokeWidth={3} aria-hidden="true" /> : i + 1}</span>
                        {label}
                    </li>
                </Fragment>
            ))}
        </ol>
    );
}

interface RunningConditionCardProps {
    state: RcStepState;
    periods: TimePeriod[];
    filters: WorkspaceSensorFilter[];
    combine: 'and' | 'or';
    noneConfirmed: boolean;
    /** Dataset headers — a condition on a sensor that isn't in them is not applied. */
    headers: string[] | null;
    getDesc: (tag: string) => string;
    getUnit: (tag: string) => string;
    /** Row count of the PERSISTED condition. */
    rows: RowCountPreview;
    /** Dataset extent (`useDatasetTimeBounds`) — null/unknown hides the period strip. */
    bounds?: DataBounds | null;
    /** Opens the settings modal (Edit / Set running condition / Fix period). */
    onOpen: () => void;
}

/** Period chips ("Which time"); a broken period is drawn red. */
function PeriodChips({ periods }: { periods: TimePeriod[] }) {
    const status = validatePeriods(periods);
    if (periods.length === 0) return <span className="rcc-chip" data-testid="rc-card-period-chip">Whole dataset</span>;
    return (
        <>
            {periods.map((p, i) => (
                <span key={p.id} data-testid="rc-card-period-chip" className={`rcc-chip${status[i]?.invalid ? ' rcc-chip--bad' : ''}`}>
                    {status[i]?.invalid ? '⚠ ' : ''}{formatPeriodChip(p)}
                </span>
            ))}
        </>
    );
}

export function RunningConditionCard({ state, periods, filters, combine, noneConfirmed, headers, getDesc, getUnit, rows, bounds, onOpen }: RunningConditionCardProps) {
    if (state === 'unset') {
        return (
            <section className="rcc-card rcc-card--req" data-testid="rc-card" data-state="unset">
                <div className="rcc-num">1</div>
                <div className="rcc-main">
                    <div className="rcc-kicker">Step 1 · Required before training</div>
                    <h3>Set the running condition</h3>
                    <p>Tell Wizard when the plant is running, so models learn from normal operation — not from shutdowns or idle time. It applies to every model.</p>
                </div>
                <button type="button" className="rcx-btn rcx-btn--pri rcx-btn--lg" data-testid="rc-card-open" onClick={onOpen}>Set running condition →</button>
            </section>
        );
    }

    if (state === 'invalid') {
        const status = validatePeriods(periods);
        const bad = status.findIndex(s => s.invalid);
        return (
            <section className="rcc-card rcc-card--bad" data-testid="rc-card" data-state="invalid">
                <div className="rcc-num">1</div>
                <div className="rcc-main">
                    <div className="rcc-kicker">Step 1 · Running condition</div>
                    <h3 data-testid="rc-card-title">Period {bad + 1} needs fixing</h3>
                    <p data-testid="rc-card-reason">{status[bad]?.reason ?? 'Fix the training period dates.'} Models can't be trained until it's fixed.</p>
                    <div className="rcc-rows"><span className="rcc-lbl">Which time</span><PeriodChips periods={periods} /></div>
                </div>
                <button type="button" className="rcx-btn rcx-btn--danger rcx-btn--lg" data-testid="rc-card-open" onClick={onOpen}>Fix period</button>
            </section>
        );
    }

    const complete = noneConfirmed ? [] : filters.filter(f => isCompleteCondition(f, headers));
    const showCount = rows.status === 'ok' || (rows.status === 'loading' && rows.used !== null);
    const pct = rows.used !== null && rows.total ? Math.min(100, (rows.used / rows.total) * 100) : 0;
    return (
        <section className="rcc-card rcc-card--ok" data-testid="rc-card" data-state="set">
            <div className="rcc-num rcc-num--ok"><Check size={16} aria-hidden="true" /></div>
            <div className="rcc-main">
                <div className="rcc-kicker">
                    Step 1 · Running condition <span className="f4-pill f4-pill--ok" data-testid="rc-card-pill">Set</span>
                    <span className="rcc-applies">applies to every model</span>
                </div>
                <div className="rcc-grid">
                    <div className="rcc-rows" data-testid="rc-card-time"><span className="rcc-lbl">Which time</span><PeriodChips periods={periods} /></div>
                    <div className="rcc-rows" data-testid="rc-card-cond">
                        <span className="rcc-lbl">When running</span>
                        {noneConfirmed || complete.length === 0
                            ? <span className="rcc-chip">All rows — no condition</span>
                            : complete.map((f, i) => {
                                const c = conditionChipParts(f, getDesc, getUnit);
                                return (
                                    <Fragment key={f.id}>
                                        {i > 0 && <span className="rcc-andor">{combine.toUpperCase()}</span>}
                                        <span className="rcc-chip" data-testid="rc-card-cond-chip"><b>{c.name}</b> {c.rest}</span>
                                    </Fragment>
                                );
                            })}
                    </div>
                </div>
            </div>
            <div className="rcc-use" data-testid="rc-card-use" aria-live="polite">
                {rows.status === 'idle' ? null : (
                    <>
                        <div className="rcc-use-n">
                            {showCount ? (
                                <>
                                    <b data-testid="rc-card-rows">{(rows.used ?? 0).toLocaleString()}</b>
                                    <span data-testid="rc-card-pct">rows · {formatPercent(rows.used, rows.total)}</span>
                                </>
                            ) : rows.status === 'error'
                                ? <span title="Couldn't count the rows" data-testid="rc-card-rows-error">— rows</span>
                                : <span data-testid="rc-card-rows-loading">Counting rows…</span>}
                        </div>
                        <div className="rcc-meter" role="img" aria-label="Share of rows used"><span style={{ width: `${pct}%` }} /></div>
                    </>
                )}
                {/* Small period strip (restored 2026-10-03). PERSISTED periods only —
                    the settings modal's draft never reaches this card. Hidden while the
                    dataset bounds are unknown. */}
                <PeriodCoverageBar periods={periods} bounds={bounds} mini />
            </div>
            <button type="button" className="rcx-btn rcx-btn--lg" data-testid="rc-card-open" onClick={onOpen}>Edit</button>
        </section>
    );
}
