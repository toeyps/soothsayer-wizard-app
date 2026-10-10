import { Fragment, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import type { TestPeriod, TimePeriod, WorkspaceSensorFilter } from '../../types';
import { isCompleteCondition } from '../../utils/runningCondition';
import { testTrainOverlaps, validatePeriods, validateTestPeriods } from '../../utils/timePeriods';
import { conditionChipParts, formatPeriodChip, parseLocal, type DataBounds } from './periodDisplay';
import { PeriodCoverageBar } from './RunningConditionParts';
import { formatPercent, type RowCountPreview } from './useRowCountPreview';
import { SensorInline } from '../sensor/SensorLabel';
import { sensorTitle, useSensorLookup } from '../sensor/sensorInfo';

/*
 * Build Model window: the Step-1 card that replaced the old one-line
 * `.bmw-rcbar` (approved mockup WKZxQbvJZLQiMLvMDEFoqq, 2026-10-03).
 * Presentation only — the persisted state, the build gate and the settings
 * modal all stay in BuildModelWindow. Since 2026-10-07 the "Which time" row is
 * "Train" (required) + a second row for the periods the model is scored on —
 * "Scoring" since 2026-10-10 ("just score it": S1, S2 …, start → end only, no
 * label and no event time) — and the strip draws train on the top lane,
 * scoring on the bottom lane. (The header step bar that once lived here moved
 * out on 2026-10-04 and was removed altogether on 2026-10-09 at the user's
 * request.)
 *
 * Workbench redesign 2026-10-10 (SPEC workbench-redesign §1): once the running
 * condition is SET the card is ONE line of workspace context — ✓ · Train n
 * periods + span · Scoring n periods · When running: n conditions · rows · % ·
 * mini strip · Details · Edit. "Details" unfolds the full grid in place. Unset
 * and invalid stay loud cards with their own button, marked "!" (there is no
 * step number any more). The line reads the SAME props the card always had: no
 * new request, no new count.
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
    /** The PERSISTED workspace scoring periods. */
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

/** Scoring period chips: "S1 · dates" — start → end only (a legacy label /
 *  event time on an old workspace's period is never shown). None yet = an amber
 *  chip (Mark complete needs one, Train does not). */
function ScoringChips({ tests, train }: { tests: TestPeriod[]; train: TimePeriod[] }) {
    if (tests.length === 0) {
        return <span className="rcc-chip rcc-chip--warn" data-testid="rc-card-test-chip">No scoring period — needed before Mark complete</span>;
    }
    const status = validateTestPeriods(tests);
    const ovl = testTrainOverlaps(train, tests);
    return (
        <>
            {tests.map((t, i) => {
                const bad = status[i].invalid;
                return (
                    <span
                        key={t.id}
                        data-testid="rc-card-test-chip"
                        className={`rcc-chip rcc-chip--test${bad ? ' rcc-chip--bad' : ''}`}
                        title={ovl[i].length ? `Includes train time (${ovl[i].map(n => `P${n}`).join(', ')}) — information only` : undefined}
                    >
                        <i className="tpe-sw tpe-sw--te" aria-hidden="true" />
                        {bad ? '⚠ ' : ''}S{i + 1} · {formatPeriodChip(t)}
                    </span>
                );
            })}
        </>
    );
}

/** "1 Jan 2026 → 30 Jun 2026": first train start to last train end (an open side reads Start / End). */
function trainSpan(periods: TimePeriod[]): string {
    if (periods.length === 0) return '';
    const byTime = (a: string, b: string) => (parseLocal(a) ?? 0) - (parseLocal(b) ?? 0);
    const starts = periods.map(p => p.start).filter(x => x.trim()).sort(byTime);
    const ends = periods.map(p => p.end).filter(x => x.trim()).sort(byTime);
    return formatPeriodChip({
        id: '',
        start: starts.length < periods.length ? '' : starts[0],
        end: ends.length < periods.length ? '' : ends[ends.length - 1],
    });
}

const plural = (n: number, word: string) => `${word}${n === 1 ? '' : 's'}`;

export function RunningConditionCard({ state, periods, filters, combine, noneConfirmed, headers, getDesc, getUnit, rows, bounds, onOpen, testPeriods = [] }: RunningConditionCardProps) {
    const lookup = useSensorLookup();
    // Set = one line; "Details" unfolds the full grid (toggling re-renders this card only).
    const [detailsOpen, setDetailsOpen] = useState(false);
    // "Details" / "Hide details" is ONE control to the keyboard: the two views are
    // different trees, so the button is a new element after each toggle — the focus
    // is put back on it (it used to drop to <body> on every toggle).
    const detailsBtnRef = useRef<HTMLButtonElement>(null);
    const refocusDetails = useRef(false);
    useEffect(() => {
        if (!refocusDetails.current) return;
        refocusDetails.current = false;
        detailsBtnRef.current?.focus();
    }, [detailsOpen]);
    const toggleDetails = (open: boolean) => { refocusDetails.current = true; setDetailsOpen(open); };
    if (state === 'unset') {
        return (
            <section className="rcc-card rcc-card--req" data-testid="rc-card" data-state="unset">
                <div className="rcc-num" aria-hidden="true">!</div>
                <div className="rcc-main">
                    <div className="rcc-kicker">
                        Running condition · required before training <span className="f4-pill f4-pill--warn" data-testid="rc-card-pill">Not set</span>
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
                <div className="rcc-num" aria-hidden="true">!</div>
                <div className="rcc-main">
                    <div className="rcc-kicker">Running condition</div>
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

    if (!detailsOpen) {
        const nTrain = periods.length;
        const nScore = testPeriods.length;
        const nCond = complete.length;
        const badScoring = validateTestPeriods(testPeriods).filter(s => s.invalid).length;
        return (
            <section className="rcc-card rcc-card--ok rcc-line" data-testid="rc-card" data-state="set" data-details="closed">
                <div className="rcc-num rcc-num--ok rcc-num--sm" role="img" aria-label="Set · applies to every model" title="Set · applies to every model" data-testid="rc-card-tick"><Check size={13} aria-hidden="true" /></div>
                <div className="rcc-line-main">
                    <b>Running condition</b>
                    <span className="rcc-line-sep" aria-hidden="true" />
                    <span className="rcc-line-item" data-testid="rc-card-time">
                        <i className="tpe-sw tpe-sw--tr" aria-hidden="true" />
                        {noTrain
                            ? <span className="rcc-line-warn">No train period</span>
                            : <>Train <b>{nTrain}</b> {plural(nTrain, 'period')} <span className="rcc-line-dt wbx-dt" data-testid="rc-card-span">{trainSpan(periods)}</span></>}
                    </span>
                    <span className="rcc-line-item" data-testid="rc-card-test">
                        <i className="tpe-sw tpe-sw--te" aria-hidden="true" />
                        {nScore === 0
                            ? <span className="rcc-line-warn" title="Needed before Mark complete">No scoring period</span>
                            : <>Scoring <b>{nScore}</b> {plural(nScore, 'period')}{badScoring > 0 && <span className="rcc-line-bad" data-testid="rc-card-test-bad"> · ⚠ {badScoring} to fix</span>}</>}
                    </span>
                    <span className="rcc-line-item" data-testid="rc-card-cond">
                        {noneConfirmed || nCond === 0 ? 'All rows — no condition' : <>When running: <b>{nCond}</b> {plural(nCond, 'condition')}</>}
                    </span>
                    <span className="rcc-line-item rcc-line-rows" data-testid="rc-card-use" aria-live="polite">
                        {noTrain ? (
                            <><b data-testid="rc-card-rows">0</b> <span data-testid="rc-card-no-train">rows — add a train period</span></>
                        ) : rows.status === 'idle' ? null : showCount ? (
                            <><b data-testid="rc-card-rows">{(rows.used ?? 0).toLocaleString()}</b> <span data-testid="rc-card-pct">rows · {formatPercent(rows.used, rows.total)}</span></>
                        ) : rows.status === 'error'
                            ? <span title="Couldn't count the rows" data-testid="rc-card-rows-error">— rows</span>
                            : <span data-testid="rc-card-rows-loading">Counting rows…</span>}
                    </span>
                </div>
                {/* PERSISTED periods only, the same strip as the Details view. Hidden while the dataset bounds are unknown. */}
                <div className="rcc-line-strip" title="Train (top lane) and scoring (bottom lane) periods across the dataset">
                    <PeriodCoverageBar periods={periods} bounds={bounds} mini tests={testPeriods} />
                </div>
                <button type="button" ref={detailsBtnRef} className="rcx-btn rcx-btn--sm rcc-line-more" data-testid="rc-card-details" aria-expanded={false} onClick={() => toggleDetails(true)}>
                    Details <ChevronDown size={12} aria-hidden="true" />
                </button>
                <button type="button" className="rcx-btn rcx-btn--sm" data-testid="rc-card-open" onClick={onOpen}>Edit</button>
            </section>
        );
    }

    return (
        <section className="rcc-card rcc-card--ok" data-testid="rc-card" data-state="set" data-details="open">
            <div className="rcc-num rcc-num--ok"><Check size={16} aria-hidden="true" /></div>
            <div className="rcc-main">
                <div className="rcc-kicker">
                    Running condition <span className="f4-pill f4-pill--ok" data-testid="rc-card-pill">Set</span>
                    <span className="rcc-applies">applies to every model</span>
                    <span className="wb2-sp" />
                    <button type="button" ref={detailsBtnRef} className="rcc-less" data-testid="rc-card-details" aria-expanded={true} onClick={() => toggleDetails(false)}>
                        Hide details <ChevronUp size={12} aria-hidden="true" />
                    </button>
                </div>
                <div className="rcc-grid">
                    <div className="rcc-rows" data-testid="rc-card-time"><span className="rcc-lbl">Train</span><PeriodChips periods={periods} /></div>
                    <div className="rcc-rows" data-testid="rc-card-test"><span className="rcc-lbl">Scoring</span><ScoringChips tests={testPeriods} train={periods} /></div>
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
