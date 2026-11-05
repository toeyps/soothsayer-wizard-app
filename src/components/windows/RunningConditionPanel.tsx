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

/* Running-condition settings for scope 'workspace' (modal body, Apply in its footer) and 'custom' (a model's own, saved with Save changes). Presentation only: values and handlers arrive via props. One required line 'Machine is running when [sensor] is above [value]' filters Train and Health score and (workspace) is the export's running_status. 'Use all data' hides it (the export checklist asks instead). Counts show as running days, never rows or %. */

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
    /** `workspace`: the modal's draft. `custom`: one model's own condition, with its own test ids, 'save' wording and the footnote. */
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
    /** "Use all data": Train and the Health score use every row of the periods. */
    allData?: boolean;
    onAllDataChange?: (next: boolean) => void;
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
    /** A date is half-typed: the row's name ('P1'/'S2'), or null; a complete date arrives via onPeriodsChange/onTestPeriodsChange. */
    onPendingDate?: (list: 'train' | 'scoring', name: string | null) => void;
    /** Both lists as SAVED: a saved period outside the loaded data only warns, a new or changed one is invalid. Omitted = all new. */
    savedPeriods?: PeriodBaseline;
    savedTestPeriods?: PeriodBaseline;
}

export default function RunningConditionPanel({
    scope = 'workspace', configured, periods, onPeriodsChange, bounds, condition,
    onConditionChange, allData = false, onAllDataChange, sensors, getComponent, getUnit,
    counts = PERIOD_COUNTS_IDLE, testPeriods, onTestPeriodsChange, highlights, onPendingDate, savedPeriods, savedTestPeriods,
}: RunningConditionPanelProps) {
    const custom = scope === 'custom';
    // Without a complete condition the count would cover every row, not what trains once it is set; so no running days and no running-time claim.
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
                        ? (allData ? 'this model trains and scores on every row of its periods.' : 'only rows where the machine is running are used to train and score this model. Required.')
                        : allData
                            ? 'train and score use every row of the periods.'
                            : 'only rows where the machine is running are used to train and score — and the export tells the monitoring system the same. Required.'}</span>
                </div>
                <div className="rcx-rows-mode" role="radiogroup" aria-label="Rows used to train and score" data-testid={id('rc-rows-mode', 'custom-rc-rows-mode')}>
                    {([
                        [false, 'Only when running', 'rows at or below the value are left out'],
                        [true, 'Use all data', 'idle and shutdown time included'],
                    ] as const).map(([v, label, hint]) => (
                        <button
                            key={label}
                            type="button"
                            role="radio"
                            aria-checked={allData === v}
                            data-testid={id(v ? 'rc-mode-all' : 'rc-mode-running', v ? 'custom-rc-mode-all' : 'custom-rc-mode-running')}
                            className={`rcx-mode${allData === v ? ' rcx-mode--on' : ''}`}
                            onClick={() => { if (allData !== v) onAllDataChange?.(v); }}
                        >
                            <b>{label}</b><span>{hint}</span>
                        </button>
                    ))}
                </div>
                {!allData && <>
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
                </>}
            </section>

            {custom && <div className="rcx-footnote" data-testid="custom-rc-footnote">{CUSTOM_PANEL_FOOTNOTE}</div>}
        </div>
    );
}
