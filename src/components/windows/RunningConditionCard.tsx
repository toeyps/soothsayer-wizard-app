import { Fragment } from 'react';
import { Check } from 'lucide-react';
import type { TestPeriod, TimePeriod, WorkspaceSensorFilter } from '../../types';
import { isCompleteCondition } from '../../utils/runningCondition';
import { testTrainOverlaps, validatePeriods, validateTestPeriods } from '../../utils/timePeriods';
import { conditionChipParts, formatPeriodChip, type DataBounds } from './periodDisplay';
import { PeriodCoverageBar } from './RunningConditionParts';
import { formatPercent, type RowCountPreview } from './useRowCountPreview';
import { SensorInline } from '../sensor/SensorLabel';
import { sensorTitle, useSensorLookup } from '../sensor/sensorInfo';

/*
 * Build Model window: the Step-1 card that replaced the old one-line
 * `.bmw-rcbar` (approved mockup WKZxQbvJZLQiMLvMDEFoqq, 2026-10-03).
 * Presentation only — the persisted state, the build gate and the settings
 * modal all stay in BuildModelWindow. Train/Test validation (2026-10-07): the
 * "Which time" row became "Train" (required) + "Test" (Known problem hatched,
 * event time shown), and the strip draws train on the top lane, test on the
 * bottom lane. (The header step bar that used to live
 * here is now `workbench/WorkbenchStepBar.tsx`, 2026-10-04.)
 */

/** unset = nothing configured yet · invalid = configured but a period is broken · set = good to go. */
export type RcStepState = 'set' | 'unset' | 'invalid';

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
    /** The PERSISTED workspace test periods (Train/Test validation). */
    testPeriods?: TestPeriod[];
}

/** Train period chips; a broken period is drawn red. No train period at all is
 *  an AMBER "add one" chip — training is blocked until one exists (rule 1), but
 *  nothing is wrong yet, it is a step still to do (same amber as the modal's
 *  "Add a train period" Apply hint; red is kept for invalid input). */
function PeriodChips({ periods }: { periods: TimePeriod[] }) {
    const status = validatePeriods(periods);
    if (periods.length === 0) {
        return <span className="rcc-chip rcc-chip--warn" data-testid="rc-card-period-chip">No train period — add one</span>;
    }
    return (
        <>
            {periods.map((p, i) => (
                <span key={p.id} data-testid="rc-card-period-chip" className={`rcc-chip${status[i]?.invalid ? ' rcc-chip--bad' : ''}`}>
                    <i className="tpe-sw tpe-sw--tr" aria-hidden="true" />
                    {status[i]?.invalid ? '⚠ ' : ''}{periods.length > 1 ? `P${i + 1} · ` : ''}{formatPeriodChip(p)}
                </span>
            ))}
        </>
    );
}

/** Test period chips: "T1 Normal · dates", Known problem hatched with its event
 *  time. None yet = an amber chip (Mark complete needs one, Train does not). */
function TestChips({ tests, train }: { tests: TestPeriod[]; train: TimePeriod[] }) {
    if (tests.length === 0) {
        return <span className="rcc-chip rcc-chip--warn" data-testid="rc-card-test-chip">No test period — needed before Mark complete</span>;
    }
    const status = validateTestPeriods(tests);
    const ovl = testTrainOverlaps(train, tests);
    return (
        <>
            {tests.map((t, i) => {
                const problem = t.label === 'problem';
                const bad = status[i].invalid || status[i].eventInvalid;
                const event = problem && (t.eventTime ?? '').trim() && !status[i].eventInvalid
                    ? formatPeriodChip({ id: '', start: t.eventTime as string, end: '' }).split(' → ')[0]
                    : null;
                return (
                    <span
                        key={t.id}
                        data-testid="rc-card-test-chip"
                        data-label={t.label}
                        className={`rcc-chip rcc-chip--test${problem ? ' rcc-chip--pb' : ''}${bad ? ' rcc-chip--bad' : ''}`}
                        title={ovl[i].length ? `Includes train time (${ovl[i].map(n => `P${n}`).join(', ')}) — information only` : undefined}
                    >
                        <i className={`tpe-sw ${problem ? 'tpe-sw--pb' : 'tpe-sw--te'}`} aria-hidden="true" />
                        {bad ? '⚠ ' : ''}T{i + 1} {problem ? 'Known problem' : 'Normal'} · {formatPeriodChip(t)}
                        {event && <span className="rcc-ev" data-testid="rc-card-test-event"> · event {event}</span>}
                    </span>
                );
            })}
        </>
    );
}

export function RunningConditionCard({ state, periods, filters, combine, noneConfirmed, headers, getDesc, getUnit, rows, bounds, onOpen, testPeriods = [] }: RunningConditionCardProps) {
    const lookup = useSensorLookup();
    if (state === 'unset') {
        return (
            <section className="rcc-card rcc-card--req" data-testid="rc-card" data-state="unset">
                <div className="rcc-num">1</div>
                <div className="rcc-main">
                    <div className="rcc-kicker">
                        Step 1 · Required before training <span className="f4-pill f4-pill--warn" data-testid="rc-card-pill">Not set</span>
                    </div>
                    <h3>Set the running condition</h3>
                    <p>Tell Wizard which healthy time to learn from (train periods) and when the plant is running, so models learn from normal operation — not from problems, shutdowns or idle time. It applies to every model.</p>
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
                    <div className="rcc-rows"><span className="rcc-lbl">Train</span><PeriodChips periods={periods} /></div>
                </div>
                <button type="button" className="rcx-btn rcx-btn--danger rcx-btn--lg" data-testid="rc-card-open" onClick={onOpen}>Fix period</button>
            </section>
        );
    }

    const complete = noneConfirmed ? [] : filters.filter(f => isCompleteCondition(f, headers));
    const noTrain = periods.length === 0;
    const showCount = !noTrain && (rows.status === 'ok' || (rows.status === 'loading' && rows.used !== null));
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
                    <div className="rcc-rows" data-testid="rc-card-time"><span className="rcc-lbl">Train</span><PeriodChips periods={periods} /></div>
                    <div className="rcc-rows" data-testid="rc-card-test"><span className="rcc-lbl">Test</span><TestChips tests={testPeriods} train={periods} /></div>
                    <div className="rcc-rows" data-testid="rc-card-cond">
                        <span className="rcc-lbl">When running</span>
                        {noneConfirmed || complete.length === 0
                            ? <span className="rcc-chip">All rows — no condition</span>
                            : complete.map((f, i) => {
                                const c = conditionChipParts(f, getDesc, getUnit);
                                return (
                                    <Fragment key={f.id}>
                                        {i > 0 && <span className="rcc-andor">{combine.toUpperCase()}</span>}
                                        <span className="rcc-chip rcc-chip--sl" data-testid="rc-card-cond-chip" title={`${sensorTitle(lookup(f.sensor))} ${c.rest}`}>
                                            {/* Customer item 3: Inline label + the condition in mono. */}
                                            <SensorInline tag={f.sensor} size="sm" /> <span className="rcc-rest">{c.rest}</span>
                                        </span>
                                    </Fragment>
                                );
                            })}
                    </div>
                </div>
            </div>
            <div className="rcc-use" data-testid="rc-card-use" aria-live="polite">
                {noTrain ? (
                    <div className="rcc-use-n">
                        <b data-testid="rc-card-rows">0</b>
                        <span className="rcc-use-none" data-testid="rc-card-no-train">rows — add a train period</span>
                    </div>
                ) : rows.status === 'idle' ? null : (
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
                <PeriodCoverageBar periods={periods} bounds={bounds} mini tests={testPeriods} />
            </div>
            <button type="button" className="rcx-btn rcx-btn--lg" data-testid="rc-card-open" onClick={onOpen}>Edit</button>
        </section>
    );
}
