import type { TestPeriod, TimeHighlight, TimePeriod, WorkspaceSensorFilter } from '../../types';
import { PERIOD_COUNTS_IDLE, type PeriodCountsState } from '../../utils/periodCounts';
import { CUSTOM_PANEL_FOOTNOTE } from '../../utils/runningCondition';
import { normalizeSensorTag } from '../../hooks/useSensorMetaMap';
import { SensorInline } from '../sensor/SensorLabel';
import { fmtNumText } from '../sensor/sensorInfo';
import { type PeriodBaseline } from '../../utils/timePeriods';
import { SensorPickerModal } from './SensorPickers';
import { TrainHighlightWarnings } from './RunningConditionParts';
import RunningConditionTimeline from './RunningConditionTimeline';
import TestPeriodsEditor from './TestPeriodsEditor';
import TimePeriodsEditor, { type PeriodBounds } from './TimePeriodsEditor';

/*
 * The Running-condition settings (workbench redesign SPEC §5,
 * docs/design/handoff/workbench-redesign/README.md) — ONE column, used twice:
 *
 *   - `scope="workspace"`: the body of BuildModelWindow's Running condition
 *     modal (the workspace default; Apply lives in the modal footer);
 *   - `scope="custom"`: a Custom model's own running condition inside its
 *     Model settings (saved with Save changes) — the same timeline, rows and
 *     states, ending with one footnote.
 *
 *   [ timeline hero: month axis · Train lane (P1 P2) · Score lane (S1 S2) · ONE caption ]
 *   Train periods                  one eyebrow line · one quiet line per period
 *   Scoring periods                one eyebrow line · one quiet line per period
 *   When the machine is running    one eyebrow line · ONE line:
 *                                  "Machine is running when [sensor] is above [value unit]"
 *
 * The running condition is that one line (user decision 2026-10-26): no
 * operator choice, no second condition, no AND / OR, no "Use all rows". It
 * filters the rows for Train and the Health score, and (workspace scope) it is
 * the export's `machine_info.running_status`. It is required.
 *
 * No right-hand preview column and no callout boxes. No number of data rows
 * either (user decision 2026-10-14): the counts are shown as running DAYS — in
 * the caption and at the end of each period row — never as rows or a
 * percentage. Presentation only: every value and handler arrives through
 * props, and nothing here writes anything.
 */

/** Header pills of the modal: Fix period / Required. */
export function RunningConditionPills({ configured, periodInvalid }: {
    configured: boolean;
    periodInvalid: boolean;
}) {
    return (
        <>
            {periodInvalid && <span data-testid="rc-fix-period-pill" className="f4-pill f4-pill--bad">Fix period</span>}
            {!configured && <span data-testid="rc-required-pill" className="f4-pill f4-pill--warn">Required</span>}
        </>
    );
}

export interface RunningConditionPanelProps {
    /** `workspace` (default): the modal's draft. `custom`: one model's own
     *  running condition — different test ids on the root and the sections,
     *  "save" wording, and the footnote at the end. */
    scope?: 'workspace' | 'custom';
    /** The running condition (as drafted) is configured. */
    configured: boolean;
    /** TRAIN periods. */
    periods: TimePeriod[];
    onPeriodsChange: (next: TimePeriod[]) => void;
    bounds: PeriodBounds | null;
    /** THE condition ("sensor > value"); `undefined` = not set yet. */
    condition: WorkspaceSensorFilter | undefined;
    /** Sets the condition from the line's sensor and value. */
    onConditionChange: (next: { sensor: string; value: string }) => void;
    sensors: string[];
    getComponent: (tag: string) => string;
    getUnit: (tag: string) => string;
    /** Per-period running-row counts of what is on screen (`usePeriodCounts`).
     *  Omitted = calendar days only. */
    counts?: PeriodCountsState;
    /** SCORING periods — the time the trained model gives a health score for;
     *  never trained on. */
    testPeriods: TestPeriod[];
    onTestPeriodsChange: (next: TestPeriod[]) => void;
    /** The workspace's Dashboard time highlights — only for the TRAIN-period
     *  overlap line ("Remove the overlap"). */
    highlights: TimeHighlight[];
    /** A date in one of the two lists is still being typed: the row's name
     *  ("P1" / "S2"), or null once that list has nothing half-typed. A complete
     *  date arrives through `onPeriodsChange` / `onTestPeriodsChange` at once. */
    onPendingDate?: (list: 'train' | 'scoring', name: string | null) => void;
    /** The two lists as they are SAVED (the persisted workspace periods, or the
     *  model's own saved Custom ones). A period unchanged from them that lies
     *  entirely outside the loaded data only WARNS on its row; a new / changed
     *  one is invalid. Omitted = every period is new. */
    savedPeriods?: PeriodBaseline;
    savedTestPeriods?: PeriodBaseline;
}

export default function RunningConditionPanel({
    scope = 'workspace', configured, periods, onPeriodsChange, bounds, condition,
    onConditionChange, sensors, getComponent, getUnit,
    counts = PERIOD_COUNTS_IDLE, testPeriods, onTestPeriodsChange, highlights, onPendingDate, savedPeriods, savedTestPeriods,
}: RunningConditionPanelProps) {
    const custom = scope === 'custom';
    // Without a complete condition the count would be of EVERY row (no condition
    // is sent), which is not what will be trained on once it is set — so no
    // running days on the rows, and the caption claims no running time either.
    const rowCounts = configured ? counts : PERIOD_COUNTS_IDLE;
    const sensor = condition?.sensor ?? '';
    const value = condition?.value1 ?? '';
    const unit = sensor ? getUnit(sensor) : '';
    const missingSensor = !!sensor && sensors.length > 0 && !sensors.some(t => normalizeSensorTag(t) === normalizeSensorTag(sensor));
    // Test ids of the two uses differ, so both can be on screen at once (the
    // workspace modal over a Custom model's open settings).
    const id = (workspace: string, own: string) => (custom ? own : workspace);
    const notTrainable = custom ? 'This model can’t be trained until it is set.' : 'No model can be trained until it is set.';

    return (
        <div data-testid={id('rc-panel', 'custom-rc-panel')} className={`rcm-body${custom ? ' rcm-body--own' : ''}`}>
            <RunningConditionTimeline periods={periods} tests={testPeriods} bounds={bounds} counts={counts} configured={configured} savedPeriods={savedPeriods} savedTests={savedTestPeriods} />

            <section className="rcx-sec" data-testid={id('rc-periods', 'custom-periods')}>
                <div className="rcx-sec-h" data-testid="rc-train-head">
                    <i className="tpe-sw tpe-sw--tr" aria-hidden="true" />
                    <b>Train periods</b>
                    <span>only healthy, normal running time — the model learns what normal looks like from it. At least one.</span>
                </div>
                <TimePeriodsEditor
                    periods={periods}
                    onChange={onPeriodsChange}
                    bounds={bounds}
                    counts={rowCounts}
                    afterRows={<TrainHighlightWarnings periods={periods} highlights={highlights} onPeriodsChange={onPeriodsChange} />}
                    onPendingChange={onPendingDate ? name => onPendingDate('train', name) : undefined}
                    savedPeriods={savedPeriods}
                />
            </section>

            <section className="rcx-sec" data-testid={id('rc-scoring', 'custom-test-periods')}>
                <div className="rcx-sec-h" data-testid="rc-test-head">
                    <i className="tpe-sw tpe-sw--te" aria-hidden="true" />
                    <b>Scoring periods</b>
                    <span>the trained model gives a health score for this time — you read it on the score chart. Needed before Mark complete; may include train time.</span>
                </div>
                <TestPeriodsEditor
                    tests={testPeriods}
                    train={periods}
                    onChange={onTestPeriodsChange}
                    bounds={bounds}
                    blocks={custom ? 'save' : 'apply'}
                    counts={rowCounts}
                    onPendingChange={onPendingDate ? name => onPendingDate('scoring', name) : undefined}
                    savedTests={savedTestPeriods}
                />
            </section>

            <section className="rcx-sec" data-testid={id('rc-condition', 'custom-condition')}>
                <div className="rcx-sec-h">
                    <b>When the machine is running</b>
                    <span>{custom
                        ? 'only rows where the machine is running are used to train and score this model. Required.'
                        : 'only rows where the machine is running are used to train and score — and the export tells the monitoring system the same. Required.'}</span>
                </div>
                <div className={`rs-row rc1-row${!configured ? ' rc1-row--unset' : ''}`} data-testid={id('rc-one', 'custom-rc-one')}>
                    <span className="rs-l">Machine is running when</span>
                    <span className={`rs-pick${!sensor ? ' rc1-pick--empty' : ''}`}>
                        <SensorPickerModal
                            sensors={sensors}
                            getComponent={getComponent}
                            single
                            value={sensor}
                            onSelect={next => onConditionChange({ sensor: next, value })}
                            noun="sensor"
                        />
                    </span>
                    <span className="rs-l">is above</span>
                    <label className={`rcm-val rs-val${!value.trim() ? ' rs-val--empty' : ''}`}>
                        <input
                            type="number"
                            value={value}
                            aria-label="Running above this value"
                            placeholder="e.g. 1000"
                            onChange={e => onConditionChange({ sensor, value: e.target.value })}
                        />
                        {unit && <span>{unit}</span>}
                    </label>
                </div>
                {missingSensor ? (
                    <div data-testid="rc-unset-warning" className="rcx-line rcx-line--bad">
                        <SensorInline tag={sensor} size="sm" /> is not in the loaded data — pick another sensor.
                    </div>
                ) : !configured ? (
                    <div data-testid="rc-unset-warning" className="rcx-line rcx-line--warn">
                        {!sensor && !value.trim()
                            ? <>Pick the sensor that shows the machine is running, and the value above which it runs — for example generator active power above <span className="rc1-num">1,000 kW</span>.</>
                            : !sensor ? 'Pick the sensor that shows the machine is running.' : 'Type the value above which the machine is running.'}
                        {' '}{notTrainable}
                    </div>
                ) : (
                    <div className="rcx-line" data-testid="rc-one-note">
                        At or below <span className="rc1-num">{fmtNumText(value.trim())}{unit ? ` ${unit}` : ''}</span> the machine counts as stopped — those rows are left out{custom ? ' for this model' : ', and the export writes the same line as the machine’s running status'}.
                    </div>
                )}
            </section>

            {custom && <div className="rcx-footnote" data-testid="custom-rc-footnote">{CUSTOM_PANEL_FOOTNOTE}</div>}
        </div>
    );
}
