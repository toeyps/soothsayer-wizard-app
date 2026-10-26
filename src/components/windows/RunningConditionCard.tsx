import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import type { TestPeriod, TimePeriod, WorkspaceSensorFilter } from '../../types';
import { isCompleteCondition } from '../../utils/runningCondition';
import { allPeriodsOutsideData, dataRangeText, savedOutsideDataNotes, testTrainOverlaps, validatePeriods, validateTestPeriods } from '../../utils/timePeriods';
import { conditionChipParts, formatPeriodChip, parseLocal, type DataBounds } from './periodDisplay';
import { PeriodCoverageBar } from './RunningConditionParts';
import { SensorInline } from '../sensor/SensorLabel';
import { sensorTitle, useSensorLookup } from '../sensor/sensorInfo';

/*
 * Build Model window: the Step-1 running-condition card. Presentation only —
 * the persisted state, the build gate and the settings modal all stay in
 * BuildModelWindow. The "Which time" part is "Train" (required) + a second
 * row for the periods the model is scored on — "Scoring" (S1, S2 …, start →
 * end only, no label and no event time) — and the strip draws train on the
 * top lane, scoring on the bottom lane.
 *
 * Once the running condition is SET the card is ONE line of workspace
 * context — ✓ · Train n periods + span · Scoring n periods · When running: n
 * conditions · Details · Edit. "Details" unfolds the full grid in
 * place — that is where the period strip is; the line itself carries none
 * (user decision 2026-10-11: it is visible on opening anyway). Unset and invalid stay loud cards with their own
 * button, marked "!" (there is no step number).
 *
 * NO count of data rows is shown anywhere on this card (user decision
 * 2026-10-14: the Build Model window never says how many rows are used — no
 * "N rows · x%", no "Counting rows…", no share meter; do not add them back).
 * Rust's `count_period_rows` still runs for the PERSISTED condition, but only
 * the window's gate reads it; the card gets its verdict as `noRows`.
 *
 * Guards against "no data to train on". The card shows the PERSISTED state,
 * so a period outside the loaded data is never "invalid" here — the user did
 * not just pick it (an old workspace, or the data file changed):
 *  - a saved train / scoring period entirely outside the data is an AMBER
 *    warning — "P2 is outside the data (…) — it is not used", "S1 is outside
 *    the data — nothing is scored there" — on the line and on its chip; the
 *    card stays "set" and nothing is blocked;
 *  - truly nothing to train on turns the card red — "Nothing to train on": NO
 *    train period is inside the data, or the settled count holds no running
 *    row (`noRows`). The card only shows it; the window blocks Train (and only
 *    Train — trained models keep their charts).
 * With no train period at all the card says "Add a train period" (amber).
 */

/** unset = nothing configured yet · invalid = configured but a period is broken · set = good to go. */
export type RcStepState = 'set' | 'unset' | 'invalid';

interface RunningConditionCardProps {
    state: RcStepState;
    periods: TimePeriod[];
    filters: WorkspaceSensorFilter[];
    /** Dataset headers — a condition on a sensor that isn't in them is not applied. */
    headers: string[] | null;
    getDesc: (tag: string) => string;
    getUnit: (tag: string) => string;
    /** Dataset extent (`useDatasetTimeBounds`) — null/unknown hides the period strip. */
    bounds?: DataBounds | null;
    /** Opens the settings modal (Edit / Set running condition / Fix period). */
    onOpen: () => void;
    /** The PERSISTED workspace scoring periods. */
    testPeriods?: TestPeriod[];
    /** The count of the persisted condition is settled and its train periods hold
     *  no running row (`countedNoTrainRows`): the red "nothing to train on" state.
     *  (The card adds the other case itself: no train period inside the data.) */
    noRows?: boolean;
    /** Why an OLD project must set the running condition again (the one-time
     *  conversion found nothing to keep): replaces the Not-set card's text. */
    why?: ReactNode;
}

/** What the card says (red, an alert) when nothing can be trained on. */
export const CARD_NO_ROWS_TEXT = 'Nothing to train on';
/** What the card says (amber) while there is no train period at all. */
export const CARD_NO_TRAIN_TEXT = 'Add a train period';
/** The tooltip of that state. With no complete running condition yet there is nothing to relax. */
function noRowsTitle(allOutside: boolean, hasCondition: boolean, bounds: DataBounds | null | undefined): string {
    if (allOutside) return `No train period is inside the data (${dataRangeText(bounds)}) — move a train period inside the data`;
    return hasCondition
        ? 'No rows match the running condition inside the train periods — widen a train period or relax the condition'
        : 'No rows inside the train periods — widen a train period';
}

/** Train period chips; a broken period is drawn red, a saved one that lies
 *  entirely outside the loaded data amber (a warning — it is simply not used).
 *  No train period at all is an AMBER "add one" chip — training is blocked until
 *  one exists (rule 1), but nothing is wrong yet, it is a step still to do (same
 *  amber as the modal's "Add a train period" Apply hint; red is kept for invalid
 *  input). */
function PeriodChips({ periods, bounds }: { periods: TimePeriod[]; bounds?: DataBounds | null }) {
    // The SAVED list judged as a whole: outside the data = a warning, never invalid.
    const status = validatePeriods(periods, bounds, periods);
    if (periods.length === 0) {
        return <span className="rcc-chip rcc-chip--warn" data-testid="rc-card-period-chip">No train period — add one</span>;
    }
    return (
        <>
            {periods.map((p, i) => {
                const st = status[i];
                const flag = st?.invalid || st?.outsideData;
                return (
                    <span
                        key={p.id}
                        data-testid="rc-card-period-chip"
                        data-outside={st?.outsideData ? 'true' : undefined}
                        className={`rcc-chip${st?.invalid ? ' rcc-chip--bad' : st?.outsideData ? ' rcc-chip--warn' : ''}`}
                        title={st?.outsideData ? st.dataNote : undefined}
                    >
                        <i className="tpe-sw tpe-sw--tr" aria-hidden="true" />
                        {flag ? '⚠ ' : ''}{periods.length > 1 ? `P${i + 1} · ` : ''}{formatPeriodChip(p)}
                    </span>
                );
            })}
        </>
    );
}

/** Scoring period chips: "S1 · dates" — start → end only (a legacy label /
 *  event time on an old workspace's period is never shown). None yet = an amber
 *  chip (Mark complete needs one, Train does not). */
function ScoringChips({ tests, train, bounds }: { tests: TestPeriod[]; train: TimePeriod[]; bounds?: DataBounds | null }) {
    if (tests.length === 0) {
        return <span className="rcc-chip rcc-chip--warn" data-testid="rc-card-test-chip">No scoring period — needed before Mark complete</span>;
    }
    // The SAVED list judged as a whole: outside the data = a warning, never invalid.
    const status = validateTestPeriods(tests, bounds, tests);
    const ovl = testTrainOverlaps(train, tests);
    return (
        <>
            {tests.map((t, i) => {
                const bad = status[i].invalid;
                const outside = !!status[i].outsideData;
                return (
                    <span
                        key={t.id}
                        data-testid="rc-card-test-chip"
                        data-outside={outside ? 'true' : undefined}
                        className={`rcc-chip rcc-chip--test${bad ? ' rcc-chip--bad' : outside ? ' rcc-chip--warn' : ''}`}
                        title={outside ? status[i].dataNote
                            : ovl[i].length ? `Includes train time (${ovl[i].map(n => `P${n}`).join(', ')}) — information only` : undefined}
                    >
                        <i className="tpe-sw tpe-sw--te" aria-hidden="true" />
                        {bad || outside ? '⚠ ' : ''}S{i + 1} · {formatPeriodChip(t)}
                    </span>
                );
            })}
        </>
    );
}

/** "2026/01/01 00:00 → 2026/06/30 23:59": first train start to last train end (an open side reads Start / End). */
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

export function RunningConditionCard({ state, periods, filters, headers, getDesc, getUnit, bounds, onOpen, testPeriods = [], noRows: noRowsCounted = false, why }: RunningConditionCardProps) {
    const lookup = useSensorLookup();
    // Set = one line; "Details" unfolds the full grid (toggling re-renders this card only).
    const [detailsOpen, setDetailsOpen] = useState(false);
    // "Details" / "Hide details" is ONE control to the keyboard: the two views are
    // different trees, so the button is a new element after each toggle — the focus
    // is put back on it (it would otherwise drop to <body> on every toggle).
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
                        Running condition · required before training <span className="f4-pill f4-pill--warn" data-testid="rc-card-pill">{why ? 'Set it again' : 'Not set'}</span>
                    </div>
                    <h3>Set the running condition</h3>
                    {why
                        ? <p data-testid="rc-card-why">{why}</p>
                        : <p>Tell Wizard which healthy time to learn from (train periods) and the sensor that shows the machine is running — <b>Machine is running when … is above …</b> — so models learn from normal operation, not from shutdowns or idle time. It applies to every model and is written to the export.</p>}
                </div>
                <button type="button" className="rcx-btn rcx-btn--pri rcx-btn--lg" data-testid="rc-card-open" onClick={onOpen}>Set running condition →</button>
            </section>
        );
    }

    if (state === 'invalid') {
        // The same rule the window's gate reads: the plain date faults. (A saved
        // period outside the loaded data is a warning on its chip, never this state.)
        const status = validatePeriods(periods);
        const bad = status.findIndex(s => s.invalid);
        return (
            <section className="rcc-card rcc-card--bad" data-testid="rc-card" data-state="invalid">
                <div className="rcc-num" aria-hidden="true">!</div>
                <div className="rcc-main">
                    <div className="rcc-kicker">Running condition</div>
                    <h3 data-testid="rc-card-title">P{bad + 1} needs fixing</h3>
                    <p data-testid="rc-card-reason">{status[bad]?.reason ?? 'Fix the training period dates.'} Models can't be trained until it's fixed.</p>
                    <div className="rcc-rows"><span className="rcc-lbl">Train</span><PeriodChips periods={periods} bounds={bounds} /></div>
                </div>
                <button type="button" className="rcx-btn rcx-btn--danger rcx-btn--lg" data-testid="rc-card-open" onClick={onOpen}>Fix period</button>
            </section>
        );
    }

    // THE one condition (a "sensor > value" row).
    const complete = filters.filter(f => f.operation === 'greater_than' && isCompleteCondition(f, headers)).slice(0, 1);
    const noTrain = periods.length === 0;
    // Saved periods that lie entirely outside the loaded data: amber, never a block.
    const outsideNotes = savedOutsideDataNotes(periods, testPeriods, bounds);
    // Truly nothing to train on: no train period is inside the data (known from the
    // dates alone), or the settled count holds no running row.
    const allOutside = allPeriodsOutsideData(periods, bounds);
    const noRows = noRowsCounted || allOutside;
    const noRowsTip = noRowsTitle(allOutside, complete.length > 0, bounds);
    const outsideLine = outsideNotes.length > 0 && (
        <span className="rcc-line-item rcc-line-warn" role="status" data-testid="rc-card-outside" title={outsideNotes.join(' · ')}>
            ⚠ {outsideNotes.join(' · ')}
        </span>
    );

    if (!detailsOpen) {
        const nTrain = periods.length;
        const nScore = testPeriods.length;
        const nCond = complete.length;
        const badScoring = validateTestPeriods(testPeriods).filter(s => s.invalid).length;
        return (
            <section className={`rcc-card ${noRows ? 'rcc-card--bad' : 'rcc-card--ok'} rcc-line`} data-testid="rc-card" data-state="set" data-details="closed" data-norows={noRows ? 'true' : undefined}>
                {noRows
                    ? <div className="rcc-num rcc-num--sm" role="img" aria-label="Nothing to train on" title={noRowsTip} data-testid="rc-card-tick">!</div>
                    : <div className="rcc-num rcc-num--ok rcc-num--sm" role="img" aria-label="Set · applies to every model" title="Set · applies to every model" data-testid="rc-card-tick"><Check size={13} aria-hidden="true" /></div>}
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
                        {nCond === 0 ? <span className="rcc-line-warn">Machine running: not set</span> : <>Running when <SensorInline tag={complete[0].sensor} size="sm" /> is above <span className="rcc-rest">{conditionChipParts(complete[0], getDesc, getUnit).rest.replace(/^> /, '')}</span></>}
                    </span>
                    {/* Only the two warnings — never a count of rows. Empty (hidden by
                        `.rcc-line-item:empty`) when there is nothing to warn about. */}
                    <span className="rcc-line-item" data-testid="rc-card-use" aria-live="polite">
                        {noTrain
                            ? <span className="rcc-line-warn" data-testid="rc-card-no-train">{CARD_NO_TRAIN_TEXT}</span>
                            : noRows
                                ? <span className="rcc-line-bad" role="alert" data-testid="rc-card-no-rows" title={noRowsTip}>{CARD_NO_ROWS_TEXT}</span>
                                : null}
                    </span>
                    {outsideLine}
                </div>
                {/* The SAME group, same buttons, in the same place in both views: Details / Hide
                    details, then Edit — so the toggle stays under the pointer. */}
                <span className="rcc-acts">
                    <button type="button" ref={detailsBtnRef} className="rcx-btn rcx-btn--sm rcc-line-more" data-testid="rc-card-details" aria-expanded={false} onClick={() => toggleDetails(true)}>
                        Details <ChevronDown size={12} aria-hidden="true" />
                    </button>
                    <button type="button" className="rcx-btn rcx-btn--sm" data-testid="rc-card-open" onClick={onOpen}>Edit</button>
                </span>
            </section>
        );
    }

    return (
        <section className={`rcc-card ${noRows ? 'rcc-card--bad' : 'rcc-card--ok'}`} data-testid="rc-card" data-state="set" data-details="open" data-norows={noRows ? 'true' : undefined}>
            {noRows
                ? <div className="rcc-num" aria-hidden="true">!</div>
                : <div className="rcc-num rcc-num--ok"><Check size={16} aria-hidden="true" /></div>}
            <div className="rcc-main">
                <div className="rcc-kicker">
                    {/* Never a green "Set" on the red nothing-to-train-on card. */}
                    Running condition {noRows
                        ? <span className="f4-pill f4-pill--bad" data-testid="rc-card-pill" title={noRowsTip}>Nothing to train on</span>
                        : <span className="f4-pill f4-pill--ok" data-testid="rc-card-pill">Set</span>}
                    <span className="rcc-applies">applies to every model</span>
                </div>
                <div className="rcc-grid">
                    <div className="rcc-rows" data-testid="rc-card-time"><span className="rcc-lbl">Train</span><PeriodChips periods={periods} bounds={bounds} /></div>
                    <div className="rcc-rows" data-testid="rc-card-test"><span className="rcc-lbl">Scoring</span><ScoringChips tests={testPeriods} train={periods} bounds={bounds} /></div>
                    <div className="rcc-rows" data-testid="rc-card-cond">
                        <span className="rcc-lbl">Running when</span>
                        {complete.map(f => {
                            const c = conditionChipParts(f, getDesc, getUnit);
                            const above = c.rest.replace(/^> /, '');
                            return (
                                <span key={f.id} className="rcc-chip rcc-chip--sl" data-testid="rc-card-cond-chip" title={`Machine is running when ${sensorTitle(lookup(f.sensor))} is above ${above}`}>
                                    <SensorInline tag={f.sensor} size="sm" /> <span className="rcc-above">is above</span> <span className="rcc-rest">{above}</span>
                                </span>
                            );
                        })}
                        <span className="rcc-applies">also the export’s running status</span>
                    </div>
                    {outsideNotes.length > 0 && (
                        <div className="rcc-rows rcc-line-warn" role="status" data-testid="rc-card-outside">⚠ {outsideNotes.join(' · ')}</div>
                    )}
                </div>
            </div>
            <div className="rcc-use" data-testid="rc-card-use" aria-live="polite">
                {/* Only the two warnings — never a count of rows, no share meter. */}
                {noTrain
                    ? <span className="rcc-use-note rcc-line-warn" data-testid="rc-card-no-train">{CARD_NO_TRAIN_TEXT}</span>
                    : noRows
                        ? <span className="rcc-use-note rcc-line-bad" role="alert" data-testid="rc-card-no-rows" title={noRowsTip}>{CARD_NO_ROWS_TEXT}</span>
                        : null}
                {/* Small period strip. PERSISTED periods only —
                    the settings modal's draft never reaches this card. Hidden while the
                    dataset bounds are unknown. */}
                <PeriodCoverageBar periods={periods} bounds={bounds} mini tests={testPeriods} />
            </div>
            <span className="rcc-acts">
                <button type="button" ref={detailsBtnRef} className="rcx-btn rcx-btn--sm rcc-line-more" data-testid="rc-card-details" aria-expanded={true} onClick={() => toggleDetails(false)}>
                    Hide details <ChevronUp size={12} aria-hidden="true" />
                </button>
                <button type="button" className="rcx-btn rcx-btn--sm" data-testid="rc-card-open" onClick={onOpen}>Edit</button>
            </span>
        </section>
    );
}
